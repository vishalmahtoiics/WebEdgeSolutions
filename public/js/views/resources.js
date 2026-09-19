import { api, el, clear, emptyState, formatMb, initials } from '../core.js';
import { resourceModal } from './users.js';

/// Super Admin sees every user's allocation and can edit it; a normal user sees
/// only their own.
export async function renderResources({ user }) {
  if (user.role !== 'SUPER_ADMIN') return myResources();

  const [{ users }, { providers }] = await Promise.all([api('/users'), api('/providers')]);
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

  // Read-only inventory from each connected provider, shown beneath the manual
  // allocations so it is obvious which numbers are assigned and which are real.
  providers
    .filter((p) => p.isActive && p.capabilities?.servers)
    .forEach((p) => frag.append(providerServersCard(p)));

  return frag;
}

/// Lists a provider's servers, loading them after render so a slow or
/// unavailable provider never blocks the page.
function providerServersCard(provider) {
  const body = el('div', { class: 'card-body' }, el('div', { class: 'muted small' }, 'Loading…'));

  api(`/providers/${provider.id}/servers`)
    .then(({ supported, servers, error }) => {
      clear(body);

      if (!supported) {
        return body.append(
          el('div', { class: 'muted small' }, 'This provider does not expose server information.'),
        );
      }
      if (error) {
        return body.append(el('div', { class: 'alert error', style: 'margin:0' }, error));
      }
      if (!servers.length) {
        return body.append(
          emptyState('server', 'No servers reported', 'This account has no virtual machines at the provider.'),
        );
      }

      body.className = 'card-body tight table-scroll';
      body.append(
        el(
          'table',
          {},
          el(
            'thead',
            {},
            el(
              'tr',
              {},
              el('th', {}, 'Hostname'),
              el('th', {}, 'Plan'),
              el('th', {}, 'State'),
              el('th', {}, 'CPU'),
              el('th', {}, 'RAM'),
              el('th', {}, 'Disk'),
              el('th', {}, 'IPv4'),
            ),
          ),
          el(
            'tbody',
            {},
            servers.map((s) =>
              el(
                'tr',
                {},
                el('td', { class: 'strong break' }, s.hostname || '—'),
                el('td', { class: 'small' }, s.plan || '—'),
                el(
                  'td',
                  {},
                  el('span', { class: `badge ${s.state === 'running' ? 'ok' : ''}` }, s.state || 'unknown'),
                ),
                el('td', { class: 'small' }, s.cpus != null ? `${s.cpus} Cores` : '—'),
                el('td', { class: 'small' }, formatMb(s.memoryMb)),
                el('td', { class: 'small' }, formatMb(s.diskMb)),
                el('td', { class: 'mono small break' }, s.ipv4?.length ? s.ipv4.join(', ') : '—'),
              ),
            ),
          ),
        ),
      );
    })
    .catch((err) => {
      clear(body).append(el('div', { class: 'alert error', style: 'margin:0' }, err.message));
    });

  return el(
    'div',
    { class: 'card' },
    el(
      'div',
      { class: 'card-head' },
      el(
        'div',
        { class: 'grow' },
        el('h2', {}, `${provider.name} — servers`),
        el('p', {}, 'Read live from the provider API. Not editable here.'),
      ),
    ),
    body,
  );
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
