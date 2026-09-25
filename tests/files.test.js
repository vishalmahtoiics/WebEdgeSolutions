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
import { buildZip } from '../src/lib/zipWriter.js';
import { readZip } from '../src/lib/archive.js';

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

  // Both halves are checked, because they fail for different reasons.
  assert.equal(data.checks.connect.ok, true);
  assert.equal(data.checks.list.ok, true);
  assert.match(data.checks.list.message, /public_html/);
  assert.equal(data.error, null, 'nothing went wrong, so there is nothing to report');
});

test('a failed test says why, instead of a bare status code', async () => {
  // The shape the browser can actually render. This used to answer 400 with
  // `ok` and `message` and no `error`, which is the one combination the API
  // helper falls back to "Request failed (400)" on — throwing away the real
  // reason on the last step before the screen.
  const { status, data } = await admin(`/domains/${ctx.domainId}/files/test`, {
    method: 'POST',
    body: { password: 'definitely-not-the-password' },
  });

  assert.equal(status, 200, 'the test ran; its result is the answer');
  assert.equal(data.ok, false);
  assert.equal(data.checks.connect.ok, false);
  assert.match(data.checks.connect.message, /credentials|password|login/i);
  assert.equal(data.error, data.message, 'repeated where a generic caller looks');
  assert.ok(!JSON.stringify(data).includes('definitely-not-the-password'));
});

test('a password nobody saved is not something a customer may try', async () => {
  // Testing the stored details is a fair question for whoever owns the
  // domain. Testing an arbitrary password against somebody's file server is
  // a brute-force helper, so that half is Super Admin's.
  const res = await member(`/domains/${ctx.domainId}/files/test`, {
    method: 'POST',
    body: { password: 'guess-one' },
  });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /Super Admin/i);

  // The plain check still works for them.
  const plain = await member(`/domains/${ctx.domainId}/files/test`, { method: 'POST' });
  assert.equal(plain.status, 200);
  assert.equal(plain.data.ok, true);
});

test('a domain with nothing saved says so, rather than failing to connect', async () => {
  // "No host is saved" and "the host refused you" need different fixes, and
  // a connection error for a domain that was never set up is a confusing way
  // to learn the first one.
  const { status, data } = await admin(`/domains/${ctx.otherId}/files/test`, { method: 'POST' });
  assert.equal(status, 200);
  assert.equal(data.ok, false);
  assert.match(data.message, /Nothing to test yet/i);
  assert.match(data.message, /no host/i);
  assert.equal(data.checks.connect, null, 'nothing was tried');
});

test('a root folder that does not exist is told apart from a bad password', async () => {
  // The two look identical from the Files tab, and the fixes are nothing
  // alike: one is a typo in a path, the other is a credential.
  await admin(`/domains/${ctx.domainId}/settings`, {
    method: 'PUT',
    body: { ftpRootPath: '/no_such_folder' },
  });

  try {
    const { data } = await admin(`/domains/${ctx.domainId}/files/test`, { method: 'POST' });
    assert.equal(data.ok, false);
    assert.equal(data.checks.connect.ok, true, 'the credentials were fine');
    assert.equal(data.checks.list.ok, false, 'the folder was not');
    assert.match(data.checks.list.message, /no_such_folder/);
  } finally {
    await admin(`/domains/${ctx.domainId}/settings`, {
      method: 'PUT',
      body: { ftpRootPath: '/public_html' },
    });
  }
});

test('a root set to the account rather than the site is pointed out', async () => {
  // Everything works and the file manager shows the wrong folder, which is
  // the sort of thing somebody discovers after an hour of edits doing
  // nothing to their website.
  await admin(`/domains/${ctx.domainId}/settings`, { method: 'PUT', body: { ftpRootPath: '/' } });

  try {
    const { data } = await admin(`/domains/${ctx.domainId}/files/test`, { method: 'POST' });
    assert.equal(data.ok, true, 'it does work — that is the point');
    assert.match(data.checks.list.message, /account root rather than the site/i);
    assert.match(data.checks.list.message, /public_html/);
  } finally {
    await admin(`/domains/${ctx.domainId}/settings`, {
      method: 'PUT',
      body: { ftpRootPath: '/public_html' },
    });
  }
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

// --- The editor puts back what it found -------------------------------------

const exists = (p) => fs.stat(p).then(() => true, () => false);

test('a file larger than an ordinary request can still be saved', async () => {
  // Between the general 256 KB body limit and the editor's 512 KB: this used
  // to open fine and then fail to save with "request entity too large".
  const big = `${'/* padding */\n'.repeat(28000)}`;
  assert.ok(big.length > 300 * 1024 && big.length < 512 * 1024);
  await fs.writeFile(path.join(siteRoot, 'big.css'), big);

  const opened = await admin(`/domains/${ctx.domainId}/files/content?path=/big.css`);
  assert.equal(opened.status, 200);

  const saved = await admin(`/domains/${ctx.domainId}/files/content`, {
    method: 'PUT',
    body: { path: '/big.css', content: `${opened.data.content}/* edited */\n` },
  });
  assert.equal(saved.status, 200, saved.data?.error);
  assert.match(await fs.readFile(path.join(siteRoot, 'big.css'), 'utf8'), /\/\* edited \*\/\n$/);
});

test('a Latin-1 file is saved back as Latin-1, not mangled into UTF-8', async () => {
  await fs.writeFile(path.join(siteRoot, 'old.txt'), Buffer.from('café\n', 'latin1'));

  const opened = await admin(`/domains/${ctx.domainId}/files/content?path=/old.txt`);
  assert.equal(opened.data.encoding, 'latin1');
  assert.equal(opened.data.content, 'café\n', 'read as the characters it holds, not as replacement marks');

  const saved = await admin(`/domains/${ctx.domainId}/files/content`, {
    method: 'PUT',
    body: { path: '/old.txt', content: 'café crème\n', encoding: 'latin1' },
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(await fs.readFile(path.join(siteRoot, 'old.txt')), Buffer.from('café crème\n', 'latin1'));
});

test('a character Latin-1 cannot hold is refused rather than written wrong', async () => {
  const res = await admin(`/domains/${ctx.domainId}/files/content`, {
    method: 'PUT',
    body: { path: '/old.txt', content: 'price ₹100\n', encoding: 'latin1' },
  });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /₹/);
  assert.deepEqual(await fs.readFile(path.join(siteRoot, 'old.txt')), Buffer.from('café crème\n', 'latin1'));
});

test('Windows line endings and a byte-order mark survive a save', async () => {
  await fs.writeFile(path.join(siteRoot, 'win.txt'), '﻿one\r\ntwo\r\n');

  const opened = await admin(`/domains/${ctx.domainId}/files/content?path=/win.txt`);
  assert.equal(opened.data.eol, 'crlf');
  assert.equal(opened.data.encoding, 'utf8');

  // What a textarea hands back: LF only.
  const content = opened.data.content.replace(/\r\n/g, '\n').replace('two', 'two\nthree');
  const saved = await admin(`/domains/${ctx.domainId}/files/content`, {
    method: 'PUT',
    body: { path: '/win.txt', content, eol: 'crlf' },
  });
  assert.equal(saved.status, 200);
  assert.equal(await fs.readFile(path.join(siteRoot, 'win.txt'), 'utf8'), '﻿one\r\ntwo\r\nthree\r\n');
});

test('a new file can be created, but never over one that is there', async () => {
  const made = await admin(`/domains/${ctx.domainId}/files/file`, {
    method: 'POST',
    body: { path: '/', name: 'notes.md' },
  });
  assert.equal(made.status, 201);
  assert.equal(made.data.path, '/notes.md');
  assert.equal(await fs.readFile(path.join(siteRoot, 'notes.md'), 'utf8'), '');

  const again = await admin(`/domains/${ctx.domainId}/files/file`, {
    method: 'POST',
    body: { path: '/', name: 'index.html' },
  });
  assert.equal(again.status, 409);
  assert.ok((await fs.readFile(path.join(siteRoot, 'index.html'), 'utf8')).length > 0, 'the existing file is untouched');

  const sneaky = await admin(`/domains/${ctx.domainId}/files/file`, {
    method: 'POST',
    body: { path: '/', name: '../outside.txt' },
  });
  assert.equal(sneaky.status, 400);
  assert.equal(await exists(path.join(sandbox, 'outside.txt')), false);
});

// --- Several at once --------------------------------------------------------

test('several items can be deleted at once, and one that fails is named', async () => {
  await fs.mkdir(path.join(siteRoot, 'old', 'deep'), { recursive: true });
  await fs.writeFile(path.join(siteRoot, 'old', 'deep', 'x.txt'), 'x');
  await fs.writeFile(path.join(siteRoot, 'a.txt'), 'a');

  const res = await admin(`/domains/${ctx.domainId}/files/delete-many`, {
    method: 'POST',
    body: {
      path: '/',
      items: [
        { name: 'a.txt', type: 'file' },
        { name: 'old', type: 'directory' },
        { name: 'not-there.txt', type: 'file' },
      ],
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.deleted, 2);
  assert.equal(res.data.ok, false);
  assert.deepEqual(res.data.failed.map((f) => f.name), ['not-there.txt']);
  assert.equal(await exists(path.join(siteRoot, 'a.txt')), false);
  assert.equal(await exists(path.join(siteRoot, 'old')), false);
});

test('a name in a bulk delete cannot reach outside the folder', async () => {
  const res = await admin(`/domains/${ctx.domainId}/files/delete-many`, {
    method: 'POST',
    body: { path: '/', items: [{ name: '../private', type: 'directory' }] },
  });
  assert.equal(res.status, 400);
  assert.equal(await exists(path.join(sandbox, 'private', 'secrets.txt')), true);
});

async function downloadZip(body) {
  const res = await fetch(`${BASE}/api/domains/${ctx.domainId}/files/zip-download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: await adminCookie() },
    body: JSON.stringify(body),
  });
  return res;
}

test('a selection downloads as a zip of exactly what was picked', async () => {
  const res = await downloadZip({ path: '/', names: ['css', 'index.html'] });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.ok(
    res.headers.get('content-disposition').includes(`${DOMAIN}.zip`),
    'a zip of the top level is named after the site',
  );

  const zip = await readZip(Buffer.from(await res.arrayBuffer()), { defaultExclusions: false });
  const paths = zip.files.map((f) => f.path).sort();
  assert.deepEqual(paths, ['css/main.css', 'index.html']);
  assert.equal(
    zip.files.find((f) => f.path === 'index.html').contents.toString(),
    await fs.readFile(path.join(siteRoot, 'index.html'), 'utf8'),
  );
});

test('a zip download cannot be pointed outside the root', async () => {
  const smuggled = await downloadZip({ path: '/', names: ['../private'] });
  assert.equal(smuggled.status, 400);

  // The folder is clamped to the root, so this asks for the decoy inside it
  // and never the real private folder beside it.
  const climbed = await downloadZip({ path: '/../..', names: ['private'] });
  assert.equal(climbed.status, 200);
  const zip = await readZip(Buffer.from(await climbed.arrayBuffer()), { defaultExclusions: false });
  const text = zip.files.map((f) => f.contents.toString()).join('\n');
  assert.ok(!text.includes('TOP-SECRET-VALUE'), 'the file outside the root must never be zipped');
  assert.match(text, /decoy-inside-root/);
});

test('a zip is made in the folder, and a name that is taken gets a number', async () => {
  const first = await admin(`/domains/${ctx.domainId}/files/compress`, {
    method: 'POST',
    body: { path: '/', names: ['css'] },
  });
  assert.equal(first.status, 201);
  assert.equal(first.data.name, 'css.zip');

  const zip = await readZip(await fs.readFile(path.join(siteRoot, 'css.zip')), { defaultExclusions: false });
  assert.deepEqual(zip.files.map((f) => f.path), ['css/main.css']);

  const second = await admin(`/domains/${ctx.domainId}/files/compress`, {
    method: 'POST',
    body: { path: '/', names: ['css'] },
  });
  assert.equal(second.data.name, 'css-2.zip', 'the first zip is not replaced');
  assert.equal(await exists(path.join(siteRoot, 'css.zip')), true);
});

// --- Extracting -------------------------------------------------------------

test('a zip extracts into a folder of its own, empty folders included', async () => {
  await fs.writeFile(
    path.join(siteRoot, 'bundle.zip'),
    await buildZip([
      { path: 'site/a.txt', contents: Buffer.from('A') },
      { path: 'site/.htaccess', contents: Buffer.from('Options -Indexes') },
      { path: 'empty', directory: true },
    ]),
  );

  const res = await admin(`/domains/${ctx.domainId}/files/extract`, {
    method: 'POST',
    body: { path: '/bundle.zip' },
  });
  assert.equal(res.status, 200, res.data?.error);
  assert.equal(res.data.ok, true);
  assert.equal(res.data.target, '/bundle');
  assert.equal(await fs.readFile(path.join(siteRoot, 'bundle', 'site', 'a.txt'), 'utf8'), 'A');
  assert.equal(
    await fs.readFile(path.join(siteRoot, 'bundle', 'site', '.htaccess'), 'utf8'),
    'Options -Indexes',
    'a dotfile is unpacked like anything else; the deploy exclusions do not apply here',
  );
  assert.ok((await fs.stat(path.join(siteRoot, 'bundle', 'empty'))).isDirectory());
});

test('extracting beside the zip keeps existing files unless told to replace them', async () => {
  const before = await fs.readFile(path.join(siteRoot, 'index.html'), 'utf8');
  await fs.writeFile(
    path.join(siteRoot, 'update.zip'),
    await buildZip([
      { path: 'index.html', contents: Buffer.from('<h1>from the zip</h1>') },
      { path: 'fresh.txt', contents: Buffer.from('new') },
    ]),
  );

  const kept = await admin(`/domains/${ctx.domainId}/files/extract`, {
    method: 'POST',
    body: { path: '/update.zip', into: 'here' },
  });
  assert.equal(kept.status, 200);
  assert.equal(kept.data.written, 1);
  assert.deepEqual(kept.data.skipped, ['index.html']);
  assert.equal(await fs.readFile(path.join(siteRoot, 'index.html'), 'utf8'), before);
  assert.equal(await fs.readFile(path.join(siteRoot, 'fresh.txt'), 'utf8'), 'new');

  const replaced = await admin(`/domains/${ctx.domainId}/files/extract`, {
    method: 'POST',
    body: { path: '/update.zip', into: 'here', overwrite: true },
  });
  assert.equal(replaced.data.written, 2);
  assert.equal(await fs.readFile(path.join(siteRoot, 'index.html'), 'utf8'), '<h1>from the zip</h1>');
});

test('a zip that tries to write outside its folder is refused before anything is written', async () => {
  await fs.writeFile(
    path.join(siteRoot, 'evil.zip'),
    await buildZip([
      { path: 'harmless.txt', contents: Buffer.from('ok') },
      { path: '../../escape.txt', contents: Buffer.from('escaped') },
    ]),
  );

  const res = await admin(`/domains/${ctx.domainId}/files/extract`, {
    method: 'POST',
    body: { path: '/evil.zip', into: 'here' },
  });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /outside/i);
  assert.equal(await exists(path.join(sandbox, 'escape.txt')), false);
  assert.equal(await exists(path.join(path.dirname(sandbox), 'escape.txt')), false);
  assert.equal(await exists(path.join(siteRoot, 'harmless.txt')), false, 'nothing from a refused zip is written');
});

test('only a zip can be extracted', async () => {
  const res = await admin(`/domains/${ctx.domainId}/files/extract`, {
    method: 'POST',
    body: { path: '/index.html' },
  });
  assert.equal(res.status, 400);
});

test('none of the new file actions reach a domain the user is not assigned', async () => {
  const other = ctx.otherId;
  for (const [label, call] of [
    ['new file', member(`/domains/${other}/files/file`, { method: 'POST', body: { path: '/', name: 'x' } })],
    ['bulk delete', member(`/domains/${other}/files/delete-many`, { method: 'POST', body: { path: '/', items: [{ name: 'x', type: 'file' }] } })],
    ['zip download', member(`/domains/${other}/files/zip-download`, { method: 'POST', body: { path: '/', names: ['x'] } })],
    ['compress', member(`/domains/${other}/files/compress`, { method: 'POST', body: { path: '/', names: ['x'] } })],
    ['extract', member(`/domains/${other}/files/extract`, { method: 'POST', body: { path: '/x.zip' } })],
  ]) {
    assert.equal((await call).status, 404, `${label} must not reach an unassigned domain`);
  }
});

test('an assigned user can zip and extract on their own domain', async () => {
  const res = await member(`/domains/${ctx.domainId}/files/compress`, {
    method: 'POST',
    body: { path: '/', names: ['fresh.txt'], name: 'mine' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.name, 'mine.zip');
});

// --- Settings are not overwritten by a stale form ---------------------------

test('a settings form drawn before the last save cannot overwrite it', async () => {
  // The page loads, and the form is drawn from what it was given.
  const loaded = (await admin(`/domains/${ctx.otherId}`)).data.settings?.updatedAt ?? null;

  const first = await admin(`/domains/${ctx.otherId}/settings`, {
    method: 'PUT',
    body: { ftpHost: 'ftp.example.net', ftpUsername: 'someone', expectedUpdatedAt: loaded },
  });
  assert.equal(first.status, 200, first.data?.error);
  const version = first.data.settings.updatedAt;
  assert.ok(version && version !== loaded);

  // The same page, the tab opened again from its original copy: blank
  // fields, still claiming the version from before the save. This is what
  // wiped details.
  const stale = await admin(`/domains/${ctx.otherId}/settings`, {
    method: 'PUT',
    body: { ftpHost: '', ftpUsername: '', expectedUpdatedAt: loaded },
  });
  assert.equal(stale.status, 409);
  assert.match(stale.data.error, /changed after this form was opened/);

  const row = await prisma.domainSettings.findUnique({ where: { domainId: ctx.otherId } });
  assert.equal(row.ftpHost, 'ftp.example.net', 'the saved host survives');
  assert.equal(row.ftpUsername, 'someone');

  // A form drawn from the current version saves normally, and the log says
  // what was emptied.
  const fresh = await admin(`/domains/${ctx.otherId}/settings`, {
    method: 'PUT',
    body: { ftpHost: 'ftp.example.org', ftpUsername: '', expectedUpdatedAt: version },
  });
  assert.equal(fresh.status, 200);
  const logged = await prisma.activityLog.findFirst({
    where: { domainId: ctx.otherId, event: 'settings.domain.updated' },
    orderBy: { createdAt: 'desc' },
  });
  assert.match(logged.detail, /Fields changed: ftpHost/);
  assert.match(logged.detail, /Fields emptied: ftpUsername/);
});
