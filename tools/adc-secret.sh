#!/usr/bin/env bash
# Print one Secret Manager secret value via Application Default Credentials (never log it).
# Usage: export DATAFORDELER_USERNAME="$(tools/adc-secret.sh datafordeler-username)"
# Project defaults to lun-integrations-dev; falls back to integrations-484814 (read-only use).
set -euo pipefail
name="$1"; tok="$(gcloud auth application-default print-access-token)"
for p in "${ADC_SECRET_PROJECT:-lun-integrations-dev}" integrations-484814; do
  out="$(curl -sf -H "Authorization: Bearer $tok" "https://secretmanager.googleapis.com/v1/projects/$p/secrets/$name/versions/latest:access" 2>/dev/null)" || continue
  printf '%s' "$out" | python3 -c 'import sys,json,base64;print(base64.b64decode(json.load(sys.stdin)["payload"]["data"]).decode().strip(),end="")'
  exit 0
done
echo "secret $name not accessible" >&2; exit 1
