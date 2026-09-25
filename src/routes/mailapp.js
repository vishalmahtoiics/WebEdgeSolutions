// The standalone webmail application.
//
// This is not the portal. People arrive here with an email address and the
// mailbox's own password, and that is the whole identity — there is no portal
// account involved, and no User row is consulted.
//
// The password is never stored. It lives in the server-side session, encrypted
// with the application key, and goes away when the session ends.

import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { prisma } from '../db.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler, badRequest, unauthorized, notFound } from '../lib/errors.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { record } from '../services/notifier.js';
import {
  listFolders, listMessages, getMessage, getAttachment, getRawMessage,
  deleteMessage, moveMessage, setSeen, setFlagged,
  sendMessage, appendToSent, verifySmtp, MailError,
} from '../lib/mail.js';
import { maskError } from '../lib/whiteLabel.js';
import { isAdmin } from '../middleware/auth.js';

export const mailAppRouter = Router();

const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 10 },
});

// Each attempt is a login against a real mail server, so this is the door to
// slow down.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Please try again in a few minutes.' },
});

/// What a visitor is told when sign-in fails for a reason that is not theirs
/// to know. Whether a domain is hosted here is not something an
/// unauthenticated stranger needs to learn.
const VAGUE = 'We could not sign you in. Check the address and password.';

/// Why a sign-in failed, in words meant for whoever runs this portal.
///
/// The visitor gets the message above and nothing else. This goes to the
/// activity log, because the alternative — which is what this used to do — is
/// that a customer says "it will not let me in", the administrator opens the
/// portal, and there is nothing anywhere to say whether the password was wrong
/// or the IMAP host was never filled in.
async function recordFailure({ req, address, reason, detail }) {
  await record({
    event: 'security.webmail.failed',
    summary: `Webmail sign-in failed for ${address}`,
    detail: `${reason}\n\n${detail}`,
    ip: req.ip,
  });
}

/// Finds the mail servers for an address by looking up its domain in the
/// portal. A domain nobody has configured cannot be signed in to.
async function serversFor(address, req) {
  const domainName = String(address).split('@')[1]?.toLowerCase();
  if (!domainName) throw badRequest('Enter a full email address.');

  const domain = await prisma.domain.findUnique({
    where: { name: domainName },
    include: { settings: true },
  });

  if (!domain) {
    await recordFailure({
      req,
      address,
      reason: `No domain called ${domainName} exists in this portal.`,
      detail:
        'Add the domain under Domains, then fill in its IMAP and SMTP details under FTP & Server. ' +
        'Until then nobody with an address at it can sign in here.',
    });
    throw unauthorized(VAGUE);
  }

  if (!domain.settings?.imapHost) {
    await recordFailure({
      req,
      address,
      reason: `${domainName} has no IMAP host saved.`,
      detail:
        'Open the domain, go to FTP & Server, and fill in the IMAP host and port. ' +
        'Use "Test a mailbox sign-in" on that tab to check them before telling the customer to try again.',
    });
    throw unauthorized(VAGUE);
  }

  return { domain, settings: domain.settings };
}

const credentials = (req, kind = 'imap') => {
  const session = req.session?.mail;
  if (!session) throw unauthorized('Please sign in.');

  const password = decrypt(session.password);
  return kind === 'smtp'
    ? { host: session.smtpHost, port: session.smtpPort, secure: session.smtpSecure, user: session.address, password }
    : { host: session.imapHost, port: session.imapPort, secure: session.imapSecure, user: session.address, password };
};

function requireMailSession(req, _res, next) {
  if (!req.session?.mail) return next(unauthorized('Please sign in.'));
  next();
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

const loginSchema = z.object({
  address: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  password: z.string().min(1, 'Enter your password.'),
});

mailAppRouter.post(
  '/login',
  loginLimiter,
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const { address, password } = req.body;
    const { domain, settings } = await serversFor(address, req);

    const imap = {
      host: settings.imapHost,
      port: settings.imapPort,
      secure: settings.imapSecure,
      user: address,
      password,
    };

    // The mail server is the authority on whether these credentials are good.
    try {
      await listFolders(imap);
    } catch (err) {
      const message = err?.message || 'The mail server request failed.';
      const where = `${settings.imapHost}:${settings.imapPort || (settings.imapSecure ? 993 : 143)}` +
        ` (${settings.imapSecure === false ? 'not encrypted' : 'encrypted'})`;

      if (err instanceof MailError && /rejected this mailbox password/i.test(message)) {
        await recordFailure({
          req,
          address,
          reason: 'The mail server rejected the password.',
          detail:
            `Tried ${where}.\n\n` +
            'The settings are reaching a real server, so this is the password, the address, or a ' +
            'mailbox that does not exist on that server.',
        });
        throw unauthorized(VAGUE);
      }

      // Everything else is a connection problem: a wrong port, encryption set
      // the wrong way, a firewall. This used to fall through as a generic
      // "something went wrong", which sent the person off to reset a password
      // that was never the problem — so it is now told apart and said plainly.
      //
      // Saying so does reveal that the address's domain is configured here.
      // That is a fair trade: anyone can read a domain's MX records, and the
      // cost of hiding it is a customer changing their password over and over
      // while a server sits unreachable.
      await recordFailure({
        req,
        address,
        reason: 'The mail server could not be reached.',
        detail: `Tried ${where}.\n\n${message}\n\nCheck the IMAP host, port and encryption under FTP & Server.`,
      });

      throw unauthorized(
        'We could not reach the mail server for this address. This is a problem at our end, not with ' +
          'your password — please try again shortly, or contact support.',
      );
    }

    await new Promise((resolve, reject) =>
      req.session.regenerate((err) => (err ? reject(err) : resolve())),
    );

    req.session.mail = {
      address,
      domainId: domain.id,
      domainName: domain.name,
      imapHost: settings.imapHost,
      imapPort: settings.imapPort,
      imapSecure: settings.imapSecure,
      smtpHost: settings.smtpHost,
      smtpPort: settings.smtpPort,
      smtpSecure: settings.smtpSecure,
      // Encrypted even inside the session store, which is a database table.
      password: encrypt(password),
      canSend: Boolean(settings.smtpHost),
    };

    res.json({ account: { address, canSend: Boolean(settings.smtpHost) } });
  }),
);

mailAppRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    await new Promise((resolve) => req.session.destroy(resolve));
    res.clearCookie('portal.sid');
    res.json({ ok: true });
  }),
);

mailAppRouter.get('/me', (req, res) => {
  const session = req.session?.mail;
  if (!session) return res.json({ account: null });
  res.json({ account: { address: session.address, canSend: session.canSend } });
});

// Everything below needs a signed-in mailbox.
mailAppRouter.use(requireMailSession);

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

mailAppRouter.get(
  '/folders',
  asyncHandler(async (req, res) => {
    res.json({ folders: await listFolders(credentials(req), { withCounts: true }) });
  }),
);

const listQuery = z.object({
  folder: z.string().max(255).optional(),
  page: z.coerce.number().int().min(1).max(10000).optional(),
  search: z.string().max(200).optional(),
});

mailAppRouter.get(
  '/messages',
  asyncHandler(async (req, res) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) throw badRequest('Invalid folder, page or search.');

    res.json(
      await listMessages(credentials(req), {
        folder: parsed.data.folder || 'INBOX',
        page: parsed.data.page || 1,
        search: parsed.data.search || '',
      }),
    );
  }),
);

const uidOf = (value) => {
  const uid = Number(value);
  if (!Number.isInteger(uid) || uid < 1) throw badRequest('Invalid message id.');
  return uid;
};

mailAppRouter.get(
  '/messages/:uid',
  asyncHandler(async (req, res) => {
    res.json({
      message: await getMessage(credentials(req), {
        folder: String(req.query.folder || 'INBOX'),
        uid: uidOf(req.params.uid),
      }),
    });
  }),
);

mailAppRouter.get(
  '/messages/:uid/attachments/:index',
  asyncHandler(async (req, res) => {
    const index = Number(req.params.index);
    if (!Number.isInteger(index) || index < 0) throw badRequest('Invalid attachment.');

    const attachment = await getAttachment(credentials(req), {
      folder: String(req.query.folder || 'INBOX'),
      uid: uidOf(req.params.uid),
      index,
    });

    const safeName = attachment.filename.replace(/["\\\r\n]/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.setHeader('Content-Type', attachment.contentType);
    res.send(attachment.content);
  }),
);

// ---------------------------------------------------------------------------
// Acting on messages
// ---------------------------------------------------------------------------

mailAppRouter.post(
  '/messages/:uid/seen',
  validate(z.object({ seen: z.boolean(), folder: z.string().max(255).optional() })),
  asyncHandler(async (req, res) => {
    await setSeen(credentials(req), {
      folder: req.body.folder || 'INBOX',
      uid: uidOf(req.params.uid),
      seen: req.body.seen,
    });
    res.json({ ok: true });
  }),
);

mailAppRouter.post(
  '/messages/:uid/flagged',
  validate(z.object({ flagged: z.boolean(), folder: z.string().max(255).optional() })),
  asyncHandler(async (req, res) => {
    await setFlagged(credentials(req), {
      folder: req.body.folder || 'INBOX',
      uid: uidOf(req.params.uid),
      flagged: req.body.flagged,
    });
    res.json({ ok: true });
  }),
);

mailAppRouter.post(
  '/messages/:uid/move',
  validate(z.object({ to: z.string().min(1).max(255), folder: z.string().max(255).optional() })),
  asyncHandler(async (req, res) => {
    const result = await moveMessage(credentials(req), {
      folder: req.body.folder || 'INBOX',
      uid: uidOf(req.params.uid),
      to: req.body.to,
    });
    res.json({ ok: true, message: `Moved to ${result.to}.` });
  }),
);

mailAppRouter.delete(
  '/messages/:uid',
  asyncHandler(async (req, res) => {
    const settings = credentials(req);
    const folder = String(req.query.folder || 'INBOX');

    const folders = await listFolders(settings);
    const trash = folders.find((f) => f.specialUse === 'trash')?.path || null;

    const result = await deleteMessage(settings, { folder, uid: uidOf(req.params.uid), trashFolder: trash });
    res.json({ ok: true, message: result.moved ? `Moved to ${result.to}.` : 'Message deleted.' });
  }),
);

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

const splitAddresses = (value) =>
  String(value || '')
    .split(/[,;]/)
    .map((r) => r.trim())
    .filter(Boolean);

mailAppRouter.post(
  '/send',
  upload.array('attachments', 10),
  asyncHandler(async (req, res) => {
    const session = req.session.mail;
    if (!session.canSend) throw badRequest('Sending is not configured for this mailbox.');

    const to = splitAddresses(req.body.to);
    if (!to.length) throw badRequest('At least one recipient is required.');

    const result = await sendMessage(credentials(req, 'smtp'), {
      // Always the signed-in mailbox: the server would reject anything else.
      from: session.address,
      to,
      cc: splitAddresses(req.body.cc),
      bcc: splitAddresses(req.body.bcc),
      subject: req.body.subject || '(no subject)',
      text: req.body.text || '',
      inReplyTo: req.body.inReplyTo || undefined,
      references: req.body.references || undefined,
      attachments: (req.files || []).map((f) => ({
        filename: f.originalname,
        content: f.buffer,
        contentType: f.mimetype,
      })),
    });

    // File a copy in Sent, the way a mail client does. Best effort: failing to
    // keep a copy must not make a delivered message look undelivered.
    let filed = false;
    if (result.raw) {
      const folders = await listFolders(credentials(req)).catch(() => []);
      const sent = folders.find((f) => f.specialUse === 'sent')?.path || null;
      filed = await appendToSent(credentials(req), { sentFolder: sent, raw: result.raw });
    }

    res.json({
      ok: true,
      filedToSent: filed,
      rejected: result.rejected || [],
      message: `Sent to ${result.accepted?.length || to.length} recipient${
        (result.accepted?.length || to.length) === 1 ? '' : 's'
      }.`,
    });
  }),
);

/// The raw source of a message, so the UI can build a forward without
/// re-uploading the original's attachments.
mailAppRouter.post(
  '/messages/:uid/forward',
  validate(
    z.object({
      to: z.string().min(1).max(2000),
      text: z.string().max(200000).optional(),
      folder: z.string().max(255).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const session = req.session.mail;
    if (!session.canSend) throw badRequest('Sending is not configured for this mailbox.');

    const folder = req.body.folder || 'INBOX';
    const uid = uidOf(req.params.uid);
    const original = await getMessage(credentials(req), { folder, uid });
    const raw = await getRawMessage(credentials(req), { folder, uid });

    const to = splitAddresses(req.body.to);
    if (!to.length) throw badRequest('At least one recipient is required.');

    const result = await sendMessage(credentials(req, 'smtp'), {
      from: session.address,
      to,
      subject: /^fwd:/i.test(original.subject) ? original.subject : `Fwd: ${original.subject}`,
      text: `${req.body.text || ''}\n\n---------- Forwarded message ----------\nFrom: ${
        original.from?.[0]?.address || 'unknown'
      }\nSubject: ${original.subject}\n\n${original.text || ''}`,
      // The whole original travels as an attachment, so nothing is lost.
      attachments: [{ filename: 'forwarded-message.eml', content: raw, contentType: 'message/rfc822' }],
    });

    res.json({ ok: true, message: `Forwarded to ${result.accepted?.length || to.length} recipient(s).` });
  }),
);

mailAppRouter.post(
  '/test-send',
  asyncHandler(async (req, res) => {
    await verifySmtp(credentials(req, 'smtp'));
    res.json({ ok: true });
  }),
);

/// Mail failures become ordinary HTTP errors.
mailAppRouter.use((err, req, res, next) => {
  if (err instanceof MailError) return res.status(err.status).json({ error: isAdmin(req.user) ? err.message : maskError(err.message) });
  next(err);
});
