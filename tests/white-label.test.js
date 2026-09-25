// What a customer may see, and what they may change.
//
// The hosting provider is never named to a customer: not in a DNS record
// pointing at its mail servers, not in an error its API wrote. What is
// stored, and what is written to the real zone, is untouched — so the other
// half of these tests is that a customer saving a record they were shown
// under our name writes the provider's real name back.
//
// Then the plan: a mailbox's size is the Super Admin's to set, and so is how
// many mailboxes a customer may have. At the limit, the customer can ask
// for more, and that request reaches the Super Admin.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { maskText, maskError, unmaskAgainst } from '../src/lib/whiteLabel.js';

const TOKEN = 'white-label-token';
const PORT = 3979;
const BASE = `http://127.0.0.1:${PORT}`;
const prisma = new PrismaClient();

const stamp = Date.now();
const LIVE = `wl-live-${stamp}.example`;
const ELSEWHERE = `wl-elsewhere-${stamp}.example`;
const userEmail = `wl+${stamp}@example.com`;
const userPassword = 'WhiteLabel@12345';

/// A zone full of the provider's own names, the way a real one is.
let zone;
const freshZone = () => [
  { name: '@', type: 'A', ttl: 3600, records: [{ content: '203.0.113.10', isDisabled: false }] },
  { name: 'mail', type: 'CNAME', ttl: 3600, records: [{ content: 'mx1.hostinger.com', isDisabled: false }] },
  { name: 'cdn', type: 'CNAME', ttl: 3600, records: [{ content: 'site-1.hstgr.io', isDisabled: false }] },
  {
    name: '@',
    type: 'TXT',
    ttl: 3600,
    records: [{ content: '"v=spf1 include:_spf.mail.hostinger.com ~all"', isDisabled: false }],
  },
];

let stub;
let server;
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

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString() || 'null'));
      } catch {
        resolve(null);
      }
    });
  });

test.before(async () => {
  zone = freshZone();
  stub = http.createServer(async (req, res) => {
    const send = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: 'Invalid or expired API token.' });
    const path = req.url.split('?')[0];

    if (path === '/api/domains/v1/portfolio') {
      return send(200, [
        { id: 1, domain: LIVE, type: 'domain', status: 'active' },
        { id: 2, domain: ELSEWHERE, type: 'domain', status: 'active' },
      ]);
    }
    if (path === '/api/hosting/v1/websites') return send(200, []);
    if (path === '/api/mail/v1/orders') return send(200, { data: [] });

    if (path === `/api/dns/v1/zones/${LIVE}`) {
      if (req.method === 'GET') return send(200, zone);
      if (req.method === 'PUT') {
        const body = await readBody(req);
        if (Array.isArray(body?.zone)) zone = body.zone;
        return send(200, { success: true });
      }
    }
    // Word for word what the real API says about a domain it does not hold.
    if (path === `/api/dns/v1/zones/${ELSEWHERE}`) {
      return send(422, { message: '[Domains:2006] Domain is not registered at Hostinger.' });
    }
    send(404, { message: 'Not found' });
  });
  stub.on('connection', (s) => s.on('error', () => {}));
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));

  server = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: String(PORT), HOSTINGER_API_BASE_URL: `http://127.0.0.1:${stub.address().port}` },
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
  const provider = await admin('/providers', {
    method: 'POST',
    body: { name: `White label ${stamp}`, adapter: 'hostinger', token: TOKEN },
  });
  ctx.providerId = provider.data.provider.id;
  await admin(`/providers/${ctx.providerId}/sync`, { method: 'POST' });

  ctx.liveId = (await prisma.domain.findUnique({ where: { name: LIVE } })).id;
  ctx.elsewhereId = (await prisma.domain.findUnique({ where: { name: ELSEWHERE } })).id;
  await admin(`/domains/${ctx.liveId}/dns/sync`, { method: 'POST' });

  const created = await admin('/users', {
    method: 'POST',
    body: { name: 'Label User', email: userEmail, password: userPassword, role: 'USER' },
  });
  ctx.userId = created.data.user.id;
  await admin(`/users/${ctx.userId}/domains`, { method: 'PUT', body: { domainIds: [ctx.liveId, ctx.elsewhereId] } });
  await member('/auth/login', { method: 'POST', body: { email: userEmail, password: userPassword } });
});

test.after(async () => {
  try {
    if (ctx.userId) await admin(`/users/${ctx.userId}`, { method: 'DELETE' });
    if (ctx.providerId) await admin(`/providers/${ctx.providerId}`, { method: 'DELETE' });
    await prisma.domain.deleteMany({ where: { name: { in: [LIVE, ELSEWHERE] } } });
    await prisma.$disconnect();
  } catch (err) {
    console.error('TEARDOWN:', err?.message);
  }
  server?.kill();
  stub?.close();
});

const zoneHas = (content) => zone.some((g) => g.records.some((r) => r.content === content));

// --- The wording, on its own ------------------------------------------------

test('a provider hostname reads as ours, and stays a hostname', () => {
  assert.equal(maskText('mx1.hostinger.com'), 'mx1.webedgesolutions.com');
  assert.equal(maskText('site-1.hstgr.io'), 'site-1.webds.io');
  assert.equal(maskText('abuse@hostinger.com'), 'abuse@webedgesolutions.com');
});

test('the provider named in a sentence reads as our business name', () => {
  assert.equal(
    maskError('[Domains:2006] Domain is not registered at Hostinger.'),
    'Domain is not registered at WebEdge Solutions.',
  );
});

test('only names a customer could have been shown are translated back', () => {
  const known = ['mx1.hostinger.com'];
  assert.equal(unmaskAgainst('mx1.webedgesolutions.com', known), 'mx1.hostinger.com');
  assert.equal(unmaskAgainst('www.webedgesolutions.in', known), 'www.webedgesolutions.in');
});

// --- What a customer reads --------------------------------------------------

test('a customer never sees the provider in DNS records', async () => {
  const { status, text, data } = await member(`/domains/${ctx.liveId}`);
  assert.equal(status, 200);
  assert.ok(!/hostinger|hstgr/i.test(text), 'the provider appears nowhere in the response');
  const contents = data.dnsRecords.map((r) => r.content);
  assert.ok(contents.includes('mx1.webedgesolutions.com'));
  assert.ok(contents.includes('site-1.webds.io'));
});

test('the Super Admin still sees the real names', async () => {
  const { data } = await admin(`/domains/${ctx.liveId}`);
  const contents = data.dnsRecords.map((r) => r.content);
  assert.ok(contents.includes('mx1.hostinger.com'));
  assert.ok(contents.includes('site-1.hstgr.io'));
});

test("the provider's error reaches a customer without its name or code", async () => {
  const user = await member(`/domains/${ctx.elsewhereId}/refresh`, { method: 'POST' });
  assert.ok(!/hostinger|hstgr|\[Domains:/i.test(user.text), `leaked: ${user.text}`);

  // And the Super Admin gets the provider's own words, which they need.
  const own = await admin(`/domains/${ctx.elsewhereId}/dns/sync`, { method: 'POST' });
  assert.match(own.text, /Hostinger/);
});

// --- What a customer writes -------------------------------------------------

test('saving a record as shown writes the real provider name back', async () => {
  const shown = (await member(`/domains/${ctx.liveId}`)).data.dnsRecords.find(
    (r) => r.content === 'mx1.webedgesolutions.com',
  );
  const res = await member(`/domains/${ctx.liveId}/dns/${shown.id}`, {
    method: 'PUT',
    body: { name: shown.name, type: shown.type, content: shown.content, ttl: 1800 },
  });
  assert.equal(res.status, 200, res.text);
  assert.ok(zoneHas('mx1.hostinger.com'), 'the zone still points at the real server');
  assert.ok(!zoneHas('mx1.webedgesolutions.com'), 'the name the customer saw was never written');
});

test('editing an SPF record keeps the real include and adds what was typed', async () => {
  const shown = (await member(`/domains/${ctx.liveId}`)).data.dnsRecords.find((r) => r.type === 'TXT');
  assert.match(shown.content, /_spf\.mail\.webedgesolutions\.com/);

  const content = shown.content.replace(' ~all', ' include:spf.example.net ~all');
  const res = await member(`/domains/${ctx.liveId}/dns/${shown.id}`, {
    method: 'PUT',
    body: { name: shown.name, type: 'TXT', content, ttl: 3600 },
  });
  assert.equal(res.status, 200, res.text);
  const txt = zone.find((g) => g.type === 'TXT').records[0].content;
  assert.match(txt, /include:_spf\.mail\.hostinger\.com/);
  assert.match(txt, /include:spf\.example\.net/);
  assert.ok(!/webedgesolutions/.test(txt));
});

// --- Mailbox size and the plan's limit --------------------------------------

test("a customer cannot change a mailbox's size", async () => {
  const added = await admin(`/domains/${ctx.liveId}/emails`, {
    method: 'POST',
    body: { address: `info@${LIVE}`, quotaMb: 1024 },
  });
  ctx.mailboxId = added.data.email.id;

  const res = await member(`/domains/${ctx.liveId}/emails/${ctx.mailboxId}`, {
    method: 'PUT',
    body: { address: `info@${LIVE}`, quotaMb: 999999 },
  });
  assert.equal(res.status, 403);

  const row = await prisma.emailAccount.findUnique({ where: { id: ctx.mailboxId } });
  assert.equal(row.quotaMbOverride ?? row.providerQuotaMb, 1024);
});

test('a customer can still keep a note on a mailbox, and only the note changes', async () => {
  const res = await member(`/domains/${ctx.liveId}/emails/${ctx.mailboxId}`, {
    method: 'PUT',
    body: { address: `changed@${LIVE}`, status: 'suspended', notes: 'Used by the front desk' },
  });
  assert.equal(res.status, 200, res.text);
  const row = await prisma.emailAccount.findUnique({ where: { id: ctx.mailboxId } });
  assert.equal(row.notes, 'Used by the front desk');
  assert.equal(row.address, `info@${LIVE}`, 'the address is not the customer’s to change');
  assert.equal(row.status, 'active');
});

test('only the Super Admin sets how many mailboxes a plan includes', async () => {
  const user = await member(`/domains/${ctx.liveId}/mailbox-limit`, { method: 'PUT', body: { max: 100 } });
  assert.equal(user.status, 403);

  const own = await admin(`/domains/${ctx.liveId}/mailbox-limit`, { method: 'PUT', body: { max: 2 } });
  assert.equal(own.status, 200);
  assert.deepEqual(own.data.mailboxLimit, { max: 2, used: 1, remaining: 1 });

  const seen = await member(`/domains/${ctx.liveId}`);
  assert.deepEqual(seen.data.mailboxLimit, { max: 2, used: 1, remaining: 1 }, 'the customer sees their allowance');
});

test('a customer at the limit cannot add another mailbox', async () => {
  const second = await member(`/domains/${ctx.liveId}/emails`, { method: 'POST', body: { address: `sales@${LIVE}` } });
  assert.equal(second.status, 201, second.text);

  const third = await member(`/domains/${ctx.liveId}/emails`, { method: 'POST', body: { address: `extra@${LIVE}` } });
  assert.equal(third.status, 403);
  assert.match(third.data.error, /includes 2 mailboxes/);
  assert.equal(third.data.details?.code, 'MAILBOX_LIMIT');

  const provisioned = await member(`/domains/${ctx.liveId}/emails/provision`, {
    method: 'POST',
    body: { address: `extra@${LIVE}`, password: 'LongEnough123' },
  });
  assert.equal(provisioned.status, 403, 'creating it for real is held to the same limit');

  // The Super Admin set the limit and is not held to it.
  const own = await admin(`/domains/${ctx.liveId}/emails`, { method: 'POST', body: { address: `admin@${LIVE}` } });
  assert.equal(own.status, 201);
});

test('asking for a bigger plan reaches the Super Admin', async () => {
  const res = await member(`/domains/${ctx.liveId}/upgrade-request`, {
    method: 'POST',
    body: { wanted: '10 mailboxes', phone: '+91 98765 43210', message: 'We are hiring' },
  });
  assert.equal(res.status, 201, res.text);

  const logged = await prisma.activityLog.findFirst({
    where: { domainId: ctx.liveId, event: 'order.upgrade-requested' },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(logged, 'recorded, and so emailed as an order alert');
  assert.match(logged.detail, /10 mailboxes/);
  assert.match(logged.detail, /\+91 98765 43210/);
  assert.match(logged.detail, new RegExp(userEmail.replace(/[+.]/g, '\\$&')));
  assert.match(logged.detail, /3 in use of 2 included/);
});

test('a customer cannot ask on behalf of a domain that is not theirs', async () => {
  const other = await prisma.domain.create({ data: { name: `wl-notmine-${stamp}.example`, source: 'MANUAL' } });
  try {
    const res = await member(`/domains/${other.id}/upgrade-request`, { method: 'POST', body: { wanted: 'more' } });
    assert.equal(res.status, 404);
  } finally {
    await prisma.domain.delete({ where: { id: other.id } });
  }
});
