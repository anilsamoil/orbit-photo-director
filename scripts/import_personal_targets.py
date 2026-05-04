#!/usr/bin/env python3
"""Merge personal-targets.csv into targets.json.

Replaces any existing entries with `category="community-personal"` AND removes
any `_placeholder=true` entries that the user has now superseded with real ones.

Usage:
    python scripts/import_personal_targets.py [--csv path] [--targets path]
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DEFAULT_CSV = REPO / "personal-targets.csv"
DEFAULT_TARGETS = REPO / "targets.json"


def parse_csv(path: Path) -> list[dict]:
    if not path.exists():
        sys.exit(f"ERROR: {path} not found")
    rows: list[dict] = []
    with path.open() as f:
        for raw_line_num, raw in enumerate(f, start=1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            reader = csv.reader([line])
            fields = next(reader)
            if raw_line_num == 1 and fields[0] == "id":
                continue
            if len(fields) < 6:
                print(
                    f"  skip line {raw_line_num}: not enough columns ({len(fields)})",
                    file=sys.stderr,
                )
                continue
            id_, name, lat, lon, priority, regime, *rest = (f.strip() for f in fields)
            category = rest[0] if len(rest) > 0 and rest[0] else "community-personal"
            notes = rest[1] if len(rest) > 1 else ""
            caption_hook = rest[2] if len(rest) > 2 else ""
            try:
                lat_f, lon_f = float(lat), float(lon)
                pri = int(priority)
            except ValueError as exc:
                print(f"  skip line {raw_line_num}: parse error ({exc})", file=sys.stderr)
                continue
            if not (-90 <= lat_f <= 90 and -180 <= lon_f <= 180):
                print(f"  skip line {raw_line_num}: lat/lon out of range", file=sys.stderr)
                continue
            if pri not in (1, 2, 3, 4, 5):
                print(f"  skip line {raw_line_num}: priority must be 1-5", file=sys.stderr)
                continue
            if regime not in ("day", "night", "terminator", "any"):
                print(
                    f"  skip line {raw_line_num}: regime must be day/night/terminator/any",
                    file=sys.stderr,
                )
                continue
            entry: dict = {
                "id": id_,
                "name": name,
                "geom": {"type": "point", "lat": lat_f, "lon": lon_f},
                "priority": pri,
                "regime": regime,
                "tier": 3,
                "category": category,
            }
            if notes:
                entry["notes"] = notes
            if caption_hook:
                entry["caption_hook"] = caption_hook
            rows.append(entry)
    return rows


def merge(targets: list[dict], personal: list[dict]) -> list[dict]:
    kept = [
        t for t in targets
        if t.get("category") != "community-personal"
        and t.get("_placeholder") is not True
    ]
    seen_ids = {t["id"] for t in kept}
    appended = []
    for p in personal:
        if p["id"] in seen_ids:
            print(f"  WARN: id '{p['id']}' already exists, skipping", file=sys.stderr)
            continue
        appended.append(p)
        seen_ids.add(p["id"])
    return kept + appended


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--csv", type=Path, default=DEFAULT_CSV)
    parser.add_argument("--targets", type=Path, default=DEFAULT_TARGETS)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    print(f"reading personal targets from: {args.csv}")
    personal = parse_csv(args.csv)
    print(f"  parsed {len(personal)} personal targets")

    print(f"reading curated targets from: {args.targets}")
    targets = json.loads(args.targets.read_text())
    print(f"  curated count: {len(targets)}")

    merged = merge(targets, personal)
    placeholder_count = sum(1 for t in targets if t.get("_placeholder") is True)
    personal_count = sum(1 for t in merged if t.get("category") == "community-personal")
    print(f"  removed {placeholder_count} placeholders")
    print(f"  total after merge: {len(merged)} ({personal_count} personal)")

    if args.dry_run:
        print("\n--- merged (dry run) ---")
        for p in merged[-min(10, len(merged)):]:
            print(f"  {p['id']:30s} {p.get('category','?')}")
        return 0

    args.targets.write_text(json.dumps(merged, indent=2))
    print(f"wrote {args.targets}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
