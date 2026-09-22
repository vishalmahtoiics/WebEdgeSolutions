// Change alerts, against a real SMTP server.
//
// Two properties matter more than the rest, and both are the kind that only
// show up under failure:
//
//   An alert never costs you the action. A mail server that is down, slow or
//   rejecting must not turn "delete this DNS record" into an error — so there
//   is a test that points the portal at a server which refuses everything and
//   checks the work still happens.
//
//   An alert never costs you the record. The activity log is written before
//   any send is attempted, so a failed send leaves an entry that says why.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import { PrismaClient } from '@prisma/client';

const PORT = 3979;
const BASE = `http://127.0.0.1:${PORT}`;
const prisma = new PrismaClient();

const stamp = Date.now();
const DOMAIN = `alerts-${stamp}.example`;
const ALERT_TO = 'ops@example.com';
const SMTP_USER = 'portal@example.com';
const SMTP_PASS = 'SmtpPass!123';
const userEmail = `alerts+${stamp}@example.com`;
const userPassword = 'AlertUser@12345';

const PROVIDER_TOKEN = 'alerts-stub-token';
const LIVE_DOMAIN = `livealerts-${stamp}.example`;
/// The stub's zone, held as state so a delete really removes something.
let zone = [
  { name: '@', type: 'A', ttl: 3600, records: [{ content: '203.0.113.10' }] },
  { name: '@', type: 'MX', ttl: 3600, records: [{ content: 'mx1.example.com' }, { content: 'mx2.example.com' }] },
];

let smtpServer;
let refusingServer;
let providerStub;
let server;
const received = [];       // what the SMTP server actually accepted
let rejectEverything = false;

const admin = client();
const member = client();
const anon = client();
const ctx = {};
let originalSettings = null;

/// Swallows connection resets on a test stub.
///
/// The portal keeps connections alive to these servers, and killing it at the
/// end of the run resets them. Without a handler, that reset surfaces as an
/// uncaughtException and fails the whole file — after every test in it has
/// already passed.
const ignoreResets = (server) => {
  server.on('clientError', () => {});
  server.on('error', () => {});
  server.on('connection', (socket) => socket.on('error', () => {}));
  return server;
};

/// `Connection: close` on every request is not decoration.
///
/// Node's fetch keeps sockets alive between calls. Killing the spawned server
/// in `after` then resets them, and that reset surfaces as an uncaughtException
/// attributed to the `before` hook that opened them — failing the whole file
/// after every test in it has already passed. Closing each connection leaves
/// nothing to reset.
function client() {
  let cookie = '';
  return async function call(pathname, { method = 'GET', body } = {}) {
    const res = await fetch(`${BASE}${pathname}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        // See the note above `client`.
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
    return { status: res.status, data, text };
  };
}

/// Waits for a message whose subject matches.
///
/// Deliberately not a count. The whole suite shares one database and one
/// notification configuration, so while these tests run, other suites are
/// creating users and editing zones that also land in this inbox. A delta of
/// one is a claim about every test running at once; a matching subject is a
/// claim about this one.
async function waitForMailMatching(pattern, timeoutMs = 12000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const hit = [...received].reverse().find((m) => pattern.test(m.subject || ''));
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

/// The opposite: gives any alert time to arrive, then confirms none matched.
async function expectNoMailMatching(pattern, waitMs = 2000) {
  await new Promise((r) => setTimeout(r, waitMs));
  return !received.some((m) => pattern.test(m.subject || ''));
}

/// The activity entry for an event, once the notifier has finished with it.
async function waitForEntry(event, timeoutMs = 8000) {
  const until = Date.now() + timeoutMs;
  let entry = null;
  while (Date.now() < until) {
    entry = await prisma.activityLog.findFirst({ where: { event }, orderBy: { createdAt: 'desc' } });
    if (entry && (entry.notified || entry.notifyError !== null)) return entry;
    await new Promise((r) => setTimeout(r, 100));
  }
  return entry;
}

const configure = (body) => admin('/api/settings', { method: 'PUT', body });

test.before(async () => {
  smtpServer = new SMTPServer({
    disabledCommands: ['STARTTLS'],
    onAuth(auth, _session, callback) {
      if (auth.username === SMTP_USER && auth.password === SMTP_PASS) {
        return callback(null, { user: auth.username });
      }
      return callback(new Error('Invalid credentials'));
    },
    onData(stream, _session, callback) {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', async () => {
        if (rejectEverything) return callback(new Error('451 Try again later'));
        received.push(await simpleParser(Buffer.concat(chunks)));
        callback();
      });
    },
  });
  ignoreResets(smtpServer.server);
  await new Promise((r) => smtpServer.listen(0, '127.0.0.1', r));
  ctx.smtpPort = smtpServer.server.address().port;

  // A second server that refuses every connection, for the failure case.
  refusingServer = new SMTPServer({
    disabledCommands: ['STARTTLS'],
    onConnect(_session, callback) {
      callback(new Error('421 Service not available'));
    },
  });
  ignoreResets(refusingServer.server);
  await new Promise((r) => refusingServer.listen(0, '127.0.0.1', r));
  ctx.refusingPort = refusingServer.server.address().port;

  // A provider whose DNS zone can actually be written, so a live change —
  // the event people most want to hear about — can be made for real.
  providerStub = http.createServer(async (req, res) => {
    const send = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (req.headers.authorization !== `Bearer ${PROVIDER_TOKEN}`) return send(401, { message: 'bad token' });

    const path = req.url.split('?')[0];
    if (path === '/api/domains/v1/portfolio') {
      return send(200, [{ id: 701, domain: LIVE_DOMAIN, type: 'domain', status: 'active' }]);
    }
    if (path === '/api/hosting/v1/websites') return send(200, []);
    if (path === '/api/mail/v1/orders') return send(200, { data: [] });
    if (path === `/api/dns/v1/zones/${LIVE_DOMAIN}`) {
      if (req.method === 'GET') return send(200, zone);
      if (req.method === 'PUT') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        return req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
          if (Array.isArray(body.zone)) zone = body.zone;
          send(200, { success: true });
        });
      }
    }
    send(404, { message: 'not found' });
  });
  ignoreResets(providerStub);
  await new Promise((r) => providerStub.listen(0, '127.0.0.1', r));

  server = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOSTINGER_API_BASE_URL: `http://127.0.0.1:${providerStub.address().port}`,
      // The rest of the suite runs alongside this one and its activity lands
      // in the same inbox, so the burst cap is raised out of the way.
      NOTIFY_BURST_LIMIT: '100000',
    },
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

  originalSettings = await prisma.appSettings.findUnique({ where: { id: 'default' } });

  const domain = await admin('/api/domains', { method: 'POST', body: { name: DOMAIN } });
  ctx.domainId = domain.data.domain.id;

  const provider = await admin('/api/providers', {
    method: 'POST',
    body: { name: `Alerts stub ${stamp}`, adapter: 'hostinger', token: PROVIDER_TOKEN },
  });
  ctx.providerId = provider.data.provider.id;
  await admin(`/api/providers/${ctx.providerId}/sync`, { method: 'POST' });
  const live = await prisma.domain.findUnique({ where: { name: LIVE_DOMAIN } });
  ctx.liveDomainId = live.id;
  await admin(`/api/domains/${ctx.liveDomainId}/dns/sync`, { method: 'POST' });

  const user = await admin('/api/users', {
    method: 'POST',
    body: { name: 'Alert User', email: userEmail, password: userPassword, role: 'USER' },
  });
  ctx.userId = user.data.user.id;
  await admin(`/api/users/${ctx.userId}/domains`, { method: 'PUT', body: { domainIds: [ctx.domainId] } });
  await member('/api/auth/login', { method: 'POST', body: { email: userEmail, password: userPassword } });
});

test.after(async () => {
  try {
    if (ctx.userId) await admin(`/api/users/${ctx.userId}`, { method: 'DELETE' });
    if (ctx.providerId) await admin(`/api/providers/${ctx.providerId}`, { method: 'DELETE' });
    await prisma.domain.deleteMany({ where: { name: { in: [DOMAIN, LIVE_DOMAIN] } } });
    await prisma.activityLog.deleteMany({
      where: { OR: [{ domainName: DOMAIN }, { summary: { contains: String(stamp) } }] },
    });

    if (originalSettings) {
      const { id, updatedAt, ...rest } = originalSettings;
      await prisma.appSettings.update({ where: { id: 'default' }, data: rest });
    } else {
      await prisma.appSettings.deleteMany({ where: { id: 'default' } });
    }
    await prisma.$disconnect();
  } catch (err) {
    console.error('TEARDOWN:', err?.message);
  }
  server?.kill();
  await new Promise((r) => smtpServer.close(r));
  await new Promise((r) => refusingServer.close(r));
  await new Promise((r) => providerStub.close(r));
});

// --- Settings ---------------------------------------------------------------

test('the settings are closed to everyone but a Super Admin', async () => {
  assert.equal((await anon('/api/settings')).status, 401);
  assert.equal((await member('/api/settings')).status, 403);
  assert.equal((await member('/api/settings/activity')).status, 403);
  assert.equal((await member('/api/settings', { method: 'PUT', body: { notifyEmails: 'x@y.com' } })).status, 403);
});

test('alerts start switched off, so a fresh install sends nothing', async () => {
  const { status, data } = await admin('/api/settings');
  assert.equal(status, 200);
  assert.equal(data.settings.notifyEnabled, false);
});

test('a bad address is refused rather than silently dropped', async () => {
  for (const body of [
    { notifyEmails: 'not-an-email' },
    { notifyEmails: 'ok@example.com, broken' },
    { fromAddress: 'nope' },
  ]) {
    const res = await configure(body);
    assert.equal(res.status, 400, `${JSON.stringify(body)} should be refused`);
  }
});

test('the SMTP password is encrypted and never returned', async () => {
  const res = await configure({
    smtpHost: '127.0.0.1',
    smtpPort: ctx.smtpPort,
    smtpSecure: false,
    smtpUser: SMTP_USER,
    smtpPassword: SMTP_PASS,
    fromAddress: SMTP_USER,
    fromName: 'Hosting Portal',
    notifyEmails: ALERT_TO,
    notifyEnabled: true,
  });
  assert.equal(res.status, 200);
  assert.ok(!res.text.includes(SMTP_PASS), 'the password must not come back');
  assert.ok(!res.text.includes('smtpPassword'), 'nor the column');
  assert.equal(res.data.settings.hasSmtpPassword, true);

  const row = await prisma.appSettings.findUnique({ where: { id: 'default' } });
  assert.notEqual(row.smtpPassword, SMTP_PASS);
  assert.equal(row.smtpPassword.split(':').length, 3, 'stored as iv:tag:ciphertext');
});

test('a test email really arrives', async () => {
  const res = await admin('/api/settings/test-email', { method: 'POST' });
  assert.equal(res.status, 200);

  const mail = await waitForMailMatching(/Test alert/i);
  assert.ok(mail, 'the SMTP server should have taken it');
  assert.equal(mail.to.value[0].address, ALERT_TO);
  assert.equal(mail.from.value[0].address, SMTP_USER);
  assert.match(mail.text, /notifications are working/i);
});

test('a test against a server that refuses says why', async () => {
  await configure({ smtpHost: '127.0.0.1', smtpPort: ctx.refusingPort });
  const res = await admin('/api/settings/test-email', { method: 'POST' });
  assert.equal(res.status, 400);
  assert.ok(res.data.error.length > 10, `expected an explanation, got "${res.data.error}"`);

  await configure({ smtpHost: '127.0.0.1', smtpPort: ctx.smtpPort });
});

// --- Alerts on real changes -------------------------------------------------

test('a portal-only DNS record is not alerted on, because nothing resolved differently', async () => {
  const before = received.length;
  const res = await admin(`/api/domains/${ctx.domainId}/dns`, {
    method: 'POST',
    body: { name: 'www', type: 'A', content: '203.0.113.10', ttl: 3600 },
  });
  assert.equal(res.status, 201);

  // This domain has no provider, so the record is local — and a local record
  // is not a change to the internet, so it is not alerted on.
  const entry = await prisma.activityLog.findFirst({
    where: { event: 'dns.record.created', domainName: DOMAIN },
  });
  assert.equal(entry, null, 'a portal-only record is not worth an alert');
  assert.ok(await expectNoMailMatching(new RegExp(DOMAIN.replace(/\./g, '\\.'))), 'and nothing was sent');
});

test('removing only the portal\u2019s record of a mailbox is not alerted on either', async () => {
  const mailbox = await prisma.emailAccount.create({
    data: { domainId: ctx.domainId, address: `info@${DOMAIN}`, status: 'active' },
  });

  // This route removes only the portal's record — the real mailbox at the
  // provider is untouched — so there is nothing for anyone to be alerted to.
  await admin(`/api/domains/${ctx.domainId}/emails/${mailbox.id}`, { method: 'DELETE' });
  assert.ok(await expectNoMailMatching(new RegExp(`info@${DOMAIN.replace(/\./g, '\\.')}`)));
});


test('a change to a live DNS zone is alerted on, naming what changed', async () => {
  const res = await admin(`/api/domains/${ctx.liveDomainId}/dns`, {
    method: 'POST',
    body: { name: 'shop', type: 'A', content: '203.0.113.77', ttl: 3600 },
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.live, true, 'this one really reached the zone');

  const mail = await waitForMailMatching(
    new RegExp(`Added a A record to the live DNS zone on ${LIVE_DOMAIN.replace(/\./g, '\\.')}`),
  );
  assert.ok(mail, 'a live DNS change should alert');
  assert.match(mail.text, /shop A → 203\.0\.113\.77/);
  assert.match(mail.text, /admin@example\.com/);
});

test('deleting an MX record says in the subject that it can break email', async () => {
  const row = await prisma.dnsRecord.findFirst({
    where: { domainId: ctx.liveDomainId, type: 'MX', content: 'mx2.example.com' },
  });
  assert.ok(row, 'the MX record was imported');

  const res = await admin(`/api/domains/${ctx.liveDomainId}/dns/${row.id}`, { method: 'DELETE' });
  assert.equal(res.status, 200);

  // The subject is what gets read on a phone, so the consequence belongs there
  // rather than three lines into the body.
  assert.ok(await waitForMailMatching(/can break email/), 'the MX warning should be in the subject');
  assert.ok(
    !zone.some((g) => g.records.some((r) => r.content === 'mx2.example.com')),
    'and it really went from the zone',
  );
});

test('creating and deleting an account sends an alert each time', async () => {
  const created = await admin('/api/users', {
    method: 'POST',
    body: { name: `Temp ${stamp}`, email: `temp+${stamp}@example.com`, password: 'TempPass@12345', role: 'USER' },
  });
  assert.equal(created.status, 201);

  const mail = await waitForMailMatching(new RegExp(`Created the account temp\\+${stamp}@example\\.com`));
  assert.ok(mail, 'creating an account should alert');
  assert.match(mail.text, /Super Admin/, 'the alert says who did it');
  assert.match(mail.text, /Event: {2}user\.created/);

  await admin(`/api/users/${created.data.user.id}`, { method: 'DELETE' });
  assert.ok(
    await waitForMailMatching(new RegExp(`Deleted the account temp\\+${stamp}@example\\.com`)),
    'deleting should alert too',
  );
});

test('a failed sign-in is alerted on, without the password in it', async () => {
  const attacker = client();

  const res = await attacker('/api/auth/login', {
    method: 'POST',
    body: { email: userEmail, password: 'CorrectHorseBatteryStaple' },
  });
  assert.equal(res.status, 401);

  const mail = await waitForMailMatching(new RegExp(`Failed sign-in for ${userEmail.replace('+', '\\+')}`));
  assert.ok(mail, 'a failed sign-in should alert');
  // The address tried is worth recording. The password never is.
  assert.ok(!mail.text.includes('CorrectHorseBatteryStaple'), 'the password must never be in an alert');
  assert.match(mail.text, /The account exists and the password was wrong/);
});

test('a new order from the public site is alerted on, with the contact details', async () => {
  const plan = await prisma.plan.create({
    data: { slug: `alerts-plan-${stamp}`, name: `Alert Plan ${stamp}`, priceMinor: 99900, features: [] },
  });
  await prisma.storeSettings.upsert({
    where: { id: 'default' },
    create: { id: 'default', isOpen: true },
    update: { isOpen: true },
  });

  const res = await anon('/api/store/orders', {
    method: 'POST',
    body: {
      kind: 'HOSTING',
      planId: plan.id,
      customerName: 'Priya Nair',
      customerEmail: 'priya@example.com',
      customerPhone: '+919876543210',
      message: 'Please call me in the evening.',
    },
  });
  assert.equal(res.status, 201);

  const mail = await waitForMailMatching(new RegExp(`New order ${res.data.reference}`));
  assert.ok(mail, 'a new order should alert');
  assert.match(mail.subject, /₹999/);
  // An order comes from a stranger, so the alert carries how to reach them.
  assert.match(mail.text, /Priya Nair/);
  assert.match(mail.text, /\+919876543210/);
  assert.match(mail.text, /Please call me in the evening/);
  assert.match(mail.text, /Nothing is paid yet/);

  await prisma.order.deleteMany({ where: { reference: res.data.reference } });
  await prisma.plan.delete({ where: { id: plan.id } });
});

// --- Switches ---------------------------------------------------------------

test('an area switched off stops its alerts but keeps its record', async () => {
  await configure({ notifyUsers: false });

  const created = await admin('/api/users', {
    method: 'POST',
    body: { name: `Quiet ${stamp}`, email: `quiet+${stamp}@example.com`, password: 'QuietPass@12345', role: 'USER' },
  });
  assert.equal(created.status, 201);

  const entry = await waitForEntry('user.created');
  assert.ok(entry, 'the change is still recorded');
  assert.equal(entry.notified, false, 'but no alert went out');
  assert.ok(
    await expectNoMailMatching(new RegExp(`quiet\\+${stamp}@example\\.com`)),
    'nothing about it reached the mail server',
  );

  await admin(`/api/users/${created.data.user.id}`, { method: 'DELETE' });
  await configure({ notifyUsers: true });
});

test('the master switch stops everything', async () => {
  await configure({ notifyEnabled: false });

  const created = await admin('/api/users', {
    method: 'POST',
    body: { name: `Off ${stamp}`, email: `off+${stamp}@example.com`, password: 'OffPass@12345', role: 'USER' },
  });
  assert.ok(await expectNoMailMatching(new RegExp(`off\\+${stamp}@example\\.com`)));

  await admin(`/api/users/${created.data.user.id}`, { method: 'DELETE' });
  await configure({ notifyEnabled: true });
});

// --- Failure --------------------------------------------------------------

test('a mail server that is down never breaks the action it was reporting', async () => {
  await configure({ smtpHost: '127.0.0.1', smtpPort: ctx.refusingPort });

  // The work must go through exactly as it would with no mail server at all.
  const created = await admin('/api/users', {
    method: 'POST',
    body: { name: `Resilient ${stamp}`, email: `resilient+${stamp}@example.com`, password: 'Resilient@12345', role: 'USER' },
  });
  assert.equal(created.status, 201, 'the account was still created');

  const user = await prisma.user.findUnique({ where: { email: `resilient+${stamp}@example.com` } });
  assert.ok(user, 'and it is really there');

  // And the failure is recorded rather than lost, so "I never got an alert"
  // has an answer.
  const entry = await waitForEntry('user.created');
  assert.equal(entry.notified, false);
  assert.ok(entry.notifyError, 'the reason is on the entry');

  await admin(`/api/users/${user.id}`, { method: 'DELETE' });
  await configure({ smtpHost: '127.0.0.1', smtpPort: ctx.smtpPort });
});

test('a mail server that rejects the message is recorded the same way', async () => {
  rejectEverything = true;
  try {
    const created = await admin('/api/users', {
      method: 'POST',
      body: { name: `Rejected ${stamp}`, email: `rejected+${stamp}@example.com`, password: 'Rejected@12345', role: 'USER' },
    });
    assert.equal(created.status, 201);

    const entry = await waitForEntry('user.created');
    assert.equal(entry.notified, false);
    assert.ok(entry.notifyError);

    await admin(`/api/users/${created.data.user.id}`, { method: 'DELETE' });
  } finally {
    rejectEverything = false;
  }
});

// --- The feed ---------------------------------------------------------------

test('the activity feed shows what happened, newest first', async () => {
  const { status, data } = await admin('/api/settings/activity?take=30');
  assert.equal(status, 200);
  assert.ok(data.entries.length > 0);

  const times = data.entries.map((e) => new Date(e.createdAt).getTime());
  assert.deepEqual(times, [...times].sort((a, b) => b - a), 'newest first');

  // Undelivered alerts are counted, so a broken mail server is visible.
  assert.equal(typeof data.undelivered, 'number');
  assert.ok(data.undelivered >= 0, 'undelivered alerts are counted');
});

test('the feed can be narrowed to one area', async () => {
  const { data } = await admin('/api/settings/activity?event=security');
  assert.ok(data.entries.length > 0);
  assert.ok(data.entries.every((e) => e.event.startsWith('security')));
});

test('an entry keeps who did it, in words, so it survives the account', async () => {
  const { data } = await admin('/api/settings/activity?event=user&take=50');
  const entry = data.entries.find((e) => e.actorLabel);
  assert.ok(entry, 'an entry names its actor');
  assert.match(entry.actorLabel, /admin@example\.com/);
  assert.equal(entry.actorRole, 'SUPER_ADMIN');
});
