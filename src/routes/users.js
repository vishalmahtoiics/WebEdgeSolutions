import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../db.js';
import { validate } from '../middleware/validate.js';
import { requireAdmin } from '../middleware/auth.js';
import { asyncHandler, badRequest, notFound } from '../lib/errors.js';
import { record } from '../services/notifier.js';

export const usersRouter = Router();
usersRouter.use(requireAdmin);

const publicUser = (u) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  isActive: u.isActive,
  createdAt: u.createdAt,
  domainCount: u._count?.domains,
  domains: u.domains?.map((d) => d.domain),
  resource: u.serverResource || null,
});

usersRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'asc' },
      include: {
        _count: { select: { domains: true } },
        serverResource: true,
      },
    });
    res.json({ users: users.map(publicUser) });
  }),
);

usersRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: {
        serverResource: true,
        domains: { include: { domain: { select: { id: true, name: true, status: true } } } },
        _count: { select: { domains: true } },
      },
    });
    if (!user) throw notFound('User not found.');
    res.json({ user: publicUser(user) });
  }),
);

const createUserSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  name: z.string().trim().min(1, 'Name is required.').max(100),
  password: z.string().min(8, 'Password must be at least 8 characters.'),
  role: z.enum(['SUPER_ADMIN', 'USER']).default('USER'),
  isActive: z.boolean().default(true),
});

usersRouter.post(
  '/',
  validate(createUserSchema),
  asyncHandler(async (req, res) => {
    const { email, name, password, role, isActive } = req.body;
    const exists = await prisma.user.findUnique({ where: { email } });
    if (exists) throw badRequest('A user with that email already exists.');

    const user = await prisma.user.create({
      data: { email, name, role, isActive, passwordHash: await bcrypt.hash(password, 12) },
      include: { _count: { select: { domains: true } }, serverResource: true },
    });
    await record({
      event: 'user.created',
      actor: req.user,
      summary: `Created the account ${user.email}`,
      detail: `Role: ${user.role === 'SUPER_ADMIN' ? 'Super Admin' : 'User'}`,
    });

    res.status(201).json({ user: publicUser(user) });
  }),
);

const updateUserSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').optional(),
  name: z.string().trim().min(1).max(100).optional(),
  // Optional: only sent when the admin wants to reset the password.
  password: z.string().min(8, 'Password must be at least 8 characters.').or(z.literal('')).optional(),
  role: z.enum(['SUPER_ADMIN', 'USER']).optional(),
  isActive: z.boolean().optional(),
});

usersRouter.put(
  '/:id',
  validate(updateUserSchema),
  asyncHandler(async (req, res) => {
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target) throw notFound('User not found.');

    const { email, name, password, role, isActive } = req.body;

    // Guard rails so an admin cannot lock themselves (or everyone) out.
    if (target.id === req.user.id) {
      if (isActive === false) throw badRequest('You cannot disable your own account.');
      if (role && role !== target.role) throw badRequest('You cannot change your own role.');
    }
    if (target.role === 'SUPER_ADMIN' && (role === 'USER' || isActive === false)) {
      const admins = await prisma.user.count({ where: { role: 'SUPER_ADMIN', isActive: true } });
      if (admins <= 1) throw badRequest('At least one active Super Admin must remain.');
    }

    if (email && email !== target.email) {
      const clash = await prisma.user.findUnique({ where: { email } });
      if (clash) throw badRequest('A user with that email already exists.');
    }

    const data = {};
    if (email !== undefined) data.email = email;
    if (name !== undefined) data.name = name;
    if (role !== undefined) data.role = role;
    if (isActive !== undefined) data.isActive = isActive;
    if (password) data.passwordHash = await bcrypt.hash(password, 12);

    const user = await prisma.user.update({
      where: { id: target.id },
      data,
      include: { _count: { select: { domains: true } }, serverResource: true },
    });
    res.json({ user: publicUser(user) });
  }),
);

usersRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target) throw notFound('User not found.');
    if (target.id === req.user.id) throw badRequest('You cannot delete your own account.');

    if (target.role === 'SUPER_ADMIN') {
      const admins = await prisma.user.count({ where: { role: 'SUPER_ADMIN', isActive: true } });
      if (admins <= 1) throw badRequest('At least one active Super Admin must remain.');
    }

    await prisma.user.delete({ where: { id: target.id } });
    await record({
      event: 'user.deleted',
      actor: req.user,
      summary: `Deleted the account ${target.email}`,
    });

    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// Domain assignment
// ---------------------------------------------------------------------------

const assignSchema = z.object({ domainIds: z.array(z.string().min(1)) });

/// Replaces a user's whole assignment list, which matches the checkbox UI.
usersRouter.put(
  '/:id/domains',
  validate(assignSchema),
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) throw notFound('User not found.');

    const ids = [...new Set(req.body.domainIds)];
    if (ids.length) {
      const found = await prisma.domain.count({ where: { id: { in: ids } } });
      if (found !== ids.length) throw badRequest('One or more selected domains no longer exist.');
    }

    await prisma.$transaction([
      prisma.userDomain.deleteMany({ where: { userId: user.id } }),
      prisma.userDomain.createMany({
        data: ids.map((domainId) => ({ userId: user.id, domainId })),
        skipDuplicates: true,
      }),
    ]);

    const assignments = await prisma.userDomain.findMany({
      where: { userId: user.id },
      include: { domain: { select: { id: true, name: true, status: true } } },
    });
    res.json({ domains: assignments.map((a) => a.domain) });
  }),
);

// ---------------------------------------------------------------------------
// Server resources (manually configured by the admin)
// ---------------------------------------------------------------------------

const resourceSchema = z.object({
  cpuCores: z.coerce.number().int().min(0).max(1024).nullish(),
  ramMb: z.coerce.number().int().min(0).nullish(),
  storageGb: z.coerce.number().int().min(0).nullish(),
  bandwidthGb: z.coerce.number().int().min(0).nullish(),
  notes: z.string().max(1000).optional(),
});

usersRouter.put(
  '/:id/resources',
  validate(resourceSchema),
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) throw notFound('User not found.');

    const data = Object.fromEntries(
      Object.entries(req.body).map(([k, v]) => [k, v === '' ? null : v]),
    );
    const resource = await prisma.serverResource.upsert({
      where: { userId: user.id },
      create: { userId: user.id, ...data },
      update: data,
    });
    res.json({ resource });
  }),
);
