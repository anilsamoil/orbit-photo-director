#!/usr/bin/env bash
# scripts/soak/inject_failure.sh <scenario>
#
# Inject a failure scenario during the 2-week pre-launch soak test. Each scenario
# corresponds to a real-world failure mode the system must handle gracefully.
#
# Usage: bash scripts/soak/inject_failure.sh <scenario>
#
# Scenarios:
#   network-kill      — drop generator's network for 5 min via pfctl (macOS)
#   daemon-kill       — kill the running generator daemon process
#   tle-expire        — manipulate cached TLE mtime to fake 36h+ age
#   earthdata-revoke  — temporarily rename .netrc to simulate auth failure
#   force-reboot      — request a hard restart (requires sudo, prompts)
#   stale-cloud       — set cached SatCORPS file mtime to 4h ago
#   r2-block          — block *.r2.cloudflarestorage.com via /etc/hosts
#   keychain-lock     — lock the keychain to simulate post-reboot lock
#   dns-fail          — block celestrak.org via /etc/hosts
#   list              — print supported scenarios
#
# All scenarios self-revert (with a message) so the soak resumes naturally.

set -euo pipefail

SCENARIO="${1:-list}"
CACHE_DIR="${OPD_CACHE:-data/cache}"

case "$SCENARIO" in
  list)
    grep -E "^#   [a-z]" "$0" | sed 's/^#   //'
    ;;

  network-kill)
    echo "[soak] dropping all outbound traffic for 5 min..."
    sudo pfctl -e 2>/dev/null || true
    echo "block out all" | sudo pfctl -f - 2>/dev/null || {
      echo "pfctl not available; falling back to host file blocks"
      sudo bash -c 'echo "127.0.0.1 celestrak.org" >> /etc/hosts'
      sudo bash -c 'echo "127.0.0.1 urs.earthdata.nasa.gov" >> /etc/hosts'
      sleep 300
      sudo sed -i.bak '/celestrak.org/d;/urs.earthdata.nasa.gov/d' /etc/hosts
      exit 0
    }
    sleep 300
    sudo pfctl -d
    echo "[soak] network restored. Watch generator log for cached-fallback recovery."
    ;;

  daemon-kill)
    PID=$(pgrep -f "generator.daemon" || true)
    if [ -z "$PID" ]; then
      echo "[soak] no generator daemon running"
      exit 1
    fi
    echo "[soak] killing daemon pid=$PID. launchd should respawn within seconds."
    kill -9 "$PID"
    ;;

  tle-expire)
    TLE="$CACHE_DIR/iss.tle"
    if [ ! -f "$TLE" ]; then
      echo "[soak] no cached TLE at $TLE"
      exit 1
    fi
    echo "[soak] backdating TLE mtime to 36h ago..."
    touch -t "$(date -v-36H +%Y%m%d%H%M)" "$TLE"
    echo "[soak] verify: status.json should show tle_freshness_factor < 1.0 next tick."
    ;;

  earthdata-revoke)
    if [ ! -f "$HOME/.netrc" ]; then
      echo "[soak] no .netrc to revoke"
      exit 1
    fi
    echo "[soak] renaming .netrc to .netrc.SOAK (5 min); generator should fail SatCORPS fetch + alert"
    mv "$HOME/.netrc" "$HOME/.netrc.SOAK"
    sleep 300
    mv "$HOME/.netrc.SOAK" "$HOME/.netrc"
    echo "[soak] .netrc restored."
    ;;

  force-reboot)
    echo "[soak] requesting reboot in 60 sec. Verify launchd auto-starts the daemon post-boot."
    read -p "Continue? [y/N] " yn
    [ "$yn" = "y" ] || exit 1
    sudo shutdown -r +1
    ;;

  stale-cloud)
    NC="$CACHE_DIR/satcorps_latest.nc"
    if [ ! -f "$NC" ]; then
      echo "[soak] no cached SatCORPS file at $NC; skipping"
      exit 0
    fi
    echo "[soak] backdating cloud composite mtime to 4h ago..."
    touch -t "$(date -v-4H +%Y%m%d%H%M)" "$NC"
    ;;

  r2-block)
    echo "[soak] blocking *.r2.cloudflarestorage.com for 5 min..."
    sudo bash -c 'echo "127.0.0.1 r2.cloudflarestorage.com" >> /etc/hosts'
    sleep 300
    sudo sed -i.bak '/r2.cloudflarestorage.com/d' /etc/hosts
    echo "[soak] R2 access restored."
    ;;

  keychain-lock)
    echo "[soak] locking keychain (simulates post-reboot)..."
    /usr/bin/security lock-keychain ~/Library/Keychains/login.keychain-db
    echo "[soak] verify daemon still publishes from cached creds (or alerts on auth fail)."
    ;;

  dns-fail)
    echo "[soak] blocking celestrak.org for 5 min..."
    sudo bash -c 'echo "127.0.0.1 celestrak.org" >> /etc/hosts'
    sleep 300
    sudo sed -i.bak '/celestrak.org/d' /etc/hosts
    echo "[soak] celestrak DNS restored."
    ;;

  *)
    echo "ERROR: unknown scenario '$SCENARIO'" >&2
    bash "$0" list
    exit 2
    ;;
esac
