"""Catalog ownership reads are bounded and fail closed without network access."""

import json
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from generator.launch_publish import rclone_catalog_reader


@pytest.fixture
def catalog_pointer():
    revision = "a" * 24
    return {
        "schema_version": 2,
        "revision": revision,
        "generated_at": "2026-10-10T08:00:00Z",
        "valid_until": "2026-10-10T08:15:00Z",
        "path": f"launch/catalog/v/{revision}.json",
        "sha256": "b" * 64,
    }


def _reader(monkeypatch, *, body=b"", error=None):
    monkeypatch.setattr("generator.launch_publish.shutil.which", lambda _name: "/usr/bin/rclone")
    command = Mock(return_value=SimpleNamespace(stdout=body), side_effect=error)
    monkeypatch.setattr("generator.launch_publish._rclone", command)
    return rclone_catalog_reader("test:bucket/"), command


def test_catalog_reader_reads_only_bounded_commit_token(monkeypatch, catalog_pointer):
    body = json.dumps(catalog_pointer).encode().ljust(4096, b" ")
    reader, command = _reader(monkeypatch, body=body)

    assert reader() == catalog_pointer
    command.assert_called_once_with(
        ["/usr/bin/rclone", "cat", "test:bucket/launch/catalog/latest.json", "--count", "4097"],
        45,
    )


@pytest.mark.parametrize("code", [3, 4])
def test_catalog_reader_accepts_confirmed_missing_object(monkeypatch, code):
    reader, _ = _reader(monkeypatch, error=ValueError(f"RCLONE_EXIT_{code}: object not found"))

    assert reader() is None


@pytest.mark.parametrize("reason", ["RCLONE_EXIT_1: unavailable", "RCLONE_EXIT_5: denied",
                                   "RCLONE_TIMEOUT: timed out"])
def test_catalog_reader_does_not_treat_transport_errors_as_absence(monkeypatch, reason):
    reader, _ = _reader(monkeypatch, error=ValueError(reason))

    with pytest.raises(ValueError, match=reason):
        reader()


@pytest.mark.parametrize("body", [b"", b"{", b"null", b"[]", b"{}", b"\xff"])
def test_catalog_reader_rejects_malformed_pointer(monkeypatch, body):
    reader, _ = _reader(monkeypatch, body=body)

    with pytest.raises(ValueError):
        reader()


def test_catalog_reader_rejects_oversized_pointer(monkeypatch, catalog_pointer):
    reader, _ = _reader(monkeypatch, body=json.dumps(catalog_pointer).encode().ljust(4097, b" "))

    with pytest.raises(ValueError, match="REMOTE_LAUNCH_CATALOG_TOO_LARGE"):
        reader()


@pytest.mark.parametrize(("field", "value"), [
    ("schema_version", 3),
    ("revision", "A" * 24),
    ("revision", 1),
    ("path", "launch/v/" + "a" * 24 + ".json"),
    ("path", "launch/catalog/v/../../latest.json"),
    ("sha256", "b" * 63),
    ("sha256", "g" * 64),
    ("sha256", None),
    ("generated_at", "not a timestamp"),
    ("valid_until", None),
    ("valid_until", "2026-10-10T08:00:00Z"),
    ("valid_until", "2026-10-10T07:59:59Z"),
    ("extra", "unexpected"),
])
def test_catalog_reader_rejects_invalid_commit_fields(monkeypatch, catalog_pointer, field, value):
    reader, _ = _reader(monkeypatch, body=json.dumps({**catalog_pointer, field: value}).encode())

    with pytest.raises(ValueError):
        reader()
