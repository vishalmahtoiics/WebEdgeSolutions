// Composing: new messages, replies, and forwards.

import {
  api, el, clear, icon, toast, openModal, field, errorAlert, formatBytes, fullAddress,
} from './ui.js';

const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;

/// The `> quoted` body a reply starts with.
function quote(message) {
  const who = message.from?.[0];
  const when = message.date ? new Date(message.date).toLocaleString() : 'an earlier date';
  const body = (message.text || '')
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return `\n\nOn ${when}, ${fullAddress(who) || 'someone'} wrote:\n${body}\n`;
}

const withPrefix = (subject, prefix) =>
  new RegExp(`^${prefix}:`, 'i').test(subject || '') ? subject : `${prefix}: ${subject || '(no subject)'}`;

/// Everyone on the original except the mailbox doing the replying — nobody
/// wants a copy of their own reply.
function replyAllRecipients(message, self) {
  const mine = String(self).toLowerCase();
  const seen = new Set([mine]);
  const keep = [];
  for (const addr of [...(message.to || []), ...(message.cc || [])]) {
    const key = String(addr.address || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keep.push(addr.address);
  }
  return keep;
}

/// Builds the draft for each way of starting a message.
export function draftFor(kind, { message, self } = {}) {
  if (kind === 'reply') {
    return {
      to: message.from?.[0]?.address || '',
      cc: '',
      subject: withPrefix(message.subject, 'Re'),
      text: quote(message),
      inReplyTo: message.messageId || '',
      references: message.messageId || '',
    };
  }
  if (kind === 'replyAll') {
    return {
      to: message.from?.[0]?.address || '',
      cc: replyAllRecipients(message, self).join(', '),
      subject: withPrefix(message.subject, 'Re'),
      text: quote(message),
      inReplyTo: message.messageId || '',
      references: message.messageId || '',
    };
  }
  return { to: '', cc: '', subject: '', text: '', inReplyTo: '', references: '' };
}

/// The attachment picker: a button, a list of chips, and the running total.
function attachmentPicker(alertHost) {
  const files = [];
  const chips = el('div', { class: 'attachments', style: 'padding:0;border:0' });
  const input = el('input', { type: 'file', multiple: true, style: 'display:none' });

  const redraw = () => {
    clear(chips);
    for (const [index, file] of files.entries()) {
      chips.append(
        el(
          'span',
          { class: 'chip' },
          icon('clip', 13),
          `${file.name} · ${formatBytes(file.size)}`,
          el(
            'button',
            { type: 'button', 'aria-label': `Remove ${file.name}`, onclick: () => { files.splice(index, 1); redraw(); } },
            '×',
          ),
        ),
      );
    }
  };

  input.addEventListener('change', () => {
    clear(alertHost);
    for (const file of input.files) {
      if (files.length >= MAX_ATTACHMENTS) {
        alertHost.append(errorAlert(new Error(`You can attach up to ${MAX_ATTACHMENTS} files.`)));
        break;
      }
      // Rejecting an oversized file here saves the upload; the server enforces
      // the same limit regardless.
      if (file.size > MAX_ATTACHMENT_BYTES) {
        alertHost.append(errorAlert(new Error(`${file.name} is larger than ${formatBytes(MAX_ATTACHMENT_BYTES)}.`)));
        continue;
      }
      files.push(file);
    }
    input.value = '';
    redraw();
  });

  const button = el(
    'button',
    { type: 'button', class: 'btn sm', onclick: () => input.click() },
    icon('clip', 15),
    'Attach files',
  );

  return { files, node: el('div', {}, button, chips, input) };
}

/// The compose window. `kind` is 'new', 'reply' or 'replyAll'; `onSent` runs
/// after a successful send so the caller can refresh its view.
export function openCompose({ kind = 'new', message = null, self, onSent }) {
  const draft = draftFor(kind, { message, self });

  const to = el('input', { type: 'text', value: draft.to, placeholder: 'name@example.com, another@example.com' });
  const cc = el('input', { type: 'text', value: draft.cc, placeholder: 'Carbon copy' });
  const bcc = el('input', { type: 'text', placeholder: 'Blind carbon copy' });
  const subject = el('input', { type: 'text', value: draft.subject, placeholder: 'Subject' });
  const body = el('textarea', { class: 'compose-body', rows: 12, value: draft.text });
  const alertHost = el('div', {});
  const picker = attachmentPicker(alertHost);

  const ccField = field('Cc', cc);
  const bccField = field('Bcc', bcc);
  ccField.style.display = draft.cc ? '' : 'none';
  bccField.style.display = 'none';

  const toggle = (label, node) =>
    el(
      'button',
      {
        type: 'button',
        class: 'btn ghost sm',
        onclick: () => {
          node.style.display = node.style.display === 'none' ? '' : 'none';
          node.querySelector('input')?.focus();
        },
      },
      label,
    );

  openModal({
    title: kind === 'new' ? 'New message' : 'Reply',
    wide: true,
    render: () =>
      el(
        'form',
        { onsubmit: (e) => e.preventDefault() },
        alertHost,
        el(
          'div',
          { style: 'display:flex;gap:6px;justify-content:flex-end;margin-bottom:-8px' },
          toggle('Cc', ccField),
          toggle('Bcc', bccField),
        ),
        field('To', to),
        ccField,
        bccField,
        field('Subject', subject),
        field('Message', body),
        picker.node,
      ),
    footer: (close) => {
      const send = el('button', { class: 'btn primary' }, icon('send', 15), 'Send');

      send.addEventListener('click', async () => {
        clear(alertHost);
        if (!to.value.trim()) {
          alertHost.append(errorAlert(new Error('Enter at least one recipient.')));
          return;
        }

        send.disabled = true;
        clear(send).append(el('span', { class: 'spinner' }), 'Sending…');

        const form = new FormData();
        form.append('to', to.value);
        form.append('cc', cc.value);
        form.append('bcc', bcc.value);
        form.append('subject', subject.value);
        form.append('text', body.value);
        if (draft.inReplyTo) form.append('inReplyTo', draft.inReplyTo);
        if (draft.references) form.append('references', draft.references);
        for (const file of picker.files) form.append('attachments', file, file.name);

        try {
          const result = await api('/send', { method: 'POST', formData: form });
          close();
          toast(result.message || 'Message sent.', 'ok');
          if (result.rejected?.length) {
            toast(`Not delivered to: ${result.rejected.join(', ')}`, 'error');
          }
          if (result.filedToSent === false) {
            // The message left; only the copy failed. Say so rather than
            // letting it look like nothing happened.
            toast('Sent, but a copy could not be saved to Sent.', '');
          }
          onSent?.(result);
        } catch (err) {
          alertHost.append(errorAlert(err));
          send.disabled = false;
          clear(send).append(icon('send', 15), 'Send');
        }
      });

      return [el('button', { class: 'btn', onclick: close }, 'Discard'), send];
    },
  });
}

/// Forwarding goes through its own endpoint: the original travels intact as an
/// attachment, so nothing — formatting or attachments — is lost in the retelling.
export function openForward({ message, folder, onSent }) {
  const to = el('input', { type: 'text', placeholder: 'name@example.com' });
  const note = el('textarea', { class: 'compose-body', rows: 8, placeholder: 'Add a note (optional)' });
  const alertHost = el('div', {});

  openModal({
    title: 'Forward message',
    wide: true,
    render: () =>
      el(
        'form',
        { onsubmit: (e) => e.preventDefault() },
        alertHost,
        el(
          'div',
          { class: 'alert info' },
          `Forwarding “${message.subject}”. The original message travels along as an attachment, so nothing is lost.`,
        ),
        field('To', to),
        field('Note', note),
      ),
    footer: (close) => {
      const send = el('button', { class: 'btn primary' }, icon('forward', 15), 'Forward');
      send.addEventListener('click', async () => {
        clear(alertHost);
        if (!to.value.trim()) {
          alertHost.append(errorAlert(new Error('Enter at least one recipient.')));
          return;
        }
        send.disabled = true;
        clear(send).append(el('span', { class: 'spinner' }), 'Forwarding…');
        try {
          const result = await api(`/messages/${message.uid}/forward`, {
            method: 'POST',
            body: { to: to.value, text: note.value, folder },
          });
          close();
          toast(result.message || 'Message forwarded.', 'ok');
          onSent?.(result);
        } catch (err) {
          alertHost.append(errorAlert(err));
          send.disabled = false;
          clear(send).append(icon('forward', 15), 'Forward');
        }
      });
      return [el('button', { class: 'btn', onclick: close }, 'Cancel'), send];
    },
  });
}
