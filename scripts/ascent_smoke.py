#!/usr/bin/env python3
"""Read-only launch diagnostic: no fetch, cache repair, deployment or delivery."""

from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path

from generator.config import Settings
from generator.launch_data import _parse_iso8601_z
from generator.launch_evidence import read_cached_artifact


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path)
    parser.add_argument("--now", help="UTC replay clock; newer cache is refused")
    parser.add_argument("--json", action="store_true")
    parser.add_argument(
        "--fixture", type=Path, help="fixture registry entry with event-time inputs"
    )
    args = parser.parse_args(argv)
    evidence_kind = "live_cache"
    try:
        now = _parse_iso8601_z(args.now) if args.now else datetime.now(UTC)
        cache = args.cache_dir or Settings.from_env().cache_dir
        if args.fixture:
            spec = json.loads(args.fixture.read_text())
            if spec.get("validation_status") != "ready":
                raise ValueError("HISTORICAL_EPHEMERIS_MISSING")
            evidence_kind = spec["evidence_kind"]
            if evidence_kind not in {"synthetic", "observed"}:
                raise ValueError("INVALID_FIXTURE")
            cache = (args.fixture.parent / spec["cache_dir"]).resolve()
            if not cache.is_relative_to(args.fixture.parent.resolve()):
                raise ValueError("INVALID_FIXTURE_PATH")
            now = _parse_iso8601_z(spec["now"])
        artifact = read_cached_artifact(cache, now, replay=bool(args.now or args.fixture))
        report = {
            "ok": True,
            "notified": False,
            "published": False,
            "evidence_kind": evidence_kind,
            "coverage_complete": artifact["coverage"]["complete"],
            "coverage": artifact["coverage"],
            "items": artifact["items"],
        }
    except (OSError, ValueError, KeyError, TypeError) as exc:
        reason = str(exc) if str(exc).isupper() else "INVALID_INPUT"
        report = {
            "ok": False,
            "coverage_complete": False,
            "notified": False,
            "published": False,
            "reasons": [reason],
        }
    if args.json:
        print(json.dumps(report, indent=2, allow_nan=False))
    elif not report["ok"]:
        print("Launch diagnosis incomplete: " + ", ".join(report["reasons"]))
    else:
        c = report["coverage"]
        print(
            f"Launches: {c['received']} received, {c['parsed']} parsed, "
            f"{c['evaluated']} evaluated, {c['visible']} sampled-visible, "
            f"{c['unevaluated']} unevaluated. No send or publication."
        )
        print(
            "Coverage: "
            + ("complete" if c["complete"] else "incomplete")
            + " | "
            + ", ".join(c["reasons"])
        )
        for item in report["items"]:
            print(
                f"{item['launch_window']['net']} | {item['name']} | MAP ONLY | "
                + ", ".join(item["reason_codes"])
            )
    return 0 if report["ok"] and report["coverage_complete"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
