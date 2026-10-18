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

parser_pid=
parser_fd_pid=
parser_fifo=

stop_parser() {
  if [ -n "${parser_pid-}" ]; then
    kill -TERM -- -"$parser_pid" 2>/dev/null || true
    kill -KILL -- -"$parser_pid" 2>/dev/null || true
    parser_pid=
  fi
  if [ -n "${parser_fd_pid-}" ]; then
    kill -TERM "$parser_fd_pid" 2>/dev/null || true
    kill -KILL "$parser_fd_pid" 2>/dev/null || true
    wait "$parser_fd_pid" 2>/dev/null || true
    parser_fd_pid=
  fi
  if [ -n "${parser_fifo-}" ]; then
    rm -f "$parser_fifo"
    parser_fifo=
  fi
}

on_parser_signal() {
  trap - EXIT
  stop_parser
  exit $((128 + $1))
}

classify_email_allowlist() {
  allowlist_status=
  if ! command -v node >/dev/null 2>&1; then
    allowlist_status=missing
    return 0
  fi
  if ! command -v perl >/dev/null 2>&1; then
    allowlist_status=noperl
    return 0
  fi
  local waited timed_out status nbytes token
  trap 'on_parser_signal 1' HUP
  trap 'on_parser_signal 2' INT
  trap 'on_parser_signal 15' TERM
  trap 'stop_parser' EXIT
  parser_fifo=$(mktemp -u "${TMPDIR:-/tmp}/opd-parser.XXXXXX")
  mkfifo "$parser_fifo"
  perl -e '
    setpgrp(0, 0) or die "setpgrp $!\n";
    $| = 1;
    my $pgid = $$;
    print "$pgid\n";
    pipe(my $in_r, my $in_w) or die "pipe $!\n";
    pipe(my $out_r, my $out_w) or die "pipe $!\n";
    my $kid = fork();
    die "fork $!\n" unless defined $kid;
    if ($kid == 0) {
      close $in_w; close $out_r;
      open(STDIN, "<&", $in_r) or die $!;
      open(STDOUT, ">&", $out_w) or die $!;
      close $in_r; close $out_w;
      open(STDERR, ">", "/dev/null");
      exec @ARGV or exit 127;
    }
    close $in_r; close $out_w;
    my $raw = $ENV{ACCESS_ALLOWED_EMAILS};
    $raw = "" unless defined $raw;
    print {$in_w} $raw;
    close $in_w;
    my $buf = "";
    while (1) {
      my $n = sysread($out_r, my $chunk, 4096);
      last if !$n;
      $buf .= $chunk;
    }
    close $out_r;
    waitpid($kid, 0);
    my $st = $?;
    my $code = ($st & 127) ? 128 + ($st & 127) : ($st >> 8);
    print length($buf), "\n", $buf;
    exit $code;
  ' node --input-type=module -e 'import { parseEmailAllowlist } from "./src/email-allowlist.mjs"; import { readFileSync } from "node:fs"; const list = parseEmailAllowlist(readFileSync(0, "utf8")); process.stdout.write(list.length > 0 ? "ok\n" : "empty\n");' >"$parser_fifo" &
  parser_fd_pid=$!
  exec 3<"$parser_fifo"
  rm -f "$parser_fifo"
  parser_fifo=
  IFS= read -r parser_pid <&3 || true
  case "$parser_pid" in
    ''|*[!0-9]*) parser_pid= ;;
  esac
  waited=0
  timed_out=0
  while [ -n "${parser_pid-}" ] && kill -0 "$parser_pid" 2>/dev/null; do
    if [ "$waited" -ge 100 ]; then
      timed_out=1
      break
    fi
    sleep 0.1
    waited=$((waited + 1))
  done
  status=0
  token=
  if [ "$timed_out" -eq 1 ]; then
    stop_parser
    allowlist_status=timeout
  else
    if [ -n "${parser_fd_pid-}" ]; then
      wait "$parser_fd_pid" || status=$?
      parser_fd_pid=
    fi
    parser_pid=
    IFS= read -r nbytes <&3 || true
    case "$nbytes" in
      ''|*[!0-9]*) token= ;;
      *)
        if [ "$nbytes" -le 64 ]; then
          token=$(dd bs=1 count="$nbytes" <&3 2>/dev/null || true; printf x)
          token=${token%x}
        fi
        ;;
    esac
    if [ "$status" -ne 0 ]; then
      allowlist_status="failed:$status"
    else
      case "$token" in
        $'ok\n') allowlist_status=ok ;;
        $'empty\n') allowlist_status=empty ;;
        *) allowlist_status=garbage ;;
      esac
    fi
  fi
  exec 3<&-
  trap - HUP INT TERM EXIT
}

classify_email_allowlist
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
  noperl)
    echo "ERROR: perl is not on PATH, so the email allowlist parser did not run." >&2
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
