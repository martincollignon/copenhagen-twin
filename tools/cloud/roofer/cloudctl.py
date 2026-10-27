#!/usr/bin/env python3
"""Operate the cph-roofer Cloud Run Job with REST + Application Default Credentials (the gcloud CLI is not used).

    python3 tools/cloud/roofer/cloudctl.py infra                # bucket (lifecycle, labels) + Artifact Registry repo: idempotent
    python3 tools/cloud/roofer/cloudctl.py build                # stage context -> GCS -> Cloud Build (linux/amd64) -> prints the image digest
    python3 tools/cloud/roofer/cloudctl.py inputs               # data/city/cells-input/*.json -> gs://.../cells-input + config/cells.txt
    python3 tools/cloud/roofer/cloudctl.py deploy [--digest sha256:...]   # create/update the job
    python3 tools/cloud/roofer/cloudctl.py run [--cells 6176_723 ...] [--force]   (parallelism is set by `deploy --parallelism N`)
    python3 tools/cloud/roofer/cloudctl.py status [EXECUTION]   # task counts of the last (or given) execution
    python3 tools/cloud/roofer/cloudctl.py report               # DONE / FAILED markers: counts, task-hours, LAZ sources (R2 vs published)
    python3 tools/cloud/roofer/cloudctl.py sync [--cells ...]   # cells/<cell>/{manifest.json,out,veg} -> data/raw/lod2-out, data/raw/veg
    python3 tools/cloud/roofer/cloudctl.py cancel               # cancel running executions of the job
    python3 tools/cloud/roofer/cloudctl.py delete --yes         # job, repo, bucket (with its objects)
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import io
import json
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
PROJECT = "lun-integrations-dev"
PROJECT_NUMBER = "368722833767"
REGION = "europe-west1"
BUCKET = "lun-integrations-dev-cph-twin"
REPO = "cph-twin"
JOB = "cph-roofer"
IMAGE_NAME = "cph-roofer"
SA = f"{PROJECT_NUMBER}-compute@developer.gserviceaccount.com"  # default compute SA: already secretAccessor on the Datafordeler key
LABELS = {"app": "cph-twin"}
CPU, MEM, TIMEOUT, RETRIES = "4", "16Gi", "10800s", 2  # pilot at 8 vCPU / 32 GiB: peak RSS 1.7 GB, download-bound (roofer ~1 min)
R2_ENV = {"R2_ACCOUNT_ID": "691682f9ad7a2e6378c27998ceffaaf9", "R2_LIDAR_BUCKET": "dk-lidar-cache", "R2_SECRET_PROJECT": "integrations-484814"}
# Cloud Run Jobs list prices, europe-west1 (tier 1): https://cloud.google.com/run/pricing  (checked 2026-10; re-check before relying on it)
PRICE_VCPU_S, PRICE_GIB_S = 0.000024, 0.0000025

_token = {"v": None, "t": 0.0}


def token() -> str:
    if time.time() - _token["t"] > 1800 or not _token["v"]:
        _token["v"] = subprocess.run(["gcloud", "auth", "application-default", "print-access-token"], capture_output=True, text=True,
                                     check=True).stdout.strip()
        _token["t"] = time.time()
    return _token["v"]


def call(method: str, url: str, body=None, raw: bytes | None = None, ctype="application/json", ok404=False, binary=False):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {token()}", "x-goog-user-project": PROJECT, **({"Content-Type": ctype} if data is not None else {})})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                b = r.read()
                return b if binary or not b or b[:1] not in b"{[" else json.loads(b)
        except urllib.error.HTTPError as e:
            msg = e.read().decode()[:1500]
            if e.code == 404 and ok404:
                return None
            if e.code >= 500 and attempt < 3:
                time.sleep(2 ** attempt)
                continue
            raise SystemExit(f"{method} {url.split('?')[0]} -> {e.code}: {msg}") from None
        except (urllib.error.URLError, TimeoutError):
            if attempt == 3:
                raise
            time.sleep(2 ** attempt)


GCS = "https://storage.googleapis.com/storage/v1/b/" + BUCKET
RUN = f"https://run.googleapis.com/v2/projects/{PROJECT}/locations/{REGION}"
AR = f"https://artifactregistry.googleapis.com/v1/projects/{PROJECT}/locations/{REGION}"


def gcs_put(name: str, data: bytes, ctype="application/octet-stream") -> None:
    call("POST", f"https://storage.googleapis.com/upload/storage/v1/b/{BUCKET}/o?uploadType=media&name={urllib.parse.quote(name, safe='')}",
         raw=data, ctype=ctype)


def gcs_get(name: str) -> bytes | None:
    r = call("GET", f"{GCS}/o/{urllib.parse.quote(name, safe='')}?alt=media", ok404=True, binary=True)
    return r


def gcs_list(prefix: str) -> list[dict]:
    out, tok = [], None
    while True:
        r = call("GET", f"{GCS}/o?prefix={urllib.parse.quote(prefix, safe='')}&maxResults=1000" + (f"&pageToken={tok}" if tok else ""))
        out += r.get("items", [])
        tok = r.get("nextPageToken")
        if not tok:
            return out


# ------------------------------------------------------------------------------------------------------------- infra
def cmd_infra(a):
    if call("GET", GCS, ok404=True) is None:
        call("POST", f"https://storage.googleapis.com/storage/v1/b?project={PROJECT}", {
            "name": BUCKET, "location": REGION, "storageClass": "STANDARD", "labels": LABELS,
            "iamConfiguration": {"uniformBucketLevelAccess": {"enabled": True}, "publicAccessPrevention": "enforced"},
            "lifecycle": {"rule": [{"action": {"type": "Delete"}, "condition": {"age": 30, "matchesPrefix": ["scratch/"]}}]}})
        print("bucket created")
    # read-modify-write: never replace the policy (the creator's access comes from the default legacy bindings)
    pol = call("GET", GCS + "/iam")
    if not any(SA_M in b["members"] and b["role"] == "roles/storage.objectAdmin" for b in pol["bindings"] for SA_M in [f"serviceAccount:{SA}"]):
        pol["bindings"].append({"role": "roles/storage.objectAdmin", "members": [f"serviceAccount:{SA}"]})
        call("PUT", GCS + "/iam", pol)
        print("bucket objectAdmin granted to", SA)
    if call("GET", f"{AR}/repositories/{REPO}", ok404=True) is None:
        call("POST", f"{AR}/repositories?repositoryId={REPO}", {"format": "DOCKER", "labels": LABELS, "description": "Copenhagen Twin cloud jobs"})
        print("repo created")
    print("infra ok")


# ------------------------------------------------------------------------------------------------------------- build
def stage(dest: Path) -> None:
    import shutil
    if dest.exists():
        shutil.rmtree(dest)
    for src, pats in [("tools/lod2", ["common.py", "prep.py", "fetch.py", "convert.py"]), ("tools/cph-geodata", ["frame.py"]),
                      ("tools/cloud/roofer", ["task.py", "lidar_r2.py", "r2_credentials.py", "requirements.txt"])]:
        for p in pats:
            (dest / src).mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / src / p, dest / src / p)
    shutil.copyfile(ROOT / "tools/cloud/roofer/Dockerfile", dest / "Dockerfile")


def cmd_build(a):
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        stage(Path(td) / "ctx")
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as tf:
            tf.add(Path(td) / "ctx", arcname=".")
    src = f"scratch/build/src-{int(time.time())}.tar.gz"
    gcs_put(src, buf.getvalue(), "application/gzip")
    image = f"{REGION}-docker.pkg.dev/{PROJECT}/{REPO}/{IMAGE_NAME}"
    op = call("POST", f"https://cloudbuild.googleapis.com/v1/projects/{PROJECT}/locations/{REGION}/builds", {
        "source": {"storageSource": {"bucket": BUCKET, "object": src}},
        "steps": [{"name": "gcr.io/cloud-builders/docker", "args": ["build", "--platform", "linux/amd64", "-t", f"{image}:latest", "."]}],
        "images": [f"{image}:latest"], "timeout": "3000s", "options": {"machineType": "E2_HIGHCPU_8", "logging": "CLOUD_LOGGING_ONLY"},
        "tags": ["cph-twin"]})
    bid = op["metadata"]["build"]["id"]
    print("build", bid)
    while True:
        b = call("GET", f"https://cloudbuild.googleapis.com/v1/projects/{PROJECT}/locations/{REGION}/builds/{bid}")
        if b["status"] not in ("QUEUED", "WORKING", "PENDING"):
            break
        time.sleep(10)
    print(b["status"], b.get("logUrl"))
    if b["status"] != "SUCCESS":
        raise SystemExit(json.dumps(b.get("statusDetail") or b.get("failureInfo")))
    digest = b["results"]["images"][0]["digest"]
    print("DIGEST", digest, f"{image}@{digest}")


# ------------------------------------------------------------------------------------------------------------- job
def job_body(digest: str, parallelism: int, task_count: int) -> dict:
    image = f"{REGION}-docker.pkg.dev/{PROJECT}/{REPO}/{IMAGE_NAME}@{digest}"
    env = [{"name": k, "value": v} for k, v in {"BUCKET": BUCKET, "IMAGE_REF": image, "WORK": "/work", "ROOFER_JOBS": CPU, **R2_ENV}.items()]
    env.append({"name": "DATAFORDELER_GRAPHQL_API_KEY", "valueSource": {"secretKeyRef": {"secret": "datafordeler-graphql-api-key", "version": "latest"}}})
    return {"labels": LABELS, "template": {"labels": LABELS, "parallelism": parallelism, "taskCount": task_count, "template": {
        "maxRetries": RETRIES, "timeout": TIMEOUT, "serviceAccount": SA, "executionEnvironment": "EXECUTION_ENVIRONMENT_GEN2",
        "containers": [{"image": image, "env": env, "resources": {"limits": {"cpu": CPU, "memory": MEM}}}]}}}


def cmd_deploy(a):
    digest = a.digest or (call("GET", f"{AR}/repositories/{REPO}/dockerImages/{IMAGE_NAME}:latest")["uri"].split("@")[-1])
    cur = call("GET", f"{RUN}/jobs/{JOB}", ok404=True)
    body = job_body(digest, a.parallelism, a.task_count)
    if cur is None:
        op = call("POST", f"{RUN}/jobs?jobId={JOB}", body)
    else:
        op = call("PATCH", f"{RUN}/jobs/{JOB}", body)
    wait_op(op)
    print("job", JOB, "->", digest)


def wait_op(op):
    name = op["name"]
    while not op.get("done"):
        time.sleep(3)
        op = call("GET", f"https://run.googleapis.com/v2/{name}")
    if "error" in op:
        raise SystemExit(json.dumps(op["error"]))


def cmd_inputs(a):
    d = ROOT / "data" / "city" / "cells-input"
    files = sorted(p for p in d.glob("*.json"))
    with cf.ThreadPoolExecutor(8) as ex:
        list(ex.map(lambda p: gcs_put(f"cells-input/{p.name}", p.read_bytes(), "application/json"), files))
    gcs_put("config/cells.txt", ("\n".join(p.stem for p in files) + "\n").encode(), "text/plain")
    print(len(files), "cells uploaded; config/cells.txt written")


def cmd_run(a):
    cells = a.cells
    over = {"taskCount": None}
    env = []
    if cells:
        name = f"config/cells-{int(time.time())}.txt"
        gcs_put(name, ("\n".join(cells) + "\n").encode(), "text/plain")
        env.append({"name": "CELLS_URI", "value": f"gs://{BUCKET}/{name}"})
        over["taskCount"] = len(cells)
    else:
        n = len((gcs_get("config/cells.txt") or b"").decode().split())
        over["taskCount"] = n
    if a.force:
        env.append({"name": "FORCE", "value": "1"})
    body = {"overrides": {"taskCount": over["taskCount"], "containerOverrides": [{"env": env}] if env else []}}
    op = call("POST", f"{RUN}/jobs/{JOB}:run", body)
    print("execution started:", json.dumps(op.get("metadata", {}).get("name") or op["name"]), "tasks", over["taskCount"])


def last_execution(name=None):
    if name:
        return call("GET", f"{RUN}/jobs/{JOB}/executions/{name}")
    ex = call("GET", f"{RUN}/jobs/{JOB}/executions?pageSize=10").get("executions", [])
    return sorted(ex, key=lambda e: e["createTime"])[-1] if ex else None


def cmd_status(a):
    e = last_execution(a.execution)
    if not e:
        print("no executions")
        return
    keys = ["name", "createTime", "startTime", "completionTime", "runningCount", "succeededCount", "failedCount", "cancelledCount", "retriedCount", "taskCount"]
    print(json.dumps({k: e.get(k) for k in keys}, indent=1))
    for c in e.get("conditions", []):
        if c["type"] == "Completed":
            print("Completed:", c.get("state"), c.get("message", "")[:300])


def cmd_cancel(a):
    for e in call("GET", f"{RUN}/jobs/{JOB}/executions?pageSize=50").get("executions", []):
        if not e.get("completionTime"):
            call("POST", f"https://run.googleapis.com/v2/{e['name']}:cancel", {})
            print("cancelled", e["name"])


# ------------------------------------------------------------------------------------------------------------- results
def markers():
    done, failed = {}, {}
    items = gcs_list("cells/")
    names = [i["name"] for i in items]
    with cf.ThreadPoolExecutor(16) as ex:
        for n, b in zip([n for n in names if n.endswith(("/DONE.json", "/FAILED.json"))],
                        ex.map(gcs_get, [n for n in names if n.endswith(("/DONE.json", "/FAILED.json"))])):
            (done if n.endswith("DONE.json") else failed)[n.split("/")[1]] = json.loads(b)
    return done, failed


def cmd_report(a):
    done, failed = markers()
    failed = {c: f for c, f in failed.items() if c not in done}
    hours = sum(d["task_s"] for d in done.values()) / 3600
    cost = sum(d["task_s"] for d in done.values()) * (float(CPU) * PRICE_VCPU_S + float(MEM[:-2]) * PRICE_GIB_S)
    src = {}
    for d in done.values():
        for t, s in d.get("lidar", {}).items():
            src[s] = src.get(s, 0) + 1
    own = [d for d in done.values() if d["lidar"].get(d["cell"])]
    own_src = {}
    for d in own:
        own_src[d["lidar"][d["cell"]]] = own_src.get(d["lidar"][d["cell"]], 0) + 1
    print(json.dumps({"done": len(done), "failed": len(failed), "failed_cells": sorted(failed), "task_hours": round(hours, 2),
                      "task_cost_usd": round(cost, 2), "own_cell_lidar": own_src, "all_lidar_fetches": src,
                      "buildings_own": sum(d["own_buildings"] for d in done.values()),
                      "max_task_s": max((d["task_s"] for d in done.values()), default=0),
                      "max_peak_rss_mb": max((d.get("peak_rss_mb", 0) for d in done.values()), default=0)}, indent=1))
    for c, f in sorted(failed.items()):
        print(c, f["attempt_error"][:200].replace("\n", " "))


def cmd_sync(a):
    cells = a.cells or sorted(c for c in markers()[0])
    out_root, veg = ROOT / "data" / "raw" / "lod2-out", ROOT / "data" / "raw" / "veg"
    veg.mkdir(parents=True, exist_ok=True)

    def one(cell):
        n = 0
        for it in gcs_list(f"cells/{cell}/"):
            rel = it["name"].split("/", 2)[2]
            if rel.startswith("veg/"):
                dest = veg / rel[4:]
            elif rel.startswith("out/") or rel in ("manifest.json", "footprints.geojson", "roofer.toml", "roofer.log.gz", "DONE.json"):
                dest = out_root / cell / rel
            else:
                continue
            if dest.exists() and dest.stat().st_size == int(it["size"]):
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(gcs_get(it["name"]))
            n += 1
        return cell, n
    with cf.ThreadPoolExecutor(8) as ex:
        for cell, n in ex.map(one, cells):
            print(cell, n, "files")


def cmd_delete(a):
    if not a.yes:
        raise SystemExit("pass --yes to delete job, repo and bucket")
    call("DELETE", f"{RUN}/jobs/{JOB}", ok404=True)
    call("DELETE", f"{AR}/repositories/{REPO}", ok404=True)
    for it in gcs_list(""):
        call("DELETE", f"{GCS}/o/{urllib.parse.quote(it['name'], safe='')}", ok404=True)
    call("DELETE", GCS, ok404=True)
    print("deleted job, repo, bucket (R2 cache and secrets untouched)")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = ap.add_subparsers(dest="cmd", required=True)
    sp.add_parser("infra").set_defaults(f=cmd_infra)
    sp.add_parser("build").set_defaults(f=cmd_build)
    sp.add_parser("inputs").set_defaults(f=cmd_inputs)
    p = sp.add_parser("deploy")
    p.add_argument("--digest")
    p.add_argument("--parallelism", type=int, default=30)
    p.add_argument("--task-count", type=int, default=145)
    p.set_defaults(f=cmd_deploy)
    p = sp.add_parser("run")
    p.add_argument("--cells", nargs="*")
    p.add_argument("--force", action="store_true")
    p.set_defaults(f=cmd_run)
    p = sp.add_parser("status")
    p.add_argument("execution", nargs="?")
    p.set_defaults(f=cmd_status)
    sp.add_parser("report").set_defaults(f=cmd_report)
    p = sp.add_parser("sync")
    p.add_argument("--cells", nargs="*")
    p.set_defaults(f=cmd_sync)
    sp.add_parser("cancel").set_defaults(f=cmd_cancel)
    p = sp.add_parser("delete")
    p.add_argument("--yes", action="store_true")
    p.set_defaults(f=cmd_delete)
    a = ap.parse_args()
    a.f(a)


if __name__ == "__main__":
    main()
