#!/usr/bin/env python3
"""Detail-override source sets -> the twin's per-tile `overrides` layer (docs/detail-overrides.md).

A source set is a directory with overrides.json (cph-detail-source/1) and the GLBs it names (tools/overrides/nyhavn.py writes one). The
packed data (tools/hosting/build_packs.py --overrides) and the unpacked local layout (this script) are made from the same sets:

    python3 tools/overrides/publish.py install [--sets DIR ...] [--data data]   # unpacked: data/tiles/<id>/overrides.json + data/overrides/<set>/...
    python3 tools/overrides/publish.py uninstall [--data data]
    python3 tools/overrides/publish.py check [--sets DIR ...]                   # validate the sets (schema, files, hashes, collisions)

Default sets: every directory under ~/.local/share/cph-twin/overrides (or $CPH_OVERRIDES, colon separated) that holds an overrides.json.
Sets later in the list win a building claimed twice (reported).
"""
from __future__ import annotations

import argparse, hashlib, json, os, shutil, sys
from pathlib import Path

LAYER_FORMAT = 'cph-detail/1'
SOURCE_FORMAT = 'cph-detail-source/1'
DEFAULT_ROOT = Path.home() / '.local/share/cph-twin/overrides'
ROOT = Path(__file__).resolve().parents[2]


def default_sets():
    env = os.environ.get('CPH_OVERRIDES')
    roots = [Path(p).expanduser() for p in env.split(':')] if env else [DEFAULT_ROOT]
    out = []
    for r in roots:
        if (r / 'overrides.json').exists():
            out.append(r)
        elif r.is_dir():
            out += sorted(d for d in r.iterdir() if (d / 'overrides.json').exists())
    return out


def load_sets(dirs, log=print):
    """-> (buildings: { gdk id: (set name, set dir, entry) }, attribution: { key: {...} }, sets: [{ name, dir, buildings, generated }])"""
    buildings, attribution, sets = {}, {}, []
    for d in dirs:
        d = Path(d).expanduser()
        doc = json.loads((d / 'overrides.json').read_text())
        if doc.get('format') != SOURCE_FORMAT:
            raise SystemExit(f'{d}/overrides.json: format {doc.get("format")!r}, expected {SOURCE_FORMAT}')
        name = doc.get('name') or d.name
        for gid, e in doc['buildings'].items():
            if gid in buildings:
                log(f'overrides: {gid} is in both {buildings[gid][0]} and {name}; {name} wins')
            buildings[gid] = (name, d, e)
        for k, v in (doc.get('attribution') or {}).items():
            attribution.setdefault(k, v)
        sets.append({'name': name, 'dir': str(d), 'buildings': len(doc['buildings']), 'generated': doc.get('generated')})
    return buildings, attribution, sets


def check(buildings):
    """Problems of the loaded sets (missing or changed GLBs, bad entries): a list of strings."""
    errs = []
    for gid, (name, d, e) in buildings.items():
        if not e.get('tile'):
            errs.append(f'{gid}: no tile')
        m = e.get('mesh')
        if e.get('mode', 'replace') == 'replace':
            if not m or not m.get('path'):
                errs.append(f'{gid}: mode replace without a mesh')
                continue
            p = d / m['path']
            if not p.exists():
                errs.append(f'{gid}: {p} missing')
                continue
            b = p.read_bytes()
            if m.get('bytes') and len(b) != m['bytes']:
                errs.append(f'{gid}: {p} is {len(b)} bytes, the set says {m["bytes"]}')
            if m.get('sha256') and hashlib.sha256(b).hexdigest()[:len(m['sha256'])] != m['sha256']:
                errs.append(f'{gid}: {p} hash differs from the set')
            if b[:4] != b'glTF':
                errs.append(f'{gid}: {p} is not a GLB')
        elif not e.get('details'):
            errs.append(f'{gid}: neither a mesh nor details')
    return errs


def mesh_rel(set_name, e):
    """The data-base-relative path of an entry's GLB: overrides/<set>/<path in the set>."""
    return f'overrides/{set_name}/{e["mesh"]["path"]}'


def tile_payloads(buildings, attribution, generated=None):
    """{ tile id: (layer payload without `pack`, [(rel path, GLB bytes, centre (x, z))]) }"""
    out = {}
    for gid in sorted(buildings):
        name, d, e = buildings[gid]
        tid = e['tile']
        payload, meshes = out.setdefault(tid, ({'format': LAYER_FORMAT, 'tile': tid, 'generated': generated, 'attribution': {}, 'buildings': {}}, []))
        entry = {k: v for k, v in e.items() if k != 'tile'}
        if e.get('mesh'):
            rel = mesh_rel(name, e)
            entry['mesh'] = {**e['mesh'], 'path': rel}
            b = e.get('bounds') or [0, 0, 0, 0, 0, 0]
            meshes.append((rel, (d / e['mesh']['path']).read_bytes(), ((b[0] + b[3]) / 2, (b[2] + b[5]) / 2)))
        entry.setdefault('source', {})['set'] = name
        payload['buildings'][gid] = entry
        for k in e.get('attribution') or []:
            if k in attribution:
                payload['attribution'][k] = attribution[k]
    return out


def install(data: Path, sets):
    """The unpacked layout: data/tiles/<id>/overrides.json, data/overrides/<set>/<mesh path>, `overrides` in data/tiles/index.json."""
    buildings, attribution, info = load_sets(sets)
    errs = check(buildings)
    if errs:
        raise SystemExit('\n'.join(errs))
    uninstall(data, quiet=True)
    index_p = data / 'tiles/index.json'
    index = json.loads(index_p.read_text())
    n = 0
    for tid, (payload, meshes) in tile_payloads(buildings, attribution, generated=index.get('generated')).items():
        if tid not in index['tiles']:
            print(f'overrides: tile {tid} is not in the index; skipped')
            continue
        body = json.dumps(payload, separators=(',', ':'), ensure_ascii=False).encode()
        (data / 'tiles' / tid / 'overrides.json').write_bytes(body)
        index['tiles'][tid].setdefault('layers', {})['overrides'] = len(body)
        for rel, b, _ in meshes:
            p = data / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(b)
            n += 1
    tmp = index_p.with_suffix('.json.tmp')
    tmp.write_text(json.dumps(index, separators=(',', ':')))
    os.replace(tmp, index_p)
    print(f'installed {len(buildings)} overrides ({n} meshes) from {[s["name"] for s in info]} into {data}')


def uninstall(data: Path, quiet=False):
    index_p = data / 'tiles/index.json'
    index = json.loads(index_p.read_text())
    k = 0
    for tid, t in index['tiles'].items():
        if t.get('layers', {}).pop('overrides', None) is not None:
            k += 1
        p = data / 'tiles' / tid / 'overrides.json'
        if p.exists():
            p.unlink()
    if (data / 'overrides').is_dir():
        shutil.rmtree(data / 'overrides')
    tmp = index_p.with_suffix('.json.tmp')
    tmp.write_text(json.dumps(index, separators=(',', ':')))
    os.replace(tmp, index_p)
    if not quiet:
        print(f'removed the overrides layer from {k} tiles of {data}')


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('cmd', choices=('install', 'uninstall', 'check'))
    ap.add_argument('--sets', nargs='*', default=None, help='source set directories (default: ~/.local/share/cph-twin/overrides/*)')
    ap.add_argument('--data', default=str(ROOT / 'data'))
    a = ap.parse_args()
    sets = [Path(s).expanduser() for s in a.sets] if a.sets is not None else default_sets()
    if a.cmd == 'uninstall':
        return uninstall(Path(a.data))
    if not sets:
        raise SystemExit('no override sets (tools/overrides/nyhavn.py writes ~/.local/share/cph-twin/overrides/nyhavn)')
    if a.cmd == 'install':
        return install(Path(a.data), sets)
    buildings, _, info = load_sets(sets)
    errs = check(buildings)
    print(json.dumps({'sets': info, 'buildings': len(buildings), 'problems': errs}, indent=1))
    sys.exit(1 if errs else 0)


if __name__ == '__main__':
    main()
