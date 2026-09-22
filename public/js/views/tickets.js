// Support.
//
// The same view for both roles, and the difference is what the server sends:
// a customer gets their own tickets and no internal notes, the Super Admin
// gets everything. Nothing here decides who may see what — the page simply
// draws what it was given, which is the only arrangement where an interface
// bug cannot become a disclosure.

import {
  api, el, clear, fill, appendAll, field, submitHandler, toast, errorAlert,
  emptyState, relativeTime, formatDate, openModal,
} from '../core.js';
import { icon } from '../icons.js';
import { navigate, refresh } from '../app.js';

const STATUS_LABEL = {
  OPEN: 'Open',
  AWAITING_SUPPORT: 'Waiting on us',
  AWAITING_CUSTOMER: 'Waiting on you',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
};

const STATUS_TONE = {
  OPEN: 'accent',
  AWAITING_SUPPORT: 'warn',
  AWAITING_CUSTOMER: '',
  RESOLVED: 'ok',
  CLOSED: '',
};

const PRIORITY_TONE = { URGENT: 'danger', HIGH: 'warn', NORMAL: '', LOW: '' };

/// "Waiting on you" reads the other way round depending on who is looking.
const statusLabel = (status, isAdmin) => {
  if (status === 'AWAITING_SUPPORT') return isAdmin ? 'Waiting on us' : 'With support';
  if (status === 'AWAITING_CUSTOMER') return isAdmin ? 'Waiting on the customer' : 'Waiting on you';
  return STATUS_LABEL[status] || status;
};

export async function renderTickets({ param, user }) {
  if (param) return renderThread(param, user);

  const isAdmin = user.role === 'SUPER_ADMIN';
  const { tickets, waitingOnSupport, categories } = await api('/tickets');
  const [{ domains }] = isAdmin ? [{ domains: [] }] : [await api('/domains').catch(() => ({ domains: [] }))];

  const frag = el('div');
  appendAll(frag, [
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        { class: 'grow' },
        el('h1', {}, 'Support'),
        el(
          'p',
          {},
          isAdmin
            ? 'Everything your customers have asked for, with the whole conversation kept.'
            : 'Ask us anything. Every message is kept here so nothing gets lost in a chat.',
        ),
      ),
      el(
        'button',
        { class: 'btn primary', onclick: () => openNew(categories, domains, isAdmin) },
        icon('lifebuoy', 16),
        isAdmin ? 'Raise a ticket' : 'New request',
      ),
    ),

    isAdmin && waitingOnSupport
      ? el(
          'div',
          { class: 'alert warn' },
          el('span', { class: 'strong' }, `${waitingOnSupport} ticket${waitingOnSupport === 1 ? '' : 's'} waiting on a reply. `),
          'The customer spoke last.',
        )
      : null,

    ticketList(tickets, isAdmin),
  ]);
  return frag;
}

function ticketList(tickets, isAdmin) {
  const body = el('div', { class: 'card-body tight table-scroll' });

  if (!tickets.length) {
    fill(
      body,
      el(
        'div',
        { style: 'padding:24px' },
        emptyState(
          'lifebuoy',
          'Nothing open',
          isAdmin ? 'When a customer asks for something it will appear here.' : 'Open a request and we will pick it up.',
        ),
      ),
    );
  } else {
    fill(
      body,
      el(
        'table',
        {},
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            el('th', {}, 'Ref'),
            el('th', {}, 'Subject'),
            isAdmin ? el('th', {}, 'From') : null,
            el('th', {}, 'Status'),
            el('th', {}, 'Last reply'),
            el('th', {}, ''),
          ),
        ),
        el(
          'tbody',
          {},
          tickets.map((t) =>
            el(
              'tr',
              {},
              el('td', { class: 'mono small muted nowrap' }, t.reference),
              el(
                'td',
                {},
                el('span', { class: 'strong small' }, t.subject),
                el(
                  'div',
                  { class: 'small muted' },
                  t.category ? `${t.category} · ` : '',
                  `${t._count?.messages ?? 0} message${t._count?.messages === 1 ? '' : 's'}`,
                  t.domain ? ` · ${t.domain.name}` : '',
                ),
              ),
              isAdmin ? el('td', { class: 'small' }, t.user?.name, el('div', { class: 'small muted' }, t.user?.email)) : null,
              el(
                'td',
                {},
                el('span', { class: `badge ${STATUS_TONE[t.status] || ''}` }, statusLabel(t.status, isAdmin)),
                t.priority !== 'NORMAL'
                  ? el('div', { style: 'margin-top:4px' }, el('span', { class: `badge ${PRIORITY_TONE[t.priority]}` }, t.priority.toLowerCase()))
                  : null,
              ),
              el(
                'td',
                { class: 'small muted nowrap', title: formatDate(t.lastReplyAt, { withTime: true }) },
                relativeTime(t.lastReplyAt),
              ),
              el('td', { class: 'right' }, el('button', { class: 'btn sm', onclick: () => navigate(`support/${t.id}`) }, 'Open')),
            ),
          ),
        ),
      ),
    );
  }

  return el(
    'div',
    { class: 'card', style: 'margin-top:18px' },
    el('div', { class: 'card-head' }, el('div', { class: 'grow' }, el('h2', {}, 'Tickets'), el('p', {}, `${tickets.length} in the list`))),
    body,
  );
}

// ---------------------------------------------------------------------------
// One thread
// ---------------------------------------------------------------------------

async function renderThread(id, user) {
  const isAdmin = user.role === 'SUPER_ADMIN';
  const { ticket } = await api(`/tickets/${id}`);

  const reply = el('textarea', { rows: 5, placeholder: isAdmin ? 'Write your reply…' : 'Add to your request…' });
  const internal = el('input', { type: 'checkbox' });
  const statusSelect = el(
    'select',
    { style: 'max-width:200px' },
    ...['AWAITING_CUSTOMER', 'AWAITING_SUPPORT', 'OPEN', 'RESOLVED', 'CLOSED'].map((s) =>
      el('option', { value: s, selected: s === (isAdmin ? 'AWAITING_CUSTOMER' : ticket.status) }, statusLabel(s, isAdmin)),
    ),
  );
  const alertHost = el('div');
  const send = el('button', { class: 'btn primary' }, 'Send reply');

  send.onclick = submitHandler(send, alertHost, async () => {
    if (!reply.value.trim()) throw new Error('Write something first.');
    await api(`/tickets/${ticket.id}/reply`, {
      method: 'POST',
      body: {
        body: reply.value,
        isInternal: isAdmin ? internal.checked : false,
        status: isAdmin ? statusSelect.value : undefined,
      },
    });
    toast(internal.checked ? 'Note saved.' : 'Reply sent.', 'ok');
    refresh();
  });

  const closed = ticket.status === 'CLOSED';

  const frag = el('div');
  appendAll(frag, [
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        { class: 'grow' },
        el('h1', {}, ticket.subject),
        el(
          'p',
          {},
          el('span', { class: 'mono' }, ticket.reference),
          ticket.category ? ` · ${ticket.category}` : '',
          ticket.domain ? ` · ${ticket.domain.name}` : '',
          isAdmin && ticket.user ? ` · ${ticket.user.name} <${ticket.user.email}>` : '',
        ),
      ),
      el(
        'div',
        { style: 'display:flex;gap:9px;align-items:center;flex-wrap:wrap' },
        el('span', { class: `badge ${STATUS_TONE[ticket.status] || ''}` }, statusLabel(ticket.status, isAdmin)),
        el('button', { class: 'btn', onclick: () => navigate('support') }, 'Back'),
      ),
    ),

    el(
      'div',
      { class: 'card' },
      el('div', { class: 'card-body' }, ...ticket.messages.map((m) => messageBubble(m, isAdmin))),
    ),

    closed && !isAdmin
      ? el(
          'div',
          { class: 'alert info', style: 'margin-top:18px' },
          'This ticket is closed. Open a new request and mention ',
          el('span', { class: 'mono' }, ticket.reference),
          ' if you need to pick it up again.',
        )
      : el(
          'div',
          { class: 'card', style: 'margin-top:18px' },
          el('div', { class: 'card-head' }, el('h2', {}, isAdmin ? 'Reply' : 'Add a message')),
          el(
            'div',
            { class: 'card-body' },
            alertHost,
            field('', reply),
            isAdmin
              ? el(
                  'div',
                  { class: 'form-row', style: 'align-items:flex-end' },
                  field('Set status to', statusSelect),
                  el(
                    'label',
                    { class: 'check', style: 'margin-bottom:14px' },
                    internal,
                    el(
                      'span',
                      {},
                      el('span', { class: 'strong' }, 'Internal note'),
                      el('div', { class: 'small muted' }, 'Only you see it. The customer is not emailed and the status does not move.'),
                    ),
                  ),
                )
              : null,
            send,
            !isAdmin
              ? el('p', { class: 'hint', style: 'margin-top:10px' }, 'We are emailed as soon as you send this.')
              : null,
          ),
        ),
  ]);
  return frag;
}

function messageBubble(message, isAdmin) {
  const fromSupport = message.authorRole === 'SUPER_ADMIN';

  return el(
    'div',
    {
      class: 'ticket-msg',
      style: message.isInternal
        ? 'border-left:3px solid var(--warn,#d97706);background:rgba(217,119,6,.06)'
        : fromSupport
          ? 'border-left:3px solid var(--accent,#4f46e5)'
          : 'border-left:3px solid var(--border,#e2e8f0)',
    },
    el(
      'div',
      { class: 'ticket-msg-head' },
      el('span', { class: 'strong small' }, message.authorLabel),
      message.isInternal ? el('span', { class: 'badge warn' }, 'internal note') : null,
      el(
        'span',
        { class: 'small muted', title: formatDate(message.createdAt, { withTime: true }) },
        relativeTime(message.createdAt),
      ),
    ),
    el('div', { style: 'white-space:pre-wrap;margin-top:6px' }, message.body),
  );
}

// ---------------------------------------------------------------------------
// Opening one
// ---------------------------------------------------------------------------

function openNew(categories, domains, isAdmin) {
  const subject = el('input', { type: 'text', placeholder: 'Website is loading slowly' });
  const body = el('textarea', { rows: 6, placeholder: 'What is happening, and when did it start?' });
  const category = el(
    'select',
    {},
    el('option', { value: '' }, 'Choose one'),
    ...(categories || []).map((c) => el('option', { value: c }, c)),
  );
  const priority = el(
    'select',
    {},
    ...['LOW', 'NORMAL', 'HIGH', 'URGENT'].map((p) =>
      el('option', { value: p, selected: p === 'NORMAL' }, p.charAt(0) + p.slice(1).toLowerCase()),
    ),
  );
  const domain = el(
    'select',
    {},
    el('option', { value: '' }, 'Not about a specific domain'),
    ...(domains || []).map((d) => el('option', { value: d.id }, d.name)),
  );

  const alertHost = el('div');
  const go = el('button', { class: 'btn primary' }, 'Send it');

  const close = openModal({
    title: isAdmin ? 'Raise a ticket' : 'New support request',
    render: () =>
      el(
        'div',
        {},
        alertHost,
        field('Subject', subject),
        el('div', { class: 'form-row' }, field('Category', category), field('How urgent', priority)),
        domains?.length ? field('Domain', domain) : null,
        field('What is happening', body),
        el(
          'p',
          { class: 'hint' },
          'Kept here in full, so you can always look back at what was asked and what we answered.',
        ),
      ),
    footer: () => go,
  });

  subject.focus();

  go.onclick = submitHandler(go, alertHost, async () => {
    const { ticket } = await api('/tickets', {
      method: 'POST',
      body: {
        subject: subject.value,
        body: body.value,
        category: category.value || undefined,
        priority: priority.value,
        domainId: domain.value || undefined,
      },
    });
    close();
    toast(`Opened ${ticket.reference}.`, 'ok');
    navigate(`support/${ticket.id}`);
  });
}
