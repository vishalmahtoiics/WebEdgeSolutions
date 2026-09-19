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
import { cleanEnv } from '../src/lib/env.js';
import { serveDiagnostics } from './diagnostics.js';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/// Reports a problem that only the operator can fix. Exiting here would make
/// the platform restart the process forever and leave the proxy with nothing to
/// route to — a 404 with the real reason buried in container logs. Holding the
/// port and serving the explanation is far easier to act on.
function fail(message, detail, fix) {
  console.error(`\n  ✕ ${message}\n`);
  if (detail) console.error(`  ${detail}\n`);
  // The fix belongs in the log too, not only on the page — whoever is reading
  // container output should not have to open a browser to learn the remedy.
  if (fix) console.error(`${fix.split('\n').map((l) => `  ${l}`).join('\n')}\n`);
  serveDiagnostics([{ title: message, detail, fix }]);
  // Resolves never: the process stays alive serving the setup page.
  return new Promise(() => {});
}

// Normalise every value up front — a pasted secret often carries a trailing
// newline or wrapping quotes — so the rest of the process sees clean values.
for (const name of ['DATABASE_URL', 'SESSION_SECRET', 'ENCRYPTION_KEY', 'ADMIN_EMAIL', 'ADMIN_PASSWORD', 'ADMIN_NAME', 'PORT', 'SECURE_COOKIES']) {
  if (process.env[name] !== undefined) process.env[name] = cleanEnv(process.env[name]);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  await fail(
    'DATABASE_URL is not set.',
    'The portal needs a PostgreSQL connection string to store its data.',
    'DATABASE_URL=postgresql://user:password@host:5432/database',
  );
}

for (const name of ['SESSION_SECRET', 'ENCRYPTION_KEY']) {
  if (!process.env[name]) {
    await fail(`${name} is not set.`, 'This value is required.', `${name}=$(openssl rand -hex 32)`);
  }
}

// Say what actually arrived, never the value itself. Without the observed
// length there is no way to tell a stale variable from a mistyped one, which
// matters most in a restart loop where the same message repeats either way.
const key = process.env.ENCRYPTION_KEY;
if (!/^[0-9a-fA-F]{64}$/.test(key)) {
  const nonHex = [...key].filter((c) => !/[0-9a-fA-F]/.test(c)).length;

  let problem;
  if (key.length !== 64) {
    const diff = Math.abs(64 - key.length);
    problem =
      `received ${key.length} characters — ${diff} too ${key.length < 64 ? 'few' : 'many'}`;
  } else {
    problem = `received 64 characters, but ${nonHex} of them ${nonHex === 1 ? 'is' : 'are'} not hexadecimal`;
  }

  await fail(
    'ENCRYPTION_KEY is not valid.',
    `Expected exactly 64 hexadecimal characters (0-9, a-f), but ${problem}. ` +
      'If that is not the length you just saved, the container is still running the old ' +
      'value — save the variable and use Redeploy, not Restart.',
    'ENCRYPTION_KEY=' + '0123456789abcdef'.repeat(4) + '\n\nGenerate your own with:\n  openssl rand -hex 32',
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
    await fail(
      'DATABASE_URL is not a valid connection string.',
      'It could not be parsed as a URL.',
      'DATABASE_URL=postgresql://user:password@host:5432/database',
    );
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

  let setupPage = null;
  for (let attempt = 1; ; attempt += 1) {
    if (await tryConnect(target.host, target.port)) {
      console.log(`  ✓ Database reachable at ${target.host}:${target.port}`);
      // Free the port so the real server can take it.
      if (setupPage) await new Promise((r) => setupPage.close(r));
      return;
    }

    if (attempt === 1) {
      diagnose();
      setupPage = serveDiagnostics([
        {
          title: `Cannot reach the database at ${target.host}:${target.port}`,
          detail: looksLocal
            ? `DATABASE_URL points at "${target.host}", which inside a container means the container itself, not your database. Use the database's own service name as the host.`
            : `Check that the host is correct, that the database is running, and that both containers are on the same network. Still retrying — this page will disappear on its own if the database comes up.`,
          fix: 'DATABASE_URL=postgresql://user:password@<database-service-name>:5432/database',
        },
      ]);
    } else if (attempt % 15 === 0) {
      console.error(`  … still retrying (attempt ${attempt})`);
    }

    await new Promise((r) => setTimeout(r, 2000));
  }
}

/// Turns a Prisma failure into something an operator can act on. Prisma's own
/// message names the code but not the setting to change, and the raw output is
/// not safe to put on a page the whole internet can reach.
function explainPrismaFailure(output) {
  if (/P1000/.test(output)) {
    const user = output.match(/credentials for `([^`]+)`/)?.[1];
    return {
      title: 'The database rejected the username or password.',
      detail:
        (user ? `The database server refused the user "${user}". ` : '') +
        'Check the credentials in DATABASE_URL against the database itself — a typo in the ' +
        'username is easy to miss, and a rotated password has to be copied across.',
      fix: 'DATABASE_URL=postgresql://<user>:<password>@<host>:5432/<database>',
    };
  }
  if (/P1001|P1002/.test(output)) {
    return {
      title: 'The database stopped responding while migrating.',
      detail: 'It accepted a connection but then became unreachable. Check that it is running and healthy.',
    };
  }
  if (/P1003/.test(output)) {
    return {
      title: 'The database named in DATABASE_URL does not exist.',
      detail: 'Create it, or point DATABASE_URL at one that already exists.',
      fix: 'DATABASE_URL=postgresql://user:password@host:5432/<database-name>',
    };
  }
  if (/P3014/.test(output)) {
    return {
      title: 'The database user cannot create the shadow database Prisma needs.',
      detail: 'Production deploys should not need this. Make sure the app starts with `npm start`.',
    };
  }
  return null;
}

/// Runs a local binary from node_modules/.bin, which is on PATH for npm scripts
/// but not necessarily for a bare `node` invocation. Output is captured rather
/// than inherited so a failure can be explained, then echoed so the container
/// log still shows everything.
async function run(label, command, args) {
  console.log(`\n  → ${label}`);
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env: process.env,
  });

  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (output.trim()) console.log(output.trim());

  if (result.error || result.status !== 0) {
    const explained = explainPrismaFailure(output);
    await fail(
      explained?.title || `${label} failed.`,
      explained?.detail || result.error?.message || 'See the container log for the full output.',
      explained?.fix,
    );
  }
}

const prismaBin = path.join(root, 'node_modules', '.bin', 'prisma');

async function main() {
  console.log('\n  Starting hosting portal…\n');
  await waitForDatabase();

  if (String(process.env.SKIP_MIGRATIONS).toLowerCase() === 'true') {
    console.log('\n  … SKIP_MIGRATIONS=true — not applying migrations or seeding.');
  } else {
    await run('Applying database migrations', prismaBin, ['migrate', 'deploy']);
    await run('Ensuring a Super Admin exists', process.execPath, ['prisma/seed.js']);
  }

  console.log('');
  await import('../src/server.js');
}

main().catch((err) => fail('Startup failed.', err?.stack || String(err)));
