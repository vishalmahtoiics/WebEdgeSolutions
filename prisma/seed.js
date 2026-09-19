import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { config } from '../src/config.js';

const prisma = new PrismaClient();

// Creates the first Super Admin so there is a way to sign in after setup.
// Safe to re-run: an existing account is left untouched.
async function main() {
  const email = config.admin.email.toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email } });

  if (existing) {
    console.log(`Super Admin already exists (${email}). Nothing to do.`);
    return;
  }

  await prisma.user.create({
    data: {
      email,
      name: config.admin.name,
      role: 'SUPER_ADMIN',
      passwordHash: await bcrypt.hash(config.admin.password, 12),
    },
  });

  console.log('\n  Super Admin created:');
  console.log(`    email:    ${email}`);
  console.log(`    password: ${config.admin.password}`);
  console.log('\n  Change this password after your first sign-in.\n');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
