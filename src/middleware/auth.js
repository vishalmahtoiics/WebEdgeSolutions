import { prisma } from '../db.js';
import { forbidden, unauthorized } from '../lib/errors.js';

/// Loads the signed-in user on every request. Re-reading from the database
/// means a disabled or deleted account loses access immediately, without
/// waiting for their session cookie to expire.
export async function loadUser(req, _res, next) {
  try {
    if (!req.session?.userId) return next();
    const user = await prisma.user.findUnique({
      where: { id: req.session.userId },
      select: { id: true, email: true, name: true, role: true, isActive: true },
    });
    if (!user || !user.isActive) {
      req.session.destroy(() => {});
      return next();
    }
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAuth(req, _res, next) {
  if (!req.user) return next(unauthorized());
  next();
}

export function requireAdmin(req, _res, next) {
  if (!req.user) return next(unauthorized());
  if (req.user.role !== 'SUPER_ADMIN') return next(forbidden('Super Admin access required.'));
  next();
}

export const isAdmin = (user) => user?.role === 'SUPER_ADMIN';

/// Single gate for every domain-scoped route. A normal user may only reach a
/// domain that is explicitly assigned to them, so changing the id in the URL
/// gets a 404 rather than someone else's data.
export async function getAccessibleDomain(user, domainId, include = {}) {
  const domain = await prisma.domain.findUnique({
    where: { id: domainId },
    include,
  });
  if (!domain) return null;
  if (isAdmin(user)) return domain;

  const assignment = await prisma.userDomain.findUnique({
    where: { userId_domainId: { userId: user.id, domainId } },
    select: { id: true },
  });
  return assignment ? domain : null;
}
