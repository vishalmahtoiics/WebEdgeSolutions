// Time-based one-time passwords, RFC 6238.
//
// Written here rather than pulled in, because the whole algorithm is forty
// lines of HMAC and a dependency that sits in the sign-in path is a dependency
// that can break the sign-in path. It interoperates with Google Authenticator,
// Authy, 1Password and Microsoft Authenticator, which all implement the same
// spec with the same defaults.
//
// The defaults are the spec's, and they are the defaults because every
// authenticator app assumes them: SHA-1, six digits, thirty seconds. SHA-1 is
// not a weakness here — it is used inside HMAC, where the collision attacks
// that retired it for signatures do not apply, and a code is dead in thirty
// seconds regardless.

import crypto from 'node:crypto';

const DIGITS = 6;
export const STEP_SECONDS = 30;

/// How many steps either side of now are accepted. One means a code stays
/// valid for about ninety seconds in total, which covers a phone clock that
/// has drifted and a person typing slowly. More than one starts to widen the
/// window an attacker has to work in.
const DRIFT_STEPS = 1;

// RFC 4648 base32, which is what the otpauth:// URI carries.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/// A new shared secret, base32, 160 bits.
///
/// Twenty bytes is what the spec recommends for SHA-1 and what every app
/// expects; a longer secret is accepted by some and silently truncated by
/// others, which is a bad way to find out.
export function generateSecret(bytes = 20) {
  return encodeBase32(crypto.randomBytes(bytes));
}

export function encodeBase32(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/// Tolerant of how people actually paste a secret: spaces, lower case, and the
/// `=` padding some sites add are all accepted.
export function decodeBase32(secret) {
  const clean = String(secret || '').toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  if (!clean || /[^A-Z2-7]/.test(clean)) throw new Error('That is not a valid base32 secret.');

  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
    value = (value << 5) | ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/// The step number a moment falls in. Exported because the replay guard stores
/// it: a code is valid for its whole window, so without remembering the last
/// step used, anyone who saw the six digits could use them again.
export const stepFor = (at = Date.now()) => Math.floor(at / 1000 / STEP_SECONDS);

/// The six digits for a given step.
export function codeFor(secret, step) {
  const counter = Buffer.alloc(8);
  // The counter is eight bytes big-endian. Written as two 32-bit halves
  // because writeBigUInt64BE would need the step as a BigInt and this is
  // plainly the same number.
  counter.writeUInt32BE(Math.floor(step / 2 ** 32), 0);
  counter.writeUInt32BE(step >>> 0, 4);

  const hmac = crypto.createHmac('sha1', decodeBase32(secret)).update(counter).digest();

  // Dynamic truncation, RFC 4226 §5.4: the low nibble of the last byte picks
  // where to read four bytes from, and the top bit is masked off so the result
  // is positive on every platform.
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3];

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/// Checks a code and says which step it matched, or null.
///
/// The step is returned rather than a bare true so the caller can refuse a
/// step it has already accepted. Comparison is constant-time: a timing
/// difference here would leak the code digit by digit.
export function verify(secret, token, { at = Date.now(), afterStep = null } = {}) {
  const entered = String(token || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(entered)) return null;

  const current = stepFor(at);
  for (let offset = -DRIFT_STEPS; offset <= DRIFT_STEPS; offset += 1) {
    const step = current + offset;
    // Already used. A code is good for its whole window, and that window must
    // only be spent once.
    if (afterStep !== null && step <= Number(afterStep)) continue;

    const expected = codeFor(secret, step);
    const a = Buffer.from(expected);
    const b = Buffer.from(entered);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return step;
  }
  return null;
}

/// The otpauth:// URI an authenticator app scans.
///
/// The label carries both the issuer and the account, which is what makes the
/// entry read "Hosting Portal (you@example.com)" rather than just an address
/// in a list of six identical ones.
export function otpauthUrl({ secret, account, issuer = 'Hosting Portal' }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params}`;
}

// ---------------------------------------------------------------------------
// Recovery codes
// ---------------------------------------------------------------------------

/// The alphabet recovery codes are printed in.
///
/// Both halves of every confusable pair are gone — no O and no 0, no I, no 1
/// and no L, no S and no 5 — because these are read off paper and typed by
/// somebody who has already lost their phone and is not in the mood. Removing
/// only one of a pair does not help: it is the resemblance that causes the
/// mistake, not which character you kept.
const CODE_ALPHABET = '234679ABCDEFGHJKMNPQRTUVWXYZ';

/// Ten codes, each ten characters in two groups. Each is worth about 47 bits,
/// which is far beyond guessing at the rate sign-in allows.
export function generateRecoveryCodes(count = 10) {
  const codes = [];
  for (let i = 0; i < count; i += 1) {
    let text = '';
    for (let j = 0; j < 10; j += 1) {
      text += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    }
    codes.push(`${text.slice(0, 5)}-${text.slice(5)}`);
  }
  return codes;
}

/// Codes are stored hashed. SHA-256 rather than bcrypt on purpose: these are
/// long random strings, not chosen passwords, so there is no dictionary to
/// slow an attacker down against — and sign-in has to try a submitted code
/// against every unused one, which bcrypt would make slow enough to notice.
export const hashRecoveryCode = (code) =>
  crypto.createHash('sha256').update(normaliseRecoveryCode(code)).digest('hex');

/// What the owner typed, reduced to what was issued. Lower case, spaces and
/// the dash are all forgiven.
export const normaliseRecoveryCode = (code) =>
  String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/// Enough to recognise a code in a list, never enough to use it.
export const recoveryHint = (code) => normaliseRecoveryCode(code).slice(0, 4);
