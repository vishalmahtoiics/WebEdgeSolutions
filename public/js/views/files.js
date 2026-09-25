// File manager for a domain, over its stored FTP/FTPS/SFTP credentials.
//
// The panel keeps its own current directory rather than putting it in the URL,
// so browsing folders does not fill the browser's history with dead entries.
//
// Everything that acts on several items at once — delete, download as a zip,
// zip into the folder — works on a selection from the folder being shown, and
// the selection is dropped whenever the folder changes, so nothing ticked in
// one folder can be acted on from another.

import {
  api, el, clear, appendAll, field, submitHandler, toast, openModal, emptyState, formatDate, errorAlert,
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

const joinPath = (dir, name) => `${dir}/${name}`.replace(/\/+/g, '/');

const extensionOf = (name) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

/// Files that are certainly not text. Anything else is offered to the editor,
/// and the server has the last word: it refuses a file with NUL bytes in it,
/// so a guess here that is wrong costs a message, never a corrupted file.
const BINARY = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp', 'tif', 'tiff', 'psd',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt',
  'zip', 'gz', 'tgz', 'rar', '7z', 'tar', 'bz2', 'xz',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'mp4', 'm4a', 'wav', 'ogg', 'webm', 'mov', 'avi', 'mkv',
  'exe', 'dll', 'so', 'bin', 'dat', 'iso', 'jar', 'class', 'phar', 'sqlite', 'db',
]);

const isZip = (entry) => entry.type !== 'directory' && extensionOf(entry.name) === 'zip';
const isEditable = (entry) => entry.type !== 'directory' && !BINARY.has(extensionOf(entry.name));

function iconFor(entry) {
  if (entry.type === 'directory') return icon('folder', 17);
  return icon('file', 17);
}

/// Saves a Blob as a download without leaving the page.
function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: name, style: 'display:none' });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/// The file name from a Content-Disposition header, preferring the UTF-8 one.
function filenameFrom(header, fallback) {
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header || '');
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      // Fall through to the plain one.
    }
  }
  const plain = /filename="([^"]+)"/i.exec(header || '');
  return plain ? plain[1] : fallback;
}

export function filesPanel(domain) {
  const base = `/domains/${domain.id}/files`;
  let currentPath = '/';
  let entries = [];
  let filter = '';
  const selected = new Set();

  const body = el('div', { class: 'files-body' }, el('div', { class: 'muted small files-pad' }, 'Connecting…'));
  const crumbs = el('nav', { class: 'files-crumbs', 'aria-label': 'Folder' });
  const toolbar = el('div', { class: 'files-toolbar' });
  const bulk = el('div', { class: 'table-bulk' });
  const status = el('div', { class: 'files-status small muted' });
  const progress = el('div', { class: 'files-progress small', hidden: true });

  const search = el('input', {
    type: 'search',
    class: 'table-search',
    placeholder: 'Filter this folder…',
    'aria-label': 'Filter this folder',
    oninput: () => {
      filter = search.value.trim().toLowerCase();
      drawEntries();
    },
  });

  // ---------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------

  async function load(target) {
    clear(body).append(el('div', { class: 'muted small files-pad' }, el('span', { class: 'spinner' }), ' Loading…'));

    let data;
    try {
      data = await api(`${base}?path=${encodeURIComponent(target)}`);
    } catch (err) {
      clear(body).append(
        el(
          'div',
          { class: 'files-pad' },
          el(
            'div',
            { class: 'alert error', style: 'margin:0' },
            err.message,
            err.status === 400
              ? el(
                  'div',
                  { class: 'small', style: 'margin-top:8px' },
                  'The file server details for this domain have not been set up yet.',
                )
              : null,
          ),
        ),
      );
      return;
    }

    if (data.path !== currentPath) {
      // A different folder: what was ticked belongs to the old one, and so
      // does the filter.
      selected.clear();
      search.value = '';
      filter = '';
    }
    currentPath = data.path;
    entries = data.entries;
    // Drop anything ticked that is no longer there, after a delete or rename.
    for (const name of [...selected]) if (!entries.some((e) => e.name === name)) selected.delete(name);

    drawCrumbs();
    drawEntries();
  }

  const reload = () => load(currentPath);

  // ---------------------------------------------------------------------------
  // Breadcrumbs and toolbar
  // ---------------------------------------------------------------------------

  function drawCrumbs() {
    clear(crumbs);
    const parts = currentPath.split('/').filter(Boolean);

    crumbs.append(
      el(
        'button',
        { class: `files-crumb${parts.length ? '' : ' current'}`, onclick: () => load('/') },
        icon('folder', 14),
        'Home',
      ),
    );

    let walked = '';
    parts.forEach((part, i) => {
      walked += `/${part}`;
      const here = walked;
      crumbs.append(
        el('span', { class: 'files-crumb-sep', 'aria-hidden': 'true' }, '›'),
        i === parts.length - 1
          ? el('span', { class: 'files-crumb current', 'aria-current': 'page' }, part)
          : el('button', { class: 'files-crumb', onclick: () => load(here) }, part),
      );
    });
  }

  const uploadInput = el('input', {
    type: 'file',
    multiple: true,
    style: 'display:none',
    onchange: async (e) => {
      const files = [...(e.target.files || [])];
      uploadInput.value = '';
      await uploadFiles(files);
    },
  });

  /// Uploads one file at a time, so a large batch never has to fit in one
  /// request, and a failure part way says which file it was.
  async function uploadFiles(files) {
    if (!files.length) return;
    const into = currentPath;
    let done = 0;
    const failed = [];
    progress.hidden = false;

    for (const file of files) {
      clear(progress).append(
        el('span', { class: 'spinner' }),
        ` Uploading ${done + failed.length + 1} of ${files.length}: `,
        el('span', { class: 'mono' }, file.name),
      );
      const form = new FormData();
      form.append('path', into);
      form.append('file', file);
      try {
        const res = await fetch(`/api${base}/upload`, { method: 'POST', body: form, credentials: 'same-origin' });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(payload.error || `Upload failed (${res.status}).`);
        done += 1;
      } catch (err) {
        failed.push(`${file.name}: ${err.message}`);
      }
    }

    progress.hidden = true;
    if (failed.length) {
      toast(`Uploaded ${done} of ${files.length}. ${failed.join(' · ')}`, 'error');
    } else {
      toast(done === 1 ? `${files[0].name} uploaded.` : `${done} files uploaded.`, 'ok');
    }
    if (into === currentPath) reload();
  }

  toolbar.append(
    uploadInput,
    search,
    el('span', { class: 'grow' }),
    el('button', { class: 'btn sm ghost', title: 'Reload this folder', onclick: reload }, 'Refresh'),
    el('button', { class: 'btn sm', onclick: () => newFileModal(domain, currentPath, (p) => { reload(); editFile(p); }) }, '+ File'),
    el('button', { class: 'btn sm', onclick: () => newFolderModal(domain, currentPath, reload) }, '+ Folder'),
    el('button', { class: 'btn sm primary', onclick: () => uploadInput.click() }, 'Upload'),
  );

  const editFile = (fullPath) => openFileModal(domain, fullPath, fullPath.split('/').pop(), reload);

  // ---------------------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------------------

  const visible = () =>
    filter ? entries.filter((e) => e.name.toLowerCase().includes(filter)) : entries;

  // The header checkbox of the table currently drawn.
  let allBox = null;

  /// Brings the header checkbox and the bar in line with the selection,
  /// without redrawing the rows — so ticking a box does not move focus or
  /// scroll the list.
  function syncSelection() {
    if (allBox) {
      const shown = visible();
      const picked = shown.filter((e) => selected.has(e.name)).length;
      allBox.checked = shown.length > 0 && picked === shown.length;
      allBox.indeterminate = picked > 0 && picked < shown.length;
    }
    drawBulk();
  }

  function drawBulk() {
    clear(bulk);
    bulk.classList.toggle('is-on', selected.size > 0);
    if (!selected.size) return;

    const names = [...selected];
    const chosen = entries.filter((e) => selected.has(e.name));
    const single = chosen.length === 1 ? chosen[0] : null;

    const zipBtn = el('button', { class: 'btn sm' }, 'Download as zip');
    zipBtn.onclick = () => downloadZip(zipBtn, names);

    // appendAll rather than append: the Extract button is conditional, and
    // append would write a literal "null" in its place.
    appendAll(bulk, [
      el('span', { class: 'strong' }, `${names.length} selected`),
      el('span', { class: 'grow' }),
      single && isZip(single)
        ? el('button', { class: 'btn sm', onclick: () => extractModal(domain, joinPath(currentPath, single.name), reload) }, 'Extract')
        : null,
      zipBtn,
      el('button', { class: 'btn sm', onclick: () => compressModal(domain, currentPath, names, reload) }, 'Create zip'),
      el('button', { class: 'btn sm danger', onclick: () => deleteManyModal(domain, currentPath, chosen, reload) }, 'Delete'),
      el('button', { class: 'btn sm ghost', onclick: () => { selected.clear(); drawEntries(); } }, 'Clear'),
    ]);
  }

  async function downloadZip(button, names) {
    const original = button.textContent;
    button.disabled = true;
    clear(button).append(el('span', { class: 'spinner' }), 'Zipping…');
    try {
      const res = await fetch(`/api${base}/zip-download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ path: currentPath, names }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || `The zip could not be made (${res.status}).`);
      }
      const blob = await res.blob();
      saveBlob(blob, filenameFrom(res.headers.get('Content-Disposition'), 'files.zip'));
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      button.disabled = false;
      clear(button).append(original);
    }
  }

  // ---------------------------------------------------------------------------
  // The list
  // ---------------------------------------------------------------------------

  function drawEntries() {
    clear(body);
    drawBulk();

    const shown = visible();
    const folders = entries.filter((e) => e.type === 'directory').length;
    const files = entries.length - folders;
    const bytes = entries.reduce((sum, e) => sum + (e.type === 'directory' ? 0 : e.size || 0), 0);
    clear(status).append(
      `${folders} folder${folders === 1 ? '' : 's'}, ${files} file${files === 1 ? '' : 's'}`,
      files ? ` · ${formatBytes(bytes)}` : '',
      filter ? ` · ${shown.length} match${shown.length === 1 ? '' : 'es'}` : '',
    );

    if (!entries.length) {
      allBox = null;
      appendAll(body, [
        currentPath !== '/' ? upRow(true) : null,
        emptyState('folder', 'This folder is empty', 'Upload files, or drop them anywhere on this panel.'),
      ]);
      return;
    }

    const headBox = el('input', {
      type: 'checkbox',
      'aria-label': 'Select everything shown',
      onchange: () => {
        for (const e of shown) (headBox.checked ? selected.add(e.name) : selected.delete(e.name));
        drawEntries();
      },
    });
    allBox = headBox;
    syncSelection();

    const rows = shown.map((entry) => entryRow(entry));
    if (currentPath !== '/') rows.unshift(upRow(false));
    if (!shown.length) {
      rows.push(
        el('tr', { class: 'is-blank' }, el('td', { colspan: 5, class: 'muted small' }, `Nothing here matches "${search.value}".`)),
      );
    }

    body.append(
      el(
        'div',
        { class: 'table-scroll' },
        el(
          'table',
          { class: 'files-table' },
          el(
            'thead',
            {},
            el(
              'tr',
              {},
              el('th', { class: 'pick' }, headBox),
              el('th', {}, 'Name'),
              el('th', { class: 'hide-sm' }, 'Size'),
              el('th', { class: 'hide-sm' }, 'Modified'),
              el('th', {}, el('span', { class: 'sr-only' }, 'Actions')),
            ),
          ),
          el('tbody', {}, rows),
        ),
      ),
    );
  }

  function upRow(standalone) {
    const button = el(
      'button',
      { class: 'file-name', onclick: () => load(parentOf(currentPath)) },
      el('span', { class: 'files-up' }, '↑'),
      el('span', { class: 'muted' }, 'Up one level'),
    );
    return standalone
      ? el('div', { class: 'files-pad', style: 'padding-bottom:0' }, button)
      : el('tr', { class: 'is-blank' }, el('td', {}), el('td', { colspan: 4 }, button));
  }

  function entryRow(entry) {
    const full = joinPath(currentPath, entry.name);
    const isDir = entry.type === 'directory';

    const box = el('input', {
      type: 'checkbox',
      checked: selected.has(entry.name),
      'aria-label': `Select ${entry.name}`,
      onchange: () => {
        (box.checked ? selected.add(entry.name) : selected.delete(entry.name));
        row.classList.toggle('is-picked', box.checked);
        syncSelection();
      },
    });

    // What clicking the name does: a folder opens, a zip offers to extract,
    // anything that might be text opens in the editor, and the rest download.
    const open = () => {
      if (isDir) return load(full);
      if (isZip(entry)) return extractModal(domain, full, reload);
      if (isEditable(entry)) return editFile(full);
      window.location.href = `/api${base}/download?path=${encodeURIComponent(full)}`;
    };

    const actions = [];
    if (isEditable(entry)) {
      actions.push(el('button', { class: 'btn sm', onclick: () => editFile(full) }, 'Edit'));
    }
    if (isZip(entry)) {
      actions.push(el('button', { class: 'btn sm', onclick: () => extractModal(domain, full, reload) }, 'Extract'));
    }
    if (!isDir) {
      actions.push(
        el('a', { class: 'btn sm ghost', href: `/api${base}/download?path=${encodeURIComponent(full)}` }, 'Download'),
      );
    }
    actions.push(
      el('button', { class: 'btn sm ghost', onclick: () => renameModal(domain, full, entry.name, reload) }, 'Rename'),
      el(
        'button',
        { class: 'btn sm ghost danger-text', onclick: () => deleteManyModal(domain, currentPath, [entry], reload) },
        'Delete',
      ),
    );

    const row = el(
      'tr',
      { class: selected.has(entry.name) ? 'is-picked' : '' },
      el('td', { class: 'pick', onclick: (e) => e.target === e.currentTarget && box.click() }, box),
      el(
        'td',
        {},
        el(
          'button',
          { class: `file-name ${isDir ? 'is-dir' : ''}`, title: isDir ? 'Open folder' : isZip(entry) ? 'Extract' : isEditable(entry) ? 'Edit' : 'Download', onclick: open },
          el('span', { class: `files-ico ${isDir ? 'dir' : isZip(entry) ? 'zip' : ''}` }, iconFor(entry)),
          el('span', { class: 'break' }, entry.name),
        ),
        // On a phone the size and date columns are hidden, so they ride
        // under the name instead.
        el(
          'div',
          { class: 'show-sm small muted files-meta' },
          isDir ? 'Folder' : formatBytes(entry.size),
        ),
      ),
      el('td', { class: 'small muted nowrap hide-sm' }, isDir ? '—' : formatBytes(entry.size)),
      // A real timestamp is formatted; a raw LIST string is shown as the
      // server wrote it rather than guessed at.
      el(
        'td',
        { class: 'small muted nowrap hide-sm' },
        entry.modifiedAt ? formatDate(entry.modifiedAt, { withTime: true }) : entry.modifiedLabel || '—',
      ),
      el('td', { class: 'files-actions-cell' }, el('div', { class: 'files-actions' }, actions)),
    );
    return row;
  }

  // ---------------------------------------------------------------------------
  // Drag and drop
  // ---------------------------------------------------------------------------

  const card = el(
    'div',
    { class: 'card files-card' },
    el(
      'div',
      { class: 'files-head' },
      el('div', { class: 'files-title' }, el('h2', {}, 'Files'), status),
      crumbs,
    ),
    toolbar,
    progress,
    bulk,
    body,
    el('div', { class: 'files-drop', 'aria-hidden': 'true' }, icon('cloud', 28), el('div', {}, 'Drop to upload here')),
  );

  // A counter rather than a flag: dragging over a child fires leave on the
  // parent, and a flag would flicker the overlay off and on.
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  card.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth += 1;
    card.classList.add('is-dropping');
  });
  card.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  card.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) card.classList.remove('is-dropping');
  });
  card.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    card.classList.remove('is-dropping');
    // Only files: a dropped folder arrives as an entry the browser cannot
    // read as a file, and the upload would fail on it with a vague error.
    const items = [...(e.dataTransfer.items || [])].filter((i) => i.kind === 'file');
    const files = items.length
      ? items.filter((i) => !i.webkitGetAsEntry?.()?.isDirectory).map((i) => i.getAsFile()).filter(Boolean)
      : [...e.dataTransfer.files];
    if (files.length < e.dataTransfer.files.length) {
      toast('Folders cannot be dropped here. Zip the folder, upload the zip, then extract it.', 'error');
    }
    uploadFiles(files);
  });

  load('/');
  return card;
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

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
    close(true);
    onDone();
  });
  name.addEventListener('keydown', (e) => e.key === 'Enter' && save.click());

  const close = openModal({
    title: 'New folder',
    render: () => el('div', {}, alertHost, field('Folder name', name, `Created in ${currentPath}`)),
    footer: (closeFn) => [el('button', { class: 'btn', onclick: closeFn }, 'Cancel'), save],
  });
}

function newFileModal(domain, currentPath, onDone) {
  const name = el('input', { type: 'text', placeholder: 'index.html' });
  const alertHost = el('div');
  const save = el('button', { class: 'btn primary' }, 'Create and edit');

  save.onclick = submitHandler(save, alertHost, async () => {
    const res = await api(`/domains/${domain.id}/files/file`, {
      method: 'POST',
      body: { path: currentPath, name: name.value.trim() },
    });
    toast(res.message, 'ok');
    close(true);
    onDone(res.path);
  });
  name.addEventListener('keydown', (e) => e.key === 'Enter' && save.click());

  const close = openModal({
    title: 'New file',
    render: () => el('div', {}, alertHost, field('File name', name, `An empty file in ${currentPath}`)),
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
    close(true);
    onDone();
  });
  name.addEventListener('keydown', (e) => e.key === 'Enter' && save.click());

  const close = openModal({
    title: `Rename ${currentName}`,
    render: () => el('div', {}, alertHost, field('New name', name)),
    footer: (closeFn) => [el('button', { class: 'btn', onclick: closeFn }, 'Cancel'), save],
  });

  // The name without its extension is selected, which is the part people
  // actually change.
  const dot = currentName.lastIndexOf('.');
  name.setSelectionRange(0, dot > 0 ? dot : currentName.length);
}

/// Deletes one item or several, after showing exactly what will go.
function deleteManyModal(domain, currentPath, items, onDone) {
  const alertHost = el('div');
  const go = el('button', { class: 'btn danger' }, items.length === 1 ? 'Delete' : `Delete ${items.length} items`);
  const folders = items.filter((i) => i.type === 'directory').length;

  go.onclick = submitHandler(go, alertHost, async () => {
    const res = await api(`/domains/${domain.id}/files/delete-many`, {
      method: 'POST',
      body: { path: currentPath, items: items.map((i) => ({ name: i.name, type: i.type })) },
    });
    toast(res.message, res.ok ? 'ok' : 'error');
    close(true);
    onDone();
  });

  const close = openModal({
    title: items.length === 1 ? `Delete ${items[0].name}` : `Delete ${items.length} items`,
    render: () =>
      el(
        'div',
        {},
        alertHost,
        el(
          'p',
          { style: 'margin-top:0' },
          folders
            ? `Folders are deleted with everything inside them. This cannot be undone.`
            : 'This cannot be undone.',
        ),
        el(
          'ul',
          { class: 'bulk-list' },
          items.map((i) =>
            el(
              'li',
              { class: 'file-name' },
              el('span', { class: `files-ico ${i.type === 'directory' ? 'dir' : ''}` }, iconFor(i)),
              el('span', { class: 'break' }, i.name + (i.type === 'directory' ? '/' : '')),
            ),
          ),
        ),
      ),
    footer: (closeFn) => [el('button', { class: 'btn', onclick: closeFn }, 'Cancel'), go],
  });
}

/// Zips the selection into a new file in the same folder.
function compressModal(domain, currentPath, names, onDone) {
  const suggested = names.length === 1
    ? `${names[0]}.zip`
    : `${currentPath.split('/').filter(Boolean).pop() || domain.name}.zip`;
  const name = el('input', { type: 'text', value: suggested });
  const alertHost = el('div');
  const go = el('button', { class: 'btn primary' }, 'Create zip');

  go.onclick = submitHandler(go, alertHost, async () => {
    const res = await api(`/domains/${domain.id}/files/compress`, {
      method: 'POST',
      body: { path: currentPath, names, name: name.value.trim() || undefined },
    });
    toast(res.message, 'ok');
    close(true);
    onDone();
  });
  name.addEventListener('keydown', (e) => e.key === 'Enter' && go.click());

  const close = openModal({
    title: 'Create a zip',
    render: () =>
      el(
        'div',
        {},
        alertHost,
        el(
          'p',
          { class: 'muted', style: 'margin-top:0' },
          names.length === 1 ? `Zips ${names[0]}` : `Zips ${names.length} items`,
          ` into a new file in ${currentPath}. Folders are included with everything inside them.`,
        ),
        field('Name of the zip', name, 'If that name is taken, a number is added rather than replacing the file.'),
      ),
    footer: (closeFn) => [el('button', { class: 'btn', onclick: closeFn }, 'Cancel'), go],
  });
  name.setSelectionRange(0, Math.max(0, name.value.length - 4));
}

/// Unpacks a zip already on the server.
function extractModal(domain, zipPath, onDone) {
  const zipName = zipPath.split('/').pop();
  const folderName = zipName.replace(/\.zip$/i, '') || 'extracted';
  const parent = zipPath.split('/').slice(0, -1).join('/') || '/';

  const intoFolder = el('input', { type: 'radio', name: 'extract-into', value: 'folder', checked: true });
  const intoHere = el('input', { type: 'radio', name: 'extract-into', value: 'here' });
  const overwrite = el('input', { type: 'checkbox' });
  const alertHost = el('div');
  const result = el('div');
  const go = el('button', { class: 'btn primary' }, 'Extract');

  go.onclick = submitHandler(go, alertHost, async () => {
    const res = await api(`/domains/${domain.id}/files/extract`, {
      method: 'POST',
      body: { path: zipPath, into: intoHere.checked ? 'here' : 'folder', overwrite: overwrite.checked },
    });
    onDone();

    // Nothing to read beyond the message: done.
    if (res.ok && !res.skippedCount) {
      toast(res.message, 'ok');
      close(true);
      return;
    }

    // Otherwise the dialog stays, showing what was left alone and why, so
    // nobody has to guess which files did not change.
    appendAll(clear(result), [
      el('div', { class: `alert ${res.ok ? 'info' : 'error'}` }, res.message),
      res.skippedCount
        ? el(
            'details',
            { class: 'small' },
            el('summary', {}, `Left as they were (${res.skippedCount})`),
            el('ul', { class: 'bulk-list mono' }, res.skipped.map((p) => el('li', {}, p))),
            res.skippedCount > res.skipped.length ? el('div', { class: 'muted' }, `…and ${res.skippedCount - res.skipped.length} more.`) : null,
          )
        : null,
      res.failed?.length
        ? el(
            'details',
            { class: 'small', open: true },
            el('summary', {}, `Not written (${res.failed.length})`),
            el('ul', { class: 'bulk-list' }, res.failed.map((f) => el('li', {}, el('span', { class: 'mono' }, f.name), ` — ${f.error}`))),
          )
        : null,
    ]);
    go.remove();
    clear(cancel).append('Close');
  });

  const cancel = el('button', { class: 'btn' }, 'Cancel');
  const close = openModal({
    title: `Extract ${zipName}`,
    render: () =>
      el(
        'div',
        {},
        alertHost,
        el(
          'div',
          { class: 'files-choices' },
          el(
            'label',
            { class: 'files-choice' },
            intoFolder,
            el(
              'span',
              {},
              el('span', { class: 'strong' }, `Into a new folder, ${folderName}/`),
              el('span', { class: 'small muted' }, 'Keeps everything in the zip together, and cannot clash with what is already here.'),
            ),
          ),
          el(
            'label',
            { class: 'files-choice' },
            intoHere,
            el(
              'span',
              {},
              el('span', { class: 'strong' }, `Into this folder, ${parent}`),
              el('span', { class: 'small muted' }, 'The way a desktop unzips — the contents land beside the zip.'),
            ),
          ),
        ),
        el(
          'label',
          { class: 'check', style: 'margin-top:12px' },
          overwrite,
          ' Replace files that already exist',
        ),
        el(
          'p',
          { class: 'small muted', style: 'margin-bottom:0' },
          'Left unticked, a file that is already there is kept and listed afterwards. ' +
            'A zip that tries to write outside its folder, or contains links, is refused before anything is written.',
        ),
        result,
      ),
    footer: (closeFn) => {
      cancel.onclick = closeFn;
      return [cancel, go];
    },
  });
}

/// Opens a text file for editing.
///
/// Save keeps the editor open, so a change can be made, saved, checked in the
/// browser and adjusted without reopening the file each time; Ctrl+S (or ⌘S)
/// does the same. Closing with unsaved changes asks first.
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

  const editor = el('textarea', {
    class: 'code-editor files-editor',
    spellcheck: 'false',
    autocapitalize: 'off',
    autocomplete: 'off',
    wrap: 'off',
    'aria-label': `Contents of ${name}`,
  });
  editor.value = opened.content;
  let savedValue = editor.value;

  const alertHost = el('div');
  const state = el('span', { class: 'small muted' });
  const cursor = el('span', { class: 'small muted mono' });
  const save = el('button', { class: 'btn primary' }, 'Save');
  const saveClose = el('button', { class: 'btn' }, 'Save & close');

  const dirty = () => editor.value !== savedValue;
  const drawState = () => {
    clear(state).append(dirty() ? el('span', { class: 'files-dirty' }, '● Unsaved changes') : state.dataset.saved || '');
  };
  const drawCursor = () => {
    const before = editor.value.slice(0, editor.selectionStart);
    const line = before.split('\n').length;
    const col = before.length - before.lastIndexOf('\n');
    cursor.textContent = `Ln ${line}, Col ${col}`;
  };

  let saving = false;
  async function doSave({ andClose = false } = {}) {
    if (saving) return;
    saving = true;
    const buttons = [save, saveClose];
    buttons.forEach((b) => { b.disabled = true; });
    const label = andClose ? saveClose : save;
    const original = label.textContent;
    clear(label).append(el('span', { class: 'spinner' }), 'Saving…');
    clear(alertHost);
    const value = editor.value;
    try {
      const res = await api(`/domains/${domain.id}/files/content`, {
        method: 'PUT',
        body: { path: fullPath, content: value, encoding: opened.encoding, eol: opened.eol },
      });
      savedValue = value;
      state.dataset.saved = `Saved ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${formatBytes(res.size)}`;
      toast(`${name} saved.`, 'ok');
      onDone();
      if (andClose) close(true);
    } catch (err) {
      alertHost.append(errorAlert(err));
    } finally {
      saving = false;
      buttons.forEach((b) => { b.disabled = false; });
      clear(label).append(original);
      drawState();
    }
  }

  save.onclick = () => doSave();
  saveClose.onclick = () => doSave({ andClose: true });

  editor.addEventListener('input', drawState);
  editor.addEventListener('keyup', drawCursor);
  editor.addEventListener('click', drawCursor);
  editor.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      doSave();
      return;
    }
    // Tab indents rather than leaving the editor. Inserted through the
    // browser's own editing so Ctrl+Z still undoes it.
    if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (!document.execCommand?.('insertText', false, '\t')) {
        editor.setRangeText('\t', editor.selectionStart, editor.selectionEnd, 'end');
        drawState();
      }
    }
  });

  const facts = [
    formatBytes(opened.size),
    opened.encoding === 'latin1' ? 'Latin-1' : 'UTF-8',
    opened.eol === 'crlf' ? 'Windows line endings (CRLF)' : null,
  ].filter(Boolean).join(' · ');

  const close = openModal({
    title: name,
    wide: true,
    beforeClose: () => !dirty() || window.confirm(`Close ${name} without saving your changes?`),
    render: () =>
      el(
        'div',
        { class: 'files-editor-wrap' },
        alertHost,
        el(
          'div',
          { class: 'files-editor-bar' },
          el('span', { class: 'mono small break' }, fullPath),
          el('span', { class: 'grow' }),
          el('span', { class: 'small muted' }, facts),
        ),
        editor,
        el('div', { class: 'files-editor-bar' }, state, el('span', { class: 'grow' }), cursor, el('span', { class: 'small muted hide-sm' }, ' · Ctrl+S saves')),
      ),
    footer: (closeFn) => [el('button', { class: 'btn ghost', onclick: closeFn }, 'Close'), saveClose, save],
  });

  editor.focus();
  editor.setSelectionRange(0, 0);
  editor.scrollTop = 0;
  drawCursor();
}
