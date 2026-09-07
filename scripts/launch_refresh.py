#!/usr/bin/env python3
"""Explicit launch-only publication from existing cache; never sends WhatsApp."""

from __future__ import annotations

import argparse
import json
import subprocess
from datetime import UTC, datetime
from pathlib import Path

from generator.launch_evidence import read_cached_artifact
from generator.launch_publish import publish_launch_artifact, rclone_uploader


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--publish", action="store_true")
    parser.add_argument("--remote", default="r2:map-astroanil-dev")
    args = parser.parse_args(argv)
    try:
        artifact = read_cached_artifact(args.cache_dir, datetime.now(UTC))
        pointer = publish_launch_artifact(
            artifact, args.output, upload=rclone_uploader(args.remote) if args.publish else None
        )
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as exc:
        print(json.dumps({"ok": False, "reason": str(exc), "notified": False}))
        return 2
    print(
        json.dumps(
            {
                "ok": True,
                "published": args.publish,
                "notified": False,
                "revision": pointer["revision"],
                "items": len(artifact["items"]),
                "coverage_complete": artifact["coverage"]["complete"],
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
