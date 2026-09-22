// Ordering, and paying for it.
//
// The flow is deliberately honest about what it can and cannot do. A UPI
// transfer cannot report itself back to a website, so nothing here claims an
// order is paid. It collects the order, shows how to pay, and then records that
// the customer says they have — clearly labelled as their word, not ours.

import {
  api, el, clear, fill, appendAll, field, submitHandler, toast, openModal,
  errorAlert, icon, copyRow, PERIOD,
} from './ui.js';

/// The order form. `item` describes what is being bought, already priced by
/// the server: { kind, planId, tld, name, price, billingPeriod, domainName }.
export function openOrderForm(item, config) {
  const name = el('input', { type: 'text', autocomplete: 'name', placeholder: 'Your full name' });
  const email = el('input', { type: 'email', autocomplete: 'email', placeholder: 'you@example.com' });
  const phone = el('input', { type: 'tel', autocomplete: 'tel', placeholder: '+91 98765 43210' });
  const domain = el('input', {
    type: 'text',
    value: item.domainName || '',
    placeholder: item.kind === 'DOMAIN' ? 'yourname.com' : 'yourname.com (optional)',
  });
  const message = el('textarea', { placeholder: 'Anything we should know?' });
  const alertHost = el('div');
  const submit = el('button', { class: 'btn primary' }, 'Place order');

  // A domain order already knows its name from the search, and changing it
  // would change the price, so it is fixed here.
  const domainLocked = item.kind === 'DOMAIN' && Boolean(item.domainName);
  if (domainLocked) domain.disabled = true;

  const close = openModal({
    title: 'Place your order',
    render: () =>
      el(
        'form',
        { onsubmit: (e) => e.preventDefault() },
        alertHost,
        el(
          'div',
          { class: 'alert info' },
          el('span', { class: 'strong' }, item.name),
          ' — ',
          item.price,
          item.billingPeriod ? PERIOD[item.billingPeriod] || '' : '',
        ),
        el(
          'div',
          { class: 'form-row' },
          field('Your name', name),
          field('Phone', phone, 'We will use WhatsApp for updates.'),
        ),
        field('Email', email),
        field(
          item.kind === 'DOMAIN' ? 'Domain' : 'Domain for this hosting',
          domain,
          domainLocked
            ? 'This is the name you searched for.'
            : item.kind === 'HOSTING'
              ? 'Leave blank if you have not chosen one yet.'
              : null,
        ),
        field('Message', message),
        el(
          'p',
          { class: 'tiny muted', style: 'margin:0' },
          'Placing an order does not charge you. You will be shown how to pay on the next step.',
        ),
      ),
    footer: (closeFn) => [el('button', { class: 'btn', onclick: closeFn }, 'Cancel'), submit],
  });

  submit.onclick = submitHandler(submit, alertHost, async () => {
    const result = await api('/orders', {
      method: 'POST',
      body: {
        kind: item.kind,
        planId: item.planId,
        tld: item.tld,
        domainName: domain.value.trim().toLowerCase(),
        customerName: name.value.trim(),
        customerEmail: email.value.trim(),
        customerPhone: phone.value.trim(),
        message: message.value.trim(),
      },
    });

    close();
    // The reference goes in the URL so the page can be reopened, shared, or
    // sent to somebody who is paying on the customer's behalf.
    window.location.hash = `#/order/${result.reference}`;
    showOrder(result.reference, config);
  });
}

const STATUS_TONE = {
  PENDING_PAYMENT: 'warn',
  PAYMENT_SUBMITTED: 'accent',
  PAID: 'ok',
  PROVISIONED: 'ok',
  CANCELLED: 'danger',
};

/// The order page: what was ordered, how to pay, and where it stands.
export async function renderOrderPage(reference, config) {
  const host = el('div', { class: 'section' }, el('div', { class: 'wrap muted' }, 'Loading your order…'));

  let order;
  try {
    order = await api(`/orders/${encodeURIComponent(reference)}`);
  } catch (err) {
    fill(
      host,
      el(
        'div',
        { class: 'wrap' },
        el('h1', {}, 'Order not found'),
        el('p', { class: 'muted', style: 'margin-top:12px' }, err.message),
        el('a', { class: 'btn', href: '#/', style: 'margin-top:22px' }, icon('back', 16), 'Back to plans'),
      ),
    );
    return host;
  }

  const body = el('div', { class: 'wrap' });
  fill(host, body);

  appendAll(body, [
    el(
      'div',
      { style: 'display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:6px' },
      el('span', { class: `badge ${STATUS_TONE[order.status] || ''}` }, order.statusText),
      el('span', { class: 'small muted' }, `Placed ${new Date(order.placedAt).toLocaleString()}`),
    ),
    el('h1', { style: 'margin-bottom:10px' }, order.status === 'PENDING_PAYMENT' ? 'Almost there' : 'Your order'),
    el(
      'p',
      { class: 'muted' },
      order.description,
      order.domainName ? ` · ${order.domainName}` : '',
      ` · ${order.amount}`,
    ),
    el('div', { style: 'margin:22px 0 28px' }, el('span', { class: 'ref-box' }, order.reference)),
    el(
      'p',
      { class: 'small muted', style: 'margin:-18px 0 28px' },
      'Keep this reference. Quote it when you pay and in any message to us.',
    ),
  ]);

  if (order.payment) body.append(paymentSection(order, config));
  else {
    body.append(
      el(
        'div',
        { class: 'pay-card' },
        el('h3', {}, order.status === 'CANCELLED' ? 'This order was cancelled' : 'Nothing left to pay'),
        el(
          'p',
          { class: 'muted', style: 'margin-top:8px' },
          order.status === 'PROVISIONED'
            ? 'Your service is set up. If anything looks wrong, message us with the reference above.'
            : order.status === 'PAID'
              ? 'We have your payment and are setting things up. We will be in touch.'
              : 'Message us if you think this is a mistake.',
        ),
        config.whatsappLink
          ? el('a', { class: 'btn wa', href: config.whatsappLink, target: '_blank', rel: 'noopener', style: 'margin-top:18px' }, icon('whatsapp', 17), 'Message us on WhatsApp')
          : null,
      ),
    );
  }

  return host;
}

function paymentSection(order, config) {
  const pay = order.payment;

  if (!pay.upiId) {
    return el(
      'div',
      { class: 'pay-card' },
      el('h3', {}, 'Payment is not set up yet'),
      el(
        'p',
        { class: 'muted', style: 'margin-top:8px' },
        'Your order is saved. Message us and we will tell you how to pay.',
      ),
      pay.whatsappLink
        ? el('a', { class: 'btn wa', href: pay.whatsappLink, target: '_blank', rel: 'noopener', style: 'margin-top:18px' }, icon('whatsapp', 17), 'Message us')
        : null,
    );
  }

  const paymentRef = el('input', { type: 'text', placeholder: 'e.g. 402912345678' });
  const alertHost = el('div');
  const confirm = el('button', { class: 'btn primary block' }, 'I have paid');
  const afterHost = el('div');

  confirm.onclick = submitHandler(confirm, alertHost, async () => {
    const res = await api(`/orders/${encodeURIComponent(order.reference)}/payment`, {
      method: 'POST',
      body: { paymentReference: paymentRef.value.trim() },
    });
    toast(res.message, 'ok');
    fill(
      afterHost,
      el('div', { class: 'alert ok', style: 'margin:16px 0 0' }, res.message),
    );
    confirm.disabled = true;
    clear(confirm).append('Reported — thank you');
  });

  const left = el(
    'div',
    { class: 'pay-card' },
    el('h3', {}, `Pay ${pay.amount} by UPI`),
    el(
      'ol',
      { class: 'steps', style: 'margin:18px 0 20px' },
      el('li', {}, 'Open any UPI app — GPay, PhonePe, Paytm, or your bank app.'),
      el('li', {}, el('span', {}, 'Pay ', el('span', { class: 'strong' }, pay.amount), ' to the UPI ID below.')),
      el('li', {}, el('span', {}, 'Put ', el('span', { class: 'strong mono' }, order.reference), ' in the note, so we can match it.')),
      el('li', {}, 'Come back here and tell us the reference your app gave you.'),
    ),
    el('div', { class: 'field' }, el('label', {}, 'UPI ID'), copyRow(pay.upiId)),
    pay.payeeName
      ? el(
          'p',
          { class: 'small muted', style: 'margin:-6px 0 18px' },
          `The name shown in your app should be ${pay.payeeName}. If it is not, stop and message us.`,
        )
      : null,
    pay.upiLink
      ? el(
          'a',
          { class: 'btn primary block', href: pay.upiLink, style: 'margin-bottom:10px' },
          icon('arrow', 16),
          `Open a UPI app and pay ${pay.amount}`,
        )
      : null,
    el(
      'p',
      { class: 'tiny muted', style: 'margin:0 0 22px' },
      'That button works on a phone. On a computer, scan the code instead.',
    ),
    el('hr', { style: 'border:0;border-top:1px solid var(--border);margin:0 0 22px' }),
    el('h3', {}, 'Once you have paid'),
    el(
      'div',
      { class: 'alert warn', style: 'margin:14px 0' },
      icon('clock', 15),
      ' ',
      pay.verificationNote,
    ),
    alertHost,
    field('Payment reference from your app', paymentRef, 'The UTR or transaction ID. It helps us find your payment.'),
    confirm,
    afterHost,
    pay.whatsappLink
      ? el(
          'a',
          { class: 'btn wa block', href: pay.whatsappLink, target: '_blank', rel: 'noopener', style: 'margin-top:10px' },
          icon('whatsapp', 17),
          'Send us the details on WhatsApp',
        )
      : null,
    pay.supportEmail
      ? el('p', { class: 'small muted center', style: 'margin-top:14px' }, 'Or email ', el('a', { href: `mailto:${pay.supportEmail}` }, pay.supportEmail))
      : null,
  );

  const qr = el(
    'div',
    {},
    el('div', { class: 'qr' }, el('img', {
      src: `/api/store/orders/${encodeURIComponent(order.reference)}/qr.svg`,
      alt: `UPI payment code for ${order.reference}`,
      style: 'display:block;width:100%;height:auto',
    })),
    el('p', { class: 'tiny muted center', style: 'margin-top:10px' }, `Scan to pay ${pay.amount}`),
  );

  return el('div', { class: 'pay-grid' }, left, qr);
}

/// Opens an order by reference, from the form or from a link.
export async function showOrder(reference, config) {
  const app = document.getElementById('app');
  fill(app, el('div', {}));
  // The shell re-renders around the order page; the router handles the rest.
  window.dispatchEvent(new CustomEvent('store:navigate', { detail: { route: 'order', param: reference } }));
}

/// A small form for looking up an order somebody has the reference for.
export function openLookup() {
  const ref = el('input', { type: 'text', placeholder: 'WES-XXXXX-XXXXX', autocomplete: 'off' });
  const alertHost = el('div');
  const go = el('button', { class: 'btn primary' }, 'Find order');

  const close = openModal({
    title: 'Find your order',
    render: () =>
      el(
        'form',
        { onsubmit: (e) => e.preventDefault() },
        alertHost,
        field('Order reference', ref, 'The code we gave you when you ordered.'),
      ),
    footer: (closeFn) => [el('button', { class: 'btn', onclick: closeFn }, 'Cancel'), go],
  });

  go.onclick = submitHandler(go, alertHost, async () => {
    const reference = ref.value.trim().toUpperCase();
    if (!reference) throw new Error('Enter your order reference.');
    // Checked before navigating, so a wrong code says so here rather than
    // dropping the person on an error page.
    await api(`/orders/${encodeURIComponent(reference)}`);
    close();
    window.location.hash = `#/order/${reference}`;
  });
}
