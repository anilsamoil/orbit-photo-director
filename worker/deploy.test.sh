#!/usr/bin/env bash
# Proves worker deploy passes the service-token allowlist from the environment.
set -euo pipefail

cd "$(dirname "$0")"

if grep -n -E '^ACCESS_SERVICE_TOKEN_CLIENT_IDS[[:space:]]*=' wrangler.toml; then
  echo "FAIL: wrangler.toml assigns ACCESS_SERVICE_TOKEN_CLIENT_IDS" >&2
  exit 1
fi
if grep -n -E '^ACCESS_ALLOWED_EMAILS[[:space:]]*=' wrangler.toml; then
  echo "FAIL: wrangler.toml assigns ACCESS_ALLOWED_EMAILS" >&2
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

assert_var_last() {
  local value="$1"
  local last expected
  last=$(printf '%s\n' "$CASE_ARGS" | tail -n 2)
  expected=$(printf '%s\n' "--var" "$value")
  if [ "$last" != "$expected" ]; then
    echo "FAIL: allowlist --var was not last" >&2
    printf '%s\n' "$CASE_ARGS" >&2
    exit 1
  fi
}

unset ACCESS_SERVICE_TOKEN_CLIENT_IDS
ACCESS_ALLOWED_EMAILS='person@example.com' run_deploy
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

ACCESS_ALLOWED_EMAILS='person@example.com' ACCESS_SERVICE_TOKEN_CLIENT_IDS="uptime-robot, other-monitor" run_deploy
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

unset ACCESS_ALLOWED_EMAILS
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
assert_var_last "ACCESS_SERVICE_TOKEN_CLIENT_IDS:"

ACCESS_ALLOWED_EMAILS='person@example.com' run_package_deploy --env "staging name" --config "other file.toml"
if [ "$CASE_CODE" -ne 0 ]; then
  echo "FAIL: quoted --env/--config exited $CASE_CODE" >&2
  printf '%s\n' "$CASE_ERR" >&2
  exit 1
fi
assert_arg "--env"
assert_arg "staging name"
assert_arg "--config"
assert_arg "other file.toml"
assert_var_last "ACCESS_SERVICE_TOKEN_CLIENT_IDS:"

ACCESS_ALLOWED_EMAILS='person@example.com' run_package_deploy --env=staging --config=other.toml
if [ "$CASE_CODE" -ne 0 ]; then
  echo "FAIL: --env= and --config= exited $CASE_CODE" >&2
  printf '%s\n' "$CASE_ERR" >&2
  exit 1
fi
assert_arg "--env=staging"
assert_arg "--config=other.toml"
assert_var_last "ACCESS_SERVICE_TOKEN_CLIENT_IDS:"

reject_allowlist_override() {
  if [ "$CASE_CODE" -ne 2 ]; then
    echo "FAIL: a second allowlist --var exited $CASE_CODE ($1)" >&2
    printf '%s\n' "$CASE_ERR" >&2
    exit 1
  fi
  if [ -n "$CASE_ARGS" ]; then
    echo "FAIL: wrangler ran after a rejected allowlist --var ($1)" >&2
    printf '%s\n' "$CASE_ARGS" >&2
    exit 1
  fi
  if ! printf '%s\n' "$CASE_ERR" | grep -F "ACCESS_ALLOWED_EMAILS" | grep -F -q "ACCESS_SERVICE_TOKEN_CLIENT_IDS"; then
    echo "FAIL: rejected allowlist --var did not name both variables ($1)" >&2
    printf '%s\n' "$CASE_ERR" >&2
    exit 1
  fi
}

run_package_deploy --var ACCESS_SERVICE_TOKEN_CLIENT_IDS:evil
reject_allowlist_override "--var"

run_package_deploy --var=ACCESS_SERVICE_TOKEN_CLIENT_IDS:evil
reject_allowlist_override "--var="

reject_closed() {
  local label="$1"
  if [ "$CASE_CODE" -ne 2 ]; then
    echo "FAIL: $label exited $CASE_CODE" >&2
    printf '%s\n' "$CASE_ARGS" >&2
    printf '%s\n' "$CASE_ERR" >&2
    exit 1
  fi
  if [ -n "$CASE_ARGS" ]; then
    echo "FAIL: wrangler ran for $label" >&2
    printf '%s\n' "$CASE_ARGS" >&2
    exit 1
  fi
}

run_package_deploy --var OTHER:x ACCESS_SERVICE_TOKEN_CLIENT_IDS:caller.access
reject_closed "grouped --var"

run_package_deploy --var=OTHER:x ACCESS_SERVICE_TOKEN_CLIENT_IDS:caller.access
reject_closed "grouped --var="

run_package_deploy ACCESS_SERVICE_TOKEN_CLIENT_IDS:caller.access
reject_closed "bare continuation"

run_package_deploy src/alternate.ts --dry-run
reject_closed "positional entrypoint"

run_package_deploy -- --
reject_closed "--"

new_failures=0

expect_reject() {
  local label="$1"
  local needle="$2"
  if [ "$CASE_CODE" -ne 2 ]; then
    echo "FAIL: $label exited $CASE_CODE" >&2
    printf '%s\n' "$CASE_ERR" >&2
    new_failures=$((new_failures + 1))
    return 0
  fi
  if [ -n "$CASE_ARGS" ]; then
    echo "FAIL: wrangler ran for $label" >&2
    printf '%s\n' "$CASE_ARGS" >&2
    new_failures=$((new_failures + 1))
    return 0
  fi
  if ! printf '%s\n' "$CASE_ERR" | grep -F -q -- "$needle"; then
    echo "FAIL: $label did not name $needle" >&2
    printf '%s\n' "$CASE_ERR" >&2
    new_failures=$((new_failures + 1))
  fi
  return 0
}

expect_var_names() {
  local label="$1"
  if [ "$CASE_CODE" -ne 2 ] || [ -n "$CASE_ARGS" ]; then
    echo "FAIL: $label exited $CASE_CODE" >&2
    printf '%s\n' "$CASE_ARGS" >&2
    printf '%s\n' "$CASE_ERR" >&2
    new_failures=$((new_failures + 1))
    return 0
  fi
  if ! printf '%s\n' "$CASE_ERR" | grep -F "ACCESS_ALLOWED_EMAILS" | grep -F -q "ACCESS_SERVICE_TOKEN_CLIENT_IDS"; then
    echo "FAIL: $label did not name both variables" >&2
    printf '%s\n' "$CASE_ERR" >&2
    new_failures=$((new_failures + 1))
  fi
  return 0
}

expect_last_four() {
  local label="$1"
  local email_binding="$2"
  local client_binding="$3"
  if [ "$CASE_CODE" -ne 0 ]; then
    echo "FAIL: $label exited $CASE_CODE" >&2
    printf '%s\n' "$CASE_ERR" >&2
    new_failures=$((new_failures + 1))
    return 0
  fi
  local last expected
  last=$(printf '%s\n' "$CASE_ARGS" | tail -n 4)
  expected=$(printf '%s\n' "--var" "$email_binding" "--var" "$client_binding")
  if [ "$last" != "$expected" ]; then
    echo "FAIL: $label last four args" >&2
    printf '%s\n' "$CASE_ARGS" >&2
    new_failures=$((new_failures + 1))
  fi
  return 0
}

expect_dry_blank() {
  if [ "$CASE_CODE" -ne 0 ]; then
    echo "FAIL: dry-run blank list exited $CASE_CODE" >&2
    printf '%s\n' "$CASE_ERR" >&2
    new_failures=$((new_failures + 1))
    return 0
  fi
  if ! printf '%s\n' "$CASE_ERR" | grep -F -q "WARN: ACCESS_ALLOWED_EMAILS"; then
    echo "FAIL: dry-run blank list did not warn" >&2
    printf '%s\n' "$CASE_ERR" >&2
    new_failures=$((new_failures + 1))
  fi
  local last expected
  last=$(printf '%s\n' "$CASE_ARGS" | tail -n 4)
  expected=$(printf '%s\n' "--var" "ACCESS_ALLOWED_EMAILS:" "--var" "ACCESS_SERVICE_TOKEN_CLIENT_IDS:")
  if [ "$last" != "$expected" ]; then
    echo "FAIL: dry-run blank list bindings" >&2
    printf '%s\n' "$CASE_ARGS" >&2
    new_failures=$((new_failures + 1))
  fi
  return 0
}

run_package_deploy --config=--var=X
expect_reject "--config=--var=X" "ERROR: --config"

run_package_deploy --env --var
expect_reject "--env --var" "ERROR: --env"

run_package_deploy --env ''
expect_reject "--env empty" "ERROR: --env"

run_package_deploy --config ''
expect_reject "--config empty" "ERROR: --config"

run_package_deploy --env $'stag\ning'
expect_reject "--env newline" "ERROR: --env"

run_package_deploy --env=$'stag\ning'
expect_reject "--env= newline" "ERROR: --env"

run_package_deploy --config $'other\ntoml'
expect_reject "--config newline" "ERROR: --config"

run_package_deploy --config=$'other\ntoml'
expect_reject "--config= newline" "ERROR: --config"

run_package_deploy --env $'stag\ring'
expect_reject "--env cr" "ERROR: --env"

run_package_deploy --config=$'other\rtoml'
expect_reject "--config= cr" "ERROR: --config"

run_package_deploy --env staging --env other
expect_reject "second --env" "ERROR: --env"

run_package_deploy --env=staging --env=other
expect_reject "second --env=" "ERROR: --env"

run_package_deploy --env staging --env=other
expect_reject "second --env space then equals" "ERROR: --env"

run_package_deploy --env=staging --env other
expect_reject "second --env equals then space" "ERROR: --env"

run_package_deploy --config other.toml --config alt.toml
expect_reject "second --config" "ERROR: --config"

run_package_deploy --config=other.toml --config=alt.toml
expect_reject "second --config=" "ERROR: --config"

run_package_deploy --config other.toml --config=alt.toml
expect_reject "second --config space then equals" "ERROR: --config"

run_package_deploy --config=other.toml --config alt.toml
expect_reject "second --config equals then space" "ERROR: --config"

run_package_deploy --env staging --config other.toml --env=again
expect_reject "second --env after --config" "ERROR: --env"

run_package_deploy --var ACCESS_ALLOWED_EMAILS:person@example.com
expect_var_names "caller --var email"

run_package_deploy --var=ACCESS_SERVICE_TOKEN_CLIENT_IDS:evil
expect_var_names "caller --var="

unset ACCESS_ALLOWED_EMAILS
run_package_deploy
expect_reject "unset ACCESS_ALLOWED_EMAILS" "ERROR: ACCESS_ALLOWED_EMAILS"

ACCESS_ALLOWED_EMAILS='' run_package_deploy
expect_reject "empty ACCESS_ALLOWED_EMAILS" "ERROR: ACCESS_ALLOWED_EMAILS"

ACCESS_ALLOWED_EMAILS=' , ' run_package_deploy
expect_reject "comma-space ACCESS_ALLOWED_EMAILS" "ERROR: ACCESS_ALLOWED_EMAILS"

ACCESS_ALLOWED_EMAILS='   ' run_package_deploy
expect_reject "whitespace ACCESS_ALLOWED_EMAILS" "ERROR: ACCESS_ALLOWED_EMAILS"

ACCESS_ALLOWED_EMAILS=',' run_package_deploy
expect_reject "comma-only ACCESS_ALLOWED_EMAILS" "ERROR: ACCESS_ALLOWED_EMAILS"

ACCESS_ALLOWED_EMAILS=$'person@example.com\n' run_package_deploy --dry-run
expect_reject "newline ACCESS_ALLOWED_EMAILS on --dry-run" "ERROR: ACCESS_ALLOWED_EMAILS"

ACCESS_ALLOWED_EMAILS=$'person@example.com\r' run_package_deploy --dry-run
expect_reject "cr ACCESS_ALLOWED_EMAILS on --dry-run" "ERROR: ACCESS_ALLOWED_EMAILS"

unset ACCESS_ALLOWED_EMAILS
run_package_deploy --dry-run
expect_dry_blank

ACCESS_ALLOWED_EMAILS='person@example.com' \
  ACCESS_SERVICE_TOKEN_CLIENT_IDS='client.example' \
  run_package_deploy
expect_last_four "non-dry-run success" \
  "ACCESS_ALLOWED_EMAILS:person@example.com" \
  "ACCESS_SERVICE_TOKEN_CLIENT_IDS:client.example"

if [ "$new_failures" -ne 0 ]; then
  echo "FAIL: $new_failures new deploy cases" >&2
  exit 1
fi

echo "deploy.test.sh passed"
