// Database browser and query editor for a domain, over its stored MySQL
// credentials.
//
// The design problem here is that two statements can look identical and cost
// wildly different amounts. `DELETE FROM orders WHERE id = 5` and
// `DELETE FROM orders` differ by six characters and by a whole table. So the
// editor asks the server what a statement means as it is typed, and shows that
// verdict on the button itself — the consequence is on screen before the thing
// that causes it is pressed.

import {
  api, el, clear, fill, appendAll, field, submitHandler, toast, openModal,
  confirmModal, emptyState, errorAlert, relativeTime,
} from '../core.js';
import { icon } from '../icons.js';
import { refresh } from '../app.js';

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/// How a value reads in a cell. Null is not the same as an empty string, and a
/// table where they look alike is a table that misleads.
function cell(value) {
  if (value === null || value === undefined) return el('span', { class: 'muted small' }, 'NULL');
  if (typeof value === 'object' && value.__binary) {
    return el('span', { class: 'muted small' }, `${formatBytes(value.bytes)} of binary`);
  }
  const text = String(value);
  if (text === '') return el('span', { class: 'muted small' }, 'empty');
  return el('span', { class: 'break' }, text.length > 200 ? `${text.slice(0, 200)}…` : text);
}

const KIND_TONE = { read: '', write: 'warn', schema: 'warn', destructive: 'danger', blocked: 'danger' };
const KIND_LABEL = {
  read: 'Reads data',
  write: 'Changes data',
  schema: 'Changes structure',
  destructive: 'Destroys data',
  blocked: 'Not allowed',
};

export function databasePanel(domain, settings) {
  const host = el('div');

  if (!settings?.hasDatabase) {
    return el(
      'div',
      { class: 'card' },
      el('div', { class: 'card-head' }, el('div', { class: 'grow' }, el('h2', {}, 'Database'))),
      el(
        'div',
        { class: 'card-body' },
        emptyState(
          'server',
          'No database configured',
          'Add the host, name, user and password under FTP & Server to browse this database.',
        ),
      ),
    );
  }

  // Panel state: which table is open, and where in it.
  const state = { tables: [], table: null, page: 1, search: '', orderBy: null, direction: 'asc', allowWrites: false };

  const load = async () => {
    fill(host, el('div', { class: 'card' }, el('div', { class: 'card-body muted' }, 'Connecting…')));
    try {
      const res = await api(`/domains/${domain.id}/db/tables`);
      state.tables = res.tables;
      state.allowWrites = res.allowWrites;
      state.database = res.database;
      state.maxRows = res.maxRows;
      draw();
    } catch (err) {
      fill(
        host,
        el(
          'div',
          { class: 'card' },
          el('div', { class: 'card-head' }, el('div', { class: 'grow' }, el('h2', {}, 'Database'))),
          el('div', { class: 'card-body' }, errorAlert(err)),
        ),
      );
    }
  };

  const openTable = async (name) => {
    state.table = name;
    state.page = 1;
    state.search = '';
    state.orderBy = null;
    draw();
    await loadRows();
  };

  const rowsHost = el('div');

  const loadRows = async () => {
    if (!state.table) return;
    fill(rowsHost, el('div', { class: 'card-body muted' }, 'Loading rows…'));
    const params = new URLSearchParams({ page: String(state.page), perPage: '50' });
    if (state.search) params.set('search', state.search);
    if (state.orderBy) {
      params.set('orderBy', state.orderBy);
      params.set('direction', state.direction);
    }
    try {
      const data = await api(`/domains/${domain.id}/db/tables/${encodeURIComponent(state.table)}/rows?${params}`);
      drawRows(data);
    } catch (err) {
      fill(rowsHost, el('div', { class: 'card-body' }, errorAlert(err)));
    }
  };

  const drawRows = (data) => {
    const pages = Math.max(1, Math.ceil(data.total / data.perPage));
    const canEdit = state.allowWrites && data.primaryKey.length > 0;

    const header = el(
      'tr',
      {},
      ...data.columns.map((c) =>
        el(
          'th',
          {
            style: 'cursor:pointer;white-space:nowrap',
            title: 'Sort by this column',
            onclick: () => {
              state.direction = state.orderBy === c && state.direction === 'asc' ? 'desc' : 'asc';
              state.orderBy = c;
              state.page = 1;
              loadRows();
            },
          },
          c,
          state.orderBy === c ? (state.direction === 'asc' ? ' ▲' : ' ▼') : '',
        ),
      ),
      canEdit ? el('th', {}, '') : null,
    );

    const body = data.rows.map((row) =>
      el(
        'tr',
        {},
        ...data.columns.map((c) => el('td', { class: 'small' }, cell(row[c]))),
        canEdit
          ? el(
              'td',
              { class: 'actions' },
              el('button', { class: 'btn sm', onclick: () => rowModal(domain, data, row) }, 'Edit'),
              ' ',
              el(
                'button',
                {
                  class: 'btn sm danger',
                  onclick: () =>
                    confirmModal({
                      title: 'Delete this row',
                      message:
                        `This deletes one row from "${data.table}" for real. It cannot be undone.`,
                      confirmLabel: 'Delete row',
                      onConfirm: async () => {
                        const key = Object.fromEntries(data.primaryKey.map((k) => [k, row[k]]));
                        const res = await api(
                          `/domains/${domain.id}/db/tables/${encodeURIComponent(data.table)}/rows/delete`,
                          { method: 'POST', body: { key } },
                        );
                        toast(res.message, 'ok');
                        loadRows();
                      },
                    }),
                },
                'Delete',
              ),
            )
          : null,
      ),
    );

    const search = el('input', {
      type: 'search',
      placeholder: 'Search this table…',
      value: state.search,
      style: 'max-width:240px',
    });
    search.onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      state.search = search.value.trim();
      state.page = 1;
      loadRows();
    };

    fill(
      rowsHost,
      el(
        'div',
        { class: 'card-head', style: 'border-top:1px solid var(--border)' },
        el(
          'div',
          { class: 'grow' },
          el('h2', { style: 'font-size:15px' }, data.table),
          el(
            'p',
            {},
            `${data.total} row${data.total === 1 ? '' : 's'}`,
            data.primaryKey.length ? ` · key: ${data.primaryKey.join(', ')}` : ' · no primary key, so rows cannot be edited here',
          ),
        ),
        search,
        el(
          'a',
          {
            class: 'btn sm',
            href: `/api/domains/${domain.id}/db/tables/${encodeURIComponent(data.table)}/export?format=csv`,
          },
          'CSV',
        ),
        el(
          'a',
          {
            class: 'btn sm',
            href: `/api/domains/${domain.id}/db/tables/${encodeURIComponent(data.table)}/export?format=sql`,
          },
          'SQL',
        ),
        el('button', { class: 'btn sm', onclick: () => structureModal(domain, data.table) }, 'Structure'),
      ),
      data.rows.length
        ? el(
            'div',
            { class: 'card-body tight table-scroll' },
            el('table', {}, el('thead', {}, header), el('tbody', {}, body)),
          )
        : el('div', { class: 'card-body' }, emptyState('search', state.search ? 'Nothing matched' : 'This table is empty')),
      pages > 1
        ? el(
            'div',
            { class: 'card-head', style: 'border-top:1px solid var(--border)' },
            el(
              'button',
              { class: 'btn sm', disabled: state.page <= 1, onclick: () => { state.page -= 1; loadRows(); } },
              'Previous',
            ),
            el('span', { class: 'small muted grow', style: 'text-align:center' }, `Page ${state.page} of ${pages}`),
            el(
              'button',
              { class: 'btn sm', disabled: state.page >= pages, onclick: () => { state.page += 1; loadRows(); } },
              'Next',
            ),
          )
        : null,
    );
  };

  const draw = () => {
    const tableList = state.tables.length
      ? el(
          'div',
          { class: 'card-body tight table-scroll' },
          el(
            'table',
            {},
            el(
              'thead',
              {},
              el('tr', {}, el('th', {}, 'Table'), el('th', {}, 'Rows'), el('th', {}, 'Size'), el('th', {}, 'Engine'), el('th', {}, '')),
            ),
            el(
              'tbody',
              {},
              ...state.tables.map((t) =>
                el(
                  'tr',
                  { style: 'cursor:pointer', class: t.name === state.table ? 'selected' : '', onclick: () => openTable(t.name) },
                  el('td', { class: 'mono break strong' }, t.name),
                  // information_schema estimates this for InnoDB. Saying so
                  // beats presenting an estimate as a count.
                  el(
                    'td',
                    { class: 'small muted', title: 'Estimated by the database engine' },
                    t.approximateRows === null ? '—' : `≈ ${t.approximateRows}`,
                  ),
                  el('td', { class: 'small muted' }, formatBytes(t.bytes)),
                  el('td', { class: 'small muted' }, t.engine || '—'),
                  el('td', { class: 'actions' }, el('button', { class: 'btn sm' }, 'Browse')),
                ),
              ),
            ),
          ),
        )
      : el('div', { class: 'card-body' }, emptyState('server', 'This database has no tables yet'));

    fill(
      host,
      el(
        'div',
        { class: 'card' },
        el(
          'div',
          { class: 'card-head' },
          el(
            'div',
            { class: 'grow' },
            el('h2', {}, 'Database'),
            el('p', {}, `${state.database} · ${state.tables.length} table${state.tables.length === 1 ? '' : 's'}`),
          ),
          el(
            'span',
            { class: `badge ${state.allowWrites ? 'warn' : ''}` },
            state.allowWrites ? 'Writes allowed' : 'Read only',
          ),
          el('button', { class: 'btn', onclick: () => queryModal(domain, state) }, 'SQL query'),
          el('button', { class: 'btn sm', onclick: load }, 'Reload'),
        ),
        tableList,
        rowsHost,
      ),
    );
    if (state.table) loadRows();
  };

  load();
  return host;
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

function structureModal(domain, table) {
  const body = el('div', { class: 'muted' }, 'Loading…');

  openModal({
    title: `Structure of ${table}`,
    wide: true,
    render: () => body,
  });

  api(`/domains/${domain.id}/db/tables/${encodeURIComponent(table)}/structure`)
    .then((data) => {
      fill(
        body,
        el('p', { class: 'small muted' }, `${data.rowCount} rows · primary key: ${data.primaryKey.join(', ') || 'none'}`),
        el(
          'div',
          { class: 'table-scroll' },
          el(
            'table',
            {},
            el(
              'thead',
              {},
              el('tr', {}, el('th', {}, 'Column'), el('th', {}, 'Type'), el('th', {}, 'Null'), el('th', {}, 'Key'), el('th', {}, 'Default'), el('th', {}, 'Extra')),
            ),
            el(
              'tbody',
              {},
              ...data.columns.map((c) =>
                el(
                  'tr',
                  {},
                  el('td', { class: 'mono strong break' }, c.name),
                  el('td', { class: 'mono small break' }, c.type),
                  el('td', { class: 'small muted' }, c.nullable ? 'yes' : 'no'),
                  el('td', { class: 'small' }, c.key || '—'),
                  el('td', { class: 'small muted break' }, c.default === null ? 'NULL' : String(c.default)),
                  el('td', { class: 'small muted' }, c.extra || '—'),
                ),
              ),
            ),
          ),
        ),
        data.indexes.length
          ? el(
              'div',
              { style: 'margin-top:16px' },
              el('div', { class: 'strong small', style: 'margin-bottom:6px' }, 'Indexes'),
              ...data.indexes.map((i) =>
                el(
                  'div',
                  { class: 'small muted' },
                  el('span', { class: 'mono' }, i.name),
                  ` — ${i.columns.join(', ')}${i.unique ? ' (unique)' : ''}`,
                ),
              ),
            )
          : null,
      );
    })
    .catch((err) => fill(body, errorAlert(err)));
}

// ---------------------------------------------------------------------------
// Editing one row
// ---------------------------------------------------------------------------

function rowModal(domain, data, row) {
  const inputs = new Map();
  const alertHost = el('div');

  const fields = data.columns.map((c) => {
    const isKey = data.primaryKey.includes(c);
    const value = row[c];
    const binary = value && typeof value === 'object' && value.__binary;

    const input = el('input', {
      type: 'text',
      value: binary ? '' : value === null ? '' : String(value),
      disabled: isKey || binary,
      placeholder: value === null ? 'NULL' : '',
    });
    if (!isKey && !binary) inputs.set(c, input);

    return field(
      c + (isKey ? ' (key)' : ''),
      input,
      binary ? 'Binary column — not editable here.' : isKey ? 'The key identifies the row and is not changed here.' : null,
    );
  });

  const save = el('button', { class: 'btn primary' }, 'Save row');

  const close = openModal({
    title: `Edit row in ${data.table}`,
    wide: true,
    render: () =>
      el(
        'form',
        { onsubmit: (e) => e.preventDefault() },
        alertHost,
        el('div', { class: 'alert warn' }, 'This changes the row in the live database.'),
        ...fields,
      ),
    footer: (closeFn) => [el('button', { class: 'btn', onclick: closeFn }, 'Cancel'), save],
  });

  save.onclick = submitHandler(save, alertHost, async () => {
    const key = Object.fromEntries(data.primaryKey.map((k) => [k, row[k]]));
    const values = {};
    for (const [column, input] of inputs) {
      const before = row[column];
      const after = input.value;
      // Only what actually changed is sent, so an untouched NULL stays NULL
      // rather than becoming an empty string.
      if (before === null && after === '') continue;
      if (String(before ?? '') === after) continue;
      values[column] = after;
    }

    if (!Object.keys(values).length) {
      close();
      toast('Nothing changed.', '');
      return;
    }

    const res = await api(`/domains/${domain.id}/db/tables/${encodeURIComponent(data.table)}/rows`, {
      method: 'PUT',
      body: { key, values },
    });
    close();
    toast(res.message, 'ok');
    refresh();
  });
}

// ---------------------------------------------------------------------------
// The query editor
// ---------------------------------------------------------------------------

function queryModal(domain, state) {
  const sql = el('textarea', {
    rows: 7,
    placeholder: 'SELECT * FROM posts ORDER BY id DESC LIMIT 20',
    style: 'font-family:var(--mono);font-size:13.5px',
  });
  const verdictHost = el('div', { class: 'verdict', style: 'min-height:34px;margin:4px 0 10px' });
  const confirm = el('input', { type: 'text', placeholder: 'Type the table name' });
  const confirmField = field('Confirm', confirm, 'This statement destroys or alters data, so name its table to proceed.');
  confirmField.style.display = 'none';
  const resultHost = el('div');
  const alertHost = el('div');
  const run = el('button', { class: 'btn primary', disabled: true }, 'Run');

  let verdict = null;

  /// Asks the server what the statement means. Debounced, because it runs on
  /// every keystroke and each call opens a connection.
  let timer;
  const inspect = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const text = sql.value.trim();
      if (!text) {
        verdict = null;
        clear(verdictHost);
        confirmField.style.display = 'none';
        run.disabled = true;
        clear(run).append('Run');
        return;
      }
      try {
        verdict = await api(`/domains/${domain.id}/db/inspect`, { method: 'POST', body: { sql: text } });
      } catch {
        verdict = null;
        return;
      }

      clear(verdictHost);
      if (!verdict.ok) {
        verdictHost.append(el('div', { class: 'alert error', style: 'margin:0' }, verdict.reason));
        run.disabled = true;
        confirmField.style.display = 'none';
        clear(run).append('Run');
        return;
      }

      appendAll(verdictHost, [
        el(
          'div',
          { class: `alert ${KIND_TONE[verdict.kind] || ''}`, style: 'margin:0' },
          el('span', { class: 'strong' }, KIND_LABEL[verdict.kind] || verdict.kind),
          verdict.target ? ` · ${verdict.target}` : '',
          verdict.reason ? ` — ${verdict.reason}` : '',
          !verdict.permitted && verdict.kind !== 'blocked'
            ? ' This database is set to read-only, so it will not run.'
            : '',
        ),
      ]);

      confirmField.style.display = verdict.needsConfirmation && verdict.target ? '' : 'none';
      run.disabled = !verdict.permitted;
      clear(run).append(verdict.kind === 'read' ? 'Run' : `Run ${String(verdict.verb || '').toUpperCase()}`);
      run.className = `btn ${verdict.kind === 'destructive' ? 'danger' : 'primary'}`;
    }, 350);
  };
  sql.oninput = inspect;

  openModal({
    title: 'SQL query',
    wide: true,
    render: () =>
      el(
        'div',
        {},
        alertHost,
        el(
          'div',
          { class: 'alert info', style: 'margin-bottom:14px' },
          state.allowWrites
            ? `Statements run against ${state.database} for real. One statement at a time; results are capped at ${state.maxRows} rows.`
            : `This database is set to read-only, so only SELECT and SHOW will run. Results are capped at ${state.maxRows} rows.`,
        ),
        field('Statement', sql),
        verdictHost,
        confirmField,
        resultHost,
      ),
    footer: (closeFn) => [el('button', { class: 'btn', onclick: closeFn }, 'Close'), run],
  });

  run.onclick = submitHandler(run, alertHost, async () => {
    clear(resultHost);
    const res = await api(`/domains/${domain.id}/db/query`, {
      method: 'POST',
      body: { sql: sql.value.trim(), confirmTarget: confirm.value.trim() || undefined },
    });

    run.disabled = false;
    clear(run).append('Run');
    toast(res.message, 'ok');

    if (res.kind === 'read') {
      appendAll(resultHost, [
        el('div', { class: 'small muted', style: 'margin:12px 0 6px' }, res.message),
        res.rows.length
          ? el(
              'div',
              { class: 'table-scroll', style: 'max-height:320px' },
              el(
                'table',
                {},
                el('thead', {}, el('tr', {}, ...res.columns.map((c) => el('th', {}, c)))),
                el(
                  'tbody',
                  {},
                  ...res.rows.map((row) => el('tr', {}, ...res.columns.map((c) => el('td', { class: 'small' }, cell(row[c]))))),
                ),
              ),
            )
          : el('div', { class: 'alert info' }, 'The statement ran and returned no rows.'),
      ]);
      return;
    }

    fill(resultHost, el('div', { class: 'alert ok', style: 'margin-top:12px' }, res.message));
    confirm.value = '';
    refresh();
  });
}

// ---------------------------------------------------------------------------
// The log
// ---------------------------------------------------------------------------

/// What has been run against this database. Super Admin only: it is a record of
/// everyone's statements, not just the reader's own.
export function queryLogCard(domain) {
  const body = el('div', { class: 'card-body muted small' }, 'Loading…');

  api(`/domains/${domain.id}/db/log`)
    .then(({ entries }) => {
      if (!entries.length) {
        return fill(body, emptyState('server', 'Nothing has changed this database yet', 'Statements that only read are not recorded.'));
      }
      fill(
        body,
        el(
          'div',
          { class: 'table-scroll', style: 'max-height:340px' },
          el(
            'table',
            {},
            el('thead', {}, el('tr', {}, el('th', {}, 'When'), el('th', {}, 'Who'), el('th', {}, 'What'), el('th', {}, 'Statement'))),
            el(
              'tbody',
              {},
              ...entries.map((e) =>
                el(
                  'tr',
                  {},
                  el('td', { class: 'small muted nowrap' }, relativeTime(e.createdAt)),
                  el('td', { class: 'small' }, e.user?.name || el('span', { class: 'muted' }, 'deleted account')),
                  el(
                    'td',
                    {},
                    el('span', { class: `badge ${KIND_TONE[e.kind] || ''}` }, e.verb.toUpperCase()),
                    e.target ? el('span', { class: 'small muted' }, ` ${e.target}`) : null,
                  ),
                  el('td', { class: 'mono small break' }, e.sql.length > 160 ? `${e.sql.slice(0, 160)}…` : e.sql),
                ),
              ),
            ),
          ),
        ),
      );
    })
    .catch((err) => fill(body, el('div', { class: 'card-body' }, errorAlert(err))));

  return el(
    'div',
    { class: 'card', style: 'margin-top:18px' },
    el(
      'div',
      { class: 'card-head' },
      el(
        'div',
        { class: 'grow' },
        el('h2', {}, 'Statement log'),
        el('p', {}, 'Every statement that changed this database, and who ran it. Reads are not recorded.'),
      ),
      icon('server', 18),
    ),
    body,
  );
}
