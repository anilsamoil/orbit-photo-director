#!/usr/bin/env bash
# Proves a failed object put does not publish the page shell.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SCRIPT="$ROOT/scripts/upload_frontend.sh"

make_dist() {
  local dir="$1"
  mkdir -p "$dir/assets" "$dir/glyphs/Open Sans Regular"
  printf 'asset' > "$dir/assets/app.js"
  printf 'glyph' > "$dir/glyphs/Open Sans Regular/0-255.pbf"
  printf 'manifest' > "$dir/manifest.webmanifest"
  printf 'helper' > "$dir/sw-shell.js"
  printf 'register' > "$dir/registerSW.js"
  printf 'page' > "$dir/index.html"
  printf 'worker' > "$dir/sw.js"
}

run_case() {
  local name="$1"
  local fail_on="$2"
  local work keys
  work=$(mktemp -d)
  keys="$work/keys"
  make_dist "$work/dist"
  cat > "$work/wrangler" <<'EOF'
#!/bin/sh
key=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "put" ]; then
    key=$arg
  fi
  prev=$arg
done
printf '%s\n' "$key" >> "$WRANGLER_KEYS"
if [ -n "${FAIL_ON:-}" ] && [ "${key#"$OPD_R2_BUCKET/"}" = "$FAIL_ON" ]; then
  echo "put failed: $key" >&2
  exit 1
fi
exit 0
EOF
  chmod +x "$work/wrangler"
  set +e
  PATH="$work:$PATH" \
    WRANGLER_KEYS="$keys" \
    FAIL_ON="$fail_on" \
    OPD_R2_BUCKET="test-bucket" \
    "$SCRIPT" "$work/dist" >"$work/out" 2>"$work/err"
  local code=$?
  set -e
  printf '%s\n' "$code" > "$work/code"
  CASE_CODE=$(cat "$work/code")
  CASE_KEYS=$(cat "$keys")
  CASE_ERR=$(cat "$work/err")
  rm -rf "$work"
  echo "== $name exit $CASE_CODE"
}

assert_absent() {
  local key="$1"
  if printf '%s\n' "$CASE_KEYS" | grep -qx "test-bucket/$key"; then
    echo "FAIL: $key was put" >&2
    printf '%s\n' "$CASE_KEYS" >&2
    exit 1
  fi
}

assert_present() {
  local key="$1"
  if ! printf '%s\n' "$CASE_KEYS" | grep -qx "test-bucket/$key"; then
    echo "FAIL: $key was not put" >&2
    printf '%s\n' "$CASE_KEYS" >&2
    exit 1
  fi
}

run_case "asset failure" "assets/app.js"
if [ "$CASE_CODE" -eq 0 ]; then
  echo "FAIL: asset failure exited 0" >&2
  exit 1
fi
assert_absent "index.html"
assert_absent "sw.js"

run_case "helper failure" "sw-shell.js"
if [ "$CASE_CODE" -eq 0 ]; then
  echo "FAIL: helper failure exited 0" >&2
  exit 1
fi
assert_absent "sw.js"

run_case "document failure" "index.html"
if [ "$CASE_CODE" -eq 0 ]; then
  echo "FAIL: document failure exited 0" >&2
  exit 1
fi
assert_absent "sw.js"

run_case "success" ""
if [ "$CASE_CODE" -ne 0 ]; then
  echo "FAIL: success exited $CASE_CODE" >&2
  printf '%s\n' "$CASE_ERR" >&2
  exit 1
fi
last=$(printf '%s\n' "$CASE_KEYS" | tail -n 5)
expected=$(printf '%s\n' \
  "test-bucket/manifest.webmanifest" \
  "test-bucket/sw-shell.js" \
  "test-bucket/registerSW.js" \
  "test-bucket/index.html" \
  "test-bucket/sw.js")
if [ "$last" != "$expected" ]; then
  echo "FAIL: shell was not published with sw.js last" >&2
  printf '%s\n' "$last" >&2
  exit 1
fi
assert_present "assets/app.js"

echo "upload_frontend.test.sh passed"
