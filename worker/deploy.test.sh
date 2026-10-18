#!/usr/bin/env bash
# Proves worker deploy passes the service-token allowlist from the environment.
set -euo pipefail

cd "$(dirname "$0")"
deploy_bash=${DEPLOY_BASH:-bash}
real_node=$(command -v node)

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
    "$deploy_bash" ./deploy.sh "$@" >"$work/out" 2>"$work/err"
  local code=$?
  set -e
  CASE_CODE=$code
  if [ -f "$args" ]; then
    CASE_ARGS=$(cat "$args")
  else
    CASE_ARGS=""
  fi
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
expect_reject "unset ACCESS_ALLOWED_EMAILS" "ACCESS_ALLOWED_EMAILS is empty"

ACCESS_ALLOWED_EMAILS='' run_package_deploy
expect_reject "empty ACCESS_ALLOWED_EMAILS" "ACCESS_ALLOWED_EMAILS is empty"

ACCESS_ALLOWED_EMAILS=' , ' run_package_deploy
expect_reject "comma-space ACCESS_ALLOWED_EMAILS" "ACCESS_ALLOWED_EMAILS is empty"

ACCESS_ALLOWED_EMAILS='   ' run_package_deploy
expect_reject "whitespace ACCESS_ALLOWED_EMAILS" "ACCESS_ALLOWED_EMAILS is empty"

ACCESS_ALLOWED_EMAILS=',' run_package_deploy
expect_reject "comma-only ACCESS_ALLOWED_EMAILS" "ACCESS_ALLOWED_EMAILS is empty"

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

bom=$(printf '\357\273\277')
nbsp=$(printf '\302\240')
ideo=$(printf '\343\200\200')
lsep=$(printf '\342\200\250')

expect_locale_emails() {
  local locale="$1"
  local runner="$2"
  local label="$3"
  local value="$4"
  local want="$5"
  if [ "$runner" = "bash" ]; then
    LC_ALL="$locale" ACCESS_ALLOWED_EMAILS="$value" run_deploy
    echo "== bash LC_ALL=$locale $label exit $CASE_CODE"
  else
    LC_ALL="$locale" ACCESS_ALLOWED_EMAILS="$value" run_package_deploy
    echo "== package LC_ALL=$locale $label exit $CASE_CODE"
  fi
  if [ "$CASE_CODE" -ne "$want" ]; then
    echo "FAIL: $runner LC_ALL=$locale $label exited $CASE_CODE, want $want" >&2
    printf '%s\n' "$CASE_ERR" >&2
    new_failures=$((new_failures + 1))
    return 0
  fi
  if [ "$want" -eq 2 ]; then
    if [ -n "$CASE_ARGS" ]; then
      echo "FAIL: wrangler ran for $runner LC_ALL=$locale $label" >&2
      printf '%s\n' "$CASE_ARGS" >&2
      new_failures=$((new_failures + 1))
      return 0
    fi
    if ! printf '%s\n' "$CASE_ERR" | grep -F -q "ACCESS_ALLOWED_EMAILS is empty"; then
      echo "FAIL: $runner LC_ALL=$locale $label did not refuse a blank list" >&2
      printf '%s\n' "$CASE_ERR" >&2
      new_failures=$((new_failures + 1))
    fi
    return 0
  fi
  if ! printf '%s\n' "$CASE_ARGS" | grep -F -q "person@example.com"; then
    echo "FAIL: $runner LC_ALL=$locale $label did not pass the mailbox" >&2
    printf '%s\n' "$CASE_ARGS" >&2
    new_failures=$((new_failures + 1))
  fi
  return 0
}

for locale in C en_US.UTF-8; do
  for runner in bash package; do
    expect_locale_emails "$locale" "$runner" "bom-only" "$bom" 2
    expect_locale_emails "$locale" "$runner" "unicode-commas" "${nbsp},${ideo},${lsep}" 2
    expect_locale_emails "$locale" "$runner" "mailbox-wrapped" "${bom}person@example.com${nbsp}" 0
  done
done

run_stub_node() {
  local mode="$1"
  shift
  local work
  work=$(mktemp -d)
  cat > "$work/wrangler" <<'EOF'
#!/bin/sh
for arg in "$@"; do
  printf '%s\n' "$arg" >> "$WRANGLER_ARGS"
done
exit 0
EOF
  chmod +x "$work/wrangler"
  case "$mode" in
    missing)
      ;;
    exit)
      cat > "$work/node" <<'EOF'
#!/bin/sh
echo node-stub-exit >&2
exit 3
EOF
      chmod +x "$work/node"
      ;;
    hang)
      cat > "$work/node" << EOF
#!/bin/sh
fifo=\$(mktemp -u "\${TMPDIR:-/tmp}/opd-hold.XXXXXX")
pidfile=\$(mktemp "\${TMPDIR:-/tmp}/opd-hold.XXXXXX")
mkfifo "\$fifo"
/bin/sh -c 'sleep 60 & echo \$! > "\$1"; wait' _ "\$pidfile" > "\$fifo" &
holder=\$!
"$real_node" "\$@" < "\$fifo"
rc=\$?
if [ -s "\$pidfile" ]; then
  kill -KILL "\$(cat "\$pidfile")" 2>/dev/null || true
fi
kill -KILL "\$holder" 2>/dev/null || true
rm -f "\$fifo" "\$pidfile"
exit "\$rc"
EOF
      chmod +x "$work/node"
      ;;
    garbage)
      cat > "$work/node" <<'EOF'
#!/bin/sh
printf '%s\n' 'not-a-parse'
exit 0
EOF
      chmod +x "$work/node"
      ;;
    close-stdin)
      cat > "$work/node" <<'EOF'
#!/bin/sh
exec 0<&-
exit 1
EOF
      chmod +x "$work/node"
      ;;
    extra-nl)
      cat > "$work/node" <<'EOF'
#!/bin/sh
printf 'ok\n\n'
exit 0
EOF
      chmod +x "$work/node"
      ;;
    junk)
      cat > "$work/node" <<'EOF'
#!/bin/sh
printf 'ok junk\n'
exit 0
EOF
      chmod +x "$work/node"
      ;;
  esac
  set +e
  PATH="$work:/usr/bin:/bin" \
    TMPDIR="$work" \
    WRANGLER_ARGS="$work/args" \
    ACCESS_ALLOWED_EMAILS="${STUB_EMAILS:-alice@example.com}" \
    "$deploy_bash" ./deploy.sh "$@" >"$work/out" 2>"$work/err"
  local code=$?
  set -e
  CASE_CODE=$code
  if [ -f "$work/args" ]; then
    CASE_ARGS=$(cat "$work/args")
  else
    CASE_ARGS=""
  fi
  CASE_ERR=$(cat "$work/err")
  CASE_OUT=$(cat "$work/out")
  if [ -n "${leak_notes-}" ] && [ -n "${STUB_EMAILS-}" ] && [ -f "$leak_notes" ]; then
    if find "$work" -type f -exec grep -F -q -- "$STUB_EMAILS" {} + 2>/dev/null; then
      echo "file" >> "$leak_notes"
    fi
  fi
  rm -rf "$work"
}

expect_parser_failure() {
  local label="$1"
  local needle="$2"
  local want="${3:-2}"
  if [ "$CASE_CODE" -ne "$want" ]; then
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
    echo "FAIL: $label did not say $needle" >&2
    printf '%s\n' "$CASE_ERR" >&2
    new_failures=$((new_failures + 1))
    return 0
  fi
  if printf '%s\n' "$CASE_ERR" "$CASE_OUT" | grep -F -q "list is empty"; then
    echo "FAIL: $label printed list is empty" >&2
    printf '%s\n' "$CASE_ERR" >&2
    new_failures=$((new_failures + 1))
    return 0
  fi
  if printf '%s\n' "$CASE_ERR" "$CASE_OUT" | grep -F -q "is empty"; then
    echo "FAIL: $label printed the empty-list message" >&2
    printf '%s\n' "$CASE_ERR" >&2
    new_failures=$((new_failures + 1))
  fi
  return 0
}

run_stub_node missing
echo "== node not on PATH exit $CASE_CODE"
printf '%s\n' "$CASE_ERR"
expect_parser_failure "node not on PATH" "node is not on PATH" 127

run_stub_node exit --dry-run
echo "== node exited non-zero exit $CASE_CODE"
printf '%s\n' "$CASE_ERR"
expect_parser_failure "node exited non-zero" "failed (exit 3)"

list_sentinel=zzsecret-allowlist@example.com
STUB_EMAILS="$list_sentinel"
leak_notes=$(mktemp)
(
  deadline=$((SECONDS + 14))
  while [ "$SECONDS" -lt "$deadline" ]; do
    ps ax -o command= | SENTINEL="$list_sentinel" awk 'BEGIN { s = ENVIRON["SENTINEL"] } index($0, s) && index($0, "awk") == 0 { print }' >> "$leak_notes"
    if [ -d /proc ]; then
      for cmdf in /proc/[0-9]*/cmdline; do
        pid=${cmdf#/proc/}
        pid=${pid%/cmdline}
        cmd=$(dd if="$cmdf" bs=4096 count=1 2>/dev/null | tr '\0' ' ' || true)
        case "$cmd" in
          *parseEmailAllowlist*)
            if dd if="/proc/$pid/environ" bs=8192 count=1 2>/dev/null | tr '\0' '\n' | grep -F -q -- "$list_sentinel"; then
              echo "node-environ $pid" >> "$leak_notes"
            fi
            ;;
        esac
      done
    fi
    sleep 0.4
  done
) &
leak_scan=$!
hang_start=$(date +%s)
run_stub_node hang
hang_end=$(date +%s)
kill "$leak_scan" 2>/dev/null || true
wait "$leak_scan" 2>/dev/null || true
unset STUB_EMAILS
echo "== hung node exit $CASE_CODE in $((hang_end - hang_start))s"
printf '%s\n' "$CASE_ERR"
expect_parser_failure "hung node" "timed out after 10s"
if [ $((hang_end - hang_start)) -le 8 ] || [ $((hang_end - hang_start)) -ge 16 ]; then
  echo "FAIL: hung node took $((hang_end - hang_start))s" >&2
  new_failures=$((new_failures + 1))
fi
if [ -s "$leak_notes" ]; then
  echo "FAIL: allowlist showed up in argv or a node environment" >&2
  cat "$leak_notes" >&2
  new_failures=$((new_failures + 1))
fi
rm -f "$leak_notes"
if ps ax -o command= | awk 'index($0, "opd-hold") && index($0, "awk") == 0 { found = 1 } END { exit found ? 0 : 1 }'; then
  echo "FAIL: hung node left the stdin holder" >&2
  ps ax -o pid=,command= | awk 'index($0, "opd-hold") && index($0, "awk") == 0 { print }' >&2
  new_failures=$((new_failures + 1))
fi

run_stub_node garbage --dry-run
echo "== node printed garbage exit $CASE_CODE"
printf '%s\n' "$CASE_ERR"
expect_parser_failure "node printed garbage" "unexpected output"


if printf '%s\n' "$CASE_ERR" "$CASE_OUT" | grep -F -q -- "$list_sentinel"; then
  echo "FAIL: hung node leaked the allowlist on stdio" >&2
  new_failures=$((new_failures + 1))
fi

run_stub_node extra-nl --dry-run
echo "== ok with an extra newline exit $CASE_CODE"
printf '%s\n' "$CASE_ERR"
expect_parser_failure "ok with an extra newline" "unexpected output"

run_stub_node junk --dry-run
echo "== ok junk exit $CASE_CODE"
printf '%s\n' "$CASE_ERR"
expect_parser_failure "ok junk" "unexpected output"

big_list=$list_sentinel
pad=0
while [ "$pad" -lt 6500 ]; do
  big_list="${big_list},a@example.com"
  pad=$((pad + 1))
done
STUB_EMAILS=$big_list
close_start=$(date +%s)
run_stub_node close-stdin
close_end=$(date +%s)
unset STUB_EMAILS
echo "== early stdin close exit $CASE_CODE in $((close_end - close_start))s"
printf '%s\n' "$CASE_ERR"
expect_parser_failure "early stdin close" "failed (exit 1)"
if [ $((close_end - close_start)) -ge 3 ]; then
  echo "FAIL: early stdin close took $((close_end - close_start))s" >&2
  new_failures=$((new_failures + 1))
fi
if printf '%s\n' "$CASE_ERR" "$CASE_OUT" | grep -F -q -- "$list_sentinel"; then
  echo "FAIL: early stdin close leaked the allowlist on stdio" >&2
  new_failures=$((new_failures + 1))
fi
if ps ax -o command= | SENTINEL="$list_sentinel" awk 'BEGIN { s = ENVIRON["SENTINEL"] } index($0, s) && index($0, "awk") == 0 { found = 1 } END { exit found ? 0 : 1 }'; then
  echo "FAIL: early stdin close left the allowlist in argv" >&2
  new_failures=$((new_failures + 1))
fi

if grep -E 'setpgrp|mkfifo|kill |[[:space:]]perl[[:space:]]' deploy.sh >/dev/null; then
  echo "FAIL: deploy.sh still supervises the parser process tree" >&2
  new_failures=$((new_failures + 1))
fi

parser_still_running() {
  ps ax -o command= | awk 'index($0, "parseEmailAllowlist") && index($0, "awk") == 0 { found = 1 } END { exit found ? 0 : 1 }' \
    || ps ax -o command= | awk 'index($0, "opd-hold") && index($0, "awk") == 0 { found = 1 } END { exit found ? 0 : 1 }'
}

run_signal_case() {
  local sig="$1"
  local want="$2"
  local how="$3"
  local work dpid spins start end code pgid
  work=$(mktemp -d)
  cat > "$work/wrangler" << 'ENDWR'
#!/bin/sh
for arg in "$@"; do
  printf '%s\n' "$arg" >> "$WRANGLER_ARGS"
done
exit 0
ENDWR
  chmod +x "$work/wrangler"
  cat > "$work/node" << EOF
#!/bin/sh
fifo=\$(mktemp -u "\$TMPDIR/opd-hold.XXXXXX")
mkfifo "\$fifo"
/bin/sh -c 'sleep 60 & wait' > "\$fifo" &
holder=\$!
$real_node "\$@" < "\$fifo"
rc=\$?
kill -KILL \$holder 2>/dev/null || true
rm -f "\$fifo"
exit \$rc
EOF
  chmod +x "$work/node"
  PATH="$work:/usr/bin:/bin" \
    TMPDIR="$work" \
    WRANGLER_ARGS="$work/args" \
    ACCESS_ALLOWED_EMAILS="$list_sentinel" \
    python3 -c 'import os, signal, sys
signal.signal(signal.SIGINT, signal.SIG_DFL)
signal.signal(signal.SIGQUIT, signal.SIG_DFL)
os.setsid()
os.execvp(sys.argv[1], sys.argv[1:])' "$deploy_bash" ./deploy.sh >"$work/out" 2>"$work/err" &
  dpid=$!
  spins=0
  while ! ps ax -o command= | awk 'index($0, "parseEmailAllowlist") && index($0, "awk") == 0 { found = 1 } END { exit found ? 0 : 1 }'; do
    spins=$((spins + 1))
    if [ "$spins" -ge 30 ]; then
      echo "FAIL: signal $sig never started node" >&2
      new_failures=$((new_failures + 1))
      kill -KILL "$dpid" 2>/dev/null || true
      wait "$dpid" 2>/dev/null || true
      rm -rf "$work"
      return 0
    fi
    sleep 0.1
  done
  pgid=$(ps -o pgid= -p "$dpid" | tr -d ' ')
  if [ "$pgid" != "$dpid" ]; then
    echo "FAIL: signal $sig deploy pid $dpid is not its process group" >&2
    new_failures=$((new_failures + 1))
  fi
  start=$(date +%s)
  if [ "$how" = "group" ]; then
    python3 -c 'import os, signal, sys; os.killpg(int(sys.argv[1]), getattr(signal, "SIG" + sys.argv[2]))' "$dpid" "$sig"
  else
    kill -s "$sig" "$dpid" 2>/dev/null || true
  fi
  set +e
  wait "$dpid"
  code=$?
  set -e
  end=$(date +%s)
  CASE_CODE=$code
  if [ -f "$work/args" ]; then
    CASE_ARGS=$(cat "$work/args")
  else
    CASE_ARGS=""
  fi
  CASE_ERR=$(cat "$work/err")
  CASE_OUT=$(cat "$work/out")
  echo "== signal $sig $how exit $CASE_CODE in $((end - start))s"
  printf '%s\n' "$CASE_ERR"
  if [ "$CASE_CODE" -ne "$want" ]; then
    echo "FAIL: signal $sig $how exited $CASE_CODE, want $want" >&2
    new_failures=$((new_failures + 1))
  fi
  if [ -n "$CASE_ARGS" ]; then
    echo "FAIL: wrangler ran for signal $sig $how" >&2
    new_failures=$((new_failures + 1))
  fi
  if [ "$how" = "group" ]; then
    if [ $((end - start)) -ge 3 ]; then
      echo "FAIL: signal $sig to the group took $((end - start))s" >&2
      new_failures=$((new_failures + 1))
    fi
  elif [ $((end - start)) -le 8 ] || [ $((end - start)) -ge 16 ]; then
    echo "FAIL: signal $sig to the pid took $((end - start))s" >&2
    new_failures=$((new_failures + 1))
  fi
  if parser_still_running; then
    echo "FAIL: signal $sig $how left node running" >&2
    ps ax -o pid=,command= | awk 'index($0, "parseEmailAllowlist") || index($0, "opd-hold") { print }' >&2
    new_failures=$((new_failures + 1))
  fi
  if printf '%s\n' "$CASE_ERR" "$CASE_OUT" | grep -F -q -- "$list_sentinel"; then
    echo "FAIL: signal $sig leaked the allowlist on stdio" >&2
    new_failures=$((new_failures + 1))
  fi
  if find "$work" -type f -exec grep -F -q -- "$list_sentinel" {} + 2>/dev/null; then
    echo "FAIL: signal $sig wrote the allowlist to a file" >&2
    new_failures=$((new_failures + 1))
  fi
  rm -rf "$work"
}

run_signal_case TERM 143 pid
run_signal_case INT 130 pid
run_signal_case HUP 129 pid
run_signal_case INT 130 group

if [ "$new_failures" -ne 0 ]; then
  echo "FAIL: $new_failures new deploy cases" >&2
  exit 1
fi

echo "deploy.test.sh passed"
