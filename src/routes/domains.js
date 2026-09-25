import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { validate } from '../middleware/validate.js';
import { requireAuth, requireAdmin, getAccessibleDomain, isAdmin } from '../middleware/auth.js';
import { asyncHandler, badRequest, notFound, HttpError } from '../lib/errors.js';
import { getAdapter, tryCapability } from '../providers/index.js';
import { encrypt, decryptMaybe, tokenHint } from '../lib/crypto.js';
import { loadProviderWithToken } from '../services/providerService.js';
import { syncDnsRecords, syncEmailAccounts, refreshDomain } from '../services/syncService.js';
import { detectAndStore } from '../services/technologyService.js';
import { record, getAppSettings } from '../services/notifier.js';
import { resolveMailSetup, mayShowToCustomer, MAIL_SETUP_MODES } from '../lib/mailSetup.js';
import {
  createRecord as createDnsRecord,
  updateRecord as updateDnsRecord,
  deleteRecord as deleteDnsRecord,
  canWriteZone,
} from '../services/dnsService.js';
import { filesRouter } from './files.js';
import { deploymentsRouter } from './deployments.js';
import { webmailRouter } from './webmail.js';
import { listFolders, verifySmtp } from '../lib/mail.js';
import { databaseRouter } from './database.js';
import {
  presentDomainSummary,
  presentDomainDetail,
  presentDnsRecord,
  presentEmailAccount,
  presentCapabilities,
  presentTechnology,
} from '../lib/visibility.js';

export const domainsRouter = Router();
domainsRouter.use(requireAuth);

/// Resolves :id and enforces access in one place. Normal users get a 404 for
/// domains they are not assigned, so the response cannot be used to probe which
/// domain ids exist.
const withDomain = (include = {}) =>
  asyncHandler(async (req, _res, next) => {
    const domain = await getAccessibleDomain(req.user, req.params.id, include);
    if (!domain) throw notFound('Domain not found.');
    req.domain = domain;
    next();
  });

// ---------------------------------------------------------------------------
// List / create
// ---------------------------------------------------------------------------

domainsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    // Admins see everything; a normal user's list is filtered to assignments.
    const where = isAdmin(req.user)
      ? {}
      : { assignments: { some: { userId: req.user.id } } };

    const domains = await prisma.domain.findMany({
      where,
      orderBy: { name: 'asc' },
      include: {
        provider: { select: { id: true, name: true, adapter: true } },
        _count: { select: { emailAccounts: true, dnsRecords: true, assignments: true } },
      },
    });

    const admin = isAdmin(req.user);
    res.json({ domains: domains.map((d) => presentDomainSummary(d, admin)) });
  }),
);

const createDomainSchema = z.object({
  name: z
    .string()
    .trim()
    .toLowerCase()
    .min(3, 'Enter a domain name.')
    .regex(/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'Enter a valid domain, e.g. example.com'),
  status: z.string().trim().min(1).max(40).optional().default('active'),
});

/// Manually added domains are owned by the admin, never by a provider.
domainsRouter.post(
  '/',
  requireAdmin,
  validate(createDomainSchema),
  asyncHandler(async (req, res) => {
    const existing = await prisma.domain.findUnique({ where: { name: req.body.name } });
    if (existing) throw badRequest('That domain already exists in the portal.');

    const domain = await prisma.domain.create({
      data: {
        name: req.body.name,
        status: req.body.status,
        source: 'MANUAL',
        settings: { create: {} },
      },
    });
    res.status(201).json({ domain });
  }),
);

// ---------------------------------------------------------------------------
// Is a name free to register
// ---------------------------------------------------------------------------

const DEFAULT_TLDS = ['com', 'in', 'net', 'org', 'co'];

const availabilitySchema = z.object({
  // The name on its own ("mysite") or with an ending ("mysite.com"); an ending
  // typed here is simply added to the list to check.
  name: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, 'Enter a name to check.')
    .max(63 + 40)
    .regex(/^[a-z0-9][a-z0-9.-]*$/, 'Use letters, numbers and hyphens.'),
  tlds: z.array(z.string().trim().toLowerCase().max(24)).max(10).optional(),
});

/// Checks a name against the registry through whichever connected provider can
/// answer. Super Admin only: it spends a provider's API quota, and buying
/// domains is not a user's business.
domainsRouter.post(
  '/availability',
  requireAdmin,
  validate(availabilitySchema),
  asyncHandler(async (req, res) => {
    const [label, ...rest] = req.body.name.split('.');
    if (!label) throw badRequest('Enter a name to check.');

    const typedTld = rest.join('.');
    const tlds = [...new Set([...(typedTld ? [typedTld] : []), ...(req.body.tlds || DEFAULT_TLDS)])].slice(0, 10);

    // Any connected provider that can answer will do; the first one that does
    // wins, and the reply never says which it was.
    const providers = await prisma.provider.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
    });

    const reasons = [];
    for (const provider of providers) {
      const adapter = getAdapter(provider.adapter);
      if (!adapter?.capabilities?.domainSearch || typeof adapter.checkDomainAvailability !== 'function') continue;

      try {
        const { token } = await loadProviderWithToken(provider.id);
        const results = await adapter.checkDomainAvailability(token, { name: label, tlds });

        // Already in the portal is worth knowing: "available" would be
        // misleading for a domain the account already owns.
        const known = await prisma.domain.findMany({
          where: { name: { in: results.map((r) => r.domain) } },
          select: { name: true },
        });
        const owned = new Set(known.map((d) => d.name));

        return res.json({
          ok: true,
          name: label,
          results: results.map((r) => ({ ...r, alreadyInPortal: owned.has(r.domain) })),
        });
      } catch (err) {
        reasons.push(err.message || 'The provider could not answer.');
      }
    }

    throw badRequest(
      reasons.length
        ? `No connected provider could check that name. ${reasons.join(' ')}`
        : 'No connected provider can check domain availability. Add one under Providers / APIs.',
    );
  }),
);

// ---------------------------------------------------------------------------
// Single domain
// ---------------------------------------------------------------------------

domainsRouter.get(
  '/:id',
  withDomain({
    provider: { select: { id: true, name: true, adapter: true, isActive: true } },
    settings: true,
    dnsRecords: { orderBy: [{ type: 'asc' }, { name: 'asc' }] },
    emailAccounts: { orderBy: { address: 'asc' } },
    assignments: { include: { user: { select: { id: true, name: true, email: true } } } },
  }),
  asyncHandler(async (req, res) => {
    const d = req.domain;
    const adapter = d.provider ? getAdapter(d.provider.adapter) : null;

    const admin = isAdmin(req.user);

    // What to put in a mail client. The customer needs this — they cannot set
    // up Outlook without a hostname — so it is resolved rather than read
    // straight out of the settings row.
    //
    // The one case a customer does not get it is a provider hostname nobody
    // chose to hand out, which is what an unconfigured portal would otherwise
    // fall back to. An administrator sees it either way, along with which of
    // the answers it is, so they can fix it.
    const setup = resolveMailSetup(d.settings, await getAppSettings());
    const forCustomer = mayShowToCustomer(setup) ? { ...setup, source: undefined, explicit: undefined } : null;

    res.json({
      domain: presentDomainDetail(d, admin),
      // Drives which panels offer a refresh action.
      capabilities: presentCapabilities(adapter?.capabilities, d, admin),
      settings: presentSettings(d.settings, admin),
      mailSetup: admin ? setup : forCustomer,
      dnsRecords: d.dnsRecords.map((r) => presentDnsRecord(r, admin)),
      emailAccounts: d.emailAccounts.map((m) => presentEmailAccount(m, admin)),
      assignedUsers: admin ? d.assignments.map((a) => a.user) : undefined,
    });
  }),
);

const updateDomainSchema = z.object({
  status: z.string().trim().min(1).max(40).optional(),
  type: z.string().trim().max(40).or(z.literal('')).optional(),
  expiresAt: z.string().datetime().or(z.literal('')).nullish(),
});

domainsRouter.put(
  '/:id',
  requireAdmin,
  withDomain(),
  validate(updateDomainSchema),
  asyncHandler(async (req, res) => {
    const { status, type, expiresAt } = req.body;
    const data = {};
    if (status !== undefined) data.status = status;
    if (type !== undefined) data.type = type || null;
    if (expiresAt !== undefined) data.expiresAt = expiresAt ? new Date(expiresAt) : null;

    const domain = await prisma.domain.update({ where: { id: req.domain.id }, data });
    res.json({ domain });
  }),
);

domainsRouter.delete(
  '/:id',
  requireAdmin,
  withDomain(),
  asyncHandler(async (req, res) => {
    await prisma.domain.delete({ where: { id: req.domain.id } });
    res.json({ ok: true });
  }),
);

/// Pulls registrar detail (nameservers, lock state) straight from the provider.
/// Not stored — it is shown live so it can never go stale in the UI.
domainsRouter.get(
  '/:id/registration',
  withDomain({ provider: true }),
  asyncHandler(async (req, res) => {
    if (!req.domain.providerId) {
      return res.json({ supported: false, details: null, error: null });
    }
    const { adapter, token } = await loadProviderWithToken(req.domain.providerId);
    const result = await tryCapability(adapter, 'getDomainDetails', token, req.domain.name);
    res.json({ supported: result.supported, details: result.data, error: result.error });
  }),
);

/// Reloads this domain's DNS records and mailboxes in one action.
///
/// Worded neutrally on purpose: this is the button an assigned user presses
/// when their information looks out of date, and it must not tell them which
/// company the data comes from.
domainsRouter.post(
  '/:id/refresh',
  withDomain({ provider: true }),
  asyncHandler(async (req, res) => {
    if (!req.domain.providerId) {
      throw badRequest('This domain is maintained by hand, so there is nothing to refresh.');
    }

    const result = await refreshDomain(req.domain);
    const parts = [];
    if (result.dns?.ok) parts.push(`${result.dns.count} DNS record${result.dns.count === 1 ? '' : 's'}`);
    if (result.emails?.ok) parts.push(`${result.emails.count} mailbox${result.emails.count === 1 ? '' : 'es'}`);
    if (result.technology?.ok) parts.push(`the site is ${result.technology.name}`);

    const problems = [result.dns?.error, result.emails?.error].filter(Boolean);
    if (!parts.length && problems.length) {
      // Nothing came back and something went wrong — say so rather than
      // reporting a cheerful "refreshed" that changed nothing.
      throw badRequest(problems.join(' '));
    }

    res.json({
      ok: true,
      dns: result.dns,
      emails: result.emails,
      technology: result.technology,
      message: parts.length ? `Refreshed ${parts.join(' and ')}.` : 'Nothing new to load.',
    });
  }),
);

// ---------------------------------------------------------------------------
// What the site is built on
// ---------------------------------------------------------------------------

/// Works out what this site is built on, now.
///
/// Open to anyone who can reach the domain, because it reports on their own
/// site: it reads their files over the FTP credentials already stored, or their
/// own homepage. Neither answer says anything about who hosts it.
domainsRouter.post(
  '/:id/technology/detect',
  withDomain({ settings: true }),
  asyncHandler(async (req, res) => {
    const result = await detectAndStore(req.domain);

    if (!result.ok) {
      // Explain what was tried rather than shrugging. "No file access is
      // configured" is something the reader can act on; "failed" is not.
      const reasons = (result.attempts || []).map((a) => a.message).filter(Boolean);
      return res.json({
        ok: false,
        technology: null,
        attempts: result.attempts || [],
        message: reasons.length
          ? `Could not tell what this site is built on. ${reasons.join(' ')}`
          : 'Could not tell what this site is built on.',
      });
    }

    const { name, version, evidence } = result.technology;
    res.json({
      ok: true,
      technology: presentTechnology(result.domain),
      message: `This site is ${name}${version ? ` ${version}` : ''} — ${evidence}.`,
    });
  }),
);

const technologySchema = z.object({
  // Empty clears the override and hands the row back to whatever was detected.
  name: z.string().trim().max(60).optional(),
  version: z.string().trim().max(40).optional(),
});

/// Sets or clears the administrator's own answer.
///
/// Detection never writes these columns, so an override survives every later
/// sync — and clearing it reveals the detected value again, unchanged.
domainsRouter.put(
  '/:id/technology',
  requireAdmin,
  withDomain(),
  validate(technologySchema),
  asyncHandler(async (req, res) => {
    const name = req.body.name || null;
    const domain = await prisma.domain.update({
      where: { id: req.domain.id },
      data: {
        techOverride: name,
        // A version with no name to attach it to would be stranded.
        techVersionOverride: name ? req.body.version || null : null,
      },
    });

    res.json({
      ok: true,
      technology: presentTechnology(domain),
      message: name ? 'Technology updated.' : 'Now showing the detected technology.',
    });
  }),
);

// ---------------------------------------------------------------------------
// Domain settings (FTP/FTPS, server info) — always manual
// ---------------------------------------------------------------------------

const settingsSchema = z.object({
  ftpHost: z.string().trim().max(255).optional(),
  ftpPort: z.coerce.number().int().min(1).max(65535).nullish(),
  ftpUsername: z.string().trim().max(255).optional(),
  ftpPassword: z.string().max(255).optional(),
  ftpProtocol: z.enum(['FTP', 'FTPS', 'SFTP']).or(z.literal('')).optional(),
  ftpRootPath: z.string().trim().max(1024).optional(),
  // Mail servers, shared by every mailbox on the domain.
  imapHost: z.string().trim().max(255).optional(),
  imapPort: z.coerce.number().int().min(1).max(65535).nullish(),
  imapSecure: z.coerce.boolean().optional(),
  smtpHost: z.string().trim().max(255).optional(),
  smtpPort: z.coerce.number().int().min(1).max(65535).nullish(),
  smtpSecure: z.coerce.boolean().optional(),
  // What the customer is told to type in, which is a separate decision from
  // what the portal connects to.
  mailSetupMode: z.enum(MAIL_SETUP_MODES).optional(),
  publicImapHost: z.string().trim().max(255).optional(),
  publicImapPort: z.coerce.number().int().min(1).max(65535).nullish(),
  publicSmtpHost: z.string().trim().max(255).optional(),
  publicSmtpPort: z.coerce.number().int().min(1).max(65535).nullish(),
  // Database, entered by hand: the provider API does not hand these out.
  dbHost: z.string().trim().max(255).optional(),
  dbPort: z.coerce.number().int().min(1).max(65535).nullish(),
  dbName: z.string().trim().max(128).optional(),
  dbUser: z.string().trim().max(128).optional(),
  dbPassword: z.string().max(255).optional(),
  dbAllowWrites: z.coerce.boolean().optional(),
  serverIp: z.string().trim().max(64).optional(),
  serverHostname: z.string().trim().max(255).optional(),
  serverLocation: z.string().trim().max(120).optional(),
  nameservers: z.string().trim().max(500).optional(),
  phpVersion: z.string().trim().max(20).optional(),
  notes: z.string().max(2000).optional(),
  // When the form was drawn from, so a stale form cannot overwrite newer
  // values. null means the form was drawn when nothing was saved yet.
  expectedUpdatedAt: z.string().max(40).nullish(),
});

/// Domain settings for the browser. The FTP password is a live credential for
/// someone else's server, so only a hint of it ever leaves this process.
/// Everything in this row is infrastructure: the provider's real hostnames,
/// the FTP account, the database account. It is Super Admin's to see.
///
/// A normal user gets none of it. Not only because the mail and FTP hostnames
/// name the provider — which is the one thing the portal is careful never to
/// do — but because these are the credentials that make the Files, Database
/// and webmail tabs work on their behalf. They do not need them to use those
/// tabs, and they cannot do anything useful with them except break their own
/// site. What they do need is the Email setup card, which is built from this
/// and says only what belongs in a mail client.
function presentSettings(settings, admin) {
  if (!settings) return settings;

  // Whether a database is set up is not a secret — it decides whether the
  // Database tab exists — but the host, user and password behind it are. So a
  // normal user gets the fact and nothing else, and keeps a working tab.
  const hasDatabase = Boolean(settings.dbHost && settings.dbName);
  if (!admin) return { hasDatabase };

  // Neither password leaves this process. What goes out is whether one is
  // stored and a few characters of it, which is enough to recognise without
  // being enough to use.
  const { ftpPassword, dbPassword, ...rest } = settings;
  return {
    ...rest,
    hasDatabase,
    hasFtpPassword: Boolean(ftpPassword),
    ftpPasswordHint: ftpPassword ? tokenHint(decryptMaybe(ftpPassword)) : null,
    hasDbPassword: Boolean(dbPassword),
    dbPasswordHint: dbPassword ? tokenHint(decryptMaybe(dbPassword)) : null,
  };
}

const blankToNull = (obj) =>
  Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, v === '' ? null : v]));

/// Tries a real sign-in against this domain's mail servers, and reports what
/// actually happened.
///
/// The standalone mail app deliberately tells a visitor nothing beyond "check
/// the address and password", because whether a domain is hosted here is not a
/// stranger's business. That leaves whoever runs the portal with no way to
/// tell a wrong password from an IMAP host that was never filled in — so this
/// is that way. Same credentials, same code path, the real error.
///
/// Super Admin only: it takes a password and returns a server's verdict on it,
/// which is a small oracle and not something to leave open to every account.
domainsRouter.post(
  '/:id/mail-test',
  withDomain(),
  requireAdmin,
  validate(
    z.object({
      address: z.string().trim().toLowerCase().email('Enter the full email address.'),
      password: z.string().min(1, 'Enter the mailbox password.'),
    }),
  ),
  asyncHandler(async (req, res) => {
    const settings = await prisma.domainSettings.findUnique({ where: { domainId: req.domain.id } });
    const { address, password } = req.body;

    const checks = { address: null, imap: null, smtp: null };

    // The mail app looks the servers up by the address's domain, so an
    // address at a different domain would never reach these settings however
    // well they work.
    const addressDomain = address.split('@')[1];
    checks.address =
      addressDomain === req.domain.name
        ? { ok: true, message: `Addresses at ${req.domain.name} are looked up against these settings.` }
        : {
            ok: false,
            message:
              `That address is at ${addressDomain}, not ${req.domain.name}. Signing in with it would ` +
              `use ${addressDomain}'s settings, not these — test it on that domain instead.`,
          };

    if (!settings?.imapHost) {
      checks.imap = {
        ok: false,
        message: 'No IMAP host is saved for this domain, so nobody can sign in to webmail with an address at it.',
      };
    } else {
      try {
        const folders = await listFolders({
          host: settings.imapHost,
          port: settings.imapPort,
          secure: settings.imapSecure,
          user: address,
          password,
        });
        checks.imap = {
          ok: true,
          message: `Signed in and read ${folders.length} folder${folders.length === 1 ? '' : 's'}.`,
        };
      } catch (err) {
        checks.imap = { ok: false, message: err?.message || 'The mail server request failed.' };
      }
    }

    if (!settings?.smtpHost) {
      checks.smtp = {
        ok: false,
        message: 'No SMTP host is saved, so this mailbox could read mail here but not send any.',
      };
    } else {
      try {
        await verifySmtp({
          host: settings.smtpHost,
          port: settings.smtpPort,
          secure: settings.smtpSecure,
          user: address,
          password,
        });
        checks.smtp = { ok: true, message: 'Sending works.' };
      } catch (err) {
        checks.smtp = { ok: false, message: err?.message || 'The mail server refused to accept mail.' };
      }
    }

    // The password is never stored by this, and never echoed back.
    await record({
      event: 'settings.domain.mail-tested',
      actor: req.user,
      domain: req.domain,
      summary: `Tested a mailbox sign-in for ${req.domain.name}`,
      detail:
        `Address: ${address}\n` +
        `IMAP:    ${checks.imap.ok ? 'ok' : `failed — ${checks.imap.message}`}\n` +
        `SMTP:    ${checks.smtp.ok ? 'ok' : `failed — ${checks.smtp.message}`}`,
    });

    res.json({
      ok: Boolean(checks.imap.ok),
      checks,
      servers: {
        imap: settings?.imapHost
          ? `${settings.imapHost}:${settings.imapPort || (settings.imapSecure === false ? 143 : 993)}` +
            ` (${settings.imapSecure === false ? 'not encrypted' : 'encrypted'})`
          : null,
        smtp: settings?.smtpHost
          ? `${settings.smtpHost}:${settings.smtpPort || (settings.smtpSecure === false ? 587 : 465)}` +
            ` (${settings.smtpSecure === false ? 'not encrypted' : 'encrypted'})`
          : null,
      },
    });
  }),
);

/// Writing these is Super Admin's as well as reading them. They are the
/// credentials the portal uses on a customer's behalf; a customer changing
/// them can only break their own Files, Database and webmail tabs, and the
/// mail hostnames here name the provider.
domainsRouter.put(
  '/:id/settings',
  withDomain(),
  requireAdmin,
  validate(settingsSchema),
  asyncHandler(async (req, res) => {
    const { expectedUpdatedAt, ...fields } = req.body;
    const data = blankToNull(fields);

    const existing = await prisma.domainSettings.findUnique({ where: { domainId: req.domain.id } });

    // A form drawn before the last save still holds the values from before
    // it, blanks included, and saving it would write those blanks over the
    // real details. That is how FTP details "disappeared": saved, then the
    // tab was revisited, drawn from the page's original (empty) copy, and
    // saved again. Refused rather than merged, because which of two forms is
    // right is not something to guess. Absent entirely means a browser still
    // running the old script, which is let through as before.
    if (expectedUpdatedAt !== undefined) {
      const current = existing?.updatedAt?.toISOString() ?? null;
      if (current !== (expectedUpdatedAt || null)) {
        throw new HttpError(
          409,
          'These settings were changed after this form was opened, so saving it would overwrite them. ' +
            'Reload the page to see the current values, then make your change again.',
        );
      }
    }

    // An empty password field means "leave it alone", so an administrator can
    // edit the host or username without retyping the secret.
    for (const field of ['ftpPassword', 'dbPassword']) {
      if (data[field]) data[field] = encrypt(data[field]);
      else delete data[field];
    }

    // Letting a user turn writes on for their own database would defeat the
    // switch, so only an administrator may move it.
    if (!isAdmin(req.user)) delete data.dbAllowWrites;

    const settings = await prisma.domainSettings.upsert({
      where: { domainId: req.domain.id },
      create: { domainId: req.domain.id, ...data },
      update: data,
    });

    // Named rather than dumped: the values include hosts and usernames, and an
    // alert that repeats them is an alert that leaks them into an inbox.
    // Compared with what was there, so the log says what actually moved — and
    // says separately what was emptied, which is the one to look for when
    // details go missing.
    const changed = [];
    const cleared = [];
    for (const key of Object.keys(data)) {
      const before = existing?.[key] ?? null;
      const after = settings[key] ?? null;
      if (key === 'ftpPassword' || key === 'dbPassword') {
        changed.push(key);
      } else if (String(before) !== String(after)) {
        (after === null ? cleared : changed).push(key);
      }
    }
    const detail = [
      changed.length ? `Fields changed: ${changed.join(', ')}` : null,
      cleared.length ? `Fields emptied: ${cleared.join(', ')}` : null,
    ].filter(Boolean).join('\n');
    await record({
      event: 'settings.domain.updated',
      actor: req.user,
      domain: req.domain,
      summary: `Changed the connection settings for ${req.domain.name}`,
      detail: detail || 'Saved with no changes.',
    });

    res.json({ settings: presentSettings(settings, isAdmin(req.user)) });
  }),
);

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

// Mounted through withDomain, so every file route inherits the same check as
// the rest of the domain: a user reaches only domains assigned to them.
domainsRouter.use('/:id/files', withDomain(), filesRouter);

// Deploying writes to the same filesystem the file manager reads, so it sits
// behind the same gate.
domainsRouter.use('/:id/deployments', withDomain(), deploymentsRouter);

// Same guard for the database: a user reaches only their own domain's, and the
// credentials are read server-side on every call.
domainsRouter.use('/:id/db', withDomain(), databaseRouter);

// Webmail for one mailbox, behind the same domain check.
domainsRouter.use('/:id/emails/:emailId/mail', withDomain(), webmailRouter);

// ---------------------------------------------------------------------------
// DNS records
// ---------------------------------------------------------------------------

const dnsSchema = z.object({
  name: z.string().trim().min(1, 'Record name is required.').max(255),
  type: z.enum(['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA']),
  content: z.string().trim().min(1, 'Record value is required.').max(2000),
  ttl: z.coerce.number().int().min(60).max(604800).default(3600),
});

/// These three go to the real DNS zone when the domain has one that accepts
/// changes, and to the portal alone when it does not. The service decides
/// which, and the reply says which happened — editing an MX record for real is
/// not the same act as editing a note about one.
domainsRouter.post(
  '/:id/dns',
  withDomain(),
  validate(dnsSchema),
  asyncHandler(async (req, res) => {
    const result = await createDnsRecord(req.domain, req.body, req.user);
    res.status(201).json(result);
  }),
);

domainsRouter.put(
  '/:id/dns/:recordId',
  withDomain(),
  validate(dnsSchema),
  asyncHandler(async (req, res) => {
    const existing = await prisma.dnsRecord.findFirst({
      where: { id: req.params.recordId, domainId: req.domain.id },
    });
    if (!existing) throw notFound('DNS record not found.');
    res.json(await updateDnsRecord(req.domain, existing, req.body, req.user));
  }),
);

domainsRouter.delete(
  '/:id/dns/:recordId',
  withDomain(),
  asyncHandler(async (req, res) => {
    const existing = await prisma.dnsRecord.findFirst({
      where: { id: req.params.recordId, domainId: req.domain.id },
    });
    if (!existing) throw notFound('DNS record not found.');
    res.json(await deleteDnsRecord(req.domain, existing, req.user));
  }),
);

domainsRouter.post(
  '/:id/dns/sync',
  withDomain(),
  asyncHandler(async (req, res) => {
    const result = await syncDnsRecords(req.domain);
    if (!result.supported) throw badRequest('This domain is not linked to a provider that exposes DNS.');
    if (result.error) throw badRequest(result.error);
    res.json({ ok: true, count: result.count, message: `Loaded ${result.count} DNS record${result.count === 1 ? '' : 's'} from the provider.` });
  }),
);

// ---------------------------------------------------------------------------
// Email accounts
// ---------------------------------------------------------------------------

const emailSchema = z.object({
  address: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  status: z.string().trim().max(40).optional().default('active'),
  // Each figure is either the provider's own or one an administrator typed.
  // `useReal*` true clears the override so the real value shows again and
  // keeps tracking every sync.
  useRealQuota: z.boolean().optional(),
  useRealUsed: z.boolean().optional(),
  quotaMb: z.coerce.number().int().min(0).nullish(),
  usedMb: z.coerce.number().int().min(0).nullish(),
  notes: z.string().max(1000).optional(),
});

/// Turns the dialog's "real or custom" choice into stored columns.
///
/// A mailbox the provider does not know about has no real value to fall back
/// on, so whatever is typed is stored as the override and also seeded as the
/// provider figure — otherwise the row would read as empty.
function mailboxValues(body, { hasProvider }) {
  const quotaCustom = body.useRealQuota === true ? null : body.quotaMb ?? null;
  const usedCustom = body.useRealUsed === true ? null : body.usedMb ?? null;

  const data = {
    status: body.status,
    notes: body.notes === '' ? null : body.notes,
    quotaMbOverride: quotaCustom,
    usedMbOverride: usedCustom,
  };

  if (!hasProvider) {
    data.providerQuotaMb = quotaCustom;
    data.providerUsedMb = usedCustom;
  }
  return data;
}

domainsRouter.post(
  '/:id/emails',
  withDomain(),
  validate(emailSchema),
  asyncHandler(async (req, res) => {
    const exists = await prisma.emailAccount.findUnique({
      where: { domainId_address: { domainId: req.domain.id, address: req.body.address } },
    });
    if (exists) throw badRequest('That mailbox is already listed for this domain.');

    const email = await prisma.emailAccount.create({
      data: {
        domainId: req.domain.id,
        address: req.body.address,
        isFromProvider: false,
        ...mailboxValues(req.body, { hasProvider: false }),
      },
    });
    res.status(201).json({ email: presentEmailAccount(email, isAdmin(req.user)) });
  }),
);

domainsRouter.put(
  '/:id/emails/:emailId',
  withDomain(),
  validate(emailSchema),
  asyncHandler(async (req, res) => {
    const existing = await prisma.emailAccount.findFirst({
      where: { id: req.params.emailId, domainId: req.domain.id },
    });
    if (!existing) throw notFound('Mailbox not found.');

    // Editing no longer detaches the row from the provider: the real values
    // keep refreshing underneath whatever an administrator chose to display.
    const email = await prisma.emailAccount.update({
      where: { id: existing.id },
      data: {
        address: req.body.address,
        ...mailboxValues(req.body, { hasProvider: Boolean(existing.externalId) }),
      },
    });
    res.json({ email: presentEmailAccount(email, isAdmin(req.user)) });
  }),
);

domainsRouter.delete(
  '/:id/emails/:emailId',
  withDomain(),
  asyncHandler(async (req, res) => {
    const existing = await prisma.emailAccount.findFirst({
      where: { id: req.params.emailId, domainId: req.domain.id },
    });
    if (!existing) throw notFound('Mailbox not found.');
    await prisma.emailAccount.delete({ where: { id: existing.id } });
    res.json({ ok: true });
  }),
);

/// Creates a mailbox. With `createAtProvider` the mailbox is created on the
/// real hosting account first; the local row is only written once the provider
/// has confirmed it, so the portal never claims a mailbox that does not exist.
const createEmailSchema = emailSchema.extend({
  password: z.string().min(8, 'Mailbox password must be at least 8 characters.').optional(),
});

domainsRouter.post(
  '/:id/emails/provision',
  withDomain({ provider: true }),
  validate(createEmailSchema),
  asyncHandler(async (req, res) => {
    const domain = req.domain;
    const { address, password } = req.body;

    if (!address.toLowerCase().endsWith(`@${domain.name.toLowerCase()}`)) {
      throw badRequest(`The address must end with @${domain.name}.`);
    }
    if (!password) throw badRequest('A password is required to create a mailbox at the provider.');
    if (!domain.providerId) throw badRequest('This domain is not linked to a provider.');

    const exists = await prisma.emailAccount.findUnique({
      where: { domainId_address: { domainId: domain.id, address } },
    });
    if (exists) throw badRequest('That mailbox is already listed for this domain.');

    const { adapter, token } = await loadProviderWithToken(domain.providerId);
    if (typeof adapter.createMailbox !== 'function' || !adapter.capabilities?.emailWrite) {
      throw badRequest('This provider does not support creating mailboxes through its API.');
    }

    const localPart = address.slice(0, address.lastIndexOf('@'));
    let created;
    try {
      created = await adapter.createMailbox(token, domain.name, { localPart, password });
    } catch (err) {
      // Pass the provider's own wording through — it names the rule that failed.
      throw new HttpError(err.status && err.status < 500 ? 400 : 502, err.message);
    }

    const email = await prisma.emailAccount.create({
      data: {
        domainId: domain.id,
        address: created.address || address,
        status: created.status || 'active',
        externalId: created.externalId ?? null,
        providerQuotaMb: created.quotaMb ?? null,
        providerUsedMb: created.usedMb ?? null,
        isFromProvider: true,
      },
    });

    await record({
      event: 'email.mailbox.created',
      actor: req.user,
      domain,
      summary: `Created the mailbox ${email.address}`,
    });

    res.status(201).json({
      email: presentEmailAccount(email, isAdmin(req.user)),
      message: `${email.address} created at the provider.`,
    });
  }),
);

/// Changes a mailbox password at the provider. Nothing is stored locally —
/// the portal never holds mailbox passwords.
domainsRouter.post(
  '/:id/emails/:emailId/password',
  withDomain({ provider: true }),
  validate(z.object({ password: z.string().min(8, 'Password must be at least 8 characters.') })),
  asyncHandler(async (req, res) => {
    const mailbox = await prisma.emailAccount.findFirst({
      where: { id: req.params.emailId, domainId: req.domain.id },
    });
    if (!mailbox) throw notFound('Mailbox not found.');
    if (!mailbox.externalId || !req.domain.providerId) {
      throw badRequest('This mailbox only exists in the portal, so it has no provider password to change.');
    }

    const { adapter, token } = await loadProviderWithToken(req.domain.providerId);
    if (typeof adapter.changeMailboxPassword !== 'function') {
      throw badRequest('This provider does not support changing mailbox passwords.');
    }

    try {
      await adapter.changeMailboxPassword(token, mailbox.externalId, req.body.password);
    } catch (err) {
      throw new HttpError(err.status && err.status < 500 ? 400 : 502, err.message);
    }

    await record({
      event: 'email.mailbox.password',
      actor: req.user,
      domain: req.domain,
      summary: `Changed the password for ${mailbox.address}`,
      detail: 'Anyone still signed in to that mailbox elsewhere will be asked for the new password.',
    });

    res.json({ ok: true, message: `Password changed for ${mailbox.address}.` });
  }),
);

/// Deletes a mailbox at the provider, then removes the local row.
///
/// Deliberately separate from DELETE /emails/:id, which only removes the
/// portal's record. Destroying a real mailbox should never be something you
/// can do by reaching for the same button.
domainsRouter.delete(
  '/:id/emails/:emailId/destroy',
  withDomain({ provider: true }),
  asyncHandler(async (req, res) => {
    const mailbox = await prisma.emailAccount.findFirst({
      where: { id: req.params.emailId, domainId: req.domain.id },
    });
    if (!mailbox) throw notFound('Mailbox not found.');
    if (!mailbox.externalId || !req.domain.providerId) {
      throw badRequest('This mailbox only exists in the portal. Use Remove to delete the portal record.');
    }

    const { adapter, token } = await loadProviderWithToken(req.domain.providerId);
    if (typeof adapter.deleteMailbox !== 'function') {
      throw badRequest('This provider does not support deleting mailboxes through its API.');
    }

    try {
      await adapter.deleteMailbox(token, mailbox.externalId);
    } catch (err) {
      throw new HttpError(err.status && err.status < 500 ? 400 : 502, err.message);
    }

    // Only drop the local row once the provider has confirmed the deletion,
    // so a failure leaves the portal still showing what really exists.
    await prisma.emailAccount.delete({ where: { id: mailbox.id } });
    await record({
      event: 'email.mailbox.destroyed',
      actor: req.user,
      domain: req.domain,
      summary: `Permanently deleted the mailbox ${mailbox.address}`,
      detail: 'This removed the mailbox and everything in it at the provider. It cannot be undone.',
    });

    res.json({ ok: true, message: `${mailbox.address} was permanently deleted at the provider.` });
  }),
);

/// How many mailboxes one bulk-delete request may carry.
///
/// Not a limit on how many can be deleted — the browser sends larger
/// selections in chunks — but a limit on how long one request can run. A
/// request that is cut off halfway through deleting fifty real mailboxes
/// leaves nobody able to say which ones went.
const BULK_DELETE_LIMIT = 25;

/// Deletes several mailboxes in one go.
///
/// Two modes, matching the two single-mailbox routes exactly — this is the
/// same power with fewer clicks, never more:
///
///   portal   — forgets the portal's record. The mailbox itself is untouched
///              and a sync brings it straight back.
///   provider — destroys the mailbox and everything in it, for real.
///
/// A batch against a real API is not all-or-nothing, and pretending otherwise
/// is how people end up believing mail was deleted when it was not. So each
/// mailbox is done in turn and reported on by name: what went, what stayed,
/// and why. The caller gets the list, not a number.
const bulkDeleteSchema = z.object({
  ids: z
    .array(z.string().min(1))
    .min(1, 'Select at least one mailbox.')
    // The browser sends these in chunks so no single request runs long enough
    // to be cut off halfway, which would leave nobody sure what happened.
    .max(BULK_DELETE_LIMIT, `Delete at most ${BULK_DELETE_LIMIT} mailboxes per request.`),
  mode: z.enum(['portal', 'provider']),
});

domainsRouter.post(
  '/:id/emails/bulk-delete',
  withDomain({ provider: true }),
  validate(bulkDeleteSchema),
  asyncHandler(async (req, res) => {
    const { mode } = req.body;
    // Duplicates in the list must not delete twice or be counted twice.
    const ids = [...new Set(req.body.ids)];

    const mailboxes = await prisma.emailAccount.findMany({
      where: { id: { in: ids }, domainId: req.domain.id },
    });

    // An id that is not this domain's is not a silent no-op: someone asked for
    // something that is not theirs to ask for, and should be told plainly.
    const found = new Set(mailboxes.map((m) => m.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) {
      throw notFound(
        missing.length === ids.length
          ? 'None of those mailboxes are listed for this domain.'
          : `${missing.length} of the selected mailboxes are not listed for this domain.`,
      );
    }

    let adapter = null;
    let token = null;
    if (mode === 'provider') {
      // Loaded once for the whole batch rather than per mailbox.
      const live = mailboxes.filter((m) => m.externalId);
      if (live.length) {
        if (!req.domain.providerId) {
          throw badRequest('This domain is not linked to a provider, so nothing can be deleted at one.');
        }
        ({ adapter, token } = await loadProviderWithToken(req.domain.providerId));
        if (typeof adapter.deleteMailbox !== 'function') {
          throw badRequest('This provider does not support deleting mailboxes through its API.');
        }
      }
    }

    const results = [];

    for (const mailbox of mailboxes) {
      // A mailbox that exists only here has nothing to destroy upstream, so
      // "delete it" means the same thing in either mode. Doing it and saying
      // so beats refusing the whole batch over one hand-entered row.
      const atProvider = mode === 'provider' && Boolean(mailbox.externalId);

      if (atProvider) {
        try {
          await adapter.deleteMailbox(token, mailbox.externalId);
        } catch (err) {
          results.push({
            id: mailbox.id,
            address: mailbox.address,
            ok: false,
            deletedAtProvider: false,
            error: err.message,
          });
          // The next one may well work; one refusal is not a reason to stop.
          continue;
        }
      }

      // The local row goes only once the provider has confirmed, so a failure
      // leaves the portal still showing what really exists.
      await prisma.emailAccount.delete({ where: { id: mailbox.id } });
      results.push({
        id: mailbox.id,
        address: mailbox.address,
        ok: true,
        deletedAtProvider: atProvider,
        error: null,
      });
    }

    const done = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    const destroyed = done.filter((r) => r.deletedAtProvider);

    if (done.length) {
      const what = mode === 'provider' ? 'Permanently deleted' : 'Removed the portal record for';
      await record({
        event: mode === 'provider' ? 'email.mailbox.destroyed' : 'email.mailbox.removed',
        actor: req.user,
        domain: req.domain,
        summary: `${what} ${done.length} mailbox${done.length === 1 ? '' : 'es'} on ${req.domain.name}`,
        // Every address, by name. A count alone is not a record of what was
        // deleted, and this is the only place that list will ever exist again.
        detail: [
          done.map((r) => r.address).join(', '),
          destroyed.length
            ? `${destroyed.length} of these were deleted at the provider, along with every message in them. This cannot be undone.`
            : 'The mailboxes themselves were not touched; only this portal\u2019s records were removed.',
          failed.length ? `${failed.length} could not be deleted: ${failed.map((r) => `${r.address} (${r.error})`).join('; ')}` : null,
        ]
          .filter(Boolean)
          .join('\n\n'),
      });
    }

    res.json({
      ok: failed.length === 0,
      mode,
      deleted: done.length,
      destroyedAtProvider: destroyed.length,
      failed: failed.length,
      results,
      message: buildBulkMessage({ mode, done: done.length, destroyed: destroyed.length, failed }),
    });
  }),
);

/// One sentence a person can act on, whatever mix of outcomes came back.
function buildBulkMessage({ mode, done, destroyed, failed }) {
  const box = (n) => `${n} mailbox${n === 1 ? '' : 'es'}`;

  if (!done && failed.length) {
    return failed.length === 1
      ? `${failed[0].address} could not be deleted: ${failed[0].error}`
      : `None of the ${box(failed.length)} could be deleted. The first reason given was: ${failed[0].error}`;
  }

  const head =
    mode === 'provider'
      ? destroyed === done
        ? `Permanently deleted ${box(done)}.`
        : `Deleted ${box(done)} \u2014 ${destroyed} at the provider, ${done - destroyed} that only existed in this portal.`
      : `Removed ${box(done)} from the portal. The mailboxes themselves are untouched.`;

  if (!failed.length) return head;
  return `${head} ${box(failed.length)} could not be deleted \u2014 ${failed[0].address}: ${failed[0].error}`;
}

/// Forwarders, aliases, autoreplies and catch-alls, read live from the
/// provider. Not stored, so they cannot go stale.
domainsRouter.get(
  '/:id/emails/extras',
  withDomain({ provider: true }),
  asyncHandler(async (req, res) => {
    if (!req.domain.providerId) {
      return res.json({ supported: false, extras: null, error: null });
    }
    const { adapter, token } = await loadProviderWithToken(req.domain.providerId);
    const result = await tryCapability(adapter, 'listEmailExtras', token, req.domain.name);
    res.json({ supported: result.supported, extras: result.data, error: result.error });
  }),
);

domainsRouter.post(
  '/:id/emails/sync',
  withDomain(),
  asyncHandler(async (req, res) => {
    const result = await syncEmailAccounts(req.domain);
    if (!result.supported) throw badRequest('This domain is not linked to a provider that exposes email.');
    if (result.error) throw badRequest(result.error);
    res.json({
      ok: true,
      count: result.count,
      message: result.count
        ? `Loaded ${result.count} mailbox${result.count === 1 ? '' : 'es'} from the provider.`
        : 'The provider reported no mailboxes for this domain.',
    });
  }),
);
