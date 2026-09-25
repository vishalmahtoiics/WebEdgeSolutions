// Mailbox dialogs, shared by the domain page and the Emails page.
//
// Creating, re-passwording and destroying a mailbox act on the real mail
// server, so there is one implementation of each rather than a copy per page —
// a second copy is how the confirmation on the dangerous one goes missing.

import { api, el, clear, fill, field, submitHandler, toast, openModal } from '../core.js';
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

/// How many mailboxes go in one request. Matches the server's own limit: the
/// browser splits a larger selection so no single request runs long enough to
/// be cut off part-way through deleting real mail.
const BULK_CHUNK = 25;

/// Deletes a selection of mailboxes.
///
/// The two choices are the same two the single-mailbox dialog offers, because
/// they are genuinely different acts: forgetting a record here, or destroying
/// mail on a server. Doing fifty at once does not make them any less different,
/// so this asks in the same words and puts the harmless one first.
export function bulkDeleteMailboxesModal(domain, mailboxes, canWrite) {
  // Sent in the order they were picked, so the progress line reads in the
  // order the list is shown.
  const live = mailboxes.filter((m) => m.externalId || m.isManaged);
  const atProvider = canWrite && live.length > 0;

  const alertHost = el('div');
  const progress = el('div', { class: 'small muted', style: 'margin-top:10px' });

  /// Runs the delete in chunks, keeping the reader posted, and returns every
  /// per-mailbox result the server sent back.
  async function run(mode) {
    const ids = mailboxes.map((m) => m.id);
    const results = [];
    let done = 0;

    for (let i = 0; i < ids.length; i += BULK_CHUNK) {
      const batch = ids.slice(i, i + BULK_CHUNK);
      progress.textContent =
        ids.length > BULK_CHUNK
          ? `Deleting ${done + 1}\u2013${done + batch.length} of ${ids.length}\u2026`
          : '';

      // A failed chunk must not hide the chunks that already went: those
      // mailboxes are gone, and the reader has to be told which.
      let res;
      try {
        res = await api(`/domains/${domain.id}/emails/bulk-delete`, {
          method: 'POST',
          body: { ids: batch, mode },
        });
      } catch (err) {
        if (!results.length) throw err;
        results.push(
          ...batch.map((id) => ({
            id,
            address: mailboxes.find((m) => m.id === id)?.address || id,
            ok: false,
            error: err.message,
          })),
        );
        break;
      }

      results.push(...(res.results || []));
      done += batch.length;
    }

    return results;
  }

  /// Says what happened, by name, and leaves the dialog open when some of it
  /// failed — a toast that vanishes is no way to learn that eight mailboxes
  /// are still there.
  function report(results, mode) {
    const failed = results.filter((r) => !r.ok);
    const done = results.filter((r) => r.ok);

    if (!failed.length) {
      toast(
        mode === 'provider'
          ? `Permanently deleted ${done.length} mailbox${done.length === 1 ? '' : 'es'}.`
          : `Removed ${done.length} mailbox${done.length === 1 ? '' : 'es'} from the portal.`,
        'ok',
      );
      close();
      refresh();
      return;
    }

    // The question has been answered, so it stops being asked: the list headed
    // "these will be deleted" is no longer true of the ones that already have
    // been, and the buttons that did it have nothing left to do.
    askSection.remove();
    fill(
      alertHost,
      el(
        'div',
        { class: 'alert error' },
        el(
          'div',
          { class: 'strong' },
          done.length
            ? `${done.length} deleted, ${failed.length} could not be.`
            : failed.length === 1
              ? 'That mailbox could not be deleted.'
              : `None of the ${failed.length} could be deleted.`,
        ),
        el(
          'ul',
          { style: 'margin:8px 0 0' },
          failed.map((r) => el('li', {}, el('span', { class: 'mono' }, r.address), `: ${r.error}`)),
        ),
        el(
          'div',
          { class: 'small', style: 'margin-top:10px' },
          failed.length === 1 ? 'It is still listed, and still exists.' : 'They are still listed, and still exist.',
        ),
      ),
    );
    fill(foot, el('button', { class: 'btn primary', onclick: () => close() }, 'Close'));

    // What did go is gone, so the table behind this dialog is now wrong.
    if (done.length) refresh();
  }

  const removeLocal = el(
    'button',
    { class: 'btn' },
    atProvider ? 'Remove from portal only' : `Remove ${mailboxes.length}`,
  );
  removeLocal.onclick = submitHandler(removeLocal, alertHost, async () => {
    report(await run('portal'), 'portal');
  });

  // Typing the domain name is the speed bump. The single-mailbox dialog asks
  // for the address; there is no one address here, and a number would be too
  // easy to type without reading.
  const confirmText = el('input', { type: 'text', placeholder: domain.name, autocomplete: 'off' });
  const destroy = el('button', { class: 'btn danger', disabled: true }, `Delete ${live.length} permanently`);
  confirmText.oninput = () => {
    destroy.disabled = confirmText.value.trim().toLowerCase() !== String(domain.name).toLowerCase();
  };
  destroy.onclick = submitHandler(destroy, alertHost, async () => {
    report(await run('provider'), 'provider');
  });

  // Named, because once the deleting is done these stop being true and have
  // to go: a list headed "these will be deleted" is a lie the moment six of
  // the seven already have been.
  const askSection = el(
    'div',
    {},
    // Every address, in full. A count is not something anybody can check, and
    // this is the last chance to notice the wrong row is ticked.
    el('p', { style: 'margin-top:0' }, 'These will be deleted:'),
    el(
      'div',
      { class: 'bulk-list' },
      mailboxes.map((m) =>
        el(
          'div',
          { class: 'bulk-list-row' },
          el('span', { class: 'mono break' }, m.address),
          // Marked only where the mark means something. When the whole
          // selection is getting the same treatment, badging some rows "Live"
          // suggests a difference that is not about to happen — and reads as a
          // contradiction next to the note below.
          !atProvider
            ? null
            : m.externalId || m.isManaged
              ? el('span', { class: 'badge danger' }, 'Deleted for real')
              : el('span', { class: 'badge' }, 'Portal record only'),
        ),
      ),
    ),
    atProvider
      ? el(
          'div',
          {},
          el(
            'div',
            { class: 'alert danger', style: 'margin-top:14px' },
            el('strong', {}, `Delete ${live.length} permanently`),
            ` destroys ${live.length === 1 ? 'that mailbox' : 'those mailboxes'} and every message in `,
            live.length === 1 ? 'it' : 'them',
            '. This cannot be undone.',
            mailboxes.length > live.length
              ? ` The other ${mailboxes.length - live.length} exist only in this portal and will simply be forgotten.`
              : '',
          ),
          field(`Type ${domain.name} to confirm permanent deletion`, confirmText),
        )
      : el(
          'p',
          { class: 'muted' },
          live.length
            ? // They came from a mail server, but this portal has no way to
              // reach one for this domain — so it can only forget them, and
              // saying "these exist only here" would not be true.
              'This portal cannot delete mailboxes on this domain\u2019s mail server, so this removes its records only. Anything still on the server comes back on the next refresh.'
            : 'These exist only as records in this portal, so removing them changes nothing on the mail server. A refresh brings back any that still exist.',
        ),
    progress,
  );

  // The footer is ours to rewrite too: after a partial failure there is
  // nothing left to confirm, and a button still reading "Working…" because it
  // was disabled mid-flight and never spoken to again is worse than no button.
  const foot = el('div', { class: 'modal-actions' });
  fill(
    foot,
    el('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'),
    removeLocal,
    atProvider ? destroy : null,
  );

  const close = openModal({
    title: `Delete ${mailboxes.length} mailbox${mailboxes.length === 1 ? '' : 'es'}`,
    wide: true,
    render: () => el('div', {}, alertHost, askSection),
    footer: () => foot,
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

export function emailModal(domainId, mailbox = null, { isAdmin = true } = {}) {
  // A customer can list a mailbox and keep a note on it, and that is all:
  // its address, status and size are the administrator's to set, and the
  // server refuses them from anyone else.
  if (!isAdmin) return customerMailboxModal(domainId, mailbox);

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

/// The customer's version of the dialog above: the address (fixed once the
/// mailbox exists) and a note. No size, no usage, no status.
function customerMailboxModal(domainId, mailbox) {
  const editing = Boolean(mailbox);
  const address = el('input', { type: 'email', value: mailbox?.address || '', disabled: editing });
  const notes = el('textarea', {}, mailbox?.notes || '');
  const alertHost = el('div');
  const save = el('button', { class: 'btn primary' }, editing ? 'Save note' : 'Add mailbox');

  save.onclick = submitHandler(save, alertHost, async () => {
    const body = { address: address.value.trim().toLowerCase(), notes: notes.value.trim() };
    const path = editing ? `/domains/${domainId}/emails/${mailbox.id}` : `/domains/${domainId}/emails`;
    await api(path, { method: editing ? 'PUT' : 'POST', body });
    toast(editing ? 'Note saved.' : 'Mailbox added.', 'ok');
    close();
    refresh();
  });

  const close = openModal({
    title: editing ? mailbox.address : 'Add Mailbox',
    render: () =>
      el(
        'div',
        {},
        alertHost,
        field('Email address', address),
        field('Notes', notes),
        editing
          ? el('p', { class: 'muted small', style: 'margin-bottom:0' }, 'The size of a mailbox is set by your administrator.')
          : null,
      ),
    footer: (closeFn) => [el('button', { class: 'btn', onclick: closeFn }, 'Cancel'), save],
  });
}
