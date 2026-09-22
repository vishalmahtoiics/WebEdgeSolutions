// Support tickets, against a real SMTP server.
//
// Two things are being checked, and the second is the one that bites:
//
//   A new ticket reaches you. That is the whole feature — a ticket system
//   nobody is told about is a form that goes nowhere.
//
//   An internal note never reaches the customer. It is excluded by the query
//   rather than hidden in the interface, so this file goes at the API
//   directly: a note that is only invisible in the browser is one fetch away
//   from being read by the person it was written about.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import { PrismaClient } from '@prisma/client';

const PORT = 3974;
const BASE = `http://127.0.0.1:${PORT}`;
const prisma = new PrismaClient();

const stamp = Date.now();
const DOMAIN = `support-${stamp}.example`;
const OTHER_DOMAIN = `notmine-${stamp}.example`;
const ALERT_TO = `support-ops-${stamp}@example.com`;
const userEmail = `support+${stamp}@example.com`;
const userPassword = 'SupportUser@12345';
const otherEmail = `other+${stamp}@example.com`;
const otherPassword = 'OtherUser@12345';

let smtpServer;
let server;
const received = [];

const admin = client();
const member = client();
const other = client();
const anon = client();
const ctx = {};
let originalSettings = null;

const ignoreResets = (s) => {
  s.on('clientError', () => {});
  s.on('error', () => {});
  s.on('connection', (socket) => socket.on('error', () => {}));
  return s;
};

function client() {
  let cookie = '';
  return async function call(pathname, { method = 'GET', body } = {}) {
    const res = await fetch(`${BASE}${pathname}`, {
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
    return { status: res.status, data };
  };
}

/// Matched on the subject rather than counted: the whole suite shares one
/// inbox, and a delta of one would be a claim about every test running at
/// once.
async function waitForMail(pattern, timeoutMs = 12000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const hit = [...received].reverse().find((m) => pattern.test(m.subject || ''));
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

async function expectNoMail(pattern, waitMs = 2500) {
  await new Promise((r) => setTimeout(r, waitMs));
  return !received.some((m) => pattern.test(m.subject || ''));
}

test.before(async () => {
  smtpServer = new SMTPServer({
    disabledCommands: ['STARTTLS'],
    authOptional: true,
    onData(stream, _session, callback) {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', async () => {
        received.push(await simpleParser(Buffer.concat(chunks)));
        callback();
      });
    },
  });
  ignoreResets(smtpServer.server);
  await new Promise((r) => smtpServer.listen(0, '127.0.0.1', r));
  const smtpPort = smtpServer.server.address().port;

  server = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: String(PORT), NOTIFY_BURST_LIMIT: '100000' },
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

  await admin('/api/settings', {
    method: 'PUT',
    body: {
      smtpHost: '127.0.0.1',
      smtpPort,
      smtpSecure: false,
      smtpUser: '',
      fromAddress: 'portal@example.com',
      fromName: 'Hosting Portal',
      notifyEmails: ALERT_TO,
      notifyEnabled: true,
      notifySupport: true,
    },
  });

  const d1 = await admin('/api/domains', { method: 'POST', body: { name: DOMAIN } });
  ctx.domainId = d1.data.domain.id;
  const d2 = await admin('/api/domains', { method: 'POST', body: { name: OTHER_DOMAIN } });
  ctx.otherDomainId = d2.data.domain.id;

  const user = await admin('/api/users', {
    method: 'POST',
    body: { name: 'Support User', email: userEmail, password: userPassword, role: 'USER' },
  });
  ctx.userId = user.data.user.id;
  await admin(`/api/users/${ctx.userId}/domains`, { method: 'PUT', body: { domainIds: [ctx.domainId] } });

  const second = await admin('/api/users', {
    method: 'POST',
    body: { name: 'Other User', email: otherEmail, password: otherPassword, role: 'USER' },
  });
  ctx.otherUserId = second.data.user.id;

  await member('/api/auth/login', { method: 'POST', body: { email: userEmail, password: userPassword } });
  await other('/api/auth/login', { method: 'POST', body: { email: otherEmail, password: otherPassword } });
});

test.after(async () => {
  try {
    await prisma.ticket.deleteMany({ where: { userId: { in: [ctx.userId, ctx.otherUserId].filter(Boolean) } } });
    if (ctx.userId) await admin(`/api/users/${ctx.userId}`, { method: 'DELETE' });
    if (ctx.otherUserId) await admin(`/api/users/${ctx.otherUserId}`, { method: 'DELETE' });
    await prisma.domain.deleteMany({ where: { name: { in: [DOMAIN, OTHER_DOMAIN] } } });
    await prisma.activityLog.deleteMany({ where: { event: { startsWith: 'support.' } } });

    if (originalSettings) {
      const { id, updatedAt, ...rest } = originalSettings;
      await prisma.appSettings.update({ where: { id: 'default' }, data: rest });
    }
    await prisma.$disconnect();
  } catch (err) {
    console.error('TEARDOWN:', err?.message);
  }
  server?.kill();
  await new Promise((r) => smtpServer.close(r));
});

// ---------------------------------------------------------------------------
// Opening a ticket
// ---------------------------------------------------------------------------

test('support needs a session', async () => {
  assert.equal((await anon('/api/tickets')).status, 401);
  assert.equal((await anon('/api/tickets', { method: 'POST', body: { subject: 'x', body: 'yyyyy' } })).status, 401);
});

test('a new ticket emails you straight away', async () => {
  const subject = `Website is down ${stamp}`;
  const res = await member('/api/tickets', {
    method: 'POST',
    body: { subject, body: 'Nothing loads since this morning.', category: 'Technical', priority: 'HIGH', domainId: ctx.domainId },
  });

  assert.equal(res.status, 201);
  ctx.ticketId = res.data.ticket.id;
  ctx.reference = res.data.ticket.reference;
  assert.match(ctx.reference, /^TKT-[A-Z0-9]{6}$/);

  const mail = await waitForMail(new RegExp(`New support ticket: Website is down ${stamp}`));
  assert.ok(mail, 'the alert must actually arrive');
  assert.ok(mail.text.includes(ctx.reference), 'and carry the reference');
  assert.ok(mail.text.includes('Nothing loads since this morning.'), 'and what they said');
  assert.ok(mail.text.includes(DOMAIN), 'and which domain');
});

test('the customer gets an acknowledgement with the reference', async () => {
  const ack = await waitForMail(new RegExp(`We have your request — ${ctx.reference}`));
  assert.ok(ack, 'somebody who asks for help should know it arrived');
  assert.ok(String(ack.to?.text || '').includes(userEmail));
});

test('the ticket is recorded whether or not the email worked', async () => {
  const entry = await prisma.activityLog.findFirst({
    where: { event: 'support.ticket.created' },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(entry);
  assert.match(entry.summary, /New support ticket/);
  assert.equal(entry.domainName, DOMAIN);
});

test('a ticket cannot be raised against somebody else’s domain', async () => {
  const res = await member('/api/tickets', {
    method: 'POST',
    body: { subject: 'Prying', body: 'Is this domain here?', domainId: ctx.otherDomainId },
  });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /not one of yours/);
});

test('an empty or trivial ticket is refused', async () => {
  for (const body of [
    { subject: 'x', body: 'A real description here.' },
    { subject: 'A real subject', body: 'no' },
    { subject: '', body: '' },
  ]) {
    assert.equal((await member('/api/tickets', { method: 'POST', body })).status, 400);
  }
});

// ---------------------------------------------------------------------------
// The conversation
// ---------------------------------------------------------------------------

test('a reply from support emails the customer and moves the ticket', async () => {
  const res = await admin(`/api/tickets/${ctx.ticketId}/reply`, {
    method: 'POST',
    body: { body: 'We are looking at it now.', status: 'AWAITING_CUSTOMER' },
  });

  assert.equal(res.status, 201);
  assert.equal(res.data.ticket.status, 'AWAITING_CUSTOMER');
  assert.equal(res.data.ticket.lastReplyByRole, 'SUPER_ADMIN');

  const mail = await waitForMail(new RegExp(`Re: Website is down ${stamp}`));
  assert.ok(mail, 'the customer hears back');
  assert.ok(mail.text.includes('We are looking at it now.'));
});

test('a reply from the customer puts it back on support', async () => {
  const res = await member(`/api/tickets/${ctx.ticketId}/reply`, {
    method: 'POST',
    body: { body: 'Still down.' },
  });

  assert.equal(res.data.ticket.status, 'AWAITING_SUPPORT');
  assert.equal(res.data.ticket.lastReplyByRole, 'USER');

  const mail = await waitForMail(new RegExp(`Reply on ${ctx.reference}`));
  assert.ok(mail, 'you are told the customer answered');
});

test('a customer cannot set the status by asking nicely', async () => {
  // The field is accepted by the schema and ignored for a customer, rather
  // than rejected: closing a ticket is not theirs to do, and refusing the
  // whole reply over it would lose what they wrote.
  const res = await member(`/api/tickets/${ctx.ticketId}/reply`, {
    method: 'POST',
    body: { body: 'Marking this closed myself.', status: 'CLOSED' },
  });
  assert.equal(res.data.ticket.status, 'AWAITING_SUPPORT');
  assert.equal(res.data.ticket.closedAt, null);
});

test('an internal note never reaches the customer', async () => {
  const note = `Internal only ${stamp}: the disk is full on that server.`;
  const before = await member(`/api/tickets/${ctx.ticketId}`);
  const countBefore = before.data.ticket.messages.length;

  const res = await admin(`/api/tickets/${ctx.ticketId}/reply`, {
    method: 'POST',
    body: { body: note, isInternal: true },
  });
  assert.equal(res.status, 201);

  // The Super Admin sees it.
  const adminView = await admin(`/api/tickets/${ctx.ticketId}`);
  assert.ok(adminView.data.ticket.messages.some((m) => m.body === note));

  // The customer's own API response does not contain it — not hidden, absent.
  const customerView = await member(`/api/tickets/${ctx.ticketId}`);
  assert.equal(customerView.data.ticket.messages.length, countBefore, 'no extra message at all');
  assert.ok(!JSON.stringify(customerView.data).includes('Internal only'));
  assert.ok(customerView.data.ticket.messages.every((m) => m.isInternal === false));
});

test('an internal note does not email the customer or move the ticket', async () => {
  const quiet = await expectNoMail(/Internal only/);
  assert.ok(quiet, 'a note to yourself is not a reply');

  const view = await admin(`/api/tickets/${ctx.ticketId}`);
  assert.equal(view.data.ticket.status, 'AWAITING_SUPPORT', 'still waiting on us');
  assert.equal(view.data.ticket.lastReplyByRole, 'USER', 'the customer still spoke last');
});

// ---------------------------------------------------------------------------
// Who sees what
// ---------------------------------------------------------------------------

test('a customer cannot open somebody else’s ticket', async () => {
  const res = await other(`/api/tickets/${ctx.ticketId}`);
  assert.equal(res.status, 404, 'not 403 — the id must not confirm it exists');

  const replyAttempt = await other(`/api/tickets/${ctx.ticketId}/reply`, { method: 'POST', body: { body: 'Hello there' } });
  assert.equal(replyAttempt.status, 404);
});

test('a customer’s list holds only their own', async () => {
  await other('/api/tickets', { method: 'POST', body: { subject: 'Mine alone', body: 'A question of my own.' } });

  const mine = await member('/api/tickets');
  assert.ok(mine.data.tickets.every((t) => t.userId === ctx.userId));
  assert.ok(!mine.data.tickets.some((t) => t.subject === 'Mine alone'));

  const everything = await admin('/api/tickets');
  assert.ok(everything.data.tickets.some((t) => t.subject === 'Mine alone'), 'the Super Admin sees all of them');
});

test('only the Super Admin can close a ticket', async () => {
  assert.equal(
    (await member(`/api/tickets/${ctx.ticketId}/status`, { method: 'POST', body: { status: 'CLOSED' } })).status,
    403,
  );

  const res = await admin(`/api/tickets/${ctx.ticketId}/status`, { method: 'POST', body: { status: 'RESOLVED' } });
  assert.equal(res.status, 200);
  assert.equal(res.data.ticket.status, 'RESOLVED');
  assert.ok(res.data.ticket.closedAt);
});

test('a closed ticket points the customer at opening a new one', async () => {
  await admin(`/api/tickets/${ctx.ticketId}/status`, { method: 'POST', body: { status: 'CLOSED' } });

  const res = await member(`/api/tickets/${ctx.ticketId}/reply`, { method: 'POST', body: { body: 'One more thing.' } });
  assert.equal(res.status, 400);
  assert.ok(res.data.error.includes(ctx.reference), 'and gives them the reference to quote');

  // Support can still add to it.
  assert.equal(
    (await admin(`/api/tickets/${ctx.ticketId}/reply`, { method: 'POST', body: { body: 'Closing note.' } })).status,
    201,
  );
});

test('the list counts what is waiting on support', async () => {
  const res = await admin('/api/tickets');
  assert.equal(typeof res.data.waitingOnSupport, 'number');
  // Closed and resolved tickets are not a to-do list.
  const closedCounted = res.data.tickets.filter(
    (t) => ['RESOLVED', 'CLOSED'].includes(t.status) && t.lastReplyByRole === 'USER',
  );
  assert.ok(res.data.waitingOnSupport <= res.data.tickets.length - closedCounted.length);
});

test('switching support alerts off stops the email but keeps the record', async () => {
  await admin('/api/settings', { method: 'PUT', body: { notifySupport: false } });

  const subject = `Quiet ticket ${stamp}`;
  const res = await member('/api/tickets', {
    method: 'POST',
    body: { subject, body: 'This one should not email anybody.' },
  });
  assert.equal(res.status, 201);

  assert.ok(await expectNoMail(new RegExp(`New support ticket: Quiet ticket ${stamp}`)), 'no alert');

  const entry = await prisma.activityLog.findFirst({
    where: { event: 'support.ticket.created', summary: { contains: subject } },
  });
  assert.ok(entry, 'but it is still recorded');
  assert.equal(entry.notified, false);

  await admin('/api/settings', { method: 'PUT', body: { notifySupport: true } });
});
