#!/usr/bin/env bash
# Links the hero glTFs named in data/cph-geodata.json (`heroes[]`, absolute paths on this machine) into the gitignored
# data/heroes/<building_id>/ folder, so the dev server can serve them. The glb is never committed.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
python3 - "$root" <<'PY'
import json, os, re, sys
root = sys.argv[1]
geo = json.load(open(os.path.join(root, 'data/cph-geodata.json')))
for hero in geo.get('heroes', []):
    glb = hero['glb']
    frame = hero.get('frame') or os.path.join(os.path.dirname(glb), 'building.json')
    if not os.path.exists(frame):  # building.json sits next to the build/ folder in the building-case-to-3d layout
        alt = os.path.join(os.path.dirname(os.path.dirname(glb)), 'building.json')
        frame = alt if os.path.exists(alt) else frame
    name = re.sub(r'[^\w.-]+', '_', hero['building_id'])
    dest = os.path.join(root, 'data/heroes', name)
    os.makedirs(dest, exist_ok=True)
    for src, target in ((glb, 'building.glb'), (frame, 'building.json')):
        link = os.path.join(dest, target)
        if not os.path.exists(src):
            print(f'missing {src}', file=sys.stderr); sys.exit(1)
        if os.path.lexists(link): os.remove(link)
        os.symlink(src, link)
        print(f'{link} -> {src}')
PY
