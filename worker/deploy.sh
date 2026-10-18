#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

ids="${ACCESS_SERVICE_TOKEN_CLIENT_IDS-}"
emails="${ACCESS_ALLOWED_EMAILS-}"
forward=()
seen_env=0
seen_config=0
dry=0

accept_named() {
  local flag="$1"
  local value="$2"
  local mode="$3"
  local original="${4-}"
  if [ -z "$value" ] || [[ "$value" == -* ]] || [[ "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
    echo "ERROR: ${flag} needs a value. Supported flags are --dry-run, --env, and --config." >&2
    exit 2
  fi
  if [ "$flag" = "--env" ]; then
    if [ "$seen_env" -ne 0 ]; then
      echo "ERROR: --env was already given. Supported flags are --dry-run, --env, and --config." >&2
      exit 2
    fi
    seen_env=1
  elif [ "$flag" = "--config" ]; then
    if [ "$seen_config" -ne 0 ]; then
      echo "ERROR: --config was already given. Supported flags are --dry-run, --env, and --config." >&2
      exit 2
    fi
    seen_config=1
  fi
  if [ "$mode" = "equals" ]; then
    forward+=("$original")
  else
    forward+=("$flag" "$value")
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --)
      echo "ERROR: deploy.sh does not accept --. Supported flags are --dry-run, --env, and --config." >&2
      exit 2
      ;;
    --dry-run)
      dry=1
      forward+=("--dry-run")
      shift
      ;;
    --env)
      if [ "$#" -lt 2 ]; then
        echo "ERROR: --env needs a value. Supported flags are --dry-run, --env, and --config." >&2
        exit 2
      fi
      accept_named "--env" "$2" "space"
      shift 2
      ;;
    --env=*)
      accept_named "--env" "${1#--env=}" "equals" "$1"
      shift
      ;;
    --config)
      if [ "$#" -lt 2 ]; then
        echo "ERROR: --config needs a value. Supported flags are --dry-run, --env, and --config." >&2
        exit 2
      fi
      accept_named "--config" "$2" "space"
      shift 2
      ;;
    --config=*)
      accept_named "--config" "${1#--config=}" "equals" "$1"
      shift
      ;;
    --var|--var=*)
      echo "ERROR: ACCESS_ALLOWED_EMAILS and ACCESS_SERVICE_TOKEN_CLIENT_IDS come from the environment. Refusing --var so it cannot replace the wrapper value." >&2
      exit 2
      ;;
    -*)
      echo "ERROR: unknown flag $1. Supported flags are --dry-run, --env, and --config." >&2
      exit 2
      ;;
    *)
      echo "ERROR: unexpected argument $1. Supported flags are --dry-run, --env, and --config." >&2
      exit 2
      ;;
  esac
done

if [[ "$emails" == *$'\n'* || "$emails" == *$'\r'* ]]; then
  echo "ERROR: ACCESS_ALLOWED_EMAILS contains a newline." >&2
  exit 2
fi

reap_parser_group() {
  local pgid pid
  pgid=$(ps -o pgid= -p $$ | tr -d ' ')
  [ "$pgid" = "$$" ] || return 0
  for pid in $(ps ax -o pid=,pgid= | awk -v g="$pgid" -v me="$$" '$1 != me && $2 == g { print $1 }'); do
    kill -TERM "$pid" 2>/dev/null || true
    kill -KILL "$pid" 2>/dev/null || true
  done
}

on_parser_signal() {
  trap - HUP INT TERM
  reap_parser_group
  if [ -n "${parser_dir-}" ]; then
    rm -rf "$parser_dir"
    parser_dir=
  fi
  exit $((128 + $1))
}

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node is not on PATH, so the email allowlist parser did not run." >&2
  exit 2
fi

trap 'on_parser_signal 1' HUP
trap 'on_parser_signal 2' INT
trap 'on_parser_signal 15' TERM

parser_dir=$(mktemp -d "${TMPDIR:-/tmp}/opd-parser.XXXXXX")
parser_fifo=$parser_dir/pipe
mkfifo "$parser_fifo"
exec 3<>"$parser_fifo"
exec 4<"$parser_fifo"
exec 5>"$parser_fifo"
exec 3>&-
rm -rf "$parser_dir"
parser_dir=

unset ACCESS_ALLOWED_EMAILS
printf '%s' "$emails" | ACCESS_ALLOWED_EMAILS= node --input-type=module -e 'import { parseEmailAllowlist } from "./src/email-allowlist.mjs"; setTimeout(() => { process.exit(2); }, 10000).unref(); const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk); const raw = Buffer.concat(chunks).toString("utf8"); const list = parseEmailAllowlist(raw); process.stdout.write(list.length > 0 ? "ok\n" : "empty\n");' >&5 2>/dev/null &
parser_pid=$!
exec 5>&-
parser_status=0
set +e
wait "$parser_pid"
parser_status=$?
set -e
reap_parser_group
parser_out=$(cat <&4; printf x)
parser_out=${parser_out%x}
exec 4<&-
set +e
wait
set -e
trap - HUP INT TERM

if [ "$parser_status" -eq 127 ]; then
  echo "ERROR: node is not on PATH, so the email allowlist parser did not run." >&2
  exit 2
fi
if [ "$parser_status" -eq 2 ] && [ -z "$parser_out" ]; then
  echo "ERROR: the email allowlist parser timed out after 10s." >&2
  exit 2
fi
if [ "$parser_status" -ne 0 ]; then
  echo "ERROR: the email allowlist parser failed (exit ${parser_status})." >&2
  exit 2
fi
case "$parser_out" in
  $'ok\n')
    ;;
  $'empty\n')
    if [ "$dry" -eq 0 ]; then
      echo "ERROR: ACCESS_ALLOWED_EMAILS is empty. Refusing to deploy." >&2
      exit 2
    fi
    echo "WARN: ACCESS_ALLOWED_EMAILS is empty. --dry-run still passes an empty binding." >&2
    ;;
  *)
    echo "ERROR: the email allowlist parser printed unexpected output." >&2
    exit 2
    ;;
esac

if [ -z "$ids" ]; then
  echo "WARN: ACCESS_SERVICE_TOKEN_CLIENT_IDS is unset. This deploy empties the allowlist. /api/health stays human-only." >&2
fi

forward+=("--var")
forward+=("ACCESS_ALLOWED_EMAILS:${emails}")
forward+=("--var")
forward+=("ACCESS_SERVICE_TOKEN_CLIENT_IDS:${ids}")
exec wrangler deploy "${forward[@]}"
