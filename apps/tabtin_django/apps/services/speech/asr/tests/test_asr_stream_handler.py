"""
ASR stream handler (_ASRStreamSession) 核心单元测试

覆盖：send_audio 帧构建、closed 状态短路、close 发送 is_last 空包、
      _cleanup 幂等、_parse_response 归一化输出、错误帧解析、音频块大小限制
"""

import os

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")
import django

django.setup()

import asyncio
import base64
import gzip
import json
import struct
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from apps.services.speech.asr.providers.bytedance.base import (
    CompressionType,
    MessageFlags,
    MessageType,
    ProtocolVersion,
    SerializationType,
    build_audio_packet,
    parse_ws_binary_frame,
)
from apps.services.common.ws.handlers.asr_stream import (
    _ASRStreamSession,
    _MAX_AUDIO_CHUNK_BYTES,
    create_asr_stream_handler,
)
from apps.services.common.ws.protocol import ERROR_SCHEMA_INVALID


def _make_consumer() -> MagicMock:
    consumer = MagicMock()
    consumer.channel_name = "test_channel"
    consumer.organization_id = "test_ws"
    consumer._send_envelope = AsyncMock()
    consumer._send_error = AsyncMock()
    return consumer


def _make_svc() -> MagicMock:
    svc = MagicMock()
    svc.app_id = "test_app"
    svc.access_token = "test_token"
    svc.resource_id = "test_resource"
    svc.ws_url = "wss://example.com/asr"
    return svc


def _build_session(*, closed: bool = False, ws: AsyncMock | None = None) -> _ASRStreamSession:
    """构造一个跳过 connect 的 _ASRStreamSession 实例。"""
    consumer = _make_consumer()
    svc = _make_svc()
    session = _ASRStreamSession(
        stream_id="asr_test456",
        consumer=consumer,
        svc=svc,
        language="zh-CN",
        audio_format="wav",
        sample_rate=16000,
        ws_endpoint="bigmodel_async",
        extra_params={},
    )
    session._ws = ws if ws is not None else AsyncMock()
    session._ws.closed = False
    session._closed = closed
    session.seq = 2
    return session


# ── 帧构造辅助（从 test_ws_protocol.py 复用思路） ─────────────────────

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
) -> bytes:
    header = _build_header(
        MessageType.SERVER_FULL_RESPONSE, flags, serialization, compression,
    )
    frame = bytearray(header)

    if flags & 0x01:
        frame.extend(struct.pack(">i", sequence))

    if payload_dict is not None:
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
) -> bytes:
    header = _build_header(
        MessageType.SERVER_ERROR_RESPONSE, flags, SerializationType.NONE, compression,
    )
    frame = bytearray(header)

    error_bytes = error_body.encode("utf-8")
    if compression == CompressionType.GZIP:
        error_bytes = gzip.compress(error_bytes)

    frame.extend(struct.pack(">i", error_code))
    frame.extend(struct.pack(">I", len(error_bytes)))
    frame.extend(error_bytes)

    return bytes(frame)


class TestASRSendAudio(unittest.IsolatedAsyncioTestCase):
    """send_audio: 验证音频包构建与发送"""

    async def test_send_audio_builds_packet(self):
        """send_audio 应调用 build_audio_packet 并通过 WS 发送"""
        mock_ws = AsyncMock()
        mock_ws.closed = False
        session = _build_session(ws=mock_ws)
        initial_seq = session.seq

        audio_data = b"\x00\x01\x02\x03" * 100

        await session.send_audio(audio_data, is_last=False)

        mock_ws.send_bytes.assert_called_once()
        sent_packet = mock_ws.send_bytes.call_args[0][0]

        expected_packet = build_audio_packet(seq=initial_seq, segment=audio_data, is_last=False)
        self.assertEqual(sent_packet, expected_packet)
        self.assertEqual(session.seq, initial_seq + 1)

    async def test_send_audio_noop_when_closed(self):
        """session 已关闭时 send_audio 不发送任何数据"""
        mock_ws = AsyncMock()
        mock_ws.closed = False
        session = _build_session(closed=True, ws=mock_ws)

        await session.send_audio(b"\x00\x01\x02\x03")

        mock_ws.send_bytes.assert_not_called()


class TestASRClose(unittest.IsolatedAsyncioTestCase):
    """close: 验证发送 is_last=True 的空包"""

    async def test_close_sends_last_packet(self):
        """close 应发送一个 is_last=True 的空音频包"""
        mock_ws = AsyncMock()
        mock_ws.closed = False
        session = _build_session(ws=mock_ws)
        seq_before = session.seq
        # 模拟 receive_loop 已完成
        session._receive_done.set()

        await session.close()

        self.assertTrue(session._closed)
        self.assertTrue(mock_ws.send_bytes.called)

        sent_packet = mock_ws.send_bytes.call_args[0][0]
        expected_packet = build_audio_packet(seq=seq_before, segment=b"", is_last=True)
        self.assertEqual(sent_packet, expected_packet)


class TestASRCleanup(unittest.IsolatedAsyncioTestCase):
    """_cleanup: 幂等安全"""

    async def test_cleanup_idempotent(self):
        """多次调用 _cleanup 不报错"""
        mock_ws = AsyncMock()
        mock_ws.closed = False
        session = _build_session(ws=mock_ws)

        await session._cleanup()
        self.assertTrue(session._closed)
        mock_ws.close.assert_called_once()

        mock_ws.closed = True
        await session._cleanup()
        await session._cleanup()


class TestASRParseResponse(unittest.IsolatedAsyncioTestCase):
    """_parse_response: 归一化输出 (camelCase) 与错误帧"""

    async def test_parse_response_normalizes_output(self):
        """正常响应帧应返回 camelCase 格式的 dict"""
        payload = {
            "result": {
                "text": "你好世界",
                "utterances": [
                    {
                        "text": "你好世界",
                        "start_time": 100,
                        "end_time": 2000,
                        "definite": False,
                        "words": [],
                    }
                ],
            },
            "audio_info": {"duration": 3500},
        }
        frame = _build_server_full_response(
            payload,
            flags=MessageFlags.NO_SEQUENCE,
        )

        result = _ASRStreamSession._parse_response(frame)

        self.assertIsNotNone(result)
        self.assertEqual(result["text"], "你好世界")
        self.assertIn("isFinal", result)
        self.assertFalse(result["isFinal"])
        self.assertIn("utterances", result)
        self.assertEqual(len(result["utterances"]), 1)
        utt = result["utterances"][0]
        self.assertEqual(utt["text"], "你好世界")
        self.assertIn("startTime", utt)
        self.assertEqual(utt["startTime"], 100)
        self.assertIn("endTime", utt)
        self.assertEqual(utt["endTime"], 2000)
        self.assertIn("audioInfo", result)
        self.assertEqual(result["audioInfo"]["duration"], 3500)

    async def test_parse_response_final_flag(self):
        """带 NEG_SEQUENCE 标记的帧应返回 isFinal=True"""
        payload = {"result": {"text": "最终结果"}}
        frame = _build_server_full_response(
            payload,
            flags=MessageFlags.NEG_SEQUENCE,
        )

        result = _ASRStreamSession._parse_response(frame)

        self.assertIsNotNone(result)
        self.assertTrue(result["isFinal"])

    async def test_parse_response_error(self):
        """错误帧应返回包含 error 字段的 dict"""
        frame = _build_server_error_response(45000001, "param error")

        result = _ASRStreamSession._parse_response(frame)

        self.assertIsNotNone(result)
        self.assertIn("error", result)
        self.assertIn("param error", result["error"])
        self.assertEqual(result["error_code"], 45000001)

    async def test_parse_response_empty_frame(self):
        """帧太短时返回 None"""
        result = _ASRStreamSession._parse_response(b"\x11")
        self.assertIsNone(result)


class TestASRAudioChunkLimit(unittest.IsolatedAsyncioTestCase):
    """handle_asr_stream_audio: 音频块大小限制"""

    async def test_audio_chunk_limit(self):
        """超过 _MAX_AUDIO_CHUNK_BYTES 的音频块应被拒绝"""
        consumer = _make_consumer()
        svc = _make_svc()

        _, handle_audio, _ = create_asr_stream_handler(consumer)

        session = _build_session()
        stream_id = session.stream_id
        session.owner_channel = consumer.channel_name

        from apps.services.common.ws.handlers import asr_stream as asr_mod
        asr_mod._active_streams[stream_id] = session

        try:
            oversized_audio = b"\x00" * (_MAX_AUDIO_CHUNK_BYTES + 1)
            oversized_b64 = base64.b64encode(oversized_audio).decode()

            envelope = {
                "request_id": "req_audio_test",
                "payload": {"stream_id": stream_id, "data": oversized_b64},
            }

            await handle_audio(envelope)

            consumer._send_error.assert_called_once()
            args = consumer._send_error.call_args
            self.assertEqual(args[0][0], "req_audio_test")
            self.assertEqual(args[0][1], ERROR_SCHEMA_INVALID)
            self.assertIn("超限", args[0][2])
        finally:
            asr_mod._active_streams.pop(stream_id, None)


if __name__ == "__main__":
    unittest.main()
