// Guards around deploying this app to a container platform (Coolify, Railway,
// Render): the entrypoint must refuse to start on a misconfiguration rather
// than boot into a broken state, and a Secure-cookie mismatch must be an
// explicit error instead of a sign-in that silently does nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = process.env.DATABASE_URL || 'postgresql://hostportal:hostportal@127.0.0.1:5432/hostportal?schema=public';
const hex64 = 'a'.repeat(64);

/// Runs the production entrypoint and returns its combined output. Used for the
/// cases where it is expected to exit before ever listening.
function startWith(env, timeoutMs = 15000) {
  const result = spawnSync(process.execPath, ['scripts/start.js'], {
    cwd: root,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, ...env },
  });
  return `${result.stdout || ''}${result.stderr || ''}`;
}

test('entrypoint refuses to start without DATABASE_URL', () => {
  const out = startWith({ DATABASE_URL: '', SESSION_SECRET: 'x', ENCRYPTION_KEY: hex64 });
  assert.match(out, /DATABASE_URL is not set/);
});

test('entrypoint refuses to start without SESSION_SECRET', () => {
  const out = startWith({ DATABASE_URL: DB, SESSION_SECRET: '', ENCRYPTION_KEY: hex64 });
  assert.match(out, /SESSION_SECRET is not set/);
});

test('entrypoint rejects an ENCRYPTION_KEY that is not 64 hex characters', () => {
  const out = startWith({ DATABASE_URL: DB, SESSION_SECRET: 'x', ENCRYPTION_KEY: 'too-short' });
  assert.match(out, /64 hexadecimal characters/);
  assert.match(out, /openssl rand -hex 32/, 'the message should say how to generate one');
});

test('a rejected ENCRYPTION_KEY reports the length it actually received', () => {
  // In a restart loop the same message repeats whether the variable is stale or
  // simply wrong, so the observed length is the only way to tell them apart.
  const out = startWith({ DATABASE_URL: DB, SESSION_SECRET: 'x', ENCRYPTION_KEY: 'a'.repeat(61) });
  assert.match(out, /received 61 characters/);
  assert.match(out, /3 too few/);
  assert.match(out, /Redeploy \(not Restart\)/, 'should point at the stale-variable case');
  assert.doesNotMatch(out, /a{20}/, 'the key itself must never be printed');
});

test('a 64-character key containing non-hex characters says so', () => {
  const out = startWith({ DATABASE_URL: DB, SESSION_SECRET: 'x', ENCRYPTION_KEY: 'z'.repeat(64) });
  assert.match(out, /received 64 characters/);
  assert.match(out, /64 of them are not hexadecimal/);
});

test('a valid key survives a trailing newline and wrapping quotes', () => {
  const key = 'a'.repeat(64);
  for (const [label, value] of [
    ['trailing newline', `${key}\n`],
    ['leading and trailing spaces', `  ${key}  `],
    ['wrapping double quotes', `"${key}"`],
    ["wrapping single quotes", `'${key}'`],
  ]) {
    const out = startWith({ DATABASE_URL: DB, SESSION_SECRET: 'x', ENCRYPTION_KEY: value }, 9000);
    assert.doesNotMatch(out, /ENCRYPTION_KEY is not valid/, `${label} should be tolerated`);
  }
});

test('an unreachable database is diagnosed on the first attempt, then retried', () => {
  // Port 1 is closed. A container platform restarts a process that exits, so
  // the reason must appear immediately — not only after the retries run out,
  // by which point the log is scrolling past in a restart loop.
  const out = startWith(
    { DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/x', SESSION_SECRET: 'x', ENCRYPTION_KEY: hex64 },
    9000,
  );
  assert.match(out, /Cannot reach the database at 127\.0\.0\.1:1/);
  // 127.0.0.1 inside a container is the container itself, so say so explicitly.
  assert.match(out, /means the\s+container itself/);
  assert.doesNotMatch(out, /Gave up after/, 'it should still be retrying, not given up');
});

test('a non-local database host gets connectivity advice instead', () => {
  const out = startWith(
    { DATABASE_URL: 'postgresql://u:p@db.internal:1/x', SESSION_SECRET: 'x', ENCRYPTION_KEY: hex64 },
    9000,
  );
  assert.match(out, /Cannot reach the database at db\.internal:1/);
  assert.match(out, /same Docker network/);
});

test('a Secure-cookie mismatch is reported instead of failing silently', async (t) => {
  const port = 3987;
  const base = `http://127.0.0.1:${port}`;

  const server = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    stdio: 'ignore',
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: DB,
      SECURE_COOKIES: 'true',
      SESSION_SECRET: 'deployment-test-secret',
      ENCRYPTION_KEY: hex64,
    },
  });
  t.after(() => server.kill());

  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  const body = JSON.stringify({ email: 'admin@example.com', password: 'Admin@12345' });
  const headers = { 'Content-Type': 'application/json' };

  // Over plain HTTP the cookie would be discarded, so this must be an error.
  const overHttp = await fetch(`${base}/api/auth/login`, { method: 'POST', headers, body });
  assert.equal(overHttp.status, 500);
  assert.match((await overHttp.json()).error, /SECURE_COOKIES/);
  assert.equal(overHttp.headers.get('set-cookie'), null);

  // Behind a TLS-terminating proxy the same request succeeds and sets a
  // Secure cookie, because the app trusts the first proxy hop.
  const overHttps = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { ...headers, 'X-Forwarded-Proto': 'https' },
    body,
  });
  assert.equal(overHttps.status, 200);
  assert.match(overHttps.headers.get('set-cookie') || '', /Secure/);
});
