#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.10"
# ///
"""Before / after table of two audit runs (docs/qa/results-before.json vs docs/qa/results.json).

    uv run tools/audit/compare.py [--before docs/qa/results-before.json] [--after docs/qa/results.json] [--top 10] [--all]
"""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ap = argparse.ArgumentParser()
ap.add_argument("--before", default=str(ROOT / "docs/qa/results-before.json"))
ap.add_argument("--after", default=str(ROOT / "docs/qa/results.json"))
ap.add_argument("--top", type=int, default=0, help="only the n biggest checks of the before run (by count x severity)")
ap.add_argument("--only", default="", help="comma list of check ids")
a = ap.parse_args()
B = {r["id"]: r for r in json.loads(Path(a.before).read_text()) if r["id"] != "dim-table"}
A = {r["id"]: r for r in json.loads(Path(a.after).read_text()) if r["id"] != "dim-table"}
SEV = {"high": 0, "med": 1, "low": 2, "info": 3}
ids = list(dict.fromkeys(list(B) + list(A)))
if a.only:
    ids = [i for i in a.only.split(",") if i in B or i in A]
elif a.top:
    ids = sorted(B, key=lambda i: (SEV[B[i]["severity"]], -B[i]["pct"]))[: a.top]
else:
    ids.sort(key=lambda i: (SEV[(B.get(i) or A[i])["severity"]], -(B.get(i) or A[i])["pct"]))
print("| severity | check | before (count / of, %) | after (count / of, %) |")
print("|---|---|---:|---:|")
fmt = lambda r: "n/a" if r is None else f"{r['count']} / {r['total']} ({r['pct']}%)"
for i in ids:
    r = B.get(i) or A.get(i)
    print(f"| {r['severity']} | `{i}` | {fmt(B.get(i))} | {fmt(A.get(i))} |")
