import 'dotenv/config';

function required(name, fallbackInDev) {
  const value = process.env[name];
  if (value) return value;
  if (process.env.NODE_ENV !== 'production' && fallbackInDev !== undefined) {
    return fallbackInDev;
  }
  throw new Error(`Missing required environment variable: ${name}`);
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),
  databaseUrl: required('DATABASE_URL'),
  sessionSecret: required('SESSION_SECRET', 'dev-only-insecure-session-secret'),
  encryptionKey: required('ENCRYPTION_KEY', '0'.repeat(64)),
  secureCookies: String(process.env.SECURE_COOKIES).toLowerCase() === 'true',
  admin: {
    email: process.env.ADMIN_EMAIL || 'admin@example.com',
    password: process.env.ADMIN_PASSWORD || 'Admin@12345',
    name: process.env.ADMIN_NAME || 'Super Admin',
  },
};

export const isProd = config.env === 'production';
