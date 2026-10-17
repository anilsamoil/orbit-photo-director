#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
ids="${ACCESS_SERVICE_TOKEN_CLIENT_IDS-}"
if [ -z "$ids" ]; then
  echo "WARN: ACCESS_SERVICE_TOKEN_CLIENT_IDS is unset. This deploy empties the allowlist. /api/health stays human-only." >&2
fi
exec wrangler deploy --var "ACCESS_SERVICE_TOKEN_CLIENT_IDS:${ids}"
