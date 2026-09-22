import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { prisma } from '../db.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler, unauthorized, HttpError } from '../lib/errors.js';
import { record } from '../services/notifier.js';
import { config } from '../config.js';

export const authRouter = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Please try again in a few minutes.' },
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
    req.session.userId = user.id;

    res.json({
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
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
