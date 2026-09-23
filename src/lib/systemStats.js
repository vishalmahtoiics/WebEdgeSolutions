// What the machine running this portal is doing right now.
//
// Everything here is read from the operating system. Nothing is estimated and
// nothing is filled in with a plausible-looking number: where a reading is not
// available — and several of them genuinely are not, depending on the machine
// and the platform — it comes back null with a reason attached, and the page
// says so. A dashboard that shows 0°C for a laptop with no temperature sensor
// is worse than one that admits it cannot tell.
//
// The parsing and arithmetic are exported separately from the reading, because
// the reading depends on the machine and the arithmetic does not. That is what
// makes any of this testable.

import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------------------
// The arithmetic
// ---------------------------------------------------------------------------

/// Total and idle jiffies across every core in one `os.cpus()` snapshot.
export function cpuTotals(cpus) {
  let total = 0;
  let idle = 0;
  for (const cpu of cpus || []) {
    const t = cpu?.times;
    if (!t) continue;
    total += (t.user || 0) + (t.nice || 0) + (t.sys || 0) + (t.idle || 0) + (t.irq || 0);
    idle += t.idle || 0;
  }
  return { total, idle };
}

/// Busy fraction between two `os.cpus()` snapshots, 0..1.
///
/// These counters only ever climb, so a drop means the machine slept, a core
/// went offline, or the process is comparing snapshots that are not related.
/// None of those is a usage figure, so they come back null.
export function cpuUsageBetween(before, after) {
  const a = cpuTotals(before);
  const b = cpuTotals(after);

  const total = b.total - a.total;
  const idle = b.idle - a.idle;
  if (!(total > 0) || idle < 0 || idle > total) return null;

  return 1 - idle / total;
}

/// Per-core busy fractions, in the order the platform lists them.
export function perCoreUsageBetween(before, after) {
  if (!before?.length || before.length !== after?.length) return null;

  const out = [];
  for (let i = 0; i < before.length; i += 1) {
    const usage = cpuUsageBetween([before[i]], [after[i]]);
    if (usage === null) return null;
    out.push(usage);
  }
  return out;
}

/// Memory from the contents of /proc/meminfo.
///
/// `os.freemem()` on Linux reports memory that is completely unused, which on
/// any machine that has been running a while is almost none of it — the rest
/// is page cache, which the kernel hands back the moment something asks. That
/// makes os.freemem() read like a machine about to run out when it is fine.
/// MemAvailable is the kernel's own estimate of what a new program could
/// actually get, and it is the honest number to show.
export function parseMemInfo(text) {
  const kb = (name) => {
    const m = new RegExp(`^${name}:\\s+(\\d+) kB$`, 'm').exec(text || '');
    return m ? Number(m[1]) * 1024 : null;
  };

  const total = kb('MemTotal');
  const available = kb('MemAvailable');
  if (!total || available === null) return null;

  return { totalBytes: total, availableBytes: available, usedBytes: total - available };
}

/// Byte and packet counters per interface, from the contents of /proc/net/dev.
export function parseProcNetDev(text) {
  const out = {};

  for (const line of String(text || '').split('\n')) {
    // "  eth0: 814584 1689 0 6 0 0 0 0 4052809 1732 0 0 0 0 0 0"
    const m = /^\s*([^:\s]+):\s*(.+)$/.exec(line);
    if (!m) continue;

    const fields = m[2].trim().split(/\s+/).map(Number);
    if (fields.length < 10 || fields.some(Number.isNaN)) continue;

    out[m[1]] = { rxBytes: fields[0], txBytes: fields[8] };
  }

  return out;
}

/// Bytes per second per interface, between two counter snapshots.
///
/// Counters reset when an interface goes down or the machine reboots. A reset
/// looks like an enormous negative delta, which as a rate would be nonsense,
/// so that interface is left out of this window rather than reported wrongly.
export function ratesBetween(before, after, elapsedMs) {
  if (!(elapsedMs > 0)) return [];

  const seconds = elapsedMs / 1000;
  const out = [];

  for (const [name, now] of Object.entries(after || {})) {
    const then = before?.[name];
    if (!then) continue;

    const rx = now.rxBytes - then.rxBytes;
    const tx = now.txBytes - then.txBytes;
    if (rx < 0 || tx < 0) continue;

    out.push({ name, rxBytesPerSec: rx / seconds, txBytesPerSec: tx / seconds });
  }

  return out.sort((a, b) => b.rxBytesPerSec + b.txBytesPerSec - (a.rxBytesPerSec + a.txBytesPerSec));
}

/// A temperature in °C from the contents of a sysfs sensor file.
///
/// These are in millidegrees. A sensor that is not wired to anything reads 0
/// and one that is unplugged reads a large negative number; neither is a
/// temperature, so both are refused rather than drawn on a gauge.
export function parseSysfsTemp(text) {
  const raw = Number(String(text || '').trim());
  if (!Number.isFinite(raw)) return null;

  const celsius = raw / 1000;
  if (celsius <= 0 || celsius > 150) return null;
  return celsius;
}

/// What `df` calls Use%: of the space this machine can actually hand out, how
/// much is already gone.
///
/// Deliberately not used/total. A filesystem reserves a slice for root, so
/// total is bigger than anything a program can ever use, and measuring against
/// it reports a disk as emptier than it is.
export function diskUsage({ totalBytes, freeBytes, availableBytes }) {
  const used = totalBytes - freeBytes;
  const usable = used + availableBytes;
  return usable > 0 ? used / usable : null;
}

// ---------------------------------------------------------------------------
// The reading
// ---------------------------------------------------------------------------

const isLinux = () => os.platform() === 'linux';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/// The last CPU and network snapshot, with when it was taken.
///
/// Both of those are rates, and a rate needs two readings and the time
/// between them. Keeping the previous one means a page that polls every few
/// seconds gets a figure covering exactly the gap since it last asked,
/// instead of every request having to stop and wait for a second sample.
let previous = null;

/// How far apart two snapshots must be for the rate between them to mean
/// anything. Closer than this and a single scheduling hiccup swamps the
/// measurement.
const MIN_SAMPLE_MS = 200;

/// How long to wait when there is no usable previous snapshot — the first
/// call after the portal starts, essentially.
const FIRST_SAMPLE_MS = 300;

async function readNetCounters() {
  if (!isLinux()) return null;
  return fs
    .readFile('/proc/net/dev', 'utf8')
    .then(parseProcNetDev)
    .catch(() => null);
}

function snapshot(netCounters) {
  return { at: Date.now(), cpus: os.cpus(), net: netCounters };
}

/// Total, free and available space for one path.
async function readDisk(target) {
  try {
    const s = await fs.statfs(target);
    const totalBytes = s.blocks * s.bsize;
    const freeBytes = s.bfree * s.bsize;
    const availableBytes = s.bavail * s.bsize;

    return {
      path: target,
      totalBytes,
      freeBytes,
      // What a program could actually write. On this machine the difference
      // between free and available runs to hundreds of gigabytes, so the
      // headline figure is this one.
      availableBytes,
      usedBytes: totalBytes - freeBytes,
      usage: diskUsage({ totalBytes, freeBytes, availableBytes }),
    };
  } catch (err) {
    return { path: target, error: err.code || err.message };
  }
}

/// Every temperature the machine will admit to, best effort.
///
/// Linux exposes these through sysfs. macOS needs a privileged helper and
/// Windows relies on a WMI class most manufacturers never implement, so on
/// those this reports nothing rather than guessing.
async function readTemperatures() {
  if (!isLinux()) {
    return { sensors: [], reason: `Temperature sensors are not readable on ${os.platform()}.` };
  }

  const sensors = [];

  // The thermal zones first: these are the ones with a type attached, so they
  // can be labelled rather than listed as temp1, temp2, temp3.
  const zones = await fs.readdir('/sys/class/thermal').catch(() => []);
  for (const zone of zones) {
    if (!zone.startsWith('thermal_zone')) continue;
    const celsius = parseSysfsTemp(
      await fs.readFile(`/sys/class/thermal/${zone}/temp`, 'utf8').catch(() => ''),
    );
    if (celsius === null) continue;
    const label = (await fs.readFile(`/sys/class/thermal/${zone}/type`, 'utf8').catch(() => '')).trim();
    sensors.push({ label: label || zone, celsius });
  }

  // Then the hardware monitors, which is where most laptops put the CPU
  // package sensor.
  const monitors = await fs.readdir('/sys/class/hwmon').catch(() => []);
  for (const monitor of monitors) {
    const base = `/sys/class/hwmon/${monitor}`;
    const chip = (await fs.readFile(`${base}/name`, 'utf8').catch(() => '')).trim();
    const files = await fs.readdir(base).catch(() => []);

    for (const file of files) {
      if (!/^temp\d+_input$/.test(file)) continue;
      const celsius = parseSysfsTemp(await fs.readFile(`${base}/${file}`, 'utf8').catch(() => ''));
      if (celsius === null) continue;

      const label = (
        await fs.readFile(`${base}/${file.replace('_input', '_label')}`, 'utf8').catch(() => '')
      ).trim();
      sensors.push({ label: [chip, label].filter(Boolean).join(' ') || file, celsius });
    }
  }

  if (!sensors.length) {
    return {
      sensors: [],
      reason:
        'This machine reports no temperature sensors. That is normal on a virtual machine, and on some laptops the sensors are only readable with a driver installed.',
    };
  }

  return { sensors, reason: null };
}

/// Link speed in megabits, where the driver reports one.
///
/// A virtual interface answers -1 and a link that is down answers 0. Neither
/// is a speed.
async function readLinkSpeeds() {
  if (!isLinux()) return {};

  const out = {};
  const nics = await fs.readdir('/sys/class/net').catch(() => []);
  for (const nic of nics) {
    const raw = await fs.readFile(`/sys/class/net/${nic}/speed`, 'utf8').catch(() => null);
    const mbps = Number(String(raw || '').trim());
    if (Number.isFinite(mbps) && mbps > 0) out[nic] = mbps;
  }
  return out;
}

async function readMemory() {
  if (isLinux()) {
    const parsed = parseMemInfo(await fs.readFile('/proc/meminfo', 'utf8').catch(() => ''));
    if (parsed) {
      return { ...parsed, usage: parsed.usedBytes / parsed.totalBytes, source: 'MemAvailable' };
    }
  }

  const totalBytes = os.totalmem();
  const availableBytes = os.freemem();
  return {
    totalBytes,
    availableBytes,
    usedBytes: totalBytes - availableBytes,
    usage: (totalBytes - availableBytes) / totalBytes,
    source: 'os.freemem',
  };
}

/// Everything, as one reading.
export async function readSystemStats({ diskPaths } = {}) {
  const unavailable = {};

  // Take the second half of both rate measurements together, so CPU and
  // network cover the same window.
  let before = previous;
  if (!before || Date.now() - before.at < MIN_SAMPLE_MS) {
    before = snapshot(await readNetCounters());
    await sleep(FIRST_SAMPLE_MS);
  }

  const after = snapshot(await readNetCounters());
  previous = after;
  const elapsedMs = after.at - before.at;

  const cpus = after.cpus || [];
  const usage = cpuUsageBetween(before.cpus, after.cpus);
  if (usage === null) unavailable.cpu = 'The processor counters moved in a way that is not a usage figure.';

  // Load average is a Unix idea. Windows answers with zeroes, which would
  // draw as a flat line rather than as "not applicable here".
  const loadAvg = os.platform() === 'win32' ? null : os.loadavg();
  if (!loadAvg) unavailable.loadAvg = 'Windows does not keep a load average.';

  const roots = diskPaths?.length ? diskPaths : [path.parse(process.cwd()).root || '/'];
  const disks = await Promise.all(roots.map(readDisk));

  const temperature = await readTemperatures();
  if (!temperature.sensors.length) unavailable.temperature = temperature.reason;

  const linkSpeeds = await readLinkSpeeds();
  const rates = before.net && after.net ? ratesBetween(before.net, after.net, elapsedMs) : null;
  if (!rates) unavailable.network = `Network counters are not readable on ${os.platform()}.`;

  return {
    at: new Date().toISOString(),
    host: {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpuModel: cpus[0]?.model?.trim() || null,
      cores: cpus.length || null,
    },
    uptime: {
      systemSeconds: Math.floor(os.uptime()),
      processSeconds: Math.floor(process.uptime()),
    },
    cpu: {
      usage,
      perCore: perCoreUsageBetween(before.cpus, after.cpus),
      loadAvg,
    },
    memory: await readMemory(),
    disks,
    temperature: temperature.sensors.length
      ? {
          // The hottest reading is the one that matters; the rest are there
          // for somebody who wants to know which part is hot.
          celsius: Math.max(...temperature.sensors.map((s) => s.celsius)),
          sensors: temperature.sensors.sort((a, b) => b.celsius - a.celsius),
        }
      : null,
    network: rates ? { sampleMs: elapsedMs, interfaces: rates.map((r) => ({ ...r, linkSpeedMbps: linkSpeeds[r.name] ?? null })) } : null,
    // Said out loud rather than left as a gap for the page to interpret.
    unavailable,
  };
}

/// Forgets the stored snapshot. Only the tests need this.
export function resetSampling() {
  previous = null;
}
