import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { prisma } from '../db.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler, unauthorized, badRequest, HttpError } from '../lib/errors.js';
import { record } from '../services/notifier.js';
import {
  PENDING_TTL_MS, beginEnrolment, completeEnrolment, disable,
  isEnrolled, regenerateRecoveryCodes, status, verifySecondFactor,
} from '../services/twoFactorService.js';
import { config } from '../config.js';

export const authRouter = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Please try again in a few minutes.' },
});

/// The second step gets its own limit. It is a six-digit space, so it has to
/// be much tighter than the password one: twenty guesses per quarter hour
/// against a million codes is not a threat, two thousand would be.
const codeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many codes tried. Wait a few minutes.' },
});

/// Managing your own second factor is a different budget, deliberately.
///
/// These routes already need a signed-in session and the account password, so
/// they are not a guessing surface. Sharing the tight limit above would mean
/// somebody hammering the sign-in step could stop the real owner from turning
/// the factor off — locking them out with the very feature meant to protect
/// them, from an IP they do not control.
const manageLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Wait a few minutes.' },
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  password: z.string().min(1, 'Enter your password.'),
});

authRouter.post(
  '/login',
  loginLimiter,
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });

    // Always compare against a hash so a missing account and a wrong password
    // take the same amount of time.
    const hash = user?.passwordHash || '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidi';
    const ok = await bcrypt.compare(password, hash);

    if (!user || !ok) {
      // A failed sign-in is the one alert worth having even when nothing
      // changed: somebody trying passwords against your portal is the thing
      // you want to hear about first. The address tried is recorded; the
      // password never is.
      await record({
        event: 'security.signin.failed',
        summary: `Failed sign-in for ${email}`,
        detail: user
          ? 'The account exists and the password was wrong.'
          : 'No account with that address.',
        ip: req.ip,
      });
      throw unauthorized('Incorrect email or password.');
    }

    if (!user.isActive) {
      await record({
        event: 'security.signin.disabled',
        summary: `Disabled account ${email} tried to sign in`,
        ip: req.ip,
      });
      throw unauthorized('This account has been disabled.');
    }

    // A Secure cookie sent over plain HTTP is silently discarded by the
    // browser: the sign-in would return 200 and then bounce straight back to
    // the login screen with nothing to explain why. `req.secure` honours
    // X-Forwarded-Proto because the app trusts the first proxy hop.
    if (config.secureCookies && !req.secure) {
      throw new HttpError(
        500,
        'This server is set to issue HTTPS-only cookies (SECURE_COOKIES=true), but the request ' +
          'arrived over HTTP, so the session cookie would be discarded. Serve the site over HTTPS, ' +
          'or set SECURE_COOKIES=false.',
      );
    }

    // Prevent session fixation: start a fresh session on every sign-in.
    await new Promise((resolve, reject) =>
      req.session.regenerate((err) => (err ? reject(err) : resolve())),
    );

    // Password accepted, but not signed in yet. The session holds only a
    // promise to finish, with a deadline: `userId` is what grants access, and
    // it is deliberately not set here.
    if (isEnrolled(user)) {
      req.session.pendingUserId = user.id;
      req.session.pendingAt = Date.now();
      return res.json({ twoFactor: true, email: user.email });
    }

    req.session.userId = user.id;

    res.json({
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    });
  }),
);

// ---------------------------------------------------------------------------
// The second step
// ---------------------------------------------------------------------------

/// The half-signed-in account, or nothing.
///
/// The deadline is checked here rather than trusted to the cookie's own
/// lifetime, so a pending session left open on a shared machine stops being
/// useful in minutes rather than hours.
function pendingUserId(req) {
  if (!req.session?.pendingUserId) return null;
  if (Date.now() - (req.session.pendingAt || 0) > PENDING_TTL_MS) {
    delete req.session.pendingUserId;
    delete req.session.pendingAt;
    return null;
  }
  return req.session.pendingUserId;
}

const codeSchema = z.object({
  code: z.string().trim().min(6, 'Enter the code from your app, or a recovery code.').max(40),
});

authRouter.post(
  '/2fa',
  codeLimiter,
  validate(codeSchema),
  asyncHandler(async (req, res) => {
    const userId = pendingUserId(req);
    if (!userId) throw unauthorized('That took too long. Please sign in again.');

    const result = await verifySecondFactor({ userId, code: req.body.code });
    const user = await prisma.user.findUnique({ where: { id: userId } });

    if (!result.ok) {
      // Worth hearing about: somebody has the password and is working on the
      // second factor. That is a different situation from a wrong password,
      // and a more urgent one.
      await record({
        event: 'security.2fa.failed',
        summary: `Wrong two-factor code for ${user?.email || 'an account'}`,
        detail: result.reason,
        ip: req.ip,
      });
      throw unauthorized(result.reason);
    }

    if (!user?.isActive) throw unauthorized('This account has been disabled.');

    // A second regeneration: the id that was handed out for the pending state
    // must not be the one that ends up authenticated.
    await new Promise((resolve, reject) =>
      req.session.regenerate((err) => (err ? reject(err) : resolve())),
    );
    req.session.userId = user.id;

    if (result.method === 'recovery') {
      await record({
        event: 'security.2fa.recovery-used',
        actor: user,
        summary: `${user.email} signed in with a recovery code`,
        detail:
          `${result.codesLeft} recovery code${result.codesLeft === 1 ? '' : 's'} left.` +
          (result.codesLeft <= 2 ? ' Generate a new set soon.' : ''),
        ip: req.ip,
      });
    }

    res.json({
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      usedRecoveryCode: result.method === 'recovery',
      recoveryCodesLeft: result.codesLeft ?? null,
    });
  }),
);

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    await new Promise((resolve) => req.session.destroy(resolve));
    res.clearCookie('portal.sid');
    res.json({ ok: true });
  }),
);

authRouter.get('/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({ user: req.user });
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password.'),
  newPassword: z.string().min(8, 'New password must be at least 8 characters.'),
});

authRouter.post(
  '/change-password',
  requireAuth,
  validate(passwordSchema),
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    const ok = await bcrypt.compare(req.body.currentPassword, user.passwordHash);
    if (!ok) throw unauthorized('Your current password is incorrect.');

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await bcrypt.hash(req.body.newPassword, 12) },
    });
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// Setting up two-factor authentication
//
// The secret lives in the session until a working code proves the
// authenticator app really has it. Writing it to the account first would mean
// a badly scanned QR, or a tab closed halfway, could leave somebody enrolled
// in a factor they cannot produce — locked out of their own portal by a
// security feature.
// ---------------------------------------------------------------------------

authRouter.get(
  '/2fa',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ twoFactor: await status(req.user.id) });
  }),
);

authRouter.post(
  '/2fa/setup',
  requireAuth,
  asyncHandler(async (req, res) => {
    const enrolment = await beginEnrolment({ email: req.user.email });

    // Held here, not returned to be handed back: the browser never gets to
    // choose which secret is being confirmed.
    req.session.enrolSecret = enrolment.secret;
    req.session.enrolAt = Date.now();

    res.json({
      qr: enrolment.qr,
      manualKey: enrolment.manualKey,
      otpauthUrl: enrolment.otpauthUrl,
    });
  }),
);

authRouter.post(
  '/2fa/enable',
  requireAuth,
  manageLimiter,
  validate(codeSchema),
  asyncHandler(async (req, res) => {
    const secret = req.session.enrolSecret;
    if (!secret || Date.now() - (req.session.enrolAt || 0) > 15 * 60 * 1000) {
      throw badRequest('That setup has expired. Start again to get a fresh QR code.');
    }

    let result;
    try {
      result = await completeEnrolment({ userId: req.user.id, secret, code: req.body.code });
    } catch (err) {
      throw badRequest(err.message);
    }

    delete req.session.enrolSecret;
    delete req.session.enrolAt;

    await record({
      event: 'security.2fa.enabled',
      actor: req.user,
      summary: `${req.user.email} switched on two-factor authentication`,
      ip: req.ip,
    });

    // The one and only time these are readable. Only hashes are stored, so
    // this response cannot be reproduced — not by the portal, and not by
    // anyone with the database.
    res.json({ ok: true, recoveryCodes: result.codes });
  }),
);

/// Turning it off needs the password again.
///
/// Anyone who walks up to an unlocked screen could otherwise remove the
/// factor that exists precisely to survive that.
const confirmSchema = z.object({
  password: z.string().min(1, 'Enter your password to confirm.'),
});

const confirmPassword = async (user, password) => {
  const row = await prisma.user.findUnique({ where: { id: user.id } });
  if (!(await bcrypt.compare(password, row.passwordHash))) {
    throw unauthorized('That password is not right.');
  }
};

authRouter.post(
  '/2fa/disable',
  requireAuth,
  manageLimiter,
  validate(confirmSchema),
  asyncHandler(async (req, res) => {
    await confirmPassword(req.user, req.body.password);
    await disable(req.user.id);

    await record({
      event: 'security.2fa.disabled',
      actor: req.user,
      summary: `${req.user.email} switched off two-factor authentication`,
      detail: 'This account is now protected by its password alone.',
      ip: req.ip,
    });

    res.json({ ok: true });
  }),
);

authRouter.post(
  '/2fa/recovery-codes',
  requireAuth,
  manageLimiter,
  validate(confirmSchema),
  asyncHandler(async (req, res) => {
    await confirmPassword(req.user, req.body.password);

    const current = await status(req.user.id);
    if (!current.enabled) throw badRequest('Two-factor authentication is not switched on.');

    const codes = await regenerateRecoveryCodes(req.user.id);

    await record({
      event: 'security.2fa.recovery-reissued',
      actor: req.user,
      summary: `${req.user.email} generated new recovery codes`,
      detail: 'The previous set no longer works.',
      ip: req.ip,
    });

    res.json({ ok: true, recoveryCodes: codes });
  }),
);
