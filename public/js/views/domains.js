import {
  api, el, clear, fill, field, submitHandler, toast, openModal, statusBadge, sourceBadge,
  techBadge, emptyState, formatDate, tableView,
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
            el('button', { class: 'btn', onclick: availabilityModal }, 'Check availability'),
            el('button', { class: 'btn', onclick: () => navigate('providers') }, 'Sync from provider'),
            el('button', { class: 'btn primary', onclick: () => addDomainModal() }, '+ Add Domain'),
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
            'globe',
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

  // Paired with the text the search box matches on. Searching and paging both
  // live in the table now, so the two cannot disagree about which rows exist.
  const rows = domains.map((d) => ({
    text: `${d.name} ${d.technology?.name || ''} ${d.status || ''}`,
    node: el(
      'tr',
      { style: 'cursor:pointer', onclick: () => navigate(`domain/${d.id}`) },
      el('td', {}, el('div', { class: 'strong' }, d.name)),
      isAdmin ? el('td', {}, sourceBadge(d.sourceLabel, d.source)) : null,
      el('td', {}, statusBadge(d.status)),
      el('td', {}, techBadge(d.technology)),
      el('td', { class: 'small muted nowrap' }, d.registeredAt ? formatDate(d.registeredAt) : '—'),
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
  }));

  frag.append(
    el(
      'div',
      { class: 'card' },
      el(
        'div',
        { class: 'card-head' },
        el('div', { class: 'grow' }, el('h2', {}, `${domains.length} domain${domains.length === 1 ? '' : 's'}`)),
      ),
      el(
        'div',
        { class: 'card-body tight' },
        tableView({
          head: el(
            'thead',
            {},
            el(
              'tr',
              {},
              el('th', {}, 'Domain'),
              isAdmin ? el('th', {}, 'Provider') : null,
              el('th', {}, 'Status'),
              el('th', {}, 'Built with'),
              el('th', {}, 'Added'),
              el('th', {}, 'Expires'),
              el('th', {}, 'Emails'),
              isAdmin ? el('th', {}, 'Users') : null,
              el('th', {}, ''),
            ),
          ),
          rows,
          noun: { one: 'domain', many: 'domains' },
          searchPlaceholder: 'Search domains or technology…',
        }),
      ),
    ),
  );

  return frag;
}

/// Asks the registry whether a name is free, through whichever connected
/// provider can answer.
///
/// Availability is reported exactly as it comes back, including "unknown" —
/// telling someone a taken name is free is a worse failure than admitting the
/// registry did not say.
function availabilityModal() {
  const name = el('input', { type: 'text', placeholder: 'mysite', autocomplete: 'off' });
  const alertHost = el('div');
  const results = el('div', { style: 'margin-top:4px' });
  const check = el('button', { class: 'btn primary' }, 'Check');

  const TLDS = ['com', 'in', 'net', 'org', 'co'];
  const chosen = new Set(TLDS.slice(0, 3));
  const tldRow = el(
    'div',
    { class: 'checklist', style: 'display:flex;flex-wrap:wrap;gap:4px 14px' },
    ...TLDS.map((tld) => {
      const box = el('input', { type: 'checkbox', checked: chosen.has(tld) });
      box.onchange = () => (box.checked ? chosen.add(tld) : chosen.delete(tld));
      return el('label', { class: 'check' }, box, el('span', {}, `.${tld}`));
    }),
  );

  const row = (r) => {
    const tone = r.alreadyInPortal ? '' : r.available === true ? 'ok' : r.available === false ? 'danger' : 'warn';
    const label = r.alreadyInPortal
      ? 'Already in the portal'
      : r.available === true
        ? 'Available'
        : r.available === false
          ? 'Taken'
          : 'Not sure';

    return el(
      'div',
      { style: 'display:flex;align-items:center;gap:10px;padding:9px 0;border-top:1px solid var(--border)' },
      el('span', { class: 'mono grow break' }, r.domain),
      r.restriction ? el('span', { class: 'small muted' }, r.restriction) : null,
      el('span', { class: `badge ${tone}` }, label),
      r.available === true && !r.alreadyInPortal
        ? el(
            'button',
            {
              class: 'btn sm',
              onclick: () => {
                close();
                // Availability does not buy it. Register it with the
                // registrar, then add it here — this button only saves
                // retyping the name.
                addDomainModal(r.domain);
              },
            },
            'Add to portal',
          )
        : null,
    );
  };

  const run = submitHandler(check, alertHost, async () => {
    clear(results);
    const res = await api('/domains/availability', {
      method: 'POST',
      body: { name: name.value.trim().toLowerCase(), tlds: [...chosen] },
    });

    check.disabled = false;
    clear(check).append('Check');

    if (!res.results.length) {
      fill(results, el('div', { class: 'alert info' }, 'The registry returned nothing for that name.'));
      return;
    }
    fill(
      results,
      el('div', { class: 'small muted', style: 'margin-bottom:2px' }, 'Registry answer, as given:'),
      res.results.map(row),
    );
  });

  check.onclick = run;
  name.onkeydown = (e) => e.key === 'Enter' && run(e);

  const close = openModal({
    title: 'Check domain availability',
    render: () =>
      el(
        'div',
        {},
        alertHost,
        field('Name', name, 'Without the ending, e.g. mysite. Typing mysite.com checks that ending too.'),
        el('div', { class: 'field' }, el('label', {}, 'Endings to check'), tldRow),
        results,
        el(
          'p',
          { class: 'small muted', style: 'margin:14px 0 0' },
          'Checking does not reserve or buy anything. Register the name with a registrar first, then add it here.',
        ),
      ),
    footer: (closeFn) => [el('button', { class: 'btn', onclick: closeFn }, 'Close'), check],
  });
}

function addDomainModal(prefill = '') {
  const name = el('input', { type: 'text', placeholder: 'example.com', value: prefill });
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
