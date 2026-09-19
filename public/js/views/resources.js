import { api, el, emptyState, formatMb, initials, toast } from '../core.js';
import { resourceModal } from './users.js';

/// Super Admin sees every user's allocation and can edit it; a normal user sees
/// only their own.
export async function renderResources({ user }) {
  if (user.role !== 'SUPER_ADMIN') return myResources();

  const { users } = await api('/users');
  const frag = el('div');

  frag.append(
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        { class: 'grow' },
        el('h1', {}, 'Server Resources'),
        el('p', {}, 'Define CPU, RAM, storage and bandwidth for each user. Values are entered manually.'),
      ),
    ),
  );

  frag.append(
    el(
      'div',
      { class: 'card' },
      el('div', { class: 'card-head' }, el('h2', {}, 'Allocations')),
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
              el('th', {}, 'User'),
              el('th', {}, 'CPU'),
              el('th', {}, 'RAM'),
              el('th', {}, 'Storage'),
              el('th', {}, 'Bandwidth'),
              el('th', {}, ''),
            ),
          ),
          el(
            'tbody',
            {},
            users.map((u) => {
              const r = u.resource;
              return el(
                'tr',
                {},
                el(
                  'td',
                  {},
                  el(
                    'div',
                    { style: 'display:flex;align-items:center;gap:10px' },
                    el('div', { class: 'avatar', style: 'background:#eef1f6;color:#475467' }, initials(u.name)),
                    el('div', {}, el('div', { class: 'strong' }, u.name), el('div', { class: 'small muted' }, u.email)),
                  ),
                ),
                el('td', {}, r?.cpuCores != null ? `${r.cpuCores} Cores` : el('span', { class: 'muted' }, '—')),
                el('td', {}, r?.ramMb != null ? formatMb(r.ramMb) : el('span', { class: 'muted' }, '—')),
                el('td', {}, r?.storageGb != null ? `${r.storageGb} GB` : el('span', { class: 'muted' }, '—')),
                el('td', {}, r?.bandwidthGb != null ? `${r.bandwidthGb} GB` : el('span', { class: 'muted' }, '—')),
                el('td', { class: 'actions' }, el('button', { class: 'btn sm', onclick: () => resourceModal(u) }, 'Configure')),
              );
            }),
          ),
        ),
      ),
    ),
  );

  return frag;
}

async function myResources() {
  const { resource: r } = await api('/dashboard/my-resources');

  return el(
    'div',
    {},
    el(
      'div',
      { class: 'page-head' },
      el('div', { class: 'grow' }, el('h1', {}, 'Resources'), el('p', {}, 'The resources allocated to your account.')),
    ),
    el(
      'div',
      { class: 'card' },
      el('div', { class: 'card-head' }, el('h2', {}, 'My allocation')),
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
          : emptyState('server', 'No resources configured', 'Your administrator has not set resource limits for your account yet.'),
      ),
    ),
  );
}
