// Deploying a website, against a real FTP server.
//
// Most of this file is about what must not happen. A deploy writes to
// somebody's live website, so the failure modes are not "it did not work" —
// they are "it wrote somewhere it should not have", "it deleted the site and
// said it succeeded", and "it could not be undone".
//
// The archive tests build genuinely hostile zips rather than describing them:
// a Zip Slip entry, a zip bomb, a symlink pointing at the filesystem root.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { FtpSrv } from 'ftp-srv';
import { PrismaClient } from '@prisma/client';

import { readZip, safeEntryPath, isExcluded, stripCommonRoot, ArchiveError } from '../src/lib/archive.js';
import { buildPlan, describePlan, digest, assertSensible } from '../src/lib/deployPlan.js';
import { assertSafeGitUrl } from '../src/services/deployService.js';

process.on('unhandledRejection', (err) => console.error('UNHANDLED REJECTION:', err));

const PORT = 3972;
const BASE = `http://127.0.0.1:${PORT}`;
const FTP_USER = 'deployuser';
const FTP_PASS = 'deploypass';
const prisma = new PrismaClient();

const stamp = Date.now();
const DOMAIN = `deploy-${stamp}.example`;
const userEmail = `deploy+${stamp}@example.com`;
const userPassword = 'DeployUser@12345';

const ftpLog = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} };
ftpLog.child = () => ftpLog;

let sandbox;
let siteRoot;
let ftpServer;
let server;
const admin = client();
const member = client();
const outsider = client();
const ctx = {};

function client() {
  let cookie = '';
  const call = async function call(pathname, { method = 'GET', body, form } = {}) {
    const res = await fetch(`${BASE}/api${pathname}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        Connection: 'close',
      },
      body: form || (body ? JSON.stringify(body) : undefined),
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
  return call;
}

/// Builds a zip in memory with the `zip` behaviour these tests need, without
/// pulling in a writer library: a stored (uncompressed) zip is a handful of
/// well-documented structures, and writing it here keeps the hostile cases
/// under this file's control.
function makeZip(entries) {
  const files = [];
  const chunks = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data ?? '', 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);           // stored
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, name, data);
    files.push({ name, data, crc, offset, mode: entry.mode ?? 0o100644 });
    offset += local.length + name.length + data.length;
  }

  const centralStart = offset;
  for (const f of files) {
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);    // made by unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(f.crc, 16);
    central.writeUInt32LE(f.data.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(f.name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    // Unsigned: 0o100644 << 16 overflows a signed 32-bit int and comes back
    // negative, which writeUInt32LE refuses.
    central.writeUInt32LE((f.mode << 16) >>> 0, 38);
    central.writeUInt32LE(f.offset, 42);
    chunks.push(central, f.name);
    offset += central.length + f.name.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(offset - centralStart, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  chunks.push(end);

  return Buffer.concat(chunks);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/// Posts a zip as multipart, the way the browser does.
async function postZip(path, zip, fields = {}, as = admin) {
  const form = new FormData();
  form.append('archive', new Blob([zip], { type: 'application/zip' }), fields.name || 'site.zip');
  for (const [key, value] of Object.entries(fields)) {
    if (key !== 'name') form.append(key, String(value));
  }
  return as(path, { method: 'POST', form });
}

const onDisk = (relative) => fs.readFile(path.join(siteRoot, relative), 'utf8');
const exists = async (relative) => {
  try {
    await fs.access(path.join(siteRoot, relative));
    return true;
  } catch {
    return false;
  }
};

test.before(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'deploy-'));
  siteRoot = path.join(sandbox, 'public_html');
  await fs.mkdir(siteRoot, { recursive: true });
  await fs.writeFile(path.join(siteRoot, 'index.html'), '<h1>version one</h1>');
  await fs.mkdir(path.join(siteRoot, 'uploads'), { recursive: true });
  await fs.writeFile(path.join(siteRoot, 'uploads', 'photo.jpg'), 'customer-photo-bytes');

  // Outside the configured root. Nothing a deploy does may reach this.
  await fs.mkdir(path.join(sandbox, 'private'), { recursive: true });
  await fs.writeFile(path.join(sandbox, 'private', 'secrets.txt'), 'TOP-SECRET-VALUE');

  ftpServer = new FtpSrv({
    url: 'ftp://127.0.0.1:0',
    anonymous: false,
    pasv_url: '127.0.0.1',
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

  const created = await admin('/domains', { method: 'POST', body: { name: DOMAIN } });
  ctx.domainId = created.data.domain.id;

  await admin(`/domains/${ctx.domainId}/settings`, {
    method: 'PUT',
    body: {
      ftpHost: '127.0.0.1',
      ftpPort,
      ftpUsername: FTP_USER,
      ftpPassword: FTP_PASS,
      ftpProtocol: 'FTP',
      ftpRootPath: '/public_html',
    },
  });

  const user = await admin('/users', {
    method: 'POST',
    body: { name: 'Deploy User', email: userEmail, password: userPassword, role: 'USER' },
  });
  ctx.userId = user.data.user.id;
  await admin(`/users/${ctx.userId}/domains`, { method: 'PUT', body: { domainIds: [ctx.domainId] } });
  await member('/auth/login', { method: 'POST', body: { email: userEmail, password: userPassword } });

  const stranger = await admin('/users', {
    method: 'POST',
    body: { name: 'Outsider', email: `out+${stamp}@example.com`, password: userPassword, role: 'USER' },
  });
  ctx.outsiderId = stranger.data.user.id;
  await outsider('/auth/login', { method: 'POST', body: { email: `out+${stamp}@example.com`, password: userPassword } });
});

test.after(async () => {
  try {
    await prisma.deployment.deleteMany({ where: { domainId: ctx.domainId } });
    for (const id of [ctx.userId, ctx.outsiderId]) if (id) await admin(`/users/${id}`, { method: 'DELETE' });
    await prisma.domain.deleteMany({ where: { name: DOMAIN } });
    await prisma.activityLog.deleteMany({ where: { event: { startsWith: 'deploy.' } } });
    await prisma.$disconnect();
  } catch (err) {
    console.error('TEARDOWN:', err?.message);
  }
  server?.kill();
  await ftpServer?.close();
  await fs.rm(sandbox, { recursive: true, force: true }).catch(() => {});
});

// ---------------------------------------------------------------------------
// The archive, on its own
// ---------------------------------------------------------------------------

test('a Zip Slip entry is refused, not written', async () => {
  const zip = makeZip([{ name: '../../../../etc/passwd', data: 'root::0:0' }]);
  await assert.rejects(() => readZip(zip), (err) => {
    assert.ok(err instanceof ArchiveError);
    assert.match(err.message, /outside itself/);
    return true;
  });
});

test('a path that only escapes once resolved is refused too', async () => {
  // "a/b/../../../outside" looks harmless until you work it out.
  const zip = makeZip([{ name: 'a/b/../../../outside.txt', data: 'nope' }]);
  await assert.rejects(() => readZip(zip), /outside itself/);
});

test('an absolute path is refused', async () => {
  await assert.rejects(() => readZip(makeZip([{ name: '/etc/shadow', data: 'x' }])), /outside itself/);
});

test('a Windows path and a backslash path are refused', () => {
  assert.throws(() => safeEntryPath('C:\\windows\\system32\\evil.dll'), /absolute path/);
  // Backslashes are normalised to slashes first, so this is the same escape.
  assert.throws(() => safeEntryPath('..\\..\\outside.txt'), /outside itself/);
});

test('a file name with a null byte in it is refused', () => {
  assert.throws(() => safeEntryPath('safe.html\u0000.php'), /null byte/);
});

test('a symbolic link in the archive is refused', async () => {
  // 0xA1FF is S_IFLNK | 0777 in the high half of the external attributes.
  const zip = makeZip([
    { name: 'link', data: '/etc', mode: 0o120777 },
    { name: 'index.html', data: 'hi' },
  ]);
  await assert.rejects(() => readZip(zip), /symbolic link/);
});

test('a zip bomb is stopped while it is unpacking, not after', async () => {
  // 200 MB of zeroes, stored. The cap has to bite on the running total
  // rather than on the header, which could say anything.
  const zip = makeZip([{ name: 'big.bin', data: '\0'.repeat(80 * 1024 * 1024) }]);
  await assert.rejects(() => readZip(zip), /larger than/);
});

test('secrets and build rubbish never come out of an archive', async () => {
  const zip = makeZip([
    { name: 'index.html', data: 'hi' },
    { name: '.env', data: 'DB_PASSWORD=hunter2' },
    { name: 'app/.env.production', data: 'STRIPE_KEY=sk_live_x' },
    { name: 'node_modules/left-pad/index.js', data: 'x' },
    { name: '.git/config', data: '[core]' },
    { name: '.DS_Store', data: 'x' },
  ]);

  const read = await readZip(zip);
  const paths = read.files.map((f) => f.path);

  assert.deepEqual(paths, ['index.html']);
  // A .env in a web root is served as plain text by every default Apache and
  // nginx configuration, so this is the one that matters most.
  assert.ok(read.skipped.includes('.env'));
  assert.ok(read.skipped.includes('app/.env.production'));
  assert.ok(isExcluded('deep/nested/.git/objects/ab'), 'matched per segment, not by prefix');
});

test('a single wrapping folder is stripped, and an ambiguous one is not', () => {
  const wrapped = [
    { path: 'myrepo-main/index.html', contents: Buffer.from('a') },
    { path: 'myrepo-main/css/a.css', contents: Buffer.from('b') },
  ];
  const stripped = stripCommonRoot(wrapped);
  assert.equal(stripped.stripped, 'myrepo-main');
  assert.deepEqual(stripped.files.map((f) => f.path), ['index.html', 'css/a.css']);

  // Two top-level entries: the intent is no longer obvious, so nothing moves.
  const flat = [
    { path: 'index.html', contents: Buffer.from('a') },
    { path: 'css/a.css', contents: Buffer.from('b') },
  ];
  assert.equal(stripCommonRoot(flat).stripped, null);
});

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

test('the plan separates new, changed, unchanged and deleted', () => {
  const source = [
    { path: 'index.html', contents: Buffer.from('v2') },
    { path: 'css/app.css', contents: Buffer.from('same') },
    { path: 'new.js', contents: Buffer.from('x') },
  ];
  const target = [
    { path: 'index.html', size: 2, hash: digest(Buffer.from('v1')) },
    { path: 'css/app.css', size: 4, hash: digest(Buffer.from('same')) },
    { path: 'uploads/photo.jpg', size: 900 },
  ];

  const additive = buildPlan(source, target);
  assert.equal(additive.create.length, 1);
  assert.equal(additive.update.length, 1);
  assert.equal(additive.unchanged.length, 1);
  assert.equal(additive.remove.length, 0, 'add-only never deletes');

  const replacing = buildPlan(source, target, { deleteMissing: true });
  assert.deepEqual(replacing.remove.map((r) => r.path), ['uploads/photo.jpg']);

  const keeping = buildPlan(source, target, { deleteMissing: true, keep: ['uploads'] });
  assert.equal(keeping.remove.length, 0);
  assert.deepEqual(keeping.protectedFromDelete, ['uploads/photo.jpg']);
});

test('parent folders are planned before the folders inside them', () => {
  const plan = buildPlan([{ path: 'a/b/c/deep.txt', contents: Buffer.from('x') }], []);
  assert.deepEqual(plan.directories, ['a', 'a/b', 'a/b/c']);
});

test('a plan that would wipe a site and replace it with nothing is refused', () => {
  const target = Array.from({ length: 40 }, (_, i) => ({ path: `page${i}.html`, size: 10 }));
  const plan = buildPlan([{ path: 'readme.md', contents: Buffer.from('x') }], target, { deleteMissing: true });

  assert.throws(
    () => assertSensible(plan, target, { deleteMissing: true }),
    /zip built from the wrong folder/,
  );
  // And it can be overridden by somebody who means it.
  assert.doesNotThrow(() => assertSensible(plan, target, { deleteMissing: true, force: true }));
});

test('only https repository URLs without credentials are accepted', () => {
  assert.ok(assertSafeGitUrl('https://github.com/someone/site.git'));
  assert.throws(() => assertSafeGitUrl('git@github.com:someone/site.git'), /https/);
  assert.throws(() => assertSafeGitUrl('file:///etc'), /https/);
  assert.throws(() => assertSafeGitUrl('ssh://git@host/x.git'), /https/);
  // A token in a URL ends up in logs and in the deployment record.
  assert.throws(() => assertSafeGitUrl('https://ghp_secret@github.com/a/b.git'), /token/);
});

// ---------------------------------------------------------------------------
// Deploying for real
// ---------------------------------------------------------------------------

test('deploying is closed to a user the domain is not assigned to', async () => {
  const zip = makeZip([{ name: 'index.html', data: 'x' }]);
  const res = await postZip(`/domains/${ctx.domainId}/deployments`, zip, {}, outsider);
  assert.equal(res.status, 404, 'not 403 — the id must not confirm the domain exists');
});

test('a preview says what would happen and writes nothing', async () => {
  const zip = makeZip([
    { name: 'index.html', data: '<h1>version two</h1>' },
    { name: 'css/app.css', data: 'body{color:red}' },
  ]);

  const res = await postZip(`/domains/${ctx.domainId}/deployments/preview`, zip);
  assert.equal(res.status, 200);
  assert.equal(res.data.ok, true);
  assert.equal(res.data.counts.update, 1, 'index.html exists already');
  assert.equal(res.data.counts.create, 1, 'the stylesheet is new');
  assert.equal(res.data.counts.remove, 0, 'add-only by default');

  // Nothing moved.
  assert.equal(await onDisk('index.html'), '<h1>version one</h1>');
  assert.equal(await exists('css/app.css'), false);
});

test('a deploy writes the files and records what it did', async () => {
  const zip = makeZip([
    { name: 'index.html', data: '<h1>version two</h1>' },
    { name: 'css/app.css', data: 'body{color:red}' },
  ]);

  const res = await postZip(`/domains/${ctx.domainId}/deployments`, zip, { name: 'release-2.zip' });
  assert.equal(res.status, 201);

  assert.equal(await onDisk('index.html'), '<h1>version two</h1>');
  assert.equal(await onDisk('css/app.css'), 'body{color:red}');

  const deployment = res.data.deployment;
  ctx.firstDeployId = deployment.id;
  assert.equal(deployment.status, 'SUCCEEDED');
  assert.equal(deployment.filesCreated, 1);
  assert.equal(deployment.filesUpdated, 1);
  assert.equal(deployment.archiveName, 'release-2.zip');
  assert.equal(deployment.number, 1, 'numbered per domain, from one');
});

test('the file it replaced was moved aside, not overwritten in place', async () => {
  const deployment = await prisma.deployment.findUnique({ where: { id: ctx.firstDeployId } });
  assert.ok(deployment.backupPath, 'a backup was taken');

  const backed = path.join(sandbox, 'public_html', deployment.backupPath, 'index.html');
  assert.equal(await fs.readFile(backed, 'utf8'), '<h1>version one</h1>');
  assert.deepEqual(deployment.movedAside, ['index.html']);
  assert.deepEqual(deployment.createdPaths, ['css/app.css']);
});

test('rolling back puts the old site back exactly', async () => {
  const res = await admin(`/domains/${ctx.domainId}/deployments/${ctx.firstDeployId}/rollback`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.problems, []);

  assert.equal(await onDisk('index.html'), '<h1>version one</h1>', 'the replaced file came back');
  assert.equal(await exists('css/app.css'), false, 'the file it added is gone');

  const after = await prisma.deployment.findUnique({ where: { id: ctx.firstDeployId } });
  assert.equal(after.status, 'ROLLED_BACK');
});

test('a second rollback of the same deploy is refused', async () => {
  const res = await admin(`/domains/${ctx.domainId}/deployments/${ctx.firstDeployId}/rollback`, { method: 'POST' });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /already been rolled back/);
});

test('an unchanged file is not uploaded a second time', async () => {
  const zip = makeZip([{ name: 'index.html', data: '<h1>version three</h1>' }]);
  await postZip(`/domains/${ctx.domainId}/deployments`, zip);

  // The same archive again: the manifest from last time says nothing moved.
  const again = await postZip(`/domains/${ctx.domainId}/deployments`, zip);
  assert.equal(again.status, 200);
  assert.equal(again.data.noop, true, 'nothing to do is said rather than done');
  assert.match(again.data.message, /already matches/);
});

test('"upload everything again" ignores the fingerprints', async () => {
  const zip = makeZip([{ name: 'index.html', data: '<h1>version three</h1>' }]);
  const res = await postZip(`/domains/${ctx.domainId}/deployments`, zip, { force: 'true' });
  assert.equal(res.status, 201);
  assert.equal(res.data.deployment.filesUpdated, 1);
});

test('a replace deploy deletes what is missing, but never the kept paths', async () => {
  const zip = makeZip([{ name: 'index.html', data: '<h1>version four</h1>' }]);

  const res = await postZip(`/domains/${ctx.domainId}/deployments`, zip, {
    deleteMissing: 'true',
    keep: 'uploads',
  });
  assert.equal(res.status, 201);

  assert.equal(await onDisk('index.html'), '<h1>version four</h1>');
  assert.equal(await onDisk('uploads/photo.jpg'), 'customer-photo-bytes', 'the customer keeps their uploads');
  ctx.replaceDeployId = res.data.deployment.id;
});

test('an unticked checkbox means off, not on', async () => {
  // Every field in a multipart body is a string, and Boolean('false') is
  // true. Getting this wrong would mean an unticked "Replace the site"
  // deleting the site — which is why it is tested through the real form
  // encoding rather than against the schema.
  const zip = makeZip([{ name: 'index.html', data: '<h1>checkbox test</h1>' }]);

  const res = await postZip(`/domains/${ctx.domainId}/deployments/preview`, zip, {
    deleteMissing: 'false',
    force: 'false',
  });

  assert.equal(res.status, 200);
  assert.equal(res.data.counts.remove, 0, '"false" must not mean replace-the-site');

  // And a ticked one still means on. No `keep` here: with uploads protected
  // there would be nothing left to delete, and the check would pass for the
  // wrong reason. This is a preview, so nothing is actually removed.
  const ticked = await postZip(`/domains/${ctx.domainId}/deployments/preview`, zip, {
    deleteMissing: 'true',
  });
  assert.ok(ticked.data.counts.remove > 0, '"true" still deletes');
});

test('a deploy never reaches outside the domain root, whatever the target path says', async () => {
  const zip = makeZip([{ name: 'evil.txt', data: 'should not escape' }]);

  const res = await postZip(`/domains/${ctx.domainId}/deployments`, zip, {
    targetPath: '../../private',
  });

  // Either refused outright, or clamped to the root. Both are correct; what
  // matters is that the file outside is untouched and nothing new is there.
  assert.equal(await fs.readFile(path.join(sandbox, 'private', 'secrets.txt'), 'utf8'), 'TOP-SECRET-VALUE');
  assert.equal(
    await fs.access(path.join(sandbox, 'private', 'evil.txt')).then(() => true, () => false),
    false,
    'nothing was written outside the root',
  );
  assert.ok([201, 400, 403].includes(res.status), `unexpected status ${res.status}`);
});

test('the backup directory is not treated as part of the site', async () => {
  // Otherwise a replace-deploy would delete its own backups, and the deploy
  // after that would back up the backups.
  const zip = makeZip([{ name: 'index.html', data: '<h1>version five</h1>' }]);
  const res = await postZip(`/domains/${ctx.domainId}/deployments/preview`, zip, { deleteMissing: 'true' });

  const removing = [...res.data.sample.remove];
  assert.ok(
    !removing.some((p) => p.startsWith('.portal-backups')),
    `a backup was about to be deleted: ${removing.join(', ')}`,
  );
});

test('the history reads back with who, when and what', async () => {
  const res = await admin(`/domains/${ctx.domainId}/deployments`);
  assert.equal(res.status, 200);
  assert.ok(res.data.deployments.length >= 4);

  const latest = res.data.deployments[0];
  assert.match(latest.actorLabel, /admin@example\.com/);
  assert.ok(latest.startedAt);
  assert.ok(typeof latest.durationMs === 'number');

  // The page is told the limits rather than hard-coding them.
  assert.ok(res.data.limits.maxUnpackedMb >= 1);
  assert.ok(res.data.excluded.includes('.env'));
});

test('a deploy is recorded in the activity log', async () => {
  const entry = await prisma.activityLog.findFirst({
    where: { event: 'deploy.completed', domainName: DOMAIN },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(entry, 'a deploy is worth an alert: it changes a live website');
  assert.match(entry.detail, /Backup:/);
});

test('an assigned user can deploy their own domain', async () => {
  const zip = makeZip([{ name: 'index.html', data: '<h1>by the customer</h1>' }]);
  const res = await postZip(`/domains/${ctx.domainId}/deployments`, zip, {}, member);
  assert.equal(res.status, 201);
  assert.equal(await onDisk('index.html'), '<h1>by the customer</h1>');
});

test('a deploy with no source at all is refused', async () => {
  const res = await admin(`/domains/${ctx.domainId}/deployments`, { method: 'POST', body: {} });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /zip file|repository URL/);
});

test('a zip and a repository together is refused rather than one being guessed', async () => {
  const zip = makeZip([{ name: 'index.html', data: 'x' }]);
  const res = await postZip(`/domains/${ctx.domainId}/deployments`, zip, {
    gitUrl: 'https://github.com/someone/site.git',
  });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /not both/);
});

test('a private or missing repository says so rather than hanging', async () => {
  // GIT_TERMINAL_PROMPT=0 is what turns "sit forever waiting for a password"
  // into an error somebody can read.
  const res = await admin(`/domains/${ctx.domainId}/deployments`, {
    method: 'POST',
    body: { gitUrl: 'https://github.com/this-user-does-not-exist-9f2b/nor-does-this.git' },
  });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /private|does not exist|Could not reach/i);
});
