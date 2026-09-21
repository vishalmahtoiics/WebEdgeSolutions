// The standalone webmail client.
//
// People sign in here with their email address and the mailbox's own password.
// There is no portal account and no hosting provider anywhere in sight — this
// is a mail client, and it only ever shows what the mail server actually holds.

import {
  api, attachmentUrl, el, clear, fill, icon, toast, openModal, confirmModal, field,
  errorAlert, submitHandler, emptyState, messageDate, fullDate, formatBytes,
  displayName, fullAddress, addressLine,
} from './ui.js';
import { openCompose, openForward } from './compose.js';

const root = document.getElementById('app');

const state = {
  account: null,
  folders: [],
  folder: 'INBOX',
  page: 1,
  perPage: 25,
  total: 0,
  search: '',
  messages: [],
  selectedUid: null,
};

const dom = {};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

boot();

async function boot() {
  let account = null;
  try {
    ({ account } = await api('/me'));
  } catch {
    // An unreachable server is still a sign-in screen, not a blank page.
  }
  if (account) {
    state.account = account;
    renderShell();
    await Promise.all([loadFolders(), loadMessages()]);
  } else {
    renderLogin();
  }
}

// A session that ends anywhere (expiry, or signing out in another tab) returns
// every tab to the sign-in screen rather than leaving a dead interface up.
window.addEventListener('mail:signed-out', () => {
  if (!state.account) return;
  state.account = null;
  renderLogin('Your session has ended. Please sign in again.');
});

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------

function renderLogin(notice) {
  root.className = '';
  clear(document.getElementById('modal-root'));

  const address = el('input', { type: 'email', autocomplete: 'username', placeholder: 'you@yourdomain.com', required: true });
  const password = el('input', { type: 'password', autocomplete: 'current-password', placeholder: '••••••••', required: true });
  const alertHost = el('div', {});
  const button = el('button', { class: 'btn primary block', type: 'submit' }, 'Sign in');

  const form = el(
    'form',
    {},
    alertHost,
    field('Email address', address),
    field('Password', password, 'The password for the mailbox itself — the same one you would use in Outlook or on your phone.'),
    button,
  );

  form.addEventListener(
    'submit',
    submitHandler(button, alertHost, async () => {
      const { account } = await api('/login', {
        method: 'POST',
        body: { address: address.value.trim(), password: password.value },
      });
      state.account = account;
      state.folder = 'INBOX';
      state.page = 1;
      state.search = '';
      state.selectedUid = null;
      renderShell();
      await Promise.all([loadFolders(), loadMessages()]);
    }),
  );

  if (notice) alertHost.append(el('div', { class: 'alert info' }, notice));

  fill(
    root,
    el(
      'div',
      { class: 'login-wrap' },
      el(
        'div',
        { class: 'login-card' },
        el('div', { class: 'login-brand' }, el('span', { class: 'logo' }, icon('mail', 18)), 'Webmail'),
        el('h1', {}, 'Sign in to your mailbox'),
        el('p', { class: 'sub' }, 'Read, write and manage your email from any browser.'),
        form,
        el(
          'p',
          { class: 'small muted', style: 'margin:18px 0 0;display:flex;gap:7px;align-items:flex-start' },
          icon('shield', 15),
          el('span', {}, 'Your password is used to talk to the mail server and is never saved to your account.'),
        ),
      ),
    ),
  );
  address.focus();
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

function renderShell() {
  root.className = '';

  const search = el('input', {
    type: 'search',
    placeholder: 'Search mail',
    value: state.search,
    'aria-label': 'Search mail',
  });
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    state.search = search.value.trim();
    state.page = 1;
    state.selectedUid = null;
    loadMessages();
  });
  dom.search = search;

  const menuToggle = el(
    'button',
    { class: 'menu-toggle', 'aria-label': 'Folders', onclick: () => dom.sidebar.classList.toggle('open') },
    icon('menu', 20),
  );

  const topbar = el(
    'div',
    { class: 'topbar' },
    menuToggle,
    el('div', { class: 'brand' }, el('span', { class: 'logo' }, icon('mail', 17)), el('span', { class: 'name' }, 'Webmail')),
    el('div', { class: 'searchbox' }, icon('search', 15), search),
    el(
      'div',
      { class: 'who' },
      el('div', { class: 'addr' }, state.account.address),
      el('div', { class: 'role' }, state.account.canSend ? 'Mailbox' : 'Read only'),
    ),
    el('button', { class: 'menu-toggle', style: 'display:inline-flex', 'aria-label': 'Sign out', onclick: signOut }, icon('logout', 18)),
  );

  dom.sidebar = el('nav', { class: 'sidebar' });
  dom.listHead = el('div', { class: 'list-head' });
  dom.listScroll = el('div', { class: 'list-scroll' });
  dom.listFoot = el('div', { class: 'list-foot' });
  dom.list = el('div', { class: 'list' }, dom.listHead, dom.listScroll, dom.listFoot);
  dom.reader = el('div', { class: 'reader' });
  dom.body = el('div', { class: 'body' }, dom.sidebar, dom.list, dom.reader);

  fill(root, el('div', { class: 'shell' }, topbar, dom.body));

  renderFolders();
  renderList();
  renderReaderEmpty();
}

async function signOut() {
  try {
    await api('/logout', { method: 'POST' });
  } catch {
    // Signing out locally matters more than the server's acknowledgement.
  }
  state.account = null;
  renderLogin('You have been signed out.');
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

const FOLDER_ICON = { inbox: 'inbox', sent: 'send', drafts: 'draft', trash: 'trash', junk: 'junk' };
const FOLDER_ORDER = ['inbox', 'drafts', 'sent', 'junk', 'trash'];

/// Inbox first, then the other special folders in the order a mail client
/// shows them, then everything else alphabetically.
function sortFolders(folders) {
  const rank = (f) => {
    const index = FOLDER_ORDER.indexOf(f.specialUse);
    return index === -1 ? FOLDER_ORDER.length : index;
  };
  return [...folders].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

async function loadFolders() {
  try {
    const { folders } = await api('/folders');
    state.folders = sortFolders(folders);
  } catch (err) {
    if (err.status !== 401) toast(err.message, 'error');
    state.folders = [];
  }
  renderFolders();
}

function renderFolders() {
  const compose = el(
    'button',
    {
      class: 'btn primary block compose-btn',
      disabled: !state.account?.canSend,
      title: state.account?.canSend ? '' : 'Sending is not set up for this mailbox.',
      onclick: () => openCompose({ kind: 'new', self: state.account.address, onSent: refreshCurrentFolder }),
    },
    icon('plus', 16),
    'Compose',
  );

  const buttons = state.folders.map((folder) =>
    el(
      'button',
      {
        class: `folder ${folder.path === state.folder ? 'active' : ''}`,
        onclick: () => openFolder(folder.path),
      },
      el('span', { class: 'ico' }, icon(FOLDER_ICON[folder.specialUse] || 'folder', 17)),
      el('span', { class: 'grow' }, folder.name),
      folder.unread ? el('span', { class: 'count' }, String(folder.unread)) : null,
    ),
  );

  fill(
    dom.sidebar,
    compose,
    buttons.length ? buttons : el('p', { class: 'small muted', style: 'padding:6px 11px' }, 'No folders found.'),
  );
}

function openFolder(path) {
  state.folder = path;
  state.page = 1;
  state.selectedUid = null;
  dom.sidebar.classList.remove('open');
  dom.body.classList.remove('reading');
  renderFolders();
  renderReaderEmpty();
  loadMessages();
}

const currentFolder = () => state.folders.find((f) => f.path === state.folder) || null;

/// Adjusts a folder's unread badge locally, so reading a message updates the
/// sidebar without a round trip for every click.
function bumpUnread(path, delta) {
  const folder = state.folders.find((f) => f.path === path);
  if (!folder || folder.unread === null || folder.unread === undefined) return;
  folder.unread = Math.max(0, folder.unread + delta);
  renderFolders();
}

// ---------------------------------------------------------------------------
// Message list
// ---------------------------------------------------------------------------

async function loadMessages() {
  fill(
    dom.listScroll,
    el('div', { class: 'empty' }, el('span', { class: 'spinner' }), el('span', { style: 'margin-left:9px' }, 'Loading…')),
  );
  clear(dom.listFoot);

  const params = new URLSearchParams({ folder: state.folder, page: String(state.page) });
  if (state.search) params.set('search', state.search);

  try {
    const result = await api(`/messages?${params}`);
    state.messages = result.messages || [];
    state.total = result.total || 0;
    state.perPage = result.perPage || 25;
  } catch (err) {
    state.messages = [];
    state.total = 0;
    renderList();
    fill(dom.listScroll, errorAlert(err));
    return;
  }
  renderList();
}

async function refreshCurrentFolder() {
  await Promise.all([loadFolders(), loadMessages()]);
}

function renderList() {
  const folder = currentFolder();
  const pages = Math.max(1, Math.ceil(state.total / state.perPage));

  fill(
    dom.listHead,
    el(
      'div',
      { class: 'grow' },
      el('div', { class: 'strong' }, state.search ? 'Search results' : folder?.name || state.folder),
      el(
        'div',
        { class: 'small muted' },
        state.search
          ? `${state.total} match${state.total === 1 ? '' : 'es'} for “${state.search}”`
          : `${state.total} message${state.total === 1 ? '' : 's'}`,
      ),
    ),
    state.search
      ? el(
          'button',
          {
            class: 'btn sm',
            onclick: () => {
              state.search = '';
              dom.search.value = '';
              state.page = 1;
              loadMessages();
            },
          },
          'Clear',
        )
      : null,
    el('button', { class: 'btn ghost sm', 'aria-label': 'Refresh', title: 'Refresh', onclick: refreshCurrentFolder }, icon('refresh', 16)),
  );

  clear(dom.listScroll);
  if (!state.messages.length) {
    dom.listScroll.append(
      state.search
        ? emptyState('search', 'Nothing matched', 'Try a different word, or search another folder.')
        : emptyState('mail', 'This folder is empty', 'New messages will appear here.'),
    );
  } else {
    for (const message of state.messages) dom.listScroll.append(messageRow(message));
  }

  clear(dom.listFoot);
  if (state.total > state.perPage) {
    dom.listFoot.append(
      el(
        'button',
        { class: 'btn sm', disabled: state.page <= 1, onclick: () => { state.page -= 1; loadMessages(); } },
        'Newer',
      ),
      el('span', { class: 'small muted grow', style: 'text-align:center' }, `Page ${state.page} of ${pages}`),
      el(
        'button',
        { class: 'btn sm', disabled: state.page >= pages, onclick: () => { state.page += 1; loadMessages(); } },
        'Older',
      ),
    );
  }
}

/// One row. In Sent and Drafts the useful name is the recipient, not the
/// sender — every message there is from you.
function messageRow(message) {
  const outgoing = ['sent', 'drafts'].includes(currentFolder()?.specialUse);
  const who = outgoing
    ? (message.to || []).map(displayName).join(', ') || 'No recipient'
    : displayName(message.from?.[0]);

  const star = el(
    'button',
    {
      class: `star ${message.flagged ? 'on' : ''}`,
      'aria-label': message.flagged ? 'Remove star' : 'Add star',
      onclick: (e) => {
        e.stopPropagation();
        setFlagged(message, !message.flagged);
      },
    },
    icon('star', 16),
  );
  if (message.flagged) star.querySelector('svg').setAttribute('fill', 'currentColor');

  const row = el(
    'div',
    {
      class: `msg ${message.seen ? '' : 'unread'} ${message.uid === state.selectedUid ? 'selected' : ''}`,
      role: 'button',
      tabindex: '0',
      onclick: () => openMessage(message.uid),
      onkeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openMessage(message.uid);
        }
      },
    },
    star,
    el(
      'div',
      { class: 'grow' },
      el('div', { class: 'from break' }, who),
      el('div', { class: 'subject break' }, message.subject),
    ),
    el(
      'div',
      { class: 'meta' },
      el('div', {}, messageDate(message.date)),
      message.hasAttachments ? el('div', { class: 'clip', style: 'margin-top:4px' }, icon('clip', 14)) : null,
    ),
  );
  return row;
}

/// Stars or unstars a message, then redraws whatever is showing it.
async function setFlagged(message, flagged) {
  try {
    await api(`/messages/${message.uid}/flagged`, { method: 'POST', body: { flagged, folder: state.folder } });
    message.flagged = flagged;
    const row = state.messages.find((m) => m.uid === message.uid);
    if (row) row.flagged = flagged;
    renderList();
    if (state.selectedUid === message.uid && dom.openMessage) renderReader(dom.openMessage);
  } catch (err) {
    if (err.status !== 401) toast(err.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

function renderReaderEmpty() {
  dom.openMessage = null;
  fill(dom.reader, emptyState('mail', 'No message selected', 'Choose a message to read it here.'));
}

async function openMessage(uid) {
  state.selectedUid = uid;
  dom.body.classList.add('reading');
  for (const node of dom.listScroll.querySelectorAll('.msg')) node.classList.remove('selected');
  renderList();

  fill(
    dom.reader,
    el('div', { class: 'empty' }, el('span', { class: 'spinner' }), el('span', { style: 'margin-left:9px' }, 'Opening…')),
  );

  let message;
  try {
    ({ message } = await api(`/messages/${uid}?folder=${encodeURIComponent(state.folder)}`));
  } catch (err) {
    fill(dom.reader, el('div', { style: 'padding:22px' }, errorAlert(err)));
    return;
  }

  // Opening a message marks it read on the server, so mirror that here rather
  // than making the list lie until the next refresh.
  const row = state.messages.find((m) => m.uid === uid);
  if (row && !row.seen) {
    row.seen = true;
    bumpUnread(state.folder, -1);
    renderList();
  }

  renderReader(message);
}

function renderReader(message) {
  dom.openMessage = message;
  const folder = state.folder;
  const row = state.messages.find((m) => m.uid === message.uid);
  const canSend = Boolean(state.account?.canSend);

  const action = (iconName, label, onclick, extra = '') =>
    el('button', { class: `btn sm ${extra}`, onclick }, icon(iconName, 15), label);

  const actions = el(
    'div',
    { class: 'reader-actions' },
    el(
      'button',
      { class: 'btn sm ghost back-to-list', onclick: () => dom.body.classList.remove('reading') },
      icon('back', 15),
      'Back',
    ),
    canSend && action('reply', 'Reply', () => openCompose({ kind: 'reply', message, self: state.account.address, onSent: refreshCurrentFolder })),
    canSend && action('replyAll', 'Reply all', () => openCompose({ kind: 'replyAll', message, self: state.account.address, onSent: refreshCurrentFolder })),
    canSend && action('forward', 'Forward', () => openForward({ message, folder, onSent: refreshCurrentFolder })),
    action('star', row?.flagged ? 'Starred' : 'Star', () => setFlagged(message, !row?.flagged)),
    action('unread', 'Mark unread', markUnread),
    action('move', 'Move', () => openMoveDialog(message)),
    action('trash', 'Delete', () => deleteCurrent(message), 'danger'),
  );

  async function markUnread() {
    try {
      await api(`/messages/${message.uid}/seen`, { method: 'POST', body: { seen: false, folder } });
      if (row) row.seen = false;
      bumpUnread(folder, 1);
      renderList();
      toast('Marked as unread.', 'ok');
    } catch (err) {
      if (err.status !== 401) toast(err.message, 'error');
    }
  }

  const head = el(
    'div',
    { class: 'reader-head' },
    el('h2', { style: 'font-size:19px' }, message.subject),
    el(
      'div',
      { class: 'small muted', style: 'margin-top:7px' },
      el('div', { class: 'break' }, el('span', { class: 'strong' }, 'From: '), fullAddress(message.from?.[0]) || 'Unknown'),
      el('div', { class: 'break' }, el('span', { class: 'strong' }, 'To: '), addressLine(message.to, 'Undisclosed recipients')),
      message.cc?.length ? el('div', { class: 'break' }, el('span', { class: 'strong' }, 'Cc: '), addressLine(message.cc)) : null,
      el('div', {}, fullDate(message.date)),
    ),
    actions,
  );

  const parts = [head];

  if (message.attachments?.length) {
    parts.push(
      el(
        'div',
        { class: 'attachments' },
        el('span', { class: 'small muted' }, `${message.attachments.length} attachment${message.attachments.length === 1 ? '' : 's'}:`),
        ...message.attachments.map((a) =>
          el(
            'a',
            { class: 'btn sm', href: attachmentUrl(folder, message.uid, a.index), download: a.filename },
            icon('download', 14),
            `${a.filename}${a.size ? ` · ${formatBytes(a.size)}` : ''}`,
          ),
        ),
      ),
    );
  }

  const body = el('div', { class: 'reader-body' });
  if (message.html) {
    // The message renders in a sandboxed frame: no scripts, no access to this
    // page, and the page's own policy blocks remote loads, so tracking pixels
    // never fire.
    body.append(el('iframe', { class: 'mail-frame', sandbox: '', srcdoc: message.html, title: 'Message content' }));
    if (/<img[^>]+src=["']?https?:/i.test(message.html)) {
      body.prepend(
        el(
          'div',
          { class: 'alert info', style: 'margin:14px 22px 0' },
          'Images hosted elsewhere are not loaded, so the sender cannot tell when you opened this message.',
        ),
      );
    }
  } else if (message.text) {
    body.append(el('pre', { class: 'mail-text' }, message.text));
  } else {
    body.append(emptyState('mail', 'This message has no text', 'It may contain only attachments.'));
  }
  parts.push(body);

  fill(dom.reader, parts);
}

function openMoveDialog(message) {
  const others = state.folders.filter((f) => f.path !== state.folder);
  if (!others.length) {
    toast('There is nowhere else to move this message.', 'error');
    return;
  }

  const select = el('select', {}, ...others.map((f) => el('option', { value: f.path }, f.name)));
  const alertHost = el('div', {});

  openModal({
    title: 'Move message',
    render: () => el('form', { onsubmit: (e) => e.preventDefault() }, alertHost, field('Move to', select)),
    footer: (close) => {
      const button = el('button', { class: 'btn primary' }, 'Move');
      button.addEventListener('click', async () => {
        button.disabled = true;
        clear(button).append(el('span', { class: 'spinner' }), 'Moving…');
        try {
          const result = await api(`/messages/${message.uid}/move`, {
            method: 'POST',
            body: { to: select.value, folder: state.folder },
          });
          close();
          toast(result.message || 'Message moved.', 'ok');
          state.selectedUid = null;
          dom.body.classList.remove('reading');
          renderReaderEmpty();
          await refreshCurrentFolder();
        } catch (err) {
          clear(alertHost).append(errorAlert(err));
          button.disabled = false;
          clear(button).append('Move');
        }
      });
      return [el('button', { class: 'btn', onclick: close }, 'Cancel'), button];
    },
  });
}

function deleteCurrent(message) {
  const inTrash = currentFolder()?.specialUse === 'trash';
  confirmModal({
    title: inTrash ? 'Delete permanently' : 'Delete message',
    message: inTrash
      ? 'This message is already in the trash, so deleting it removes it for good. This cannot be undone.'
      : 'The message will be moved to the trash.',
    confirmLabel: 'Delete',
    onConfirm: async () => {
      const result = await api(`/messages/${message.uid}?folder=${encodeURIComponent(state.folder)}`, { method: 'DELETE' });
      toast(result.message || 'Message deleted.', 'ok');
      state.selectedUid = null;
      dom.body.classList.remove('reading');
      renderReaderEmpty();
      await refreshCurrentFolder();
    },
  });
}
