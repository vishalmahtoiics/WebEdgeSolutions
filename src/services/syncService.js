import { prisma } from '../db.js';
import { tryCapability } from '../providers/index.js';
import { loadProviderWithToken } from './providerService.js';
import { detectAndStore } from './technologyService.js';

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

/// Refreshes the mailbox list from the provider.
///
/// Rows are updated in place rather than deleted and recreated, because a
/// mailbox row now carries administrator decisions — a custom size, a custom
/// usage figure, notes — that must survive every sync. Only the
/// provider-reported values and status are touched here.
export async function syncEmailAccounts(domain) {
  if (!domain.providerId) return { supported: false, count: 0 };

  const { adapter, token } = await loadProviderWithToken(domain.providerId);
  const result = await tryCapability(adapter, 'listEmailAccounts', token, domain.name);
  if (!result.supported) return { supported: false, count: 0 };
  if (result.error) return { supported: true, error: result.error, count: 0 };

  const mailboxes = result.data || [];
  const seen = new Set();

  for (const m of mailboxes) {
    const address = String(m.address).toLowerCase();
    seen.add(address);

    await prisma.emailAccount.upsert({
      where: { domainId_address: { domainId: domain.id, address } },
      create: {
        domainId: domain.id,
        address,
        status: m.status || 'unknown',
        externalId: m.externalId ?? null,
        providerQuotaMb: m.quotaMb ?? null,
        providerUsedMb: m.usedMb ?? null,
        providerCreatedAt: m.createdAt ?? null,
        isFromProvider: true,
      },
      // Overrides and notes are deliberately absent: an administrator's
      // choices are not the provider's to overwrite.
      update: {
        status: m.status || 'unknown',
        externalId: m.externalId ?? null,
        providerQuotaMb: m.quotaMb ?? null,
        providerUsedMb: m.usedMb ?? null,
        providerCreatedAt: m.createdAt ?? null,
        isFromProvider: true,
      },
    });
  }

  // A mailbox that has disappeared upstream is removed, unless it was entered
  // by hand — that row is the administrator's own record, not a stale copy.
  await prisma.emailAccount.deleteMany({
    where: { domainId: domain.id, isFromProvider: true, address: { notIn: [...seen] } },
  });

  return { supported: true, count: mailboxes.length };
}

/// Refreshes one domain's DNS records, mailboxes, and what its site is built on.
///
/// Each part is reported separately and a failure in one does not stop the
/// others: a domain with a DNS zone but no email plan should still get its DNS,
/// and a site that is down should not cost it either.
export async function refreshDomain(domain) {
  const result = { dns: null, emails: null, technology: null };

  try {
    const dns = await syncDnsRecords(domain);
    result.dns = dns.error ? { ok: false, error: dns.error } : { ok: dns.supported, count: dns.count };
  } catch (err) {
    result.dns = { ok: false, error: err.message };
  }

  try {
    const emails = await syncEmailAccounts(domain);
    result.emails = emails.error
      ? { ok: false, error: emails.error }
      : { ok: emails.supported, count: emails.count };
  } catch (err) {
    result.emails = { ok: false, error: err.message };
  }

  // Detection reaches out to the site's own filesystem or its homepage, neither
  // of which is the provider's business, so it runs for manually added domains
  // too — and never reports a failure as a problem with the refresh.
  const tech = await detectAndStore(domain);
  result.technology = tech.ok
    ? { ok: true, name: tech.technology.name, version: tech.technology.version }
    : { ok: false, attempts: tech.attempts };

  return result;
}

/// One action that pulls everything a provider knows into the database:
/// the domain list first, then DNS and mailboxes for each domain it owns.
///
/// Domains are processed one at a time rather than in parallel, to stay
/// polite to the provider's rate limits. Per-domain failures are collected
/// rather than thrown, so one broken domain cannot abandon the rest.
export async function syncEverything(providerId) {
  const domainSummary = await syncDomains(providerId);

  const domains = await prisma.domain.findMany({
    where: { providerId, source: 'PROVIDER' },
    orderBy: { name: 'asc' },
  });

  const details = [];
  let dnsRecords = 0;
  let mailboxes = 0;
  let identified = 0;
  const failures = [];

  for (const domain of domains) {
    const result = await refreshDomain(domain);
    if (result.dns?.ok) dnsRecords += result.dns.count || 0;
    if (result.emails?.ok) mailboxes += result.emails.count || 0;
    if (result.technology?.ok) identified += 1;

    const problems = [result.dns?.error, result.emails?.error].filter(Boolean);
    if (problems.length) failures.push({ domain: domain.name, problems });

    details.push({
      domain: domain.name,
      dnsCount: result.dns?.ok ? result.dns.count : null,
      emailCount: result.emails?.ok ? result.emails.count : null,
      technology: result.technology?.ok ? result.technology.name : null,
      problems,
    });
  }

  return {
    domains: domainSummary,
    domainsProcessed: domains.length,
    dnsRecords,
    mailboxes,
    // How many sites the detector could actually name. Not a failure count:
    // a domain that is parked or has no file access simply has no answer.
    identified,
    failures,
    details,
  };
}
