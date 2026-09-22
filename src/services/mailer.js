// The one place this portal sends mail from.
//
// Separate from the notifier because three different things now need to send
// through the same server — change alerts, expiry warnings to customers, and
// invoices — and they must not each grow their own idea of how to connect.
// One transport definition means one place to fix a TLS quirk, one place that
// knows what a timeout means, and one set of error messages that read like
// somebody wrote them.
//
// Nothing here decides *whether* to send. That is the caller's business: the
// notifier has switches per area, the scheduler has its own, and this module
// just does as it is told.

import nodemailer from 'nodemailer';
import { prisma } from '../db.js';
import { decryptMaybe } from '../lib/crypto.js';

const SEND_TIMEOUT_MS = 15000;

export async function getAppSettings() {
  return prisma.appSettings.upsert({
    where: { id: 'default' },
    create: { id: 'default' },
    update: {},
  });
}

/// The addresses alerts go to, from the comma-separated list in settings.
export const recipients = (settings) =>
  String(settings.notifyEmails || '')
    .split(/[,;\s]+/)
    .map((e) => e.trim())
    .filter((e) => e.includes('@'));

export function transportFor(settings) {
  const port = settings.smtpPort || (settings.smtpSecure ? 465 : 587);
  return nodemailer.createTransport({
    host: settings.smtpHost,
    port,
    secure: settings.smtpSecure !== false && port === 465,
    auth: settings.smtpUser
      ? { user: settings.smtpUser, pass: decryptMaybe(settings.smtpPassword) }
      : undefined,
    connectionTimeout: SEND_TIMEOUT_MS,
    greetingTimeout: SEND_TIMEOUT_MS,
    socketTimeout: SEND_TIMEOUT_MS,
    // Hosting providers very often present a certificate that does not match
    // the host name they tell you to use. Refusing those would make this
    // unusable on exactly the servers it is meant for; the same trade-off is
    // documented for FTPS and IMAP elsewhere in this project.
    tls: { rejectUnauthorized: false },
  });
}

export const fromHeader = (settings) =>
  settings.fromName
    ? `"${settings.fromName}" <${settings.fromAddress || settings.smtpUser}>`
    : settings.fromAddress || settings.smtpUser;

/// SMTP failures, in words somebody can act on.
///
/// The port-and-encryption case is here because it is by far the most common
/// way this is set up wrong, and the raw error for it ("wrong version number")
/// tells you nothing at all.
export const friendly = (err) => {
  const message = err?.message || 'Unknown error';
  const code = err?.code || '';
  if (code === 'EAUTH' || /535|authentication/i.test(message)) {
    return 'The mail server rejected the username or password.';
  }
  if (code === 'ENOTFOUND') return 'The SMTP host could not be found. Check the host name.';
  if (code === 'ECONNREFUSED') return 'The server refused the connection. Check the host and port.';
  if (code === 'ETIMEDOUT' || /timed? ?out/i.test(message)) {
    return 'The mail server did not respond in time. Check the port — 465 is usually encrypted, 587 usually is not.';
  }
  if (/wrong version number|ssl/i.test(message)) {
    return 'The connection failed in a way that usually means the port and the encryption setting disagree. ' +
      'Try 465 with encryption on, or 587 with it off.';
  }
  return message;
};

/// Sends one message through the configured server.
///
/// The transport is created and closed per send rather than pooled. A pooled
/// connection to somebody else's SMTP server sitting open for days is a
/// connection that will be dropped at some point without telling us, and
/// finding that out at the moment an alert matters is the wrong time.
export async function send(settings, to, { subject, text, html, replyTo, attachments }) {
  const transport = transportFor(settings);
  try {
    await transport.sendMail({
      from: fromHeader(settings),
      to: Array.isArray(to) ? to.join(', ') : to,
      replyTo: replyTo || undefined,
      subject,
      text,
      html: html || undefined,
      attachments: attachments || undefined,
    });
  } finally {
    transport.close();
  }
}

/// Sends to an address of the caller's choosing — a customer, not the alert
/// list.
///
/// Unlike the notifier this reports its failure, because every caller is doing
/// something a person asked for and can say so on screen.
export async function sendDirect({ to, subject, text, html, replyTo, attachments }) {
  const settings = await getAppSettings();
  if (!settings.smtpHost) throw new Error('No SMTP server is configured. Set one up under Alerts & Activity.');

  const list = (Array.isArray(to) ? to : [to]).map((e) => String(e || '').trim()).filter((e) => e.includes('@'));
  if (!list.length) throw new Error('No valid email address to send to.');

  try {
    await send(settings, list, { subject, text, html, replyTo, attachments });
    return { ok: true, sentTo: list };
  } catch (err) {
    throw new Error(friendly(err));
  }
}
