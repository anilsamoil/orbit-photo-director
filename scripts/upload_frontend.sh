#!/usr/bin/env bash
# scripts/upload_frontend.sh — upload built frontend to the R2 site bucket.
# Run once after `bun run build` in frontend/, and again whenever the UI changes.
# Independent from the data-publish path (that's deploy_wrangler.sh / deploy.sh).

set -euo pipefail

DIST_DIR="${1:-frontend/dist}"
BUCKET="${OPD_R2_BUCKET:-map-astroanil-dev}"

if [ ! -d "$DIST_DIR" ]; then
  echo "ERROR: $DIST_DIR not found. Run 'cd frontend && bun run build' first." >&2
  exit 2
fi

content_type_for() {
  case "$1" in
    *.html)        echo "text/html; charset=utf-8" ;;
    *.css)         echo "text/css; charset=utf-8" ;;
    *.js)          echo "application/javascript; charset=utf-8" ;;
    *.js.map|*.css.map) echo "application/json" ;;
    *.json)        echo "application/json" ;;
    *.svg)         echo "image/svg+xml" ;;
    *.png)         echo "image/png" ;;
    *.woff|*.woff2) echo "font/woff2" ;;
    *)             echo "application/octet-stream" ;;
  esac
}

cache_control_for() {
  case "$1" in
    *index.html) echo "public, max-age=60" ;;          # short — manifest pointer
    /assets/*)   echo "public, max-age=31536000, immutable" ;;  # hashed names
    *.js|*.css)  echo "public, max-age=31536000, immutable" ;;
    *)           echo "public, max-age=300" ;;
  esac
}

COUNT=0
while IFS= read -r FILE; do
  REL_PATH="${FILE#$DIST_DIR/}"
  CT=$(content_type_for "$REL_PATH")
  CC=$(cache_control_for "$REL_PATH")
  wrangler r2 object put "$BUCKET/$REL_PATH" \
    --file "$FILE" \
    --content-type "$CT" \
    --cache-control "$CC" \
    --remote >/dev/null 2>&1
  COUNT=$((COUNT + 1))
  echo "  $REL_PATH"
done < <(find "$DIST_DIR" -type f)

echo "==> Uploaded $COUNT frontend files to $BUCKET"
echo "==> Live at https://map.astroanil.dev"
