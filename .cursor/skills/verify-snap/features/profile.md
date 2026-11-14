# Profile

Profile holds per-astronaut settings, personal targets, and the Photo lookup tool (timestamp / EXIF → map pin).

## Sub-features

- `profile-open` opens the Profile tab.
- `profile-body` shows the profile body region (account / crew UI).
- `profile-lookup` accepts a UTC timestamp in Photo lookup.
- `profile-targets` CRUD for personal targets (needs Worker `/api/browser/profiles/...`).

## How to get to it (user POV)

- Choose the `Profile` button in the topbar tabs.
- Scroll to **Photo lookup** inside the Profile pane.

## Driving it with control-snap

Preconditions:

- Doctor healthy.
- Google account sync and profile APIs are **not** available on the fixture server — treat authenticated target sync as `verified-unreachable` unless a Worker is wired.

- **Open Profile.** Run `.cursor/skills/verify-snap/helpers/control-snap.mjs browser click --id tab-profile`. `#view` is `view-profile` (or equivalent class from `setActive('view-profile', ...)`).
- **See lookup UI.** `#lookup-input`, `#lookup-resolve`, and `#lookup-dropzone` are visible.
- **Resolve timestamp (best-effort).** Fill `#lookup-input` with `2024-10-17T12:23:00Z` and click `#lookup-resolve`. Observe `#lookup-result` leaving `hidden` **or** an honest error/toast if TLE/SGP4 cannot resolve — capture whichever end state appears; do not fake success.
- **Proof.** Snapshot/screenshot under `.cursor/skills/verify-snap/artifacts/profile/` with Profile tab active and Photo lookup section visible.

## Gotchas

- Profile content depends heavily on Cloudflare Access + Google session on production.
- Target create/delete without Worker auth will fail network calls — report unreachable API, still verify the form controls render.
- Photo lookup moved under Profile in v1.6.6.0 — there is no top-level Lookup tab.
