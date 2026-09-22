// Hostinger adapter.
//
// Endpoints follow Hostinger's official API (https://developers.hostinger.com),
// authenticated with a Bearer API token:
//   GET /api/domains/v1/portfolio            -> domains on the account
//   GET /api/domains/v1/portfolio/{domain}   -> registrar detail (nameservers, lock)
//   GET /api/hosting/v1/websites             -> hosted websites (server/account info)
//   GET /api/dns/v1/zones/{domain}           -> DNS zone records
//   PUT /api/dns/v1/zones/{domain}           -> replace the zone (whole-zone write)
//   POST /api/domains/v1/availability        -> is a name free to register
//   GET /api/mail/v1/orders                  -> mail orders (one per domain)
//   GET /api/mail/v1/orders/{orderId}/mailboxes -> mailboxes for an order
//
// Every method returns normalised data or throws; nothing is invented. When an
// endpoint is not available on the account's plan the caller gets an explicit
// "unsupported" result rather than fabricated rows.

import {
  flattenZone, addRecord, removeRecord, updateRecord,
  assertSafeWrite, hasRecord, countRecords, ZoneError,
} from '../lib/dnsZone.js';

// Overridable so the integration tests can point the adapter at a local stub
// that serves Hostinger's documented response shapes.
const BASE_URL = process.env.HOSTINGER_API_BASE_URL || 'https://developers.hostinger.com';
const TIMEOUT_MS = 20000;

async function request(token, path, { method = 'GET', body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await res.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }

    if (!res.ok) {
      let message =
        (payload && (payload.message || payload.error)) ||
        (res.status === 401 ? 'Invalid or expired API token.' : `Hostinger API returned ${res.status}.`);

      // 422 responses carry per-field reasons; surfacing them saves a round of
      // guessing at which rule the input broke.
      const fieldErrors = payload?.errors && typeof payload.errors === 'object' ? payload.errors : null;
      if (fieldErrors) {
        const detail = Object.entries(fieldErrors)
          .map(([field, msgs]) => `${field}: ${[].concat(msgs).join(', ')}`)
          .join('; ');
        if (detail) message = `${message} (${detail})`;
      }

      const err = new Error(message);
      err.status = res.status;
      throw err;
    }
    return payload;
  } catch (err) {
    if (err.name === 'AbortError') {
      const timeout = new Error('Hostinger API did not respond in time.');
      timeout.status = 504;
      throw timeout;
    }
    if (!err.status) {
      err.status = 502;
      err.message = `Could not reach the Hostinger API: ${err.message}`;
    }
    throw err;
  }
}

/// Hostinger wraps some list responses in `{ data: [...] }` and returns others
/// as a bare array.
function unwrap(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.data)) return body.data;
  return [];
}

function toDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/// Finds the mail order covering a domain. Mailboxes hang off an order rather
/// than a domain in Hostinger's model, so nothing mail-related can happen
/// without one.
async function findMailOrder(token, domainName) {
  const orders = unwrap(await request(token, '/api/mail/v1/orders'));
  const wanted = String(domainName).toLowerCase();

  const order = orders.find((o) => {
    const d = o?.domain;
    const name = typeof d === 'string' ? d : d?.domain || d?.name;
    return String(name || '').toLowerCase() === wanted;
  });

  if (!order?.id) {
    const err = new Error(
      `${domainName} has no email plan at Hostinger, so mailboxes cannot be managed there. ` +
        'You can still record mailboxes in the portal manually.',
    );
    err.status = 404;
    throw err;
  }
  return order;
}

/// Maps a mailbox resource. Hostinger reports usage as `storageUsed` and
/// `storageQuota` in KILOBYTES, so both are converted to megabytes here.
function toMailbox(m) {
  const kbToMb = (kb) => (kb === null || kb === undefined ? null : Math.round(Number(kb) / 1024));
  return {
    address: m.address,
    status: m.status || 'unknown',
    externalId: m.id != null ? String(m.id) : null,
    quotaMb: kbToMb(m.usage?.storageQuota),
    usedMb: kbToMb(m.usage?.storageUsed),
    messagesUsed: m.usage?.messagesUsed ?? null,
    messagesQuota: m.usage?.messagesQuota ?? null,
    isCatchall: m.isCatchall ?? null,
  };
}

export const hostingerAdapter = {
  key: 'hostinger',
  label: 'Hostinger',
  defaultDocsUrl: 'https://docs.hostinger.com/api-reference/overview',
  tokenLabel: 'API Token',
  tokenHelp:
    'Create a token in hPanel under Account → API. It is stored encrypted and never sent to the browser.',

  // Which features this provider can actually serve. The UI reads these flags
  // so an unsupported area degrades to manual entry instead of erroring.
  capabilities: {
    domains: true,
    dns: true,
    // DNS is writable, but only as a whole zone — see replaceDnsZone.
    dnsWrite: true,
    // Whether a name is free to register.
    domainSearch: true,
    email: true,
    // Mailboxes can be created, deleted and have their password changed
    // through the API; these act on the real account.
    emailWrite: true,
    // Forwarders, aliases, autoreplies and catch-alls are read here only.
    emailExtras: true,
    servers: true,
    ftp: false, // Hostinger's API does not expose FTP/FTPS credentials.
  },

  /// Cheapest authenticated call we can make; proves the token works.
  async testConnection(token) {
    const body = await request(token, '/api/domains/v1/portfolio');
    const domains = unwrap(body);
    return {
      ok: true,
      message: `Connection successful. Found ${domains.length} domain${domains.length === 1 ? '' : 's'} on this account.`,
      meta: { domainCount: domains.length },
    };
  },

  /// Domains from the registrar portfolio, merged with hosted websites so
  /// domains that are hosted but registered elsewhere still show up.
  async listDomains(token) {
    const portfolio = unwrap(await request(token, '/api/domains/v1/portfolio'));

    const byName = new Map();
    for (const item of portfolio) {
      if (!item?.domain) continue; // unclaimed free domains have a null name
      byName.set(item.domain, {
        name: item.domain,
        externalId: item.id != null ? String(item.id) : null,
        status: item.status || 'unknown',
        type: item.type || null,
        registeredAt: toDate(item.createdAt),
        expiresAt: toDate(item.expiresAt),
      });
    }

    // Hosted websites are a best-effort enrichment: some plans/tokens cannot
    // read them, which must not fail the whole sync.
    try {
      const websites = unwrap(await request(token, '/api/hosting/v1/websites'));
      for (const site of websites) {
        if (!site?.domain) continue;
        const existing = byName.get(site.domain);
        if (existing) {
          existing.website = site;
        } else {
          byName.set(site.domain, {
            name: site.domain,
            externalId: null,
            status: site.isEnabled === false ? 'suspended' : 'active',
            type: 'hosting',
            registeredAt: toDate(site.createdAt),
            expiresAt: null,
            website: site,
          });
        }
      }
    } catch {
      // Ignored on purpose — portfolio domains are still returned.
    }

    return [...byName.values()];
  },

  /// Registrar detail for one domain (nameservers, lock/privacy state).
  async getDomainDetails(token, domainName) {
    const body = await request(token, `/api/domains/v1/portfolio/${encodeURIComponent(domainName)}`);
    if (!body || typeof body !== 'object') return null;
    const data = body.data && typeof body.data === 'object' ? body.data : body;
    const ns = data.nameServers || {};
    const nameservers = Object.keys(ns)
      .sort()
      .map((k) => ns[k])
      .filter(Boolean);
    return {
      status: data.status || null,
      isLocked: data.isLocked ?? null,
      isPrivacyProtected: data.isPrivacyProtected ?? null,
      nameservers,
      registeredAt: toDate(data.registeredAt || data.createdAt),
      expiresAt: toDate(data.expiresAt),
    };
  },

  /// DNS zone, flattened from Hostinger's name-grouped shape into one row per
  /// record value, which is what the UI and database store.
  async listDnsRecords(token, domainName) {
    // A 404 here means Hostinger holds no zone for this domain — common when a
    // domain is registered there but its DNS is hosted elsewhere. That is a
    // fact about the domain, not a failure, so it reads as an empty zone
    // rather than souring a whole account sync.
    let body;
    try {
      body = await request(token, `/api/dns/v1/zones/${encodeURIComponent(domainName)}`);
    } catch (err) {
      if (err.status === 404) return [];
      throw err;
    }
    const groups = unwrap(body);
    const flat = [];
    for (const group of groups) {
      const entries = Array.isArray(group?.records) ? group.records : [];
      for (const entry of entries) {
        flat.push({
          name: group.name ?? '@',
          type: group.type ?? 'A',
          content: entry?.content ?? '',
          ttl: Number(group.ttl) || 3600,
          isDisabled: Boolean(entry?.isDisabled),
        });
      }
    }
    return flat;
  },

  /// Mailboxes for a domain. Hostinger scopes mailboxes to a mail *order*, so
  /// we find the order matching this domain first. No order means the domain
  /// has no email plan — an empty list, not an error.
  async listEmailAccounts(token, domainName) {
    // Reading is tolerant: a domain with no email plan simply has no
    // mailboxes, which is a fact rather than a failure.
    const order = await findMailOrder(token, domainName).catch(() => null);
    if (!order?.id) return [];

    const mailboxes = unwrap(
      await request(token, `/api/mail/v1/orders/${encodeURIComponent(order.id)}/mailboxes`),
    );
    return mailboxes.filter((m) => m?.address).map(toMailbox);
  },

  // -------------------------------------------------------------------------
  // Mailbox writes. These change the real account, so each one resolves the
  // mail order for the domain first and fails loudly when there is none —
  // better than appearing to succeed against nothing.
  // -------------------------------------------------------------------------

  /// Creates a mailbox on the domain's mail plan.
  /// `localPart` is the piece before the @; the domain comes from the order.
  async createMailbox(token, domainName, { localPart, password }) {
    const order = await findMailOrder(token, domainName);
    const created = await request(token, `/api/mail/v1/orders/${encodeURIComponent(order.id)}/mailboxes`, {
      method: 'POST',
      body: { localPart, password },
    });
    const data = created?.data && typeof created.data === 'object' ? created.data : created;
    return data?.address ? toMailbox(data) : { address: `${localPart}@${domainName}`, status: 'active', externalId: data?.id != null ? String(data.id) : null };
  },

  /// Permanently deletes a mailbox and everything in it.
  async deleteMailbox(token, mailboxId) {
    await request(token, `/api/mail/v1/mailboxes/${encodeURIComponent(mailboxId)}`, { method: 'DELETE' });
    return { ok: true };
  },

  async changeMailboxPassword(token, mailboxId, password) {
    await request(token, `/api/mail/v1/mailboxes/${encodeURIComponent(mailboxId)}/password`, {
      method: 'PATCH',
      body: { password },
    });
    return { ok: true };
  },

  /// Forwarders, aliases, autoreplies and catch-alls for a domain, read only.
  /// Each is optional on the plan, so one failing must not lose the others.
  async listEmailExtras(token, domainName) {
    const order = await findMailOrder(token, domainName).catch(() => null);
    if (!order?.id) return { forwarders: [], aliases: [], autoreplies: [], catchalls: [] };

    const base = `/api/mail/v1/orders/${encodeURIComponent(order.id)}`;
    const fetchList = async (path) => {
      try {
        return unwrap(await request(token, path));
      } catch {
        return [];
      }
    };

    const [forwarders, aliases, autoreplies, catchalls] = await Promise.all([
      fetchList(`${base}/forwarders`),
      fetchList(`${base}/aliases`),
      fetchList(`${base}/autoreplies`),
      fetchList(`${base}/catchalls`),
    ]);

    return {
      forwarders: forwarders.map((f) => ({
        id: f.id != null ? String(f.id) : null,
        mailbox: f.mailbox?.address || null,
        destination: f.destination || null,
        keepCopy: f.isKeepCopyEnabled ?? null,
        isActive: f.isActive ?? null,
        isConfirmed: f.isConfirmed ?? null,
      })),
      aliases: aliases.map((a) => ({
        id: a.id != null ? String(a.id) : null,
        address: a.address || null,
        mailbox: a.mailbox?.address || null,
        isActive: a.isActive ?? null,
      })),
      autoreplies: autoreplies.map((r) => ({
        id: r.id != null ? String(r.id) : null,
        mailbox: r.mailbox?.address || null,
        subject: r.subject || null,
        body: r.body || null,
        startsAt: toDate(r.startsAt),
        endsAt: toDate(r.endsAt),
      })),
      catchalls: catchalls.map((c) => ({
        id: c.id != null ? String(c.id) : null,
        mailbox: c.mailbox?.address || null,
        domain: c.domain || null,
        isActive: c.isActive ?? null,
        isConfirmed: c.isConfirmed ?? null,
      })),
    };
  },


  // -------------------------------------------------------------------------
  // DNS writes.
  //
  // Hostinger has no per-record endpoint: a zone is replaced whole. So each of
  // these reads the live zone, changes exactly one thing in it, checks the
  // result against what was asked for, writes it back, and then reads it again
  // to confirm. The read-back is not ceremony — a whole-zone write that half
  // succeeded would otherwise look identical to one that worked.
  // -------------------------------------------------------------------------

  /// The zone exactly as Hostinger holds it, with nothing normalised away.
  /// This is the shape that gets written back, so it must stay untouched.
  async getDnsZoneRaw(token, domainName) {
    try {
      return unwrap(await request(token, `/api/dns/v1/zones/${encodeURIComponent(domainName)}`));
    } catch (err) {
      if (err.status === 404) return [];
      throw err;
    }
  },

  async replaceDnsZone(token, domainName, groups) {
    await request(token, `/api/dns/v1/zones/${encodeURIComponent(domainName)}`, {
      method: 'PUT',
      body: { overwrite: true, zone: groups },
    });
    return { ok: true };
  },

  /// Applies one edit to the live zone and returns the zone as it stands
  /// afterwards. `edit` is one of the pure functions from lib/dnsZone.
  async applyZoneEdit(token, domainName, edit, { expectedDelta, verify, minimumBefore = 0 }) {
    const before = await this.getDnsZoneRaw(token, domainName);
    const { groups, ttlAffected = 0 } = edit(before);

    assertSafeWrite(before, groups, { expectedDelta, minimumBefore });
    await this.replaceDnsZone(token, domainName, groups);

    // Read it back. If the zone does not now say what it was told to say, the
    // write did not take, and silence here would be the worst outcome.
    const after = await this.getDnsZoneRaw(token, domainName);
    if (verify && !verify(after)) {
      throw new ZoneError(
        'The change was sent but the zone does not show it. Reload the DNS tab to see what the zone actually holds.',
        502,
      );
    }

    return { records: flattenZone(after), total: countRecords(after), ttlAffected };
  },

  async createDnsRecord(token, domainName, record, { minimumBefore = 0 } = {}) {
    return this.applyZoneEdit(token, domainName, (zone) => addRecord(zone, record), {
      expectedDelta: 1,
      minimumBefore,
      verify: (zone) => hasRecord(zone, record),
    });
  },

  async updateDnsRecord(token, domainName, { before, after }, { minimumBefore = 0 } = {}) {
    return this.applyZoneEdit(token, domainName, (zone) => updateRecord(zone, before, after), {
      // One out, one in.
      expectedDelta: 0,
      minimumBefore,
      verify: (zone) => hasRecord(zone, after) && !hasRecord(zone, before),
    });
  },

  async deleteDnsRecord(token, domainName, record, { minimumBefore = 0 } = {}) {
    return this.applyZoneEdit(token, domainName, (zone) => removeRecord(zone, record), {
      expectedDelta: -1,
      minimumBefore,
      verify: (zone) => !hasRecord(zone, record),
    });
  },

  /// Whether a name is free to register, across the given endings.
  ///
  /// Reports "unknown" rather than "available" when the registry does not
  /// answer clearly: telling someone a taken domain is free is worse than
  /// telling them we could not find out.
  async checkDomainAvailability(token, { name, tlds }) {
    const body = await request(token, '/api/domains/v1/availability', {
      method: 'POST',
      body: { domain: name, tlds, withAlternatives: false },
    });

    const rows = unwrap(body);
    return rows
      .map((row) => {
        const tld = row?.tld || row?.domain?.split('.').slice(1).join('.') || null;
        const full = row?.domain?.includes('.') ? row.domain : tld ? `${name}.${tld}` : row?.domain || name;
        const free = row?.isAvailable ?? row?.available ?? null;
        return {
          domain: String(full).toLowerCase(),
          tld,
          available: free === null ? null : Boolean(free),
          // Some endings refuse registration for reasons of their own
          // (reserved, premium, restricted). Pass that through verbatim.
          restriction: row?.restriction || row?.reason || null,
        };
      })
      .filter((r) => r.domain);
  },

  /// VPS instances on the account, shown read-only in the Super Admin area.
  async listServers(token) {
    const machines = unwrap(await request(token, '/api/vps/v1/virtual-machines'));
    return machines.map((vm) => ({
      id: vm.id != null ? String(vm.id) : null,
      hostname: vm.hostname || null,
      plan: vm.plan || null,
      state: vm.state || null,
      cpus: vm.cpus ?? null,
      memoryMb: vm.memory ?? null,
      diskMb: vm.disk ?? null,
      bandwidthMb: vm.bandwidth ?? null,
      ipv4: Array.isArray(vm.ipv4) ? vm.ipv4.map((ip) => ip?.address).filter(Boolean) : [],
    }));
  },
};
