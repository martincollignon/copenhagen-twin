# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy", "rasterio", "scipy", "shapely>=2", "laspy[lazrs]"]
# ///
"""Cached-only tree enrichment. Run after furniture.py: python3 tools/cph-geodata/tree_canopy.py.

Uses ortho.py's CIR/class-5 method at 1 m (the native class-count resolution).
Never fetches or changes raw inputs. --height-cache may point to a writable scratch
file; derived caches default to .context/ and raw inputs remain read-only.
"""
from __future__ import annotations
import argparse
from collections import Counter
import json
import math
from pathlib import Path

import numpy as np
import rasterio
from rasterio.features import rasterize
from rasterio.transform import from_origin
from rasterio.warp import reproject, Resampling
from scipy import ndimage
from scipy.spatial import cKDTree
from shapely.geometry import Point, Polygon
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / 'data/raw'
ORIGIN = (723900, 6176500)
LIDAR = 'dhm:punktsky:class5'
CIR = 'geodanmark:orto_foraar_cir:2025-04-27'
METHOD = 'ortho-cir/1'
SIZE = 1500
TRANSFORM = from_origin(723150, 6177250, 1, 1)


def polygon(record):
    r = record['ring']
    return Polygon(list(zip(r[::2], r[1::2])), [list(zip(h[::2], h[1::2])) for h in record.get('holes', [])]).buffer(0)


def burn(polygons):
    # This local-frame grid has z increasing downward, just like raster rows.
    from affine import Affine
    shapes = [(p, 1) for p in polygons if not p.is_empty]
    return rasterize(shapes, out_shape=(SIZE, SIZE), transform=Affine(1, 0, -750, 0, 1, -750), dtype='uint8').astype(bool) if shapes else np.zeros((SIZE, SIZE), bool)


def raster(paths, band=1, average=False):
    out = np.zeros((SIZE, SIZE), 'float32')
    for path in paths:
        with rasterio.open(path) as src:
            a = np.zeros_like(out)
            reproject(rasterio.band(src, band), a, src_transform=src.transform, src_crs=src.crs,
                      dst_transform=TRANSFORM, dst_crs='EPSG:25832', dst_nodata=0,
                      resampling=Resampling.average if average else Resampling.nearest)
            out = np.maximum(out, a)
    return out


def canopy_masks(geo, lakes):
    water = burn([polygon(p) for p in lakes['lakes'] + lakes.get('ponds', [])])
    buildings = burn([polygon(b) for b in geo['buildings']])
    lidar_paths = sorted((RAW / 'veg').glob('c5_*.tif'))
    high = raster(lidar_paths) >= 1
    cir_path = RAW / 'ortho/district_cir_2025.tif'
    canopy = np.zeros_like(high)
    threshold = None
    if cir_path.exists():
        from ortho import otsu
        nir, red = raster([cir_path], 1, True), raster([cir_path], 2, True)
        ndvi = (nir - red) / np.maximum(nir + red, 1)
        threshold = otsu(ndvi[~water & (red > 30)])
        green = ndvi > threshold
        # Without height evidence NDVI could be a lawn: never invent trees from it alone.
        canopy = green & (ndimage.binary_dilation(high) if lidar_paths else True) & ~water & ~buildings
    return high & ~water & ~buildings, canopy, threshold


def height_grid(cache):
    """Class-5 surface minus nearby class-2 ground; no building returns in canopy heights."""
    if cache.exists():
        with np.load(cache) as d:
            return d['height']
    paths = sorted((RAW / 'lod2').glob('PUNKTSKY_*.laz'))
    if not paths:
        return None
    import laspy
    top = np.full(SIZE * SIZE, -np.inf, 'float32')
    ground = np.full(SIZE * SIZE, np.inf, 'float32')
    for path in paths:
        print('height returns:', path.name, flush=True)
        with laspy.open(path) as reader:
            for points in reader.chunk_iterator(1_000_000):
                cls = np.asarray(points.classification)
                x, z = np.asarray(points.x) - ORIGIN[0], ORIGIN[1] - np.asarray(points.y)
                ok = (x >= -750) & (x < 750) & (z >= -750) & (z < 750) & ((cls == 2) | (cls == 5))
                c, r = (x[ok] + 750).astype(int), (z[ok] + 750).astype(int)
                idx, v, cl = r * SIZE + c, np.asarray(points.z)[ok], cls[ok]
                np.maximum.at(top, idx[cl == 5], v[cl == 5])
                np.minimum.at(ground, idx[cl == 2], v[cl == 2])
    ground, top = ground.reshape(SIZE, SIZE), top.reshape(SIZE, SIZE)
    known = np.isfinite(ground)
    if not known.any():
        return None
    distance, nearest = ndimage.distance_transform_edt(~known, return_indices=True)
    heights = top - ground[tuple(nearest)]
    heights[(distance > 12) | ~np.isfinite(top) | (heights < 2) | (heights > 40)] = np.nan
    cache.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(cache, height=heights)
    return heights


def enrich(doc, geo, lakes, surfaces, height_cache):
    # Preserve the input on each tree, so reruns are idempotent and corrections reversible.
    existing = []
    for record in doc['trees']:
        if record.get('canopy_added') == METHOD:
            continue
        t = dict(record)
        prior = t.pop('canopy_original', None)
        if prior:
            t.update(prior)
        for k in ('crown_measurement', 'leaf_apr', 'lakeside', 'litter_points', 'litter_origin'):
            t.pop(k, None)
        existing.append(t)
    high, canopy, threshold = canopy_masks(geo, lakes)
    coords = np.array([[t['x'], t['z']] for t in existing])
    kd = cKDTree(coords)
    rr, cc = np.indices(high.shape)
    centres = np.column_stack((cc.ravel() - 749.5, rr.ravel() - 749.5))
    dist, owner = kd.query(centres)
    assigned = dist <= 9
    lidar_area = np.bincount(owner[assigned & high.ravel()], minlength=len(existing))
    ortho_area = np.bincount(owner[assigned & canopy.ravel()], minlength=len(existing))
    close = dist <= 2.5
    leaf = np.bincount(owner[close & canopy.ravel()], minlength=len(existing)) / np.maximum(1, np.bincount(owner[close], minlength=len(existing)))
    near_dist = kd.query(coords, k=2)[0][:, 1]
    measured, scaled = 0, 0
    for i, t in enumerate(existing):
        t['canopy_original'] = {k: t.get(k) for k in ('height', 'crown_radius', 'genus', 'conf_fields', 'src')}
        t['conf_fields'] = dict(t.get('conf_fields') or {})
        t['src'] = list(t['src'])
        old = t['crown_radius']
        r = math.sqrt(lidar_area[i] / math.pi)
        source, area = LIDAR, int(lidar_area[i])
        # CIR is only a sizing fallback for a leafed tree, never a reason to shrink a bare one.
        if area < 12 and leaf[i] >= 0.5 and ortho_area[i] >= 12:
            area, source = int(ortho_area[i]), CIR
            r = math.sqrt(area / math.pi)
        if area >= 12:
            isolated = near_dist[i] > 1.5 * r
            # Voronoi shares are noisy in rows. Use a bounded 25% correction there,
            # retaining the measured footprint separately instead of claiming an exact crown.
            corrected = r if isolated else old * np.clip(r / old, 0.8, 1.25)
            t['crown_radius'] = round(float(np.clip(corrected, 0.9, 9)), 2)
            conf = 'measured' if isolated else 'scaled'
            t['conf_fields']['crown_radius'] = conf
            t['crown_measurement'] = {'radius': round(r, 2), 'area': area, 'src': [source], 'conf': 'measured', 'method': 'nearest trunk share, 9 m cap', 'isolated': bool(isolated)}
            if source not in t['src']:
                t['src'].append(source)
            measured += isolated
            scaled += not isolated
        if threshold is not None:
            t['leaf_apr'] = round(float(leaf[i]), 3)
            t['conf_fields']['leaf_apr'] = 'observed'
            if CIR not in t['src']:
                t['src'].append(CIR)
    unclaimed = canopy & ndimage.binary_dilation(high) & (dist.reshape(high.shape) > 9)
    labels, _ = ndimage.label(ndimage.binary_opening(unclaimed, structure=np.ones((2, 2))))
    slices = ndimage.find_objects(labels)
    heights = height_grid(height_cache) if unclaimed.any() else None
    added = []
    for label, sl in enumerate(slices, 1):
        if sl is None:
            continue
        mask = labels[sl] == label
        area = int(mask.sum())
        if area < 12:
            continue
        rows, cols = np.nonzero(mask)
        # A centroid of a crescent can sit in a building or within the exclusion disc.
        # Choose the interior pixel closest to the centroid, not the centroid itself.
        order = np.argsort((rows - rows.mean()) ** 2 + (cols - cols.mean()) ** 2, kind='stable')
        row, col = int(rows[order[0]] + sl[0].start), int(cols[order[0]] + sl[1].start)
        x, z = col - 749.5, row - 749.5
        if kd.query([x, z])[0] <= 9:
            continue
        radius = round(min(9, math.sqrt(area / math.pi)), 2)
        values = heights[sl][mask] if heights is not None else np.array([])
        values = values[np.isfinite(values)]
        h = float(np.percentile(values, 95)) if len(values) >= 4 else max(6, min(18, radius * 2.8))
        added.append({'x': x, 'z': z, 'height': round(h, 1), 'crown_radius': radius, 'genus': 'generic',
                      'species': None, 'name': None, 'age': None, 'category': None, 'canopy_added': METHOD,
                      'canopy_area': area, 'src': [CIR, LIDAR], 'conf': 'observed',
                      'conf_fields': {'genus': 'inferred', 'height': 'measured' if len(values) >= 4 else 'inferred', 'crown_radius': 'measured'},
                      'height_method': 'class5 surface p95 minus nearby class2 ground' if len(values) >= 4 else 'crown ratio',
                      'licence': 'Klimadatastyrelsen frie data'})
    all_trees = existing + added
    lake_shapes = [polygon(p) for p in lakes['lakes']]
    shore = unary_union([p.boundary for p in lake_shapes])
    water_shapes = lake_shapes + [polygon(p) for p in lakes.get('ponds', [])]
    water = unary_union(water_shapes)
    pavement = unary_union([polygon(p) for p in geo['sidewalks']] + [polygon(p) for p in surfaces['surfaces'] if p['cls'] in ('gravel', 'cobbles', 'setts', 'kbh_fortov')])
    blocked = unary_union([polygon(b) for b in geo['buildings']] + water_shapes)
    pavement = pavement.difference(blocked)
    for i, t in enumerate(all_trees):
        pos = Point(t['x'], t['z'])
        t['lakeside'] = not water.contains(pos) and shore.distance(pos) <= 24
        t['conf_fields']['lakeside'] = 'inferred'
        if t['lakeside']:
            if t['genus'] == 'generic' and not t.get('species'):
                t['genus'] = 'chestnut'
                t['conf_fields']['genus'] = 'inferred'
            if t['conf_fields'].get('height') == 'inferred':
                t['height'] = min(20, max(16, t['height']))
        if t['genus'] not in ('chestnut', 'lime'):
            continue
        rng = np.random.default_rng(i + 6176500)
        points = []
        # One tiny quad per spray, selected on known hard ground only. No water/roof/garden litter.
        for _ in range(min(180, round(math.pi * t['crown_radius'] ** 2 * 2.5))):
            a, radius = rng.random() * math.tau, math.sqrt(rng.random()) * t['crown_radius']
            x, z = t['x'] + math.cos(a) * radius, t['z'] + math.sin(a) * radius
            if pavement.contains(Point(x, z)):
                points.extend((round(x - t['x'], 2), round(z - t['z'], 2)))
        if points:
            t['litter_points'] = points
            t['litter_origin'] = [t['x'], t['z']]
            t['conf_fields']['litter_points'] = 'inferred'
    doc['trees'] = all_trees
    doc['stats']['trees'] = len(all_trees)
    doc['stats']['tree_genera'] = dict(Counter(t['genus'] for t in all_trees))
    doc['tree_canopy'] = {
        'method': METHOD, 'input_trees': len(existing), 'added_trees': len(added), 'total_trees': len(all_trees),
        'crown_measured': int(measured), 'crown_scaled': int(scaled), 'crown_unchanged': len(existing) - int(measured + scaled),
        'original_radius_median': float(np.median([t['canopy_original']['crown_radius'] for t in existing])),
        'corrected_radius_median': float(np.median([t['crown_radius'] for t in existing])),
        'lidar_radius_median': round(float(np.median(np.sqrt(lidar_area / math.pi))), 2),
        'ndvi_threshold': round(threshold, 4) if threshold is not None else None,
        'height_measured': sum(t['conf_fields']['height'] == 'measured' for t in added),
        'lakeside_trees': sum(t['lakeside'] for t in all_trees),
        'notes': ['One observed tree per unclaimed patch >=12 m2; this is a conservative count, not 1000 fabricated stems.',
                  'April NDVI is not used to shrink bare late-leafing genera.',
                  'No WCS DSM/DTM cached; heights use cached class-5/class-2 LAZ returns where available.',
                  '1 m class-count grid; building and water masks exclude roofs and lake pixels.']
    }
    attribution = 'Indeholder data fra Klimadatastyrelsen (GeoDanmark ortofoto forår 2025 og DHM Punktsky)'
    if attribution not in doc['attribution']:
        doc['attribution'].append(attribution)
    doc['stats']['attribution'] = len(doc['attribution'])
    doc['licences']['Klimadatastyrelsen frie data'] = 'Klimadatastyrelsen free geographic data; attribution in attribution[]'
    return doc


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--height-cache', type=Path, default=ROOT / '.context/tree-heights.npz')
    ap.add_argument('--output', type=Path, default=ROOT / 'data/cph-furniture.json')
    args = ap.parse_args()
    load = lambda name: json.loads((ROOT / f'data/{name}.json').read_text())
    doc = enrich(load('cph-furniture'), load('cph-geodata'), load('cph-lakes'), load('cph-surfaces'), args.height_cache)
    args.output.write_text(json.dumps(doc, ensure_ascii=False, separators=(',', ':')) + '\n')
    print(json.dumps(doc['tree_canopy'], indent=2))


if __name__ == '__main__':
    main()
