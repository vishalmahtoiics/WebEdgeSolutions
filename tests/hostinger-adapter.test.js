// Exercises the Hostinger adapter's parsing against the response shapes given
// in Hostinger's official API documentation, served by a local stub. This
// checks our own mapping code; the running application still only ever shows
// data returned by the real provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const TOKEN = 'stub-token';

// Response bodies mirroring the documented resource shapes.
const FIXTURES = {
  '/api/domains/v1/portfolio': [
    { id: 101, domain: 'example.com', type: 'domain', status: 'active', createdAt: '2024-02-01T10:00:00Z', expiresAt: '2027-02-01T10:00:00Z' },
    { id: 102, domain: 'example.in', type: 'domain', status: 'expired', createdAt: '2023-05-10T10:00:00Z', expiresAt: '2025-05-10T10:00:00Z' },
    // Unclaimed free domains have a null name and must be skipped.
    { id: 103, domain: null, type: 'free_domain', status: 'requested', createdAt: '2024-06-01T10:00:00Z', expiresAt: null },
  ],
  '/api/hosting/v1/websites': [
    { domain: 'example.com', isEnabled: true, username: 'u123456', orderId: 77, createdAt: '2024-02-02T10:00:00Z' },
    // Hosted but not in the registrar portfolio — should still be imported.
    { domain: 'clientdomain.com', isEnabled: true, username: 'u999999', orderId: 78, createdAt: '2024-07-01T10:00:00Z' },
  ],
  '/api/domains/v1/portfolio/example.com': {
    domain: 'example.com',
    status: 'active',
    isLocked: true,
    isPrivacyProtected: false,
    nameServers: { ns1: 'ns1.dns-parking.com', ns2: 'ns2.dns-parking.com' },
    registeredAt: '2024-02-01T10:00:00Z',
    expiresAt: '2027-02-01T10:00:00Z',
  },
  // DNS is grouped by name/type with an inner records array.
  '/api/dns/v1/zones/example.com': [
    { name: '@', type: 'A', ttl: 3600, records: [{ content: '203.0.113.10', isDisabled: false }] },
    { name: 'www', type: 'CNAME', ttl: 1800, records: [{ content: 'example.com', isDisabled: false }] },
    { name: '@', type: 'MX', ttl: 3600, records: [{ content: 'mx1.example.com', isDisabled: false }, { content: 'mx2.example.com', isDisabled: false }] },
  ],
  '/api/mail/v1/orders': { data: [{ id: 'ord_1', status: 'active', seats: 3, domain: { domain: 'example.com' } }] },
  // Usage is reported as storageUsed/storageQuota in KILOBYTES, per
  // MailV1MailboxesMailboxUsageResource — not bytes.
  '/api/mail/v1/orders/ord_1/mailboxes': {
    data: [
      { id: 'mb_1', address: 'info@example.com', status: 'active', usage: { storageQuota: 10485760, storageUsed: 1048576, messagesUsed: 42, messagesQuota: 10000 } },
      { id: 'mb_2', address: 'support@example.com', status: 'active', usage: { storageQuota: 10485760, storageUsed: 0 } },
    ],
  },
  '/api/vps/v1/virtual-machines': [
    { id: 55, hostname: 'srv1.example.com', plan: 'KVM 2', state: 'running', cpus: 2, memory: 8192, disk: 102400, bandwidth: 8192, ipv4: [{ address: '203.0.113.50' }] },
  ],
};

let server;
let adapter;

test.before(async () => {
  server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ message: 'Invalid or expired API token.' }));
    }
    const path = req.url.split('?')[0];
    if (!(path in FIXTURES)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ message: 'Not found' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(FIXTURES[path]));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.HOSTINGER_API_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  ({ hostingerAdapter: adapter } = await import('../src/providers/hostinger.js'));
});

test.after(() => server?.close());

test('testConnection succeeds with a valid token', async () => {
  const result = await adapter.testConnection(TOKEN);
  assert.equal(result.ok, true);
  assert.match(result.message, /Found 3 domains/);
});

test('testConnection reports an invalid token clearly', async () => {
  await assert.rejects(() => adapter.testConnection('wrong-token'), /Invalid or expired API token/);
});

test('listDomains merges the portfolio with hosted websites', async () => {
  const domains = await adapter.listDomains(TOKEN);
  const names = domains.map((d) => d.name).sort();
  assert.deepEqual(names, ['clientdomain.com', 'example.com', 'example.in']);

  const example = domains.find((d) => d.name === 'example.com');
  assert.equal(example.externalId, '101');
  assert.equal(example.status, 'active');
  assert.equal(example.expiresAt.toISOString(), '2027-02-01T10:00:00.000Z');
  // The hosting account is carried through so FTP username can be pre-filled.
  assert.equal(example.website.username, 'u123456');

  // A hosted domain missing from the portfolio is still picked up.
  assert.equal(domains.find((d) => d.name === 'clientdomain.com').type, 'hosting');
});

test('listDomains skips unclaimed free domains with no name', async () => {
  const domains = await adapter.listDomains(TOKEN);
  assert.ok(domains.every((d) => d.name));
  assert.equal(domains.length, 3);
});

test('getDomainDetails flattens the nameserver object', async () => {
  const details = await adapter.getDomainDetails(TOKEN, 'example.com');
  assert.deepEqual(details.nameservers, ['ns1.dns-parking.com', 'ns2.dns-parking.com']);
  assert.equal(details.isLocked, true);
  assert.equal(details.isPrivacyProtected, false);
});

test('listDnsRecords flattens grouped zone records into one row per value', async () => {
  const records = await adapter.listDnsRecords(TOKEN, 'example.com');
  // 1 A + 1 CNAME + 2 MX values = 4 rows.
  assert.equal(records.length, 4);

  const mx = records.filter((r) => r.type === 'MX').map((r) => r.content).sort();
  assert.deepEqual(mx, ['mx1.example.com', 'mx2.example.com']);

  const a = records.find((r) => r.type === 'A');
  assert.equal(a.name, '@');
  assert.equal(a.content, '203.0.113.10');
  assert.equal(a.ttl, 3600);
});

test('listEmailAccounts resolves the mail order for the domain', async () => {
  const mailboxes = await adapter.listEmailAccounts(TOKEN, 'example.com');
  assert.deepEqual(mailboxes.map((m) => m.address), ['info@example.com', 'support@example.com']);
  // Kilobytes are converted to megabytes for storage.
  assert.equal(mailboxes[0].quotaMb, 10240, '10 GB quota should read as 10240 MB');
  assert.equal(mailboxes[0].usedMb, 1024, '1 GB used should read as 1024 MB');
  assert.equal(mailboxes[0].messagesUsed, 42);
  assert.equal(mailboxes[1].usedMb, 0, 'zero usage must stay 0, not become null');
});

test('listEmailAccounts returns an empty list when a domain has no mail order', async () => {
  const mailboxes = await adapter.listEmailAccounts(TOKEN, 'example.in');
  assert.deepEqual(mailboxes, [], 'no email plan must mean no rows, not an error');
});

test('listServers maps VPS instances', async () => {
  const servers = await adapter.listServers(TOKEN);
  assert.equal(servers.length, 1);
  assert.equal(servers[0].hostname, 'srv1.example.com');
  assert.equal(servers[0].cpus, 2);
  assert.deepEqual(servers[0].ipv4, ['203.0.113.50']);
});
