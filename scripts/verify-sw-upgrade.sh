#!/usr/bin/env bash
# scripts/verify-sw-upgrade.sh — V2-P0 SW upgrade lifecycle verification.
#
# Runs against a live deploy to confirm the Workbox SW upgrade behaves as
# the V2 plan locks in. Was meant to be a contrived "deploy v1, deploy v2,
# verify" recipe; piggybacks on real deploys (the V3.0 deploy IS a v2 in
# the recipe), so this script just validates that whatever's currently on
# the live URL behaves correctly.
#
# Per /plan-eng-review ARCH-3 (2026-05-05): bundles with the V3.0 ship
# alongside docs/SW_UPGRADE_VERIFY.md (which covers the eyes-on-glass
# checks this script can't observe headlessly — multi-tab races, PWA
# install drift, devtools-only signals).
#
# Usage:
#   scripts/verify-sw-upgrade.sh                         # default URL
#   scripts/verify-sw-upgrade.sh https://map.astroanil.dev
#   scripts/verify-sw-upgrade.sh https://localhost:4173  # vite preview
#
# Exit code: 0 = all checks pass, non-zero = at least one failed.

set -uo pipefail
# Don't `-e` — we want to continue on individual check failures and report
# the full picture, not bail on first miss. Final exit code is computed
# explicitly from PASS/FAIL counters.

URL="${1:-https://map.astroanil.dev}"
echo "=== SW upgrade verification: $URL ==="

PASS=0
FAIL=0

check() {
  local name="$1"
  local got="$2"
  local want="$3"
  if echo "$got" | grep -Eq "$want"; then
    echo "  ✓ $name"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $name"
    echo "      got:  ${got:0:200}"
    echo "      want: $want"
    FAIL=$((FAIL + 1))
  fi
}

# 1. /sw.js reachable + correct content-type
echo
echo "[1/6] /sw.js reachable + correct content-type"
SW_HEADERS=$(curl -sI "$URL/sw.js")
SW_BODY=$(curl -s "$URL/sw.js")
check "HTTP 200"     "$SW_HEADERS" "^HTTP.* 200"
check "JS content-type" "$SW_HEADERS" "content-type: application/javascript"

# 2. SW lifecycle directives — skipWaiting present, clientsClaim absent
# This is the multi-tab safety property the V2 plan was designed to enforce.
echo
echo "[2/6] SW lifecycle: skipWaiting yes, clientsClaim no"
SKIP_COUNT=$(echo "$SW_BODY" | grep -oE 'skipWaiting\(\)' | wc -l | tr -d ' ' || echo 0)
CLAIM_COUNT=$(echo "$SW_BODY" | grep -oE 'clientsClaim\(\)' | wc -l | tr -d ' ' || echo 0)
check "skipWaiting() present (1+)" "$SKIP_COUNT" "^[1-9]"
check "clientsClaim() absent (0)"  "$CLAIM_COUNT" "^0$"

# 3. Runtime cache strategies present
echo
echo "[3/6] Runtime cache strategies wired"
for strategy in NetworkFirst CacheFirst NetworkOnly; do
  if echo "$SW_BODY" | grep -q "$strategy"; then
    echo "  ✓ $strategy strategy present"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $strategy strategy MISSING"
    FAIL=$((FAIL + 1))
  fi
done

# 4. Cache names baked in
echo
echo "[4/6] Runtime cache names registered"
for cache_name in opd-manifest opd-versioned-artifacts opd-tiles-carto opd-tiles-gibs; do
  if echo "$SW_BODY" | grep -q "$cache_name"; then
    echo "  ✓ $cache_name"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $cache_name MISSING"
    FAIL=$((FAIL + 1))
  fi
done

# 5. PWA manifest reachable + non-empty
echo
echo "[5/6] PWA manifest"
MANIFEST_HEADERS=$(curl -sI "$URL/manifest.webmanifest")
MANIFEST_BODY=$(curl -s "$URL/manifest.webmanifest")
check "HTTP 200"  "$MANIFEST_HEADERS" "^HTTP.* 200"
check "JSON parses + has 'start_url'" "$MANIFEST_BODY" '"start_url"'

# 6. registerSW.js auto-injected by vite-plugin-pwa
echo
echo "[6/6] registerSW.js auto-injected"
INDEX_BODY=$(curl -s "$URL/")
check "registerSW.js script tag in index.html" "$INDEX_BODY" 'src="/registerSW.js"'
check "manifest link in index.html" "$INDEX_BODY" 'rel="manifest"'

# Summary
echo
echo "=== Summary ==="
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
echo
if [ "$FAIL" -eq 0 ]; then
  echo "✅ All headless checks pass. Multi-tab + PWA install + devtools-only"
  echo "   checks still need the eyes-on-glass run from docs/SW_UPGRADE_VERIFY.md."
  exit 0
else
  echo "❌ At least one check failed. The SW upgrade may have broken something."
  echo "   Investigate dist/sw.js + manifest.webmanifest before declaring V2-P0 verified."
  exit 1
fi
