"""
TTS receive_loop 消息分发单元测试

覆盖：SERVER_AUDIO_ONLY 音频转发、TTS_RESPONSE 事件转发、
      SESSION_FINISHED 结束信号、SERVER_ERROR / SESSION_FAILED 错误处理、
      WS CLOSED 消息导致循环退出
"""

import os

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")
import django

django.setup()

import base64
import json
import struct
import unittest
from unittest.mock import AsyncMock, MagicMock

import aiohttp

from apps.services.speech.tts.providers.bytedance.base import (
    PROTOCOL_VERSION,
    Compression,
    Event,
    MsgFlags,
    MsgType,
    Serialization,
)
from apps.services.common.ws.handlers.tts_stream import (
    _TTSStreamSession,
    _active_tts_streams,
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


# ── TTS 下行帧构造辅助 ───────────────────────────────────────────────


def _build_server_audio_only(audio_data: bytes) -> bytes:
    """构造 SERVER_AUDIO_ONLY 帧：header(4) + payload_size(4) + audio"""
    b0 = (PROTOCOL_VERSION << 4) | 1
    b1 = (MsgType.SERVER_AUDIO_ONLY << 4) | MsgFlags.NONE
    b2 = (Serialization.RAW << 4) | Compression.NONE
    b3 = 0
    header = struct.pack(">BBBB", b0, b1, b2, b3)
    return header + struct.pack(">I", len(audio_data)) + audio_data


def _build_server_full_response(
    event: int,
    payload_json: dict | None = None,
    payload_raw: bytes = b"",
    *,
    session_id: str = "test_session",
) -> bytes:
    """
    构造带事件的 SERVER_FULL_RESPONSE 帧。

    帧结构：header(4) + event(4) + sid_size(4) + sid + payload_size(4) + payload
    """
    has_json = payload_json is not None
    serialization = Serialization.JSON if has_json else Serialization.RAW

    b0 = (PROTOCOL_VERSION << 4) | 1
    b1 = (MsgType.SERVER_FULL_RESPONSE << 4) | MsgFlags.WITH_EVENT
    b2 = (serialization << 4) | Compression.NONE
    b3 = 0
    header = struct.pack(">BBBB", b0, b1, b2, b3)
    event_bytes = struct.pack(">I", event)

    sid_raw = session_id.encode("utf-8")
    sid_section = struct.pack(">I", len(sid_raw)) + sid_raw

    payload = json.dumps(payload_json).encode("utf-8") if has_json else payload_raw
    payload_section = struct.pack(">I", len(payload)) + payload

    return header + event_bytes + sid_section + payload_section


def _build_server_error(error_code: int) -> bytes:
    """构造 SERVER_ERROR 帧：header(4) + error_code(4)"""
    b0 = (PROTOCOL_VERSION << 4) | 1
    b1 = (MsgType.SERVER_ERROR << 4) | MsgFlags.NONE
    b2 = (Serialization.RAW << 4) | Compression.NONE
    b3 = 0
    header = struct.pack(">BBBB", b0, b1, b2, b3)
    return header + struct.pack(">I", error_code)


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
    svc.default_speaker = "test_speaker"
    svc.app_id = "test_app"
    svc.access_token = "test_token"
    svc.resource_id = "test_resource"
    return svc


def _build_session(mock_ws: MockWSConnection) -> _TTSStreamSession:
    """构造注入 mock WS 的 _TTSStreamSession，跳过 connect"""
    consumer = _make_consumer()
    svc = _make_svc()
    session = _TTSStreamSession(
        stream_id="tts_test",
        consumer=consumer,
        svc=svc,
        speaker="test",
        model="",
        format="mp3",
        sample_rate=24000,
        speed_ratio=1.0,
        emotion="",
        enable_timestamp=False,
    )
    session._ws = mock_ws
    return session


def _finish_frame() -> bytes:
    """构造 SESSION_FINISHED 帧（用于终止 receive_loop）"""
    return _build_server_full_response(Event.SESSION_FINISHED, {"usage": {}})


# ── 测试 ────────────────────────────────────────────────────────────


class TestReceiveServerAudioOnly(unittest.IsolatedAsyncioTestCase):
    """SERVER_AUDIO_ONLY 帧 → tts.stream.audio"""

    async def test_receive_server_audio_only(self):
        """收到 SERVER_AUDIO_ONLY 帧，前端应收到包含 base64 音频和 size 的 tts.stream.audio"""
        audio_bytes = b"\x00\x01\x02\x03" * 64
        mock_ws = MockWSConnection([
            MockWSMessage(aiohttp.WSMsgType.BINARY, _build_server_audio_only(audio_bytes)),
            MockWSMessage(aiohttp.WSMsgType.BINARY, _finish_frame()),
        ])
        session = _build_session(mock_ws)

        await session.receive_loop()

        calls = session.consumer._send_envelope.call_args_list
        self.assertGreaterEqual(len(calls), 2)

        envelope = calls[0][0][0]
        self.assertEqual(envelope["type"], "tts.stream.audio")
        self.assertEqual(envelope["payload"]["stream_id"], "tts_test")
        self.assertEqual(
            envelope["payload"]["data"],
            base64.b64encode(audio_bytes).decode(),
        )
        self.assertEqual(envelope["payload"]["size"], len(audio_bytes))

    def tearDown(self):
        _active_tts_streams.clear()


class TestReceiveTTSResponse(unittest.IsolatedAsyncioTestCase):
    """TTS_RESPONSE 事件 → tts.stream.audio"""

    async def test_receive_tts_response(self):
        """收到 TTS_RESPONSE 事件帧，前端应收到 tts.stream.audio"""
        audio_bytes = b"\xff\xfe\xfd" * 50
        mock_ws = MockWSConnection([
            MockWSMessage(
                aiohttp.WSMsgType.BINARY,
                _build_server_full_response(Event.TTS_RESPONSE, payload_raw=audio_bytes),
            ),
            MockWSMessage(aiohttp.WSMsgType.BINARY, _finish_frame()),
        ])
        session = _build_session(mock_ws)

        await session.receive_loop()

        calls = session.consumer._send_envelope.call_args_list
        self.assertGreaterEqual(len(calls), 2)

        envelope = calls[0][0][0]
        self.assertEqual(envelope["type"], "tts.stream.audio")
        self.assertEqual(
            envelope["payload"]["data"],
            base64.b64encode(audio_bytes).decode(),
        )
        self.assertEqual(envelope["payload"]["size"], len(audio_bytes))

    def tearDown(self):
        _active_tts_streams.clear()


class TestReceiveSessionFinished(unittest.IsolatedAsyncioTestCase):
    """SESSION_FINISHED → tts.stream.done + 循环退出"""

    async def test_receive_session_finished(self):
        """收到 SESSION_FINISHED 帧，前端应收到 tts.stream.done 且循环正常退出"""
        usage = {"total_chars": 100}
        mock_ws = MockWSConnection([
            MockWSMessage(
                aiohttp.WSMsgType.BINARY,
                _build_server_full_response(Event.SESSION_FINISHED, {"usage": usage}),
            ),
        ])
        session = _build_session(mock_ws)

        await session.receive_loop()

        calls = session.consumer._send_envelope.call_args_list
        self.assertEqual(len(calls), 1)

        envelope = calls[0][0][0]
        self.assertEqual(envelope["type"], "tts.stream.done")
        self.assertEqual(envelope["payload"]["stream_id"], "tts_test")
        self.assertEqual(envelope["payload"]["usage"], usage)
        self.assertTrue(session._receive_done.is_set())

    def tearDown(self):
        _active_tts_streams.clear()


class TestReceiveServerError(unittest.IsolatedAsyncioTestCase):
    """SERVER_ERROR → tts.stream.error + 循环退出"""

    async def test_receive_server_error(self):
        """收到 SERVER_ERROR 帧，前端应收到 tts.stream.error 且循环退出"""
        mock_ws = MockWSConnection([
            MockWSMessage(aiohttp.WSMsgType.BINARY, _build_server_error(55000000)),
        ])
        session = _build_session(mock_ws)

        await session.receive_loop()

        calls = session.consumer._send_envelope.call_args_list
        self.assertEqual(len(calls), 1)

        envelope = calls[0][0][0]
        self.assertEqual(envelope["type"], "tts.stream.error")
        self.assertEqual(envelope["payload"]["stream_id"], "tts_test")
        self.assertIn("error", envelope["payload"])
        self.assertTrue(session._receive_done.is_set())

    def tearDown(self):
        _active_tts_streams.clear()


class TestReceiveSessionFailed(unittest.IsolatedAsyncioTestCase):
    """SESSION_FAILED → tts.stream.error + 循环退出"""

    async def test_receive_session_failed(self):
        """收到 SESSION_FAILED 帧，前端应收到 tts.stream.error 且循环退出"""
        mock_ws = MockWSConnection([
            MockWSMessage(
                aiohttp.WSMsgType.BINARY,
                _build_server_full_response(Event.SESSION_FAILED, {"error": "upstream failure"}),
            ),
        ])
        session = _build_session(mock_ws)

        await session.receive_loop()

        calls = session.consumer._send_envelope.call_args_list
        self.assertEqual(len(calls), 1)

        envelope = calls[0][0][0]
        self.assertEqual(envelope["type"], "tts.stream.error")
        self.assertEqual(envelope["payload"]["stream_id"], "tts_test")
        self.assertIn("error", envelope["payload"])
        self.assertTrue(session._receive_done.is_set())

    def tearDown(self):
        _active_tts_streams.clear()


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
        _active_tts_streams.clear()


if __name__ == "__main__":
    unittest.main()
