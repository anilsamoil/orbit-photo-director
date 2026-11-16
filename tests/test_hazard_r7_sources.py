from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from generator.hazard_match import validate_bundle
from generator.hazard_notices import notice_record, parse_nga_payload
from generator.hazard_sources import STATE_NAME, refresh_sources
from generator.launch_evidence import canonical_bytes, utc
from generator.launch_publish import publish_launch_catalog
from scripts.hazard_refresh import ARTIFACT, PUBLICATION_RECEIPT, refresh_hazards
from tests import hazard_fixtures as fx
from tests.test_hazard_r5_areas import _dateline_801
from tests.test_hazard_r6_sources import NOTICE_ID, URL, _assert_retained, _other_page, _page
from tests.test_hazard_r6_sources import published as published
from tests.test_hazard_refresh import NOW
from tests.test_hazard_relevance import _payload

EXPIRY = datetime(2026, 11, 24, 7, 34, tzinfo=UTC)
CANCELLATION_ID = "NAVAREA XII 1801/26"


def _renew_catalog(output: Path, now: datetime) -> None:
    catalog = json.loads((fx.FIXTURES / "launch-catalog-2026-11-13.json").read_bytes())
    catalog["generated_at"] = utc(now)
    catalog["schedule_valid_until"] = utc(now + timedelta(minutes=75))
    catalog["geometry_valid_until"] = utc(now + timedelta(minutes=15))
    catalog["revision"] = hashlib.sha256(
        canonical_bytes({key: value for key, value in catalog.items() if key != "revision"})
    ).hexdigest()[:24]
    publish_launch_catalog(catalog, output)


def _cancellation_row(target: str = "801/26") -> dict:
    row = json.loads(_page())["broadcast-warn"][0]
    row["msgNumber"] = 1801
    row["text"] = row["text"].replace("785/26", target)
    return row


def _replacement_page(cancellation: dict | None = None) -> bytes:
    rows = json.loads(_other_page())["broadcast-warn"]
    return _payload(rows + ([cancellation] if cancellation is not None else []))


def _refresh(published, now: datetime) -> dict:
    web, cache, output, publication, *_ = published
    _renew_catalog(output, now)
    return refresh_hazards(
        cache, output, now, fetch=web, pause=lambda _: None, publication=publication,
    )


def _assert_withdrawn(published, report: dict, expected_ids: list[str]) -> None:
    _, cache, output, _, uploads, _, artifact, receipt = published
    state = json.loads((cache / STATE_NAME).read_bytes())
    source = state["sources"]["nga:12"]
    current = (output / ARTIFACT).read_bytes()
    assert state["schema_version"] == 5
    assert source["error"] is None, source["error"]
    assert [row["notice_id"] for row in source["notices"]] == expected_ids
    assert report["ok"] and not report["degraded"]
    assert report["written"] and report["published"]
    assert current != artifact and uploads[-1] == current and len(uploads) == 2
    assert (output / PUBLICATION_RECEIPT).read_bytes() != receipt
    assert all(
        NOTICE_ID not in [row["notice_id"], *row.get("also", [])]
        for launch in json.loads(current)["launches"]
        for row in [*launch["notices"], *launch["listed"]]
    )


@pytest.mark.parametrize("offset", (timedelta(0), timedelta(seconds=1), timedelta(days=1)))
def test_trusted_expiry_withdraws_downgraded_notice_and_publishes(published, offset: timedelta) -> None:
    web, *_ = published
    assert parse_nga_payload(_page(), URL)[0].valid_until == EXPIRY
    web.pages[URL] = _other_page()
    report = _refresh(published, EXPIRY + offset)
    _assert_withdrawn(published, report, [])


def test_one_second_before_trusted_expiry_keeps_last_publication(published) -> None:
    web, _, _, _, _, state, *_ = published
    web.pages[URL] = _other_page()
    report = _refresh(published, EXPIRY - timedelta(seconds=1))
    assert report["sources"]["nga:12"]["error"] == "NGA_RELEVANCE_DOWNGRADE"
    _assert_retained(published, report, state["sources"]["nga:12"])


def test_validated_fresh_cancellation_withdraws_downgraded_notice_and_publishes(published) -> None:
    web, *_ = published
    web.pages[URL] = _replacement_page(_cancellation_row())
    cancellation = parse_nga_payload(web.pages[URL], URL)[1]
    assert cancellation.notice_id == CANCELLATION_ID
    assert cancellation.cancels == (NOTICE_ID,) and not cancellation.problems
    report = _refresh(published, NOW + timedelta(minutes=31))
    _assert_withdrawn(published, report, [CANCELLATION_ID])


def test_validated_cached_cancellation_survives_the_next_downgrade(published) -> None:
    web, cache, output, _, uploads, *_ = published
    web.pages[URL] = _payload([
        json.loads(_page())["broadcast-warn"][0], _cancellation_row(),
    ])
    assert _refresh(published, NOW + timedelta(minutes=31))["ok"]
    cached = json.loads((cache / STATE_NAME).read_bytes())["sources"]["nga:12"]["notices"]
    assert cached[1]["cancels"] == [NOTICE_ID]
    web.pages[URL] = _other_page()
    report = _refresh(published, NOW + timedelta(minutes=62))
    assert report["sources"]["nga:12"]["error"] is None
    assert report["ok"] and report["published"] and len(uploads) == 3
    assert json.loads((cache / STATE_NAME).read_bytes())["sources"]["nga:12"]["notices"] == []
    assert uploads[-1] == (output / ARTIFACT).read_bytes()


@pytest.mark.parametrize("problem", (
    "CANCEL_UNPARSED", "RELEVANCE_UNCERTAIN", "PREAMBLE_UNPARSED", "UNKNOWN_DIAGNOSTIC",
))
def test_unparsed_cached_cancellation_cannot_release_artifact_identity(
    published, problem: str,
) -> None:
    web, cache, output, _, uploads, state, artifact, receipt = published
    cancellation = notice_record(parse_nga_payload(_payload([_cancellation_row()]), URL)[0])
    cancellation["problems"] = [problem]
    state["sources"]["nga:12"]["notices"].append(cancellation)
    (cache / STATE_NAME).write_text(json.dumps(state))
    web.pages[URL] = _other_page()
    sources = refresh_sources(
        cache, NOW + timedelta(minutes=31), fetch=web, pause=lambda _: None,
        last_good=output / ARTIFACT,
    )
    assert sources["nga:12"]["error"] == "NGA_RELEVANCE_DOWNGRADE"
    assert "notices" not in sources["nga:12"] and "checked_at" not in sources["nga:12"]
    assert (output / ARTIFACT).read_bytes() == artifact
    assert (output / PUBLICATION_RECEIPT).read_bytes() == receipt and uploads == [artifact]


@pytest.mark.parametrize("diagnostic", ("WINDOW_UNPARSED:", "GEOMETRY_UNDRAWN:"))
def test_supported_cached_nga_diagnostics_preserve_valid_cancellation(
    published, diagnostic: str,
) -> None:
    web, cache, _, _, _, state, *_ = published
    if diagnostic == "GEOMETRY_UNDRAWN:":
        row = json.loads(_dateline_801())["broadcast-warn"][0]
        row["msgNumber"] = 1801
        row["text"] = row["text"].replace("785/26", "801/26")
    else:
        row = _cancellation_row()
        row["text"] = (
            "NORTH PACIFIC.\n1. HAZARDOUS OPERATIONS, ROCKET LAUNCHING "
            "140000Z NOV TO 240000Z NOV "
            "IN AREA BOUND BY\n32-00.00N 119-00.00W, 33-00.00N 119-00.00W, "
            "32-00.00N 120-00.00W.\n2. CANCEL NAVAREA XII 801/26.\n"
            "3. CANCEL THIS MSG 240734Z NOV 26.\n"
        )
    cancellation = parse_nga_payload(_payload([row]), URL)[0]
    assert cancellation.cancels == (NOTICE_ID,)
    assert cancellation.problems and all(problem.startswith(diagnostic) for problem in cancellation.problems)
    state["sources"]["nga:12"]["notices"].append(notice_record(cancellation))
    (cache / STATE_NAME).write_text(json.dumps(state))
    web.pages[URL] = _other_page()
    report = _refresh(published, NOW + timedelta(minutes=31))
    _assert_withdrawn(published, report, [])


@pytest.mark.parametrize("damage", ("missing_issue", "unread_tail", "missing_area"))
def test_malformed_cancellation_cannot_release_last_publication(published, damage: str) -> None:
    web, _, _, _, _, state, *_ = published
    cancellation = _cancellation_row()
    if damage == "missing_issue":
        del cancellation["issueDate"]
    elif damage == "unread_tail":
        cancellation["text"] += "CANCELLATION IS UNCONFIRMED.\n"
    else:
        start = cancellation["text"].index("   B.")
        stop = cancellation["text"].index("   C.")
        cancellation["text"] = cancellation["text"][:start] + cancellation["text"][stop:]
    web.pages[URL] = _replacement_page(cancellation)
    report = _refresh(published, NOW + timedelta(minutes=31))
    assert report["sources"]["nga:12"]["error"] == "NGA_ROW"
    _assert_retained(published, report, state["sources"]["nga:12"])


def test_cancellation_requires_an_exact_notice_identity(published) -> None:
    web, _, _, _, _, state, *_ = published
    web.pages[URL] = _replacement_page(_cancellation_row("8010/26"))
    report = _refresh(published, NOW + timedelta(minutes=31))
    assert report["sources"]["nga:12"]["error"] == "NGA_RELEVANCE_DOWNGRADE"
    _assert_retained(published, report, state["sources"]["nga:12"])


@pytest.mark.parametrize("clause", (
    "2. CANCEL THIS MSG 140000Z NOV 26.\n",
    "2. CANCEL NAVAREA XII 801/26.\n",
))
def test_other_replacement_cannot_supply_expiry_or_cancellation(published, clause: str) -> None:
    web, _, _, _, _, state, *_ = published
    rows = json.loads(_other_page())["broadcast-warn"]
    rows[0]["text"] += clause
    web.pages[URL] = _payload(rows)
    report = _refresh(published, NOW + timedelta(minutes=31))
    assert report["sources"]["nga:12"]["error"] == "NGA_RELEVANCE_DOWNGRADE"
    _assert_retained(published, report, state["sources"]["nga:12"])


def _artifact_representation(bundle: dict, representation: str) -> None:
    original = next(
        row for launch in bundle["launches"] for row in launch["notices"]
        if row["notice_id"] == NOTICE_ID
    )
    if representation == "alias":
        for launch in bundle["launches"]:
            for row in launch["notices"]:
                if row["notice_id"] == NOTICE_ID:
                    row["notice_id"], row["also"] = CANCELLATION_ID, [NOTICE_ID]
            for feature in launch["geojson"]["features"]:
                if feature["properties"]["notice_id"] == NOTICE_ID:
                    feature["properties"]["notice_id"] = CANCELLATION_ID
    elif representation == "listed":
        bundle["launches"] = [{
            "event_id": fx.USSF_317,
            "notices": [],
            "geojson": {"type": "FeatureCollection", "features": []},
            "listed": [{
                key: original[key] for key in (
                    "authority", "notice_id", "checked_at", "valid_until", "source_url", "source_sha256",
                )
            } | {"reason": "not_drawn", "text": "Area A is not drawn."}],
        }]
    validate_bundle(bundle)


@pytest.mark.parametrize("representation", ("primary", "alias", "listed"))
@pytest.mark.parametrize("cache_condition", ("empty", "invalid"))
@pytest.mark.parametrize("lifecycle", ("unexpired", "expired", "cancelled"))
def test_artifact_lifecycle_recovers_after_cache_loss(
    published, representation: str, cache_condition: str, lifecycle: str,
) -> None:
    web, cache, output, _, uploads, state, artifact, receipt = published
    if cache_condition == "empty":
        state["sources"]["nga:12"]["notices"] = []
    else:
        state["sources"]["nga:12"]["notices"][0]["source_sha256"] = "invalid"
    (cache / STATE_NAME).write_text(json.dumps(state))
    bundle = json.loads(artifact)
    _artifact_representation(bundle, representation)
    retained = json.dumps(bundle).encode()
    (output / ARTIFACT).write_bytes(retained)
    web.pages[URL] = _replacement_page(_cancellation_row() if lifecycle == "cancelled" else None)
    now = EXPIRY if lifecycle == "expired" else NOW + timedelta(minutes=31)
    sources = refresh_sources(cache, now, fetch=web, pause=lambda _: None, last_good=output / ARTIFACT)
    expected = "NGA_RELEVANCE_DOWNGRADE" if lifecycle == "unexpired" else None
    assert sources["nga:12"]["error"] == expected
    if lifecycle != "unexpired":
        assert sources["nga:12"]["checked_at"] == utc(now)
        assert [row["notice_id"] for row in sources["nga:12"]["notices"]] == (
            [CANCELLATION_ID] if lifecycle == "cancelled" else []
        )
    assert (output / ARTIFACT).read_bytes() == retained
    assert (output / PUBLICATION_RECEIPT).read_bytes() == receipt
    assert uploads == [artifact]


@pytest.mark.parametrize(("cache_end", "artifact_end"), (
    (None, "expired"), ("future", "expired"), ("expired", "future"),
))
def test_any_trusted_live_evidence_preserves_downgrade_protection(
    published, cache_end: str | None, artifact_end: str,
) -> None:
    web, cache, output, _, _, state, artifact, _ = published
    ends = {"expired": utc(NOW), "future": utc(EXPIRY), None: None}
    state["sources"]["nga:12"]["notices"][0]["valid_until"] = ends[cache_end]
    (cache / STATE_NAME).write_text(json.dumps(state))
    bundle = json.loads(artifact)
    for launch in bundle["launches"]:
        for row in launch["notices"]:
            if row["notice_id"] == NOTICE_ID:
                row["valid_until"] = ends[artifact_end]
    validate_bundle(bundle)
    (output / ARTIFACT).write_text(json.dumps(bundle))
    web.pages[URL] = _other_page()
    report = _refresh(published, NOW + timedelta(minutes=31))
    assert report["sources"]["nga:12"]["error"] == "NGA_RELEVANCE_DOWNGRADE"
    assert not report["written"] and not report["published"]


def test_one_live_artifact_area_protects_all_exact_identity_evidence(published) -> None:
    web, cache, output, _, _, state, artifact, _ = published
    state["sources"]["nga:12"]["notices"] = []
    (cache / STATE_NAME).write_text(json.dumps(state))
    bundle = json.loads(artifact)
    rows = [row for launch in bundle["launches"] for row in launch["notices"] if row["notice_id"] == NOTICE_ID]
    assert len(rows) > 1
    for row in rows[1:]:
        row["valid_until"] = utc(NOW)
    validate_bundle(bundle)
    (output / ARTIFACT).write_text(json.dumps(bundle))
    web.pages[URL] = _other_page()
    report = _refresh(published, NOW + timedelta(minutes=31))
    assert report["sources"]["nga:12"]["error"] == "NGA_RELEVANCE_DOWNGRADE"
    assert not report["written"] and not report["published"]


def test_invalid_artifact_lifecycle_metadata_grants_no_identity(published) -> None:
    web, cache, output, _, _, state, artifact, _ = published
    state["sources"]["nga:12"]["notices"] = []
    (cache / STATE_NAME).write_text(json.dumps(state))
    bundle = json.loads(artifact)
    next(row for launch in bundle["launches"] for row in launch["notices"])["valid_until"] = "bad date"
    (output / ARTIFACT).write_text(json.dumps(bundle))
    web.pages[URL] = _other_page()
    sources = refresh_sources(
        cache, NOW + timedelta(minutes=31), fetch=web, pause=lambda _: None, last_good=output / ARTIFACT,
    )
    assert sources["nga:12"]["error"] is None and sources["nga:12"]["notices"] == []
