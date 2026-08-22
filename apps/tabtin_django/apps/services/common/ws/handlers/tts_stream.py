"""
TTS streaming handler — tts.stream.start / tts.stream.text / tts.stream.stop

前端通过 Gateway WebSocket 发送文本，后端代理连接到
字节跳动 WS 双向 TTS，将合成的音频实时推回前端。

协议流程：
  1. 前端发 tts.stream.start → 后端建立到 ByteDance 的 WS 连接
     → 返回 tts.stream.started (含 stream_id)
  2. 前端发 tts.stream.text (payload.text = 文本块)
     → 后端通过 TaskRequest 转发给 ByteDance
     → ByteDance 返回音频数据
     → 后端推 tts.stream.audio / tts.stream.sentence 给前端
  3. 前端发 tts.stream.stop → 后端发 FinishSession / FinishConnection
     → 最终 tts.stream.done
"""

from __future__ import annotations

import asyncio
import base64
import logging
import uuid
from typing import Any, Dict

import aiohttp
from asgiref.sync import sync_to_async

from apps.services.speech.exceptions import SpeechUpstreamError as _SpeechUpstreamError
from apps.services.speech.tts.providers.bytedance.base import (
    Event as _Event,
    MsgType as _MsgType,
    build_tts_request_params as _build_tts_request_params,
    build_ws_auth_headers as _build_ws_auth_headers,
    build_ws_frame as _build_ws_frame,
    new_connect_id as _new_connect_id,
    parse_ws_frame as _parse_ws_frame,
    supports_subtitle_resource as _supports_subtitle_resource,
    WS_BIDIRECTIONAL_URL as _WS_BIDIRECTIONAL_URL,
)

from ._base_stream import _BaseStreamSession, cleanup_streams_for_consumer
from ..protocol import (
    ERROR_CONNECTION_LIMIT,
    ERROR_INTERNAL,
    ERROR_PERMISSION_DENIED,
    ERROR_SCHEMA_INVALID,
    build_envelope,
)

logger = logging.getLogger(__name__)

_USER_FACING_ERRORS = {
    "config": "语音合成服务未配置，请联系管理员",
    "connect": "语音合成服务暂时不可用，请稍后重试",
    "internal": "语音合成内部错误，请稍后重试",
}

_active_tts_streams: dict[str, "_TTSStreamSession"] = {}
_MAX_CONCURRENT_TTS_STREAMS = 200
_MAX_TEXT_CHARS_PER_REQUEST = 10000


async def cleanup_tts_streams_for_consumer(channel_name: str) -> None:
    """Clean up all TTS stream sessions owned by a disconnecting consumer."""
    await cleanup_streams_for_consumer(_active_tts_streams, channel_name, "TTS WS")


def create_tts_stream_handler(consumer):
    """Factory: returns handlers for tts.stream.start / text / stop."""

    async def handle_tts_stream_start(envelope: Dict[str, Any]) -> None:
        request_id = envelope["request_id"]
        payload = envelope.get("payload", {})

        if len(_active_tts_streams) >= _MAX_CONCURRENT_TTS_STREAMS:
            await consumer._send_error(
                request_id, ERROR_CONNECTION_LIMIT,
                f"TTS 并发上限 ({_MAX_CONCURRENT_TTS_STREAMS}) 已达到，请稍后重试",
            )
            return

        stream_id = f"tts_{uuid.uuid4().hex[:12]}"

        try:
            from apps.services.speech.tts.factory import get_tts_service, TTSConfigError

            provider = payload.get("provider", "bytedance")
            svc = await sync_to_async(get_tts_service)(
                provider=provider, mode="ws_bidirectional",
            )
        except TTSConfigError as exc:
            logger.warning("[TTS WS] 配置错误: %s", exc)
            await consumer._send_error(request_id, ERROR_INTERNAL, _USER_FACING_ERRORS["config"])
            return
        except Exception as exc:
            logger.exception("[TTS WS] 获取 TTS 服务失败: %s", exc)
            await consumer._send_error(request_id, ERROR_INTERNAL, _USER_FACING_ERRORS["internal"])
            return

        session = _TTSStreamSession(
            stream_id=stream_id,
            consumer=consumer,
            svc=svc,
            speaker=payload.get("speaker", ""),
            model=payload.get("model", ""),
            format=payload.get("format", "mp3"),
            sample_rate=payload.get("sample_rate", 24000),
            speed_ratio=payload.get("speed_ratio", 1.0),
            emotion=payload.get("emotion", ""),
            enable_timestamp=payload.get("enable_timestamp", False),
        )

        _active_tts_streams[stream_id] = session

        try:
            await session.connect()
        except (
            aiohttp.WSServerHandshakeError,
            aiohttp.ClientError,
            asyncio.TimeoutError,
            _SpeechUpstreamError,
        ) as exc:
            logger.error("[TTS WS] connect 失败: %s stream_id=%s", exc, stream_id)
            _active_tts_streams.pop(stream_id, None)
            await session._cleanup()
            await consumer._send_error(request_id, ERROR_INTERNAL, _USER_FACING_ERRORS["connect"])
            return
        except Exception as exc:
            logger.exception("[TTS WS] connect 未知错误: %s stream_id=%s", exc, stream_id)
            _active_tts_streams.pop(stream_id, None)
            await session._cleanup()
            await consumer._send_error(request_id, ERROR_INTERNAL, _USER_FACING_ERRORS["internal"])
            return

        response = build_envelope(
            "tts.stream.started",
            request_id,
            {"stream_id": stream_id},
        )
        await consumer._send_envelope(response)

        consumer._track_task(asyncio.create_task(
            session.receive_loop()
        ))

    async def handle_tts_stream_text(envelope: Dict[str, Any]) -> None:
        request_id = envelope["request_id"]
        payload = envelope.get("payload", {})
        stream_id = payload.get("stream_id", "")

        session = _active_tts_streams.get(stream_id)
        if not session:
            await consumer._send_error(request_id, ERROR_SCHEMA_INVALID, "invalid stream_id")
            return
        if session.owner_channel != getattr(consumer, "channel_name", ""):
            await consumer._send_error(request_id, ERROR_PERMISSION_DENIED, "stream owned by another connection")
            return

        text = payload.get("text", "")
        if not text:
            return
        if len(text) > _MAX_TEXT_CHARS_PER_REQUEST:
            await consumer._send_error(
                request_id, ERROR_SCHEMA_INVALID,
                f"文本长度超限（最大 {_MAX_TEXT_CHARS_PER_REQUEST} 字符）",
            )
            return
        await session.send_text(text)

    async def handle_tts_stream_stop(envelope: Dict[str, Any]) -> None:
        request_id = envelope["request_id"]
        payload = envelope.get("payload", {})
        stream_id = payload.get("stream_id", "")

        session = _active_tts_streams.get(stream_id)
        if not session:
            await consumer._send_error(request_id, ERROR_SCHEMA_INVALID, "invalid stream_id")
            return
        if session.owner_channel != getattr(consumer, "channel_name", ""):
            await consumer._send_error(request_id, ERROR_PERMISSION_DENIED, "stream owned by another connection")
            return

        _active_tts_streams.pop(stream_id, None)
        await session.finish()

    return handle_tts_stream_start, handle_tts_stream_text, handle_tts_stream_stop


class _TTSStreamSession(_BaseStreamSession):
    """管理一次 TTS 流式会话：维护到字节跳动 WS 双向 TTS 的连接。"""

    _log_prefix = "TTS WS"
    _stream_error_event = "tts.stream.error"

    def __init__(
        self,
        stream_id: str,
        consumer: Any,
        svc: Any,
        speaker: str,
        model: str,
        format: str,
        sample_rate: int,
        speed_ratio: float,
        emotion: str,
        enable_timestamp: bool,
    ):
        super().__init__(stream_id, consumer, svc)
        self.speaker = speaker or svc.default_speaker
        self.model = model
        self.format = format
        self.sample_rate = sample_rate
        self.speed_ratio = speed_ratio
        self.emotion = emotion
        self.enable_timestamp = enable_timestamp
        self._ws_session_id: str = ""

    async def connect(self) -> None:
        """
        建立 WS 连接并完成 StartConnection + StartSession 握手。

        必须在 receive_loop 启动前调用，避免与 receive_loop 竞争
        WS 消息（ConnectionStarted / SessionStarted）。
        """
        connect_id = _new_connect_id()
        self._ws_session_id = _new_connect_id()

        headers = _build_ws_auth_headers(
            app_id=self.svc.app_id,
            access_token=self.svc.access_token,
            resource_id=self.svc.resource_id,
            connect_id=connect_id,
        )
        headers["X-Control-Require-Usage-Tokens-Return"] = "*"

        ws_timeout = getattr(self.svc, "timeout_seconds", 60)
        self._http_session = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=ws_timeout, connect=10),
        )
        self._ws = await self._http_session.ws_connect(_WS_BIDIRECTIONAL_URL, headers=headers)

        # 1) StartConnection → ConnectionStarted
        await self._ws.send_bytes(_build_ws_frame(
            _Event.START_CONNECTION, {"user": {"uid": "tabtin"}},
        ))
        self._expect_handshake_binary(_Event.CONNECTION_STARTED, await self._ws.receive())

        # 2) StartSession（不含 text）→ SessionStarted
        enable_subtitle = self.enable_timestamp and _supports_subtitle_resource(self.svc.resource_id)
        req_params = _build_tts_request_params(
            "",
            speaker=self.speaker,
            model=self.model,
            format=self.format,
            sample_rate=self.sample_rate,
            speed_ratio=self.speed_ratio,
            emotion=self.emotion,
            enable_timestamp=self.enable_timestamp and not enable_subtitle,
            enable_subtitle=enable_subtitle,
        )
        session_req_params = {k: v for k, v in req_params.items() if k != "text"}

        session_payload = {
            "user": {"uid": "tabtin"},
            "event": _Event.START_SESSION,
            "namespace": "BidirectionalTTS",
            "req_params": session_req_params,
        }
        await self._ws.send_bytes(_build_ws_frame(
            _Event.START_SESSION, session_payload,
            session_id=self._ws_session_id,
        ))
        self._expect_handshake_binary(_Event.SESSION_STARTED, await self._ws.receive())

    @staticmethod
    def _expect_handshake_binary(expected_event: int, msg: aiohttp.WSMessage) -> None:
        if msg.type == aiohttp.WSMsgType.BINARY:
            parsed = _parse_ws_frame(msg.data)
            if parsed["event"] != expected_event:
                raise _SpeechUpstreamError(
                    f"TTS WS 握手: 期望 event={expected_event}，收到 event={parsed['event']}"
                )
        else:
            raise _SpeechUpstreamError(
                f"TTS WS 握手: 收到意外消息类型 {msg.type}"
            )

    async def send_text(self, text: str) -> None:
        """发送文本块（TaskRequest）到 ByteDance TTS"""
        if self._closed or not self._ws:
            return

        task_payload = {
            "user": {"uid": "tabtin"},
            "event": _Event.TASK_REQUEST,
            "namespace": "BidirectionalTTS",
            "req_params": {"text": text},
        }
        await self._ws.send_bytes(_build_ws_frame(
            _Event.TASK_REQUEST, task_payload,
            session_id=self._ws_session_id,
        ))

    async def finish(self) -> None:
        """发送 FinishSession，等 receive_loop 自然退出后再清理。"""
        if self._closed or not self._ws:
            return

        try:
            await self._ws.send_bytes(_build_ws_frame(
                _Event.FINISH_SESSION, None,
                session_id=self._ws_session_id,
            ))
        except Exception:
            pass

        await self._wait_and_cleanup()

    async def _dispatch_binary(self, data: bytes) -> bool:
        """处理一个 TTS BINARY WS 帧。返回 True 继续接收，False 终止循环。"""
        parsed = _parse_ws_frame(data)
        msg_type = parsed["msg_type"]

        if msg_type == _MsgType.SERVER_ERROR:
            logger.warning(
                "[TTS WS] 上游错误: code=%s payload=%s stream_id=%s",
                parsed["error_code"], parsed.get("payload_json"), self.stream_id,
            )
            await self._send_event("tts.stream.error", {
                "stream_id": self.stream_id,
                "error": _USER_FACING_ERRORS["connect"],
            })
            return False

        if msg_type == _MsgType.SERVER_AUDIO_ONLY:
            audio_data = parsed.get("payload_bytes", b"")
            if audio_data:
                await self._send_event("tts.stream.audio", {
                    "stream_id": self.stream_id,
                    "data": base64.b64encode(audio_data).decode(),
                    "size": len(audio_data),
                })
            return True

        event = parsed["event"]

        if event == _Event.TTS_RESPONSE:
            audio_data = parsed.get("payload_bytes", b"")
            if audio_data:
                await self._send_event("tts.stream.audio", {
                    "stream_id": self.stream_id,
                    "data": base64.b64encode(audio_data).decode(),
                    "size": len(audio_data),
                })

        elif event == _Event.TTS_SENTENCE_START:
            payload_json = parsed.get("payload_json", {})
            await self._send_event("tts.stream.sentence", {
                "stream_id": self.stream_id,
                "event": "sentence_start",
                "text": (payload_json or {}).get("res_params", {}).get("text", ""),
            })

        elif event in (_Event.TTS_SENTENCE_END, _Event.TTS_SUBTITLE):
            payload_json = parsed.get("payload_json", {})
            await self._send_event("tts.stream.sentence", {
                "stream_id": self.stream_id,
                "event": "subtitle" if event == _Event.TTS_SUBTITLE else "sentence_end",
                "data": payload_json,
            })

        elif event == _Event.SESSION_FINISHED:
            await self._send_event("tts.stream.done", {
                "stream_id": self.stream_id,
                "usage": (parsed.get("payload_json") or {}).get("usage", {}),
            })
            return False

        elif event == _Event.SESSION_FAILED:
            logger.warning(
                "[TTS WS] 会话失败: payload=%s stream_id=%s",
                parsed.get("payload_json"), self.stream_id,
            )
            await self._send_event("tts.stream.error", {
                "stream_id": self.stream_id,
                "error": _USER_FACING_ERRORS["connect"],
            })
            return False

        return True

    async def _on_receive_error(self) -> None:
        await self._send_event("tts.stream.error", {
            "stream_id": self.stream_id,
            "error": _USER_FACING_ERRORS["internal"],
        })

    def _deregister(self) -> None:
        _active_tts_streams.pop(self.stream_id, None)

    async def _on_cleanup_ws(self) -> None:
        """TTS 特有：cleanup 前发送 FinishConnection 给 ByteDance。"""
        await self._ws.send_bytes(_build_ws_frame(
            _Event.FINISH_CONNECTION,
            {"user": {"uid": "tabtin"}},
        ))
