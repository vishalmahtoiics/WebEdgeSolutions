// End-to-end checks against a running server (npm start) and a live database.
// Run with:  npm test
import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';
const ADMIN = { email: 'admin@example.com', password: 'Admin@12345' };

/// Minimal cookie-aware client so each actor keeps its own session.
function client() {
  let cookie = '';
  return async function call(path, { method = 'GET', body } = {}) {
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
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, data };
  };
}

const stamp = Date.now();
const userEmail = `tester+${stamp}@example.com`;
const userPassword = 'TestUser@12345';
const ownDomain = `owned-${stamp}.example`;
const otherDomain = `hidden-${stamp}.example`;

const admin = client();
const member = client();

const ctx = {};

test('health endpoint responds', async () => {
  const res = await fetch(`${BASE}/api/health`);
  assert.equal(res.status, 200);
});

test('unauthenticated requests are rejected', async () => {
  const anon = client();
  assert.equal((await anon('/domains')).status, 401);
  assert.equal((await anon('/users')).status, 401);
  assert.equal((await anon('/providers')).status, 401);
});

test('login rejects a wrong password', async () => {
  const bad = client();
  const res = await bad('/auth/login', {
    method: 'POST',
    body: { email: ADMIN.email, password: 'not-the-password' },
  });
  assert.equal(res.status, 401);
});

test('super admin can sign in', async () => {
  const res = await admin('/auth/login', { method: 'POST', body: ADMIN });
  assert.equal(res.status, 200);
  assert.equal(res.data.user.role, 'SUPER_ADMIN');
});

test('admin dashboard returns the expected statistics', async () => {
  const { status, data } = await admin('/dashboard');
  assert.equal(status, 200);
  assert.equal(data.role, 'SUPER_ADMIN');
  for (const key of ['totalUsers', 'totalDomains', 'connectedProviders', 'activeDomains', 'totalEmailAccounts']) {
    assert.equal(typeof data.stats[key], 'number', `missing stat: ${key}`);
  }
});

test('hostinger adapter is registered with its capabilities', async () => {
  const { data } = await admin('/providers/adapters');
  const hostinger = data.adapters.find((a) => a.key === 'hostinger');
  assert.ok(hostinger, 'hostinger adapter should be available');
  assert.equal(hostinger.capabilities.domains, true);
  assert.equal(hostinger.capabilities.dns, true);
  // Hostinger's API has no FTP credentials endpoint, so this must stay false.
  assert.equal(hostinger.capabilities.ftp, false);
});

test('a provider can be created and its token is never returned', async () => {
  const res = await admin('/providers', {
    method: 'POST',
    body: { name: 'Hostinger (test)', adapter: 'hostinger', token: 'test-token-ABCD1234' },
  });
  assert.equal(res.status, 201);
  ctx.providerId = res.data.provider.id;

  const serialised = JSON.stringify(res.data);
  assert.ok(!serialised.includes('test-token-ABCD1234'), 'raw token must not reach the client');
  assert.equal(res.data.provider.tokenHint, '••••1234');
  assert.equal(res.data.provider.hasToken, true);
});

test('provider list never leaks tokens', async () => {
  const { data } = await admin('/providers');
  assert.ok(!JSON.stringify(data).includes('test-token-ABCD1234'));
  assert.ok(data.providers.every((p) => !('encryptedToken' in p)));
});

test('test connection always reports a definite, explained outcome', async () => {
  // This server talks to whatever provider endpoint it is configured for, so
  // the outcome itself is not asserted here — only that it is definite and
  // explained, never silently empty. `tests/hostinger-adapter.test.js` covers
  // accepted and rejected tokens deterministically against a stub.
  const { status, data } = await admin(`/providers/${ctx.providerId}/test`, { method: 'POST' });
  assert.ok([200, 400].includes(status), `unexpected status ${status}`);
  assert.equal(typeof data.ok, 'boolean');
  assert.equal(data.ok, status === 200);
  assert.ok(data.message?.length > 0, 'a result must always carry a message');
  ctx.testOk = data.ok;
});

test('the connection test result is recorded on the provider', async () => {
  const { data } = await admin('/providers');
  const provider = data.providers.find((p) => p.id === ctx.providerId);
  assert.equal(provider.lastTestOk, ctx.testOk);
  assert.ok(provider.lastTestedAt, 'the test timestamp must be stored');
  assert.ok(provider.lastTestMessage?.length > 0);
});

test('domains can be added manually and are labelled as such', async () => {
  const a = await admin('/domains', { method: 'POST', body: { name: ownDomain } });
  assert.equal(a.status, 201);
  ctx.ownDomainId = a.data.domain.id;
  assert.equal(a.data.domain.source, 'MANUAL');

  const b = await admin('/domains', { method: 'POST', body: { name: otherDomain } });
  ctx.otherDomainId = b.data.domain.id;

  const list = await admin('/domains');
  const found = list.data.domains.find((d) => d.id === ctx.ownDomainId);
  assert.equal(found.sourceLabel, 'Manually Added');
});

test('duplicate domains are rejected', async () => {
  const res = await admin('/domains', { method: 'POST', body: { name: ownDomain } });
  assert.equal(res.status, 400);
});

test('invalid domain names are rejected', async () => {
  const res = await admin('/domains', { method: 'POST', body: { name: 'not a domain' } });
  assert.equal(res.status, 400);
  assert.ok(res.data.details?.length);
});

test('DNS records can be created and listed', async () => {
  const res = await admin(`/domains/${ctx.ownDomainId}/dns`, {
    method: 'POST',
    body: { name: '@', type: 'A', content: '203.0.113.10', ttl: 3600 },
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.record.isFromProvider, false);

  const detail = await admin(`/domains/${ctx.ownDomainId}`);
  assert.equal(detail.data.dnsRecords.length, 1);
});

test('invalid DNS record types are rejected', async () => {
  const res = await admin(`/domains/${ctx.ownDomainId}/dns`, {
    method: 'POST',
    body: { name: '@', type: 'NOPE', content: 'x' },
  });
  assert.equal(res.status, 400);
});

test('mailboxes can be added manually', async () => {
  const res = await admin(`/domains/${ctx.ownDomainId}/emails`, {
    method: 'POST',
    body: { address: `info@${ownDomain}`, status: 'active' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.email.isFromProvider, false);

  const dupe = await admin(`/domains/${ctx.ownDomainId}/emails`, {
    method: 'POST',
    body: { address: `info@${ownDomain}` },
  });
  assert.equal(dupe.status, 400, 'duplicate mailbox should be rejected');
});

test('FTP and server settings can be stored manually', async () => {
  const res = await admin(`/domains/${ctx.ownDomainId}/settings`, {
    method: 'PUT',
    body: { ftpHost: 'ftp.example.test', ftpPort: 21, ftpProtocol: 'FTPS', serverIp: '203.0.113.10' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.settings.ftpProtocol, 'FTPS');
  assert.equal(res.data.settings.ftpPort, 21);
});

test('a user can be created and assigned a single domain', async () => {
  const created = await admin('/users', {
    method: 'POST',
    body: { name: 'Test User', email: userEmail, password: userPassword, role: 'USER' },
  });
  assert.equal(created.status, 201);
  ctx.userId = created.data.user.id;

  const assigned = await admin(`/users/${ctx.userId}/domains`, {
    method: 'PUT',
    body: { domainIds: [ctx.ownDomainId] },
  });
  assert.equal(assigned.status, 200);
  assert.equal(assigned.data.domains.length, 1);
});

test('server resources can be configured for a user', async () => {
  const res = await admin(`/users/${ctx.userId}/resources`, {
    method: 'PUT',
    body: { cpuCores: 4, ramMb: 8192, storageGb: 50, bandwidthGb: 500 },
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.resource.cpuCores, 4);
});

test('the user can sign in', async () => {
  const res = await member('/auth/login', {
    method: 'POST',
    body: { email: userEmail, password: userPassword },
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.user.role, 'USER');
});

test('the user only sees their assigned domains', async () => {
  const { data } = await member('/domains');
  assert.equal(data.domains.length, 1);
  assert.equal(data.domains[0].id, ctx.ownDomainId);
});

test('changing the id in the URL does not expose another domain', async () => {
  const res = await member(`/domains/${ctx.otherDomainId}`);
  assert.equal(res.status, 404, 'unassigned domain must not be readable');

  const dns = await member(`/domains/${ctx.otherDomainId}/dns`, {
    method: 'POST',
    body: { name: '@', type: 'A', content: '198.51.100.1' },
  });
  assert.equal(dns.status, 404, 'unassigned domain must not be writable');

  const settings = await member(`/domains/${ctx.otherDomainId}/settings`, {
    method: 'PUT',
    body: { ftpHost: 'evil.example' },
  });
  assert.equal(settings.status, 404);
});

test('the user can read the domain assigned to them', async () => {
  const { status, data } = await member(`/domains/${ctx.ownDomainId}`);
  assert.equal(status, 200);
  assert.equal(data.domain.id, ctx.ownDomainId);
  // Only admins see who else has access.
  assert.equal(data.assignedUsers, undefined);
});

test('admin-only areas are closed to normal users', async () => {
  assert.equal((await member('/users')).status, 403);
  assert.equal((await member('/providers')).status, 403);
  assert.equal((await member(`/providers/${ctx.providerId}/test`, { method: 'POST' })).status, 403);
  // Creating and deleting domains stays with the admin.
  assert.equal((await member('/domains', { method: 'POST', body: { name: `x-${stamp}.example` } })).status, 403);
  assert.equal((await member(`/domains/${ctx.ownDomainId}`, { method: 'DELETE' })).status, 403);
});

test('the user dashboard is scoped to their own data', async () => {
  const { data } = await member('/dashboard');
  assert.equal(data.role, 'USER');
  assert.equal(data.stats.myDomains, 1);
  assert.equal(data.resource.cpuCores, 4);
  assert.equal(data.resource.ramMb, 8192);
});

test('the user sees only mailboxes on their own domains', async () => {
  await admin(`/domains/${ctx.otherDomainId}/emails`, {
    method: 'POST',
    body: { address: `secret@${otherDomain}` },
  });
  // Mailboxes come back grouped by domain, and only assigned domains appear.
  const { data } = await member('/dashboard/my-emails');
  assert.ok(data.domains.every((d) => d.id === ctx.ownDomainId));
  assert.ok(!JSON.stringify(data).includes('secret@'), "another user's mailbox must not appear");
});

test('a disabled account loses access immediately', async () => {
  await admin(`/users/${ctx.userId}`, { method: 'PUT', body: { isActive: false } });
  const res = await member('/domains');
  assert.equal(res.status, 401, 'an existing session must stop working once disabled');

  const login = await member('/auth/login', {
    method: 'POST',
    body: { email: userEmail, password: userPassword },
  });
  assert.equal(login.status, 401);
});

test('the last super admin cannot be demoted or disabled', async () => {
  const { data } = await admin('/auth/me');
  const res = await admin(`/users/${data.user.id}`, { method: 'PUT', body: { isActive: false } });
  assert.equal(res.status, 400);
});

test('cleanup', async () => {
  await admin(`/users/${ctx.userId}`, { method: 'DELETE' });
  await admin(`/domains/${ctx.ownDomainId}`, { method: 'DELETE' });
  await admin(`/domains/${ctx.otherDomainId}`, { method: 'DELETE' });
  await admin(`/providers/${ctx.providerId}`, { method: 'DELETE' });
  assert.equal((await admin('/auth/logout', { method: 'POST' })).status, 200);
});
