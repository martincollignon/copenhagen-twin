import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDataBase, dataUrl, isRemoteBase, BUILD_DATA_BASE } from '../js/data-config.js';
import { openTileStore, tilesUrl } from '../js/tile-store.js';

test('default data base is the local ./data, a trailing slash is ignored', () => {
  assert.equal(BUILD_DATA_BASE, './data');
  assert.equal(resolveDataBase('', './data'), './data');
  assert.equal(resolveDataBase('?hooks', './data/'), './data');
  assert.equal(dataUrl('tex-look/a.webp', './data'), './data/tex-look/a.webp');
});

test('?data= overrides the build default', () => {
  assert.equal(resolveDataBase('?data=https://x.r2.dev/v1/&stream=300', './data'), 'https://x.r2.dev/v1');
  assert.equal(dataUrl('/tiles', 'https://x.r2.dev/v1'), 'https://x.r2.dev/v1/tiles');
  assert.ok(isRemoteBase('https://x.r2.dev/v1'));
  assert.ok(!isRemoteBase('./data'));
});

test('without a page the tile directory is ./data/tiles', () => {
  assert.equal(tilesUrl(), './data/tiles');
});

test('a remote tile store fetches index and layers under its base, city files via the index, cacheable', async () => {
  const seen = [];
  const base = 'https://x.r2.dev/v1/tiles';
  const docs = {
    [`${base}/index.json`]: { version: 'cph-tiles/1', tiles: { t1: { layers: { buildings: 5 } } }, city: { meta: '../city/meta.json' } },
    [`${base}/../city/post.json`]: { version: 'cph-post/1' }
  };
  const fetchImpl = async (url, opts) => { seen.push([String(url), opts?.cache]); const d = docs[url]; return d ? { ok: true, json: async () => d } : { ok: false, status: 404 }; };
  const store = await openTileStore({ baseUrl: base, fetchImpl });
  assert.ok(store);
  assert.equal(store.cityUrl('far.bin'), `${base}/../city/far.bin`);
  assert.ok(seen.every(([u]) => u.startsWith('https://x.r2.dev/v1/')));
  assert.equal(seen.find(([u]) => u.endsWith('post.json'))[1], 'default');
});

test('hero models are requested only by a local build (they are never published), ?heroes= overrides', async () => {
  const { heroesEnabled } = await import('../js/data-config.js');
  assert.equal(heroesEnabled('', './data'), true);
  assert.equal(heroesEnabled('?data=https://x.r2.dev/v3', './data'), true, 'a local checkout testing the R2 data still has its linked hero');
  assert.equal(heroesEnabled('', 'https://x.r2.dev/v3'), false, 'the Pages build');
  assert.equal(heroesEnabled('?heroes=1', 'https://x.r2.dev/v3'), true);
  assert.equal(heroesEnabled('?heroes=0', './data'), false);
});
