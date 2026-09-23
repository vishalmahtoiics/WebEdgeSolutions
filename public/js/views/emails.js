import { api, el, statusBadge, emptyState, formatMb, tableView } from '../core.js';
import { navigate } from '../app.js';
import {
  createMailboxModal,
  passwordModal,
  deleteMailboxModal,
  bulkDeleteMailboxesModal,
  emailModal,
} from './mailbox-modals.js';

/// Every mailbox across the domains the signed-in user can reach, with the
/// same actions available on the domain page. Someone whose job is email
/// should not have to go domain by domain to do it.
export async function renderEmails({ user }) {
  const isAdmin = user.role === 'SUPER_ADMIN';
  const { domains } = await api('/dashboard/my-emails');

  const total = domains.reduce((sum, d) => sum + d.emails.length, 0);

  const frag = el('div');
  frag.append(
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        { class: 'grow' },
        el('h1', {}, 'Emails'),
        el(
          'p',
          {},
          total
            ? `${total} mailbox${total === 1 ? '' : 'es'} across ${domains.length} domain${domains.length === 1 ? '' : 's'}.`
            : 'Mailboxes across your domains.',
        ),
      ),
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
            'mail',
            'No domains yet',
            isAdmin
              ? 'Add or sync a domain first, then its mailboxes appear here.'
              : 'No domains have been assigned to your account yet.',
          ),
        ),
      ),
    );
    return frag;
  }

  for (const domain of domains) {
    frag.append(domainCard(domain, isAdmin));
  }

  return frag;
}

function domainCard(domain, isAdmin) {
  // Paired with the text to search on, so a domain with fifty mailboxes can be
  // narrowed to the one being looked for instead of scrolled through.
  const rows = domain.emails.map((m) => ({
    id: m.id,
    data: m,
    text: `${m.address} ${m.status || ''}`,
    node: el(
      'tr',
      {},
      el('td', { class: 'strong break' }, m.address),
      el('td', {}, statusBadge(m.status)),
      el(
        'td',
        { class: 'small nowrap' },
        m.usedMb != null || m.quotaMb != null
          ? el('span', { class: 'muted' }, `${formatMb(m.usedMb)} / ${formatMb(m.quotaMb)}`)
          : el('span', { class: 'muted' }, '—'),
        // Admins see at a glance which figures were set by hand.
        isAdmin && (m.usesCustomQuota || m.usesCustomUsed)
          ? el('span', { class: 'badge', style: 'margin-left:8px' }, 'Custom')
          : null,
      ),
      isAdmin
        ? el(
            'td',
            {},
            el(
              'span',
              { class: `badge ${m.isFromProvider ? 'accent' : ''}` },
              m.isFromProvider ? 'Provider' : 'Manual',
            ),
          )
        : null,
      el(
        'td',
        { class: 'actions' },
        el(
          'button',
          { class: 'btn sm primary', onclick: () => navigate(`mail/${domain.id}~${m.id}`) },
          'Open inbox',
        ),
        ' ',
        el('button', { class: 'btn sm', onclick: () => emailModal(domain.id, m) }, 'Edit'),
        ' ',
        // A password only exists upstream, so only a live mailbox offers it.
        domain.canManageEmail && (m.externalId || m.isManaged)
          ? [el('button', { class: 'btn sm', onclick: () => passwordModal(domain.id, m) }, 'Password'), ' ']
          : null,
        el(
          'button',
          {
            class: 'btn sm danger',
            onclick: () => deleteMailboxModal(domain, m, domain.canManageEmail),
          },
          'Delete',
        ),
      ),
    ),
  }));

  return el(
    'div',
    { class: 'card' },
    el(
      'div',
      { class: 'card-head' },
      el(
        'div',
        { class: 'grow' },
        el('h2', {}, domain.name),
        el(
          'p',
          {},
          domain.emails.length
            ? `${domain.emails.length} mailbox${domain.emails.length === 1 ? '' : 'es'}`
            : 'No mailboxes yet',
        ),
      ),
      el('button', { class: 'btn sm', onclick: () => navigate(`domain/${domain.id}`) }, 'Open domain'),
      el('button', { class: 'btn sm', onclick: () => emailModal(domain.id) }, '+ Track Manually'),
      domain.canManageEmail
        ? el(
            'button',
            { class: 'btn sm primary', onclick: () => createMailboxModal(domain) },
            '+ Create Mailbox',
          )
        : null,
    ),
    domain.emails.length
      ? el(
          'div',
          { class: 'card-body tight' },
          tableView({
            head: el(
              'thead',
              {},
              el(
                'tr',
                {},
                el('th', {}, 'Address'),
                el('th', {}, 'Status'),
                el('th', {}, 'Usage'),
                isAdmin ? el('th', {}, 'Source') : null,
                el('th', {}, ''),
              ),
            ),
            rows,
            noun: { one: 'mailbox', many: 'mailboxes' },
            searchPlaceholder: 'Search mailboxes…',
            select: {
              noun: { one: 'mailbox', many: 'mailboxes' },
              actions: (chosen) => [
                el(
                  'button',
                  {
                    class: 'btn sm danger',
                    onclick: () => bulkDeleteMailboxesModal(domain, chosen, domain.canManageEmail),
                  },
                  `Delete ${chosen.length}`,
                ),
              ],
            },
          }),
        )
      : el(
          'div',
          { class: 'card-body' },
          emptyState(
            'mail',
            'No mailboxes on this domain',
            domain.canManageEmail
              ? 'Create one, or open the domain and use Refresh to load existing mailboxes.'
              : 'Track a mailbox here to keep a record of it.',
          ),
        ),
  );
}
