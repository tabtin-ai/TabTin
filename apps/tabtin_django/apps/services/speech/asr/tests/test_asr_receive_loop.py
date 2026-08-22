"""
ASR receive_loop 消息分发单元测试

覆盖：正常识别事件转发 (camelCase)、is_final 结束事件、
      错误帧处理、WS CLOSED 消息导致循环退出
"""

import os

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")
import django

django.setup()

import gzip
import json
import struct
import unittest
from unittest.mock import AsyncMock, MagicMock

import aiohttp

from apps.services.speech.asr.providers.bytedance.base import (
    CompressionType,
    MessageFlags,
    MessageType,
    ProtocolVersion,
    SerializationType,
)
from apps.services.common.ws.handlers.asr_stream import (
    _ASRStreamSession,
    _active_streams,
)


# ── Mock WS ──────────────────────────────────────────────────────────


class MockWSMessage:
    """模拟 aiohttp.WSMessage"""

    def __init__(self, msg_type, data=None):
        self.type = msg_type
        self.data = data


class MockWSConnection:
    """模拟 aiohttp.ClientWebSocketResponse，支持 async for 迭代"""

    def __init__(self, messages):
        self._messages = messages
        self._idx = 0
        self.closed = False
        self.send_bytes = AsyncMock()

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self._idx >= len(self._messages):
            raise StopAsyncIteration
        msg = self._messages[self._idx]
        self._idx += 1
        return msg

    async def close(self):
        self.closed = True


# ── ASR 下行帧构造辅助（复用 test_ws_protocol 模式） ──────────────────


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
    """构造 ASR SERVER_FULL_RESPONSE 帧"""
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
    """构造 ASR SERVER_ERROR_RESPONSE 帧"""
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


# ── Session 构造辅助 ─────────────────────────────────────────────────


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


def _build_session(mock_ws: MockWSConnection) -> _ASRStreamSession:
    """构造注入 mock WS 的 _ASRStreamSession，跳过 connect"""
    consumer = _make_consumer()
    svc = _make_svc()
    session = _ASRStreamSession(
        stream_id="asr_test",
        consumer=consumer,
        svc=svc,
        language="",
        audio_format="wav",
        sample_rate=16000,
        ws_endpoint="bigmodel_async",
        extra_params={},
    )
    session._ws = mock_ws
    return session


def _final_frame() -> bytes:
    """构造 is_final=True 的帧（用于终止 receive_loop）"""
    return _build_server_full_response(
        {"result": {"text": "最终结果"}, "audio_info": {"duration": 3000}},
        flags=MessageFlags.NEG_SEQUENCE,
    )


# ── 测试 ────────────────────────────────────────────────────────────


class TestReceiveNormalEvent(unittest.IsolatedAsyncioTestCase):
    """正常识别事件 → asr.stream.event (camelCase)"""

    async def test_receive_normal_event(self):
        """收到非 final 响应帧，前端应收到 asr.stream.event 且 payload 为 camelCase 格式"""
        payload = {
            "result": {
                "text": "你好世界",
                "utterances": [{
                    "text": "你好世界",
                    "start_time": 100,
                    "end_time": 2000,
                    "definite": False,
                    "words": [],
                }],
            },
            "audio_info": {"duration": 2500},
        }
        normal_frame = _build_server_full_response(
            payload, flags=MessageFlags.POS_SEQUENCE, sequence=1,
        )
        mock_ws = MockWSConnection([
            MockWSMessage(aiohttp.WSMsgType.BINARY, normal_frame),
            MockWSMessage(aiohttp.WSMsgType.BINARY, _final_frame()),
        ])
        session = _build_session(mock_ws)

        await session.receive_loop()

        calls = session.consumer._send_envelope.call_args_list
        self.assertGreaterEqual(len(calls), 2)

        envelope = calls[0][0][0]
        self.assertEqual(envelope["type"], "asr.stream.event")
        p = envelope["payload"]
        self.assertEqual(p["stream_id"], "asr_test")
        self.assertEqual(p["text"], "你好世界")
        self.assertFalse(p["isFinal"])
        self.assertEqual(p["sequence"], 1)
        self.assertIn("utterances", p)
        self.assertEqual(len(p["utterances"]), 1)
        utt = p["utterances"][0]
        self.assertEqual(utt["text"], "你好世界")
        self.assertEqual(utt["startTime"], 100)
        self.assertEqual(utt["endTime"], 2000)
        self.assertIn("audioInfo", p)
        self.assertEqual(p["audioInfo"]["duration"], 2500)

    def tearDown(self):
        _active_streams.clear()


class TestReceiveFinalEvent(unittest.IsolatedAsyncioTestCase):
    """is_final=True 事件 → asr.stream.done + 循环退出"""

    async def test_receive_final_event(self):
        """收到 is_final=True 帧，前端应收到 asr.stream.done 且循环正常退出"""
        payload = {
            "result": {"text": "最终识别结果"},
            "audio_info": {"duration": 5000},
        }
        final_frame = _build_server_full_response(
            payload, flags=MessageFlags.NEG_WITH_SEQUENCE, sequence=-5,
        )
        mock_ws = MockWSConnection([
            MockWSMessage(aiohttp.WSMsgType.BINARY, final_frame),
        ])
        session = _build_session(mock_ws)

        await session.receive_loop()

        calls = session.consumer._send_envelope.call_args_list
        self.assertEqual(len(calls), 1)

        envelope = calls[0][0][0]
        self.assertEqual(envelope["type"], "asr.stream.done")
        p = envelope["payload"]
        self.assertEqual(p["stream_id"], "asr_test")
        self.assertEqual(p["text"], "最终识别结果")
        self.assertTrue(p["isFinal"])
        self.assertEqual(p["sequence"], -5)
        self.assertTrue(session._receive_done.is_set())

    def tearDown(self):
        _active_streams.clear()


class TestReceiveErrorFrame(unittest.IsolatedAsyncioTestCase):
    """错误帧 → asr.stream.error + 循环退出"""

    async def test_receive_error_frame(self):
        """收到 SERVER_ERROR_RESPONSE 帧，前端应收到 asr.stream.error 且循环退出"""
        error_frame = _build_server_error_response(45000001, "param error")
        mock_ws = MockWSConnection([
            MockWSMessage(aiohttp.WSMsgType.BINARY, error_frame),
        ])
        session = _build_session(mock_ws)

        await session.receive_loop()

        calls = session.consumer._send_envelope.call_args_list
        self.assertEqual(len(calls), 1)

        envelope = calls[0][0][0]
        self.assertEqual(envelope["type"], "asr.stream.error")
        p = envelope["payload"]
        self.assertEqual(p["stream_id"], "asr_test")
        self.assertIn("error", p)
        self.assertTrue(p["isFinal"])
        self.assertTrue(session._receive_done.is_set())

    def tearDown(self):
        _active_streams.clear()


class TestReceiveWSClosed(unittest.IsolatedAsyncioTestCase):
    """WSMsgType.CLOSED → 循环安全退出"""

    async def test_receive_ws_closed(self):
        """收到 CLOSED 消息，循环应退出且不向前端推送业务事件"""
        mock_ws = MockWSConnection([
            MockWSMessage(aiohttp.WSMsgType.CLOSED, None),
        ])
        session = _build_session(mock_ws)

        await session.receive_loop()

        session.consumer._send_envelope.assert_not_called()
        self.assertTrue(session._receive_done.is_set())

    def tearDown(self):
        _active_streams.clear()


if __name__ == "__main__":
    unittest.main()
