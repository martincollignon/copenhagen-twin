#!/usr/bin/env python3
"""Operate the cph-skraafoto Cloud Run Job (REST + ADC, like tools/cloud/roofer/cloudctl.py, whose helpers and infra it reuses unmodified).

    python3 tools/cloud/skraafoto/cloudctl.py build                       # stage -> Cloud Build -> image digest
    python3 tools/cloud/skraafoto/cloudctl.py inputs                      # data/tiles/*/buildings.json + index.json + data/cph-geodata.json -> gs://.../skraafoto/input
    python3 tools/cloud/skraafoto/cloudctl.py deploy [--digest ...] [--parallelism N]
    python3 tools/cloud/skraafoto/cloudctl.py run MODE [--cells 723_6176 ...] [--factor 2]   # MODE: tones | finalize | atlas | attach
    python3 tools/cloud/skraafoto/cloudctl.py status | cancel
    python3 tools/cloud/skraafoto/cloudctl.py report                      # per-cell task seconds, cost estimate, markers
    python3 tools/cloud/skraafoto/cloudctl.py sync [--atlas-cap-gb 1.5]   # tile layers -> data/tiles/*/appearance.json; inner-city webp -> data/tex-look
                                                                          # refuses while the attach step is older than the atlas run (--allow-stale)
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import importlib.util
import io
import json
import math
import sys
import tarfile
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
_spec = importlib.util.spec_from_file_location("roofer_cloudctl", ROOT / "tools/cloud/roofer/cloudctl.py")
R = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(R)  # shared helpers only: token, call, gcs_*, wait_op, constants (the roofer job is never touched)

JOB, IMAGE_NAME, P = "cph-skraafoto", "cph-skraafoto", "skraafoto/"
CPU, MEM, TIMEOUT, RETRIES = "4", "16Gi", "10800s", 1
FIN_CPU, FIN_MEM = "8", "32Gi"
PRICE_VCPU_S, PRICE_GIB_S = R.PRICE_VCPU_S, R.PRICE_GIB_S


def stage(dest: Path) -> None:
    import shutil
    for src in sorted((ROOT / "tools/cph-geodata").glob("*.py")):
        (dest / "tools/cph-geodata").mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dest / "tools/cph-geodata" / src.name)
    d = dest / ".claude/skills/building-case-to-3d/scripts"
    d.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(ROOT / ".claude/skills/building-case-to-3d/scripts/skraafoto.py", d / "skraafoto.py")
    (dest / "tools/cloud/skraafoto").mkdir(parents=True, exist_ok=True)
    for f in ("task.py", "requirements.txt"):
        shutil.copyfile(ROOT / "tools/cloud/skraafoto" / f, dest / "tools/cloud/skraafoto" / f)
    shutil.copyfile(ROOT / "tools/cloud/skraafoto/Dockerfile", dest / "Dockerfile")


def cmd_build(a):
    R.cmd_infra(a)
    with tempfile.TemporaryDirectory() as td:
        stage(Path(td) / "ctx")
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as tf:
            tf.add(Path(td) / "ctx", arcname=".")
    src = f"scratch/build/skraafoto-{int(time.time())}.tar.gz"
    R.gcs_put(src, buf.getvalue(), "application/gzip")
    image = f"{R.REGION}-docker.pkg.dev/{R.PROJECT}/{R.REPO}/{IMAGE_NAME}"
    op = R.call("POST", f"https://cloudbuild.googleapis.com/v1/projects/{R.PROJECT}/locations/{R.REGION}/builds", {
        "source": {"storageSource": {"bucket": R.BUCKET, "object": src}},
        "steps": [{"name": "gcr.io/cloud-builders/docker", "args": ["build", "--platform", "linux/amd64", "-t", f"{image}:latest", "."]}],
        "images": [f"{image}:latest"], "timeout": "1800s", "options": {"machineType": "E2_HIGHCPU_8", "logging": "CLOUD_LOGGING_ONLY"},
        "tags": ["cph-twin", "skraafoto"]})
    bid = op["metadata"]["build"]["id"]
    print("build", bid)
    while True:
        b = R.call("GET", f"https://cloudbuild.googleapis.com/v1/projects/{R.PROJECT}/locations/{R.REGION}/builds/{bid}")
        if b["status"] not in ("QUEUED", "WORKING", "PENDING"):
            break
        time.sleep(10)
    print(b["status"], b.get("logUrl"))
    if b["status"] != "SUCCESS":
        raise SystemExit(json.dumps(b.get("statusDetail") or b.get("failureInfo")))
    print("DIGEST", b["results"]["images"][0]["digest"])


def cmd_inputs(a):
    tiles = ROOT / "data" / "tiles"
    idx = json.loads((tiles / "index.json").read_text())
    jobs = [("input/index.json", tiles / "index.json")]
    jobs += [(f"input/tiles/{t}/buildings.json", tiles / t / "buildings.json") for t in idx["tiles"] if (tiles / t / "buildings.json").exists()]
    geo = ROOT / "data" / "cph-geodata.json"
    if geo.exists():
        jobs.append(("input/cph-geodata.json", geo))
    with cf.ThreadPoolExecutor(8) as ex:
        list(ex.map(lambda j: R.gcs_put(P + j[0], j[1].read_bytes(), "application/json"), jobs))
    sys.path.insert(0, str(ROOT / "tools/cph-geodata"))
    import appearance_city as C
    from appearance_city_atlas import cell_priority
    cells = sorted(C.all_cells(idx["tiles"]), key=cell_priority)
    R.gcs_put(P + "config/cells.txt", ("\n".join(cells) + "\n").encode(), "text/plain")
    print(len(jobs), "inputs,", len(cells), "cells (inner first) uploaded")


def job_body(digest: str, parallelism: int, cpu=CPU, mem=MEM) -> dict:
    image = f"{R.REGION}-docker.pkg.dev/{R.PROJECT}/{R.REPO}/{IMAGE_NAME}@{digest}"
    env = [{"name": k, "value": v} for k, v in {"BUCKET": R.BUCKET, "APPEARANCE_WORK": "/work"}.items()]
    env.append({"name": "GSEARCH_TOKEN", "valueSource": {"secretKeyRef": {"secret": "gsearch-token", "version": "latest"}}})
    return {"labels": R.LABELS, "template": {"labels": R.LABELS, "parallelism": parallelism, "taskCount": 1, "template": {
        "maxRetries": RETRIES, "timeout": TIMEOUT, "serviceAccount": R.SA, "executionEnvironment": "EXECUTION_ENVIRONMENT_GEN2",
        "containers": [{"image": image, "env": env, "resources": {"limits": {"cpu": cpu, "memory": mem}}}]}}}


def cmd_deploy(a):
    digest = a.digest or R.call("GET", f"{R.AR}/repositories/{R.REPO}/dockerImages/{IMAGE_NAME}:latest")["uri"].split("@")[-1]
    cur = R.call("GET", f"{R.RUN}/jobs/{JOB}", ok404=True)
    body = job_body(digest, a.parallelism)
    op = R.call("POST", f"{R.RUN}/jobs?jobId={JOB}", body) if cur is None else R.call("PATCH", f"{R.RUN}/jobs/{JOB}", body)
    R.wait_op(op)
    print("job", JOB, "->", digest)


def cmd_run(a):
    env = [{"name": "MODE", "value": a.mode}, {"name": "FACTOR", "value": str(a.factor)}]
    single = a.mode in ("finalize", "attach")
    cells = a.cells
    if cells:
        name = f"{P}config/cells-{a.mode}-{int(time.time())}.txt"
        R.gcs_put(name, ("\n".join(cells) + "\n").encode(), "text/plain")
        env.append({"name": "CELLS_URI", "value": f"gs://{R.BUCKET}/{name}"})
        n = len(cells)
    else:
        n = len((R.gcs_get(P + "config/cells.txt") or b"").decode().split())
    if a.force:
        env.append({"name": "FORCE", "value": "1"})
    if a.texel:
        env.append({"name": "TEXEL", "value": a.texel})
    ov = {"taskCount": 1 if single else n, "containerOverrides": [{"env": env}]}
    if single:
        ov["timeout"] = "10800s"
    if a.parallelism and not single:
        pass
    op = R.call("POST", f"{R.RUN}/jobs/{JOB}:run", {"overrides": ov})
    print("execution started", a.mode, "tasks", ov["taskCount"], json.dumps(op.get("metadata", {}).get("name") or op["name"]))


def execs():
    return sorted(R.call("GET", f"{R.RUN}/jobs/{JOB}/executions?pageSize=50").get("executions", []), key=lambda e: e["createTime"])


def cmd_status(a):
    ex = execs()
    for e in ex[-3:]:
        print(json.dumps({k: e.get(k) for k in ("name", "createTime", "completionTime", "runningCount", "succeededCount", "failedCount", "retriedCount", "taskCount")}))


def cmd_cancel(a):
    for e in execs():
        if not e.get("completionTime"):
            R.call("POST", f"https://run.googleapis.com/v2/{e['name']}:cancel", {})
            print("cancelled", e["name"])


def cmd_report(a):
    items = R.gcs_list(P + "cells/")
    done = [i for i in items if i["name"].endswith(".task.json")]
    data = [R.gcs_get(i["name"]) for i in done]
    secs = sum(d.get("task_s", 0) for d in data)
    cost = secs * (float(CPU) * PRICE_VCPU_S + float(MEM[:-2]) * PRICE_GIB_S)
    by = {}
    for i in done:
        by[i["name"].rsplit("/", 1)[1]] = by.get(i["name"].rsplit("/", 1)[1], 0) + 1
    size = sum(int(i["size"]) for i in R.gcs_list(P))
    print(json.dumps({"task_files": by, "task_hours": round(secs / 3600, 2), "task_cost_usd_est": round(cost, 2), "bucket_prefix_gb": round(size / 1e9, 2),
                      "max_task_s": max((d.get("task_s", 0) for d in data), default=0), "max_rss_mb": max((d.get("peak_rss_mb", 0) for d in data), default=0)}, indent=1))


def attach_state() -> tuple[bool, str]:
    """Is the bucket's tile layer set current? attach.done (written by the attach task) must be newer than every atlas.pkl.gz;
    a sync before that copies layers without (or with stale) atlas descriptors."""
    marker = [i for i in R.gcs_list(P + "attach.done") if i["name"] == P + "attach.done"]
    atl = [i["updated"] for i in R.gcs_list(P + "cells/") if i["name"].endswith("/atlas.pkl.gz")]
    if not atl:
        return True, "no atlas run in the bucket"
    if not marker:
        return False, f"no {P}attach.done: run `cloudctl.py run attach` after the atlas run"
    if marker[0]["updated"] < max(atl):
        return False, f"attach.done ({marker[0]['updated']}) is older than the newest atlas.pkl.gz ({max(atl)}): run attach again"
    return True, (R.gcs_get(P + "attach.done") or b"").decode()


def cmd_sync(a):
    tiles = ROOT / "data" / "tiles"
    ok, why = attach_state()
    print("attach:", why)
    if not ok and not a.allow_stale:
        raise SystemExit("sync refused: " + why + " (or --allow-stale)")
    items = R.gcs_list(P + "tiles/")
    with cf.ThreadPoolExecutor(8) as ex:
        def one(i):
            t = i["name"].split("/")[2]
            dest = tiles / t / "appearance.json"
            if dest.parent.exists():
                dest.write_bytes(R.gcs_get(i["name"]))
                return int(i["size"])
            return 0
        n = sum(ex.map(one, [i for i in items if i["name"].endswith("appearance.json")]))
    desc = sum(1 for t in tiles.iterdir() if (t / "appearance.json").exists()
               for b in json.loads((t / "appearance.json").read_text())["buildings"].values() if b.get("atlas"))
    print(f"tile layers: {n / 1e6:.1f} MB, {desc} buildings with an atlas descriptor")
    sys.path.insert(0, str(ROOT / "tools/cph-geodata"))
    from appearance_city_atlas import CENTRE_UTM
    look = ROOT / "data" / "tex-look"
    want = [i for i in R.gcs_list(P + "tex-look/")]
    # inner city first: nearest buildings by tile centre
    idx = json.loads((tiles / "index.json").read_text())["tiles"]
    cent = {t: (sum(v["utm"][0::2]) / 2, sum(v["utm"][1::2]) / 2) for t, v in idx.items()}
    owner = {}
    for t in cent:
        p = tiles / t / "appearance.json"
        if p.exists():
            for bid in json.loads(p.read_text())["buildings"]:
                owner[bid.replace(":", "_")] = t
    key = lambda i: math.hypot(*(a_ - b_ for a_, b_ in zip(cent.get(owner.get(Path(i["name"]).stem, ""), (1e9, 1e9)), CENTRE_UTM)))
    want.sort(key=key)
    cap, tot = a.atlas_cap_gb * 1e9, 0
    look.mkdir(parents=True, exist_ok=True)
    take = []
    for i in want:
        if tot + int(i["size"]) > cap:
            break
        tot += int(i["size"])
        take.append(i)
    with cf.ThreadPoolExecutor(8) as ex:
        list(ex.map(lambda i: (look / Path(i["name"]).name).write_bytes(R.gcs_get(i["name"])), [i for i in take if not (look / Path(i["name"]).name).exists()]))
    # the atlas run's quality gate, for the coverage report (data/city/appearance-atlas-gate.json)
    tasks = [json.loads(R.gcs_get(i["name"])) for i in R.gcs_list(P + "cells/") if i["name"].endswith("/atlas.task.json")]
    gate: dict = {}
    for d in tasks:
        for k, v in (d.get("gate") or {}).items():
            gate[k] = gate.get(k, 0) + v
    (ROOT / "data" / "city" / "appearance-atlas-gate.json").write_text(json.dumps({
        "cells": len(tasks), "texels": sorted({d.get("texel") for d in tasks}), "atlases": sum(d.get("atlases", 0) for d in tasks),
        "webp_mb": round(sum(d.get("webp_mb", 0) for d in tasks), 1), "gate": gate}, indent=1) + "\n")
    print(f"atlases: {len(take)} of {len(want)} synced ({tot / 1e9:.2f} GB, cap {a.atlas_cap_gb} GB); the rest stay in gs://{R.BUCKET}/{P}tex-look/")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = ap.add_subparsers(dest="cmd", required=True)
    sp.add_parser("build").set_defaults(f=cmd_build)
    sp.add_parser("inputs").set_defaults(f=cmd_inputs)
    p = sp.add_parser("deploy"); p.add_argument("--digest"); p.add_argument("--parallelism", type=int, default=20); p.set_defaults(f=cmd_deploy)
    p = sp.add_parser("run"); p.add_argument("mode", choices=["tones", "finalize", "atlas", "attach"]); p.add_argument("--cells", nargs="*")
    p.add_argument("--factor", type=int, default=2); p.add_argument("--force", action="store_true"); p.add_argument("--texel"); p.add_argument("--parallelism", type=int)
    p.set_defaults(f=cmd_run)
    sp.add_parser("status").set_defaults(f=cmd_status)
    sp.add_parser("cancel").set_defaults(f=cmd_cancel)
    sp.add_parser("report").set_defaults(f=cmd_report)
    p = sp.add_parser("sync"); p.add_argument("--atlas-cap-gb", type=float, default=1.5)
    p.add_argument("--allow-stale", action="store_true", help="sync even if the attach step has not run after the atlas run")
    p.set_defaults(f=cmd_sync)
    a = ap.parse_args()
    a.f(a)


if __name__ == "__main__":
    main()
