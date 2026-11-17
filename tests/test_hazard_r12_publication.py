from __future__ import annotations

import json
from datetime import timedelta
from pathlib import Path

import pytest

from generator.hazard_sources import STATE_NAME
from scripts.hazard_refresh import (
    ARTIFACT,
    PUBLICATION_RECEIPT,
    RUN_LOG,
    PublicationTarget,
    refresh_hazards,
)
from tests import hazard_fixtures as fx
from tests.test_hazard_r7_coverage import _publish_catalog
from tests.test_hazard_r10_match import AVOID_THREE_HOURS
from tests.test_hazard_r11_warnings import USCG_URL, _uscg_payload, _with_advice
from tests.test_hazard_r12_parsers import (
    CONTACT,
    FAA_AVOIDANCE,
    FAA_RESTRICTION,
    FAA_URL,
    VESSEL_AVOIDANCE,
    _faa_payload,
)
from tests.test_hazard_refresh import NOW, Web


@pytest.mark.parametrize("case", (
    "uscg-contact-twice", "uscg-contact-vessel", "faa-after", "faa-before",
    "uscg-overlength", "faa-unsupported", "faa-overflow", "faa-overlength",
))
def test_warning_refresh_keeps_all_instructions_or_retains_last_good(
    tmp_path: Path, case: str,
) -> None:
    web = Web(complete=True)
    source, url, notice_id = (
        ("uscg", USCG_URL, "USCG LNM 58067")
        if case.startswith("uscg") else ("faa", FAA_URL, "TFR 6/7129")
    )
    required = (AVOID_THREE_HOURS,)
    if case == "uscg-contact-twice":
        changed = _uscg_payload(_with_advice(CONTACT, CONTACT))
    elif case == "uscg-contact-vessel":
        original = fx.uscg_description(58067).replace(AVOID_THREE_HOURS, VESSEL_AVOIDANCE)
        web.pages[url] = _uscg_payload(original)
        changed = _uscg_payload(original.replace(VESSEL_AVOIDANCE, CONTACT + "\n" + VESSEL_AVOIDANCE))
        required = (VESSEL_AVOIDANCE,)
    elif case == "uscg-overlength":
        instruction = "Mariners must avoid " + "these hazardous waters " * 20 + "during launch."
        changed = _uscg_payload(_with_advice(instruction))
    else:
        required = (FAA_RESTRICTION, FAA_AVOIDANCE)
        paragraphs = (FAA_RESTRICTION, FAA_AVOIDANCE)
        if case == "faa-before":
            paragraphs = tuple(reversed(paragraphs))
        elif case == "faa-unsupported":
            paragraphs = (FAA_RESTRICTION, "UNSUPPORTED ADDITIONAL OPERATING CONDITION.")
        elif case == "faa-overflow":
            paragraphs = (FAA_RESTRICTION, FAA_AVOIDANCE, FAA_AVOIDANCE, FAA_AVOIDANCE)
        elif case == "faa-overlength":
            paragraphs = (FAA_RESTRICTION, "AIRCRAFT MUST AVOID " + "THE AREA " * 50 + "DURING LAUNCH.")
        changed = _faa_payload(*paragraphs)
    rejecting = case in {"uscg-overlength", "faa-unsupported", "faa-overflow", "faa-overlength"}
    output, cache = tmp_path / "output", tmp_path / "cache"
    items = fx.catalog_items()
    next(item for item in items if item["event_id"] == fx.STARSHIP)["schedule"]["window_end"] = "2026-11-14T00:30:00Z"
    _publish_catalog(output, items)
    uploads: list[bytes] = []
    publication = PublicationTarget("offline:test", lambda path, *_: uploads.append(path.read_bytes()))
    first = refresh_hazards(cache, output, NOW, fetch=web, pause=lambda _: None, publication=publication)
    assert first["ok"] and first["published"]
    before = json.loads((cache / STATE_NAME).read_bytes())["sources"][source]
    artifact, receipt = (output / ARTIFACT).read_bytes(), (output / PUBLICATION_RECEIPT).read_bytes()
    web.pages[url] = changed

    report = refresh_hazards(
        cache, output, NOW + timedelta(minutes=31), fetch=web, pause=lambda _: None,
        publication=publication,
    )

    after = json.loads((cache / STATE_NAME).read_bytes())["sources"][source]
    if rejecting or after["error"] is not None:
        assert after["error"] == ("USCG_ROW" if source == "uscg" else "FAA_ROW")
        assert after["notices"] == before["notices"]
        assert after["checked_at"] == before["checked_at"]
        assert (report["ok"], report["degraded"], report["written"], report["published"]) == (False, True, False, False)
        assert (output / ARTIFACT).read_bytes() == artifact
        assert (output / PUBLICATION_RECEIPT).read_bytes() == receipt
        assert uploads == [artifact]
        run = json.loads((output / RUN_LOG).read_bytes())
        assert run["degraded"] and not run["published"]
    else:
        assert report["ok"] and report["published"]
        record = next(row for row in after["notices"] if row["notice_id"] == notice_id)
        cached = [instruction for area in record["areas"] for instruction in area["instructions"]]
        bundle = json.loads((output / ARTIFACT).read_bytes())
        published = [
            instruction for entry in bundle["launches"] for row in entry["notices"]
            if row["notice_id"] == notice_id for instruction in row["instructions"]
        ]
        assert set(required) <= set(cached)
        assert set(required) <= set(published)
        assert uploads[-1] == (output / ARTIFACT).read_bytes()
