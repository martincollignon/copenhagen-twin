// Which tile set the district assertions run on: CPH_TILES (a directory under the repo, e.g. .context/c2-tiles/tiles, made with
//   uv run tools/cph-geodata/tile_split.py --out .context/c2-tiles/tiles --city .context/c2-tiles/city)
// or data/tiles when it holds the 16 consistent district tiles. A citywide build in data/tiles (milestone C3+), or one that is half
// regenerated, is not the district: the tests that compare tiles with the monolithic district files are skipped for it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const TILES = process.env.CPH_TILES || 'data/tiles';
export const TILES_URL = `./${TILES}`;

export const isDistrict = (() => {
  try {
    const i = JSON.parse(fs.readFileSync(path.join(ROOT, TILES, 'index.json'), 'utf8'));
    if (Object.keys(i.tiles).length !== 16 || i.frame.bbox[2] !== 750) return false;
    const meta = JSON.parse(fs.readFileSync(path.join(ROOT, TILES, i.city.meta), 'utf8'));
    for (const id of Object.keys(i.tiles)) {
      const t = JSON.parse(fs.readFileSync(path.join(ROOT, TILES, id, 'terrain.json'), 'utf8'));
      if (t.chunk && (t.chunk.x0 < meta.terrain.bbox[0] || t.chunk.z0 < meta.terrain.bbox[1])) return false;
    }
    return true;
  } catch { return false; }
})();
