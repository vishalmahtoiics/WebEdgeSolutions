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
import { filesRouter } from './files.js';
import { webmailRouter } from './webmail.js';
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
    res.json({
      domain: presentDomainDetail(d, admin),
      // Drives which panels offer a refresh action.
      capabilities: presentCapabilities(adapter?.capabilities, d, admin),
      settings: presentSettings(d.settings),
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
  serverIp: z.string().trim().max(64).optional(),
  serverHostname: z.string().trim().max(255).optional(),
  serverLocation: z.string().trim().max(120).optional(),
  nameservers: z.string().trim().max(500).optional(),
  phpVersion: z.string().trim().max(20).optional(),
  notes: z.string().max(2000).optional(),
});

/// Domain settings for the browser. The FTP password is a live credential for
/// someone else's server, so only a hint of it ever leaves this process.
function presentSettings(settings) {
  if (!settings) return settings;
  const { ftpPassword, ...rest } = settings;
  return {
    ...rest,
    hasFtpPassword: Boolean(ftpPassword),
    ftpPasswordHint: ftpPassword ? tokenHint(decryptMaybe(ftpPassword)) : null,
  };
}

const blankToNull = (obj) =>
  Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, v === '' ? null : v]));

domainsRouter.put(
  '/:id/settings',
  withDomain(),
  validate(settingsSchema),
  asyncHandler(async (req, res) => {
    const data = blankToNull(req.body);

    // An empty password field means "leave it alone", so an administrator can
    // edit the host or username without retyping the secret.
    if (data.ftpPassword) {
      data.ftpPassword = encrypt(data.ftpPassword);
    } else {
      delete data.ftpPassword;
    }

    const settings = await prisma.domainSettings.upsert({
      where: { domainId: req.domain.id },
      create: { domainId: req.domain.id, ...data },
      update: data,
    });
    res.json({ settings: presentSettings(settings) });
  }),
);

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

// Mounted through withDomain, so every file route inherits the same check as
// the rest of the domain: a user reaches only domains assigned to them.
domainsRouter.use('/:id/files', withDomain(), filesRouter);

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

domainsRouter.post(
  '/:id/dns',
  withDomain(),
  validate(dnsSchema),
  asyncHandler(async (req, res) => {
    const record = await prisma.dnsRecord.create({
      data: { domainId: req.domain.id, ...req.body, isFromProvider: false },
    });
    res.status(201).json({ record });
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

    const record = await prisma.dnsRecord.update({
      where: { id: existing.id },
      // An edited record is no longer a faithful copy of the provider zone, so
      // it becomes a manual record and survives the next sync.
      data: { ...req.body, isFromProvider: false },
    });
    res.json({ record });
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
    await prisma.dnsRecord.delete({ where: { id: existing.id } });
    res.json({ ok: true });
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
    res.json({ ok: true, message: `${mailbox.address} was permanently deleted at the provider.` });
  }),
);

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
