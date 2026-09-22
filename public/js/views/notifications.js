// Where change alerts are sent, and what has changed lately. Super Admin only.
//
// Two halves, and the second is the point of the first: the activity feed is
// the record, and email is one way of reading it. So the feed works whether or
// not any mail server is configured, and it says plainly when an alert was
// meant to go out and did not.

import {
  api, el, clear, fill, appendAll, field, submitHandler, toast, errorAlert,
  emptyState, relativeTime, formatDate,
} from '../core.js';
import { icon } from '../icons.js';
import { refresh } from '../app.js';

/// The areas, in the order they are worth being told about.
const AREAS = [
  ['notifyDns', 'DNS changes', 'A record added, changed or deleted in a live zone.'],
  ['notifyEmailMgmt', 'Mailboxes', 'A mailbox created, deleted, or its password changed.'],
  ['notifyFiles', 'File deletions', 'A file or folder deleted through the file manager.'],
  ['notifyDatabase', 'Database', 'A DROP, TRUNCATE or other statement that changes structure.'],
  ['notifyUsers', 'Accounts', 'A portal account created or deleted.'],
  ['notifySettings', 'Settings', 'Connection details or these notification settings changed.'],
  ['notifyOrders', 'Orders', 'A new order from the public site, or a payment reported.'],
  ['notifySecurity', 'Sign-in failures', 'Somebody trying passwords against your portal, or a wrong two-factor code.'],
  ['notifySupport', 'Support tickets', 'A customer opening a ticket or replying to one.'],
  ['notifyBilling', 'Invoices', 'An invoice or quotation raised, or a payment recorded.'],
  ['notifySchedule', 'Overnight jobs', 'A domain about to expire, or a nightly sync that failed.'],
];

const EVENT_TONE = (event) => {
  if (event.startsWith('security')) return 'danger';
  if (/(deleted|destroyed|destructive)/.test(event)) return 'danger';
  if (event.startsWith('order') || event.startsWith('billing')) return 'ok';
  if (event.startsWith('schedule')) return 'warn';
  return 'accent';
};

export async function renderNotifications() {
  const [{ settings }, feed, jobsResult] = await Promise.all([
    api('/settings'),
    api('/settings/activity?take=60').catch(() => ({ entries: [], total: 0, undelivered: 0 })),
    api('/settings/jobs').catch(() => ({ jobs: [] })),
  ]);

  const frag = el('div');
  appendAll(frag, [
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        { class: 'grow' },
        el('h1', {}, 'Alerts & Activity'),
        el('p', {}, 'Be told by email when somebody changes something, and see everything that has changed.'),
      ),
    ),
    feed.undelivered
      ? el(
          'div',
          { class: 'alert warn' },
          el('span', { class: 'strong' }, `${feed.undelivered} alert${feed.undelivered === 1 ? '' : 's'} could not be sent. `),
          'The change is still recorded below — check the SMTP settings and send a test.',
        )
      : null,
    settingsCard(settings),
    scheduleCard(settings, jobsResult.jobs),
    activityCard(feed),
  ]);
  return frag;
}

// ---------------------------------------------------------------------------
// Work that happens on its own
// ---------------------------------------------------------------------------

/// The nightly jobs, and whether last night actually happened.
///
/// The last result is the point of this card. "Auto-sync: on" tells you
/// nothing — a switch that has been on for a month while every run failed
/// looks exactly the same as one that is working.
function scheduleCard(settings, jobs) {
  const jobsEnabled = el('input', { type: 'checkbox', checked: Boolean(settings.jobsEnabled) });
  const autoSync = el('input', { type: 'checkbox', checked: settings.autoSyncEnabled !== false });
  const expiryOn = el('input', { type: 'checkbox', checked: settings.expiryRemindersEnabled !== false });
  const remindCustomer = el('input', { type: 'checkbox', checked: Boolean(settings.expiryRemindCustomer) });

  const hour = el(
    'select',
    { style: 'max-width:130px' },
    ...Array.from({ length: 24 }, (_, h) =>
      el('option', { value: String(h), selected: (settings.jobHour ?? 2) === h }, `${String(h).padStart(2, '0')}:00`),
    ),
  );

  // A short list rather than every zone in the world: this portal is written
  // for India, and the others are here so a container elsewhere still works.
  const ZONES = [
    [330, 'India (IST, UTC+5:30)'],
    [0, 'UTC'],
    [240, 'Gulf (UTC+4)'],
    [60, 'Central Europe (UTC+1)'],
    [-300, 'US Eastern (UTC−5)'],
    [480, 'Singapore (UTC+8)'],
  ];
  const zone = el(
    'select',
    { style: 'max-width:230px' },
    ...ZONES.map(([offset, label]) =>
      el('option', { value: String(offset), selected: (settings.jobTimezoneOffset ?? 330) === offset }, label),
    ),
  );

  const ladder = el('input', {
    type: 'text',
    value: settings.expiryReminderDays || '30,15,7,1',
    placeholder: '30,15,7,1',
  });

  const alertHost = el('div');
  const save = el('button', { class: 'btn primary' }, 'Save schedule');

  save.onclick = submitHandler(save, alertHost, async () => {
    await api('/settings', {
      method: 'PUT',
      body: {
        jobsEnabled: jobsEnabled.checked,
        jobHour: Number(hour.value),
        jobTimezoneOffset: Number(zone.value),
        autoSyncEnabled: autoSync.checked,
        expiryRemindersEnabled: expiryOn.checked,
        expiryRemindCustomer: remindCustomer.checked,
        expiryReminderDays: ladder.value.trim(),
      },
    });
    toast('Schedule saved.', 'ok');
    refresh();
  });

  return el(
    'div',
    { class: 'card', style: 'margin-top:18px' },
    el(
      'div',
      { class: 'card-head' },
      el(
        'div',
        { class: 'grow' },
        el('h2', {}, 'Overnight jobs'),
        el('p', {}, 'Sync your providers and warn about expiring domains, without anyone pressing anything.'),
      ),
      el('span', { class: `badge ${settings.jobsEnabled ? 'ok' : ''}` }, settings.jobsEnabled ? 'On' : 'Off'),
    ),
    el(
      'div',
      { class: 'card-body' },
      alertHost,
      el(
        'label',
        { class: 'check', style: 'margin-bottom:14px' },
        jobsEnabled,
        el(
          'span',
          {},
          el('span', { class: 'strong' }, 'Run jobs automatically'),
          el('div', { class: 'small muted' }, 'The master switch. Everything below is off while this is.'),
        ),
      ),
      el('div', { class: 'form-row' }, field('Run at', hour), field('In this timezone', zone)),
      el(
        'p',
        { class: 'hint', style: 'margin:-6px 0 18px' },
        'A machine that was switched off at that hour catches up when it comes back, rather than skipping ' +
          'a day quietly.',
      ),

      el('hr', { style: 'border:0;border-top:1px solid var(--border);margin:6px 0 18px' }),

      el(
        'div',
        { class: 'grid-2' },
        el(
          'div',
          {},
          el(
            'label',
            { class: 'check', style: 'align-items:flex-start;margin-bottom:10px' },
            autoSync,
            el(
              'span',
              {},
              el('span', { class: 'strong' }, 'Nightly sync'),
              el('div', { class: 'small muted' }, 'Pull every provider\u2019s domains, DNS and mailboxes overnight.'),
            ),
          ),
        ),
        el(
          'div',
          {},
          el(
            'label',
            { class: 'check', style: 'align-items:flex-start;margin-bottom:10px' },
            expiryOn,
            el(
              'span',
              {},
              el('span', { class: 'strong' }, 'Domain expiry reminders'),
              el('div', { class: 'small muted' }, 'Warn before a domain lapses and the site goes dark.'),
            ),
          ),
          field('Warn this many days ahead', ladder, 'One email per step, and renewing resets them all.'),
          el(
            'label',
            { class: 'check', style: 'align-items:flex-start' },
            remindCustomer,
            el(
              'span',
              {},
              el('span', { class: 'strong' }, 'Tell the customer too'),
              el('div', { class: 'small muted' }, 'Emails whoever the domain is assigned to, as well as you.'),
            ),
          ),
        ),
      ),

      el('div', { style: 'margin-top:16px' }, save),

      jobs?.length
        ? el(
            'div',
            { style: 'margin-top:22px' },
            el('h3', { style: 'font-size:15px;margin-bottom:10px' }, 'Last run'),
            el(
              'table',
              { style: 'width:100%' },
              el(
                'thead',
                {},
                el('tr', {}, el('th', {}, 'Job'), el('th', {}, 'Last run'), el('th', {}, 'Result'), el('th', {}, 'Next'), el('th', {}, '')),
              ),
              el(
                'tbody',
                {},
                jobs.map((job) => jobRow(job)),
              ),
            ),
          )
        : null,
    ),
  );
}

function jobRow(job) {
  const run = el('button', { class: 'btn sm' }, 'Run now');
  const alertHost = el('div');

  run.onclick = submitHandler(run, alertHost, async () => {
    const res = await api(`/settings/jobs/${job.id}/run`, { method: 'POST' });
    toast(res.message, res.ok ? 'ok' : 'error');
    refresh();
  });

  return el(
    'tr',
    {},
    el('td', {}, el('span', { class: 'strong small' }, job.label), job.running ? el('div', { class: 'badge accent' }, 'running') : null),
    el(
      'td',
      { class: 'small muted nowrap' },
      job.lastRunAt ? relativeTime(job.lastRunAt) : el('span', { class: 'muted' }, 'never'),
    ),
    el(
      'td',
      { class: 'small' },
      job.lastRunAt
        ? el(
            'span',
            {},
            el('span', { class: `badge ${job.lastOk ? 'ok' : 'warn'}` }, job.lastOk ? 'ok' : 'failed'),
            el('div', { class: 'small muted' }, job.lastMessage || ''),
          )
        : el('span', { class: 'muted' }, '\u2014'),
    ),
    el(
      'td',
      { class: 'small muted nowrap' },
      job.enabled && job.nextRunAt ? formatDate(job.nextRunAt, { withTime: true }) : el('span', { class: 'muted' }, 'off'),
    ),
    el('td', { class: 'right' }, run, alertHost),
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function settingsCard(settings) {
  const inputs = {
    smtpHost: el('input', { type: 'text', value: settings.smtpHost || '', placeholder: 'smtp.yourprovider.com' }),
    smtpPort: el('input', { type: 'number', value: settings.smtpPort ?? '', placeholder: '465' }),
    smtpUser: el('input', { type: 'text', value: settings.smtpUser || '', placeholder: 'alerts@yourdomain.com' }),
    smtpPassword: el('input', {
      type: 'password',
      autocomplete: 'off',
      placeholder: settings.hasSmtpPassword ? 'Saved — leave blank to keep it' : '',
    }),
    fromAddress: el('input', { type: 'text', value: settings.fromAddress || '', placeholder: 'alerts@yourdomain.com' }),
    fromName: el('input', { type: 'text', value: settings.fromName || '', placeholder: 'Hosting Portal' }),
    notifyEmails: el('input', {
      type: 'text',
      value: settings.notifyEmails || '',
      placeholder: 'you@yourdomain.com, partner@yourdomain.com',
    }),
  };

  const smtpSecure = el('input', { type: 'checkbox', checked: settings.smtpSecure !== false });
  const notifyEnabled = el('input', { type: 'checkbox', checked: Boolean(settings.notifyEnabled) });
  const areaBoxes = Object.fromEntries(
    AREAS.map(([key]) => [key, el('input', { type: 'checkbox', checked: settings[key] !== false })]),
  );

  const alertHost = el('div');
  const save = el('button', { class: 'btn primary' }, 'Save alert settings');
  const test = el('button', { class: 'btn' }, icon('mail', 16), 'Send a test email');

  const body = () => ({
    ...Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value.trim()])),
    smtpPort: inputs.smtpPort.value === '' ? null : Number(inputs.smtpPort.value),
    smtpSecure: smtpSecure.checked,
    notifyEnabled: notifyEnabled.checked,
    ...Object.fromEntries(Object.entries(areaBoxes).map(([k, box]) => [k, box.checked])),
  });

  save.onclick = submitHandler(save, alertHost, async () => {
    const res = await api('/settings', { method: 'PUT', body: body() });
    toast(res.message, 'ok');
    refresh();
  });

  test.onclick = submitHandler(test, alertHost, async () => {
    // Saved first, so the test uses what is on screen rather than what was
    // there before — otherwise a fix looks like it did not work.
    await api('/settings', { method: 'PUT', body: body() });
    const res = await api('/settings/test-email', { method: 'POST' });
    toast(res.message, 'ok');
    alertHost.append(
      el('div', { class: 'alert ok' }, `${res.message} If it does not arrive, check the spam folder.`),
    );
    test.disabled = false;
    clear(test).append(icon('mail', 16), 'Send a test email');
  });

  return el(
    'div',
    { class: 'card' },
    el(
      'div',
      { class: 'card-head' },
      el(
        'div',
        { class: 'grow' },
        el('h2', {}, 'Email alerts'),
        el('p', {}, 'The portal sends through your own SMTP server. This is separate from any domain’s mail settings.'),
      ),
      el('span', { class: `badge ${settings.notifyEnabled ? 'ok' : ''}` }, settings.notifyEnabled ? 'On' : 'Off'),
    ),
    el(
      'div',
      { class: 'card-body' },
      alertHost,
      el(
        'div',
        { class: 'grid-2' },
        el(
          'div',
          {},
          el('h3', { style: 'font-size:15px;margin-bottom:12px' }, 'Your mail server'),
          el('div', { class: 'form-row' }, field('SMTP host', inputs.smtpHost), field('Port', inputs.smtpPort)),
          el(
            'label',
            { class: 'check', style: 'margin:-6px 0 14px' },
            smtpSecure,
            el('span', {}, 'Encrypted connection'),
          ),
          el(
            'p',
            { class: 'hint', style: 'margin:-8px 0 14px' },
            'Port 465 with encryption on, or 587 with it off, covers almost every provider.',
          ),
          field('Username', inputs.smtpUser),
          field(
            'Password',
            inputs.smtpPassword,
            settings.hasSmtpPassword ? 'A password is already saved. Type a new one only to replace it.' : null,
          ),
        ),
        el(
          'div',
          {},
          el('h3', { style: 'font-size:15px;margin-bottom:12px' }, 'Who hears about it'),
          field('Send alerts to', inputs.notifyEmails, 'Separate several addresses with commas.'),
          field('From address', inputs.fromAddress, 'Usually the same as the username.'),
          field('From name', inputs.fromName),
          el(
            'label',
            { class: 'check', style: 'margin-top:4px' },
            notifyEnabled,
            el('span', { class: 'strong' }, 'Send alerts when something changes'),
          ),
          el('div', { style: 'margin-top:16px;display:flex;gap:9px;flex-wrap:wrap' }, save, test),
        ),
      ),
      el('hr', { style: 'border:0;border-top:1px solid var(--border);margin:22px 0' }),
      el('h3', { style: 'font-size:15px;margin-bottom:6px' }, 'What to be told about'),
      el(
        'p',
        { class: 'hint', style: 'margin:0 0 14px' },
        'Switch off anything that turns out to be noise. Everything stays in the activity log either way.',
      ),
      el(
        'div',
        { class: 'grid-2' },
        AREAS.map(([key, label, description]) =>
          el(
            'label',
            { class: 'check', style: 'align-items:flex-start;margin-bottom:12px' },
            areaBoxes[key],
            el(
              'span',
              {},
              el('span', { class: 'strong' }, label),
              el('div', { class: 'small muted' }, description),
            ),
          ),
        ),
      ),
      el(
        'div',
        { class: 'alert info', style: 'margin:8px 0 0' },
        el('span', { class: 'strong' }, 'Alerts never get in the way. '),
        'A change is written to the activity log first and emailed afterwards, in the background. If the mail ' +
          'server is down or slow, you lose the alert — never the record, and never the action somebody was doing.',
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

function activityCard(feed) {
  const filter = el(
    'select',
    { style: 'max-width:220px' },
    el('option', { value: '' }, 'Everything'),
    ...[
      ['dns', 'DNS'],
      ['email', 'Mailboxes'],
      ['files', 'Files'],
      ['database', 'Database'],
      ['user', 'Accounts'],
      ['settings', 'Settings'],
      ['order', 'Orders'],
      ['security', 'Sign-in failures'],
      ['support', 'Support'],
      ['billing', 'Invoices'],
      ['schedule', 'Overnight jobs'],
    ].map(([value, label]) => el('option', { value }, label)),
  );

  const body = el('div', { class: 'card-body tight table-scroll feed-scroll' });

  const draw = (entries) => {
    if (!entries.length) {
      return fill(
        body,
        el(
          'div',
          { style: 'padding:24px' },
          emptyState('check', 'Nothing has changed yet', 'Every change worth knowing about will appear here.'),
        ),
      );
    }

    fill(
      body,
      el(
        'table',
        {},
        el(
          'thead',
          {},
          el('tr', {}, el('th', {}, 'When'), el('th', {}, 'What happened'), el('th', {}, 'Who'), el('th', {}, 'Alert')),
        ),
        el(
          'tbody',
          {},
          entries.map((e) =>
            el(
              'tr',
              {},
              el(
                'td',
                { class: 'small muted nowrap', title: formatDate(e.createdAt, { withTime: true }) },
                relativeTime(e.createdAt),
              ),
              el(
                'td',
                {},
                el(
                  'div',
                  {},
                  el('span', { class: `badge ${EVENT_TONE(e.event)}`, style: 'margin-right:8px' }, e.event.split('.')[0]),
                  el('span', { class: 'strong small' }, e.summary),
                ),
                e.domainName ? el('div', { class: 'small muted mono' }, e.domainName) : null,
                e.detail ? el('div', { class: 'small muted break', style: 'white-space:pre-wrap;margin-top:3px' }, e.detail) : null,
              ),
              el(
                'td',
                { class: 'small' },
                e.actorLabel || el('span', { class: 'muted' }, 'the public site'),
                e.ip ? el('div', { class: 'small muted mono' }, e.ip) : null,
              ),
              el(
                'td',
                { class: 'small' },
                e.notified
                  ? el('span', { class: 'badge ok' }, 'Sent')
                  : e.notifyError
                    ? el('span', { class: 'badge warn', title: e.notifyError }, 'Not sent')
                    : el('span', { class: 'muted' }, '—'),
              ),
            ),
          ),
        ),
      ),
    );
  };

  filter.onchange = async () => {
    fill(body, el('div', { class: 'card-body muted small' }, 'Loading…'));
    try {
      const res = await api(`/settings/activity?take=60${filter.value ? `&event=${filter.value}` : ''}`);
      draw(res.entries);
    } catch (err) {
      fill(body, el('div', { style: 'padding:20px' }, errorAlert(err)));
    }
  };

  draw(feed.entries);

  return el(
    'div',
    { class: 'card', style: 'margin-top:18px' },
    el(
      'div',
      { class: 'card-head' },
      el(
        'div',
        { class: 'grow' },
        el('h2', {}, 'Recent activity'),
        el('p', {}, `${feed.total} change${feed.total === 1 ? '' : 's'} recorded. This works whether or not email does.`),
      ),
      filter,
    ),
    body,
  );
}
