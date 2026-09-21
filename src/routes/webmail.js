// Webmail for a single mailbox.
//
// Mounted under /api/domains/:id/emails/:emailId/mail, so the domain check that
// guards everything else guards this too: a user only reaches mailboxes on
// domains assigned to them. The mailbox password is decrypted here and used to
// talk to the mail server; it is never part of a response.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler, badRequest, notFound } from '../lib/errors.js';
import { encrypt, decryptMaybe } from '../lib/crypto.js';
import {
  listFolders,
  listMessages,
  getMessage,
  getAttachment,
  deleteMessage,
  sendMessage,
  verifySmtp,
  MailError,
} from '../lib/mail.js';

export const webmailRouter = Router({ mergeParams: true });

/// Loads the mailbox and the domain's mail-server settings together, and
/// refuses early when either half is missing.
async function mailboxContext(domainId, emailId, { require = 'imap' } = {}) {
  const mailbox = await prisma.emailAccount.findFirst({
    where: { id: emailId, domainId },
  });
  if (!mailbox) throw notFound('Mailbox not found.');
  if (!mailbox.encryptedPassword) {
    throw badRequest('No password is saved for this mailbox yet. Add one to open it.');
  }

  const settings = await prisma.domainSettings.findUnique({ where: { domainId } });
  const password = decryptMaybe(mailbox.encryptedPassword);

  if (require === 'smtp') {
    if (!settings?.smtpHost) {
      throw badRequest('No outgoing (SMTP) server is configured for this domain.');
    }
    return {
      mailbox,
      server: {
        host: settings.smtpHost,
        port: settings.smtpPort,
        secure: settings.smtpSecure,
        user: mailbox.address,
        password,
      },
    };
  }

  if (!settings?.imapHost) {
    throw badRequest('No incoming (IMAP) server is configured for this domain.');
  }
  return {
    mailbox,
    server: {
      host: settings.imapHost,
      port: settings.imapPort,
      secure: settings.imapSecure,
      user: mailbox.address,
      password,
    },
  };
}

const passwordSchema = z.object({
  password: z.string().min(1, 'A mailbox password is required.').max(512),
});

/// Saves the mailbox password so the inbox can be opened without retyping it.
/// Stored encrypted, like every other credential here.
webmailRouter.put(
  '/password',
  validate(passwordSchema),
  asyncHandler(async (req, res) => {
    const mailbox = await prisma.emailAccount.findFirst({
      where: { id: req.params.emailId, domainId: req.domain.id },
    });
    if (!mailbox) throw notFound('Mailbox not found.');

    await prisma.emailAccount.update({
      where: { id: mailbox.id },
      data: { encryptedPassword: encrypt(req.body.password) },
    });
    res.json({ ok: true, message: 'Mailbox password saved.' });
  }),
);

webmailRouter.delete(
  '/password',
  asyncHandler(async (req, res) => {
    const mailbox = await prisma.emailAccount.findFirst({
      where: { id: req.params.emailId, domainId: req.domain.id },
    });
    if (!mailbox) throw notFound('Mailbox not found.');

    await prisma.emailAccount.update({
      where: { id: mailbox.id },
      data: { encryptedPassword: null },
    });
    res.json({ ok: true, message: 'Mailbox password removed.' });
  }),
);

/// Checks the saved password against both servers before the UI offers an
/// inbox, so a wrong password is reported once rather than on every action.
webmailRouter.post(
  '/test',
  asyncHandler(async (req, res) => {
    const result = { imap: null, smtp: null };

    try {
      const { server } = await mailboxContext(req.domain.id, req.params.emailId);
      const folders = await listFolders(server);
      result.imap = { ok: true, message: `Signed in. ${folders.length} folder${folders.length === 1 ? '' : 's'}.` };
    } catch (err) {
      result.imap = { ok: false, message: err.message };
    }

    try {
      const { server } = await mailboxContext(req.domain.id, req.params.emailId, { require: 'smtp' });
      await verifySmtp(server);
      result.smtp = { ok: true, message: 'Sending is available.' };
    } catch (err) {
      result.smtp = { ok: false, message: err.message };
    }

    res.status(result.imap.ok ? 200 : 400).json({ ok: result.imap.ok, ...result });
  }),
);

webmailRouter.get(
  '/folders',
  asyncHandler(async (req, res) => {
    const { server } = await mailboxContext(req.domain.id, req.params.emailId);
    res.json({ folders: await listFolders(server) });
  }),
);

const listQuery = z.object({
  folder: z.string().max(255).optional(),
  page: z.coerce.number().int().min(1).max(10000).optional(),
});

webmailRouter.get(
  '/messages',
  asyncHandler(async (req, res) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) throw badRequest('Invalid folder or page.');

    const { server } = await mailboxContext(req.domain.id, req.params.emailId);
    res.json(
      await listMessages(server, {
        folder: parsed.data.folder || 'INBOX',
        page: parsed.data.page || 1,
      }),
    );
  }),
);

webmailRouter.get(
  '/messages/:uid',
  asyncHandler(async (req, res) => {
    const uid = Number(req.params.uid);
    if (!Number.isInteger(uid) || uid < 1) throw badRequest('Invalid message id.');

    const { server } = await mailboxContext(req.domain.id, req.params.emailId);
    res.json({
      message: await getMessage(server, { folder: String(req.query.folder || 'INBOX'), uid }),
    });
  }),
);

webmailRouter.get(
  '/messages/:uid/attachments/:index',
  asyncHandler(async (req, res) => {
    const uid = Number(req.params.uid);
    const index = Number(req.params.index);
    if (!Number.isInteger(uid) || !Number.isInteger(index) || index < 0) {
      throw badRequest('Invalid attachment.');
    }

    const { server } = await mailboxContext(req.domain.id, req.params.emailId);
    const attachment = await getAttachment(server, {
      folder: String(req.query.folder || 'INBOX'),
      uid,
      index,
    });

    // The filename comes from the message, so strip anything that could break
    // out of the header.
    const safeName = attachment.filename.replace(/["\\\r\n]/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.setHeader('Content-Type', attachment.contentType);
    res.send(attachment.content);
  }),
);

webmailRouter.delete(
  '/messages/:uid',
  asyncHandler(async (req, res) => {
    const uid = Number(req.params.uid);
    if (!Number.isInteger(uid) || uid < 1) throw badRequest('Invalid message id.');

    const { server } = await mailboxContext(req.domain.id, req.params.emailId);
    const folder = String(req.query.folder || 'INBOX');

    // Prefer moving to trash, so a delete is recoverable from the mail client.
    const folders = await listFolders(server);
    const trash = folders.find((f) => f.specialUse === 'trash')?.path || null;

    const result = await deleteMessage(server, { folder, uid, trashFolder: trash });
    res.json({
      ok: true,
      message: result.moved ? `Moved to ${result.to}.` : 'Message deleted.',
    });
  }),
);

const sendSchema = z.object({
  to: z.string().trim().min(1, 'At least one recipient is required.').max(2000),
  cc: z.string().trim().max(2000).optional(),
  subject: z.string().trim().max(500).optional(),
  text: z.string().max(200000).optional(),
  inReplyTo: z.string().max(500).optional(),
  references: z.string().max(4000).optional(),
});

webmailRouter.post(
  '/send',
  validate(sendSchema),
  asyncHandler(async (req, res) => {
    const { mailbox, server } = await mailboxContext(req.domain.id, req.params.emailId, {
      require: 'smtp',
    });

    const recipients = req.body.to
      .split(/[,;]/)
      .map((r) => r.trim())
      .filter(Boolean);
    if (!recipients.length) throw badRequest('At least one recipient is required.');

    const result = await sendMessage(server, {
      // Always the mailbox itself: the server would reject anything else.
      from: mailbox.address,
      to: recipients,
      cc: req.body.cc
        ? req.body.cc.split(/[,;]/).map((r) => r.trim()).filter(Boolean)
        : undefined,
      subject: req.body.subject || '(no subject)',
      text: req.body.text || '',
      inReplyTo: req.body.inReplyTo,
      references: req.body.references,
    });

    res.json({
      ok: true,
      message: `Sent to ${result.accepted?.length || recipients.length} recipient${
        (result.accepted?.length || recipients.length) === 1 ? '' : 's'
      }.`,
      rejected: result.rejected || [],
    });
  }),
);

/// Turns mail failures into ordinary HTTP errors.
webmailRouter.use((err, _req, res, next) => {
  if (err instanceof MailError) {
    return res.status(err.status).json({ error: err.message });
  }
  next(err);
});
