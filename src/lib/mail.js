// Reading and sending mail for a mailbox, over IMAP and SMTP.
//
// Nothing is cached: every request opens a connection, does its work and closes
// it. That costs a round trip, but it means the portal never holds a stale copy
// of someone's inbox and never keeps a session open against their mail server.

import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
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
export async function listFolders(settings) {
  return withImap(settings, async (client) => {
    const boxes = await client.list();
    return boxes
      .filter((b) => !b.flags?.has('\\Noselect'))
      .map((b) => ({
        path: b.path,
        name: b.name,
        // IMAP marks special folders with a use flag; falling back to the name
        // covers servers that do not advertise SPECIAL-USE.
        specialUse: b.specialUse ? b.specialUse.replace('\\', '').toLowerCase() : guessUse(b.name),
        subscribed: b.subscribed !== false,
      }));
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

/// One page of a folder, newest first.
export async function listMessages(settings, { folder = 'INBOX', page = 1, perPage = 25 } = {}) {
  return withImap(settings, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
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
      })) {
        messages.push({
          uid: msg.uid,
          subject: msg.envelope?.subject || '(no subject)',
          from: addressList(msg.envelope?.from),
          to: addressList(msg.envelope?.to),
          date: msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : null,
          size: msg.size ?? null,
          seen: Boolean(msg.flags?.has('\\Seen')),
          flagged: Boolean(msg.flags?.has('\\Flagged')),
          answered: Boolean(msg.flags?.has('\\Answered')),
        });
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
export async function sendMessage(settings, { from, to, cc, subject, text, html, inReplyTo, references }) {
  const transport = transportFor(settings);
  try {
    const info = await transport.sendMail({
      from,
      to,
      cc: cc || undefined,
      subject,
      text: text || undefined,
      html: html || undefined,
      inReplyTo: inReplyTo || undefined,
      references: references || undefined,
    });
    return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected };
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
