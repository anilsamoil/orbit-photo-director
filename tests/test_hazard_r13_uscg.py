from __future__ import annotations

import json
from datetime import timedelta
from pathlib import Path

import pytest

from generator.hazard_notices import NoticeError, parse_uscg_space_operations
from generator.hazard_sources import NGA_URL, STATE_NAME
from scripts.hazard_refresh import (
    ARTIFACT,
    PUBLICATION_RECEIPT,
    PublicationTarget,
    refresh_hazards,
)
from tests import hazard_fixtures as fx
from tests.test_hazard_r7_coverage import _publish_catalog
from tests.test_hazard_r11_warnings import USCG_URL
from tests.test_hazard_refresh import NOW, Web


def _payload(uid: int, description: str) -> bytes:
    payload = json.loads((fx.NOTICES / fx.USCG).read_bytes())
    feature = next(row for row in payload["features"] if row["properties"]["MSI_UID"] == uid)
    feature["properties"]["DESCRIPTION"] = description
    payload["features"] = [feature]
    return json.dumps(payload).encode()


def _mixed_recovery(label: str = "Hazard Area FOR LAUNCH OPERATIONS:\n") -> str:
    launch = fx.uscg_description(58067)
    coordinates = launch.split("High Risk Hazard Area:\n", 1)[1].split("Hazard Area:", 1)[0]
    return (
        fx.uscg_description(58204) + "\n" + label + coordinates
        + "13/2245Z Nov 26 to 14/0040Z Nov 26\n"
        + "Mariners are advised to remain clear of these areas for the duration of operations."
    )


@pytest.mark.parametrize("uid", (58204, 58067))
@pytest.mark.parametrize("strict", (True, False))
@pytest.mark.parametrize("label", ("Hazard Area FOR LAUNCH OPERATIONS:\n", "Hazard Area:\n", ""))
def test_mixed_recovery_cannot_hide_a_launch_block(uid: int, strict: bool, label: str) -> None:
    with pytest.raises(NoticeError, match="^USCG_ROW$"):
        parse_uscg_space_operations(_payload(uid, _mixed_recovery(label)), USCG_URL, strict=strict)


@pytest.mark.parametrize(("uid", "old", "new"), (
    (58119, "Hazard Area LOS ANGELES:", "Hazard Area FOR LAUNCH OPERATIONS:"),
    (58119, "contact Space X at", "contact LAUNCH OPERATIONS at"),
    (58119, "Pacific Ocean", "LAUNCH OPERATIONS Ocean"),
    (58122, "Pacific Ocean", "LAUNCH OPERATIONS Ocean"),
    (58114, "from November 14", "from LAUNCH 14"),
    (58114, "to November 21", "to LAUNCH 21"),
    (58114, "1544 HST", "1544 LAUNCH"),
    (58114, "0144 UTC", "0144 LAUNCH"),
    (58119, "regulatory@spacex.com", "LAUNCH@spacex.com"),
    (58204, "primary Starship vehicle", "primary LAUNCH OPERATIONS vehicle"),
    (58204, "area is Starbase Tower 2,", "area is LAUNCH OPERATIONS,"),
    (58204, "Starship reentry and landing", "LAUNCH OPERATIONS reentry and landing"),
    (58204, "initial Starship Flight 15 launch", "initial LAUNCH OPERATIONS launch"),
    (58204, "Sector Corpus Christi Command", "Sector LAUNCH OPERATIONS Command"),
    (58306, "landing of Starship Flight 15 will", "landing of LAUNCH OPERATIONS will"),
    (58306, "Port Corpus Christi is", "Port LAUNCH OPERATIONS is"),
    (58306, "in portions of the Gulf", "in LAUNCH OPERATIONS portions of the Gulf"),
    (58306, "specified reentry times", "specified launch and reentry times"),
    (58298, "landing of Starship Flight 15 will", "landing of LAUNCH OPERATIONS will"),
    (58298, "South Bay internal coastline", "LAUNCH OPERATIONS internal coastline"),
    (58306, "Sector Corpus Christi Command", "Sector LAUNCH OPERATIONS Command"),
))
def test_recovery_free_text_cannot_claim_launch_operations(uid: int, old: str, new: str) -> None:
    description = fx.uscg_description(uid)
    assert old in description
    with pytest.raises(NoticeError, match="^USCG_ROW$"):
        parse_uscg_space_operations(_payload(uid, description.replace(old, new)), USCG_URL)


@pytest.mark.parametrize("nga_present", (False, True))
def test_mixed_recovery_refresh_keeps_last_good_with_or_without_nga(
    tmp_path: Path, nga_present: bool,
) -> None:
    web = Web(complete=True)
    web.pages[USCG_URL] = _payload(58067, fx.uscg_description(58067))
    if nga_present:
        _, issued, text = fx.broadcast_blocks("navarea-iv-1080-26.txt")[0]
        web.pages[NGA_URL.format(area="4")] = json.dumps({"broadcast-warn": [{
            "navArea": "4", "msgNumber": 1080, "msgYear": 2026, "text": text,
            "issueDate": issued.strftime("%d%H%MZ %b %Y").upper(),
        }]}).encode()
    output, cache = tmp_path / "output", tmp_path / "cache"
    items = fx.catalog_items()
    next(item for item in items if item["event_id"] == fx.STARSHIP)["schedule"]["window_end"] = "2026-11-14T00:30:00Z"
    _publish_catalog(output, items)
    uploads: list[bytes] = []
    publication = PublicationTarget("offline:test", lambda path, *_: uploads.append(path.read_bytes()))
    first = refresh_hazards(cache, output, NOW, fetch=web, pause=lambda _: None, publication=publication)
    assert first["ok"] and first["published"]
    before = json.loads((cache / STATE_NAME).read_bytes())["sources"]["uscg"]
    artifact = (output / ARTIFACT).read_bytes()
    receipt = (output / PUBLICATION_RECEIPT).read_bytes()
    web.pages[USCG_URL] = _payload(58067, _mixed_recovery())

    report = refresh_hazards(
        cache, output, NOW + timedelta(minutes=31), fetch=web, pause=lambda _: None,
        publication=publication,
    )

    after = json.loads((cache / STATE_NAME).read_bytes())["sources"]["uscg"]
    assert after["error"] == "USCG_ROW"
    assert after["notices"] == before["notices"]
    assert after["checked_at"] == before["checked_at"]
    assert (report["ok"], report["degraded"], report["written"], report["published"]) == (False, True, False, False)
    assert (output / ARTIFACT).read_bytes() == artifact
    assert (output / PUBLICATION_RECEIPT).read_bytes() == receipt
    assert uploads == [artifact]


@pytest.mark.parametrize("uid", (58114, 58116, *range(58119, 58128), 58204))
def test_real_recovery_rows_keep_empty_diagnostics(uid: int) -> None:
    notice = fx.uscg_notice(uid)
    assert (notice.kind, notice.areas, notice.problems) == ("recovery", (), ())


@pytest.mark.parametrize("uid", (58296, 58298, 58306))
def test_invalid_zone_body_has_nonstrict_diagnostic(uid: int) -> None:
    description = fx.uscg_description(uid).replace("Port Corpus Christi is", "Port LAUNCH OPERATIONS is")
    (notice,) = parse_uscg_space_operations(_payload(uid, description), USCG_URL, strict=False)
    assert notice.kind != "recovery"
    assert notice.problems == ("BODY_UNPARSED",)
