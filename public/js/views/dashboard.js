import { api, el, statusBadge, emptyState, formatMb } from '../core.js';
import { icon } from '../icons.js';
import { navigate } from '../app.js';

const statCard = (label, value, iconName) =>
  el(
    'div',
    { class: 'stat' },
    el('div', { class: 'label' }, icon(iconName, 16), label),
    el('div', { class: 'value' }, String(value ?? 0)),
  );

export async function renderDashboard({ user }) {
  const data = await api('/dashboard');
  const frag = el('div');

  frag.append(
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        { class: 'grow' },
        el('h1', {}, `Welcome back, ${user.name}`),
        el(
          'p',
          {},
          data.role === 'SUPER_ADMIN'
            ? 'Overview of every provider, domain and user in the portal.'
            : 'Your assigned domains and allocated resources.',
        ),
      ),
    ),
  );

  if (data.role === 'SUPER_ADMIN') {
    const s = data.stats;
    frag.append(
      el(
        'div',
        { class: 'stat-grid' },
        statCard('Total Users', s.totalUsers, 'users'),
        statCard('Total Domains', s.totalDomains, 'globe'),
        statCard('Connected Providers', s.connectedProviders, 'plug'),
        statCard('Active Domains', s.activeDomains, 'check'),
        statCard('Email Accounts', s.totalEmailAccounts, 'mail'),
      ),
    );

    frag.append(
      el(
        'div',
        { class: 'card' },
        el(
          'div',
          { class: 'card-head' },
          el('div', { class: 'grow' }, el('h2', {}, 'Recently added domains')),
          el('button', { class: 'btn sm', onclick: () => navigate('domains') }, 'View all'),
        ),
        data.recentDomains.length
          ? el(
              'div',
              { class: 'card-body tight table-scroll' },
              el(
                'table',
                {},
                el('thead', {}, el('tr', {}, el('th', {}, 'Domain'), el('th', {}, 'Provider'), el('th', {}, 'Status'))),
                el(
                  'tbody',
                  {},
                  data.recentDomains.map((d) =>
                    el(
                      'tr',
                      { style: 'cursor:pointer', onclick: () => navigate(`domain/${d.id}`) },
                      el('td', { class: 'strong' }, d.name),
                      el('td', {}, el('span', { class: 'badge' }, d.sourceLabel)),
                      el('td', {}, statusBadge(d.status)),
                    ),
                  ),
                ),
              ),
            )
          : el(
              'div',
              { class: 'card-body' },
              emptyState('globe', 'No domains yet', 'Connect a provider and run Sync to import your domains.'),
            ),
      ),
    );

    return frag;
  }

  // --- Normal user ---------------------------------------------------------
  const s = data.stats;
  frag.append(
    el(
      'div',
      { class: 'stat-grid' },
      statCard('My Domains', s.myDomains, 'globe'),
      statCard('My Email Accounts', s.myEmailAccounts, 'mail'),
      statCard('Active Domains', s.activeDomains, 'check'),
    ),
  );

  const r = data.resource;
  frag.append(
    el(
      'div',
      { class: 'grid-2' },
      el(
        'div',
        { class: 'card' },
        el('div', { class: 'card-head' }, el('h2', {}, 'My Domains')),
        data.domains.length
          ? el(
              'div',
              { class: 'card-body tight table-scroll' },
              el(
                'table',
                {},
                el('thead', {}, el('tr', {}, el('th', {}, 'Domain'), el('th', {}, 'Status'), el('th', {}, 'Emails'))),
                el(
                  'tbody',
                  {},
                  data.domains.map((d) =>
                    el(
                      'tr',
                      { style: 'cursor:pointer', onclick: () => navigate(`domain/${d.id}`) },
                      el('td', { class: 'strong' }, d.name),
                      el('td', {}, statusBadge(d.status)),
                      el('td', {}, String(d.emailCount)),
                    ),
                  ),
                ),
              ),
            )
          : el('div', { class: 'card-body' }, emptyState('globe', 'No domains assigned yet', 'Your administrator will assign domains to your account.')),
      ),
      el(
        'div',
        { class: 'card' },
        el('div', { class: 'card-head' }, el('h2', {}, 'My Server Resources')),
        el(
          'div',
          { class: 'card-body' },
          r
            ? el(
                'dl',
                { class: 'dl' },
                el('div', {}, el('dt', {}, 'CPU'), el('dd', {}, r.cpuCores != null ? `${r.cpuCores} Cores` : '—')),
                el('div', {}, el('dt', {}, 'RAM'), el('dd', {}, formatMb(r.ramMb))),
                el('div', {}, el('dt', {}, 'Storage'), el('dd', {}, r.storageGb != null ? `${r.storageGb} GB` : '—')),
                el('div', {}, el('dt', {}, 'Bandwidth'), el('dd', {}, r.bandwidthGb != null ? `${r.bandwidthGb} GB` : '—')),
                r.notes ? el('div', {}, el('dt', {}, 'Notes'), el('dd', {}, r.notes)) : null,
              )
            : emptyState('server', 'No resources configured', 'Your administrator has not set resource limits yet.'),
        ),
      ),
    ),
  );

  return frag;
}
