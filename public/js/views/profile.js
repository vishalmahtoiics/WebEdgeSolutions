import {
  api, el, clear, appendAll, field, submitHandler, toast, openModal, formatDate,
} from '../core.js';
import { icon } from '../icons.js';
import { refresh } from '../app.js';

export async function renderProfile({ user }) {
  const { twoFactor } = await api('/auth/2fa').catch(() => ({ twoFactor: { enabled: false } }));

  // Set by the sign-in screen when a recovery code was spent. Shown once.
  const recoveryNotice = sessionStorage.getItem('portal.recoveryNotice');
  sessionStorage.removeItem('portal.recoveryNotice');

  const frag = el('div');
  appendAll(frag, [
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        { class: 'grow' },
        el('h1', {}, user.role === 'SUPER_ADMIN' ? 'Settings' : 'Profile'),
        el('p', {}, 'Your account, your password, and how you sign in.'),
      ),
    ),
    recoveryNotice ? el('div', { class: 'alert warn' }, recoveryNotice, ' Generate a new set below.') : null,

    // The one warning worth putting above everything else. This account can
    // reach every DNS zone, database, mailbox and FTP login the portal
    // manages, and a password on its own is not a proportionate defence.
    !twoFactor.enabled && user.role === 'SUPER_ADMIN'
      ? el(
          'div',
          { class: 'alert warn' },
          el('span', { class: 'strong' }, 'This account is protected by its password alone. '),
          'It can reach every domain, database and mailbox in the portal. Switch on two-factor ' +
            'authentication below — it takes a minute and needs only the authenticator app you already have.',
        )
      : null,

    el('div', { class: 'grid-2' }, accountCard(user), passwordCard()),
    twoFactorCard(twoFactor),
  ]);
  return frag;
}

const accountCard = (user) =>
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
          el(
            'dd',
            {},
            el(
              'span',
              { class: `badge ${user.role === 'SUPER_ADMIN' ? 'accent' : ''}` },
              user.role === 'SUPER_ADMIN' ? 'Super Admin' : 'User',
            ),
          ),
        ),
      ),
    ),
  );

function passwordCard() {
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
  );
}

// ---------------------------------------------------------------------------
// Two-factor authentication
// ---------------------------------------------------------------------------

function twoFactorCard(twoFactor) {
  const body = el('div', { class: 'card-body' });

  if (twoFactor.enabled) {
    const low = twoFactor.recoveryCodesLeft <= 2;
    appendAll(body, [
      el(
        'div',
        { class: 'alert ok' },
        el('span', { class: 'strong' }, 'Switched on. '),
        `Since ${formatDate(twoFactor.enabledAt)}. You need a code from your authenticator app every time you sign in.`,
      ),
      el(
        'div',
        { class: low ? 'alert warn' : 'hint', style: low ? '' : 'margin:12px 0' },
        `${twoFactor.recoveryCodesLeft} of ${twoFactor.recoveryCodesTotal} recovery codes left.` +
          (low ? ' Generate a new set now — running out means losing access to this account.' : ''),
      ),
      el(
        'div',
        { style: 'display:flex;gap:9px;flex-wrap:wrap;margin-top:14px' },
        el('button', { class: 'btn', onclick: regenerate }, 'New recovery codes'),
        el('button', { class: 'btn danger', onclick: turnOff }, 'Turn off'),
      ),
    ]);
  } else {
    appendAll(body, [
      el(
        'p',
        { class: 'muted', style: 'margin:0 0 14px' },
        'A password can be guessed, reused or phished. With two-factor authentication on, signing in ' +
          'also needs a six-digit code from your phone, which changes every thirty seconds.',
      ),
      el(
        'p',
        { class: 'hint', style: 'margin:0 0 16px' },
        'Works with Google Authenticator, Microsoft Authenticator, Authy, 1Password — any of them.',
      ),
      el('button', { class: 'btn primary' , onclick: startSetup }, icon('shield', 16), 'Set up two-factor authentication'),
    ]);
  }

  return el(
    'div',
    { class: 'card', style: 'margin-top:18px' },
    el(
      'div',
      { class: 'card-head' },
      el(
        'div',
        { class: 'grow' },
        el('h2', {}, 'Two-factor authentication'),
        el('p', {}, 'A second step at sign-in, so a stolen password is not enough on its own.'),
      ),
      el('span', { class: `badge ${twoFactor.enabled ? 'ok' : 'warn'}` }, twoFactor.enabled ? 'On' : 'Off'),
    ),
    body,
  );
}

/// The enrolment dialog: scan, then prove it.
///
/// Nothing is saved until the code checks out, so a QR that was scanned badly
/// or a tab closed halfway leaves the account exactly as it was.
async function startSetup() {
  let setup;
  try {
    setup = await api('/auth/2fa/setup', { method: 'POST' });
  } catch (err) {
    return toast(err.message, 'error');
  }

  const code = el('input', {
    type: 'text',
    inputmode: 'numeric',
    placeholder: '123456',
    style: 'font-size:20px;letter-spacing:4px;text-align:center',
  });
  const alertHost = el('div');
  const confirmBtn = el('button', { class: 'btn primary' }, 'Verify and switch on');

  const closeSetup = openModal({
    title: 'Set up two-factor authentication',
    render: () =>
      el(
        'div',
        {},
        alertHost,
        el('p', { class: 'muted', style: 'margin-top:0' }, '1. Scan this with your authenticator app.'),
        el(
          'div',
          { style: 'text-align:center;margin:0 0 14px' },
          el('img', {
            src: setup.qr,
            alt: 'QR code for two-factor setup',
            style: 'width:200px;height:200px;border-radius:10px;background:#fff;padding:8px',
          }),
        ),
        el(
          'details',
          { style: 'margin-bottom:16px' },
          el('summary', { class: 'small muted', style: 'cursor:pointer' }, 'Cannot scan it?'),
          el('p', { class: 'hint', style: 'margin:8px 0 4px' }, 'Type this key into the app by hand:'),
          el(
            'code',
            { class: 'mono break', style: 'display:block;padding:10px;border-radius:8px;background:var(--surface-2,#f1f3f9);font-size:13px' },
            setup.manualKey,
          ),
        ),
        el('p', { class: 'muted' }, '2. Enter the six-digit code it shows.'),
        field('Code from your app', code),
      ),
    footer: () => confirmBtn,
  });

  code.focus();

  confirmBtn.onclick = submitHandler(confirmBtn, alertHost, async () => {
    const { recoveryCodes } = await api('/auth/2fa/enable', { method: 'POST', body: { code: code.value } });
    closeSetup();
    showRecoveryCodes(recoveryCodes, 'Two-factor authentication is on.');
  });
}

async function regenerate() {
  promptPassword({
    title: 'New recovery codes',
    intro: 'Your current codes will stop working straight away.',
    // No close() here: showRecoveryCodes opens its own dialog, and opening one
    // replaces whatever is on screen.
    action: async (password) => {
      const { recoveryCodes } = await api('/auth/2fa/recovery-codes', { method: 'POST', body: { password } });
      showRecoveryCodes(recoveryCodes, 'Here is your new set. The old ones no longer work.');
    },
  });
}

async function turnOff() {
  promptPassword({
    title: 'Turn off two-factor authentication',
    intro: 'This account will be protected by its password alone.',
    danger: true,
    confirmLabel: 'Turn it off',
    action: async (password, close) => {
      await api('/auth/2fa/disable', { method: 'POST', body: { password } });
      close();
      toast('Two-factor authentication is off.', 'ok');
      refresh();
    },
  });
}

/// Anything that weakens the second factor asks for the password again, so
/// walking up to an unlocked screen is not enough to remove it.
function promptPassword({ title, intro, action, danger = false, confirmLabel = 'Confirm' }) {
  const password = el('input', { type: 'password', autocomplete: 'current-password' });
  const alertHost = el('div');
  const go = el('button', { class: `btn ${danger ? 'danger' : 'primary'}` }, confirmLabel);

  const close = openModal({
    title,
    render: () =>
      el(
        'div',
        {},
        alertHost,
        el('p', { class: 'muted', style: 'margin-top:0' }, intro),
        field('Your password', password),
      ),
    footer: () => go,
  });

  password.focus();
  // The dialog stays open until the action decides otherwise, so a wrong
  // password shows its error here rather than closing and leaving nothing.
  go.onclick = submitHandler(go, alertHost, () => action(password.value, close));
}

/// The codes, shown once.
///
/// Only their hashes are kept, so this dialog genuinely cannot be reopened —
/// which is said on it, because "I will write them down later" is how people
/// lose accounts.
function showRecoveryCodes(codes, intro) {
  const text = codes.join('\n');

  openModal({
    title: 'Your recovery codes',
    render: () =>
      el(
        'div',
        {},
        el('div', { class: 'alert ok' }, intro),
        el(
          'p',
          { class: 'muted' },
          'Keep these somewhere safe and away from your phone. Each one works once, and they are the ' +
            'only way back in if you lose the authenticator app.',
        ),
        el(
          'div',
          {
            class: 'mono',
            style:
              'display:grid;grid-template-columns:1fr 1fr;gap:8px 18px;padding:16px;border-radius:10px;' +
              'background:var(--surface-2,#f1f3f9);font-size:15px;letter-spacing:1px;margin:4px 0 14px',
          },
          codes.map((c) => el('div', {}, c)),
        ),
        el(
          'div',
          { class: 'alert warn', style: 'margin:0' },
          el('span', { class: 'strong' }, 'This is the only time they are shown. '),
          'The portal stores only a fingerprint of each one, so it cannot show them again — not to you, ' +
            'and not to anyone with the database.',
        ),
      ),
    footer: (close) => {
      const copy = el('button', { class: 'btn' }, 'Copy');
      const download = el('button', { class: 'btn' }, 'Download');
      const done = el('button', { class: 'btn primary' }, 'I have saved them');

      copy.onclick = async () => {
        try {
          await navigator.clipboard.writeText(text);
          toast('Copied.', 'ok');
        } catch {
          // Clipboard access is refused outside a secure context, which is
          // exactly where somebody might be testing this. Downloading works
          // everywhere, so say that rather than failing silently.
          toast('Could not copy here — use Download instead.', 'error');
        }
      };

      download.onclick = () => {
        const url = URL.createObjectURL(new Blob([`${text}\n`], { type: 'text/plain' }));
        const link = el('a', { href: url, download: 'hosting-portal-recovery-codes.txt' });
        link.click();
        URL.revokeObjectURL(url);
      };

      done.onclick = () => {
        close();
        refresh();
      };

      return el('div', { style: 'display:flex;gap:9px' }, copy, download, done);
    },
  });
}
