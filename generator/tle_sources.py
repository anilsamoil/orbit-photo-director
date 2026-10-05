from __future__ import annotations

import fcntl
import json
import logging
import os
import tempfile
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Generic, Protocol, TypeVar

import requests
import urllib3

log = logging.getLogger(__name__)

T = TypeVar("T")

_ANSWER_REST = timedelta(hours=2)
_FAILURE_RESTS = (timedelta(hours=2), timedelta(hours=4), timedelta(hours=8))
_READ_CHUNK_BYTES = 8192

Judge = Callable[[int, str], T]


@dataclass(frozen=True)
class Answered(Generic[T]):
    """The source replied 200 or 404 and ``judge`` accepted the body."""

    value: T


@dataclass(frozen=True)
class Failed:
    """This attempt failed. The failure is already counted in the ledger."""

    reason: str


@dataclass(frozen=True)
class Throttled:
    """The source answered less than 2 hours ago. Nothing was sent."""

    until: datetime


@dataclass(frozen=True)
class BackedOff:
    """The source failed recently. Nothing was sent."""

    until: datetime
    failures: int


@dataclass(frozen=True)
class _Record:
    attempted_at: datetime
    failures: int


class _Clock(Protocol):  # pragma: no cover
    def now(self) -> datetime: ...

    def monotonic(self) -> float: ...


class _Stream(Protocol):  # pragma: no cover
    @property
    def status(self) -> int: ...

    def read_some(self, timeout_s: float) -> bytes: ...

    def close(self) -> None: ...


class _SystemClock:
    def now(self) -> datetime:
        return datetime.now(UTC)

    def monotonic(self) -> float:
        return time.monotonic()


class _DeadlineError(TimeoutError):
    pass


class _RequestsStream:
    def __init__(self, response: requests.Response) -> None:
        self._response = response

    @property
    def status(self) -> int:
        return self._response.status_code

    def read_some(self, timeout_s: float) -> bytes:
        raw = self._response.raw
        connection = getattr(raw, "connection", None)
        sock = getattr(connection, "sock", None) if connection is not None else None
        if sock is not None:
            sock.settimeout(timeout_s)
        try:
            chunk = raw.read1(_READ_CHUNK_BYTES, decode_content=True)
        except urllib3.exceptions.ReadTimeoutError as exc:
            raise TimeoutError(str(exc)) from exc
        except urllib3.exceptions.HTTPError as exc:
            raise ConnectionError(str(exc)) from exc
        if not chunk:
            return b""
        return chunk

    def close(self) -> None:
        self._response.close()


def open_http(url: str, budget_s: float) -> _RequestsStream:
    response = requests.get(
        url,
        stream=True,
        timeout=urllib3.Timeout(total=budget_s),
        allow_redirects=False,
        headers={"Accept-Encoding": "identity"},
    )
    return _RequestsStream(response)


class TleSources:
    def __init__(
        self,
        cache_dir: Path,
        *,
        clock: _Clock | None = None,
        transport: Callable[[str, float], _Stream] | None = None,
    ) -> None:
        self._cache_dir = cache_dir
        self._ledger = cache_dir / "tle-sources.json"
        self._lock_path = cache_dir / "tle-sources.json.lock"
        self._clock = clock if clock is not None else _SystemClock()
        self._transport = transport if transport is not None else open_http

    def ask(
        self,
        url: str,
        judge: Judge[T],
        *,
        budget_s: float,
        lift_answer_rest: bool = False,
    ) -> Answered[T] | Failed | Throttled | BackedOff:
        stamp = self._reserve(url, lift_answer_rest=lift_answer_rest)
        if not isinstance(stamp, datetime):
            return stamp
        try:
            status, text = self._read(url, budget_s)
        except OSError as exc:
            return Failed(_reason(exc))
        if status not in (200, 404):
            return Failed(f"HTTP {status}")
        try:
            value = judge(status, text)
        except (ValueError, OSError) as exc:
            return Failed(_reason(exc))
        self._settle(url, stamp)
        return Answered(value)

    def _reserve(self, url: str, *, lift_answer_rest: bool) -> datetime | Throttled | BackedOff:
        with self._locked():
            now = _as_utc(self._clock.now())
            records = self._load()
            record = records.get(url)
            resting = _rest(record, now)
            if isinstance(resting, BackedOff):
                return resting
            if isinstance(resting, Throttled) and not lift_answer_rest:
                return resting
            previous = record.failures if record is not None else 0
            records[url] = _Record(attempted_at=now, failures=previous + 1)
            self._save(records)
            return now

    def _settle(self, url: str, stamp: datetime) -> None:
        with self._locked():
            records = self._load()
            current = records.get(url)
            if current is not None and current.attempted_at == stamp:
                records[url] = _Record(attempted_at=stamp, failures=0)
                self._save(records)

    def _read(self, url: str, budget_s: float) -> tuple[int, str]:
        deadline = self._clock.monotonic() + budget_s
        stream = self._transport(url, budget_s)
        try:
            status = stream.status
            if status not in (200, 404):
                return status, ""
            body = bytearray()
            while True:
                left = deadline - self._clock.monotonic()
                if left <= 0:
                    raise _DeadlineError(_deadline_message(budget_s, len(body)))
                try:
                    chunk = stream.read_some(left)
                except TimeoutError as exc:
                    if deadline - self._clock.monotonic() <= 0:
                        raise _DeadlineError(_deadline_message(budget_s, len(body))) from exc
                    raise
                if not chunk:
                    return status, bytes(body).decode("utf-8", errors="replace")
                body.extend(chunk)
        finally:
            stream.close()

    @contextmanager
    def _locked(self) -> Iterator[None]:
        self._cache_dir.mkdir(parents=True, exist_ok=True)
        handle = open(self._lock_path, "a+")
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            handle.close()

    def _load(self) -> dict[str, _Record]:
        try:
            text = self._ledger.read_text()
        except FileNotFoundError:
            return {}
        except OSError as exc:
            _warn_unreadable(self._ledger, exc)
            return {}
        try:
            raw = json.loads(text)
        except json.JSONDecodeError as exc:
            _warn_unreadable(self._ledger, exc)
            return {}
        sources = raw.get("sources") if isinstance(raw, dict) else None
        if not isinstance(sources, dict):
            _warn_unreadable(self._ledger, ValueError("invalid ledger"))
            return {}
        records: dict[str, _Record] = {}
        for url, item in sources.items():
            parsed = _parse_row(item)
            if isinstance(url, str) and parsed is not None:
                records[url] = parsed
        return records

    def _save(self, records: dict[str, _Record]) -> None:
        try:
            _atomic_write(self._ledger, _encode(records))
        except OSError as exc:
            log.warning(
                "TLE source ledger %s not saved (%s); the source may be asked again",
                self._ledger,
                exc,
            )


def _deadline_message(budget_s: float, nbytes: int) -> str:
    return f"whole-request deadline {budget_s:g}s passed after {nbytes} bytes"


def _reason(exc: BaseException) -> str:
    text = str(exc).strip()
    return text or type(exc).__name__


def _as_utc(moment: datetime) -> datetime:
    if moment.tzinfo is None or moment.tzinfo.utcoffset(moment) is None:
        return moment.replace(tzinfo=UTC)
    return moment.astimezone(UTC)


def _rest(record: _Record | None, now: datetime) -> Throttled | BackedOff | None:
    if record is None:
        return None
    since = min(record.attempted_at, now)
    if record.failures == 0:
        until = since + _ANSWER_REST
        if now < until:
            return Throttled(until)
        return None
    index = min(record.failures, len(_FAILURE_RESTS)) - 1
    until = since + _FAILURE_RESTS[index]
    if now < until:
        return BackedOff(until, record.failures)
    return None


def _parse_row(item: object) -> _Record | None:
    if not isinstance(item, dict):
        return None
    raw_stamp = item.get("attempted_at")
    failures = item.get("failures")
    if not isinstance(raw_stamp, str):
        return None
    if isinstance(failures, bool) or not isinstance(failures, int) or failures < 0:
        return None
    try:
        stamp = datetime.fromisoformat(raw_stamp)
    except ValueError:
        return None
    if stamp.tzinfo is None or stamp.tzinfo.utcoffset(stamp) is None:
        return None
    return _Record(attempted_at=_as_utc(stamp), failures=failures)


def _encode(records: dict[str, _Record]) -> str:
    payload = {
        "version": 1,
        "sources": {
            url: {
                "attempted_at": record.attempted_at.isoformat(),
                "failures": record.failures,
            }
            for url, record in sorted(records.items())
        },
    }
    return json.dumps(payload, indent=2) + "\n"


def _warn_unreadable(path: Path, exc: BaseException) -> None:
    log.warning("TLE source ledger %s unreadable (%s); treating it as empty", path, exc)


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=".tle-sources.", suffix=".tmp")
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_path, path)
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise
