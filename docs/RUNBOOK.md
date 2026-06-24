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

## Forecast cloud frames (v1.9.0.0+, flag default off)

The scrub-synced forecast cloud overlay is gated by `OPD_ENABLE_FORECAST_CLOUDS` in the launchd plist environment (same pattern as `OPD_ENABLE_ASCENT` / `OPD_ENABLE_WEATHER`). Off by default; flip to `1` after one daemon tick proves frames publish.

When enabled:

- The generator renders GFS cloud tile frames at most twice a day (00Z/12Z cycles) under `out/clouds-fcst/<run>/`; the manifest gains a top-level `forecast_clouds` key. Ticks in between no-op.
- `scripts/deploy.sh` uploads the referenced run's frames additively BEFORE the manifest flip. `scripts/prune_versions.sh` keeps the newest two run dirs in R2 — the previous run must survive the flip so clients on a not-yet-refreshed manifest never 404.
- Failures are self-healing: if a render fails or grid coverage is partial, the manifest simply omits `forecast_clouds` and the map stays on the observed cloud layer (the badge says so). Retries are capped (3 per run, ≥2h apart) so a weather-API outage can't burn the Open-Meteo request budget or starve the daemon's own pass-scoring fetches. No operator action needed.
- The wrangler fallback deploy (`scripts/deploy_wrangler.sh`) cannot upload frames; it strips `forecast_clouds` from the manifest it publishes by design. Clients stay on the observed layer until a normal rclone deploy runs.

Verify after flipping the flag (one render cycle, up to ~12h):

```bash
ls out/clouds-fcst/*/index.json
curl -s https://map.astroanil.dev/manifest.json | jq '.forecast_clouds'
```

## Adding personal targets

The `targets.json` file ships with 106 curated targets (auroras, night-megacities, iconic shapes, big terrain, volcanoes, lightning belts, dynamic events, US + global communities) selected via a "social-media legibility" framework — each scores ≥7/10 on recognizability + local connection + visual contrast + caption-ability.

To add YOUR targets (hometown, family/friends' cities, alma mater, etc.):

1. Open `personal-targets.csv`. Uncomment the example rows or add new ones. Each row:
   ```
   id,name,lat,lon,priority,regime,category,notes,caption_hook
   ```
   Example:
   ```
   my-hometown,My hometown — Kyiv,50.4501,30.5234,5,any,community-personal,Where I grew up,
   ```

2. Run the importer:
   ```bash
   cd ~/orbit-photo-director
   python scripts/import_personal_targets.py
   ```
   This merges into `targets.json`, removing the `[FILL IN]` placeholder entries (your real targets supersede them) and preserving all curated entries.

3. Verify + push:
   ```bash
   python -m generator.main          # tick locally with new targets
   bash scripts/deploy.sh            # publish to map.astroanil.dev
   git add personal-targets.csv targets.json
   git commit -m "feat: add personal targets"
   git push
   ```

**Recommended priorities:** hometown = 5 (the "I saw you from orbit" caption hits hardest), parents/partner cities = 5, sibling cities = 4, close friends = 3-4, schools/alma mater = 3.

**Lat/lon reach reminder:** ISS orbit is inclined 51.6°. Targets with `|lat| > 60°` are oblique-only. `|lat| > 70°` is effectively unreachable.

## Periodic maintenance (~once per quarter)

- [ ] Verify Earthdata token expiry: `cat ~/.config/orbit-photo-director/credentials.json | jq .earthdata` (tokens expire roughly every 60-90 days; set a reminder)
- [ ] Verify Cloudflare R2 token still valid: `wrangler r2 bucket list`
- [ ] Check disk usage: `df -h /` and `du -sh ~/orbit-photo-director/data/`
- [ ] Verify all 50 targets are still reachable (the test suite does this automatically)
- [ ] Pull-and-deploy the latest code if updates exist in the GitHub repo:
      `cd ~/orbit-photo-director && git pull && pip install -e ".[dev]" && launchctl kickstart -k gui/$UID/com.astroanil.orbit-photo-director`

## Pre-launch hardening (one-time, ~1h)

Run the script:

```bash
bash scripts/harden-mac.sh           # apply (prompts for sudo once)
bash scripts/harden-mac.sh --verify  # show state without changing anything
```

What the script handles automatically:
- Power management: no system sleep, no display sleep, no disk sleep, no Power Nap
- Auto-restart on power loss (so a brief outage doesn't leave the Mac off)
- Screen lock disabled — no password prompt after sleep
- Screensaver idle time set to 0 (never starts)
- macOS major version auto-update DISABLED (security-only updates kept enabled)
- App Store auto-update DISABLED
- Login keychain stays unlocked while user is logged in

What you have to do manually:
- [ ] **Auto-login**: System Settings → Users & Groups → Automatic Login → set to your user. Apple removed the scriptable path on Apple Silicon.
- [ ] **FileVault decision**: see "FileVault tradeoff" below.
- [ ] **Wi-Fi auto-connect**: System Settings → Network → Wi-Fi → Other Networks → Auto-Join.
- [ ] **Wired ethernet** if available — more reliable than Wi-Fi for 8-month uptime.
- [ ] **UPS / surge protector** to protect against power blips.
- [ ] **Disable Time Machine** OR ensure it doesn't compete with the daemon for I/O.
- [ ] **Test reboot recovery**: `sudo shutdown -r +1` then verify daemon resumes within 5 min of login.
- [ ] **2-week unattended soak test** with at least one injection scenario per category from `scripts/soak/inject_failure.sh`.

### Daemon cold-start (without a full reboot — quick smoke test)

Run before each soak test to confirm the daemon survives a clean restart of the
LaunchAgent. Validates: TLE fetch, all 3 cloud tiers, R2 credentials,
manifest publish, end-to-end timing.

```bash
# Stop, restart, watch the first tick + deploy.
launchctl bootout gui/$UID/com.astroanil.orbit-photo-director
truncate -s 0 data/logs/launchd.err
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.astroanil.orbit-photo-director.plist
# Wait ~15s, then read logs:
sleep 15
cat data/logs/launchd.err
# Confirm map.astroanil.dev picked up the new manifest:
curl -s https://map.astroanil.dev/manifest.json | jq -r '.version'
```

Expected on a healthy install: tick complete in 5–10 s, "deploy ok" within
a further 2 s, live `version` matches the new tick's timestamp.

### FileVault tradeoff

FileVault encrypts the disk. After a kernel update reboot, the disk is locked at the EFI password prompt — launchd cannot start the daemon until someone enters the password. Two options:

- **Turn FileVault OFF** (System Settings → Privacy & Security → FileVault → Turn Off…). Simpler ops; the Mac fully auto-resumes after any reboot. Less protection if the Mac is physically stolen.
- **Keep FileVault ON**. After kernel updates, your support contact must use `sudo fdesetup authrestart -inputplist <plist>` to schedule an auto-unlock for the next reboot, OR be physically present after the reboot to type the password. Document this carefully — multiple kernel updates per year is normal.

This Mac currently: **FileVault OFF** (set before the 2026-06-24 incident; the Mac auto-resumes after any reboot *once a user is logged in* — see "Reboot recovery requires a login" below).

### Host network tuning (ephemeral-port exhaustion — the 2026-06-24 outage)

**What happened:** the host wedged its own networking. ~19,000 stuck `TIME_WAIT`
sockets filled the macOS default ephemeral-port range (49152–65535, only ~16k
ports). Once full, *every* `127.0.0.1` connection failed with "Can't assign
requested address". That cascaded: Colima couldn't SSH to its VM → Docker/Guacamole
returned 502; the OpenClaw gateway couldn't reach its local model relay (looked like
an OAuth failure but wasn't). It built up over ~50 days of uptime. The bulk of the
churn was localhost services (BlueBubbles relay `:1234`, the gateway `:18789`) — NOT
this generator, which holds zero connections between its hourly ticks.

**The host fix (the real defense — this app depends on it):** a LaunchDaemon
`com.astroanil.net-tuning` (`/Library/LaunchDaemons/com.astroanil.net-tuning.plist`,
`RunAtLoad`) widens the range and shortens `TIME_WAIT` linger:

```bash
# Verify it is applied (expected: first=32768, msl=750):
sysctl net.inet.ip.portrange.first net.inet.tcp.msl
# If first is back at 49152, the daemon did not load — reload it:
sudo launchctl load -w /Library/LaunchDaemons/com.astroanil.net-tuning.plist
```

This gives ~33k ports (2×) and drains `TIME_WAIT` in ~1.5s instead of ~30s.

**The generator's guardrails (added 2026-06-24):**
- It pools outbound HTTP via a shared keep-alive session (`generator/netpool.py`),
  so a tick reuses connections instead of opening a fresh socket per request
  (the ~360-granule GLM fetch drops from ~360 connections to ~16). It is a good
  host citizen — not a cause.
- At startup it logs a **WARNING** if `portrange.first` is back at the 49152
  default (the net-tuning daemon is missing). Grep: `net-tuning`.
- Each tick it logs the host `TIME_WAIT` count and **WARNS above 8000** — an early
  tripwire long before exhaustion. Grep: `TIME_WAIT sockets`.
- Off-switch (rarely needed): `OPD_SKIP_NETCHECK=1`.

**Manual recovery if it ever recurs (needs sudo):**
```bash
sudo sysctl -w net.inet.ip.portrange.first=32768 net.inet.tcp.msl=750  # localhost recovers
colima stop --force && colima start          # plain `restart` HANGS while localhost is broken
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway
cd ~/iss2-guacamole && docker compose -f docker-compose.guacamole.yml restart  # clears the 502
```

### Reboot recovery requires a login (auto-login + VPN)

The generator runs as a **per-user LaunchAgent** (`gui/$UID/...`) and the Tailscale
VPN runs as the **GUI app + network extension** under the login session. Neither
starts at the macOS login window — they start when a user **logs into the GUI**.
So after a reboot with no auto-login, the Mac sits dark (no daemon, no VPN, SSH/guac
unreachable) until someone physically logs in. That is why the 2026-06-24 reboot
needed a hands-on login before everything reconnected.

**Fix for unattended operation** (FileVault is OFF, so this is safe to enable):
- [ ] **Enable Automatic Login**: System Settings → Users & Groups → Automatically
      log in as → the operator user. Apple removed the scriptable path on Apple
      Silicon, so this is a one-time manual GUI step. With it on, a reboot lands
      straight in the session and the daemon + VPN come up with no human present.
- [ ] *(Optional, belt-and-suspenders — NOT a quick command)* The VPN here is the
      **macsys GUI variant** (`/Applications/Tailscale.app`, v1.96.2 + a Network
      Extension). That variant has **no `install-system-daemon`** subcommand — it is
      architecturally tied to the login session, and a bare `sudo tailscale
      install-system-daemon` just errors ("unknown subcommand", also true of the
      homebrew v1.94.2 CLI). True boot-independence means **replacing** macsys with the
      open-source `tailscaled` running as a LaunchDaemon, then re-authing the node.
      That migration **drops the tunnel and needs interactive re-auth**, so do it ONLY
      with console/physical access — never blind over the tunnel it would cut. Until
      then, **auto-login is the supported unattended path for macsys** (and it is now
      enabled).

Verify after enabling: `sudo shutdown -r +1`, then confirm (remotely) that
`map.astroanil.dev` manifest advances and Tailscale reconnects within ~5 min — with
**no** interactive login.

## Credential rotation

Run `bash scripts/check-credentials.sh` daily (or weekly) to spot expired creds before they bite:

```
[1] NASA Earthdata    — checks ~/.netrc + credentials.json + URS reachability
[2] Cloudflare R2     — runs `rclone lsf` against the bucket
[3] Cloudflare API    — informational (the cfat_ token is unused at runtime)
[4] CALIB_TOKEN       — confirms Worker secret is set
```

### Earthdata password rotation (~every 60-90 days)

Earthdata passwords don't strictly expire on a schedule, but URS occasionally forces resets. If you see HTTP 401 from any data fetch, rotate:

1. Visit `https://urs.earthdata.nasa.gov/profile` and log in (`anilsamoil` / current password).
2. Go to "Change Password" and set a new one. Copy it before closing the window.
3. Update `~/.netrc`:
   ```bash
   # back up first
   cp ~/.netrc ~/.netrc.bak.$(date +%Y%m%d)
   # rewrite the urs.earthdata.nasa.gov entry
   python3 - <<EOF
   from pathlib import Path
   import re
   netrc = Path.home() / ".netrc"
   text = netrc.read_text()
   new = re.sub(
       r"machine urs\.earthdata\.nasa\.gov\s+login \S+\s+password \S+",
       f"machine urs.earthdata.nasa.gov\n  login anilsamoil\n  password NEW_PASSWORD_HERE",
       text,
   )
   netrc.write_text(new)
   EOF
   chmod 600 ~/.netrc
   ```
4. Update `~/.config/orbit-photo-director/credentials.json`:
   ```bash
   python3 - <<EOF
   import json, os
   from pathlib import Path
   p = Path.home() / ".config" / "orbit-photo-director" / "credentials.json"
   data = json.loads(p.read_text())
   data["earthdata"]["password"] = "NEW_PASSWORD_HERE"
   p.write_text(json.dumps(data, indent=2))
   os.chmod(p, 0o600)
   EOF
   ```
5. Verify: `bash scripts/check-credentials.sh` should pass.
6. Restart daemon to pick up new creds:
   ```bash
   launchctl kickstart -k gui/$UID/com.astroanil.orbit-photo-director
   ```

### Cloudflare R2 keys rotation

R2 user API tokens don't expire by default but Cloudflare may revoke them if the token is exposed.

1. Go to `https://dash.cloudflare.com/<account-id>/r2/api-tokens`.
2. Click **Create User API Token** → name it `orbit-photo-director-deploy-rotated-YYYY-MM-DD`.
3. Permissions: **Object Read & Write**, scoped to `map-astroanil-dev` AND `orbit-calib`.
4. Copy the new Access Key ID + Secret Access Key (Cloudflare only shows them ONCE).
5. Update `~/.config/rclone/rclone.conf`:
   ```bash
   # The [r2] section: replace access_key_id and secret_access_key values.
   nano ~/.config/rclone/rclone.conf
   ```
6. Verify: `rclone lsf r2:map-astroanil-dev/ --max-depth 1` lists files.
7. Update `~/.config/orbit-photo-director/credentials.json` with the new keys.
8. Revoke the OLD token from the dashboard.
9. Run `bash scripts/check-credentials.sh` — should pass.

### CALIB_TOKEN rotation (Worker secret)

If the calibration token leaks (it lives in browser localStorage, plaintext), rotate:

1. Generate a new token: `python3 -c "import secrets; print(secrets.token_hex(32))"` (copy output).
2. Set on Worker:
   ```bash
   cd ~/orbit-photo-director/worker
   echo "NEW_TOKEN_HERE" | wrangler secret put CALIB_TOKEN
   wrangler deploy
   ```
3. Update credentials.json:
   ```bash
   python3 -c "
   import json, os
   from pathlib import Path
   p = Path.home() / '.config' / 'orbit-photo-director' / 'credentials.json'
   d = json.loads(p.read_text())
   d['calib_token'] = 'NEW_TOKEN_HERE'
   p.write_text(json.dumps(d, indent=2))
   os.chmod(p, 0o600)
   "
   ```
4. **Important**: any browser that previously visited `map.astroanil.dev` has the OLD token in localStorage. The `/api/log` Worker will return 401 on those POSTs and the frontend (per its hardening) will clear the token + show the setup banner. The astronaut needs to paste the new token into localStorage on the ISS-side device:
   ```js
   // In browser DevTools console on map.astroanil.dev:
   localStorage.setItem('opd-calib-token', 'NEW_TOKEN_HERE');
   ```

## Escalation

If you cannot recover within 24h and the astronaut is still relying on the system:

1. Disable the alert temporarily so the astronaut isn't seeing a perma-red banner: rebuild a static `manifest.json` with `freshness.ok: false` and a note explaining the outage, push to R2 via `make deploy`.
2. Contact the astronaut via standard mission comms to notify them the planning tool is offline; they'll fall back to manual photography decisions.
3. Document the incident in `docs/INCIDENTS.md` (create if missing) for post-mortem.

## Contact

Repo: https://github.com/anilsamoil/orbit-photo-director
Owner: Anil Samoilenko (anilsamoilenko@gmail.com)
Astronaut email (mission-affiliated): iss.astro.anil@gmail.com
