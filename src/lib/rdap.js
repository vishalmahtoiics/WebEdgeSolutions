// Asking a domain registry directly whether a name is registered.
//
// RDAP is the registries' own lookup service, the structured replacement for
// WHOIS, and ICANN requires it of every generic ending. Which registry
// answers for which ending is published by IANA as a "bootstrap" file, so
// nothing here is a list somebody typed in and forgot to update.
//
// Used as the second opinion, after the hosting provider: it needs no account
// and no key, so a search still gets a real answer when no provider is
// connected, or when the provider's check is down or rate limited.
//
// Three answers and only three. A registry that has a record for the name
// says it is taken; one that answers "not found" says it is free; anything
// else — a timeout, an ending with no RDAP service, a 429, a 500 — is
// unknown, and is reported as unknown rather than guessed at.

const BOOTSTRAP_URL = process.env.RDAP_BOOTSTRAP_URL || 'https://data.iana.org/rdap/dns.json';
const BOOTSTRAP_TTL_MS = 24 * 60 * 60 * 1000;
const LOOKUP_TIMEOUT_MS = 6000;

let bootstrap = null; // { at, servers: Map<ending, baseUrl> }
let loading = null;

async function fetchWithTimeout(url, ms, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

/// Which RDAP server answers for which ending, from IANA, kept for a day.
async function servers() {
  if (bootstrap && Date.now() - bootstrap.at < BOOTSTRAP_TTL_MS) return bootstrap.servers;
  if (loading) return loading;

  loading = (async () => {
    try {
      const res = await fetchWithTimeout(BOOTSTRAP_URL, 10000, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`bootstrap answered ${res.status}`);
      const data = await res.json();

      const map = new Map();
      for (const [endings, urls] of data.services || []) {
        // Prefer https; the file lists http alternatives for some registries.
        const base = (urls || []).find((u) => u.startsWith('https://')) || (urls || [])[0];
        if (!base) continue;
        for (const ending of endings || []) map.set(String(ending).toLowerCase(), base);
      }
      bootstrap = { at: Date.now(), servers: map };
      return map;
    } catch {
      // A failed download is retried on the next search rather than cached,
      // and an older copy, if there is one, is better than none meanwhile.
      return bootstrap?.servers || new Map();
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/// Whether `domain` is free: true, false, or null when the registry could
/// not say.
export async function rdapAvailability(domain) {
  const name = String(domain || '').toLowerCase();
  const labels = name.split('.');
  if (labels.length < 2) return null;

  const map = await servers();
  // The bootstrap lists top-level endings, so "example.co.in" is asked of
  // the .in registry — which is the registry that holds it.
  const base = map.get(labels.at(-1));
  if (!base) return null;

  try {
    const url = `${base.replace(/\/+$/, '')}/domain/${encodeURIComponent(name)}`;
    const res = await fetchWithTimeout(url, LOOKUP_TIMEOUT_MS, {
      headers: { Accept: 'application/rdap+json, application/json' },
    });
    // Drained either way, so the connection is not left hanging.
    await res.arrayBuffer().catch(() => {});
    if (res.status === 404) return true;
    if (res.ok) return false;
    return null;
  } catch {
    return null;
  }
}

/// For tests: forget the cached bootstrap.
export function resetRdapCache() {
  bootstrap = null;
  loading = null;
}
