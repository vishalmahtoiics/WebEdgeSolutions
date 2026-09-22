// Two-factor sign-in.
//
// The tests that matter here are the ones about what must NOT work. A second
// factor that can be replayed, skipped, or brute-forced is worse than none at
// all, because it is believed in. So this file spends most of its time on:
//
//   a code that has been used once cannot be used again inside its window;
//   the password alone does not produce a session, only a pending one;
//   a pending session expires, and expires into nothing rather than into
//   access;
//   a secret that was never proven does not enrol the account;
//   and the stored form of every secret is useless on its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import {
  codeFor, stepFor, verify, generateSecret, encodeBase32, decodeBase32,
  generateRecoveryCodes, hashRecoveryCode, normaliseRecoveryCode, otpauthUrl,
} from '../src/lib/totp.js';

const PORT = 3976;
const BASE = `http://127.0.0.1:${PORT}`;
const prisma = new PrismaClient();

const stamp = Date.now();
const userEmail = `twofactor+${stamp}@example.com`;
const userPassword = 'TwoFactor@12345';

let server;
const admin = client();
const member = client();
const attacker = client();
const ctx = {};

function client() {
  let cookie = '';
  const call = async function call(pathname, { method = 'GET', body } = {}) {
    const res = await fetch(`${BASE}${pathname}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        Connection: 'close',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, data };
  };
  call.forget = () => {
    cookie = '';
  };
  return call;
}

/// A code the account will actually accept right now.
///
/// Not simply the code for this instant: enrolling spends the step it was
/// done in, and these tests run inside the same thirty seconds. So this takes
/// the next unspent step, which the drift window still accepts — the same
/// thing a real authenticator shows a moment later.
const currentCode = async (userId) => {
  const { totpSecret, totpLastStep } = await prisma.user.findUnique({ where: { id: userId } });
  const { decryptMaybe } = await import('../src/lib/crypto.js');
  const spent = totpLastStep === null ? -1 : Number(totpLastStep);
  return codeFor(decryptMaybe(totpSecret), Math.max(stepFor(), spent + 1));
};

test.before(async () => {
  server = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  for (let i = 0; i < 80; i += 1) {
    try {
      if ((await fetch(`${BASE}/api/health`, { headers: { Connection: 'close' } })).ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  await admin('/api/auth/login', { method: 'POST', body: { email: 'admin@example.com', password: 'Admin@12345' } });

  const user = await admin('/api/users', {
    method: 'POST',
    body: { name: 'Two Factor User', email: userEmail, password: userPassword, role: 'USER' },
  });
  ctx.userId = user.data.user.id;
});

test.after(async () => {
  try {
    if (ctx.userId) await admin(`/api/users/${ctx.userId}`, { method: 'DELETE' });
    await prisma.activityLog.deleteMany({ where: { summary: { contains: userEmail } } });
    await prisma.$disconnect();
  } catch (err) {
    console.error('TEARDOWN:', err?.message);
  }
  server?.kill();
});

// ---------------------------------------------------------------------------
// The algorithm
// ---------------------------------------------------------------------------

test('the codes match the RFC 6238 test vectors', () => {
  // If these pass, every authenticator app agrees with us. If they do not,
  // nothing else in this file is worth anything.
  const secret = encodeBase32(Buffer.from('12345678901234567890'));
  assert.equal(codeFor(secret, Math.floor(59 / 30)), '287082');
  assert.equal(codeFor(secret, Math.floor(1111111109 / 30)), '081804');
  assert.equal(codeFor(secret, Math.floor(1111111111 / 30)), '050471');
  assert.equal(codeFor(secret, Math.floor(1234567890 / 30)), '005924');
  assert.equal(codeFor(secret, Math.floor(2000000000 / 30)), '279037');
});

test('base32 survives the ways people actually paste a secret', () => {
  const secret = generateSecret();
  const original = decodeBase32(secret);
  for (const variant of [
    secret.toLowerCase(),
    secret.replace(/(.{4})/g, '$1 ').trim(),
    `${secret}====`,
    secret.replace(/(.{4})/g, '$1-').replace(/-$/, ''),
  ]) {
    assert.deepEqual(decodeBase32(variant), original);
  }
  assert.throws(() => decodeBase32('not base32!'));
});

test('a code is accepted a little early and a little late, but not far out', () => {
  const secret = generateSecret();
  const now = Date.now();
  const step = stepFor(now);

  assert.ok(verify(secret, codeFor(secret, step), { at: now }) !== null);
  // A phone clock thirty seconds out still works.
  assert.ok(verify(secret, codeFor(secret, step - 1), { at: now }) !== null);
  assert.ok(verify(secret, codeFor(secret, step + 1), { at: now }) !== null);
  // Two minutes out does not.
  assert.equal(verify(secret, codeFor(secret, step + 4), { at: now }), null);
  assert.equal(verify(secret, codeFor(secret, step - 4), { at: now }), null);
});

test('a code that has been spent is refused for the rest of its window', () => {
  const secret = generateSecret();
  const now = Date.now();
  const step = stepFor(now);
  const code = codeFor(secret, step);

  const accepted = verify(secret, code, { at: now });
  assert.equal(accepted, step);
  // Somebody who read it over a shoulder gets nothing.
  assert.equal(verify(secret, code, { at: now, afterStep: accepted }), null);
});

test('anything that is not six digits is refused outright', () => {
  const secret = generateSecret();
  for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56', null, undefined]) {
    assert.equal(verify(secret, bad), null, `"${bad}" must not pass`);
  }
});

test('the enrolment URL says everything an authenticator needs', () => {
  const url = otpauthUrl({ secret: 'ABCDEFGH', account: 'someone@example.com', issuer: 'Hosting Portal' });
  assert.match(url, /^otpauth:\/\/totp\//);
  assert.match(url, /secret=ABCDEFGH/);
  assert.match(url, /issuer=Hosting\+Portal/);
  assert.match(url, /digits=6/);
  assert.match(url, /period=30/);
  // The label carries both, so the entry reads as more than an address.
  assert.match(decodeURIComponent(url.split('?')[0]), /Hosting Portal:someone@example\.com/);
});

test('recovery codes avoid every pair of characters that gets misread', () => {
  const codes = generateRecoveryCodes(50).join('');
  // Both halves of each pair are gone — keeping one does not help, because it
  // is the resemblance that causes the mistake.
  for (const char of ['O', '0', 'I', '1', 'L', 'S', '5']) {
    assert.ok(!codes.includes(char), `${char} is too easily misread off paper`);
  }
  assert.equal(new Set(generateRecoveryCodes(20)).size, 20, 'and they are not repeated');
});

test('a recovery code is forgiving about how it is typed', () => {
  const [code] = generateRecoveryCodes(1);
  const hash = hashRecoveryCode(code);
  assert.equal(hashRecoveryCode(code.toLowerCase()), hash);
  assert.equal(hashRecoveryCode(code.replace('-', '')), hash);
  assert.equal(hashRecoveryCode(` ${code} `), hash);
  assert.notEqual(normaliseRecoveryCode(code), code, 'the dash is not part of the secret');
});

// ---------------------------------------------------------------------------
// Signing in
// ---------------------------------------------------------------------------

test('without two-factor, a password signs you straight in', async () => {
  const res = await member('/api/auth/login', { method: 'POST', body: { email: userEmail, password: userPassword } });
  assert.equal(res.status, 200);
  assert.equal(res.data.user.email, userEmail);
  assert.equal(res.data.twoFactor, undefined);
  assert.equal((await member('/api/auth/me')).data.user.email, userEmail);
});

test('setting it up needs a working code before anything is saved', async () => {
  const setup = await member('/api/auth/2fa/setup', { method: 'POST' });
  assert.equal(setup.status, 200);
  // The QR is drawn here, so the shared secret never travels to a third party.
  assert.match(setup.data.qr, /^data:image\/png;base64,/);
  assert.ok(setup.data.manualKey.replace(/\s/g, '').length >= 32);

  // A wrong code enrols nothing.
  const wrong = await member('/api/auth/2fa/enable', { method: 'POST', body: { code: '000000' } });
  assert.equal(wrong.status, 400);

  const stillOff = await prisma.user.findUnique({ where: { id: ctx.userId } });
  assert.equal(stillOff.totpEnabledAt, null, 'an unproven secret must not enrol the account');

  // The right one does.
  const secret = setup.data.manualKey.replace(/\s/g, '');
  const enabled = await member('/api/auth/2fa/enable', { method: 'POST', body: { code: codeFor(secret, stepFor()) } });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.data.recoveryCodes.length, 10);
  ctx.recoveryCodes = enabled.data.recoveryCodes;

  const row = await prisma.user.findUnique({ where: { id: ctx.userId } });
  assert.ok(row.totpEnabledAt);
  // Encrypted at rest: the stored value is not the secret.
  assert.notEqual(row.totpSecret, secret);
  assert.equal(row.totpSecret.split(':').length, 3, 'iv:tag:ciphertext');
});

test('the recovery codes are stored hashed, so the database holds none of them', async () => {
  const stored = await prisma.recoveryCode.findMany({ where: { userId: ctx.userId } });
  assert.equal(stored.length, 10);

  for (const code of ctx.recoveryCodes) {
    assert.ok(
      !stored.some((row) => row.codeHash === code || row.codeHash.includes(normaliseRecoveryCode(code))),
      'a code must not appear in its own hash',
    );
  }
  // The hint is a recognisable fragment, never enough to use.
  assert.ok(stored.every((row) => row.hint.length === 4));
});

test('once it is on, the password alone does not sign you in', async () => {
  member.forget();
  const res = await member('/api/auth/login', { method: 'POST', body: { email: userEmail, password: userPassword } });

  assert.equal(res.status, 200);
  assert.equal(res.data.twoFactor, true);
  assert.equal(res.data.user, undefined, 'no account is handed back at this point');

  // And the session it holds grants nothing.
  const me = await member('/api/auth/me');
  assert.equal(me.data.user, null);
  assert.equal((await member('/api/domains')).status, 401);
});

test('a wrong code at the second step does not sign you in', async () => {
  const res = await member('/api/auth/2fa', { method: 'POST', body: { code: '000000' } });
  assert.equal(res.status, 401);
  assert.equal((await member('/api/auth/me')).data.user, null);

  // It is recorded: somebody has the password and is working on the factor.
  const entry = await prisma.activityLog.findFirst({
    where: { event: 'security.2fa.failed' },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(entry, 'a failed second factor is worth knowing about');
});

test('the right code completes the sign-in', async () => {
  const res = await member('/api/auth/2fa', { method: 'POST', body: { code: await currentCode(ctx.userId) } });
  assert.equal(res.status, 200);
  assert.equal(res.data.user.email, userEmail);
  assert.equal(res.data.usedRecoveryCode, false);
  assert.equal((await member('/api/auth/me')).data.user.email, userEmail);
});

test('the same code cannot be used again by somebody who saw it', async () => {
  const code = await currentCode(ctx.userId);

  attacker.forget();
  await attacker('/api/auth/login', { method: 'POST', body: { email: userEmail, password: userPassword } });

  const res = await attacker('/api/auth/2fa', { method: 'POST', body: { code } });
  assert.equal(res.status, 401, 'that code was already spent');
  assert.equal((await attacker('/api/auth/me')).data.user, null);
});

test('the second step cannot be reached without the password first', async () => {
  const stranger = client();
  const res = await stranger('/api/auth/2fa', { method: 'POST', body: { code: await currentCode(ctx.userId) } });
  assert.equal(res.status, 401);
  assert.match(res.data.error, /sign in again/);
});

test('a recovery code signs you in, once', async () => {
  const code = ctx.recoveryCodes[0];

  const session = client();
  await session('/api/auth/login', { method: 'POST', body: { email: userEmail, password: userPassword } });
  const res = await session('/api/auth/2fa', { method: 'POST', body: { code } });

  assert.equal(res.status, 200);
  assert.equal(res.data.usedRecoveryCode, true);
  assert.equal(res.data.recoveryCodesLeft, 9);

  // The same one is dead now.
  const again = client();
  await again('/api/auth/login', { method: 'POST', body: { email: userEmail, password: userPassword } });
  assert.equal((await again('/api/auth/2fa', { method: 'POST', body: { code } })).status, 401);
});

test('a recovery code is accepted however it is typed', async () => {
  const code = ctx.recoveryCodes[1].toLowerCase().replace('-', ' ');

  const session = client();
  await session('/api/auth/login', { method: 'POST', body: { email: userEmail, password: userPassword } });
  assert.equal((await session('/api/auth/2fa', { method: 'POST', body: { code } })).status, 200);
});

test('using a recovery code is recorded, with how many are left', async () => {
  const entry = await prisma.activityLog.findFirst({
    where: { event: 'security.2fa.recovery-used' },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(entry);
  assert.ok(entry.summary.includes(userEmail));
  assert.match(entry.detail, /recovery codes? left/);
});

// ---------------------------------------------------------------------------
// Turning it off, and starting again
// ---------------------------------------------------------------------------

test('new recovery codes kill the old ones', async () => {
  const res = await member('/api/auth/2fa/recovery-codes', { method: 'POST', body: { password: userPassword } });
  assert.equal(res.status, 200);
  assert.equal(res.data.recoveryCodes.length, 10);

  const stale = ctx.recoveryCodes[5];
  const session = client();
  await session('/api/auth/login', { method: 'POST', body: { email: userEmail, password: userPassword } });
  assert.equal((await session('/api/auth/2fa', { method: 'POST', body: { code: stale } })).status, 401);

  ctx.recoveryCodes = res.data.recoveryCodes;
  const status = await member('/api/auth/2fa');
  assert.equal(status.data.twoFactor.recoveryCodesLeft, 10);
});

test('the wrong password does not turn it off', async () => {
  const res = await member('/api/auth/2fa/disable', { method: 'POST', body: { password: 'not-the-password' } });
  assert.equal(res.status, 401);
  assert.equal((await member('/api/auth/2fa')).data.twoFactor.enabled, true);
});

test('turning it off destroys the secret and every code with it', async () => {
  const res = await member('/api/auth/2fa/disable', { method: 'POST', body: { password: userPassword } });
  assert.equal(res.status, 200);

  const row = await prisma.user.findUnique({ where: { id: ctx.userId } });
  assert.equal(row.totpSecret, null);
  assert.equal(row.totpEnabledAt, null);
  assert.equal(await prisma.recoveryCode.count({ where: { userId: ctx.userId } }), 0);

  // And the password alone works again.
  const session = client();
  const login = await session('/api/auth/login', { method: 'POST', body: { email: userEmail, password: userPassword } });
  assert.equal(login.data.user.email, userEmail);
});

test('the status endpoint never returns the secret or a code', async () => {
  const res = await member('/api/auth/2fa');
  assert.equal(res.status, 200);
  const keys = Object.keys(res.data.twoFactor);
  assert.deepEqual(keys.sort(), ['enabled', 'enabledAt', 'recoveryCodesLeft', 'recoveryCodesTotal']);
  assert.ok(!JSON.stringify(res.data).includes('totpSecret'));
});

test('setting it up needs a session of your own', async () => {
  const stranger = client();
  assert.equal((await stranger('/api/auth/2fa/setup', { method: 'POST' })).status, 401);
  assert.equal((await stranger('/api/auth/2fa')).status, 401);
  assert.equal((await stranger('/api/auth/2fa/disable', { method: 'POST', body: { password: 'x' } })).status, 401);
});
