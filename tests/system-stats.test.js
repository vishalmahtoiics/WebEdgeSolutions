// Reading the machine.
//
// Most of this file is arithmetic over counter snapshots, which is the part
// that can be wrong in a way nobody notices: a CPU figure that is quietly 4x
// too low, or a network rate that turns into a huge negative number the first
// time an interface resets. The readings themselves depend on the machine, so
// what is checked there is the shape and the honesty — that an unavailable
// sensor comes back as null with a reason, never as a zero.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';

import {
  cpuTotals,
  cpuUsageBetween,
  perCoreUsageBetween,
  parseMemInfo,
  parseProcNetDev,
  ratesBetween,
  parseSysfsTemp,
  diskUsage,
  readSystemStats,
  resetSampling,
} from '../src/lib/systemStats.js';

/// An `os.cpus()`-shaped core.
const core = (user, sys, idle) => ({ model: 'Test', speed: 2100, times: { user, nice: 0, sys, idle, irq: 0 } });

// --- Processor ---------------------------------------------------------------

test('a core that spent half its time idle reads as half busy', () => {
  const before = [core(0, 0, 0)];
  const after = [core(400, 100, 500)];
  assert.equal(cpuUsageBetween(before, after), 0.5);
});

test('a fully idle machine reads as zero, not as null', () => {
  // Zero is a real answer here and must not be confused with "cannot tell".
  assert.equal(cpuUsageBetween([core(0, 0, 0)], [core(0, 0, 1000)]), 0);
});

test('a pinned machine reads as one', () => {
  assert.equal(cpuUsageBetween([core(0, 0, 0)], [core(1000, 0, 0)]), 1);
});

test('usage is averaged across cores, not taken from the busiest', () => {
  // One core pinned out of four is 25% of the machine. Reporting 100% would
  // make an idle server look like it is on fire.
  const before = [core(0, 0, 0), core(0, 0, 0), core(0, 0, 0), core(0, 0, 0)];
  const after = [core(1000, 0, 0), core(0, 0, 1000), core(0, 0, 1000), core(0, 0, 1000)];
  assert.equal(cpuUsageBetween(before, after), 0.25);
});

test('counters that go backwards are refused rather than reported', () => {
  // A machine that slept, or a core that went offline. Neither is a usage
  // figure, and the difference would otherwise come out as a wild number.
  assert.equal(cpuUsageBetween([core(500, 0, 500)], [core(0, 0, 0)]), null);
  assert.equal(cpuUsageBetween([core(0, 0, 500)], [core(1000, 0, 0)]), null, 'idle fell while total rose');
});

test('two identical snapshots give no answer, rather than dividing by zero', () => {
  assert.equal(cpuUsageBetween([core(1, 1, 1)], [core(1, 1, 1)]), null);
});

test('a machine that reports no processors does not crash the reading', () => {
  assert.deepEqual(cpuTotals([]), { total: 0, idle: 0 });
  assert.equal(cpuUsageBetween([], []), null);
  assert.equal(cpuUsageBetween(undefined, undefined), null);
});

test('per-core figures line up with the cores they came from', () => {
  const before = [core(0, 0, 0), core(0, 0, 0)];
  const after = [core(1000, 0, 0), core(0, 0, 1000)];
  assert.deepEqual(perCoreUsageBetween(before, after), [1, 0]);
});

test('per-core is refused when the core count changed between snapshots', () => {
  assert.equal(perCoreUsageBetween([core(0, 0, 0)], [core(0, 0, 1), core(0, 0, 1)]), null);
});

// --- Memory ------------------------------------------------------------------

test('memory is read from MemAvailable, not from what is completely unused', () => {
  // The distinction matters: on a machine that has been up a while almost
  // nothing is "free" because the kernel uses the rest as cache, and it hands
  // that back the moment something asks. Reporting MemFree would show a
  // healthy machine as being out of memory.
  const meminfo = [
    'MemTotal:       16482956 kB',
    'MemFree:          279284 kB',
    'MemAvailable:   14963452 kB',
    'Buffers:          102400 kB',
  ].join('\n');

  const mem = parseMemInfo(meminfo);
  assert.equal(mem.totalBytes, 16482956 * 1024);
  assert.equal(mem.availableBytes, 14963452 * 1024);
  assert.ok(mem.usedBytes / mem.totalBytes < 0.1, 'this machine is barely using its memory');
});

test('a meminfo without MemAvailable falls back rather than inventing one', () => {
  assert.equal(parseMemInfo('MemTotal: 100 kB\nMemFree: 50 kB'), null);
  assert.equal(parseMemInfo(''), null);
  assert.equal(parseMemInfo(null), null);
});

// --- Network -----------------------------------------------------------------

const NET_DEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:  158805      14    0    0    0     0          0         0   158805      14    0    0    0     0       0          0
  eth0:  814584    1689    0    6    0     0          0         0  4052809    1732    0    0    0     0       0          0`;

test('interface counters are read from the right columns', () => {
  const parsed = parseProcNetDev(NET_DEV);
  // Receive bytes is the first field, transmit bytes the ninth. Getting this
  // wrong would swap in and out, which looks plausible and is never noticed.
  assert.deepEqual(parsed.eth0, { rxBytes: 814584, txBytes: 4052809 });
  assert.deepEqual(parsed.lo, { rxBytes: 158805, txBytes: 158805 });
  assert.equal(Object.keys(parsed).length, 2, 'the two header lines are not interfaces');
});

test('a rate is bytes moved divided by the time it took', () => {
  const before = { eth0: { rxBytes: 1000, txBytes: 2000 } };
  const after = { eth0: { rxBytes: 3048, txBytes: 2000 } };

  const [eth0] = ratesBetween(before, after, 2000);
  assert.equal(eth0.rxBytesPerSec, 1024, '2048 bytes over two seconds');
  assert.equal(eth0.txBytesPerSec, 0);
});

test('an interface whose counters reset is left out, not reported as negative', () => {
  // Happens on every reboot and every time an interface is brought down. A
  // negative rate drawn on a dashboard is worse than a missing one.
  const before = { eth0: { rxBytes: 9_000_000, txBytes: 9_000_000 } };
  const after = { eth0: { rxBytes: 1000, txBytes: 1000 } };
  assert.deepEqual(ratesBetween(before, after, 1000), []);
});

test('an interface that appeared since the last reading is skipped this round', () => {
  const rates = ratesBetween({}, { wlan0: { rxBytes: 500, txBytes: 500 } }, 1000);
  assert.deepEqual(rates, [], 'there is nothing to subtract from yet');
});

test('no time between snapshots means no rate', () => {
  const same = { eth0: { rxBytes: 1, txBytes: 1 } };
  assert.deepEqual(ratesBetween(same, same, 0), []);
  assert.deepEqual(ratesBetween(same, same, -5), []);
});

test('the busiest interface is listed first', () => {
  const before = { a: { rxBytes: 0, txBytes: 0 }, b: { rxBytes: 0, txBytes: 0 } };
  const after = { a: { rxBytes: 10, txBytes: 0 }, b: { rxBytes: 5000, txBytes: 0 } };
  assert.deepEqual(ratesBetween(before, after, 1000).map((n) => n.name), ['b', 'a']);
});

// --- Temperature -------------------------------------------------------------

test('a sysfs reading is millidegrees', () => {
  assert.equal(parseSysfsTemp('45000\n'), 45);
  assert.equal(parseSysfsTemp('58123'), 58.123);
});

test('a sensor reading nothing is not a temperature', () => {
  // An unwired sensor reads 0 and an unplugged one reads a large negative.
  // Drawing either on a gauge would be a lie with a number attached.
  for (const junk of ['0', '-40000', '', '   ', 'abc', null, '900000']) {
    assert.equal(parseSysfsTemp(junk), null, `"${junk}" is not a temperature`);
  }
});

// --- Disk --------------------------------------------------------------------

test('disk usage is measured against what can be written, not the raw total', () => {
  // A filesystem holds back a slice for root, so total is larger than anything
  // a program can reach. This machine's own root filesystem shows the gap
  // plainly: 252 GB total, 243 GB "free", 28 GB actually available.
  const usage = diskUsage({
    totalBytes: 270_553_174_016,
    freeBytes: 261_107_367_936,
    availableBytes: 30_335_082_496,
  });

  // 9.4 GB used against 39.7 GB reachable is 24%, which is what df says.
  assert.ok(Math.abs(usage - 0.2374) < 0.001, `expected about 24%, got ${(usage * 100).toFixed(1)}%`);

  // Measuring against the raw total would have said 3%, and a disk about to
  // fill up would have looked empty.
  const naive = (270_553_174_016 - 261_107_367_936) / 270_553_174_016;
  assert.ok(naive < 0.04, 'the naive figure really is that misleading');
});

test('a filesystem with no usable space at all gives no percentage', () => {
  assert.equal(diskUsage({ totalBytes: 0, freeBytes: 0, availableBytes: 0 }), null);
});

// --- The whole reading -------------------------------------------------------

test('a reading has every section, and says why anything is missing', async () => {
  resetSampling();
  const s = await readSystemStats();

  assert.ok(s.at, 'stamped with when it was taken');
  assert.equal(typeof s.host.platform, 'string');
  assert.ok(s.uptime.systemSeconds >= 0);
  assert.ok(s.memory.totalBytes > 0);
  assert.ok(Array.isArray(s.disks) && s.disks.length);

  // The honesty rule, checked directly: anything that is null has a reason
  // next to it, and nothing that is unavailable is dressed up as a zero.
  if (s.cpu.usage === null) assert.ok(s.unavailable.cpu, 'an unreadable processor says so');
  if (s.temperature === null) assert.ok(s.unavailable.temperature, 'a machine with no sensor says so');
  if (s.network === null) assert.ok(s.unavailable.network, 'unreadable counters say so');
});

test('the processor figure is a fraction, never a percentage by accident', async () => {
  resetSampling();
  const s = await readSystemStats();
  if (s.cpu.usage === null) return;
  assert.ok(s.cpu.usage >= 0 && s.cpu.usage <= 1, `expected 0..1, got ${s.cpu.usage}`);
  for (const core of s.cpu.perCore || []) {
    assert.ok(core >= 0 && core <= 1, `per-core expected 0..1, got ${core}`);
  }
});

test('a second reading arrives without stopping to sample again', async () => {
  // The point of keeping the previous snapshot. A page that polls should not
  // pay for a sampling delay on every request.
  resetSampling();
  await readSystemStats();
  await new Promise((r) => setTimeout(r, 250));

  const started = Date.now();
  await readSystemStats();
  assert.ok(Date.now() - started < 200, `the second reading took ${Date.now() - started}ms`);
});

test('work done on this machine shows up in the reading', async () => {
  // The end-to-end check that the counters are wired to anything at all: burn
  // a core and watch the figure move. Written against a busy machine as well
  // as an idle one, so it asserts a rise rather than a value.
  resetSampling();
  await readSystemStats();
  await new Promise((r) => setTimeout(r, 200));
  const idle = await readSystemStats();
  if (idle.cpu.usage === null) return;

  const until = Date.now() + 700;
  while (Date.now() < until) Math.sqrt(Math.random());

  const busy = await readSystemStats();
  assert.ok(
    busy.cpu.usage > idle.cpu.usage,
    `burning a core should raise the figure: idle ${idle.cpu.usage}, busy ${busy.cpu.usage}`,
  );
  // One core of however many this machine has.
  assert.ok(busy.cpu.usage <= 1);
});

test('the reading names this machine, so it is obvious which one it is', async () => {
  resetSampling();
  const s = await readSystemStats();
  assert.equal(s.host.hostname, os.hostname());
  assert.equal(s.host.platform, os.platform());
});
