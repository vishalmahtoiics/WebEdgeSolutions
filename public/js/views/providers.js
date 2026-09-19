import {
  api, el, clear, field, submitHandler, toast, openModal, confirmModal,
  relativeTime, emptyState, errorAlert,
} from '../core.js';
import { refresh, navigate } from '../app.js';

export async function renderProviders() {
  const [{ providers }, { adapters }] = await Promise.all([
    api('/providers'),
    api('/providers/adapters'),
  ]);

  const frag = el('div');
  frag.append(
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        { class: 'grow' },
        el('h1', {}, 'Providers / APIs'),
        el('p', {}, 'Connect a hosting provider, test the credentials, then sync its domains.'),
      ),
      el(
        'div',
        { class: 'page-actions' },
        el('button', { class: 'btn primary', onclick: () => providerModal({ adapters }) }, '+ Add Provider'),
      ),
    ),
  );

  if (!providers.length) {
    frag.append(
      el(
        'div',
        { class: 'card' },
        el(
          'div',
          { class: 'card-body' },
          emptyState('plug', 'No providers configured', 'Add your Hostinger API token to get started.'),
        ),
      ),
    );
    return frag;
  }

  providers.forEach((p) => frag.append(providerCard(p, adapters)));
  return frag;
}

function providerCard(provider, adapters) {
  const resultHost = el('div', { style: 'margin-top:14px' });

  // The Sync button only appears once a connection test has actually passed,
  // so nobody tries to import domains with a broken token.
  const syncBtn = el(
    'button',
    { class: 'btn primary', disabled: !provider.lastTestOk },
    'Sync Domains',
  );
  syncBtn.onclick = async () => {
    syncBtn.disabled = true;
    const original = syncBtn.textContent;
    clear(syncBtn).append(el('span', { class: 'spinner' }), 'Syncing…');
    clear(resultHost);
    try {
      const res = await api(`/providers/${provider.id}/sync`, { method: 'POST' });
      resultHost.append(
        el(
          'div',
          { class: 'alert ok', style: 'margin:0' },
          res.message,
          ' ',
          el('a', { href: '#/domains', onclick: () => navigate('domains') }, 'View domains →'),
        ),
      );
      toast(res.message, 'ok');
    } catch (err) {
      resultHost.append(el('div', { class: 'alert error', style: 'margin:0' }, err.message));
    } finally {
      syncBtn.disabled = false;
      clear(syncBtn).append(original);
    }
  };

  // One action for the whole account: domains, then DNS and mailboxes for each.
  const syncAllBtn = el('button', { class: 'btn', disabled: !provider.lastTestOk }, 'Sync Everything');
  syncAllBtn.onclick = async () => {
    const original = syncAllBtn.textContent;
    [syncBtn, syncAllBtn].forEach((b) => (b.disabled = true));
    clear(syncAllBtn).append(el('span', { class: 'spinner' }), 'Syncing everything…');
    clear(resultHost);
    try {
      const res = await api(`/providers/${provider.id}/sync-all`, { method: 'POST' });
      resultHost.append(
        el(
          'div',
          { class: res.failures.length ? 'alert warn' : 'alert ok', style: 'margin:0' },
          res.message,
          ' ',
          el('a', { href: '#/domains', onclick: () => navigate('domains') }, 'View domains →'),
          res.failures.length
            ? el(
                'ul',
                {},
                res.failures.map((f) => el('li', {}, `${f.domain}: ${f.problems.join(' ')}`)),
              )
            : null,
        ),
      );
      toast(res.message, res.failures.length ? '' : 'ok');
    } catch (err) {
      resultHost.append(el('div', { class: 'alert error', style: 'margin:0' }, err.message));
    } finally {
      [syncBtn, syncAllBtn].forEach((b) => (b.disabled = false));
      clear(syncAllBtn).append(original);
    }
  };

  const testBtn = el('button', { class: 'btn' }, 'Test Connection');
  testBtn.onclick = async () => {
    testBtn.disabled = true;
    const original = testBtn.textContent;
    clear(testBtn).append(el('span', { class: 'spinner' }), 'Testing…');
    clear(resultHost);
    try {
      const res = await api(`/providers/${provider.id}/test`, { method: 'POST' });
      resultHost.append(el('div', { class: 'alert ok', style: 'margin:0' }, `✓ ${res.message}`));
      syncBtn.disabled = false;
      syncAllBtn.disabled = false;
      toast('Connection successful.', 'ok');
    } catch (err) {
      resultHost.append(el('div', { class: 'alert error', style: 'margin:0' }, `✕ ${err.message}`));
      syncBtn.disabled = true;
      syncAllBtn.disabled = true;
    } finally {
      testBtn.disabled = false;
      clear(testBtn).append(original);
    }
  };

  const caps = Object.entries(provider.capabilities || {})
    .filter(([, v]) => v)
    .map(([k]) => k);

  return el(
    'div',
    { class: 'card' },
    el(
      'div',
      { class: 'card-head' },
      el(
        'div',
        { class: 'grow' },
        el(
          'h2',
          {},
          provider.name,
          ' ',
          el('span', { class: `badge ${provider.isActive ? 'ok' : ''}` }, provider.isActive ? 'Active' : 'Inactive'),
        ),
        el('p', {}, `${provider.adapterLabel} · ${provider.domainCount ?? 0} domain(s) imported`),
      ),
      el(
        'div',
        { class: 'page-actions' },
        el('button', { class: 'btn sm', onclick: () => providerModal({ adapters, provider }) }, 'Edit'),
        el(
          'button',
          {
            class: 'btn sm danger',
            onclick: () =>
              confirmModal({
                title: 'Remove provider',
                message: `Remove "${provider.name}"? Imported domains are kept, but they will no longer be linked to this provider.`,
                confirmLabel: 'Remove',
                onConfirm: async () => {
                  await api(`/providers/${provider.id}`, { method: 'DELETE' });
                  toast('Provider removed.', 'ok');
                  refresh();
                },
              }),
          },
          'Remove',
        ),
      ),
    ),
    el(
      'div',
      { class: 'card-body' },
      el(
        'dl',
        { class: 'dl' },
        el('div', {}, el('dt', {}, 'API Token'), el('dd', { class: 'mono' }, provider.tokenHint || 'Not set')),
        el(
          'div',
          {},
          el('dt', {}, 'Documentation'),
          el(
            'dd',
            {},
            provider.docsUrl
              ? el('a', { href: provider.docsUrl, target: '_blank', rel: 'noopener noreferrer' }, provider.docsUrl)
              : '—',
          ),
        ),
        el(
          'div',
          {},
          el('dt', {}, 'Last tested'),
          el(
            'dd',
            {},
            provider.lastTestedAt
              ? el(
                  'span',
                  { class: `badge ${provider.lastTestOk ? 'ok' : 'danger'}` },
                  `${provider.lastTestOk ? 'Success' : 'Failed'} · ${relativeTime(provider.lastTestedAt)}`,
                )
              : el('span', { class: 'muted' }, 'Never tested'),
          ),
        ),
        el('div', {}, el('dt', {}, 'Last sync'), el('dd', {}, relativeTime(provider.lastSyncedAt))),
        el(
          'div',
          {},
          el('dt', {}, 'Supports'),
          el('dd', {}, caps.length ? caps.join(', ') : '—'),
        ),
      ),
      el('div', { style: 'display:flex;gap:9px;flex-wrap:wrap;margin-top:16px' }, testBtn, syncBtn, syncAllBtn),
      resultHost,
      provider.lastTestMessage && !provider.lastTestOk
        ? el('div', { class: 'small muted', style: 'margin-top:10px' }, `Last result: ${provider.lastTestMessage}`)
        : null,
    ),
  );
}

function providerModal({ adapters, provider = null }) {
  const isEdit = Boolean(provider);

  const adapterSelect = el(
    'select',
    { disabled: isEdit },
    adapters.map((a) => el('option', { value: a.key, selected: provider?.adapter === a.key }, a.label)),
  );
  const name = el('input', { type: 'text', value: provider?.name || adapters[0]?.label || '' });
  const token = el('input', {
    type: 'password',
    placeholder: isEdit ? 'Leave blank to keep the current token' : '',
    autocomplete: 'off',
  });
  const docsUrl = el('input', {
    type: 'url',
    value: provider?.docsUrl || adapters[0]?.defaultDocsUrl || '',
  });
  const isActive = el('input', { type: 'checkbox', checked: provider ? provider.isActive : true });

  const selected = () => adapters.find((a) => a.key === adapterSelect.value) || adapters[0];
  adapterSelect.onchange = () => {
    const a = selected();
    if (!isEdit) {
      name.value = a.label;
      docsUrl.value = a.defaultDocsUrl || '';
    }
    tokenHelp.textContent = a.tokenHelp || '';
  };

  const tokenHelp = el('div', { class: 'hint' }, selected()?.tokenHelp || '');
  const alertHost = el('div');
  const save = el('button', { class: 'btn primary' }, isEdit ? 'Save changes' : 'Add provider');

  save.onclick = submitHandler(save, alertHost, async () => {
    const body = {
      name: name.value.trim(),
      docsUrl: docsUrl.value.trim(),
      isActive: isActive.checked,
    };
    if (token.value.trim()) body.token = token.value.trim();

    if (isEdit) {
      await api(`/providers/${provider.id}`, { method: 'PUT', body });
    } else {
      body.adapter = adapterSelect.value;
      if (!body.token) throw new Error('An API token is required.');
      await api('/providers', { method: 'POST', body });
    }
    toast(isEdit ? 'Provider updated.' : 'Provider added.', 'ok');
    close();
    refresh();
  });

  const close = openModal({
    title: isEdit ? `Edit ${provider.name}` : 'Add Provider',
    render: () =>
      el(
        'div',
        {},
        alertHost,
        field('Provider type', adapterSelect, isEdit ? 'The provider type cannot be changed after creation.' : null),
        field('Provider name', name),
        el(
          'div',
          { class: 'field' },
          el('label', {}, `${selected()?.tokenLabel || 'API Token'}${isEdit ? ' (optional)' : ''}`),
          token,
          tokenHelp,
        ),
        field('API documentation URL', docsUrl),
        el('label', { class: 'check' }, isActive, 'Active'),
      ),
    footer: (closeFn) => [el('button', { class: 'btn', onclick: closeFn }, 'Cancel'), save],
  });
}
