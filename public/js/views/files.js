// File manager for a domain, over its stored FTP/FTPS/SFTP credentials.
//
// The panel keeps its own current directory rather than putting it in the URL,
// so browsing folders does not fill the browser's history with dead entries.

import {
  api, el, clear, field, submitHandler, toast, openModal, confirmModal, emptyState, formatDate,
} from '../core.js';
import { icon } from '../icons.js';

/// Bytes, shown the way a file manager shows them.
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

const parentOf = (dir) => {
  const parts = dir.split('/').filter(Boolean);
  parts.pop();
  return `/${parts.join('/')}`;
};

export function filesPanel(domain) {
  let currentPath = '/';

  const body = el('div', { class: 'card-body' }, el('div', { class: 'muted small' }, 'Connecting…'));
  const crumbs = el('div', { class: 'crumbs' });
  const actions = el('div', { class: 'page-actions' });

  async function load(target) {
    currentPath = target;
    clear(body).append(el('div', { class: 'muted small' }, 'Loading…'));
    clear(actions);

    let data;
    try {
      data = await api(`/domains/${domain.id}/files?path=${encodeURIComponent(target)}`);
    } catch (err) {
      clear(body).append(
        el(
          'div',
          { class: 'alert error', style: 'margin:0' },
          err.message,
          err.status === 400
            ? el(
                'div',
                { class: 'small', style: 'margin-top:8px' },
                'Add the host, username and password under the FTP & Server tab, then come back.',
              )
            : null,
        ),
      );
      return;
    }

    currentPath = data.path;
    drawCrumbs();
    drawActions();
    drawEntries(data.entries);
  }

  const reload = () => load(currentPath);

  function drawCrumbs() {
    clear(crumbs);
    const parts = currentPath.split('/').filter(Boolean);

    crumbs.append(
      el('button', { class: 'crumb', onclick: () => load('/') }, icon('folder', 14), ' Home'),
    );

    let walked = '';
    parts.forEach((part, i) => {
      walked += `/${part}`;
      const here = walked;
      crumbs.append(
        el('span', { class: 'crumb-sep' }, '/'),
        i === parts.length - 1
          ? el('span', { class: 'crumb current' }, part)
          : el('button', { class: 'crumb', onclick: () => load(here) }, part),
      );
    });
  }

  function drawActions() {
    const uploadInput = el('input', {
      type: 'file',
      style: 'display:none',
      onchange: async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const form = new FormData();
        form.append('file', file);
        form.append('path', currentPath);
        try {
          const res = await fetch(`/api/domains/${domain.id}/files/upload`, {
            method: 'POST',
            body: form,
            credentials: 'same-origin',
          });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(payload.error || 'Upload failed.');
          toast(payload.message, 'ok');
          reload();
        } catch (err) {
          toast(err.message, 'error');
        } finally {
          uploadInput.value = '';
        }
      },
    });

    actions.append(
      uploadInput,
      el('button', { class: 'btn sm', onclick: reload }, 'Refresh'),
      el('button', { class: 'btn sm', onclick: () => newFolderModal(domain, currentPath, reload) }, '+ Folder'),
      el('button', { class: 'btn sm primary', onclick: () => uploadInput.click() }, 'Upload'),
    );
  }

  function drawEntries(entries) {
    clear(body);
    body.className = 'card-body tight table-scroll';

    if (!entries.length && currentPath === '/') {
      body.className = 'card-body';
      return body.append(emptyState('folder', 'This folder is empty', 'Upload a file to get started.'));
    }

    const rows = entries.map((entry) => {
      const full = `${currentPath}/${entry.name}`.replace(/\/+/g, '/');
      const isDir = entry.type === 'directory';

      return el(
        'tr',
        {},
        el(
          'td',
          {},
          el(
            'button',
            {
              class: 'file-name',
              onclick: () => (isDir ? load(full) : openFileModal(domain, full, entry.name, reload)),
            },
            icon(isDir ? 'folder' : 'file', 16),
            el('span', { class: 'break' }, entry.name),
          ),
        ),
        el('td', { class: 'small muted nowrap' }, isDir ? '—' : formatBytes(entry.size)),
        // A real timestamp is formatted; a raw LIST string is shown as the
        // server wrote it rather than guessed at.
        el(
          'td',
          { class: 'small muted nowrap' },
          entry.modifiedAt ? formatDate(entry.modifiedAt) : entry.modifiedLabel || '—',
        ),
        el(
          'td',
          { class: 'actions' },
          !isDir
            ? [
                el(
                  'a',
                  {
                    class: 'btn sm',
                    href: `/api/domains/${domain.id}/files/download?path=${encodeURIComponent(full)}`,
                  },
                  'Download',
                ),
                ' ',
              ]
            : null,
          el('button', { class: 'btn sm', onclick: () => renameModal(domain, full, entry.name, reload) }, 'Rename'),
          ' ',
          el(
            'button',
            {
              class: 'btn sm danger',
              onclick: () =>
                confirmModal({
                  title: `Delete ${entry.name}`,
                  message: isDir
                    ? `Delete the folder "${entry.name}" and everything inside it? This cannot be undone.`
                    : `Delete "${entry.name}"? This cannot be undone.`,
                  confirmLabel: 'Delete',
                  onConfirm: async () => {
                    const res = await api(`/domains/${domain.id}/files/delete`, {
                      method: 'POST',
                      body: { path: full, type: entry.type },
                    });
                    toast(res.message, 'ok');
                    reload();
                  },
                }),
            },
            'Delete',
          ),
        ),
      );
    });

    // A way back up, since the breadcrumb is the only other route out.
    if (currentPath !== '/') {
      rows.unshift(
        el(
          'tr',
          {},
          el(
            'td',
            { colspan: 4 },
            el(
              'button',
              { class: 'file-name', onclick: () => load(parentOf(currentPath)) },
              el('span', { class: 'muted' }, '↑ Up one level'),
            ),
          ),
        ),
      );
    }

    body.append(
      el(
        'table',
        {},
        el(
          'thead',
          {},
          el('tr', {}, el('th', {}, 'Name'), el('th', {}, 'Size'), el('th', {}, 'Modified'), el('th', {}, '')),
        ),
        el('tbody', {}, rows),
      ),
    );
  }

  load('/');

  return el(
    'div',
    { class: 'card' },
    el(
      'div',
      { class: 'card-head' },
      el('div', { class: 'grow' }, el('h2', {}, 'Files'), crumbs),
      actions,
    ),
    body,
  );
}

function newFolderModal(domain, currentPath, onDone) {
  const name = el('input', { type: 'text', placeholder: 'images' });
  const alertHost = el('div');
  const save = el('button', { class: 'btn primary' }, 'Create folder');

  save.onclick = submitHandler(save, alertHost, async () => {
    const res = await api(`/domains/${domain.id}/files/folder`, {
      method: 'POST',
      body: { path: currentPath, name: name.value.trim() },
    });
    toast(res.message, 'ok');
    close();
    onDone();
  });

  const close = openModal({
    title: 'New folder',
    render: () => el('div', {}, alertHost, field('Folder name', name)),
    footer: (closeFn) => [el('button', { class: 'btn', onclick: closeFn }, 'Cancel'), save],
  });
}

function renameModal(domain, fullPath, currentName, onDone) {
  const name = el('input', { type: 'text', value: currentName });
  const alertHost = el('div');
  const save = el('button', { class: 'btn primary' }, 'Rename');

  save.onclick = submitHandler(save, alertHost, async () => {
    const res = await api(`/domains/${domain.id}/files/rename`, {
      method: 'POST',
      body: { path: fullPath, name: name.value.trim() },
    });
    toast(res.message, 'ok');
    close();
    onDone();
  });

  const close = openModal({
    title: `Rename ${currentName}`,
    render: () => el('div', {}, alertHost, field('New name', name)),
    footer: (closeFn) => [el('button', { class: 'btn', onclick: closeFn }, 'Cancel'), save],
  });
}

/// Opens a text file for editing. Binary files and anything large are refused
/// by the server, which says so rather than mangling the file.
async function openFileModal(domain, fullPath, name, onDone) {
  let opened;
  try {
    opened = await api(`/domains/${domain.id}/files/content?path=${encodeURIComponent(fullPath)}`);
  } catch (err) {
    return openModal({
      title: name,
      render: () =>
        el(
          'div',
          {},
          el('div', { class: 'alert info', style: 'margin:0' }, err.message),
          el(
            'p',
            { class: 'small', style: 'margin-bottom:0' },
            el(
              'a',
              { href: `/api/domains/${domain.id}/files/download?path=${encodeURIComponent(fullPath)}` },
              'Download it instead →',
            ),
          ),
        ),
      footer: (closeFn) => [el('button', { class: 'btn', onclick: closeFn }, 'Close')],
    });
  }

  const editor = el('textarea', { class: 'code-editor', spellcheck: 'false' }, opened.content);
  const alertHost = el('div');
  const save = el('button', { class: 'btn primary' }, 'Save changes');

  save.onclick = submitHandler(save, alertHost, async () => {
    const res = await api(`/domains/${domain.id}/files/content`, {
      method: 'PUT',
      body: { path: fullPath, content: editor.value },
    });
    toast(res.message, 'ok');
    close();
    onDone();
  });

  const close = openModal({
    title: name,
    wide: true,
    render: () =>
      el(
        'div',
        {},
        alertHost,
        el('p', { class: 'muted small mono', style: 'margin-top:0' }, fullPath),
        editor,
      ),
    footer: (closeFn) => [el('button', { class: 'btn', onclick: closeFn }, 'Cancel'), save],
  });
}
