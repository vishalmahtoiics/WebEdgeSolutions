// Quotations and invoices.
//
// A quotation is an offer and an invoice is a demand, and the difference
// matters more than it looks: a quotation can be edited until it is accepted,
// an invoice that has been issued cannot. So the two share a table, a
// numbering scheme and all of the arithmetic, and differ in exactly the places
// where the law differs.
//
// Two things here are not conveniences, and changing them would break
// something real:
//
//   A number, once allocated, is never reused — not even by a cancelled
//   document. A gap in an invoice series is ordinary; a repeat is a problem
//   at assessment time.
//
//   The customer's details and your own are copied onto the document, not
//   read through a relation. An invoice has to say what it said on the day it
//   was issued, and an address that changes next year must not silently
//   rewrite it.

import crypto from 'node:crypto';
import { prisma } from '../db.js';
import { HttpError } from '../lib/errors.js';
import { formatMinor } from '../lib/money.js';
import {
  computeTotals, financialYear, formatNumber, isInterState,
  normaliseStateCode, stateCodeFromGstin, amountInWords,
} from '../lib/gst.js';
import { getStoreSettings } from './storeService.js';
import { sendDirect } from './mailer.js';

/// Documents a quotation may still be edited in. Once it has gone out as an
/// invoice the figures are fixed; correcting one is a credit note and a new
/// invoice, which is a bigger feature than this and deliberately not faked.
const EDITABLE = new Set(['DRAFT']);

export const isEditable = (doc) =>
  doc.kind === 'QUOTATION' ? doc.status !== 'CANCELLED' : EDITABLE.has(doc.status);

// ---------------------------------------------------------------------------
// Numbering
// ---------------------------------------------------------------------------

/// Takes the next number in a series.
///
/// The increment is a single atomic UPDATE, so two documents created in the
/// same instant get different numbers. Reading a maximum and adding one would
/// hand both the same one, and the unique index would then reject a real
/// document because of a race nobody could reproduce.
async function allocateNumber(kind, series, prefix) {
  await prisma.documentCounter.upsert({
    where: { kind_series: { kind, series } },
    create: { kind, series, nextNumber: 1 },
    update: {},
  });

  const row = await prisma.documentCounter.update({
    where: { kind_series: { kind, series } },
    data: { nextNumber: { increment: 1 } },
  });

  // The row now holds the *next* one, so mine is the one before it.
  return formatNumber(prefix, series, row.nextNumber - 1);
}

// ---------------------------------------------------------------------------
// Creating and editing
// ---------------------------------------------------------------------------

/// Everything a document needs that comes from your own settings.
async function sellerContext() {
  const store = await getStoreSettings();
  return {
    store,
    sellerGstin: store.gstin || null,
    sellerStateCode: normaliseStateCode(store.stateCode),
  };
}

/// Works out the figures, given what the caller asked for and who is selling.
///
/// Split out so the same arithmetic can be shown live in the browser through
/// a preview endpoint, and so the totals on a saved document are produced by
/// exactly the code that produced the preview.
export async function priceDocument(input) {
  const { sellerGstin, sellerStateCode } = await sellerContext();

  // A customer's own GSTIN says which state they are in, so it fills this in
  // rather than asking twice and risking the two disagreeing.
  const customerStateCode =
    normaliseStateCode(input.customerStateCode) || stateCodeFromGstin(input.customerGstin);

  // No GSTIN of your own means nothing to charge tax under. Silently issuing a
  // tax invoice in that state would be worse than refusing to.
  const gstEnabled = Boolean(input.gstEnabled) && Boolean(sellerGstin);
  const interState = gstEnabled && isInterState(sellerStateCode, customerStateCode);

  const totals = computeTotals({
    items: input.items,
    gstEnabled,
    interState,
    pricesIncludeTax: Boolean(input.pricesIncludeTax),
    discountMinor: input.discountMinor || 0,
  });

  return {
    ...totals,
    gstEnabled,
    interState,
    sellerGstin,
    sellerStateCode,
    customerStateCode,
    /// Why tax is or is not on this document, in a sentence, so the person
    /// filling the form is not left guessing.
    taxNote: gstEnabled
      ? interState
        ? `IGST, because ${customerStateCode} is a different state from ${sellerStateCode}.`
        : `CGST + SGST, because this is within state ${sellerStateCode}.`
      : Boolean(input.gstEnabled) && !sellerGstin
        ? 'No GST: add your own GSTIN under Plans & Pricing → Business details first.'
        : 'No GST on this document — it will be issued as a bill of supply.',
    amountInWords: amountInWords(totals.totalMinor),
  };
}

export async function createDocument({ kind, actor, ...input }) {
  const priced = await priceDocument(input);
  const { store } = await sellerContext();

  const issueDate = input.issueDate ? new Date(input.issueDate) : new Date();
  const series = financialYear(issueDate);
  const prefix = kind === 'INVOICE' ? store.invoicePrefix || 'INV' : store.quotationPrefix || 'QTN';
  const number = await allocateNumber(kind, series, prefix);

  const validUntil =
    kind === 'QUOTATION'
      ? input.validUntil
        ? new Date(input.validUntil)
        : new Date(issueDate.getTime() + (store.quotationValidDays || 15) * 86400000)
      : null;

  return prisma.billingDocument.create({
    data: {
      kind,
      number,
      series,
      status: 'DRAFT',

      customerName: input.customerName,
      customerEmail: input.customerEmail || null,
      customerPhone: input.customerPhone || null,
      customerAddress: input.customerAddress || null,
      customerGstin: input.customerGstin || null,
      customerStateCode: priced.customerStateCode,

      userId: input.userId || null,
      domainId: input.domainId || null,
      orderId: input.orderId || null,

      issueDate,
      dueDate: input.dueDate ? new Date(input.dueDate) : null,
      validUntil,

      gstEnabled: priced.gstEnabled,
      sellerGstin: priced.sellerGstin,
      sellerStateCode: priced.sellerStateCode,
      isInterState: priced.interState,
      pricesIncludeTax: Boolean(input.pricesIncludeTax),

      subtotalMinor: priced.subtotalMinor,
      discountMinor: priced.discountMinor,
      taxableMinor: priced.taxableMinor,
      cgstMinor: priced.cgstMinor,
      sgstMinor: priced.sgstMinor,
      igstMinor: priced.igstMinor,
      totalMinor: priced.totalMinor,

      notes: input.notes || null,
      terms:
        input.terms ||
        (kind === 'INVOICE' ? store.invoiceTerms : store.quotationTerms) ||
        null,

      createdById: actor?.id || null,
      items: { create: priced.items.map(toItemRow) },
    },
    include: { items: { orderBy: { sortOrder: 'asc' } } },
  });
}

const toItemRow = (item) => ({
  description: item.description,
  hsnCode: item.hsnCode || null,
  quantity: item.quantity,
  unitPriceMinor: item.unitPriceMinor,
  taxRatePct: item.taxRatePct,
  lineSubtotalMinor: item.lineSubtotalMinor,
  lineDiscountMinor: item.lineDiscountMinor,
  lineTaxableMinor: item.lineTaxableMinor,
  lineTaxMinor: item.lineTaxMinor,
  lineTotalMinor: item.lineTotalMinor,
  sortOrder: item.sortOrder,
});

/// Replaces a document's contents, keeping its number.
///
/// The number is what a customer quotes back at you, so editing must never
/// change it — and an issued invoice cannot be edited at all.
export async function updateDocument(id, input) {
  const existing = await prisma.billingDocument.findUnique({ where: { id } });
  if (!existing) throw new HttpError(404, 'That document no longer exists.');
  if (!isEditable(existing)) {
    throw new HttpError(
      400,
      existing.kind === 'INVOICE'
        ? `${existing.number} has already been issued, so its figures are fixed. Cancel it and raise a new one if it is wrong.`
        : `${existing.number} has been cancelled.`,
    );
  }

  const priced = await priceDocument(input);

  // Items are replaced wholesale rather than matched up: an edit is a new set
  // of lines, and trying to guess which old line became which new one is how
  // a total ends up disagreeing with the lines above it.
  await prisma.billingItem.deleteMany({ where: { documentId: id } });

  return prisma.billingDocument.update({
    where: { id },
    data: {
      customerName: input.customerName,
      customerEmail: input.customerEmail || null,
      customerPhone: input.customerPhone || null,
      customerAddress: input.customerAddress || null,
      customerGstin: input.customerGstin || null,
      customerStateCode: priced.customerStateCode,

      userId: input.userId || null,
      domainId: input.domainId || null,

      issueDate: input.issueDate ? new Date(input.issueDate) : existing.issueDate,
      dueDate: input.dueDate ? new Date(input.dueDate) : null,
      validUntil: input.validUntil ? new Date(input.validUntil) : existing.validUntil,

      gstEnabled: priced.gstEnabled,
      sellerGstin: priced.sellerGstin,
      sellerStateCode: priced.sellerStateCode,
      isInterState: priced.interState,
      pricesIncludeTax: Boolean(input.pricesIncludeTax),

      subtotalMinor: priced.subtotalMinor,
      discountMinor: priced.discountMinor,
      taxableMinor: priced.taxableMinor,
      cgstMinor: priced.cgstMinor,
      sgstMinor: priced.sgstMinor,
      igstMinor: priced.igstMinor,
      totalMinor: priced.totalMinor,

      notes: input.notes || null,
      terms: input.terms || null,

      items: { create: priced.items.map(toItemRow) },
    },
    include: { items: { orderBy: { sortOrder: 'asc' } } },
  });
}

/// Turns an accepted quotation into an invoice.
///
/// The quotation is left exactly as it was quoted and the two point at each
/// other. Copying rather than converting in place is the point: what you
/// offered and what you billed are separate facts, and an argument about a
/// price is settled by being able to show both.
export async function convertToInvoice(quotationId, actor) {
  const quotation = await prisma.billingDocument.findUnique({
    where: { id: quotationId },
    include: { items: { orderBy: { sortOrder: 'asc' } } },
  });

  if (!quotation) throw new HttpError(404, 'That quotation no longer exists.');
  if (quotation.kind !== 'QUOTATION') throw new HttpError(400, 'That is already an invoice.');
  if (quotation.convertedToId) {
    throw new HttpError(400, 'This quotation has already been turned into an invoice.');
  }
  if (quotation.status === 'CANCELLED') {
    throw new HttpError(400, 'This quotation was cancelled.');
  }

  const invoice = await createDocument({
    kind: 'INVOICE',
    actor,
    customerName: quotation.customerName,
    customerEmail: quotation.customerEmail,
    customerPhone: quotation.customerPhone,
    customerAddress: quotation.customerAddress,
    customerGstin: quotation.customerGstin,
    customerStateCode: quotation.customerStateCode,
    userId: quotation.userId,
    domainId: quotation.domainId,
    orderId: quotation.orderId,
    gstEnabled: quotation.gstEnabled,
    pricesIncludeTax: quotation.pricesIncludeTax,
    discountMinor: quotation.discountMinor,
    notes: quotation.notes,
    items: quotation.items.map((i) => ({
      description: i.description,
      hsnCode: i.hsnCode,
      quantity: i.quantity,
      unitPriceMinor: i.unitPriceMinor,
      taxRatePct: i.taxRatePct,
    })),
  });

  const [, linked] = await prisma.$transaction([
    prisma.billingDocument.update({
      where: { id: quotation.id },
      data: { convertedToId: invoice.id, status: 'ACCEPTED' },
    }),
    prisma.billingDocument.update({
      where: { id: invoice.id },
      data: { convertedFromId: quotation.id },
      include: { items: { orderBy: { sortOrder: 'asc' } } },
    }),
  ]);

  // The linked row, not the one from before the transaction: the caller needs
  // the invoice as it now is, with its pointer back to the quotation.
  return linked;
}

/// Records money against an invoice.
///
/// Partial payments add up rather than replacing each other, and the status
/// only becomes PAID once the whole amount is there — an invoice marked paid
/// on a part payment is how a balance gets forgotten.
export async function recordPayment(id, { amountMinor, reference, paidOn }) {
  const doc = await prisma.billingDocument.findUnique({ where: { id } });
  if (!doc) throw new HttpError(404, 'That document no longer exists.');
  if (doc.kind !== 'INVOICE') throw new HttpError(400, 'Only an invoice can be paid.');
  if (doc.status === 'CANCELLED') throw new HttpError(400, 'That invoice was cancelled.');

  const paid = doc.amountPaidMinor + Math.max(0, Math.trunc(amountMinor));
  if (paid > doc.totalMinor) {
    throw new HttpError(
      400,
      `That is more than the ${formatMinor(doc.totalMinor - doc.amountPaidMinor)} still outstanding on ${doc.number}.`,
    );
  }

  const settled = paid >= doc.totalMinor;

  return prisma.billingDocument.update({
    where: { id },
    data: {
      amountPaidMinor: paid,
      status: settled ? 'PAID' : doc.status === 'DRAFT' ? 'SENT' : doc.status,
      paidOn: settled ? (paidOn ? new Date(paidOn) : new Date()) : doc.paidOn,
      paymentReference: reference || doc.paymentReference,
    },
    include: { items: { orderBy: { sortOrder: 'asc' } } },
  });
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/// Emails the document to the customer, as text.
///
/// Plain text rather than an attached PDF, and the reason is worth being
/// honest about: nothing here generates a PDF. The portal renders a printable
/// page instead, which the browser saves as one. Claiming an attachment and
/// sending a text body would be the kind of small lie that costs trust the
/// first time somebody looks.
export async function emailDocument(id, { message } = {}) {
  const doc = await prisma.billingDocument.findUnique({
    where: { id },
    include: { items: { orderBy: { sortOrder: 'asc' } } },
  });
  if (!doc) throw new HttpError(404, 'That document no longer exists.');
  if (!doc.customerEmail) throw new HttpError(400, 'This document has no customer email address on it.');

  const store = await getStoreSettings();
  await sendDirect({
    to: doc.customerEmail,
    subject: `${doc.kind === 'INVOICE' ? 'Invoice' : 'Quotation'} ${doc.number} — ${formatMinor(doc.totalMinor)}`,
    text: renderPlainText(doc, store, message),
    replyTo: store.supportEmail || undefined,
  });

  return prisma.billingDocument.update({
    where: { id },
    data: { sentOn: new Date(), status: doc.status === 'DRAFT' ? 'SENT' : doc.status },
    include: { items: { orderBy: { sortOrder: 'asc' } } },
  });
}

/// The document as text, laid out so it is readable in a mail client that
/// does not use a fixed-width font either.
function renderPlainText(doc, store, message) {
  const rupees = (m) => formatMinor(m, doc.currency);
  const title = doc.kind === 'INVOICE' ? 'INVOICE' : 'QUOTATION';

  const lines = [
    message ? `${message}\n` : null,
    `${title} ${doc.number}`,
    `Date: ${new Date(doc.issueDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}`,
    doc.dueDate ? `Due: ${new Date(doc.dueDate).toLocaleDateString('en-IN')}` : null,
    doc.validUntil ? `Valid until: ${new Date(doc.validUntil).toLocaleDateString('en-IN')}` : null,
    '',
    `From: ${store.legalName || store.businessName || 'Us'}`,
    store.gstin ? `GSTIN: ${store.gstin}` : null,
    '',
    `To: ${doc.customerName}`,
    doc.customerGstin ? `GSTIN: ${doc.customerGstin}` : null,
    '',
    '—'.repeat(40),
  ];

  for (const item of doc.items) {
    lines.push(
      `${item.description}`,
      `  ${item.quantity} × ${rupees(item.unitPriceMinor)}` +
        (doc.gstEnabled && item.taxRatePct ? `  (GST ${item.taxRatePct}%)` : '') +
        `   ${rupees(item.lineTotalMinor)}`,
    );
  }

  lines.push(
    '—'.repeat(40),
    `Subtotal:${' '.repeat(6)}${rupees(doc.subtotalMinor)}`,
    doc.discountMinor ? `Discount:${' '.repeat(6)}−${rupees(doc.discountMinor)}` : null,
    doc.cgstMinor ? `CGST:${' '.repeat(10)}${rupees(doc.cgstMinor)}` : null,
    doc.sgstMinor ? `SGST:${' '.repeat(10)}${rupees(doc.sgstMinor)}` : null,
    doc.igstMinor ? `IGST:${' '.repeat(10)}${rupees(doc.igstMinor)}` : null,
    `TOTAL:${' '.repeat(9)}${rupees(doc.totalMinor)}`,
    `(${amountInWords(doc.totalMinor, doc.currency)})`,
    '',
  );

  if (doc.kind === 'INVOICE' && doc.amountPaidMinor) {
    lines.push(
      `Paid:${' '.repeat(10)}${rupees(doc.amountPaidMinor)}`,
      `Outstanding:${' '.repeat(3)}${rupees(doc.totalMinor - doc.amountPaidMinor)}`,
      '',
    );
  }

  if (doc.kind === 'INVOICE' && doc.status !== 'PAID') {
    if (store.upiId) lines.push(`Pay by UPI: ${store.upiId}`);
    if (store.bankAccount) {
      lines.push(
        `Bank transfer: ${store.bankName || ''} ${store.bankAccount}`.trim(),
        store.bankIfsc ? `IFSC: ${store.bankIfsc}` : null,
      );
    }
    lines.push('');
  }

  if (doc.notes) lines.push(doc.notes, '');
  if (doc.terms) lines.push('Terms:', doc.terms, '');
  if (!doc.gstEnabled) {
    lines.push('This is a bill of supply. No GST has been charged on it.', '');
  }

  return lines.filter((l) => l !== null).join('\n');
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/// A document with everything the printable page needs, including the
/// seller's details as they are now.
export async function presentDocument(doc) {
  const store = await getStoreSettings();
  return {
    ...doc,
    amountInWords: amountInWords(doc.totalMinor, doc.currency),
    outstandingMinor: doc.totalMinor - doc.amountPaidMinor,
    /// The tax summary table a GST invoice is required to carry, rebuilt from
    /// the stored lines rather than recomputed from prices — what is on the
    /// document is what was issued.
    rateBreakdown: summariseStored(doc),
    seller: {
      name: store.legalName || store.businessName || null,
      addressLine1: store.addressLine1,
      addressLine2: store.addressLine2,
      city: store.city,
      stateName: store.stateName,
      stateCode: store.stateCode,
      pincode: store.pincode,
      gstin: store.gstin,
      pan: store.pan,
      email: store.supportEmail,
      phone: store.whatsappNumber,
      upiId: store.upiId,
      bankName: store.bankName,
      bankAccount: store.bankAccount,
      bankIfsc: store.bankIfsc,
      bankBranch: store.bankBranch,
    },
  };
}

function summariseStored(doc) {
  if (!doc.gstEnabled) return [];
  const byRate = new Map();
  for (const item of doc.items || []) {
    const row = byRate.get(item.taxRatePct) || {
      taxRatePct: item.taxRatePct,
      taxableMinor: 0,
      cgstMinor: 0,
      sgstMinor: 0,
      igstMinor: 0,
    };
    row.taxableMinor += item.lineTaxableMinor;
    if (doc.isInterState) {
      row.igstMinor += item.lineTaxMinor;
    } else {
      const half = Math.floor(item.lineTaxMinor / 2);
      row.cgstMinor += half;
      row.sgstMinor += item.lineTaxMinor - half;
    }
    byRate.set(item.taxRatePct, row);
  }
  return [...byRate.values()].sort((a, b) => a.taxRatePct - b.taxRatePct);
}

/// A short token for the customer-facing link, if one is ever wanted. Kept
/// here so the shape matches the order reference the storefront already uses.
export const shortRef = () =>
  [...crypto.randomBytes(6)].map((b) => '2346789ABCDEFGHJKLMNPQRTUVWXYZ'[b % 30]).join('');
