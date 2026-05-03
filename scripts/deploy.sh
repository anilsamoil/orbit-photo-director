#!/usr/bin/env bash
# scripts/deploy.sh — sync the latest generator output to Cloudflare R2.
#
# Order matters:
#   1. Sync versioned subfolders first (out/v/* → r2:.../v/*).
#   2. Copy manifest.json LAST — atomic pointer flip; readers never see torn state.
#   3. Trigger a small cleanup of versions older than 1h on the bucket.
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

echo "==> Syncing versioned artifacts: $OUT_DIR/v/ -> $REMOTE/v/"
rclone sync "$OUT_DIR/v/" "$REMOTE/v/" \
  --transfers 4 \
  --checkers 8 \
  --header-upload "Cache-Control: public, max-age=3600, immutable" \
  $VERBOSE_FLAG

echo "==> Atomic pointer flip: copying manifest.json LAST"
rclone copyto "$OUT_DIR/manifest.json" "$REMOTE/manifest.json" \
  --header-upload "Cache-Control: public, max-age=10" \
  $VERBOSE_FLAG

echo "==> Cleanup remote versions older than 1h"
# rclone delete by min-age (entries OLDER than min-age get deleted)
rclone delete "$REMOTE/v/" --min-age 1h $VERBOSE_FLAG || true

echo "==> Deploy complete"
