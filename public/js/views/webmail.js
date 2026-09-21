// Webmail for one mailbox: folders on the left, messages in the middle, the
// open message below. Nothing is cached in the browser — every action asks the
// server, which asks the mail server — so what is shown is what is really there.

import {
  api, el, clear, field, submitHandler, toast, openModal, confirmModal, emptyState, formatDate, relativeTime,
} from '../core.js';
import { navigate } from '../app.js';
import { icon } from '../icons.js';

const FOLDER_ICON = {
  inbox: 'mail', sent: 'mail', drafts: 'file', trash: 'folder', junk: 'folder',
};

const describe = (people) =>
  (people || []).map((p) => p.name || p.address).filter(Boolean).join(', ') || '(unknown)';

export async function renderWebmail({ param, user }) {
  // The route carries "<domainId>~<mailboxId>", since a mailbox only means
  // something in the context of its domain.
  const [domainId, mailboxId] = String(param || '').split('~');
  if (!domainId || !mailboxId) {
    navigate('emails');
    return el('div');
  }

  const detail = await api(`/domains/${domainId}`);
  const mailbox = detail.emailAccounts.find((m) => m.id === mailboxId);
  if (!mailbox) throw new Error('That mailbox no longer exists.');

  const frag = el('div');
  frag.append(
    el('button', { class: 'backlink', onclick: () => navigate(`domain/${domainId}`) }, '← Back to domain'),
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        { class: 'grow' },
        el('h1', {}, mailbox.address),
        el('p', {}, `Mailbox on ${detail.domain.name}`),
      ),
      el(
        'div',
        { class: 'page-actions' },
        el('button', { class: 'btn', onclick: () => passwordModal(domainId, mailbox) }, 'Mailbox password'),
      ),
    ),
  );

  const shell = el('div');
  frag.append(shell);

  // Without a saved password there is no inbox to show, so ask for one first.
  try {
    await mount(shell, domainId, mailbox);
  } catch (err) {
    clear(shell).append(
      el(
        'div',
        { class: 'card' },
        el(
          'div',
          { class: 'card-body' },
          el('div', { class: 'alert info', style: 'margin:0 0 14px' }, err.message),
          el(
            'button',
            { class: 'btn primary', onclick: () => passwordModal(domainId, mailbox) },
            'Add the mailbox password',
          ),
        ),
      ),
    );
  }

  return frag;
}

async function mount(shell, domainId, mailbox) {
  const base = `/domains/${domainId}/emails/${mailbox.id}/mail`;
  const { folders } = await api(`${base}/folders`);

  let currentFolder = folders.find((f) => f.specialUse === 'inbox')?.path || folders[0]?.path || 'INBOX';
  let currentPage = 1;

  const folderList = el('aside', { class: 'mail-folders' });
  const listBody = el('div', { class: 'card-body tight table-scroll' });
  const readerHost = el('div');
  const listHead = el('div', { class: 'card-head' });

  function drawFolders() {
    clear(folderList).append(
      ...folders.map((f) =>
        el(
          'button',
          {
            class: `nav-item ${f.path === currentFolder ? 'active' : ''}`,
            onclick: () => {
              currentFolder = f.path;
              currentPage = 1;
              clear(readerHost);
              loadList();
              drawFolders();
            },
          },
          el('span', { class: 'ico' }, icon(FOLDER_ICON[f.specialUse] || 'folder', 16)),
          f.specialUse === 'inbox' ? 'Inbox' : f.name,
        ),
      ),
    );
  }

  async function loadList() {
    clear(listBody).append(el('div', { class: 'muted small', style: 'padding:18px' }, 'Loading…'));
    let data;
    try {
      data = await api(`${base}/messages?folder=${encodeURIComponent(currentFolder)}&page=${currentPage}`);
    } catch (err) {
      return clear(listBody).append(el('div', { class: 'alert error', style: 'margin:18px' }, err.message));
    }

    clear(listHead).append(
      el(
        'div',
        { class: 'grow' },
        el('h2', {}, currentFolder === 'INBOX' ? 'Inbox' : currentFolder),
        el('p', {}, data.total ? `${data.total} message${data.total === 1 ? '' : 's'}` : 'No messages'),
      ),
      el('button', { class: 'btn sm', onclick: loadList }, 'Refresh'),
      el('button', { class: 'btn sm primary', onclick: () => composeModal(base, mailbox) }, 'Compose'),
    );

    if (!data.messages.length) {
      clear(listBody);
      listBody.className = 'card-body';
      return listBody.append(emptyState('mail', 'Nothing here', 'This folder is empty.'));
    }

    listBody.className = 'card-body tight table-scroll';
    clear(listBody).append(
      el(
        'table',
        {},
        el(
          'tbody',
          {},
          data.messages.map((m) =>
            el(
              'tr',
              { class: m.seen ? '' : 'unread', style: 'cursor:pointer', onclick: () => openMessage(m.uid) },
              el(
                'td',
                {},
                el('div', { class: m.seen ? '' : 'strong' }, describe(m.from)),
                el('div', { class: 'small muted break' }, m.subject),
              ),
              el('td', { class: 'small muted nowrap', style: 'text-align:right' }, m.date ? relativeTime(m.date) : '—'),
            ),
          ),
        ),
      ),
    );

    // Paging, only when there is more than one page.
    const pages = Math.ceil(data.total / data.perPage);
    if (pages > 1) {
      listBody.append(
        el(
          'div',
          { style: 'display:flex;gap:8px;align-items:center;justify-content:center;padding:12px' },
          el(
            'button',
            { class: 'btn sm', disabled: currentPage <= 1, onclick: () => { currentPage -= 1; loadList(); } },
            'Newer',
          ),
          el('span', { class: 'small muted' }, `Page ${currentPage} of ${pages}`),
          el(
            'button',
            { class: 'btn sm', disabled: currentPage >= pages, onclick: () => { currentPage += 1; loadList(); } },
            'Older',
          ),
        ),
      );
    }
  }

  async function openMessage(uid) {
    clear(readerHost).append(
      el('div', { class: 'card' }, el('div', { class: 'card-body muted small' }, 'Opening…')),
    );

    let message;
    try {
      ({ message } = await api(`${base}/messages/${uid}?folder=${encodeURIComponent(currentFolder)}`));
    } catch (err) {
      return clear(readerHost).append(
        el('div', { class: 'card' }, el('div', { class: 'card-body' }, el('div', { class: 'alert error', style: 'margin:0' }, err.message))),
      );
    }

    clear(readerHost).append(reader(base, mailbox, message, currentFolder, loadList));
    readerHost.scrollIntoView({ behavior: 'smooth', block: 'start' });
    loadList(); // the message is now read, so refresh the list's unread marks
  }

  drawFolders();
  await loadList();

  clear(shell).append(
    el(
      'div',
      { class: 'mail-layout' },
      el('div', { class: 'card' }, el('div', { class: 'card-body', style: 'padding:10px' }, folderList)),
      el('div', {}, el('div', { class: 'card' }, listHead, listBody), readerHost),
    ),
  );
}

function reader(base, mailbox, message, folder, onChanged) {
  // A message body is someone else's HTML. It goes in a sandboxed iframe with
  // no scripts and no same-origin access, so it cannot touch the portal.
  const bodyHost = el('div', { class: 'card-body' });

  if (message.html) {
    const frame = el('iframe', {
      class: 'mail-body',
      sandbox: '',
      srcdoc: `<!doctype html><meta charset="utf-8"><base target="_blank"><style>body{font:14px/1.6 system-ui,sans-serif;color:#1b2333;margin:0;padding:4px}img{max-width:100%}</style>${message.html}`,
    });
    bodyHost.append(frame);
  } else {
    bodyHost.append(el('pre', { class: 'mail-text' }, message.text || '(no content)'));
  }

  return el(
    'div',
    { class: 'card' },
    el(
      'div',
      { class: 'card-head' },
      el(
        'div',
        { class: 'grow' },
        el('h2', {}, message.subject),
        el(
          'p',
          {},
          `From ${describe(message.from)} · to ${describe(message.to)}`,
          message.date ? ` · ${formatDate(message.date, { withTime: true })}` : '',
        ),
      ),
      el('button', { class: 'btn sm', onclick: () => composeModal(base, mailbox, message) }, 'Reply'),
      el(
        'button',
        {
          class: 'btn sm danger',
          onclick: () =>
            confirmModal({
              title: 'Delete message',
              message: `Delete "${message.subject}"? It moves to Trash if the server has one.`,
              confirmLabel: 'Delete',
              onConfirm: async () => {
                const res = await api(`${base}/messages/${message.uid}?folder=${encodeURIComponent(folder)}`, {
                  method: 'DELETE',
                });
                toast(res.message, 'ok');
                onChanged();
              },
            }),
        },
        'Delete',
      ),
    ),
    message.attachments.length
      ? el(
          'div',
          { class: 'card-body', style: 'border-bottom:1px solid var(--border);padding-bottom:14px' },
          el('div', { class: 'small strong', style: 'margin-bottom:8px' }, `${message.attachments.length} attachment${message.attachments.length === 1 ? '' : 's'}`),
          el(
            'div',
            { style: 'display:flex;gap:8px;flex-wrap:wrap' },
            message.attachments.map((a) =>
              el(
                'a',
                {
                  class: 'btn sm',
                  href: `/api${base}/messages/${message.uid}/attachments/${a.index}?folder=${encodeURIComponent(folder)}`,
                },
                icon('file', 14),
                a.filename,
              ),
            ),
          ),
        )
      : null,
    bodyHost,
  );
}

/// Compose, or reply when a message is given.
function composeModal(base, mailbox, replyTo = null) {
  const to = el('input', {
    type: 'text',
    value: replyTo ? replyTo.from?.[0]?.address || '' : '',
    placeholder: 'someone@example.com, another@example.com',
  });
  const subject = el('input', {
    type: 'text',
    value: replyTo ? (/^re:/i.test(replyTo.subject) ? replyTo.subject : `Re: ${replyTo.subject}`) : '',
  });
  const body = el(
    'textarea',
    { class: 'mail-compose' },
    replyTo
      ? `\n\nOn ${replyTo.date ? formatDate(replyTo.date, { withTime: true }) : 'an earlier date'}, ${describe(replyTo.from)} wrote:\n> ${(replyTo.text || '').split('\n').join('\n> ')}`
      : '',
  );

  const alertHost = el('div');
  const send = el('button', { class: 'btn primary' }, 'Send');

  send.onclick = submitHandler(send, alertHost, async () => {
    const res = await api(`${base}/send`, {
      method: 'POST',
      body: {
        to: to.value,
        subject: subject.value,
        text: body.value,
        inReplyTo: replyTo?.messageId || undefined,
        references: replyTo?.messageId || undefined,
      },
    });
    toast(res.message, 'ok');
    if (res.rejected?.length) toast(`Rejected: ${res.rejected.join(', ')}`, 'error');
    close();
  });

  const close = openModal({
    title: replyTo ? 'Reply' : 'New message',
    wide: true,
    render: () =>
      el(
        'div',
        {},
        alertHost,
        el('p', { class: 'muted small', style: 'margin-top:0' }, `Sending as ${mailbox.address}`),
        field('To', to, 'Separate several addresses with commas.'),
        field('Subject', subject),
        body,
      ),
    footer: (closeFn) => [el('button', { class: 'btn', onclick: closeFn }, 'Cancel'), send],
  });
}

/// Saves or clears the mailbox password used to sign in to the mail server.
export function passwordModal(domainId, mailbox) {
  const base = `/domains/${domainId}/emails/${mailbox.id}/mail`;
  const password = el('input', { type: 'password', autocomplete: 'off' });
  const alertHost = el('div');
  const save = el('button', { class: 'btn primary' }, 'Save password');

  save.onclick = submitHandler(save, alertHost, async () => {
    await api(`${base}/password`, { method: 'PUT', body: { password: password.value } });

    // Check it before claiming success, so a typo is caught here rather than
    // on the first attempt to open the inbox.
    const test = await api(`${base}/test`, { method: 'POST' }).catch((err) => ({ ok: false, imap: { message: err.message } }));
    if (!test.ok) throw new Error(test.imap?.message || 'The mail server rejected that password.');

    toast('Mailbox password saved.', 'ok');
    close();
    window.location.reload();
  });

  const close = openModal({
    title: `Password for ${mailbox.address}`,
    render: () =>
      el(
        'div',
        {},
        alertHost,
        el(
          'p',
          { class: 'muted small', style: 'margin-top:0' },
          'This is the password for the mailbox itself, the one used to sign in to webmail. It is encrypted before being stored and is never sent back to this page.',
        ),
        field('Mailbox password', password),
      ),
    footer: (closeFn) => [
      el('button', { class: 'btn', onclick: closeFn }, 'Cancel'),
      el(
        'button',
        {
          class: 'btn danger',
          onclick: () =>
            confirmModal({
              title: 'Remove saved password',
              message: 'The inbox will close until a password is saved again. The mailbox itself is not changed.',
              confirmLabel: 'Remove',
              onConfirm: async () => {
                await api(`${base}/password`, { method: 'DELETE' });
                toast('Password removed.', 'ok');
                close();
                window.location.reload();
              },
            }),
        },
        'Remove',
      ),
      save,
    ],
  });
}
