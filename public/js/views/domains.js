import {
  api, el, field, submitHandler, toast, openModal, statusBadge, sourceBadge,
  emptyState, formatDate,
} from '../core.js';
import { refresh, navigate } from '../app.js';

export async function renderDomains({ user }) {
  const { domains } = await api('/domains');
  const isAdmin = user.role === 'SUPER_ADMIN';

  const frag = el('div');
  frag.append(
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        { class: 'grow' },
        el('h1', {}, isAdmin ? 'Domains' : 'My Domains'),
        el(
          'p',
          {},
          isAdmin
            ? 'Every domain in the portal, whether synced from a provider or added by hand.'
            : 'The domains assigned to your account.',
        ),
      ),
      isAdmin
        ? el(
            'div',
            { class: 'page-actions' },
            el('button', { class: 'btn', onclick: () => navigate('providers') }, 'Sync from provider'),
            el('button', { class: 'btn primary', onclick: addDomainModal }, '+ Add Domain'),
          )
        : null,
    ),
  );

  if (!domains.length) {
    frag.append(
      el(
        'div',
        { class: 'card' },
        el(
          'div',
          { class: 'card-body' },
          emptyState(
            '🌐',
            'No domains yet',
            isAdmin
              ? 'Connect a provider and click Sync, or add a domain manually.'
              : 'No domains have been assigned to your account yet.',
          ),
        ),
      ),
    );
    return frag;
  }

  const search = el('input', {
    type: 'text',
    placeholder: 'Search domains…',
    style: 'max-width:280px',
  });

  const tbody = el('tbody');
  const draw = (list) => {
    tbody.replaceChildren(
      ...list.map((d) =>
        el(
          'tr',
          { style: 'cursor:pointer', onclick: () => navigate(`domain/${d.id}`) },
          el('td', {}, el('div', { class: 'strong' }, d.name)),
          el('td', {}, sourceBadge(d.sourceLabel, d.source)),
          el('td', {}, statusBadge(d.status)),
          el('td', { class: 'small muted nowrap' }, formatDate(d.expiresAt)),
          el('td', { class: 'small' }, String(d.emailCount)),
          isAdmin ? el('td', { class: 'small' }, String(d.userCount)) : null,
          el(
            'td',
            { class: 'actions' },
            el(
              'button',
              {
                class: 'btn sm',
                onclick: (e) => {
                  e.stopPropagation();
                  navigate(`domain/${d.id}`);
                },
              },
              'Manage',
            ),
          ),
        ),
      ),
    );
    if (!list.length) {
      tbody.append(el('tr', {}, el('td', { colspan: isAdmin ? 7 : 6 }, emptyState('search', 'No matches'))));
    }
  };

  search.oninput = () => {
    const q = search.value.trim().toLowerCase();
    draw(q ? domains.filter((d) => d.name.includes(q)) : domains);
  };
  draw(domains);

  frag.append(
    el(
      'div',
      { class: 'card' },
      el(
        'div',
        { class: 'card-head' },
        el('div', { class: 'grow' }, el('h2', {}, `${domains.length} domain${domains.length === 1 ? '' : 's'}`)),
        search,
      ),
      el(
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
              el('th', {}, 'Domain'),
              el('th', {}, 'Provider'),
              el('th', {}, 'Status'),
              el('th', {}, 'Expires'),
              el('th', {}, 'Emails'),
              isAdmin ? el('th', {}, 'Users') : null,
              el('th', {}, ''),
            ),
          ),
          tbody,
        ),
      ),
    ),
  );

  return frag;
}

function addDomainModal() {
  const name = el('input', { type: 'text', placeholder: 'example.com' });
  const status = el(
    'select',
    {},
    ['active', 'pending', 'suspended', 'expired'].map((s) =>
      el('option', { value: s }, s[0].toUpperCase() + s.slice(1)),
    ),
  );
  const alertHost = el('div');
  const save = el('button', { class: 'btn primary' }, 'Add domain');

  save.onclick = submitHandler(save, alertHost, async () => {
    const { domain } = await api('/domains', {
      method: 'POST',
      body: { name: name.value.trim().toLowerCase(), status: status.value },
    });
    toast('Domain added.', 'ok');
    close();
    navigate(`domain/${domain.id}`);
  });

  const close = openModal({
    title: 'Add Domain Manually',
    render: () =>
      el(
        'div',
        {},
        alertHost,
        el(
          'div',
          { class: 'alert info' },
          'Manually added domains are labelled "Manually Added" and are never overwritten by a provider sync.',
        ),
        field('Domain name', name),
        field('Status', status),
      ),
    footer: (closeFn) => [el('button', { class: 'btn', onclick: closeFn }, 'Cancel'), save],
  });
}
