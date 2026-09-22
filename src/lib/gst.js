// Indian GST, worked out in whole paise.
//
// An invoice is a legal document and the arithmetic on it has to reconcile
// exactly: the lines must add to the subtotal, the tax must add to the tax
// total, and the whole thing must add to the figure somebody is asked to pay.
// Floating point cannot promise that — 18% of ₹1,499 is not representable in
// binary — so every value here is an integer number of paise and every
// division rounds explicitly.
//
// Three rules are worth stating because getting any of them wrong produces an
// invoice that is quietly, legally wrong:
//
//   Within one state the tax splits into CGST and SGST, half each. Across
//   states it is a single IGST line at the full rate. The decision is made
//   from the two state codes and nothing else.
//
//   A tax-inclusive price has to be worked backwards, not multiplied: at 18%
//   the taxable value of ₹118 is ₹100, which is 118 × 100/118, not 118 × 0.82.
//
//   A discount is applied before tax and has to be split across the lines in
//   amounts that add back to exactly the discount, because each line is taxed
//   at its own rate.

import { HttpError } from './errors.js';

/// Postgres INTEGER, which is what every money column here is. A document that
/// would exceed it is refused rather than silently wrapping into a negative
/// amount on somebody's bill.
const MAX_MINOR = 2 ** 31 - 1;

/// The rates GST actually uses. Anything else is a typing mistake, and a
/// mistake in this field is a mistake on a filed return.
export const GST_RATES = [0, 5, 12, 18, 28];

export const isValidRate = (pct) => GST_RATES.includes(Number(pct));

/// Rounds a positive rational to the nearest paisa, halves upward.
///
/// Written out rather than using Math.round on a quotient: the quotient is a
/// float, and the whole point here is not to go through one.
function divideRound(numerator, denominator) {
  return Math.floor((numerator * 2 + denominator) / (denominator * 2));
}

/// Splits `amount` across `weights` so the parts add to exactly `amount`.
///
/// Largest remainder: everyone gets their floor, and the paise left over go to
/// whoever was closest to the next one up. Without this a ₹100 discount over
/// three lines becomes ₹99.99 and the invoice does not reconcile.
export function distribute(amount, weights) {
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (!total || !amount) return weights.map(() => 0);

  const parts = weights.map((w) => Math.floor((amount * w) / total));
  let left = amount - parts.reduce((sum, p) => sum + p, 0);

  // Order by the size of the fraction that was thrown away, largest first.
  const order = weights
    .map((w, i) => ({ i, remainder: amount * w - parts[i] * total }))
    .sort((a, b) => b.remainder - a.remainder || a.i - b.i);

  for (let k = 0; left > 0; k += 1, left -= 1) parts[order[k % order.length].i] += 1;
  return parts;
}

/// Whether this is one IGST line or a CGST + SGST pair.
///
/// An unknown customer state is treated as the same state, which is the
/// common case for a walk-in customer with no GSTIN, and is the conservative
/// answer: CGST + SGST on a bill that should have been IGST is a correction,
/// where the reverse can look like tax collected and not passed on.
export const isInterState = (sellerStateCode, customerStateCode) => {
  const seller = normaliseStateCode(sellerStateCode);
  const customer = normaliseStateCode(customerStateCode);
  if (!seller || !customer) return false;
  return seller !== customer;
};

/// "9" and "09" are the same state. Stored two-digit because that is how GST
/// writes it and how a GSTIN starts.
export const normaliseStateCode = (code) => {
  const digits = String(code ?? '').replace(/\D/g, '');
  return digits ? digits.padStart(2, '0').slice(0, 2) : null;
};

/// The state a GSTIN belongs to. The first two digits of a GSTIN are the state
/// code, which means a customer's own number can fill this in for them.
export const stateCodeFromGstin = (gstin) => {
  const clean = String(gstin || '').trim().toUpperCase();
  return /^\d{2}[A-Z]{5}\d{4}[A-Z]/.test(clean) ? clean.slice(0, 2) : null;
};

/// Shape check only. Whether the number is real and active is a question for
/// the GST portal, and this does not pretend to answer it.
export const looksLikeGstin = (gstin) =>
  /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/.test(String(gstin || '').trim().toUpperCase());

// ---------------------------------------------------------------------------
// The totals
// ---------------------------------------------------------------------------

/// Works out every figure on a document from its lines.
///
/// Returns the lines with their own totals filled in as well as the document
/// totals, because an invoice has to show both and they have to agree.
export function computeTotals({
  items,
  gstEnabled = true,
  interState = false,
  pricesIncludeTax = false,
  discountMinor = 0,
}) {
  if (!Array.isArray(items) || !items.length) {
    throw new HttpError(400, 'Add at least one line item.');
  }

  const lines = items.map((item, index) => {
    const quantity = Number(item.quantity);
    const unitPriceMinor = Number(item.unitPriceMinor);
    const taxRatePct = gstEnabled ? Number(item.taxRatePct ?? 18) : 0;

    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999) {
      throw new HttpError(400, `Line ${index + 1}: quantity must be a whole number between 1 and 9999.`);
    }
    if (!Number.isInteger(unitPriceMinor) || unitPriceMinor < 0) {
      throw new HttpError(400, `Line ${index + 1}: enter a valid price.`);
    }
    if (gstEnabled && !isValidRate(taxRatePct)) {
      throw new HttpError(400, `Line ${index + 1}: ${taxRatePct}% is not a GST rate. Use 0, 5, 12, 18 or 28.`);
    }

    return { ...item, quantity, unitPriceMinor, taxRatePct, lineSubtotalMinor: quantity * unitPriceMinor };
  });

  const subtotalMinor = lines.reduce((sum, l) => sum + l.lineSubtotalMinor, 0);
  const discount = Math.max(0, Math.trunc(Number(discountMinor) || 0));

  if (discount > subtotalMinor) {
    throw new HttpError(400, 'The discount is more than the total of the lines.');
  }

  // Split across the lines so the parts add back to exactly the discount.
  const discounts = distribute(discount, lines.map((l) => l.lineSubtotalMinor));

  let taxableMinor = 0;
  let taxMinor = 0;

  const priced = lines.map((line, i) => {
    const lineDiscountMinor = discounts[i];
    const net = line.lineSubtotalMinor - lineDiscountMinor;

    let lineTaxableMinor;
    let lineTaxMinor;

    if (!gstEnabled || line.taxRatePct === 0) {
      lineTaxableMinor = net;
      lineTaxMinor = 0;
    } else if (pricesIncludeTax) {
      // Backwards out of a tax-inclusive figure: at 18%, ₹118 holds ₹100 of
      // value and ₹18 of tax. The tax is the remainder rather than a second
      // rounded multiplication, so taxable + tax is exactly what was typed.
      lineTaxableMinor = divideRound(net * 100, 100 + line.taxRatePct);
      lineTaxMinor = net - lineTaxableMinor;
    } else {
      lineTaxableMinor = net;
      lineTaxMinor = divideRound(net * line.taxRatePct, 100);
    }

    taxableMinor += lineTaxableMinor;
    taxMinor += lineTaxMinor;

    return {
      ...line,
      lineDiscountMinor,
      lineTaxableMinor,
      lineTaxMinor,
      lineTotalMinor: lineTaxableMinor + lineTaxMinor,
      sortOrder: i,
    };
  });

  // Within one state the tax is halved into CGST and SGST. The halves are
  // taken as floor and remainder so an odd number of paise is not lost: ₹0.05
  // of tax is 0.02 + 0.03, not 0.02 + 0.02.
  const cgstMinor = gstEnabled && !interState ? Math.floor(taxMinor / 2) : 0;
  const sgstMinor = gstEnabled && !interState ? taxMinor - cgstMinor : 0;
  const igstMinor = gstEnabled && interState ? taxMinor : 0;

  const totalMinor = taxableMinor + cgstMinor + sgstMinor + igstMinor;

  if (totalMinor > MAX_MINOR || subtotalMinor > MAX_MINOR) {
    throw new HttpError(400, 'That total is larger than this system can record. Split it across more than one document.');
  }

  return {
    items: priced,
    subtotalMinor,
    discountMinor: discount,
    taxableMinor,
    cgstMinor,
    sgstMinor,
    igstMinor,
    taxMinor,
    totalMinor,
    /// The rates that appear on the document, for the tax summary table a GST
    /// invoice is required to carry.
    rateBreakdown: summariseByRate(priced, { gstEnabled, interState }),
  };
}

/// Tax grouped by rate, which is the table a GST invoice has to show.
function summariseByRate(items, { gstEnabled, interState }) {
  if (!gstEnabled) return [];
  const byRate = new Map();

  for (const item of items) {
    const key = item.taxRatePct;
    const row = byRate.get(key) || { taxRatePct: key, taxableMinor: 0, cgstMinor: 0, sgstMinor: 0, igstMinor: 0 };
    row.taxableMinor += item.lineTaxableMinor;
    if (interState) {
      row.igstMinor += item.lineTaxMinor;
    } else {
      const half = Math.floor(item.lineTaxMinor / 2);
      row.cgstMinor += half;
      row.sgstMinor += item.lineTaxMinor - half;
    }
    byRate.set(key, row);
  }

  return [...byRate.values()].sort((a, b) => a.taxRatePct - b.taxRatePct);
}

// ---------------------------------------------------------------------------
// Numbering
// ---------------------------------------------------------------------------

/// The Indian financial year a date falls in: April to March, "2026-27".
///
/// This is the year GST is filed against, so it is the year invoice numbers
/// run in. A document issued on the 31st of March and one issued the next day
/// belong to different series, and that is the point.
export function financialYear(date = new Date()) {
  const d = new Date(date);
  const year = d.getFullYear();
  // Months are zero-based, so 3 is April.
  const start = d.getMonth() >= 3 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/// INV/2026-27/0001.
export const formatNumber = (prefix, series, n) =>
  `${prefix}/${series}/${String(n).padStart(4, '0')}`;

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen',
  'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

const underHundred = (n) =>
  n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`;

/// The amount in words, in the Indian system — lakh and crore, not million.
///
/// Every invoice carries this line, and it is not decoration: it is what
/// settles an argument about a smudged digit.
export function amountInWords(minor, currency = 'INR') {
  const rupees = Math.trunc(Math.abs(minor) / 100);
  const paise = Math.abs(minor) % 100;

  const parts = [];
  const push = (value, label) => {
    if (value) parts.push(`${underHundred(value)} ${label}`);
  };

  push(Math.floor(rupees / 10000000), 'Crore');
  push(Math.floor((rupees % 10000000) / 100000), 'Lakh');
  push(Math.floor((rupees % 100000) / 1000), 'Thousand');
  push(Math.floor((rupees % 1000) / 100), 'Hundred');

  const last = rupees % 100;
  if (last) parts.push(`${parts.length ? 'and ' : ''}${underHundred(last)}`);
  if (!parts.length) parts.push('Zero');

  const unit = currency === 'INR' ? 'Rupees' : currency;
  const words = `${unit} ${parts.join(' ')}`;
  return paise
    ? `${words} and ${underHundred(paise)} Paise Only`
    : `${words} Only`;
}
