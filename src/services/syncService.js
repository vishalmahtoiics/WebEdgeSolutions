import { prisma } from '../db.js';
import { tryCapability } from '../providers/index.js';
import { loadProviderWithToken } from './providerService.js';

/// Pulls domains from a provider into the local database.
///
/// Matching is by domain name, which is unique, so running Sync repeatedly
/// updates existing rows instead of creating duplicates. Manually added domains
/// are left untouched: we never silently reassign a hand-entered domain to a
/// provider.
export async function syncDomains(providerId) {
  const { provider, adapter, token } = await loadProviderWithToken(providerId);

  const remote = await adapter.listDomains(token);
  const summary = { imported: 0, updated: 0, skipped: 0, total: remote.length };

  for (const item of remote) {
    const name = String(item.name).trim().toLowerCase();
    if (!name) continue;

    const existing = await prisma.domain.findUnique({ where: { name } });

    if (!existing) {
      await prisma.domain.create({
        data: {
          name,
          source: 'PROVIDER',
          providerId: provider.id,
          externalId: item.externalId ?? null,
          status: item.status ?? 'unknown',
          type: item.type ?? null,
          registeredAt: item.registeredAt ?? null,
          expiresAt: item.expiresAt ?? null,
          lastSyncedAt: new Date(),
          settings: { create: buildSettingsFromWebsite(item.website) },
        },
      });
      summary.imported += 1;
      continue;
    }

    if (existing.source === 'MANUAL') {
      summary.skipped += 1;
      continue;
    }

    await prisma.domain.update({
      where: { id: existing.id },
      data: {
        providerId: provider.id,
        externalId: item.externalId ?? existing.externalId,
        status: item.status ?? existing.status,
        type: item.type ?? existing.type,
        registeredAt: item.registeredAt ?? existing.registeredAt,
        expiresAt: item.expiresAt ?? existing.expiresAt,
        lastSyncedAt: new Date(),
      },
    });
    summary.updated += 1;
  }

  await prisma.provider.update({
    where: { id: provider.id },
    data: { lastSyncedAt: new Date() },
  });

  return summary;
}

/// The websites endpoint gives us the hosting account username, which is also
/// the FTP username, so the admin starts from something real rather than blank.
function buildSettingsFromWebsite(website) {
  return website?.username ? { ftpUsername: website.username } : {};
}

/// Replaces the provider-sourced DNS records for a domain with a fresh copy of
/// the zone. Records added by hand (isFromProvider = false) are preserved.
export async function syncDnsRecords(domain) {
  if (!domain.providerId) return { supported: false, count: 0 };

  const { adapter, token } = await loadProviderWithToken(domain.providerId);
  const result = await tryCapability(adapter, 'listDnsRecords', token, domain.name);
  if (!result.supported) return { supported: false, count: 0 };
  if (result.error) return { supported: true, error: result.error, count: 0 };

  const records = result.data || [];
  await prisma.$transaction([
    prisma.dnsRecord.deleteMany({ where: { domainId: domain.id, isFromProvider: true } }),
    prisma.dnsRecord.createMany({
      data: records.map((r) => ({
        domainId: domain.id,
        name: r.name || '@',
        type: r.type || 'A',
        content: r.content || '',
        ttl: r.ttl || 3600,
        isFromProvider: true,
      })),
    }),
  ]);

  return { supported: true, count: records.length };
}

/// Same contract as DNS: provider mailboxes are refreshed, manual ones stay.
export async function syncEmailAccounts(domain) {
  if (!domain.providerId) return { supported: false, count: 0 };

  const { adapter, token } = await loadProviderWithToken(domain.providerId);
  const result = await tryCapability(adapter, 'listEmailAccounts', token, domain.name);
  if (!result.supported) return { supported: false, count: 0 };
  if (result.error) return { supported: true, error: result.error, count: 0 };

  const mailboxes = result.data || [];
  const manual = await prisma.emailAccount.findMany({
    where: { domainId: domain.id, isFromProvider: false },
    select: { address: true },
  });
  const manualAddresses = new Set(manual.map((m) => m.address.toLowerCase()));

  await prisma.emailAccount.deleteMany({ where: { domainId: domain.id, isFromProvider: true } });

  // A mailbox the admin had entered by hand and that now exists upstream stays
  // as the manual row, so their notes and quota edits are not lost.
  const fresh = mailboxes.filter((m) => !manualAddresses.has(String(m.address).toLowerCase()));
  if (fresh.length) {
    await prisma.emailAccount.createMany({
      data: fresh.map((m) => ({
        domainId: domain.id,
        address: m.address,
        status: m.status || 'unknown',
        externalId: m.externalId ?? null,
        quotaMb: m.quotaMb ?? null,
        usedMb: m.usedMb ?? null,
        isFromProvider: true,
      })),
      skipDuplicates: true,
    });
  }

  return { supported: true, count: fresh.length };
}
