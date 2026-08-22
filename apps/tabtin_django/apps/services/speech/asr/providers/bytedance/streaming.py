"""
字节跳动 ASR WebSocket 流式版

支持三种 WebSocket 端点：
  - bigmodel: 双向流式（边说边出文字）
  - bigmodel_async: 双向流式优化版（仅结果变化时返回）
  - bigmodel_nostream: 流式输入模式（输入流式，返回句级结果）

协议：自定义二进制协议（4字节 header + payload）
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, AsyncGenerator, Optional

import aiohttp

from ...base import BaseASRService
from ....config_types import ASRProviderConfig
from ...types import ASRStreamEvent
from .base import (
    WS_BIGMODEL_NOSTREAM,
    WS_ENDPOINTS,
    RESOURCE_ID_SAUC_DURATION,
    build_audio_packet,
    build_auth_headers,
    build_full_client_request,
    build_ws_header,
    new_request_id,
    parse_stream_event,
    parse_ws_binary_frame,
)

logger = logging.getLogger(__name__)

DEFAULT_SEGMENT_DURATION_MS = 200
DEFAULT_SAMPLE_RATE = 16000


class ByteDanceStreamingASR(BaseASRService):
    """
    字节跳动 WebSocket 流式 ASR

    支持实时语音识别，通过 WebSocket 二进制协议分包发送音频。
    """

    def __init__(self, config: ASRProviderConfig):
        super().__init__(config)
        self.app_id: str = config.app_id
        self.access_token: str = config.access_token
        self.ws_endpoint: str = config.ws_endpoint or "bigmodel_async"
        self.ws_url: str = config.ws_url or WS_ENDPOINTS.get(self.ws_endpoint, WS_BIGMODEL_NOSTREAM)
        self.resource_id: str = config.resource_id or RESOURCE_ID_SAUC_DURATION
        self.segment_duration_ms: int = config.segment_duration_ms

    async def stream(
        self,
        audio_data: bytes,
        *,
        language: str = "",
        audio_format: str = "pcm",
        sample_rate: int = DEFAULT_SAMPLE_RATE,
        **kwargs: Any,
    ) -> AsyncGenerator[ASRStreamEvent, None]:
        """
        流式识别。

        Args:
            audio_data: 完整音频 bytes（WAV/PCM/OGG/MP3）
            language: 指定语言（仅 nostream 端点支持）
            audio_format: 格式 (pcm / wav / ogg / mp3)
            sample_rate: 采样率
            **kwargs: enable_itn, enable_punc, show_utterances 等
        """
        connect_id = new_request_id()
        headers = build_auth_headers(
            app_id=self.app_id,
            access_token=self.access_token,
            resource_id=self.resource_id,
            connect_id=connect_id,
        )

        session = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=self.timeout_seconds, connect=10),
        )
        try:
            ws = await session.ws_connect(self.ws_url, headers=headers)
            ws_resp = getattr(ws, "response", None) or getattr(ws, "_response", None)
            log_id = ws_resp.headers.get("X-Tt-Logid", "") if ws_resp else ""
            if log_id:
                logger.info("ByteDance ASR logid=%s connect_id=%s", log_id, connect_id)

            try:
                seq = 1

                full_request = self._build_full_client_request(
                    seq=seq,
                    language=language,
                    audio_format=audio_format,
                    sample_rate=sample_rate,
                    **kwargs,
                )
                await ws.send_bytes(full_request)
                seq += 1

                init_msg = await ws.receive()
                if init_msg.type == aiohttp.WSMsgType.BINARY:
                    init_resp = self._parse_server_response(init_msg.data)
                    if init_resp:
                        yield init_resp

                segment_size = self._calc_segment_size(
                    audio_format=audio_format,
                    sample_rate=sample_rate,
                )
                segments = self._split_audio(audio_data, segment_size)
                total = len(segments)

                async def sender():
                    nonlocal seq
                    for i, segment in enumerate(segments):
                        is_last = (i == total - 1)
                        packet = self._build_audio_packet(
                            seq=seq, segment=segment, is_last=is_last,
                        )
                        await ws.send_bytes(packet)
                        if not is_last:
                            seq += 1
                            await asyncio.sleep(self.segment_duration_ms / 1000)

                sender_task = asyncio.create_task(sender())

                try:
                    async for msg in ws:
                        if msg.type == aiohttp.WSMsgType.BINARY:
                            event = self._parse_server_response(msg.data)
                            if event:
                                yield event
                                if event.is_final:
                                    break
                        elif msg.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSED):
                            break
                finally:
                    sender_task.cancel()
                    try:
                        await sender_task
                    except asyncio.CancelledError:
                        pass

            finally:
                await ws.close()
        finally:
            await session.close()

    def get_supported_languages(self) -> list[str]:
        return [
            "auto", "zh", "en", "ja", "ko", "id", "es", "pt",
            "de", "fr", "fil", "ms", "th", "ar",
        ]

    # ── 二进制协议构建 ────────────────────────────────────────────

    @staticmethod
    def _build_header(
        message_type: int,
        flags: int,
        **kwargs: Any,
    ) -> bytes:
        return build_ws_header(message_type, flags, **kwargs)

    def _build_full_client_request(
        self,
        seq: int,
        language: str,
        audio_format: str,
        sample_rate: int,
        **kwargs: Any,
    ) -> bytes:
        return build_full_client_request(
            app_id=self.app_id,
            audio_format=audio_format,
            sample_rate=sample_rate,
            language=language,
            ws_endpoint=self.ws_endpoint,
            seq=seq,
            extra_params=kwargs,
        )

    def _build_audio_packet(
        self, seq: int, segment: bytes, is_last: bool = False,
    ) -> bytes:
        return build_audio_packet(seq=seq, segment=segment, is_last=is_last)

    @staticmethod
    def _parse_server_response(data: bytes) -> Optional[ASRStreamEvent]:
        """解析服务端二进制响应（委托给公共 parse_ws_binary_frame）"""
        parsed = parse_ws_binary_frame(data)
        if parsed is None:
            return None

        if "error" in parsed:
            logger.warning(
                "ByteDance WS ASR error: code=%s msg=%s",
                parsed.get("error_code"), parsed["error"],
            )
            return ASRStreamEvent(
                text="",
                is_final=True,
                error_code=parsed.get("error_code", 0),
                error_message=parsed["error"],
            )

        json_data = parsed.get("json_data")
        is_final = parsed.get("is_final", False)
        sequence = parsed.get("sequence", 0)

        if json_data is None:
            return ASRStreamEvent(text="", is_final=is_final, sequence=sequence)

        return parse_stream_event(json_data, is_final=is_final, sequence=sequence)

    def _calc_segment_size(
        self, audio_format: str, sample_rate: int,
    ) -> int:
        """计算每包音频的 byte 大小"""
        if audio_format in ("pcm", "wav"):
            bytes_per_sec = sample_rate * 2  # 16bit mono
            return bytes_per_sec * self.segment_duration_ms // 1000
        return 3200  # 默认 ~200ms

    @staticmethod
    def _split_audio(data: bytes, segment_size: int) -> list[bytes]:
        if segment_size <= 0:
            return [data]
        return [data[i:i + segment_size] for i in range(0, len(data), segment_size)]
