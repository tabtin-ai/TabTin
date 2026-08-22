"""
字节跳动 TTS WebSocket 二进制帧编解码 (build_ws_frame / parse_ws_frame) 单元测试

覆盖：基本构建、带 session_id、GZIP 压缩、帧过短、SERVER_ERROR 解析、
      带 event 的 SERVER_FULL_RESPONSE、build → parse 往返一致性
"""

import gzip
import json
import struct
import unittest

from apps.services.speech.tts.providers.bytedance.base import (
    HEADER_SIZE_UNIT,
    PROTOCOL_VERSION,
    Compression,
    Event,
    MsgFlags,
    MsgType,
    Serialization,
    build_ws_frame,
    parse_ws_frame,
)


# ── 服务端帧手动构造辅助 ────────────────────────────────────────────


def _server_header(
    msg_type: int,
    msg_flags: int,
    serialization: int = Serialization.JSON,
    compression: int = Compression.NONE,
) -> bytes:
    return struct.pack(
        ">BBBB",
        (PROTOCOL_VERSION << 4) | HEADER_SIZE_UNIT,
        (msg_type << 4) | msg_flags,
        (serialization << 4) | compression,
        0x00,
    )


# ── build_ws_frame 测试 ─────────────────────────────────────────────


class TestBuildWsFrame(unittest.TestCase):
    """build_ws_frame 构建测试"""

    # 1. StartConnection 事件，无 payload
    def test_start_connection_no_payload(self):
        frame = build_ws_frame(Event.START_CONNECTION)

        self.assertEqual(frame[0], (PROTOCOL_VERSION << 4) | HEADER_SIZE_UNIT)
        self.assertEqual(
            frame[1],
            (MsgType.FULL_CLIENT_REQUEST << 4) | MsgFlags.WITH_EVENT,
        )
        self.assertEqual(frame[2], (Serialization.JSON << 4) | Compression.NONE)
        self.assertEqual(frame[3], 0x00)

        event = struct.unpack(">I", frame[4:8])[0]
        self.assertEqual(event, Event.START_CONNECTION)

        payload_size = struct.unpack(">I", frame[8:12])[0]
        self.assertEqual(payload_size, 0)
        self.assertEqual(len(frame), 12)

    # 2. StartSession 带 session_id
    def test_start_session_with_session_id(self):
        sid = "test-session-123"
        payload = {"key": "value"}
        frame = build_ws_frame(Event.START_SESSION, payload, session_id=sid)

        offset = 4
        event = struct.unpack(">I", frame[offset:offset + 4])[0]
        self.assertEqual(event, Event.START_SESSION)
        offset += 4

        sid_size = struct.unpack(">I", frame[offset:offset + 4])[0]
        offset += 4
        self.assertEqual(sid_size, len(sid.encode("utf-8")))
        actual_sid = frame[offset:offset + sid_size].decode("utf-8")
        self.assertEqual(actual_sid, sid)
        offset += sid_size

        payload_size = struct.unpack(">I", frame[offset:offset + 4])[0]
        offset += 4
        payload_bytes = frame[offset:offset + payload_size]
        self.assertEqual(json.loads(payload_bytes), payload)

    def test_start_connection_ignores_session_id(self):
        """连接级事件不写入 session_id（不在 _CLIENT_NEEDS_SESSION_ID 中）"""
        frame_with = build_ws_frame(
            Event.START_CONNECTION, session_id="should-be-ignored",
        )
        frame_without = build_ws_frame(Event.START_CONNECTION)
        self.assertEqual(frame_with, frame_without)

    # 3. GZIP 压缩
    def test_build_with_gzip_compression(self):
        payload = {"text": "hello world", "nested": [1, 2, 3]}
        frame = build_ws_frame(
            Event.START_CONNECTION, payload, compression=Compression.GZIP,
        )

        self.assertEqual(frame[2] & 0x0F, Compression.GZIP)

        offset = 8  # header(4) + event(4)
        payload_size = struct.unpack(">I", frame[offset:offset + 4])[0]
        offset += 4
        compressed = frame[offset:offset + payload_size]
        decompressed = gzip.decompress(compressed)
        self.assertEqual(json.loads(decompressed), payload)


# ── parse_ws_frame 测试 ──────────────────────────────────────────────


class TestParseWsFrame(unittest.TestCase):
    """parse_ws_frame 解析测试"""

    # 4. 帧太短 → 抛 ValueError
    def test_frame_too_short_empty(self):
        with self.assertRaises(ValueError):
            parse_ws_frame(b"")

    def test_frame_too_short_2_bytes(self):
        with self.assertRaises(ValueError):
            parse_ws_frame(b"\x11\x90")

    # 5. 解析 SERVER_ERROR 帧
    def test_parse_server_error(self):
        error_code = 45000001
        error_body = {"message": "something went wrong"}
        error_bytes = json.dumps(error_body).encode("utf-8")

        frame = _server_header(MsgType.SERVER_ERROR, MsgFlags.NONE)
        frame += struct.pack(">I", error_code)
        frame += struct.pack(">I", len(error_bytes))
        frame += error_bytes

        result = parse_ws_frame(frame)
        self.assertEqual(result["msg_type"], MsgType.SERVER_ERROR)
        self.assertEqual(result["error_code"], error_code)
        self.assertEqual(result["payload_json"], error_body)

    def test_parse_server_error_gzip(self):
        error_code = 55000000
        error_body = {"detail": "server down"}
        raw = json.dumps(error_body).encode("utf-8")
        compressed = gzip.compress(raw)

        frame = _server_header(
            MsgType.SERVER_ERROR, MsgFlags.NONE,
            compression=Compression.GZIP,
        )
        frame += struct.pack(">I", error_code)
        frame += struct.pack(">I", len(compressed))
        frame += compressed

        result = parse_ws_frame(frame)
        self.assertEqual(result["error_code"], error_code)
        self.assertEqual(result["payload_json"], error_body)

    # 6. 解析带 event 的 SERVER_FULL_RESPONSE
    def test_parse_server_response_with_event(self):
        payload = {"status": "ok"}
        payload_bytes = json.dumps(payload).encode("utf-8")
        sid = "sess-abc"
        sid_bytes = sid.encode("utf-8")

        frame = _server_header(
            MsgType.SERVER_FULL_RESPONSE, MsgFlags.WITH_EVENT,
        )
        frame += struct.pack(">I", Event.SESSION_STARTED)
        frame += struct.pack(">I", len(sid_bytes)) + sid_bytes
        frame += struct.pack(">I", len(payload_bytes)) + payload_bytes

        result = parse_ws_frame(frame)
        self.assertEqual(result["msg_type"], MsgType.SERVER_FULL_RESPONSE)
        self.assertEqual(result["event"], Event.SESSION_STARTED)
        self.assertEqual(result.get("session_id"), sid)
        self.assertEqual(result["payload_json"], payload)

    def test_parse_connection_started_with_connect_id(self):
        cid = "connect-xyz"
        cid_bytes = cid.encode("utf-8")
        payload = {"message": "connected"}
        payload_bytes = json.dumps(payload).encode("utf-8")

        frame = _server_header(
            MsgType.SERVER_FULL_RESPONSE, MsgFlags.WITH_EVENT,
        )
        frame += struct.pack(">I", Event.CONNECTION_STARTED)
        frame += struct.pack(">I", len(cid_bytes)) + cid_bytes
        frame += struct.pack(">I", len(payload_bytes)) + payload_bytes

        result = parse_ws_frame(frame)
        self.assertEqual(result["event"], Event.CONNECTION_STARTED)
        self.assertEqual(result.get("connect_id"), cid)
        self.assertEqual(result["payload_json"], payload)


# ── build → parse 往返测试 ──────────────────────────────────────────


class TestRoundTrip(unittest.TestCase):
    """build_ws_frame → parse_ws_frame 往返一致性"""

    # 7. 往返测试
    def test_round_trip_task_request(self):
        sid = "round-trip-session"
        payload = {"text": "你好世界", "speaker": "test_speaker"}

        frame = build_ws_frame(
            Event.TASK_REQUEST, payload, session_id=sid,
        )
        result = parse_ws_frame(frame)

        self.assertEqual(result["msg_type"], MsgType.FULL_CLIENT_REQUEST)
        self.assertEqual(result["event"], Event.TASK_REQUEST)
        self.assertEqual(result.get("session_id"), sid)
        self.assertEqual(result["payload_json"], payload)

    def test_round_trip_with_gzip(self):
        sid = "gzip-session"
        payload = {"text": "压缩测试", "items": list(range(50))}

        frame = build_ws_frame(
            Event.TASK_REQUEST, payload,
            session_id=sid,
            compression=Compression.GZIP,
        )
        result = parse_ws_frame(frame)

        self.assertEqual(result["event"], Event.TASK_REQUEST)
        self.assertEqual(result.get("session_id"), sid)
        self.assertEqual(result["payload_json"], payload)

    def test_round_trip_no_payload(self):
        frame = build_ws_frame(Event.FINISH_SESSION, session_id="s1")
        result = parse_ws_frame(frame)

        self.assertEqual(result["event"], Event.FINISH_SESSION)
        self.assertEqual(result.get("session_id"), "s1")
        self.assertIsNone(result["payload_json"])


if __name__ == "__main__":
    unittest.main()
