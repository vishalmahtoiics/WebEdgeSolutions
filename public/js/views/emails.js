import { api, el, statusBadge, emptyState, formatMb } from '../core.js';
import { navigate } from '../app.js';

/// Every mailbox across the domains the signed-in user can reach.
export async function renderEmails({ user }) {
  const isAdmin = user.role === 'SUPER_ADMIN';
  const { emails } = await api('/dashboard/my-emails');

  const frag = el('div');
  frag.append(
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        { class: 'grow' },
        el('h1', {}, 'Emails'),
        el('p', {}, 'Mailboxes across your domains. Open a domain to add or edit one.'),
      ),
    ),
  );

  if (!emails.length) {
    frag.append(
      el(
        'div',
        { class: 'card' },
        el(
          'div',
          { class: 'card-body' },
          emptyState('mail', 'No mailboxes yet', 'Open a domain and use the Emails tab to load or add mailboxes.'),
        ),
      ),
    );
    return frag;
  }

  // Grouped by domain, matching how the admin thinks about them.
  const byDomain = new Map();
  for (const m of emails) {
    if (!byDomain.has(m.domain.id)) byDomain.set(m.domain.id, { domain: m.domain, list: [] });
    byDomain.get(m.domain.id).list.push(m);
  }

  for (const { domain, list } of byDomain.values()) {
    frag.append(
      el(
        'div',
        { class: 'card' },
        el(
          'div',
          { class: 'card-head' },
          el('div', { class: 'grow' }, el('h2', {}, domain.name), el('p', {}, `${list.length} mailbox${list.length === 1 ? '' : 'es'}`)),
          el('button', { class: 'btn sm', onclick: () => navigate(`domain/${domain.id}`) }, 'Manage domain'),
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
                el('th', {}, 'Address'),
                el('th', {}, 'Status'),
                el('th', {}, 'Usage'),
                isAdmin ? el('th', {}, 'Source') : null,
              ),
            ),
            el(
              'tbody',
              {},
              list.map((m) =>
                el(
                  'tr',
                  {},
                  el('td', { class: 'strong break' }, m.address),
                  el('td', {}, statusBadge(m.status)),
                  el('td', { class: 'small muted' }, m.usedMb != null || m.quotaMb != null ? `${formatMb(m.usedMb)} / ${formatMb(m.quotaMb)}` : '—'),
                  isAdmin
                    ? el('td', {}, el('span', { class: `badge ${m.isFromProvider ? 'accent' : ''}` }, m.isFromProvider ? 'Provider' : 'Manual'))
                    : null,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  return frag;
}
