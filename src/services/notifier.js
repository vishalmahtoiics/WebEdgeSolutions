// Recording what changed, and telling somebody about it.
//
// The order of operations here is the whole design. A change is written to the
// activity log first and emailed second, in the background, and no failure on
// the email side is ever allowed to travel back to the request. Three things
// follow from that, and each one is deliberate:
//
//   A mail server that is down, slow, or misconfigured costs you the
//   notification and never the record, and never the action. Somebody deleting
//   a DNS record must not see an error because an SMTP host stopped answering.
//
//   Sending happens after the response has gone out. An SMTP handshake can take
//   seconds; nobody should wait through one to find out their file saved.
//
//   A burst is capped. A bulk operation — twenty files, a zone rebuilt — would
//   otherwise put twenty messages in an inbox, and an alert nobody can stand to
//   read is an alert nobody reads.

import { prisma } from '../db.js';
import { encrypt } from '../lib/crypto.js';
import { getAppSettings, recipients, send, friendly } from './mailer.js';

export { getAppSettings };

/// Which switch governs which event, by the event name's first part.
const AREA_SWITCH = {
  dns: 'notifyDns',
  email: 'notifyEmailMgmt',
  files: 'notifyFiles',
  database: 'notifyDatabase',
  user: 'notifyUsers',
  settings: 'notifySettings',
  order: 'notifyOrders',
  security: 'notifySecurity',
  support: 'notifySupport',
  schedule: 'notifySchedule',
  billing: 'notifyBilling',
  deploy: 'notifyDeploy',
};

/// How many alerts may be sent in a rolling window before the rest are
/// summarised instead. Sized so an ordinary busy hour goes through untouched
/// and a runaway loop does not, and tunable for a portal busier than that.
const BURST_LIMIT = Number(process.env.NOTIFY_BURST_LIMIT) || 30;
const BURST_WINDOW_MS = 10 * 60 * 1000;

/// Times of recent sends, for the burst cap. In memory on purpose: it is a
/// safety valve, not a record, and it should reset when the process does.
let recentSends = [];
let suppressedSinceCap = 0;

/// The settings as the browser may see them: everything except the password,
/// which never leaves this process.
export function presentAppSettings(settings) {
  const { smtpPassword, ...rest } = settings;
  return { ...rest, hasSmtpPassword: Boolean(smtpPassword) };
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/// Records a change and, if notifications are on for its area, emails it.
///
/// Never throws. The caller is in the middle of doing something for somebody,
/// and a problem here is not their problem.
export async function record({ event, actor, summary, detail, domain, ip }) {
  let entry;
  try {
    entry = await prisma.activityLog.create({
      data: {
        event,
        actorId: actor?.id || null,
        actorLabel: actor ? `${actor.name} <${actor.email}>` : null,
        actorRole: actor?.role || null,
        summary,
        detail: detail || null,
        domainId: domain?.id || null,
        domainName: domain?.name || null,
        ip: ip || null,
      },
    });
  } catch (err) {
    // Even the record failing must not reach the caller. Logged so it is not
    // silent, and then dropped.
    console.error('activity log failed:', err?.message);
    return null;
  }

  // Deliberately not awaited: the response should not wait on an SMTP
  // handshake. Any rejection is caught inside.
  queueMicrotask(() => {
    deliver(entry).catch((err) => console.error('notification failed:', err?.message));
  });

  return entry;
}

/// Whether this event's area is switched on, so a caller can skip work it only
/// does in order to describe something.
export async function willNotify(event) {
  const settings = await getAppSettings().catch(() => null);
  if (!settings?.notifyEnabled || !settings.smtpHost || !recipients(settings).length) return false;
  const key = AREA_SWITCH[String(event).split('.')[0]];
  return key ? settings[key] !== false : true;
}

async function deliver(entry) {
  const settings = await getAppSettings();

  if (!settings.notifyEnabled) return skip(entry, null);
  if (!settings.smtpHost) return skip(entry, 'No SMTP server is configured.');

  const to = recipients(settings);
  if (!to.length) return skip(entry, 'No notification address is set.');

  const key = AREA_SWITCH[entry.event.split('.')[0]];
  if (key && settings[key] === false) return skip(entry, null);

  // The burst cap. Past it, one message says how many were held back rather
  // than the inbox filling with the rest.
  const now = Date.now();
  recentSends = recentSends.filter((t) => now - t < BURST_WINDOW_MS);
  if (recentSends.length >= BURST_LIMIT) {
    suppressedSinceCap += 1;
    if (suppressedSinceCap === 1) {
      await send(settings, to, {
        subject: 'Too many changes to alert on individually',
        text:
          `More than ${BURST_LIMIT} alerts were sent in the last ${BURST_WINDOW_MS / 60000} minutes, ` +
          'so the rest are being held back to keep this inbox usable.\n\n' +
          'Everything is still being recorded — open Settings → Activity in the portal to see it all.',
      }).catch(() => {});
    }
    return skip(entry, `Held back: more than ${BURST_LIMIT} alerts in ${BURST_WINDOW_MS / 60000} minutes.`);
  }

  try {
    await send(settings, to, compose(entry));
    recentSends.push(now);
    suppressedSinceCap = 0;
    await prisma.activityLog.update({ where: { id: entry.id }, data: { notified: true, notifyError: null } });
  } catch (err) {
    await skip(entry, friendly(err));
  }
}

const skip = (entry, reason) =>
  prisma.activityLog
    .update({ where: { id: entry.id }, data: { notified: false, notifyError: reason } })
    .catch(() => null);

/// The message. Plain text on purpose: these are read on a phone, often in a
/// hurry, and the first line should say everything that matters.
function compose(entry) {
  const who = entry.actorLabel || 'the system';
  const where = entry.domainName ? ` on ${entry.domainName}` : '';

  const lines = [
    entry.summary,
    '',
    `Who:    ${who}${entry.actorRole ? ` (${entry.actorRole === 'SUPER_ADMIN' ? 'Super Admin' : 'User'})` : ''}`,
    `When:   ${new Date(entry.createdAt).toLocaleString()}`,
    entry.domainName ? `Domain: ${entry.domainName}` : null,
    entry.ip ? `From:   ${entry.ip}` : null,
    `Event:  ${entry.event}`,
  ].filter((l) => l !== null);

  if (entry.detail) lines.push('', entry.detail);
  lines.push('', '—', 'You are receiving this because notifications are on in the portal settings.');

  return {
    // The domain in the subject is what makes these scannable in a list.
    subject: `${entry.summary}${where}`.slice(0, 160),
    text: lines.join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function saveAppSettings(data) {
  const patch = { ...data };
  // An empty password field means "leave it alone", so the host can be edited
  // without retyping the secret.
  if (patch.smtpPassword) patch.smtpPassword = encrypt(patch.smtpPassword);
  else delete patch.smtpPassword;

  return prisma.appSettings.upsert({
    where: { id: 'default' },
    create: { id: 'default', ...patch },
    update: patch,
  });
}

/// Sends a real message through the configured server, so the settings page can
/// say whether it works rather than leaving you to find out at the worst
/// moment. Unlike everything else here, this one reports its failure.
export async function sendTestEmail(actor) {
  const settings = await getAppSettings();
  if (!settings.smtpHost) throw new Error('Add an SMTP host first.');

  const to = recipients(settings);
  if (!to.length) throw new Error('Add at least one address to send notifications to.');

  try {
    await send(settings, to, {
      subject: 'Test alert from your hosting portal',
      text:
        'This is a test.\n\n' +
        'If you are reading it, notifications are working and alerts will arrive here ' +
        'when somebody changes something.\n\n' +
        `Sent by: ${actor ? `${actor.name} <${actor.email}>` : 'the portal'}\n` +
        `At:      ${new Date().toLocaleString()}\n` +
        `Server:  ${settings.smtpHost}:${settings.smtpPort || (settings.smtpSecure ? 465 : 587)}\n`,
    });
    return { ok: true, sentTo: to };
  } catch (err) {
    throw new Error(friendly(err));
  }
}

/// For tests, which need the cap to start from a known state.
export const __resetBurst = () => {
  recentSends = [];
  suppressedSinceCap = 0;
};
