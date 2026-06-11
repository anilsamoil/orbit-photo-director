#!/usr/bin/env bash
# scripts/prune_versions.sh — delete versioned subfolders on R2 except:
#   - the version named in the current manifest.json
#   - any version uploaded in the last KEEP_HOURS hours (default 6)
#
# Uses --use-server-modtime so rclone compares against the actual S3 LastModified,
# not the source mtime metadata. That's the safe behavior for "prune by upload age."
#
# Run on a daily cron, or manually when the bucket gets crowded.

set -euo pipefail

REMOTE="${OPD_RCLONE_REMOTE:-r2:map-astroanil-dev}"
KEEP_HOURS="${OPD_KEEP_VERSION_HOURS:-6}"
VERBOSE_FLAG=""
[ "${OPD_VERBOSE:-0}" = "1" ] && VERBOSE_FLAG="-v"

if ! command -v rclone >/dev/null 2>&1; then
  echo "ERROR: rclone not installed" >&2
  exit 2
fi

# 1. Get the version currently published.
CURRENT_VERSION=$(rclone cat "$REMOTE/manifest.json" 2>/dev/null \
  | python3 -c "import json,sys; print(json.load(sys.stdin).get('version',''))" 2>/dev/null || true)

if [ -z "$CURRENT_VERSION" ]; then
  echo "ERROR: could not read $REMOTE/manifest.json — refusing to prune" >&2
  exit 3
fi

echo "==> Current published version: $CURRENT_VERSION (will be preserved)"
echo "==> Pruning versions older than ${KEEP_HOURS}h, except current"

# 2. Delete ANY object older than KEEP_HOURS that is NOT under the current version path.
# Build an exclude pattern for the current version dir.
rclone delete "$REMOTE/v/" \
  --min-age "${KEEP_HOURS}h" \
  --use-server-modtime \
  --exclude "${CURRENT_VERSION}/**" \
  $VERBOSE_FLAG || true

# 3. Empty leftover directory entries (rclone leaves dir markers on some backends).
rclone rmdirs "$REMOTE/v/" --leave-root $VERBOSE_FLAG 2>/dev/null || true

# 4. Forecast cloud runs (V4-P2): preserve the run the current manifest's
# forecast_clouds.prefix points at (plus anything younger than KEEP_HOURS —
# covers the freshly-published run). One GFS run lives ~6h, so the default
# horizon naturally keeps the active + previous run, mirroring the local
# KEEP_RUNS=2 prune in generator/forecast_clouds.py.
CURRENT_FCST_PREFIX=$(rclone cat "$REMOTE/manifest.json" 2>/dev/null \
  | python3 -c "import json,sys; print((json.load(sys.stdin).get('forecast_clouds') or {}).get('prefix',''))" 2>/dev/null || true)
FCST_EXCLUDE=()
if [ -n "$CURRENT_FCST_PREFIX" ]; then
  # prefix is "clouds-fcst/<runkey>" — strip the root for the exclude glob.
  FCST_EXCLUDE=(--exclude "${CURRENT_FCST_PREFIX#clouds-fcst/}/**")
fi
rclone delete "$REMOTE/clouds-fcst/" \
  --min-age "${KEEP_HOURS}h" \
  --use-server-modtime \
  "${FCST_EXCLUDE[@]}" \
  $VERBOSE_FLAG 2>/dev/null || true
rclone rmdirs "$REMOTE/clouds-fcst/" --leave-root $VERBOSE_FLAG 2>/dev/null || true

echo "==> Prune complete"
