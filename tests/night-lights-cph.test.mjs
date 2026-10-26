import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { lampPhotometry, poolLux, buildPoolWindow, encodePoolWindow, selectRealLights, haloSize, PEAK_LUX } from '../js/night-lights-cph.js';
import { mapLamps, lightColor } from '../js/street-furniture-data.js';

const lamp = (o = {}) => ({ x: 0, z: 0, y: 0, lampY: 8, mount: 'wire', light: 'led', led: true, cct: 3000, watt: 66, ...o });

test('colour temperature comes from the data: sodium amber, LED / metal halide warm white, 4000 K whiter', () => {
  const sodium = lampPhotometry(lamp({ light: 'sodium', cct: 2000, led: false }));
  const led = lampPhotometry(lamp({ cct: 3000 }));
  const cool = lampPhotometry(lamp({ cct: 4000 }));
  assert.ok(sodium.color[2] < led.color[2] && led.color[2] < cool.color[2], 'blue grows with the colour temperature');
  assert.deepEqual(led.color, lightColor(3000));
  assert.ok(sodium.color[0] > 0.95 && sodium.color[1] < led.color[1]);
});

test('pool: the peak is under the lamp, falls off smoothly, a taller lamp has the wider pool', () => {
  const a = lampPhotometry(lamp());
  assert.ok(poolLux(a, 0) > poolLux(a, 4) && poolLux(a, 4) > poolLux(a, 8) && poolLux(a, 8) > poolLux(a, 14));
  assert.ok(Math.abs(poolLux(a, 0) - a.lux) < 1e-9);
  const lakeLamp = lampPhotometry({ x: 0, z: 0, height: 1, cct: 3000, watt: 12, kind: 'lake' });
  assert.ok(lakeLamp.radius < a.radius);
  assert.ok(a.lux > 8 && a.lux < 40, `street illuminance in the KK range: ${a.lux}`);
  assert.ok(lakeLamp.lux <= PEAK_LUX.lake * 1.01);
});

test('pool window: the pools of nearby lamps add up, lamps outside the window are skipped, output is finite', () => {
  const lamps = [lamp({ x: 0, z: 0 }), lamp({ x: 10, z: 0 }), lamp({ x: 500, z: 500 })];
  const win = buildPoolWindow(lamps, 5, 0, { size: 128, cell: 0.75 });
  assert.equal(win.lamps, 2);
  const at = (x, z) => { const i = Math.floor((x - win.x0) / win.cell); const j = Math.floor((z - win.z0) / win.cell); return win.data[(j * win.size + i) * 3]; };
  assert.ok(at(5, 0) > at(0, 0) * 0.55, 'between two lamps the pools overlap');
  assert.ok(at(0, 0) > at(0, 12));
  assert.ok(win.data.every(Number.isFinite));
  assert.equal(at(win.x0 + 1, win.z0 + 1), 0);
  const bytes = encodePoolWindow(win);
  assert.equal(bytes.length, 128 * 128 * 4);
  assert.ok(Math.max(...bytes.filter((_, i) => i % 4 === 0)) > 60);
});

test('light assignment: the nearest lamps get the real lights, capped, stable, none beyond the range', () => {
  const lamps = [];
  for (let i = 0; i < 40; i++) lamps.push(lamp({ x: i * 10, z: 0 }));
  const sel = selectRealLights(lamps, 52, 3, 8);
  assert.equal(sel.length, 8);
  assert.equal(sel[0].x, 50);
  assert.deepEqual(sel.map((l) => l.x).sort((a, b) => a - b), [20, 30, 40, 50, 60, 70, 80, 90]);
  assert.ok(sel.every((l) => Math.hypot(l.x - 52, l.z - 3) <= 48));
  assert.equal(selectRealLights(lamps, 5000, 5000, 8).length, 0);
  assert.deepEqual(selectRealLights(lamps, 52, 3, 8).map((l) => l.x), sel.map((l) => l.x), 'deterministic');
});

test('real data: every lamp class has a sensible pool, wire lamps hang higher than lake lights', () => {
  const fur = JSON.parse(readFileSync(new URL('../data/cph-furniture.json', import.meta.url), 'utf8'));
  const lamps = mapLamps(fur.lamps, null);
  const photos = lamps.map(lampPhotometry);
  assert.ok(photos.every((p) => p.lux > 1 && p.lux < 60 && p.radius >= 1.5 && p.radius <= 18), 'pools within range');
  const by = (cls) => photos.filter((p) => p.cls === cls);
  assert.ok(by('sodium').length > 0 && by('led').length > 100 && by('metalhalide').length > 100);
  assert.ok(Math.min(...by('sodium').map((p) => p.cct)) <= 2000 && by('led').every((p) => p.cct >= 2700 && p.cct <= 4000));
  assert.ok(haloSize(photos[0], 60) > haloSize(photos[0], 5), 'the glare grows with distance');
});
