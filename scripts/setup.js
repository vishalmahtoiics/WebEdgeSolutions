#!/usr/bin/env node
// One-command setup: copies .env if missing (generating real secrets), applies
// migrations, generates the Prisma client and seeds the first Super Admin.
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');

function run(command) {
  console.log(`\n> ${command}`);
  execSync(command, { cwd: root, stdio: 'inherit' });
}

if (!fs.existsSync(envPath)) {
  const template = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  const filled = template
    .replace(/^SESSION_SECRET=.*$/m, `SESSION_SECRET="${crypto.randomBytes(32).toString('hex')}"`)
    .replace(/^ENCRYPTION_KEY=.*$/m, `ENCRYPTION_KEY="${crypto.randomBytes(32).toString('hex')}"`);
  fs.writeFileSync(envPath, filled);
  console.log('Created .env with freshly generated secrets.');
  console.log('Review DATABASE_URL in .env before continuing if your database differs.');
} else {
  console.log('.env already exists — leaving it untouched.');
}

run('npx prisma migrate deploy');
run('npx prisma generate');
run('node prisma/seed.js');

console.log('\nSetup complete. Start the app with:  npm run dev\n');
