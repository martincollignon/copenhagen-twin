import test from 'node:test';
import assert from 'node:assert/strict';
import { streamConfig, ringFor, distanceToRect, wantedTiles, neighbourIds, layerDemand, planStreaming, extentOfTiles, RING_LAYERS, CONTEXT_LAYERS, DEFAULT_STREAM } from '../js/tile-rings.js';
import { tileBoundsLocal, tileOfLocal } from '../js/tile-grid.js';

const cfg = streamConfig();
// a 5 x 5 block of tiles around the origin tile
const centre = tileOfLocal(0, 0);
const [ie, in_] = centre.split('_').map(Number);
const ids = [];
for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) ids.push(`${ie + a}_${in_ + b}`);
const tiles = ids.map((id) => ({ id, bounds: tileBoundsLocal(id) }));
const exists = (id) => ids.includes(id);

test('stream config defaults and ?stream=<near>', () => {
  assert.deepEqual({ ...cfg }, { near: 750, mid: 2500, hysteresis: 250, maxConcurrent: 4, maxBuilds: 1 });
  assert.equal(streamConfig({ maxBuilds: 2 }).maxBuilds, 2);
  const c = streamConfig({ near: 300 });
  assert.equal(c.near, 300);
  assert.equal(c.mid, 1000);
  assert.equal(c.hysteresis, 100);
  assert.throws(() => streamConfig({ near: 0 }));
  assert.throws(() => streamConfig({ near: 500, mid: 100 }));
});

test('distance to a rectangle is 0 inside and euclidean outside', () => {
  const r = [0, 0, 100, 100];
  assert.equal(distanceToRect(50, 50, r), 0);
  assert.equal(distanceToRect(130, 50, r), 30);
  assert.equal(distanceToRect(103, 104, r), 5);
});

test('ringFor: enter at the radius, leave at radius + hysteresis', () => {
  assert.equal(ringFor(700, null, cfg), 'near');
  assert.equal(ringFor(751, null, cfg), 'mid');
  assert.equal(ringFor(900, 'near', cfg), 'near'); // inside near + 250: stays
  assert.equal(ringFor(1001, 'near', cfg), 'mid'); // beyond: drops to mid
  assert.equal(ringFor(2400, null, cfg), 'mid');
  assert.equal(ringFor(2600, null, cfg), null); // not yet loaded: not loaded
  assert.equal(ringFor(2600, 'mid', cfg), 'mid'); // loaded: stays until mid + hysteresis
  assert.equal(ringFor(2751, 'mid', cfg), null);
  assert.equal(ringFor(2751, 'near', cfg), null);
  assert.equal(ringFor(740, 'mid', cfg), 'near'); // a mid tile that gets close is promoted
});

test('a camera jittering on the ring edge does not load and unload', () => {
  const current = new Map();
  let flips = 0;
  let prev = null;
  for (let i = 0; i < 200; i++) {
    const d = 2500 + Math.sin(i) * 120; // wobbles across the mid radius
    const ring = ringFor(d, current.get('t') ?? null, cfg);
    if (ring) current.set('t', ring); else current.delete('t');
    if (ring !== prev) flips++;
    prev = ring;
  }
  assert.ok(flips <= 2, `flips ${flips}`);
});

test('wantedTiles: rings by distance to the tile rectangle', () => {
  const c = streamConfig({ near: 300 });
  const w = wantedTiles({ x: 0, z: 0 }, tiles, new Map(), c);
  assert.equal(w.get(centre).ring, 'near');
  assert.equal(w.get(centre).d, 0);
  for (const [id, { ring, d }] of w) {
    if (ring === 'near') assert.ok(d <= 300);
    else assert.ok(d > 300 && d <= 1000, `${id} ${d}`);
  }
  // some tiles of the 5 x 5 block are beyond mid
  assert.ok(w.size < tiles.length);
});

test('moving the camera: tiles left behind keep their ring until radius + hysteresis', () => {
  const c = streamConfig({ near: 300 });
  const current = new Map();
  let w = wantedTiles({ x: 0, z: 0 }, tiles, current, c);
  for (const [id, { ring }] of w) current.set(id, ring);
  const nearBefore = [...w].filter(([, v]) => v.ring === 'near').map(([id]) => id);
  // step 50 m: nothing near is dropped yet
  w = wantedTiles({ x: 50, z: 0 }, tiles, current, c);
  for (const id of nearBefore) assert.ok(w.has(id));
  // far away: everything near before has left
  w = wantedTiles({ x: 3000, z: 3000 }, tiles, current, c);
  for (const id of nearBefore) assert.ok(!w.has(id) || w.get(id).ring !== 'near');
});

test('neighbours and the layer demand', () => {
  assert.equal(neighbourIds(centre, exists).length, 8);
  const corner = ids[0];
  assert.equal(neighbourIds(corner, exists).length, 3);
  const wanted = new Map([[centre, { ring: 'near', d: 0 }]]);
  const demand = layerDemand(wanted, exists);
  assert.deepEqual([...demand.get(centre)].sort(), [...RING_LAYERS.near].sort());
  const [n] = neighbourIds(centre, exists);
  assert.deepEqual([...demand.get(n)].sort(), [...CONTEXT_LAYERS.near].sort());
  assert.equal(demand.size, 9);
  // a mid tile asks little of its neighbours
  const dm = layerDemand(new Map([[centre, { ring: 'mid', d: 900 }]]), exists);
  assert.deepEqual([...dm.get(n)].sort(), [...CONTEXT_LAYERS.mid].sort());
});

test('planStreaming: loads nearest first, rebuilds on a ring change, unbuilds, releases, aborts', () => {
  const [a, b, c2, d] = ids;
  const wanted = new Map([[a, { ring: 'mid', d: 900 }], [b, { ring: 'near', d: 100 }], [c2, { ring: 'near', d: 20 }], [d, { ring: 'near', d: 5 }]]);
  const built = new Map([[d, 'mid'], ['gone', 'near']]);
  const demand = layerDemand(wanted, exists);
  const plan = planStreaming({
    wanted, demand, built, building: new Set(), fetching: new Set(['stale']), held: new Set([a, 'orphan']),
    ready: (id) => id !== b // b's data has not arrived
  });
  assert.deepEqual(plan.build.map((x) => x.id), [c2, a]); // nearest near first, then mid; b is not ready
  assert.deepEqual(plan.rebuild.map((x) => `${x.id}:${x.ring}`), [`${d}:near`]);
  assert.deepEqual(plan.unbuild, ['gone']);
  assert.deepEqual(plan.release, ['orphan']);
  assert.deepEqual(plan.abort, ['stale']);
  // a tile being built is not started twice, and not unbuilt under the builder
  const again = planStreaming({ wanted: new Map(), demand: new Map(), built: new Map([[a, 'near']]), building: new Set([a]), held: new Set(), ready: () => true });
  assert.deepEqual(again.unbuild, []);
});

test('extentOfTiles unites the tile rectangles', () => {
  const e = extentOfTiles(ids);
  assert.equal(e[2] - e[0], 5 * 500);
  assert.equal(e[3] - e[1], 5 * 500);
  assert.equal(extentOfTiles([]), null);
});

test('defaults are the plan: near 750 m, mid 2.5 km, hysteresis 250 m', () => {
  assert.deepEqual({ ...DEFAULT_STREAM }, { near: 750, mid: 2500, hysteresis: 250 });
});
