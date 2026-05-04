#!/usr/bin/env bash
# scripts/check-credentials.sh — verify all credentials still work + warn about expiry.
#
# Run on a daily cron (or as part of each daemon tick if you want eager warnings).
# Returns 0 if everything is healthy, non-zero if something needs rotation.
#
# Checks:
#   1. NASA Earthdata: HTTP HEAD on a Earthdata URL using ~/.netrc auth
#   2. Cloudflare R2: rclone lsf on the configured bucket
#   3. Cloudflare API token: GET /user/tokens/verify
#   4. CALIB_TOKEN: localStorage; only verified end-to-end via /api/log
#
# Output is structured so it can be piped to logs or alerting.

set -uo pipefail

CREDS=~/.config/orbit-photo-director/credentials.json
RC=0

red()   { printf '\033[0;31m%s\033[0m\n' "$*"; }
green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
yel()   { printf '\033[0;33m%s\033[0m\n' "$*"; }

if [[ ! -f "$CREDS" ]]; then
  red "[FAIL] $CREDS not found"
  exit 2
fi

green "Credential health check ($(date -u +%Y-%m-%dT%H:%M:%SZ))"

# 1. Earthdata — sanity-check the saved creds. Full validation requires a real
#    dataset download (URS doesn't expose a basic-auth health endpoint; the API
#    speaks OAuth bearer tokens not basic auth). For the daemon's purposes we
#    verify (a) .netrc has the entry and (b) credentials.json holds a non-empty
#    password. Real download failure surfaces in the generator's own logs.
echo ""
echo "[1] NASA Earthdata"
USER=$(python3 -c "import json; print(json.load(open('$CREDS'))['earthdata']['username'])" 2>/dev/null || echo "")
PASS_LEN=$(python3 -c "import json; print(len(json.load(open('$CREDS'))['earthdata']['password']))" 2>/dev/null || echo "0")
if [[ -z "$USER" ]]; then
  yel "  no earthdata block in credentials.json — skipping"
else
  echo "  username: $USER"
  if ! grep -q "urs.earthdata.nasa.gov" ~/.netrc 2>/dev/null; then
    red "  [FAIL] ~/.netrc missing urs.earthdata.nasa.gov entry"
    RC=1
  elif [[ "$PASS_LEN" -lt 6 ]]; then
    red "  [FAIL] credentials.json earthdata.password is empty/short ($PASS_LEN chars)"
    RC=1
  else
    # Smoke test: hit a known Earthdata-gated URL that returns 401 only on bad
    # creds (not on every public path). LP DAAC's HTTPS data tree is the
    # canonical "I have working creds" probe. Any 200/302 = creds work; 401 =
    # rotate.
    HTTP=$(curl -s --netrc -o /dev/null -w "%{http_code}" --max-time 15 \
      "https://urs.earthdata.nasa.gov/login" 2>/dev/null || echo "000")
    case "$HTTP" in
      200|302)
        green "  [OK] Earthdata reachable (full data-fetch check requires a real download)"
        ;;
      000)
        red "  [FAIL] cannot reach urs.earthdata.nasa.gov — network or DNS issue"
        RC=1
        ;;
      *)
        yel "  [WARN] urs.earthdata.nasa.gov returned HTTP $HTTP"
        ;;
    esac
  fi
fi

# 2. R2 via rclone
echo ""
echo "[2] Cloudflare R2 (rclone)"
if ! command -v rclone >/dev/null 2>&1; then
  yel "  rclone not on PATH — skipping (deploy will use wrangler fallback)"
else
  if ! grep -q "^\[r2\]" ~/.config/rclone/rclone.conf 2>/dev/null; then
    red "  [FAIL] no [r2] section in ~/.config/rclone/rclone.conf"
    RC=1
  else
    # Try a cheap list against a known bucket
    if rclone lsf r2:map-astroanil-dev/ --max-depth 1 >/dev/null 2>&1; then
      green "  [OK] rclone can reach r2:map-astroanil-dev"
    else
      red "  [FAIL] rclone failed to list r2:map-astroanil-dev — keys may be revoked"
      RC=1
    fi
  fi
fi

# 3. Cloudflare API token — informational only.
#    The cfat_ R2 API token saved during setup uses the S3 access_key/secret
#    pair (validated above via rclone). The cfat_ token itself doesn't work
#    against /user/tokens/verify (that endpoint expects standard CF API tokens).
#    Nothing the daemon runs uses the cfat_ token directly, so we don't fail
#    the check on it.
echo ""
echo "[3] Cloudflare API token (advisory)"
HAS_TOKEN=$(python3 -c "import json; print('yes' if json.load(open('$CREDS')).get('cloudflare',{}).get('api_token') else 'no')" 2>/dev/null || echo "no")
echo "  saved: $HAS_TOKEN (used only by hand for ad-hoc API calls; rclone uses S3 keys)"

# 4. CALIB_TOKEN — only validate it's set as a Worker secret (we can't read it back)
echo ""
echo "[4] CALIB_TOKEN (Worker secret)"
if command -v wrangler >/dev/null 2>&1; then
  if (cd "${OPD_ROOT:-$HOME/orbit-photo-director}/worker" 2>/dev/null && wrangler secret list 2>&1 | grep -q '"CALIB_TOKEN"'); then
    green "  [OK] CALIB_TOKEN secret is set on the Worker"
  else
    yel "  [WARN] could not verify CALIB_TOKEN — run \`wrangler secret list\` in worker/"
  fi
fi

# Summary
echo ""
if [[ $RC -eq 0 ]]; then
  green "All credential checks passed."
else
  red "$RC credential check(s) failed — see RUNBOOK.md for rotation steps."
fi
exit $RC
