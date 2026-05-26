"""Per-astronaut profile multiplexer — Slot 4 of design rev 2 (2026-05-26).

The daemon's canonical tick produces one set of artifacts (passes.json,
status.json, top5.json, top_24h.json) scored against the curated 137 targets
in `targets.json`. This module extends that tick so each astronaut named in
`config.PROFILE_NAMES` also gets a SEPARATE set of artifacts
(passes_<name>.json, status_<name>.json, ...) scored against
  curated 137  +  the astronaut's personal targets from R2
                  (fetched via Worker API: GET /api/profiles/<name>/targets)
                  − their `removedCuratedIds` (read path wired with default
                  [] — POST not in v1; slot 6 ships that).

Storage / API
=============
The Worker (`worker/src/profiles.ts`) is the system of record. Each profile
lives at `r2:CALIB/profiles/<name>/targets.json`, exposed read-side via
`GET /api/profiles/<name>/targets` returning `{targets: PersonalTarget[]}`.
The daemon authenticates with the same `CALIB_TOKEN` shared secret used by
`/api/calib` (premise 12 of the design doc), passed in the `x-calib-token`
header. Token comes from `OPD_CALIB_TOKEN` in the daemon's environment.

If `OPD_CALIB_TOKEN` is unset, the multiplexer logs a clear warning and
skips entirely — the daemon's existing single-tenant artifacts stay as
the canonical fallback. This keeps local dev / fresh-checkout flows
working without forcing operators to provision a token.

Validation
==========
The Worker validates inputs at write time (see profiles.ts). The daemon
ALSO validates at read time (defense in depth): malformed entries are
dropped with a per-entry warning so a single bad row doesn't wedge the
profile. The validation rules mirror profiles.ts:validateTarget — id
pattern `personal:<name>:<token>`, name length, lat/lon bounds,
priority 1-10.

Failure mode
============
Profile fetch failure (network, Worker 5xx, auth) → log loudly and fall
through to curated-only for that profile. We still write per-profile
artifacts (they'll just be the canonical curated 137 view, just named for
the profile). This lets the frontend keep rendering for that profile —
better degraded than 404.

Out of scope (slot 6+)
======================
- `removedCuratedIds` filter (frontend doesn't POST this yet; daemon
  reads it with a default of [] so it's ready when slot 6 ships).
- Per-target rating UI / rephoto priority (v2 TODO).
- Per-profile auth tokens (shared CALIB_TOKEN is fine for v1, premise 12).
"""

from __future__ import annotations

import logging
import os
import re
from typing import Any

import requests

from .config import (
    PROFILE_API_BASE,
    PROFILE_FETCH_TIMEOUT_SECONDS,
    PROFILE_NAMES,
)

log = logging.getLogger(__name__)

# Mirrors worker/src/profiles.ts ID_RE (kept in sync so a target that
# round-trips PUT → GET → daemon parses cleanly). Loosened from a strict
# UUID regex to match the Worker's relaxed token portion.
_ID_RE = re.compile(r"^personal:[a-z0-9][a-z0-9-]{0,31}:[A-Za-z0-9_-]{1,128}$")

# Worker enforces this; daemon double-checks (defense in depth). Matches
# TARGET_NAME_MAX_LEN in worker/src/profiles.ts.
_NAME_MAX_LEN = 200


class ProfileFetchError(RuntimeError):
    """Raised when a profile target list can't be retrieved. Multiplexer
    catches this and falls through to curated-only for the affected
    profile — see `fetch_profile_targets` for the contract."""


def _calib_token() -> str | None:
    """Read CALIB token from the env. None when unset (multiplex disabled)."""
    return os.environ.get("OPD_CALIB_TOKEN")


def validate_personal_target(raw: Any, profile_name: str) -> dict[str, Any] | None:
    """Validate one PersonalTarget shape from the Worker. Returns the
    target as the daemon-internal target dict (with `geom.type=point`) on
    success, or None with a warning logged on failure.

    Mirrors worker/src/profiles.ts:validateTarget — kept duplicated here so
    a malformed entry that somehow slipped past the Worker (legacy data,
    out-of-band R2 edit, schema drift) doesn't crash the tick. Validation
    failures are tick-non-fatal: skip the row, log, keep going.
    """
    if not isinstance(raw, dict):
        log.warning(
            "profile %s: target is not an object (%r); skipping",
            profile_name,
            type(raw).__name__,
        )
        return None

    target_id = raw.get("id")
    if not isinstance(target_id, str) or not _ID_RE.match(target_id):
        log.warning(
            "profile %s: target has invalid id %r; skipping",
            profile_name,
            target_id,
        )
        return None

    # id must declare the matching profile in its second segment. Cheap
    # defense against a profile's bucket containing another profile's row
    # (would happen on a race or manual R2 edit).
    id_profile = target_id.split(":")[1]
    if id_profile != profile_name:
        log.warning(
            "profile %s: target id %r declares profile %r; skipping",
            profile_name,
            target_id,
            id_profile,
        )
        return None

    name = raw.get("name")
    if not isinstance(name, str) or not name or len(name) > _NAME_MAX_LEN:
        log.warning(
            "profile %s: target %s has invalid name %r; skipping",
            profile_name,
            target_id,
            name,
        )
        return None

    lat = raw.get("lat")
    lon = raw.get("lon")
    if not isinstance(lat, (int, float)) or isinstance(lat, bool) or not -90 <= lat <= 90:
        log.warning(
            "profile %s: target %s has invalid lat %r; skipping",
            profile_name,
            target_id,
            lat,
        )
        return None
    if not isinstance(lon, (int, float)) or isinstance(lon, bool) or not -180 <= lon <= 180:
        log.warning(
            "profile %s: target %s has invalid lon %r; skipping",
            profile_name,
            target_id,
            lon,
        )
        return None

    priority = raw.get("priority")
    if (
        not isinstance(priority, int)
        or isinstance(priority, bool)
        or not 1 <= priority <= 10
    ):
        log.warning(
            "profile %s: target %s has invalid priority %r; skipping",
            profile_name,
            target_id,
            priority,
        )
        return None

    # The Worker stores priorities up to 10 (more granular UI); the
    # daemon's scoring math saturates at 5 (matches curated targets). Clamp
    # here so existing scoring code stays untouched. Operator-facing
    # priority in the Profile tab UI is still 1-10; the daemon just
    # collapses 6-10 → 5 for scoring purposes.
    scoring_priority = min(priority, 5)

    return {
        "id": target_id,
        "name": name,
        # Match the curated targets schema (geom.type=point with nested
        # lat/lon) so this dict is interchangeable in find_passes and
        # score_pass_for_target with no special-casing.
        "geom": {"type": "point", "lat": float(lat), "lon": float(lon)},
        # PersonalTarget defaults regime to "any" — astronauts pick
        # locations they care about and care about getting them in any
        # lighting; the regime-fit term in scoring becomes the operator's
        # opt-in via the existing curated mechanism (v2 TODO: surface
        # regime in the add-target form).
        "regime": "any",
        "priority": scoring_priority,
        # Source marker so downstream consumers can tell personal targets
        # from curated ones if needed. Not used by scoring; just a hint
        # for debugging + future per-source filtering.
        "_source": "personal",
        "_profile": profile_name,
    }


def fetch_profile_targets(profile_name: str) -> dict[str, Any]:
    """Fetch + validate one profile's personal targets from the Worker.

    Returns a dict with:
      - `targets`: list of daemon-internal target dicts (PersonalTargets
                   converted to the curated schema, validated)
      - `removed_curated_ids`: list of curated target ids the profile
                               wants hidden. Read path wired with default
                               [] — frontend doesn't POST this yet (slot
                               6's job); we read it now so we're ready
                               when it ships.
      - `source`: "api" on success, "curated-only" on auth/network failure

    Never raises: a fetch failure logs a warning and returns a curated-only
    result (empty targets, empty removed list) so the tick proceeds.
    """
    empty: dict[str, Any] = {"targets": [], "removed_curated_ids": [], "source": "curated-only"}
    token = _calib_token()
    if not token:
        # Caller is expected to have logged the "multiplex disabled"
        # warning already — return empty here without re-logging.
        return empty

    url = f"{PROFILE_API_BASE}/api/profiles/{profile_name}/targets"
    try:
        resp = requests.get(
            url,
            headers={"x-calib-token": token},
            timeout=PROFILE_FETCH_TIMEOUT_SECONDS,
        )
        resp.raise_for_status()
        body = resp.json()
    except requests.RequestException as exc:
        log.warning(
            "profile fetch failed for %s: %s — falling back to curated-only",
            profile_name,
            exc,
        )
        return empty
    except ValueError as exc:  # JSON decode error
        log.warning(
            "profile fetch returned non-JSON for %s: %s — falling back to curated-only",
            profile_name,
            exc,
        )
        return empty

    if not isinstance(body, dict):
        log.warning(
            "profile fetch returned non-object for %s (%r); falling back to curated-only",
            profile_name,
            type(body).__name__,
        )
        return empty

    raw_targets = body.get("targets")
    if not isinstance(raw_targets, list):
        log.warning(
            "profile fetch returned no targets array for %s; falling back to curated-only",
            profile_name,
        )
        return empty

    valid: list[dict[str, Any]] = []
    for entry in raw_targets:
        target = validate_personal_target(entry, profile_name)
        if target is not None:
            valid.append(target)

    # `removedCuratedIds` is not yet sent by the frontend (slot 6 will
    # start POSTing it). The Worker returns `{targets}` only today. We
    # accept either a top-level `removedCuratedIds` (forward-compat for
    # when slot 6 lands) OR default to [].
    raw_removed = body.get("removedCuratedIds", [])
    removed: list[str] = []
    if isinstance(raw_removed, list):
        for r in raw_removed:
            if isinstance(r, str):
                removed.append(r)

    log.info(
        "profile %s: fetched %d personal targets (+%d invalid skipped, %d hidden curated)",
        profile_name,
        len(valid),
        len(raw_targets) - len(valid),
        len(removed),
    )
    return {"targets": valid, "removed_curated_ids": removed, "source": "api"}


def build_profile_target_list(
    curated: list[dict[str, Any]],
    personal: list[dict[str, Any]],
    removed_curated_ids: list[str],
) -> list[dict[str, Any]]:
    """Compute curated + personal − removed for one profile.

    De-duplication: if a personal target somehow has the same id as a
    curated one (shouldn't happen per the `personal:` id prefix, but
    cheap to defend against), the personal entry wins because that's the
    operator's explicit choice.

    Order: curated targets first (stable), then personal targets after.
    The pass-finding loop is order-insensitive; the order matters only for
    deterministic output across runs (helps with diffability).
    """
    removed_set = set(removed_curated_ids)
    personal_ids = {p["id"] for p in personal}
    result: list[dict[str, Any]] = []
    for t in curated:
        if t["id"] in removed_set:
            continue
        if t["id"] in personal_ids:
            # personal entry will be appended below; skip the curated dup
            continue
        result.append(t)
    result.extend(personal)
    return result


def profile_names() -> tuple[str, ...]:
    """Names this daemon multiplexes. Wrapped in a function so tests can
    monkeypatch the module-level constant without import-order pain."""
    return PROFILE_NAMES


def multiplex_enabled() -> bool:
    """Multiplexer runs when there's at least one profile AND we have an
    auth token. False otherwise — the canonical single-tenant pipeline
    stays as the daemon's only output."""
    if not profile_names():
        return False
    if not _calib_token():
        log.warning(
            "OPD_CALIB_TOKEN not set; profile multiplex disabled, falling back to "
            "single-tenant mode (canonical passes.json only)"
        )
        return False
    return True
