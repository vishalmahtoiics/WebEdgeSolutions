// Full provider → database sync flow, driven through the HTTP API against a
// local stub serving Hostinger's documented response shapes. Verifies that
// running Sync repeatedly does not create duplicates and that manual records
// survive a re-sync.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

const TOKEN = 'stub-token';
const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const prisma = new PrismaClient();

const stamp = Date.now();
const D1 = `sync-a-${stamp}.example`;
const D2 = `sync-b-${stamp}.example`;
const MANUAL = `manual-${stamp}.example`;

// Mutable so a test can simulate the provider's data changing between syncs.
let portfolio = [
  { id: 201, domain: D1, type: 'domain', status: 'active', createdAt: '2024-02-01T10:00:00Z', expiresAt: '2027-02-01T10:00:00Z' },
  { id: 202, domain: D2, type: 'domain', status: 'active', createdAt: '2024-03-01T10:00:00Z', expiresAt: '2027-03-01T10:00:00Z' },
];

const routes = () => ({
  '/api/domains/v1/portfolio': portfolio,
  '/api/hosting/v1/websites': [{ domain: D1, isEnabled: true, username: 'u55555', orderId: 90, createdAt: '2024-02-02T10:00:00Z' }],
  [`/api/dns/v1/zones/${D1}`]: [
    { name: '@', type: 'A', ttl: 3600, records: [{ content: '203.0.113.20', isDisabled: false }] },
    { name: 'www', type: 'CNAME', ttl: 3600, records: [{ content: D1, isDisabled: false }] },
  ],
  '/api/mail/v1/orders': { data: [{ id: 'ord_9', status: 'active', seats: 2, domain: { domain: D1 } }] },
  // Usage is storageUsed/storageQuota in kilobytes, per Hostinger's
  // MailV1MailboxesMailboxUsageResource.
  '/api/mail/v1/orders/ord_9/mailboxes': {
    data: [
      { id: 'mb_a', address: `info@${D1}`, status: 'active', usage: { storageQuota: 5242880, storageUsed: 0 } },
      { id: 'mb_b', address: `admin@${D1}`, status: 'active', usage: { storageQuota: 5242880, storageUsed: 0 } },
    ],
  },
});

let stub;
let server;
let cookie = '';
const ctx = {};

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

test.before(async () => {
  stub = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ message: 'Invalid or expired API token.' }));
    }
    const table = routes();
    const path = req.url.split('?')[0];
    if (!(path in table)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ message: 'Not found' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(table[path]));
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));

  server = spawn('node', ['src/server.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOSTINGER_API_BASE_URL: `http://127.0.0.1:${stub.address().port}`,
    },
    stdio: 'ignore',
  });

  // Wait for the server to accept connections.
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  const login = await call('/auth/login', {
    method: 'POST',
    body: { email: 'admin@example.com', password: 'Admin@12345' },
  });
  assert.equal(login.status, 200, 'admin login should succeed');
});

test.after(async () => {
  if (ctx.providerId) await call(`/providers/${ctx.providerId}`, { method: 'DELETE' });
  await prisma.domain.deleteMany({ where: { name: { in: [D1, D2, MANUAL] } } });
  await prisma.$disconnect();
  server?.kill();
  stub?.close();
});

test('test connection succeeds against the provider', async () => {
  const created = await call('/providers', {
    method: 'POST',
    body: { name: `Hostinger sync ${stamp}`, adapter: 'hostinger', token: TOKEN },
  });
  assert.equal(created.status, 201);
  ctx.providerId = created.data.provider.id;

  const test1 = await call(`/providers/${ctx.providerId}/test`, { method: 'POST' });
  assert.equal(test1.status, 200);
  assert.equal(test1.data.ok, true);
});

test('sync imports the provider domains', async () => {
  const res = await call(`/providers/${ctx.providerId}/sync`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(res.data.imported, 2);
  assert.equal(res.data.updated, 0);

  const { data } = await call('/domains');
  const imported = data.domains.filter((d) => [D1, D2].includes(d.name));
  assert.equal(imported.length, 2);
  assert.ok(imported.every((d) => d.source === 'PROVIDER'));
  // Domains carry the provider's name as their source label.
  assert.ok(imported.every((d) => d.sourceLabel === `Hostinger sync ${stamp}`));
  ctx.domainId = imported.find((d) => d.name === D1).id;
});

test('running sync again does not create duplicates', async () => {
  const res = await call(`/providers/${ctx.providerId}/sync`, { method: 'POST' });
  assert.equal(res.data.imported, 0, 'nothing new should be imported');
  assert.equal(res.data.updated, 2, 'existing rows should be updated in place');

  const count = await prisma.domain.count({ where: { name: { in: [D1, D2] } } });
  assert.equal(count, 2, 'exactly one row per domain');
});

test('sync picks up a status change at the provider', async () => {
  portfolio = portfolio.map((d) => (d.domain === D2 ? { ...d, status: 'expired' } : d));
  await call(`/providers/${ctx.providerId}/sync`, { method: 'POST' });

  const updated = await prisma.domain.findUnique({ where: { name: D2 } });
  assert.equal(updated.status, 'expired');
});

test('a manually added domain is never taken over by sync', async () => {
  await call('/domains', { method: 'POST', body: { name: MANUAL } });
  portfolio = [...portfolio, { id: 203, domain: MANUAL, type: 'domain', status: 'active', createdAt: '2024-04-01T10:00:00Z', expiresAt: null }];

  const res = await call(`/providers/${ctx.providerId}/sync`, { method: 'POST' });
  assert.equal(res.data.skipped, 1, 'the manual domain should be skipped');

  const row = await prisma.domain.findUnique({ where: { name: MANUAL } });
  assert.equal(row.source, 'MANUAL');
  assert.equal(row.providerId, null, 'a manual domain keeps no provider link');
});

test('DNS records are imported from the provider zone', async () => {
  const res = await call(`/domains/${ctx.domainId}/dns/sync`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(res.data.count, 2);

  const { data } = await call(`/domains/${ctx.domainId}`);
  assert.equal(data.dnsRecords.length, 2);
  assert.ok(data.dnsRecords.every((r) => r.isFromProvider));
});

test('manual DNS records survive a zone refresh, provider ones are replaced', async () => {
  await call(`/domains/${ctx.domainId}/dns`, {
    method: 'POST',
    body: { name: 'custom', type: 'TXT', content: 'keep-me', ttl: 300 },
  });

  await call(`/domains/${ctx.domainId}/dns/sync`, { method: 'POST' });

  const { data } = await call(`/domains/${ctx.domainId}`);
  // 2 provider records (refreshed, not duplicated) + 1 manual record.
  assert.equal(data.dnsRecords.length, 3);
  assert.equal(data.dnsRecords.filter((r) => r.isFromProvider).length, 2);
  assert.ok(data.dnsRecords.some((r) => r.content === 'keep-me'));
});

test('mailboxes are imported from the provider', async () => {
  const res = await call(`/domains/${ctx.domainId}/emails/sync`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(res.data.count, 2);

  const { data } = await call(`/domains/${ctx.domainId}`);
  const addresses = data.emailAccounts.map((m) => m.address).sort();
  assert.deepEqual(addresses, [`admin@${D1}`, `info@${D1}`]);
  assert.equal(data.emailAccounts[0].quotaMb, 5120);
});

test('re-syncing mailboxes does not duplicate them', async () => {
  await call(`/domains/${ctx.domainId}/emails/sync`, { method: 'POST' });
  const { data } = await call(`/domains/${ctx.domainId}`);
  assert.equal(data.emailAccounts.length, 2);
});

test('a manually added mailbox is kept over the provider copy', async () => {
  await call(`/domains/${ctx.domainId}/emails`, {
    method: 'POST',
    body: { address: `manual@${D1}`, status: 'active', notes: 'hand entered' },
  });
  await call(`/domains/${ctx.domainId}/emails/sync`, { method: 'POST' });

  const { data } = await call(`/domains/${ctx.domainId}`);
  assert.equal(data.emailAccounts.length, 3);
  const manual = data.emailAccounts.find((m) => m.address === `manual@${D1}`);
  assert.equal(manual.isFromProvider, false);
  assert.equal(manual.notes, 'hand entered');
});

test('live provider details are read through for a synced domain', async () => {
  // This domain has no detail route in the stub, so the adapter must report the
  // failure rather than inventing values.
  const { status, data } = await call(`/domains/${ctx.domainId}/registration`);
  assert.equal(status, 200);
  assert.equal(data.supported, true);
  assert.equal(data.details, null);
  assert.ok(data.error, 'an unavailable endpoint must surface as an error, not fake data');
});

test('servers are listed from the provider when supported', async () => {
  const { status, data } = await call(`/providers/${ctx.providerId}/servers`);
  assert.equal(status, 200);
  // The stub has no VPS route; the error is reported instead of a fake list.
  assert.equal(data.supported, true);
  assert.deepEqual(data.servers, []);
});
