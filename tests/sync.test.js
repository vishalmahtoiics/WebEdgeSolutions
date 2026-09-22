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

// The zone is state, not a fixture: DNS writes go to the provider for real now,
// so a PUT has to change what the next GET returns.
let zone = [
  { name: '@', type: 'A', ttl: 3600, records: [{ content: '203.0.113.20', isDisabled: false }] },
  { name: 'www', type: 'CNAME', ttl: 3600, records: [{ content: D1, isDisabled: false }] },
];

// Mutable so a test can simulate the provider's data changing between syncs.
let portfolio = [
  { id: 201, domain: D1, type: 'domain', status: 'active', createdAt: '2024-02-01T10:00:00Z', expiresAt: '2027-02-01T10:00:00Z' },
  { id: 202, domain: D2, type: 'domain', status: 'active', createdAt: '2024-03-01T10:00:00Z', expiresAt: '2027-03-01T10:00:00Z' },
];

// Mutable so a test can give this domain more mailboxes than fit on one page.
let mailboxes = [
  { id: 'mb_a', address: `info@${D1}`, status: 'active', usage: { storageQuota: 5242880, storageUsed: 0 } },
  { id: 'mb_b', address: `admin@${D1}`, status: 'active', usage: { storageQuota: 5242880, storageUsed: 0 } },
];

// Hostinger paginates its list endpoints and serves 15 rows a page, so the
// stub does too. Reading only the first page is the whole bug this guards
// against; a stub that hands over everything at once could never catch it.
const PER_PAGE = 15;

function paginate(rows, page) {
  const last = Math.max(1, Math.ceil(rows.length / PER_PAGE));
  const current = Math.min(Math.max(1, Number(page) || 1), last);
  const from = (current - 1) * PER_PAGE;
  return {
    data: rows.slice(from, from + PER_PAGE),
    links: {
      first: '?page=1',
      last: `?page=${last}`,
      prev: current > 1 ? `?page=${current - 1}` : null,
      next: current < last ? `?page=${current + 1}` : null,
    },
    meta: {
      current_page: current,
      from: rows.length ? from + 1 : null,
      last_page: last,
      per_page: PER_PAGE,
      to: Math.min(from + PER_PAGE, rows.length),
      total: rows.length,
    },
  };
}

const routes = () => ({
  '/api/domains/v1/portfolio': portfolio,
  '/api/hosting/v1/websites': [{ domain: D1, isEnabled: true, username: 'u55555', orderId: 90, createdAt: '2024-02-02T10:00:00Z' }],
  [`/api/dns/v1/zones/${D1}`]: zone,
  '/api/mail/v1/orders': { data: [{ id: 'ord_9', status: 'active', seats: 2, domain: { domain: D1 } }] },
  // Usage is storageUsed/storageQuota in kilobytes, per Hostinger's
  // MailV1MailboxesMailboxUsageResource.
  '/api/mail/v1/orders/ord_9/mailboxes': { data: mailboxes },
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
      // Closed so no keep-alive socket is left to reset when the spawned
      // server is killed at the end of the run.
      Connection: 'close',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

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

test.before(async () => {
  stub = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ message: 'Invalid or expired API token.' }));
    }
    const path = req.url.split('?')[0];

    if (path === `/api/dns/v1/zones/${D1}` && req.method === 'PUT') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      return req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        if (Array.isArray(body.zone)) zone = body.zone;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      });
    }

    const table = routes();
    if (!(path in table)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ message: 'Not found' }));
    }

    // Endpoints documented as a `{ data: [...] }` envelope are paginated;
    // the ones documented as a bare array are not.
    const fixture = table[path];
    const page = new URL(req.url, 'http://stub').searchParams.get('page');
    const body = Array.isArray(fixture) ? fixture : paginate(fixture.data, page);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  ignoreResets(stub);
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
      const res = await fetch(`${BASE}/api/health`, { headers: { Connection: 'close' } });
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

test('a record added to a provider domain goes into the live zone', async () => {
  const res = await call(`/domains/${ctx.domainId}/dns`, {
    method: 'POST',
    body: { name: 'custom', type: 'TXT', content: 'keep-me', ttl: 300 },
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.live, true, 'this domain has a writable zone, so the record belongs in it');

  // Proven against the stub's own state, not against the reply.
  assert.ok(
    zone.some((g) => g.type === 'TXT' && g.records.some((r) => r.content === 'keep-me')),
    'the zone really holds it',
  );
});

test('a hand-added record survives a zone refresh, live ones are replaced', async () => {
  // Straight into the database: a note that was never part of the zone.
  await prisma.dnsRecord.create({
    data: { domainId: ctx.domainId, name: 'note', type: 'TXT', content: 'mine-only', ttl: 300, isFromProvider: false },
  });

  await call(`/domains/${ctx.domainId}/dns/sync`, { method: 'POST' });

  const { data } = await call(`/domains/${ctx.domainId}`);
  const live = data.dnsRecords.filter((r) => r.isFromProvider);
  // 3 in the zone (apex A, www CNAME, the TXT just written) refreshed rather
  // than duplicated, plus the one note.
  assert.equal(live.length, 3);
  assert.equal(data.dnsRecords.length, 4);
  assert.ok(data.dnsRecords.some((r) => r.content === 'mine-only' && !r.isFromProvider));
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

test('every mailbox is imported, not just the first page of them', async () => {
  // Reported from a live account: a domain with 50-odd mailboxes showed 15.
  // The provider serves 15 rows a page, and only the first page was ever
  // read — so the other 37 never arrived, and worse, sync deletes provider
  // rows it did not see, which meant each run threw them away again.
  const many = [
    ...mailboxes,
    ...Array.from({ length: 50 }, (_, i) => ({
      id: `mb_bulk_${i}`,
      address: `staff${String(i).padStart(2, '0')}@${D1}`,
      status: 'active',
      usage: { storageQuota: 5242880, storageUsed: 0 },
    })),
  ];
  const original = mailboxes;
  mailboxes = many;

  try {
    const res = await call(`/domains/${ctx.domainId}/emails/sync`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(res.data.count, 52, 'all 52 mailboxes should come back, over four pages');

    const { data } = await call(`/domains/${ctx.domainId}`);
    const fromProvider = data.emailAccounts.filter((m) => m.isFromProvider);
    assert.equal(fromProvider.length, 52);

    // One from the last page in particular: an off-by-one in the paging would
    // still pass a count check if it fetched the same page twice.
    assert.ok(
      data.emailAccounts.some((m) => m.address === `staff49@${D1}`),
      'the mailbox on the final page must be there too',
    );
    // And the mailbox entered by hand in the previous test is still untouched.
    assert.ok(data.emailAccounts.some((m) => m.address === `manual@${D1}` && !m.isFromProvider));
  } finally {
    // Put the provider back where the following tests expect it.
    mailboxes = original;
    await call(`/domains/${ctx.domainId}/emails/sync`, { method: 'POST' });
  }
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
