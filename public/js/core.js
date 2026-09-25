// Small shared helpers: API calls, DOM building, formatting, toasts, modals.

import { icon } from './icons.js';
import { PAGE_SIZES, SHOW_ALL, readPageSize, writePageSize, pageSlice, pageWindow } from './paging.js';

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

/// Appends children with the same rules `el` uses: arrays are flattened and
/// null/false are skipped. `Node.append` does neither — it stringifies an array
/// and writes a literal "null" into the page — so anything built conditionally
/// goes through here rather than straight to `.append`.
export function appendAll(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === true) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export const clear = (node) => {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
};

/// Replaces a node's contents, with the same child rules as `el`.
export const fill = (node, ...children) => appendAll(clear(node), children);

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

/// A technology chip. "Likely" is drawn plainer than "confirmed", because the
/// difference between reading wp-config.php and inferring from a URL is real
/// and the reader deserves to see it at a glance.
export function techBadge(technology) {
  if (!technology?.name) return el('span', { class: 'small muted' }, '—');

  const label = technology.version ? `${technology.name} ${technology.version}` : technology.name;
  const tone = technology.confidence === 'likely' ? '' : 'accent';
  const badge = el('span', { class: `badge ${tone}` }, label);

  if (technology.evidence) badge.title = technology.evidence;
  return badge;
}

/// Where an answer came from, in the reader's terms. Never names a provider.
export const TECH_SOURCE_LABEL = {
  files: 'read from your site\u2019s files',
  site: 'read from your homepage',
  manual: 'set by your administrator',
};

export const initials = (name = '') =>
  name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() || '').join('') || '?';

// --- Tables ----------------------------------------------------------------

// The arithmetic lives in paging.js, where it can be tested without a browser.

const storedPageSize = (fallback) => readPageSize((k) => localStorage.getItem(k), fallback);
const rememberPageSize = (size) => writePageSize((k, v) => localStorage.setItem(k, v), size);

/// A table that pages, and searches once there is enough in it to be worth
/// searching, and picks rows out when it is given something to do with them.
///
/// Rows arrive already built, as `{ node, text, id, data }`: `node` is the
/// `<tr>`, `text` is whatever the search box should match, and `id`/`data` are
/// only needed when rows can be selected. Paging then only moves existing
/// nodes between the table and a holding array, so every button inside a row
/// keeps the handler it was created with — nothing is rebuilt and nothing is
/// re-fetched.
///
/// A plain `<tr>` is accepted in place of the object; it simply never matches
/// a search and can never be selected.
///
/// `select` turns on the checkbox column:
///
///   select: {
///     noun: { one: 'mailbox', many: 'mailboxes' },
///     actions: (chosen, { clear }) => [ el('button', …) ],
///   }
///
/// `chosen` is the `data` of every selected row, in the order given. It holds
/// rows that paging or a search has hidden, because unticking something by
/// scrolling past it would be the worse surprise — so the count and the list
/// shown to the reader must always be the true ones.
export function tableView({
  head,
  rows,
  pageSize = 25,
  noun = { one: 'row', many: 'rows' },
  searchPlaceholder = 'Search…',
  searchHint = null,
  // Off where the page already has a search of its own — usually one that asks
  // the server, and so sees more than the rows currently loaded. Two search
  // boxes over one table is a way to get two different answers.
  search: searchable = true,
  select = null,
}) {
  const items = rows.map((r) => (r instanceof Node ? { node: r, text: '' } : r));

  let size = storedPageSize(pageSize);
  let page = 1;
  let query = '';

  const body = el('tbody');
  const table = el('table', {}, head, body);
  const status = el('div', { class: 'small muted grow' });
  const pager = el('div', { class: 'table-pager' });
  const scroll = el('div', { class: 'table-scroll' }, table);

  // --- Selection ------------------------------------------------------------
  //
  // Only the rows that carry an id can be picked; anything else is drawn with
  // an empty cell rather than a checkbox that would do nothing.
  const pickable = select ? items.filter((i) => i.id != null) : [];
  const chosen = new Set();
  const bar = el('div', { class: 'table-bulk' });
  const headBox = el('input', {
    type: 'checkbox',
    'aria-label': `Select the ${select?.noun?.many || noun.many} on this page`,
  });

  const chosenItems = () => pickable.filter((i) => chosen.has(i.id));
  const clearChoice = () => {
    chosen.clear();
    draw();
  };

  if (select) {
    // The column header, added here rather than asked of every caller: a
    // checkbox column that some tables forgot would be a column of rows that
    // silently cannot be selected.
    head.querySelector('tr')?.prepend(el('th', { class: 'pick' }, headBox));

    for (const item of items) {
      const cell = el('td', { class: 'pick' });
      if (item.id != null) {
        const box = el('input', {
          type: 'checkbox',
          'aria-label': `Select ${item.text || 'this row'}`,
          onclick: (e) => {
            // Several of these tables navigate when the row is clicked.
            e.stopPropagation();
          },
          onchange: (e) => {
            if (e.currentTarget.checked) chosen.add(item.id);
            else chosen.delete(item.id);
            drawSelection();
          },
        });
        item.box = box;
        cell.append(box);
        // The whole cell is a target, so the checkbox is not a 13px thing to
        // aim at on a phone.
        cell.onclick = (e) => {
          e.stopPropagation();
          if (e.target !== box) box.click();
        };
      }
      item.node.prepend(cell);
    }
  }

  /// Redraws everything that depends on which rows are ticked, without
  /// touching the table itself — so ticking a box never moves a row.
  function drawSelection() {
    if (!select) return;

    for (const item of pickable) {
      if (item.box) item.box.checked = chosen.has(item.id);
    }

    // The header box speaks for the page in front of you, not the whole list:
    // "select everything" is offered separately and by name, below.
    const onPage = visible.filter((i) => i.id != null);
    const pickedHere = onPage.filter((i) => chosen.has(i.id)).length;
    headBox.checked = onPage.length > 0 && pickedHere === onPage.length;
    headBox.indeterminate = pickedHere > 0 && pickedHere < onPage.length;

    const word = chosen.size === 1 ? select.noun?.one || noun.one : select.noun?.many || noun.many;
    clear(bar);

    if (!chosen.size) {
      bar.classList.remove('is-on');
      return;
    }
    bar.classList.add('is-on');

    // Offered only when the page is full and there is more behind it, and
    // worded with both numbers in it so neither can be mistaken for the other.
    const matchingPickable = matching.filter((i) => i.id != null);
    const offerAll =
      pickedHere === onPage.length &&
      onPage.length > 0 &&
      chosen.size < matchingPickable.length;

    appendAll(bar, [
      el('span', { class: 'strong' }, `${chosen.size} ${word} selected`),
      offerAll
        ? el(
            'button',
            {
              class: 'btn sm ghost',
              onclick: () => {
                for (const i of matchingPickable) chosen.add(i.id);
                drawSelection();
              },
            },
            `Select all ${matchingPickable.length}${query ? ' matching' : ''}`,
          )
        : null,
      el('span', { class: 'grow' }),
      select.actions(chosenItems().map((i) => i.data ?? { id: i.id }), { clear: clearChoice }),
      el('button', { class: 'btn sm ghost', onclick: clearChoice }, 'Clear'),
    ]);
  }

  headBox.onchange = () => {
    const onPage = visible.filter((i) => i.id != null);
    for (const item of onPage) {
      if (headBox.checked) chosen.add(item.id);
      else chosen.delete(item.id);
    }
    drawSelection();
  };

  // What the current page and the current search are showing, kept here so
  // the selection code and the pager agree on it without recomputing.
  let matching = items;
  let visible = items;

  const search = el('input', {
    type: 'search',
    class: 'table-search',
    placeholder: searchPlaceholder,
    'aria-label': searchPlaceholder,
    oninput: () => {
      query = search.value.trim().toLowerCase();
      page = 1;
      draw();
    },
  });

  const sizeSelect = el(
    'select',
    {
      class: 'table-size',
      'aria-label': `${noun.many} per page`,
      onchange: () => {
        size = Number(sizeSelect.value);
        rememberPageSize(size);
        page = 1;
        draw();
      },
    },
    PAGE_SIZES.map((n) => el('option', { value: String(n), selected: n === size }, `${n} per page`)),
    el('option', { value: String(SHOW_ALL), selected: size === SHOW_ALL }, 'Show all'),
  );

  // The controls only appear when they would do something. A table of four
  // rows does not need a search box above it.
  const tools = el(
    'div',
    { class: 'table-tools' },
    searchable ? search : null,
    searchable && searchHint ? el('span', { class: 'small muted hide-sm' }, searchHint) : null,
    el('span', { class: 'grow' }),
    sizeSelect,
  );

  function draw() {
    matching = query ? items.filter((i) => i.text.toLowerCase().includes(query)) : items;

    const at = pageSlice(matching.length, page, size);
    page = at.page;
    visible = matching.slice(at.start, at.end);

    fill(body, visible.map((i) => i.node));

    if (!matching.length) {
      fill(
        body,
        el(
          'tr',
          { class: 'is-blank' },
          el(
            'td',
            {
              // Counted after the checkbox column has been added, so the
              // message stays centred under the whole table.
              colspan: String(head.querySelectorAll('th').length || 1),
              class: 'muted',
              style: 'text-align:center',
            },
            query ? `Nothing here matches “${search.value.trim()}”.` : 'Nothing to show.',
          ),
        ),
      );
    }

    // Plain counting, in the reader's terms. "Showing 26–50 of 52" answers
    // both "where am I" and "how much is there" without them doing sums.
    const word = matching.length === 1 ? noun.one : noun.many;
    status.textContent = matching.length
      ? at.last === 1
        ? `${matching.length} ${word}${query ? ` matching, of ${items.length}` : ''}`
        : `Showing ${at.firstRow}–${at.lastRow} of ${matching.length} ${word}${
            query ? `, filtered from ${items.length}` : ''
          }`
      : `No ${noun.many}`;

    clear(pager);
    pager.append(status);

    if (at.last > 1) {
      const go = (n) => () => {
        page = n;
        draw();
        // Back to the top of the table, not the top of the page: the reader
        // was looking at this table and should still be.
        scroll.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      };

      pager.append(
        el(
          'div',
          { class: 'pages', role: 'navigation', 'aria-label': `${noun.many} pages` },
          el(
            'button',
            { class: 'btn sm', disabled: page === 1, onclick: go(page - 1), 'aria-label': 'Previous page' },
            '‹',
          ),
          pageWindow(page, at.last).map((n) =>
            n === null
              ? el('span', { class: 'gap', 'aria-hidden': 'true' }, '…')
              : el(
                  'button',
                  {
                    class: `btn sm ${n === page ? 'primary' : ''}`,
                    onclick: go(n),
                    'aria-current': n === page ? 'page' : null,
                    'aria-label': `Page ${n}`,
                  },
                  String(n),
                ),
          ),
          el(
            'button',
            { class: 'btn sm', disabled: page === at.last, onclick: go(page + 1), 'aria-label': 'Next page' },
            '›',
          ),
        ),
      );
    }

    // Last, because it reads `visible` and `matching` as this draw left them.
    drawSelection();
  }

  draw();

  return el(
    'div',
    { class: 'table-view' },
    items.length > PAGE_SIZES[0] ? tools : null,
    select ? bar : null,
    scroll,
    // With one short page and no search there is nothing to say: the rows are
    // all there, in front of the reader, and a count would just be noise.
    items.length > PAGE_SIZES[0] ? pager : null,
  );
}

// --- Toasts ----------------------------------------------------------------

export function toast(message, tone = '') {
  const host = document.getElementById('toasts');
  const node = el('div', { class: `toast ${tone}` }, message);
  host.append(node);
  setTimeout(() => node.remove(), 4200);
}

// --- Modal -----------------------------------------------------------------

/// Opens a modal. `render(close)` returns the body; `footer(close)` the buttons.
///
/// `beforeClose` is asked before the × button, Escape or a click outside
/// closes the dialog, and returning false keeps it open — for a dialog with
/// unsaved work in it. `close(true)` from the caller skips the question.
export function openModal({ title, render, footer, wide = false, beforeClose = null }) {
  const root = document.getElementById('modal-root');
  const close = (force) => {
    if (force !== true && beforeClose && beforeClose() === false) return;
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
