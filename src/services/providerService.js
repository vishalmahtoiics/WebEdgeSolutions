import { prisma } from '../db.js';
import { decrypt } from '../lib/crypto.js';
import { getAdapter } from '../providers/index.js';
import { badRequest, notFound } from '../lib/errors.js';

/// Loads a provider together with its decrypted token. The plaintext token
/// exists only inside this process — it is never attached to a response.
export async function loadProviderWithToken(providerId) {
  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
    include: { credential: true },
  });
  if (!provider) throw notFound('Provider not found.');

  const adapter = getAdapter(provider.adapter);
  if (!adapter) throw badRequest(`No integration is installed for "${provider.adapter}".`);
  if (!provider.credential) throw badRequest('This provider has no API token configured yet.');

  return { provider, adapter, token: decrypt(provider.credential.encryptedToken) };
}

/// Shape a provider for the browser: credential fields are reduced to a hint.
export function publicProvider(provider) {
  const adapter = getAdapter(provider.adapter);
  return {
    id: provider.id,
    name: provider.name,
    adapter: provider.adapter,
    adapterLabel: adapter?.label || provider.adapter,
    docsUrl: provider.docsUrl,
    isActive: provider.isActive,
    hasToken: Boolean(provider.credential),
    tokenHint: provider.credential?.tokenHint || null,
    capabilities: adapter?.capabilities || {},
    lastTestedAt: provider.lastTestedAt,
    lastTestOk: provider.lastTestOk,
    lastTestMessage: provider.lastTestMessage,
    lastSyncedAt: provider.lastSyncedAt,
    domainCount: provider._count?.domains,
    createdAt: provider.createdAt,
  };
}
