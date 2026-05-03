# Ground-Side Support Runbook

This runbook is for the named ground-side support contact who can physically reach the Mac running Orbit Photo Director if it goes silent during the 8-month mission.

> **In an emergency:** if `map.astroanil.dev` is showing a red `STALE` banner for more than 24h and you cannot reach the Mac remotely, the fastest fix is in-person physical access.

## What this system is

A Mac on Earth runs a Python daemon every 30 minutes. The daemon fetches ISS TLE + cloud cover, scores upcoming passes over saved targets, writes artifacts to a versioned subfolder, and `rclone sync`s them to Cloudflare R2 — which serves `map.astroanil.dev` to the astronaut on the ISS.

If the Mac silently stops, the astronaut sees a `STALE` banner. That's the loud-failure design — it never blanks out, but the data goes red.

## Alert triggers

Alerts fire from **UptimeRobot** to the OpenClaw notification pipeline (see `~/.config/orbit-photo-director/alert-channel.txt` for the destination). You'll see:

- **STALE > 30 min**: routine. Daemon may have hit a transient network blip and will recover next tick. Wait 1 tick (~30 min).
- **STALE > 2h**: investigate. Daemon may be wedged.
- **STALE > 6h**: physical or remote intervention needed.

## Diagnostic ladder (run in this order)

### 1. Confirm the alert is real

```bash
curl -s https://map.astroanil.dev/api/health | jq
```

Expected: `{"ok": true, "age_seconds": <small>, "version": "..."}`. If `ok: false`, the system itself confirms degradation.

### 2. Try remote SSH (if configured)

```bash
ssh astroanil@<mac-hostname-or-ip>
```

If you can SSH in, jump to "On-Mac diagnostics" below. If not, continue.

### 3. Physical access checklist

Once you're at the Mac:

- [ ] **Screen unlocked?** If locked, log in. (Auto-login is enabled, but a kernel update reboot can require manual login the first time.)
- [ ] **Wi-Fi connected?** Check the menu bar.
- [ ] **Power adapter plugged in?** Required to prevent sleep.
- [ ] **No system updates pending?** If yes, defer them: `softwareupdate --ignore <name>`.

### 4. On-Mac diagnostics

```bash
cd ~/orbit-photo-director

# Is the launchd agent loaded?
launchctl print gui/$UID/com.astroanil.orbit-photo-director | head -20

# Recent log lines
tail -100 data/logs/launchd.err
tail -100 data/logs/launchd.out

# Is the daemon process actually running?
pgrep -lf "generator.daemon"

# How fresh is the published manifest?
curl -s https://map.astroanil.dev/manifest.json | jq '.generated_at, .freshness'

# Disk full?
df -h /
```

### 5. Common fixes

| Symptom | Fix |
|---|---|
| Daemon not running | `launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.astroanil.orbit-photo-director.plist` |
| Daemon crashing on start | Check `launchd.err`. If venv broken: `cd ~/orbit-photo-director && python3 -m venv --upgrade .venv && source .venv/bin/activate && pip install -e ".[dev]"` |
| Earthdata token expired | Visit https://urs.earthdata.nasa.gov, generate a new token, update `~/.netrc` and `~/.config/orbit-photo-director/credentials.json`. Restart daemon. |
| Cloudflare R2 token expired | Run `wrangler login` once. The next deploy will re-authorize. |
| Disk full | `make clean` then check `~/orbit-photo-director/data/logs/` and `~/orbit-photo-director/data/cache/`. Logs auto-rotate to 30 days; cache should be < 1 GB. |
| Network unreachable | The daemon will retry with exponential backoff. If sustained, restart the network or reboot the Mac. |
| Site shows manifest but `freshness.ok: false` | TLE or cloud composite source is degraded. Daemon is running but inputs are bad. Check upstream status pages: Celestrak, NASA Earthdata. |
| Mac unresponsive | Hard reboot. launchd will auto-start the daemon after login. |

## Periodic maintenance (~once per quarter)

- [ ] Verify Earthdata token expiry: `cat ~/.config/orbit-photo-director/credentials.json | jq .earthdata` (tokens expire roughly every 60-90 days; set a reminder)
- [ ] Verify Cloudflare R2 token still valid: `wrangler r2 bucket list`
- [ ] Check disk usage: `df -h /` and `du -sh ~/orbit-photo-director/data/`
- [ ] Verify all 50 targets are still reachable (the test suite does this automatically)
- [ ] Pull-and-deploy the latest code if updates exist in the GitHub repo:
      `cd ~/orbit-photo-director && git pull && pip install -e ".[dev]" && launchctl kickstart -k gui/$UID/com.astroanil.orbit-photo-director`

## Pre-launch hardening (one-time, ~1h)

These steps were partially completed during the pre-launch soak. Verify before sealing the Mac for the mission:

- [ ] Auto-login enabled (System Settings → Users & Groups → Login Options)
- [ ] Auto-update for macOS major versions DISABLED (security-only updates allowed)
- [ ] No screensaver / no display sleep on AC power: `pmset -a displaysleep 0 sleep 0`
- [ ] No password requirement after sleep: `defaults write com.apple.screensaver askForPassword -int 0`
- [ ] Passwords don't expire: confirm via `pwpolicy -getaccountpolicies anilsamoil`
- [ ] FileVault: if enabled, configure auto-unlock or document the recovery key location
- [ ] Verify `rclone --version` and `wrangler --version` are on the system PATH for the launchd-spawned process
- [ ] 2-week unattended soak test passed with at least one of each injection scenario in `scripts/soak/inject_failure.sh`

## Escalation

If you cannot recover within 24h and the astronaut is still relying on the system:

1. Disable the alert temporarily so the astronaut isn't seeing a perma-red banner: rebuild a static `manifest.json` with `freshness.ok: false` and a note explaining the outage, push to R2 via `make deploy`.
2. Contact the astronaut via standard mission comms to notify them the planning tool is offline; they'll fall back to manual photography decisions.
3. Document the incident in `docs/INCIDENTS.md` (create if missing) for post-mortem.

## Contact

Repo: https://github.com/anilsamoil/orbit-photo-director
Owner: Anil Samoilenko (anilsamoilenko@gmail.com)
Astronaut email (mission-affiliated): iss.astro.anil@gmail.com
