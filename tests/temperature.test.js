// Reading a temperature from somewhere other than this machine.
//
// Two formats are parsed here and neither could be tried against the real
// thing from where this was written — there is no Windows in reach. So the
// tests are written against the documented shapes, including the parts most
// likely to be got wrong: the unit MSAcpi reports in, which is tenths of a
// kelvin and looks like a plausible number either way, and a sensor tree that
// carries fan speeds and voltages alongside the temperatures.
//
// That is also the honest limit of these tests. They prove the parsing, not
// that the machine at the other end sends what the documentation says.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseWindowsThermalZones,
  parseSensorTree,
  readSensorService,
  readRemoteTemperature,
  resetTemperatureCache,
} from '../src/lib/temperature.js';

// --- Windows thermal zones ---------------------------------------------------

test('tenths of a kelvin become degrees celsius', () => {
  // 3032 is 303.2 K. Dividing by ten alone gives 303°C, which reads as a
  // machine on fire; subtracting without dividing gives -270. Both are
  // numbers, and both would be drawn on the gauge without complaint.
  const [zone] = parseWindowsThermalZones('{"InstanceName":"ACPI\\\\ThermalZone\\\\TZ00_0","CurrentTemperature":3032}');
  assert.equal(zone.celsius, 30.1);
  assert.equal(zone.label, 'TZ00_0', 'the tail of the instance name, not the whole ACPI path');
});

test('several zones come back as an array and are all read', () => {
  const json = JSON.stringify([
    { InstanceName: 'ACPI\\ThermalZone\\TZ00_0', CurrentTemperature: 3232 },
    { InstanceName: 'ACPI\\ThermalZone\\TZ01_0', CurrentTemperature: 3432 },
  ]);
  const zones = parseWindowsThermalZones(json);
  assert.equal(zones.length, 2);
  assert.equal(zones[0].celsius, 50.1);
  assert.equal(zones[1].celsius, 70.1);
});

test('a machine that answers with nothing is not a temperature of zero', () => {
  for (const nothing of ['', '   ', 'null', 'not json at all', undefined]) {
    assert.deepEqual(parseWindowsThermalZones(nothing), [], `"${nothing}" is not a reading`);
  }
});

test('a zone reporting an impossible value is dropped, not drawn', () => {
  // 0 K is a sensor that is not wired to anything. 5000 K is not a laptop.
  const json = JSON.stringify([
    { InstanceName: 'TZ00', CurrentTemperature: 0 },
    { InstanceName: 'TZ01', CurrentTemperature: 50000 },
    { InstanceName: 'TZ02', CurrentTemperature: 3232 },
  ]);
  const zones = parseWindowsThermalZones(json);
  assert.equal(zones.length, 1, 'only the believable one survives');
  assert.equal(zones[0].label, 'TZ02');
});

// --- A sensor program's tree -------------------------------------------------

/// The shape LibreHardwareMonitor serves at /data.json: machine, then chip,
/// then sensor type, then the readings — with the unit inside the value.
const SENSOR_TREE = {
  Text: 'Sensor',
  Children: [
    {
      Text: 'DESKTOP-ABC',
      Children: [
        {
          Text: 'Intel Core i7-1165G7',
          Children: [
            {
              Text: 'Temperatures',
              Children: [
                { Text: 'CPU Core #1', Value: '45.0 °C', Children: [] },
                { Text: 'CPU Package', Value: '61.5 °C', Children: [] },
              ],
            },
            {
              Text: 'Load',
              Children: [{ Text: 'CPU Total', Value: '12.4 %', Children: [] }],
            },
            {
              Text: 'Voltages',
              Children: [{ Text: 'CPU Core', Value: '0.812 V', Children: [] }],
            },
          ],
        },
        {
          Text: 'Generic Memory',
          Children: [{ Text: 'Load', Children: [{ Text: 'Memory', Value: '48.2 %', Children: [] }] }],
        },
      ],
    },
  ],
};

test('temperatures are picked out of a tree that also holds loads and voltages', () => {
  // The trap: everything in this document is a node with a Text and a Value,
  // and a CPU load of 12.4 drawn as 12.4°C would look entirely plausible.
  const sensors = parseSensorTree(SENSOR_TREE);
  assert.equal(sensors.length, 2, 'two temperatures, not five readings');
  assert.deepEqual(
    sensors.map((s) => s.celsius).sort((a, b) => a - b),
    [45, 61.5],
  );
});

test('a sensor is labelled with the chip it belongs to', () => {
  // "CPU Core #1" alone is ambiguous on a machine with two processors, and
  // the grouping node is not part of anything's name.
  const sensors = parseSensorTree(SENSOR_TREE);
  assert.equal(sensors[0].label, 'Intel Core i7-1165G7 CPU Core #1');
  assert.ok(!sensors[0].label.includes('Temperatures'));
});

test('a comma decimal separator is read, not truncated', () => {
  // Which is what a machine set to a European locale sends.
  const [sensor] = parseSensorTree({ Text: 'CPU', Value: '45,5 °C', Children: [] });
  assert.equal(sensor.celsius, 45.5);
});

test('a value that is not a temperature is left alone', () => {
  for (const value of ['45.0 %', '1200 RPM', '0.9 V', '45.0', '', 'hot']) {
    assert.deepEqual(parseSensorTree({ Text: 'x', Value: value, Children: [] }), [], `"${value}"`);
  }
});

test('nothing, or something that is not a tree, is no temperatures', () => {
  assert.deepEqual(parseSensorTree(null), []);
  assert.deepEqual(parseSensorTree('a string'), []);
  assert.deepEqual(parseSensorTree({}), []);
});

// --- Reaching a sensor program -----------------------------------------------

test('a sensor program that is not running is reported in words', async () => {
  const result = await readSensorService('http://127.0.0.1:1/data.json');
  assert.deepEqual(result.sensors, []);
  assert.match(result.reason, /Check the sensor program is running/i);
});

test('an address that is not a web address is refused before anything is fetched', async () => {
  for (const bad of ['file:///etc/passwd', 'not a url', 'ftp://host/data.json']) {
    const result = await readSensorService(bad);
    assert.deepEqual(result.sensors, []);
    assert.match(result.reason, /not a web address/i, bad);
  }
});

test('no address configured is not an error to report', async () => {
  // Nothing was asked for, so there is nothing to complain about — the
  // machine's own reason for having no sensors is the one worth showing.
  const result = await readSensorService('');
  assert.deepEqual(result.sensors, []);
  assert.equal(result.reason, null);
});

test('a running sensor program is read', async () => {
  const http = await import('node:http');
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(SENSOR_TREE));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  try {
    const url = `http://127.0.0.1:${server.address().port}/data.json`;
    const result = await readSensorService(url);
    assert.equal(result.sensors.length, 2);
    assert.equal(result.source, 'Sensor program');
  } finally {
    server.close();
  }
});

test('a program that is running but reports no temperatures says exactly that', async () => {
  const http = await import('node:http');
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ Text: 'Sensor', Children: [] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  try {
    const result = await readSensorService(`http://127.0.0.1:${server.address().port}/data.json`);
    assert.deepEqual(result.sensors, []);
    assert.match(result.reason, /running but reported no temperatures/i);
  } finally {
    server.close();
  }
});

// --- Choosing between them ---------------------------------------------------

test('on a machine with nowhere to ask, nothing is claimed', async () => {
  resetTemperatureCache();
  const result = await readRemoteTemperature({ sensorUrl: '', environment: { kind: 'host' }, platform: 'linux' });
  assert.deepEqual(result.sensors, []);
  assert.equal(result.reason, null, 'nothing was tried, so there is nothing to explain');
});

test('every reason is kept, not just the last one', async () => {
  // Somebody who set up a sensor program and still sees nothing needs to know
  // it was tried and what it said.
  resetTemperatureCache();
  const result = await readRemoteTemperature({
    sensorUrl: 'http://127.0.0.1:1/data.json',
    environment: { kind: 'wsl' },
    platform: 'linux',
  });
  assert.deepEqual(result.sensors, []);
  assert.match(result.reason, /sensor program/i, 'the configured address was tried and failed');
});

test('changing the address takes effect at once, not a quarter of a minute later', async () => {
  // Caught by walking the whole path: with the cache keyed only on time,
  // pointing the portal at a sensor program appeared to do nothing for
  // fifteen seconds, which is long enough to conclude the setting is broken
  // and go looking for a bug that is not there.
  const http = await import('node:http');
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(SENSOR_TREE));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  try {
    resetTemperatureCache();
    const base = { environment: { kind: 'host' }, platform: 'linux' };

    // Nothing configured: nothing found, and that gets cached.
    const before = await readRemoteTemperature({ ...base, sensorUrl: '' });
    assert.deepEqual(before.sensors, []);

    // Configured a moment later. The cached miss must not be returned.
    const after = await readRemoteTemperature({
      ...base,
      sensorUrl: `http://127.0.0.1:${server.address().port}/data.json`,
    });
    assert.equal(after.sensors.length, 2, 'the new address is used immediately');
  } finally {
    server.close();
    resetTemperatureCache();
  }
});

test('a reading is cached, so a polling page does not shell out every time', async () => {
  // Spawning a Windows process from WSL costs most of a second. A page asking
  // every three seconds must not pay that every time.
  const http = await import('node:http');
  let hits = 0;
  const server = http.createServer((_req, res) => {
    hits += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(SENSOR_TREE));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  try {
    resetTemperatureCache();
    const url = `http://127.0.0.1:${server.address().port}/data.json`;
    const args = { sensorUrl: url, environment: { kind: 'host' }, platform: 'linux' };

    const first = await readRemoteTemperature(args);
    const second = await readRemoteTemperature(args);

    assert.equal(hits, 1, 'the second reading came from the cache');
    assert.deepEqual(first.sensors, second.sensors);
  } finally {
    server.close();
    resetTemperatureCache();
  }
});
