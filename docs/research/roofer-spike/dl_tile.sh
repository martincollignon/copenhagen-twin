#!/bin/bash
# usage: dl_tile.sh <northing_km> <easting_km>  (needs DATAFORDELER_GRAPHQL_API_KEY in env; never printed)
N=$1; E=$2; OUT=raw/PUNKTSKY_1km_${N}_${E}.laz
curl -s --max-time 1500 -o "$OUT.tmp" -w "http=%{http_code} size=%{size_download} time=%{time_total}\n" \
 "https://api.datafordeler.dk/FileDownloads/GetPointCloudFile?apiKey=${DATAFORDELER_GRAPHQL_API_KEY}&FileName=PUNKTSKY_1km_${N}_${E}.laz"
if [ "$(head -c4 "$OUT.tmp")" = "LASF" ]; then mv "$OUT.tmp" "$OUT"; echo OK; else head -c 300 "$OUT.tmp"; echo; rm -f "$OUT.tmp"; fi
