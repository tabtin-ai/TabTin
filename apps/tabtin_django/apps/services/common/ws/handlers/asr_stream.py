"""
ASR streaming handler — asr.stream.start / asr.stream.audio / asr.stream.stop

前端通过 Gateway WebSocket 发送音频数据，后端作为代理连接到
字节跳动 WebSocket ASR，将识别结果实时推回前端。

协议流程：
  1. 前端发 asr.stream.start → 后端建立到 ByteDance 的 WS 连接
     → 返回 asr.stream.started (含 stream_id)
  2. 前端发 asr.stream.audio (payload.data = base64 音频块)
     → 后端转发给 ByteDance
     → ByteDance 返回识别结果
     → 后端推 asr.stream.event 给前端
  3. 前端发 asr.stream.stop → 后端发最后一包并关闭
     → 最终结果 asr.stream.done
"""

from __future__ import annotations

import asyncio
import base64
import logging
import uuid
from typing import Any, Dict, Optional

import aiohttp
from asgiref.sync import sync_to_async

from apps.services.speech.exceptions import SpeechUpstreamError as _SpeechUpstreamError

from apps.services.speech.asr.providers.bytedance.base import (
    build_audio_packet,
    build_auth_headers,
    build_full_client_request,
    new_request_id,
    parse_stream_event,
    parse_ws_binary_frame,
)

from ._base_stream import _BaseStreamSession, cleanup_streams_for_consumer
from ..protocol import (
    ERROR_CONNECTION_LIMIT,
    ERROR_PERMISSION_DENIED,
    ERROR_SCHEMA_INVALID,
    ERROR_INTERNAL,
    build_envelope,
)

logger = logging.getLogger(__name__)

_active_streams: dict[str, "_ASRStreamSession"] = {}
_MAX_CONCURRENT_STREAMS = 200
_MAX_AUDIO_CHUNK_BYTES = 1 * 1024 * 1024  # 1 MB per chunk
_UPSTREAM_IDLE_TIMEOUT_CODE = 45000081

_USER_FACING_ERRORS = {
    "config": "语音识别服务未配置，请联系管理员",
    "connect": "语音识别服务暂时不可用，请稍后重试",
    "internal": "语音识别内部错误，请稍后重试",
}


async def cleanup_asr_streams_for_consumer(channel_name: str) -> None:
    """Clean up all ASR stream sessions owned by a disconnecting consumer."""
    await cleanup_streams_for_consumer(_active_streams, channel_name, "ASR WS")


def create_asr_stream_handler(consumer):
    """Factory: returns handlers for asr.stream.start / audio / stop."""

    async def handle_asr_stream_start(envelope: Dict[str, Any]) -> None:
        request_id = envelope["request_id"]
        payload = envelope.get("payload", {})

        if len(_active_streams) >= _MAX_CONCURRENT_STREAMS:
            await consumer._send_error(
                request_id, ERROR_CONNECTION_LIMIT,
                f"ASR 并发上限 ({_MAX_CONCURRENT_STREAMS}) 已达到，请稍后重试",
            )
            return

        stream_id = f"asr_{uuid.uuid4().hex[:12]}"

        from apps.services.speech.asr.factory import (
            get_asr_service, ASRConfigError, VALID_WS_ENDPOINTS,
        )

        provider = payload.get("provider", "bytedance")
        ws_endpoint = payload.get("ws_endpoint", "bigmodel_async")
        if ws_endpoint not in VALID_WS_ENDPOINTS:
            await consumer._send_error(
                request_id, ERROR_SCHEMA_INVALID,
                f"无效的 ws_endpoint: {ws_endpoint}，可选: {sorted(VALID_WS_ENDPOINTS)}",
            )
            return

        _ALLOWED_EXTRA_PARAMS = frozenset({
            "enable_itn", "enable_punc", "enable_ddc",
            "show_utterances", "enable_nonstream", "result_type",
            "enable_accelerate_text", "accelerate_score",
            "vad_segment_duration", "end_window_size", "force_to_speech_time",
            "sensitive_words_filter",
            "show_speech_rate", "show_volume",
            "enable_lid", "enable_emotion_detection", "enable_gender_detection",
            "enable_poi_fc", "enable_music_fc",
            "context", "boosting_table_name", "boosting_table_id",
            "correct_table_name", "correct_table_id",
        })

        extra_params = {
            k: v for k, v in payload.items() if k in _ALLOWED_EXTRA_PARAMS
        }

        if extra_params.get("enable_nonstream") and ws_endpoint != "bigmodel_async":
            await consumer._send_error(
                request_id, ERROR_SCHEMA_INVALID,
                "enable_nonstream 仅支持 bigmodel_async 端点",
            )
            return

        try:
            svc = await sync_to_async(get_asr_service)(
                provider=provider,
                mode="streaming",
                config=None,
                config_overrides={"ws_endpoint": ws_endpoint},
            )
        except ASRConfigError as exc:
            logger.warning("[ASR WS] 配置错误: %s", exc)
            await consumer._send_error(
                request_id, ERROR_INTERNAL, _USER_FACING_ERRORS["config"],
            )
            return
        except Exception as exc:
            logger.exception("[ASR WS] 获取 ASR 服务失败: %s", exc)
            await consumer._send_error(
                request_id, ERROR_INTERNAL, _USER_FACING_ERRORS["internal"],
            )
            return

        session = _ASRStreamSession(
            stream_id=stream_id,
            consumer=consumer,
            svc=svc,
            language=payload.get("language", ""),
            audio_format=payload.get("audio_format", "pcm"),
            sample_rate=payload.get("sample_rate", 16000),
            ws_endpoint=ws_endpoint,
            extra_params=extra_params,
        )

        _active_streams[stream_id] = session

        try:
            await session.connect()
        except (
            aiohttp.WSServerHandshakeError,
            aiohttp.ClientError,
            asyncio.TimeoutError,
            _SpeechUpstreamError,
        ) as exc:
            logger.error("[ASR WS] connect 失败: %s stream_id=%s", exc, stream_id)
            _active_streams.pop(stream_id, None)
            await session._cleanup()
            await consumer._send_error(
                request_id, ERROR_INTERNAL, _USER_FACING_ERRORS["connect"],
            )
            return
        except Exception as exc:
            logger.exception("[ASR WS] connect 未知错误: %s stream_id=%s", exc, stream_id)
            _active_streams.pop(stream_id, None)
            await session._cleanup()
            await consumer._send_error(
                request_id, ERROR_INTERNAL, _USER_FACING_ERRORS["internal"],
            )
            return

        response = build_envelope(
            "asr.stream.started",
            request_id,
            {"stream_id": stream_id},
        )
        await consumer._send_envelope(response)

        consumer._track_task(asyncio.create_task(
            session.receive_loop()
        ))

    async def handle_asr_stream_audio(envelope: Dict[str, Any]) -> None:
        request_id = envelope["request_id"]
        payload = envelope.get("payload", {})
        stream_id = payload.get("stream_id", "")

        session = _active_streams.get(stream_id)
        if not session:
            await consumer._send_error(request_id, ERROR_SCHEMA_INVALID, "invalid stream_id")
            return
        if session.owner_channel != getattr(consumer, "channel_name", ""):
            await consumer._send_error(request_id, ERROR_PERMISSION_DENIED, "stream owned by another connection")
            return

        audio_b64 = payload.get("data", "")
        if not audio_b64:
            return

        try:
            audio_bytes = base64.b64decode(audio_b64)
        except Exception:
            await consumer._send_error(request_id, ERROR_SCHEMA_INVALID, "invalid base64 audio data")
            return

        if len(audio_bytes) > _MAX_AUDIO_CHUNK_BYTES:
            await consumer._send_error(
                request_id, ERROR_SCHEMA_INVALID,
                f"音频块大小超限（最大 {_MAX_AUDIO_CHUNK_BYTES // 1024} KB）",
            )
            return

        is_last = payload.get("is_last", False)
        await session.send_audio(audio_bytes, is_last=is_last)

    async def handle_asr_stream_stop(envelope: Dict[str, Any]) -> None:
        request_id = envelope["request_id"]
        payload = envelope.get("payload", {})
        stream_id = payload.get("stream_id", "")

        session = _active_streams.get(stream_id)
        if not session:
            await consumer._send_error(request_id, ERROR_SCHEMA_INVALID, "invalid stream_id")
            return
        if session.owner_channel != getattr(consumer, "channel_name", ""):
            await consumer._send_error(request_id, ERROR_PERMISSION_DENIED, "stream owned by another connection")
            return

        _active_streams.pop(stream_id, None)
        await session.close()

    return handle_asr_stream_start, handle_asr_stream_audio, handle_asr_stream_stop


class _ASRStreamSession(_BaseStreamSession):
    """管理一次 ASR 流式会话：维护到字节跳动的 WS 连接和状态。"""

    _log_prefix = "ASR WS"
    _stream_error_event = "asr.stream.error"

    def __init__(
        self,
        stream_id: str,
        consumer: Any,
        svc: Any,
        language: str,
        audio_format: str,
        sample_rate: int,
        ws_endpoint: str,
        extra_params: dict,
    ):
        super().__init__(stream_id, consumer, svc)
        self.language = language
        self.audio_format = audio_format
        self.sample_rate = sample_rate
        self.ws_endpoint = ws_endpoint
        self.extra_params = extra_params
        self.seq = 1
        self.log_id: str = ""

    async def connect(self) -> None:
        connect_id = new_request_id()
        headers = build_auth_headers(
            app_id=self.svc.app_id,
            access_token=self.svc.access_token,
            resource_id=self.svc.resource_id,
            connect_id=connect_id,
        )

        ws_timeout = getattr(self.svc, "timeout_seconds", 300)
        self._http_session = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=ws_timeout, connect=10),
        )
        self._ws = await self._http_session.ws_connect(self.svc.ws_url, headers=headers)

        ws_resp = getattr(self._ws, "response", None) or getattr(self._ws, "_response", None)
        if ws_resp:
            self.log_id = ws_resp.headers.get("X-Tt-Logid", "")
        if self.log_id:
            logger.info(
                "[ASR WS] connected logid=%s connect_id=%s stream_id=%s",
                self.log_id, connect_id, self.stream_id,
            )

        packet = build_full_client_request(
            app_id=self.svc.app_id,
            audio_format=self.audio_format,
            sample_rate=self.sample_rate,
            language=self.language,
            ws_endpoint=self.ws_endpoint,
            seq=self.seq,
            extra_params=self.extra_params,
        )
        self.seq += 1

        await self._ws.send_bytes(packet)

        init_msg = await self._ws.receive()
        if init_msg.type == aiohttp.WSMsgType.BINARY:
            parsed = parse_ws_binary_frame(init_msg.data)
            if parsed and "error" in parsed:
                raise _SpeechUpstreamError(
                    f"ASR 上游初始化错误: code={parsed.get('error_code')}"
                )
            logger.debug("[ASR WS] init response received, stream_id=%s", self.stream_id)
        else:
            raise _SpeechUpstreamError(
                f"ASR WS 握手阶段收到意外消息类型: {init_msg.type}"
            )

    async def send_audio(self, audio_bytes: bytes, is_last: bool = False) -> None:
        if self._closed or not self._ws:
            return

        packet = build_audio_packet(seq=self.seq, segment=audio_bytes, is_last=is_last)
        if not is_last:
            self.seq += 1

        try:
            await self._ws.send_bytes(packet)
        except Exception as exc:
            logger.warning("[ASR WS] send_audio failed: %s", exc)

    async def _dispatch_binary(self, data: bytes) -> bool:
        """处理一个 ASR BINARY WS 帧。返回 True 继续接收，False 终止循环。"""
        event = self._parse_response(data)
        if not event:
            return True

        if event.get("error"):
            log = logger.debug if event.get("error_code") == _UPSTREAM_IDLE_TIMEOUT_CODE else logger.warning
            log(
                "[ASR WS] 上游错误: code=%s msg=%s stream_id=%s logid=%s",
                event.get("error_code"), event.get("error"),
                self.stream_id, self.log_id,
            )
            await self._send_event("asr.stream.error", {
                "stream_id": self.stream_id,
                "error": _USER_FACING_ERRORS["connect"],
                "isFinal": True,
            })
            return False

        is_final = event.get("isFinal", False)
        msg_type = "asr.stream.done" if is_final else "asr.stream.event"
        await self._send_event(msg_type, {
            "stream_id": self.stream_id,
            **event,
        })

        return not is_final

    async def _on_receive_error(self) -> None:
        await self._send_event("asr.stream.error", {
            "stream_id": self.stream_id,
            "error": _USER_FACING_ERRORS["internal"],
            "isFinal": True,
        })

    def _deregister(self) -> None:
        _active_streams.pop(self.stream_id, None)

    async def close(self) -> None:
        """发送最后空包，等 receive_loop 自然退出后再清理。"""
        if self._closed or not self._ws:
            return

        try:
            packet = build_audio_packet(seq=self.seq, segment=b"", is_last=True)
            await self._ws.send_bytes(packet)
        except Exception:
            pass

        await self._wait_and_cleanup()

    @staticmethod
    def _parse_response(data: bytes) -> Optional[dict]:
        """解析字节跳动 WS 二进制响应，输出归一化 camelCase 格式（与 HTTP API 一致）"""
        parsed = parse_ws_binary_frame(data)
        if parsed is None:
            return None

        if "error" in parsed:
            return parsed

        json_data = parsed.get("json_data")
        is_final = parsed.get("is_final", False)
        sequence = parsed.get("sequence", 0)

        event = parse_stream_event(
            json_data or {},
            is_final=is_final,
            sequence=sequence,
        )
        return event.to_dict()
