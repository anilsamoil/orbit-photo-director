from __future__ import annotations

from datetime import datetime, timedelta


class FakeClock:
    def __init__(self, start: datetime) -> None:
        self._wall = start
        self._mono = 0.0

    def now(self) -> datetime:
        return self._wall

    def monotonic(self) -> float:
        return self._mono

    def advance(self, seconds: float) -> None:
        self._wall += timedelta(seconds=seconds)
        self._mono += seconds


class TextStream:
    def __init__(self, text: str, status: int = 200) -> None:
        self.status = status
        self._payload = text.encode()
        self._sent = False

    def read_some(self, timeout_s: float) -> bytes:
        del timeout_s
        if self._sent:
            return b""
        self._sent = True
        return self._payload

    def close(self) -> None:
        return None


class TrickleStream:
    def __init__(
        self,
        body: bytes,
        clock: FakeClock,
        *,
        chunk: int,
        gap_s: float,
        status: int = 200,
    ) -> None:
        self.status = status
        self._body = body
        self._clock = clock
        self._chunk = chunk
        self._gap_s = gap_s
        self._offset = 0

    @property
    def unread(self) -> int:
        return len(self._body) - self._offset

    def read_some(self, timeout_s: float) -> bytes:
        if self._offset >= len(self._body):
            return b""
        if timeout_s <= 0 or self._gap_s > timeout_s:
            self._clock.advance(max(timeout_s, 0.0))
            raise TimeoutError("read timed out")
        self._clock.advance(self._gap_s)
        end = min(self._offset + self._chunk, len(self._body))
        chunk = self._body[self._offset:end]
        self._offset = end
        return chunk

    def close(self) -> None:
        return None
