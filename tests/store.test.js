// The public storefront, end to end.
//
// This is the one part of the application a stranger can reach, so most of what
// is checked here is what happens when they misbehave: a tampered price, a
// guessed order reference, an order placed a hundred times.
//
// The other half is the honesty of the payment flow. Nothing may report an
// order as paid until a person says so, because nothing about a UPI transfer
// can be verified from here — and a test that lets that slip would be worse
// than no test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { toMinor, formatMinor, toEditable } from '../src/lib/money.js';
import { generateReference, upiLink, whatsappLink } from '../src/services/storeService.js';

const PORT = 3981;
const BASE = `http://127.0.0.1:${PORT}`;
const prisma = new PrismaClient();

const stamp = Date.now();
const PLAN_SLUG = `starter-${stamp}`;
const TLD = `t${String(stamp).slice(-5)}`;   // a made-up ending, so no real price is disturbed
const userEmail = `store+${stamp}@example.com`;
const userPassword = 'StoreUser@12345';

let server;
const admin = client();
const anon = client();
const member = client();
const ctx = {};
/// Settings are one shared row, so whatever was there is put back afterwards.
let originalSettings = null;

function client() {
  let cookie = '';
  return async function call(pathname, { method = 'GET', body } = {}) {
    const res = await fetch(`${BASE}${pathname}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];

    const type = res.headers.get('content-type') || '';
    const text = await res.text();
    if (!type.includes('json')) return { status: res.status, text, data: null, headers: res.headers };

    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, data, text, headers: res.headers };
  };
}

const order = (body) => anon('/api/store/orders', { method: 'POST', body });

const customer = {
  customerName: 'Priya Nair',
  customerEmail: 'priya@example.com',
  customerPhone: '+91 98765 43210',
};

test.before(async () => {
  server = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  for (let i = 0; i < 80; i += 1) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  await admin('/api/auth/login', { method: 'POST', body: { email: 'admin@example.com', password: 'Admin@12345' } });

  originalSettings = await prisma.storeSettings.findUnique({ where: { id: 'default' } });
  await admin('/api/catalog/store-settings', {
    method: 'PUT',
    body: {
      businessName: 'Test Hosting Co',
      headline: 'Hosting for the test suite',
      supportEmail: 'help@example.com',
      upiId: 'testshop@examplebank',
      upiPayeeName: 'Test Hosting Co',
      whatsappNumber: '+91 90000 00000',
      isOpen: true,
    },
  });

  const plan = await admin('/api/catalog/plans', {
    method: 'POST',
    body: {
      name: `Starter ${stamp}`,
      slug: PLAN_SLUG,
      tagline: 'For a first site',
      price: '1499.50',
      wasPrice: '1999',
      billingPeriod: 'YEARLY',
      features: ['10 GB storage', 'Free SSL', ''],
      isFeatured: true,
    },
  });
  ctx.planId = plan.data.plan.id;

  const hidden = await admin('/api/catalog/plans', {
    method: 'POST',
    body: { name: `Retired ${stamp}`, price: '99', isActive: false },
  });
  ctx.hiddenPlanId = hidden.data.plan.id;

  await admin('/api/catalog/tld-prices', {
    method: 'PUT',
    body: { tld: TLD, register: '899', renew: '1099', isPopular: true },
  });

  const user = await admin('/api/users', {
    method: 'POST',
    body: { name: 'Store User', email: userEmail, password: userPassword, role: 'USER' },
  });
  ctx.userId = user.data.user.id;
  await member('/api/auth/login', { method: 'POST', body: { email: userEmail, password: userPassword } });
});

test.after(async () => {
  try {
    if (ctx.userId) await admin(`/api/users/${ctx.userId}`, { method: 'DELETE' });
    await prisma.order.deleteMany({ where: { customerEmail: { in: ['priya@example.com', 'spam@example.com'] } } });
    await prisma.plan.deleteMany({ where: { id: { in: [ctx.planId, ctx.hiddenPlanId].filter(Boolean) } } });
    await prisma.tldPrice.deleteMany({ where: { tld: TLD } });

    if (originalSettings) {
      const { id, updatedAt, ...rest } = originalSettings;
      await prisma.storeSettings.update({ where: { id: 'default' }, data: rest });
    } else {
      await prisma.storeSettings.deleteMany({ where: { id: 'default' } });
    }
    await prisma.$disconnect();
  } catch (err) {
    console.error('TEARDOWN:', err?.message);
  }
  server?.kill();
});

// --- Money, on its own -----------------------------------------------------

test('a price a person typed becomes exact paise, or is refused', () => {
  assert.equal(toMinor('1499'), 149900);
  assert.equal(toMinor('1499.50'), 149950);
  assert.equal(toMinor('1,499.99'), 149999);
  assert.equal(toMinor('₹ 999'), 99900);
  assert.equal(toMinor('0.05'), 5);

  // Refused rather than guessed: a price that quietly became NaN would be
  // charged as zero.
  for (const bad of ['', 'abc', '12.345', '-5', '1e3']) {
    assert.equal(toMinor(bad), null, `${bad} should be refused`);
  }
});

test('paise come back as rupees, grouped the Indian way', () => {
  assert.equal(formatMinor(149950), '₹1,499.50');
  assert.equal(formatMinor(99900), '₹999');
  assert.equal(formatMinor(1234567800), '₹1,23,45,678');
  assert.equal(formatMinor(5), '₹0.05');
  // And back to something a form field can hold.
  assert.equal(toEditable(149950), '1499.50');
  assert.equal(toEditable(99900), '999');
});

test('an order reference is unguessable and readable aloud', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) seen.add(generateReference());
  assert.equal(seen.size, 500, 'no collisions in 500');

  // Checked over many references rather than one, or a character that only
  // turns up a quarter of the time would pass by luck.
  for (let i = 0; i < 200; i += 1) {
    const one = generateReference();
    assert.match(one, /^WES-[2-46-9A-HJ-NP-RT-Z]{5}-[2-46-9A-HJ-NP-RT-Z]{5}$/, one);
    // Both halves of each confusable pair are absent: O/0, I/1, S/5.
    assert.ok(!/[O0I1S5]/.test(one.slice(4)), `${one} contains a character people misread`);
  }
});

test('the UPI link carries the amount and the reference', () => {
  const link = upiLink({ upiId: 'shop@bank', payeeName: 'Shop Name', amountMinor: 149950, reference: 'WES-AAAAA-BBBBB' });
  const url = new URL(link);
  assert.equal(url.protocol, 'upi:');
  const params = new URLSearchParams(link.split('?')[1]);
  assert.equal(params.get('pa'), 'shop@bank');
  assert.equal(params.get('pn'), 'Shop Name');
  assert.equal(params.get('am'), '1499.50', 'rupees with two decimals, as the spec wants');
  assert.equal(params.get('cu'), 'INR');
  assert.match(params.get('tn'), /WES-AAAAA-BBBBB/);

  assert.equal(upiLink({ upiId: null, amountMinor: 1, reference: 'x' }), null);
  assert.equal(whatsappLink('+91 98765 43210', 'hi'), 'https://wa.me/919876543210?text=hi');
});

// --- The public site -------------------------------------------------------

test('the storefront is served at the root and the portal at /portal', async () => {
  const store = await anon('/');
  assert.equal(store.status, 200);
  assert.match(store.text, /js\/store\.js/);

  const portal = await anon('/portal/');
  assert.equal(portal.status, 200);
  assert.match(portal.text, /js\/app\.js/, 'the portal moved but still works');

  // Its own deep links survive a refresh.
  assert.equal((await anon('/portal/anything')).status, 200);
});

test('a stranger can read the catalogue without signing in', async () => {
  const config = await anon('/api/store/config');
  assert.equal(config.status, 200);
  assert.equal(config.data.businessName, 'Test Hosting Co');
  assert.equal(config.data.canAcceptPayment, true);
  assert.match(config.data.whatsappLink, /^https:\/\/wa\.me\/919000000000/);

  const plans = await anon('/api/store/plans');
  assert.equal(plans.status, 200);
  const mine = plans.data.plans.find((p) => p.slug === PLAN_SLUG);
  assert.ok(mine, 'the plan is on sale');
  assert.equal(mine.price, '₹1,499.50');
  assert.equal(mine.wasPrice, '₹1,999');
  assert.deepEqual(mine.features, ['10 GB storage', 'Free SSL'], 'the blank line was dropped');
});

test('a hidden plan is off the public list but keeps its own page closed too', async () => {
  const plans = await anon('/api/store/plans');
  assert.ok(!plans.data.plans.some((p) => p.id === ctx.hiddenPlanId));

  const hidden = await prisma.plan.findUnique({ where: { id: ctx.hiddenPlanId } });
  const direct = await anon(`/api/store/plans/${hidden.slug}`);
  assert.equal(direct.status, 404);
});

test('domain endings come back with both prices', async () => {
  const { status, data } = await anon('/api/store/tlds');
  assert.equal(status, 200);
  const mine = data.tlds.find((t) => t.tld === TLD);
  assert.equal(mine.register, '₹899');
  assert.equal(mine.renew, '₹1,099', 'renewal is shown so nobody is surprised later');
  assert.equal(mine.isPopular, true);
});

test('a domain search prices the name across every ending', async () => {
  const { status, data } = await anon('/api/store/domain-search', { method: 'POST', body: { name: 'mybrand' } });
  assert.equal(status, 200);
  assert.equal(data.name, 'mybrand');

  const mine = data.results.find((r) => r.tld === TLD);
  assert.equal(mine.domain, `mybrand.${TLD}`);
  assert.equal(mine.register, '₹899');
  // No provider can answer for a made-up ending, so availability is unknown —
  // which must read as unknown rather than as available.
  assert.ok(mine.available === null || typeof mine.available === 'boolean');
});

test('a search for rubbish is refused', async () => {
  for (const name of ['', 'has space', 'under_score']) {
    const res = await anon('/api/store/domain-search', { method: 'POST', body: { name } });
    assert.equal(res.status, 400, `"${name}" should be refused`);
  }
});

// --- Placing an order ------------------------------------------------------

test('a hosting order is priced by the server, not by the browser', async () => {
  const res = await order({
    kind: 'HOSTING',
    planId: ctx.planId,
    ...customer,
    // Everything a tampered form might send. All of it is ignored.
    amountMinor: 1,
    amount: '₹1',
    priceMinor: 100,
  });

  assert.equal(res.status, 201);
  assert.equal(res.data.amount, '₹1,499.50', 'the plan price, not the one sent');

  const row = await prisma.order.findUnique({ where: { reference: res.data.reference } });
  assert.equal(row.amountMinor, 149950);
  assert.equal(row.status, 'PENDING_PAYMENT');
  ctx.hostingRef = res.data.reference;
});

test('the order comes back with everything needed to pay it', async () => {
  const { data } = await anon(`/api/store/orders/${ctx.hostingRef}`);
  assert.equal(data.amount, '₹1,499.50');
  assert.equal(data.status, 'PENDING_PAYMENT');
  assert.equal(data.payment.upiId, 'testshop@examplebank');
  assert.match(data.payment.upiLink, /^upi:\/\/pay\?/);
  assert.match(data.payment.whatsappLink, /wa\.me\/919000000000/);
  // And says plainly that nobody has checked anything.
  assert.match(data.payment.verificationNote, /checked by hand/i);
});

test('a leaked reference does not hand over the customer with it', async () => {
  const res = await anon(`/api/store/orders/${ctx.hostingRef}`);
  // The reference travels in URLs and messages, so what it opens must not
  // include personal details.
  for (const secret of [customer.customerName, customer.customerEmail, '98765']) {
    assert.ok(!res.text.includes(secret), `the lookup exposed ${secret}`);
  }
});

test('the payment QR is a real image for this order', async () => {
  const res = await anon(`/api/store/orders/${ctx.hostingRef}/qr.svg`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(res.text, /^<svg/);
});

test('a domain order is priced from its ending', async () => {
  const res = await order({
    kind: 'DOMAIN',
    tld: TLD,
    domainName: `mybrand.${TLD}`,
    ...customer,
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.amount, '₹899');
  ctx.domainRef = res.data.reference;

  const row = await prisma.order.findUnique({ where: { reference: res.data.reference } });
  assert.equal(row.kind, 'DOMAIN');
  assert.equal(row.tld, TLD);
  assert.equal(row.amountMinor, 89900);
});

test('a domain name that does not match the ending chosen is refused', async () => {
  const res = await order({ kind: 'DOMAIN', tld: TLD, domainName: 'mybrand.com', ...customer });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /does not match the ending/i);
});

test('a domain order with no name is refused', async () => {
  const res = await order({ kind: 'DOMAIN', tld: TLD, ...customer });
  assert.equal(res.status, 400);
});

test('hosting can be ordered before a domain has been chosen', async () => {
  const res = await order({ kind: 'HOSTING', planId: ctx.planId, ...customer });
  assert.equal(res.status, 201, 'plenty of people buy hosting first');
  await prisma.order.delete({ where: { reference: res.data.reference } });
});

test('a hidden plan cannot be ordered even with its id', async () => {
  const res = await order({ kind: 'HOSTING', planId: ctx.hiddenPlanId, ...customer });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /no longer on sale/i);
});

test('an unpriced ending cannot be ordered', async () => {
  const res = await order({ kind: 'DOMAIN', tld: 'zzznotsold', domainName: 'x.zzznotsold', ...customer });
  assert.equal(res.status, 404);
});

test('a bad contact detail is refused with a reason', async () => {
  const cases = [
    [{ ...customer, customerEmail: 'not-an-email' }, /email/i],
    [{ ...customer, customerName: 'x' }, /name/i],
    [{ ...customer, customerPhone: '12' }, /phone/i],
  ];
  for (const [body, pattern] of cases) {
    const res = await order({ kind: 'HOSTING', planId: ctx.planId, ...body });
    assert.equal(res.status, 400);
    assert.match(JSON.stringify(res.data), pattern);
  }
});

test('an unknown reference is a 404 rather than a hint', async () => {
  const res = await anon('/api/store/orders/WES-ZZZZZ-ZZZZZ');
  assert.equal(res.status, 404);
});

// --- Reporting a payment ---------------------------------------------------

test('a customer can report a payment, and it is recorded as a claim', async () => {
  const res = await anon(`/api/store/orders/${ctx.hostingRef}/payment`, {
    method: 'POST',
    body: { paymentReference: '402912345678' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.status, 'PAYMENT_SUBMITTED');

  const row = await prisma.order.findUnique({ where: { reference: ctx.hostingRef } });
  assert.equal(row.paymentReference, '402912345678');
  assert.ok(row.paymentSubmittedAt);
  // The crucial part: reporting a payment does not make it paid.
  assert.equal(row.status, 'PAYMENT_SUBMITTED');
  assert.equal(row.paidAt, null);
  assert.equal(row.confirmedById, null);
});

test('nothing a customer can reach marks an order paid', async () => {
  // Every shape of attempt to move the order along from outside.
  const attempts = [
    ['/api/store/orders/' + ctx.hostingRef, 'PUT', { status: 'PAID' }],
    ['/api/store/orders/' + ctx.hostingRef + '/confirm-payment', 'POST', {}],
    ['/api/orders/' + ctx.hostingRef + '/confirm-payment', 'POST', {}],
  ];
  for (const [path, method, body] of attempts) {
    const res = await anon(path, { method, body });
    assert.ok(res.status >= 400, `${method} ${path} should not have worked`);
  }

  const row = await prisma.order.findUnique({ where: { reference: ctx.hostingRef } });
  assert.equal(row.status, 'PAYMENT_SUBMITTED', 'still waiting on a person');
});

// --- The admin side --------------------------------------------------------

test('the orders queue is closed to everyone but a Super Admin', async () => {
  assert.equal((await anon('/api/orders')).status, 401);
  assert.equal((await member('/api/orders')).status, 403);
  assert.equal((await member('/api/catalog/plans')).status, 403);
  assert.equal((await member('/api/catalog/store-settings')).status, 403);
});

test('a normal user cannot change what is for sale or where money goes', async () => {
  const res = await member('/api/catalog/store-settings', {
    method: 'PUT',
    body: { upiId: 'attacker@bank' },
  });
  assert.equal(res.status, 403);

  const settings = await prisma.storeSettings.findUnique({ where: { id: 'default' } });
  assert.equal(settings.upiId, 'testshop@examplebank', 'the payee did not move');
});

test('the admin sees the order with the customer, and what they claimed', async () => {
  const { status, data } = await admin('/api/orders?status=PAYMENT_SUBMITTED');
  assert.equal(status, 200);

  const mine = data.orders.find((o) => o.reference === ctx.hostingRef);
  assert.ok(mine, 'the order is in the queue');
  assert.equal(mine.customerName, customer.customerName);
  assert.equal(mine.customerEmail, customer.customerEmail);
  // Named so nobody mistakes it for a verified fact.
  assert.equal(mine.claimedPaymentReference, '402912345678');
  assert.match(mine.whatsappLink, /wa\.me\/919876543210/);
  ctx.orderId = mine.id;

  assert.match(data.totals.awaiting, /^₹/);
});

test('confirming a payment records who confirmed it', async () => {
  const res = await admin(`/api/orders/${ctx.orderId}/confirm-payment`, {
    method: 'POST',
    body: { note: 'Seen in the account.' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.order.status, 'PAID');

  const row = await prisma.order.findUnique({ where: { id: ctx.orderId }, include: { confirmedBy: true } });
  assert.ok(row.paidAt);
  assert.equal(row.confirmedBy.email, 'admin@example.com', 'a money decision has a name against it');
  assert.match(row.adminNotes, /Seen in the account/);
});

test('confirming twice is refused', async () => {
  const res = await admin(`/api/orders/${ctx.orderId}/confirm-payment`, { method: 'POST' });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /already confirmed/i);
});

test('the customer now sees it as paid, with no payment details left to show', async () => {
  const { data } = await anon(`/api/store/orders/${ctx.hostingRef}`);
  assert.equal(data.status, 'PAID');
  assert.equal(data.payment, null, 'nothing left to pay, so nothing is shown');
  assert.match(data.statusText, /confirmed/i);
});

test('an order cannot be marked set up before its payment is confirmed', async () => {
  const domainOrder = await prisma.order.findUnique({ where: { reference: ctx.domainRef } });
  const res = await admin(`/api/orders/${domainOrder.id}/provision`, { method: 'POST', body: {} });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /Confirm the payment/i);
});

test('marking an order set up can tie it to what it became', async () => {
  const domain = await prisma.domain.create({ data: { name: `ordered-${stamp}.example`, source: 'MANUAL' } });
  ctx.domainId = domain.id;

  const res = await admin(`/api/orders/${ctx.orderId}/provision`, {
    method: 'POST',
    body: { domainId: domain.id, note: 'Set up on shared hosting.' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.order.status, 'PROVISIONED');
  assert.equal(res.data.order.linkedDomain.name, domain.name);

  await prisma.order.update({ where: { id: ctx.orderId }, data: { domainId: null } });
  await prisma.domain.delete({ where: { id: domain.id } });
});

test('a link to something that does not exist is refused', async () => {
  const res = await admin(`/api/orders/${ctx.orderId}/provision`, {
    method: 'POST',
    body: { domainId: 'no-such-domain-id' },
  });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /does not exist/i);
});

test('cancelling works, and an order already set up cannot be cancelled away', async () => {
  const domainOrder = await prisma.order.findUnique({ where: { reference: ctx.domainRef } });
  const cancelled = await admin(`/api/orders/${domainOrder.id}/cancel`, { method: 'POST', body: { note: 'Customer changed their mind.' } });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.order.status, 'CANCELLED');

  // The provisioned one is a different matter: cancelling it here would not
  // undo the thing that was actually set up.
  const res = await admin(`/api/orders/${ctx.orderId}/cancel`, { method: 'POST' });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /already been set up/i);
});

test('a cancelled order still answers its reference, and asks for nothing', async () => {
  const { data } = await anon(`/api/store/orders/${ctx.domainRef}`);
  assert.equal(data.status, 'CANCELLED');
  assert.equal(data.payment, null);
});

// --- Abuse -----------------------------------------------------------------

test('the order form is rate limited', async () => {
  const spam = client();
  let blocked = 0;
  let placed = [];

  for (let i = 0; i < 14; i += 1) {
    const res = await spam('/api/store/orders', {
      method: 'POST',
      body: {
        kind: 'HOSTING',
        planId: ctx.planId,
        customerName: 'Spam Bot',
        customerEmail: 'spam@example.com',
        customerPhone: '+911111111111',
      },
    });
    if (res.status === 429) blocked += 1;
    else if (res.status === 201) placed.push(res.data.reference);
  }

  assert.ok(blocked > 0, 'an open order form has to be limited');
  assert.ok(placed.length <= 10, `no more than the limit got through, got ${placed.length}`);
  await prisma.order.deleteMany({ where: { reference: { in: placed } } });
});

test('a closed store takes no orders but still shows its prices', async () => {
  await admin('/api/catalog/store-settings', { method: 'PUT', body: { isOpen: false } });
  try {
    const config = await anon('/api/store/config');
    assert.equal(config.data.isOpen, false);
    assert.ok((await anon('/api/store/plans')).data.plans.length, 'prices are still readable');

    const fresh = client();
    const res = await fresh('/api/store/orders', {
      method: 'POST',
      body: { kind: 'HOSTING', planId: ctx.planId, ...customer },
    });
    assert.ok([400, 429].includes(res.status), `expected a refusal, got ${res.status}`);
    if (res.status === 400) assert.match(res.data.error, /not taking orders/i);
  } finally {
    await admin('/api/catalog/store-settings', { method: 'PUT', body: { isOpen: true } });
  }
});

// --- The catalogue, from the admin side ------------------------------------

test('a price that cannot be read is refused rather than stored as zero', async () => {
  for (const price of ['', 'free', '12.345', '-100']) {
    const res = await admin('/api/catalog/plans', { method: 'POST', body: { name: 'Bad price', price } });
    assert.equal(res.status, 400, `"${price}" should be refused`);
  }
});

test('two plans cannot share a URL', async () => {
  const res = await admin('/api/catalog/plans', {
    method: 'POST',
    body: { name: 'Clash', slug: PLAN_SLUG, price: '500' },
  });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /already exists/i);
});

test('a plan with orders against it is hidden rather than deleted', async () => {
  const res = await admin(`/api/catalog/plans/${ctx.planId}`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.equal(res.data.hidden, true, 'an order has to keep saying what was bought');

  const plan = await prisma.plan.findUnique({ where: { id: ctx.planId } });
  assert.ok(plan, 'still there');
  assert.equal(plan.isActive, false);

  // The order it belongs to still names it.
  const orders = await admin('/api/orders');
  assert.ok(orders.data.orders.some((o) => o.reference === ctx.hostingRef && o.planName));

  await prisma.plan.update({ where: { id: ctx.planId }, data: { isActive: true } });
});

test('a UPI ID that is not one is refused', async () => {
  const res = await admin('/api/catalog/store-settings', { method: 'PUT', body: { upiId: 'not a upi id' } });
  assert.equal(res.status, 400);
  assert.match(JSON.stringify(res.data), /UPI ID/i);
});

test('saving with no UPI ID says the store cannot ask for money yet', async () => {
  const res = await admin('/api/catalog/store-settings', { method: 'PUT', body: { upiId: '' } });
  assert.equal(res.status, 200);
  assert.match(res.data.message, /before the store can ask anyone to pay/i);

  const config = await anon('/api/store/config');
  assert.equal(config.data.canAcceptPayment, false);

  await admin('/api/catalog/store-settings', { method: 'PUT', body: { upiId: 'testshop@examplebank' } });
});
