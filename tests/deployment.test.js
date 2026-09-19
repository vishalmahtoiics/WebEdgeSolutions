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

test('entrypoint waits for an unreachable database instead of crashing', () => {
  // Port 1 is closed; the script should report waiting rather than exit at once.
  const out = startWith(
    { DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/x', SESSION_SECRET: 'x', ENCRYPTION_KEY: hex64 },
    9000,
  );
  assert.match(out, /waiting for database at 127\.0\.0\.1:1/);
  assert.doesNotMatch(out, /Could not reach the database/, 'it should still be retrying, not given up');
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
