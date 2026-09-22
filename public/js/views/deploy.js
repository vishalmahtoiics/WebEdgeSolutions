// Deploying a website.
//
// The page is built around one idea: you see what will happen before it
// happens. Preview reads the archive and the server and reports the plan;
// nothing is written until the second button. That is why the deploy button
// stays disabled until a preview has been run — not to be awkward, but
// because "this will delete 412 files" is only useful before the event.
//
// It also says plainly what this does not do: it uploads files, it does not
// run a build. Somebody arriving expecting `npm run build` should find that
// out here rather than from a site that deploys to a blank page.

import {
  api, el, clear, fill, appendAll, field, toast, errorAlert, emptyState,
  formatDate, relativeTime, confirmModal,
} from '../core.js';
import { icon } from '../icons.js';
import { refresh } from '../app.js';

const STATUS_TONE = {
  RUNNING: 'accent',
  SUCCEEDED: 'ok',
  FAILED: 'danger',
  ROLLED_BACK: 'warn',
};

const kb = (bytes) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export function deployPanel(domain) {
  const host = el('div');
  load();
  return host;

  async function load() {
    fill(host, el('div', { class: 'card' }, el('div', { class: 'card-body' },
      el('div', { class: 'skeleton line mid' }),
      el('div', { class: 'skeleton line' }),
    )));

    try {
      const data = await api(`/domains/${domain.id}/deployments`);
      fill(host, deployCard(domain, data, load), historyCard(domain, data, load));
    } catch (err) {
      fill(host, el('div', { class: 'card' }, el('div', { class: 'card-body' }, errorAlert(err))));
    }
  }
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

function deployCard(domain, data, reload) {
  // --- Source -------------------------------------------------------------
  let mode = 'zip';
  let chosenFile = null;

  const fileInput = el('input', { type: 'file', accept: '.zip,application/zip', style: 'display:none' });
  const fileLabel = el('div', { class: 'muted small' }, 'No file chosen yet.');
  const pickButton = el('button', { class: 'btn', type: 'button' }, icon('folder', 16), 'Choose a .zip file');

  pickButton.onclick = () => fileInput.click();
  fileInput.onchange = () => {
    chosenFile = fileInput.files?.[0] || null;
    fill(
      fileLabel,
      chosenFile
        ? el('span', {}, el('span', { class: 'strong' }, chosenFile.name), ` — ${kb(chosenFile.size)}`)
        : 'No file chosen yet.',
    );
    invalidate();
  };

  const gitUrl = el('input', { type: 'text', placeholder: 'https://github.com/you/your-site' });
  const gitRef = el('input', { type: 'text', placeholder: 'main' });

  const zipPane = el(
    'div',
    {},
    el('div', { class: 'row', style: 'margin-bottom:10px' }, pickButton, fileInput),
    fileLabel,
    el(
      'p',
      { class: 'hint', style: 'margin-top:10px' },
      `Up to ${data.limits.maxArchiveMb} MB compressed, ${data.limits.maxUnpackedMb} MB unpacked, ` +
        `${data.limits.maxFiles.toLocaleString('en-IN')} files. If everything inside the zip sits in one ` +
        'folder — the way GitHub’s “Download ZIP” gives it to you — that folder is unwrapped for you.',
    ),
  );

  const gitPane = el(
    'div',
    { style: 'display:none' },
    field('Repository URL', gitUrl, 'Public repositories only, over https.'),
    field('Branch or tag', gitRef, 'Leave blank for the default branch.'),
  );

  const tabs = el(
    'div',
    { class: 'tabs', style: 'margin-bottom:16px' },
    ...[
      ['zip', 'Upload a .zip'],
      ['git', 'From a repository'],
    ].map(([key, label]) =>
      el(
        'button',
        {
          class: `tab ${key === 'zip' ? 'active' : ''}`,
          dataset: { key },
          onclick: (e) => {
            mode = key;
            tabs.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.key === key));
            zipPane.style.display = key === 'zip' ? '' : 'none';
            gitPane.style.display = key === 'git' ? '' : 'none';
            invalidate();
          },
        },
        label,
      ),
    ),
  );

  // --- Where and how ------------------------------------------------------
  const targetPath = el('input', { type: 'text', value: '/', placeholder: '/' });
  const deleteMissing = el('input', { type: 'checkbox' });
  const keep = el('input', { type: 'text', placeholder: 'uploads, wp-content' });
  const force = el('input', { type: 'checkbox' });
  const confirmDestructive = el('input', { type: 'checkbox' });

  const keepField = field(
    'Never delete these',
    keep,
    'Comma separated. Folders a customer writes to — uploads, cache — that are not in your source.',
  );
  keepField.style.display = 'none';

  const destructiveNote = el(
    'div',
    { class: 'alert warn', style: 'display:none' },
    el('span', { class: 'strong' }, 'This will delete files. '),
    'Anything on the server that is not in your source is removed, apart from the paths you keep. ' +
      'The preview lists exactly what would go, and everything removed is set aside so it can be put back.',
  );

  deleteMissing.onchange = () => {
    keepField.style.display = deleteMissing.checked ? '' : 'none';
    destructiveNote.style.display = deleteMissing.checked ? '' : 'none';
    invalidate();
  };
  [targetPath, gitUrl, gitRef, keep].forEach((i) => (i.oninput = invalidate));
  force.onchange = invalidate;

  // --- Actions ------------------------------------------------------------
  const alertHost = el('div');
  const result = el('div');
  const previewBtn = el('button', { class: 'btn' }, icon('search', 16), 'Preview');
  const deployBtn = el('button', { class: 'btn primary', disabled: true }, icon('bolt', 16), 'Deploy');

  /// Any change to the form invalidates the preview it was based on. A
  /// deploy button still lit from the previous settings is how somebody
  /// ships the thing they had just decided against.
  function invalidate() {
    deployBtn.disabled = true;
    clear(result);
  }

  const body = () => {
    const form = new FormData();
    if (mode === 'zip') {
      if (!chosenFile) throw new Error('Choose a .zip file first.');
      form.append('archive', chosenFile, chosenFile.name);
    } else {
      if (!gitUrl.value.trim()) throw new Error('Paste the repository URL first.');
      form.append('gitUrl', gitUrl.value.trim());
      if (gitRef.value.trim()) form.append('gitRef', gitRef.value.trim());
    }
    form.append('targetPath', targetPath.value.trim() || '/');
    form.append('deleteMissing', String(deleteMissing.checked));
    form.append('force', String(force.checked));
    if (deleteMissing.checked && keep.value.trim()) form.append('keep', keep.value.trim());
    if (confirmDestructive.checked) form.append('confirmDestructive', 'true');
    return form;
  };

  const send = async (path, form) => {
    const res = await fetch(`/api/domains/${domain.id}/deployments${path}`, { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'That did not work.'), { status: res.status, details: data.details });
    return data;
  };

  const busy = (button, on, label) => {
    button.disabled = on;
    button.classList.toggle('is-busy', on);
    if (!on && label) fill(button, ...label);
  };

  previewBtn.onclick = async () => {
    clear(alertHost);
    clear(result);
    let form;
    try {
      form = body();
    } catch (err) {
      return alertHost.append(el('div', { class: 'alert error' }, err.message));
    }

    busy(previewBtn, true);
    try {
      const preview = await send('/preview', form);
      fill(result, previewResult(preview, confirmDestructive));
      // Only a preview that the server was willing to run unlocks the deploy.
      deployBtn.disabled = !preview.ok || preview.isNoOp;
    } catch (err) {
      alertHost.append(errorAlert(err));
    } finally {
      busy(previewBtn, false, [icon('search', 16), 'Preview']);
    }
  };

  deployBtn.onclick = async () => {
    clear(alertHost);
    let form;
    try {
      form = body();
    } catch (err) {
      return alertHost.append(el('div', { class: 'alert error' }, err.message));
    }

    busy(deployBtn, true);
    try {
      const res = await send('', form);
      toast(res.message, 'ok');
      reload();
    } catch (err) {
      alertHost.append(errorAlert(err));
      busy(deployBtn, false, [icon('bolt', 16), 'Deploy']);
    }
  };

  return el(
    'div',
    { class: 'card' },
    el(
      'div',
      { class: 'card-head' },
      el(
        'div',
        { class: 'grow' },
        el('h2', {}, 'Deploy a website'),
        el('p', {}, `Uploads files into ${domain.name}’s web root over your stored FTP connection.`),
      ),
    ),
    el(
      'div',
      { class: 'card-body' },
      alertHost,

      // Said once, near the top, because it is the thing most likely to
      // surprise somebody arriving from a host that does build for them.
      el(
        'div',
        { class: 'alert info' },
        el('span', { class: 'strong' }, 'Files are uploaded, nothing is run. '),
        'No build step, no install, no scripts from the repository. Deploy a finished site — plain HTML, ' +
          'PHP, WordPress, or the contents of your ',
        el('span', { class: 'mono' }, 'dist'),
        ' / ',
        el('span', { class: 'mono' }, 'build'),
        ' folder after you have built it on your own machine.',
      ),

      tabs,
      zipPane,
      gitPane,

      el('hr', { class: 'hr' }),

      el(
        'div',
        { class: 'grid-2' },
        el(
          'div',
          {},
          field('Deploy into', targetPath, 'Relative to the FTP root. “/” is the web root itself.'),
          el(
            'label',
            { class: 'check', style: 'align-items:flex-start;margin-bottom:12px' },
            deleteMissing,
            el(
              'span',
              {},
              el('span', { class: 'strong' }, 'Replace the site'),
              el('div', { class: 'small muted' }, 'Delete files on the server that are not in the source.'),
            ),
          ),
          keepField,
        ),
        el(
          'div',
          {},
          el(
            'label',
            { class: 'check', style: 'align-items:flex-start;margin-bottom:12px' },
            force,
            el(
              'span',
              {},
              el('span', { class: 'strong' }, 'Upload everything again'),
              el(
                'div',
                { class: 'small muted' },
                'By default a file that has not changed since the last deploy is skipped. Tick this if ' +
                  'something was edited on the server directly.',
              ),
            ),
          ),
          el(
            'p',
            { class: 'hint' },
            'Left out of every deploy: ',
            el('span', { class: 'mono' }, data.excluded.slice(0, 6).join(', ')),
            ` and ${Math.max(0, data.excluded.length - 6)} more. A .env in a web root is served as plain text.`,
          ),
        ),
      ),

      destructiveNote,
      el('div', { class: 'row', style: 'margin-top:6px' }, previewBtn, deployBtn),
      result,
    ),
  );
}

// ---------------------------------------------------------------------------
// The preview
// ---------------------------------------------------------------------------

function previewResult(preview, confirmDestructive) {
  if (!preview.ok) {
    return el(
      'div',
      { style: 'margin-top:16px' },
      el('div', { class: 'alert warn' }, el('span', { class: 'strong' }, 'Refused. '), preview.refusal),
      el('div', { class: 'small muted' }, preview.summary),
      el(
        'label',
        { class: 'check', style: 'margin-top:12px' },
        confirmDestructive,
        el('span', {}, 'I know what this will do. Preview it again.'),
      ),
    );
  }

  const counts = preview.counts;
  const tile = (label, value, tone) =>
    el(
      'div',
      { class: 'stat', style: 'min-height:0;padding:13px 15px' },
      el('div', { class: 'label' }, label),
      el('div', { class: `value ${tone || ''}`, style: 'font-size:23px' }, String(value)),
    );

  const sampleList = (title, paths, total, tone) =>
    !paths.length
      ? null
      : el(
          'details',
          { style: 'margin-top:10px' },
          el(
            'summary',
            { class: 'small', style: 'cursor:pointer' },
            el('span', { class: `badge ${tone}` }, String(total)),
            ` ${title}`,
          ),
          el(
            'div',
            { class: 'mono small muted', style: 'margin-top:8px;max-height:220px;overflow:auto;line-height:1.7' },
            ...paths.map((p) => el('div', {}, p)),
            total > paths.length ? el('div', { class: 'muted' }, `…and ${total - paths.length} more`) : null,
          ),
        );

  return el(
    'div',
    { style: 'margin-top:18px' },
    el('h3', { class: 'doc-section' }, 'What this will do'),

    preview.isNoOp
      ? el(
          'div',
          { class: 'alert ok' },
          'Everything on the server already matches the source. There is nothing to deploy.',
        )
      : null,

    el(
      'div',
      { class: 'stat-grid', style: 'margin-bottom:6px' },
      tile('New files', counts.create),
      tile('Changed', counts.update),
      tile('Deleted', counts.remove),
      tile('Unchanged', counts.unchanged),
    ),

    el(
      'p',
      { class: 'small muted' },
      `${counts.inSource} file(s) in the source, ${counts.onServer} on the server. `,
      preview.bytes ? `About ${kb(preview.bytes)} to upload. ` : '',
      preview.usedManifestFrom
        ? `Unchanged files were matched against deploy #${preview.usedManifestFrom}.`
        : 'No previous deploy to compare against, so everything is sent.',
    ),

    preview.strippedFolder
      ? el(
          'div',
          { class: 'alert info' },
          'Everything sat inside ',
          el('span', { class: 'mono' }, preview.strippedFolder),
          ', so that folder was unwrapped — your site will be at the root, not under it.',
        )
      : null,

    preview.protectedFromDelete.length
      ? el(
          'div',
          { class: 'alert ok' },
          el('span', { class: 'strong' }, `${preview.protectedFromDelete.length} file(s) kept. `),
          'Matched one of the paths you asked to keep, so they are not deleted.',
        )
      : null,

    preview.skipped.length
      ? el(
          'p',
          { class: 'small muted' },
          `${preview.skipped.length} file(s) left out of the source: `,
          el('span', { class: 'mono' }, preview.skipped.slice(0, 5).join(', ')),
          preview.skipped.length > 5 ? '…' : '',
        )
      : null,

    sampleList('to be added', preview.sample.create, counts.create, 'ok'),
    sampleList('to be changed', preview.sample.update, counts.update, 'accent'),
    sampleList('to be deleted', preview.sample.remove, counts.remove, 'danger'),
  );
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function historyCard(domain, data, reload) {
  const body = el('div', { class: 'card-body tight table-scroll' });

  if (!data.deployments.length) {
    fill(
      body,
      el(
        'div',
        { style: 'padding:24px' },
        emptyState('bolt', 'Nothing deployed yet', 'Every deploy will be listed here, with a way to undo it.'),
      ),
    );
  } else {
    fill(
      body,
      el(
        'table',
        {},
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            el('th', {}, '#'),
            el('th', {}, 'From'),
            el('th', {}, 'Changes'),
            el('th', {}, 'When'),
            el('th', {}, 'Status'),
            el('th', {}, ''),
          ),
        ),
        el('tbody', {}, data.deployments.map((d) => row(domain, d, reload))),
      ),
    );
  }

  return el(
    'div',
    { class: 'card', style: 'margin-top:18px' },
    el(
      'div',
      { class: 'card-head' },
      el(
        'div',
        { class: 'grow' },
        el('h2', {}, 'Deploy history'),
        el(
          'p',
          {},
          'Replaced files are set aside in ',
          el('span', { class: 'mono' }, data.backupDir),
          ', so a deploy can be undone. The last few are kept.',
        ),
      ),
    ),
    body,
  );
}

function row(domain, d, reload) {
  const source =
    d.source === 'GIT'
      ? el(
          'div',
          {},
          el('span', { class: 'small strong break' }, shortRepo(d.gitUrl)),
          el(
            'div',
            { class: 'small muted mono' },
            [d.gitRef, d.gitCommit].filter(Boolean).join(' @ ') || '—',
          ),
        )
      : el(
          'div',
          {},
          el('span', { class: 'small strong break' }, d.archiveName || 'archive'),
          el('div', { class: 'small muted' }, 'uploaded'),
        );

  const changes = el(
    'div',
    { class: 'small' },
    el('span', {}, `${d.filesCreated} new, ${d.filesUpdated} changed`),
    d.filesDeleted ? el('div', { class: 'small', style: 'color:var(--danger)' }, `${d.filesDeleted} deleted`) : null,
    d.targetPath && d.targetPath !== '/' ? el('div', { class: 'small muted mono' }, `into ${d.targetPath}`) : null,
  );

  const canRollback = d.status === 'SUCCEEDED' && Boolean(d.backupPath);
  const undo = el('button', { class: 'btn sm' }, 'Roll back');
  undo.onclick = () =>
    confirmModal({
      title: `Roll back deploy #${d.number}?`,
      message:
        `The ${d.filesCreated} file(s) this deploy added will be removed, and the ${d.filesUpdated + d.filesDeleted} ` +
        'it replaced will be put back exactly as they were. The live site changes immediately.',
      confirmLabel: 'Roll it back',
      onConfirm: async () => {
        const res = await api(`/domains/${domain.id}/deployments/${d.id}/rollback`, { method: 'POST' });
        toast(res.message, res.problems?.length ? 'error' : 'ok');
        reload();
      },
    });

  return el(
    'tr',
    {},
    el('td', { class: 'mono small muted' }, `#${d.number}`),
    el('td', {}, source),
    el('td', {}, changes),
    el(
      'td',
      { class: 'small muted nowrap', title: formatDate(d.startedAt, { withTime: true }) },
      relativeTime(d.startedAt),
      d.durationMs ? el('div', { class: 'small muted' }, `${(d.durationMs / 1000).toFixed(1)}s`) : null,
    ),
    el(
      'td',
      {},
      el('span', { class: `badge ${STATUS_TONE[d.status] || ''}` }, d.status.replace('_', ' ').toLowerCase()),
      d.error ? el('div', { class: 'small', style: 'color:var(--danger);margin-top:4px', title: d.error }, truncate(d.error)) : null,
      d.actorLabel ? el('div', { class: 'small muted' }, d.actorLabel.split('<')[0].trim()) : null,
    ),
    el(
      'td',
      { class: 'right' },
      canRollback
        ? undo
        : el(
            'span',
            { class: 'small muted', title: d.backupPath ? '' : 'The backup for this deploy has been pruned.' },
            d.status === 'ROLLED_BACK' ? 'undone' : '—',
          ),
    ),
  );
}

const shortRepo = (url) => String(url || '').replace(/^https:\/\/(www\.)?/, '').replace(/\.git$/, '');
const truncate = (text) => (text.length > 60 ? `${text.slice(0, 60)}…` : text);
