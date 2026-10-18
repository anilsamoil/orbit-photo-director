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

read_allowlist_status() {
  if ! command -v node >/dev/null 2>&1; then
    printf '%s\n' missing
    return 0
  fi
  local input output pid waited status token timed_out
  input=$(mktemp "${TMPDIR:-/tmp}/opd-email.XXXXXX")
  output=$(mktemp "${TMPDIR:-/tmp}/opd-email.XXXXXX")
  printf '%s' "$emails" > "$input"
  node --input-type=module -e 'import { parseEmailAllowlist } from "./src/email-allowlist.mjs"; import { readFileSync } from "node:fs"; const list = parseEmailAllowlist(readFileSync(0, "utf8")); process.stdout.write(list.length > 0 ? "ok\n" : "empty\n");' <"$input" >"$output" 2>/dev/null &
  pid=$!
  waited=0
  timed_out=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge 100 ]; then
      timed_out=1
      kill -TERM "$pid" 2>/dev/null || true
      kill -KILL "$pid" 2>/dev/null || true
      break
    fi
    sleep 0.1
    waited=$((waited + 1))
  done
  status=0
  wait "$pid" || status=$?
  if [ "$timed_out" -eq 1 ]; then
    rm -f "$input" "$output"
    printf '%s\n' timeout
    return 0
  fi
  if [ "$status" -ne 0 ]; then
    rm -f "$input" "$output"
    printf '%s\n' "failed:$status"
    return 0
  fi
  token=$(cat "$output")
  rm -f "$input" "$output"
  case "$token" in
    ok|empty)
      printf '%s\n' "$token"
      ;;
    *)
      printf '%s\n' garbage
      ;;
  esac
}

allowlist_status=$(read_allowlist_status)
case "$allowlist_status" in
  ok)
    ;;
  empty)
    if [ "$dry" -eq 0 ]; then
      echo "ERROR: ACCESS_ALLOWED_EMAILS is empty. Refusing to deploy." >&2
      exit 2
    fi
    echo "WARN: ACCESS_ALLOWED_EMAILS is empty. --dry-run still passes an empty binding." >&2
    ;;
  missing)
    echo "ERROR: node is not on PATH, so the email allowlist parser did not run." >&2
    exit 2
    ;;
  timeout)
    echo "ERROR: the email allowlist parser timed out after 10s." >&2
    exit 2
    ;;
  garbage)
    echo "ERROR: the email allowlist parser printed unexpected output." >&2
    exit 2
    ;;
  failed:*)
    echo "ERROR: the email allowlist parser failed because node exited ${allowlist_status#failed:}." >&2
    exit 2
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
