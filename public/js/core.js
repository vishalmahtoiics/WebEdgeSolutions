// Small shared helpers: API calls, DOM building, formatting, toasts, modals.

import { icon } from './icons.js';

// --- API -------------------------------------------------------------------

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });

  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status}).`);
    err.status = res.status;
    err.details = data?.details;
    throw err;
  }
  return data;
}

// --- DOM -------------------------------------------------------------------

/// Tiny element builder. Children may be nodes, strings, or nested arrays;
/// null/false/undefined are skipped so callers can write `cond && el(...)`.
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key in node && key !== 'list') node[key] = value;
    else node.setAttribute(key, value);
  }

  appendAll(node, children);
  return node;
}

function appendAll(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === true) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export const clear = (node) => {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
};

// --- Formatting ------------------------------------------------------------

export function formatDate(value, { withTime = false } = {}) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  const opts = { year: 'numeric', month: 'short', day: 'numeric' };
  if (withTime) Object.assign(opts, { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString(undefined, opts);
}

export function relativeTime(value) {
  if (!value) return 'never';
  const diff = Date.now() - new Date(value).getTime();
  if (Number.isNaN(diff)) return 'never';
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  return formatDate(value);
}

export function formatMb(mb) {
  if (mb === null || mb === undefined) return '—';
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB` : `${mb} MB`;
}

const STATUS_TONE = {
  active: 'ok',
  enabled: 'ok',
  running: 'ok',
  pending: 'warn',
  pending_setup: 'warn',
  pending_verification: 'warn',
  requested: 'warn',
  suspended: 'danger',
  expired: 'danger',
  failed: 'danger',
  deleted: 'danger',
};

export function statusBadge(status) {
  const key = String(status || 'unknown').toLowerCase();
  const tone = STATUS_TONE[key] || '';
  const label = key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return el('span', { class: `badge ${tone}` }, el('span', { class: 'dot' }), label);
}

export const sourceBadge = (label, source) =>
  el('span', { class: `badge ${source === 'MANUAL' ? '' : 'accent'}` }, label);

export const initials = (name = '') =>
  name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() || '').join('') || '?';

// --- Toasts ----------------------------------------------------------------

export function toast(message, tone = '') {
  const host = document.getElementById('toasts');
  const node = el('div', { class: `toast ${tone}` }, message);
  host.append(node);
  setTimeout(() => node.remove(), 4200);
}

// --- Modal -----------------------------------------------------------------

/// Opens a modal. `render(close)` returns the body; `footer(close)` the buttons.
export function openModal({ title, render, footer, wide = false }) {
  const root = document.getElementById('modal-root');
  const close = () => {
    clear(root);
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);

  const backdrop = el(
    'div',
    {
      class: 'modal-backdrop',
      onclick: (e) => e.target === backdrop && close(),
    },
    el(
      'div',
      { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true' },
      el(
        'div',
        { class: 'modal-head' },
        el('h2', {}, title),
        el('button', { class: 'icon-btn', onclick: close, 'aria-label': 'Close' }, '×'),
      ),
      el('div', { class: 'modal-body' }, render(close)),
      footer ? el('div', { class: 'modal-foot' }, footer(close)) : null,
    ),
  );

  clear(root).append(backdrop);
  // Focus the first field so the modal is usable from the keyboard immediately.
  backdrop.querySelector('input, select, textarea, button')?.focus();
  return close;
}

export function confirmModal({ title, message, confirmLabel = 'Confirm', danger = true, onConfirm }) {
  openModal({
    title,
    render: () => el('p', { class: 'muted', style: 'margin:0' }, message),
    footer: (close) => [
      el('button', { class: 'btn', onclick: close }, 'Cancel'),
      el(
        'button',
        {
          class: `btn ${danger ? 'danger' : 'primary'}`,
          onclick: async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            try {
              await onConfirm();
              close();
            } catch (err) {
              toast(err.message, 'error');
              btn.disabled = false;
            }
          },
        },
        confirmLabel,
      ),
    ],
  });
}

// --- Forms -----------------------------------------------------------------

export function field(label, input, hint) {
  return el(
    'div',
    { class: 'field' },
    el('label', { for: input.id || undefined }, label),
    input,
    hint ? el('div', { class: 'hint' }, hint) : null,
  );
}

/// Renders a server validation error, including per-field details.
export function errorAlert(err) {
  return el(
    'div',
    { class: 'alert error' },
    err.message,
    err.details?.length
      ? el('ul', {}, err.details.map((d) => el('li', {}, `${d.field}: ${d.message}`)))
      : null,
  );
}

/// Wraps an async submit: disables the button, shows a spinner, surfaces errors
/// into `alertHost` so every form behaves the same way.
export function submitHandler(button, alertHost, fn) {
  return async (event) => {
    event?.preventDefault?.();
    const original = button.textContent;
    button.disabled = true;
    clear(button).append(el('span', { class: 'spinner' }), 'Working…');
    clear(alertHost);
    try {
      await fn();
    } catch (err) {
      alertHost.append(errorAlert(err));
      button.disabled = false;
      clear(button).append(original);
    }
  };
}

export const emptyState = (iconName, title, hint) =>
  el(
    'div',
    { class: 'empty' },
    el('div', { class: 'big' }, icon(iconName, 30)),
    el('div', { class: 'strong' }, title),
    hint ? el('div', { class: 'small', style: 'margin-top:4px' }, hint) : null,
  );
