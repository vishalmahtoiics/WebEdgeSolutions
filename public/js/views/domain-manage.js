import {
  api, el, clear, field, submitHandler, toast, openModal, confirmModal,
  statusBadge, sourceBadge, emptyState, formatDate, relativeTime, formatMb,
} from '../core.js';
import { navigate, refresh } from '../app.js';

export async function renderDomainManage({ param, user }) {
  const data = await api(`/domains/${param}`);
  const isAdmin = user.role === 'SUPER_ADMIN';
  const d = data.domain;

  const frag = el('div');

  frag.append(
    el('button', { class: 'backlink', onclick: () => navigate('domains') }, '← Back to domains'),
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        { class: 'grow' },
        el('h1', {}, d.name),
        el(
          'div',
          { style: 'display:flex;gap:8px;margin-top:8px;flex-wrap:wrap' },
          statusBadge(d.status),
          sourceBadge(d.sourceLabel, d.source),
          d.type ? el('span', { class: 'badge' }, d.type) : null,
        ),
      ),
      isAdmin
        ? el(
            'div',
            { class: 'page-actions' },
            el('button', { class: 'btn', onclick: () => editDomainModal(d) }, 'Edit'),
            el(
              'button',
              {
                class: 'btn danger',
                onclick: () =>
                  confirmModal({
                    title: 'Delete domain',
                    message: `Delete ${d.name} and all of its DNS records, mailboxes and settings from the portal? This does not affect the domain at the provider.`,
                    confirmLabel: 'Delete',
                    onConfirm: async () => {
                      await api(`/domains/${d.id}`, { method: 'DELETE' });
                      toast('Domain deleted.', 'ok');
                      navigate('domains');
                    },
                  }),
              },
              'Delete',
            ),
          )
        : null,
    ),
  );

  // --- Tabs ----------------------------------------------------------------
  const panel = el('div');
  const tabs = [
    { key: 'overview', label: 'Overview' },
    { key: 'dns', label: `DNS Records (${data.dnsRecords.length})` },
    { key: 'emails', label: `Emails (${data.emailAccounts.length})` },
    { key: 'settings', label: 'FTP & Server' },
  ];
  if (isAdmin) tabs.push({ key: 'access', label: 'Access' });

  const tabBar = el('div', { class: 'tabs' });
  const select = (key) => {
    tabBar.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.key === key));
    clear(panel).append(renderPanel(key, data, isAdmin));
  };
  tabs.forEach((t) =>
    tabBar.append(
      el('button', { class: 'tab', dataset: { key: t.key }, onclick: () => select(t.key) }, t.label),
    ),
  );

  frag.append(tabBar, panel);
  select('overview');
  return frag;
}

function renderPanel(key, data, isAdmin) {
  if (key === 'dns') return dnsPanel(data, isAdmin);
  if (key === 'emails') return emailPanel(data, isAdmin);
  if (key === 'settings') return settingsPanel(data);
  if (key === 'access') return accessPanel(data);
  return overviewPanel(data);
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function overviewPanel(data) {
  const d = data.domain;

  const liveHost = el('div', { class: 'card-body' }, el('div', { class: 'muted small' }, 'Loading…'));

  // Registrar detail is fetched live rather than stored, so it is never stale.
  if (d.provider) {
    api(`/domains/${d.id}/provider-details`)
      .then((res) => {
        clear(liveHost);
        if (!res.supported || !res.details) {
          liveHost.append(
            el(
              'div',
              { class: 'muted small' },
              res.error || 'This provider does not expose registrar details for this domain.',
            ),
          );
          return;
        }
        const x = res.details;

        // A bare dash cannot be told apart from a bug. Say plainly that the
        // provider returned no value, so an empty row reads as a fact about
        // the domain rather than a failure of this page.
        const missing = () => el('span', { class: 'muted small' }, 'Not provided');
        const value = (v, render) => (v === null || v === undefined || v === '' ? missing() : render(v));

        const rows = [
          ['Registrar status', value(x.status, (v) => v)],
          ['Domain lock', value(x.isLocked, (v) => (v ? 'Locked' : 'Unlocked'))],
          ['Privacy protection', value(x.isPrivacyProtected, (v) => (v ? 'Enabled' : 'Disabled'))],
          [
            'Nameservers',
            x.nameservers?.length
              ? el('span', { class: 'mono' }, x.nameservers.join(', '))
              : missing(),
          ],
          ['Registered', value(x.registeredAt, formatDate)],
          ['Expires', value(x.expiresAt, formatDate)],
        ];

        liveHost.append(
          el('dl', { class: 'dl' }, rows.map(([label, node]) => el('div', {}, el('dt', {}, label), el('dd', {}, node)))),
        );

        // When the registrar fields come back empty, the usual cause is that
        // the domain is hosted here but registered somewhere else — worth
        // saying, since there is nothing to fix in the portal.
        const registrarFields = [x.isLocked, x.isPrivacyProtected, x.registeredAt, x.expiresAt];
        const noneProvided = registrarFields.every((v) => v === null || v === undefined) && !x.nameservers?.length;

        if (noneProvided) {
          liveHost.append(
            el(
              'div',
              { class: 'alert info', style: 'margin:16px 0 0' },
              `${d.provider.name} returned no registrar details for this domain. That normally means it is `,
              el('strong', {}, 'hosted here but registered with another registrar'),
              ', so the registrar owns this information. You can record it by hand under FTP & Server.',
            ),
          );
        }
      })
      .catch((err) => {
        clear(liveHost).append(el('div', { class: 'alert error', style: 'margin:0' }, err.message));
      });
  } else {
    clear(liveHost).append(
      el(
        'div',
        { class: 'muted small' },
        'This domain was added manually and is not linked to a provider API.',
      ),
    );
  }

  return el(
    'div',
    { class: 'grid-2' },
    el(
      'div',
      { class: 'card' },
      el('div', { class: 'card-head' }, el('h2', {}, 'Domain information')),
      el(
        'div',
        { class: 'card-body' },
        el(
          'dl',
          { class: 'dl' },
          el('div', {}, el('dt', {}, 'Domain'), el('dd', { class: 'strong' }, d.name)),
          el('div', {}, el('dt', {}, 'Provider'), el('dd', {}, sourceBadge(d.sourceLabel, d.source))),
          el('div', {}, el('dt', {}, 'Status'), el('dd', {}, statusBadge(d.status))),
          el('div', {}, el('dt', {}, 'Type'), el('dd', {}, d.type || '—')),
          el('div', {}, el('dt', {}, 'Registered'), el('dd', {}, formatDate(d.registeredAt))),
          el('div', {}, el('dt', {}, 'Expires'), el('dd', {}, formatDate(d.expiresAt))),
          el('div', {}, el('dt', {}, 'Last synced'), el('dd', {}, relativeTime(d.lastSyncedAt))),
          el('div', {}, el('dt', {}, 'Added to portal'), el('dd', {}, formatDate(d.createdAt))),
        ),
      ),
    ),
    el(
      'div',
      { class: 'card' },
      el(
        'div',
        { class: 'card-head' },
        el(
          'div',
          { class: 'grow' },
          el('h2', {}, 'Live provider details'),
          el('p', {}, 'Read directly from the provider API.'),
        ),
      ),
      liveHost,
    ),
  );
}

// ---------------------------------------------------------------------------
// DNS
// ---------------------------------------------------------------------------

function dnsPanel(data, isAdmin) {
  const d = data.domain;
  const canSync = Boolean(d.provider) && data.capabilities?.dns;

  const syncBtn = el('button', { class: 'btn' }, 'Load from provider');
  syncBtn.onclick = async () => {
    syncBtn.disabled = true;
    try {
      const res = await api(`/domains/${d.id}/dns/sync`, { method: 'POST' });
      toast(res.message, 'ok');
      refresh();
    } catch (err) {
      toast(err.message, 'error');
      syncBtn.disabled = false;
    }
  };

  const rows = data.dnsRecords.map((r) =>
    el(
      'tr',
      {},
      el('td', { class: 'mono break' }, r.name),
      el('td', {}, el('span', { class: 'badge' }, r.type)),
      el('td', { class: 'mono break' }, r.content),
      el('td', { class: 'small muted' }, String(r.ttl)),
      el(
        'td',
        {},
        el('span', { class: `badge ${r.isFromProvider ? 'accent' : ''}` }, r.isFromProvider ? 'Provider' : 'Manual'),
      ),
      el(
        'td',
        { class: 'actions' },
        el('button', { class: 'btn sm', onclick: () => dnsModal(d.id, r) }, 'Edit'),
        ' ',
        el(
          'button',
          {
            class: 'btn sm danger',
            onclick: () =>
              confirmModal({
                title: 'Delete DNS record',
                message: `Delete the ${r.type} record for ${r.name}?`,
                confirmLabel: 'Delete',
                onConfirm: async () => {
                  await api(`/domains/${d.id}/dns/${r.id}`, { method: 'DELETE' });
                  toast('Record deleted.', 'ok');
                  refresh();
                },
              }),
          },
          'Delete',
        ),
      ),
    ),
  );

  return el(
    'div',
    { class: 'card' },
    el(
      'div',
      { class: 'card-head' },
      el(
        'div',
        { class: 'grow' },
        el('h2', {}, 'DNS Zone'),
        el(
          'p',
          {},
          canSync
            ? 'Records loaded from the provider are replaced each time you refresh. Records you add or edit here are kept.'
            : 'This domain has no provider DNS integration — records are managed manually.',
        ),
      ),
      canSync ? syncBtn : null,
      el('button', { class: 'btn primary', onclick: () => dnsModal(d.id) }, '+ Add Record'),
    ),
    data.dnsRecords.length
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
                el('th', {}, 'Name'),
                el('th', {}, 'Type'),
                el('th', {}, 'Value'),
                el('th', {}, 'TTL'),
                el('th', {}, 'Source'),
                el('th', {}, ''),
              ),
            ),
            el('tbody', {}, rows),
          ),
        )
      : el(
          'div',
          { class: 'card-body' },
          emptyState(
            '🧭',
            'No DNS records',
            canSync ? 'Click "Load from provider" to import the live zone.' : 'Add a record to get started.',
          ),
        ),
  );
}

function dnsModal(domainId, record = null) {
  const name = el('input', { type: 'text', value: record?.name || '@', placeholder: '@ or www' });
  const type = el(
    'select',
    {},
    ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA'].map((t) =>
      el('option', { value: t, selected: record?.type === t }, t),
    ),
  );
  const content = el('input', { type: 'text', value: record?.content || '' });
  const ttl = el('input', { type: 'number', value: record?.ttl ?? 3600, min: 60 });

  const alertHost = el('div');
  const save = el('button', { class: 'btn primary' }, record ? 'Save record' : 'Add record');

  save.onclick = submitHandler(save, alertHost, async () => {
    const body = {
      name: name.value.trim(),
      type: type.value,
      content: content.value.trim(),
      ttl: Number(ttl.value),
    };
    const path = record ? `/domains/${domainId}/dns/${record.id}` : `/domains/${domainId}/dns`;
    await api(path, { method: record ? 'PUT' : 'POST', body });
    toast(record ? 'Record updated.' : 'Record added.', 'ok');
    close();
    refresh();
  });

  const close = openModal({
    title: record ? 'Edit DNS Record' : 'Add DNS Record',
    render: () =>
      el(
        'div',
        {},
        alertHost,
        record?.isFromProvider
          ? el(
              'div',
              { class: 'alert warn' },
              'This record came from the provider. Saving your changes marks it as a manual record — it will no longer be replaced when you refresh the zone, and the change is not pushed back to the provider.',
            )
          : null,
        el('div', { class: 'form-row' }, field('Name', name), field('Type', type)),
        field('Value', content),
        field('TTL (seconds)', ttl),
      ),
    footer: (closeFn) => [el('button', { class: 'btn', onclick: closeFn }, 'Cancel'), save],
  });
}

// ---------------------------------------------------------------------------
// Emails
// ---------------------------------------------------------------------------

function emailPanel(data, isAdmin) {
  const d = data.domain;
  const canSync = Boolean(d.provider) && data.capabilities?.email;

  const syncBtn = el('button', { class: 'btn' }, 'Load from provider');
  syncBtn.onclick = async () => {
    syncBtn.disabled = true;
    try {
      const res = await api(`/domains/${d.id}/emails/sync`, { method: 'POST' });
      toast(res.message, 'ok');
      refresh();
    } catch (err) {
      toast(err.message, 'error');
      syncBtn.disabled = false;
    }
  };

  const rows = data.emailAccounts.map((m) =>
    el(
      'tr',
      {},
      el('td', { class: 'strong break' }, m.address),
      el('td', {}, statusBadge(m.status)),
      el('td', { class: 'small muted nowrap' }, m.usedMb != null || m.quotaMb != null ? `${formatMb(m.usedMb)} / ${formatMb(m.quotaMb)}` : '—'),
      el(
        'td',
        {},
        el('span', { class: `badge ${m.isFromProvider ? 'accent' : ''}` }, m.isFromProvider ? 'Provider' : 'Manual'),
      ),
      el(
        'td',
        { class: 'actions' },
        el('button', { class: 'btn sm', onclick: () => emailModal(d.id, m) }, 'Edit'),
        ' ',
        el(
          'button',
          {
            class: 'btn sm danger',
            onclick: () =>
              confirmModal({
                title: 'Remove mailbox',
                message: `Remove ${m.address} from the portal? The mailbox itself is not deleted at the provider.`,
                confirmLabel: 'Remove',
                onConfirm: async () => {
                  await api(`/domains/${d.id}/emails/${m.id}`, { method: 'DELETE' });
                  toast('Mailbox removed.', 'ok');
                  refresh();
                },
              }),
          },
          'Remove',
        ),
      ),
    ),
  );

  return el(
    'div',
    { class: 'card' },
    el(
      'div',
      { class: 'card-head' },
      el(
        'div',
        { class: 'grow' },
        el('h2', {}, 'Email Accounts'),
        el(
          'p',
          {},
          canSync
            ? 'Mailboxes are read from the provider where an email plan exists. You can also add mailboxes manually.'
            : 'No provider email integration for this domain — mailboxes are tracked manually.',
        ),
      ),
      canSync ? syncBtn : null,
      el('button', { class: 'btn primary', onclick: () => emailModal(d.id) }, '+ Add Email'),
    ),
    data.emailAccounts.length
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
                el('th', {}, 'Address'),
                el('th', {}, 'Status'),
                el('th', {}, 'Usage'),
                el('th', {}, 'Source'),
                el('th', {}, ''),
              ),
            ),
            el('tbody', {}, rows),
          ),
        )
      : el(
          'div',
          { class: 'card-body' },
          emptyState(
            '✉',
            'No mailboxes listed',
            canSync
              ? 'Click "Load from provider", or add a mailbox manually if the provider has no email plan for this domain.'
              : 'Add a mailbox to track it here.',
          ),
        ),
  );
}

function emailModal(domainId, mailbox = null) {
  const address = el('input', { type: 'email', value: mailbox?.address || '' });
  const status = el(
    'select',
    {},
    ['active', 'suspended', 'pending'].map((s) =>
      el('option', { value: s, selected: mailbox?.status === s }, s[0].toUpperCase() + s.slice(1)),
    ),
  );
  const quotaMb = el('input', { type: 'number', value: mailbox?.quotaMb ?? '', min: 0 });
  const usedMb = el('input', { type: 'number', value: mailbox?.usedMb ?? '', min: 0 });
  const notes = el('textarea', {}, mailbox?.notes || '');

  const alertHost = el('div');
  const save = el('button', { class: 'btn primary' }, mailbox ? 'Save mailbox' : 'Add mailbox');

  save.onclick = submitHandler(save, alertHost, async () => {
    const body = {
      address: address.value.trim().toLowerCase(),
      status: status.value,
      quotaMb: quotaMb.value === '' ? null : Number(quotaMb.value),
      usedMb: usedMb.value === '' ? null : Number(usedMb.value),
      notes: notes.value.trim(),
    };
    const path = mailbox ? `/domains/${domainId}/emails/${mailbox.id}` : `/domains/${domainId}/emails`;
    await api(path, { method: mailbox ? 'PUT' : 'POST', body });
    toast(mailbox ? 'Mailbox updated.' : 'Mailbox added.', 'ok');
    close();
    refresh();
  });

  const close = openModal({
    title: mailbox ? 'Edit Mailbox' : 'Add Mailbox',
    render: () =>
      el(
        'div',
        {},
        alertHost,
        field('Email address', address),
        field('Status', status),
        el('div', { class: 'form-row' }, field('Quota (MB)', quotaMb), field('Used (MB)', usedMb)),
        field('Notes', notes),
      ),
    footer: (closeFn) => [el('button', { class: 'btn', onclick: closeFn }, 'Cancel'), save],
  });
}

// ---------------------------------------------------------------------------
// FTP / server settings (always manual)
// ---------------------------------------------------------------------------

function settingsPanel(data) {
  const s = data.settings || {};
  const d = data.domain;

  const inputs = {
    ftpProtocol: el(
      'select',
      {},
      ['', 'FTP', 'FTPS', 'SFTP'].map((p) =>
        el('option', { value: p, selected: s.ftpProtocol === p }, p || 'Not set'),
      ),
    ),
    ftpHost: el('input', { type: 'text', value: s.ftpHost || '' }),
    ftpPort: el('input', { type: 'number', value: s.ftpPort ?? '', min: 1, max: 65535 }),
    ftpUsername: el('input', { type: 'text', value: s.ftpUsername || '' }),
    ftpPassword: el('input', { type: 'password', value: s.ftpPassword || '', autocomplete: 'off' }),
    serverIp: el('input', { type: 'text', value: s.serverIp || '' }),
    serverHostname: el('input', { type: 'text', value: s.serverHostname || '' }),
    serverLocation: el('input', { type: 'text', value: s.serverLocation || '' }),
    nameservers: el('input', { type: 'text', value: s.nameservers || '' }),
    phpVersion: el('input', { type: 'text', value: s.phpVersion || '' }),
    notes: el('textarea', {}, s.notes || ''),
  };

  const alertHost = el('div');
  const save = el('button', { class: 'btn primary' }, 'Save settings');
  save.onclick = submitHandler(save, alertHost, async () => {
    const body = Object.fromEntries(
      Object.entries(inputs).map(([k, input]) => [
        k,
        input.type === 'number' ? (input.value === '' ? null : Number(input.value)) : input.value.trim(),
      ]),
    );
    await api(`/domains/${d.id}/settings`, { method: 'PUT', body });
    toast('Settings saved.', 'ok');
    alertHost.append(el('div', { class: 'alert ok' }, 'Saved.'));
    save.disabled = false;
    clear(save).append('Save settings');
  });

  return el(
    'div',
    {},
    data.capabilities && data.capabilities.ftp === false
      ? el(
          'div',
          { class: 'alert info' },
          'This provider\'s API does not expose FTP/FTPS credentials or server details, so they are configured here manually.',
        )
      : null,
    el(
      'div',
      { class: 'grid-2' },
      el(
        'div',
        { class: 'card' },
        el(
          'div',
          { class: 'card-head' },
          el('div', { class: 'grow' }, el('h2', {}, 'FTP / FTPS'), el('p', {}, 'Stored for your reference.')),
        ),
        el(
          'div',
          { class: 'card-body' },
          field('Protocol', inputs.ftpProtocol),
          el('div', { class: 'form-row' }, field('Host', inputs.ftpHost), field('Port', inputs.ftpPort)),
          field('Username', inputs.ftpUsername),
          field('Password', inputs.ftpPassword),
        ),
      ),
      el(
        'div',
        { class: 'card' },
        el('div', { class: 'card-head' }, el('h2', {}, 'Server information')),
        el(
          'div',
          { class: 'card-body' },
          el('div', { class: 'form-row' }, field('Server IP', inputs.serverIp), field('PHP version', inputs.phpVersion)),
          field('Hostname', inputs.serverHostname),
          field('Location', inputs.serverLocation),
          field('Nameservers', inputs.nameservers, 'Comma separated.'),
        ),
      ),
    ),
    el(
      'div',
      { class: 'card' },
      el('div', { class: 'card-head' }, el('h2', {}, 'Notes')),
      el('div', { class: 'card-body' }, inputs.notes, alertHost, el('div', { style: 'margin-top:14px' }, save)),
    ),
  );
}

// ---------------------------------------------------------------------------
// Access (admin only)
// ---------------------------------------------------------------------------

function accessPanel(data) {
  const users = data.assignedUsers || [];
  return el(
    'div',
    { class: 'card' },
    el(
      'div',
      { class: 'card-head' },
      el(
        'div',
        { class: 'grow' },
        el('h2', {}, 'Users with access'),
        el('p', {}, 'Assign domains to users from the Users page.'),
      ),
      el('button', { class: 'btn', onclick: () => navigate('users') }, 'Manage users'),
    ),
    users.length
      ? el(
          'div',
          { class: 'card-body tight table-scroll' },
          el(
            'table',
            {},
            el('thead', {}, el('tr', {}, el('th', {}, 'Name'), el('th', {}, 'Email'))),
            el(
              'tbody',
              {},
              users.map((u) => el('tr', {}, el('td', { class: 'strong' }, u.name), el('td', { class: 'muted' }, u.email))),
            ),
          ),
        )
      : el(
          'div',
          { class: 'card-body' },
          emptyState('user', 'No users assigned', 'Only Super Admins can see this domain right now.'),
        ),
  );
}

// ---------------------------------------------------------------------------

function editDomainModal(d) {
  const status = el(
    'select',
    {},
    ['active', 'pending', 'suspended', 'expired', 'unknown'].map((s) =>
      el('option', { value: s, selected: d.status === s }, s[0].toUpperCase() + s.slice(1)),
    ),
  );
  const type = el('input', { type: 'text', value: d.type || '' });
  const alertHost = el('div');
  const save = el('button', { class: 'btn primary' }, 'Save changes');

  save.onclick = submitHandler(save, alertHost, async () => {
    await api(`/domains/${d.id}`, {
      method: 'PUT',
      body: { status: status.value, type: type.value.trim() },
    });
    toast('Domain updated.', 'ok');
    close();
    refresh();
  });

  const close = openModal({
    title: `Edit ${d.name}`,
    render: () =>
      el(
        'div',
        {},
        alertHost,
        d.source === 'PROVIDER'
          ? el(
              'div',
              { class: 'alert warn' },
              'This domain is synced from a provider. Your changes may be overwritten the next time you run Sync.',
            )
          : null,
        field('Status', status),
        field('Type', type),
      ),
    footer: (closeFn) => [el('button', { class: 'btn', onclick: closeFn }, 'Cancel'), save],
  });
}
