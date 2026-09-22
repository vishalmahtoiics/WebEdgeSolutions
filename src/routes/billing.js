// Quotations and invoices. Super Admin issues them; a customer may read their
// own.
//
// The read boundary is the only subtle part: a customer sees a document that
// names their account and nothing else, so changing the id in the URL returns
// a 404 rather than somebody else's prices.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth, requireAdmin, isAdmin } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler, badRequest, notFound } from '../lib/errors.js';
import { toMinor } from '../lib/money.js';
import { GST_RATES, looksLikeGstin } from '../lib/gst.js';
import { record } from '../services/notifier.js';
import {
  convertToInvoice, createDocument, emailDocument, isEditable,
  presentDocument, priceDocument, recordPayment, updateDocument,
} from '../services/billingService.js';

export const billingRouter = Router();
billingRouter.use(requireAuth);

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/// A price as typed, in rupees, turned into paise here.
///
/// `toMinor` refuses anything that is not a plain amount rather than guessing,
/// because a price that silently became NaN would be charged as zero.
const rupees = z.union([z.string(), z.number()]).transform((value, ctx) => {
  const minor = toMinor(value);
  if (minor === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter an amount like 1499 or 1499.50.' });
    return z.NEVER;
  }
  return minor;
});

const itemSchema = z.object({
  description: z.string().trim().min(1, 'Every line needs a description.').max(300),
  hsnCode: z.string().trim().max(12).optional(),
  quantity: z.coerce.number().int().min(1).max(9999).default(1),
  unitPrice: rupees,
  taxRatePct: z.coerce
    .number()
    .int()
    .refine((v) => GST_RATES.includes(v), `Use one of ${GST_RATES.join(', ')}%.`)
    .default(18),
});

const documentSchema = z.object({
  customerName: z.string().trim().min(1, 'Who is this for?').max(200),
  customerEmail: z.string().trim().toLowerCase().max(255).optional(),
  customerPhone: z.string().trim().max(30).optional(),
  customerAddress: z.string().trim().max(600).optional(),
  customerGstin: z
    .string()
    .trim()
    .toUpperCase()
    .max(15)
    .refine((v) => !v || looksLikeGstin(v), 'That does not look like a GSTIN.')
    .optional(),
  customerStateCode: z.string().trim().max(2).optional(),

  userId: z.string().trim().max(40).optional(),
  domainId: z.string().trim().max(40).optional(),
  orderId: z.string().trim().max(40).optional(),

  issueDate: z.string().trim().max(40).optional(),
  dueDate: z.string().trim().max(40).optional(),
  validUntil: z.string().trim().max(40).optional(),

  gstEnabled: z.coerce.boolean().default(true),
  pricesIncludeTax: z.coerce.boolean().default(false),
  discount: rupees.optional(),

  notes: z.string().trim().max(2000).optional(),
  terms: z.string().trim().max(2000).optional(),

  items: z.array(itemSchema).min(1, 'Add at least one line.').max(50),
});

/// The service works in paise and calls the field `unitPriceMinor`; the form
/// works in rupees and calls it `unitPrice`. One translation, here.
const toServiceInput = (body) => ({
  ...body,
  discountMinor: body.discount || 0,
  items: body.items.map((item) => ({
    description: item.description,
    hsnCode: item.hsnCode || null,
    quantity: item.quantity,
    unitPriceMinor: item.unitPrice,
    taxRatePct: item.taxRatePct,
  })),
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/// The list. A customer sees only documents issued to their account, and
/// never a draft — a draft is a thing you are still deciding.
billingRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const where = isAdmin(req.user)
      ? {}
      : { userId: req.user.id, status: { not: 'DRAFT' } };

    if (req.query.kind === 'INVOICE' || req.query.kind === 'QUOTATION') where.kind = req.query.kind;
    if (req.query.status) where.status = req.query.status;

    const documents = await prisma.billingDocument.findMany({
      where,
      orderBy: { issueDate: 'desc' },
      take: 200,
      include: {
        items: { orderBy: { sortOrder: 'asc' } },
        domain: { select: { id: true, name: true } },
      },
    });

    // What is owed, which is the number worth seeing at the top of a list.
    const outstanding = documents
      .filter((d) => d.kind === 'INVOICE' && !['PAID', 'CANCELLED'].includes(d.status))
      .reduce((sum, d) => sum + (d.totalMinor - d.amountPaidMinor), 0);

    res.json({ documents, outstandingMinor: outstanding });
  }),
);

const readable = async (user, id) => {
  const doc = await prisma.billingDocument.findUnique({
    where: { id },
    include: {
      items: { orderBy: { sortOrder: 'asc' } },
      domain: { select: { id: true, name: true } },
    },
  });
  if (!doc) return null;
  if (isAdmin(user)) return doc;
  // A customer's own, and not one that is still being drafted.
  if (doc.userId !== user.id || doc.status === 'DRAFT') return null;
  return doc;
};

billingRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const doc = await readable(req.user, req.params.id);
    if (!doc) throw notFound('That document does not exist.');
    res.json({ document: await presentDocument(doc), editable: isAdmin(req.user) && isEditable(doc) });
  }),
);

// ---------------------------------------------------------------------------
// Writing — Super Admin only
// ---------------------------------------------------------------------------

/// Works out the totals without saving anything, so the form can show the tax
/// as it is typed. The same code that prices a saved document, so what is
/// previewed is what is issued.
billingRouter.post(
  '/preview',
  requireAdmin,
  validate(documentSchema),
  asyncHandler(async (req, res) => {
    res.json({ totals: await priceDocument(toServiceInput(req.body)) });
  }),
);

const kindParam = (value) => {
  const kind = String(value || '').toUpperCase();
  if (kind !== 'INVOICE' && kind !== 'QUOTATION') throw badRequest('Unknown document type.');
  return kind;
};

billingRouter.post(
  '/:kind',
  requireAdmin,
  validate(documentSchema),
  asyncHandler(async (req, res) => {
    const kind = kindParam(req.params.kind);
    const doc = await createDocument({ kind, actor: req.user, ...toServiceInput(req.body) });

    await record({
      event: `billing.${kind.toLowerCase()}.created`,
      actor: req.user,
      summary: `${kind === 'INVOICE' ? 'Invoice' : 'Quotation'} ${doc.number} for ${doc.customerName}`,
      detail: `Total: ${(doc.totalMinor / 100).toFixed(2)} ${doc.currency}${doc.gstEnabled ? '' : ' (no GST)'}`,
    });

    res.status(201).json({ document: await presentDocument(doc) });
  }),
);

billingRouter.put(
  '/:id',
  requireAdmin,
  validate(documentSchema),
  asyncHandler(async (req, res) => {
    const doc = await updateDocument(req.params.id, toServiceInput(req.body));
    res.json({ document: await presentDocument(doc) });
  }),
);

billingRouter.post(
  '/:id/convert',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const invoice = await convertToInvoice(req.params.id, req.user);

    await record({
      event: 'billing.invoice.created',
      actor: req.user,
      summary: `Invoice ${invoice.number} raised from a quotation`,
      detail: `For ${invoice.customerName}. Total: ${(invoice.totalMinor / 100).toFixed(2)} ${invoice.currency}`,
    });

    res.status(201).json({ document: await presentDocument(invoice) });
  }),
);

const paymentSchema = z.object({
  amount: rupees,
  reference: z.string().trim().max(120).optional(),
  paidOn: z.string().trim().max(40).optional(),
});

billingRouter.post(
  '/:id/payment',
  requireAdmin,
  validate(paymentSchema),
  asyncHandler(async (req, res) => {
    const doc = await recordPayment(req.params.id, {
      amountMinor: req.body.amount,
      reference: req.body.reference,
      paidOn: req.body.paidOn,
    });

    await record({
      event: 'billing.payment.recorded',
      actor: req.user,
      summary: `Payment recorded against ${doc.number}`,
      detail:
        `${(req.body.amount / 100).toFixed(2)} ${doc.currency} received.\n` +
        `Outstanding: ${((doc.totalMinor - doc.amountPaidMinor) / 100).toFixed(2)} ${doc.currency}`,
    });

    res.json({ document: await presentDocument(doc) });
  }),
);

const sendSchema = z.object({ message: z.string().trim().max(1000).optional() });

billingRouter.post(
  '/:id/send',
  requireAdmin,
  validate(sendSchema),
  asyncHandler(async (req, res) => {
    let doc;
    try {
      doc = await emailDocument(req.params.id, { message: req.body.message });
    } catch (err) {
      // Sending is something the person is watching happen, so unlike an alert
      // this one reports its failure.
      throw badRequest(err.message);
    }
    res.json({
      document: await presentDocument(doc),
      message: `Sent to ${doc.customerEmail}.`,
    });
  }),
);

const statusSchema = z.object({
  status: z.enum(['DRAFT', 'SENT', 'ACCEPTED', 'PAID', 'CANCELLED']),
});

billingRouter.post(
  '/:id/status',
  requireAdmin,
  validate(statusSchema),
  asyncHandler(async (req, res) => {
    const existing = await prisma.billingDocument.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound('That document no longer exists.');

    // Marking something paid is a money decision; it belongs to the payment
    // endpoint, which knows how much and keeps the balance right.
    if (req.body.status === 'PAID') {
      throw badRequest('Record the payment instead, so the amount and the balance are right.');
    }

    const doc = await prisma.billingDocument.update({
      where: { id: req.params.id },
      data: {
        status: req.body.status,
        // A cancelled document keeps its number. A gap in a series is
        // ordinary; a reused number is not.
      },
      include: { items: { orderBy: { sortOrder: 'asc' } } },
    });

    if (req.body.status === 'CANCELLED') {
      await record({
        event: 'billing.document.cancelled',
        actor: req.user,
        summary: `${doc.number} cancelled`,
        detail: `Was ${(doc.totalMinor / 100).toFixed(2)} ${doc.currency} for ${doc.customerName}.`,
      });
    }

    res.json({ document: await presentDocument(doc) });
  }),
);
