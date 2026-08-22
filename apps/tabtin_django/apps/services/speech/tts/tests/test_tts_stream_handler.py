"""
TTS stream handler (_TTSStreamSession) 核心单元测试

覆盖：send_text 帧构建、closed 状态短路、finish 发送 FinishSession、
      _cleanup 发送 FinishConnection、_cleanup 幂等、文本长度限制
"""

import os

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")
import django

django.setup()

import asyncio
import json
import struct
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from apps.services.speech.tts.providers.bytedance.base import (
    Event,
    build_ws_frame,
    parse_ws_frame,
)
from apps.services.common.ws.handlers.tts_stream import (
    _MAX_TEXT_CHARS_PER_REQUEST,
    _TTSStreamSession,
    create_tts_stream_handler,
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
    svc.default_speaker = "test_speaker"
    svc.app_id = "test_app"
    svc.access_token = "test_token"
    svc.resource_id = "test_resource"
    return svc


def _build_session(*, closed: bool = False, ws: AsyncMock | None = None) -> _TTSStreamSession:
    """构造一个跳过 connect 的 _TTSStreamSession 实例，手动注入内部状态。"""
    consumer = _make_consumer()
    svc = _make_svc()
    session = _TTSStreamSession(
        stream_id="tts_test123",
        consumer=consumer,
        svc=svc,
        speaker="test_speaker",
        model="",
        format="mp3",
        sample_rate=24000,
        speed_ratio=1.0,
        emotion="",
        enable_timestamp=False,
    )
    session._ws = ws if ws is not None else AsyncMock()
    session._ws.closed = False
    session._ws_session_id = "mock_session_id"
    session._closed = closed
    session._receive_done = asyncio.Event()
    return session


class TestTTSSendText(unittest.IsolatedAsyncioTestCase):
    """send_text: 验证 TaskRequest 帧构建"""

    async def test_send_text_builds_task_request(self):
        """发送文本后，WS 应收到包含正确 session_id 和 text 的 TaskRequest 帧"""
        mock_ws = AsyncMock()
        mock_ws.closed = False
        session = _build_session(ws=mock_ws)

        await session.send_text("你好世界")

        mock_ws.send_bytes.assert_called_once()
        frame_bytes = mock_ws.send_bytes.call_args[0][0]

        parsed = parse_ws_frame(frame_bytes)
        self.assertEqual(parsed["event"], Event.TASK_REQUEST)
        payload = parsed["payload_json"]
        self.assertIsNotNone(payload)
        self.assertEqual(payload["req_params"]["text"], "你好世界")
        self.assertEqual(payload["event"], Event.TASK_REQUEST)
        self.assertEqual(payload["namespace"], "BidirectionalTTS")

        self.assertIn("session_id", parsed)
        self.assertEqual(parsed["session_id"], "mock_session_id")

    async def test_send_text_noop_when_closed(self):
        """session 已关闭时调用 send_text 不发送任何数据"""
        mock_ws = AsyncMock()
        mock_ws.closed = False
        session = _build_session(closed=True, ws=mock_ws)

        await session.send_text("不应该发送")

        mock_ws.send_bytes.assert_not_called()


class TestTTSFinish(unittest.IsolatedAsyncioTestCase):
    """finish: 验证 FinishSession 帧发送"""

    async def test_finish_sends_finish_session(self):
        """finish 应向 WS 发送 FinishSession 帧"""
        mock_ws = AsyncMock()
        mock_ws.closed = False
        session = _build_session(ws=mock_ws)
        session._receive_done.set()

        await session.finish()

        self.assertTrue(mock_ws.send_bytes.called)
        frame_bytes = mock_ws.send_bytes.call_args_list[0][0][0]
        parsed = parse_ws_frame(frame_bytes)
        self.assertEqual(parsed["event"], Event.FINISH_SESSION)


class TestTTSCleanup(unittest.IsolatedAsyncioTestCase):
    """_cleanup: FinishConnection 发送与幂等安全"""

    async def test_cleanup_sends_finish_connection(self):
        """_cleanup 应发送 FinishConnection 帧后关闭 WS"""
        mock_ws = AsyncMock()
        mock_ws.closed = False
        session = _build_session(ws=mock_ws)

        await session._cleanup()

        self.assertTrue(session._closed)
        sent_frames = [call[0][0] for call in mock_ws.send_bytes.call_args_list]
        self.assertTrue(len(sent_frames) >= 1, "至少应发送 FinishConnection 帧")
        parsed = parse_ws_frame(sent_frames[0])
        self.assertEqual(parsed["event"], Event.FINISH_CONNECTION)
        mock_ws.close.assert_called_once()

    async def test_cleanup_idempotent(self):
        """多次调用 _cleanup 不报错"""
        mock_ws = AsyncMock()
        mock_ws.closed = False
        session = _build_session(ws=mock_ws)

        await session._cleanup()
        self.assertTrue(session._closed)

        mock_ws.closed = True
        await session._cleanup()
        await session._cleanup()


class TestTTSTextLengthLimit(unittest.IsolatedAsyncioTestCase):
    """handle_tts_stream_text: 文本长度限制"""

    async def test_text_length_limit(self):
        """超过 _MAX_TEXT_CHARS_PER_REQUEST 的文本应被拒绝"""
        consumer = _make_consumer()
        svc = _make_svc()

        _, handle_text, _ = create_tts_stream_handler(consumer)

        session = _build_session()
        stream_id = session.stream_id
        session.owner_channel = consumer.channel_name

        from apps.services.common.ws.handlers import tts_stream as tts_mod
        tts_mod._active_tts_streams[stream_id] = session

        try:
            oversized_text = "A" * (_MAX_TEXT_CHARS_PER_REQUEST + 1)
            envelope = {
                "request_id": "req_test",
                "payload": {"stream_id": stream_id, "text": oversized_text},
            }

            await handle_text(envelope)

            consumer._send_error.assert_called_once()
            args = consumer._send_error.call_args
            self.assertEqual(args[0][0], "req_test")
            self.assertEqual(args[0][1], ERROR_SCHEMA_INVALID)
            self.assertIn("超限", args[0][2])
        finally:
            tts_mod._active_tts_streams.pop(stream_id, None)


if __name__ == "__main__":
    unittest.main()
