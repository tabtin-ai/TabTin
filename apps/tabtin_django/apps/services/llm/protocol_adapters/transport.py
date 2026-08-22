from contextlib import AbstractContextManager
from dataclasses import dataclass
from typing import Iterable, Protocol
from .contracts import PreparedProtocolRequest

@dataclass(frozen=True)
class UpstreamStreamResponse:
    status_code: int
    lines: Iterable[bytes]

class StreamingTransport(Protocol):
    def open_stream(self, request: PreparedProtocolRequest) -> AbstractContextManager[UpstreamStreamResponse]: ...

class TransportObserver(Protocol):
    def observe(self, event: str, *, fingerprint: str, status_code: int | None = None) -> None: ...

class NullTransportObserver:
    def observe(self, event: str, *, fingerprint: str, status_code: int | None = None) -> None: pass
