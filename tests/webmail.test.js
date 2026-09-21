// Webmail, exercised against a real IMAP server and a real SMTP server.
//
// Reading and sending are the whole feature, so both are done for real here:
// hoodiecrow-imap serves an inbox, smtp-server receives what is sent, and the
// assertions check the actual bytes that arrived.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import hoodiecrow from 'hoodiecrow-imap';
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import { PrismaClient } from '@prisma/client';

const PORT = 3991;
const BASE = `http://127.0.0.1:${PORT}`;
const MAILBOX_PASSWORD = 'MailboxPass!123';
const prisma = new PrismaClient();

const stamp = Date.now();
const DOMAIN = `mail-${stamp}.example`;
const OTHER = `other-${stamp}.example`;
const ADDRESS = `info@${DOMAIN}`;
const userEmail = `mailuser+${stamp}@example.com`;
const userPassword = 'MailUser@12345';

let imapServer;
let smtpServer;
let server;
const received = [];       // messages the SMTP server actually accepted
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

const message = (subject, from, body) =>
  ({ raw: `Subject: ${subject}\r\nFrom: ${from}\r\nTo: ${ADDRESS}\r\nDate: Mon, 21 Sep 2026 10:00:00 +0000\r\n\r\n${body}` });

test.before(async () => {
  imapServer = hoodiecrow({
    plugins: ['ID', 'SPECIAL-USE'],
    // The mailbox signs in as its own address, so the server has to know it.
    users: { [ADDRESS]: { password: MAILBOX_PASSWORD } },
    storage: {
      INBOX: {
        messages: [
          message('First email', 'alice@example.com', 'Hello from Alice.'),
          message('Second email', 'bob@example.com', 'Hello from Bob.'),
          message('Third email', 'carol@example.com', 'Hello from Carol.'),
        ],
      },
      '': {
        separator: '/',
        folders: {
          Sent: { 'special-use': '\\Sent' },
          Trash: { 'special-use': '\\Trash' },
        },
      },
    },
  });
  await new Promise((r) => imapServer.listen(0, '127.0.0.1', r));
  const imapPort = imapServer.server.address().port;

  smtpServer = new SMTPServer({
    disabledCommands: ['STARTTLS'],
    onAuth(auth, _session, callback) {
      if (auth.username === ADDRESS && auth.password === MAILBOX_PASSWORD) {
        return callback(null, { user: auth.username });
      }
      return callback(new Error('Invalid credentials'));
    },
    onData(stream, _session, callback) {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', async () => {
        received.push(await simpleParser(Buffer.concat(chunks)));
        callback();
      });
    },
  });
  await new Promise((r) => smtpServer.listen(0, '127.0.0.1', r));
  const smtpPort = smtpServer.server.address().port;

  server = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  for (let i = 0; i < 80; i += 1) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  await admin('/auth/login', { method: 'POST', body: { email: 'admin@example.com', password: 'Admin@12345' } });

  const a = await admin('/domains', { method: 'POST', body: { name: DOMAIN } });
  ctx.domainId = a.data.domain.id;
  const b = await admin('/domains', { method: 'POST', body: { name: OTHER } });
  ctx.otherId = b.data.domain.id;

  await admin(`/domains/${ctx.domainId}/settings`, {
    method: 'PUT',
    body: {
      imapHost: '127.0.0.1', imapPort, imapSecure: false,
      smtpHost: '127.0.0.1', smtpPort, smtpSecure: false,
    },
  });

  const mailbox = await admin(`/domains/${ctx.domainId}/emails`, {
    method: 'POST',
    body: { address: ADDRESS },
  });
  ctx.mailboxId = mailbox.data.email.id;

  const created = await admin('/users', {
    method: 'POST',
    body: { name: 'Mail User', email: userEmail, password: userPassword, role: 'USER' },
  });
  ctx.userId = created.data.user.id;
  await admin(`/users/${ctx.userId}/domains`, { method: 'PUT', body: { domainIds: [ctx.domainId] } });
  await member('/auth/login', { method: 'POST', body: { email: userEmail, password: userPassword } });
});

test.after(async () => {
  try {
    if (ctx.userId) await admin(`/users/${ctx.userId}`, { method: 'DELETE' });
    await prisma.domain.deleteMany({ where: { name: { in: [DOMAIN, OTHER] } } });
    await prisma.$disconnect();
  } catch (err) {
    console.error('TEARDOWN:', err?.message);
  }
  server?.kill();
  await new Promise((r) => smtpServer.close(r));
  await new Promise((r) => imapServer.close(r));
});

// --- The password -----------------------------------------------------------

test('a mailbox without a password says so rather than failing obscurely', async () => {
  const res = await admin(`/domains/${ctx.domainId}/emails/${ctx.mailboxId}/mail/folders`);
  assert.equal(res.status, 400);
  assert.match(res.data.error, /No password is saved/i);
});

test('the mailbox password can be saved', async () => {
  const res = await admin(`/domains/${ctx.domainId}/emails/${ctx.mailboxId}/mail/password`, {
    method: 'PUT',
    body: { password: MAILBOX_PASSWORD },
  });
  assert.equal(res.status, 200);
});

test('the mailbox password is encrypted and never returned', async () => {
  const row = await prisma.emailAccount.findUnique({ where: { id: ctx.mailboxId } });
  assert.notEqual(row.encryptedPassword, MAILBOX_PASSWORD, 'must not be stored in the clear');
  assert.equal(row.encryptedPassword.split(':').length, 3, 'stored as iv:tag:ciphertext');

  const detail = await admin(`/domains/${ctx.domainId}`);
  assert.ok(!detail.text.includes(MAILBOX_PASSWORD), 'must not appear in any response');
  assert.ok(!detail.text.includes('encryptedPassword'), 'the column must not be exposed either');
});

test('the connection can be tested', async () => {
  const res = await admin(`/domains/${ctx.domainId}/emails/${ctx.mailboxId}/mail/test`, { method: 'POST' });
  if (res.status !== 200) console.error('DEBUG:', JSON.stringify(res.data));
  assert.equal(res.status, 200);
  assert.equal(res.data.imap.ok, true);
  assert.equal(res.data.smtp.ok, true);
});

// --- Reading ----------------------------------------------------------------

test('folders are listed, with the special ones recognised', async () => {
  const { status, data } = await admin(`/domains/${ctx.domainId}/emails/${ctx.mailboxId}/mail/folders`);
  assert.equal(status, 200);

  const byUse = Object.fromEntries(data.folders.map((f) => [f.specialUse, f.path]));
  assert.equal(byUse.inbox, 'INBOX');
  assert.ok(byUse.sent, 'a Sent folder should be found');
  assert.ok(byUse.trash, 'a Trash folder should be found');
});

test('the inbox lists messages, newest first', async () => {
  const { status, data } = await admin(`/domains/${ctx.domainId}/emails/${ctx.mailboxId}/mail/messages`);
  assert.equal(status, 200);
  assert.equal(data.total, 3);
  assert.deepEqual(data.messages.map((m) => m.subject), ['Third email', 'Second email', 'First email']);
  assert.equal(data.messages[0].from[0].address, 'carol@example.com');
  ctx.uid = data.messages.at(-1).uid;
});

test('a message can be opened and its body read', async () => {
  const { status, data } = await admin(
    `/domains/${ctx.domainId}/emails/${ctx.mailboxId}/mail/messages/${ctx.uid}`,
  );
  assert.equal(status, 200);
  assert.equal(data.message.subject, 'First email');
  assert.match(data.message.text, /Hello from Alice/);
  assert.equal(data.message.from[0].address, 'alice@example.com');
});

test('opening a message marks it read', async () => {
  const { data } = await admin(`/domains/${ctx.domainId}/emails/${ctx.mailboxId}/mail/messages`);
  const opened = data.messages.find((m) => m.uid === ctx.uid);
  assert.equal(opened.seen, true);
});

test('an invalid message id is refused', async () => {
  const res = await admin(`/domains/${ctx.domainId}/emails/${ctx.mailboxId}/mail/messages/abc`);
  assert.equal(res.status, 400);
});

// --- Sending ----------------------------------------------------------------

test('a message is actually delivered to the mail server', async () => {
  const before = received.length;

  const res = await admin(`/domains/${ctx.domainId}/emails/${ctx.mailboxId}/mail/send`, {
    method: 'POST',
    body: { to: 'someone@elsewhere.test', subject: 'Hello from the portal', text: 'This was sent from the portal.' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.ok, true);

  for (let i = 0; i < 40 && received.length === before; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(received.length, before + 1, 'the SMTP server should have received it');

  const sent = received.at(-1);
  assert.equal(sent.subject, 'Hello from the portal');
  assert.equal(sent.from.value[0].address, ADDRESS, 'the From address is the mailbox itself');
  assert.equal(sent.to.value[0].address, 'someone@elsewhere.test');
  assert.match(sent.text, /sent from the portal/);
});

test('several recipients can be given at once', async () => {
  const before = received.length;
  const res = await admin(`/domains/${ctx.domainId}/emails/${ctx.mailboxId}/mail/send`, {
    method: 'POST',
    body: { to: 'one@elsewhere.test, two@elsewhere.test', subject: 'Two people', text: 'Hi both.' },
  });
  assert.equal(res.status, 200);

  for (let i = 0; i < 40 && received.length === before; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const sent = received.at(-1);
  assert.deepEqual(sent.to.value.map((a) => a.address), ['one@elsewhere.test', 'two@elsewhere.test']);
});

test('sending with no recipient is refused', async () => {
  const res = await admin(`/domains/${ctx.domainId}/emails/${ctx.mailboxId}/mail/send`, {
    method: 'POST',
    body: { to: '   ', subject: 'Nobody', text: 'x' },
  });
  assert.equal(res.status, 400);
});

// --- Authorization ----------------------------------------------------------

test('an assigned user can read and send from their mailbox', async () => {
  const list = await member(`/domains/${ctx.domainId}/emails/${ctx.mailboxId}/mail/messages`);
  assert.equal(list.status, 200);
  assert.ok(list.data.messages.length);

  const sent = await member(`/domains/${ctx.domainId}/emails/${ctx.mailboxId}/mail/send`, {
    method: 'POST',
    body: { to: 'user-sent@elsewhere.test', subject: 'From the user', text: 'Sent by an assigned user.' },
  });
  assert.equal(sent.status, 200);
});

test('a user cannot reach a mailbox on a domain they are not assigned', async () => {
  for (const [label, call] of [
    ['folders', member(`/domains/${ctx.otherId}/emails/${ctx.mailboxId}/mail/folders`)],
    ['messages', member(`/domains/${ctx.otherId}/emails/${ctx.mailboxId}/mail/messages`)],
    ['send', member(`/domains/${ctx.otherId}/emails/${ctx.mailboxId}/mail/send`, { method: 'POST', body: { to: 'x@y.test', text: 'x' } })],
    ['password', member(`/domains/${ctx.otherId}/emails/${ctx.mailboxId}/mail/password`, { method: 'PUT', body: { password: 'x' } })],
  ]) {
    assert.equal((await call).status, 404, `${label} must not reach an unassigned domain`);
  }
});

test('a mailbox id from another domain is not accepted', async () => {
  // The mailbox exists, but not on this domain — so it must not resolve.
  const res = await admin(`/domains/${ctx.otherId}/emails/${ctx.mailboxId}/mail/messages`);
  assert.equal(res.status, 404);
});

// --- Removing the password --------------------------------------------------

test('the saved password can be removed', async () => {
  const res = await admin(`/domains/${ctx.domainId}/emails/${ctx.mailboxId}/mail/password`, {
    method: 'DELETE',
  });
  assert.equal(res.status, 200);

  const row = await prisma.emailAccount.findUnique({ where: { id: ctx.mailboxId } });
  assert.equal(row.encryptedPassword, null);

  const after = await admin(`/domains/${ctx.domainId}/emails/${ctx.mailboxId}/mail/folders`);
  assert.equal(after.status, 400, 'the inbox is closed again once the password is gone');
});
