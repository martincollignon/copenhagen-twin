import assert from 'node:assert/strict';
import test from 'node:test';
import { WINDOW, FRAME_COLOURS, windowStyle, windowOccupancy, facadeStyle, MAT, ERA } from '../js/facade-style.js';
import { roofColourFor, createAccumulator, addBuilding } from '../js/building-geometry.js';
import { describeAppearance, srgbToLinear, texturedWalls } from '../js/appearance.js';

const building = (extra = {}) => ({
  id: 'gdk:1000000042', year: 1890, storeys: 5, ring: [0, 0, 20, 0, 20, -10, 0, -10], ground: 0, eave: 15,
  ridge: 19, roof: 'pitched', wall_material: 'mursten', roof_material: 'tegl',
  facade: { floor_h: 3, ground_floor_h: 3, bay_w: 2.9, window_w: 1.15, tone: [0.7, 0.4, 0.3] }, ...extra
});
const linearToSrgb = (v) => v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;

test('frame colour is deterministic per building, 60–70% white over 1000 buildings; metric dimensions stay bounded', () => {
  let white = 0;
  for (let i = 0; i < 1000; i++) {
    const b = building({ id: `gdk:${1000000000 + i}` });
    const style = windowStyle(b);
    if (style.frame === 0) white++;
    assert.equal(style.colour, FRAME_COLOURS[style.frame]);
    assert.deepEqual(windowStyle({ ...b, facade: { tone: [0.8, 0.8, 0.8] } }), style);
    assert.ok(style.frameWidth >= 0.07 && style.frameWidth <= 0.10);
    assert.ok(style.reveal >= 0.10 && style.reveal <= 0.18);
  }
  assert.ok(white >= 600 && white <= 700, `${white}/1000 white`);
  assert.equal(WINDOW.transom, 0.68);
});

test('window divisions follow the BBR era without changing the building frame paint', () => {
  const early = windowStyle(building());
  const small = windowStyle(building({ year: 1920 }));
  const funkis = windowStyle(building({ year: 1935 }));
  assert.ok([0, 1].includes(early.type));
  assert.equal(small.type, 2);
  assert.equal(funkis.type, 3);
  assert.equal(early.colour, funkis.colour);
});

test('main material/era codes and observed tones survive the window port; every wall shares one frame style', () => {
  const b = building({ observed: { walls: [
    { ring: 0, edge: 0, tone: [0.9, 0.9, 0.85], conf: 'observed' },
    { ring: 0, edge: 1, tone: [0.65, 0.32, 0.2], conf: 'observed' }
  ] } });
  const before = structuredClone(b);
  const acc = createAccumulator();
  const added = addBuilding(acc, b);
  assert.equal(added.style.era, ERA.historic);
  assert.equal(acc.wall.facadeWindow.length, acc.wall.position.length / 3 * 4);
  const { frame, type, frameWidth, reveal } = windowStyle(b);
  for (let i = 0; i < acc.wall.facadeWindow.length; i += 4) {
    assert.deepEqual(acc.wall.facadeWindow.slice(i, i + 4), [frame + 4 * type, 65535, frameWidth, reveal]); // x packs frame and type, y the ground-floor bay mask
    assert.equal(acc.wall.facadeBldg[i + 2], added.style.code);
  }
  assert.notDeepEqual(acc.wall.facadeTone.slice(0, 3), acc.wall.facadeTone.slice(16, 19));
  assert.equal(facadeStyle({ wall_material: 'mursten', year: 1890 }, [0.9, 0.9, 0.9]).mat, MAT.plaster);
  assert.equal(facadeStyle({ wall_material: 'mursten', year: 1890 }, [0.5, 0.25, 0.2]).mat, MAT.brick);
  assert.deepEqual(b, before);
});

test('dark pitched roof albedo is bounded and hue-preserving; flat roofs and metals keep main colours', () => {
  const b = building({ observed: { roof: { conf: 'observed', type_hint: 'slate', tone: [0.55, 0.58, 0.62] } } });
  const before = structuredClone(b);
  const rgb = roofColourFor(b, true, true).slice(0, 3).map(linearToSrgb);
  assert.ok(Math.abs(rgb[0] / rgb[2] - 0.55 / 0.62) < 1e-10);
  assert.ok(Math.abs(rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722 - 0.26) < 1e-10);
  assert.deepEqual(roofColourFor(b, true, false).slice(0, 3), b.observed.roof.tone.map(srgbToLinear));
  for (const type_hint of ['copper', 'metal', 'tile', 'green', 'solar']) {
    const other = { ...b, observed: { roof: { ...b.observed.roof, type_hint } } };
    assert.deepEqual(roofColourFor(other, true, true).slice(0, 3), b.observed.roof.tone.map(srgbToLinear));
  }
  assert.deepEqual(roofColourFor(building(), false, true).slice(0, 3), [0.46, 0.19, 0.13].map(srgbToLinear), 'main tile default wins');
  assert.deepEqual(b, before);
});

test('roof correction uses the generated roof pitch, not a pitched label on a flat concave fallback', () => {
  const b = building({ ring: [0, 0, 20, 0, 20, -8, 8, -8, 8, -20, 0, -20],
    observed: { roof: { conf: 'observed', type_hint: 'slate', tone: [0.6, 0.6, 0.6] } } });
  const acc = createAccumulator();
  addBuilding(acc, b);
  assert.deepEqual(acc.roof.color.slice(0, 3), [0.6, 0.6, 0.6].map(srgbToLinear));
});

test('occupied window share peaks in the existing evening presets and falls late at night', () => {
  assert.equal(windowOccupancy(0.24), 0.12);
  assert.equal(windowOccupancy(0.48), 0.50);
  assert.equal(windowOccupancy(1.25), 0.50);
  assert.ok(Math.abs(windowOccupancy(1.55) - 0.10) < 1e-10);
  for (let glow = 0; glow <= 2; glow += 0.01) assert.ok(windowOccupancy(glow) >= 0.099 && windowOccupancy(glow) <= 0.501);
});

test('photo wall positions, masks and UV mapping are unchanged when physical facade details are enabled', () => {
  const b = building({ observed: {
    walls: [{ ring: 0, edge: 0, tone: [0.7, 0.6, 0.5], conf: 'observed', filled_frac: 0 }],
    atlas: { file: 'tex/test.jpg', size: [128, 128], walls: [{ ring: 0, edge: 0, uv: [0, 0, 1, 1], h_m: 15, filled_frac: 0 }] }
  } });
  const capture = (details) => {
    const acc = createAccumulator(), quads = [];
    const added = addBuilding(acc, b, { details, streetEdges: [true, false, false, false], quads });
    return { walls: texturedWalls(b, quads, added.mapping), acc };
  };
  const before = capture(false), after = capture(true);
  assert.ok(before.walls && after.acc.detailParts.length);
  assert.deepEqual(after.walls, before.walls);
  assert.deepEqual(after.acc.wall.position, before.acc.wall.position);
  assert.equal(after.acc.roofRanges.length, before.acc.roofRanges.length);
});

test('decorative geometry is identified as inferred instead of inheriting a measured roof or wall colour', () => {
  const source = describeAppearance(building(), 'detail', { x: 5, z: 0 });
  assert.equal(source.detail.kind, 'inferred');
  assert.equal(source.wall, null);
  assert.equal(source.roof, null);
});
