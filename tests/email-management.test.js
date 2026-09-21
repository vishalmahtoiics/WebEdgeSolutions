// Mailbox management against a stub of Hostinger's mail API.
//
// These are write operations on a real hosting account, so the things worth
// proving are: the portal only records a mailbox the provider confirmed, a
// provider deletion is a separate act from removing the portal's record, and a
// user cannot touch a domain that is not theirs.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

const TOKEN = 'stub-token';
const PORT = 3996;
const BASE = `http://127.0.0.1:${PORT}`;
const prisma = new PrismaClient();

const stamp = Date.now();
const DOMAIN = `mail-${stamp}.example`;
const OTHER = `other-${stamp}.example`;
const userEmail = `mailuser+${stamp}@example.com`;
const userPassword = 'MailUser@12345';

// Stub state, so deletes and creates are observable.
let mailboxes = [
  { id: 'mb_1', address: `info@${DOMAIN}`, status: 'active', usage: { storageQuota: 10485760, storageUsed: 524288 } },
];
const calls = [];

function stubRoutes() {
  return {
    '/api/domains/v1/portfolio': [
      { id: 900, domain: DOMAIN, type: 'domain', status: 'active', createdAt: '2024-01-01T00:00:00Z', expiresAt: null },
      { id: 901, domain: OTHER, type: 'domain', status: 'active', createdAt: '2024-01-01T00:00:00Z', expiresAt: null },
    ],
    '/api/hosting/v1/websites': [],
    '/api/mail/v1/orders': { data: [{ id: 'ord_m', status: 'active', seats: 5, domain: { domain: DOMAIN } }] },
    '/api/mail/v1/orders/ord_m/mailboxes': { data: mailboxes },
    '/api/mail/v1/orders/ord_m/forwarders': { data: [{ id: 'fw_1', mailbox: { id: 'mb_1', address: `info@${DOMAIN}` }, destination: 'backup@elsewhere.test', isKeepCopyEnabled: true, isActive: true, isConfirmed: false }] },
    '/api/mail/v1/orders/ord_m/aliases': { data: [{ id: 'al_1', address: `sales@${DOMAIN}`, mailbox: { id: 'mb_1', address: `info@${DOMAIN}` }, isActive: true }] },
    '/api/mail/v1/orders/ord_m/autoreplies': { data: [] },
    '/api/mail/v1/orders/ord_m/catchalls': { data: [] },
  };
}

let stub;
let server;
const admin = cookieClient();
const member = cookieClient();
const ctx = {};

function cookieClient() {
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
    return { status: res.status, data: text ? JSON.parse(text) : null };
  };
}

test.before(async () => {
  stub = http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    calls.push(`${req.method} ${path}`);

    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ message: 'Invalid or expired API token.' }));
    }

    // Create mailbox
    if (req.method === 'POST' && path === '/api/mail/v1/orders/ord_m/mailboxes') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      return req.on('end', () => {
        const { localPart, password } = JSON.parse(raw || '{}');
        if (!password || password.length < 8) {
          res.writeHead(422, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ message: 'Validation failed', errors: { password: ['Password is too weak.'] } }));
        }
        const created = { id: `mb_${mailboxes.length + 1}`, address: `${localPart}@${DOMAIN}`, status: 'active', usage: { storageQuota: 10485760, storageUsed: 0 } };
        mailboxes.push(created);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: created }));
      });
    }

    // Delete mailbox
    const del = path.match(/^\/api\/mail\/v1\/mailboxes\/([^/]+)$/);
    if (req.method === 'DELETE' && del) {
      mailboxes = mailboxes.filter((m) => m.id !== del[1]);
      res.writeHead(204);
      return res.end();
    }

    // Change password
    if (req.method === 'PATCH' && /^\/api\/mail\/v1\/mailboxes\/[^/]+\/password$/.test(path)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: { ok: true } }));
    }

    const table = stubRoutes();
    if (path in table) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(table[path]));
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

  assert.equal((await admin('/auth/login', { method: 'POST', body: { email: 'admin@example.com', password: 'Admin@12345' } })).status, 200);

  const prov = await admin('/providers', { method: 'POST', body: { name: `Hostinger mail ${stamp}`, adapter: 'hostinger', token: TOKEN } });
  ctx.providerId = prov.data.provider.id;
  await admin(`/providers/${ctx.providerId}/test`, { method: 'POST' });
  await admin(`/providers/${ctx.providerId}/sync`, { method: 'POST' });

  const synced = await admin(`/providers/${ctx.providerId}/sync`, { method: 'POST' });
  assert.equal(synced.status, 200, `sync failed: ${JSON.stringify(synced.data)}`);

  const list = await admin('/domains');
  assert.ok(
    list.data.domains.some((d) => d.name === DOMAIN),
    `domain not imported. sync said: ${JSON.stringify(synced.data)}; domains: ${JSON.stringify(list.data.domains?.map((d) => d.name))}`,
  );
  ctx.domainId = list.data.domains.find((d) => d.name === DOMAIN).id;
  ctx.otherId = list.data.domains.find((d) => d.name === OTHER).id;
});

test.after(async () => {
  if (ctx.userId) await admin(`/users/${ctx.userId}`, { method: 'DELETE' });
  if (ctx.providerId) await admin(`/providers/${ctx.providerId}`, { method: 'DELETE' });
  await prisma.domain.deleteMany({ where: { name: { in: [DOMAIN, OTHER] } } });
  await prisma.$disconnect();
  server?.kill();
  stub?.close();
});

test('the adapter advertises mailbox writes', async () => {
  const { data } = await admin('/providers/adapters');
  const hostinger = data.adapters.find((a) => a.key === 'hostinger');
  assert.equal(hostinger.capabilities.emailWrite, true);
  assert.equal(hostinger.capabilities.emailExtras, true);
});

test('mailbox usage is read in kilobytes and stored as megabytes', async () => {
  await admin(`/domains/${ctx.domainId}/emails/sync`, { method: 'POST' });
  const { data } = await admin(`/domains/${ctx.domainId}`);
  const info = data.emailAccounts.find((m) => m.address === `info@${DOMAIN}`);
  assert.equal(info.quotaMb, 10240, '10485760 KB is 10240 MB');
  assert.equal(info.usedMb, 512, '524288 KB is 512 MB');
});

test('creating a mailbox provisions it at the provider', async () => {
  const res = await admin(`/domains/${ctx.domainId}/emails/provision`, {
    method: 'POST',
    body: { address: `support@${DOMAIN}`, password: 'Str0ng!Passw0rd' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.email.isFromProvider, true);
  assert.ok(res.data.email.externalId, 'the provider id must be stored so it can be managed later');
  assert.ok(mailboxes.some((m) => m.address === `support@${DOMAIN}`), 'it should exist at the provider');
});

test('the address must belong to the domain being managed', async () => {
  const res = await admin(`/domains/${ctx.domainId}/emails/provision`, {
    method: 'POST',
    body: { address: 'someone@unrelated.test', password: 'Str0ng!Passw0rd' },
  });
  assert.equal(res.status, 400);
  assert.match(res.data.error, new RegExp(DOMAIN));
});

test("a provider rejection is passed through, and nothing is recorded locally", async () => {
  const before = (await admin(`/domains/${ctx.domainId}`)).data.emailAccounts.length;

  const res = await admin(`/domains/${ctx.domainId}/emails/provision`, {
    method: 'POST',
    body: { address: `weak@${DOMAIN}`, password: 'short' },
  });
  assert.equal(res.status, 400);

  const after = (await admin(`/domains/${ctx.domainId}`)).data.emailAccounts.length;
  assert.equal(after, before, 'a failed creation must not leave a local row behind');
});

test('a mailbox password can be changed at the provider', async () => {
  const { data } = await admin(`/domains/${ctx.domainId}`);
  const mailbox = data.emailAccounts.find((m) => m.externalId);
  const res = await admin(`/domains/${ctx.domainId}/emails/${mailbox.id}/password`, {
    method: 'POST',
    body: { password: 'An0ther!Passw0rd' },
  });
  assert.equal(res.status, 200);
  assert.ok(calls.some((c) => /PATCH .*\/password$/.test(c)));
});

test('removing from the portal leaves the provider mailbox alone', async () => {
  const { data } = await admin(`/domains/${ctx.domainId}`);
  const mailbox = data.emailAccounts.find((m) => m.address === `info@${DOMAIN}`);
  const countBefore = mailboxes.length;

  const res = await admin(`/domains/${ctx.domainId}/emails/${mailbox.id}`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.equal(mailboxes.length, countBefore, 'the provider must not be touched by a portal-only removal');
});

test('deleting at the provider removes it from both sides', async () => {
  await admin(`/domains/${ctx.domainId}/emails/sync`, { method: 'POST' });
  const { data } = await admin(`/domains/${ctx.domainId}`);
  const mailbox = data.emailAccounts.find((m) => m.address === `support@${DOMAIN}`);

  const res = await admin(`/domains/${ctx.domainId}/emails/${mailbox.id}/destroy`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.ok(!mailboxes.some((m) => m.address === `support@${DOMAIN}`), 'it should be gone at the provider');

  const after = await admin(`/domains/${ctx.domainId}`);
  assert.ok(!after.data.emailAccounts.some((m) => m.address === `support@${DOMAIN}`));
});

test('a portal-only mailbox cannot be deleted at the provider', async () => {
  const created = await admin(`/domains/${ctx.domainId}/emails`, {
    method: 'POST',
    body: { address: `manual@${DOMAIN}` },
  });
  const res = await admin(`/domains/${ctx.domainId}/emails/${created.data.email.id}/destroy`, { method: 'DELETE' });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /only exists in the portal/);
});

test('forwarders and aliases are read from the provider', async () => {
  const { status, data } = await admin(`/domains/${ctx.domainId}/emails/extras`);
  assert.equal(status, 200);
  assert.equal(data.supported, true);
  assert.equal(data.extras.forwarders.length, 1);
  assert.equal(data.extras.forwarders[0].destination, 'backup@elsewhere.test');
  assert.equal(data.extras.forwarders[0].isConfirmed, false);
  assert.equal(data.extras.aliases[0].address, `sales@${DOMAIN}`);
});

test('a domain with no mail plan reports that clearly', async () => {
  const res = await admin(`/domains/${ctx.otherId}/emails/provision`, {
    method: 'POST',
    body: { address: `info@${OTHER}`, password: 'Str0ng!Passw0rd' },
  });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /no email plan/);
});

test('an assigned user can manage their own domain mailboxes', async () => {
  const created = await admin('/users', {
    method: 'POST',
    body: { name: 'Mail User', email: userEmail, password: userPassword, role: 'USER' },
  });
  ctx.userId = created.data.user.id;
  await admin(`/users/${ctx.userId}/domains`, { method: 'PUT', body: { domainIds: [ctx.domainId] } });

  assert.equal((await member('/auth/login', { method: 'POST', body: { email: userEmail, password: userPassword } })).status, 200);

  const res = await member(`/domains/${ctx.domainId}/emails/provision`, {
    method: 'POST',
    body: { address: `user-made@${DOMAIN}`, password: 'Str0ng!Passw0rd' },
  });
  assert.equal(res.status, 201, 'an assigned user may create mailboxes on their domain');
});

test('a user cannot manage mailboxes on a domain they are not assigned', async () => {
  for (const [label, call] of [
    ['provision', member(`/domains/${ctx.otherId}/emails/provision`, { method: 'POST', body: { address: `x@${OTHER}`, password: 'Str0ng!Passw0rd' } })],
    ['extras', member(`/domains/${ctx.otherId}/emails/extras`)],
    ['sync', member(`/domains/${ctx.otherId}/emails/sync`, { method: 'POST' })],
  ]) {
    assert.equal((await call).status, 404, `${label} must not reach an unassigned domain`);
  }
});

// --- Real values versus custom ones ----------------------------------------

test('a synced mailbox carries the real size and usage from the server', async () => {
  await admin(`/domains/${ctx.domainId}/emails/sync`, { method: 'POST' });
  const { data } = await admin(`/domains/${ctx.domainId}`);
  const info = data.emailAccounts.find((m) => m.address === `info@${DOMAIN}`);

  assert.equal(info.providerQuotaMb, 10240, 'the real quota is kept');
  assert.equal(info.providerUsedMb, 512, 'the real usage is kept');
  assert.equal(info.quotaMb, 10240, 'with no override, the real value is shown');
  assert.equal(info.usesCustomQuota, false);
  ctx.infoId = info.id;
});

test('an admin can show a custom size while the real one is still kept', async () => {
  const res = await admin(`/domains/${ctx.domainId}/emails/${ctx.infoId}`, {
    method: 'PUT',
    body: {
      address: `info@${DOMAIN}`,
      status: 'active',
      useRealQuota: false,
      quotaMb: 25600,
      useRealUsed: true,
    },
  });
  assert.equal(res.status, 200);

  const m = res.data.email;
  assert.equal(m.quotaMb, 25600, 'the custom figure is what is shown');
  assert.equal(m.usesCustomQuota, true);
  assert.equal(m.providerQuotaMb, 10240, 'the real figure is still there underneath');
  assert.equal(m.usedMb, 512, 'usage still tracks the real value');
  assert.equal(m.usesCustomUsed, false);
});

test('a custom value survives a sync, and the real one keeps updating', async () => {
  // The server now reports a different usage figure.
  mailboxes = mailboxes.map((m) =>
    m.address === `info@${DOMAIN}` ? { ...m, usage: { storageQuota: 10485760, storageUsed: 3145728 } } : m,
  );

  await admin(`/domains/${ctx.domainId}/emails/sync`, { method: 'POST' });
  const { data } = await admin(`/domains/${ctx.domainId}`);
  const m = data.emailAccounts.find((x) => x.id === ctx.infoId);

  assert.equal(m.quotaMb, 25600, 'the override must not be wiped by a sync');
  assert.equal(m.providerQuotaMb, 10240, 'the real quota is still tracked');
  assert.equal(m.usedMb, 3072, 'usage follows the server because it has no override');
});

test('ticking "use the real value" restores it', async () => {
  const res = await admin(`/domains/${ctx.domainId}/emails/${ctx.infoId}`, {
    method: 'PUT',
    body: { address: `info@${DOMAIN}`, status: 'active', useRealQuota: true, useRealUsed: true },
  });
  assert.equal(res.data.email.usesCustomQuota, false);
  assert.equal(res.data.email.quotaMb, 10240, 'back to the server figure');
});

test('editing a mailbox no longer detaches it from the server', async () => {
  const { data } = await admin(`/domains/${ctx.domainId}`);
  const m = data.emailAccounts.find((x) => x.id === ctx.infoId);
  assert.equal(m.isFromProvider, true, 'it must keep syncing after being edited');
  assert.ok(m.externalId, 'and keep its upstream id, so Password still works');
});

test('a user sees the effective figure but not the two apart', async () => {
  const { data } = await member(`/domains/${ctx.domainId}`);
  const m = data.emailAccounts.find((x) => x.address === `info@${DOMAIN}`);
  assert.equal(typeof m.quotaMb, 'number', 'they still see a size');
  for (const field of ['providerQuotaMb', 'quotaMbOverride', 'usesCustomQuota', 'isFromProvider']) {
    assert.equal(m[field], undefined, `${field} is an administrator's concern`);
  }
});
