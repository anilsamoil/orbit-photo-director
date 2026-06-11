#!/usr/bin/env bash
# scripts/deploy_wrangler.sh — fallback deploy using wrangler r2 object commands.
#
# Slower than rclone (one HTTP round-trip per file) but works with the OAuth
# session that `wrangler login` creates. Use when R2 API keys aren't yet
# generated. Once you have an S3-compatible R2 token (Cloudflare dashboard →
# R2 → Manage API Tokens), prefer scripts/deploy.sh which uses rclone.
#
# Same atomic-publish ordering as deploy.sh: copy versioned dir first, then
# manifest.json, then prune old versions.

set -euo pipefail

OUT_DIR="${OPD_OUT:-out}"
BUCKET="${OPD_R2_BUCKET:-map-astroanil-dev}"

if ! command -v wrangler >/dev/null 2>&1; then
  echo "ERROR: wrangler not installed" >&2
  exit 2
fi

if [ ! -f "$OUT_DIR/manifest.json" ]; then
  echo "ERROR: $OUT_DIR/manifest.json not found. Run 'make tick' first." >&2
  exit 3
fi

# 1. Upload versioned subfolder contents (additive — never use delete).
VERSION=$(python3 -c "import json,sys; print(json.load(open('$OUT_DIR/manifest.json'))['version'])")
echo "==> Uploading version $VERSION artifacts to r2:$BUCKET/v/$VERSION/"

V_DIR="$OUT_DIR/v/$VERSION"
if [ ! -d "$V_DIR" ]; then
  echo "ERROR: version dir $V_DIR missing" >&2
  exit 4
fi

# wrangler r2 object put doesn't recursively upload, so loop manually.
# Find every file under v/$VERSION and upload it.
COUNT=0
while IFS= read -r FILE; do
  REL_PATH="${FILE#$OUT_DIR/}"
  CONTENT_TYPE="application/octet-stream"
  case "$FILE" in
    *.json) CONTENT_TYPE="application/json" ;;
    *.png)  CONTENT_TYPE="image/png" ;;
    *.html) CONTENT_TYPE="text/html; charset=utf-8" ;;
    *.txt)  CONTENT_TYPE="text/plain; charset=utf-8" ;;
  esac
  wrangler r2 object put "$BUCKET/$REL_PATH" \
    --file "$FILE" \
    --content-type "$CONTENT_TYPE" \
    --cache-control "public, max-age=3600, immutable" \
    --remote >/dev/null 2>&1
  COUNT=$((COUNT + 1))
done < <(find "$V_DIR" -type f)
echo "==> Uploaded $COUNT version artifacts"

# 2. Atomic pointer flip: copy manifest.json LAST.
#
# V4-P2 guard (Codex adversarial 2026-06-11): this fallback path uploads
# only v/$VERSION — it does NOT upload out/clouds-fcst/ (per-file wrangler
# puts for ~1,800 tiles would blow the deploy timeout). Publishing a
# manifest whose forecast_clouds index points at never-uploaded tiles
# would 404 every client and trip their one-way session fallback. Strip
# the key before flipping: clients gracefully stay on the observed layer
# (locked A4) until an rclone deploy publishes the frames.
MANIFEST_TO_FLIP="$OUT_DIR/manifest.json"
if python3 -c "import json,sys; sys.exit(0 if 'forecast_clouds' in json.load(open('$OUT_DIR/manifest.json')) else 1)" 2>/dev/null; then
  echo "WARN: wrangler fallback cannot upload forecast cloud frames — stripping forecast_clouds from the published manifest (observed-layer fallback)" >&2
  MANIFEST_TO_FLIP=$(mktemp)
  python3 -c "
import json
m = json.load(open('$OUT_DIR/manifest.json'))
m.pop('forecast_clouds', None)
open('$MANIFEST_TO_FLIP', 'w').write(json.dumps(m, indent=2, sort_keys=True))
"
fi
echo "==> Atomic flip: writing manifest.json"
wrangler r2 object put "$BUCKET/manifest.json" \
  --file "$MANIFEST_TO_FLIP" \
  --content-type "application/json" \
  --cache-control "public, max-age=10" \
  --remote >/dev/null 2>&1

echo "==> Deploy complete. Live at https://map.astroanil.dev"
echo "    Version: $VERSION"
echo "    Note: pruning of old remote versions is deferred (wrangler has no list-prune"
echo "          shortcut). Generate R2 API keys + use scripts/deploy.sh for full pipeline."
