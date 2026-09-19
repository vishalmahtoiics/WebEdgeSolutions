#!/usr/bin/env node
// Production entrypoint.
//
// Platforms like Coolify, Railway and Render build with `npm ci` and then run
// `npm start` — there is no separate release step, so migrations have to happen
// here or the app boots against an empty database and every query fails.
//
// This script waits for the database to accept connections (the database
// container often starts after the app), applies migrations, ensures a Super
// Admin exists, and only then starts the server. All three steps are safe to
// repeat on every boot.
//
// Set SKIP_MIGRATIONS=true to bypass the migrate/seed steps, e.g. when running
// several replicas and migrating separately.

import { spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(message, detail) {
  console.error(`\n  ✕ ${message}\n`);
  if (detail) console.error(`  ${detail}\n`);
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  fail('DATABASE_URL is not set.', 'Add it to your environment variables and redeploy.');
}

for (const name of ['SESSION_SECRET', 'ENCRYPTION_KEY']) {
  if (!process.env[name]) {
    fail(`${name} is not set.`, 'Generate one with: openssl rand -hex 32');
  }
}

if (!/^[0-9a-fA-F]{64}$/.test(process.env.ENCRYPTION_KEY)) {
  fail(
    'ENCRYPTION_KEY must be exactly 64 hexadecimal characters (32 bytes).',
    'Generate one with: openssl rand -hex 32',
  );
}

/// Resolves the database host and port so we can wait for it to come up.
function parseTarget(url) {
  try {
    const parsed = new URL(url);
    return { host: parsed.hostname, port: Number(parsed.port) || 5432 };
  } catch {
    return null;
  }
}

const tryConnect = (host, port, timeout = 3000) =>
  new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });

async function waitForDatabase() {
  const target = parseTarget(databaseUrl);
  if (!target) {
    fail('DATABASE_URL is not a valid connection string.', 'Expected: postgresql://user:password@host:5432/database');
  }

  // A container platform restarts a process that exits, so an unreachable
  // database turns into a restart loop. Print the diagnosis on the FIRST failed
  // attempt rather than only at the end, so the reason is visible in the log
  // even if the container is cycling.
  const localHosts = ['localhost', '127.0.0.1', '::1', '0.0.0.0'];
  const looksLocal = localHosts.includes(target.host);

  const diagnose = () => {
    console.error(`\n  ✕ Cannot reach the database at ${target.host}:${target.port}\n`);
    if (looksLocal) {
      console.error(
        `  DATABASE_URL points at "${target.host}", which inside a container means the\n` +
          '  container itself — not your database. Use the database\'s service name\n' +
          '  (in Coolify: the database resource\'s internal hostname) as the host.\n',
      );
    } else {
      console.error(
        '  Check that:\n' +
          `    • the host "${target.host}" is correct and reachable from this container\n` +
          `    • the database is running and listening on port ${target.port}\n` +
          '    • both are attached to the same Docker network\n',
      );
    }
    console.error(`  Current DATABASE_URL host:port → ${target.host}:${target.port}\n`);
  };

  const attempts = 60;
  for (let i = 1; i <= attempts; i += 1) {
    if (await tryConnect(target.host, target.port)) {
      console.log(`  ✓ Database reachable at ${target.host}:${target.port}`);
      return;
    }
    if (i === 1) diagnose();
    if (i % 10 === 0) console.error(`  … still retrying (${i}/${attempts})`);
    await new Promise((r) => setTimeout(r, 2000));
  }

  diagnose();
  fail(`Gave up after ${attempts} attempts (${attempts * 2} seconds).`);
}

/// Runs a local binary from node_modules/.bin, which is on PATH for npm scripts
/// but not necessarily for a bare `node` invocation.
function run(label, command, args) {
  console.log(`\n  → ${label}`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: process.env,
  });
  if (result.error || result.status !== 0) {
    fail(`${label} failed.`, result.error?.message);
  }
}

const prismaBin = path.join(root, 'node_modules', '.bin', 'prisma');

async function main() {
  console.log('\n  Starting hosting portal…\n');
  await waitForDatabase();

  if (String(process.env.SKIP_MIGRATIONS).toLowerCase() === 'true') {
    console.log('\n  … SKIP_MIGRATIONS=true — not applying migrations or seeding.');
  } else {
    run('Applying database migrations', prismaBin, ['migrate', 'deploy']);
    run('Ensuring a Super Admin exists', process.execPath, ['prisma/seed.js']);
  }

  console.log('');
  await import('../src/server.js');
}

main().catch((err) => fail('Startup failed.', err?.stack || String(err)));
