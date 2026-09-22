// Writing DNS for real, and checking a name against the registry.
//
// Hostinger replaces a zone whole rather than record by record, which makes
// every edit a read-modify-write over somebody's live DNS. The stub here holds
// actual zone state: a PUT changes it, and the next GET returns what was
// written. So a passing test means the record really moved, not that a call
// was made.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import {
  addRecord, removeRecord, updateRecord, assertSafeWrite, flattenZone, countRecords, hasRecord, ZoneError,
} from '../src/lib/dnsZone.js';

const TOKEN = 'dns-stub-token';
const PORT = 3998;
const BASE = `http://127.0.0.1:${PORT}`;
const prisma = new PrismaClient();

const stamp = Date.now();
const LIVE = `dnslive-${stamp}.example`;
const MANUAL = `dnsmanual-${stamp}.example`;
const userEmail = `dns+${stamp}@example.com`;
const userPassword = 'DnsUser@12345';

/// The stub's zone, as Hostinger would hold it. `note` is a field this portal
/// knows nothing about — it must survive every round trip.
let zone;
const freshZone = () => [
  {
    name: '@',
    type: 'A',
    ttl: 3600,
    records: [{ content: '203.0.113.10', isDisabled: false }],
    note: 'upstream-field-we-do-not-model',
  },
  { name: 'www', type: 'CNAME', ttl: 3600, records: [{ content: LIVE, isDisabled: false }] },
  {
    name: '@',
    type: 'MX',
    ttl: 3600,
    records: [
      { content: 'mx1.example.com', isDisabled: false, priority: 10 },
      { content: 'mx2.example.com', isDisabled: false, priority: 20 },
    ],
  },
];

/// When true the stub accepts a PUT and changes nothing — the failure mode the
/// read-back exists to catch.
let swallowWrites = false;
let availability = [];
let lastPutBody = null;

let stub;
let server;
const admin = client();
const member = client();
const ctx = {};

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
    const res = await fetch(`${BASE}/api${pathname}`, {
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

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      try {
        resolve(raw ? JSON.parse(raw) : null);
      } catch {
        resolve(null);
      }
    });
  });

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
  zone = freshZone();

  stub = http.createServer(async (req, res) => {
    const send = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      return send(401, { message: 'Invalid or expired API token.' });
    }

    const path = req.url.split('?')[0];

    if (path === '/api/domains/v1/portfolio') {
      return send(200, [
        { id: 401, domain: LIVE, type: 'domain', status: 'active', createdAt: '2024-01-01T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z' },
      ]);
    }
    if (path === '/api/hosting/v1/websites') return send(200, []);
    if (path === '/api/mail/v1/orders') return send(200, { data: [] });

    if (path === `/api/dns/v1/zones/${LIVE}`) {
      if (req.method === 'GET') return send(200, zone);
      if (req.method === 'PUT') {
        lastPutBody = await readBody(req);
        // Hostinger's write takes { overwrite, zone }.
        if (!swallowWrites && Array.isArray(lastPutBody?.zone)) zone = lastPutBody.zone;
        return send(200, { success: true });
      }
    }

    if (path === '/api/domains/v1/availability' && req.method === 'POST') {
      await readBody(req);
      return send(200, availability);
    }

    send(404, { message: 'Not found' });
  });
  ignoreResets(stub);
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));

  server = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOSTINGER_API_BASE_URL: `http://127.0.0.1:${stub.address().port}`,
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

  await admin('/auth/login', { method: 'POST', body: { email: 'admin@example.com', password: 'Admin@12345' } });

  const provider = await admin('/providers', {
    method: 'POST',
    body: { name: `DNS write ${stamp}`, adapter: 'hostinger', token: TOKEN },
  });
  ctx.providerId = provider.data.provider.id;

  // Import the live domain from the provider, then a hand-added one alongside.
  await admin(`/providers/${ctx.providerId}/sync`, { method: 'POST' });
  const live = await prisma.domain.findUnique({ where: { name: LIVE } });
  ctx.liveId = live.id;
  await admin(`/domains/${ctx.liveId}/dns/sync`, { method: 'POST' });

  const manual = await admin('/domains', { method: 'POST', body: { name: MANUAL } });
  ctx.manualId = manual.data.domain.id;

  const created = await admin('/users', {
    method: 'POST',
    body: { name: 'DNS User', email: userEmail, password: userPassword, role: 'USER' },
  });
  ctx.userId = created.data.user.id;
  await admin(`/users/${ctx.userId}/domains`, { method: 'PUT', body: { domainIds: [ctx.liveId] } });
  await member('/auth/login', { method: 'POST', body: { email: userEmail, password: userPassword } });
});

test.after(async () => {
  try {
    if (ctx.userId) await admin(`/users/${ctx.userId}`, { method: 'DELETE' });
    if (ctx.providerId) await admin(`/providers/${ctx.providerId}`, { method: 'DELETE' });
    await prisma.domain.deleteMany({ where: { name: { in: [LIVE, MANUAL] } } });
    await prisma.$disconnect();
  } catch (err) {
    console.error('TEARDOWN:', err?.message);
  }
  server?.kill();
  stub?.close();
});

/// The live zone as the stub actually holds it — the source of truth for every
/// assertion below.
const inZone = (name, type, content) => hasRecord(zone, { name, type, content });
const recordId = async (name, type, content) => {
  const row = await prisma.dnsRecord.findFirst({
    where: { domainId: ctx.liveId, name, type, content },
  });
  return row?.id;
};

// --- The zone maths, on its own ---------------------------------------------

test('an edit carries through fields this portal knows nothing about', () => {
  const before = freshZone();
  const { groups } = addRecord(before, { name: 'blog', type: 'A', content: '203.0.113.99', ttl: 1800 });

  const apex = groups.find((g) => g.name === '@' && g.type === 'A');
  assert.equal(apex.note, 'upstream-field-we-do-not-model', 'an unmodelled group field survived');

  const mx = groups.find((g) => g.type === 'MX');
  assert.deepEqual(mx.records.map((r) => r.priority), [10, 20], 'MX priorities survived');

  // And the input zone was not mutated on the way through.
  assert.equal(countRecords(before), 4);
  assert.equal(countRecords(groups), 5);
});

test('adding to an existing name and type appends rather than replacing', () => {
  const { groups, ttlAffected } = addRecord(freshZone(), {
    name: '@', type: 'MX', content: 'mx3.example.com', ttl: 3600,
  });
  const mx = groups.find((g) => g.type === 'MX');
  assert.deepEqual(mx.records.map((r) => r.content), ['mx1.example.com', 'mx2.example.com', 'mx3.example.com']);
  assert.equal(ttlAffected, 0, 'the TTL matched, so nothing else moved');
});

test('a TTL change reports how many records it drags along', () => {
  const { groups, ttlAffected } = addRecord(freshZone(), {
    name: '@', type: 'MX', content: 'mx3.example.com', ttl: 600,
  });
  // TTL belongs to the group upstream, so the two existing MX records moved too.
  assert.equal(ttlAffected, 2);
  assert.equal(groups.find((g) => g.type === 'MX').ttl, 600);
});

test('the same value twice is refused', () => {
  assert.throws(
    () => addRecord(freshZone(), { name: '@', type: 'A', content: '203.0.113.10' }),
    (err) => err instanceof ZoneError && err.status === 409,
  );
});

test('an emptied group is dropped, not left behind', () => {
  const { groups } = removeRecord(freshZone(), { name: 'www', type: 'CNAME', content: LIVE });
  assert.ok(!groups.some((g) => g.type === 'CNAME'), 'the empty CNAME group went with it');
  assert.equal(countRecords(groups), 3);
});

test('name matching follows DNS rules, not string equality', () => {
  // Case-insensitive, and "" means the apex just as "@" does.
  const { groups } = removeRecord(freshZone(), { name: 'WWW', type: 'cname', content: LIVE });
  assert.equal(countRecords(groups), 3);
  assert.ok(!hasRecord(groups, { name: 'www', type: 'CNAME', content: LIVE }));
});

test('an edit that would collide with an existing record is refused outright', () => {
  assert.throws(
    () =>
      updateRecord(
        freshZone(),
        { name: '@', type: 'MX', content: 'mx1.example.com' },
        { name: '@', type: 'MX', content: 'mx2.example.com', ttl: 3600 },
      ),
    (err) => err instanceof ZoneError && err.status === 409,
  );
});

test('a zone read that comes back empty is treated as a failed read', () => {
  // The dangerous case: a transient 404 reads as an empty zone, and writing
  // then replaces real DNS with one record.
  const { groups } = addRecord([], { name: '@', type: 'A', content: '203.0.113.10' });
  assert.throws(
    () => assertSafeWrite([], groups, { expectedDelta: 1, minimumBefore: 4 }),
    /reading the zone returned none/i,
  );
  // With nothing expected up there, the same write is fine.
  assert.doesNotThrow(() => assertSafeWrite([], groups, { expectedDelta: 1, minimumBefore: 0 }));
});

test('a transformation that loses records it was not asked to lose is refused', () => {
  const before = freshZone();
  assert.throws(
    () => assertSafeWrite(before, [], { expectedDelta: -1, minimumBefore: 4 }),
    /not the change that was asked for/i,
  );
});

test('deliberately deleting the last record in a zone is allowed', () => {
  const single = [{ name: '@', type: 'A', ttl: 3600, records: [{ content: '203.0.113.1' }] }];
  const { groups } = removeRecord(single, { name: '@', type: 'A', content: '203.0.113.1' });
  assert.equal(countRecords(groups), 0);
  assert.doesNotThrow(() => assertSafeWrite(single, groups, { expectedDelta: -1, minimumBefore: 1 }));
});

// --- Writing the real zone --------------------------------------------------

test('the imported zone is what the stub holds', async () => {
  const { data } = await admin(`/domains/${ctx.liveId}`);
  assert.equal(data.dnsRecords.length, 4);
  assert.equal(data.capabilities.canEditLiveDns, true);
  assert.ok(data.dnsRecords.every((r) => r.isLive), 'all four came from the zone');
});

test('adding a record puts it in the live zone', async () => {
  const res = await admin(`/domains/${ctx.liveId}/dns`, {
    method: 'POST',
    body: { name: 'blog', type: 'A', content: '203.0.113.50', ttl: 1800 },
  });
  if (res.status !== 201) console.error('DEBUG:', JSON.stringify(res.data));
  assert.equal(res.status, 201);
  assert.equal(res.data.live, true);
  assert.match(res.data.message, /live DNS zone/i);

  assert.ok(inZone('blog', 'A', '203.0.113.50'), 'the stub zone really has it');
  assert.equal(countRecords(zone), 5);

  // And the unmodelled upstream field is still there after a real write.
  assert.equal(zone.find((g) => g.name === '@' && g.type === 'A').note, 'upstream-field-we-do-not-model');
  assert.equal(lastPutBody.overwrite, true);
});

test('the new record shows up as live in the portal', async () => {
  const { data } = await admin(`/domains/${ctx.liveId}`);
  const row = data.dnsRecords.find((r) => r.name === 'blog');
  assert.ok(row, 'the record is in the portal');
  assert.equal(row.isLive, true);
  assert.equal(row.isFromProvider, true);
});

test('editing a record changes the live zone, old value gone', async () => {
  const id = await recordId('blog', 'A', '203.0.113.50');
  const res = await admin(`/domains/${ctx.liveId}/dns/${id}`, {
    method: 'PUT',
    body: { name: 'blog', type: 'A', content: '203.0.113.51', ttl: 1800 },
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.live, true);

  assert.ok(inZone('blog', 'A', '203.0.113.51'), 'the new value is up');
  assert.ok(!inZone('blog', 'A', '203.0.113.50'), 'the old value is gone');
  assert.equal(countRecords(zone), 5, 'an edit is one out and one in');
});

test('deleting a record removes it from the live zone', async () => {
  const id = await recordId('blog', 'A', '203.0.113.51');
  const res = await admin(`/domains/${ctx.liveId}/dns/${id}`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.equal(res.data.live, true);
  assert.match(res.data.message, /Removed A blog/);

  assert.ok(!inZone('blog', 'A', '203.0.113.51'));
  assert.equal(countRecords(zone), 4);
});

test('adding a second MX keeps the first, and says whose TTL moved', async () => {
  const res = await admin(`/domains/${ctx.liveId}/dns`, {
    method: 'POST',
    body: { name: '@', type: 'MX', content: 'mx3.example.com', ttl: 600 },
  });
  assert.equal(res.status, 201);
  assert.match(res.data.message, /applies to 2 other records/i);

  assert.ok(inZone('@', 'MX', 'mx1.example.com'));
  assert.ok(inZone('@', 'MX', 'mx2.example.com'));
  assert.ok(inZone('@', 'MX', 'mx3.example.com'));
  assert.deepEqual(
    zone.find((g) => g.type === 'MX').records.map((r) => r.priority),
    [10, 20, undefined],
    'the existing priorities were not disturbed',
  );

  // Put the zone back for the tests that follow.
  const id = await recordId('@', 'MX', 'mx3.example.com');
  await admin(`/domains/${ctx.liveId}/dns/${id}`, { method: 'DELETE' });
});

test('a duplicate is refused and the zone is left alone', async () => {
  const before = countRecords(zone);
  const res = await admin(`/domains/${ctx.liveId}/dns`, {
    method: 'POST',
    body: { name: '@', type: 'A', content: '203.0.113.10', ttl: 3600 },
  });
  assert.equal(res.status, 409);
  assert.match(res.data.error, /already exists/i);
  assert.equal(countRecords(zone), before, 'nothing was written');
});

test('a write the provider quietly ignores is caught, not reported as success', async () => {
  swallowWrites = true;
  try {
    const res = await admin(`/domains/${ctx.liveId}/dns`, {
      method: 'POST',
      body: { name: 'ghost', type: 'A', content: '203.0.113.77', ttl: 3600 },
    });
    assert.notEqual(res.status, 201, 'a write that did nothing must not read as created');
    assert.match(res.data.error, /does not show it/i);
  } finally {
    swallowWrites = false;
  }
  assert.ok(!inZone('ghost', 'A', '203.0.113.77'));
});

// --- Records that were never in the zone ------------------------------------

test('a domain with no provider edits locally, and says so', async () => {
  const res = await admin(`/domains/${ctx.manualId}/dns`, {
    method: 'POST',
    body: { name: '@', type: 'A', content: '198.51.100.1', ttl: 3600 },
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.live, false);
  assert.equal(res.data.message, 'Record saved.');

  const { data } = await admin(`/domains/${ctx.manualId}`);
  assert.equal(data.capabilities.canEditLiveDns, false);
  assert.equal(data.dnsRecords[0].isLive, false);
});

test('a hand-added record on a live domain stays out of the zone', async () => {
  const before = countRecords(zone);
  // Straight into the database, the way a record typed in before the zone was
  // ever synced would look.
  const row = await prisma.dnsRecord.create({
    data: { domainId: ctx.liveId, name: 'note', type: 'TXT', content: 'internal', ttl: 3600, isFromProvider: false },
  });

  const edited = await admin(`/domains/${ctx.liveId}/dns/${row.id}`, {
    method: 'PUT',
    body: { name: 'note', type: 'TXT', content: 'internal-v2', ttl: 3600 },
  });
  assert.equal(edited.data.live, false);
  assert.equal(edited.data.message, 'Record updated.');
  assert.equal(countRecords(zone), before, 'the live zone was not touched');

  const removed = await admin(`/domains/${ctx.liveId}/dns/${row.id}`, { method: 'DELETE' });
  assert.equal(removed.data.live, false);
  assert.equal(countRecords(zone), before);
});

test('a zone reload leaves hand-added records alone', async () => {
  await prisma.dnsRecord.create({
    data: { domainId: ctx.liveId, name: 'kept', type: 'TXT', content: 'mine', ttl: 3600, isFromProvider: false },
  });
  await admin(`/domains/${ctx.liveId}/dns/sync`, { method: 'POST' });

  const { data } = await admin(`/domains/${ctx.liveId}`);
  assert.ok(data.dnsRecords.some((r) => r.name === 'kept' && !r.isLive), 'the manual record survived');
  assert.equal(data.dnsRecords.filter((r) => r.isLive).length, countRecords(zone));
});

// --- Who may write ----------------------------------------------------------

test('an assigned user can edit their own live zone', async () => {
  const res = await member(`/domains/${ctx.liveId}/dns`, {
    method: 'POST',
    body: { name: 'shop', type: 'A', content: '203.0.113.60', ttl: 3600 },
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.live, true);
  assert.ok(inZone('shop', 'A', '203.0.113.60'));

  // And nothing in the reply names the provider.
  assert.ok(!/hostinger/i.test(res.text));
  assert.ok(!res.text.includes('isFromProvider'));
});

test('a user cannot touch a zone they are not assigned', async () => {
  const res = await member(`/domains/${ctx.manualId}/dns`, {
    method: 'POST',
    body: { name: '@', type: 'A', content: '198.51.100.9', ttl: 3600 },
  });
  assert.equal(res.status, 404, 'a 404, so ids cannot be probed');
});

test('the user sees that their edits are live without being told by whom', async () => {
  const { data, text } = await member(`/domains/${ctx.liveId}`);
  assert.equal(data.capabilities.canEditLiveDns, true);
  assert.ok(data.dnsRecords.some((r) => r.isLive === true));
  for (const field of ['isFromProvider', 'sourceLabel', 'adapter', 'dnsWrite']) {
    assert.ok(!text.includes(field), `leaked ${field}`);
  }
});

// --- Is a name free ---------------------------------------------------------

test('availability comes back per ending, exactly as the registry answered', async () => {
  availability = [
    { domain: 'mysite.com', tld: 'com', isAvailable: false },
    { domain: 'mysite.in', tld: 'in', isAvailable: true },
    { domain: 'mysite.net', tld: 'net', isAvailable: true, restriction: 'premium' },
  ];

  const res = await admin('/domains/availability', {
    method: 'POST',
    body: { name: 'mysite', tlds: ['com', 'in', 'net'] },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.data.results.map((r) => [r.domain, r.available]),
    [['mysite.com', false], ['mysite.in', true], ['mysite.net', true]],
  );
  assert.equal(res.data.results[2].restriction, 'premium');
});

test('a registry that does not say is reported as unknown, never as available', async () => {
  availability = [{ domain: 'unclear.com', tld: 'com' }];
  const res = await admin('/domains/availability', { method: 'POST', body: { name: 'unclear' } });
  assert.equal(res.data.results[0].available, null);
});

test('a name already in the portal is flagged rather than called available', async () => {
  availability = [{ domain: LIVE, tld: 'example', isAvailable: true }];
  const res = await admin('/domains/availability', {
    method: 'POST',
    body: { name: LIVE.split('.')[0], tlds: ['example'] },
  });
  assert.equal(res.data.results[0].alreadyInPortal, true);
});

test('an ending typed into the name is checked as well', async () => {
  availability = [{ domain: 'typed.dev', tld: 'dev', isAvailable: true }];
  const res = await admin('/domains/availability', { method: 'POST', body: { name: 'typed.dev' } });
  assert.equal(res.status, 200);
  assert.equal(res.data.name, 'typed');
  assert.equal(res.data.results[0].domain, 'typed.dev');
});

test('rubbish input is refused before any provider is called', async () => {
  for (const name of ['', 'has space', 'bad_underscore']) {
    const res = await admin('/domains/availability', { method: 'POST', body: { name } });
    assert.equal(res.status, 400, `"${name}" should be refused`);
  }
});

test('checking availability is closed to normal users', async () => {
  const res = await member('/domains/availability', { method: 'POST', body: { name: 'mysite' } });
  assert.equal(res.status, 403);
});
