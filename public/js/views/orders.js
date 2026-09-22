// The orders queue. Super Admin only.
//
// This page exists because payment is not automatic. A UPI transfer cannot
// report itself back to a website, so somebody has to look at the bank account
// and say the money arrived — and this is where they do it. The wording
// throughout keeps that distinction: what the customer told us, and what
// somebody here has actually confirmed.

import {
  api, el, clear, fill, appendAll, field, submitHandler, toast, openModal,
  confirmModal, emptyState, formatDate, relativeTime,
} from '../core.js';
import { icon } from '../icons.js';
import { refresh, navigate } from '../app.js';

const STATUS = {
  PENDING_PAYMENT: { label: 'Awaiting payment', tone: 'warn' },
  PAYMENT_SUBMITTED: { label: 'Payment reported', tone: 'accent' },
  PAID: { label: 'Paid', tone: 'ok' },
  PROVISIONED: { label: 'Set up', tone: 'ok' },
  CANCELLED: { label: 'Cancelled', tone: '' },
};

let filter = { status: '', search: '' };

export async function renderOrders() {
  const params = new URLSearchParams();
  if (filter.status) params.set('status', filter.status);
  if (filter.search) params.set('search', filter.search);

  const { orders, counts, totals } = await api(`/orders?${params}`);

  const frag = el('div');
  const search = el('input', {
    type: 'search',
    placeholder: 'Reference, name, email, phone or domain…',
    value: filter.search,
    style: 'max-width:300px',
  });
  search.onkeydown = (e) => {
    if (e.key !== 'Enter') return;
    filter.search = search.value.trim();
    refresh();
  };

  const tab = (value, label) =>
    el(
      'button',
      {
        class: `btn sm ${filter.status === value ? 'primary' : ''}`,
        onclick: () => {
          filter.status = value;
          refresh();
        },
      },
      label,
      value && counts[value] ? el('span', { class: 'badge', style: 'margin-left:7px' }, String(counts[value])) : null,
    );

  appendAll(frag, [
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        { class: 'grow' },
        el('h1', {}, 'Orders'),
        el('p', {}, 'Everything ordered from the public site. Nothing here is confirmed until you confirm it.'),
      ),
      el('div', { class: 'page-actions' }, el('button', { class: 'btn', onclick: () => navigate('plans') }, 'Plans & pricing')),
    ),
    el(
      'div',
      { class: 'grid-2', style: 'margin-bottom:18px' },
      statCard('Waiting to be paid', totals.awaiting, `${(counts.PENDING_PAYMENT || 0) + (counts.PAYMENT_SUBMITTED || 0)} order(s)`),
      statCard('Confirmed received', totals.collected, `${(counts.PAID || 0) + (counts.PROVISIONED || 0)} order(s)`),
    ),
    counts.PAYMENT_SUBMITTED
      ? el(
          'div',
          { class: 'alert info' },
          el('span', { class: 'strong' }, `${counts.PAYMENT_SUBMITTED} order${counts.PAYMENT_SUBMITTED === 1 ? '' : 's'} waiting on you. `),
          'A customer says they have paid. Check your account, then confirm or cancel.',
        )
      : null,
    el(
      'div',
      { class: 'card' },
      el(
        'div',
        { class: 'card-head' },
        el(
          'div',
          { class: 'grow', style: 'display:flex;gap:7px;flex-wrap:wrap' },
          tab('', 'All'),
          tab('PAYMENT_SUBMITTED', 'Reported'),
          tab('PENDING_PAYMENT', 'Awaiting'),
          tab('PAID', 'Paid'),
          tab('PROVISIONED', 'Set up'),
          tab('CANCELLED', 'Cancelled'),
        ),
        search,
      ),
      orders.length
        ? el(
            'div',
            { class: 'card-body tight table-scroll' },
            el(
              'table',
              {},
              el(
                'thead',
                {},
                el(
                  'tr',
                  {},
                  el('th', {}, 'Reference'),
                  el('th', {}, 'What'),
                  el('th', {}, 'Customer'),
                  el('th', {}, 'Amount'),
                  el('th', {}, 'Status'),
                  el('th', {}, 'Placed'),
                  el('th', {}, ''),
                ),
              ),
              el('tbody', {}, orders.map(row)),
            ),
          )
        : el(
            'div',
            { class: 'card-body' },
            emptyState(
              'globe',
              filter.status || filter.search ? 'No orders match' : 'No orders yet',
              filter.status || filter.search
                ? 'Try a different filter.'
                : 'Orders from the public site land here. Check Plans & pricing if the site has nothing to sell yet.',
            ),
          ),
    ),
  ]);

  return frag;
}

const statCard = (label, value, sub) =>
  el(
    'div',
    { class: 'card' },
    el(
      'div',
      { class: 'card-body' },
      el('div', { class: 'small muted' }, label),
      el('div', { style: 'font-size:27px;font-weight:700;letter-spacing:-.02em;margin-top:2px' }, value),
      el('div', { class: 'small muted' }, sub),
    ),
  );

function row(order) {
  const status = STATUS[order.status] || { label: order.status, tone: '' };

  return el(
    'tr',
    { style: 'cursor:pointer', onclick: () => orderModal(order) },
    el('td', { class: 'mono small strong break' }, order.reference),
    el(
      'td',
      {},
      el('div', { class: 'small strong' }, order.planName || (order.tld ? `.${order.tld} domain` : order.kind)),
      order.domainName ? el('div', { class: 'small muted mono break' }, order.domainName) : null,
    ),
    el(
      'td',
      {},
      el('div', { class: 'small' }, order.customerName),
      el('div', { class: 'small muted break' }, order.customerPhone),
    ),
    el('td', { class: 'strong small nowrap' }, order.amount),
    el(
      'td',
      {},
      el('span', { class: `badge ${status.tone}` }, status.label),
      order.claimedPaymentReference && order.status === 'PAYMENT_SUBMITTED'
        ? el('div', { class: 'small muted mono break', style: 'margin-top:3px' }, order.claimedPaymentReference)
        : null,
    ),
    el('td', { class: 'small muted nowrap' }, relativeTime(order.createdAt)),
    el(
      'td',
      { class: 'actions' },
      el(
        'button',
        {
          class: 'btn sm',
          onclick: (e) => {
            e.stopPropagation();
            orderModal(order);
          },
        },
        'Open',
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// One order
// ---------------------------------------------------------------------------

function orderModal(order) {
  const status = STATUS[order.status] || { label: order.status, tone: '' };
  const alertHost = el('div');
  const notes = el('textarea', { rows: 3, placeholder: 'Anything worth remembering about this order' }, order.adminNotes || '');

  const act = (path, body, label) => {
    const button = el('button', { class: 'btn primary' }, label);
    button.onclick = submitHandler(button, alertHost, async () => {
      const res = await api(`/orders/${order.id}/${path}`, { method: 'POST', body: body() });
      close();
      toast(res.message, 'ok');
      refresh();
    });
    return button;
  };

  const rows = [
    ['Reference', el('span', { class: 'mono strong' }, order.reference)],
    ['What', order.planName || (order.tld ? `.${order.tld} domain registration` : order.kind)],
    ['Domain', order.domainName ? el('span', { class: 'mono' }, order.domainName) : el('span', { class: 'muted' }, 'not given')],
    ['Amount', el('span', { class: 'strong' }, order.amount)],
    ['Status', el('span', { class: `badge ${status.tone}` }, status.label)],
    ['Placed', formatDate(order.createdAt, { withTime: true })],
    ['Name', order.customerName],
    ['Email', el('a', { href: `mailto:${order.customerEmail}` }, order.customerEmail)],
    ['Phone', order.customerPhone],
  ];

  if (order.message) rows.push(['Their message', el('span', { class: 'break' }, order.message)]);
  if (order.claimedPaymentReference) {
    rows.push([
      'Reference they gave',
      el(
        'span',
        {},
        el('span', { class: 'mono' }, order.claimedPaymentReference),
        el('div', { class: 'small muted' }, `Reported ${relativeTime(order.paymentSubmittedAt)} — unverified`),
      ),
    ]);
  }
  if (order.paidAt) {
    rows.push([
      'Payment confirmed',
      el(
        'span',
        {},
        formatDate(order.paidAt, { withTime: true }),
        order.confirmedBy ? el('div', { class: 'small muted' }, `by ${order.confirmedBy.name}`) : null,
      ),
    ]);
  }
  if (order.provisionedAt) rows.push(['Set up', formatDate(order.provisionedAt, { withTime: true })]);
  if (order.linkedDomain) {
    rows.push([
      'Linked domain',
      el('a', { href: `#/domain/${order.linkedDomain.id}`, onclick: () => close() }, order.linkedDomain.name),
    ]);
  }
  if (order.linkedUser) rows.push(['Linked account', `${order.linkedUser.name} (${order.linkedUser.email})`]);

  const close = openModal({
    title: `Order ${order.reference}`,
    wide: true,
    render: () =>
      el(
        'div',
        {},
        alertHost,
        ['PENDING_PAYMENT', 'PAYMENT_SUBMITTED'].includes(order.status)
          ? el(
              'div',
              { class: 'alert warn' },
              order.status === 'PAYMENT_SUBMITTED'
                ? 'The customer says they have paid and given the reference below. Check it against your account before confirming — nothing about a UPI transfer can be verified from here.'
                : 'No payment reported yet. The customer has the payment details and their reference.',
            )
          : null,
        el(
          'dl',
          { class: 'dl' },
          rows.map(([label, value]) => el('div', {}, el('dt', {}, label), el('dd', {}, value))),
        ),
        el('div', { style: 'margin-top:16px' }, field('Internal notes', notes)),
        el(
          'div',
          { style: 'display:flex;gap:9px;flex-wrap:wrap' },
          order.whatsappLink
            ? el(
                'a',
                { class: 'btn sm', href: order.whatsappLink, target: '_blank', rel: 'noopener' },
                'WhatsApp the customer',
              )
            : null,
          el(
            'button',
            {
              class: 'btn sm',
              onclick: async () => {
                await api(`/orders/${order.id}/notes`, { method: 'PUT', body: { adminNotes: notes.value } });
                toast('Notes saved.', 'ok');
              },
            },
            'Save notes',
          ),
        ),
      ),
    footer: (closeFn) => {
      const buttons = [el('button', { class: 'btn', onclick: closeFn }, 'Close')];

      if (order.status !== 'CANCELLED' && order.status !== 'PROVISIONED') {
        buttons.push(
          el(
            'button',
            {
              class: 'btn danger',
              onclick: () =>
                confirmModal({
                  title: 'Cancel this order',
                  message: `Cancel ${order.reference}? The customer will see it as cancelled if they check their reference.`,
                  confirmLabel: 'Cancel order',
                  onConfirm: async () => {
                    const res = await api(`/orders/${order.id}/cancel`, { method: 'POST', body: { note: notes.value } });
                    close();
                    toast(res.message, 'ok');
                    refresh();
                  },
                }),
            },
            'Cancel order',
          ),
        );
      }

      if (['PENDING_PAYMENT', 'PAYMENT_SUBMITTED'].includes(order.status)) {
        buttons.push(act('confirm-payment', () => ({ note: notes.value }), 'I have received the money'));
      } else if (order.status === 'PAID') {
        buttons.push(
          el('button', { class: 'btn primary', onclick: () => provisionModal(order, close) }, 'Mark as set up'),
        );
      }

      return buttons;
    },
  });
}

/// Ties a paid order to what it became, so it stops being a loose end.
function provisionModal(order, closeParent) {
  const domainId = el('input', { type: 'text', placeholder: 'Domain id from the Domains page (optional)' });
  const userId = el('input', { type: 'text', placeholder: 'User id from the Users page (optional)' });
  const note = el('textarea', { rows: 2, placeholder: 'What you set up' });
  const alertHost = el('div');
  const save = el('button', { class: 'btn primary' }, 'Mark as set up');

  const close = openModal({
    title: `Set up ${order.reference}`,
    render: () =>
      el(
        'form',
        { onsubmit: (e) => e.preventDefault() },
        alertHost,
        el(
          'div',
          { class: 'alert info' },
          'Set the hosting or domain up first, then record it here. Linking it means this order points at the real thing afterwards.',
        ),
        field('Domain id', domainId, 'Open the domain in the portal — the id is in the address bar after #/domain/.'),
        field('User id', userId, 'Optional. Links the order to the portal account you created for them.'),
        field('Note', note),
      ),
    footer: (closeFn) => [el('button', { class: 'btn', onclick: closeFn }, 'Back'), save],
  });

  save.onclick = submitHandler(save, alertHost, async () => {
    const res = await api(`/orders/${order.id}/provision`, {
      method: 'POST',
      body: { domainId: domainId.value.trim(), userId: userId.value.trim(), note: note.value.trim() },
    });
    close();
    closeParent();
    toast(res.message, 'ok');
    refresh();
  });
}
