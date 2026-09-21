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

app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API endpoint.' }));

// Two front ends share this server: the admin portal, and the standalone
// webmail app people sign in to with an email address.
//
// Which one you get depends on the hostname (MAIL_HOST), so webmail can live
// at mails.example.com. /webmail works as well, for setups without a second
// DNS name and for trying it out before the DNS exists.
const publicDir = path.join(__dirname, '..', 'public');
const mailDir = path.join(__dirname, '..', 'public-mail');
const staticOptions = { maxAge: isProd ? '1h' : 0 };

const isMailHost = (req) =>
  Boolean(config.mailHost) && String(req.hostname || '').toLowerCase() === config.mailHost;

app.use('/webmail', express.static(mailDir, staticOptions));
app.get('/webmail/*', (_req, res) => res.sendFile(path.join(mailDir, 'index.html')));

app.use((req, res, next) => {
  if (!isMailHost(req)) return next();
  return express.static(mailDir, staticOptions)(req, res, next);
});

app.use(express.static(publicDir, staticOptions));

// Any remaining path falls through to the right index.html, so client-side
// routes survive a refresh.
app.get('*', (req, res) =>
  res.sendFile(path.join(isMailHost(req) ? mailDir : publicDir, 'index.html')),
);

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
