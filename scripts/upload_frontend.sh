#!/usr/bin/env bash
# scripts/upload_frontend.sh — upload built frontend to the R2 site bucket.
# Run once after `bun run build` in frontend/, and again whenever the UI changes.
# Independent from the data-publish path (that's deploy_wrangler.sh / deploy.sh).

set -euo pipefail

DIST_DIR="${1:-frontend/dist}"
DIST_DIR="${DIST_DIR%/}"
BUCKET="${OPD_R2_BUCKET:-map-astroanil-dev}"
REMOTE="${OPD_RCLONE_REMOTE:-r2:$BUCKET}"

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

GLYPH_REL="glyphs/Open Sans Regular/0-255.pbf"
if [ ! -f "$DIST_DIR/$GLYPH_REL" ]; then
  echo "ERROR: $DIST_DIR/$GLYPH_REL missing. The plan inset reads this Open Sans PBF." >&2
  exit 2
fi

COUNT=0
GLYPHS_UPLOADED=0
FAILED_FILES=()
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT
file_list="$work_dir/files"
find_status=0
find "$DIST_DIR" -type f -print0 > "$file_list" || find_status=$?
if [ "$find_status" -ne 0 ]; then
  echo "ERROR: listing $DIST_DIR failed (find exit $find_status). No file was published." >&2
  exit 2
fi

index_assets() {
  python3 - "$@" <<'PY'
import os
import posixpath
import re
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit


class IndexAssets(HTMLParser):
    def __init__(self):
        super().__init__()
        self.assets = set()
        self.root = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else None
        self.upload_keys = set()
        if self.root is not None:
            self.upload_keys = {
                os.path.relpath(os.fsdecode(entry), sys.argv[2])
                for entry in Path(sys.argv[3]).read_bytes().split(b"\0") if entry
            }

    def validate_local_asset(self, path):
        if path.endswith("/") or path.rsplit("/", 1)[-1] in {".", ".."}:
            print("ERROR: local asset URL names a directory.", file=sys.stderr)
            sys.exit(3)
        key = posixpath.normpath(path.lstrip("/"))
        if "\0" in key or "\\" in key:
            print("ERROR: ambiguous local asset path in index.html.", file=sys.stderr)
            sys.exit(3)
        try:
            target = (self.root / key).resolve()
            target.relative_to(self.root)
        except (ValueError, OSError, RuntimeError):
            print(f"ERROR: local asset escapes dist: {key}", file=sys.stderr)
            sys.exit(3)
        if key not in self.upload_keys or not target.is_file():
            print(f"ERROR: local asset missing or excluded from upload: {key}", file=sys.stderr)
            sys.exit(3)

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if self.root is not None and tag == "base" and values.get("href"):
            print("ERROR: local asset preflight does not support base href.", file=sys.stderr)
            sys.exit(3)
        resource_link = tag == "link" and bool(
            set((values.get("rel") or "").lower().split()) & {
                "stylesheet", "modulepreload", "preload", "prefetch", "manifest",
                "icon", "apple-touch-icon", "apple-touch-icon-precomposed", "mask-icon",
            }
        )
        for name, value in attrs:
            if name in {"src", "href"} and value:
                if name == "href" and tag in {"a", "area", "form"}:
                    continue
                url = urlsplit(value)
                external = bool(url.scheme or url.netloc)
                path = url.path if external else unquote(url.path, errors="strict")
                if re.search(r"(?:^|/)index-[\w-]+\.(?:js|css)$", path):
                    self.assets.add(path)
                if self.root is not None and not external and path:
                    hashed = re.search(r"(?:^|/)[^/]+-[\w-]+\.[\w.]+$", path)
                    if name == "src" or resource_link or hashed:
                        self.validate_local_asset(path)


parser = IndexAssets()
parser.feed(Path(sys.argv[1]).read_text(encoding="utf-8"))
if not any(path.endswith(".js") for path in parser.assets):
    sys.exit("ERROR: index.html has no hashed index-*.js reference.")
print("\n".join(sorted(parser.assets)))
PY
}

local_status=0
index_assets "$DIST_DIR/index.html" "$DIST_DIR" "$file_list" > "$work_dir/local-assets" || local_status=$?
if [ "$local_status" -ne 0 ]; then
  echo "ERROR: cannot validate local index.html. No file was published." >&2
  if [ "$local_status" -eq 3 ]; then
    exit 3
  fi
  exit 2
fi

UPLOADER=wrangler
probe_key="_opd-upload-probe-$(basename "$work_dir").txt"
printf 'OPD R2 write probe\n' > "$work_dir/probe"
if probe_error=$(wrangler r2 object put "$BUCKET/$probe_key" \
  --file "$work_dir/probe" --content-type text/plain --remote 2>&1); then
  if ! wrangler r2 object delete "$BUCKET/$probe_key" --remote > /dev/null 2>&1; then
    echo "ERROR: R2 preflight probe cleanup failed: $BUCKET/$probe_key. No frontend file was published." >&2
    exit 3
  fi
  echo "==> R2 write/delete preflight passed"
elif grep -Ei '(code["[:space:]:=]+(403|10000)([^0-9]|$)|HTTP[^[:alnum:]]+403([^0-9]|$)|403[[:space:]]+Forbidden|status["[:space:]:=]+403([^0-9]|$))' \
  <<< "$probe_error" > /dev/null; then
  echo "ERROR: token lacks R2 write on $BUCKET (Cloudflare 403/10000)." >&2
  echo "==> Falling back to additive rclone copy; assets first, index.html then sw.js last."
  if ! command -v rclone > /dev/null 2>&1; then
    echo "ERROR: rclone is unavailable. No frontend file was published." >&2
    exit 3
  fi
  case "$REMOTE" in
    *:"$BUCKET") ;;
    *) echo "ERROR: OPD_RCLONE_REMOTE must target the root of $BUCKET." >&2; exit 2 ;;
  esac
  UPLOADER=rclone
else
  echo "ERROR: R2 write preflight failed without a recognized 403/10000; no frontend file was published." >&2
  exit 3
fi

report_failures() {
  echo "" >&2
  echo "==> $COUNT files uploaded, ${#FAILED_FILES[@]} FAILED:" >&2
  local f
  for f in "${FAILED_FILES[@]}"; do
    echo "    $f" >&2
  done
  echo "==> Re-run upload_frontend.sh after the failed puts succeed." >&2
  exit 3
}
upload_one() {
  local FILE="$1"
  local REL_PATH="${FILE#$DIST_DIR/}"
  local CT CC
  CT=$(content_type_for "$REL_PATH")
  CC=$(cache_control_for "$REL_PATH")
  if [ "$UPLOADER" = rclone ]; then
    if rclone copyto "$FILE" "$REMOTE/$REL_PATH" --ignore-times \
      --header-upload "Content-Type: $CT" \
      --header-upload "Cache-Control: $CC" > /dev/null 2>&1; then
      :
    else
      FAILED_FILES+=("$REL_PATH")
      echo "  ✗ $REL_PATH (rclone copy failed)" >&2
      return 1
    fi
  elif ! wrangler r2 object put "$BUCKET/$REL_PATH" \
    --file "$FILE" --content-type "$CT" --cache-control "$CC" \
    --remote > /dev/null 2>&1; then
    echo "  ✗ $REL_PATH" >&2
    FAILED_FILES+=("$REL_PATH")
    return 1
  fi
  COUNT=$((COUNT + 1))
  if [ "$REL_PATH" = "$GLYPH_REL" ]; then
    GLYPHS_UPLOADED=1
  fi
  echo "  ✓ $REL_PATH"
}

ASSET_FILES=()
OTHER_FILES=()
while IFS= read -r -d '' FILE; do
  REL_PATH="${FILE#$DIST_DIR/}"
  case "$REL_PATH" in
    assets/*) ASSET_FILES+=("$FILE") ;;
    index.html|sw.js|registerSW.js|sw-shell.js|manifest.webmanifest) ;;
    *) OTHER_FILES+=("$FILE") ;;
  esac
done < "$file_list"

if [ "${#ASSET_FILES[@]}" -gt 0 ]; then
  for FILE in "${ASSET_FILES[@]}"; do
    upload_one "$FILE" || true
  done
fi
if [ "${#FAILED_FILES[@]}" -gt 0 ]; then
  echo "==> Asset upload failed. No shell file was published." >&2
  report_failures
fi

for FILE in "${OTHER_FILES[@]}"; do
  upload_one "$FILE" || true
done

if [ "${#FAILED_FILES[@]}" -gt 0 ]; then
  echo "==> Asset upload failed. No shell file was published." >&2
  report_failures
fi

if [ "$GLYPHS_UPLOADED" -ne 1 ]; then
  echo "ERROR: $GLYPH_REL was not uploaded." >&2
  exit 3
fi

# Helper and registration before the document, sw.js last. The new worker
# imports sw-shell.js and seeds index.html as soon as sw.js is fetched.
for name in manifest.webmanifest sw-shell.js registerSW.js index.html sw.js; do
  if [ -f "$DIST_DIR/$name" ]; then
    upload_one "$DIST_DIR/$name" || report_failures
  fi
done

if [ "$UPLOADER" = rclone ]; then
  if ! rclone cat "$REMOTE/index.html" > "$work_dir/remote-index.html" 2>/dev/null; then
    echo "ERROR: could not read R2 index.html after upload." >&2
    exit 3
  fi
elif ! wrangler r2 object get "$BUCKET/index.html" \
  --file "$work_dir/remote-index.html" --remote > /dev/null 2>&1; then
  echo "ERROR: could not read R2 index.html after upload." >&2
  exit 3
fi
if ! index_assets "$work_dir/remote-index.html" > "$work_dir/remote-assets" || \
  ! cmp -s "$work_dir/local-assets" "$work_dir/remote-assets"; then
  echo "ERROR: R2 index.html hashed index-*.js/.css references do not match local dist." >&2
  exit 3
fi

echo "==> Verified R2 index.html hashed JS/CSS references match local dist"
echo "==> Uploaded $COUNT frontend files to $BUCKET"
echo "==> Live at https://map.astroanil.dev"
