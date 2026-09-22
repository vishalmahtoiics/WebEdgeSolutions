// The storefront's own logic: what something costs, what an order is called,
// and how somebody pays for it.
//
// One rule shapes this file: the price of an order is worked out here, from the
// plan or the ending being bought, and never taken from the request. A browser
// that says a ₹1,499 plan costs ₹1 is describing what it would like, not what
// it owes.

import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { prisma } from '../db.js';
import { badRequest, notFound } from '../lib/errors.js';
import { formatMinor } from '../lib/money.js';

/// An order reference is effectively a bearer token — it is the only key the
/// public lookup accepts — so it is random rather than sequential, and drawn
/// from an alphabet without the characters people misread when reading one out
/// over the phone. Both halves of each confusable pair are gone: O and 0, I
/// and 1, S and 5. Thirty characters over ten places is still around 49 bits,
/// which is not guessable.
const ALPHABET = '2346789ABCDEFGHJKLMNPQRTUVWXYZ';

export function generateReference(prefix = 'WES') {
  const bytes = crypto.randomBytes(10);
  let out = '';
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  // 10 characters from a 31-character alphabet is around 50 bits: not
  // guessable, and still short enough to type.
  return `${prefix}-${out.slice(0, 5)}-${out.slice(5)}`;
}

/// The single settings row, created empty the first time it is asked for so the
/// admin page has something to edit.
export async function getStoreSettings() {
  return prisma.storeSettings.upsert({
    where: { id: 'default' },
    create: { id: 'default' },
    update: {},
  });
}

/// What the store shows a visitor about itself. Deliberately narrow: the public
/// site needs to know whether it can take an order and how to reach you, and
/// nothing else about the installation.
export async function publicStoreConfig() {
  const settings = await getStoreSettings();
  return {
    businessName: settings.businessName || 'Web Hosting',
    headline: settings.headline || 'Hosting and domains, looked after properly',
    subheadline: settings.subheadline || 'Pick a plan, or search for a domain name.',
    supportEmail: settings.supportEmail || null,
    whatsappNumber: settings.whatsappNumber || null,
    currency: settings.currency || 'INR',
    isOpen: settings.isOpen,
    // Whether payment can be shown at all. The UPI id itself is only sent with
    // an order, so it appears where it is needed rather than on every page.
    canAcceptPayment: Boolean(settings.upiId),
  };
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/// The price of a hosting order, read from the plan.
async function priceHosting(planId) {
  const plan = await prisma.plan.findUnique({ where: { id: planId } });
  if (!plan) throw notFound('That plan is no longer available.');
  if (!plan.isActive) throw badRequest('That plan is no longer on sale.');

  return {
    kind: 'HOSTING',
    planId: plan.id,
    amountMinor: plan.priceMinor,
    currency: plan.currency,
    billingPeriod: plan.billingPeriod,
    description: `${plan.name} (${plan.billingPeriod === 'MONTHLY' ? 'monthly' : 'yearly'})`,
  };
}

/// The price of a domain order, read from the ending's own row.
async function priceDomain(tld) {
  const ending = String(tld || '').replace(/^\./, '').toLowerCase();
  const row = await prisma.tldPrice.findUnique({ where: { tld: ending } });
  if (!row) throw notFound(`We do not sell .${ending} domains.`);
  if (!row.isActive) throw badRequest(`.${ending} domains are not on sale at the moment.`);

  return {
    kind: 'DOMAIN',
    tld: row.tld,
    amountMinor: row.registerMinor,
    currency: row.currency,
    billingPeriod: 'YEARLY',
    description: `.${row.tld} domain registration (1 year)`,
  };
}

/// Works out what an order costs. The caller passes what was chosen; the price
/// comes from the database.
export async function priceOrder({ kind, planId, tld }) {
  if (kind === 'HOSTING') {
    if (!planId) throw badRequest('Choose a plan.');
    return priceHosting(planId);
  }
  if (kind === 'DOMAIN') {
    if (!tld) throw badRequest('Choose a domain ending.');
    return priceDomain(tld);
  }
  throw badRequest('Unknown order type.');
}

// ---------------------------------------------------------------------------
// Paying
// ---------------------------------------------------------------------------

/// The `upi://pay` link every Indian payment app understands. Tapping it on a
/// phone opens GPay, PhonePe or whichever app is installed, with the amount and
/// the reference already filled in — which is what stops a customer typing the
/// wrong amount or forgetting to mention their order.
export function upiLink({ upiId, payeeName, amountMinor, reference, currency = 'INR' }) {
  if (!upiId) return null;

  const params = new URLSearchParams({
    pa: upiId,
    pn: payeeName || 'Hosting',
    // The UPI spec wants a plain decimal in major units.
    am: (amountMinor / 100).toFixed(2),
    cu: currency,
    tn: `Order ${reference}`,
    tr: reference.replace(/-/g, ''),
  });
  return `upi://pay?${params.toString()}`;
}

/// The same link as a QR code, for paying from a different device than the one
/// showing the page.
export async function upiQrSvg(link) {
  if (!link) return null;
  return QRCode.toString(link, {
    type: 'svg',
    margin: 1,
    errorCorrectionLevel: 'M',
    color: { dark: '#17203a', light: '#ffffff' },
  });
}

/// A wa.me link with the message already written, so a customer reaches you
/// with their order reference rather than "hi".
export function whatsappLink(number, text) {
  const digits = String(number || '').replace(/\D/g, '');
  if (!digits) return null;
  return `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}

/// Everything a customer needs in order to pay, gathered in one place.
export async function paymentDetailsFor(order) {
  const settings = await getStoreSettings();
  const link = upiLink({
    upiId: settings.upiId,
    payeeName: settings.upiPayeeName || settings.businessName,
    amountMinor: order.amountMinor,
    reference: order.reference,
    currency: order.currency,
  });

  return {
    upiId: settings.upiId || null,
    payeeName: settings.upiPayeeName || settings.businessName || null,
    amount: formatMinor(order.amountMinor, order.currency),
    upiLink: link,
    whatsappLink: whatsappLink(
      settings.whatsappNumber,
      `Hi, I have placed order ${order.reference} for ${order.domainName || 'hosting'}.`,
    ),
    supportEmail: settings.supportEmail || null,
    // Said plainly, because it is the part people assume works the other way:
    // a UPI transfer cannot confirm itself back to this site.
    verificationNote:
      'Payments are checked by hand. Once you have paid, send us the reference and we will confirm it — ' +
      'usually within a few hours during business hours.',
  };
}
