// MySQL and MariaDB access over the credentials stored for a domain.
//
// This is the file manager's pattern applied to a database: the provider API
// does not hand out database credentials, so an administrator saves them once
// and the portal connects directly. Nothing is cached — every request opens a
// connection, does its work and closes it — so the portal never holds a stale
// picture of someone's data and never keeps a session open against their server.
//
// Two rules run through everything here:
//
//   Identifiers are never interpolated from what the browser sent. A table
//   name is checked against the list the server itself reports before it is
//   used, so there is no path from a request to an arbitrary identifier.
//
//   Values are always bound as parameters, never concatenated.

import mysql from 'mysql2/promise';
import { classify, KIND, returnsRows, SqlError } from './sqlStatement.js';

const CONNECT_TIMEOUT_MS = 12000;
/// How long a statement may run before the server gives up on it.
const STATEMENT_TIMEOUT_S = 15;
/// Most rows a query will return in one go. A bigger result is truncated and
/// said to be truncated, rather than pulled into memory whole.
export const MAX_ROWS = 500;
export const DEFAULT_PER_PAGE = 50;

export class DatabaseError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/// Connection failures are the most common thing to go wrong here, and the most
/// commonly misdiagnosed: shared hosting blocks database connections from
/// outside by default, so "it does not work" is usually one missing IP in the
/// host's Remote MySQL list. That is worth saying instead of a driver message.
function explain(err) {
  const code = err?.code || '';
  const message = err?.message || '';

  if (code === 'ER_HOST_NOT_PRIVILEGED' || /not allowed to connect/i.test(message)) {
    return new DatabaseError(
      'The database server refused this address. Shared hosting blocks outside connections until the ' +
        "address is allowed: add this server's IP under Remote MySQL in your hosting control panel.",
      502,
    );
  }
  if (code === 'ER_ACCESS_DENIED_ERROR' || /access denied/i.test(message)) {
    return new DatabaseError('The database rejected that username or password.', 502);
  }
  if (code === 'ER_BAD_DB_ERROR' || /unknown database/i.test(message)) {
    return new DatabaseError('That database name does not exist on the server.', 502);
  }
  if (code === 'ENOTFOUND') return new DatabaseError('The database host could not be found. Check the host name.', 502);
  if (code === 'ECONNREFUSED') {
    return new DatabaseError('The server refused the connection. Check the host and port, and that remote access is on.', 502);
  }
  if (code === 'ETIMEDOUT' || code === 'PROTOCOL_SEQUENCE_TIMEOUT' || /timeout/i.test(message)) {
    return new DatabaseError(
      'The database did not respond in time. That is usually a firewall silently dropping the connection — ' +
        'check Remote MySQL in your hosting control panel.',
      502,
    );
  }
  if (/max_statement_time|max_execution_time|query execution was interrupted/i.test(message)) {
    return new DatabaseError(
      `That statement ran longer than ${STATEMENT_TIMEOUT_S} seconds and was stopped. Narrow it down and try again.`,
      400,
    );
  }
  return new DatabaseError(message || 'The database request failed.', 502);
}

async function connect(settings) {
  if (!settings?.host || !settings?.user || !settings?.database) {
    throw new DatabaseError('Database access is not set up for this domain yet.', 400);
  }
  if (!settings.password) {
    throw new DatabaseError('No database password is stored for this domain.', 400);
  }

  try {
    const connection = await mysql.createConnection({
      host: settings.host,
      port: settings.port || 3306,
      user: settings.user,
      password: settings.password,
      database: settings.database,
      connectTimeout: CONNECT_TIMEOUT_MS,
      // Stacking statements is how one query box becomes several. The
      // classifier refuses them too; this makes it impossible at the protocol.
      multipleStatements: false,
      // Dates and decimals come back as strings, so a value is shown as the
      // database holds it rather than reshaped by a JavaScript Date.
      dateStrings: true,
      decimalNumbers: false,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });

    // Server-side cap, so a runaway statement is stopped at the database rather
    // than left running after the browser has given up. The two engines spell
    // it differently and neither failing is fatal.
    for (const statement of [
      `SET SESSION max_statement_time = ${STATEMENT_TIMEOUT_S}`,
      `SET SESSION max_execution_time = ${STATEMENT_TIMEOUT_S * 1000}`,
    ]) {
      await connection.query(statement).catch(() => {});
    }

    return connection;
  } catch (err) {
    throw explain(err);
  }
}

/// Runs `fn` against a connection and always closes it, so a thrown error
/// cannot leave a socket open against someone's database server.
export async function withDatabase(settings, fn) {
  const connection = await connect(settings);
  try {
    return await fn(connection);
  } catch (err) {
    if (err instanceof DatabaseError || err instanceof SqlError) throw err;
    throw explain(err);
  } finally {
    try {
      await connection.end();
    } catch {
      // Closing is best effort; the operation's own result matters more.
    }
  }
}

/// Quotes an identifier for use in SQL. Only ever called with a name the server
/// itself reported, never with one straight from a request.
const quote = (name) => `\`${String(name).replace(/`/g, '``')}\``;

/// Confirms a table exists before its name is put into a statement. This is the
/// whitelist that makes identifier interpolation safe.
async function requireTable(connection, database, table) {
  const [rows] = await connection.execute(
    'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
    [database, table],
  );
  if (!rows.length) throw new DatabaseError(`There is no table called "${table}" in this database.`, 404);
  return rows[0].TABLE_NAME;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function testConnection(settings) {
  return withDatabase(settings, async (connection) => {
    const [[row]] = await connection.query('SELECT VERSION() AS version, DATABASE() AS db');
    return { ok: true, version: row.version, database: row.db };
  });
}

export async function listTables(settings) {
  return withDatabase(settings, async (connection) => {
    const [rows] = await connection.execute(
      `SELECT TABLE_NAME, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH, ENGINE, TABLE_COLLATION, TABLE_COMMENT
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
        ORDER BY TABLE_NAME`,
      [settings.database],
    );

    return rows.map((r) => ({
      name: r.TABLE_NAME,
      // information_schema reports an estimate for InnoDB, not a count. Saying
      // so beats presenting a guess as a fact.
      approximateRows: r.TABLE_ROWS === null ? null : Number(r.TABLE_ROWS),
      bytes: Number(r.DATA_LENGTH || 0) + Number(r.INDEX_LENGTH || 0),
      engine: r.ENGINE || null,
      collation: r.TABLE_COLLATION || null,
      comment: r.TABLE_COMMENT || null,
    }));
  });
}

export async function describeTable(settings, table) {
  return withDatabase(settings, async (connection) => {
    const name = await requireTable(connection, settings.database, table);

    const [columns] = await connection.execute(
      `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION`,
      [settings.database, name],
    );

    const [indexes] = await connection.execute(
      `SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME
         FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
      [settings.database, name],
    );

    const byIndex = new Map();
    for (const row of indexes) {
      if (!byIndex.has(row.INDEX_NAME)) {
        byIndex.set(row.INDEX_NAME, { name: row.INDEX_NAME, unique: row.NON_UNIQUE === 0, columns: [] });
      }
      byIndex.get(row.INDEX_NAME).columns.push(row.COLUMN_NAME);
    }

    // An exact count, unlike the estimate in the table listing.
    const [[count]] = await connection.query(`SELECT COUNT(*) AS n FROM ${quote(name)}`);

    return {
      table: name,
      rowCount: Number(count.n),
      columns: columns.map((c) => ({
        name: c.COLUMN_NAME,
        type: c.COLUMN_TYPE,
        nullable: c.IS_NULLABLE === 'YES',
        key: c.COLUMN_KEY || null,
        default: c.COLUMN_DEFAULT,
        extra: c.EXTRA || null,
        comment: c.COLUMN_COMMENT || null,
      })),
      indexes: [...byIndex.values()],
      primaryKey: columns.filter((c) => c.COLUMN_KEY === 'PRI').map((c) => c.COLUMN_NAME),
    };
  });
}

/// One page of a table.
///
/// `orderBy` and `search` come from the browser, so both are checked against
/// the table's real columns before any of it reaches a statement.
export async function browseRows(settings, table, { page = 1, perPage = DEFAULT_PER_PAGE, orderBy, direction = 'asc', search = '' } = {}) {
  return withDatabase(settings, async (connection) => {
    const name = await requireTable(connection, settings.database, table);

    const [columnRows] = await connection.execute(
      `SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_KEY FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [settings.database, name],
    );
    const columns = columnRows.map((c) => c.COLUMN_NAME);
    const primaryKey = columnRows.filter((c) => c.COLUMN_KEY === 'PRI').map((c) => c.COLUMN_NAME);

    const size = Math.min(Math.max(Number(perPage) || DEFAULT_PER_PAGE, 1), MAX_ROWS);
    const offset = Math.max((Number(page) || 1) - 1, 0) * size;

    // Search runs across every column as text. Values are bound; only the
    // column names — which came from the server — are interpolated.
    let where = '';
    const params = [];
    if (String(search).trim() && columns.length) {
      const term = `%${String(search).trim()}%`;
      where = ` WHERE ${columns.map((c) => `CAST(${quote(c)} AS CHAR) LIKE ?`).join(' OR ')}`;
      params.push(...columns.map(() => term));
    }

    let order = '';
    if (orderBy && columns.includes(orderBy)) {
      order = ` ORDER BY ${quote(orderBy)} ${String(direction).toLowerCase() === 'desc' ? 'DESC' : 'ASC'}`;
    }

    const [[count]] = await connection.execute(
      `SELECT COUNT(*) AS n FROM ${quote(name)}${where}`,
      params,
    );
    const [rows] = await connection.execute(
      `SELECT * FROM ${quote(name)}${where}${order} LIMIT ${size} OFFSET ${offset}`,
      params,
    );

    return {
      table: name,
      columns,
      primaryKey,
      rows: rows.map(normaliseRow),
      total: Number(count.n),
      page: Number(page) || 1,
      perPage: size,
    };
  });
}

/// Binary columns cannot go into JSON as they are, and a silent mangling would
/// be worse than saying what was left out.
function normaliseRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (Buffer.isBuffer(value)) {
      out[key] = { __binary: true, bytes: value.length };
    } else {
      out[key] = value;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Running a statement
// ---------------------------------------------------------------------------

/// Runs one statement, having first decided what it is.
///
/// `allowWrites` is the domain's own setting. A statement that changes anything
/// is refused when it is off, and `confirmTarget` must match the table a
/// destructive statement names — the caller cannot skip that by not asking.
export async function runQuery(settings, sql, { allowWrites = false, confirmTarget = null } = {}) {
  const verdict = classify(sql);

  if (verdict.kind === KIND.BLOCKED) {
    throw new DatabaseError(verdict.reason, 403);
  }

  if (verdict.kind !== KIND.READ && !allowWrites) {
    throw new DatabaseError(
      `This database is set to read-only, and a ${verdict.verb.toUpperCase()} statement changes data. ` +
        'A Super Admin can allow writes for this domain under Database settings.',
      403,
    );
  }

  if ((verdict.kind === KIND.DESTRUCTIVE || verdict.kind === KIND.SCHEMA) && verdict.target) {
    if (String(confirmTarget || '').trim() !== verdict.target) {
      throw new DatabaseError(
        `${verdict.reason} Type the table name "${verdict.target}" to confirm.`,
        409,
      );
    }
  }

  return withDatabase(settings, async (connection) => {
    const started = Date.now();

    if (returnsRows(verdict.kind)) {
      // Streamed and capped, so a SELECT over a huge table cannot pull the
      // whole thing into memory before anyone notices.
      const rows = [];
      let truncated = false;
      const stream = connection.connection.query(sql).stream();

      await new Promise((resolve, reject) => {
        stream.on('data', (row) => {
          if (rows.length >= MAX_ROWS) {
            truncated = true;
            return;
          }
          rows.push(normaliseRow(row));
        });
        stream.on('end', resolve);
        stream.on('error', reject);
      });

      return {
        kind: verdict.kind,
        verb: verdict.verb,
        columns: rows.length ? Object.keys(rows[0]) : [],
        rows,
        rowCount: rows.length,
        truncated,
        tookMs: Date.now() - started,
      };
    }

    const [result] = await connection.query(sql);
    return {
      kind: verdict.kind,
      verb: verdict.verb,
      target: verdict.target,
      columns: [],
      rows: [],
      affectedRows: result?.affectedRows ?? 0,
      changedRows: result?.changedRows ?? null,
      insertId: result?.insertId || null,
      tookMs: Date.now() - started,
    };
  });
}

/// What a statement would do, without running it. The query editor asks for
/// this as you type, so the consequence is on screen before the button is.
export function inspect(sql) {
  try {
    const verdict = classify(sql);
    return { ok: true, ...verdict };
  } catch (err) {
    return { ok: false, kind: null, reason: err.message };
  }
}

// ---------------------------------------------------------------------------
// Editing one row
// ---------------------------------------------------------------------------

/// Changes one row, addressed by its primary key.
///
/// A table with no primary key is refused: without one there is no way to name
/// a single row, and an UPDATE that matches by value could change several.
export async function updateRow(settings, table, { key, values }) {
  return withDatabase(settings, async (connection) => {
    const name = await requireTable(connection, settings.database, table);
    const [columnRows] = await connection.execute(
      `SELECT COLUMN_NAME, COLUMN_KEY FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [settings.database, name],
    );
    const columns = columnRows.map((c) => c.COLUMN_NAME);
    const primaryKey = columnRows.filter((c) => c.COLUMN_KEY === 'PRI').map((c) => c.COLUMN_NAME);

    if (!primaryKey.length) {
      throw new DatabaseError(
        `"${name}" has no primary key, so a single row cannot be identified. Use the query editor instead.`,
        400,
      );
    }
    if (!primaryKey.every((k) => key && Object.prototype.hasOwnProperty.call(key, k))) {
      throw new DatabaseError(`The whole primary key is needed: ${primaryKey.join(', ')}.`, 400);
    }

    const sets = Object.keys(values || {}).filter((c) => columns.includes(c) && !primaryKey.includes(c));
    if (!sets.length) throw new DatabaseError('No changed columns were given.', 400);

    const [result] = await connection.execute(
      `UPDATE ${quote(name)} SET ${sets.map((c) => `${quote(c)} = ?`).join(', ')} ` +
        `WHERE ${primaryKey.map((k) => `${quote(k)} = ?`).join(' AND ')} LIMIT 1`,
      [...sets.map((c) => values[c]), ...primaryKey.map((k) => key[k])],
    );

    return { affectedRows: result.affectedRows, changedRows: result.changedRows };
  });
}

export async function deleteRow(settings, table, { key }) {
  return withDatabase(settings, async (connection) => {
    const name = await requireTable(connection, settings.database, table);
    const [columnRows] = await connection.execute(
      `SELECT COLUMN_NAME, COLUMN_KEY FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [settings.database, name],
    );
    const primaryKey = columnRows.filter((c) => c.COLUMN_KEY === 'PRI').map((c) => c.COLUMN_NAME);

    if (!primaryKey.length) {
      throw new DatabaseError(
        `"${name}" has no primary key, so a single row cannot be identified. Use the query editor instead.`,
        400,
      );
    }
    if (!primaryKey.every((k) => key && Object.prototype.hasOwnProperty.call(key, k))) {
      throw new DatabaseError(`The whole primary key is needed: ${primaryKey.join(', ')}.`, 400);
    }

    // LIMIT 1 so that even a primary key that somehow matched twice could only
    // ever cost one row.
    const [result] = await connection.execute(
      `DELETE FROM ${quote(name)} WHERE ${primaryKey.map((k) => `${quote(k)} = ?`).join(' AND ')} LIMIT 1`,
      primaryKey.map((k) => key[k]),
    );
    return { affectedRows: result.affectedRows };
  });
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const csvCell = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' && value.__binary) return `[${value.bytes} bytes]`;
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const sqlValue = (value) => {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object' && value.__binary) return 'NULL';
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
};

/// A whole table as CSV or as INSERT statements, streamed row by row so the
/// size of the table does not decide whether this works.
export async function exportTable(settings, table, { format = 'csv', onChunk }) {
  return withDatabase(settings, async (connection) => {
    const name = await requireTable(connection, settings.database, table);
    let count = 0;
    let header = null;

    const stream = connection.connection.query(`SELECT * FROM ${quote(name)}`).stream();

    await new Promise((resolve, reject) => {
      stream.on('data', (raw) => {
        const row = normaliseRow(raw);
        const columns = Object.keys(row);

        if (!header) {
          header = columns;
          if (format === 'csv') onChunk(`${columns.map(csvCell).join(',')}\n`);
          else onChunk(`-- ${name}\n`);
        }

        if (format === 'csv') {
          onChunk(`${columns.map((c) => csvCell(row[c])).join(',')}\n`);
        } else {
          onChunk(
            `INSERT INTO ${quote(name)} (${columns.map(quote).join(', ')}) VALUES (${columns
              .map((c) => sqlValue(row[c]))
              .join(', ')});\n`,
          );
        }
        count += 1;
      });
      stream.on('end', resolve);
      stream.on('error', reject);
    });

    if (!header) onChunk(format === 'csv' ? '' : `-- ${name} is empty\n`);
    return { table: name, rows: count };
  });
}
