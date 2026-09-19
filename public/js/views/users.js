import {
  api, el, field, submitHandler, toast, openModal, confirmModal,
  emptyState, formatDate, initials,
} from '../core.js';
import { refresh } from '../app.js';

export async function renderUsers({ user: me }) {
  const [{ users }, { domains }] = await Promise.all([api('/users'), api('/domains')]);

  const frag = el('div');
  frag.append(
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        { class: 'grow' },
        el('h1', {}, 'Users'),
        el('p', {}, 'Create users, assign domains and control access.'),
      ),
      el(
        'div',
        { class: 'page-actions' },
        el('button', { class: 'btn primary', onclick: () => userModal({ domains }) }, '+ Add User'),
      ),
    ),
  );

  frag.append(
    el(
      'div',
      { class: 'card' },
      el('div', { class: 'card-head' }, el('h2', {}, `${users.length} user${users.length === 1 ? '' : 's'}`)),
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
              el('th', {}, 'Role'),
              el('th', {}, 'Status'),
              el('th', {}, 'Domains'),
              el('th', {}, 'Created'),
              el('th', {}, ''),
            ),
          ),
          el(
            'tbody',
            {},
            users.map((u) =>
              el(
                'tr',
                {},
                el(
                  'td',
                  {},
                  el(
                    'div',
                    { style: 'display:flex;align-items:center;gap:10px' },
                    el('div', { class: 'avatar', style: 'background:#eef1f6;color:#475467' }, initials(u.name)),
                    el(
                      'div',
                      {},
                      el('div', { class: 'strong' }, u.name, u.id === me.id ? el('span', { class: 'muted small' }, ' (you)') : null),
                      el('div', { class: 'small muted' }, u.email),
                    ),
                  ),
                ),
                el(
                  'td',
                  {},
                  el('span', { class: `badge ${u.role === 'SUPER_ADMIN' ? 'accent' : ''}` }, u.role === 'SUPER_ADMIN' ? 'Super Admin' : 'User'),
                ),
                el('td', {}, el('span', { class: `badge ${u.isActive ? 'ok' : 'danger'}` }, u.isActive ? 'Active' : 'Disabled')),
                el(
                  'td',
                  {},
                  u.role === 'SUPER_ADMIN' ? el('span', { class: 'muted small' }, 'All') : String(u.domainCount ?? 0),
                ),
                el('td', { class: 'small muted nowrap' }, formatDate(u.createdAt)),
                el(
                  'td',
                  { class: 'actions' },
                  u.role !== 'SUPER_ADMIN'
                    ? el('button', { class: 'btn sm', onclick: () => assignModal(u, domains) }, 'Domains')
                    : null,
                  ' ',
                  el('button', { class: 'btn sm', onclick: () => resourceModal(u) }, 'Resources'),
                  ' ',
                  el('button', { class: 'btn sm', onclick: () => userModal({ domains, user: u }) }, 'Edit'),
                  ' ',
                  u.id !== me.id
                    ? el(
                        'button',
                        {
                          class: 'btn sm danger',
                          onclick: () =>
                            confirmModal({
                              title: 'Delete user',
                              message: `Delete ${u.name} (${u.email})? Their domain assignments and resource allocation are removed too.`,
                              confirmLabel: 'Delete',
                              onConfirm: async () => {
                                await api(`/users/${u.id}`, { method: 'DELETE' });
                                toast('User deleted.', 'ok');
                                refresh();
                              },
                            }),
                        },
                        'Delete',
                      )
                    : null,
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );

  return frag;
}

function userModal({ domains, user = null }) {
  const isEdit = Boolean(user);
  const name = el('input', { type: 'text', value: user?.name || '' });
  const email = el('input', { type: 'email', value: user?.email || '' });
  const password = el('input', {
    type: 'password',
    autocomplete: 'new-password',
    placeholder: isEdit ? 'Leave blank to keep the current password' : '',
  });
  const role = el(
    'select',
    {},
    el('option', { value: 'USER', selected: user?.role !== 'SUPER_ADMIN' }, 'User'),
    el('option', { value: 'SUPER_ADMIN', selected: user?.role === 'SUPER_ADMIN' }, 'Super Admin'),
  );
  const isActive = el('input', { type: 'checkbox', checked: user ? user.isActive : true });

  const alertHost = el('div');
  const save = el('button', { class: 'btn primary' }, isEdit ? 'Save changes' : 'Create user');

  save.onclick = submitHandler(save, alertHost, async () => {
    const body = {
      name: name.value.trim(),
      email: email.value.trim().toLowerCase(),
      role: role.value,
      isActive: isActive.checked,
    };
    if (password.value) body.password = password.value;

    if (isEdit) {
      await api(`/users/${user.id}`, { method: 'PUT', body });
    } else {
      if (!password.value) throw new Error('A password is required.');
      await api('/users', { method: 'POST', body });
    }
    toast(isEdit ? 'User updated.' : 'User created.', 'ok');
    close();
    refresh();
  });

  const close = openModal({
    title: isEdit ? `Edit ${user.name}` : 'Add User',
    render: () =>
      el(
        'div',
        {},
        alertHost,
        field('Full name', name),
        field('Email address', email),
        field(isEdit ? 'New password (optional)' : 'Password', password, 'At least 8 characters.'),
        field('Role', role, 'Super Admins can see and manage everything.'),
        el('label', { class: 'check' }, isActive, 'Account is active'),
      ),
    footer: (closeFn) => [el('button', { class: 'btn', onclick: closeFn }, 'Cancel'), save],
  });
}

function assignModal(user, domains) {
  const alertHost = el('div');
  const save = el('button', { class: 'btn primary' }, 'Save assignments');

  const boxes = new Map();
  const list = el('div', { class: 'checklist' });

  api(`/users/${user.id}`).then(({ user: full }) => {
    const assigned = new Set((full.domains || []).map((d) => d.id));
    list.replaceChildren(
      ...domains.map((d) => {
        const box = el('input', { type: 'checkbox', checked: assigned.has(d.id) });
        boxes.set(d.id, box);
        return el(
          'label',
          { class: 'check' },
          box,
          el('span', {}, el('span', { class: 'strong' }, d.name), ' ', el('span', { class: 'muted small' }, `· ${d.sourceLabel}`)),
        );
      }),
    );
    if (!domains.length) list.replaceChildren(emptyState('globe', 'No domains available'));
  });

  save.onclick = submitHandler(save, alertHost, async () => {
    const domainIds = [...boxes.entries()].filter(([, box]) => box.checked).map(([id]) => id);
    await api(`/users/${user.id}/domains`, { method: 'PUT', body: { domainIds } });
    toast('Domain assignments updated.', 'ok');
    close();
    refresh();
  });

  const close = openModal({
    title: `Assign domains to ${user.name}`,
    wide: true,
    render: () =>
      el(
        'div',
        {},
        alertHost,
        el('p', { class: 'muted small', style: 'margin-top:0' }, 'This user can only see and manage the domains you tick here.'),
        list,
      ),
    footer: (closeFn) => [el('button', { class: 'btn', onclick: closeFn }, 'Cancel'), save],
  });
}

export function resourceModal(user) {
  const r = user.resource || {};
  const cpuCores = el('input', { type: 'number', value: r.cpuCores ?? '', min: 0 });
  const ramMb = el('input', { type: 'number', value: r.ramMb ?? '', min: 0 });
  const storageGb = el('input', { type: 'number', value: r.storageGb ?? '', min: 0 });
  const bandwidthGb = el('input', { type: 'number', value: r.bandwidthGb ?? '', min: 0 });
  const notes = el('textarea', {}, r.notes || '');

  const alertHost = el('div');
  const save = el('button', { class: 'btn primary' }, 'Save resources');

  const num = (input) => (input.value === '' ? null : Number(input.value));

  save.onclick = submitHandler(save, alertHost, async () => {
    await api(`/users/${user.id}/resources`, {
      method: 'PUT',
      body: {
        cpuCores: num(cpuCores),
        ramMb: num(ramMb),
        storageGb: num(storageGb),
        bandwidthGb: num(bandwidthGb),
        notes: notes.value.trim(),
      },
    });
    toast('Resources saved.', 'ok');
    close();
    refresh();
  });

  const close = openModal({
    title: `Server resources for ${user.name}`,
    render: () =>
      el(
        'div',
        {},
        alertHost,
        el('p', { class: 'muted small', style: 'margin-top:0' }, 'These values are set by hand and shown to the user on their dashboard.'),
        el('div', { class: 'form-row' }, field('CPU cores', cpuCores), field('RAM (MB)', ramMb)),
        el('div', { class: 'form-row' }, field('Storage (GB)', storageGb), field('Bandwidth (GB)', bandwidthGb)),
        field('Notes', notes),
      ),
    footer: (closeFn) => [el('button', { class: 'btn', onclick: closeFn }, 'Cancel'), save],
  });
}
