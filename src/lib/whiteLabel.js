// Keeping the hosting provider's name away from customers.
//
// A customer sees their service as ours. Where the provider's name turns up
// in something they would read — a DNS record pointing at the provider's
// mail servers, a registrar field, an error the provider's API wrote — it is
// shown as ours instead. Only on the way out, and only to people who are not
// Super Admin: what is stored, and what is sent to the provider, stays exactly
// as it is. A record that says mx1.hostinger.com still says that in the zone;
// a customer just reads mx1.webedgesolutions.com.
//
// Because the display differs from the truth, anything a customer sends back
// has to be translated back before it is written — see `unmaskAgainst`.

const NAME = process.env.WHITE_LABEL_NAME || 'WebEdge Solutions';
const HOST = (process.env.WHITE_LABEL_HOST || 'webedgesolutions').toLowerCase();
const SHORT = (process.env.WHITE_LABEL_SHORT || 'webds').toLowerCase();

const PROVIDER = /hostinger/gi;
const PROVIDER_SHORT = /hstgr/gi;
const MENTIONS = /hostinger|hstgr/i;

/// Whether the word is part of a hostname or address rather than prose:
/// "mx1.hostinger.com", "abuse@hostinger.com", "hostinger-mail". A joining
/// character only counts with a letter or digit on its far side, so the full
/// stop ending "registered at Hostinger." is still the end of a sentence.
const JOINED_AFTER = /^[.@\-_/:][A-Za-z0-9]/;
const JOINED_BEFORE = /[A-Za-z0-9_][.@\-_/:]$/;

/// A provider's error code on the front of a message, like "[Domains:2006]".
/// Meaningless to a customer, and it says whose API answered.
const PROVIDER_CODE = /\[[A-Za-z]+:\d+\]\s*/g;

/// One piece of text, as a customer should read it.
export function maskText(text) {
  if (typeof text !== 'string' || !MENTIONS.test(text)) return text;
  return text
    .replace(PROVIDER, (match, offset, whole) => {
      const before = whole.slice(Math.max(0, offset - 2), offset);
      const after = whole.slice(offset + match.length, offset + match.length + 2);
      // In a hostname it must stay a hostname: no spaces, no capitals.
      if (JOINED_BEFORE.test(before) || JOINED_AFTER.test(after) || match === match.toLowerCase()) {
        return HOST;
      }
      return NAME;
    })
    .replace(PROVIDER_SHORT, SHORT);
}

/// An error message for a customer: masked, and without the provider's code.
export function maskError(message) {
  if (typeof message !== 'string') return message;
  return maskText(message.replace(PROVIDER_CODE, '')).trim();
}

/// Keys whose text is a message rather than data, so a provider's error
/// code on them is dropped as well.
const MESSAGE_KEYS = new Set(['error', 'message', 'problems', 'detail', 'summary']);

/// A whole response body, masked throughout. Only plain objects and arrays
/// are walked; anything else (a Date, a Buffer) goes out as it came.
export function maskDeep(value, key = null) {
  if (typeof value === 'string') return MESSAGE_KEYS.has(key) ? maskError(value) : maskText(value);
  if (Array.isArray(value)) return value.map((item) => maskDeep(item, key === 'problems' ? key : null));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskDeep(v, k);
    return out;
  }
  return value;
}

/// Every hostname-like word in `texts` that mentions the provider, keyed by
/// how a customer sees it: "mx1.webedgesolutions.com" → "mx1.hostinger.com".
function maskedTokens(texts) {
  const map = new Map();
  for (const text of texts) {
    if (typeof text !== 'string' || !MENTIONS.test(text)) continue;
    for (const token of text.match(/[A-Za-z0-9._@-]*(?:hostinger|hstgr)[A-Za-z0-9._@-]*/gi) || []) {
      const shown = maskText(token);
      if (shown !== token) map.set(shown, token);
    }
  }
  return map;
}

/// Translates what a customer typed back into the real values.
///
/// Only names the customer could have seen are translated: the masked form
/// of a provider hostname that actually appears in `knownTexts` (the domain's
/// existing records). So editing an SPF record that reads
/// "include:_spf.mail.webedgesolutions.com" writes back the real
/// "_spf.mail.hostinger.com", while a hostname of ours typed on purpose —
/// "www.webedgesolutions.in" — is left alone, because no provider record
/// shows it.
export function unmaskAgainst(text, knownTexts) {
  if (typeof text !== 'string') return text;
  const tokens = maskedTokens(knownTexts);
  if (!tokens.size) return text;
  // Longest first, so "mail.webedgesolutions.com" is not half-replaced by a
  // shorter token inside it.
  const shown = [...tokens.keys()].sort((a, b) => b.length - a.length);
  let out = text;
  for (const s of shown) out = out.split(s).join(tokens.get(s));
  return out;
}

/// Response paths that carry the customer's own data rather than anything
/// about the provider: their files, their database, their mail. Masking
/// those would change what they read — and a masked file saved back from the
/// editor would change the file itself.
const LEAVE_ALONE = [
  /^\/api\/domains\/[^/]+\/files(\/|$)/,
  /^\/api\/domains\/[^/]+\/db(\/|$)/,
  /^\/api\/domains\/[^/]+\/deployments(\/|$)/,
  /^\/api\/domains\/[^/]+\/emails\/[^/]+\/mail(\/|$)/,
  /^\/api\/webmail(\/|$)/,
  /^\/api\/store(\/|$)/,
];

/// Express middleware: everything a non-admin is sent goes through
/// `maskDeep`, except the customer-data paths above. Errors on those paths
/// are still masked, by the error handler.
export function whiteLabelResponses(isAdmin) {
  return (req, res, next) => {
    if (isAdmin(req.user)) return next();
    const path = (req.originalUrl || '').split('?')[0];
    if (LEAVE_ALONE.some((re) => re.test(path))) return next();

    const json = res.json.bind(res);
    res.json = (body) => json(maskDeep(body));
    next();
  };
}
