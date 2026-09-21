// Reading and sending mail for a mailbox, over IMAP and SMTP.
//
// Nothing is cached: every request opens a connection, does its work and closes
// it. That costs a round trip, but it means the portal never holds a stale copy
// of someone's inbox and never keeps a session open against their mail server.

import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { simpleParser } from 'mailparser';

const TIMEOUT_MS = 20000;

export class MailError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/// Mail servers routinely present certificates that do not match the host a
/// customer was told to use. Refusing those would make the feature unusable, so
/// the connection is encrypted but the certificate is not verified.
const TLS_OPTIONS = { rejectUnauthorized: false };

function friendlyError(err) {
  const text = err?.responseText || err?.message || '';
  if (/AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed|535/i.test(text)) {
    return 'The mail server rejected this mailbox password.';
  }
  if (err?.code === 'ENOTFOUND') return 'The mail server could not be found. Check the host name.';
  if (err?.code === 'ECONNREFUSED') return 'The mail server refused the connection. Check the host and port.';
  if (err?.code === 'ETIMEDOUT' || /timed? ?out/i.test(text)) {
    return 'The mail server did not respond in time. Check the host, port and any firewall.';
  }
  return text || 'The mail server request failed.';
}

async function connect({ host, port, secure, user, password }) {
  const client = new ImapFlow({
    host,
    port: port || (secure ? 993 : 143),
    secure: secure !== false,
    auth: { user, pass: password },
    tls: TLS_OPTIONS,
    logger: false,
    emitLogs: false,
  });

  try {
    await client.connect();
  } catch (err) {
    throw new MailError(friendlyError(err), 502);
  }
  return client;
}

/// Opens a connection, runs `fn`, and always logs out.
export async function withImap(settings, fn) {
  const client = await connect(settings);
  try {
    return await fn(client);
  } catch (err) {
    if (err instanceof MailError) throw err;
    throw new MailError(friendlyError(err), 502);
  } finally {
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }
}

/// Folders, with the well-known ones flagged so the UI can order and name them.
///
/// `withCounts` asks the server for message and unread totals per folder. It
/// costs a STATUS call each, so the list view asks for them and anything that
/// just needs folder names does not.
export async function listFolders(settings, { withCounts = false } = {}) {
  return withImap(settings, async (client) => {
    const boxes = (await client.list()).filter((b) => !b.flags?.has('\\Noselect'));

    const folders = boxes.map((b) => ({
      path: b.path,
      name: b.name,
      // IMAP marks special folders with a use flag; falling back to the name
      // covers servers that do not advertise SPECIAL-USE.
      specialUse: b.specialUse ? b.specialUse.replace('\\', '').toLowerCase() : guessUse(b.name),
      subscribed: b.subscribed !== false,
      total: null,
      unread: null,
    }));

    if (withCounts) {
      for (const folder of folders) {
        try {
          const status = await client.status(folder.path, { messages: true, unseen: true });
          folder.total = status.messages ?? null;
          folder.unread = status.unseen ?? null;
        } catch {
          // A folder that refuses STATUS still belongs in the list.
        }
      }
    }

    return folders;
  });
}

function guessUse(name) {
  const n = String(name).toLowerCase();
  if (n === 'inbox') return 'inbox';
  if (/sent/.test(n)) return 'sent';
  if (/draft/.test(n)) return 'drafts';
  if (/trash|deleted/.test(n)) return 'trash';
  if (/junk|spam/.test(n)) return 'junk';
  return null;
}

const addressList = (value) =>
  (value || []).map((a) => ({ name: a.name || null, address: a.address || null }));

/// The row shape used by both the plain listing and search results.
const summarise = (msg) => ({
  uid: msg.uid,
  subject: msg.envelope?.subject || '(no subject)',
  from: addressList(msg.envelope?.from),
  to: addressList(msg.envelope?.to),
  date: msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : null,
  size: msg.size ?? null,
  seen: Boolean(msg.flags?.has('\\Seen')),
  flagged: Boolean(msg.flags?.has('\\Flagged')),
  answered: Boolean(msg.flags?.has('\\Answered')),
  hasAttachments: Boolean(msg.bodyStructure && hasAttachment(msg.bodyStructure)),
});

/// Walks a body structure looking for a part the client should show as an
/// attachment.
function hasAttachment(node) {
  if (!node) return false;
  if (node.disposition === 'attachment') return true;
  return (node.childNodes || []).some(hasAttachment);
}

/// One page of a folder, newest first.
///
/// With `search`, the server does the matching (IMAP SEARCH across from,
/// subject and body) and the page is taken from the results. Searching in the
/// browser would only ever see the page already loaded.
export async function listMessages(settings, { folder = 'INBOX', page = 1, perPage = 25, search = '' } = {}) {
  return withImap(settings, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const query = String(search || '').trim();

      if (query) {
        const uids = await client.search({ or: [{ from: query }, { subject: query }, { body: query }] }, { uid: true });
        const total = uids.length;
        if (!total) return { folder, page, perPage, total, messages: [], search: query };

        // Newest first, then the requested page of that.
        const ordered = [...uids].reverse();
        const slice = ordered.slice((page - 1) * perPage, page * perPage);
        if (!slice.length) return { folder, page, perPage, total, messages: [], search: query };

        const found = [];
        for await (const msg of client.fetch(slice, { uid: true, envelope: true, flags: true, size: true, bodyStructure: true }, { uid: true })) {
          found.push(summarise(msg));
        }
        // fetch may return in any order, so restore the newest-first order.
        found.sort((a, b) => slice.indexOf(a.uid) - slice.indexOf(b.uid));
        return { folder, page, perPage, total, messages: found, search: query };
      }

      const total = client.mailbox.exists;
      if (!total) return { folder, page, perPage, total, messages: [] };

      // IMAP sequence numbers run oldest-first, so the newest page is the last
      // slice of the range.
      const end = Math.max(total - (page - 1) * perPage, 0);
      const start = Math.max(end - perPage + 1, 1);
      if (end < 1) return { folder, page, perPage, total, messages: [] };

      const messages = [];
      for await (const msg of client.fetch(`${start}:${end}`, {
        uid: true,
        envelope: true,
        flags: true,
        size: true,
        bodyStructure: true,
      })) {
        messages.push(summarise(msg));
      }

      messages.reverse(); // newest first
      return { folder, page, perPage, total, messages };
    } finally {
      lock.release();
    }
  });
}

/// A single message, parsed. Attachments are listed but not included; each is
/// fetched separately so a large one does not bloat the reply.
export async function getMessage(settings, { folder = 'INBOX', uid }) {
  return withImap(settings, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const { content } = await client.download(String(uid), undefined, { uid: true });
      if (!content) throw new MailError('That message could not be found.', 404);

      const parsed = await simpleParser(content);

      // Opening a message marks it read, which is what a mail client does.
      try {
        await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
      } catch {
        // A read-only mailbox is not a reason to fail the read itself.
      }

      return {
        uid,
        folder,
        subject: parsed.subject || '(no subject)',
        from: addressList(parsed.from?.value),
        to: addressList(parsed.to?.value),
        cc: addressList(parsed.cc?.value),
        date: parsed.date ? parsed.date.toISOString() : null,
        messageId: parsed.messageId || null,
        text: parsed.text || null,
        html: parsed.html || null,
        attachments: (parsed.attachments || []).map((a, index) => ({
          index,
          filename: a.filename || `attachment-${index + 1}`,
          contentType: a.contentType || 'application/octet-stream',
          size: a.size ?? null,
        })),
      };
    } finally {
      lock.release();
    }
  });
}

/// One attachment's bytes.
export async function getAttachment(settings, { folder = 'INBOX', uid, index }) {
  return withImap(settings, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const { content } = await client.download(String(uid), undefined, { uid: true });
      if (!content) throw new MailError('That message could not be found.', 404);

      const parsed = await simpleParser(content);
      const attachment = (parsed.attachments || [])[index];
      if (!attachment) throw new MailError('That attachment could not be found.', 404);

      return {
        filename: attachment.filename || `attachment-${index + 1}`,
        contentType: attachment.contentType || 'application/octet-stream',
        content: attachment.content,
      };
    } finally {
      lock.release();
    }
  });
}

/// Moves a message to the trash folder, or deletes it outright when already
/// there or when the server has no trash.
export async function deleteMessage(settings, { folder = 'INBOX', uid, trashFolder }) {
  return withImap(settings, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      if (trashFolder && trashFolder !== folder) {
        await client.messageMove(String(uid), trashFolder, { uid: true });
        return { moved: true, to: trashFolder };
      }
      await client.messageDelete(String(uid), { uid: true });
      return { moved: false };
    } finally {
      lock.release();
    }
  });
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

function transportFor({ host, port, secure, user, password }) {
  return nodemailer.createTransport({
    host,
    port: port || (secure ? 465 : 587),
    secure: secure !== false,
    auth: { user, pass: password },
    tls: TLS_OPTIONS,
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
  });
}

export async function verifySmtp(settings) {
  const transport = transportFor(settings);
  try {
    await transport.verify();
    return true;
  } catch (err) {
    throw new MailError(friendlyError(err), 502);
  } finally {
    transport.close();
  }
}

/// Sends a message as the mailbox. The From address is the mailbox itself —
/// it is not something the caller gets to choose, since the server would
/// reject or spam-flag anything else anyway.
export async function sendMessage(settings, { from, to, cc, bcc, subject, text, html, inReplyTo, references, attachments }) {
  const transport = transportFor(settings);
  try {
    // The message is built once, here, and then both sent and filed to Sent.
    // Composing it separately is what makes the copy in Sent byte-identical to
    // what actually left the server — and an SMTP send does not hand the raw
    // message back, so there would otherwise be nothing to file.
    const compiled = new MailComposer({
      from,
      to,
      cc: cc?.length ? cc : undefined,
      bcc: bcc?.length ? bcc : undefined,
      subject,
      text: text || undefined,
      html: html || undefined,
      inReplyTo: inReplyTo || undefined,
      references: references || undefined,
      attachments: attachments?.length
        ? attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType }))
        : undefined,
    }).compile();

    // The envelope carries the Bcc recipients; the built message does not, so
    // nobody on the To line learns who else received it.
    const envelope = compiled.getEnvelope();
    const messageId = compiled.messageId();
    const raw = await compiled.build();

    const info = await transport.sendMail({ envelope, raw });
    return {
      messageId,
      accepted: info.accepted,
      rejected: info.rejected,
      // Kept so a copy can be filed in Sent.
      raw,
    };
  } catch (err) {
    throw new MailError(friendlyError(err), 502);
  } finally {
    transport.close();
  }
}

/// Appends a copy of a sent message to the Sent folder, the way a mail client
/// does. Best effort: failing to file a copy must not fail the send.
export async function appendToSent(settings, { sentFolder, raw }) {
  if (!sentFolder) return false;
  try {
    await withImap(settings, (client) => client.append(sentFolder, raw, ['\\Seen']));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Acting on messages
// ---------------------------------------------------------------------------

/// Marks a message read or unread.
export async function setSeen(settings, { folder, uid, seen }) {
  return withImap(settings, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      if (seen) await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
      else await client.messageFlagsRemove(String(uid), ['\\Seen'], { uid: true });
      return { seen };
    } finally {
      lock.release();
    }
  });
}

/// Stars or unstars a message.
export async function setFlagged(settings, { folder, uid, flagged }) {
  return withImap(settings, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      if (flagged) await client.messageFlagsAdd(String(uid), ['\\Flagged'], { uid: true });
      else await client.messageFlagsRemove(String(uid), ['\\Flagged'], { uid: true });
      return { flagged };
    } finally {
      lock.release();
    }
  });
}

/// Moves a message to another folder.
export async function moveMessage(settings, { folder, uid, to }) {
  if (folder === to) throw new MailError('That message is already in this folder.', 400);
  return withImap(settings, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      await client.messageMove(String(uid), to, { uid: true });
      return { moved: true, to };
    } finally {
      lock.release();
    }
  });
}

/// The raw source of a message, used to build a forward.
export async function getRawMessage(settings, { folder, uid }) {
  return withImap(settings, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const { content } = await client.download(String(uid), undefined, { uid: true });
      if (!content) throw new MailError('That message could not be found.', 404);
      const chunks = [];
      for await (const chunk of content) chunks.push(chunk);
      return Buffer.concat(chunks);
    } finally {
      lock.release();
    }
  });
}
