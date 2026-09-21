// The white-label boundary.
//
// A normal user must never learn which hosting company is behind their
// domains. That has to hold in the API responses themselves, not just in what
// the browser chooses to draw — anyone can open the network tab.
//
// The provider is given a distinctive name here so a single substring check
// over a whole response body is a meaningful test.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

const TOKEN = 'stub-token';
const PORT = 3995;
const BASE = `http://127.0.0.1:${PORT}`;
const prisma = new PrismaClient();

const stamp = Date.now();
const PROVIDER_NAME = `AcmeHost-${stamp}`;
const DOMAIN = `vis-${stamp}.example`;
const HIDDEN = `hidden-${stamp}.example`;
const userEmail = `vis+${stamp}@example.com`;
const userPassword = 'VisUser@12345';

const FIXTURES = {
  '/api/domains/v1/portfolio': [
    { id: 1, domain: DOMAIN, type: 'domain', status: 'active', createdAt: '2024-01-01T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z' },
    { id: 2, domain: HIDDEN, type: 'domain', status: 'active', createdAt: '2024-01-01T00:00:00Z', expiresAt: null },
  ],
  '/api/hosting/v1/websites': [],
  [`/api/dns/v1/zones/${DOMAIN}`]: [
    { name: '@', type: 'A', ttl: 3600, records: [{ content: '203.0.113.9' }] },
    { name: 'www', type: 'CNAME', ttl: 3600, records: [{ content: DOMAIN }] },
  ],
  '/api/mail/v1/orders': { data: [{ id: 'o1', status: 'active', seats: 2, domain: { domain: DOMAIN } }] },
  '/api/mail/v1/orders/o1/mailboxes': {
    data: [{ id: 'mb_1', address: `info@${DOMAIN}`, status: 'active', usage: { storageQuota: 5242880, storageUsed: 1048576 } }],
  },
  '/api/mail/v1/orders/o1/forwarders': { data: [] },
  '/api/mail/v1/orders/o1/aliases': { data: [] },
  '/api/mail/v1/orders/o1/autoreplies': { data: [] },
  '/api/mail/v1/orders/o1/catchalls': { data: [] },
};

let stub;
let server;
const admin = client();
const member = client();
const ctx = {};

function client() {
  let cookie = '';
  return async function call(path, { method = 'GET', body } = {}) {
    const res = await fetch(`${BASE}/api${path}`, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null, raw: text };
  };
}

test.before(async () => {
  stub = http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    if (path in FIXTURES) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(FIXTURES[path]));
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Not found' }));
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));

  server = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: String(PORT), HOSTINGER_API_BASE_URL: `http://127.0.0.1:${stub.address().port}` },
    stdio: 'ignore',
  });
  for (let i = 0; i < 80; i += 1) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  const login = await admin('/auth/login', { method: 'POST', body: { email: 'admin@example.com', password: 'Admin@12345' } });
  assert.equal(login.status, 200, `admin login failed: ${login.raw}`);

  const prov = await admin('/providers', { method: 'POST', body: { name: PROVIDER_NAME, adapter: 'hostinger', token: TOKEN } });
  assert.equal(prov.status, 201, `provider create failed: ${prov.raw}`);
  ctx.providerId = prov.data.provider.id;
  await admin(`/providers/${ctx.providerId}/test`, { method: 'POST' });

  const all = await admin(`/providers/${ctx.providerId}/sync-all`, { method: 'POST' });
  assert.equal(all.status, 200, `sync-all failed: ${all.raw}`);
  ctx.syncAll = all.data;

  const list = await admin('/domains');
  ctx.domainId = list.data.domains.find((d) => d.name === DOMAIN).id;
  ctx.hiddenId = list.data.domains.find((d) => d.name === HIDDEN).id;

  const created = await admin('/users', {
    method: 'POST',
    body: { name: 'Visibility User', email: userEmail, password: userPassword, role: 'USER' },
  });
  ctx.userId = created.data.user.id;
  await admin(`/users/${ctx.userId}/domains`, { method: 'PUT', body: { domainIds: [ctx.domainId] } });
  await member('/auth/login', { method: 'POST', body: { email: userEmail, password: userPassword } });
});

test.after(async () => {
  if (ctx.userId) await admin(`/users/${ctx.userId}`, { method: 'DELETE' });
  if (ctx.providerId) await admin(`/providers/${ctx.providerId}`, { method: 'DELETE' });
  await prisma.domain.deleteMany({ where: { name: { in: [DOMAIN, HIDDEN] } } });
  await prisma.$disconnect();
  server?.kill();
  stub?.close();
});

// --- One-click sync ---------------------------------------------------------

test('Sync Everything imports domains, DNS and mailboxes in one action', () => {
  const s = ctx.syncAll;
  assert.equal(s.ok, true);
  assert.equal(s.domains.total, 2, 'both domains should be imported');
  assert.equal(s.domainsProcessed, 2);
  assert.equal(s.dnsRecords, 2, 'the zone should be saved');
  assert.equal(s.mailboxes, 1, 'the mailbox should be saved');

  // The second domain has no DNS zone and no mail plan at the provider. That
  // is an ordinary state, not a failure, and must not be reported as one.
  assert.deepEqual(s.failures, [], 'a domain with nothing to sync is not a failure');
  const hidden = s.details.find((x) => x.domain === HIDDEN);
  assert.equal(hidden.dnsCount, 0);
  assert.equal(hidden.emailCount, 0);
});

test('everything Sync Everything imported is in the database', async () => {
  const { data } = await admin(`/domains/${ctx.domainId}`);
  assert.equal(data.dnsRecords.length, 2);
  assert.equal(data.emailAccounts.length, 1);
  assert.equal(data.emailAccounts[0].quotaMb, 5120);
});

test('running Sync Everything again creates no duplicates', async () => {
  const again = await admin(`/providers/${ctx.providerId}/sync-all`, { method: 'POST' });
  assert.equal(again.data.domains.imported, 0);
  assert.equal(again.data.domains.updated, 2);

  const { data } = await admin(`/domains/${ctx.domainId}`);
  assert.equal(data.dnsRecords.length, 2, 'the zone should be replaced, not appended to');
  assert.equal(data.emailAccounts.length, 1);
});

// --- The boundary -----------------------------------------------------------

/// Every response a user can reach, checked as raw text.
async function userResponses() {
  return {
    'GET /dashboard': await member('/dashboard'),
    'GET /domains': await member('/domains'),
    'GET /domains/:id': await member(`/domains/${ctx.domainId}`),
    'GET /domains/:id/registration': await member(`/domains/${ctx.domainId}/registration`),
    'GET /dashboard/my-emails': await member('/dashboard/my-emails'),
    'GET /dashboard/my-resources': await member('/dashboard/my-resources'),
    'GET /auth/me': await member('/auth/me'),
  };
}

test('no response a user can reach names the provider', async () => {
  for (const [label, res] of Object.entries(await userResponses())) {
    assert.ok(!res.raw.includes(PROVIDER_NAME), `${label} leaked the provider name`);
    assert.ok(!/hostinger/i.test(res.raw), `${label} leaked the adapter name`);
  }
});

test('no response a user can reach exposes where a record came from', async () => {
  for (const [label, res] of Object.entries(await userResponses())) {
    for (const field of ['sourceLabel', 'isFromProvider', 'adapter', 'externalId', '"provider"']) {
      assert.ok(!res.raw.includes(field), `${label} exposed ${field}`);
    }
  }
});

test('the refresh action itself gives nothing away', async () => {
  const res = await member(`/domains/${ctx.domainId}/refresh`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.ok(!res.raw.includes(PROVIDER_NAME));
  assert.ok(!/hostinger/i.test(res.raw));
  assert.match(res.data.message, /Refreshed/);
});

test('refresh actually reloads the data', async () => {
  // Drop a record, refresh, and confirm it comes back.
  const before = await member(`/domains/${ctx.domainId}`);
  await prisma.dnsRecord.deleteMany({ where: { domainId: ctx.domainId, isFromProvider: true } });

  const emptied = await member(`/domains/${ctx.domainId}`);
  assert.equal(emptied.data.dnsRecords.length, 0);

  await member(`/domains/${ctx.domainId}/refresh`, { method: 'POST' });
  const after = await member(`/domains/${ctx.domainId}`);
  assert.equal(after.data.dnsRecords.length, before.data.dnsRecords.length);
});

test('a user still gets what they need to use the page', async () => {
  const { data } = await member(`/domains/${ctx.domainId}`);
  assert.equal(data.domain.name, DOMAIN);
  assert.equal(data.domain.canRefresh, true, 'the Refresh button needs this');
  assert.equal(typeof data.capabilities.canManageEmail, 'boolean');
  assert.ok(data.dnsRecords.length, 'DNS records are still visible');
  assert.ok(data.emailAccounts.length, 'mailboxes are still visible');
  assert.equal(data.emailAccounts[0].isManaged, true, 'so the Password button can show');
});

test('the admin still sees the provider everywhere they should', async () => {
  const list = await admin('/domains');
  const row = list.data.domains.find((d) => d.id === ctx.domainId);
  assert.equal(row.sourceLabel, PROVIDER_NAME);
  assert.equal(row.provider.name, PROVIDER_NAME);

  const detail = await admin(`/domains/${ctx.domainId}`);
  assert.equal(detail.data.domain.provider.name, PROVIDER_NAME);
  assert.equal(detail.data.domain.provider.adapter, 'hostinger');
  assert.equal(typeof detail.data.dnsRecords[0].isFromProvider, 'boolean');
  assert.equal(typeof detail.data.emailAccounts[0].isFromProvider, 'boolean');
});

test('a user cannot reach the provider administration at all', async () => {
  assert.equal((await member('/providers')).status, 403);
  assert.equal((await member('/providers/adapters')).status, 403);
  assert.equal((await member(`/providers/${ctx.providerId}/sync-all`, { method: 'POST' })).status, 403);
  assert.equal((await member(`/providers/${ctx.providerId}/servers`)).status, 403);
});

test('a user cannot refresh a domain they are not assigned', async () => {
  const res = await member(`/domains/${ctx.hiddenId}/refresh`, { method: 'POST' });
  assert.equal(res.status, 404);
  assert.ok(!res.raw.includes(HIDDEN), 'it must not confirm the domain exists');
});
