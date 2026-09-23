// Reading a machine's temperature, which is the one figure on the System page
// that often cannot be read at all.
//
// There are three places it can come from, and which of them works depends
// entirely on the machine:
//
//   1. Linux sysfs        — works on real Linux, including most laptops.
//   2. Windows, via WMI   — works on some machines. Many laptop manufacturers
//                           never implement the class, and those answer "not
//                           supported" rather than a number.
//   3. A sensor program   — LibreHardwareMonitor and Open Hardware Monitor
//                           install a driver that reads the chips directly,
//                           and will serve every sensor as JSON over HTTP.
//                           This is the one that reliably works on Windows.
//
// Under WSL none of the local readings work: Windows does not pass hardware
// sensors through to the Linux environment. But WSL can run Windows programs,
// so 2 and 3 are still reachable from there, which is why this is worth having
// rather than simply reporting nothing.
//
// A caution about 2 and 3: they are written from the documented shapes and
// could not be tried against real Windows from where this was built. The
// parsing is tested against those shapes; the machine at the other end is not
// something a test here can stand in for. If either comes back wrong, the
// parser is the first place to look.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/// Long enough that a page polling every few seconds does not shell out to
/// Windows every time, short enough that a machine heating up shows it. A
/// processor that is throttling has been hot for far longer than this.
const CACHE_MS = 15000;

/// Spawning a Windows process from WSL is slow — the better part of a second
/// — so it is not allowed to hold a page up beyond this.
const WINDOWS_TIMEOUT_MS = 5000;
const HTTP_TIMEOUT_MS = 2500;

let cache = null;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/// Temperatures from MSAcpi_ThermalZoneTemperature, as PowerShell renders it.
///
/// The class reports tenths of a kelvin, so 3032 is 303.2 K, which is 30.05°C.
/// Getting that conversion wrong is not obvious from the output — a plain
/// division by 10 gives 303°C, which looks like a machine on fire, and
/// subtracting without dividing gives a number that is merely wrong.
export function parseWindowsThermalZones(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout || '').trim() || 'null');
  } catch {
    return [];
  }
  if (!parsed) return [];

  // One thermal zone comes back as an object, several as an array.
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const sensors = [];

  for (const row of rows) {
    const tenthsKelvin = Number(row?.CurrentTemperature);
    if (!Number.isFinite(tenthsKelvin) || tenthsKelvin <= 0) continue;

    const celsius = tenthsKelvin / 10 - 273.15;
    if (celsius <= 0 || celsius > 150) continue;

    // "ACPI\ThermalZone\TZ00_0" says nothing to a person; the tail of it is
    // at least short enough to tell two zones apart.
    const name = String(row?.InstanceName || '').split('\\').pop() || 'Thermal zone';
    sensors.push({ label: name, celsius: Math.round(celsius * 10) / 10 });
  }

  return sensors;
}

/// Temperatures out of a LibreHardwareMonitor or Open Hardware Monitor
/// `/data.json`.
///
/// The document is a tree of nodes — machine, then chip, then sensor type,
/// then the sensors — and readings are strings with their unit attached, like
/// "45.0 °C". Everything is walked rather than reaching into fixed positions,
/// because the depth depends on how many chips the machine has.
export function parseSensorTree(json) {
  const sensors = [];

  const walk = (node, trail) => {
    if (!node || typeof node !== 'object') return;

    const text = typeof node.Text === 'string' ? node.Text : '';
    const value = typeof node.Value === 'string' ? node.Value : '';

    // A degree sign is what marks a node as a temperature rather than a fan
    // speed, a voltage or a load percentage, all of which sit in the same
    // tree and would otherwise be drawn as temperatures.
    const match = /^\s*(-?\d+(?:[.,]\d+)?)\s*°\s*C\s*$/.exec(value);
    if (match) {
      const celsius = Number(match[1].replace(',', '.'));
      if (Number.isFinite(celsius) && celsius > 0 && celsius <= 150) {
        // The chip's name and the sensor's, so "CPU Core #1" is not
        // ambiguous on a machine with two processors.
        const label = [trail[trail.length - 1], text].filter(Boolean).join(' ');
        sensors.push({ label: label || text || 'Sensor', celsius });
      }
    }

    const children = Array.isArray(node.Children) ? node.Children : [];
    // "Temperatures" is a grouping node, not the name of anything, so it is
    // not carried down as part of a label.
    const next = text && text !== 'Temperatures' ? [...trail, text] : trail;
    for (const child of children) walk(child, next);
  };

  walk(json, []);
  return sensors;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/// Asks Windows for its ACPI thermal zones.
///
/// Reachable from Windows itself and from WSL, which can run Windows
/// executables directly. The command carries no input from anywhere, so there
/// is nothing in it for a caller to influence.
export async function readWindowsThermalZones() {
  const script =
    'Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop ' +
    '| Select-Object InstanceName, CurrentTemperature | ConvertTo-Json -Compress';

  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: WINDOWS_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 256 * 1024,
    });

    const sensors = parseWindowsThermalZones(stdout);
    if (sensors.length) return { sensors, source: 'Windows thermal zones' };

    return {
      sensors: [],
      reason:
        'Windows answered, but reported no thermal zones. Most laptop manufacturers never implement the sensor class Windows exposes, so this is common and is not something the portal can fix.',
    };
  } catch (err) {
    // ENOENT means there is no Windows to ask, which is a different thing
    // from Windows refusing to answer.
    if (err.code === 'ENOENT') return { sensors: [], reason: null };
    return {
      sensors: [],
      reason:
        'Windows refused to report its thermal zones. On most laptops the sensor class is not implemented; a sensor program is the way round it.',
    };
  }
}

/// Reads every temperature a sensor program is serving.
///
/// `url` points at a LibreHardwareMonitor or Open Hardware Monitor web
/// server — /data.json on whatever port it was given.
export async function readSensorService(url) {
  if (!url) return { sensors: [], reason: null };

  let target;
  try {
    target = new URL(url);
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error('not http');
  } catch {
    return { sensors: [], reason: `"${url}" is not a web address the portal can read.` };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(target, { signal: controller.signal });
    if (!res.ok) {
      return { sensors: [], reason: `The sensor program answered ${res.status} at ${target.origin}.` };
    }

    const sensors = parseSensorTree(await res.json());
    if (sensors.length) return { sensors, source: 'Sensor program' };

    return {
      sensors: [],
      reason: `The sensor program at ${target.origin} is running but reported no temperatures.`,
    };
  } catch (err) {
    // The message from a failed fetch names the address, which is already on
    // screen, and nothing else worth showing.
    return {
      sensors: [],
      reason:
        err.name === 'AbortError'
          ? `The sensor program at ${target.origin} did not answer in time.`
          : `Nothing answered at ${target.origin}. Check the sensor program is running and its web server is switched on.`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/// The first temperature reading that works, from the sources worth trying on
/// this machine.
///
/// Ordered by how much the answer is worth: a sensor program reads the chips
/// directly and names them, ACPI gives one number for a whole zone, and local
/// sysfs is already covered by the caller.
export async function readRemoteTemperature({ sensorUrl, environment, platform }) {
  const canAskWindows = platform === 'win32' || environment?.kind === 'wsl';

  // Keyed on what it was computed from, not only on when. Without this,
  // somebody who has just pointed the portal at a sensor program watches the
  // page keep saying there is nothing for another quarter of a minute, and
  // reasonably concludes the setting does not work.
  const key = `${sensorUrl || ''}|${canAskWindows}`;
  const now = Date.now();
  if (cache && cache.key === key && now - cache.at < CACHE_MS) return cache.value;

  const reasons = [];

  const attempts = [
    () => readSensorService(sensorUrl),
    ...(canAskWindows ? [() => readWindowsThermalZones()] : []),
  ];

  let value = { sensors: [], reason: null, source: null };
  for (const attempt of attempts) {
    const result = await attempt();
    if (result.sensors.length) {
      value = result;
      break;
    }
    if (result.reason) reasons.push(result.reason);
  }

  // Every reason, not just the last: somebody who set up a sensor program and
  // still sees nothing needs to know it was tried and what it said.
  if (!value.sensors.length && reasons.length) value.reason = reasons.join(' ');

  cache = { at: now, key, value };
  return value;
}

/// Forgets the cached reading. Only the tests need this.
export function resetTemperatureCache() {
  cache = null;
}
