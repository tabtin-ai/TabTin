from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import time
from unittest.mock import AsyncMock, MagicMock, patch

from asgiref.sync import async_to_sync

from apps.services.common.ws.gateway import GatewayConsumer
from apps.services.common.ws import gateway
from apps.services.common.ws.frame_reassembly import (
    FrameFragmentError,
    FrameFragmentReassembler,
    process_buffered_fragment_bytes,
)
from apps.services.common.ws import frame_reassembly
from apps.services.common.ws.protocol import PROTOCOL_VERSION, build_envelope


def _fragment_envelope(
    *,
    frame_id: str,
    index: int,
    count: int,
    raw_envelope: bytes,
    fragment: bytes,
) -> str:
    return json.dumps(
        {
            "v": PROTOCOL_VERSION,
            "type": "frame_fragment",
            "request_id": f"fragment-{index}",
            "ts": int(time.time()),
            "device_id": "electron-test",
            "role": "electron",
            "payload": {
                "frame_id": frame_id,
                "original_request_id": "logical-request",
                "original_type": "relay_events",
                "index": index,
                "count": count,
                "total_bytes": len(raw_envelope),
                "sha256": hashlib.sha256(raw_envelope).hexdigest(),
                "encoding": "base64",
                "data": base64.b64encode(fragment).decode("ascii"),
            },
        }
    )


def test_fragments_reassemble_into_the_existing_handler_once():
    consumer = GatewayConsumer()
    consumer.authed = True
    consumer._send_envelope = AsyncMock()

    async def relay_handler(envelope):
        await consumer._send_envelope(
            build_envelope("relay_events.ok", envelope["request_id"], {})
        )

    consumer._cached_handlers = {"relay_events": relay_handler}

    original = json.dumps(
        {
            "v": PROTOCOL_VERSION,
            "type": "relay_events",
            "request_id": "logical-request",
            "ts": int(time.time()),
            "device_id": "electron-test",
            "role": "electron",
            "payload": {"events": [{"text": "a" * 1024}]},
        },
        separators=(",", ":"),
    ).encode("utf-8")
    split_at = len(original) // 2
    fragments = [original[:split_at], original[split_at:]]

    async def exercise_gateway():
        await consumer.receive(
            text_data=_fragment_envelope(
                frame_id="frame-1",
                index=1,
                count=2,
                raw_envelope=original,
                fragment=fragments[1],
            )
        )
        await consumer.receive(
            text_data=_fragment_envelope(
                frame_id="frame-1",
                index=0,
                count=2,
                raw_envelope=original,
                fragment=fragments[0],
            )
        )

    asyncio.run(exercise_gateway())

    sent_types = [call.args[0]["type"] for call in consumer._send_envelope.await_args_list]
    assert sent_types == ["relay_events.ok"]
    assert consumer._send_envelope.await_args_list[-1].args[0]["request_id"] == "logical-request"

    # Final business ACK lost on the wire: retransmitting an already completed
    # physical fragment is ignored and must not execute the logical request twice.
    asyncio.run(
        consumer.receive(
            text_data=_fragment_envelope(
                frame_id="frame-1",
                index=0,
                count=2,
                raw_envelope=original,
                fragment=fragments[0],
            )
        )
    )
    sent_types = [call.args[0]["type"] for call in consumer._send_envelope.await_args_list]
    assert sent_types.count("relay_events.ok") == 1


def test_fragment_is_rejected_before_authentication_without_buffering():
    consumer = GatewayConsumer()
    consumer._send_envelope = AsyncMock()
    original = json.dumps(
        {
            "v": PROTOCOL_VERSION,
            "type": "relay_events",
            "request_id": "logical-request",
            "ts": int(time.time()),
            "device_id": "electron-test",
            "role": "electron",
            "payload": {},
        },
        separators=(",", ":"),
    ).encode("utf-8")

    async_to_sync(consumer.receive)(
        text_data=_fragment_envelope(
            frame_id="unauthenticated-frame",
            index=0,
            count=2,
            raw_envelope=original,
            fragment=original[:1],
        )
    )

    error = consumer._send_envelope.await_args.args[0]
    assert error["type"] == "error"
    assert error["payload"]["code"] == "WS_1000_AUTH_REQUIRED"

    consumer.authed = True
    consumer._cached_handlers = {"relay_events": AsyncMock()}
    async_to_sync(consumer.receive)(
        text_data=_fragment_envelope(
            frame_id="unauthenticated-frame",
            index=1,
            count=2,
            raw_envelope=original,
            fragment=original[1:],
        )
    )
    assert consumer._cached_handlers["relay_events"].await_count == 0


def test_reassembled_envelope_reenters_normal_schema_validation():
    consumer = GatewayConsumer()
    consumer.authed = True
    consumer._send_envelope = AsyncMock()
    consumer._cached_handlers = {"relay_events": AsyncMock()}
    original = json.dumps(
        {
            "v": PROTOCOL_VERSION,
            "type": "relay_events",
            "request_id": "logical-request",
            "ts": int(time.time()),
            "device_id": "electron-test",
            # Missing role: the transport wrapper must not bypass validation.
            "payload": {},
        },
        separators=(",", ":"),
    ).encode("utf-8")
    split_at = len(original) // 2

    async_to_sync(consumer.receive)(
        text_data=_fragment_envelope(
            frame_id="invalid-logical-frame",
            index=0,
            count=2,
            raw_envelope=original,
            fragment=original[:split_at],
        )
    )
    async_to_sync(consumer.receive)(
        text_data=_fragment_envelope(
            frame_id="invalid-logical-frame",
            index=1,
            count=2,
            raw_envelope=original,
            fragment=original[split_at:],
        )
    )

    sent = [call.args[0] for call in consumer._send_envelope.await_args_list]
    assert [envelope["type"] for envelope in sent] == ["error"]
    assert sent[-1]["request_id"] == "logical-request"
    assert consumer._cached_handlers["relay_events"].await_count == 0


def test_idle_fragment_is_expired_by_event_loop_timer_without_another_add():
    consumer = GatewayConsumer()
    consumer.authed = True
    consumer._send_envelope = AsyncMock()
    raw = b'{"request_id":"logical-request","type":"relay_events"}'
    baseline = process_buffered_fragment_bytes()

    async def exercise_timer():
        with patch.object(frame_reassembly, "FRAGMENT_TTL_SECONDS", 0.02):
            await consumer.receive(
                text_data=_fragment_envelope(
                    frame_id="idle-frame",
                    index=0,
                    count=2,
                    raw_envelope=raw,
                    fragment=raw[:10],
                )
            )
            assert consumer._frame_fragment_reassembler.next_pending_expiry_at() is not None
            await asyncio.sleep(0.05)
            assert consumer._frame_fragment_reassembler.next_pending_expiry_at() is None
            assert consumer._frame_fragment_expiry_handle is None
            assert process_buffered_fragment_bytes() == baseline

    asyncio.run(exercise_timer())


def test_physical_fragment_limit_aborts_assembly_with_original_request_error():
    consumer = GatewayConsumer()
    consumer.authed = True
    consumer._send_envelope = AsyncMock()
    consumer._cached_handlers = {"relay_events": AsyncMock()}
    raw = b'{"request_id":"logical-request","type":"relay_events"}'

    async def exercise_limit():
        with patch.object(gateway, "FRAGMENT_RATE_LIMIT_MAX_MESSAGES", 1):
            await consumer.receive(
                text_data=_fragment_envelope(
                    frame_id="limited-frame",
                    index=0,
                    count=2,
                    raw_envelope=raw,
                    fragment=raw[:10],
                )
            )
            await consumer.receive(
                text_data=_fragment_envelope(
                    frame_id="limited-frame",
                    index=1,
                    count=2,
                    raw_envelope=raw,
                    fragment=raw[10:],
                )
            )

    asyncio.run(exercise_limit())
    error = consumer._send_envelope.await_args.args[0]
    assert error["type"] == "error"
    assert error["request_id"] == "fragment-1"
    assert error["payload"]["code"] == "WS_1007_RATE_LIMITED"
    assert consumer._frame_fragment_reassembler.next_pending_expiry_at() is None
    assert consumer._cached_handlers["relay_events"].await_count == 0


def test_fragments_use_physical_quota_and_reassembled_message_uses_one_business_slot():
    consumer = GatewayConsumer()
    consumer.authed = True
    consumer._send_envelope = AsyncMock()
    consumer._cached_handlers = {"relay_events": AsyncMock()}
    consumer._is_fragment_rate_limited = MagicMock(return_value=False)
    consumer._is_rate_limited = MagicMock(return_value=False)
    raw = json.dumps(
        {
            "v": PROTOCOL_VERSION,
            "type": "relay_events",
            "request_id": "logical-request",
            "ts": int(time.time()),
            "device_id": "electron-test",
            "role": "electron",
            "payload": {},
        },
        separators=(",", ":"),
    ).encode()
    split_at = len(raw) // 2

    async def exercise_quotas():
        for index, fragment in enumerate((raw[:split_at], raw[split_at:])):
            await consumer.receive(
                text_data=_fragment_envelope(
                    frame_id="quota-frame",
                    index=index,
                    count=2,
                    raw_envelope=raw,
                    fragment=fragment,
                )
            )

    asyncio.run(exercise_quotas())
    assert consumer._is_fragment_rate_limited.call_count == 2
    assert consumer._is_rate_limited.call_count == 1
    assert consumer._cached_handlers["relay_events"].await_count == 1


def test_default_physical_quota_allows_two_maximum_fragment_frames():
    consumer = GatewayConsumer()
    for _ in range(128):
        assert consumer._is_fragment_rate_limited(1) is False


def test_physical_byte_quota_allows_two_max_frames_and_rejects_third():
    consumer = GatewayConsumer()
    assert consumer._is_fragment_rate_limited(32_000_000) is False
    assert consumer._is_fragment_rate_limited(32_000_000) is False
    assert consumer._is_fragment_rate_limited(1) is True


def test_process_budget_is_shared_and_released_between_reassemblers():
    raw = b'{"request_id":"logical-request","type":"relay_events"}'
    first = FrameFragmentReassembler()
    second = FrameFragmentReassembler()
    baseline = process_buffered_fragment_bytes()

    with patch.object(
        frame_reassembly,
        "MAX_PROCESS_BUFFERED_FRAGMENT_BYTES",
        baseline + 10,
    ):
        assert first.add(
            _fragment_payload(raw, raw[:6], index=0, frame_id="process-a")
        ) is None
        try:
            second.add(
                _fragment_payload(raw, raw[:5], index=0, frame_id="process-b")
            )
        except FrameFragmentError as exc:
            assert str(exc) == "process fragment buffer size limit exceeded"
        else:
            raise AssertionError("process-wide byte budget must be shared")

        first.abort("process-a")
        assert second.add(
            _fragment_payload(raw, raw[:5], index=0, frame_id="process-b")
        ) is None
        second.clear()

    assert process_buffered_fragment_bytes() == baseline


def _fragment_payload(
    raw: bytes,
    fragment: bytes,
    *,
    index: int,
    count: int = 2,
    frame_id: str = "frame-unit",
) -> dict:
    return json.loads(
        _fragment_envelope(
            frame_id=frame_id,
            index=index,
            count=count,
            raw_envelope=raw,
            fragment=fragment,
        )
    )["payload"]


def test_conflicting_duplicate_fragment_terminates_the_logical_frame():
    raw = b'{"request_id":"logical-request","type":"relay_events"}'
    reassembler = FrameFragmentReassembler()
    first = _fragment_payload(raw, raw[:10], index=0)
    conflicting = _fragment_payload(raw, b"different", index=0)

    assert reassembler.add(first, received_at=1) is None
    try:
        reassembler.add(conflicting, received_at=2)
    except FrameFragmentError as exc:
        assert str(exc) == "duplicate fragment content conflicts"
    else:
        raise AssertionError("conflicting duplicate must be rejected")

    # Conflict discards the old assembly: an isolated second fragment cannot
    # accidentally complete and dispatch the poisoned logical frame.
    assert reassembler.add(
        _fragment_payload(raw, raw[10:], index=1),
        received_at=3,
    ) is None


def test_expired_fragments_cannot_complete_a_logical_frame():
    raw = b'{"request_id":"logical-request","type":"relay_events"}'
    reassembler = FrameFragmentReassembler()
    assert reassembler.add(
        _fragment_payload(raw, raw[:10], index=0),
        received_at=1,
    ) is None
    assert reassembler.add(
        _fragment_payload(raw, raw[10:], index=1),
        received_at=62,
    ) is None


def test_reassembled_checksum_mismatch_is_rejected():
    raw = b'{"request_id":"logical-request","type":"relay_events"}'
    reassembler = FrameFragmentReassembler()
    first = _fragment_payload(raw, raw[:10], index=0)
    second = _fragment_payload(raw, raw[10:], index=1)
    second["sha256"] = first["sha256"] = "0" * 64

    assert reassembler.add(first) is None
    try:
        reassembler.add(second)
    except FrameFragmentError as exc:
        assert str(exc) == "reassembled frame checksum mismatch"
    else:
        raise AssertionError("checksum mismatch must be rejected")


def test_connection_cache_rejects_concurrent_frames_beyond_limit():
    raw = b'{"request_id":"logical-request","type":"relay_events"}'
    reassembler = FrameFragmentReassembler()
    with patch.object(frame_reassembly, "MAX_BUFFERED_FRAMES", 1):
        assert reassembler.add(
            _fragment_payload(raw, raw[:1], index=0, frame_id="frame-a")
        ) is None
        try:
            reassembler.add(
                _fragment_payload(raw, raw[:1], index=0, frame_id="frame-b")
            )
        except FrameFragmentError as exc:
            assert str(exc) == "too many fragmented frames in progress"
        else:
            raise AssertionError("concurrent frame limit must be enforced")


def test_connection_cache_rejects_total_buffered_bytes_beyond_limit():
    raw = b'{"request_id":"logical-request","type":"relay_events"}'
    reassembler = FrameFragmentReassembler()
    with patch.object(frame_reassembly, "MAX_BUFFERED_FRAGMENT_BYTES", 4):
        try:
            reassembler.add(_fragment_payload(raw, raw[:5], index=0))
        except FrameFragmentError as exc:
            assert str(exc) == "fragment buffer size limit exceeded"
        else:
            raise AssertionError("connection byte limit must be enforced")


def test_clear_releases_connection_owned_fragment_state():
    raw = b'{"request_id":"logical-request","type":"relay_events"}'
    reassembler = FrameFragmentReassembler()
    assert reassembler.add(_fragment_payload(raw, raw[:10], index=0)) is None
    reassembler.clear()
    assert reassembler.add(_fragment_payload(raw, raw[10:], index=1)) is None
