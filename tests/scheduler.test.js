// Work that happens on its own: the nightly sync and expiry reminders.
//
// The hard part of a scheduler is not making it run. It is making it run
// exactly once, in the right hour, in somebody else's timezone, on a machine
// that keeps being redeployed — and catching up rather than silently skipping
// a day when it was switched off. Each of those is a test here.
//
// The reminder rules get the same treatment. A warning that goes out twice
// trains people to ignore it; one that never goes out costs somebody their
// domain. The property that prevents both is a unique key on (domain, rung,
// expiry date), and this file leans on it hard — including the case that
// justifies it, a domain being renewed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import { PrismaClient } from '@prisma/client';
import { dueMomentFor, isDue } from '../src/services/scheduler.js';
import { parseLadder, rungFor, daysUntil } from '../src/services/expiryService.js';

const PORT = 3973;
const BASE = `http://127.0.0.1:${PORT}`;
const prisma = new PrismaClient();

const stamp = Date.now();
const ALERT_TO = `sched-ops-${stamp}@example.com`;
const userEmail = `sched+${stamp}@example.com`;
const userPassword = 'SchedUser@12345';
const DAY = 24 * 60 * 60 * 1000;

/// Domains at each interesting distance from expiry.
const NAMES = {
  far: `far-${stamp}.example`,
  soon: `soon-${stamp}.example`,
  tomorrow: `tomorrow-${stamp}.example`,
  expired: `expired-${stamp}.example`,
  ancient: `ancient-${stamp}.example`,
};

let smtpServer;
let server;
const received = [];

const admin = client();
const member = client();
const ctx = { domainIds: {} };
let originalSettings = null;

const ignoreResets = (s) => {
  s.on('clientError', () => {});
  s.on('error', () => {});
  s.on('connection', (socket) => socket.on('error', () => {}));
  return s;
};

function client() {
  let cookie = '';
  return async function call(pathname, { method = 'GET', body } = {}) {
    const res = await fetch(`${BASE}${pathname}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        Connection: 'close',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, data };
  };
}

async function waitForMail(pattern, timeoutMs = 12000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const hit = [...received].reverse().find((m) => pattern.test(m.subject || ''));
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

/// Waits for a message matching an arbitrary test, not just a subject.
///
/// Needed because the two copies of a reminder — yours and the customer's —
/// share a subject and arrive independently. Scanning once would sometimes
/// find only whichever landed first.
async function waitForMailWhere(predicate, timeoutMs = 12000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const hit = [...received].reverse().find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

async function expectNoMail(pattern, waitMs = 2500) {
  await new Promise((r) => setTimeout(r, waitMs));
  return !received.some((m) => pattern.test(m.subject || ''));
}

/// Moves a domain's expiry, as a renewal or a correction would.
const setExpiry = (name, daysFromNow) =>
  prisma.domain.update({
    where: { name },
    data: { expiresAt: new Date(Date.now() + daysFromNow * DAY) },
  });

const runReminders = () => admin('/api/settings/jobs/domain-expiry/run', { method: 'POST' });

const remindersFor = (name) =>
  prisma.expiryReminder.findMany({
    where: { domain: { name } },
    orderBy: { daysBefore: 'desc' },
  });

test.before(async () => {
  smtpServer = new SMTPServer({
    disabledCommands: ['STARTTLS'],
    authOptional: true,
    onData(stream, _session, callback) {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', async () => {
        received.push(await simpleParser(Buffer.concat(chunks)));
        callback();
      });
    },
  });
  ignoreResets(smtpServer.server);
  await new Promise((r) => smtpServer.listen(0, '127.0.0.1', r));
  const smtpPort = smtpServer.server.address().port;

  server = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      NOTIFY_BURST_LIMIT: '100000',
      // The timer is never allowed to fire on its own here: every run in this
      // file is started deliberately, so a test cannot be raced by one that
      // happened in the background.
      SCHEDULER_TICK_MS: String(60 * 60 * 1000),
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 80; i += 1) {
    try {
      if ((await fetch(`${BASE}/api/health`, { headers: { Connection: 'close' } })).ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  await admin('/api/auth/login', { method: 'POST', body: { email: 'admin@example.com', password: 'Admin@12345' } });
  originalSettings = await prisma.appSettings.findUnique({ where: { id: 'default' } });

  await admin('/api/settings', {
    method: 'PUT',
    body: {
      smtpHost: '127.0.0.1',
      smtpPort,
      smtpSecure: false,
      smtpUser: '',
      fromAddress: 'portal@example.com',
      fromName: 'Hosting Portal',
      notifyEmails: ALERT_TO,
      notifyEnabled: true,
      notifySchedule: true,
      expiryReminderDays: '30,15,7,1',
      expiryRemindCustomer: false,
    },
  });

  for (const [key, name] of Object.entries(NAMES)) {
    const res = await admin('/api/domains', { method: 'POST', body: { name } });
    ctx.domainIds[key] = res.data.domain.id;
  }

  await setExpiry(NAMES.far, 200);
  await setExpiry(NAMES.soon, 14);
  await setExpiry(NAMES.tomorrow, 1);
  await setExpiry(NAMES.expired, -3);
  await setExpiry(NAMES.ancient, -400);

  const user = await admin('/api/users', {
    method: 'POST',
    body: { name: 'Sched User', email: userEmail, password: userPassword, role: 'USER' },
  });
  ctx.userId = user.data.user.id;
  await admin(`/api/users/${ctx.userId}/domains`, { method: 'PUT', body: { domainIds: [ctx.domainIds.soon] } });
  await member('/api/auth/login', { method: 'POST', body: { email: userEmail, password: userPassword } });
});

test.after(async () => {
  try {
    await prisma.expiryReminder.deleteMany({ where: { domain: { name: { in: Object.values(NAMES) } } } });
    if (ctx.userId) await admin(`/api/users/${ctx.userId}`, { method: 'DELETE' });
    await prisma.domain.deleteMany({ where: { name: { in: Object.values(NAMES) } } });
    await prisma.activityLog.deleteMany({ where: { event: { startsWith: 'schedule.' } } });
    await prisma.scheduledJob.deleteMany({ where: { id: { in: ['domain-expiry', 'nightly-sync'] } } });

    if (originalSettings) {
      const { id, updatedAt, ...rest } = originalSettings;
      await prisma.appSettings.update({ where: { id: 'default' }, data: rest });
    }
    await prisma.$disconnect();
  } catch (err) {
    console.error('TEARDOWN:', err?.message);
  }
  server?.kill();
  await new Promise((r) => smtpServer.close(r));
});

// ---------------------------------------------------------------------------
// When a job is owed a run
// ---------------------------------------------------------------------------

const settings = (over = {}) => ({
  jobsEnabled: true,
  jobHour: 2,
  jobTimezoneOffset: 330,
  autoSyncEnabled: true,
  expiryRemindersEnabled: true,
  ...over,
});

test('the hour is read in the configured timezone, not the container’s', () => {
  // 02:00 IST is 20:30 UTC the day before. A container running in UTC must
  // still fire this when the operator's clock says two in the morning.
  const due = dueMomentFor(settings(), new Date('2026-06-15T12:00:00Z'));
  assert.equal(due.toISOString(), '2026-06-14T20:30:00.000Z');

  // The same setting in UTC is exactly 02:00 UTC.
  const utc = dueMomentFor(settings({ jobTimezoneOffset: 0 }), new Date('2026-06-15T12:00:00Z'));
  assert.equal(utc.toISOString(), '2026-06-15T02:00:00.000Z');
});

test('a job is not due before its hour, and is due after it', () => {
  const job = { id: 'nightly-sync', lastRunAt: null, enabledBy: 'autoSyncEnabled' };

  // 19:00 UTC is 00:30 IST — before 02:00 IST.
  assert.equal(isDue(job, settings(), new Date('2026-06-15T19:00:00Z')), false);
  // 21:00 UTC is 02:30 IST — past it.
  assert.equal(isDue(job, settings(), new Date('2026-06-15T21:00:00Z')), true);
});

test('a job that already ran today is not run again', () => {
  const now = new Date('2026-06-15T23:00:00Z');
  const due = dueMomentFor(settings(), now);

  const ranAfter = { id: 'nightly-sync', lastRunAt: new Date(due.getTime() + 60000), enabledBy: 'autoSyncEnabled' };
  assert.equal(isDue(ranAfter, settings(), now), false, 'four redeploys before lunch must not sync four times');

  const ranYesterday = { id: 'nightly-sync', lastRunAt: new Date(due.getTime() - DAY), enabledBy: 'autoSyncEnabled' };
  assert.equal(isDue(ranYesterday, settings(), now), true);
});

test('a machine that was off at the hour catches up rather than skipping a day', () => {
  // It is now 09:00 IST and the 02:00 run never happened, because the
  // container was down. That run is still owed — a missed sync is the case
  // this feature exists for.
  const now = new Date('2026-06-15T03:30:00Z'); // 09:00 IST
  const job = { id: 'nightly-sync', lastRunAt: new Date('2026-06-13T21:00:00Z'), enabledBy: 'autoSyncEnabled' };
  assert.equal(isDue(job, settings(), now), true);
});

test('nothing is due while the master switch is off', () => {
  const job = { id: 'nightly-sync', lastRunAt: null, enabledBy: 'autoSyncEnabled' };
  assert.equal(isDue(job, settings({ jobsEnabled: false }), new Date('2026-06-15T21:00:00Z')), false);
  assert.equal(isDue(job, settings({ autoSyncEnabled: false }), new Date('2026-06-15T21:00:00Z')), false);
});

// ---------------------------------------------------------------------------
// The reminder ladder
// ---------------------------------------------------------------------------

test('the ladder is sorted, de-duplicated and defended against nonsense', () => {
  assert.deepEqual(parseLadder('7,30,15,1'), [30, 15, 7, 1]);
  assert.deepEqual(parseLadder('30, 30, 7'), [30, 7]);
  assert.deepEqual(parseLadder('30;15 7'), [30, 15, 7]);
  assert.deepEqual(parseLadder('abc, -5, 900, 10'), [10], 'only whole days inside a year');
  assert.deepEqual(parseLadder(''), []);
  assert.deepEqual(parseLadder(null), []);
});

test('a domain first seen close to expiry gets the rung it has reached', () => {
  const ladder = [30, 15, 7, 1];
  // Nine days left and never warned: the 7-day rung, not silence until the
  // last day.
  assert.equal(rungFor(9, ladder), 15);
  assert.equal(rungFor(30, ladder), 30);
  assert.equal(rungFor(31, ladder), null, 'too far out to be news');
  assert.equal(rungFor(1, ladder), 1);
  assert.equal(rungFor(0, ladder), 1);
});

test('days remaining is counted in whole days, not hours', () => {
  const noon = new Date('2026-06-15T12:00:00Z');
  assert.equal(daysUntil(new Date('2026-06-16T01:00:00Z'), noon), 1);
  assert.equal(daysUntil(new Date('2026-06-15T23:59:00Z'), noon), 0);
  assert.equal(daysUntil(new Date('2026-06-12T00:00:00Z'), noon), -3);
});

// ---------------------------------------------------------------------------
// Running the reminders
// ---------------------------------------------------------------------------

test('a run warns about what is close and ignores what is not', async () => {
  const res = await runReminders();
  assert.equal(res.status, 200);
  assert.equal(res.data.ok, true);

  assert.ok(await waitForMail(new RegExp(`${NAMES.soon} expires in 14 days`)), 'fourteen days out is worth saying');
  assert.ok(await waitForMail(new RegExp(`${NAMES.tomorrow} expires in 1 day`)));
  assert.ok(await waitForMail(new RegExp(`${NAMES.expired} expired 3 days ago`)));

  assert.ok(await expectNoMail(new RegExp(NAMES.far)), 'two hundred days out is not news');
  assert.ok(await expectNoMail(new RegExp(NAMES.ancient)), 'and neither is a year gone');
});

test('the ladder rung is the one the domain has reached', async () => {
  const soon = await remindersFor(NAMES.soon);
  assert.equal(soon.length, 1);
  assert.equal(soon[0].daysBefore, 15, 'fourteen days left sits on the 15-day rung');

  const tomorrow = await remindersFor(NAMES.tomorrow);
  assert.equal(tomorrow[0].daysBefore, 1);
});

test('running again the same day sends nothing twice', async () => {
  const before = received.length;
  const res = await runReminders();

  assert.equal(res.status, 200);
  assert.match(res.data.message, /Nothing expiring soon/);
  await new Promise((r) => setTimeout(r, 1500));

  const fresh = received.slice(before).filter((m) => /expires in|expired \d+ days ago/.test(m.subject || ''));
  assert.equal(fresh.length, 0, 'a warning sent twice trains people to ignore it');
});

test('crossing to the next rung warns again', async () => {
  // Fourteen days became six: a different rung, so a different warning.
  await setExpiry(NAMES.soon, 6);
  await runReminders();

  assert.ok(await waitForMail(new RegExp(`${NAMES.soon} expires in 6 days`)));

  const rungs = (await remindersFor(NAMES.soon)).map((r) => r.daysBefore);
  assert.deepEqual(rungs, [15, 7], 'both rungs recorded, neither repeated');
});

test('renewing a domain resets the whole ladder, with no code to reset it', async () => {
  // This is the property the unique key buys: the key includes the expiry
  // date, so moving the date makes every rung due again for the new one.
  await setExpiry(NAMES.soon, 400);
  await runReminders();
  assert.ok(await expectNoMail(/expires in 400/), 'nothing due at four hundred days');

  // A year later it comes round again.
  await setExpiry(NAMES.soon, 20);
  await runReminders();

  assert.ok(await waitForMail(new RegExp(`${NAMES.soon} expires in 20 days`)), 'warned again for the new date');

  // Scoped to the new expiry date, because earlier rungs in this file were
  // recorded against the dates this domain had before.
  const { expiresAt } = await prisma.domain.findUnique({ where: { name: NAMES.soon } });
  const day = new Date(Date.UTC(expiresAt.getUTCFullYear(), expiresAt.getUTCMonth(), expiresAt.getUTCDate()));

  const forNewDate = await prisma.expiryReminder.findMany({
    where: { domain: { name: NAMES.soon }, expiresOn: day },
  });
  assert.equal(forNewDate.length, 1, 'one rung so far for the renewed date');
  assert.equal(forNewDate[0].daysBefore, 30, 'a fresh ladder for the renewed date');
});

test('the customer is only told when that is switched on', async () => {
  // Off by default, because telling a customer is a business decision.
  await setExpiry(NAMES.tomorrow, 25);
  await runReminders();
  await new Promise((r) => setTimeout(r, 1200));

  const sent = await prisma.expiryReminder.findFirst({
    where: { domain: { name: NAMES.tomorrow }, daysBefore: 30 },
  });
  assert.ok(sent);
  assert.equal(sent.sentTo, null, 'nobody outside was emailed');

  // Switched on, the assigned customer is emailed too.
  await admin('/api/settings', { method: 'PUT', body: { expiryRemindCustomer: true } });
  await setExpiry(NAMES.soon, 5);
  await runReminders();

  const mail = await waitForMail(new RegExp(`${NAMES.soon} expires in 5 days`));
  assert.ok(mail);

  // The newest row: this domain has been walked up and down the ladder by the
  // tests above, so there is more than one rung recorded against it.
  const record = await prisma.expiryReminder.findFirst({
    where: { domain: { name: NAMES.soon }, daysBefore: 7 },
    orderBy: { sentAt: 'desc' },
  });
  assert.ok(record?.sentTo?.includes(userEmail), 'and it is recorded who was told');

  await admin('/api/settings', { method: 'PUT', body: { expiryRemindCustomer: false } });
});

test('the customer’s copy explains the consequence, not just the date', async () => {
  // Both copies carry the same subject and arrive independently, so this one
  // is picked out by who it went to and waited for rather than scanned for:
  // whichever landed first is not necessarily the one being tested.
  const subject = new RegExp(`${NAMES.soon} expires in 5 days`);

  const mail = await waitForMailWhere(
    (m) => subject.test(m.subject || '') && String(m.to?.text || '').includes(userEmail),
  );
  assert.ok(mail, 'the customer got their own copy');
  assert.ok(mail.text.includes('website'), 'a customer needs to know what stops working');
  assert.ok(/renew/i.test(mail.text));

  // Yours is the other one, written for somebody who already knows what a
  // domain is.
  const ours = await waitForMailWhere(
    (m) => subject.test(m.subject || '') && String(m.to?.text || '').includes(ALERT_TO),
  );
  assert.ok(ours, 'you are told as well');
  assert.ok(!ours.text.includes('Your domain'), 'and not in the customer wording');
});

// ---------------------------------------------------------------------------
// The job runner
// ---------------------------------------------------------------------------

test('a run is recorded whether it worked or not', async () => {
  const { data } = await admin('/api/settings/jobs');
  const expiry = data.jobs.find((j) => j.id === 'domain-expiry');

  assert.ok(expiry.lastRunAt, 'when');
  assert.equal(expiry.lastOk, true, 'and whether');
  assert.ok(typeof expiry.lastDurationMs === 'number', 'and how long — a switch that is on says nothing');
  assert.equal(expiry.running, false);
});

test('the nightly sync copes with having no providers to sync', async () => {
  const res = await admin('/api/settings/jobs/nightly-sync/run', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(res.data.ok, true);
});

test('running a job by hand is recorded as having been done by hand', async () => {
  const entry = await prisma.activityLog.findFirst({
    where: { event: 'schedule.nightly-sync.manual' },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(entry);
  assert.match(entry.actorLabel || '', /admin@example\.com/);
});

test('an unknown job is refused rather than silently doing nothing', async () => {
  const res = await admin('/api/settings/jobs/not-a-job/run', { method: 'POST' });
  assert.equal(res.status, 400);
});

test('the schedule is Super Admin territory', async () => {
  assert.equal((await member('/api/settings/jobs')).status, 403);
  assert.equal((await member('/api/settings/jobs/domain-expiry/run', { method: 'POST' })).status, 403);
});

test('a reminder day list that is not days is refused', async () => {
  for (const expiryReminderDays of ['thirty', '30,abc', '-1', '400']) {
    const res = await admin('/api/settings', { method: 'PUT', body: { expiryReminderDays } });
    assert.equal(res.status, 400, `"${expiryReminderDays}" should be refused`);
  }
  // And a good one is kept.
  assert.equal((await admin('/api/settings', { method: 'PUT', body: { expiryReminderDays: '45,30,7' } })).status, 200);
});

test('the next run is worked out from the last one', async () => {
  await admin('/api/settings', { method: 'PUT', body: { jobsEnabled: true, jobHour: 3, jobTimezoneOffset: 330 } });

  const { data } = await admin('/api/settings/jobs');
  const expiry = data.jobs.find((j) => j.id === 'domain-expiry');

  assert.ok(expiry.nextRunAt, 'it says when it will happen next');
  assert.ok(new Date(expiry.nextRunAt) > new Date(), 'and that is in the future');

  // Off means off, and the page says so rather than showing a time.
  await admin('/api/settings', { method: 'PUT', body: { jobsEnabled: false } });
  const off = await admin('/api/settings/jobs');
  assert.equal(off.data.jobs.find((j) => j.id === 'domain-expiry').nextRunAt, null);
  assert.equal(off.data.jobs.find((j) => j.id === 'domain-expiry').enabled, false);
});
