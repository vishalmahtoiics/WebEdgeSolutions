// Database access, exercised against a real MariaDB server.
//
// Real tables, real rows, real statements: a write here changes actual data and
// the next read proves it. The one thing that cannot be faked usefully is the
// classifier's job — deciding what a statement will do before it runs — so that
// gets its own section, including the tricks used to hide a DROP from a naive
// check.
//
// These tests need a MySQL or MariaDB server. Without one they skip rather than
// fail, so `npm test` still works on a machine that has no database engine
// beyond the portal's own Postgres.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import mysql from 'mysql2/promise';
import { PrismaClient } from '@prisma/client';
import { classify, stripForAnalysis, topLevel, KIND, SqlError } from '../src/lib/sqlStatement.js';

const PORT = 3983;
const BASE = `http://127.0.0.1:${PORT}`;
const SOCKET = process.env.TEST_MYSQL_SOCKET || '/var/run/mysqld/mysqld.sock';
const prisma = new PrismaClient();

const stamp = Date.now();
const DB_NAME = `portal_test_${stamp}`.slice(0, 60);
const DB_USER = `pt_${String(stamp).slice(-8)}`;
const DB_PASS = 'TestDbPass1!';
const DOMAIN = `db-${stamp}.example`;
const OTHER = `nodb-${stamp}.example`;
const userEmail = `db+${stamp}@example.com`;
const userPassword = 'DbUser@12345';

let root;          // the fixture's own connection, as the server's root
let server;
let available = false;
let skipReason = '';
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

    const type = res.headers.get('content-type') || '';
    const text = await res.text();
    if (!type.includes('json')) return { status: res.status, text, data: null, headers: res.headers };

    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, data, text, headers: res.headers };
  };
}

test.before(async () => {
  try {
    root = await mysql.createConnection({ socketPath: SOCKET, user: 'root', multipleStatements: true });
  } catch (err) {
    skipReason = `no MySQL server at ${SOCKET} (${err.code || err.message})`;
    return;
  }

  await root.query(`CREATE DATABASE \`${DB_NAME}\``);
  await root.query(`CREATE USER '${DB_USER}'@'%' IDENTIFIED BY '${DB_PASS}'`);
  await root.query(`GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'%'`);
  await root.query('FLUSH PRIVILEGES');
  await root.query(`USE \`${DB_NAME}\``);

  await root.query(`
    CREATE TABLE posts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(200) NOT NULL,
      body TEXT,
      views INT NOT NULL DEFAULT 0,
      INDEX idx_title (title)
    ) ENGINE=InnoDB
  `);
  await root.query(
    'INSERT INTO posts (title, body, views) VALUES (?,?,?), (?,?,?), (?,?,?)',
    ['Hello world', 'The first post', 10, 'Second post', 'More writing', 25, 'Pricing page', 'About money', 3],
  );

  // No primary key on purpose: the row editor must refuse to touch this.
  await root.query('CREATE TABLE notes (label VARCHAR(50), value VARCHAR(50)) ENGINE=InnoDB');
  await root.query("INSERT INTO notes VALUES ('a','1'), ('b','2')");

  // Bigger than the row cap, so truncation can be observed rather than assumed.
  await root.query('CREATE TABLE wide (id INT PRIMARY KEY) ENGINE=InnoDB');
  const many = Array.from({ length: 600 }, (_, i) => `(${i + 1})`).join(',');
  await root.query(`INSERT INTO wide (id) VALUES ${many}`);

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

  await admin('/auth/login', { method: 'POST', body: { email: 'admin@example.com', password: 'Admin@12345' } });

  const created = await admin('/domains', { method: 'POST', body: { name: DOMAIN } });
  ctx.domainId = created.data.domain.id;
  const other = await admin('/domains', { method: 'POST', body: { name: OTHER } });
  ctx.otherId = other.data.domain.id;

  await admin(`/domains/${ctx.domainId}/settings`, {
    method: 'PUT',
    body: {
      dbHost: '127.0.0.1', dbPort: 3306, dbName: DB_NAME, dbUser: DB_USER, dbPassword: DB_PASS,
    },
  });

  const user = await admin('/users', {
    method: 'POST',
    body: { name: 'DB User', email: userEmail, password: userPassword, role: 'USER' },
  });
  ctx.userId = user.data.user.id;
  await admin(`/users/${ctx.userId}/domains`, { method: 'PUT', body: { domainIds: [ctx.domainId] } });
  await member('/auth/login', { method: 'POST', body: { email: userEmail, password: userPassword } });

  available = true;
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
  if (root) {
    await root.query(`DROP DATABASE IF EXISTS \`${DB_NAME}\``).catch(() => {});
    await root.query(`DROP USER IF EXISTS '${DB_USER}'@'%'`).catch(() => {});
    await root.end().catch(() => {});
  }
});

/// Reads the table directly, as the source of truth for what a write did.
const rowsOf = async (table) => {
  const [rows] = await root.query(`SELECT * FROM \`${DB_NAME}\`.\`${table}\``);
  return rows;
};
const tableExists = async (table) => {
  const [rows] = await root.query(
    'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
    [DB_NAME, table],
  );
  return rows.length > 0;
};

const db = (client_, path, options) => client_(`/domains/${ctx.domainId}/db${path}`, options);
const allowWrites = (on) =>
  admin(`/domains/${ctx.domainId}/settings`, { method: 'PUT', body: { dbAllowWrites: on } });

// ---------------------------------------------------------------------------
// Reading a statement. No server needed: this is the gate everything else sits
// behind, so it is checked on its own.
// ---------------------------------------------------------------------------

test('a keyword inside a string is not a keyword', () => {
  assert.equal(classify("SELECT 'drop table users' AS note").kind, KIND.READ);
  assert.equal(classify('SELECT "truncate table x"').kind, KIND.READ);
  // Both ways of escaping a quote, so neither ends the literal early.
  assert.equal(classify("SELECT 'it''s drop table' , 'a\\' drop table'").kind, KIND.READ);
});

test('a keyword inside a quoted identifier is not a keyword either', () => {
  const verdict = classify('SELECT * FROM `drop table`');
  assert.equal(verdict.kind, KIND.READ);
});

test('a comment cannot smuggle a second statement past the check', () => {
  assert.throws(() => classify('SELECT 1; -- harmless\n DROP TABLE posts'), SqlError);
  assert.throws(() => classify('SELECT 1; # note\n TRUNCATE posts'), SqlError);
  assert.throws(() => classify('SELECT 1; /* note */ DROP TABLE posts'), SqlError);
});

test('a version-conditional comment is code, and is read as code', () => {
  // MySQL executes what is inside /*! … */ — a plain comment-stripper reads
  // this as a comment and lets a DROP through.
  const verdict = classify('/*!40101 DROP TABLE posts */');
  assert.equal(verdict.kind, KIND.DESTRUCTIVE);
  assert.equal(verdict.verb, 'drop');
  assert.equal(verdict.target, 'posts');
});

test('a plain comment really is stripped', () => {
  assert.equal(classify('/* just a note */ SELECT 1').kind, KIND.READ);
  assert.equal(stripForAnalysis('SELECT /* x */ 1').text.includes('x'), false);
});

test("a CTE's own SELECT is not mistaken for the statement's verb", () => {
  const verdict = classify('WITH t AS (SELECT 1) DELETE FROM posts WHERE id IN (SELECT * FROM t)');
  assert.equal(verdict.verb, 'delete');
  assert.equal(verdict.kind, KIND.WRITE);
  assert.equal(verdict.target, 'posts');

  assert.equal(classify('WITH t AS (SELECT 1) SELECT * FROM t').kind, KIND.READ);
});

test('a WHERE inside a subquery does not count as limiting the statement', () => {
  // This rewrites every row: the WHERE belongs to the subquery.
  const verdict = classify('UPDATE posts SET title = (SELECT title FROM posts WHERE id = 1)');
  assert.equal(verdict.kind, KIND.DESTRUCTIVE, 'no WHERE of its own, so every row changes');

  assert.equal(classify('UPDATE posts SET views = 1 WHERE id = 2').kind, KIND.WRITE);
  assert.equal(topLevel('UPDATE a SET x = (SELECT y WHERE z)').includes('WHERE'), false);
});

test('statements that reach the server rather than the data are blocked', () => {
  const blocked = [
    "SELECT * FROM posts INTO OUTFILE '/tmp/x'",
    "SELECT load_file('/etc/passwd')",
    "SELECT (SELECT load_file('/etc/passwd'))",
    "LOAD DATA INFILE '/etc/passwd' INTO TABLE posts",
    'GRANT ALL ON *.* TO me',
    "CREATE USER 'x'@'%' IDENTIFIED BY 'y'",
    'SET GLOBAL max_connections = 1',
    'USE information_schema',
    'DROP DATABASE other',
  ];
  for (const sql of blocked) {
    assert.equal(classify(sql).kind, KIND.BLOCKED, `${sql} should be blocked`);
  }
});

test('an unrecognised verb is treated as a change, not waved through', () => {
  assert.equal(classify('FROBNICATE posts').kind, KIND.WRITE);
});

// ---------------------------------------------------------------------------
// Against the real server
// ---------------------------------------------------------------------------

/// A test that needs the database server.
///
/// The check has to happen inside the test body: node:test reads the `skip`
/// option when a test is *defined*, which is before `before` has run and so
/// before anything is known about whether a server is there.
const live = (name, fn) =>
  test(name, async (t) => {
    if (!available) return t.skip(skipReason || 'the database fixture did not come up');
    return fn(t);
  });

live('the connection reports the real server version', async () => {
  const res = await db(admin, '/test', { method: 'POST' });
  if (res.status !== 200) console.error('DEBUG:', JSON.stringify(res.data));
  assert.equal(res.status, 200);
  assert.match(res.data.version, /MariaDB|^\d+\./);
  assert.equal(res.data.database, DB_NAME);
  assert.equal(res.data.allowWrites, false, 'read-only until switched on');
});

live('tables are listed with their real sizes', async () => {
  const { status, data } = await db(admin, '/tables');
  assert.equal(status, 200);
  const names = data.tables.map((t) => t.name).sort();
  assert.deepEqual(names, ['notes', 'posts', 'wide']);

  const posts = data.tables.find((t) => t.name === 'posts');
  assert.equal(posts.engine, 'InnoDB');
  assert.ok(posts.bytes > 0);
});

live('structure comes back with columns, keys and indexes', async () => {
  const { data } = await db(admin, '/tables/posts/structure');
  assert.equal(data.table, 'posts');
  assert.equal(data.rowCount, 3, 'an exact count, not the engine estimate');
  assert.deepEqual(data.primaryKey, ['id']);
  assert.deepEqual(data.columns.map((c) => c.name), ['id', 'title', 'body', 'views']);
  assert.equal(data.columns.find((c) => c.name === 'id').extra, 'auto_increment');
  assert.ok(data.indexes.some((i) => i.name === 'idx_title'));
});

live('a table that is not there is a 404, not an error page', async () => {
  const res = await db(admin, '/tables/no_such_table/structure');
  assert.equal(res.status, 404);
  assert.match(res.data.error, /no table called/i);
});

live('rows come back a page at a time', async () => {
  const first = await db(admin, '/tables/posts/rows?perPage=2');
  assert.equal(first.data.total, 3);
  assert.equal(first.data.rows.length, 2);
  assert.deepEqual(first.data.columns, ['id', 'title', 'body', 'views']);

  const second = await db(admin, '/tables/posts/rows?perPage=2&page=2');
  assert.equal(second.data.rows.length, 1);
  assert.notEqual(second.data.rows[0].id, first.data.rows[0].id);
});

live('search looks across every column', async () => {
  const byTitle = await db(admin, '/tables/posts/rows?search=Pricing');
  assert.equal(byTitle.data.total, 1);
  assert.equal(byTitle.data.rows[0].title, 'Pricing page');

  // A value only in the body, and one only in a numeric column.
  const byBody = await db(admin, '/tables/posts/rows?search=About money');
  assert.equal(byBody.data.total, 1);
  const byNumber = await db(admin, '/tables/posts/rows?search=25');
  assert.equal(byNumber.data.total, 1);
});

live('sorting works, and an unknown column is ignored rather than injected', async () => {
  const sorted = await db(admin, '/tables/posts/rows?orderBy=views&direction=desc');
  assert.deepEqual(sorted.data.rows.map((r) => r.views), [25, 10, 3]);

  // A column name that is really an injection attempt changes nothing.
  const attack = await db(admin, '/tables/posts/rows?orderBy=id%3B%20DROP%20TABLE%20posts');
  assert.equal(attack.status, 200);
  assert.equal(attack.data.rows.length, 3);
  assert.equal(await tableExists('posts'), true, 'posts is still there');
});

live('a table name that is really an injection attempt is refused', async () => {
  const res = await db(admin, '/tables/posts%60%3B%20DROP%20TABLE%20%60posts/rows');
  assert.ok([400, 404].includes(res.status), `expected a refusal, got ${res.status}`);
  assert.equal(await tableExists('posts'), true);
});

live('a SELECT runs and reports how long it took', async () => {
  const res = await db(admin, '/query', { method: 'POST', body: { sql: 'SELECT id, title FROM posts ORDER BY id' } });
  assert.equal(res.status, 200);
  assert.equal(res.data.kind, KIND.READ);
  assert.equal(res.data.rowCount, 3);
  assert.deepEqual(res.data.columns, ['id', 'title']);
  assert.equal(typeof res.data.tookMs, 'number');
  assert.match(res.data.message, /3 rows/);
});

live('a result bigger than the cap is truncated, and says so', async () => {
  const res = await db(admin, '/query', { method: 'POST', body: { sql: 'SELECT * FROM wide' } });
  assert.equal(res.data.rowCount, 500, 'capped');
  assert.equal(res.data.truncated, true);
  assert.match(res.data.message, /capped at 500/);
});

live('inspect says what a statement would do without running it', async () => {
  const before = (await rowsOf('posts')).length;

  const read = await db(admin, '/inspect', { method: 'POST', body: { sql: 'SELECT 1' } });
  assert.equal(read.data.kind, KIND.READ);
  assert.equal(read.data.permitted, true);

  const drop = await db(admin, '/inspect', { method: 'POST', body: { sql: 'DROP TABLE posts' } });
  assert.equal(drop.data.kind, KIND.DESTRUCTIVE);
  assert.equal(drop.data.target, 'posts');
  assert.equal(drop.data.needsConfirmation, true);
  assert.equal(drop.data.permitted, false, 'writes are still off');

  assert.equal((await rowsOf('posts')).length, before, 'inspecting ran nothing');
});

// --- Read-only ---------------------------------------------------------------

live('with writes off, a statement that changes data is refused', async () => {
  for (const sql of [
    "INSERT INTO posts (title) VALUES ('nope')",
    'UPDATE posts SET views = 0 WHERE id = 1',
    'DELETE FROM posts WHERE id = 1',
    'DROP TABLE posts',
  ]) {
    const res = await db(admin, '/query', { method: 'POST', body: { sql } });
    assert.equal(res.status, 403, `${sql} should be refused`);
    assert.match(res.data.error, /read-only/i);
  }
  assert.equal((await rowsOf('posts')).length, 3, 'nothing changed');
});

live('a blocked statement is refused even with writes off', async () => {
  const res = await db(admin, '/query', { method: 'POST', body: { sql: "SELECT load_file('/etc/passwd')" } });
  assert.equal(res.status, 403);
  assert.match(res.data.error, /file from the database server/i);
});

live('several statements at once are refused', async () => {
  const res = await db(admin, '/query', { method: 'POST', body: { sql: 'SELECT 1; SELECT 2' } });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /one statement at a time/i);
});

// --- Writes on ---------------------------------------------------------------

live('an admin can allow writes for the domain', async () => {
  const res = await allowWrites(true);
  assert.equal(res.status, 200);
  assert.equal(res.data.settings.dbAllowWrites, true);
});

live('an INSERT really inserts', async () => {
  const res = await db(admin, '/query', {
    method: 'POST',
    body: { sql: "INSERT INTO posts (title, body, views) VALUES ('Added by portal', 'hello', 7)" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.affectedRows, 1);
  assert.ok(res.data.insertId > 0);

  const rows = await rowsOf('posts');
  assert.equal(rows.length, 4);
  assert.ok(rows.some((r) => r.title === 'Added by portal'));
});

live('an UPDATE with a WHERE changes only those rows', async () => {
  const res = await db(admin, '/query', {
    method: 'POST',
    body: { sql: "UPDATE posts SET views = 99 WHERE title = 'Added by portal'" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.affectedRows, 1);

  const rows = await rowsOf('posts');
  assert.equal(rows.find((r) => r.title === 'Added by portal').views, 99);
  assert.equal(rows.find((r) => r.title === 'Hello world').views, 10, 'untouched');
});

live('an UPDATE with no WHERE needs the table typed out first', async () => {
  const refused = await db(admin, '/query', { method: 'POST', body: { sql: 'UPDATE posts SET views = 0' } });
  assert.equal(refused.status, 409);
  assert.match(refused.data.error, /every row/i);
  assert.match(refused.data.error, /Type the table name "posts"/);

  const rows = await rowsOf('posts');
  assert.ok(rows.some((r) => r.views !== 0), 'nothing was changed by the refusal');
});

live('a wrong confirmation does not count', async () => {
  const res = await db(admin, '/query', {
    method: 'POST',
    body: { sql: 'UPDATE posts SET views = 0', confirmTarget: 'notes' },
  });
  assert.equal(res.status, 409);
  assert.ok((await rowsOf('posts')).some((r) => r.views !== 0));
});

live('with the table typed, the statement runs', async () => {
  const res = await db(admin, '/query', {
    method: 'POST',
    body: { sql: 'UPDATE posts SET views = 0', confirmTarget: 'posts' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.affectedRows, 4);
  assert.ok((await rowsOf('posts')).every((r) => r.views === 0));
});

live('DROP TABLE needs the same confirmation, then really drops', async () => {
  await root.query(`CREATE TABLE \`${DB_NAME}\`.throwaway (id INT)`);
  assert.equal(await tableExists('throwaway'), true);

  const refused = await db(admin, '/query', { method: 'POST', body: { sql: 'DROP TABLE throwaway' } });
  assert.equal(refused.status, 409);
  assert.equal(await tableExists('throwaway'), true, 'still there after the refusal');

  const done = await db(admin, '/query', {
    method: 'POST',
    body: { sql: 'DROP TABLE throwaway', confirmTarget: 'throwaway' },
  });
  assert.equal(done.status, 200);
  assert.equal(await tableExists('throwaway'), false, 'gone for real');
});

live('a version-conditional comment cannot drop a table unconfirmed', async () => {
  await root.query(`CREATE TABLE \`${DB_NAME}\`.sneaky (id INT)`);
  const res = await db(admin, '/query', { method: 'POST', body: { sql: '/*!40101 DROP TABLE sneaky */' } });
  assert.equal(res.status, 409, 'read as a DROP, so it needs confirming');
  assert.equal(await tableExists('sneaky'), true);
  await root.query(`DROP TABLE \`${DB_NAME}\`.sneaky`);
});

// --- Editing one row ---------------------------------------------------------

live('one row can be edited by its primary key', async () => {
  const rows = await rowsOf('posts');
  const target = rows.find((r) => r.title === 'Hello world');

  const res = await db(admin, '/tables/posts/rows', {
    method: 'PUT',
    body: { key: { id: target.id }, values: { title: 'Hello, edited', views: 42 } },
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.affectedRows, 1);

  const after = await rowsOf('posts');
  assert.equal(after.find((r) => r.id === target.id).title, 'Hello, edited');
  assert.equal(after.length, rows.length, 'no row was added or lost');
});

live('a table with no primary key is refused, with the reason', async () => {
  const res = await db(admin, '/tables/notes/rows', {
    method: 'PUT',
    body: { key: { label: 'a' }, values: { value: 'changed' } },
  });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /no primary key/i);
  assert.deepEqual((await rowsOf('notes')).map((r) => r.value), ['1', '2'], 'untouched');
});

live('one row can be deleted by its primary key', async () => {
  const before = await rowsOf('posts');
  const target = before.find((r) => r.title === 'Added by portal');

  const res = await db(admin, '/tables/posts/rows/delete', { method: 'POST', body: { key: { id: target.id } } });
  assert.equal(res.status, 200);
  assert.equal(res.data.affectedRows, 1);

  const after = await rowsOf('posts');
  assert.equal(after.length, before.length - 1);
  assert.ok(!after.some((r) => r.id === target.id));
});

// --- Export ------------------------------------------------------------------

live('a table exports as CSV with its real rows', async () => {
  const res = await db(admin, '/tables/posts/export?format=csv');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /filename="posts\.csv"/);

  const lines = res.text.trim().split('\n');
  assert.equal(lines[0], 'id,title,body,views');
  assert.equal(lines.length - 1, (await rowsOf('posts')).length);
  assert.match(res.text, /Hello, edited/);
});

live('a table exports as INSERT statements', async () => {
  const res = await db(admin, '/tables/posts/export?format=sql');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /filename="posts\.sql"/);
  assert.match(res.text, /INSERT INTO `posts`/);
  assert.match(res.text, /Hello, edited/);
});

// --- The log -----------------------------------------------------------------

live('statements that changed something are on the log, reads are not', async () => {
  const { status, data } = await db(admin, '/log');
  assert.equal(status, 200);
  assert.ok(data.entries.length > 0);

  assert.ok(data.entries.some((e) => e.verb === 'drop' && e.target === 'throwaway'));
  assert.ok(data.entries.some((e) => e.verb === 'insert'));
  assert.ok(!data.entries.some((e) => e.kind === KIND.READ), 'reads would bury the rest');

  // And who ran it.
  assert.ok(data.entries.every((e) => e.user === null || typeof e.user.email === 'string'));
});

live('the log is closed to normal users', async () => {
  const res = member(`/domains/${ctx.domainId}/db/log`);
  assert.equal((await res).status, 403);
});

// --- Who can do what ---------------------------------------------------------

live('an assigned user can browse their own database', async () => {
  const res = await member(`/domains/${ctx.domainId}/db/tables`);
  assert.equal(res.status, 200);
  assert.ok(res.data.tables.some((t) => t.name === 'posts'));

  // Nothing in the reply gives away the password or the provider.
  assert.ok(!res.text.includes(DB_PASS));
  assert.ok(!/hostinger/i.test(res.text));
});

live('an assigned user can run statements, writes included', async () => {
  const res = await member(`/domains/${ctx.domainId}/db/query`, {
    method: 'POST',
    body: { sql: "INSERT INTO posts (title, views) VALUES ('By the user', 1)" },
  });
  assert.equal(res.status, 200);
  assert.ok((await rowsOf('posts')).some((r) => r.title === 'By the user'));
});

live('a user cannot reach a database on a domain they are not assigned', async () => {
  const res = await member(`/domains/${ctx.otherId}/db/tables`);
  assert.equal(res.status, 404, 'a 404, so ids cannot be probed');
});

live('a user cannot turn writes on for themselves', async () => {
  await allowWrites(false);

  // This used to be allowed through with the one field quietly dropped. The
  // whole settings row is an administrator's now — it holds the provider's
  // hostnames and the credentials the portal uses on the customer's behalf —
  // so the request is refused outright, which is a stronger answer to the
  // same question.
  const attempt = await member(`/domains/${ctx.domainId}/settings`, {
    method: 'PUT',
    body: { dbAllowWrites: true },
  });
  assert.equal(attempt.status, 403, 'the settings are not a customer\u2019s to write');

  const settings = await admin(`/domains/${ctx.domainId}`);
  assert.equal(settings.data.settings.dbAllowWrites, false, 'the switch did not move');

  const blocked = await member(`/domains/${ctx.domainId}/db/query`, {
    method: 'POST',
    body: { sql: "INSERT INTO posts (title) VALUES ('should not happen')" },
  });
  assert.equal(blocked.status, 403);
  assert.ok(!(await rowsOf('posts')).some((r) => r.title === 'should not happen'));
});

// --- The password ------------------------------------------------------------

live('the database password is encrypted and never returned', async () => {
  const row = await prisma.domainSettings.findUnique({ where: { domainId: ctx.domainId } });
  assert.notEqual(row.dbPassword, DB_PASS, 'must not be stored in the clear');
  assert.equal(row.dbPassword.split(':').length, 3, 'stored as iv:tag:ciphertext');

  // Nobody gets the password. A user does not get the settings row at all
  // any more, so for them the check is that none of it is there; for an
  // administrator it is that the column is replaced by a hint.
  for (const who of [admin, member]) {
    const res = await who(`/domains/${ctx.domainId}`);
    assert.ok(!res.text.includes(DB_PASS), 'the password must not appear in any response');
    assert.ok(!('dbPassword' in res.data.settings), 'the column is not exposed');
  }

  const forUser = await member(`/domains/${ctx.domainId}`);
  assert.deepEqual(
    Object.keys(forUser.data.settings),
    ['hasDatabase'],
    'a customer gets the one fact the page needs and nothing else',
  );

  const forAdmin = await admin(`/domains/${ctx.domainId}`);
  assert.equal(forAdmin.data.settings.hasDbPassword, true, 'only that one is stored');

  // And the hint reveals a tail only, never the whole secret.
  const hint = forAdmin.data.settings.dbPasswordHint;
  assert.ok(hint.startsWith('••••'));
  assert.ok(hint.length <= 8, `the hint is a hint, not the password: ${hint}`);
  assert.ok(!DB_PASS.startsWith(hint.replace(/•/g, '')));
});

live('a domain with no database set up says so plainly', async () => {
  const res = await admin(`/domains/${ctx.otherId}/db/tables`);
  assert.equal(res.status, 400);
  assert.match(res.data.error, /not set up/i);
});

live('a short password is not given away by its own hint', async () => {
  // Four trailing characters is most of a short password, so nothing is shown.
  await admin(`/domains/${ctx.domainId}/settings`, { method: 'PUT', body: { dbPassword: 'tiny' } });
  const res = await admin(`/domains/${ctx.domainId}`);
  assert.equal(res.data.settings.dbPasswordHint, '••••••••');
  assert.ok(!res.text.includes('tiny'));

  // Put the working password back.
  await admin(`/domains/${ctx.domainId}/settings`, { method: 'PUT', body: { dbPassword: DB_PASS } });
});
