import 'dotenv/config';
import { cleanEnv, env } from './lib/env.js';

function required(name, fallbackInDev) {
  const value = env(name);
  if (value) return value;
  if (process.env.NODE_ENV !== 'production' && fallbackInDev !== undefined) {
    return fallbackInDev;
  }
  throw new Error(`Missing required environment variable: ${name}`);
}

export const config = {
  env: env('NODE_ENV') || 'development',
  port: Number(env('PORT') || 3000),
  databaseUrl: required('DATABASE_URL'),
  sessionSecret: required('SESSION_SECRET', 'dev-only-insecure-session-secret'),
  encryptionKey: required('ENCRYPTION_KEY', '0'.repeat(64)),
  secureCookies: String(env('SECURE_COOKIES')).toLowerCase() === 'true',
  /// Hostname that serves the standalone mail app from its root, e.g.
  /// mails.example.com. Unset changes nothing else: the app is always
  /// reachable at /mails, /mail and /webmail on the main site as well.
  mailHost: (env('MAIL_HOST') || '').toLowerCase(),
  admin: {
    email: env('ADMIN_EMAIL') || 'admin@example.com',
    password: cleanEnv(process.env.ADMIN_PASSWORD) || 'Admin@12345',
    name: env('ADMIN_NAME') || 'Super Admin',
  },
};

export const isProd = config.env === 'production';
