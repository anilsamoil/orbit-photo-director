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
    *.webmanifest) echo "application/manifest+json" ;;
    *.svg)         echo "image/svg+xml" ;;
    *.png)         echo "image/png" ;;
    *.woff|*.woff2) echo "font/woff2" ;;
    *.pbf)         echo "application/x-protobuf" ;;
    *)             echo "application/octet-stream" ;;
  esac
}

cache_control_for() {
  case "$1" in
    *.html|sw.js|registerSW.js|sw-shell.js|manifest.webmanifest)
      echo "no-cache, max-age=0, must-revalidate" ;;
    assets/*|*/assets/*|workbox-*.js|*.css|*.js|*.map)
      echo "public, max-age=31536000, immutable" ;;
    *)
      echo "public, max-age=300" ;;
  esac
}

is_shell_entry() {
  case "$1" in
    index.html|sw.js|registerSW.js|sw-shell.js|manifest.webmanifest) return 0 ;;
  esac
  return 1
}

GLYPH_REL="glyphs/Open Sans Regular/0-255.pbf"
if [ ! -f "$DIST_DIR/$GLYPH_REL" ]; then
  echo "ERROR: $DIST_DIR/$GLYPH_REL missing. The plan inset reads this Open Sans PBF." >&2
  exit 2
fi

COUNT=0
GLYPHS_UPLOADED=0
FAILED_FILES=()
upload_one() {
  local FILE="$1"
  local REL_PATH="${FILE#$DIST_DIR/}"
  local CT CC WRANGLER_ERR
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
    return
  }
  COUNT=$((COUNT + 1))
  if [ "$REL_PATH" = "$GLYPH_REL" ]; then
    GLYPHS_UPLOADED=1
  fi
  echo "  ✓ $REL_PATH"
}

SHELL_FILES=()
while IFS= read -r FILE; do
  REL_PATH="${FILE#$DIST_DIR/}"
  if is_shell_entry "$REL_PATH"; then
    SHELL_FILES+=("$FILE")
    continue
  fi
  upload_one "$FILE"
done < <(find "$DIST_DIR" -type f)

# Helper and registration before the document, sw.js last. The new worker
# imports sw-shell.js and seeds index.html as soon as sw.js is fetched.
for name in manifest.webmanifest sw-shell.js registerSW.js index.html sw.js; do
  for FILE in "${SHELL_FILES[@]}"; do
    if [ "${FILE#$DIST_DIR/}" = "$name" ]; then
      upload_one "$FILE"
    fi
  done
done

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

if [ "$GLYPHS_UPLOADED" -ne 1 ]; then
  echo "ERROR: $GLYPH_REL was not uploaded." >&2
  exit 3
fi

echo "==> Uploaded $COUNT frontend files to $BUCKET"
echo "==> Live at https://map.astroanil.dev"
