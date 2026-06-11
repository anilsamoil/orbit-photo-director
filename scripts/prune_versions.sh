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

# 4. Forecast cloud runs (V4-P2, rewritten 2026-06-11 per ship review):
# keep the TWO newest run dirs by name (compact keys sort chronologically),
# mirroring the generator's local KEEP_RUNS=2 — the previous run must
# survive so clients on a not-yet-flipped manifest never 404. The earlier
# --min-age approach deleted the deliberately-kept previous run every day
# (delete/re-upload churn + a 404 window), and its empty-exclude array
# aborted under bash 3.2 set -u whenever the manifest had no
# forecast_clouds key (i.e. the feature-off default — the prune cron died
# before this point on every run).
FCST_DIRS=$(rclone lsf "$REMOTE/clouds-fcst/" --dirs-only 2>/dev/null | sed 's:/$::' | sort || true)
if [ -n "$FCST_DIRS" ]; then
  KEEPERS=$(printf '%s\n' "$FCST_DIRS" | tail -2)
  printf '%s\n' "$FCST_DIRS" | while IFS= read -r RUN_DIR; do
    [ -z "$RUN_DIR" ] && continue
    if printf '%s\n' "$KEEPERS" | grep -qx "$RUN_DIR"; then
      continue
    fi
    echo "==> Pruning old forecast run: clouds-fcst/$RUN_DIR"
    rclone purge "$REMOTE/clouds-fcst/$RUN_DIR" $VERBOSE_FLAG 2>/dev/null || true
  done
fi
rclone rmdirs "$REMOTE/clouds-fcst/" --leave-root $VERBOSE_FLAG 2>/dev/null || true

echo "==> Prune complete"
