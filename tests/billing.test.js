// Quotations and invoices, and the GST arithmetic underneath them.
//
// An invoice is a legal document, so most of this file is about exactness
// rather than about features working. Three claims are tested harder than the
// rest, because each one is a way of being quietly, expensively wrong:
//
//   The lines add up to the totals, in every combination of rate, discount,
//   inclusive pricing and rounding. A figure that is off by a paisa is a
//   figure somebody will eventually have to explain.
//
//   The tax splits the right way. CGST + SGST within a state, one IGST line
//   across a border, and nothing at all without a GSTIN of your own.
//
//   A number is never reused, even under concurrency, and never changes once
//   it has been issued.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import {
  computeTotals, distribute, financialYear, amountInWords, isInterState,
  stateCodeFromGstin, normaliseStateCode, looksLikeGstin, formatNumber,
} from '../src/lib/gst.js';

const PORT = 3975;
const BASE = `http://127.0.0.1:${PORT}`;
const prisma = new PrismaClient();

const stamp = Date.now();
const userEmail = `billing+${stamp}@example.com`;
const userPassword = 'BillingUser@12345';

let server;
const admin = client();
const member = client();
const anon = client();
const ctx = { created: [] };
let originalStore = null;

function client() {
  let cookie = '';
  return async function call(pathname, { method = 'GET', body } = {}) {
    const res = await fetch(`${BASE}${pathname}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        // Node's fetch keeps sockets alive; killing the server then resets
        // them, which surfaces as an uncaughtException after every test has
        // already passed.
        Connection: 'close',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, data };
  };
}

/// Creates a document and remembers it, so the teardown can take it away
/// again without touching anything this suite did not make.
async function create(kind, body) {
  const res = await admin(`/api/billing/${kind}`, { method: 'POST', body });
  if (res.data?.document?.id) ctx.created.push(res.data.document.id);
  return res;
}

const HOSTING = (price = '4999', rate = 18) => [
  { description: 'Business hosting — 1 year', hsnCode: '998315', quantity: 1, unitPrice: price, taxRatePct: rate },
];

test.before(async () => {
  server = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  for (let i = 0; i < 80; i += 1) {
    try {
      if ((await fetch(`${BASE}/api/health`, { headers: { Connection: 'close' } })).ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  await admin('/api/auth/login', { method: 'POST', body: { email: 'admin@example.com', password: 'Admin@12345' } });

  originalStore = await prisma.storeSettings.findUnique({ where: { id: 'default' } });

  // A seller in state 09, so the inter-state cases have something to differ
  // from.
  await admin('/api/catalog/store-settings', {
    method: 'PUT',
    body: {
      legalName: 'Billing Test Pvt Ltd',
      addressLine1: '1 Test Road',
      city: 'Lucknow',
      stateCode: '09',
      stateName: 'Uttar Pradesh',
      pincode: '226001',
      gstin: '09AABCU9603R1ZM',
      invoicePrefix: `TI${stamp % 1000}`,
      quotationPrefix: `TQ${stamp % 1000}`,
    },
  });

  const user = await admin('/api/users', {
    method: 'POST',
    body: { name: 'Billing User', email: userEmail, password: userPassword, role: 'USER' },
  });
  ctx.userId = user.data.user.id;
  await member('/api/auth/login', { method: 'POST', body: { email: userEmail, password: userPassword } });
});

test.after(async () => {
  try {
    if (ctx.created.length) {
      await prisma.billingDocument.deleteMany({ where: { id: { in: ctx.created } } });
    }
    await prisma.documentCounter.deleteMany({ where: { series: { contains: '-' }, nextNumber: { gt: 0 } } }).catch(() => null);
    if (ctx.userId) await admin(`/api/users/${ctx.userId}`, { method: 'DELETE' });

    if (originalStore) {
      const { id, updatedAt, ...rest } = originalStore;
      await prisma.storeSettings.update({ where: { id: 'default' }, data: rest });
    }
    await prisma.$disconnect();
  } catch (err) {
    console.error('TEARDOWN:', err?.message);
  }
  server?.kill();
});

// ---------------------------------------------------------------------------
// The arithmetic
// ---------------------------------------------------------------------------

test('18% is added to a price, exactly', () => {
  const r = computeTotals({ items: [{ quantity: 1, unitPriceMinor: 149900, taxRatePct: 18 }] });
  assert.equal(r.taxableMinor, 149900);
  // ₹1,499 × 18% is ₹269.82, which splits 134.91 each way with nothing lost.
  assert.equal(r.cgstMinor, 13491);
  assert.equal(r.sgstMinor, 13491);
  assert.equal(r.totalMinor, 176882);
});

test('a tax-inclusive price is worked backwards, not multiplied', () => {
  // ₹118 at 18% holds exactly ₹100 of value and ₹18 of tax.
  const r = computeTotals({
    items: [{ quantity: 1, unitPriceMinor: 11800, taxRatePct: 18 }],
    pricesIncludeTax: true,
  });
  assert.equal(r.taxableMinor, 10000);
  assert.equal(r.taxMinor, 1800);
  // And the total is what was typed, to the paisa.
  assert.equal(r.totalMinor, 11800);
});

test('an odd number of paise of tax is split rather than lost', () => {
  // A tax of 5 paise must become 2 + 3, not 2 + 2.
  const r = computeTotals({ items: [{ quantity: 1, unitPriceMinor: 50, taxRatePct: 5 }] });
  assert.equal(r.taxMinor, r.cgstMinor + r.sgstMinor);
  assert.equal(r.totalMinor, r.taxableMinor + r.cgstMinor + r.sgstMinor);
});

test('across a state border it is one IGST line, not two halves', () => {
  const r = computeTotals({
    items: [{ quantity: 2, unitPriceMinor: 50000, taxRatePct: 18 }],
    interState: true,
  });
  assert.equal(r.igstMinor, 18000);
  assert.equal(r.cgstMinor, 0);
  assert.equal(r.sgstMinor, 0);
  assert.equal(r.totalMinor, 118000);
});

test('with GST off there is no tax at all, at any rate', () => {
  const r = computeTotals({
    items: [{ quantity: 3, unitPriceMinor: 33333, taxRatePct: 18 }],
    gstEnabled: false,
  });
  assert.equal(r.taxMinor, 0);
  assert.equal(r.totalMinor, 99999);
  assert.deepEqual(r.rateBreakdown, []);
});

test('a discount is split so the parts add back to exactly the discount', () => {
  // ₹1 over three lines cannot divide evenly, which is the point.
  const r = computeTotals({
    items: [
      { quantity: 1, unitPriceMinor: 10000, taxRatePct: 18 },
      { quantity: 1, unitPriceMinor: 10000, taxRatePct: 18 },
      { quantity: 1, unitPriceMinor: 10000, taxRatePct: 5 },
    ],
    discountMinor: 100,
  });
  assert.equal(r.items.reduce((sum, i) => sum + i.lineDiscountMinor, 0), 100);
  assert.equal(r.items.reduce((sum, i) => sum + i.lineTotalMinor, 0), r.totalMinor);
});

test('the lines always add up to the totals, across every rate and shape', () => {
  // A sweep rather than a few chosen numbers: rounding bugs hide in the
  // combinations nobody thought to write down.
  for (const rate of [0, 5, 12, 18, 28]) {
    for (const price of [1, 7, 99, 333, 4999, 123456]) {
      for (const quantity of [1, 3, 7]) {
        for (const inclusive of [false, true]) {
          for (const interState of [false, true]) {
            const r = computeTotals({
              items: [
                { quantity, unitPriceMinor: price, taxRatePct: rate },
                { quantity: 1, unitPriceMinor: price * 2 + 1, taxRatePct: rate },
              ],
              pricesIncludeTax: inclusive,
              interState,
              discountMinor: Math.floor(price / 3),
            });

            const where = `rate ${rate} price ${price} qty ${quantity} incl ${inclusive} inter ${interState}`;

            assert.equal(
              r.items.reduce((s, i) => s + i.lineTaxableMinor, 0),
              r.taxableMinor,
              `taxable values must sum: ${where}`,
            );
            assert.equal(
              r.items.reduce((s, i) => s + i.lineTaxMinor, 0),
              r.taxMinor,
              `tax must sum: ${where}`,
            );
            assert.equal(
              r.taxableMinor + r.cgstMinor + r.sgstMinor + r.igstMinor,
              r.totalMinor,
              `total must reconcile: ${where}`,
            );
            assert.equal(r.cgstMinor + r.sgstMinor + r.igstMinor, r.taxMinor, `split must be lossless: ${where}`);
            assert.equal(
              r.items.reduce((s, i) => s + i.lineDiscountMinor, 0),
              r.discountMinor,
              `discount must sum: ${where}`,
            );
            // The tax summary is what goes on the document, so it has to
            // agree with the totals it sits beside.
            const summed = r.rateBreakdown.reduce(
              (s, row) => s + row.cgstMinor + row.sgstMinor + row.igstMinor,
              0,
            );
            assert.equal(summed, r.taxMinor, `rate summary must agree: ${where}`);
          }
        }
      }
    }
  }
});

test('distribute never loses or invents a paisa', () => {
  for (const amount of [0, 1, 7, 100, 9999]) {
    for (const weights of [[1], [1, 1], [1, 2, 3], [7, 11, 13, 17], [1, 0, 0]]) {
      const parts = distribute(amount, weights);
      assert.equal(parts.reduce((a, b) => a + b, 0), amount, `${amount} over ${weights}`);
      assert.ok(parts.every((p) => p >= 0));
    }
  }
});

test('a quantity or rate that is not real is refused, not guessed', () => {
  assert.throws(() => computeTotals({ items: [{ quantity: 0, unitPriceMinor: 100, taxRatePct: 18 }] }));
  assert.throws(() => computeTotals({ items: [{ quantity: 1.5, unitPriceMinor: 100, taxRatePct: 18 }] }));
  assert.throws(() => computeTotals({ items: [{ quantity: 1, unitPriceMinor: -1, taxRatePct: 18 }] }));
  assert.throws(() => computeTotals({ items: [{ quantity: 1, unitPriceMinor: 100, taxRatePct: 17 }] }));
  assert.throws(() => computeTotals({ items: [] }));
  // A discount bigger than the bill would make a negative invoice.
  assert.throws(() => computeTotals({ items: [{ quantity: 1, unitPriceMinor: 100, taxRatePct: 0 }], discountMinor: 200 }));
});

test('the financial year turns over on the first of April', () => {
  assert.equal(financialYear(new Date('2026-03-31T23:59:00Z')), '2025-26');
  assert.equal(financialYear(new Date('2026-04-01T00:01:00Z')), '2026-27');
  assert.equal(financialYear(new Date('2026-12-31T00:00:00Z')), '2026-27');
  assert.equal(formatNumber('INV', '2026-27', 7), 'INV/2026-27/0007');
});

test('amounts read the Indian way, in lakh and crore', () => {
  assert.equal(amountInWords(17699000), 'Rupees One Lakh Seventy Six Thousand Nine Hundred and Ninety Only');
  assert.equal(amountInWords(150), 'Rupees One and Fifty Paise Only');
  assert.equal(amountInWords(0), 'Rupees Zero Only');
  assert.match(amountInWords(1234567890), /Crore/);
});

test('a GSTIN says which state it belongs to', () => {
  assert.equal(stateCodeFromGstin('09AABCU9603R1ZM'), '09');
  assert.equal(stateCodeFromGstin('27AABCU9603R1ZM'), '27');
  assert.equal(stateCodeFromGstin('nonsense'), null);
  assert.equal(normaliseStateCode('9'), '09');
  assert.ok(looksLikeGstin('09AABCU9603R1ZM'));
  assert.ok(!looksLikeGstin('09AABCU9603R1XM'), 'the fixed Z is part of the shape');
});

test('an unknown customer state is treated as the same state', () => {
  // The conservative answer: CGST + SGST where IGST was owed is a correction,
  // where the reverse can look like tax collected and not passed on.
  assert.equal(isInterState('09', null), false);
  assert.equal(isInterState('09', '09'), false);
  assert.equal(isInterState('09', '27'), true);
});

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

test('an invoice within the state carries CGST and SGST', async () => {
  const { status, data } = await create('INVOICE', {
    customerName: 'Same State Traders',
    customerGstin: '09AAACA1234A1Z5',
    gstEnabled: true,
    items: HOSTING(),
  });

  assert.equal(status, 201);
  const doc = data.document;
  assert.equal(doc.isInterState, false);
  assert.equal(doc.cgstMinor, 44991);
  assert.equal(doc.sgstMinor, 44991);
  assert.equal(doc.igstMinor, 0);
  assert.equal(doc.totalMinor, 589882);
  // The customer's own GSTIN filled the state in.
  assert.equal(doc.customerStateCode, '09');
  assert.match(doc.amountInWords, /^Rupees/);
});

test('an invoice across the border carries IGST instead', async () => {
  const { data } = await create('INVOICE', {
    customerName: 'Mumbai Media',
    customerGstin: '27AAACA1234A1Z5',
    gstEnabled: true,
    items: HOSTING(),
  });

  assert.equal(data.document.isInterState, true);
  assert.equal(data.document.igstMinor, 89982);
  assert.equal(data.document.cgstMinor, 0);
  assert.equal(data.document.totalMinor, 589882);
});

test('with GST off the document is a bill of supply and charges nothing', async () => {
  const { data } = await create('INVOICE', {
    customerName: 'Below Threshold Shop',
    gstEnabled: false,
    items: HOSTING(),
  });

  const doc = data.document;
  assert.equal(doc.gstEnabled, false);
  assert.equal(doc.cgstMinor + doc.sgstMinor + doc.igstMinor, 0);
  assert.equal(doc.totalMinor, 499900, 'the customer pays exactly the price quoted');
  assert.deepEqual(doc.rateBreakdown, []);
});

test('numbers run in sequence within the financial year', async () => {
  const first = await create('INVOICE', { customerName: 'Seq One', gstEnabled: false, items: HOSTING('100') });
  const second = await create('INVOICE', { customerName: 'Seq Two', gstEnabled: false, items: HOSTING('100') });

  const n = (doc) => Number(doc.number.split('/').pop());
  assert.equal(n(second.data.document), n(first.data.document) + 1);
  assert.equal(first.data.document.series, financialYear(new Date()));
  // Quotations have their own series, so an invoice and a quotation raised in
  // the same minute do not collide.
  const quote = await create('QUOTATION', { customerName: 'Seq Q', gstEnabled: false, items: HOSTING('100') });
  assert.notEqual(quote.data.document.number, first.data.document.number);
  assert.match(quote.data.document.number, /^TQ/);
});

test('two documents created at the same moment never take the same number', async () => {
  // The allocation is a single atomic UPDATE. Reading a maximum and adding
  // one would hand both of these the same number.
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      create('INVOICE', { customerName: `Race ${i}`, gstEnabled: false, items: HOSTING('100') }),
    ),
  );

  const numbers = results.map((r) => r.data.document.number);
  assert.equal(new Set(numbers).size, 8, `all distinct, got ${numbers.join(', ')}`);
});

test('a quotation becomes an invoice without changing the quotation', async () => {
  const quote = await create('QUOTATION', {
    customerName: 'Convert Co',
    customerGstin: '09AAACA1234A1Z5',
    gstEnabled: true,
    items: [{ description: 'Website redesign', quantity: 1, unitPrice: '25000', taxRatePct: 18 }],
  });
  const original = quote.data.document;
  assert.ok(original.validUntil, 'a quotation lapses');

  const converted = await admin(`/api/billing/${original.id}/convert`, { method: 'POST' });
  assert.equal(converted.status, 201);
  ctx.created.push(converted.data.document.id);

  const invoice = converted.data.document;
  assert.equal(invoice.kind, 'INVOICE');
  assert.equal(invoice.totalMinor, original.totalMinor);
  assert.equal(invoice.convertedFromId, original.id);
  assert.notEqual(invoice.number, original.number);

  // The quotation is untouched apart from being marked accepted, so what was
  // offered can still be shown.
  const after = await admin(`/api/billing/${original.id}`);
  assert.equal(after.data.document.number, original.number);
  assert.equal(after.data.document.totalMinor, original.totalMinor);
  assert.equal(after.data.document.status, 'ACCEPTED');

  // And it cannot be converted twice.
  assert.equal((await admin(`/api/billing/${original.id}/convert`, { method: 'POST' })).status, 400);
});

test('a part payment leaves a balance; the full amount settles it', async () => {
  const { data } = await create('INVOICE', {
    customerName: 'Paying Customer',
    gstEnabled: false,
    items: HOSTING('1000'),
  });
  const doc = data.document;

  const part = await admin(`/api/billing/${doc.id}/payment`, { method: 'POST', body: { amount: '400' } });
  assert.equal(part.data.document.amountPaidMinor, 40000);
  assert.notEqual(part.data.document.status, 'PAID', 'a part payment is not a paid invoice');
  assert.equal(part.data.document.outstandingMinor, 60000);

  const rest = await admin(`/api/billing/${doc.id}/payment`, { method: 'POST', body: { amount: '600' } });
  assert.equal(rest.data.document.status, 'PAID');
  assert.equal(rest.data.document.outstandingMinor, 0);
  assert.ok(rest.data.document.paidOn);

  // And nothing more can be taken against it.
  const over = await admin(`/api/billing/${doc.id}/payment`, { method: 'POST', body: { amount: '1' } });
  assert.equal(over.status, 400);
});

test('an issued invoice cannot have its figures edited', async () => {
  const { data } = await create('INVOICE', { customerName: 'Fixed Co', gstEnabled: false, items: HOSTING('500') });
  const doc = data.document;

  await admin(`/api/billing/${doc.id}/payment`, { method: 'POST', body: { amount: '500' } });

  const edit = await admin(`/api/billing/${doc.id}`, {
    method: 'PUT',
    body: { customerName: 'Fixed Co', gstEnabled: false, items: HOSTING('99999') },
  });
  assert.equal(edit.status, 400);
  assert.match(edit.data.error, /already been issued/);

  const after = await admin(`/api/billing/${doc.id}`);
  assert.equal(after.data.document.totalMinor, 50000, 'the figures did not move');
});

test('a cancelled document keeps its number', async () => {
  const { data } = await create('INVOICE', { customerName: 'Cancel Co', gstEnabled: false, items: HOSTING('100') });
  const number = data.document.number;

  await admin(`/api/billing/${data.document.id}/status`, { method: 'POST', body: { status: 'CANCELLED' } });

  const after = await admin(`/api/billing/${data.document.id}`);
  assert.equal(after.data.document.status, 'CANCELLED');
  assert.equal(after.data.document.number, number, 'a gap in a series is ordinary; a repeat is not');

  // And the next document does not reuse it either.
  const next = await create('INVOICE', { customerName: 'After Cancel', gstEnabled: false, items: HOSTING('100') });
  assert.notEqual(next.data.document.number, number);
});

test('marking something paid goes through the payment route, not the status one', async () => {
  const { data } = await create('INVOICE', { customerName: 'Status Co', gstEnabled: false, items: HOSTING('100') });
  const res = await admin(`/api/billing/${data.document.id}/status`, { method: 'POST', body: { status: 'PAID' } });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /Record the payment/);
});

test('the preview and the saved document agree, because they are the same code', async () => {
  const body = {
    customerName: 'Preview Co',
    customerGstin: '27AAACA1234A1Z5',
    gstEnabled: true,
    discount: '250',
    items: [
      { description: 'Hosting', quantity: 2, unitPrice: '1499', taxRatePct: 18 },
      { description: 'Email', quantity: 5, unitPrice: '99', taxRatePct: 18 },
    ],
  };

  const preview = await admin('/api/billing/preview', { method: 'POST', body });
  const saved = await create('INVOICE', body);

  assert.equal(preview.data.totals.totalMinor, saved.data.document.totalMinor);
  assert.equal(preview.data.totals.igstMinor, saved.data.document.igstMinor);
  assert.equal(preview.data.totals.taxableMinor, saved.data.document.taxableMinor);
});

// ---------------------------------------------------------------------------
// Who may see what
// ---------------------------------------------------------------------------

test('billing is closed to a stranger and read-only to a customer', async () => {
  assert.equal((await anon('/api/billing')).status, 401);

  assert.equal((await member('/api/billing')).status, 200, 'a customer sees their own list');
  assert.equal(
    (await member('/api/billing/INVOICE', { method: 'POST', body: { customerName: 'X', items: HOSTING() } })).status,
    403,
    'but cannot raise one',
  );
});

test('a customer cannot read a document that is not theirs', async () => {
  const { data } = await create('INVOICE', { customerName: 'Somebody Else', gstEnabled: false, items: HOSTING('100') });
  const res = await member(`/api/billing/${data.document.id}`);
  assert.equal(res.status, 404, 'not 403 — the id must not confirm the document exists');
});

test('a customer sees a document addressed to them, but never a draft', async () => {
  const { data } = await create('INVOICE', {
    customerName: 'Billing User',
    userId: ctx.userId,
    gstEnabled: false,
    items: HOSTING('100'),
  });

  // Still a draft: not decided yet, so not theirs to see.
  assert.equal((await member(`/api/billing/${data.document.id}`)).status, 404);

  await admin(`/api/billing/${data.document.id}/status`, { method: 'POST', body: { status: 'SENT' } });
  const res = await member(`/api/billing/${data.document.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.data.document.number, data.document.number);
  assert.equal(res.data.editable, false, 'and they cannot edit it');
});

test('a GSTIN that is not a GSTIN is refused', async () => {
  const res = await admin('/api/billing/INVOICE', {
    method: 'POST',
    body: { customerName: 'Bad GSTIN', customerGstin: '09NOTAGSTIN', items: HOSTING() },
  });
  assert.equal(res.status, 400);
});

test('a price that is not a price is refused rather than becoming zero', async () => {
  for (const unitPrice of ['abc', '1.234', '-5', '']) {
    const res = await admin('/api/billing/INVOICE', {
      method: 'POST',
      body: {
        customerName: 'Bad Price',
        items: [{ description: 'Thing', quantity: 1, unitPrice, taxRatePct: 18 }],
      },
    });
    assert.equal(res.status, 400, `"${unitPrice}" should be refused`);
  }
});
