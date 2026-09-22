// Shared primitives for the storefront: API calls, DOM building, icons,
// toasts and modals.
//
// Self-contained rather than imported from the portal: this is the page
// strangers load, and it should carry only what it needs.

const BASE = '/api/store';

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
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
    const err = new Error(data?.error || `Something went wrong (${res.status}).`);
    err.status = res.status;
    err.details = data?.details;
    throw err;
  }
  return data;
}

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
/// anything built conditionally goes through here.
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

export const fill = (node, ...children) => appendAll(clear(node), children);

// --- Icons -----------------------------------------------------------------

const PATHS = {
  cloud: '<path d="M6.5 18.5A4.5 4.5 0 0 1 6 9.6a6 6 0 0 1 11.6 1.6A3.9 3.9 0 0 1 17.5 18.5Z"/>',
  check: '<path d="m4.5 12.5 4.5 4.5 10.5-10.5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>',
  whatsapp:
    '<path d="M12.04 2.5a9.5 9.5 0 0 0-8.1 14.4L2.5 21.5l4.7-1.4a9.5 9.5 0 1 0 4.84-17.6Z"/><path d="M8.6 8.2c.3-.6.6-.6.9-.6h.6c.2 0 .4 0 .6.5l.8 1.9c.1.3 0 .5-.1.7l-.4.5c-.2.2-.2.4 0 .7a7 7 0 0 0 3 2.6c.3.1.5.1.7-.1l.5-.6c.2-.2.4-.2.6-.1l1.8.9c.4.2.4.4.4.6v.6c0 .3-.1.6-.7.9-.6.3-1.5.5-2.5.2a10 10 0 0 1-6.4-6.3c-.3-1 0-1.9.3-2.5Z"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18Z"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01"/><path d="M7 16.5h.01"/>',
  mail: '<rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/><path d="m3 7 8.1 5.4a2 2 0 0 0 2.2 0L21.5 7"/>',
  arrow: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
  back: '<path d="M19 12H5"/><path d="m11 18-6-6 6-6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/>',
  shield: '<path d="M12 2.5 20 5.5v6c0 5-3.4 8.7-8 10.5-4.6-1.8-8-5.5-8-10.5v-6Z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2"/><path d="M12 19.5v2"/><path d="M4.2 4.2l1.4 1.4"/><path d="M18.4 18.4l1.4 1.4"/><path d="M2.5 12h2"/><path d="M19.5 12h2"/><path d="M4.2 19.8l1.4-1.4"/><path d="M18.4 5.6l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8.2 8.2 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/>',
  headset: '<path d="M4 13v-1a8 8 0 0 1 16 0v1"/><path d="M4 13h2.5a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1Z"/><path d="M20 13h-2.5a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1H19a1 1 0 0 0 1-1Z"/><path d="M19 19v.5a2.5 2.5 0 0 1-2.5 2.5H13"/>',
  bolt: '<path d="M13 2.5 4.5 13.5H11l-1 8 8.5-11H12Z"/>',
};

export function icon(name, size = 18) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = PATHS[name] || PATHS.cloud;
  return svg;
}

// --- Toasts and modals -----------------------------------------------------

export function toast(message, tone = '') {
  const host = document.getElementById('toasts');
  const node = el('div', { class: `toast ${tone}` }, message);
  host.append(node);
  setTimeout(() => node.remove(), 5000);
}

export function openModal({ title, render, footer, wide = false, onClose }) {
  const root = document.getElementById('modal-root');
  const close = () => {
    clear(root);
    document.removeEventListener('keydown', onKey);
    document.body.style.overflow = '';
    onClose?.();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);
  document.body.style.overflow = 'hidden';

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
    err.details?.length ? el('ul', {}, err.details.map((d) => el('li', {}, d.message))) : null,
  );
}

/// Wraps an async submit: disables the button, shows a spinner, and puts any
/// error where the person can see it without losing what they typed.
export function submitHandler(button, alertHost, fn) {
  return async (event) => {
    event?.preventDefault?.();
    const original = button.textContent;
    button.disabled = true;
    clear(button).append(el('span', { class: 'spinner' }), 'Please wait…');
    clear(alertHost);
    try {
      await fn();
    } catch (err) {
      alertHost.append(errorAlert(err));
      alertHost.scrollIntoView({ block: 'nearest' });
      button.disabled = false;
      clear(button).append(original);
    }
  };
}

/// A value with a copy button. Copying a UPI ID by hand is where a typo costs
/// somebody their money, so it is one tap.
export function copyRow(value, label = 'Copy') {
  const button = el('button', { class: 'btn sm' }, icon('copy', 14), label);
  button.onclick = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast('Copied.', 'ok');
    } catch {
      // Clipboard access can be refused; selecting the text still works.
      toast('Could not copy automatically — select the text and copy it.', '');
    }
  };
  return el('div', { class: 'copy-row' }, el('span', { class: 'value grow' }, value), button);
}

export const PERIOD = { MONTHLY: '/month', YEARLY: '/year' };
