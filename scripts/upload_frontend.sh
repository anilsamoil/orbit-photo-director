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
FAILED_FILES=()
while IFS= read -r FILE; do
  REL_PATH="${FILE#$DIST_DIR/}"
  CT=$(content_type_for "$REL_PATH")
  CC=$(cache_control_for "$REL_PATH")
  # Capture stderr so we can surface real errors instead of silently
  # leaving index.html pointing at a 404'd asset on R2. `wrangler r2
  # object put` writes useful error detail (auth failure, network, R2
  # quota) to stderr.
  WRANGLER_ERR=$(wrangler r2 object put "$BUCKET/$REL_PATH" \
    --file "$FILE" \
    --content-type "$CT" \
    --cache-control "$CC" \
    --remote 2>&1 >/dev/null) || {
    echo "  ✗ $REL_PATH" >&2
    echo "    $WRANGLER_ERR" | head -5 | sed 's/^/    /' >&2
    FAILED_FILES+=("$REL_PATH")
    continue
  }
  COUNT=$((COUNT + 1))
  echo "  ✓ $REL_PATH"
done < <(find "$DIST_DIR" -type f)

if [ "${#FAILED_FILES[@]}" -gt 0 ]; then
  echo "" >&2
  echo "==> $COUNT files uploaded, ${#FAILED_FILES[@]} FAILED:" >&2
  for f in "${FAILED_FILES[@]}"; do
    echo "    $f" >&2
  done
  echo "==> NOT updating index.html assumption — the site may reference" >&2
  echo "    assets that didn't upload. Re-run upload_frontend.sh, or" >&2
  echo "    inspect the errors above." >&2
  exit 3
fi

echo "==> Uploaded $COUNT frontend files to $BUCKET"
echo "==> Live at https://map.astroanil.dev"
