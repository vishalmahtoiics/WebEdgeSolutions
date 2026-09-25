// What each role is allowed to see.
//
// Only a Super Admin deals with hosting providers. A normal user sees their
// domains, DNS and mailboxes as plain facts about their own service — never
// which company hosts them, nor which rows came from an API rather than being
// typed in.
//
// This is enforced here, on the way out of the API, rather than by hiding
// things in the browser: a user reading the network tab must not learn the
// provider either.

/// What a site is built on.
///
/// The effective answer is the administrator's override where one is set,
/// otherwise what was detected. Everyone sees that, along with the evidence:
/// a technology name with nothing behind it is worth no more than a guess, and
/// the evidence describes the customer's own site, never who hosts it.
///
/// `source` stays deliberately plain — "files" means the site's own filesystem
/// and "site" means its homepage. Neither names a provider.
export function presentTechnology(domain) {
  const override = domain.techOverride;
  const isCustom = Boolean(override);

  const name = override || domain.detectedTech || null;
  if (!name) return null;

  return {
    name,
    version: (isCustom ? domain.techVersionOverride : domain.detectedTechVersion) || null,
    source: isCustom ? 'manual' : domain.detectedTechSource || null,
    evidence: isCustom ? 'Set by your administrator' : domain.detectedTechEvidence || null,
    confidence: isCustom ? 'confirmed' : domain.detectedTechLevel || null,
    checkedAt: domain.detectedTechAt || null,
  };
}

/// The same, plus what the detector found underneath an override, which is what
/// the edit dialog needs to offer "detected" against "custom".
function adminTechnology(domain) {
  return {
    technology: presentTechnology(domain),
    detectedTech: domain.detectedTech || null,
    detectedTechVersion: domain.detectedTechVersion || null,
    detectedTechSource: domain.detectedTechSource || null,
    detectedTechEvidence: domain.detectedTechEvidence || null,
    detectedTechLevel: domain.detectedTechLevel || null,
    detectedTechAt: domain.detectedTechAt || null,
    techOverride: domain.techOverride || null,
    techVersionOverride: domain.techVersionOverride || null,
    usesCustomTech: Boolean(domain.techOverride),
  };
}

/// Domain row for a list view.
export function presentDomainSummary(domain, isAdmin) {
  const base = {
    id: domain.id,
    name: domain.name,
    status: domain.status,
    type: domain.type,
    // When it was added to the hosting account, as the provider reports it.
    registeredAt: domain.registeredAt,
    expiresAt: domain.expiresAt,
    lastSyncedAt: domain.lastSyncedAt,
    emailCount: domain._count?.emailAccounts ?? 0,
    dnsCount: domain._count?.dnsRecords ?? 0,
    // Whether this domain can be refreshed from upstream. Deliberately a plain
    // boolean: it says an action is possible, not who provides it.
    canRefresh: Boolean(domain.providerId),
    technology: presentTechnology(domain),
  };

  if (!isAdmin) return base;

  return {
    ...base,
    source: domain.source,
    sourceLabel: domain.source === 'MANUAL' ? 'Manually Added' : domain.provider?.name || 'Provider',
    provider: domain.provider,
    userCount: domain._count?.assignments ?? 0,
  };
}

/// Single domain, as returned by the manage page.
export function presentDomainDetail(domain, isAdmin) {
  const base = {
    id: domain.id,
    name: domain.name,
    status: domain.status,
    type: domain.type,
    registeredAt: domain.registeredAt,
    expiresAt: domain.expiresAt,
    lastSyncedAt: domain.lastSyncedAt,
    createdAt: domain.createdAt,
    canRefresh: Boolean(domain.providerId),
    technology: presentTechnology(domain),
  };

  if (!isAdmin) return base;

  return {
    ...base,
    ...adminTechnology(domain),
    source: domain.source,
    sourceLabel: domain.source === 'MANUAL' ? 'Manually Added' : domain.provider?.name || 'Provider',
    provider: domain.provider,
    externalId: domain.externalId,
  };
}

/// DNS record.
///
/// `isLive` says whether this record is in the zone the internet resolves, as
/// opposed to a note kept only in the portal. Everyone gets it, because it is
/// the difference between editing real DNS and editing a memo — and as a plain
/// boolean about their own zone it names nobody.
///
/// `isFromProvider` is the same bit wearing its internal meaning (it decides
/// whether a sync replaces the row) and stays with the administrator.
export function presentDnsRecord(record, isAdmin) {
  const base = {
    id: record.id,
    name: record.name,
    type: record.type,
    content: record.content,
    ttl: record.ttl,
    isLive: Boolean(record.isFromProvider),
  };
  return isAdmin ? { ...base, isFromProvider: record.isFromProvider } : base;
}

/// Mailbox.
///
/// `quotaMb` and `usedMb` are the effective figures — an administrator's
/// override where one is set, otherwise what the provider reported. Everyone
/// sees those. Only an administrator additionally sees the two apart, which is
/// what the edit dialog needs to offer "real" against "custom".
///
/// For users the upstream id becomes a plain `isManaged` flag, so the UI still
/// knows a password can be set without exposing the provider's id.
export function presentEmailAccount(email, isAdmin) {
  const quotaMb = email.quotaMbOverride ?? email.providerQuotaMb;
  const usedMb = email.usedMbOverride ?? email.providerUsedMb;

  const base = {
    id: email.id,
    address: email.address,
    status: email.status,
    quotaMb,
    usedMb,
    notes: email.notes,
    isManaged: Boolean(email.externalId),
    // When the mailbox was made: the hosting account's own date where it
    // reports one, otherwise when it was first listed here. `addedSource`
    // says which, so a date is never passed off as the provider's when it
    // is only the portal's.
    addedAt: email.providerCreatedAt ?? email.createdAt ?? null,
    addedSource: email.providerCreatedAt ? 'server' : 'portal',
  };

  if (!isAdmin) return base;

  return {
    ...base,
    isFromProvider: email.isFromProvider,
    externalId: email.externalId,
    // What the provider actually reports, kept even while an override is shown.
    providerQuotaMb: email.providerQuotaMb,
    providerUsedMb: email.providerUsedMb,
    quotaMbOverride: email.quotaMbOverride,
    usedMbOverride: email.usedMbOverride,
    usesCustomQuota: email.quotaMbOverride !== null && email.quotaMbOverride !== undefined,
    usesCustomUsed: email.usedMbOverride !== null && email.usedMbOverride !== undefined,
  };
}

/// Feature flags for the manage page. A user gets only what changes the UI;
/// the adapter's own capability names stay server-side.
export function presentCapabilities(capabilities, domain, isAdmin) {
  const linked = Boolean(domain.providerId);
  // Whether a DNS edit here changes what the internet resolves. Everyone needs
  // this — it is the difference between editing a zone and editing a note —
  // and as a plain boolean it says nothing about who holds the zone.
  const canEditLiveDns = linked && Boolean(capabilities?.dnsWrite);

  if (isAdmin) return { ...(capabilities || {}), canEditLiveDns };

  return {
    canRefresh: linked && Boolean(capabilities?.email || capabilities?.dns),
    canManageEmail: linked && Boolean(capabilities?.emailWrite),
    canEditLiveDns,
  };
}
