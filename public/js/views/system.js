// What this machine is doing right now. Super Admin only.
//
// The page refreshes itself, and the numbers are read fresh from the operating
// system each time. Where a reading is not available — a machine with no
// temperature sensor, a platform with no load average — it says so in words
// rather than drawing a zero, because a gauge sitting at zero looks like an
// answer and is not one.

import { api, el, clear, fill, appendAll, emptyState, errorAlert } from '../core.js';
import { icon } from '../icons.js';

/// How often to ask again. Every reading is a fresh syscall, so this is cheap,
/// but not so cheap that it should run faster than somebody can read it.
const REFRESH_MS = 3000;

const GB = 1024 ** 3;
const MB = 1024 ** 2;

const bytes = (n) => {
  if (n === null || n === undefined) return '—';
  if (n >= GB) return `${(n / GB).toFixed(n >= 10 * GB ? 0 : 1)} GB`;
  if (n >= MB) return `${(n / MB).toFixed(0)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
};

/// Bytes per second, in the units a person watching a transfer expects.
const rate = (n) => {
  if (n === null || n === undefined) return '—';
  if (n >= MB) return `${(n / MB).toFixed(1)} MB/s`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB/s`;
  return `${Math.round(n)} B/s`;
};

const percent = (f) => (f === null || f === undefined ? '—' : `${Math.round(f * 100)}%`);

/// "3 days, 4 hours". Seconds are noise on a figure that only ever grows.
function duration(seconds) {
  if (!Number.isFinite(seconds)) return '—';

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);

  const parts = [];
  if (days) parts.push(`${days} day${days === 1 ? '' : 's'}`);
  if (hours) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
  // Only worth the words while the other two are small.
  if (!days && mins) parts.push(`${mins} min`);

  return parts.join(', ') || 'less than a minute';
}

/// Green below two thirds, amber past that, red once it is nearly gone.
const toneFor = (usage) => (usage >= 0.9 ? 'danger' : usage >= 0.66 ? 'warn' : 'ok');

/// A labelled bar. `usage` is 0..1, or null for "this cannot be measured".
function meter(label, usage, detail, note) {
  const known = usage !== null && usage !== undefined;
  return el(
    'div',
    { class: 'meter' },
    el(
      'div',
      { class: 'meter-head' },
      el('span', { class: 'meter-label' }, label),
      el('span', { class: `meter-value ${known ? '' : 'muted'}` }, known ? percent(usage) : 'Not available'),
    ),
    el(
      'div',
      { class: 'meter-track', role: 'img', 'aria-label': `${label}: ${known ? percent(usage) : 'not available'}` },
      known ? el('div', { class: `meter-fill ${toneFor(usage)}`, style: `width:${Math.min(100, usage * 100)}%` }) : null,
    ),
    detail ? el('div', { class: 'small muted' }, detail) : null,
    note ? el('div', { class: 'small muted' }, note) : null,
  );
}

const statTile = (label, value, sub) =>
  el(
    'div',
    { class: 'stat-tile' },
    el('div', { class: 'small muted' }, label),
    el('div', { class: 'stat-value' }, value),
    sub ? el('div', { class: 'small muted' }, sub) : null,
  );

export async function renderSystem() {
  const frag = el('div');
  const body = el('div');
  const stamp = el('span', { class: 'small muted' });

  const live = el('span', { class: 'badge ok' }, el('span', { class: 'dot' }), 'Live');

  appendAll(frag, [
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        { class: 'grow' },
        el('h1', {}, 'System'),
        el('p', {}, 'What the machine running this portal is doing, read fresh from the operating system.'),
      ),
      el('div', { class: 'page-actions' }, live, stamp),
    ),
    body,
  ]);

  let timer = null;
  let stopped = false;

  const draw = async () => {
    try {
      const { stats, portal } = await api('/system');
      if (stopped) return;
      fill(body, ...panels(stats, portal));
      stamp.textContent = `updated ${new Date(stats.at).toLocaleTimeString()}`;
    } catch (err) {
      if (stopped) return;
      fill(body, errorAlert(err));
      clear(live).append('Stopped');
      live.className = 'badge danger';
      return;
    }
    // Chained rather than on an interval, so a slow reading cannot stack up
    // requests behind itself.
    timer = setTimeout(draw, REFRESH_MS);
  };

  // The page is replaced on navigation; without this the timer would keep
  // polling for a page nobody is looking at.
  const observer = new MutationObserver(() => {
    if (!document.body.contains(frag)) {
      stopped = true;
      clearTimeout(timer);
      observer.disconnect();
    }
  });
  observer.observe(document.getElementById('app'), { childList: true, subtree: true });

  await draw();
  return frag;
}

function panels(s, portal) {
  return [hostCard(s, portal), loadCard(s), diskCard(s), networkCard(s)];
}

function hostCard(s, portal) {
  const h = s.host;
  const env = h.environment;

  return el(
    'div',
    { class: 'card' },
    el(
      'div',
      { class: 'card-head' },
      el(
        'div',
        { class: 'grow' },
        el('h2', {}, h.hostname || 'This machine'),
        el('p', {}, h.cpuModel || 'Processor not reported'),
      ),
      env?.label ? el('span', { class: 'badge warn' }, env.label) : null,
    ),
    el(
      'div',
      { class: 'card-body' },
      // Said before the numbers, not after them. Somebody who opens this page
      // expecting their laptop should find out here rather than by wondering
      // why the memory does not match Task Manager.
      env?.note
        ? el(
            'div',
            { class: 'alert info', style: 'margin-bottom:16px' },
            el('span', { class: 'strong' }, `Running under ${env.label}. `),
            env.note,
          )
        : null,
      el(
        'div',
        { class: 'stat-row' },
        statTile('Uptime', duration(s.uptime.systemSeconds), 'since the machine last started'),
        statTile('Portal running', duration(s.uptime.processSeconds), 'since this process started'),
        // Which code is live. After pushing a fix, this is where to check it
        // actually reached the server: a commit that does not match, or a
        // start time from before the push, means it is still the old code.
        statTile(
          'Portal version',
          portal?.commit || 'Unknown',
          portal?.commit
            ? `started ${new Date(portal.startedAt).toLocaleString()}`
            : 'this server does not report its commit',
        ),
        statTile('Processors', h.cores ? `${h.cores} cores` : '—', h.arch || ''),
        statTile('System', h.platform || '—', h.release || ''),
      ),
    ),
  );
}

function loadCard(s) {
  const mem = s.memory;
  const temp = s.temperature;

  return el(
    'div',
    { class: 'card', style: 'margin-top:18px' },
    el('div', { class: 'card-head' }, el('div', { class: 'grow' }, el('h2', {}, 'Load'))),
    el(
      'div',
      { class: 'card-body' },
      el(
        'div',
        { class: 'meter-grid' },
        meter(
          'Processor',
          s.cpu.usage,
          s.cpu.usage === null ? s.unavailable.cpu : `across ${s.host.cores || '?'} cores`,
        ),
        meter(
          'Memory',
          mem.usage,
          `${bytes(mem.usedBytes)} used of ${bytes(mem.totalBytes)}`,
          // Worth saying: on Linux the obvious number is the misleading one,
          // and somebody comparing this against `free` deserves to know which
          // of the two they are looking at.
          {
            MemAvailable: `${bytes(mem.availableBytes)} available to a new program`,
            cgroup: 'Measured against this container\u2019s limit, not the whole machine\u2019s memory.',
          }[mem.source] || null,
        ),
        temp
          ? meter(
              'Temperature',
              // Scaled across the range a machine actually lives in, so the
              // bar moves where it matters rather than sitting at a third.
              Math.max(0, Math.min(1, (temp.celsius - 30) / 60)),
              `${temp.celsius.toFixed(1)} °C — ${temp.sensors[0].label}`,
              [
                temp.sensors.length > 1 ? `${temp.sensors.length} sensors, hottest shown` : null,
                // A figure read off the chips and one an ACPI zone reported
                // are not the same quality of answer.
                temp.source && temp.source !== 'This machine' ? `Read from: ${temp.source}` : null,
              ]
                .filter(Boolean)
                .join(' · ') || null,
            )
          : meter('Temperature', null, s.unavailable.temperature),
      ),
      s.cpu.perCore?.length
        ? el(
            'div',
            { class: 'core-row' },
            s.cpu.perCore.map((usage, i) =>
              el(
                'div',
                { class: 'core', title: `Core ${i + 1}: ${percent(usage)}` },
                el('div', { class: 'core-track' }, el('div', { class: `core-fill ${toneFor(usage)}`, style: `height:${Math.max(2, usage * 100)}%` })),
                el('div', { class: 'small muted' }, String(i + 1)),
              ),
            ),
          )
        : null,
      !temp
        ? el(
            'div',
            { class: 'alert info', style: 'margin-top:14px' },
            el('span', { class: 'strong' }, 'To read a temperature here: '),
            'install LibreHardwareMonitor on the machine, switch on its web server, and put the address into ',
            el('span', { class: 'strong' }, 'Alerts & Activity \u2192 Hardware temperature'),
            '. It installs a driver that reads the sensor chips directly, which is the only thing that works reliably on Windows.',
          )
        : null,
      s.cpu.loadAvg
        ? el(
            'div',
            { class: 'small muted', style: 'margin-top:12px' },
            `Load average ${s.cpu.loadAvg.map((n) => n.toFixed(2)).join(' · ')} over 1, 5 and 15 minutes.`,
          )
        : el('div', { class: 'small muted', style: 'margin-top:12px' }, s.unavailable.loadAvg || ''),
    ),
  );
}

function diskCard(s) {
  return el(
    'div',
    { class: 'card', style: 'margin-top:18px' },
    el('div', { class: 'card-head' }, el('div', { class: 'grow' }, el('h2', {}, 'Disk'))),
    el(
      'div',
      { class: 'card-body' },
      el(
        'div',
        { class: 'meter-grid' },
        s.disks.map((d) =>
          d.error
            ? meter(d.path, null, `Could not be read (${d.error}).`)
            : meter(
                d.path,
                d.usage,
                `${bytes(d.usedBytes)} used, ${bytes(d.availableBytes)} free`,
                // These two differ by a lot on some filesystems, and the
                // smaller one is the one that runs out.
                d.freeBytes - d.availableBytes > GB
                  ? `${bytes(d.totalBytes)} in total, but only ${bytes(d.availableBytes)} can be written to`
                  : `${bytes(d.totalBytes)} in total`,
              ),
        ),
      ),
    ),
  );
}

function networkCard(s) {
  if (!s.network) {
    return el(
      'div',
      { class: 'card', style: 'margin-top:18px' },
      el('div', { class: 'card-head' }, el('div', { class: 'grow' }, el('h2', {}, 'Network'))),
      el('div', { class: 'card-body' }, emptyState('server', 'Not available', s.unavailable.network)),
    );
  }

  // An interface that has moved nothing at all since the last reading is
  // noise on this page — every machine has several.
  const busy = s.network.interfaces.filter((n) => n.rxBytesPerSec > 0 || n.txBytesPerSec > 0);
  const shown = busy.length ? busy : s.network.interfaces.slice(0, 1);

  return el(
    'div',
    { class: 'card', style: 'margin-top:18px' },
    el(
      'div',
      { class: 'card-head' },
      el(
        'div',
        { class: 'grow' },
        el('h2', {}, 'Network'),
        el('p', {}, `Measured over the last ${(s.network.sampleMs / 1000).toFixed(1)} seconds.`),
      ),
    ),
    el(
      'div',
      { class: 'card-body' },
      el(
        'div',
        { class: 'stat-row' },
        shown.map((n) =>
          el(
            'div',
            { class: 'stat-tile' },
            el('div', { class: 'small muted' }, n.name, n.linkSpeedMbps ? ` · ${n.linkSpeedMbps} Mbps link` : ''),
            el(
              'div',
              { class: 'net-rates' },
              el('span', {}, icon('cloud', 14), ` ${rate(n.rxBytesPerSec)} in`),
              el('span', {}, icon('cloud', 14), ` ${rate(n.txBytesPerSec)} out`),
            ),
          ),
        ),
      ),
      busy.length === 0 ? el('div', { class: 'small muted', style: 'margin-top:10px' }, 'Nothing is moving right now.') : null,
    ),
  );
}
