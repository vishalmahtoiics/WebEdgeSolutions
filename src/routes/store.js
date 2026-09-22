// The public storefront's API.
//
// Everything here is reachable without signing in, which makes it the only part
// of this application a stranger can talk to. Three things follow from that:
//
//   Prices come from the database, never from the request. A browser saying a
//   ₹1,499 plan costs ₹1 is describing a wish.
//
//   Every write is rate limited. An open order form is a spam target, and the
//   domain search spends a provider's API quota on each call.
//
//   An order looked up by reference returns only what is needed to pay it. The
//   reference is effectively a bearer token; if one leaks, it must not hand
//   over a customer's name, email and phone number with it.

import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { prisma } from '../db.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler, badRequest, notFound } from '../lib/errors.js';
import { getAdapter } from '../providers/index.js';
import { loadProviderWithToken } from '../services/providerService.js';
import { formatMinor } from '../lib/money.js';
import { record } from '../services/notifier.js';
import {
  publicStoreConfig, priceOrder, generateReference, paymentDetailsFor, upiQrSvg, upiLink,
  getStoreSettings, whatsappLink,
} from '../services/storeService.js';

export const storeRouter = Router();

const limiter = (max, minutes, message) =>
  rateLimit({
    windowMs: minutes * 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: message },
  });

const orderLimiter = limiter(10, 60, 'Too many orders from this address. Please try again later, or message us on WhatsApp.');
const searchLimiter = limiter(40, 15, 'Too many domain searches. Please wait a few minutes.');
const paymentLimiter = limiter(20, 60, 'Too many attempts. Please wait a few minutes.');

/// What a plan looks like to a visitor. No internal ids beyond the one needed
/// to order it, and no timestamps.
const presentPlan = (plan) => ({
  id: plan.id,
  slug: plan.slug,
  name: plan.name,
  kind: plan.kind,
  tagline: plan.tagline,
  price: formatMinor(plan.priceMinor, plan.currency),
  priceMinor: plan.priceMinor,
  wasPrice: plan.wasPriceMinor ? formatMinor(plan.wasPriceMinor, plan.currency) : null,
  currency: plan.currency,
  billingPeriod: plan.billingPeriod,
  features: plan.features || [],
  isFeatured: plan.isFeatured,
});

const presentTld = (row) => ({
  tld: row.tld,
  register: formatMinor(row.registerMinor, row.currency),
  registerMinor: row.registerMinor,
  renew: row.renewMinor ? formatMinor(row.renewMinor, row.currency) : null,
  isPopular: row.isPopular,
});

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

storeRouter.get(
  '/config',
  asyncHandler(async (_req, res) => {
    const config = await publicStoreConfig();
    const settings = await getStoreSettings();
    res.json({
      ...config,
      // A general enquiry link, separate from the per-order one.
      whatsappLink: whatsappLink(settings.whatsappNumber, 'Hi, I have a question about hosting.'),
    });
  }),
);

storeRouter.get(
  '/plans',
  asyncHandler(async (_req, res) => {
    const plans = await prisma.plan.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { priceMinor: 'asc' }],
    });
    res.json({ plans: plans.map(presentPlan) });
  }),
);

storeRouter.get(
  '/plans/:slug',
  asyncHandler(async (req, res) => {
    const plan = await prisma.plan.findFirst({
      where: { slug: String(req.params.slug).toLowerCase(), isActive: true },
    });
    if (!plan) throw notFound('That plan was not found.');
    res.json({ plan: presentPlan(plan) });
  }),
);

storeRouter.get(
  '/tlds',
  asyncHandler(async (_req, res) => {
    const tlds = await prisma.tldPrice.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { registerMinor: 'asc' }],
    });
    res.json({ tlds: tlds.map(presentTld) });
  }),
);

// ---------------------------------------------------------------------------
// Searching for a domain
// ---------------------------------------------------------------------------

const searchSchema = z.object({
  name: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, 'Enter a name to search for.')
    .max(80)
    .regex(/^[a-z0-9][a-z0-9.-]*$/, 'Use letters, numbers and hyphens.'),
});

/// Prices a name against every ending on sale, and asks the registry which of
/// them are free.
///
/// The registry answer is best-effort: when no provider can check, the prices
/// still come back and the availability reads "unknown" rather than the search
/// failing. A price list is useful on its own; a broken page is not.
storeRouter.post(
  '/domain-search',
  searchLimiter,
  validate(searchSchema),
  asyncHandler(async (req, res) => {
    const [label] = req.body.name.split('.');
    if (!label) throw badRequest('Enter a name to search for.');

    const priced = await prisma.tldPrice.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { registerMinor: 'asc' }],
    });
    if (!priced.length) throw badRequest('No domain endings are on sale at the moment.');

    // Availability, if any connected provider can answer.
    const byDomain = new Map();
    const providers = await prisma.provider.findMany({ where: { isActive: true }, orderBy: { createdAt: 'asc' } });

    for (const provider of providers) {
      const adapter = getAdapter(provider.adapter);
      if (!adapter?.capabilities?.domainSearch) continue;
      try {
        const { token } = await loadProviderWithToken(provider.id);
        const results = await adapter.checkDomainAvailability(token, {
          name: label,
          tlds: priced.map((p) => p.tld),
        });
        for (const row of results) byDomain.set(row.domain, row);
        break;
      } catch {
        // Try the next one; a price list without availability still helps.
      }
    }

    // A name already in the portal is ours, so it is certainly not free.
    const names = priced.map((p) => `${label}.${p.tld}`);
    const taken = new Set(
      (await prisma.domain.findMany({ where: { name: { in: names } }, select: { name: true } })).map((d) => d.name),
    );

    res.json({
      name: label,
      checked: byDomain.size > 0,
      results: priced.map((row) => {
        const domain = `${label}.${row.tld}`;
        const found = byDomain.get(domain);
        return {
          domain,
          ...presentTld(row),
          available: taken.has(domain) ? false : found ? found.available : null,
          restriction: found?.restriction || null,
        };
      }),
    });
  }),
);

// ---------------------------------------------------------------------------
// Placing an order
// ---------------------------------------------------------------------------

const orderSchema = z.object({
  kind: z.enum(['HOSTING', 'DOMAIN']),
  planId: z.string().trim().max(40).optional(),
  tld: z.string().trim().toLowerCase().max(24).optional(),
  domainName: z
    .string()
    .trim()
    .toLowerCase()
    .max(253)
    .regex(/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'Enter a valid domain, e.g. example.com')
    .optional()
    .or(z.literal('')),

  customerName: z.string().trim().min(2, 'Please give your name.').max(120),
  customerEmail: z.string().trim().toLowerCase().email('Enter a valid email address.').max(160),
  customerPhone: z
    .string()
    .trim()
    .min(7, 'Enter a phone number we can reach you on.')
    .max(24)
    .regex(/^[+0-9][0-9\s-]*$/, 'Enter a valid phone number.'),
  message: z.string().trim().max(1000).optional(),
});

storeRouter.post(
  '/orders',
  orderLimiter,
  validate(orderSchema),
  asyncHandler(async (req, res) => {
    const config = await publicStoreConfig();
    if (!config.isOpen) {
      throw badRequest('We are not taking orders at the moment. Please message us and we will help directly.');
    }

    const body = req.body;

    // A domain order needs the name being registered; hosting does not,
    // because plenty of people buy hosting before they have picked one.
    if (body.kind === 'DOMAIN' && !body.domainName) {
      throw badRequest('Enter the domain name you want to register.');
    }
    if (body.kind === 'DOMAIN' && body.tld && !body.domainName.endsWith(`.${body.tld}`)) {
      throw badRequest('The domain name does not match the ending chosen.');
    }

    // The price. Worked out here, from the plan or the ending — whatever the
    // request said the total was is ignored entirely.
    const priced = await priceOrder({ kind: body.kind, planId: body.planId, tld: body.tld });

    const order = await prisma.order.create({
      data: {
        reference: generateReference(),
        kind: priced.kind,
        planId: priced.planId || null,
        tld: priced.tld || null,
        domainName: body.domainName || null,
        customerName: body.customerName,
        customerEmail: body.customerEmail,
        customerPhone: body.customerPhone,
        message: body.message || null,
        amountMinor: priced.amountMinor,
        currency: priced.currency,
        billingPeriod: priced.billingPeriod,
        status: 'PENDING_PAYMENT',
      },
    });

    // No actor: this is a stranger on the public site, so the alert carries
    // the contact details instead of an account.
    await record({
      event: 'order.placed',
      summary: `New order ${order.reference} — ${formatMinor(order.amountMinor, order.currency)}`,
      detail:
        `${priced.description}\n` +
        `${order.domainName ? `Domain: ${order.domainName}\n` : ''}` +
        `From: ${order.customerName} <${order.customerEmail}>, ${order.customerPhone}\n` +
        `${order.message ? `\nThey said: ${order.message}\n` : ''}` +
        '\nNothing is paid yet. Open Orders in the portal when they report a payment.',
      ip: req.ip,
    });

    res.status(201).json({
      reference: order.reference,
      description: priced.description,
      amount: formatMinor(order.amountMinor, order.currency),
      payment: await paymentDetailsFor(order),
      message: 'Order placed. Pay using the details shown, then tell us the reference.',
    });
  }),
);

const STATUS_TEXT = {
  PENDING_PAYMENT: 'Waiting for payment',
  PAYMENT_SUBMITTED: 'Payment reported — we are checking it',
  PAID: 'Payment confirmed',
  PROVISIONED: 'Set up and ready',
  CANCELLED: 'Cancelled',
};

/// An order, for the customer holding its reference.
///
/// Deliberately narrow. The reference travels in a URL and in messages, so it
/// should be assumed to leak eventually; what it opens must therefore not
/// include the customer's name, email or phone number. What is left is enough
/// to pay and to see where the order stands.
storeRouter.get(
  '/orders/:reference',
  asyncHandler(async (req, res) => {
    const order = await prisma.order.findUnique({
      where: { reference: String(req.params.reference).toUpperCase() },
      include: { plan: { select: { name: true, billingPeriod: true } } },
    });
    if (!order) throw notFound('No order with that reference.');

    res.json({
      reference: order.reference,
      kind: order.kind,
      description: order.plan
        ? `${order.plan.name} (${order.plan.billingPeriod === 'MONTHLY' ? 'monthly' : 'yearly'})`
        : order.tld
          ? `.${order.tld} domain registration (1 year)`
          : 'Order',
      domainName: order.domainName,
      amount: formatMinor(order.amountMinor, order.currency),
      status: order.status,
      statusText: STATUS_TEXT[order.status] || order.status,
      placedAt: order.createdAt,
      paymentReported: Boolean(order.paymentSubmittedAt),
      payment: ['PENDING_PAYMENT', 'PAYMENT_SUBMITTED'].includes(order.status)
        ? await paymentDetailsFor(order)
        : null,
    });
  }),
);

/// The payment QR as an image, so it can be scanned from another device.
storeRouter.get(
  '/orders/:reference/qr.svg',
  asyncHandler(async (req, res) => {
    const order = await prisma.order.findUnique({
      where: { reference: String(req.params.reference).toUpperCase() },
    });
    if (!order) throw notFound('No order with that reference.');

    const settings = await getStoreSettings();
    const link = upiLink({
      upiId: settings.upiId,
      payeeName: settings.upiPayeeName || settings.businessName,
      amountMinor: order.amountMinor,
      reference: order.reference,
      currency: order.currency,
    });
    if (!link) throw notFound('No payment method is configured.');

    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(await upiQrSvg(link));
  }),
);

/// The customer telling us they have paid, and what reference their bank gave.
///
/// This records a claim. It does not confirm anything: a UPI transfer cannot be
/// verified from here, so the order moves to "payment reported" and waits for
/// somebody to look at the bank account.
storeRouter.post(
  '/orders/:reference/payment',
  paymentLimiter,
  validate(z.object({ paymentReference: z.string().trim().min(3, 'Enter the reference your payment app gave you.').max(120) })),
  asyncHandler(async (req, res) => {
    const order = await prisma.order.findUnique({
      where: { reference: String(req.params.reference).toUpperCase() },
    });
    if (!order) throw notFound('No order with that reference.');

    if (!['PENDING_PAYMENT', 'PAYMENT_SUBMITTED'].includes(order.status)) {
      throw badRequest('This order is not waiting for payment.');
    }

    const updated = await prisma.order.update({
      where: { id: order.id },
      data: {
        paymentReference: req.body.paymentReference,
        paymentSubmittedAt: new Date(),
        status: 'PAYMENT_SUBMITTED',
      },
    });

    await record({
      event: 'order.payment.reported',
      summary: `Payment reported for ${order.reference} — ${formatMinor(order.amountMinor, order.currency)}`,
      detail:
        `Reference they gave: ${req.body.paymentReference}\n` +
        `From: ${order.customerName} <${order.customerEmail}>, ${order.customerPhone}\n\n` +
        'Nobody has checked this. Look at your account, then confirm it in the portal.',
      ip: req.ip,
    });

    res.json({
      status: updated.status,
      statusText: STATUS_TEXT[updated.status],
      message:
        'Thank you. We will check the payment against our account and confirm it — ' +
        'you can message us on WhatsApp if it is urgent.',
    });
  }),
);
