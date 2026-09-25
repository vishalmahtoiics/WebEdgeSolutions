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
    { id: 101, domain: 'example.com', type: 'domain', status: 'active', created_at: '2024-02-01T10:00:00Z', expires_at: '2027-02-01T10:00:00Z' },
    { id: 102, domain: 'example.in', type: 'domain', status: 'expired', created_at: '2023-05-10T10:00:00Z', expires_at: '2025-05-10T10:00:00Z' },
    // Unclaimed free domains have a null name and must be skipped.
    { id: 103, domain: null, type: 'free_domain', status: 'requested', created_at: '2024-06-01T10:00:00Z', expires_at: null },
  ],
  '/api/hosting/v1/websites': [
    { domain: 'example.com', is_enabled: true, username: 'u123456', order_id: 77, created_at: '2024-02-02T10:00:00Z' },
    // Hosted but not in the registrar portfolio — should still be imported.
    { domain: 'clientdomain.com', is_enabled: true, username: 'u999999', order_id: 78, created_at: '2024-07-01T10:00:00Z' },
  ],
  '/api/domains/v1/portfolio/example.com': {
    domain: 'example.com',
    status: 'active',
    is_locked: true,
    is_privacy_protected: false,
    name_servers: { ns1: 'ns1.dns-parking.com', ns2: 'ns2.dns-parking.com' },
    registered_at: '2024-02-01T10:00:00Z',
    expires_at: '2027-02-01T10:00:00Z',
  },
  // DNS is grouped by name/type with an inner records array.
  '/api/dns/v1/zones/example.com': [
    { name: '@', type: 'A', ttl: 3600, records: [{ content: '203.0.113.10', is_disabled: false }] },
    { name: 'www', type: 'CNAME', ttl: 1800, records: [{ content: 'example.com', is_disabled: false }] },
    { name: '@', type: 'MX', ttl: 3600, records: [{ content: 'mx1.example.com', is_disabled: false }, { content: 'mx2.example.com', is_disabled: false }] },
  ],
  // More orders than fit on one page, with `ord_big` deliberately beyond the
  // first: an order is found by scanning this list, so a domain whose order
  // sits on page two used to read as "no email plan at all".
  '/api/mail/v1/orders': {
    data: [
      { id: 'ord_1', status: 'active', seats: 3, domain: { domain: 'example.com' } },
      ...Array.from({ length: 20 }, (_, i) => ({
        id: `ord_filler_${i}`,
        status: 'active',
        seats: 1,
        domain: { domain: `filler${i}.example` },
      })),
      { id: 'ord_big', status: 'active', seats: 60, domain: { domain: 'bigmail.example' } },
    ],
  },
  // Usage is reported as storage_used/storage_quota in KILOBYTES, per
  // MailV1MailboxesMailboxUsageResource — not bytes.
  '/api/mail/v1/orders/ord_1/mailboxes': {
    data: [
      { id: 'mb_1', address: 'info@example.com', status: 'active', created_at: '2025-03-01T10:00:00Z', usage: { storage_quota: 10485760, storage_used: 1048576, messages_used: 42, messages_quota: 10000 } },
      { id: 'mb_2', address: 'support@example.com', status: 'active', usage: { storage_quota: 10485760, storage_used: 0 } },
    ],
  },
  // 52 mailboxes on one domain — the case this was reported against.
  '/api/mail/v1/orders/ord_big/mailboxes': {
    data: Array.from({ length: 52 }, (_, i) => ({
      id: `mb_big_${i}`,
      address: `staff${String(i).padStart(2, '0')}@bigmail.example`,
      status: 'active',
      usage: { storage_quota: 5242880, storage_used: 0 },
    })),
  },
  '/api/vps/v1/virtual-machines': [
    { id: 55, hostname: 'srv1.example.com', plan: 'KVM 2', state: 'running', cpus: 2, memory: 8192, disk: 102400, bandwidth: 8192, ipv4: [{ address: '203.0.113.50' }] },
  ],
};

// Hostinger paginates its list endpoints at 15 rows a page. The stub does the
// same, because a stub that hands over everything in one response agrees with
// the mistake of only ever reading the first page — the same way the stub once
// agreed that the create-mailbox field was called `localPart`.
const PER_PAGE = 15;

/// The envelope Laravel-style APIs return: the slice, links, and a `meta`
/// block saying where in the list this slice sits.
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

let server;
let adapter;
// Every path the adapter asked for, so a test can show how many pages it took.
let requested = [];

test.before(async () => {
  server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ message: 'Invalid or expired API token.' }));
    }
    requested.push(req.url);
    const path = req.url.split('?')[0];
    if (!(path in FIXTURES)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ message: 'Not found' }));
    }

    // The endpoints documented as a `{ data: [...] }` envelope are paginated.
    // A bare array, or a single resource, is served whole.
    const fixture = FIXTURES[path];
    const page = new URL(req.url, 'http://stub').searchParams.get('page');
    const body = Array.isArray(fixture?.data) ? paginate(fixture.data, page) : fixture;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
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

test('a domain with more mailboxes than one page returns all of them', async () => {
  // Reported from a live account: a domain with 50-odd mailboxes showed 15.
  // The provider serves 15 a page and only the first page was ever read.
  requested = [];
  const mailboxes = await adapter.listEmailAccounts(TOKEN, 'bigmail.example');

  assert.equal(mailboxes.length, 52, 'all 52 mailboxes, not the first 15');

  // No duplicates and nothing missed: an off-by-one that re-read page one
  // would still reach 52 rows if it also skipped a page.
  const addresses = mailboxes.map((m) => m.address);
  assert.equal(new Set(addresses).size, 52);
  assert.ok(addresses.includes('staff00@bigmail.example'), 'first page');
  assert.ok(addresses.includes('staff20@bigmail.example'), 'a middle page');
  assert.ok(addresses.includes('staff51@bigmail.example'), 'the last page');

  // The first request goes out exactly as it always did, with no query string;
  // later pages are asked for only because the response said there were more.
  // So an endpoint that does not paginate is untouched by any of this.
  const calls = requested.filter((u) => u.startsWith('/api/mail/v1/orders/ord_big/mailboxes'));
  assert.equal(calls[0], '/api/mail/v1/orders/ord_big/mailboxes');
  assert.deepEqual(calls.slice(1).map((u) => u.split('page=')[1]), ['2', '3', '4']);
});

test('a mail order past the first page is still found', async () => {
  // `ord_big` is the 22nd order, so it is only reachable by reading page two
  // of the order list. Before, this domain reported no email plan at all.
  const mailboxes = await adapter.listEmailAccounts(TOKEN, 'bigmail.example');
  assert.ok(mailboxes.length, 'an order on page two is still an order');
});

test('testConnection counts every domain, not the first page of them', async () => {
  // The portfolio fixture is a bare array, so this also proves an
  // unpaginated endpoint still reads in a single request.
  requested = [];
  const result = await adapter.testConnection(TOKEN);
  assert.match(result.message, /Found 3 domains/);
  assert.deepEqual(
    requested.filter((u) => u.startsWith('/api/domains/v1/portfolio')),
    ['/api/domains/v1/portfolio'],
    'a bare array is the whole answer; asking for page two would be noise',
  );
});

test('listServers maps VPS instances', async () => {
  const servers = await adapter.listServers(TOKEN);
  assert.equal(servers.length, 1);
  assert.equal(servers[0].hostname, 'srv1.example.com');
  assert.equal(servers[0].cpus, 2);
  assert.deepEqual(servers[0].ipv4, ['203.0.113.50']);
});

// --- Dates -------------------------------------------------------------------

test('dates come from the fields the API actually sends', async () => {
  const domains = await adapter.listDomains(TOKEN);
  const com = domains.find((d) => d.name === 'example.com');
  assert.equal(com.registeredAt?.toISOString(), '2024-02-01T10:00:00.000Z', 'from created_at');
  assert.equal(com.expiresAt?.toISOString(), '2027-02-01T10:00:00.000Z', 'from expires_at');

  const hosted = domains.find((d) => d.name === 'clientdomain.com');
  assert.equal(hosted.registeredAt?.toISOString(), '2024-07-01T10:00:00.000Z', "a hosted site's created_at");

  const details = await adapter.getDomainDetails(TOKEN, 'example.com');
  assert.equal(details.isLocked, true);
  assert.equal(details.isPrivacyProtected, false);
  assert.deepEqual(details.nameservers, ['ns1.dns-parking.com', 'ns2.dns-parking.com']);
  assert.equal(details.registeredAt?.toISOString(), '2024-02-01T10:00:00.000Z');
});

test('a mailbox carries the date it was created on the hosting account', async () => {
  const mailboxes = await adapter.listEmailAccounts(TOKEN, 'example.com');
  const info = mailboxes.find((m) => m.address === 'info@example.com');
  assert.equal(info.createdAt?.toISOString(), '2025-03-01T10:00:00.000Z');
  const support = mailboxes.find((m) => m.address === 'support@example.com');
  assert.equal(support.createdAt, null, 'no date reported is no date, not today');
});
