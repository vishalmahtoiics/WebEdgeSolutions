import { api, el, clear, fill, field, submitHandler } from '../core.js';
import { icon } from '../icons.js';

/// Sign-in, in one or two steps.
///
/// The second step is a separate screen rather than a field that appears
/// underneath the first, because they are separate states on the server: the
/// password has already been accepted, and what is left is a different
/// question with its own deadline. Showing it in place would invite somebody
/// to retype their password when the code is refused, which cannot help.
export function renderLogin(onSuccess) {
  const card = el('div', { class: 'login-card' });

  const shell = el(
    'div',
    { class: 'login-wrap' },
    card,
  );

  showPassword();
  return shell;

  function frame(title, subtitle, ...rest) {
    fill(
      card,
      el(
        'div',
        { class: 'login-brand' },
        el('span', {
          class: 'logo',
          style: 'width:30px;height:30px;border-radius:8px;background:#4f46e5;color:#fff;display:grid;place-items:center',
        }, icon('cloud', 17)),
        'Hosting Portal',
      ),
      el('h1', {}, title),
      el('p', { class: 'sub' }, subtitle),
      ...rest,
    );
  }

  function showPassword() {
    const email = el('input', { type: 'email', id: 'email', autocomplete: 'username', required: true });
    const password = el('input', {
      type: 'password',
      id: 'password',
      autocomplete: 'current-password',
      required: true,
    });
    const alertHost = el('div');
    const submit = el('button', { class: 'btn primary block', type: 'submit' }, 'Sign in');

    const form = el(
      'form',
      {
        onsubmit: submitHandler(submit, alertHost, async () => {
          const result = await api('/auth/login', {
            method: 'POST',
            body: { email: email.value, password: password.value },
          });
          // Not signed in yet: the password was right and a code is owed.
          if (result.twoFactor) return showCode(result.email);
          onSuccess(result.user);
        }),
      },
      alertHost,
      field('Email address', email),
      field('Password', password),
      submit,
    );

    frame('Welcome back', 'Sign in to manage your domains and hosting.', form);
    email.focus();
  }

  function showCode(email) {
    const code = el('input', {
      type: 'text',
      inputmode: 'numeric',
      autocomplete: 'one-time-code',
      // A phone keyboard should offer digits, but a recovery code has letters
      // in it, so the field itself stays plain text.
      placeholder: '123456',
      style: 'font-size:22px;letter-spacing:5px;text-align:center;font-family:var(--mono, monospace)',
      required: true,
    });
    const alertHost = el('div');
    const submit = el('button', { class: 'btn primary block', type: 'submit' }, 'Verify and sign in');

    const form = el(
      'form',
      {
        onsubmit: submitHandler(submit, alertHost, async () => {
          const result = await api('/auth/2fa', { method: 'POST', body: { code: code.value } });
          if (result.usedRecoveryCode) {
            // Said out loud rather than left to be discovered: somebody who
            // has just spent a recovery code needs to know how many are left.
            sessionStorage.setItem(
              'portal.recoveryNotice',
              `You signed in with a recovery code. ${result.recoveryCodesLeft} left.`,
            );
          }
          onSuccess(result.user);
        }),
      },
      alertHost,
      el(
        'div',
        { class: 'alert info', style: 'margin-bottom:16px' },
        el('span', { class: 'strong' }, 'One more step. '),
        `Open your authenticator app and enter the current code for ${email}.`,
      ),
      field('Six-digit code', code, 'Lost your phone? Enter one of your recovery codes instead.'),
      submit,
      el(
        'button',
        {
          class: 'btn ghost block',
          type: 'button',
          style: 'margin-top:8px',
          onclick: showPassword,
        },
        'Back to sign in',
      ),
    );

    frame('Two-factor authentication', 'Your password was accepted.', form);
    code.focus();
  }
}
