from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

from generator.hazard_match import build_bundle
from generator.hazard_sources import (
    FAA_LIST_URL,
    NGA_URL,
    USCG_INDEX_URL,
    refresh_sources,
    sightings_from_state,
)
from tests import hazard_fixtures as fx


def test_malformed_nga_launch_row_retains_last_good_geometry_and_confirmation(tmp_path: Path):
    raw = (fx.NOTICES / fx.NGA_2023).read_bytes()
    payload = json.loads(raw)
    assert len(payload["broadcast-warn"]) == 85
    launch = next(row for row in payload["broadcast-warn"] if row["msgNumber"] == 1231)
    launch["issueDate"] = "yesterday"
    answers = [raw, json.dumps(payload).encode()]

    def fetch(url: str) -> bytes:
        if url == NGA_URL.format(area="4"):
            return answers.pop(0)
        if url == FAA_LIST_URL:
            return b"[]"
        if url == USCG_INDEX_URL:
            return b'{"spaceOpsPoly_": {"counter": 0}}'
        assert url in {NGA_URL.format(area=area) for area in ("12", "A", "P")}
        return b'{"broadcast-warn": []}'

    checked = datetime(2023, 10, 30, 21, tzinfo=UTC)
    now = checked + timedelta(hours=1)
    cache = tmp_path / "cache"
    before_sources = refresh_sources(cache, checked, fetch=fetch, pause=lambda _: None)
    after_sources = refresh_sources(cache, now, fetch=fetch, pause=lambda _: None)
    before, after = before_sources["nga:4"], after_sources["nga:4"]
    item = json.loads((fx.FIXTURES / "launch-starlink-6-25-2023.json").read_bytes())["item"]

    def bundle(sources: dict) -> dict:
        return build_bundle([item], sightings_from_state(sources, now), now)[0]

    before_launch = fx.launch(bundle(before_sources), fx.STARLINK_6_25)
    assert len(before_launch["geojson"]["features"]) == 2
    assert bundle(after_sources)["launches"] == [before_launch]
    assert after["error"] == "NGA_ROW"
    assert after["checked_at"] == before["checked_at"] == "2023-10-30T21:00:00Z"
