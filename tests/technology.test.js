// Working out what a site is built on, exercised for real.
//
// The filesystem half runs against a real FTP server holding real WordPress,
// Laravel, Next.js, static and plain-PHP trees. The homepage half runs against
// a real HTTP server serving the markup and headers those platforms actually
// send. Nothing here is mocked, because the whole point of the feature is that
// the answer is evidence rather than a guess.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { FtpSrv } from 'ftp-srv';
import { PrismaClient } from '@prisma/client';
import { detectFromSite, detectTechnology } from '../src/lib/technology.js';

process.on('unhandledRejection', (err) => console.error('UNHANDLED REJECTION:', err));

const PORT = 3994;
const BASE = `http://127.0.0.1:${PORT}`;
const FTP_USER = 'siteuser';
const FTP_PASS = 'sitepass';
const prisma = new PrismaClient();

const stamp = Date.now();
// .example is reserved by RFC 2606 and never resolves, which is what keeps
// these tests from reaching the real internet.
const WP = `wp-${stamp}.example`;
const LARAVEL = `laravel-${stamp}.example`;
const NEXT = `next-${stamp}.example`;
const STATIC = `static-${stamp}.example`;
const PHP = `php-${stamp}.example`;
const BARE = `bare-${stamp}.example`;
const NOFTP = `noftp-${stamp}.example`;
const userEmail = `tech+${stamp}@example.com`;
const userPassword = 'TechUser@12345';

const ftpLog = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} };
ftpLog.child = () => ftpLog;

let sandbox;
let ftpServer;
let siteServer;
let sitePort;
let server;
/// What the fake website replies with. Swapped per test.
let respond = (_req, res) => res.end('');

const admin = client();
const member = client();
const ctx = {};

function client() {
  let cookie = '';
  return async function call(pathname, { method = 'GET', body } = {}) {
    const res = await fetch(`${BASE}/api${pathname}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
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
    return { status: res.status, data, text };
  };
}

const write = async (file, content) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
};

test.before(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'tech-'));

  // A WordPress install, as one actually looks on disk.
  await write(path.join(sandbox, 'wp', 'wp-config.php'), "<?php define('DB_NAME', 'wp');");
  await write(path.join(sandbox, 'wp', 'index.php'), "<?php require __DIR__ . '/wp-blog-header.php';");
  await fs.mkdir(path.join(sandbox, 'wp', 'wp-content', 'themes'), { recursive: true });
  await write(
    path.join(sandbox, 'wp', 'wp-includes', 'version.php'),
    "<?php\n$wp_version = '6.5.2';\n$wp_db_version = 57155;\n",
  );

  // Laravel.
  await write(path.join(sandbox, 'laravel', 'artisan'), '#!/usr/bin/env php');
  await write(
    path.join(sandbox, 'laravel', 'composer.json'),
    JSON.stringify({ require: { php: '^8.2', 'laravel/framework': '^11.9' } }),
  );
  await fs.mkdir(path.join(sandbox, 'laravel', 'app'), { recursive: true });

  // Next.js.
  await write(path.join(sandbox, 'next', 'next.config.js'), 'module.exports = {};');
  await write(
    path.join(sandbox, 'next', 'package.json'),
    JSON.stringify({ dependencies: { next: '14.2.3', react: '18.3.1' } }),
  );

  // A hand-built static site, and a hand-built PHP site.
  await write(path.join(sandbox, 'static', 'index.html'), '<!doctype html><h1>Hello</h1>');
  await write(path.join(sandbox, 'static', 'style.css'), 'body{}');
  await write(path.join(sandbox, 'php', 'index.php'), '<?php echo "hi";');
  await write(path.join(sandbox, 'php', 'db.php'), '<?php // connection');

  // Nothing identifiable at all.
  await write(path.join(sandbox, 'bare', 'notes.txt'), 'nothing to see');

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

  siteServer = http.createServer((req, res) => respond(req, res));
  await new Promise((r) => siteServer.listen(0, '127.0.0.1', r));
  sitePort = siteServer.address().port;

  server = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  for (let i = 0; i < 80; i += 1) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  await admin('/auth/login', { method: 'POST', body: { email: 'admin@example.com', password: 'Admin@12345' } });

  const ftpFor = (root) => ({
    ftpHost: '127.0.0.1',
    ftpPort,
    ftpUsername: FTP_USER,
    ftpPassword: FTP_PASS,
    ftpProtocol: 'FTP',
    ftpRootPath: root,
  });

  for (const [name, root] of [
    [WP, '/wp'], [LARAVEL, '/laravel'], [NEXT, '/next'],
    [STATIC, '/static'], [PHP, '/php'], [BARE, '/bare'],
  ]) {
    const created = await admin('/domains', { method: 'POST', body: { name } });
    ctx[name] = created.data.domain.id;
    await admin(`/domains/${ctx[name]}/settings`, { method: 'PUT', body: ftpFor(root) });
  }

  // A domain with no file access at all, to prove the fallback explains itself.
  const noftp = await admin('/domains', { method: 'POST', body: { name: NOFTP } });
  ctx[NOFTP] = noftp.data.domain.id;

  const created = await admin('/users', {
    method: 'POST',
    body: { name: 'Tech User', email: userEmail, password: userPassword, role: 'USER' },
  });
  ctx.userId = created.data.user.id;
  await admin(`/users/${ctx.userId}/domains`, { method: 'PUT', body: { domainIds: [ctx[WP]] } });
  await member('/auth/login', { method: 'POST', body: { email: userEmail, password: userPassword } });
});

test.after(async () => {
  try {
    if (ctx.userId) await admin(`/users/${ctx.userId}`, { method: 'DELETE' });
    await prisma.domain.deleteMany({
      where: { name: { in: [WP, LARAVEL, NEXT, STATIC, PHP, BARE, NOFTP] } },
    });
    await prisma.$disconnect();
  } catch (err) {
    console.error('TEARDOWN:', err?.message);
  }
  server?.kill();
  await new Promise((r) => siteServer.close(r));
  await ftpServer.close();
  await fs.rm(sandbox, { recursive: true, force: true });
});

const detect = (client_, name) => client_(`/domains/${ctx[name]}/technology/detect`, { method: 'POST' });

// --- Reading the filesystem -------------------------------------------------

test('WordPress is identified from the files, down to the version', async () => {
  const { status, data } = await detect(admin, WP);
  if (status !== 200) console.error('DEBUG:', JSON.stringify(data));
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.technology.name, 'WordPress');
  assert.equal(data.technology.version, '6.5.2', 'read out of wp-includes/version.php');
  assert.equal(data.technology.source, 'files');
  assert.equal(data.technology.confidence, 'confirmed');
});

test('the answer carries the evidence that produced it', async () => {
  const { data } = await detect(admin, WP);
  assert.match(data.technology.evidence, /wp-config\.php/);
  assert.match(data.message, /This site is WordPress 6\.5\.2/);
});

test('Laravel is identified, with the version off composer.json', async () => {
  const { data } = await detect(admin, LARAVEL);
  assert.equal(data.technology.name, 'Laravel');
  // "^11.9" is a constraint; the caret is not part of a version number.
  assert.equal(data.technology.version, '11.9');
  assert.match(data.technology.evidence, /artisan/);
});

test('Next.js is identified', async () => {
  const { data } = await detect(admin, NEXT);
  assert.equal(data.technology.name, 'Next.js');
  assert.equal(data.technology.version, '14.2.3');
});

test('a hand-built site is called a static site, not a CMS', async () => {
  const { data } = await detect(admin, STATIC);
  assert.equal(data.technology.name, 'Static site');
  assert.equal(data.technology.confidence, 'likely', 'this one is read off a listing, not proven');
  assert.match(data.technology.evidence, /index\.html/);
});

test('an unrecognised PHP site is called PHP rather than guessed at', async () => {
  const { data } = await detect(admin, PHP);
  assert.equal(data.technology.name, 'PHP');
  assert.equal(data.technology.confidence, 'likely');
  assert.match(data.technology.evidence, /\.php/);
});

test('when nothing is recognisable it says so, and says what it tried', async () => {
  const { status, data } = await detect(admin, BARE);
  assert.equal(status, 200);
  assert.equal(data.ok, false);
  assert.equal(data.technology, null);
  assert.match(data.message, /Could not tell/i);

  const sources = data.attempts.map((a) => a.source);
  assert.ok(sources.includes('files'), 'the files were looked at');
  assert.ok(sources.includes('site'), 'and then the homepage');
});

test('a domain with no file access explains that, rather than just failing', async () => {
  const { data } = await detect(admin, NOFTP);
  assert.equal(data.ok, false);
  const files = data.attempts.find((a) => a.source === 'files');
  assert.match(files.message, /No file access is configured/i);
});

// --- Storing and showing ----------------------------------------------------

test('what was detected is stored and shows up on the domain', async () => {
  const { data } = await admin(`/domains/${ctx[WP]}`);
  assert.equal(data.domain.technology.name, 'WordPress');
  assert.equal(data.domain.technology.version, '6.5.2');
  assert.ok(data.domain.technology.checkedAt, 'and when it was checked');
});

test('it appears in the domain list too', async () => {
  const { data } = await admin('/domains');
  const row = data.domains.find((d) => d.name === LARAVEL);
  assert.equal(row.technology.name, 'Laravel');
});

// --- The administrator's own answer -----------------------------------------

test('an admin can override what was detected', async () => {
  const res = await admin(`/domains/${ctx[WP]}/technology`, {
    method: 'PUT',
    body: { name: 'WordPress (managed)', version: '6.5' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.technology.name, 'WordPress (managed)');
  assert.equal(res.data.technology.source, 'manual');

  const { data } = await admin(`/domains/${ctx[WP]}`);
  assert.equal(data.domain.technology.name, 'WordPress (managed)');
  assert.equal(data.domain.usesCustomTech, true);
  // The real answer is still on file underneath it.
  assert.equal(data.domain.detectedTech, 'WordPress');
  assert.equal(data.domain.detectedTechVersion, '6.5.2');
});

test('detecting again does not wipe the override', async () => {
  await detect(admin, WP);
  const { data } = await admin(`/domains/${ctx[WP]}`);
  assert.equal(data.domain.technology.name, 'WordPress (managed)', 'the override still stands');
  assert.equal(data.domain.detectedTech, 'WordPress', 'and detection still updated its own column');
});

test('clearing the override brings back the detected value, unchanged', async () => {
  const res = await admin(`/domains/${ctx[WP]}/technology`, { method: 'PUT', body: { name: '' } });
  assert.equal(res.status, 200);
  assert.equal(res.data.technology.name, 'WordPress');
  assert.equal(res.data.technology.version, '6.5.2');

  const { data } = await admin(`/domains/${ctx[WP]}`);
  assert.equal(data.domain.usesCustomTech, false);
  assert.equal(data.domain.techOverride, null);
});

// --- Who can do what --------------------------------------------------------

test('a user can detect the technology of their own domain', async () => {
  const { status, data } = await detect(member, WP);
  assert.equal(status, 200);
  assert.equal(data.technology.name, 'WordPress');
});

test('a user cannot touch a domain they are not assigned', async () => {
  const res = await member(`/domains/${ctx[LARAVEL]}/technology/detect`, { method: 'POST' });
  assert.equal(res.status, 404, 'a 404, so ids cannot be probed');
});

test('a user cannot set the override', async () => {
  const res = await member(`/domains/${ctx[WP]}/technology`, {
    method: 'PUT',
    body: { name: 'Something else' },
  });
  assert.equal(res.status, 403);
});

test('nothing a user sees here names the provider', async () => {
  const provider = (await admin('/providers')).data.providers[0];
  const name = provider?.name || 'Hostinger';

  for (const path_ of [`/domains/${ctx[WP]}`, '/domains']) {
    const res = await member(path_);
    assert.ok(!res.text.toLowerCase().includes(name.toLowerCase()), `${path_} leaked the provider`);
    assert.ok(!res.text.toLowerCase().includes('hostinger'), `${path_} leaked the provider`);
  }

  const detected = await detect(member, WP);
  assert.ok(!detected.text.toLowerCase().includes('hostinger'));
  // And the user is told where the answer came from in their own terms.
  assert.equal(detected.data.technology.source, 'files');
});

// --- Reading the site itself ------------------------------------------------

const site = (handler) => {
  respond = handler;
  return detectFromSite(`127.0.0.1:${sitePort}`, { allowPrivate: true });
};

const html = (body) => (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(body);
};

test('a generator tag is taken at its word, version and all', async () => {
  const result = await site(
    html('<html><head><meta name="generator" content="WordPress 6.5.2" /></head><body>Hi</body></html>'),
  );
  assert.equal(result.name, 'WordPress');
  assert.equal(result.version, '6.5.2');
  assert.equal(result.source, 'site');
  assert.match(result.evidence, /generated by "WordPress 6\.5\.2"/);
});

test('Drupal and Joomla generators are recognised as well', async () => {
  const drupal = await site(html('<meta name="generator" content="Drupal 10 (https://www.drupal.org)">'));
  assert.equal(drupal.name, 'Drupal');

  const joomla = await site(html('<meta name="generator" content="Joomla! - Open Source Content Management">'));
  assert.equal(joomla.name, 'Joomla');
});

test('a WordPress asset path is evidence, and is labelled as only that', async () => {
  const result = await site(html('<html><body><img src="/wp-content/uploads/logo.png"></body></html>'));
  assert.equal(result.name, 'WordPress');
  assert.equal(result.confidence, 'likely', 'inferred from a URL, not proven');
  assert.match(result.evidence, /wp-content/);
});

test('a response header can give it away too', async () => {
  const result = await site((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html', 'x-shopid': '12345678' });
    res.end('<html><body>Shop</body></html>');
  });
  assert.equal(result.name, 'Shopify');
  assert.match(result.evidence, /x-shopid/);
});

test('with no platform markers it falls back to what the server admits', async () => {
  const result = await site((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html', 'x-powered-by': 'PHP/8.2.12' });
    res.end('<html><body>Custom</body></html>');
  });
  assert.equal(result.name, 'PHP');
  assert.equal(result.version, '8.2.12');
  assert.equal(result.confidence, 'likely');
});

test('plain HTML with nothing to go on is called a static site', async () => {
  const result = await site(html('<html><body><h1>Just a page</h1></body></html>'));
  assert.equal(result.name, 'Static site');
  assert.equal(result.confidence, 'likely');
});

test('redirects are followed to the page that answers', async () => {
  let hits = 0;
  const result = await site((req, res) => {
    hits += 1;
    if (req.url === '/') {
      res.writeHead(302, { Location: `http://127.0.0.1:${sitePort}/home` });
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<meta name="generator" content="Ghost 5.0">');
  });
  assert.equal(result.name, 'Ghost');
  assert.equal(hits, 2, 'one redirect, one page');
});

test('a redirect loop is abandoned rather than followed forever', async () => {
  let hits = 0;
  respond = (_req, res) => {
    hits += 1;
    res.writeHead(302, { Location: `http://127.0.0.1:${sitePort}/again` });
    res.end();
  };
  await assert.rejects(
    () => detectFromSite(`127.0.0.1:${sitePort}`, { allowPrivate: true }),
    /Too many redirects/,
  );
  assert.ok(hits <= 10, `stopped after ${hits} requests rather than looping`);
});

// --- Where it will not go ---------------------------------------------------

test('the portal will not fetch anything that is not on the public web', async () => {
  for (const host of ['127.0.0.1', 'localhost', 'router.local', 'db.internal', '10.0.0.5']) {
    const { result, attempts } = await detectTechnology({ domainName: host, ftpSettings: null });
    assert.equal(result, null, `${host} should not have been fetched`);
    const siteAttempt = attempts.find((a) => a.source === 'site');
    assert.match(siteAttempt.message, /not on the public web/i, `${host} was not refused`);
  }
});
