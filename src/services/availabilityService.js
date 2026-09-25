// Whether domain names are free, from whoever can actually say.
//
// The hosting provider is asked first: it is the one that would register the
// name, so its answer includes restrictions (premium, reserved) that a
// registry lookup does not. Whatever it cannot answer is then asked of the
// registry itself over RDAP. Anything neither can answer stays unknown.
//
// Answers are kept for a few minutes. The public site's search is open to
// anyone, and a name does not change hands between one keystroke and the
// next; asking the provider again for every search would spend its rate
// limit on repeats.

import { prisma } from '../db.js';
import { getAdapter } from '../providers/index.js';
import { loadProviderWithToken } from './providerService.js';
import { rdapAvailability } from '../lib/rdap.js';

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 5000;
const cache = new Map(); // domain → { at, available, restriction }

function remember(domain, answer) {
  // Only definite answers. An "unknown" cached for ten minutes would hide a
  // provider that has just come back.
  if (answer.available === null || answer.available === undefined) return;
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(domain, { at: Date.now(), ...answer });
}

function recalled(domain) {
  const hit = cache.get(domain);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(domain);
    return null;
  }
  return { available: hit.available, restriction: hit.restriction ?? null };
}

/// Checks `label` under each ending in `tlds`.
///
/// Returns a Map of full domain → { available: true | false | null,
/// restriction }. Never throws for an unreachable provider or registry; the
/// affected names are simply unknown.
export async function checkAvailability(label, tlds) {
  const results = new Map();
  const pending = [];

  for (const tld of tlds) {
    const domain = `${label}.${tld}`;
    const hit = recalled(domain);
    if (hit) results.set(domain, hit);
    else pending.push(tld);
  }

  // 1. The provider, for everything not already known.
  if (pending.length) {
    const providers = await prisma.provider.findMany({ where: { isActive: true }, orderBy: { createdAt: 'asc' } });
    for (const provider of providers) {
      const adapter = getAdapter(provider.adapter);
      if (!adapter?.capabilities?.domainSearch) continue;
      try {
        const { token } = await loadProviderWithToken(provider.id);
        const rows = await adapter.checkDomainAvailability(token, { name: label, tlds: pending });
        for (const row of rows) {
          if (!row?.domain || !pending.some((t) => row.domain === `${label}.${t}`)) continue;
          const answer = { available: row.available ?? null, restriction: row.restriction || null };
          results.set(row.domain, answer);
          remember(row.domain, answer);
        }
        break;
      } catch {
        // The next provider, then the registry.
      }
    }
  }

  // 2. The registry, for whatever the provider left unanswered.
  const unanswered = pending
    .map((tld) => `${label}.${tld}`)
    .filter((domain) => results.get(domain)?.available == null);
  await Promise.all(
    unanswered.map(async (domain) => {
      const available = await rdapAvailability(domain);
      const answer = { available, restriction: results.get(domain)?.restriction || null };
      results.set(domain, answer);
      remember(domain, answer);
    }),
  );

  for (const tld of tlds) {
    const domain = `${label}.${tld}`;
    if (!results.has(domain)) results.set(domain, { available: null, restriction: null });
  }
  return results;
}

/// For tests: forget remembered answers.
export function resetAvailabilityCache() {
  cache.clear();
}
