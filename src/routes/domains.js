import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { validate } from '../middleware/validate.js';
import { requireAuth, requireAdmin, getAccessibleDomain, isAdmin } from '../middleware/auth.js';
import { asyncHandler, badRequest, notFound } from '../lib/errors.js';
import { getAdapter, tryCapability } from '../providers/index.js';
import { loadProviderWithToken } from '../services/providerService.js';
import { syncDnsRecords, syncEmailAccounts } from '../services/syncService.js';

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

function sourceLabel(domain) {
  if (domain.source === 'MANUAL') return 'Manually Added';
  return domain.provider?.name || 'Provider';
}

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

    res.json({
      domains: domains.map((d) => ({
        id: d.id,
        name: d.name,
        status: d.status,
        type: d.type,
        source: d.source,
        sourceLabel: sourceLabel(d),
        provider: d.provider,
        expiresAt: d.expiresAt,
        lastSyncedAt: d.lastSyncedAt,
        emailCount: d._count.emailAccounts,
        dnsCount: d._count.dnsRecords,
        userCount: d._count.assignments,
      })),
    });
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

    res.json({
      domain: {
        id: d.id,
        name: d.name,
        status: d.status,
        type: d.type,
        source: d.source,
        sourceLabel: sourceLabel(d),
        provider: d.provider,
        externalId: d.externalId,
        registeredAt: d.registeredAt,
        expiresAt: d.expiresAt,
        lastSyncedAt: d.lastSyncedAt,
        createdAt: d.createdAt,
      },
      // Drives which panels offer a "Refresh from provider" button.
      capabilities: adapter?.capabilities || {},
      settings: d.settings,
      dnsRecords: d.dnsRecords,
      emailAccounts: d.emailAccounts,
      assignedUsers: isAdmin(req.user) ? d.assignments.map((a) => a.user) : undefined,
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
  '/:id/provider-details',
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

// ---------------------------------------------------------------------------
// Domain settings (FTP/FTPS, server info) — always manual
// ---------------------------------------------------------------------------

const settingsSchema = z.object({
  ftpHost: z.string().trim().max(255).optional(),
  ftpPort: z.coerce.number().int().min(1).max(65535).nullish(),
  ftpUsername: z.string().trim().max(255).optional(),
  ftpPassword: z.string().max(255).optional(),
  ftpProtocol: z.enum(['FTP', 'FTPS', 'SFTP']).or(z.literal('')).optional(),
  serverIp: z.string().trim().max(64).optional(),
  serverHostname: z.string().trim().max(255).optional(),
  serverLocation: z.string().trim().max(120).optional(),
  nameservers: z.string().trim().max(500).optional(),
  phpVersion: z.string().trim().max(20).optional(),
  notes: z.string().max(2000).optional(),
});

const blankToNull = (obj) =>
  Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, v === '' ? null : v]));

domainsRouter.put(
  '/:id/settings',
  withDomain(),
  validate(settingsSchema),
  asyncHandler(async (req, res) => {
    const data = blankToNull(req.body);
    const settings = await prisma.domainSettings.upsert({
      where: { domainId: req.domain.id },
      create: { domainId: req.domain.id, ...data },
      update: data,
    });
    res.json({ settings });
  }),
);

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
  quotaMb: z.coerce.number().int().min(0).nullish(),
  usedMb: z.coerce.number().int().min(0).nullish(),
  notes: z.string().max(1000).optional(),
});

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
      data: { domainId: req.domain.id, ...blankToNull(req.body), isFromProvider: false },
    });
    res.status(201).json({ email });
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

    const email = await prisma.emailAccount.update({
      where: { id: existing.id },
      data: { ...blankToNull(req.body), isFromProvider: false },
    });
    res.json({ email });
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
