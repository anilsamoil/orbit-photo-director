#!/usr/bin/env bash
# Exercises both upload paths against a local object-store double; no credentials.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SCRIPT="${UPLOAD_FRONTEND_SCRIPT:-$ROOT/scripts/upload_frontend.sh}"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"
cat > "$WORK/bin/object-store" <<'PY'
#!/usr/bin/env python3
import json
import os
from pathlib import Path
import sys

tool = Path(sys.argv[0]).name
args = sys.argv[1:]
work = Path(os.environ["CASE_DIR"])
with (work / "calls").open("a") as log:
    log.write(json.dumps([tool, *args]) + "\n")


def fail(message):
    print(message + " synthetic-secret-do-not-print", file=sys.stderr)
    sys.exit(1)


if tool == "wrangler":
    assert args[:2] == ["r2", "object"] and "--remote" in args
    action, target = args[2:4]
    assert target.startswith("test-bucket/")
    key = target.split("/", 1)[1]
    probe = key.startswith("_opd-upload-probe-") and key.endswith(".txt")
    if action == "put" and probe:
        mode = os.environ["PROBE_MODE"]
        if mode == "auth403":
            print("HTTP 403 Authentication error synthetic-secret-do-not-print")
            sys.exit(1)
        if mode == "auth10000":
            fail("Authentication error [code: 10000]")
        if mode == "generic":
            fail("Connection timed out")
        if mode == "timeout10000":
            fail("Connection timeout after 10000 ms")
    if action == "delete":
        assert probe, "deleting a frontend object is forbidden"
        if os.environ["PROBE_MODE"] == "cleanup":
            fail("HTTP 403 Authentication error")
        (work / "remote" / key).unlink()
        sys.exit(0)
    if action == "put":
        source = Path(args[args.index("--file") + 1])
    else:
        assert action == "get" and key == "index.html"
elif tool == "rclone":
    action = args[0]
    assert action in {"copyto", "cat"}, "only additive copy and readback are allowed"
    target = args[2] if action == "copyto" else args[1]
    assert target.startswith("r2:test-bucket/")
    key = target.split("/", 1)[1]
    if action == "copyto":
        assert "--ignore-times" in args
        assert args.count("--header-upload") == 2
        source = Path(args[1])
else:
    raise AssertionError(tool)

remote = work / "remote" / key
if action in {"put", "copyto"}:
    if key == os.environ.get("FAIL_ON"):
        fail("Upload failed")
    remote.parent.mkdir(parents=True, exist_ok=True)
    remote.write_bytes(source.read_bytes())
else:
    mode = os.environ["READ_MODE"]
    if mode == "failure":
        fail("Read failed")
    data = remote.read_text()
    if mode == "stale-js":
        data = data.replace("index-current.js", "index-stale.js")
    if mode == "stale-css":
        data = data.replace("index-current.css", "index-stale.css")
    if mode == "empty":
        data = "<html>no hashed assets</html>"
    if tool == "rclone":
        print(data, end="")
    else:
        Path(args[args.index("--file") + 1]).write_text(data)
PY
chmod +x "$WORK/bin/object-store"
ln -s object-store "$WORK/bin/wrangler"
ln -s object-store "$WORK/bin/rclone"

run_case() {
  local name="$1" probe="${2:-success}" fail_on="${3:-}" read_mode="${4:-success}"
  CASE_DIR="$WORK/$name"
  mkdir -p "$CASE_DIR/dist/assets" "$CASE_DIR/dist/glyphs/Open Sans Regular" "$CASE_DIR/remote"
  printf 'keep me' > "$CASE_DIR/remote/older-live-asset.js"
  printf 'asset' > "$CASE_DIR/dist/assets/index-current.js"
  printf 'css' > "$CASE_DIR/dist/assets/index-current.css"
  printf 'glyph' > "$CASE_DIR/dist/glyphs/Open Sans Regular/0-255.pbf"
  printf 'other' > "$CASE_DIR/dist/favicon.svg"
  printf 'manifest' > "$CASE_DIR/dist/manifest.webmanifest"
  printf 'helper' > "$CASE_DIR/dist/sw-shell.js"
  printf 'register' > "$CASE_DIR/dist/registerSW.js"
  printf '<script src="/assets/index-current.js"></script>\n<link href=\x27/assets/index-current.css\x27 rel="stylesheet">\n' > "$CASE_DIR/dist/index.html"
  printf 'worker' > "$CASE_DIR/dist/sw.js"
  case "$name" in
    missing-glyph) rm "$CASE_DIR/dist/glyphs/Open Sans Regular/0-255.pbf" ;;
    bad-local-index) printf '<html>no assets</html>' > "$CASE_DIR/dist/index.html" ;;
    empty-assets)
      mv "$CASE_DIR/dist/assets/index-current.js" "$CASE_DIR/dist/index-current.js"
      mv "$CASE_DIR/dist/assets/index-current.css" "$CASE_DIR/dist/index-current.css"
      printf '<script src="/index-current.js"></script><link href="/index-current.css">' > "$CASE_DIR/dist/index.html" ;;
    missing-index-js) rm "$CASE_DIR/dist/assets/index-current.js" ;;
    missing-index-css) rm "$CASE_DIR/dist/assets/index-current.css" ;;
    missing-modulepreload)
      printf '<link rel="modulepreload" href="/assets/vendor-DEADBEEF.js">' >> "$CASE_DIR/dist/index.html" ;;
    missing-registersw)
      printf '<script src="/registerSW.js"></script>' >> "$CASE_DIR/dist/index.html"
      rm "$CASE_DIR/dist/registerSW.js" ;;
    missing-helper)
      printf '<script src="./sw-shell.js"></script>' >> "$CASE_DIR/dist/index.html"
      rm "$CASE_DIR/dist/sw-shell.js" ;;
    missing-manifest)
      printf '<link rel="manifest" href="./manifest.webmanifest">' >> "$CASE_DIR/dist/index.html"
      rm "$CASE_DIR/dist/manifest.webmanifest" ;;
    missing-other-hashed-link)
      printf '<link rel="alternate" href="/assets/vendor-DEADBEEF.js">' >> "$CASE_DIR/dist/index.html" ;;
    missing-image)
      printf '<img src="/images/missing.png">' >> "$CASE_DIR/dist/index.html" ;;
    missing-icon)
      printf '<link rel="shortcut icon" href="/missing.svg">' >> "$CASE_DIR/dist/index.html" ;;
    missing-preload)
      printf '<link rel="preload" as="font" href="/fonts/missing.woff2">' >> "$CASE_DIR/dist/index.html" ;;
    missing-encoded-path)
      printf '<script src="/assets/missing%%20file.js?v=1#module"></script>' >> "$CASE_DIR/dist/index.html" ;;
    outside-traversal|outside-encoded-traversal)
      printf 'outside' > "$CASE_DIR/outside.js"
      if [ "$name" = outside-traversal ]; then
        printf '<script src="../outside.js"></script>' >> "$CASE_DIR/dist/index.html"
      else
        printf '<script src="%%2e%%2e/outside.js"></script>' >> "$CASE_DIR/dist/index.html"
      fi ;;
    symlink-alias)
      ln -s index-current.js "$CASE_DIR/dist/assets/alias.js"
      printf '<script src="/assets/alias.js"></script>' >> "$CASE_DIR/dist/index.html" ;;
    symlink-outside-file)
      printf 'outside' > "$CASE_DIR/outside.js"
      ln -s "$CASE_DIR/outside.js" "$CASE_DIR/dist/outside.js"
      printf '<script src="/outside.js"></script>' >> "$CASE_DIR/dist/index.html" ;;
    symlink-outside-directory)
      mkdir "$CASE_DIR/outside"
      printf 'outside' > "$CASE_DIR/outside/module.js"
      ln -s "$CASE_DIR/outside" "$CASE_DIR/dist/linked"
      printf '<script src="/linked/module.js"></script>' >> "$CASE_DIR/dist/index.html" ;;
    directory-resource)
      printf '<script src="/assets"></script>' >> "$CASE_DIR/dist/index.html" ;;
    trailing-slash-resource)
      printf '<img src="/assets/index-current.js/">' >> "$CASE_DIR/dist/index.html" ;;
    encoded-trailing-slash-resource)
      printf '<img src="/assets/index-current.js%%2F">' >> "$CASE_DIR/dist/index.html" ;;
    trailing-dot-resource)
      printf '<img src="/assets/index-current.js/.">' >> "$CASE_DIR/dist/index.html" ;;
    unsupported-base)
      printf '<base href="/nested/">' >> "$CASE_DIR/dist/index.html" ;;
    valid-resource-urls)
      printf 'literal percent' > "$CASE_DIR/dist/assets/literal%20name.js"
      cat > "$CASE_DIR/dist/index.html" <<'HTML'
<base href="">
<script src="./assets/index%2Dcurrent.js?v=1#module"></script>
<link rel="stylesheet" href="/assets/index-current.css?v=2#style">
<link rel="modulepreload" href="./assets/index-current.js?preload#module">
<link rel="preload" href="/glyphs/Open%20Sans%20Regular/0-255.pbf?v=1#glyph">
<script src="/assets/literal%2520name.js"></script>
<script src="./registerSW.js"></script>
<link rel="manifest" href="/manifest.webmanifest?version=1">
HTML
      ;;
    ignored-external-navigation)
      cat >> "$CASE_DIR/dist/index.html" <<'HTML'
<script src="https://cdn.invalid/absent.js"></script>
<img src="https://example.com/%FF.png">
<script src="//cdn.invalid/absent.js"></script>
<script src="data:text/javascript,void(0)"></script>
<script src="blob:https://example.invalid/id"></script>
<img src="#fragment">
<a href="/settings">Settings</a>
<a href="/assets/navigation-DEADBEEF.js">Download</a>
<form action="/submit"><button formaction="/elsewhere">Submit</button></form>
HTML
      ;;
    listing-failure)
      printf '#!/bin/sh\nexit 1\n' > "$WORK/bin/find"
      chmod +x "$WORK/bin/find" ;;
  esac
  : > "$CASE_DIR/calls"
  local status=0
  if [ "$name" = wrong-remote ]; then
    env -u OPD_RCLONE_REMOTE PATH="$WORK/bin:$PATH" CASE_DIR="$CASE_DIR" \
      PROBE_MODE="$probe" FAIL_ON="$fail_on" READ_MODE="$read_mode" \
      OPD_R2_BUCKET=test-bucket OPD_RCLONE_REMOTE=r2:another-bucket \
      "$SCRIPT" "$CASE_DIR/dist/" > "$CASE_DIR/out" 2> "$CASE_DIR/err" || status=$?
  else
    env -u OPD_RCLONE_REMOTE PATH="$WORK/bin:$PATH" CASE_DIR="$CASE_DIR" \
      PROBE_MODE="$probe" FAIL_ON="$fail_on" READ_MODE="$read_mode" \
      OPD_R2_BUCKET=test-bucket \
      "$SCRIPT" "$CASE_DIR/dist/" > "$CASE_DIR/out" 2> "$CASE_DIR/err" || status=$?
  fi
  rm -f "$WORK/bin/find"
  CASE_CODE=$status
  if grep -q synthetic-secret-do-not-print "$CASE_DIR/out" "$CASE_DIR/err"; then
    echo "FAIL: $name leaked raw tool output" >&2; exit 1
  fi
  test "$(cat "$CASE_DIR/remote/older-live-asset.js")" = 'keep me'
  assert_calls safety
  echo "== $name exit $CASE_CODE"
}

assert_code() {
  if [ "$CASE_CODE" -ne "$1" ]; then
    cat "$CASE_DIR/err" >&2
    echo "FAIL: expected exit $1, got $CASE_CODE" >&2; exit 1
  fi
}

assert_calls() {
  python3 - "$CASE_DIR" "$1" <<'PY'
import json
from pathlib import Path
import sys

work, check = Path(sys.argv[1]), sys.argv[2]
calls = [json.loads(line) for line in (work / "calls").read_text().splitlines()]
uploads = []
for call in calls:
    tool, *args = call
    if tool == "wrangler":
        assert args[2] in {"put", "get", "delete"}
        if args[2] == "delete":
            assert args[3] == calls[0][4], "delete must match unique probe PUT"
            assert "_opd-upload-probe-" in args[3]
        if args[2] == "put" and "_opd-upload-probe-" not in args[3]:
            uploads.append(args[3].split("/", 1)[1])
    else:
        assert args[0] in {"copyto", "cat"}, "remote deletion command forbidden"
        if args[0] == "copyto":
            uploads.append(args[2].split("/", 1)[1])

if check in {"success", "fallback"}:
    assert set(uploads) == {"assets/index-current.js", "assets/index-current.css", "favicon.svg",
                            "glyphs/Open Sans Regular/0-255.pbf", "manifest.webmanifest", "sw-shell.js",
                            "registerSW.js", "index.html", "sw.js"}, uploads
    assert set(uploads[:2]) == {"assets/index-current.js", "assets/index-current.css"}, uploads
    assert uploads[-5:] == ["manifest.webmanifest", "sw-shell.js", "registerSW.js", "index.html", "sw.js"]
    if check == "fallback":
        assert len([c for c in calls if c[0] == "wrangler"]) == 1, calls
        assert calls[-1] == ["rclone", "cat", "r2:test-bucket/index.html"], calls
        for call in calls:
            if call[:2] == ["rclone", "copyto"]:
                key = call[3].split("/", 1)[1]
                expected = "no-cache, max-age=0, must-revalidate" if key in uploads[-5:] else (
                    "public, max-age=31536000, immutable" if key.startswith("assets/") else "public, max-age=300")
                assert "Cache-Control: " + expected in call, call
                if key.endswith(".pbf"):
                    assert "Content-Type: application/x-protobuf" in call
    else:
        assert calls[0][3] == "put" and calls[1][3] == "delete", calls
        assert calls[-1][3:5] == ["get", "test-bucket/index.html"], calls
elif check == "no-network":
    assert not calls, calls
elif check == "no-publish":
    assert not uploads and not any(c[0] == "rclone" for c in calls), calls
else:
    assert check not in uploads, uploads
PY
}

for name in missing-glyph bad-local-index listing-failure; do
  run_case "$name"; assert_code 2; assert_calls no-network
done
run_case normal; assert_code 0; assert_calls success
run_case empty-assets; assert_code 0
for probe in auth403 auth10000; do
  run_case "$probe" "$probe"; assert_code 0; assert_calls fallback
  grep -q 'token lacks R2 write on test-bucket' "$CASE_DIR/err"
done
for probe in generic timeout10000 cleanup; do
  run_case "$probe" "$probe"; assert_code 3; assert_calls no-publish
done
run_case wrong-remote auth403; assert_code 2; assert_calls no-publish
for probe in success auth403; do
  run_case "$probe-asset-failure" "$probe" assets/index-current.js
  assert_code 3; assert_calls index.html; assert_calls sw.js
  run_case "$probe-helper-failure" "$probe" sw-shell.js
  assert_code 3; assert_calls index.html; assert_calls sw.js
  run_case "$probe-index-failure" "$probe" index.html
  assert_code 3; assert_calls sw.js
  for read_mode in stale-js stale-css empty failure; do
    run_case "$probe-$read_mode" "$probe" "" "$read_mode"; assert_code 3
  done
done
for name in missing-index-js missing-index-css missing-modulepreload missing-registersw missing-helper \
  missing-manifest missing-other-hashed-link missing-image missing-icon missing-preload missing-encoded-path \
  outside-traversal outside-encoded-traversal symlink-alias symlink-outside-file symlink-outside-directory \
  directory-resource trailing-slash-resource encoded-trailing-slash-resource trailing-dot-resource unsupported-base; do
  run_case "$name"; assert_code 3; assert_calls no-network
done
for name in valid-resource-urls ignored-external-navigation; do
  run_case "$name"; assert_code 0
done
echo "upload_frontend.test.sh passed (48 offline cases)"
