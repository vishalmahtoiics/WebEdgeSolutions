import { hostingerAdapter } from './hostinger.js';

// Registry of supported hosting providers. To add a provider later, write an
// adapter exposing the same shape and register it here — nothing else in the
// application needs to change.
const adapters = new Map([[hostingerAdapter.key, hostingerAdapter]]);

export function getAdapter(key) {
  return adapters.get(key) || null;
}

export function listAdapters() {
  return [...adapters.values()].map((a) => ({
    key: a.key,
    label: a.label,
    defaultDocsUrl: a.defaultDocsUrl,
    tokenLabel: a.tokenLabel,
    tokenHelp: a.tokenHelp,
    capabilities: a.capabilities,
  }));
}

/// Calls an optional adapter method. Returns `{ supported:false }` instead of
/// throwing when a provider does not implement a feature, so one missing
/// capability never breaks a page.
export async function tryCapability(adapter, method, ...args) {
  if (typeof adapter?.[method] !== 'function') {
    return { supported: false, data: null, error: null };
  }
  try {
    return { supported: true, data: await adapter[method](...args), error: null };
  } catch (err) {
    return { supported: true, data: null, error: err.message || 'Provider request failed.' };
  }
}
