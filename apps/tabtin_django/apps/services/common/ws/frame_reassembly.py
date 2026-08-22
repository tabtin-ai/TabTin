"""Connection-local reassembly for oversized WebSocket envelopes."""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

from django.conf import settings


FRAME_FRAGMENT_TYPE = "frame_fragment"
FRAME_FRAGMENT_ENCODING = "base64"
FRAME_FRAGMENT_TRANSPORT_CAPABILITY = "frame_fragment.v1.c2s"

MAX_FRAGMENT_COUNT = int(getattr(settings, "WS_FRAGMENT_MAX_COUNT", 64))
MAX_REASSEMBLED_FRAME_BYTES = int(
    getattr(settings, "WS_FRAGMENT_MAX_REASSEMBLED_BYTES", 32_000_000)
)
MAX_BUFFERED_FRAGMENT_BYTES = int(
    getattr(settings, "WS_FRAGMENT_MAX_BUFFERED_BYTES", 64_000_000)
)
MAX_BUFFERED_FRAMES = int(getattr(settings, "WS_FRAGMENT_MAX_BUFFERED_FRAMES", 8))
FRAGMENT_TTL_SECONDS = int(getattr(settings, "WS_FRAGMENT_TTL_SECONDS", 60))
MAX_COMPLETED_FRAME_IDS = int(getattr(settings, "WS_FRAGMENT_MAX_COMPLETED_IDS", 128))
MAX_PROCESS_BUFFERED_FRAGMENT_BYTES = int(
    getattr(settings, "WS_FRAGMENT_MAX_PROCESS_BUFFERED_BYTES", 256_000_000)
)

_process_budget_lock = threading.Lock()
_process_buffered_fragment_bytes = 0

_FRAME_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
_SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")


class FrameFragmentError(ValueError):
    """A fragment cannot safely participate in reassembly."""


@dataclass(frozen=True)
class ReassembledEnvelope:
    envelope: Dict[str, Any]
    received_at: float
    total_bytes: int


@dataclass
class _PendingFrame:
    original_request_id: str
    original_type: str
    count: int
    total_bytes: int
    sha256: str
    first_received_at: float
    expires_at: float
    fragments: Dict[int, bytes] = field(default_factory=dict)
    buffered_bytes: int = 0


class FrameFragmentReassembler:
    """Bounded, idempotent fragment cache owned by one WS connection."""

    def __init__(self) -> None:
        self._pending: "OrderedDict[str, _PendingFrame]" = OrderedDict()
        self._completed: "OrderedDict[str, tuple[float, str, str, int, int, str]]" = OrderedDict()
        self._buffered_bytes = 0

    def add(
        self,
        payload: Dict[str, Any],
        *,
        received_at: Optional[float] = None,
        decoded: Optional[tuple[Dict[str, Any], bytes]] = None,
    ) -> Optional[ReassembledEnvelope]:
        now = received_at if received_at is not None else time.time()
        self._purge_expired(now)

        metadata, fragment = decoded if decoded is not None else self.decode_payload(payload)
        frame_id = metadata["frame_id"]

        completed = self._completed.get(frame_id)
        if completed is not None:
            _, request_id, message_type, count, total_bytes, checksum = completed
            if (
                request_id != metadata["original_request_id"]
                or message_type != metadata["original_type"]
                or count != metadata["count"]
                or total_bytes != metadata["total_bytes"]
                or checksum != metadata["sha256"]
            ):
                raise FrameFragmentError("completed frame_id reused with conflicting metadata")
            self._completed.move_to_end(frame_id)
            return None

        pending = self._pending.get(frame_id)
        if pending is None:
            if len(self._pending) >= MAX_BUFFERED_FRAMES:
                raise FrameFragmentError("too many fragmented frames in progress")
            pending = _PendingFrame(
                original_request_id=metadata["original_request_id"],
                original_type=metadata["original_type"],
                count=metadata["count"],
                total_bytes=metadata["total_bytes"],
                sha256=metadata["sha256"],
                first_received_at=now,
                expires_at=now + FRAGMENT_TTL_SECONDS,
            )
            self._pending[frame_id] = pending
        elif not self._metadata_matches(pending, metadata):
            self._discard(frame_id)
            raise FrameFragmentError("fragment metadata conflicts with buffered frame")

        existing = pending.fragments.get(metadata["index"])
        if existing is not None:
            if existing != fragment:
                self._discard(frame_id)
                raise FrameFragmentError("duplicate fragment content conflicts")
            return None

        if self._buffered_bytes + len(fragment) > MAX_BUFFERED_FRAGMENT_BYTES:
            self._discard(frame_id)
            raise FrameFragmentError("fragment buffer size limit exceeded")
        if pending.buffered_bytes + len(fragment) > pending.total_bytes:
            self._discard(frame_id)
            raise FrameFragmentError("fragments exceed declared frame size")
        if not _reserve_process_fragment_bytes(len(fragment)):
            self._discard(frame_id)
            raise FrameFragmentError("process fragment buffer size limit exceeded")

        pending.fragments[metadata["index"]] = fragment
        pending.buffered_bytes += len(fragment)
        self._buffered_bytes += len(fragment)
        self._pending.move_to_end(frame_id)

        if len(pending.fragments) != pending.count:
            return None

        raw = b"".join(pending.fragments[index] for index in range(pending.count))
        first_received_at = pending.first_received_at
        self._discard(frame_id)

        if len(raw) != pending.total_bytes:
            raise FrameFragmentError("reassembled frame size mismatch")
        if hashlib.sha256(raw).hexdigest() != pending.sha256:
            raise FrameFragmentError("reassembled frame checksum mismatch")

        try:
            envelope = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise FrameFragmentError("reassembled frame is not valid UTF-8 JSON") from exc
        if not isinstance(envelope, dict):
            raise FrameFragmentError("reassembled envelope must be an object")
        if envelope.get("request_id") != pending.original_request_id:
            raise FrameFragmentError("reassembled request_id does not match fragment metadata")
        if envelope.get("type") != pending.original_type:
            raise FrameFragmentError("reassembled type does not match fragment metadata")
        if envelope.get("type") == FRAME_FRAGMENT_TYPE:
            raise FrameFragmentError("nested fragmented frames are not supported")

        self._completed[frame_id] = (
            now + FRAGMENT_TTL_SECONDS,
            pending.original_request_id,
            pending.original_type,
            pending.count,
            pending.total_bytes,
            pending.sha256,
        )
        self._completed.move_to_end(frame_id)
        while len(self._completed) > MAX_COMPLETED_FRAME_IDS:
            self._completed.popitem(last=False)

        return ReassembledEnvelope(envelope, first_received_at, len(raw))

    def clear(self) -> None:
        """Release all connection-owned fragment state on disconnect."""
        for frame_id in list(self._pending):
            self._discard(frame_id)
        self._completed.clear()

    def abort(self, frame_id: Any) -> None:
        """Discard one logical assembly after a transport-level rejection."""
        if isinstance(frame_id, str):
            self._discard(frame_id)

    def purge_expired(self, now: Optional[float] = None) -> None:
        """Expire idle assemblies without requiring another fragment arrival."""
        self._purge_expired(now if now is not None else time.time())

    def next_pending_expiry_at(self) -> Optional[float]:
        if not self._pending:
            return None
        return min(pending.expires_at for pending in self._pending.values())

    @staticmethod
    def decode_payload(payload: Dict[str, Any]) -> tuple[Dict[str, Any], bytes]:
        """Validate fragment metadata and decode its physical payload."""
        if not isinstance(payload, dict):
            raise FrameFragmentError("fragment payload must be an object")

        frame_id = payload.get("frame_id")
        original_request_id = payload.get("original_request_id")
        original_type = payload.get("original_type")
        index = payload.get("index")
        count = payload.get("count")
        total_bytes = payload.get("total_bytes")
        sha256 = payload.get("sha256")
        encoding = payload.get("encoding")
        data = payload.get("data")

        if not isinstance(frame_id, str) or not _FRAME_ID_PATTERN.fullmatch(frame_id):
            raise FrameFragmentError("invalid frame_id")
        if not isinstance(original_request_id, str) or not 0 < len(original_request_id) <= 128:
            raise FrameFragmentError("invalid original_request_id")
        if not isinstance(original_type, str) or not 0 < len(original_type) <= 128:
            raise FrameFragmentError("invalid original_type")
        if isinstance(index, bool) or not isinstance(index, int):
            raise FrameFragmentError("invalid fragment index")
        if isinstance(count, bool) or not isinstance(count, int) or not 1 < count <= MAX_FRAGMENT_COUNT:
            raise FrameFragmentError("invalid fragment count")
        if index < 0 or index >= count:
            raise FrameFragmentError("fragment index out of range")
        if (
            isinstance(total_bytes, bool)
            or not isinstance(total_bytes, int)
            or total_bytes <= 0
            or total_bytes > MAX_REASSEMBLED_FRAME_BYTES
        ):
            raise FrameFragmentError("invalid reassembled frame size")
        if not isinstance(sha256, str) or not _SHA256_PATTERN.fullmatch(sha256):
            raise FrameFragmentError("invalid sha256")
        if encoding != FRAME_FRAGMENT_ENCODING:
            raise FrameFragmentError("unsupported fragment encoding")
        if not isinstance(data, str) or not data:
            raise FrameFragmentError("invalid fragment data")
        try:
            fragment = base64.b64decode(data, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise FrameFragmentError("invalid base64 fragment data") from exc
        if not fragment or len(fragment) > total_bytes:
            raise FrameFragmentError("invalid decoded fragment size")

        return {
            "frame_id": frame_id,
            "original_request_id": original_request_id,
            "original_type": original_type,
            "index": index,
            "count": count,
            "total_bytes": total_bytes,
            "sha256": sha256,
        }, fragment

    @staticmethod
    def _metadata_matches(pending: _PendingFrame, metadata: Dict[str, Any]) -> bool:
        return (
            pending.original_request_id == metadata["original_request_id"]
            and pending.original_type == metadata["original_type"]
            and pending.count == metadata["count"]
            and pending.total_bytes == metadata["total_bytes"]
            and pending.sha256 == metadata["sha256"]
        )

    def _discard(self, frame_id: str) -> None:
        pending = self._pending.pop(frame_id, None)
        if pending is not None:
            self._buffered_bytes -= pending.buffered_bytes
            _release_process_fragment_bytes(pending.buffered_bytes)

    def _purge_expired(self, now: float) -> None:
        for frame_id, pending in list(self._pending.items()):
            if pending.expires_at <= now:
                self._discard(frame_id)
        for frame_id, completed in list(self._completed.items()):
            expires_at = completed[0]
            if expires_at <= now:
                self._completed.pop(frame_id, None)


def _reserve_process_fragment_bytes(size: int) -> bool:
    global _process_buffered_fragment_bytes
    with _process_budget_lock:
        if _process_buffered_fragment_bytes + size > MAX_PROCESS_BUFFERED_FRAGMENT_BYTES:
            return False
        _process_buffered_fragment_bytes += size
        return True


def _release_process_fragment_bytes(size: int) -> None:
    global _process_buffered_fragment_bytes
    with _process_budget_lock:
        _process_buffered_fragment_bytes = max(0, _process_buffered_fragment_bytes - size)


def process_buffered_fragment_bytes() -> int:
    """Return the process-wide fragment reservation total."""
    with _process_budget_lock:
        return _process_buffered_fragment_bytes
