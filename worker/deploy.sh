#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

ids="${ACCESS_SERVICE_TOKEN_CLIENT_IDS-}"
prev=""
for arg in "$@"; do
  case "$arg" in
    --var=ACCESS_SERVICE_TOKEN_CLIENT_IDS|--var=ACCESS_SERVICE_TOKEN_CLIENT_IDS:*)
      echo "ERROR: ACCESS_SERVICE_TOKEN_CLIENT_IDS comes from the environment. Refusing --var for that name so it cannot replace the wrapper value." >&2
      exit 2
      ;;
  esac
  if [ "$prev" = "--var" ]; then
    key="${arg%%:*}"
    if [ "$key" = "ACCESS_SERVICE_TOKEN_CLIENT_IDS" ]; then
      echo "ERROR: ACCESS_SERVICE_TOKEN_CLIENT_IDS comes from the environment. Refusing --var for that name so it cannot replace the wrapper value." >&2
      exit 2
    fi
  fi
  prev=$arg
done

if [ -z "$ids" ]; then
  echo "WARN: ACCESS_SERVICE_TOKEN_CLIENT_IDS is unset. This deploy empties the allowlist. /api/health stays human-only." >&2
fi
exec wrangler deploy --var "ACCESS_SERVICE_TOKEN_CLIENT_IDS:${ids}" "$@"
