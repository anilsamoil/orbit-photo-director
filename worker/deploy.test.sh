#!/usr/bin/env bash
# Proves worker deploy passes the service-token allowlist from the environment.
set -euo pipefail

suite_path=$0
case "$suite_path" in
  /*) ;;
  *) suite_path=$(pwd)/$suite_path ;;
esac

cd "$(dirname "$0")"
deploy_bash=${DEPLOY_BASH:-bash}
real_node=$(command -v node)
package_bash=$(command -v bash)
wrangler_target=""

if grep -n -E '^ACCESS_SERVICE_TOKEN_CLIENT_IDS[[:space:]]*=' wrangler.toml; then
  echo "FAIL: wrangler.toml assigns ACCESS_SERVICE_TOKEN_CLIENT_IDS" >&2
  exit 1
fi
if grep -n -E '^ACCESS_ALLOWED_EMAILS[[:space:]]*=' wrangler.toml; then
  echo "FAIL: wrangler.toml assigns ACCESS_ALLOWED_EMAILS" >&2
  exit 1
fi

hold_dir=$(mktemp -d "${TMPDIR:-/tmp}/XXXXXXXX")
mkdir -p "$hold_dir/pids" "$hold_dir/side" "$hold_dir/bin"

{
  printf '#!%s\n' "$BASH"
  cat << 'EOF'
set -u
pid=$1
expect_ppid=${2-}
dir=$3
depth=${4:-0}
if [ "$depth" -gt 8 ]; then
  exit 0
fi
case "$pid" in
  ''|*[!0-9]*) exit 1 ;;
esac
if [ "$pid" -le 1 ]; then
  exit 1
fi
if [ -n "$expect_ppid" ]; then
  have_ppid=$(LC_ALL=C ps -p "$pid" -o ppid= 2>/dev/null | tr -d ' ' || true)
  if [ "$have_ppid" != "$expect_ppid" ]; then
    exit 1
  fi
fi
live=$(LC_ALL=C ps -p "$pid" -o lstart= 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' || true)
if [ -z "$live" ] && [ ! -f "$dir/$pid" ]; then
  tries=0
  while [ "$tries" -lt 30 ]; do
    live=$(LC_ALL=C ps -p "$pid" -o lstart= 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' || true)
    if [ -n "$live" ]; then
      break
    fi
    tries=$((tries + 1))
    sleep 0.05
  done
fi
if [ -n "$live" ]; then
  have=
  if [ -f "$dir/$pid" ]; then
    have=$(sed 's/^[[:space:]]*//;s/[[:space:]]*$//' "$dir/$pid")
  fi
  if [ "$live" != "$have" ]; then
    printf '%s\n' "$live" > "$dir/$pid"
  fi
elif [ ! -f "$dir/$pid" ]; then
  exit 1
fi
children=$(LC_ALL=C ps -axww -o pid=,ppid= 2>/dev/null | awk -v p="$pid" '$2 == p { print $1 }' || true)
for child in $children; do
  "$0" "$child" "$pid" "$dir" $((depth + 1)) || true
done
exit 0
EOF
} > "$hold_dir/bin/note"

{
  printf '#!%s\n' "$BASH"
  cat << 'EOF'
set -u
pid=$1
dir=$2
case "$pid" in
  ''|*[!0-9]*) exit 0 ;;
esac
if [ "$pid" -le 1 ]; then
  exit 0
fi
if [ ! -f "$dir/$pid" ]; then
  exit 0
fi
want=$(sed 's/^[[:space:]]*//;s/[[:space:]]*$//' "$dir/$pid")
have=$(LC_ALL=C ps -p "$pid" -o lstart= 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' || true)
if [ -n "$have" ] && [ "$have" = "$want" ]; then
  kill -KILL "$pid" 2>/dev/null || true
fi
exit 0
EOF
} > "$hold_dir/bin/reap-one"

{
  printf '#!%s\n' "$BASH"
  cat << 'EOF'
set -u
root=$1
bin=$(dirname "$0")
for pidfile in "$root"/pids/* "$root"/side/*; do
  if [ ! -f "$pidfile" ]; then
    continue
  fi
  "$bin/reap-one" "${pidfile##*/}" "$(dirname "$pidfile")" || true
done
exit 0
EOF
} > "$hold_dir/bin/reap"

{
  printf '#!%s\n' "$BASH"
  cat << 'EOF'
set -u
root=$1
: > "$root/left"
found=1
for pidfile in "$root"/pids/*; do
  if [ ! -f "$pidfile" ]; then
    continue
  fi
  pid=${pidfile##*/}
  case "$pid" in
    ''|*[!0-9]*) continue ;;
  esac
  want=$(sed 's/^[[:space:]]*//;s/[[:space:]]*$//' "$pidfile")
  have=$(LC_ALL=C ps -p "$pid" -o lstart= 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' || true)
  if [ -n "$have" ] && [ "$have" = "$want" ]; then
    printf '%s %s\n' "$pid" "$have" >> "$root/left"
    found=0
  fi
done
exit "$found"
EOF
} > "$hold_dir/bin/collect"

{
  printf '#!%s\n' "$BASH"
  cat << 'EOF'
set -u
root=$1
hold=$2
self=$$
bin=$(dirname "$0")
kids=$(LC_ALL=C ps -axww -o pid=,ppid= 2>/dev/null | awk -v p="$root" -v s="$self" '$2 == p && $1 != s { print $1 }' || true)
: > "$hold/kids"
for kid in $kids; do
  printf '%s\n' "$kid" >> "$hold/kids"
  "$bin/note" "$kid" "$root" "$hold/pids" || true
done
exit 0
EOF
} > "$hold_dir/bin/sweep"

chmod +x "$hold_dir/bin/note" "$hold_dir/bin/reap-one" "$hold_dir/bin/reap" "$hold_dir/bin/collect" "$hold_dir/bin/sweep"
ps_lstart() {
  LC_ALL=C ps -p "$1" -o lstart= 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' || true
}

ps_command() {
  LC_ALL=C ps -ww -p "$1" -o command= 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' || true
}

ps_comm() {
  LC_ALL=C ps -p "$1" -o comm= 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' || true
}

ps_ppid() {
  LC_ALL=C ps -p "$1" -o ppid= 2>/dev/null | tr -d ' ' || true
}

hold_same() {
  local pid="$1"
  local dir="$2"
  local want have
  if [ ! -f "$dir/$pid" ]; then
    return 1
  fi
  want=$(sed 's/^[[:space:]]*//;s/[[:space:]]*$//' "$dir/$pid")
  have=$(ps_lstart "$pid")
  [ -n "$have" ] && [ "$have" = "$want" ]
}

hold_accept_parser() {
  local pid="$1"
  local cmd comm have noted
  if [ ! -f "$hold_dir/pids/$pid" ]; then
    return 1
  fi
  noted=$(sed 's/^[[:space:]]*//;s/[[:space:]]*$//' "$hold_dir/pids/$pid")
  have=$(ps_lstart "$pid")
  if [ -z "$have" ] || [ "$have" != "$noted" ]; then
    return 1
  fi
  cmd=$(ps_command "$pid")
  case "$cmd" in
    "$real_node"|"$real_node "*) ;;
    *) return 1 ;;
  esac
  case "$cmd" in
    *parseEmailAllowlist*) ;;
    *) return 1 ;;
  esac
  comm=$(ps_comm "$pid")
  case "$comm" in
    node|*/node) ;;
    *) return 1 ;;
  esac
  return 0
}

read_parser_handoff() {
  local ready="$1"
  local pid noted filed
  if [ ! -f "$ready" ]; then
    return 1
  fi
  pid=$(sed -n '1p' "$ready" | tr -d ' ')
  noted=$(sed -n '2p' "$ready" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  case "$pid" in
    ''|*[!0-9]*) return 1 ;;
  esac
  if [ -z "$noted" ] || [ ! -f "$hold_dir/pids/$pid" ]; then
    return 1
  fi
  filed=$(sed 's/^[[:space:]]*//;s/[[:space:]]*$//' "$hold_dir/pids/$pid")
  if [ "$filed" != "$noted" ]; then
    return 1
  fi
  hold_accept_parser "$pid" || return 1
  PARSER_PID=$pid
  PARSER_LSTART=$noted
  return 0
}

hold_collect() {
  "$hold_dir/bin/collect" "$hold_dir"
}

reap_recorded_tree() {
  local piddir root list
  if [ -z "${hold_dir-}" ] || [ ! -x "${hold_dir}/bin/reap" ]; then
    return 0
  fi
  list=$(mktemp "$hold_dir/reap.XXXXXX")
  find "$hold_dir" -type d -name pids > "$list" 2>/dev/null || true
  while IFS= read -r piddir; do
    if [ -d "$piddir" ]; then
      root=$(dirname "$piddir")
      "${hold_dir}/bin/reap" "$root" || true
    fi
  done < "$list"
  rm -f "$list"
}

cleanup_on_exit() {
  trap '' INT TERM HUP
  if [ -n "${hold_dir-}" ] && [ -x "${hold_dir}/bin/sweep" ]; then
    "${hold_dir}/bin/sweep" "$$" "$hold_dir" || true
  fi
  reap_recorded_tree
  if [ -n "${hold_dir-}" ] && [ -f "${hold_dir}/kids" ]; then
    while read -r kid; do
      case "$kid" in
        ''|*[!0-9]*) continue ;;
      esac
      state=$(LC_ALL=C ps -p "$kid" -o stat= 2>/dev/null | tr -d ' ' || true)
      case "$state" in
        ''|Z*) wait "$kid" 2>/dev/null || true ;;
      esac
    done < "${hold_dir}/kids"
  fi
  if [ -n "${hold_dir-}" ]; then
    rm -rf "$hold_dir"
  fi
  true
}

hold_defer() {
  HOLD_SIGNAL=
  trap 'HOLD_SIGNAL=1' INT TERM HUP
}

hold_resume() {
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  if [ "${HOLD_SIGNAL-}" = 1 ]; then
    exit
  fi
}

wait_deadline() {
  local pid="$1"
  local seconds="$2"
  local start now state
  start=$(date +%s)
  while true; do
    if ! kill -0 "$pid" 2>/dev/null; then
      set +e
      wait "$pid"
      WAIT_STATUS=$?
      set -e
      return 0
    fi
    state=$(LC_ALL=C ps -p "$pid" -o stat= 2>/dev/null | tr -d ' ' || true)
    case "$state" in
      Z*)
        set +e
        wait "$pid"
        WAIT_STATUS=$?
        set -e
        return 0
        ;;
    esac
    now=$(date +%s)
    if [ $((now - start)) -ge "$seconds" ]; then
      WAIT_STATUS=
      return 1
    fi
    sleep 0.2
  done
}

trap cleanup_on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

start_paired_suites() {
  local mode
  mode=${1:-suite}
  race1=$(mktemp "$hold_dir/race.XXXXXX")
  race2=$(mktemp "$hold_dir/race.XXXXXX")
  suite_tmp=$(mktemp -d "$hold_dir/suites.XXXXXX")
  if [ "$mode" = holder ]; then
    TMPDIR="$suite_tmp" OPD_HOLDER_WAIT=1 "$BASH" "$suite_path" >"$race1" 2>&1 &
    race_a=$!
    TMPDIR="$suite_tmp" OPD_HOLDER_WAIT=1 "$BASH" "$suite_path" >"$race2" 2>&1 &
    race_b=$!
  else
    TMPDIR="$suite_tmp" OPD_SUITE_CHILD=1 "$BASH" "$suite_path" >"$race1" 2>&1 &
    race_a=$!
    TMPDIR="$suite_tmp" OPD_SUITE_CHILD=1 "$BASH" "$suite_path" >"$race2" 2>&1 &
    race_b=$!
  fi
}

if [ "${OPD_HOLDER_WAIT:-}" = 1 ]; then
  /bin/sh -c 'sleep 180 & echo $! > "$1"; wait' _ "$hold_dir/helper.pid" &
  helper=$!
  spins=0
  while [ ! -s "$hold_dir/helper.pid" ]; do
    spins=$((spins + 1))
    if [ "$spins" -gt 50 ]; then
      exit 1
    fi
    sleep 0.05
  done
  "$hold_dir/bin/note" "$helper" "$$" "$hold_dir/pids" || exit 1
  printf '%s\n' "$helper" > "$hold_dir/helper.ppid"
  : > "$hold_dir/ready"
  if ! wait_deadline "$helper" "${OPD_HOLD_DEADLINE:-240}"; then
    echo "FAIL: holder wait exceeded deadline" >&2
    exit 1
  fi
  exit 0
fi

if [ "${OPD_CANCEL_PROBE:-}" = 1 ]; then
  start_paired_suites holder
  spins=0
  while true; do
    ready_n=0
    for ready in "$suite_tmp"/*/ready; do
      if [ -f "$ready" ]; then
        ready_n=$((ready_n + 1))
      fi
    done
    if [ "$ready_n" -ge 2 ]; then
      break
    fi
    spins=$((spins + 1))
    if [ "$spins" -gt 100 ]; then
      echo "FAIL: cancel probe children did not start" >&2
      exit 1
    fi
    sleep 0.05
  done
  {
    printf 'HOLD %s\n' "$hold_dir"
    printf 'RACE %s\n' "$race1"
    printf 'RACE %s\n' "$race2"
    printf 'SUITES %s\n' "$suite_tmp"
    for meta in "$suite_tmp"/*/helper.pid; do
      child_dir=$(dirname "$meta")
      sleep_pid=$(tr -d ' ' < "$meta")
      helper_pid=$(tr -d ' ' < "$child_dir/helper.ppid")
      printf 'CHILD %s\n' "$child_dir"
      printf 'SLEEP %s %s\n' "$sleep_pid" "$(ps_lstart "$sleep_pid")"
      printf 'SLEEP %s %s\n' "$helper_pid" "$(ps_lstart "$helper_pid")"
    done
  } > "$OPD_CANCEL_INFO"
  if ! wait_deadline "$race_a" "${OPD_HOLD_DEADLINE:-240}"; then
    echo "FAIL: cancel probe exceeded deadline" >&2
    exit 1
  fi
  exit 0
fi

if [ "${OPD_TRAP_PROBE:-}" = 1 ]; then
  hold_defer
  sleep 180 &
  probe_pid=$!
  "$hold_dir/bin/note" "$probe_pid" "$$" "$hold_dir/pids" || exit 1
  printf '%s\n%s\n' "$probe_pid" "$(ps_lstart "$probe_pid")" > "$OPD_TRAP_PIDFILE"
  hold_resume
  exit 1
fi

if [ "${OPD_RACE_PROBE:-}" = 1 ]; then
  sleep 180 &
  probe_pid=$!
  printf '%s\n%s\n' "$probe_pid" "$(ps_lstart "$probe_pid")" > "$OPD_TRAP_PIDFILE"
  exit 1
fi

if [ "${OPD_SIGINT_PROBE:-}" = 1 ]; then
  hold_defer
  sleep 180 &
  probe_pid=$!
  "$hold_dir/bin/note" "$probe_pid" "$$" "$hold_dir/pids" || exit 1
  printf '%s\n%s\n' "$probe_pid" "$(ps_lstart "$probe_pid")" > "$OPD_TRAP_PIDFILE"
  hold_resume
  if ! wait_deadline "$probe_pid" "${OPD_HOLD_DEADLINE:-240}"; then
    echo "FAIL: sigint probe exceeded deadline" >&2
    exit 1
  fi
  exit 0
fi

write_holding_node() {
  local dest="$1"
  cat > "$dest" << EOF
#!/bin/sh
fifo=\$(mktemp -u "\${TMPDIR:-/tmp}/fifo.XXXXXX")
childf=\${TMPDIR:-/tmp}/sleep.pid
mkfifo "\$fifo"
exec 3<>"\$fifo"
/bin/sh -c 'sleep 60 & echo \$! > "\$1"; wait' _ "\$childf" >&3 &
holder=\$!
tries=0
while [ ! -s "\$childf" ]; do
  tries=\$((tries + 1))
  if [ "\$tries" -gt 50 ]; then
    exit 1
  fi
  sleep 0.05
done
"$hold_dir/bin/note" "\$holder" "" "$hold_dir/pids" || exit 1
child=\$(cat "\$childf")
tries=0
while [ ! -f "$hold_dir/pids/\$child" ]; do
  tries=\$((tries + 1))
  if [ "\$tries" -gt 30 ]; then
    exit 1
  fi
  "$hold_dir/bin/note" "\$holder" "" "$hold_dir/pids" || true
  sleep 0.05
done
"$real_node" "\$@" <&3 &
parser=\$!
"$hold_dir/bin/note" "\$parser" "" "$hold_dir/pids" || exit 1
lstart=\$(sed 's/^[[:space:]]*//;s/[[:space:]]*\$//' "$hold_dir/pids/\$parser")
printf '%s\n%s\n' "\$parser" "\$lstart" > "$dest.ready.tmp"
mv "$dest.ready.tmp" "$dest.ready"
wait "\$parser"
rc=\$?
"$hold_dir/bin/reap-one" "\$holder" "$hold_dir/pids" || true
"$hold_dir/bin/reap-one" "\$child" "$hold_dir/pids" || true
rm -f "\$fifo" "\$childf"
exit "\$rc"
EOF
  chmod +x "$dest"
}

run_deploy() {
  local work calls args
  work=$(mktemp -d "${TMPDIR:-/tmp}/opd.XXXXXX")
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

grep_lines() {
  local flags="$1"
  local pattern="$2"
  shift 2
  local file code
  file=$(mktemp "$hold_dir/lines.XXXXXX")
  printf '%s\n' "$@" > "$file"
  code=0
  case "$flags" in
    Fxq) grep -Fxq -- "$pattern" "$file" || code=$? ;;
    Fq) grep -F -q -- "$pattern" "$file" || code=$? ;;
    q) grep -q -- "$pattern" "$file" || code=$? ;;
    *) code=2 ;;
  esac
  rm -f "$file"
  return "$code"
}

grep_both() {
  local first="$1"
  local second="$2"
  shift 2
  local file mid code1 code2
  file=$(mktemp "$hold_dir/lines.XXXXXX") || return 2
  mid=$(mktemp "$hold_dir/lines.XXXXXX") || return 2
  if [ ! -f "$file" ] || [ ! -f "$mid" ]; then
    rm -f "$file" "$mid"
    return 2
  fi
  if ! printf '%s\n' "$@" > "$file"; then
    rm -f "$file" "$mid"
    return 2
  fi
  if [ "$#" -gt 0 ] && [ ! -s "$file" ]; then
    rm -f "$file" "$mid"
    return 2
  fi
  set +e
  grep -F -- "$first" "$file" > "$mid"
  code1=$?
  set -e
  if [ "$code1" -gt 1 ] || [ ! -f "$mid" ]; then
    rm -f "$file" "$mid"
    if [ "$code1" -gt 1 ]; then
      return "$code1"
    fi
    return 2
  fi
  set +e
  grep -F -q -- "$second" "$mid"
  code2=$?
  set -e
  rm -f "$file" "$mid"
  if [ "$code2" -gt 1 ]; then
    return "$code2"
  fi
  return "$code2"
}

assert_arg() {
  local expected="$1"
  if ! grep_lines Fxq "$expected" "$CASE_ARGS"; then
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

if [ "${OPD_GREP_STATUS_PROBE:-}" = 1 ]; then
  set +e
  grep_both "ACCESS_ALLOWED_EMAILS" "ACCESS_SERVICE_TOKEN_CLIENT_IDS" "ACCESS_ALLOWED_EMAILS partial"
  grep_status=$?
  set -e
  exit "$grep_status"
fi

if [ "${OPD_PIPE_PROBE:-}" = 1 ]; then
  if [ "${OPD_BLOCK_PROBE:-}" = 1 ]; then
    : > "$hold_dir/outer-ready"
    sleep 180 &
    if ! wait_deadline "$!" "${OPD_HOLD_DEADLINE:-240}"; then
      exit 1
    fi
    exit 0
  fi
  filler=$(awk 'BEGIN { line="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; while (length(out) < 262144) out = out line "\n"; printf "%s", out }')
  CASE_ARGS="deploy
${filler}"
  assert_arg "deploy"
  echo "pipe probe passed"
  exit 0
fi

run_pipe_probe() {
  local pipe_out pipe_err pipe_code nest block pipe_pid block_pid
  nest=$(mktemp -d "$hold_dir/nested.XXXXXX")
  pipe_out=$(mktemp "$hold_dir/pipe.XXXXXX")
  pipe_err=$(mktemp "$hold_dir/pipe.XXXXXX")
  block=
  if [ "${OPD_OUTER_MODE:-}" = pipe ]; then
    block=1
  fi
  set +e
  TMPDIR="$nest" OPD_PIPE_PROBE=1 OPD_BLOCK_PROBE="$block" \
    python3 -c 'import os, signal, sys
signal.signal(signal.SIGINT, signal.SIG_DFL)
signal.signal(signal.SIGTERM, signal.SIG_DFL)
signal.signal(signal.SIGHUP, signal.SIG_DFL)
os.setsid()
os.execvp(sys.argv[1], sys.argv[1:])' "$BASH" "$suite_path" >"$pipe_out" 2>"$pipe_err" &
  pipe_pid=$!
  set -e
  if [ "$block" = 1 ]; then
    sleep 180 &
    block_pid=$!
    wait_deadline "$block_pid" "${OPD_HOLD_DEADLINE:-240}" || true
    kill -KILL "$block_pid" 2>/dev/null || true
    wait "$block_pid" 2>/dev/null || true
    rm -f "$pipe_out" "$pipe_err"
    return 0
  fi
  set +e
  wait "$pipe_pid"
  pipe_code=$?
  set -e
  if [ "$pipe_code" -ne 0 ] || ! grep -F -q "pipe probe passed" "$pipe_out"; then
    echo "FAIL: self-test pipe: early-closing reader missed deploy" >&2
    cat "$pipe_err" >&2
    cat "$pipe_out" >&2
    rm -f "$pipe_out" "$pipe_err"
    exit 1
  fi
  if grep -F -q "Broken pipe" "$pipe_err"; then
    echo "FAIL: self-test pipe: broken pipe" >&2
    cat "$pipe_err" >&2
    rm -f "$pipe_out" "$pipe_err"
    exit 1
  fi
  echo "self-test pipe: early-closing reader still saw deploy"
  rm -f "$pipe_out" "$pipe_err"
  rm -rf "$nest"
}

cancel_runner() {
  local sig="$1"
  local info out runner spins line path rest pid lstart now child_n sleep_n
  local nest wait_code expect block_pid
  info=$(mktemp "$hold_dir/cancel.XXXXXX")
  out=$(mktemp "$hold_dir/cancel.XXXXXX")
  nest=$(mktemp -d "$hold_dir/nested.XXXXXX")
  set +e
  TMPDIR="$nest" OPD_CANCEL_PROBE=1 OPD_CANCEL_INFO="$info" \
    python3 -c 'import os, signal, sys
signal.signal(signal.SIGINT, signal.SIG_DFL)
signal.signal(signal.SIGTERM, signal.SIG_DFL)
signal.signal(signal.SIGHUP, signal.SIG_DFL)
os.setsid()
os.execvp(sys.argv[1], sys.argv[1:])' "$BASH" "$suite_path" >"$out" 2>&1 &
  runner=$!
  set -e
  spins=0
  while true; do
    child_n=$(grep -c '^CHILD ' "$info" 2>/dev/null || true)
    sleep_n=$(grep -c '^SLEEP ' "$info" 2>/dev/null || true)
    if [ "${child_n:-0}" -ge 2 ] && [ "${sleep_n:-0}" -ge 4 ]; then
      break
    fi
    spins=$((spins + 1))
    if [ "$spins" -gt 100 ]; then
      echo "FAIL: self-test cancel $sig: runner did not record holders" >&2
      cat "$out" >&2
      cat "$info" >&2
      rm -f "$info" "$out"
      exit 1
    fi
    sleep 0.05
  done
  if [ "${OPD_BLOCK_PROBE:-}" = 1 ]; then
    : > "$hold_dir/outer-ready"
    sleep 180 &
    block_pid=$!
    wait_deadline "$block_pid" "${OPD_HOLD_DEADLINE:-240}" || true
    kill -KILL "$block_pid" 2>/dev/null || true
    wait "$block_pid" 2>/dev/null || true
  fi
  kill -s "$sig" "$runner" 2>/dev/null || true
  spins=0
  while true; do
    state=$(LC_ALL=C ps -p "$runner" -o stat= 2>/dev/null | tr -d ' ' || true)
    case "$state" in
      ''|Z*) break ;;
    esac
    spins=$((spins + 1))
    if [ "$spins" -gt 50 ]; then
      echo "FAIL: self-test cancel $sig: runner $runner did not end" >&2
      rm -f "$info" "$out"
      exit 1
    fi
    sleep 0.05
  done
  set +e
  wait "$runner"
  wait_code=$?
  set -e
  case "$sig" in
    INT) expect=130 ;;
    TERM) expect=143 ;;
    HUP) expect=129 ;;
  esac
  if [ "$wait_code" -ne "$expect" ]; then
    echo "FAIL: self-test cancel $sig: exit $wait_code" >&2
    rm -f "$info" "$out"
    exit 1
  fi
  while IFS= read -r line; do
    case "$line" in
      HOLD\ *|RACE\ *|SUITES\ *|CHILD\ *)
        path=${line#* }
        if [ -e "$path" ]; then
          echo "FAIL: self-test cancel $sig: left $path" >&2
          rm -f "$info" "$out"
          exit 1
        fi
        ;;
      SLEEP\ *)
        rest=${line#SLEEP }
        pid=${rest%% *}
        lstart=${rest#* }
        now=$(ps_lstart "$pid")
        if [ -n "$now" ] && [ "$now" = "$lstart" ]; then
          echo "FAIL: self-test cancel $sig: left holder $pid" >&2
          rm -f "$info" "$out"
          exit 1
        fi
        ;;
    esac
  done < "$info"
  echo "self-test cancel $sig: runner $runner ended and left 0 holders"
  rm -f "$info" "$out"
  rm -rf "$nest"
}

run_grep_status_probe() {
  local shim real out code nest
  real=$(command -v grep)
  shim=$(mktemp -d "$hold_dir/grepshim.XXXXXX")
  nest=$(mktemp -d "$hold_dir/nested.XXXXXX")
  cat > "$shim/grep" << EOF
#!/bin/sh
if [ "\$1" = "-F" ] && [ "\$2" = "--" ] && [ "\$3" = "ACCESS_ALLOWED_EMAILS" ]; then
  printf '%s\n' "ACCESS_SERVICE_TOKEN_CLIENT_IDS"
  exit 2
fi
exec ${real} "\$@"
EOF
  chmod +x "$shim/grep"
  out=$(mktemp "$hold_dir/grep.XXXXXX")
  set +e
  TMPDIR="$nest" PATH="$shim:$PATH" OPD_GREP_STATUS_PROBE=1 "$BASH" "$suite_path" >"$out" 2>&1
  code=$?
  set -e
  if [ "$code" -ne 2 ]; then
    echo "FAIL: grep status probe exited $code" >&2
    cat "$out" >&2
    exit 1
  fi
  rm -f "$out"
  rm -rf "$shim" "$nest"
  echo "self-test grep: error with partial matches yielded 2"
}

run_deep_reap() {
  local deep pid
  deep="$hold_dir/a/b/c/d/e/pids"
  mkdir -p "$deep"
  sleep 30 &
  pid=$!
  "$hold_dir/bin/note" "$pid" "" "$deep" || exit 1
  reap_recorded_tree
  if kill -0 "$pid" 2>/dev/null; then
    echo "FAIL: deep reap left $pid" >&2
    kill -KILL "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    exit 1
  fi
  wait "$pid" 2>/dev/null || true
  echo "self-test reap: recorded tree reaped $pid"
}

run_deadline_probe() {
  local out child spins code nest
  out=$(mktemp "$hold_dir/deadline.XXXXXX")
  nest=$(mktemp -d "$hold_dir/nested.XXXXXX")
  set +e
  TMPDIR="$nest" OPD_HOLDER_WAIT=1 OPD_HOLD_DEADLINE=1 "$BASH" "$suite_path" >"$out" 2>&1 &
  child=$!
  set -e
  spins=0
  while kill -0 "$child" 2>/dev/null; do
    spins=$((spins + 1))
    if [ "$spins" -gt 75 ]; then
      kill -TERM "$child" 2>/dev/null || true
      wait "$child" 2>/dev/null || true
      echo "FAIL: holder deadline did not fire" >&2
      cat "$out" >&2
      exit 1
    fi
    sleep 0.2
  done
  set +e
  wait "$child"
  code=$?
  set -e
  if [ "$code" -eq 0 ] || ! grep -F -q "holder wait exceeded deadline" "$out"; then
    echo "FAIL: holder deadline exited $code" >&2
    cat "$out" >&2
    exit 1
  fi
  rm -f "$out"
  rm -rf "$nest"
  echo "self-test deadline: holder wait stopped at 1s"
}

cancel_outer_during() {
  local mode="$1"
  local drv runner spins list left
  drv=$(mktemp -d "$hold_dir/outer.XXXXXX")
  set +e
  TMPDIR="$drv" OPD_OUTER_MODE="$mode" "$BASH" "$suite_path" >"$hold_dir/outer-$mode.out" 2>&1 &
  runner=$!
  set -e
  spins=0
  while true; do
    list=$(mktemp "$hold_dir/found.XXXXXX")
    find "$drv" -name outer-ready -type f > "$list" 2>/dev/null || true
    if [ -s "$list" ]; then
      rm -f "$list"
      break
    fi
    rm -f "$list"
    spins=$((spins + 1))
    if [ "$spins" -gt 400 ]; then
      echo "FAIL: outer cancel $mode: probe did not start" >&2
      cat "$hold_dir/outer-$mode.out" >&2
      kill -TERM "$runner" 2>/dev/null || true
      wait "$runner" 2>/dev/null || true
      exit 1
    fi
    sleep 0.05
  done
  kill -TERM "$runner" 2>/dev/null || true
  set +e
  wait "$runner"
  set -e
  list=$(mktemp "$hold_dir/found.XXXXXX")
  find "$drv" -mindepth 1 -print > "$list" 2>/dev/null || true
  left=$(wc -l < "$list" | tr -d ' ')
  if [ "${left:-0}" -ne 0 ]; then
    echo "FAIL: outer cancel $mode: left $left entries" >&2
    cat "$list" >&2
    rm -f "$list"
    exit 1
  fi
  rm -f "$list"
  rm -rf "$drv"
  echo "self-test outer $mode: TERM left 0 entries"
}

if [ "${OPD_OUTER_MODE:-}" = pipe ]; then
  run_pipe_probe
  exit 0
fi
if [ "${OPD_OUTER_MODE:-}" = cancel ]; then
  OPD_BLOCK_PROBE=1 cancel_runner TERM
  exit 0
fi

if [ "${OPD_SUITE_CHILD:-}" != 1 ]; then
  run_grep_status_probe
  run_deep_reap
  run_deadline_probe
  cancel_outer_during pipe
  cancel_outer_during cancel
  run_pipe_probe
  cancel_runner TERM
  cancel_runner INT
  cancel_runner HUP
fi

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
if ! grep_lines q "empties the allowlist" "$CASE_ERR"; then
  echo "FAIL: unset deploy did not warn that the allowlist is emptied" >&2
  printf '%s\n' "$CASE_ERR" >&2
  exit 1
fi
if grep_lines q "machine-secret" "$CASE_ARGS"; then
  echo "FAIL: deploy forwarded the calibration secret" >&2
  exit 1
fi

ACCESS_ALLOWED_EMAILS='person@example.com' ACCESS_SERVICE_TOKEN_CLIENT_IDS="uptime-robot, other-monitor" run_deploy
if [ "$CASE_CODE" -ne 0 ]; then
  echo "FAIL: allowlisted deploy exited $CASE_CODE" >&2
  exit 1
fi
assert_arg "ACCESS_SERVICE_TOKEN_CLIENT_IDS:uptime-robot, other-monitor"
if grep_lines q "empties the allowlist" "$CASE_ERR"; then
  echo "FAIL: a set allowlist still warned" >&2
  exit 1
fi
if grep_lines q "machine-secret" "$CASE_ARGS"; then
  echo "FAIL: deploy forwarded the calibration secret" >&2
  exit 1
fi

run_package_deploy() {
  local work shim code
  work=$(mktemp -d "${TMPDIR:-/tmp}/opd.XXXXXX")
  shim="$work/shim"
  mkdir -p "$shim"
  cat > "$shim/wrangler" << 'EOF'
#!/bin/sh
for arg in "$@"; do
  printf '%s\n' "$arg" >> "$WRANGLER_ARGS"
done
exit 0
EOF
  cat > "$shim/bash" << EOF
#!/bin/sh
export PATH='$shim':\$PATH
exec '$package_bash' "\$@"
EOF
  chmod +x "$shim/wrangler" "$shim/bash"
  set +e
  PATH="$shim:${HOME}/.bun/bin:${PATH}" \
    WRANGLER_ARGS="$work/args" \
    "${PACKAGE_TOOL:-bun}" run deploy "$@" >"$work/out" 2>"$work/err"
  code=$?
  set -e
  CASE_CODE=$code
  if [ -f "$work/args" ]; then
    CASE_ARGS=$(cat "$work/args")
  else
    CASE_ARGS=""
  fi
  CASE_ERR=$(cat "$work/err")
  if [ -n "$wrangler_target" ] && [ "$(readlink node_modules/.bin/wrangler)" != "$wrangler_target" ]; then
    echo "FAIL: shared wrangler link changed during package deploy" >&2
    exit 1
  fi
  rm -rf "$work"
  echo "== package deploy ($*) exit $CASE_CODE"
}

if [ ! -L node_modules/.bin/wrangler ]; then
  echo "FAIL: worker/node_modules/.bin/wrangler is missing. Run bun install in worker/." >&2
  exit 1
fi
wrangler_target=$(readlink node_modules/.bin/wrangler)

ACCESS_ALLOWED_EMAILS='person@example.com' run_package_deploy --dry-run --env staging --config other.toml
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
  if ! grep_both "ACCESS_ALLOWED_EMAILS" "ACCESS_SERVICE_TOKEN_CLIENT_IDS" "$CASE_ERR"; then
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
  if ! grep_lines Fq "$needle" "$CASE_ERR"; then
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
  if ! grep_both "ACCESS_ALLOWED_EMAILS" "ACCESS_SERVICE_TOKEN_CLIENT_IDS" "$CASE_ERR"; then
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
run_deploy --dry-run
expect_reject "bash deploy.sh --dry-run unset" "ACCESS_ALLOWED_EMAILS is empty"
ACCESS_ALLOWED_EMAILS='' run_deploy --dry-run
expect_reject "bash deploy.sh --dry-run empty" "ACCESS_ALLOWED_EMAILS is empty"
ACCESS_ALLOWED_EMAILS='   ' run_deploy --dry-run
expect_reject "bash deploy.sh --dry-run whitespace" "ACCESS_ALLOWED_EMAILS is empty"

unset ACCESS_ALLOWED_EMAILS
run_package_deploy --dry-run
expect_reject "bun run deploy --dry-run unset" "ACCESS_ALLOWED_EMAILS is empty"
ACCESS_ALLOWED_EMAILS='' run_package_deploy --dry-run
expect_reject "bun run deploy --dry-run empty" "ACCESS_ALLOWED_EMAILS is empty"
ACCESS_ALLOWED_EMAILS='   ' run_package_deploy --dry-run
expect_reject "bun run deploy --dry-run whitespace" "ACCESS_ALLOWED_EMAILS is empty"

if command -v npm >/dev/null 2>&1; then
  PACKAGE_TOOL=npm
  unset ACCESS_ALLOWED_EMAILS
  run_package_deploy -- --dry-run
  expect_reject "npm run deploy -- --dry-run unset" "ACCESS_ALLOWED_EMAILS is empty"
  ACCESS_ALLOWED_EMAILS='' run_package_deploy -- --dry-run
  expect_reject "npm run deploy -- --dry-run empty" "ACCESS_ALLOWED_EMAILS is empty"
  ACCESS_ALLOWED_EMAILS='   ' run_package_deploy -- --dry-run
  expect_reject "npm run deploy -- --dry-run whitespace" "ACCESS_ALLOWED_EMAILS is empty"
  unset PACKAGE_TOOL
fi

ACCESS_ALLOWED_EMAILS='person@example.com' \
  ACCESS_SERVICE_TOKEN_CLIENT_IDS='client.example' \
  run_package_deploy
expect_last_four "non-dry-run success" \
  "ACCESS_ALLOWED_EMAILS:person@example.com" \
  "ACCESS_SERVICE_TOKEN_CLIENT_IDS:client.example"

bom=$(printf '\357\273\277')
ACCESS_ALLOWED_EMAILS="$bom" run_deploy --dry-run
expect_reject "bash deploy.sh --dry-run bom" "ACCESS_ALLOWED_EMAILS is empty"
ACCESS_ALLOWED_EMAILS="$bom" run_package_deploy --dry-run
expect_reject "bun run deploy --dry-run bom" "ACCESS_ALLOWED_EMAILS is empty"
if command -v npm >/dev/null 2>&1; then
  PACKAGE_TOOL=npm
  ACCESS_ALLOWED_EMAILS="$bom" run_package_deploy -- --dry-run
  expect_reject "npm run deploy -- --dry-run bom" "ACCESS_ALLOWED_EMAILS is empty"
  unset PACKAGE_TOOL
fi
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
    if ! grep_lines Fq "ACCESS_ALLOWED_EMAILS is empty" "$CASE_ERR"; then
      echo "FAIL: $runner LC_ALL=$locale $label did not refuse a blank list" >&2
      printf '%s\n' "$CASE_ERR" >&2
      new_failures=$((new_failures + 1))
    fi
    return 0
  fi
  if ! grep_lines Fq "person@example.com" "$CASE_ARGS"; then
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
  work=$(mktemp -d "${TMPDIR:-/tmp}/opd.XXXXXX")
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
      write_holding_node "$work/node"
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
  if ! grep_lines Fq "$needle" "$CASE_ERR"; then
    echo "FAIL: $label did not say $needle" >&2
    printf '%s\n' "$CASE_ERR" >&2
    new_failures=$((new_failures + 1))
    return 0
  fi
  if grep_lines Fq "list is empty" "$CASE_ERR" "$CASE_OUT"; then
    echo "FAIL: $label printed list is empty" >&2
    printf '%s\n' "$CASE_ERR" >&2
    new_failures=$((new_failures + 1))
    return 0
  fi
  if grep_lines Fq "is empty" "$CASE_ERR" "$CASE_OUT"; then
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

list_sentinel="zzsecret-${RANDOM}$$@example.com"
STUB_EMAILS="$list_sentinel"
leak_notes=$(mktemp "${TMPDIR:-/tmp}/opd.XXXXXX")
(
  deadline=$((SECONDS + 14))
  while [ "$SECONDS" -lt "$deadline" ]; do
    ps ax -ww -o command= | SENTINEL="$list_sentinel" awk 'BEGIN { s = ENVIRON["SENTINEL"] } index($0, s) && index($0, "awk") == 0 { print }' >> "$leak_notes"
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
"$hold_dir/bin/note" "$leak_scan" "" "$hold_dir/side" || true
"$hold_dir/bin/reap-one" "$leak_scan" "$hold_dir/side" || true
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
if hold_collect; then
  echo "FAIL: hung node left the stdin holder" >&2
  cat "$hold_dir/left" >&2
  new_failures=$((new_failures + 1))
fi
"$hold_dir/bin/reap" "$hold_dir" || true

run_stub_node garbage --dry-run
echo "== node printed garbage exit $CASE_CODE"
printf '%s\n' "$CASE_ERR"
expect_parser_failure "node printed garbage" "unexpected output"


if grep_lines Fq "$list_sentinel" "$CASE_ERR" "$CASE_OUT"; then
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
if grep_lines Fq "$list_sentinel" "$CASE_ERR" "$CASE_OUT"; then
  echo "FAIL: early stdin close leaked the allowlist on stdio" >&2
  new_failures=$((new_failures + 1))
fi
if ps ax -ww -o command= | SENTINEL="$list_sentinel" awk 'BEGIN { s = ENVIRON["SENTINEL"] } index($0, s) && index($0, "awk") == 0 { found = 1 } END { exit found ? 0 : 1 }'; then
  echo "FAIL: early stdin close left the allowlist in argv" >&2
  new_failures=$((new_failures + 1))
fi

if grep -E 'setpgrp|mkfifo|kill |[[:space:]]perl[[:space:]]' deploy.sh >/dev/null; then
  echo "FAIL: deploy.sh still supervises the parser process tree" >&2
  new_failures=$((new_failures + 1))
fi

run_signal_case() {
  local sig="$1"
  local want="$2"
  local how="$3"
  local work dpid spins start end code pgid
  work=$(mktemp -d "${TMPDIR:-/tmp}/opd.XXXXXX")
  cat > "$work/wrangler" << 'ENDWR'
#!/bin/sh
for arg in "$@"; do
  printf '%s\n' "$arg" >> "$WRANGLER_ARGS"
done
exit 0
ENDWR
  chmod +x "$work/wrangler"
  write_holding_node "$work/node"
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
  if ! "$hold_dir/bin/note" "$dpid" "" "$hold_dir/pids"; then
    echo "FAIL: signal $sig could not record deploy pid $dpid" >&2
    new_failures=$((new_failures + 1))
    wait "$dpid" 2>/dev/null || true
    rm -rf "$work"
    return 0
  fi
  spins=0
  while ! read_parser_handoff "$work/node.ready"; do
    spins=$((spins + 1))
    if [ "$spins" -ge 50 ]; then
      echo "FAIL: signal $sig never handed over the node parser" >&2
      new_failures=$((new_failures + 1))
      "$hold_dir/bin/reap" "$hold_dir" || true
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
  if ! hold_same "$dpid" "$hold_dir/pids"; then
    echo "FAIL: signal $sig deploy pid $dpid changed start time before the signal" >&2
    new_failures=$((new_failures + 1))
    "$hold_dir/bin/reap" "$hold_dir" || true
    wait "$dpid" 2>/dev/null || true
    rm -rf "$work"
    return 0
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
  if hold_same "$PARSER_PID" "$hold_dir/pids"; then
    echo "FAIL: signal $sig $how left the parser running" >&2
    ps_command "$PARSER_PID" >&2
    new_failures=$((new_failures + 1))
  fi
  if grep_lines Fq "$list_sentinel" "$CASE_ERR" "$CASE_OUT"; then
    echo "FAIL: signal $sig leaked the allowlist on stdio" >&2
    new_failures=$((new_failures + 1))
  fi
  if find "$work" -type f -exec grep -F -q -- "$list_sentinel" {} + 2>/dev/null; then
    echo "FAIL: signal $sig wrote the allowlist to a file" >&2
    new_failures=$((new_failures + 1))
  fi
  "$hold_dir/bin/reap" "$hold_dir" || true
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

assert_early_reaped() {
  local label="$1"
  local pidfile="$2"
  local outfile="$3"
  local code="$4"
  local pid lstart now
  if [ "$code" -ne 1 ] || [ ! -s "$pidfile" ]; then
    echo "FAIL: self-test $label: probe exited $code" >&2
    if [ -f "$outfile" ]; then
      cat "$outfile" >&2
    fi
    rm -f "$pidfile" "$outfile"
    exit 1
  fi
  pid=$(sed -n '1p' "$pidfile" | tr -d ' ')
  lstart=$(sed -n '2p' "$pidfile" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  now=$(ps_lstart "$pid")
  if [ -n "$now" ] && { [ -z "$lstart" ] || [ "$now" = "$lstart" ]; }; then
    echo "FAIL: self-test $label: early exit left $pid" >&2
    rm -f "$pidfile" "$outfile"
    exit 1
  fi
  echo "self-test $label: early exit reaped $pid"
  rm -f "$pidfile" "$outfile"
}

trap_pidfile=$(mktemp "${TMPDIR:-/tmp}/opd.XXXXXX")
trap_out=$(mktemp "${TMPDIR:-/tmp}/opd.XXXXXX")
set +e
OPD_TRAP_PROBE=1 OPD_TRAP_PIDFILE="$trap_pidfile" "$BASH" "$suite_path" >"$trap_out" 2>&1
trap_code=$?
set -e
assert_early_reaped trap "$trap_pidfile" "$trap_out" "$trap_code"

race_pidfile=$(mktemp "${TMPDIR:-/tmp}/opd.XXXXXX")
race_out=$(mktemp "${TMPDIR:-/tmp}/opd.XXXXXX")
set +e
OPD_RACE_PROBE=1 OPD_TRAP_PIDFILE="$race_pidfile" "$BASH" "$suite_path" >"$race_out" 2>&1
race_code=$?
set -e
assert_early_reaped race "$race_pidfile" "$race_out" "$race_code"

sig_pidfile=$(mktemp "${TMPDIR:-/tmp}/opd.XXXXXX")
sig_out=$(mktemp "${TMPDIR:-/tmp}/opd.XXXXXX")
set +e
OPD_SIGINT_PROBE=1 OPD_TRAP_PIDFILE="$sig_pidfile" \
  python3 -c 'import os, signal, sys
signal.signal(signal.SIGINT, signal.SIG_DFL)
signal.signal(signal.SIGTERM, signal.SIG_DFL)
signal.signal(signal.SIGHUP, signal.SIG_DFL)
os.setsid()
os.execvp(sys.argv[1], sys.argv[1:])' "$BASH" "$suite_path" >"$sig_out" 2>&1 &
sig_runner=$!
set -e
sig_spins=0
while [ ! -s "$sig_pidfile" ]; do
  sig_spins=$((sig_spins + 1))
  if [ "$sig_spins" -gt 50 ]; then
    echo "FAIL: self-test sigint: runner did not record a holder" >&2
    cat "$sig_out" >&2
    rm -f "$sig_pidfile" "$sig_out"
    exit 1
  fi
  sleep 0.05
done
sig_holder=$(sed -n '1p' "$sig_pidfile" | tr -d ' ')
sig_lstart=$(sed -n '2p' "$sig_pidfile" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
kill -INT "$sig_runner" 2>/dev/null || true
sig_spins=0
while true; do
  sig_state=$(LC_ALL=C ps -p "$sig_runner" -o stat= 2>/dev/null | tr -d ' ' || true)
  case "$sig_state" in
    ''|Z*) break ;;
  esac
  sig_spins=$((sig_spins + 1))
  if [ "$sig_spins" -gt 50 ]; then
    echo "FAIL: self-test sigint: runner $sig_runner did not end" >&2
    rm -f "$sig_pidfile" "$sig_out"
    exit 1
  fi
  sleep 0.05
done
set +e
wait "$sig_runner"
set -e
sig_now=$(ps_lstart "$sig_holder")
if [ -n "$sig_now" ] && { [ -z "$sig_lstart" ] || [ "$sig_now" = "$sig_lstart" ]; }; then
  echo "FAIL: self-test sigint: runner left holder $sig_holder" >&2
  rm -f "$sig_pidfile" "$sig_out"
  exit 1
fi
echo "self-test sigint: runner $sig_runner ended and left 0 holders"
rm -f "$sig_pidfile" "$sig_out"

sleep 60 &
stray=$!
if ! "$hold_dir/bin/note" "$stray" "" "$hold_dir/side"; then
  echo "FAIL: self-test a: could not record stray sleep $stray" >&2
  exit 1
fi
if hold_collect; then
  echo "FAIL: self-test a: unrelated sleep $stray failed the check" >&2
  cat "$hold_dir/left" >&2
  exit 1
fi
if ! hold_same "$stray" "$hold_dir/side"; then
  echo "FAIL: self-test a: stray sleep $stray was not alive during the check" >&2
  exit 1
fi
echo "self-test a: unrelated sleep $stray ignored"
"$hold_dir/bin/reap-one" "$stray" "$hold_dir/side" || true
wait "$stray" 2>/dev/null || true

bwork=$(mktemp -d "${TMPDIR:-/tmp}/opd.XXXXXX")
/bin/sh -c 'sleep 60 & echo $! > "$1"; wait' _ "$bwork/child" &
bholder=$!
bspins=0
while [ ! -s "$bwork/child" ]; do
  bspins=$((bspins + 1))
  if [ "$bspins" -gt 50 ]; then
    echo "FAIL: self-test b: holder child did not start" >&2
    exit 1
  fi
  sleep 0.05
done
bchild=$(cat "$bwork/child")
if ! "$hold_dir/bin/note" "$bholder" "" "$hold_dir/pids"; then
  echo "FAIL: self-test b: could not record holder $bholder" >&2
  exit 1
fi
bspins=0
while [ ! -f "$hold_dir/pids/$bchild" ]; do
  bspins=$((bspins + 1))
  if [ "$bspins" -gt 30 ]; then
    echo "FAIL: self-test b: child $bchild was not recorded while its parent link was known" >&2
    exit 1
  fi
  "$hold_dir/bin/note" "$bholder" "" "$hold_dir/pids" || true
  sleep 0.05
done
if ! hold_collect; then
  echo "FAIL: self-test b: leaked holder $bholder did not fail the check" >&2
  exit 1
fi
if ! grep -q "^$bholder " "$hold_dir/left" || ! grep -q "^$bchild " "$hold_dir/left"; then
  echo "FAIL: self-test b: check missed the holder or its child" >&2
  cat "$hold_dir/left" >&2
  exit 1
fi
echo "self-test b: leaked holder $bholder failed the check, with child $bchild"
"$hold_dir/bin/reap" "$hold_dir" || true
wait "$bholder" 2>/dev/null || true
if hold_same "$bholder" "$hold_dir/pids" || hold_same "$bchild" "$hold_dir/pids"; then
  echo "FAIL: self-test b: reap left the holder or its child" >&2
  exit 1
fi
rm -rf "$bwork"

cwork=$(mktemp -d "${TMPDIR:-/tmp}/opd.XXXXXX")
cat > "$cwork/wrap" << EOF
#!/bin/sh
"$real_node" "\$@" &
echo \$! > "$cwork/parser.pid"
wait
EOF
chmod +x "$cwork/wrap"
/bin/sh "$cwork/wrap" --input-type=module -e 'import { parseEmailAllowlist } from "./src/email-allowlist.mjs"; setInterval(() => {}, 1000);' &
cwrap=$!
/bin/sh -c 'sleep 90 & echo $! > "$1"; wait' _ "$cwork/sleep.pid" &
cholder=$!
cspins=0
while [ ! -s "$cwork/parser.pid" ] || [ ! -s "$cwork/sleep.pid" ]; do
  cspins=$((cspins + 1))
  if [ "$cspins" -gt 50 ]; then
    echo "FAIL: self-test c: parser or holder did not start" >&2
    exit 1
  fi
  sleep 0.05
done
cparser=$(cat "$cwork/parser.pid")
csleep=$(cat "$cwork/sleep.pid")
cwrap_cmd=$(ps_command "$cwrap")
case "$cwrap_cmd" in
  *parseEmailAllowlist*) ;;
  *)
    echo "FAIL: self-test c: wrapper argv has no parseEmailAllowlist" >&2
    printf '%s\n' "$cwrap_cmd" >&2
    exit 1
    ;;
esac
"$hold_dir/bin/note" "$cwrap" "" "$hold_dir/pids" || exit 1
if hold_accept_parser "$cwrap"; then
  echo "FAIL: self-test c: accepted the shell wrapper $cwrap as the parser" >&2
  exit 1
fi
"$hold_dir/bin/note" "$cparser" "" "$hold_dir/pids" || exit 1
if ! hold_accept_parser "$cparser"; then
  echo "FAIL: self-test c: could not accept node parser $cparser" >&2
  ps_command "$cparser" >&2
  exit 1
fi
"$hold_dir/bin/note" "$cholder" "" "$hold_dir/pids" || exit 1
cspins=0
while [ ! -f "$hold_dir/pids/$csleep" ]; do
  cspins=$((cspins + 1))
  if [ "$cspins" -gt 30 ]; then
    echo "FAIL: self-test c: holder child was not recorded" >&2
    exit 1
  fi
  "$hold_dir/bin/note" "$cholder" "" "$hold_dir/pids" || true
  sleep 0.05
done
if ! hold_same "$cwrap" "$hold_dir/pids" || ! hold_same "$cholder" "$hold_dir/pids"; then
  echo "FAIL: self-test c: wrapper or holder changed before the kill" >&2
  exit 1
fi
"$hold_dir/bin/reap-one" "$cwrap" "$hold_dir/pids" || true
wait "$cwrap" 2>/dev/null || true
"$hold_dir/bin/reap-one" "$cholder" "$hold_dir/pids" || true
wait "$cholder" 2>/dev/null || true
if ! hold_same "$cparser" "$hold_dir/pids"; then
  echo "FAIL: self-test c: parser $cparser died with its wrapper" >&2
  exit 1
fi
cppid=$(ps_ppid "$cparser")
if [ -z "$cppid" ] || [ "$cppid" = "$cwrap" ] || [ "$cppid" = "$cholder" ]; then
  echo "FAIL: self-test c: parser ppid $cppid is still the wrapper or holder" >&2
  exit 1
fi
if ! hold_collect || ! grep -q "^$cparser " "$hold_dir/left"; then
  echo "FAIL: self-test c: check missed surviving parser $cparser" >&2
  cat "$hold_dir/left" >&2
  exit 1
fi
echo "self-test c: parser $cparser survived wrapper $cwrap and holder $cholder (ppid $cppid)"
"$hold_dir/bin/reap" "$hold_dir" || true
rm -rf "$cwork"

sleep 60 &
reused=$!
if ! "$hold_dir/bin/note" "$reused" "" "$hold_dir/pids"; then
  echo "FAIL: self-test d: could not record $reused" >&2
  exit 1
fi
reused_lstart=$(sed 's/^[[:space:]]*//;s/[[:space:]]*$//' "$hold_dir/pids/$reused")
printf '%s\n' "reused-pid-different-start" > "$hold_dir/pids/$reused"
"$hold_dir/bin/reap-one" "$reused" "$hold_dir/pids" || true
if [ "$(ps_lstart "$reused")" != "$reused_lstart" ]; then
  echo "FAIL: self-test d: reap killed pid $reused whose start time did not match" >&2
  exit 1
fi
printf '%s\n' "$reused_lstart" > "$hold_dir/pids/$reused"
"$hold_dir/bin/reap-one" "$reused" "$hold_dir/pids" || true
wait "$reused" 2>/dev/null || true
if [ "$(ps_lstart "$reused")" = "$reused_lstart" ]; then
  echo "FAIL: self-test d: matching start time did not reap $reused" >&2
  exit 1
fi
echo "self-test d: pid $reused with a different start time was not killed"

if [ "${OPD_SUITE_CHILD:-}" != 1 ]; then
  start_paired_suites suite
  if wait_deadline "$race_a" "${OPD_JOIN_DEADLINE:-600}"; then
    race_a_code=$WAIT_STATUS
  else
    race_a_code=1
  fi
  if wait_deadline "$race_b" "${OPD_JOIN_DEADLINE:-600}"; then
    race_b_code=$WAIT_STATUS
  else
    race_b_code=1
  fi
  if [ "$race_a_code" -ne 0 ] || [ "$race_b_code" -ne 0 ]; then
    echo "FAIL: self-test e: suites exited $race_a_code and $race_b_code" >&2
    echo "---- suite A ----" >&2
    cat "$race1" >&2
    echo "---- suite B ----" >&2
    cat "$race2" >&2
    rm -f "$race1" "$race2"
    rm -rf "$suite_tmp"
    exit 1
  fi
  if grep -F -q "missing arg deploy" "$race1" "$race2"; then
    echo "FAIL: self-test e: missing arg deploy" >&2
    rm -f "$race1" "$race2"
    rm -rf "$suite_tmp"
    exit 1
  fi
  if ! grep -F -q "deploy.test.sh passed" "$race1" || ! grep -F -q "deploy.test.sh passed" "$race2"; then
    echo "FAIL: self-test e: a suite did not pass" >&2
    rm -f "$race1" "$race2"
    rm -rf "$suite_tmp"
    exit 1
  fi
  echo "self-test e: both suites passed"
  rm -f "$race1" "$race2"
  rm -rf "$suite_tmp"
fi

if [ -n "$wrangler_target" ] && [ "$(readlink node_modules/.bin/wrangler)" != "$wrangler_target" ]; then
  echo "FAIL: shared wrangler link changed" >&2
  exit 1
fi

echo "deploy.test.sh passed"
