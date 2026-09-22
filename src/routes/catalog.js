// What is for sale, and who is selling it. Super Admin only.
//
// Plans and domain prices are ordinary records; the storefront settings are one
// row. The one field worth being careful about is the UPI id, because it
// decides who receives money — so it is Super Admin only like everything here,
// and a change to it is not something a normal user can reach at all.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler, badRequest, notFound } from '../lib/errors.js';
import { toMinor, formatMinor } from '../lib/money.js';
import { getStoreSettings, whatsappLink, upiLink } from '../services/storeService.js';

export const catalogRouter = Router();
catalogRouter.use(requireAuth, requireAdmin);

/// Rupees in, paise out. A price that cannot be read is refused rather than
/// stored as zero.
const price = (label, { required = true } = {}) =>
  z.union([z.string(), z.number()]).optional().transform((value, ctx) => {
    if (value === undefined || value === '' || value === null) {
      if (required) ctx.addIssue({ code: 'custom', message: `${label} is required.` });
      return null;
    }
    const minor = toMinor(value);
    if (minor === null) {
      ctx.addIssue({ code: 'custom', message: `${label} should be an amount, e.g. 1499 or 1499.50.` });
      return null;
    }
    return minor;
  });

const slugify = (value) =>
  String(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

const withPrices = (plan) => ({
  ...plan,
  price: formatMinor(plan.priceMinor, plan.currency),
  wasPrice: plan.wasPriceMinor ? formatMinor(plan.wasPriceMinor, plan.currency) : null,
});

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

const planSchema = z.object({
  name: z.string().trim().min(2, 'Give the plan a name.').max(80),
  slug: z.string().trim().max(60).optional(),
  kind: z.enum(['HOSTING', 'EMAIL', 'OTHER']).optional(),
  tagline: z.string().trim().max(160).optional(),
  price: price('Price'),
  wasPrice: price('Was price', { required: false }),
  billingPeriod: z.enum(['MONTHLY', 'YEARLY']).optional(),
  features: z.array(z.string().trim().max(160)).max(30).optional(),
  isActive: z.coerce.boolean().optional(),
  isFeatured: z.coerce.boolean().optional(),
  sortOrder: z.coerce.number().int().min(0).max(9999).optional(),
});

catalogRouter.get(
  '/plans',
  asyncHandler(async (_req, res) => {
    const plans = await prisma.plan.findMany({
      orderBy: [{ sortOrder: 'asc' }, { priceMinor: 'asc' }],
      include: { _count: { select: { orders: true } } },
    });
    res.json({ plans: plans.map((p) => ({ ...withPrices(p), orderCount: p._count.orders })) });
  }),
);

const planData = (body) => ({
  name: body.name,
  kind: body.kind || 'HOSTING',
  tagline: body.tagline || null,
  priceMinor: body.price,
  wasPriceMinor: body.wasPrice ?? null,
  billingPeriod: body.billingPeriod || 'YEARLY',
  // Blank lines are what a textarea leaves behind, not selling points.
  features: (body.features || []).map((f) => f.trim()).filter(Boolean),
  isActive: body.isActive ?? true,
  isFeatured: body.isFeatured ?? false,
  sortOrder: body.sortOrder ?? 0,
});

catalogRouter.post(
  '/plans',
  validate(planSchema),
  asyncHandler(async (req, res) => {
    const slug = slugify(req.body.slug || req.body.name);
    if (!slug) throw badRequest('That name cannot be turned into a URL. Add some letters or numbers.');

    const clash = await prisma.plan.findUnique({ where: { slug } });
    if (clash) throw badRequest(`A plan with the URL "${slug}" already exists.`);

    const plan = await prisma.plan.create({ data: { slug, ...planData(req.body) } });
    res.status(201).json({ plan: withPrices(plan) });
  }),
);

catalogRouter.put(
  '/plans/:id',
  validate(planSchema),
  asyncHandler(async (req, res) => {
    const existing = await prisma.plan.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound('Plan not found.');

    // The slug only moves when asked: it is in URLs people may have shared.
    const slug = req.body.slug ? slugify(req.body.slug) : existing.slug;
    if (slug !== existing.slug) {
      const clash = await prisma.plan.findUnique({ where: { slug } });
      if (clash) throw badRequest(`A plan with the URL "${slug}" already exists.`);
    }

    const plan = await prisma.plan.update({
      where: { id: existing.id },
      data: { slug, ...planData(req.body) },
    });
    res.json({ plan: withPrices(plan) });
  }),
);

/// Deletes a plan, or refuses when orders name it.
///
/// An order has to keep saying what was bought, so a plan with orders against
/// it is hidden rather than removed.
catalogRouter.delete(
  '/plans/:id',
  asyncHandler(async (req, res) => {
    const plan = await prisma.plan.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { orders: true } } },
    });
    if (!plan) throw notFound('Plan not found.');

    if (plan._count.orders > 0) {
      await prisma.plan.update({ where: { id: plan.id }, data: { isActive: false } });
      return res.json({
        ok: true,
        hidden: true,
        message: `${plan._count.orders} order${plan._count.orders === 1 ? '' : 's'} name this plan, so it has been hidden from the site rather than deleted.`,
      });
    }

    await prisma.plan.delete({ where: { id: plan.id } });
    res.json({ ok: true, hidden: false, message: 'Plan deleted.' });
  }),
);

// ---------------------------------------------------------------------------
// Domain prices
// ---------------------------------------------------------------------------

const tldSchema = z.object({
  tld: z
    .string()
    .trim()
    .toLowerCase()
    .min(2, 'Enter a domain ending, e.g. com')
    .max(24)
    // Accepts "com" or ".com", and multi-part endings like "co.in".
    .transform((v) => v.replace(/^\./, ''))
    .refine((v) => /^[a-z0-9]+(\.[a-z0-9]+)*$/.test(v), 'Use letters and numbers, e.g. com or co.in'),
  register: price('Registration price'),
  renew: price('Renewal price', { required: false }),
  isActive: z.coerce.boolean().optional(),
  isPopular: z.coerce.boolean().optional(),
  sortOrder: z.coerce.number().int().min(0).max(9999).optional(),
});

const withTldPrices = (row) => ({
  ...row,
  register: formatMinor(row.registerMinor, row.currency),
  renew: row.renewMinor ? formatMinor(row.renewMinor, row.currency) : null,
});

catalogRouter.get(
  '/tld-prices',
  asyncHandler(async (_req, res) => {
    const tlds = await prisma.tldPrice.findMany({ orderBy: [{ sortOrder: 'asc' }, { tld: 'asc' }] });
    res.json({ tlds: tlds.map(withTldPrices) });
  }),
);

const tldData = (body) => ({
  registerMinor: body.register,
  renewMinor: body.renew ?? null,
  isActive: body.isActive ?? true,
  isPopular: body.isPopular ?? false,
  sortOrder: body.sortOrder ?? 0,
});

/// Creates or updates an ending's price in one call, keyed on the ending
/// itself — there is only ever one price for .com, so there is nothing to
/// duplicate.
catalogRouter.put(
  '/tld-prices',
  validate(tldSchema),
  asyncHandler(async (req, res) => {
    const row = await prisma.tldPrice.upsert({
      where: { tld: req.body.tld },
      create: { tld: req.body.tld, ...tldData(req.body) },
      update: tldData(req.body),
    });
    res.json({ tld: withTldPrices(row) });
  }),
);

catalogRouter.delete(
  '/tld-prices/:tld',
  asyncHandler(async (req, res) => {
    const tld = String(req.params.tld).replace(/^\./, '').toLowerCase();
    const existing = await prisma.tldPrice.findUnique({ where: { tld } });
    if (!existing) throw notFound('That ending is not priced.');

    await prisma.tldPrice.delete({ where: { tld } });
    res.json({ ok: true, message: `.${tld} removed from the price list.` });
  }),
);

// ---------------------------------------------------------------------------
// Storefront settings
// ---------------------------------------------------------------------------

const settingsSchema = z.object({
  businessName: z.string().trim().max(120).optional(),
  headline: z.string().trim().max(200).optional(),
  subheadline: z.string().trim().max(300).optional(),
  supportEmail: z.string().trim().toLowerCase().email('Enter a valid email address.').max(160).or(z.literal('')).optional(),
  // A UPI id looks like name@bank. Checked loosely rather than strictly,
  // because handle formats vary between banks and a false rejection here
  // stops the shop taking money.
  upiId: z
    .string()
    .trim()
    .max(120)
    .refine((v) => v === '' || /^[\w.\-]{2,}@[a-z]{2,}$/i.test(v), 'A UPI ID looks like yourname@bank.')
    .optional(),
  upiPayeeName: z.string().trim().max(120).optional(),
  whatsappNumber: z
    .string()
    .trim()
    .max(24)
    .refine((v) => v === '' || /^\+?[0-9\s-]{7,}$/.test(v), 'Enter the number with its country code, e.g. +91 98765 43210.')
    .optional(),
  isOpen: z.coerce.boolean().optional(),
});

const presentSettings = (settings) => ({
  ...settings,
  // Shown so the admin can see what a customer will see before anyone pays.
  whatsappLink: whatsappLink(settings.whatsappNumber, 'Hi, I have a question about hosting.'),
  upiPreview: settings.upiId
    ? upiLink({
        upiId: settings.upiId,
        payeeName: settings.upiPayeeName || settings.businessName,
        amountMinor: 100000,
        reference: 'WES-PREVIEW',
        currency: settings.currency,
      })
    : null,
});

catalogRouter.get(
  '/store-settings',
  asyncHandler(async (_req, res) => {
    res.json({ settings: presentSettings(await getStoreSettings()) });
  }),
);

catalogRouter.put(
  '/store-settings',
  validate(settingsSchema),
  asyncHandler(async (req, res) => {
    const data = Object.fromEntries(
      Object.entries(req.body).map(([key, value]) => [key, value === '' ? null : value]),
    );

    const settings = await prisma.storeSettings.upsert({
      where: { id: 'default' },
      create: { id: 'default', ...data },
      update: data,
    });

    res.json({
      settings: presentSettings(settings),
      message: settings.upiId
        ? 'Storefront settings saved.'
        : 'Saved. Add a UPI ID before the store can ask anyone to pay.',
    });
  }),
);
