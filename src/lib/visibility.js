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

/// Domain row for a list view.
export function presentDomainSummary(domain, isAdmin) {
  const base = {
    id: domain.id,
    name: domain.name,
    status: domain.status,
    type: domain.type,
    expiresAt: domain.expiresAt,
    lastSyncedAt: domain.lastSyncedAt,
    emailCount: domain._count?.emailAccounts ?? 0,
    dnsCount: domain._count?.dnsRecords ?? 0,
    // Whether this domain can be refreshed from upstream. Deliberately a plain
    // boolean: it says an action is possible, not who provides it.
    canRefresh: Boolean(domain.providerId),
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
  };

  if (!isAdmin) return base;

  return {
    ...base,
    source: domain.source,
    sourceLabel: domain.source === 'MANUAL' ? 'Manually Added' : domain.provider?.name || 'Provider',
    provider: domain.provider,
    externalId: domain.externalId,
  };
}

/// DNS record. `isFromProvider` drives whether a sync replaces the row, which
/// is an implementation detail a user has no use for.
export function presentDnsRecord(record, isAdmin) {
  const base = {
    id: record.id,
    name: record.name,
    type: record.type,
    content: record.content,
    ttl: record.ttl,
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
  if (isAdmin) return capabilities || {};
  const linked = Boolean(domain.providerId);
  return {
    canRefresh: linked && Boolean(capabilities?.email || capabilities?.dns),
    canManageEmail: linked && Boolean(capabilities?.emailWrite),
  };
}
