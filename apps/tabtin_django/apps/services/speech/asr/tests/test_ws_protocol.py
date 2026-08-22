"""
字节跳动 ASR WebSocket 二进制帧解析 (parse_ws_binary_frame) 单元测试

覆盖：帧过短、正常 JSON 响应、错误帧、空 payload、非 JSON 序列化、
      GZIP 解压失败、带 sequence、is_final 标志、不识别的 message_type
"""

import gzip
import json
import struct
import unittest

from apps.services.speech.asr.providers.bytedance.base import (
    CompressionType,
    MessageFlags,
    MessageType,
    ProtocolVersion,
    SerializationType,
    parse_ws_binary_frame,
)


# ── 帧构造辅助 ──────────────────────────────────────────────────────


def _build_header(
    msg_type: int,
    flags: int,
    serialization: int,
    compression: int,
) -> bytes:
    h = bytearray(4)
    h[0] = (ProtocolVersion.V1 << 4) | 1
    h[1] = (msg_type << 4) | flags
    h[2] = (serialization << 4) | compression
    h[3] = 0x00
    return bytes(h)


def _build_server_full_response(
    payload_dict: dict | None = None,
    *,
    flags: int = MessageFlags.NO_SEQUENCE,
    serialization: int = SerializationType.JSON,
    compression: int = CompressionType.GZIP,
    sequence: int = 0,
    raw_payload: bytes | None = None,
) -> bytes:
    header = _build_header(
        MessageType.SERVER_FULL_RESPONSE, flags, serialization, compression,
    )
    frame = bytearray(header)

    if flags & 0x01:
        frame.extend(struct.pack(">i", sequence))

    if raw_payload is not None:
        frame.extend(struct.pack(">I", len(raw_payload)))
        frame.extend(raw_payload)
    elif payload_dict is not None:
        body = json.dumps(payload_dict).encode("utf-8")
        if compression == CompressionType.GZIP:
            body = gzip.compress(body)
        frame.extend(struct.pack(">I", len(body)))
        frame.extend(body)

    return bytes(frame)


def _build_server_error_response(
    error_code: int,
    error_body: str,
    *,
    flags: int = MessageFlags.NO_SEQUENCE,
    compression: int = CompressionType.NONE,
    sequence: int = 0,
) -> bytes:
    header = _build_header(
        MessageType.SERVER_ERROR_RESPONSE, flags, SerializationType.NONE, compression,
    )
    frame = bytearray(header)

    if flags & 0x01:
        frame.extend(struct.pack(">i", sequence))

    error_bytes = error_body.encode("utf-8")
    if compression == CompressionType.GZIP:
        error_bytes = gzip.compress(error_bytes)

    frame.extend(struct.pack(">i", error_code))
    frame.extend(struct.pack(">I", len(error_bytes)))
    frame.extend(error_bytes)

    return bytes(frame)


# ── 测试 ────────────────────────────────────────────────────────────


class TestParseWsBinaryFrame(unittest.TestCase):
    """parse_ws_binary_frame 全面解析测试"""

    # 1. 帧太短（< 4 bytes）
    def test_frame_too_short_empty(self):
        self.assertIsNone(parse_ws_binary_frame(b""))

    def test_frame_too_short_3_bytes(self):
        self.assertIsNone(parse_ws_binary_frame(b"\x11\x90\x11"))

    # 2. 正常 JSON 响应帧
    def test_normal_json_response(self):
        expected = {"result": {"text": "你好世界"}}
        frame = _build_server_full_response(expected)
        result = parse_ws_binary_frame(frame)

        self.assertIsNotNone(result)
        self.assertEqual(result["json_data"], expected)
        self.assertFalse(result["is_final"])
        self.assertEqual(result["sequence"], 0)

    # 3. 错误帧
    def test_error_response(self):
        frame = _build_server_error_response(45000001, "param error")
        result = parse_ws_binary_frame(frame)

        self.assertIsNotNone(result)
        self.assertEqual(result["error_code"], 45000001)
        self.assertIn("param error", result["error"])
        self.assertTrue(result["is_final"])

    def test_error_response_with_gzip(self):
        frame = _build_server_error_response(
            55000031, "server internal", compression=CompressionType.GZIP,
        )
        result = parse_ws_binary_frame(frame)

        self.assertIsNotNone(result)
        self.assertEqual(result["error_code"], 55000031)
        self.assertIn("server internal", result["error"])

    # 4. 空 payload（SERVER_FULL_RESPONSE 但无 payload 数据）
    def test_empty_payload_header_only(self):
        header = _build_header(
            MessageType.SERVER_FULL_RESPONSE,
            MessageFlags.NO_SEQUENCE,
            SerializationType.JSON,
            CompressionType.GZIP,
        )
        result = parse_ws_binary_frame(header)

        self.assertIsNotNone(result)
        self.assertIsNone(result["json_data"])
        self.assertFalse(result["is_final"])

    def test_empty_payload_with_zero_size(self):
        header = _build_header(
            MessageType.SERVER_FULL_RESPONSE,
            MessageFlags.NO_SEQUENCE,
            SerializationType.JSON,
            CompressionType.NONE,
        )
        frame = header + struct.pack(">I", 0)
        result = parse_ws_binary_frame(frame)

        self.assertIsNotNone(result)
        self.assertIsNone(result["json_data"])

    # 5. 非 JSON 序列化
    def test_non_json_serialization(self):
        raw = b"raw binary data"
        frame = _build_server_full_response(
            None,
            serialization=SerializationType.NONE,
            compression=CompressionType.NONE,
            raw_payload=raw,
        )
        result = parse_ws_binary_frame(frame)

        self.assertIsNotNone(result)
        self.assertIsNone(result["json_data"])

    # 6. GZIP 解压失败
    def test_gzip_decompress_failure(self):
        bad_gzip = b"not a valid gzip stream"
        frame = _build_server_full_response(
            None,
            serialization=SerializationType.JSON,
            compression=CompressionType.GZIP,
            raw_payload=bad_gzip,
        )
        result = parse_ws_binary_frame(frame)

        self.assertIsNotNone(result)
        self.assertIsNone(result["json_data"])

    # 7. 带 sequence 的帧（flags & 0x01）
    def test_frame_with_positive_sequence(self):
        expected = {"result": {"text": "seq"}}
        frame = _build_server_full_response(
            expected, flags=MessageFlags.POS_SEQUENCE, sequence=42,
        )
        result = parse_ws_binary_frame(frame)

        self.assertIsNotNone(result)
        self.assertEqual(result["sequence"], 42)
        self.assertEqual(result["json_data"], expected)
        self.assertFalse(result["is_final"])

    def test_frame_with_negative_sequence(self):
        expected = {"result": {"text": "neg"}}
        frame = _build_server_full_response(
            expected, flags=MessageFlags.NEG_WITH_SEQUENCE, sequence=-5,
        )
        result = parse_ws_binary_frame(frame)

        self.assertIsNotNone(result)
        self.assertEqual(result["sequence"], -5)
        self.assertTrue(result["is_final"])

    # 8. is_final 标志（flags & 0x02）
    def test_is_final_flag_only(self):
        expected = {"result": {"text": "final"}}
        frame = _build_server_full_response(
            expected, flags=MessageFlags.NEG_SEQUENCE,
        )
        result = parse_ws_binary_frame(frame)

        self.assertIsNotNone(result)
        self.assertTrue(result["is_final"])
        self.assertEqual(result["json_data"], expected)

    def test_is_final_with_sequence(self):
        expected = {"result": {"text": "neg final"}}
        frame = _build_server_full_response(
            expected, flags=MessageFlags.NEG_WITH_SEQUENCE, sequence=-10,
        )
        result = parse_ws_binary_frame(frame)

        self.assertIsNotNone(result)
        self.assertTrue(result["is_final"])
        self.assertEqual(result["sequence"], -10)
        self.assertEqual(result["json_data"], expected)

    # 9. 不认识的 message_type
    def test_unknown_message_type(self):
        unknown = 0b0101
        header = _build_header(
            unknown, MessageFlags.NO_SEQUENCE,
            SerializationType.JSON, CompressionType.NONE,
        )
        self.assertIsNone(parse_ws_binary_frame(header))

    def test_client_message_type_ignored(self):
        header = _build_header(
            MessageType.CLIENT_FULL_REQUEST, MessageFlags.NO_SEQUENCE,
            SerializationType.JSON, CompressionType.NONE,
        )
        self.assertIsNone(parse_ws_binary_frame(header))


if __name__ == "__main__":
    unittest.main()
