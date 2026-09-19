import { api, el, clear, field, submitHandler, toast } from '../core.js';

export async function renderProfile({ user }) {
  const current = el('input', { type: 'password', autocomplete: 'current-password' });
  const next = el('input', { type: 'password', autocomplete: 'new-password' });
  const confirm = el('input', { type: 'password', autocomplete: 'new-password' });

  const alertHost = el('div');
  const save = el('button', { class: 'btn primary' }, 'Update password');

  save.onclick = submitHandler(save, alertHost, async () => {
    if (next.value !== confirm.value) throw new Error('The new passwords do not match.');
    await api('/auth/change-password', {
      method: 'POST',
      body: { currentPassword: current.value, newPassword: next.value },
    });
    toast('Password updated.', 'ok');
    [current, next, confirm].forEach((i) => (i.value = ''));
    alertHost.append(el('div', { class: 'alert ok' }, 'Your password has been changed.'));
    save.disabled = false;
    clear(save).append('Update password');
  });

  return el(
    'div',
    {},
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        { class: 'grow' },
        el('h1', {}, user.role === 'SUPER_ADMIN' ? 'Settings' : 'Profile'),
        el('p', {}, 'Your account details and password.'),
      ),
    ),
    el(
      'div',
      { class: 'grid-2' },
      el(
        'div',
        { class: 'card' },
        el('div', { class: 'card-head' }, el('h2', {}, 'Account')),
        el(
          'div',
          { class: 'card-body' },
          el(
            'dl',
            { class: 'dl' },
            el('div', {}, el('dt', {}, 'Name'), el('dd', {}, user.name)),
            el('div', {}, el('dt', {}, 'Email'), el('dd', {}, user.email)),
            el(
              'div',
              {},
              el('dt', {}, 'Role'),
              el('dd', {}, el('span', { class: `badge ${user.role === 'SUPER_ADMIN' ? 'accent' : ''}` }, user.role === 'SUPER_ADMIN' ? 'Super Admin' : 'User')),
            ),
          ),
        ),
      ),
      el(
        'div',
        { class: 'card' },
        el('div', { class: 'card-head' }, el('h2', {}, 'Change password')),
        el(
          'div',
          { class: 'card-body' },
          alertHost,
          field('Current password', current),
          field('New password', next, 'At least 8 characters.'),
          field('Confirm new password', confirm),
          save,
        ),
      ),
    ),
  );
}
