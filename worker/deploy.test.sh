#!/usr/bin/env bash
# Proves worker deploy passes the service-token allowlist from the environment.
set -euo pipefail

cd "$(dirname "$0")"

if grep -n -E '^ACCESS_SERVICE_TOKEN_CLIENT_IDS[[:space:]]*=' wrangler.toml; then
  echo "FAIL: wrangler.toml assigns ACCESS_SERVICE_TOKEN_CLIENT_IDS" >&2
  exit 1
fi

run_deploy() {
  local work calls args
  work=$(mktemp -d)
  calls="$work/calls"
  args="$work/args"
  cat > "$work/wrangler" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$WRANGLER_CALLS"
for arg in "$@"; do
  printf '%s\n' "$arg" >> "$WRANGLER_ARGS"
done
exit 0
EOF
  chmod +x "$work/wrangler"
  set +e
  PATH="$work:$PATH" \
    WRANGLER_CALLS="$calls" \
    WRANGLER_ARGS="$args" \
    CALIB_TOKEN="machine-secret" \
    bash ./deploy.sh >"$work/out" 2>"$work/err"
  local code=$?
  set -e
  CASE_CODE=$code
  CASE_ARGS=$(cat "$args")
  CASE_ERR=$(cat "$work/err")
  rm -rf "$work"
}

assert_arg() {
  local expected="$1"
  if ! printf '%s\n' "$CASE_ARGS" | grep -Fxq -- "$expected"; then
    echo "FAIL: missing arg $expected" >&2
    printf '%s\n' "$CASE_ARGS" >&2
    exit 1
  fi
}

run_deploy
if [ "$CASE_CODE" -ne 0 ]; then
  echo "FAIL: unset deploy exited $CASE_CODE" >&2
  printf '%s\n' "$CASE_ERR" >&2
  exit 1
fi
assert_arg "deploy"
assert_arg "--var"
assert_arg "ACCESS_SERVICE_TOKEN_CLIENT_IDS:"
if ! printf '%s\n' "$CASE_ERR" | grep -q "empties the allowlist"; then
  echo "FAIL: unset deploy did not warn that the allowlist is emptied" >&2
  printf '%s\n' "$CASE_ERR" >&2
  exit 1
fi
if printf '%s\n' "$CASE_ARGS" | grep -q "machine-secret"; then
  echo "FAIL: deploy forwarded the calibration secret" >&2
  exit 1
fi

ACCESS_SERVICE_TOKEN_CLIENT_IDS="uptime-robot, other-monitor" run_deploy
if [ "$CASE_CODE" -ne 0 ]; then
  echo "FAIL: allowlisted deploy exited $CASE_CODE" >&2
  exit 1
fi
assert_arg "ACCESS_SERVICE_TOKEN_CLIENT_IDS:uptime-robot, other-monitor"
if printf '%s\n' "$CASE_ERR" | grep -q "empties the allowlist"; then
  echo "FAIL: a set allowlist still warned" >&2
  exit 1
fi
if printf '%s\n' "$CASE_ARGS" | grep -q "machine-secret"; then
  echo "FAIL: deploy forwarded the calibration secret" >&2
  exit 1
fi

echo "deploy.test.sh passed"
