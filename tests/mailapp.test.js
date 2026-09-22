// The standalone webmail app, exercised against a real IMAP server and a real
// SMTP server.
//
// This is the app people reach at the mail hostname: they sign in with an email
// address and the mailbox's own password, with no portal account involved. Every
// assertion below goes through that door.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import hoodiecrow from 'hoodiecrow-imap';
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import { PrismaClient } from '@prisma/client';

const PORT = 3993;
const BASE = `http://127.0.0.1:${PORT}`;
const MAILBOX_PASSWORD = 'Webmail!Pass123';
const prisma = new PrismaClient();

const stamp = Date.now();
const DOMAIN = `webmail-${stamp}.example`;
const ADDRESS = `hello@${DOMAIN}`;

let imapServer;
let smtpServer;
let server;
const received = [];       // what the SMTP server actually accepted, parsed
const rawReceived = [];    // the same messages, as bytes
const admin = client();    // the portal's super admin, for setting the domain up
const mail = client();     // the webmail session
const stranger = client(); // never signs in
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
  return async function call(pathname, { method = 'GET', body, form } = {}) {
    const res = await fetch(`${BASE}${pathname}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        // See the note above `client`.
        Connection: 'close',
      },
      body: form || (body ? JSON.stringify(body) : undefined),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];

    const type = res.headers.get('content-type') || '';
    if (!type.includes('json')) {
      return { status: res.status, buffer: Buffer.from(await res.arrayBuffer()), headers: res.headers };
    }
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, data, text, headers: res.headers };
  };
}

const plain = (subject, from, body, id) => ({
  raw:
    `Subject: ${subject}\r\nFrom: ${from}\r\nTo: ${ADDRESS}\r\n` +
    `Message-ID: <${id}@example.com>\r\nDate: Mon, 21 Sep 2026 10:00:00 +0000\r\n\r\n${body}`,
});

const withAttachment = {
  raw: [
    'Subject: Quarterly report',
    'From: dana@example.com',
    `To: ${ADDRESS}`,
    'Date: Mon, 21 Sep 2026 11:00:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="EDGE"',
    '',
    '--EDGE',
    'Content-Type: text/plain',
    '',
    'The report is attached.',
    '--EDGE',
    'Content-Type: text/plain; name="report.txt"',
    'Content-Disposition: attachment; filename="report.txt"',
    '',
    'Revenue is up.',
    '--EDGE--',
    '',
  ].join('\r\n'),
};

test.before(async () => {
  imapServer = hoodiecrow({
    plugins: ['ID', 'SPECIAL-USE', 'MOVE'],
    users: { [ADDRESS]: { password: MAILBOX_PASSWORD } },
    storage: {
      INBOX: {
        messages: [
          plain('Welcome aboard', 'alice@example.com', 'Glad to have you with us.', 'welcome-1'),
          plain('Invoice 4471', 'billing@supplier.example', 'Your invoice is ready.', 'invoice-4471'),
          withAttachment,
        ],
      },
      '': {
        separator: '/',
        folders: {
          Sent: { 'special-use': '\\Sent' },
          Trash: { 'special-use': '\\Trash' },
          Archive: {},
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
        const buffer = Buffer.concat(chunks);
        rawReceived.push(buffer.toString());
        received.push(await simpleParser(buffer));
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
      if ((await fetch(`${BASE}/api/health`, { headers: { Connection: 'close' } })).ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  // The only setup the webmail app needs: a domain that knows its mail servers.
  await admin('/api/auth/login', { method: 'POST', body: { email: 'admin@example.com', password: 'Admin@12345' } });
  const created = await admin('/api/domains', { method: 'POST', body: { name: DOMAIN } });
  ctx.domainId = created.data.domain.id;
  await admin(`/api/domains/${ctx.domainId}/settings`, {
    method: 'PUT',
    body: {
      imapHost: '127.0.0.1', imapPort, imapSecure: false,
      smtpHost: '127.0.0.1', smtpPort, smtpSecure: false,
    },
  });
});

test.after(async () => {
  try {
    await prisma.domain.deleteMany({ where: { name: DOMAIN } });
    await prisma.$disconnect();
  } catch (err) {
    console.error('TEARDOWN:', err?.message);
  }
  server?.kill();
  await new Promise((r) => smtpServer.close(r));
  await new Promise((r) => imapServer.close(r));
});

// --- The front door ---------------------------------------------------------

test('the webmail app is served at /webmail', async () => {
  const res = await fetch(`${BASE}/webmail`);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /js\/mail-app\.js/);
});

test('nothing is readable before signing in', async () => {
  for (const path of ['/api/webmail/folders', '/api/webmail/messages', '/api/webmail/messages/1']) {
    const res = await stranger(path);
    assert.equal(res.status, 401, `${path} should be closed`);
  }
  const me = await stranger('/api/webmail/me');
  assert.equal(me.data.account, null);
});

test('an address on an unknown domain is turned away without confirming anything', async () => {
  const res = await stranger('/api/webmail/login', {
    method: 'POST',
    body: { address: `someone@not-hosted-${stamp}.example`, password: 'whatever' },
  });
  assert.equal(res.status, 401);
  // The same wording as a wrong password: whether a domain is hosted here is
  // not something an unauthenticated visitor should be able to probe.
  assert.match(res.data.error, /could not sign you in/i);
});

test('a wrong password is refused', async () => {
  const res = await stranger('/api/webmail/login', {
    method: 'POST',
    body: { address: ADDRESS, password: 'not-the-password' },
  });
  assert.equal(res.status, 401);
  assert.match(res.data.error, /could not sign you in/i);
});

test('the mailbox signs in with its own password, with no portal account', async () => {
  const res = await mail('/api/webmail/login', {
    method: 'POST',
    body: { address: ADDRESS, password: MAILBOX_PASSWORD },
  });
  if (res.status !== 200) console.error('DEBUG:', JSON.stringify(res.data));
  assert.equal(res.status, 200);
  assert.equal(res.data.account.address, ADDRESS);
  assert.equal(res.data.account.canSend, true);

  // No User row was created or consulted — this identity is the mailbox itself.
  const user = await prisma.user.findUnique({ where: { email: ADDRESS } });
  assert.equal(user, null);
});

test('the password is never sent back and never stored in the clear', async () => {
  const me = await mail('/api/webmail/me');
  assert.ok(!me.text.includes(MAILBOX_PASSWORD));

  // It lives only inside the session record, encrypted.
  const rows = await prisma.$queryRawUnsafe('SELECT sess::text AS sess FROM user_sessions');
  const holding = rows.filter((r) => r.sess.includes(ADDRESS));
  assert.ok(holding.length >= 1, 'the signed-in session should be on file');
  for (const row of holding) {
    assert.ok(!row.sess.includes(MAILBOX_PASSWORD), 'the session must not hold the password in the clear');
    const stored = JSON.parse(row.sess).mail.password;
    assert.equal(stored.split(':').length, 3, 'stored as iv:tag:ciphertext');
  }

  // A mailbox password is not a portal password: it is never hashed into users.
  const detail = await admin(`/api/domains/${ctx.domainId}`);
  assert.ok(!detail.text.includes(MAILBOX_PASSWORD));
});

// --- Reading ----------------------------------------------------------------

test('folders come back with the special ones recognised and unread counted', async () => {
  const { status, data } = await mail('/api/webmail/folders');
  assert.equal(status, 200);

  const byUse = Object.fromEntries(data.folders.map((f) => [f.specialUse, f]));
  assert.equal(byUse.inbox.path, 'INBOX');
  assert.ok(byUse.sent && byUse.trash, 'Sent and Trash should be found');
  assert.equal(byUse.inbox.total, 3);
  assert.equal(byUse.inbox.unread, 3, 'nothing has been read yet');
  assert.ok(data.folders.some((f) => f.name === 'Archive'));
});

test('the inbox lists newest first, and flags attachments', async () => {
  const { status, data } = await mail('/api/webmail/messages?folder=INBOX');
  assert.equal(status, 200);
  assert.equal(data.total, 3);
  assert.deepEqual(data.messages.map((m) => m.subject), ['Quarterly report', 'Invoice 4471', 'Welcome aboard']);
  assert.equal(data.messages[0].hasAttachments, true, 'the report carries a file');
  assert.equal(data.messages[1].hasAttachments, false);

  ctx.reportUid = data.messages[0].uid;
  ctx.invoiceUid = data.messages[1].uid;
  ctx.welcomeUid = data.messages[2].uid;
});

test('search asks the mail server, so it reaches past the first page', async () => {
  const bySubject = await mail('/api/webmail/messages?search=Invoice');
  assert.equal(bySubject.data.total, 1);
  assert.equal(bySubject.data.messages[0].subject, 'Invoice 4471');

  const bySender = await mail('/api/webmail/messages?search=alice@example.com');
  assert.equal(bySender.data.messages[0].subject, 'Welcome aboard');

  // Body text the listing never returns is still findable.
  const byBody = await mail('/api/webmail/messages?search=Glad to have you');
  assert.equal(byBody.data.messages[0].subject, 'Welcome aboard');

  const nothing = await mail('/api/webmail/messages?search=zzz-no-such-word');
  assert.equal(nothing.data.total, 0);
  assert.deepEqual(nothing.data.messages, []);
});

test('a message opens with its body, and reading it marks it read', async () => {
  const { status, data } = await mail(`/api/webmail/messages/${ctx.welcomeUid}?folder=INBOX`);
  assert.equal(status, 200);
  assert.equal(data.message.subject, 'Welcome aboard');
  assert.match(data.message.text, /Glad to have you/);
  assert.equal(data.message.from[0].address, 'alice@example.com');

  const list = await mail('/api/webmail/messages');
  assert.equal(list.data.messages.find((m) => m.uid === ctx.welcomeUid).seen, true);

  const folders = await mail('/api/webmail/folders');
  assert.equal(folders.data.folders.find((f) => f.specialUse === 'inbox').unread, 2);
});

test('an attachment downloads with its real name and bytes', async () => {
  const opened = await mail(`/api/webmail/messages/${ctx.reportUid}?folder=INBOX`);
  assert.equal(opened.data.message.attachments.length, 1);
  assert.equal(opened.data.message.attachments[0].filename, 'report.txt');

  const file = await mail(`/api/webmail/messages/${ctx.reportUid}/attachments/0?folder=INBOX`);
  assert.equal(file.status, 200);
  assert.match(file.headers.get('content-disposition'), /filename="report\.txt"/);
  assert.equal(file.buffer.toString(), 'Revenue is up.');
});

test('a message id that is not a number is refused', async () => {
  const res = await mail('/api/webmail/messages/abc?folder=INBOX');
  assert.equal(res.status, 400);
});

// --- Flags ------------------------------------------------------------------

test('a message can be starred and unstarred', async () => {
  await mail(`/api/webmail/messages/${ctx.invoiceUid}/flagged`, { method: 'POST', body: { flagged: true, folder: 'INBOX' } });
  let list = await mail('/api/webmail/messages');
  assert.equal(list.data.messages.find((m) => m.uid === ctx.invoiceUid).flagged, true);

  await mail(`/api/webmail/messages/${ctx.invoiceUid}/flagged`, { method: 'POST', body: { flagged: false, folder: 'INBOX' } });
  list = await mail('/api/webmail/messages');
  assert.equal(list.data.messages.find((m) => m.uid === ctx.invoiceUid).flagged, false);
});

test('a read message can be marked unread again', async () => {
  const res = await mail(`/api/webmail/messages/${ctx.welcomeUid}/seen`, { method: 'POST', body: { seen: false, folder: 'INBOX' } });
  assert.equal(res.status, 200);

  const list = await mail('/api/webmail/messages');
  assert.equal(list.data.messages.find((m) => m.uid === ctx.welcomeUid).seen, false);
});

// --- Sending ----------------------------------------------------------------

test('a message with an attachment is really delivered, and filed to Sent', async () => {
  const before = received.length;

  const form = new FormData();
  form.append('to', 'someone@example.com, second@example.com');
  form.append('cc', 'copied@example.com');
  form.append('subject', 'Hello from webmail');
  form.append('text', 'Sent straight from the browser.');
  form.append('attachments', new Blob(['line one\nline two'], { type: 'text/plain' }), 'notes.txt');

  const res = await mail('/api/webmail/send', { method: 'POST', form });
  if (res.status !== 200) console.error('DEBUG:', JSON.stringify(res.data));
  assert.equal(res.status, 200);
  assert.equal(res.data.ok, true);
  assert.equal(received.length, before + 1, 'the SMTP server should have accepted it');

  const sent = received.at(-1);
  assert.equal(sent.subject, 'Hello from webmail');
  assert.equal(sent.from.value[0].address, ADDRESS, 'the from address is the signed-in mailbox');
  assert.deepEqual(sent.to.value.map((a) => a.address), ['someone@example.com', 'second@example.com']);
  assert.deepEqual(sent.cc.value.map((a) => a.address), ['copied@example.com']);
  assert.equal(sent.attachments.length, 1);
  assert.equal(sent.attachments[0].filename, 'notes.txt');
  assert.equal(sent.attachments[0].content.toString(), 'line one\nline two');

  assert.equal(res.data.filedToSent, true, 'a copy should be kept');
  const inSent = await mail('/api/webmail/messages?folder=Sent');
  assert.equal(inSent.data.messages[0].subject, 'Hello from webmail');
});

test('a bcc recipient receives the message but is not named in the headers', async () => {
  const before = received.length;

  const form = new FormData();
  form.append('to', 'open@example.com');
  form.append('bcc', 'hidden@example.com');
  form.append('subject', 'Quiet copy');
  form.append('text', 'Only one of you is listed.');

  const res = await mail('/api/webmail/send', { method: 'POST', form });
  assert.equal(res.status, 200);
  assert.equal(received.length, before + 1);

  const sent = received.at(-1);
  assert.equal(sent.subject, 'Quiet copy');
  assert.ok(!sent.headers.has('bcc'), 'a Bcc header must not travel with the message');
  assert.ok(!JSON.stringify(sent.headerLines).includes('hidden@example.com'));
});

test('a reply carries the threading headers', async () => {
  const opened = await mail(`/api/webmail/messages/${ctx.invoiceUid}?folder=INBOX`);
  const messageId = opened.data.message.messageId;
  assert.ok(messageId, 'the original should have a Message-ID to reply to');

  const form = new FormData();
  form.append('to', 'billing@supplier.example');
  form.append('subject', 'Re: Invoice 4471');
  form.append('text', 'Received, thank you.');
  form.append('inReplyTo', messageId);
  form.append('references', messageId);

  const res = await mail('/api/webmail/send', { method: 'POST', form });
  assert.equal(res.status, 200);

  const sent = received.at(-1);
  assert.equal(sent.inReplyTo, messageId);
  assert.match(String(sent.references), new RegExp(messageId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('sending with no recipient is refused', async () => {
  const form = new FormData();
  form.append('to', '   ');
  form.append('subject', 'Nowhere');
  const res = await mail('/api/webmail/send', { method: 'POST', form });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /recipient/i);
});

test('forwarding sends the original along intact', async () => {
  const before = received.length;

  const res = await mail(`/api/webmail/messages/${ctx.reportUid}/forward`, {
    method: 'POST',
    body: { to: 'colleague@example.com', text: 'Passing this on.', folder: 'INBOX' },
  });
  assert.equal(res.status, 200);
  assert.equal(received.length, before + 1);

  const sent = received.at(-1);
  assert.equal(sent.subject, 'Fwd: Quarterly report');
  assert.match(sent.text, /Passing this on/);

  // The original is attached whole, as message/rfc822 — headers, body and its
  // own attachment. A parser unwraps that part, so the check is on the bytes.
  const raw = rawReceived.at(-1);
  assert.match(raw, /filename="?forwarded-message\.eml"?/);
  assert.match(raw, /Subject: Quarterly report/);
  assert.match(raw, /From: dana@example\.com/);
  assert.match(raw, /Revenue is up/);
});

// --- Moving and deleting ----------------------------------------------------

test('a message can be moved to another folder', async () => {
  const res = await mail(`/api/webmail/messages/${ctx.invoiceUid}/move`, {
    method: 'POST',
    body: { to: 'Archive', folder: 'INBOX' },
  });
  assert.equal(res.status, 200);

  const archive = await mail('/api/webmail/messages?folder=Archive');
  assert.equal(archive.data.total, 1);
  assert.equal(archive.data.messages[0].subject, 'Invoice 4471');

  const inbox = await mail('/api/webmail/messages?folder=INBOX');
  assert.ok(!inbox.data.messages.some((m) => m.subject === 'Invoice 4471'));
});

test('deleting moves to the trash rather than destroying the message', async () => {
  const res = await mail(`/api/webmail/messages/${ctx.welcomeUid}?folder=INBOX`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.match(res.data.message, /Trash/i);

  const trash = await mail('/api/webmail/messages?folder=Trash');
  assert.ok(trash.data.messages.some((m) => m.subject === 'Welcome aboard'));
});

// --- Leaving ----------------------------------------------------------------

test('signing out ends the session for good', async () => {
  const out = await mail('/api/webmail/logout', { method: 'POST' });
  assert.equal(out.status, 200);

  const after = await mail('/api/webmail/folders');
  assert.equal(after.status, 401);
});

test('a portal sign-in is not a webmail sign-in', async () => {
  // The super admin is signed in to the portal on this very cookie, and still
  // has no mailbox session here.
  const res = await admin('/api/webmail/folders');
  assert.equal(res.status, 401);
});

// ---------------------------------------------------------------------------
// Finding out why somebody cannot sign in
//
// The visitor is deliberately told nothing useful, because whether a domain is
// hosted here is not a stranger's business. That is right, and it left whoever
// runs the portal with no way to tell a wrong password from an IMAP host that
// was never filled in. These are the two halves of the answer: the real reason
// goes to the activity log, and a Super Admin can reproduce the sign-in on
// demand.
// ---------------------------------------------------------------------------

test('a failed sign-in records why, even though the visitor is not told', async () => {
  const address = `nobody@${DOMAIN}`;
  await stranger('/api/webmail/login', { method: 'POST', body: { address, password: 'not-the-password' } });

  const entry = await prisma.activityLog.findFirst({
    where: { event: 'security.webmail.failed', summary: { contains: address } },
    orderBy: { createdAt: 'desc' },
  });

  assert.ok(entry, 'the administrator has to be able to find out what happened');
  assert.match(entry.detail, /rejected the password/i);
  // The settings that were tried, so a wrong port is visible at a glance.
  assert.match(entry.detail, /127\.0\.0\.1:/);
  // And never the password itself.
  assert.ok(!entry.detail.includes('not-the-password'));
});

test('an unconfigured domain is recorded as unconfigured, not as a bad password', async () => {
  const bare = `unconfigured-${stamp}.example`;
  const created = await admin('/api/domains', { method: 'POST', body: { name: bare } });

  const res = await stranger('/api/webmail/login', {
    method: 'POST',
    body: { address: `someone@${bare}`, password: 'whatever' },
  });
  assert.equal(res.status, 401);
  assert.match(res.data.error, /could not sign you in/i, 'the visitor still learns nothing');

  const entry = await prisma.activityLog.findFirst({
    where: { event: 'security.webmail.failed', summary: { contains: bare } },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(entry);
  assert.match(entry.detail, /no IMAP host/i, 'and the administrator learns everything');

  await admin(`/api/domains/${created.data.domain.id}`, { method: 'DELETE' });
});

test('a mail server that cannot be reached says so instead of blaming the password', async () => {
  // Port 1 is closed. Somebody told "check your password" here would change it
  // over and over while the real fault sat in the port field.
  const broken = `unreachable-${stamp}.example`;
  const created = await admin('/api/domains', { method: 'POST', body: { name: broken } });
  await admin(`/api/domains/${created.data.domain.id}/settings`, {
    method: 'PUT',
    body: { imapHost: '127.0.0.1', imapPort: 1, imapSecure: false },
  });

  const res = await stranger('/api/webmail/login', {
    method: 'POST',
    body: { address: `someone@${broken}`, password: 'whatever' },
  });

  assert.equal(res.status, 401);
  assert.match(res.data.error, /could not reach the mail server/i);
  assert.match(res.data.error, /not with your password/i);

  const entry = await prisma.activityLog.findFirst({
    where: { event: 'security.webmail.failed', summary: { contains: broken } },
    orderBy: { createdAt: 'desc' },
  });
  assert.match(entry.detail, /could not be reached/i);

  await admin(`/api/domains/${created.data.domain.id}`, { method: 'DELETE' });
});

test('an administrator can reproduce a sign-in and see the real verdict', async () => {
  const good = await admin(`/api/domains/${ctx.domainId}/mail-test`, {
    method: 'POST',
    body: { address: ADDRESS, password: MAILBOX_PASSWORD },
  });

  assert.equal(good.status, 200);
  assert.equal(good.data.ok, true);
  assert.equal(good.data.checks.imap.ok, true);
  assert.match(good.data.checks.imap.message, /folder/i);
  assert.equal(good.data.checks.smtp.ok, true);
  // The settings actually used, so a wrong port is obvious without guessing.
  assert.match(good.data.servers.imap, /127\.0\.0\.1:\d+/);
});

test('the test reports a wrong password as a wrong password', async () => {
  const res = await admin(`/api/domains/${ctx.domainId}/mail-test`, {
    method: 'POST',
    body: { address: ADDRESS, password: 'definitely-wrong' },
  });

  assert.equal(res.status, 200, 'a failed sign-in is an answer, not an error');
  assert.equal(res.data.ok, false);
  assert.equal(res.data.checks.imap.ok, false);
  assert.match(res.data.checks.imap.message, /rejected this mailbox password/i);
});

test('the test catches an address that belongs to a different domain', async () => {
  // A real mistake: the settings are perfect, but webmail looks servers up by
  // the address's own domain, so this address would never reach them.
  const res = await admin(`/api/domains/${ctx.domainId}/mail-test`, {
    method: 'POST',
    body: { address: 'someone@somewhere-else.example', password: MAILBOX_PASSWORD },
  });

  assert.equal(res.data.checks.address.ok, false);
  assert.match(res.data.checks.address.message, /somewhere-else\.example/);
  assert.match(res.data.checks.address.message, new RegExp(DOMAIN));
});

test('the sign-in test is Super Admin only, and never echoes the password', async () => {
  const res = await admin(`/api/domains/${ctx.domainId}/mail-test`, {
    method: 'POST',
    body: { address: ADDRESS, password: MAILBOX_PASSWORD },
  });
  assert.ok(!JSON.stringify(res.data).includes(MAILBOX_PASSWORD));

  // A signed-out caller gets nothing.
  const anon = await stranger(`/api/domains/${ctx.domainId}/mail-test`, {
    method: 'POST',
    body: { address: ADDRESS, password: MAILBOX_PASSWORD },
  });
  assert.equal(anon.status, 401);
});
