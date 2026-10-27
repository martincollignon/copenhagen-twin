#!/usr/bin/env python3
"""One Cloud Run Job task of the citywide Skraafoto appearance run (see tools/cph-geodata/appearance_city*.py).

MODE (env, per execution)
  tones     one 1 km cell per task (CLOUD_RUN_TASK_INDEX into $CELLS_URI): STAC + COG overview windows + DHM blocks + z-buffer + observations
            -> skraafoto/cells/<cell>/{obs,pairs,views}.pkl.gz + tones.done
  finalize  ONE task: calibrate + finalize (passes B-D) over the cells listed in $CELLS_URI (default: every cell with tones.done), validation
            against data/cph-geodata.json -> skraafoto/tiles/<tile>/appearance.json, cells/<cell>/final.* , validation.json
  atlas     one cell per task: full-resolution windows of each wall's texture view -> strips -> facade_look -> quality gate
            -> skraafoto/tex-look/<id>.webp, cells/<cell>/atlas.pkl.gz (descriptors of the strips that passed)
  attach    ONE task: sets every tile layer's citywide atlas descriptors to exactly what the cells' atlas.pkl.gz hold (stale ones from an
            earlier atlas run are removed; the district's own atlases are kept), then writes skraafoto/attach.done, which
            `cloudctl.py sync` requires to be newer than every atlas.pkl.gz
Store: gs://$BUCKET/skraafoto/. Inputs: input/index.json, input/tiles/<tile>/buildings.json, input/cph-geodata.json (uploaded by cloudctl.py inputs).
Token: GSEARCH_TOKEN comes from Secret Manager (secretKeyRef on the job) and is never printed.
"""
from __future__ import annotations

import concurrent.futures as cf
import json
import os
import resource
import shutil
import sys
import time
import traceback
from pathlib import Path

APP = Path("/app") if Path("/app/tools").exists() else Path(__file__).resolve().parents[3]
os.environ.setdefault("APPEARANCE_WORK", "/work")
sys.path.insert(0, str(APP / "tools" / "cph-geodata"))

from google.cloud import storage  # noqa: E402

BUCKET = os.environ.get("BUCKET", "lun-integrations-dev-cph-twin")
P = "skraafoto/"
bkt = storage.Client().bucket(BUCKET)
WORK = Path(os.environ["APPEARANCE_WORK"])
DATA = APP / "data"


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def get(rel: str, dest: Path) -> bool:
    b = bkt.blob(P + rel)
    if not b.exists():
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    b.download_to_filename(str(dest))
    return True


def put(rel: str, src: Path) -> None:
    bkt.blob(P + rel).upload_from_filename(str(src))


def listing(prefix: str) -> list[str]:
    return [b.name[len(P):] for b in bkt.list_blobs(prefix=P + prefix)]


def fetch_tiles(tids: list[str]) -> None:
    def one(t):
        get(f"input/tiles/{t}/buildings.json", DATA / "tiles" / t / "buildings.json")
    with cf.ThreadPoolExecutor(8) as ex:
        list(ex.map(one, tids))


def cell_list() -> list[str]:
    uri = os.environ.get("CELLS_URI")
    if uri:
        name = uri.split(f"gs://{BUCKET}/", 1)[1]
        return bkt.blob(name).download_as_text().split()
    return bkt.blob(P + "config/cells.txt").download_as_text().split()


def main() -> int:
    mode = os.environ.get("MODE", "tones")
    t0 = time.time()
    get("input/index.json", DATA / "tiles" / "index.json")
    import appearance_city as C  # noqa: PLC0415
    idx = C.tile_index()
    cells = C.all_cells(idx)
    force = bool(os.environ.get("FORCE"))
    if mode in ("tones", "atlas"):
        cell = cell_list()[int(os.environ.get("CLOUD_RUN_TASK_INDEX", "0"))] if "CELL" not in os.environ else os.environ["CELL"]
        log("mode", mode, "cell", cell)
        bx0, bz0, bx1, bz1 = C.cell_bbox_local(cell)
        r = C.RING_M
        need = [t for t, i in idx.items() if not (i["local"][2] < bx0 - r or i["local"][0] > bx1 + r or i["local"][3] < bz0 - r or i["local"][1] > bz1 + r)]
        fetch_tiles(need)
        cd = C.cell_dir(cell)
        # DHM block cache shared through the bucket
        cx, cy = map(int, cell.split("_"))
        import math
        blocks = [f"dsm_{be}_{bn}.tif" for be in range(math.floor((cx * 1000 - 250) / 500), math.floor((cx * 1000 + 1250) / 500) + 1)
                  for bn in range(math.floor((cy * 1000 - 250) / 500), math.floor((cy * 1000 + 1250) / 500) + 1)]
        for b in blocks:
            get(f"dsm/{b}", C.WORK / "dsm" / b)
        if mode == "tones":
            if bkt.blob(P + f"cells/{cell}/tones.done").exists() and not force:
                log("already done")
                return 0
            res = C.process_tones(cell, int(os.environ.get("FACTOR", "2")), C.COLLECTIONS, force=True)
            for f in ("tones.done", "obs.pkl.gz", "pairs.pkl.gz", "views.pkl.gz"):
                if (cd / f).exists():
                    put(f"cells/{cell}/{f}", cd / f)
        else:
            import appearance_city_atlas as AT  # noqa: PLC0415
            for f in ("final.done", "final.pkl.gz", "views.pkl.gz"):
                if not get(f"cells/{cell}/{f}", cd / f):
                    raise SystemExit(f"{cell}: {f} missing in the bucket: run finalize first")
            get(f"cells/{cell}/obs.pkl.gz", cd / "obs.pkl.gz")  # per-view observations: the texture view candidates
            if not force and bkt.blob(P + f"cells/{cell}/atlas.done").exists():
                log("already done")
                return 0
            get("input/cph-geodata.json", DATA / "cph-geodata.json")
            res = AT.process_atlas(cell, AT.texel_for(cell, os.environ.get("TEXEL") or AT.DEFAULT_TEXEL), force=True)
            look = DATA / "tex-look"
            files = sorted(look.glob("*.webp")) if look.exists() else []
            with cf.ThreadPoolExecutor(8) as ex:
                list(ex.map(lambda p: put(f"tex-look/{p.name}", p), files))
            for f in ("atlas.pkl.gz", "atlas.done"):
                if (cd / f).exists():
                    put(f"cells/{cell}/{f}", cd / f)
        for b in blocks:
            if (C.WORK / "dsm" / b).exists() and not bkt.blob(P + f"dsm/{b}").exists():
                put(f"dsm/{b}", C.WORK / "dsm" / b)
        res.update({"task_s": round(time.time() - t0, 1), "peak_rss_mb": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024 // 1024})
        bkt.blob(P + f"cells/{cell}/{mode}.task.json").upload_from_string(json.dumps(res))
        log("done", json.dumps(res))
        return 0
    if mode == "finalize":
        import appearance_city_final as F  # noqa: PLC0415
        import appearance_city_report as R  # noqa: PLC0415
        todo = cell_list() if os.environ.get("CELLS_URI") else sorted({n.split("/")[1] for n in listing("cells/") if n.endswith("/tones.done")})
        log("finalize", len(todo), "cells")
        def dl(c):
            for f in ("tones.done", "obs.pkl.gz", "pairs.pkl.gz", "views.pkl.gz"):
                get(f"cells/{c}/{f}", C.cell_dir(c) / f)
        with cf.ThreadPoolExecutor(8) as ex:
            list(ex.map(dl, todo))
        fetch_tiles([t for c in todo for t in cells[c]])
        get("input/cph-geodata.json", DATA / "cph-geodata.json")
        F.calibrate_all()
        F.finalize(int(os.environ.get("WORKERS", 4)), force=True)
        up = []
        for c in todo:
            for f in ("final.done", "final.pkl.gz", "entries.pkl.gz"):
                up.append((f"cells/{c}/{f}", C.cell_dir(c) / f))
            for t in cells[c]:
                p = C.TILES / t / "appearance.json"
                if p.exists():
                    up.append((f"tiles/{t}/appearance.json", p))
        up.append(("calibration.pkl.gz", WORK / "calibration.pkl.gz"))
        with cf.ThreadPoolExecutor(8) as ex:
            list(ex.map(lambda a: put(*a), [u for u in up if u[1].exists()]))
        v = R.validate() if (DATA / "cph-geodata.json").exists() else {}
        bkt.blob(P + "validation.json").upload_from_string(json.dumps(v, indent=1))
        log("validation", json.dumps(v)[:3000])
        log("done", round(time.time() - t0), "s")
        return 0
    if mode == "attach":
        import appearance_city as C2  # noqa: PLC0415
        todo = sorted({n.split("/")[1] for n in listing("cells/") if n.endswith("/atlas.pkl.gz")})
        by_tile: dict[str, dict] = {}
        for c in todo:
            d = Path("/tmp/atl.pkl.gz")
            get(f"cells/{c}/atlas.pkl.gz", d)
            at = C2.load_pkl(d)
            fin = Path("/tmp/fin.pkl.gz")
            get(f"cells/{c}/final.pkl.gz", fin)
            tid_of = C2.load_pkl(fin)["tid_of"]
            for bid, a in at.items():
                by_tile.setdefault(tid_of[bid], {})[bid] = a
        # the district's atlases (data/cph-geodata.json, served from data/tex-look) are the only descriptors not made here
        district = set()
        if get("input/cph-geodata.json", DATA / "cph-geodata.json"):
            district = {b["id"] for b in json.loads((DATA / "cph-geodata.json").read_text())["buildings"] if (b.get("observed") or {}).get("atlas")}
        tiles = sorted({n.split("/")[1] for n in listing("tiles/") if n.endswith("/appearance.json")})
        tot = {"attached": 0, "removed": 0, "tiles_written": 0}

        def one(t):
            p = Path(f"/tmp/tiles/{t}.json")
            get(f"tiles/{t}/appearance.json", p)
            doc = json.loads(p.read_text())
            dd = by_tile.get(t, {})
            n_set = n_rm = 0
            for bid, b in doc["buildings"].items():
                if bid in dd:
                    if b.get("atlas") != dd[bid]:
                        b["atlas"] = dd[bid]
                        n_set += 1
                elif "atlas" in b and bid not in district:
                    del b["atlas"]
                    n_rm += 1
            if n_set or n_rm:
                p.write_text(json.dumps(doc, separators=(",", ":"), ensure_ascii=False))
                put(f"tiles/{t}/appearance.json", p)
            return n_set, n_rm, sum(1 for bid in dd if bid in doc["buildings"])
        with cf.ThreadPoolExecutor(8) as ex:
            for n_set, n_rm, n_have in ex.map(one, tiles):
                tot["attached"] += n_have
                tot["removed"] += n_rm
                tot["tiles_written"] += bool(n_set or n_rm)
        tot.update({"cells": len(todo), "tiles": len(tiles), "time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
        bkt.blob(P + "attach.done").upload_from_string(json.dumps(tot))
        log("attach", json.dumps(tot))
        return 0
    raise SystemExit(f"unknown MODE {mode}")


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        sys.exit(1)
