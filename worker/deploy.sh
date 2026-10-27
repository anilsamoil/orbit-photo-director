#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

ids="${ACCESS_SERVICE_TOKEN_CLIENT_IDS-}"
emails="${ACCESS_ALLOWED_EMAILS-}"
forward=()
seen_env=0
seen_config=0

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

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node is not on PATH, so the email allowlist parser did not run." >&2
  exit 127
fi

trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

unset ACCESS_ALLOWED_EMAILS
parser_raw=$(
  set +e
  printf '%s' "$emails" | ACCESS_ALLOWED_EMAILS= node --input-type=module -e 'import { parseEmailAllowlist } from "./src/email-allowlist.mjs"; setTimeout(() => { process.exit(2); }, 10000).unref(); const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk); const raw = Buffer.concat(chunks).toString("utf8"); const list = parseEmailAllowlist(raw); process.stdout.write(list.length > 0 ? "ok\n" : "empty\n");' 2>/dev/null
  parser_status=${PIPESTATUS[1]}
  printf '%s' "__OPD_STATUS__:${parser_status}"
)
parser_status=${parser_raw##*__OPD_STATUS__:}
parser_out=${parser_raw%__OPD_STATUS__:*}

case "$parser_status" in
  127)
    echo "ERROR: node is not on PATH, so the email allowlist parser did not run." >&2
    exit 127
    ;;
  2)
    echo "ERROR: the email allowlist parser timed out after 10s." >&2
    exit 2
    ;;
  0)
    ;;
  *)
    echo "ERROR: the email allowlist parser failed (exit ${parser_status})." >&2
    exit 2
    ;;
esac
case "$parser_out" in
  $'ok\n')
    ;;
  $'empty\n')
    echo "ERROR: ACCESS_ALLOWED_EMAILS is empty. Refusing to deploy." >&2
    exit 2
    ;;
  *)
    echo "ERROR: the email allowlist parser printed unexpected output." >&2
    exit 2
    ;;
esac
trap - HUP INT TERM

if [ -z "$ids" ]; then
  echo "WARN: ACCESS_SERVICE_TOKEN_CLIENT_IDS is unset. This deploy empties the allowlist. /api/health stays human-only." >&2
fi

forward+=("--var")
forward+=("ACCESS_ALLOWED_EMAILS:${emails}")
forward+=("--var")
forward+=("ACCESS_SERVICE_TOKEN_CLIENT_IDS:${ids}")
exec wrangler deploy "${forward[@]}"
