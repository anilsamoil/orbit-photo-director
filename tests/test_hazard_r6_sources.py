from __future__ import annotations

import json
from datetime import timedelta
from pathlib import Path

import pytest

from generator.hazard_sources import (
    FAA_LIST_URL,
    NGA_URL,
    SOURCES,
    STATE_NAME,
    USCG_INDEX_URL,
    refresh_sources,
)
from scripts.hazard_refresh import ARTIFACT, PUBLICATION_RECEIPT, PublicationTarget, refresh_hazards
from tests import hazard_fixtures as fx
from tests.test_hazard_refresh import NOW, Web, _output
from tests.test_hazard_relevance import _payload, _xii_rows

URL = NGA_URL.format(area="12")
NOTICE_ID = "NAVAREA XII 801/26"


def _page(text: str | None = None) -> bytes:
    row = next(row for row in _xii_rows() if row["msgNumber"] == 801)
    if text is not None:
        row["text"] = text
    return _payload([row])


def _other_page() -> bytes:
    return _page(
        "BERING STRAIT.\nALASKA.\n1. SCIENTIFIC MOORINGS, AT DEPTH "
        "15 METERS, ESTABLISHED IN:\n   A. 65-46.86N 168-34.06W.\n"
    )


@pytest.fixture
def published(tmp_path: Path):
    web = Web(complete=True)
    web.pages[URL] = _page()
    cache, output = tmp_path / "cache", _output(tmp_path)
    uploads: list[bytes] = []
    publication = PublicationTarget(
        "offline:test", lambda path, *_: uploads.append(path.read_bytes())
    )
    report = refresh_hazards(
        cache,
        output,
        NOW,
        fetch=web,
        pause=lambda _: None,
        publication=publication,
    )
    state = json.loads((cache / STATE_NAME).read_bytes())
    artifact, receipt = (
        (output / ARTIFACT).read_bytes(),
        (output / PUBLICATION_RECEIPT).read_bytes(),
    )
    assert report["ok"] and report["published"] and uploads == [artifact]
    assert any(
        row["notice_id"] == NOTICE_ID
        for launch in json.loads(artifact)["launches"]
        for row in launch["notices"]
    )
    return web, cache, output, publication, uploads, state, artifact, receipt


def _assert_retained(published, report: dict, source_before: dict) -> None:
    _, cache, output, _, uploads, _, artifact, receipt = published
    source = json.loads((cache / STATE_NAME).read_bytes())["sources"]["nga:12"]
    assert source["error"]
    assert source["checked_at"] == source_before["checked_at"]
    assert source["notices"] == source_before["notices"]
    assert not report["ok"] and report["degraded"]
    assert not report["written"] and not report["published"]
    assert (output / ARTIFACT).read_bytes() == artifact
    assert (output / PUBLICATION_RECEIPT).read_bytes() == receipt
    assert uploads == [artifact]


def test_lost_launch_clause_preserves_the_last_publication(published) -> None:
    web, cache, output, publication, _, before, _, _ = published
    damaged = _page().replace(b", ROCKET LAUNCHING:", b"")
    assert damaged != _page()
    web.pages[URL] = damaged
    report = refresh_hazards(
        cache,
        output,
        NOW + timedelta(minutes=31),
        fetch=web,
        pause=lambda _: None,
        publication=publication,
    )
    _assert_retained(published, report, before["sources"]["nga:12"])


def test_known_relevant_identity_cannot_become_positive_nonspace_in_cache(published) -> None:
    web, cache, _, _, _, before, _, _ = published
    web.pages[URL] = _other_page()
    sources = refresh_sources(cache, NOW + timedelta(minutes=31), fetch=web, pause=lambda _: None)
    assert sources["nga:12"]["error"]
    assert sources["nga:12"]["notices"] == before["sources"]["nga:12"]["notices"]
    assert sources["nga:12"]["checked_at"] == before["sources"]["nga:12"]["checked_at"]


def test_artifact_identity_blocks_positive_nonspace_after_empty_cache(published) -> None:
    web, cache, output, publication, _, state, _, _ = published
    state["sources"]["nga:12"]["notices"] = []
    (cache / STATE_NAME).write_text(json.dumps(state))
    web.pages[URL] = _other_page()
    report = refresh_hazards(
        cache,
        output,
        NOW + timedelta(minutes=31),
        fetch=web,
        pause=lambda _: None,
        publication=publication,
    )
    _assert_retained(published, report, state["sources"]["nga:12"])


def test_schema4_empty_cache_refetch_failure_retains_artifact_and_receipt(published) -> None:
    web, cache, output, publication, _, state, _, _ = published
    state["schema_version"] = 4
    state["sources"]["nga:12"]["notices"] = []
    (cache / STATE_NAME).write_text(json.dumps(state))
    del web.pages[URL]
    web.asked.clear()
    report = refresh_hazards(
        cache,
        output,
        NOW + timedelta(minutes=1),
        fetch=web,
        pause=lambda _: None,
        publication=publication,
    )
    assert URL in web.asked
    _assert_retained(published, report, state["sources"]["nga:12"])
    assert json.loads((cache / STATE_NAME).read_bytes())["schema_version"] == 5


def test_schema4_empty_cache_requires_successful_refetch_before_publication(published) -> None:
    web, cache, output, publication, _, state, _, _ = published
    state["schema_version"] = 4
    for entry in state["sources"].values():
        entry["notices"] = []
    (cache / STATE_NAME).write_text(json.dumps(state))
    web.asked.clear()
    report = refresh_hazards(
        cache,
        output,
        NOW + timedelta(minutes=1),
        fetch=web,
        pause=lambda _: None,
        publication=publication,
    )
    restored = json.loads((cache / STATE_NAME).read_bytes())
    assert FAA_LIST_URL in web.asked and USCG_INDEX_URL in web.asked
    assert all(
        NGA_URL.format(area=name[4:]) in web.asked for name in SOURCES if name.startswith("nga:")
    )
    assert report["ok"] and not report["degraded"]
    assert restored["schema_version"] == 5
    assert [notice["notice_id"] for notice in restored["sources"]["nga:12"]["notices"]] == [
        NOTICE_ID
    ]
    assert all(
        entry["checked_at"] == "2026-11-13T23:41:00Z" for entry in restored["sources"].values()
    )


def test_interrupted_schema4_migration_keeps_every_unconfirmed_source_due(published) -> None:
    web, cache, output, publication, uploads, state, artifact, receipt = published
    state["schema_version"] = 4
    (cache / STATE_NAME).write_text(json.dumps(state))

    def interrupted(url: str) -> bytes:
        if url == USCG_INDEX_URL:
            raise KeyboardInterrupt
        return web(url)

    with pytest.raises(KeyboardInterrupt):
        refresh_hazards(
            cache,
            output,
            NOW + timedelta(minutes=1),
            fetch=interrupted,
            pause=lambda _: None,
            publication=publication,
        )
    assert (output / ARTIFACT).read_bytes() == artifact
    assert (output / PUBLICATION_RECEIPT).read_bytes() == receipt
    assert uploads == [artifact]
    during = json.loads((cache / STATE_NAME).read_bytes())
    assert during["schema_version"] == 5
    assert during["sources"]["faa"]["checked_at"] == "2026-11-13T23:41:00Z"
    web.asked.clear()
    report = refresh_hazards(
        cache,
        output,
        NOW + timedelta(minutes=2),
        fetch=web,
        pause=lambda _: None,
        publication=publication,
    )
    assert FAA_LIST_URL not in web.asked and USCG_INDEX_URL in web.asked
    assert all(
        NGA_URL.format(area=name[4:]) in web.asked for name in SOURCES if name.startswith("nga:")
    )
    assert report["ok"]


@pytest.mark.parametrize("representation", ("primary", "alias", "listed"))
def test_validated_artifact_identities_survive_empty_source_cache(
    published, representation: str
) -> None:
    web, cache, output, _, uploads, state, artifact, _ = published
    state["sources"]["nga:12"]["notices"] = []
    (cache / STATE_NAME).write_text(json.dumps(state))
    bundle = json.loads(artifact)
    source = next(
        row
        for launch in bundle["launches"]
        for row in launch["notices"]
        if row["notice_id"] == NOTICE_ID
    )
    if representation == "alias":
        for launch in bundle["launches"]:
            for row in launch["notices"]:
                if row["notice_id"] == NOTICE_ID:
                    row["notice_id"] = "NAVAREA XII 1801/26"
                    row["also"] = [NOTICE_ID]
            for feature in launch["geojson"]["features"]:
                if feature["properties"]["notice_id"] == NOTICE_ID:
                    feature["properties"]["notice_id"] = "NAVAREA XII 1801/26"
    elif representation == "listed":
        bundle["launches"] = [
            {
                "event_id": fx.USSF_317,
                "notices": [],
                "geojson": {"type": "FeatureCollection", "features": []},
                "listed": [
                    {
                        key: source[key]
                        for key in (
                            "authority",
                            "notice_id",
                            "checked_at",
                            "valid_until",
                            "source_url",
                            "source_sha256",
                        )
                    }
                    | {"reason": "not_drawn", "text": "Area A is not drawn."}
                ],
            }
        ]
    last_good = output / "retained-test.json"
    retained_bytes = json.dumps(bundle).encode()
    last_good.write_bytes(retained_bytes)
    web.pages[URL] = _other_page()
    sources = refresh_sources(
        cache,
        NOW + timedelta(minutes=31),
        fetch=web,
        pause=lambda _: None,
        last_good=last_good,
    )
    assert sources["nga:12"]["error"]
    assert sources["nga:12"]["notices"] == []
    assert sources["nga:12"]["checked_at"] == state["sources"]["nga:12"]["checked_at"]
    assert last_good.read_bytes() == retained_bytes and uploads == [artifact]


@pytest.mark.parametrize("content", (None, b"{invalid", b'{"schema_version": 2,"launches": []}'))
def test_missing_or_invalid_artifact_grants_no_identity(
    tmp_path: Path, content: bytes | None
) -> None:
    web = Web(complete=True)
    web.pages[URL] = _other_page()
    last_good = tmp_path / "retained.json"
    if content is not None:
        last_good.write_bytes(content)
    sources = refresh_sources(
        tmp_path / "cache",
        NOW,
        fetch=web,
        pause=lambda _: None,
        last_good=last_good,
    )
    assert sources["nga:12"]["error"] is None and sources["nga:12"]["notices"] == []
    assert not last_good.exists() if content is None else last_good.read_bytes() == content
