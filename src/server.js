import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';

import { config, isProd } from './config.js';
import { prisma } from './db.js';
import { loadUser } from './middleware/auth.js';
import { HttpError } from './lib/errors.js';
import { authRouter } from './routes/auth.js';
import { providersRouter } from './routes/providers.js';
import { domainsRouter } from './routes/domains.js';
import { usersRouter } from './routes/users.js';
import { dashboardRouter } from './routes/dashboard.js';
import { mailAppRouter } from './routes/mailapp.js';
import { storeRouter } from './routes/store.js';
import { catalogRouter } from './routes/catalog.js';
import { ordersRouter } from './routes/orders.js';
import { settingsRouter } from './routes/settings.js';
import { billingRouter } from './routes/billing.js';
import { ticketsRouter } from './routes/tickets.js';
import { startScheduler } from './services/scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Behind a reverse proxy (the usual deployment) trust the first hop so secure
// cookies and rate-limit client IPs work correctly.
app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  }),
);

app.use(express.json({ limit: '256kb' }));

const PgStore = connectPgSimple(session);
app.use(
  session({
    name: 'portal.sid',
    store: new PgStore({
      conString: config.databaseUrl,
      tableName: 'user_sessions',
      // The table is created by a migration, so the schema stays the single
      // source of truth and `prisma migrate` sees no drift.
      createTableIfMissing: false,
    }),
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.secureCookies,
      maxAge: 1000 * 60 * 60 * 8,
    },
  }),
);

app.use(loadUser);

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/auth', authRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/providers', providersRouter);
app.use('/api/domains', domainsRouter);
app.use('/api/users', usersRouter);

app.use('/api/webmail', mailAppRouter);

// The public storefront. No session required — this is the one part of the API
// a stranger can reach, which is why prices are computed server-side and every
// write is rate limited.
app.use('/api/store', storeRouter);
app.use('/api/catalog', catalogRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/billing', billingRouter);
app.use('/api/tickets', ticketsRouter);

app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API endpoint.' }));

// Three front ends share this server:
//
//   /          the public storefront — plans, domain search, ordering
//   /portal    the admin and customer portal
//   /webmail   the standalone mail app, or MAIL_HOST if one is set
//
// The storefront has the root because it is the part strangers arrive at. The
// portal sits under /portal, which costs its router nothing: it addresses its
// own views through the URL hash (#/dashboard), so the path it is served from
// is not part of its routing at all.
// One design language, served once. All three apps reference /shared, so the
// fonts and the token layer are downloaded and cached a single time rather
// than three times, and there is one file to change when something moves.
//
// An absolute path is safe here where it would not be for an app's own assets:
// this is a server-level mount, so it resolves the same from /, from /portal,
// from /webmail and from a dedicated mail hostname.
const sharedDir = path.join(__dirname, '..', 'public-shared');

const storeDir = path.join(__dirname, '..', 'public-store');
const portalDir = path.join(__dirname, '..', 'public');
const mailDir = path.join(__dirname, '..', 'public-mail');
const staticOptions = { maxAge: isProd ? '1h' : 0 };

const isMailHost = (req) =>
  Boolean(config.mailHost) && String(req.hostname || '').toLowerCase() === config.mailHost;

/// Serves a single-page app from `dir` under `base`.
///
/// An unknown path under the base redirects to the base rather than being
/// answered with the index. That is not a detail: every one of these apps
/// references its assets relatively — `css/app.css` rather than
/// `/css/app.css` — so that it works wherever it is mounted. Answering
/// /portal/a/b with the index would make the browser resolve that stylesheet
/// against /portal/a/, and the page would load without any styling or script.
///
/// Nothing is lost by redirecting, because all three apps keep their own
/// routes in the URL fragment, and a fragment survives a redirect whose
/// Location carries none of its own.
const mountSpa = (base, dir) => {
  app.use(base, express.static(dir, staticOptions));
  app.get(base, (_req, res) => res.redirect(302, `${base}/`));
  app.get(`${base}/*`, (req, res) =>
    req.path === `${base}/`
      ? res.sendFile(path.join(dir, 'index.html'))
      : res.redirect(302, `${base}/`),
  );
};

app.use('/shared', express.static(sharedDir, { maxAge: isProd ? '30d' : 0, immutable: isProd }));

mountSpa('/portal', portalDir);
mountSpa('/webmail', mailDir);

// A dedicated mail hostname serves the mail app from its root instead.
app.use((req, res, next) => {
  if (!isMailHost(req)) return next();
  return express.static(mailDir, staticOptions)(req, res, next);
});

app.use(express.static(storeDir, staticOptions));

// Whichever app owns the root here. Same rule as above: an unknown path
// redirects rather than being served the index at a depth its relative asset
// paths could not survive.
app.get('*', (req, res) => {
  const dir = isMailHost(req) ? mailDir : storeDir;
  if (req.path === '/') return res.sendFile(path.join(dir, 'index.html'));
  return res.redirect(302, '/');
});

// Error handler. Client errors carry their message through; anything else is
// logged server-side and reported generically so internals do not leak.
app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }
  if (err?.status && err.status < 500) {
    return res.status(err.status).json({ error: err.message });
  }
  // Turn the two Prisma failures that actually strand a deployment into an
  // instruction, so the container log says what to do rather than just what
  // broke. The client still gets the generic message.
  if (err?.code === 'P2021' || err?.code === 'P2022') {
    console.error(
      '[error] The database schema is missing or out of date. ' +
        'Run `npx prisma migrate deploy` against DATABASE_URL, or start the app with `npm start`, ' +
        'which applies migrations before serving.',
    );
  } else if (err?.code === 'P1001' || err?.code === 'P1000') {
    console.error(
      '[error] Could not reach the database. Check DATABASE_URL — inside Docker the host must be ' +
        'the database service name, not localhost.',
    );
  }

  console.error('[error]', err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

const server = app.listen(config.port, () => {
  console.log(`\n  Hosting portal running on port ${config.port}\n`);

  // Nightly sync and expiry reminders. The timer is unref'd and every job is
  // guarded by a lock and a last-run time, so starting it here costs nothing
  // when the feature is switched off — which it is until somebody turns it on.
  startScheduler();
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `\n  ✕ Port ${config.port} is already in use.\n\n` +
        '  Set PORT to a free port, or stop the process already listening on it.\n',
    );
    process.exit(1);
  }
  if (err.code === 'EACCES') {
    console.error(`\n  ✕ Not allowed to bind port ${config.port}. Use a port above 1024.\n`);
    process.exit(1);
  }
  throw err;
});

async function shutdown(signal) {
  console.log(`\n${signal} received, shutting down.`);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { app };
