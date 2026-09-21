// Mailbox dialogs, shared by the domain page and the Emails page.
//
// Creating, re-passwording and destroying a mailbox act on the real mail
// server, so there is one implementation of each rather than a copy per page —
// a second copy is how the confirmation on the dangerous one goes missing.

import { api, el, field, submitHandler, toast, openModal } from '../core.js';
import { refresh } from '../app.js';

/// Creates a real mailbox on the hosting account.
export function createMailboxModal(domain) {
  const localPart = el('input', { type: 'text', placeholder: 'info' });
  const password = el('input', { type: 'password', autocomplete: 'new-password' });
  const confirm = el('input', { type: 'password', autocomplete: 'new-password' });
  const alertHost = el('div');
  const save = el('button', { class: 'btn primary' }, 'Create mailbox');

  save.onclick = submitHandler(save, alertHost, async () => {
    const local = localPart.value.trim().toLowerCase();
    if (!local) throw new Error('Enter the part before the @.');
    if (password.value !== confirm.value) throw new Error('The passwords do not match.');

    const res = await api(`/domains/${domain.id}/emails/provision`, {
      method: 'POST',
      body: { address: `${local}@${domain.name}`, password: password.value },
    });
    toast(res.message, 'ok');
    close();
    refresh();
  });

  const close = openModal({
    title: 'Create mailbox',
    render: () =>
      el(
        'div',
        {},
        alertHost,
        el(
          'div',
          { class: 'alert warn' },
          'This creates a real mailbox on the mail server, not just a record in this portal.',
        ),
        el(
          'div',
          { class: 'field' },
          el('label', {}, 'Address'),
          el(
            'div',
            { style: 'display:flex;align-items:center;gap:8px' },
            localPart,
            el('span', { class: 'muted nowrap' }, `@${domain.name}`),
          ),
        ),
        field('Password', password, 'At least 8 characters, with upper and lower case, a number and a symbol.'),
        field('Confirm password', confirm),
      ),
    footer: (closeFn) => [el('button', { class: 'btn', onclick: closeFn }, 'Cancel'), save],
  });
}

/// Sets a new password on the mail server. Nothing is stored in the portal.
export function passwordModal(domainId, mailbox) {
  const password = el('input', { type: 'password', autocomplete: 'new-password' });
  const confirm = el('input', { type: 'password', autocomplete: 'new-password' });
  const alertHost = el('div');
  const save = el('button', { class: 'btn primary' }, 'Change password');

  save.onclick = submitHandler(save, alertHost, async () => {
    if (password.value !== confirm.value) throw new Error('The passwords do not match.');
    const res = await api(`/domains/${domainId}/emails/${mailbox.id}/password`, {
      method: 'POST',
      body: { password: password.value },
    });
    toast(res.message, 'ok');
    close();
  });

  const close = openModal({
    title: `Password for ${mailbox.address}`,
    render: () =>
      el(
        'div',
        {},
        alertHost,
        el('p', { class: 'muted small', style: 'margin-top:0' }, 'The new password takes effect immediately. The portal does not keep a copy.'),
        field('New password', password, 'At least 8 characters, with upper and lower case, a number and a symbol.'),
        field('Confirm password', confirm),
      ),
    footer: (closeFn) => [el('button', { class: 'btn', onclick: closeFn }, 'Cancel'), save],
  });
}

/// Deleting a portal record and destroying a real mailbox are very different
/// acts, so they are presented as an explicit choice rather than one button
/// whose meaning depends on context.
export function deleteMailboxModal(domain, mailbox, canWrite) {
  const atProvider = canWrite && Boolean(mailbox.externalId || mailbox.isManaged);
  const alertHost = el('div');

  const removeLocal = el('button', { class: 'btn' }, 'Remove from portal only');
  removeLocal.onclick = submitHandler(removeLocal, alertHost, async () => {
    await api(`/domains/${domain.id}/emails/${mailbox.id}`, { method: 'DELETE' });
    toast('Removed from the portal. The mailbox itself is untouched.', 'ok');
    close();
    refresh();
  });

  // Typing the address is a deliberate speed bump: this destroys real mail.
  const confirmText = el('input', { type: 'text', placeholder: mailbox.address, autocomplete: 'off' });
  const destroy = el('button', { class: 'btn danger', disabled: true }, 'Delete permanently');
  confirmText.oninput = () => {
    destroy.disabled = confirmText.value.trim().toLowerCase() !== mailbox.address.toLowerCase();
  };
  destroy.onclick = submitHandler(destroy, alertHost, async () => {
    const res = await api(`/domains/${domain.id}/emails/${mailbox.id}/destroy`, { method: 'DELETE' });
    toast(res.message, 'ok');
    close();
    refresh();
  });

  const close = openModal({
    title: `Delete ${mailbox.address}`,
    render: () =>
      el(
        'div',
        {},
        alertHost,
        !atProvider
          ? el(
              'p',
              { class: 'muted', style: 'margin-top:0' },
              'This mailbox exists only as a record in this portal, so removing it changes nothing on the mail server.',
            )
          : el(
              'div',
              {},
              el(
                'p',
                { style: 'margin-top:0' },
                'This is a live mailbox. Choose what should happen:',
              ),
              el(
                'div',
                { class: 'alert danger', style: 'background:#fdeceb;color:#c02626;border-color:#f5cecb' },
                el('strong', {}, 'Delete permanently'),
                ' destroys the mailbox and every message in it. This cannot be undone.',
              ),
              field('Type the address to confirm permanent deletion', confirmText),
            ),
      ),
    footer: (closeFn) => [
      el('button', { class: 'btn ghost', onclick: closeFn }, 'Cancel'),
      atProvider ? removeLocal : null,
      atProvider ? destroy : el('button', { class: 'btn danger', onclick: () => removeLocal.click() }, 'Remove'),
    ],
  });
}

/// A value that is either the real one from the server or a custom one.
///
/// The checkbox is the whole point: an administrator can see what the provider
/// actually reports and decide, per value, whether to show that or their own
/// figure. Ticking it clears the override, so the value goes back to tracking
/// every sync rather than freezing at whatever was last typed.
function realOrCustom({ label, realValue, overrideValue, unit = 'MB' }) {
  const hasReal = realValue !== null && realValue !== undefined;
  const usesCustom = overrideValue !== null && overrideValue !== undefined;

  const input = el('input', {
    type: 'number',
    min: 0,
    value: usesCustom ? overrideValue : (realValue ?? ''),
  });

  const checkbox = el('input', { type: 'checkbox', checked: !usesCustom, disabled: !hasReal });

  const realText = el(
    'div',
    { class: 'hint' },
    hasReal
      ? `Real value from the server: ${realValue} ${unit}`
      : 'The server does not report a value for this mailbox, so a custom one is used.',
  );

  const apply = () => {
    const useReal = checkbox.checked;
    input.disabled = useReal;
    if (useReal && hasReal) input.value = realValue;
  };
  checkbox.onchange = apply;
  apply();

  return {
    node: el(
      'div',
      { class: 'field' },
      el('label', {}, `${label} (${unit})`),
      el(
        'label',
        { class: 'check', style: 'margin-bottom:8px' },
        checkbox,
        hasReal ? 'Use the real value from the server' : 'No real value available',
      ),
      input,
      realText,
    ),
    read: () => ({
      useReal: checkbox.checked && hasReal,
      value: input.value === '' ? null : Number(input.value),
    }),
  };
}

export function emailModal(domainId, mailbox = null) {
  const address = el('input', { type: 'email', value: mailbox?.address || '' });
  const status = el(
    'select',
    {},
    ['active', 'suspended', 'pending'].map((v) =>
      el('option', { value: v, selected: mailbox?.status === v }, v[0].toUpperCase() + v.slice(1)),
    ),
  );

  // On an existing mailbox each figure can be the server's or a custom one.
  // A new manual mailbox has no server figures, so it is a plain number.
  const editing = Boolean(mailbox);
  const quota = editing
    ? realOrCustom({
        label: 'Quota',
        realValue: mailbox.providerQuotaMb,
        overrideValue: mailbox.quotaMbOverride,
      })
    : null;
  const used = editing
    ? realOrCustom({
        label: 'Used',
        realValue: mailbox.providerUsedMb,
        overrideValue: mailbox.usedMbOverride,
      })
    : null;

  const plainQuota = el('input', { type: 'number', min: 0 });
  const plainUsed = el('input', { type: 'number', min: 0 });
  const notes = el('textarea', {}, mailbox?.notes || '');

  const alertHost = el('div');
  const save = el('button', { class: 'btn primary' }, editing ? 'Save mailbox' : 'Add mailbox');

  save.onclick = submitHandler(save, alertHost, async () => {
    const q = quota ? quota.read() : { useReal: false, value: plainQuota.value === '' ? null : Number(plainQuota.value) };
    const u = used ? used.read() : { useReal: false, value: plainUsed.value === '' ? null : Number(plainUsed.value) };

    const body = {
      address: address.value.trim().toLowerCase(),
      status: status.value,
      useRealQuota: q.useReal,
      useRealUsed: u.useReal,
      quotaMb: q.value,
      usedMb: u.value,
      notes: notes.value.trim(),
    };

    const path = editing ? `/domains/${domainId}/emails/${mailbox.id}` : `/domains/${domainId}/emails`;
    await api(path, { method: editing ? 'PUT' : 'POST', body });
    toast(editing ? 'Mailbox updated.' : 'Mailbox added.', 'ok');
    close();
    refresh();
  });

  const close = openModal({
    title: editing ? `Edit ${mailbox.address}` : 'Add Mailbox',
    render: () =>
      el(
        'div',
        {},
        alertHost,
        field('Email address', address),
        field('Status', status),
        editing
          ? el(
              'div',
              {},
              el(
                'p',
                { class: 'muted small' },
                'Untick a value to show your own figure instead of the one reported by the server.',
              ),
              quota.node,
              used.node,
            )
          : el('div', { class: 'form-row' }, field('Quota (MB)', plainQuota), field('Used (MB)', plainUsed)),
        field('Notes', notes),
      ),
    footer: (closeFn) => [el('button', { class: 'btn', onclick: closeFn }, 'Cancel'), save],
  });
}
