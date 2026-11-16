from __future__ import annotations

import json
from datetime import timedelta
from pathlib import Path
from string import ascii_uppercase

import pytest

from generator.hazard_match import Sighting, build_bundle
from generator.hazard_notices import parse_nga_payload
from generator.hazard_sources import NGA_URL, STATE_NAME
from scripts.hazard_refresh import ARTIFACT, PUBLICATION_RECEIPT, PublicationTarget, refresh_hazards
from tests import hazard_fixtures as fx
from tests.test_hazard_r5_areas import _dateline_801
from tests.test_hazard_refresh import NOW, Web, _output
from tests.test_hazard_relevance import _payload, _xii_rows


def _many_areas(count: int) -> bytes:
    row = next(row for row in _xii_rows() if row["msgNumber"] == 801)
    text = str(row["text"])
    head, rest = text.split("   A. ", 1)
    first, _ = rest.split("   B. ", 1)
    tail = text[text.index("2. CANCEL"):]
    row["text"] = head + "".join(f"   {name}. {first}" for name in ascii_uppercase[:count]) + tail
    return _payload([row])


def test_sixteen_strictly_confirmed_drawable_areas_still_publish() -> None:
    (notice,) = parse_nga_payload(_many_areas(16), NGA_URL.format(area="12"))
    assert notice.kind == "launch" and not notice.problems
    assert [area.area_id for area in notice.areas] == list(ascii_uppercase[:16])
    bundle, _ = build_bundle([fx.item(fx.USSF_317)], [Sighting(notice, NOW)], NOW)
    assert len(fx.launch(bundle, fx.USSF_317)["notices"]) == 16


def test_drawable_area_overflow_retains_the_warm_artifact_and_receipt(tmp_path: Path) -> None:
    web = Web(complete=True)
    url = NGA_URL.format(area="12")
    web.pages[url] = _payload([next(row for row in _xii_rows() if row["msgNumber"] == 801)])
    cache, output = tmp_path / "cache", _output(tmp_path)
    uploads: list[bytes] = []
    publication = PublicationTarget("offline:test", lambda path, *_: uploads.append(path.read_bytes()))
    first = refresh_hazards(
        cache, output, NOW, fetch=web, pause=lambda _: None, publication=publication,
    )
    artifact = (output / ARTIFACT).read_bytes()
    receipt = (output / PUBLICATION_RECEIPT).read_bytes()
    assert first["ok"] and first["published"] and uploads == [artifact]
    assert [
        notice["area_id"] for notice in fx.launch(json.loads(artifact), fx.USSF_317)["notices"]
    ] == ["A", "B", "C"]

    web.pages[url] = _many_areas(17)
    (notice,) = parse_nga_payload(web.pages[url], url)
    assert notice.kind == "launch" and not notice.problems
    assert [area.area_id for area in notice.areas] == list(ascii_uppercase[:17])
    assert all(area.drawable for area in notice.areas)
    with pytest.raises(ValueError, match="^HAZARD_NOTICES$"):
        refresh_hazards(
            cache, output, NOW + timedelta(minutes=31), fetch=web, pause=lambda _: None,
            publication=publication,
        )

    source = json.loads((cache / STATE_NAME).read_bytes())["sources"]["nga:12"]
    assert source["error"] is None and len(source["notices"][0]["areas"]) == 17
    assert (output / ARTIFACT).read_bytes() == artifact
    assert (output / PUBLICATION_RECEIPT).read_bytes() == receipt
    assert uploads == [artifact]


def test_mixed_coverage_listing_names_only_the_withheld_area() -> None:
    (notice,) = parse_nga_payload(_dateline_801(), NGA_URL.format(area="12"))
    bundle, _ = build_bundle([fx.item(fx.USSF_317)], [Sighting(notice, NOW)], NOW)
    launch = fx.launch(bundle, fx.USSF_317)
    assert [notice["area_id"] for notice in launch["notices"]] == ["A", "B"]
    assert [feature["properties"]["area_id"] for feature in launch["geojson"]["features"]] == [
        "A", "B",
    ]
    assert launch["listed"][0]["text"] == (
        "Area C is not drawn because its ring crosses the antimeridian."
    )
