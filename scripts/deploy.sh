#!/usr/bin/env bash
# scripts/deploy.sh — publish the latest generator output to Cloudflare R2.
#
# Order matters. NEVER `rclone sync` /v/ because sync deletes destination files
# missing locally — after cleanup_old_versions prunes a 60-min-old folder that
# the CURRENT manifest still points to, a sync would erase it from R2 first and
# break readers between that step and the manifest flip.
#
# Correct order:
#   1. `rclone copy` (additive) the new versioned artifacts to /v/.
#   2. Atomic `rclone copyto` of manifest.json (single-file flip).
#   3. Prune remote versions older than 2h (AFTER manifest flip — the 2h horizon
#      vs local 1h gives in-flight readers headroom against the prior version).
#
# Run from the repo root. Environment vars (with defaults):
#   OPD_OUT          path to out/ dir (default: out)
#   OPD_RCLONE_REMOTE  rclone remote target (default: r2:map-astroanil-dev)
#   OPD_VERBOSE      "1" to enable rclone --progress
#
# Exit codes: 0 = ok, non-zero = sync failed (see stderr).

set -euo pipefail

OUT_DIR="${OPD_OUT:-out}"
REMOTE="${OPD_RCLONE_REMOTE:-r2:map-astroanil-dev}"
VERBOSE_FLAG=""
[ "${OPD_VERBOSE:-0}" = "1" ] && VERBOSE_FLAG="--progress"

if ! command -v rclone >/dev/null 2>&1; then
  echo "ERROR: rclone not installed. Install via: brew install rclone" >&2
  exit 2
fi

if [ ! -f "$OUT_DIR/manifest.json" ]; then
  echo "ERROR: $OUT_DIR/manifest.json not found. Run 'make tick' first." >&2
  exit 3
fi

echo "==> Uploading new versioned artifacts (additive copy): $OUT_DIR/v/ -> $REMOTE/v/"
rclone copy "$OUT_DIR/v/" "$REMOTE/v/" \
  --transfers 4 \
  --checkers 8 \
  --header-upload "Cache-Control: public, max-age=3600, immutable" \
  $VERBOSE_FLAG

# V4-P2 forecast cloud frames (additive copy BEFORE the manifest flip, same
# rationale as /v/: the manifest must never reference a frame set that isn't
# fully uploaded). Scoped to the run the manifest actually references (ship
# review 2026-06-11): new tiles exist twice a day, but this deploy runs
# every tick — copying the whole clouds-fcst tree paid a ~3,200-file no-op
# listing 22 of 24 times. Run dirs are immutable once published; pruning
# lives in prune_versions.sh (no-sync-deletes discipline, same as /v/).
FCST_PREFIX=$(python3 -c "import json;print((json.load(open('$OUT_DIR/manifest.json')).get('forecast_clouds') or {}).get('prefix',''))" 2>/dev/null || true)
if [ -n "$FCST_PREFIX" ] && [ -d "$OUT_DIR/$FCST_PREFIX" ]; then
  echo "==> Uploading forecast cloud frames (additive copy): $OUT_DIR/$FCST_PREFIX/ -> $REMOTE/$FCST_PREFIX/"
  rclone copy "$OUT_DIR/$FCST_PREFIX/" "$REMOTE/$FCST_PREFIX/" \
    --transfers 8 \
    --checkers 16 \
    --header-upload "Cache-Control: public, max-age=21600, immutable" \
    $VERBOSE_FLAG
fi

echo "==> Atomic pointer flip: copying manifest.json LAST"
rclone copyto "$OUT_DIR/manifest.json" "$REMOTE/manifest.json" \
  --header-upload "Cache-Control: public, max-age=10" \
  $VERBOSE_FLAG

# NOTE: pruning is intentionally NOT done in this deploy step.
# `rclone delete --min-age` uses the SOURCE mtime stored in X-Amz-Meta-Mtime
# headers (not the upload time), which means a freshly-uploaded file can be
# pruned the moment it lands if its source mtime was old. We learned this the
# hard way. R2 storage is cheap; we let versions accumulate and prune via the
# separate `scripts/prune_versions.sh` (run daily from cron, or on demand).

echo "==> Deploy complete"
