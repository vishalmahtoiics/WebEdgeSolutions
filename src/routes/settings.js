// Application settings and the activity log. Super Admin only.
//
// This is where the portal is told how to send its own mail, and who to tell
// when something changes. It is separate from a domain's mail settings, which
// belong to a customer — these belong to you.

import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { prisma } from '../db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler, badRequest } from '../lib/errors.js';
import { getAppSettings, presentAppSettings, saveAppSettings, sendTestEmail, record } from '../services/notifier.js';
import { JOBS, jobStatus, runJob } from '../services/scheduler.js';

export const settingsRouter = Router();
settingsRouter.use(requireAuth, requireAdmin);

/// A test sends real mail through somebody's server, so it is not something to
/// let anyone hold down.
const testLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many test emails. Wait a few minutes.' },
});

/// The password never leaves this process; `hasSmtpPassword` is all the page
/// needs in order to say "one is saved, leave this blank to keep it".
const present = (settings) => presentAppSettings(settings);

settingsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ settings: present(await getAppSettings()) });
  }),
);

const settingsSchema = z.object({
  smtpHost: z.string().trim().max(255).optional(),
  smtpPort: z.coerce.number().int().min(1).max(65535).nullish(),
  smtpSecure: z.coerce.boolean().optional(),
  smtpUser: z.string().trim().max(255).optional(),
  smtpPassword: z.string().max(255).optional(),
  fromAddress: z
    .string()
    .trim()
    .toLowerCase()
    .max(255)
    .refine((v) => v === '' || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), 'Enter a valid From address.')
    .optional(),
  fromName: z.string().trim().max(120).optional(),
  // Comma separated, because more than one person may want to know.
  notifyEmails: z
    .string()
    .trim()
    .max(1000)
    .refine(
      (v) =>
        v === '' ||
        v
          .split(/[,;\s]+/)
          .filter(Boolean)
          .every((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)),
      'One or more of those is not a valid email address.',
    )
    .optional(),

  // The mail server names customers are given, portal-wide. Empty means they
  // are told the provider's real hostnames, which is the old behaviour and a
  // legitimate choice.
  publicImapHost: z.string().trim().max(255).optional(),
  publicImapPort: z.coerce.number().int().min(1).max(65535).nullish(),
  publicSmtpHost: z.string().trim().max(255).optional(),
  publicSmtpPort: z.coerce.number().int().min(1).max(65535).nullish(),

  notifyEnabled: z.coerce.boolean().optional(),
  notifyDns: z.coerce.boolean().optional(),
  notifyEmailMgmt: z.coerce.boolean().optional(),
  notifyFiles: z.coerce.boolean().optional(),
  notifyDatabase: z.coerce.boolean().optional(),
  notifyUsers: z.coerce.boolean().optional(),
  notifySettings: z.coerce.boolean().optional(),
  notifyOrders: z.coerce.boolean().optional(),
  notifySecurity: z.coerce.boolean().optional(),
  notifySupport: z.coerce.boolean().optional(),
  notifySchedule: z.coerce.boolean().optional(),
  notifyBilling: z.coerce.boolean().optional(),
  notifyDeploy: z.coerce.boolean().optional(),

  // Work that happens on its own.
  jobsEnabled: z.coerce.boolean().optional(),
  jobHour: z.coerce.number().int().min(0).max(23).optional(),
  jobTimezoneOffset: z.coerce.number().int().min(-720).max(840).optional(),
  autoSyncEnabled: z.coerce.boolean().optional(),
  expiryRemindersEnabled: z.coerce.boolean().optional(),
  expiryReminderDays: z
    .string()
    .trim()
    .max(120)
    .refine(
      (v) =>
        v === '' ||
        v
          .split(/[,;\s]+/)
          .filter(Boolean)
          .every((d) => /^\d{1,3}$/.test(d) && Number(d) <= 365),
      'Use whole numbers of days, separated by commas — for example 30,15,7,1.',
    )
    .optional(),
  expiryRemindCustomer: z.coerce.boolean().optional(),
});

settingsRouter.put(
  '/',
  validate(settingsSchema),
  asyncHandler(async (req, res) => {
    const data = Object.fromEntries(
      Object.entries(req.body).map(([k, v]) => [k, v === '' ? null : v]),
    );

    const before = await getAppSettings();
    const settings = await saveAppSettings(data);

    // Worth an alert of its own: somebody changing where the alerts go is
    // exactly the change you would want to hear about.
    if (
      before.notifyEmails !== settings.notifyEmails ||
      before.notifyEnabled !== settings.notifyEnabled ||
      before.smtpHost !== settings.smtpHost
    ) {
      await record({
        event: 'settings.notifications.updated',
        actor: req.user,
        summary: 'Changed where change alerts are sent',
        detail:
          `Alerts are now ${settings.notifyEnabled ? 'on' : 'off'}.\n` +
          `Going to: ${settings.notifyEmails || 'nobody'}\n` +
          `Through: ${settings.smtpHost || 'no server'}`,
      });
    }

    res.json({
      settings: present(settings),
      message: settings.notifyEnabled
        ? settings.smtpHost
          ? 'Saved. Send a test to be sure it works.'
          : 'Saved, but there is no SMTP host yet, so nothing can be sent.'
        : 'Saved. Alerts are switched off.',
    });
  }),
);

/// Sends a real message through the configured server.
///
/// Unlike every other send in this system, this one reports its failure — the
/// whole point is to find out here rather than at the worst possible moment.
settingsRouter.post(
  '/test-email',
  testLimiter,
  asyncHandler(async (req, res) => {
    let result;
    try {
      result = await sendTestEmail(req.user);
    } catch (err) {
      throw badRequest(err.message);
    }
    res.json({ ok: true, sentTo: result.sentTo, message: `Test sent to ${result.sentTo.join(', ')}.` });
  }),
);

// ---------------------------------------------------------------------------
// The activity log
// ---------------------------------------------------------------------------

const feedQuery = z.object({
  event: z.string().trim().max(60).optional(),
  domainId: z.string().trim().max(40).optional(),
  take: z.coerce.number().int().min(1).max(200).optional(),
});

/// What has changed, newest first. Useful on its own: a record that exists
/// whether or not any email ever went out.
settingsRouter.get(
  '/activity',
  asyncHandler(async (req, res) => {
    const parsed = feedQuery.safeParse(req.query);
    if (!parsed.success) throw badRequest('Invalid filter.');

    const where = {};
    // Matched by prefix, so "dns" covers every dns.* event.
    if (parsed.data.event) where.event = { startsWith: parsed.data.event };
    if (parsed.data.domainId) where.domainId = parsed.data.domainId;

    const [entries, total, undelivered] = await Promise.all([
      prisma.activityLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: parsed.data.take || 60,
      }),
      prisma.activityLog.count({ where }),
      // Alerts that were meant to go and did not, so a broken mail server is
      // visible rather than merely quiet.
      prisma.activityLog.count({ where: { notified: false, notifyError: { not: null } } }),
    ]);

    res.json({ entries, total, undelivered });
  }),
);

// ---------------------------------------------------------------------------
// Work that happens on its own
// ---------------------------------------------------------------------------

/// Every job with its last result, so the page can say whether last night
/// actually happened rather than only that it was switched on.
settingsRouter.get(
  '/jobs',
  asyncHandler(async (_req, res) => {
    res.json({ jobs: await jobStatus() });
  }),
);

/// Runs one now, without waiting for its hour.
///
/// The same code path the scheduler uses, including the lock — so pressing
/// this while last night's run is still going does not start a second one.
settingsRouter.post(
  '/jobs/:id/run',
  asyncHandler(async (req, res) => {
    if (!JOBS[req.params.id]) throw badRequest('Unknown job.');

    const result = await runJob(req.params.id, { manual: true, actor: req.user });
    if (!result.ran) throw badRequest(result.reason);

    await record({
      event: `schedule.${req.params.id}.manual`,
      actor: req.user,
      summary: `Ran ${JOBS[req.params.id].label} by hand`,
      detail: result.message,
    });

    res.json({
      ok: result.ok,
      message: result.message,
      jobs: await jobStatus(),
    });
  }),
);
