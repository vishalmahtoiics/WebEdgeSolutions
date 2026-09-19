import { Router } from 'express';
import { prisma } from '../db.js';
import { requireAuth, isAdmin } from '../middleware/auth.js';
import { asyncHandler } from '../lib/errors.js';

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);

const ACTIVE = 'active';

dashboardRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    if (isAdmin(req.user)) {
      const [users, domains, providers, activeDomains, emails, recent] = await Promise.all([
        prisma.user.count(),
        prisma.domain.count(),
        prisma.provider.count({ where: { isActive: true } }),
        prisma.domain.count({ where: { status: ACTIVE } }),
        prisma.emailAccount.count(),
        prisma.domain.findMany({
          take: 5,
          orderBy: { createdAt: 'desc' },
          include: { provider: { select: { name: true } } },
        }),
      ]);

      return res.json({
        role: 'SUPER_ADMIN',
        stats: {
          totalUsers: users,
          totalDomains: domains,
          connectedProviders: providers,
          activeDomains,
          totalEmailAccounts: emails,
        },
        recentDomains: recent.map((d) => ({
          id: d.id,
          name: d.name,
          status: d.status,
          sourceLabel: d.source === 'MANUAL' ? 'Manually Added' : d.provider?.name || 'Provider',
        })),
      });
    }

    // Normal user: counts are scoped to assigned domains only.
    const assignments = await prisma.userDomain.findMany({
      where: { userId: req.user.id },
      select: { domainId: true },
    });
    const domainIds = assignments.map((a) => a.domainId);

    const [domains, emailCount, resource] = await Promise.all([
      prisma.domain.findMany({
        where: { id: { in: domainIds } },
        orderBy: { name: 'asc' },
        include: {
          provider: { select: { name: true } },
          _count: { select: { emailAccounts: true } },
        },
      }),
      prisma.emailAccount.count({ where: { domainId: { in: domainIds } } }),
      prisma.serverResource.findUnique({ where: { userId: req.user.id } }),
    ]);

    res.json({
      role: 'USER',
      stats: {
        myDomains: domains.length,
        myEmailAccounts: emailCount,
        activeDomains: domains.filter((d) => d.status === ACTIVE).length,
      },
      resource,
      domains: domains.map((d) => ({
        id: d.id,
        name: d.name,
        status: d.status,
        sourceLabel: d.source === 'MANUAL' ? 'Manually Added' : d.provider?.name || 'Provider',
        emailCount: d._count.emailAccounts,
      })),
    });
  }),
);

/// The signed-in user's own resource allocation, for the Resources page.
dashboardRouter.get(
  '/my-resources',
  asyncHandler(async (req, res) => {
    const resource = await prisma.serverResource.findUnique({ where: { userId: req.user.id } });
    res.json({ resource });
  }),
);

/// Every mailbox across the domains the signed-in user can reach.
dashboardRouter.get(
  '/my-emails',
  asyncHandler(async (req, res) => {
    const where = isAdmin(req.user)
      ? {}
      : { domain: { assignments: { some: { userId: req.user.id } } } };

    const emails = await prisma.emailAccount.findMany({
      where,
      orderBy: [{ domain: { name: 'asc' } }, { address: 'asc' }],
      include: { domain: { select: { id: true, name: true } } },
    });
    res.json({ emails });
  }),
);
