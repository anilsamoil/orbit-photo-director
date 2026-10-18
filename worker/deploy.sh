#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

ids="${ACCESS_SERVICE_TOKEN_CLIENT_IDS-}"
forward=()
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
      case "$2" in
        -*)
          echo "ERROR: --env needs a value. Supported flags are --dry-run, --env, and --config." >&2
          exit 2
          ;;
      esac
      forward+=("--env" "$2")
      shift 2
      ;;
    --env=)
      echo "ERROR: --env needs a value. Supported flags are --dry-run, --env, and --config." >&2
      exit 2
      ;;
    --env=*)
      forward+=("$1")
      shift
      ;;
    --config)
      if [ "$#" -lt 2 ]; then
        echo "ERROR: --config needs a value. Supported flags are --dry-run, --env, and --config." >&2
        exit 2
      fi
      case "$2" in
        -*)
          echo "ERROR: --config needs a value. Supported flags are --dry-run, --env, and --config." >&2
          exit 2
          ;;
      esac
      forward+=("--config" "$2")
      shift 2
      ;;
    --config=)
      echo "ERROR: --config needs a value. Supported flags are --dry-run, --env, and --config." >&2
      exit 2
      ;;
    --config=*)
      forward+=("$1")
      shift
      ;;
    --var|--var=*)
      echo "ERROR: ACCESS_SERVICE_TOKEN_CLIENT_IDS comes from the environment. Refusing --var so it cannot replace the wrapper value." >&2
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

if [ -z "$ids" ]; then
  echo "WARN: ACCESS_SERVICE_TOKEN_CLIENT_IDS is unset. This deploy empties the allowlist. /api/health stays human-only." >&2
fi

forward+=("--var")
forward+=("ACCESS_SERVICE_TOKEN_CLIENT_IDS:${ids}")
exec wrangler deploy "${forward[@]}"
