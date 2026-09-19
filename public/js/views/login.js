import { api, el, clear, field, submitHandler } from '../core.js';
import { icon } from '../icons.js';

export function renderLogin(onSuccess) {
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
        const { user } = await api('/auth/login', {
          method: 'POST',
          body: { email: email.value, password: password.value },
        });
        onSuccess(user);
      }),
    },
    alertHost,
    field('Email address', email),
    field('Password', password),
    submit,
  );

  return el(
    'div',
    { class: 'login-wrap' },
    el(
      'div',
      { class: 'login-card' },
      el(
        'div',
        { class: 'login-brand' },
        el('span', { class: 'logo', style: 'width:30px;height:30px;border-radius:8px;background:#4f46e5;color:#fff;display:grid;place-items:center' }, icon('cloud', 17)),
        'Hosting Portal',
      ),
      el('h1', {}, 'Welcome back'),
      el('p', { class: 'sub' }, 'Sign in to manage your domains and hosting.'),
      form,
    ),
  );
}
