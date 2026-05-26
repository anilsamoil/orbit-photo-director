#!/usr/bin/env python3
"""One-shot profile bootstrap uploader.

Reads `data/profiles/<name>/bootstrap.json` and PUTs the target list to
the live Worker API at `/api/profiles/<name>/targets`. The `_v2_*` fields
in the bootstrap file are STRIPPED before upload (the API doesn't accept
them in v1) but stay in the on-disk file for v2 rating migration.

Usage:
    OPD_CALIB_TOKEN=<your-token> python scripts/bootstrap_profile.py jack

    # Dry-run (validate JSON, show what would be sent, no network):
    python scripts/bootstrap_profile.py jack --dry-run

    # Override API base (default https://map.astroanil.dev):
    python scripts/bootstrap_profile.py jack --base https://staging.example.com

Designed for one-shot data imports — not the long-term CSV import (slot 9
will ship that as a UI feature). Use this when:
- A new astronaut joins and Anil has their spreadsheet
- Migration after a schema change
- Recovery after a profile wipe
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import requests

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_BASE = "https://map.astroanil.dev"

# v1 API accepts these fields per worker/src/profiles.ts validation. Any
# other field (including the `_v2_*` ones) gets dropped before upload.
V1_FIELDS = {"id", "name", "lat", "lon", "priority", "createdAt"}


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("profile", help="Profile name (matches data/profiles/<name>/bootstrap.json)")
    p.add_argument("--base", default=DEFAULT_BASE, help=f"API base URL (default: {DEFAULT_BASE})")
    p.add_argument("--dry-run", action="store_true", help="Validate + print payload but don't POST")
    args = p.parse_args()

    boot_path = REPO_ROOT / "data" / "profiles" / args.profile / "bootstrap.json"
    if not boot_path.exists():
        print(f"ERROR: {boot_path} not found", file=sys.stderr)
        return 1

    data = json.loads(boot_path.read_text())
    if data.get("profile") != args.profile:
        print(
            f"ERROR: bootstrap file declares profile={data.get('profile')!r} "
            f"but argv says {args.profile!r}",
            file=sys.stderr,
        )
        return 1

    raw_targets = data.get("targets", [])
    payload_targets = [
        {k: v for k, v in t.items() if k in V1_FIELDS}
        for t in raw_targets
    ]
    payload = {"targets": payload_targets}

    print(f"Profile: {args.profile}")
    print(f"Source:  {boot_path}")
    print(f"Targets: {len(payload_targets)} (stripped {sum(len(t) - len({k for k in t if k in V1_FIELDS}) for t in raw_targets)} v2-only fields)")
    skipped = data.get("skipped", [])
    if skipped:
        print(f"Skipped: {len(skipped)} entries — see bootstrap.json")

    if args.dry_run:
        print("\n--dry-run: NOT uploading. First 3 entries:")
        print(json.dumps(payload_targets[:3], indent=2))
        return 0

    token = os.environ.get("OPD_CALIB_TOKEN")
    if not token:
        print("ERROR: set OPD_CALIB_TOKEN env var with the wrangler CALIB_TOKEN secret", file=sys.stderr)
        return 1

    url = f"{args.base}/api/profiles/{args.profile}/targets"
    print(f"\nPUT {url}")
    r = requests.put(
        url,
        json=payload,
        headers={"x-calib-token": token, "content-type": "application/json"},
        timeout=30,
    )
    print(f"  HTTP {r.status_code}")
    try:
        print(f"  body: {json.dumps(r.json(), indent=2)}")
    except ValueError:
        print(f"  body (raw): {r.text[:500]}")
    if not r.ok:
        return 1
    print(f"\nDone. Open https://map.astroanil.dev/?u={args.profile} to see {args.profile}'s queue.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
