import {
  api, el, clear, appendAll, field, submitHandler, toast, openModal, confirmModal,
  statusBadge, sourceBadge, techBadge, TECH_SOURCE_LABEL,
  emptyState, formatDate, relativeTime, formatMb,
} from '../core.js';
import { navigate, refresh } from '../app.js';
import { filesPanel } from './files.js';
import {
  createMailboxModal,
  passwordModal,
  deleteMailboxModal,
  emailModal,
} from './mailbox-modals.js';

/// The tab in view, remembered across re-renders.
///
/// Saving a mailbox re-renders the page; without this the admin is thrown back
/// to Overview every time and has to find their place again.
let activeTab = { domainId: null, key: 'overview' };

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
          // Where a domain came from is an administrator's concern.
          isAdmin ? sourceBadge(d.sourceLabel, d.source) : null,
          d.type ? el('span', { class: 'badge' }, d.type) : null,
        ),
      ),
      el(
        'div',
        { class: 'page-actions' },
        // The button a user reaches for when their information looks stale.
        d.canRefresh ? refreshButton(d) : null,
        isAdmin ? el('button', { class: 'btn', onclick: () => editDomainModal(d) }, 'Edit') : null,
        isAdmin
          ? el(
              'button',
              {
                class: 'btn danger',
                onclick: () =>
                  confirmModal({
                    title: 'Delete domain',
                    message: `Delete ${d.name} and all of its DNS records, mailboxes and settings from the portal? The domain itself is not affected.`,
                    confirmLabel: 'Delete',
                    onConfirm: async () => {
                      await api(`/domains/${d.id}`, { method: 'DELETE' });
                      toast('Domain deleted.', 'ok');
                      navigate('domains');
                    },
                  }),
              },
              'Delete',
            )
          : null,
      ),
    ),
  );

  // --- Tabs ----------------------------------------------------------------
  const panel = el('div');
  const tabs = [
    { key: 'overview', label: 'Overview' },
    { key: 'dns', label: `DNS Records (${data.dnsRecords.length})` },
    { key: 'emails', label: `Emails (${data.emailAccounts.length})` },
    { key: 'files', label: 'Files' },
    { key: 'settings', label: 'FTP & Server' },
  ];
  if (isAdmin) tabs.push({ key: 'access', label: 'Access' });

  const tabBar = el('div', { class: 'tabs' });
  const select = (key) => {
    activeTab = { domainId: d.id, key };
    tabBar.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.key === key));
    clear(panel).append(renderPanel(key, data, isAdmin));
  };
  tabs.forEach((t) =>
    tabBar.append(
      el('button', { class: 'tab', dataset: { key: t.key }, onclick: () => select(t.key) }, t.label),
    ),
  );

  frag.append(tabBar, panel);

  // Reopen where we were, unless this is a different domain or that tab is no
  // longer offered (the Access tab is admin-only).
  const remembered =
    activeTab.domainId === d.id && tabs.some((t) => t.key === activeTab.key) ? activeTab.key : 'overview';
  select(remembered);
  return frag;
}

/// Pulls this domain's DNS and mailboxes again. Worded without reference to
/// any provider, because a user must not learn who hosts their domain.
function refreshButton(domain) {
  const btn = el('button', { class: 'btn' }, 'Refresh');
  btn.onclick = async () => {
    btn.disabled = true;
    const original = btn.textContent;
    clear(btn).append(el('span', { class: 'spinner' }), 'Refreshing…');
    try {
      const res = await api(`/domains/${domain.id}/refresh`, { method: 'POST' });
      toast(res.message, 'ok');
      refresh();
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
      clear(btn).append(original);
    }
  };
  return btn;
}

function renderPanel(key, data, isAdmin) {
  if (key === 'dns') return dnsPanel(data, isAdmin);
  if (key === 'emails') return emailPanel(data, isAdmin);
  if (key === 'files') return filesPanel(data.domain);
  if (key === 'settings') return settingsPanel(data);
  if (key === 'access') return accessPanel(data);
  return overviewPanel(data, isAdmin);
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

/// What the site is built on, with the evidence in plain sight.
///
/// The evidence line is the point of this card. "WordPress" alone is a claim;
/// "WordPress — found wp-config.php and wp-includes/version.php" is something
/// the reader can check for themselves.
function technologyCard(d, isAdmin) {
  const tech = d.technology;

  const detectBtn = el('button', { class: 'btn sm' }, 'Detect now');
  detectBtn.onclick = async () => {
    detectBtn.disabled = true;
    const label = detectBtn.textContent;
    clear(detectBtn).append(el('span', { class: 'spinner' }), 'Checking…');
    try {
      const res = await api(`/domains/${d.id}/technology/detect`, { method: 'POST' });
      toast(res.message, res.ok ? 'ok' : '');
      refresh();
    } catch (err) {
      toast(err.message, 'error');
      detectBtn.disabled = false;
      clear(detectBtn).append(label);
    }
  };

  const body = el('div', { class: 'card-body' });

  if (!tech) {
    body.append(
      el('div', { class: 'muted small' }, 'Not detected yet. Press Detect now to look.'),
    );
  } else {
    const rows = [
      ['Built with', el('span', { class: 'strong' }, tech.name)],
      ['Version', tech.version ? el('span', { class: 'mono' }, tech.version) : el('span', { class: 'muted small' }, 'Not determined')],
      ['How we know', el('span', { class: 'small' }, TECH_SOURCE_LABEL[tech.source] || 'unknown')],
      ['Last checked', relativeTime(tech.checkedAt)],
    ];

    appendAll(body, [
      el('dl', { class: 'dl' }, rows.map(([label, node]) => el('div', {}, el('dt', {}, label), el('dd', {}, node)))),
      tech.evidence
        ? el(
            'div',
            { class: 'alert info', style: 'margin:16px 0 0' },
            tech.source === 'manual'
              ? 'This value was entered by hand, so it is whatever your administrator says it is.'
              : tech.confidence === 'likely'
                ? `Best guess: ${tech.evidence}. That is evidence rather than proof — set it by hand if it is wrong.`
                : `Confirmed: ${tech.evidence}.`,
          )
        : null,
      isAdmin && d.usesCustomTech && d.detectedTech
        ? el(
            'div',
            { class: 'alert warn', style: 'margin:12px 0 0' },
            `Showing your custom value. Detection last found ${d.detectedTech}${
              d.detectedTechVersion ? ` ${d.detectedTechVersion}` : ''
            }.`,
          )
        : null,
    ]);
  }

  return el(
    'div',
    { class: 'card' },
    el(
      'div',
      { class: 'card-head' },
      el(
        'div',
        { class: 'grow' },
        el('h2', {}, 'Technology'),
        el('p', {}, 'What this website is built on.'),
      ),
      detectBtn,
      isAdmin ? el('button', { class: 'btn sm', onclick: () => technologyModal(d) }, 'Edit') : null,
    ),
    body,
  );
}

/// The administrator's override, offered the same way mailbox figures are:
/// the detected value on one side, a custom value on the other, and a plain
/// statement of which one people will see.
function technologyModal(d) {
  const useCustom = el('input', { type: 'checkbox', checked: Boolean(d.usesCustomTech) });
  const name = el('input', { type: 'text', value: d.techOverride || '', placeholder: 'e.g. WordPress' });
  const version = el('input', { type: 'text', value: d.techVersionOverride || '', placeholder: 'e.g. 6.5.2' });
  const alertHost = el('div', {});

  const detected = d.detectedTech
    ? `${d.detectedTech}${d.detectedTechVersion ? ` ${d.detectedTechVersion}` : ''}`
    : 'nothing yet';

  const sync = () => {
    const custom = useCustom.checked;
    name.disabled = !custom;
    version.disabled = !custom;
  };
  useCustom.onchange = sync;
  sync();

  openModal({
    title: 'Technology',
    render: () =>
      el(
        'form',
        { onsubmit: (e) => e.preventDefault() },
        alertHost,
        el(
          'div',
          { class: 'alert info', style: 'margin-bottom:16px' },
          `Detection found ${detected}${d.detectedTechEvidence ? ` — ${d.detectedTechEvidence}` : ''}.`,
        ),
        el(
          'label',
          { class: 'check' },
          useCustom,
          el('span', {}, 'Show a custom value instead of what was detected'),
        ),
        field('Technology', name, 'Leave the box above unticked to go back to the detected value.'),
        field('Version', version, 'Optional.'),
      ),
    footer: (close) => {
      const save = el('button', { class: 'btn primary' }, 'Save');
      save.onclick = submitHandler(save, alertHost, async () => {
        const res = await api(`/domains/${d.id}/technology`, {
          method: 'PUT',
          body: useCustom.checked
            ? { name: name.value.trim(), version: version.value.trim() }
            : { name: '', version: '' },
        });
        close();
        toast(res.message, 'ok');
        refresh();
      });
      return [el('button', { class: 'btn', onclick: close }, 'Cancel'), save];
    },
  });
}

function overviewPanel(data, isAdmin) {
  const d = data.domain;

  const liveHost = el('div', { class: 'card-body' }, el('div', { class: 'muted small' }, 'Loading…'));

  // Registrar detail is fetched live rather than stored, so it is never stale.
  if (d.canRefresh) {
    api(`/domains/${d.id}/registration`)
      .then((res) => {
        clear(liveHost);
        if (!res.supported || !res.details) {
          liveHost.append(
            el(
              'div',
              { class: 'muted small' },
              res.error || 'No registration details are available for this domain.',
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
              isAdmin
                ? `${d.provider?.name || 'The provider'} returned no registrar details for this domain. That normally means it is hosted there but registered with another registrar, so the registrar owns this information. You can record it by hand under FTP & Server.`
                : 'No registration details are available for this domain. You can record them by hand under FTP & Server.',
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
        isAdmin
          ? 'This domain was added manually and is not linked to a provider API.'
          : 'No registration details are available for this domain.',
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
          isAdmin
            ? el('div', {}, el('dt', {}, 'Provider'), el('dd', {}, sourceBadge(d.sourceLabel, d.source)))
            : null,
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
          el('h2', {}, isAdmin ? 'Live provider details' : 'Registration details'),
          el('p', {}, isAdmin ? 'Read directly from the provider API.' : 'Read live from the domain registry.'),
        ),
      ),
      liveHost,
    ),
    technologyCard(d, isAdmin),
  );
}

// ---------------------------------------------------------------------------
// DNS
// ---------------------------------------------------------------------------

function dnsPanel(data, isAdmin) {
  const d = data.domain;
  // Admins get an explicit zone reload; users use the page-level Refresh.
  const canSync = isAdmin && Boolean(d.provider) && data.capabilities?.dns;

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
      isAdmin
        ? el(
            'td',
            {},
            el('span', { class: `badge ${r.isFromProvider ? 'accent' : ''}` }, r.isFromProvider ? 'Provider' : 'Manual'),
          )
        : null,
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
          isAdmin
            ? canSync
              ? 'Records loaded from the provider are replaced each time you refresh. Records you add or edit here are kept.'
              : 'This domain has no provider DNS integration — records are managed manually.'
            : 'The DNS records for this domain. Use Refresh above to reload them.',
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
                isAdmin ? el('th', {}, 'Source') : null,
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
            'dns',
            'No DNS records',
            isAdmin
              ? canSync
                ? 'Click "Load from provider" to import the live zone.'
                : 'Add a record to get started.'
              : 'Use Refresh above to load them, or add a record yourself.',
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
        record && record.isFromProvider === undefined
          ? el(
              'div',
              { class: 'alert info' },
              'Your change is kept here and will not be overwritten by a refresh. It is not pushed to the name servers.',
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
  const canSync = isAdmin && Boolean(d.provider) && data.capabilities?.email;
  // Creating, deleting and re-passwording mailboxes act on the real mail
  // server, so they only appear where that is actually supported.
  const canWrite = isAdmin
    ? Boolean(d.provider) && data.capabilities?.emailWrite
    : Boolean(data.capabilities?.canManageEmail);

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
      el(
        'td',
        { class: 'small nowrap' },
        el(
          'span',
          { class: 'muted' },
          m.usedMb != null || m.quotaMb != null ? `${formatMb(m.usedMb)} / ${formatMb(m.quotaMb)}` : '—',
        ),
        // Admins see at a glance which figures were set by hand.
        isAdmin && (m.usesCustomQuota || m.usesCustomUsed)
          ? el('span', { class: 'badge', style: 'margin-left:8px' }, 'Custom')
          : null,
      ),
      isAdmin
        ? el(
            'td',
            {},
            el('span', { class: `badge ${m.isFromProvider ? 'accent' : ''}` }, m.isFromProvider ? 'Provider' : 'Manual'),
          )
        : null,
      el(
        'td',
        { class: 'actions' },
        el(
          'button',
          { class: 'btn sm primary', onclick: () => navigate(`mail/${d.id}~${m.id}`) },
          'Open inbox',
        ),
        ' ',
        el('button', { class: 'btn sm', onclick: () => emailModal(d.id, m) }, 'Edit'),
        ' ',
        // Password and provider deletion only mean anything for a mailbox that
        // actually exists at the provider.
        canWrite && (m.externalId || m.isManaged)
          ? [
              el('button', { class: 'btn sm', onclick: () => passwordModal(d.id, m) }, 'Password'),
              ' ',
            ]
          : null,
        el('button', { class: 'btn sm danger', onclick: () => deleteMailboxModal(d, m, canWrite) }, 'Delete'),
      ),
    ),
  );

  const panel = el('div');
  const mailboxCard = el(
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
          isAdmin
            ? canSync
              ? 'Mailboxes are read from the provider where an email plan exists. You can also add mailboxes manually.'
              : 'No provider email integration for this domain — mailboxes are tracked manually.'
            : 'The mailboxes on this domain. Use Refresh above to reload them.',
        ),
      ),
      canSync ? syncBtn : null,
      el('button', { class: 'btn', onclick: () => emailModal(d.id) }, '+ Track Manually'),
      canWrite
        ? el('button', { class: 'btn primary', onclick: () => createMailboxModal(d) }, '+ Create Mailbox')
        : null,
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
                isAdmin ? el('th', {}, 'Source') : null,
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
            'mail',
            'No mailboxes listed',
            isAdmin
              ? canSync
                ? 'Click "Load from provider", or add a mailbox manually if the provider has no email plan for this domain.'
                : 'Add a mailbox to track it here.'
              : 'Use Refresh above to load them, or create a mailbox.',
          ),
        ),
  );

  panel.append(mailboxCard);
  // Forwarders and aliases are shown to admins only: the card describes the
  // provider's own panel.
  if (isAdmin && d.provider && data.capabilities?.emailExtras) panel.append(emailExtrasCard(d));
  return panel;
}

/// Forwarders, aliases, autoreplies and catch-alls, read live from the
/// provider. Read-only here: they are managed in the provider's own panel, and
/// showing them beats pretending they do not exist.
function emailExtrasCard(domain) {
  const body = el('div', { class: 'card-body' }, el('div', { class: 'muted small' }, 'Loading…'));

  api(`/domains/${domain.id}/emails/extras`)
    .then(({ supported, extras, error }) => {
      clear(body);
      if (!supported) return body.append(el('div', { class: 'muted small' }, 'Not available for this provider.'));
      if (error) return body.append(el('div', { class: 'alert error', style: 'margin:0' }, error));

      const sections = [
        ['Forwarders', extras.forwarders, (f) => `${f.mailbox} → ${f.destination}`, (f) => (f.isConfirmed === false ? 'Pending confirmation' : null)],
        ['Aliases', extras.aliases, (a) => `${a.address} → ${a.mailbox}`, () => null],
        ['Auto-replies', extras.autoreplies, (r) => `${r.mailbox}${r.subject ? ` — ${r.subject}` : ''}`, (r) => (r.endsAt ? `until ${formatDate(r.endsAt)}` : null)],
        ['Catch-all', extras.catchalls, (c) => `${c.domain || domain.name} → ${c.mailbox}`, (c) => (c.isConfirmed === false ? 'Pending confirmation' : null)],
      ].filter(([, list]) => Array.isArray(list) && list.length);

      if (!sections.length) {
        return body.append(
          emptyState('mail', 'None configured', 'No forwarders, aliases, auto-replies or catch-all are set for this domain.'),
        );
      }

      body.append(
        ...sections.map(([label, list, describe, note]) =>
          el(
            'div',
            { style: 'margin-bottom:18px' },
            el('div', { class: 'strong small', style: 'margin-bottom:8px' }, `${label} (${list.length})`),
            el(
              'dl',
              { class: 'dl' },
              list.map((item) =>
                el(
                  'div',
                  {},
                  el('dt', { class: 'mono break' }, describe(item)),
                  el('dd', { class: 'small muted' }, note(item) || (item.isActive === false ? 'Inactive' : 'Active')),
                ),
              ),
            ),
          ),
        ),
      );
    })
    .catch((err) => clear(body).append(el('div', { class: 'alert error', style: 'margin:0' }, err.message)));

  return el(
    'div',
    { class: 'card' },
    el(
      'div',
      { class: 'card-head' },
      el(
        'div',
        { class: 'grow' },
        el('h2', {}, 'Forwarders, aliases & auto-replies'),
        el('p', {}, "Read live from the provider. Manage these in the provider's own panel."),
      ),
    ),
    body,
  );
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
    // Never pre-filled: the server does not send the password back. Leaving it
    // empty keeps the stored one.
    ftpPassword: el('input', {
      type: 'password',
      autocomplete: 'off',
      placeholder: s.hasFtpPassword ? `Saved (${s.ftpPasswordHint}) — leave blank to keep it` : '',
    }),
    ftpRootPath: el('input', { type: 'text', value: s.ftpRootPath || '', placeholder: '/public_html' }),
    imapHost: el('input', { type: 'text', value: s.imapHost || '', placeholder: 'imap.example.com' }),
    imapPort: el('input', { type: 'number', value: s.imapPort ?? '', placeholder: '993' }),
    smtpHost: el('input', { type: 'text', value: s.smtpHost || '', placeholder: 'smtp.example.com' }),
    smtpPort: el('input', { type: 'number', value: s.smtpPort ?? '', placeholder: '465' }),
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
          'FTP/FTPS credentials and server details cannot be fetched automatically, so they are configured here by hand.',
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
          field('Password', inputs.ftpPassword, s.hasFtpPassword ? 'A password is already saved. Type a new one only to replace it.' : null),
          field(
            'Root folder',
            inputs.ftpRootPath,
            'The file manager is confined to this folder. Usually /public_html. Leave blank for the login directory.',
          ),
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
      el(
        'div',
        { class: 'card-head' },
        el(
          'div',
          { class: 'grow' },
          el('h2', {}, 'Mail servers'),
          el('p', {}, 'Needed to open a mailbox from inside the portal.'),
        ),
      ),
      el(
        'div',
        { class: 'card-body' },
        el('div', { class: 'form-row' }, field('IMAP host (incoming)', inputs.imapHost), field('IMAP port', inputs.imapPort)),
        el('div', { class: 'form-row' }, field('SMTP host (outgoing)', inputs.smtpHost), field('SMTP port', inputs.smtpPort)),
        el(
          'p',
          { class: 'hint', style: 'margin:0' },
          'Ports 993 (IMAP) and 465 (SMTP) are the usual encrypted ones. Your provider lists these under email or webmail settings.',
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
