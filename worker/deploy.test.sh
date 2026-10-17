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

unset ACCESS_SERVICE_TOKEN_CLIENT_IDS
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

WRANGLER_BIN_PATH=""
WRANGLER_BIN_SAVED=""
restore_package_wrangler() {
  if [ -n "$WRANGLER_BIN_PATH" ] && [ -n "$WRANGLER_BIN_SAVED" ]; then
    ln -sfn "$WRANGLER_BIN_SAVED" "$WRANGLER_BIN_PATH"
    WRANGLER_BIN_PATH=""
    WRANGLER_BIN_SAVED=""
  fi
}
trap restore_package_wrangler EXIT

run_package_deploy() {
  local work bin
  work=$(mktemp -d)
  bin="node_modules/.bin/wrangler"
  WRANGLER_BIN_PATH=$bin
  WRANGLER_BIN_SAVED=$(readlink "$bin")
  cat > "$work/wrangler" <<'EOF'
#!/bin/sh
for arg in "$@"; do
  printf '%s\n' "$arg" >> "$WRANGLER_ARGS"
done
exit 0
EOF
  chmod +x "$work/wrangler"
  ln -sfn "$work/wrangler" "$bin"
  set +e
  PATH="${HOME}/.bun/bin:${PATH}" \
    WRANGLER_ARGS="$work/args" \
    bun run deploy "$@" >"$work/out" 2>"$work/err"
  local code=$?
  set -e
  restore_package_wrangler
  CASE_CODE=$code
  if [ -f "$work/args" ]; then
    CASE_ARGS=$(cat "$work/args")
  else
    CASE_ARGS=""
  fi
  CASE_ERR=$(cat "$work/err")
  rm -rf "$work"
  echo "== package deploy ($*) exit $CASE_CODE"
}

if [ ! -L node_modules/.bin/wrangler ]; then
  echo "FAIL: worker/node_modules/.bin/wrangler is missing. Run bun install in worker/." >&2
  exit 1
fi

run_package_deploy --dry-run --env staging --config other.toml
if [ "$CASE_CODE" -ne 0 ]; then
  echo "FAIL: bun run deploy --dry-run exited $CASE_CODE" >&2
  printf '%s\n' "$CASE_ERR" >&2
  exit 1
fi
assert_arg "deploy"
assert_arg "--dry-run"
assert_arg "--env"
assert_arg "staging"
assert_arg "--config"
assert_arg "other.toml"
assert_arg "--var"
assert_arg "ACCESS_SERVICE_TOKEN_CLIENT_IDS:"

reject_allowlist_override() {
  if [ "$CASE_CODE" -eq 0 ]; then
    echo "FAIL: a second allowlist --var was accepted ($1)" >&2
    printf '%s\n' "$CASE_ARGS" >&2
    exit 1
  fi
  if [ -n "$CASE_ARGS" ]; then
    echo "FAIL: wrangler ran after a rejected allowlist --var ($1)" >&2
    printf '%s\n' "$CASE_ARGS" >&2
    exit 1
  fi
  if ! printf '%s\n' "$CASE_ERR" | grep -q "ACCESS_SERVICE_TOKEN_CLIENT_IDS"; then
    echo "FAIL: rejected allowlist --var did not name the variable ($1)" >&2
    printf '%s\n' "$CASE_ERR" >&2
    exit 1
  fi
}

run_package_deploy --var ACCESS_SERVICE_TOKEN_CLIENT_IDS:evil
reject_allowlist_override "--var"

run_package_deploy --var=ACCESS_SERVICE_TOKEN_CLIENT_IDS:evil
reject_allowlist_override "--var="

echo "deploy.test.sh passed"
