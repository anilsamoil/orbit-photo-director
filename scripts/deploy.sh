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

echo "==> Atomic pointer flip: copying manifest.json LAST"
rclone copyto "$OUT_DIR/manifest.json" "$REMOTE/manifest.json" \
  --header-upload "Cache-Control: public, max-age=10" \
  $VERBOSE_FLAG

echo "==> Pruning remote versions older than 2h (AFTER manifest flip)"
rclone delete "$REMOTE/v/" --min-age 2h $VERBOSE_FLAG || true
rclone rmdirs "$REMOTE/v/" --leave-root $VERBOSE_FLAG 2>/dev/null || true

echo "==> Deploy complete"
