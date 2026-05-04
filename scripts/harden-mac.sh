#!/usr/bin/env bash
# scripts/harden-mac.sh — apply 8-month-unattended hardening to this Mac.
#
# This script does NOT lock down security in the firewall/least-privilege sense.
# It does the OPPOSITE: it removes the OS-level interruptions that would stop
# the generator daemon from running (screen lock, sleep, password prompts after
# sleep, automatic major-version macOS updates).
#
# Idempotent. Each setting prints its before+after state. Use --verify to check
# state without changing anything.
#
# Usage:
#   bash scripts/harden-mac.sh           # apply (prompts for sudo once)
#   bash scripts/harden-mac.sh --verify  # show current state, no changes

set -euo pipefail

VERIFY=0
[[ "${1:-}" == "--verify" ]] && VERIFY=1

apply() {
  if [[ $VERIFY -eq 1 ]]; then
    return 0
  fi
  "$@"
}

section() {
  echo ""
  echo "=== $1 ==="
}

show_then_set() {
  local label="$1"
  local current_cmd="$2"
  local apply_cmd="$3"
  local target="$4"
  printf "  %-50s current: %s" "$label" "$(eval "$current_cmd" 2>/dev/null || echo unknown)"
  if [[ $VERIFY -eq 0 ]]; then
    eval "$apply_cmd" || true
    printf "  ->  %s\n" "$(eval "$current_cmd" 2>/dev/null || echo unknown)"
  else
    printf "  (target: %s)\n" "$target"
  fi
}

if [[ $VERIFY -eq 0 ]]; then
  echo "This will modify system + user preferences. Sudo password may be needed."
  echo "Re-run with --verify to see changes without applying."
fi

section "Power management (pmset)"
# AC-power side; use -a for "all power sources" so it sticks even if the laptop
# briefly switches to battery during a power blip.
show_then_set "system sleep" \
  'pmset -g | awk "/^ +sleep/ {print \$2}"' \
  'sudo pmset -a sleep 0' \
  '0'
show_then_set "display sleep" \
  'pmset -g | awk "/^ +displaysleep/ {print \$2}"' \
  'sudo pmset -a displaysleep 0' \
  '0'
show_then_set "disk sleep" \
  'pmset -g | awk "/^ +disksleep/ {print \$2}"' \
  'sudo pmset -a disksleep 0' \
  '0'
show_then_set "Power Nap" \
  'pmset -g | awk "/^ +powernap/ {print \$2}"' \
  'sudo pmset -a powernap 0' \
  '0'
show_then_set "auto-restart on power loss" \
  'pmset -g | awk "/^ +autorestart/ {print \$2}"' \
  'sudo pmset -a autorestart 1' \
  '1'

section "Screen lock + password after sleep"
show_then_set "ask for password on wake" \
  'defaults read com.apple.screensaver askForPassword 2>/dev/null' \
  'defaults write com.apple.screensaver askForPassword -int 0' \
  '0'
show_then_set "ask for password delay (sec)" \
  'defaults read com.apple.screensaver askForPasswordDelay 2>/dev/null' \
  'defaults write com.apple.screensaver askForPasswordDelay -int 0' \
  '0'

section "Screensaver"
show_then_set "screensaver idle time (sec; 0 = never)" \
  'defaults -currentHost read com.apple.screensaver idleTime 2>/dev/null' \
  'defaults -currentHost write com.apple.screensaver idleTime -int 0' \
  '0'

section "Automatic macOS updates"
# Allow security updates (always good); disable major-version auto-install.
show_then_set "scheduled update check enabled" \
  'defaults read /Library/Preferences/com.apple.SoftwareUpdate ScheduledCheckEnabled 2>/dev/null' \
  'sudo defaults write /Library/Preferences/com.apple.SoftwareUpdate ScheduledCheckEnabled -bool true' \
  '1 (we want to KNOW about updates, just not auto-install majors)'
show_then_set "auto-install macOS major updates" \
  'defaults read /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates 2>/dev/null' \
  'sudo defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates -bool false' \
  '0'
show_then_set "auto-install app updates" \
  'defaults read /Library/Preferences/com.apple.commerce AutoUpdate 2>/dev/null' \
  'sudo defaults write /Library/Preferences/com.apple.commerce AutoUpdate -bool false' \
  '0'
show_then_set "auto-install security updates (KEEP)" \
  'defaults read /Library/Preferences/com.apple.SoftwareUpdate CriticalUpdateInstall 2>/dev/null' \
  'sudo defaults write /Library/Preferences/com.apple.SoftwareUpdate CriticalUpdateInstall -bool true' \
  '1'

section "Login window — auto-login"
# Auto-login can't be reliably scripted on modern macOS (Apple removed the
# kcpassword path in T2/Apple Silicon for security). Leave for manual config.
echo "  Auto-login MUST be set manually:"
echo "    System Settings -> Users & Groups -> Automatic Login -> set to your user"
CURRENT_AUTOLOGIN=$(defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null || echo "<not set>")
echo "  current autoLoginUser: $CURRENT_AUTOLOGIN"

section "FileVault status"
FV_STATUS=$(fdesetup status 2>/dev/null || echo "unknown")
echo "  $FV_STATUS"
if [[ "$FV_STATUS" == *"On"* ]]; then
  echo "  WARNING: FileVault is ON. After a kernel update reboots the Mac, the"
  echo "  disk WILL be locked at the EFI password prompt — daemon won't start"
  echo "  until someone enters the password. Either:"
  echo "    (a) Turn FileVault OFF for this Mac (less secure, simpler ops)"
  echo "        System Settings -> Privacy & Security -> FileVault -> Turn Off..."
  echo "    (b) Configure auto-unlock via 'sudo fdesetup authrestart' before each"
  echo "        scheduled reboot. Not unattended-friendly. Document for support."
fi

section "Keychain auto-lock"
KC=~/Library/Keychains/login.keychain-db
if [[ -f "$KC" ]]; then
  CUR=$(security show-keychain-info "$KC" 2>&1 | head -1)
  echo "  $CUR"
  if [[ $VERIFY -eq 0 ]]; then
    # Disable inactivity timeout for the login keychain
    security set-keychain-settings "$KC"
    echo "  -> set: keychain stays unlocked while user is logged in"
  fi
fi

section "Account password aging"
USER=$(whoami)
echo "  user: $USER"
POLICY=$(pwpolicy -u "$USER" -getaccountpolicies 2>/dev/null | grep -E "policyAttribute(ExpiresEvery|EnableForceChangeAtNextLogin)" || echo "<no policy returned>")
echo "  policy: $POLICY"
if [[ "$POLICY" == "<no policy returned>" ]]; then
  echo "  Good — no password aging policy set."
fi

section "Verify launchd agent is loaded"
if launchctl print "gui/$UID/com.astroanil.orbit-photo-director" >/dev/null 2>&1; then
  STATE=$(launchctl print "gui/$UID/com.astroanil.orbit-photo-director" | awk '/state =/ {print $3; exit}')
  PID=$(launchctl print "gui/$UID/com.astroanil.orbit-photo-director" | awk '/^\tpid =/ {print $3; exit}')
  echo "  loaded: state=$STATE pid=${PID:-<not running>}"
else
  echo "  NOT LOADED — install via:"
  echo "    launchctl bootstrap gui/\$UID ~/Library/LaunchAgents/com.astroanil.orbit-photo-director.plist"
fi

section "Pre-launch checklist (still on you)"
echo "  [ ] Set automatic login to your user account (System Settings)"
echo "  [ ] Verify Wi-Fi network auto-connects on boot (System Settings -> Network)"
echo "  [ ] Plug Mac into wired ethernet if available (more reliable than Wi-Fi)"
echo "  [ ] Plug into UPS / surge protector"
echo "  [ ] Disable Time Machine OR ensure it doesn't throttle other I/O"
echo "  [ ] Test reboot recovery: 'sudo shutdown -r +1' then verify daemon resumes"
echo "  [ ] If FileVault on: practice 'fdesetup authrestart' procedure"

if [[ $VERIFY -eq 0 ]]; then
  echo ""
  echo "Hardening applied. Re-run with --verify to confirm state."
fi
