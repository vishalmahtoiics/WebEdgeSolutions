// File manager, exercised against a real FTP server.
//
// The security property that matters most here is confinement: a path from the
// browser must never reach outside the configured root. A directory is created
// *next to* the root holding a file that must stay unreachable, and the tests
// try to get at it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { FtpSrv } from 'ftp-srv';
import { PrismaClient } from '@prisma/client';

// Surface anything that escapes a test, since the runner otherwise reports a
// bare non-zero exit with no explanation.
process.on('unhandledRejection', (err) => console.error('UNHANDLED REJECTION:', err));
process.on('uncaughtException', (err) => console.error('UNCAUGHT EXCEPTION:', err));

const PORT = 3992;
const BASE = `http://127.0.0.1:${PORT}`;
const FTP_USER = 'siteuser';
const FTP_PASS = 'sitepass';
const prisma = new PrismaClient();

const stamp = Date.now();
const DOMAIN = `files-${stamp}.example`;
const OTHER = `nofiles-${stamp}.example`;
const userEmail = `files+${stamp}@example.com`;
const userPassword = 'FilesUser@12345';

// ftp-srv logs every refused request; these tests refuse a lot on purpose.
const ftpLog = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} };
ftpLog.child = () => ftpLog;

let sandbox;   // what the FTP user can see
let siteRoot;  // the directory the portal is confined to
let ftpServer;
let server;
const admin = client();
const member = client();
const ctx = {};

function client() {
  let cookie = '';
  return async function call(pathname, { method = 'GET', body, raw } = {}) {
    const res = await fetch(`${BASE}/api${pathname}`, {
      method,
      headers: {
        ...(body && !raw ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: raw ? body : body ? JSON.stringify(body) : undefined,
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
    return { status: res.status, data, text };
  };
}

test.before(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'ftp-'));
  siteRoot = path.join(sandbox, 'public_html');
  await fs.mkdir(path.join(siteRoot, 'css'), { recursive: true });
  await fs.writeFile(path.join(siteRoot, 'index.html'), '<h1>hello</h1>');
  await fs.writeFile(path.join(siteRoot, 'css', 'app.css'), 'body{}');

  // Outside the configured root, but inside what the FTP account can see.
  // Nothing the portal does should ever reach this.
  await fs.mkdir(path.join(sandbox, 'private'), { recursive: true });
  await fs.writeFile(path.join(sandbox, 'private', 'secrets.txt'), 'TOP-SECRET-VALUE');

  // A decoy at the same name *inside* the root. An escape attempt is clamped
  // to here, so the attempt has somewhere real to land and the difference
  // between "clamped" and "escaped" is unambiguous.
  await fs.mkdir(path.join(siteRoot, 'private'), { recursive: true });
  await fs.writeFile(path.join(siteRoot, 'private', 'decoy.txt'), 'decoy-inside-root');

  ftpServer = new FtpSrv({
    url: 'ftp://127.0.0.1:0',
    anonymous: false,
    pasv_url: '127.0.0.1',
    // Refused traversal attempts are expected here and log an error each time.
    log: { child: () => ftpLog, ...ftpLog },
  });
  ftpServer.on('login', ({ username, password }, resolve, reject) => {
    if (username === FTP_USER && password === FTP_PASS) return resolve({ root: sandbox });
    return reject(new Error('Bad credentials'));
  });
  await ftpServer.listen();
  const ftpPort = ftpServer.server.address().port;

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

  await admin('/auth/login', { method: 'POST', body: { email: 'admin@example.com', password: 'Admin@12345' } });

  const a = await admin('/domains', { method: 'POST', body: { name: DOMAIN } });
  ctx.domainId = a.data.domain.id;
  const b = await admin('/domains', { method: 'POST', body: { name: OTHER } });
  ctx.otherId = b.data.domain.id;

  await admin(`/domains/${ctx.domainId}/settings`, {
    method: 'PUT',
    body: {
      ftpHost: '127.0.0.1',
      ftpPort: ftpPort,
      ftpUsername: FTP_USER,
      ftpPassword: FTP_PASS,
      ftpProtocol: 'FTP',
      ftpRootPath: '/public_html',
    },
  });

  const created = await admin('/users', {
    method: 'POST',
    body: { name: 'Files User', email: userEmail, password: userPassword, role: 'USER' },
  });
  ctx.userId = created.data.user.id;
  await admin(`/users/${ctx.userId}/domains`, { method: 'PUT', body: { domainIds: [ctx.domainId] } });
  await member('/auth/login', { method: 'POST', body: { email: userEmail, password: userPassword } });
});

test.after(async () => {
  try {
    if (ctx.userId) await admin(`/users/${ctx.userId}`, { method: 'DELETE' });
    await prisma.domain.deleteMany({ where: { name: { in: [DOMAIN, OTHER] } } });
    await prisma.$disconnect();
  } catch (err) {
    console.error('TEARDOWN db:', err);
  }
  server?.kill();
  try {
    // ftp-srv keeps passive-mode sockets around; closing can reject if one is
    // already gone, which must not fail an otherwise passing run.
    await ftpServer?.close();
  } catch (err) {
    console.error('TEARDOWN ftp:', err?.message);
  }
  if (sandbox) await fs.rm(sandbox, { recursive: true, force: true });
});

// --- Credentials ------------------------------------------------------------

test('the FTP password is never returned to the browser', async () => {
  const { data, text } = await admin(`/domains/${ctx.domainId}`);
  assert.ok(!text.includes(FTP_PASS), 'the password must not appear anywhere in the response');
  assert.equal(data.settings.ftpPassword, undefined);
  assert.equal(data.settings.hasFtpPassword, true, 'but the UI still knows one is set');
  assert.match(data.settings.ftpPasswordHint, /••••/);
});

test('the FTP password is encrypted at rest', async () => {
  const row = await prisma.domainSettings.findUnique({ where: { domainId: ctx.domainId } });
  assert.notEqual(row.ftpPassword, FTP_PASS, 'it must not be stored in the clear');
  assert.equal(row.ftpPassword.split(':').length, 3, 'stored as iv:tag:ciphertext');
});

test('the connection can be tested', async () => {
  const { status, data } = await admin(`/domains/${ctx.domainId}/files/test`, { method: 'POST' });
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.match(data.message, /Connected/);
});

// --- Browsing ---------------------------------------------------------------

test('the root lists the site, with directories first', async () => {
  const { status, data } = await admin(`/domains/${ctx.domainId}/files`);
  assert.equal(status, 200);
  assert.equal(data.path, '/');
  assert.deepEqual(data.entries.map((e) => e.name), ['css', 'private', 'index.html']);
  assert.equal(data.entries[0].type, 'directory', 'directories come first');
  assert.equal(data.entries[2].type, 'file');
  assert.ok(data.entries[2].size > 0, 'files report a size');
});

test('subdirectories can be opened', async () => {
  const { data } = await admin(`/domains/${ctx.domainId}/files?path=/css`);
  assert.equal(data.path, '/css');
  assert.deepEqual(data.entries.map((e) => e.name), ['app.css']);
});

// --- Confinement ------------------------------------------------------------

test('a path cannot climb out of the configured root', async () => {
  for (const evil of ['/../private', '../private', '/css/../../private', '/..%2f..%2fprivate', '////../private']) {
    const { status, data } = await admin(`/domains/${ctx.domainId}/files?path=${encodeURIComponent(evil)}`);
    const names = status === 200 ? data.entries.map((e) => e.name) : [];
    assert.ok(!names.includes('secrets.txt'), `"${evil}" reached outside the root`);
  }
});

test('a file outside the root cannot be read', async () => {
  for (const evil of ['/../private/secrets.txt', '../private/secrets.txt', '/css/../../private/secrets.txt']) {
    const res = await admin(`/domains/${ctx.domainId}/files/content?path=${encodeURIComponent(evil)}`);
    assert.ok(!String(res.text).includes('TOP-SECRET-VALUE'), `"${evil}" leaked a file outside the root`);
  }
});

test('a file outside the root cannot be written', async () => {
  const res = await admin(`/domains/${ctx.domainId}/files/content`, {
    method: 'PUT',
    body: { path: '/../private/secrets.txt', content: 'overwritten' },
  });

  // Whether refused or clamped, the file outside the root must be untouched.
  const outside = await fs.readFile(path.join(sandbox, 'private', 'secrets.txt'), 'utf8');
  assert.equal(outside, 'TOP-SECRET-VALUE', `a write escaped the root (status ${res.status})`);

  // If it was clamped rather than refused, it landed inside the root.
  const landedInside = await fs
    .readFile(path.join(siteRoot, 'private', 'secrets.txt'), 'utf8')
    .catch(() => null);
  assert.ok(
    landedInside === null || landedInside === 'overwritten',
    'the write went somewhere unexpected',
  );
});

// --- Reading and writing ----------------------------------------------------

test('a text file can be opened and saved', async () => {
  const opened = await admin(`/domains/${ctx.domainId}/files/content?path=/index.html`);
  assert.equal(opened.status, 200);
  assert.equal(opened.data.content, '<h1>hello</h1>');

  const saved = await admin(`/domains/${ctx.domainId}/files/content`, {
    method: 'PUT',
    body: { path: '/index.html', content: '<h1>edited</h1>' },
  });
  assert.equal(saved.status, 200);
  assert.equal(await fs.readFile(path.join(siteRoot, 'index.html'), 'utf8'), '<h1>edited</h1>');
});

test('a binary file is refused by the text editor', async () => {
  await fs.writeFile(path.join(siteRoot, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  const res = await admin(`/domains/${ctx.domainId}/files/content?path=/logo.png`);
  assert.equal(res.status, 415);
  assert.match(res.data.error, /binary/i);
});

test('a file can be downloaded', async () => {
  const res = await fetch(`${BASE}/api/domains/${ctx.domainId}/files/download?path=/index.html`, {
    headers: { Cookie: (await adminCookie()) },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /index\.html/);
  assert.equal(await res.text(), '<h1>edited</h1>');
});

// The download route returns a body rather than JSON, so it needs the raw cookie.
let cachedCookie = null;
async function adminCookie() {
  if (cachedCookie) return cachedCookie;
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: 'Admin@12345' }),
  });
  cachedCookie = res.headers.get('set-cookie').split(';')[0];
  return cachedCookie;
}

// --- Managing ---------------------------------------------------------------

test('a folder can be created', async () => {
  const res = await admin(`/domains/${ctx.domainId}/files/folder`, {
    method: 'POST',
    body: { path: '/', name: 'uploads' },
  });
  assert.equal(res.status, 201);
  const stat = await fs.stat(path.join(siteRoot, 'uploads'));
  assert.ok(stat.isDirectory());
});

test('a folder name cannot smuggle a path', async () => {
  await admin(`/domains/${ctx.domainId}/files/folder`, {
    method: 'POST',
    body: { path: '/', name: '../escaped' },
  });
  await assert.rejects(
    () => fs.stat(path.join(sandbox, 'escaped')),
    'a folder was created outside the root',
  );
});

test('a file can be renamed', async () => {
  const res = await admin(`/domains/${ctx.domainId}/files/rename`, {
    method: 'POST',
    body: { path: '/css/app.css', name: 'main.css' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual((await fs.readdir(path.join(siteRoot, 'css'))).sort(), ['main.css']);
});

test('a file can be deleted', async () => {
  const res = await admin(`/domains/${ctx.domainId}/files/delete`, {
    method: 'POST',
    body: { path: '/logo.png', type: 'file' },
  });
  assert.equal(res.status, 200);
  await assert.rejects(() => fs.stat(path.join(siteRoot, 'logo.png')));
});

test('the top-level folder cannot be deleted', async () => {
  const res = await admin(`/domains/${ctx.domainId}/files/delete`, {
    method: 'POST',
    body: { path: '/', type: 'directory' },
  });
  assert.equal(res.status, 400);
  assert.ok(await fs.stat(siteRoot), 'the site root must survive');
});

// --- Authorization ----------------------------------------------------------

test('an assigned user can use the file manager', async () => {
  const { status, data } = await member(`/domains/${ctx.domainId}/files`);
  assert.equal(status, 200);
  assert.ok(data.entries.length);
});

test('a user cannot touch files on a domain they are not assigned', async () => {
  for (const [label, call] of [
    ['list', member(`/domains/${ctx.otherId}/files`)],
    ['download', member(`/domains/${ctx.otherId}/files/download?path=/index.html`)],
    ['save', member(`/domains/${ctx.otherId}/files/content`, { method: 'PUT', body: { path: '/x', content: 'x' } })],
    ['delete', member(`/domains/${ctx.otherId}/files/delete`, { method: 'POST', body: { path: '/x', type: 'file' } })],
  ]) {
    assert.equal((await call).status, 404, `${label} must not reach an unassigned domain`);
  }
});

test('a domain with no FTP details says so clearly', async () => {
  const { status, data } = await admin(`/domains/${ctx.otherId}/files`);
  assert.equal(status, 400);
  assert.match(data.error, /not set up/i);
});
