import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { validate } from '../middleware/validate.js';
import { requireAdmin } from '../middleware/auth.js';
import { asyncHandler, badRequest, notFound } from '../lib/errors.js';
import { encrypt, tokenHint } from '../lib/crypto.js';
import { getAdapter, listAdapters, tryCapability } from '../providers/index.js';
import { loadProviderWithToken, publicProvider } from '../services/providerService.js';
import { syncDomains } from '../services/syncService.js';

export const providersRouter = Router();

// Everything under /api/providers is Super Admin only — this is where API
// tokens live.
providersRouter.use(requireAdmin);

/// Integrations this build ships with, for the "Provider type" dropdown.
providersRouter.get('/adapters', (_req, res) => res.json({ adapters: listAdapters() }));

providersRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const providers = await prisma.provider.findMany({
      orderBy: { createdAt: 'asc' },
      include: { credential: true, _count: { select: { domains: true } } },
    });
    res.json({ providers: providers.map(publicProvider) });
  }),
);

const providerSchema = z.object({
  name: z.string().trim().min(1, 'Provider name is required.').max(80),
  adapter: z.string().trim().min(1, 'Choose a provider type.'),
  token: z.string().trim().min(1, 'API token is required.'),
  docsUrl: z.string().trim().url('Enter a valid URL.').or(z.literal('')).optional(),
  isActive: z.boolean().optional().default(true),
});

providersRouter.post(
  '/',
  validate(providerSchema),
  asyncHandler(async (req, res) => {
    const { name, adapter: adapterKey, token, docsUrl, isActive } = req.body;
    const adapter = getAdapter(adapterKey);
    if (!adapter) throw badRequest(`No integration is installed for "${adapterKey}".`);

    const provider = await prisma.provider.create({
      data: {
        name,
        adapter: adapterKey,
        docsUrl: docsUrl || adapter.defaultDocsUrl || null,
        isActive,
        credential: {
          create: { encryptedToken: encrypt(token), tokenHint: tokenHint(token) },
        },
      },
      include: { credential: true, _count: { select: { domains: true } } },
    });

    res.status(201).json({ provider: publicProvider(provider) });
  }),
);

const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  // Omit the token to keep the stored one; send a new value to replace it.
  token: z.string().trim().min(1).optional(),
  docsUrl: z.string().trim().url('Enter a valid URL.').or(z.literal('')).optional(),
  isActive: z.boolean().optional(),
});

providersRouter.put(
  '/:id',
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    const existing = await prisma.provider.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound('Provider not found.');

    const { name, token, docsUrl, isActive } = req.body;
    const data = {};
    if (name !== undefined) data.name = name;
    if (docsUrl !== undefined) data.docsUrl = docsUrl || null;
    if (isActive !== undefined) data.isActive = isActive;

    if (token) {
      data.credential = {
        upsert: {
          create: { encryptedToken: encrypt(token), tokenHint: tokenHint(token) },
          update: { encryptedToken: encrypt(token), tokenHint: tokenHint(token) },
        },
      };
      // A new token invalidates the previous test result.
      data.lastTestedAt = null;
      data.lastTestOk = null;
      data.lastTestMessage = null;
    }

    const provider = await prisma.provider.update({
      where: { id: req.params.id },
      data,
      include: { credential: true, _count: { select: { domains: true } } },
    });
    res.json({ provider: publicProvider(provider) });
  }),
);

providersRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const provider = await prisma.provider.findUnique({ where: { id: req.params.id } });
    if (!provider) throw notFound('Provider not found.');
    // Domains stay behind (providerId is set to null by the schema) so removing
    // a provider never deletes the admin's domain records.
    await prisma.provider.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  }),
);

/// Verifies the stored credentials against the live provider API and records
/// the outcome, which is what unlocks the Sync button in the UI.
providersRouter.post(
  '/:id/test',
  asyncHandler(async (req, res) => {
    const { provider, adapter, token } = await loadProviderWithToken(req.params.id);

    let ok = false;
    let message;
    try {
      const result = await adapter.testConnection(token);
      ok = Boolean(result?.ok);
      message = result?.message || 'Connection successful.';
    } catch (err) {
      ok = false;
      message = err.message || 'Connection failed.';
    }

    await prisma.provider.update({
      where: { id: provider.id },
      data: { lastTestedAt: new Date(), lastTestOk: ok, lastTestMessage: message },
    });

    res.status(ok ? 200 : 400).json({ ok, message });
  }),
);

/// Imports domains from the provider. Safe to run repeatedly.
providersRouter.post(
  '/:id/sync',
  asyncHandler(async (req, res) => {
    const summary = await syncDomains(req.params.id);
    res.json({
      ok: true,
      ...summary,
      message: `Synced ${summary.total} domain${summary.total === 1 ? '' : 's'} — ${summary.imported} added, ${summary.updated} updated${summary.skipped ? `, ${summary.skipped} skipped (added manually)` : ''}.`,
    });
  }),
);

/// Read-only VPS listing, where the provider supports it.
providersRouter.get(
  '/:id/servers',
  asyncHandler(async (req, res) => {
    const { adapter, token } = await loadProviderWithToken(req.params.id);
    const result = await tryCapability(adapter, 'listServers', token);
    res.json({ supported: result.supported, servers: result.data || [], error: result.error });
  }),
);
