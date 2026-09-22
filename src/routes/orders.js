// Orders, from an administrator's side. Super Admin only.
//
// The whole point of this file is that nothing here happens automatically. A
// UPI transfer cannot report itself back to this application, so an order sits
// at "payment reported" until a person looks at the bank account and says the
// money arrived. Every route below is that person acting, and each one records
// who acted.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler, badRequest, notFound } from '../lib/errors.js';
import { formatMinor } from '../lib/money.js';
import { whatsappLink, getStoreSettings } from '../services/storeService.js';

export const ordersRouter = Router();
ordersRouter.use(requireAuth, requireAdmin);

const present = (order, settings) => ({
  id: order.id,
  reference: order.reference,
  kind: order.kind,
  status: order.status,
  planName: order.plan?.name || null,
  tld: order.tld,
  domainName: order.domainName,
  amount: formatMinor(order.amountMinor, order.currency),
  amountMinor: order.amountMinor,
  currency: order.currency,
  billingPeriod: order.billingPeriod,

  customerName: order.customerName,
  customerEmail: order.customerEmail,
  customerPhone: order.customerPhone,
  message: order.message,

  // What the customer says their bank gave them. Nobody has checked it, and
  // the field name should not pretend otherwise.
  claimedPaymentReference: order.paymentReference,
  paymentSubmittedAt: order.paymentSubmittedAt,
  paidAt: order.paidAt,
  provisionedAt: order.provisionedAt,
  confirmedBy: order.confirmedBy ? { id: order.confirmedBy.id, name: order.confirmedBy.name } : null,
  adminNotes: order.adminNotes,

  domainId: order.domainId,
  userId: order.userId,
  linkedDomain: order.domain ? { id: order.domain.id, name: order.domain.name } : null,
  linkedUser: order.user ? { id: order.user.id, name: order.user.name, email: order.user.email } : null,

  createdAt: order.createdAt,
  // Ready to send, with the reference already in the message.
  whatsappLink: whatsappLink(
    order.customerPhone,
    `Hi ${order.customerName.split(' ')[0]}, about your order ${order.reference}`,
  ),
  storeWhatsappLink: whatsappLink(settings?.whatsappNumber, `Order ${order.reference}`),
});

const include = {
  plan: { select: { name: true } },
  confirmedBy: { select: { id: true, name: true } },
  domain: { select: { id: true, name: true } },
  user: { select: { id: true, name: true, email: true } },
};

const listQuery = z.object({
  status: z.enum(['PENDING_PAYMENT', 'PAYMENT_SUBMITTED', 'PAID', 'PROVISIONED', 'CANCELLED']).optional(),
  search: z.string().trim().max(120).optional(),
});

ordersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) throw badRequest('Invalid filter.');

    const where = {};
    if (parsed.data.status) where.status = parsed.data.status;
    if (parsed.data.search) {
      const term = parsed.data.search;
      where.OR = [
        { reference: { contains: term.toUpperCase() } },
        { customerName: { contains: term, mode: 'insensitive' } },
        { customerEmail: { contains: term, mode: 'insensitive' } },
        { customerPhone: { contains: term } },
        { domainName: { contains: term, mode: 'insensitive' } },
      ];
    }

    const [orders, counts, settings] = await Promise.all([
      prisma.order.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200, include }),
      prisma.order.groupBy({ by: ['status'], _count: { _all: true } }),
      getStoreSettings(),
    ]);

    // Money still owed, so the queue leads with the number that matters.
    const awaiting = await prisma.order.aggregate({
      where: { status: { in: ['PENDING_PAYMENT', 'PAYMENT_SUBMITTED'] } },
      _sum: { amountMinor: true },
    });
    const collected = await prisma.order.aggregate({
      where: { status: { in: ['PAID', 'PROVISIONED'] } },
      _sum: { amountMinor: true },
    });

    res.json({
      orders: orders.map((o) => present(o, settings)),
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
      totals: {
        awaiting: formatMinor(awaiting._sum.amountMinor || 0),
        collected: formatMinor(collected._sum.amountMinor || 0),
      },
    });
  }),
);

ordersRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const order = await prisma.order.findUnique({ where: { id: req.params.id }, include });
    if (!order) throw notFound('Order not found.');
    res.json({ order: present(order, await getStoreSettings()) });
  }),
);

/// Confirms that the money arrived.
///
/// This is a person's judgement, not a verified fact, so it records who made it.
ordersRouter.post(
  '/:id/confirm-payment',
  validate(z.object({ note: z.string().trim().max(1000).optional() })),
  asyncHandler(async (req, res) => {
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order) throw notFound('Order not found.');
    if (order.status === 'CANCELLED') throw badRequest('This order was cancelled.');
    if (['PAID', 'PROVISIONED'].includes(order.status)) throw badRequest('This payment is already confirmed.');

    const updated = await prisma.order.update({
      where: { id: order.id },
      data: {
        status: 'PAID',
        paidAt: new Date(),
        confirmedById: req.user.id,
        adminNotes: req.body.note ? `${order.adminNotes ? `${order.adminNotes}\n` : ''}${req.body.note}` : order.adminNotes,
      },
      include,
    });

    res.json({
      order: present(updated, await getStoreSettings()),
      message: `Payment confirmed for ${order.reference}.`,
    });
  }),
);

/// Marks the order as set up, optionally tying it to the domain and the portal
/// account it produced, so the order stops being a loose end.
ordersRouter.post(
  '/:id/provision',
  validate(
    z.object({
      domainId: z.string().trim().max(40).optional().or(z.literal('')),
      userId: z.string().trim().max(40).optional().or(z.literal('')),
      note: z.string().trim().max(1000).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order) throw notFound('Order not found.');
    if (order.status === 'CANCELLED') throw badRequest('This order was cancelled.');
    if (order.status === 'PENDING_PAYMENT' || order.status === 'PAYMENT_SUBMITTED') {
      throw badRequest('Confirm the payment before marking this set up.');
    }

    // A reference to something that is not there would be worse than no
    // reference, so both links are checked.
    if (req.body.domainId) {
      const domain = await prisma.domain.findUnique({ where: { id: req.body.domainId } });
      if (!domain) throw badRequest('That domain does not exist in the portal.');
    }
    if (req.body.userId) {
      const user = await prisma.user.findUnique({ where: { id: req.body.userId } });
      if (!user) throw badRequest('That user does not exist.');
    }

    const updated = await prisma.order.update({
      where: { id: order.id },
      data: {
        status: 'PROVISIONED',
        provisionedAt: new Date(),
        domainId: req.body.domainId || order.domainId,
        userId: req.body.userId || order.userId,
        adminNotes: req.body.note ? `${order.adminNotes ? `${order.adminNotes}\n` : ''}${req.body.note}` : order.adminNotes,
      },
      include,
    });

    res.json({
      order: present(updated, await getStoreSettings()),
      message: `${order.reference} marked as set up.`,
    });
  }),
);

ordersRouter.post(
  '/:id/cancel',
  validate(z.object({ note: z.string().trim().max(1000).optional() })),
  asyncHandler(async (req, res) => {
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order) throw notFound('Order not found.');
    if (order.status === 'PROVISIONED') {
      throw badRequest('This order has already been set up. Cancelling it here would not undo that.');
    }

    const updated = await prisma.order.update({
      where: { id: order.id },
      data: {
        status: 'CANCELLED',
        adminNotes: req.body.note ? `${order.adminNotes ? `${order.adminNotes}\n` : ''}${req.body.note}` : order.adminNotes,
      },
      include,
    });

    res.json({ order: present(updated, await getStoreSettings()), message: `${order.reference} cancelled.` });
  }),
);

ordersRouter.put(
  '/:id/notes',
  validate(z.object({ adminNotes: z.string().max(4000) })),
  asyncHandler(async (req, res) => {
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order) throw notFound('Order not found.');

    const updated = await prisma.order.update({
      where: { id: order.id },
      data: { adminNotes: req.body.adminNotes || null },
      include,
    });
    res.json({ order: present(updated, await getStoreSettings()), message: 'Notes saved.' });
  }),
);
