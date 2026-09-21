// Shared primitives for the webmail app: API calls, DOM building, icons,
// formatting, toasts and modals.
//
// The webmail app is deliberately standalone — it is served from its own
// directory so it can live on its own hostname without dragging the portal's
// code along — so these helpers are a small, self-contained set rather than an
// import from the portal.

const BASE = '/api/webmail';

// --- API -------------------------------------------------------------------

/// A JSON request against the webmail API.
///
/// A 401 means the mailbox session is gone (expired, or signed out in another
/// tab). Rather than leaving the caller to handle that everywhere, it raises an
/// event the shell listens for and returns to the sign-in screen.
export async function api(path, { method = 'GET', body, formData } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: formData || (body ? JSON.stringify(body) : undefined),
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
    if (res.status === 401 && path !== '/login' && path !== '/me') {
      window.dispatchEvent(new CustomEvent('mail:signed-out'));
    }
    const err = new Error(data?.error || `Request failed (${res.status}).`);
    err.status = res.status;
    err.details = data?.details;
    throw err;
  }
  return data;
}

/// The URL an attachment downloads from. Built here so the encoding rules live
/// in one place.
export const attachmentUrl = (folder, uid, index) =>
  `${BASE}/messages/${encodeURIComponent(uid)}/attachments/${index}?folder=${encodeURIComponent(folder)}`;

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

/// Appends children, flattening arrays and skipping null/false. `Node.append`
/// does neither — it stringifies an array and writes a literal "null" — so
/// anything built conditionally goes through here instead.
export function appendAll(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === true) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const clear = (node) => {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
};

/// Replaces a node's contents, with the same child rules as `el`.
export const fill = (node, ...children) => appendAll(clear(node), children);

// --- Icons -----------------------------------------------------------------

const PATHS = {
  mail: '<rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/><path d="m3 7 8.1 5.4a2 2 0 0 0 2.2 0L21.5 7"/>',
  inbox: '<path d="M3 12h4l2 3h6l2-3h4"/><path d="M5.5 5h13l2.5 7v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5Z"/>',
  send: '<path d="M21.5 2.5 2.5 10l7.5 3 3 7.5Z"/><path d="M10 13.5 21.5 2.5"/>',
  draft: '<path d="M14 3H7a1.5 1.5 0 0 0-1.5 1.5v15A1.5 1.5 0 0 0 7 21h10a1.5 1.5 0 0 0 1.5-1.5V7.5Z"/><path d="M14 3v4.5h4.5"/>',
  trash: '<path d="M4 6.5h16"/><path d="M9.5 6.5V4.5h5v2"/><path d="M6.5 6.5 7.5 20a1.5 1.5 0 0 0 1.5 1.4h6a1.5 1.5 0 0 0 1.5-1.4l1-13.5"/>',
  junk: '<path d="M12 3 2.5 20h19Z"/><path d="M12 10v4"/><path d="M12 17h.01"/>',
  folder: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v7a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17Z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>',
  star: '<path d="m12 3.6 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.8l5.9-.9Z"/>',
  clip: '<path d="M20 11.5 12.2 19.3a4.5 4.5 0 0 1-6.4-6.4l8-8a3 3 0 0 1 4.3 4.3l-8 8a1.5 1.5 0 0 1-2.2-2.2l7.4-7.4"/>',
  reply: '<path d="M9 7 3.5 12 9 17"/><path d="M3.5 12H14a6 6 0 0 1 6 6v1"/>',
  replyAll: '<path d="M7 7 2.5 12 7 17"/><path d="M12 7 7.5 12 12 17"/><path d="M7.5 12H16a5 5 0 0 1 5 5v1"/>',
  forward: '<path d="m15 7 5.5 5L15 17"/><path d="M20.5 12H10a6 6 0 0 0-6 6v1"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-.7 4.3"/><path d="M20 5v6h-6"/>',
  back: '<path d="M15 5.5 8.5 12l6.5 6.5"/>',
  menu: '<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/>',
  move: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v7a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17Z"/><path d="M12 11v5"/><path d="m9.8 13.2 2.2-2.2 2.2 2.2"/>',
  unread: '<rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/><path d="m3 7 8.1 5.4a2 2 0 0 0 2.2 0L21.5 7"/><circle cx="19" cy="6" r="3" fill="currentColor" stroke="none"/>',
  logout: '<path d="M14 5.5V4a1.5 1.5 0 0 0-1.5-1.5h-7A1.5 1.5 0 0 0 4 4v16a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 14 20v-1.5"/><path d="M9.5 12h11"/><path d="m17 8.5 3.5 3.5L17 15.5"/>',
  download: '<path d="M12 3.5v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M4 19.5h16"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  shield: '<path d="M12 2.5 20 5.5v6c0 5-3.4 8.7-8 10.5-4.6-1.8-8-5.5-8-10.5v-6Z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
};

/// An inline SVG icon, coloured by `currentColor` so it matches its context.
export function icon(name, size = 18) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = PATHS[name] || PATHS.mail;
  return svg;
}

// --- Formatting ------------------------------------------------------------

/// Mail-client style dates: a time for today, a day and month this year, and a
/// full date for anything older.
export function messageDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const now = new Date();
  const sameDay =
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear();

  if (sameDay) return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function fullDate(value) {
  if (!value) return 'Unknown date';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown date';
  return date.toLocaleString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/// How an address should read in a list: the display name when there is one,
/// the address otherwise.
export const displayName = (addr) => addr?.name || addr?.address || 'Unknown sender';

/// A full `Name <address>` for headers, falling back to whichever half exists.
export const fullAddress = (addr) => {
  if (!addr) return '';
  if (addr.name && addr.address) return `${addr.name} <${addr.address}>`;
  return addr.address || addr.name || '';
};

export const addressLine = (list, fallback = '') =>
  (list || []).map(fullAddress).filter(Boolean).join(', ') || fallback;

// --- Toasts and modals -----------------------------------------------------

export function toast(message, tone = '') {
  const host = document.getElementById('toasts');
  const node = el('div', { class: `toast ${tone}` }, message);
  host.append(node);
  setTimeout(() => node.remove(), 4200);
}

/// Opens a modal. `render(close)` returns the body; `footer(close)` the buttons.
export function openModal({ title, render, footer, wide = false, onClose }) {
  const root = document.getElementById('modal-root');
  const close = () => {
    clear(root);
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);

  const backdrop = el(
    'div',
    { class: 'modal-backdrop', onclick: (e) => e.target === backdrop && close() },
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

/// Wraps an async submit: disables the button, shows a spinner, and surfaces
/// errors into `alertHost` so every form behaves the same way.
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
    hint ? el('div', { class: 'small muted', style: 'margin-top:4px' }, hint) : null,
  );
