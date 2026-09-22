// Work that happens on its own, once a day.
//
// There is no cron here and no extra process: a timer inside the app checks
// every few minutes whether today's run is still owed, and runs it if so. That
// is deliberate — an external scheduler is another thing to deploy, another
// thing to forget, and another thing that can be running against a database
// whose app has moved on.
//
// Three properties are what make this safe to leave switched on:
//
//   It runs once per day, not once per tick. What decides that is the
//   recorded time of the last run, not a counter in memory, so a container
//   redeployed four times before lunch still syncs once.
//
//   It catches up. A machine that was off at 2am runs the job when it comes
//   back, rather than skipping a day in silence. A missed sync is the case
//   this feature exists for.
//
//   Two copies cannot both run. The lock is a column, taken with a
//   conditional UPDATE, so two containers behind a load balancer race for one
//   row and exactly one wins.

import { prisma } from '../db.js';
import { getAppSettings, record } from './notifier.js';
import { runExpiryReminders } from './expiryService.js';
import { syncEverything } from './syncService.js';

/// How often to look. Five minutes is frequent enough that a job starts near
/// the hour it was asked for, and rare enough to be free.
const TICK_MS = Number(process.env.SCHEDULER_TICK_MS) || 5 * 60 * 1000;

/// A lock older than this belonged to a process that died holding it. Sized
/// well past how long a full sync of a large account takes.
const STALE_LOCK_MS = 60 * 60 * 1000;

/// The jobs, in the order they should run when both are due. Sync first: a
/// reminder is worth more when it is working from figures pulled an hour ago
/// than from last week's.
export const JOBS = {
  'nightly-sync': {
    label: 'Nightly sync',
    enabledBy: 'autoSyncEnabled',
    run: runNightlySync,
  },
  'domain-expiry': {
    label: 'Domain expiry reminders',
    enabledBy: 'expiryRemindersEnabled',
    run: runExpiryReminders,
  },
};

let timer = null;

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/// The moment today's run was due, as an absolute time.
///
/// The offset is stored rather than read from the host clock because the host
/// is usually a container running in UTC while the person who set "2am" meant
/// 2am where they live.
export function dueMomentFor(settings, now = new Date()) {
  const offsetMs = (settings.jobTimezoneOffset ?? 330) * 60 * 1000;
  const local = new Date(now.getTime() + offsetMs);

  // Midnight of the local day, expressed back in real time.
  const localMidnight = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
  ) - offsetMs;

  return new Date(localMidnight + (settings.jobHour ?? 2) * 60 * 60 * 1000);
}

/// Whether a job is owed a run.
///
/// True when the hour has come round and the last run was before it. That one
/// sentence gives both "once a day" and "catch up after downtime" without a
/// separate rule for either.
export function isDue(job, settings, now = new Date()) {
  if (!settings.jobsEnabled) return false;
  if (settings[JOBS[job.id]?.enabledBy ?? job.enabledBy] === false) return false;

  const due = dueMomentFor(settings, now);
  if (now < due) return false;
  return !job.lastRunAt || new Date(job.lastRunAt) < due;
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

const jobRow = (id) =>
  prisma.scheduledJob.upsert({ where: { id }, create: { id }, update: {} });

/// Takes the lock, or reports that somebody else has it.
///
/// A conditional UPDATE is the whole mechanism: the database decides the race,
/// so two containers cannot both believe they won. Checking and then writing
/// would leave a gap between the two in which both could pass.
async function takeLock(id) {
  const stale = new Date(Date.now() - STALE_LOCK_MS);
  const { count } = await prisma.scheduledJob.updateMany({
    where: { id, OR: [{ runningSince: null }, { runningSince: { lt: stale } }] },
    data: { runningSince: new Date() },
  });
  return count === 1;
}

/// Runs one job and records what happened, whether it worked or not.
///
/// Never throws. This is called from a timer with nobody watching, and an
/// unhandled rejection there would take the process down — losing not just
/// this job but the portal everyone is using.
export async function runJob(id, { manual = false, actor = null } = {}) {
  const definition = JOBS[id];
  if (!definition) throw new Error(`Unknown job: ${id}`);

  await jobRow(id);
  if (!(await takeLock(id))) {
    return { id, ran: false, reason: 'Already running.' };
  }

  const startedAt = Date.now();
  let ok = false;
  let message;

  try {
    const result = await definition.run({ manual, actor });
    ok = true;
    message = result?.summary || 'Done.';

    // A scheduled run that did something is worth an alert; one that found
    // nothing to do is not. Nobody needs an email every night saying nothing
    // happened — that is how people learn to ignore the sender.
    if (!manual && result?.notable) {
      await record({
        event: `schedule.${id}.completed`,
        summary: `${definition.label}: ${message}`,
        detail: result.detail || null,
      });
    }
    return { id, ran: true, ok: true, message, ...result };
  } catch (err) {
    message = err?.message || 'Failed.';
    // A failure always gets an alert. Silence here is exactly the failure
    // mode this whole feature exists to prevent.
    await record({
      event: `schedule.${id}.failed`,
      summary: `${definition.label} failed`,
      detail: message,
    });
    return { id, ran: true, ok: false, message };
  } finally {
    await prisma.scheduledJob
      .update({
        where: { id },
        data: {
          runningSince: null,
          lastRunAt: new Date(),
          lastOk: ok,
          lastMessage: String(message ?? '').slice(0, 500),
          lastDurationMs: Date.now() - startedAt,
        },
      })
      .catch((err) => console.error(`[scheduler] could not record ${id}:`, err?.message));
  }
}

/// One pass: run whatever is owed. Exported so a test can drive it directly
/// rather than waiting for a timer.
export async function tick(now = new Date()) {
  const settings = await getAppSettings().catch(() => null);
  if (!settings?.jobsEnabled) return [];

  const ran = [];
  for (const [id, definition] of Object.entries(JOBS)) {
    if (settings[definition.enabledBy] === false) continue;
    const row = await jobRow(id);
    if (!isDue({ ...row, id }, settings, now)) continue;
    ran.push(await runJob(id));
  }
  return ran;
}

export function startScheduler() {
  if (timer) return timer;
  timer = setInterval(() => {
    tick().catch((err) => console.error('[scheduler]', err?.message));
  }, TICK_MS);
  // Never hold the process open. A container being shut down should not wait
  // out a five-minute timer to exit.
  timer.unref?.();
  return timer;
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

/// Every job with its last result, for the settings page.
export async function jobStatus() {
  const settings = await getAppSettings();
  const rows = await prisma.scheduledJob.findMany();
  const byId = new Map(rows.map((r) => [r.id, r]));

  return Object.entries(JOBS).map(([id, definition]) => {
    const row = byId.get(id) || { id };
    return {
      id,
      label: definition.label,
      enabled: Boolean(settings.jobsEnabled) && settings[definition.enabledBy] !== false,
      lastRunAt: row.lastRunAt ?? null,
      lastOk: row.lastOk ?? null,
      lastMessage: row.lastMessage ?? null,
      lastDurationMs: row.lastDurationMs ?? null,
      running: Boolean(row.runningSince),
      nextRunAt: nextRunAt(row, settings),
    };
  });
}

function nextRunAt(row, settings) {
  if (!settings.jobsEnabled) return null;
  const due = dueMomentFor(settings, new Date());
  // Today's slot if it has not been used yet, otherwise tomorrow's.
  if (!row.lastRunAt || new Date(row.lastRunAt) < due) return due;
  return new Date(due.getTime() + 24 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// The sync job
// ---------------------------------------------------------------------------

/// Syncs every active provider that has a credential.
///
/// One provider failing does not stop the others: the point of a nightly run
/// is that the data is fresh in the morning, and one broken token should cost
/// you one provider rather than all of them.
async function runNightlySync() {
  const providers = await prisma.provider.findMany({
    where: { isActive: true, credential: { isNot: null } },
    select: { id: true, name: true },
  });

  if (!providers.length) return { summary: 'No providers to sync.', notable: false };

  let imported = 0;
  let updated = 0;
  let dnsRecords = 0;
  let mailboxes = 0;
  const failures = [];

  for (const provider of providers) {
    try {
      const result = await syncEverything(provider.id);
      imported += result.domains?.imported || 0;
      updated += result.domains?.updated || 0;
      dnsRecords += result.dnsRecords || 0;
      mailboxes += result.mailboxes || 0;
      for (const failure of result.failures || []) {
        failures.push(`${failure.domain}: ${failure.problems.join('; ')}`);
      }
    } catch (err) {
      failures.push(`${provider.name}: ${err?.message || 'failed'}`);
    }
  }

  const summary =
    `${imported} new, ${updated} updated, ${dnsRecords} DNS records, ${mailboxes} mailboxes` +
    (failures.length ? `, ${failures.length} problem${failures.length === 1 ? '' : 's'}` : '');

  return {
    summary,
    // Worth telling somebody about only when something actually moved, or
    // something went wrong.
    notable: imported > 0 || failures.length > 0,
    detail: failures.length ? `Problems:\n${failures.slice(0, 20).join('\n')}` : null,
    imported,
    updated,
    dnsRecords,
    mailboxes,
    failures,
  };
}
