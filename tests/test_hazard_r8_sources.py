from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from pathlib import Path

import pytest

from generator.hazard_match import validate_bundle
from generator.hazard_notices import Notice, notice_record, parse_nga_payload
from generator.hazard_sources import NGA_URL, STATE_NAME, SourceError
from generator.launch_evidence import canonical_bytes, utc
from scripts.hazard_refresh import ARTIFACT, PUBLICATION_RECEIPT, PublicationTarget, refresh_hazards
from tests.test_hazard_r6_sources import URL, _other_page, _page
from tests.test_hazard_r7_sources import EXPIRY, _renew_catalog
from tests.test_hazard_refresh import NOW, Web, _output
from tests.test_hazard_relevance import _payload

PRIMARY = "NAVAREA XII 1801/26"
ALIAS = "NAVAREA XII 2801/26"
CANCELLATION = "NAVAREA XII 3801/26"


@dataclass(frozen=True)
class _Published:
    web: Web
    cache: Path
    output: Path
    publication: PublicationTarget
    uploads: list[bytes]
    artifact: bytes
    receipt: bytes


def _notice_row(number: int, expiry_day: int, target: str = "785/26") -> dict:
    row = json.loads(_page())["broadcast-warn"][0]
    row["msgNumber"] = number
    row["text"] = row["text"].replace("240734Z NOV 26", f"{expiry_day}0734Z NOV 26")
    row["text"] = row["text"].replace("785/26", target)
    return row


def _pair(primary_day: int) -> list[dict]:
    alias_day = 25 if primary_day == 24 else 24
    rows = [_notice_row(1801, primary_day), _notice_row(2801, alias_day)]
    notices = parse_nga_payload(_payload(rows), URL)
    assert [notice.notice_id for notice in notices] == [PRIMARY, ALIAS]
    assert not any(notice.problems for notice in notices)
    assert notices[0].areas == notices[1].areas
    assert notices[0].cancels == notices[1].cancels
    assert [notice.valid_until for notice in notices] == [
        EXPIRY.replace(day=primary_day), EXPIRY.replace(day=alias_day),
    ]
    return rows


def _start(
    tmp_path: Path, rows: list[dict], *, other_pages: dict[str, bytes] | None = None,
) -> _Published:
    web = Web(complete=True)
    web.pages[URL] = _payload(rows)
    web.pages.update(other_pages or {})
    cache, output = tmp_path / "cache", _output(tmp_path)
    uploads: list[bytes] = []
    publication = PublicationTarget("offline:test", lambda path, *_: uploads.append(path.read_bytes()))
    report = refresh_hazards(
        cache, output, NOW, fetch=web, pause=lambda _: None, publication=publication,
    )
    artifact, receipt = (output / ARTIFACT).read_bytes(), (output / PUBLICATION_RECEIPT).read_bytes()
    assert report["ok"] and report["published"] and uploads == [artifact]
    assert json.loads((cache / STATE_NAME).read_bytes())["schema_version"] == 5
    return _Published(web, cache, output, publication, uploads, artifact, receipt)


def _refresh(published: _Published, now: datetime = EXPIRY) -> dict:
    _renew_catalog(published.output, now)
    return refresh_hazards(
        published.cache, published.output, now, fetch=published.web, pause=lambda _: None,
        publication=published.publication,
    )


def _other_alias() -> dict:
    row = json.loads(_other_page())["broadcast-warn"][0]
    row["msgNumber"] = 2801
    assert not parse_nga_payload(_payload([row]), URL)[0].problems
    assert parse_nga_payload(_payload([row]), URL)[0].kind == "other"
    return row


def _damage_cache(published: _Published, condition: str) -> None:
    if condition == "lost":
        (published.cache / STATE_NAME).unlink()
        return
    state = json.loads((published.cache / STATE_NAME).read_bytes())
    notices = state["sources"]["nga:12"]["notices"]
    if condition == "invalid":
        notices[1]["source_sha256"] = "invalid"
    (published.cache / STATE_NAME).write_bytes(canonical_bytes(state))


def _assert_retained(published: _Published, report: dict | None) -> None:
    state = json.loads((published.cache / STATE_NAME).read_bytes())
    assert state["sources"]["nga:12"]["error"] == "NGA_RELEVANCE_DOWNGRADE"
    if report is not None:
        assert not report["ok"] and report["degraded"]
        assert not report["written"] and not report["published"]
    assert (published.output / ARTIFACT).read_bytes() == published.artifact
    assert (published.output / PUBLICATION_RECEIPT).read_bytes() == published.receipt
    assert published.uploads == [published.artifact]


def _assert_released(published: _Published, report: dict, expected_ids: list[str]) -> None:
    state = json.loads((published.cache / STATE_NAME).read_bytes())
    assert state["schema_version"] == 5
    assert [row["notice_id"] for row in state["sources"]["nga:12"]["notices"]] == expected_ids
    assert report["sources"]["nga:12"]["error"] is None
    assert report["ok"] and not report["degraded"]
    assert report["written"] and report["published"]
    artifact = (published.output / ARTIFACT).read_bytes()
    assert artifact != published.artifact and json.loads(artifact)["launches"] == []
    assert published.uploads == [published.artifact, artifact]
    assert (published.output / PUBLICATION_RECEIPT).read_bytes() != published.receipt


def _drawn(published: _Published) -> list[dict]:
    return [
        row for launch in json.loads(published.artifact)["launches"]
        for row in launch["notices"] if row["authority"] == "NGA"
    ]


def _legacy_alias(published: _Published, *, generated_at: datetime = NOW) -> _Published:
    bundle = json.loads(published.artifact)
    bundle["generated_at"] = utc(generated_at)
    for launch in bundle["launches"]:
        launch["notices"] = [row for row in launch["notices"] if row["notice_id"] != ALIAS]
        for row in launch["notices"]:
            if row["notice_id"] == PRIMARY:
                row["also"] = [ALIAS]
        launch["geojson"]["features"] = [
            feature for feature in launch["geojson"]["features"]
            if feature["properties"]["notice_id"] != ALIAS
        ]
    bundle["revision"] = hashlib.sha256(canonical_bytes({
        key: value for key, value in bundle.items() if key not in {"revision", "generated_at"}
    })).hexdigest()[:16]
    validate_bundle(bundle)
    artifact = canonical_bytes(bundle)
    receipt = json.loads(published.receipt) | {"revision": bundle["revision"]}
    (published.output / ARTIFACT).write_bytes(artifact)
    (published.output / PUBLICATION_RECEIPT).write_bytes(canonical_bytes(receipt))
    published.uploads[:] = [artifact]
    return replace(published, artifact=artifact, receipt=canonical_bytes(receipt))


@pytest.mark.parametrize("primary_day", (24, 25))
@pytest.mark.parametrize("cache_condition", ("intact", "lost"))
def test_each_nga_identity_keeps_its_expiry_through_warm_publication(
    tmp_path: Path, primary_day: int, cache_condition: str,
) -> None:
    published = _start(tmp_path, _pair(primary_day))
    _damage_cache(published, cache_condition)
    published.web.pages[URL] = _payload([_other_alias()])
    report = None
    if primary_day == 24 and cache_condition == "lost":
        with pytest.raises(SourceError, match="SOURCE_STATE_INCOMPLETE"):
            _refresh(published)
    else:
        report = _refresh(published)
    if primary_day == 25:
        _assert_released(published, report, [])
    else:
        _assert_retained(published, report)


def test_same_area_with_distinct_expiries_keeps_both_notice_lifecycles(tmp_path: Path) -> None:
    published = _start(tmp_path, _pair(24))
    drawn = _drawn(published)
    assert {row["notice_id"]: row["valid_until"] for row in drawn} == {
        PRIMARY: utc(EXPIRY), ALIAS: utc(EXPIRY + timedelta(days=1)),
    }
    assert not any(row["also"] for row in drawn)


def test_equal_expiry_duplicates_still_deduplicate(tmp_path: Path) -> None:
    published = _start(tmp_path, [_notice_row(1801, 25), _notice_row(2801, 25)])
    drawn = _drawn(published)
    assert len(drawn) == 3
    assert {row["notice_id"] for row in drawn} == {PRIMARY}
    assert all(row["also"] == [ALIAS] for row in drawn)


def test_different_cancellation_targets_keep_notice_identities_separate(tmp_path: Path) -> None:
    rows = [_notice_row(1801, 25), _notice_row(2801, 25, "786/26")]
    notices: list[Notice] = parse_nga_payload(_payload(rows), URL)
    assert not any(notice.problems for notice in notices)
    assert [notice.cancels for notice in notices] == [
        ("NAVAREA XII 785/26",), ("NAVAREA XII 786/26",),
    ]
    drawn = _drawn(_start(tmp_path, rows))
    assert {row["notice_id"] for row in drawn} == {PRIMARY, ALIAS}
    assert not any(row["also"] for row in drawn)


@pytest.mark.parametrize("target", ("1801/26", "2801/26"))
def test_incoming_cancellation_never_becomes_an_alias_of_the_surviving_identity(
    tmp_path: Path, target: str,
) -> None:
    rows = [_notice_row(1801, 25), _notice_row(2801, 25), _notice_row(3801, 25, target)]
    notices = parse_nga_payload(_payload(rows), URL)
    assert not any(notice.problems for notice in notices)
    drawn = _drawn(_start(tmp_path, rows))
    survivor = ALIAS if target == "1801/26" else PRIMARY
    assert {row["notice_id"] for row in drawn} == {survivor, CANCELLATION}
    assert not any(row["also"] for row in drawn)


@pytest.mark.parametrize("primary_day", (24, 25))
def test_legacy_alias_uses_its_own_validated_cached_expiry(
    tmp_path: Path, primary_day: int,
) -> None:
    published = _legacy_alias(_start(tmp_path, _pair(primary_day)))
    published.web.pages[URL] = _payload([_other_alias()])
    report = _refresh(published)
    if primary_day == 25:
        _assert_released(published, report, [])
    else:
        _assert_retained(published, report)


@pytest.mark.parametrize("offset_minutes", (-1, 0, 1))
def test_legacy_alias_requires_matching_or_newer_own_cache_evidence(
    tmp_path: Path, offset_minutes: int,
) -> None:
    published = _legacy_alias(_start(tmp_path, _pair(24)))
    state = json.loads((published.cache / STATE_NAME).read_bytes())
    source = state["sources"]["nga:12"]
    notices = parse_nga_payload(_payload([_notice_row(1801, 24), _notice_row(2801, 24)]), URL)
    assert not any(notice.problems for notice in notices)
    assert notices[1].source_sha256 != source["notices"][1]["source_sha256"]
    source["notices"] = [notice_record(notice) for notice in notices]
    source["checked_at"] = source["attempted_at"] = utc(NOW + timedelta(minutes=offset_minutes))
    (published.cache / STATE_NAME).write_bytes(canonical_bytes(state))
    published.web.pages[URL] = _payload([_other_alias()])
    report = _refresh(published)
    if offset_minutes > 0:
        _assert_released(published, report, [])
    else:
        _assert_retained(published, report)


def test_legacy_alias_matching_snapshot_can_establish_expiry_from_older_cache(tmp_path: Path) -> None:
    published = _legacy_alias(_start(tmp_path, _pair(25)))
    state = json.loads((published.cache / STATE_NAME).read_bytes())
    source = state["sources"]["nga:12"]
    source["checked_at"] = source["attempted_at"] = utc(NOW - timedelta(minutes=1))
    (published.cache / STATE_NAME).write_bytes(canonical_bytes(state))
    published.web.pages[URL] = _payload([_other_alias()])
    _assert_released(published, _refresh(published), [])


def test_legacy_alias_changed_cache_between_carrier_check_and_generation_stays_protected(
    tmp_path: Path,
) -> None:
    published = _legacy_alias(_start(tmp_path, _pair(24)), generated_at=NOW + timedelta(minutes=2))
    state = json.loads((published.cache / STATE_NAME).read_bytes())
    source = state["sources"]["nga:12"]
    notices = parse_nga_payload(_payload([_notice_row(1801, 24), _notice_row(2801, 24)]), URL)
    assert not any(notice.problems for notice in notices)
    assert notices[1].source_sha256 != source["notices"][1]["source_sha256"]
    source["notices"] = [notice_record(notice) for notice in notices]
    source["checked_at"] = source["attempted_at"] = utc(NOW + timedelta(minutes=1))
    (published.cache / STATE_NAME).write_bytes(canonical_bytes(state))
    carrier = next(row for row in _drawn(published) if row["notice_id"] == PRIMARY)
    assert carrier["checked_at"] < source["checked_at"] < json.loads(published.artifact)["generated_at"]
    published.web.pages[URL] = _payload([_other_alias()])
    _assert_retained(published, _refresh(published))


@pytest.mark.parametrize("offset_minutes", (-1, 0, 1))
def test_cross_feed_alias_with_equal_hash_requires_a_newer_own_observation(
    tmp_path: Path, offset_minutes: int,
) -> None:
    carrier_url = NGA_URL.format(area="4")
    carrier_row = _notice_row(1801, 25) | {"navArea": "4"}
    published = _start(
        tmp_path, [_notice_row(2801, 25)], other_pages={carrier_url: _payload([carrier_row])},
    )
    drawn = _drawn(published)
    assert {row["notice_id"] for row in drawn} == {"NAVAREA IV 1801/26"}
    assert all(row["also"] == [ALIAS] and row["source_url"] == carrier_url for row in drawn)
    own = parse_nga_payload(_payload([_notice_row(2801, 24)]), URL)[0]
    assert not own.problems and own.valid_until == EXPIRY
    own = replace(own, source_sha256=drawn[0]["source_sha256"])
    assert own.source_url != drawn[0]["source_url"]
    state = json.loads((published.cache / STATE_NAME).read_bytes())
    source = state["sources"]["nga:12"]
    source["notices"] = [notice_record(own)]
    source["checked_at"] = source["attempted_at"] = utc(NOW + timedelta(minutes=offset_minutes))
    (published.cache / STATE_NAME).write_bytes(canonical_bytes(state))
    published.web.pages[URL] = _payload([_other_alias()])
    report = _refresh(published)
    if offset_minutes > 0:
        _assert_released(published, report, [])
    else:
        _assert_retained(published, report)


@pytest.mark.parametrize("cache_condition", ("lost", "invalid"))
@pytest.mark.parametrize("release", ("none", "validated_cancellation"))
def test_legacy_ambiguous_alias_without_cache_requires_its_own_release(
    tmp_path: Path, cache_condition: str, release: str,
) -> None:
    published = _legacy_alias(_start(tmp_path, _pair(24)))
    _damage_cache(published, cache_condition)
    rows = [_other_alias()]
    if release == "validated_cancellation":
        cancellation = _notice_row(3801, 25, "2801/26")
        notice = parse_nga_payload(_payload([cancellation]), URL)[0]
        assert notice.cancels == (ALIAS,) and not notice.problems
        rows.append(cancellation)
    published.web.pages[URL] = _payload(rows)
    report = None
    if release == "none":
        with pytest.raises(SourceError, match="SOURCE_STATE_INCOMPLETE"):
            _refresh(published)
    else:
        report = _refresh(published)
    if release == "validated_cancellation":
        _assert_released(published, report, [CANCELLATION])
    else:
        _assert_retained(published, report)
