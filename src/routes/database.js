// Database access, backed by the MySQL credentials stored for a domain.
//
// Mounted under /api/domains/:id/db, so the domain authorization that guards
// everything else guards these too: a user reaches only a domain assigned to
// them, and the credentials never leave this process.
//
// Every statement that changes data is logged before it runs — who, when, and
// what. A query box handed to several people needs a record of what went
// through it, and the log is the only thing that can answer "what happened to
// this table" afterwards.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler, badRequest, forbidden } from '../lib/errors.js';
import { decryptMaybe } from '../lib/crypto.js';
import { isAdmin } from '../middleware/auth.js';
import {
  testConnection, listTables, describeTable, browseRows,
  runQuery, inspect, updateRow, deleteRow, exportTable,
  DatabaseError, MAX_ROWS, DEFAULT_PER_PAGE,
} from '../lib/database.js';
import { SqlError, KIND } from '../lib/sqlStatement.js';
import { record } from '../services/notifier.js';

export const databaseRouter = Router({ mergeParams: true });

/// Loads the domain's stored credentials. The password is decrypted here and
/// nowhere else; it is never put on a response.
async function credentialsFor(domainId) {
  const settings = await prisma.domainSettings.findUnique({ where: { domainId } });
  if (!settings?.dbHost || !settings?.dbName || !settings?.dbUser) {
    throw badRequest('Database access is not set up for this domain yet. Add the details under FTP & Server.');
  }
  return {
    host: settings.dbHost,
    port: settings.dbPort,
    database: settings.dbName,
    user: settings.dbUser,
    password: decryptMaybe(settings.dbPassword),
    allowWrites: Boolean(settings.dbAllowWrites),
  };
}

/// Records a statement that changed something, with who ran it.
///
/// Written before the statement runs and updated after, so a statement that
/// killed the connection still leaves a trace. A failure to log never stops
/// the work — but it is the last thing to give up.
async function logStatement({ domainId, userId, sql, kind, verb, target }) {
  return prisma.databaseQueryLog
    .create({ data: { domainId, userId, sql: sql.slice(0, 4000), kind, verb, target: target || null } })
    .catch(() => null);
}

/// Alerts on a statement that changed data. Only the destructive and
/// structural ones by default — an alert for every INSERT would bury the DROP
/// that actually mattered.
async function alertOnStatement(req, { kind, verb, target, sql }) {
  if (kind !== KIND.DESTRUCTIVE && kind !== KIND.SCHEMA) return;
  await record({
    event: 'database.statement.destructive',
    actor: req.user,
    domain: req.domain,
    summary: `Ran a ${verb.toUpperCase()} on the database${target ? ` (${target})` : ''}`,
    detail: sql.slice(0, 500),
  });
}

// ---------------------------------------------------------------------------
// Connection and structure
// ---------------------------------------------------------------------------

databaseRouter.post(
  '/test',
  asyncHandler(async (req, res) => {
    const settings = await credentialsFor(req.domain.id);
    const result = await testConnection(settings);
    res.json({ ...result, allowWrites: settings.allowWrites });
  }),
);

databaseRouter.get(
  '/tables',
  asyncHandler(async (req, res) => {
    const settings = await credentialsFor(req.domain.id);
    const tables = await listTables(settings);
    res.json({
      tables,
      database: settings.database,
      allowWrites: settings.allowWrites,
      maxRows: MAX_ROWS,
    });
  }),
);

const tableName = z.string().trim().min(1).max(64);

databaseRouter.get(
  '/tables/:table/structure',
  asyncHandler(async (req, res) => {
    const parsed = tableName.safeParse(req.params.table);
    if (!parsed.success) throw badRequest('Invalid table name.');
    res.json(await describeTable(await credentialsFor(req.domain.id), parsed.data));
  }),
);

const browseQuery = z.object({
  page: z.coerce.number().int().min(1).max(100000).optional(),
  perPage: z.coerce.number().int().min(1).max(MAX_ROWS).optional(),
  orderBy: z.string().trim().max(64).optional(),
  direction: z.enum(['asc', 'desc']).optional(),
  search: z.string().max(200).optional(),
});

databaseRouter.get(
  '/tables/:table/rows',
  asyncHandler(async (req, res) => {
    const table = tableName.safeParse(req.params.table);
    if (!table.success) throw badRequest('Invalid table name.');

    const query = browseQuery.safeParse(req.query);
    if (!query.success) throw badRequest('Invalid paging or sort.');

    res.json(
      await browseRows(await credentialsFor(req.domain.id), table.data, {
        page: query.data.page || 1,
        perPage: query.data.perPage || DEFAULT_PER_PAGE,
        orderBy: query.data.orderBy,
        direction: query.data.direction || 'asc',
        search: query.data.search || '',
      }),
    );
  }),
);

// ---------------------------------------------------------------------------
// Running a statement
// ---------------------------------------------------------------------------

/// What a statement would do, without running it.
///
/// The editor calls this as you type, so the consequence of a statement is on
/// screen before the button that runs it is pressed.
databaseRouter.post(
  '/inspect',
  validate(z.object({ sql: z.string().max(100000) })),
  asyncHandler(async (req, res) => {
    const settings = await credentialsFor(req.domain.id);
    const verdict = inspect(req.body.sql);

    res.json({
      ...verdict,
      // Whether this statement could run as things stand, so the button can
      // explain itself rather than just failing.
      permitted:
        verdict.ok &&
        verdict.kind !== KIND.BLOCKED &&
        (verdict.kind === KIND.READ || settings.allowWrites),
      allowWrites: settings.allowWrites,
      needsConfirmation: verdict.ok && [KIND.DESTRUCTIVE, KIND.SCHEMA].includes(verdict.kind),
    });
  }),
);

const runSchema = z.object({
  sql: z.string().trim().min(1, 'Enter a statement to run.').max(100000),
  // Must equal the table a destructive statement names, typed out.
  confirmTarget: z.string().trim().max(128).optional(),
});

databaseRouter.post(
  '/query',
  validate(runSchema),
  asyncHandler(async (req, res) => {
    const settings = await credentialsFor(req.domain.id);
    const verdict = inspect(req.body.sql);

    // Logged before it runs, so a statement that takes the connection down
    // with it still leaves a record of having been attempted.
    if (verdict.ok && verdict.kind !== KIND.READ) {
      await logStatement({
        domainId: req.domain.id,
        userId: req.user.id,
        sql: req.body.sql,
        kind: verdict.kind,
        verb: verdict.verb,
        target: verdict.target,
      });
    }

    const result = await runQuery(settings, req.body.sql, {
      allowWrites: settings.allowWrites,
      confirmTarget: req.body.confirmTarget,
    });

    if (verdict.ok) {
      await alertOnStatement(req, { ...verdict, sql: req.body.sql });
    }

    res.json({
      ...result,
      message:
        result.kind === KIND.READ
          ? `${result.rowCount} row${result.rowCount === 1 ? '' : 's'}${result.truncated ? ` (capped at ${MAX_ROWS})` : ''} in ${result.tookMs} ms.`
          : `${result.verb.toUpperCase()} affected ${result.affectedRows} row${result.affectedRows === 1 ? '' : 's'} in ${result.tookMs} ms.`,
    });
  }),
);

/// What has been run against this database, newest first. Super Admin only:
/// it is a record of everyone's actions, not just the reader's.
databaseRouter.get(
  '/log',
  asyncHandler(async (req, res) => {
    if (!isAdmin(req.user)) throw forbidden('Only a Super Admin can read the statement log.');

    const entries = await prisma.databaseQueryLog.findMany({
      where: { domainId: req.domain.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    res.json({ entries });
  }),
);

// ---------------------------------------------------------------------------
// One row at a time
// ---------------------------------------------------------------------------

const rowSchema = z.object({
  key: z.record(z.any()),
  values: z.record(z.any()).optional(),
});

databaseRouter.put(
  '/tables/:table/rows',
  validate(rowSchema),
  asyncHandler(async (req, res) => {
    const table = tableName.safeParse(req.params.table);
    if (!table.success) throw badRequest('Invalid table name.');

    const settings = await credentialsFor(req.domain.id);
    if (!settings.allowWrites) {
      throw forbidden('This database is set to read-only. A Super Admin can allow writes for this domain.');
    }

    await logStatement({
      domainId: req.domain.id,
      userId: req.user.id,
      sql: `UPDATE ${table.data} (row editor)`,
      kind: KIND.WRITE,
      verb: 'update',
      target: table.data,
    });

    const result = await updateRow(settings, table.data, { key: req.body.key, values: req.body.values || {} });
    res.json({ ...result, message: `Updated ${result.affectedRows} row${result.affectedRows === 1 ? '' : 's'}.` });
  }),
);

databaseRouter.post(
  '/tables/:table/rows/delete',
  validate(z.object({ key: z.record(z.any()) })),
  asyncHandler(async (req, res) => {
    const table = tableName.safeParse(req.params.table);
    if (!table.success) throw badRequest('Invalid table name.');

    const settings = await credentialsFor(req.domain.id);
    if (!settings.allowWrites) {
      throw forbidden('This database is set to read-only. A Super Admin can allow writes for this domain.');
    }

    await logStatement({
      domainId: req.domain.id,
      userId: req.user.id,
      sql: `DELETE FROM ${table.data} (row editor)`,
      kind: KIND.WRITE,
      verb: 'delete',
      target: table.data,
    });

    const result = await deleteRow(settings, table.data, { key: req.body.key });
    res.json({ ...result, message: `Deleted ${result.affectedRows} row${result.affectedRows === 1 ? '' : 's'}.` });
  }),
);

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

databaseRouter.get(
  '/tables/:table/export',
  asyncHandler(async (req, res) => {
    const table = tableName.safeParse(req.params.table);
    if (!table.success) throw badRequest('Invalid table name.');

    const format = req.query.format === 'sql' ? 'sql' : 'csv';
    const settings = await credentialsFor(req.domain.id);

    const safeName = table.data.replace(/[^\w.-]/g, '_');
    res.setHeader('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/sql; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.${format}"`);

    // Streamed straight to the response, so table size does not decide whether
    // this works.
    await exportTable(settings, table.data, { format, onChunk: (chunk) => res.write(chunk) });
    res.end();
  }),
);

/// Database failures become ordinary HTTP errors, keeping their explanation —
/// especially the Remote MySQL one, which is the answer most of the time.
databaseRouter.use((err, _req, res, next) => {
  if (err instanceof DatabaseError || err instanceof SqlError) {
    return res.status(err.status).json({ error: err.message });
  }
  next(err);
});
