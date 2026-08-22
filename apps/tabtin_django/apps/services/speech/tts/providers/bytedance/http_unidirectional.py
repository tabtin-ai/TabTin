"""
字节跳动 V3 HTTP 单向流式 TTS

协议：POST https://openspeech.bytedance.com/api/v3/tts/unidirectional
认证：X-Api-App-Id, X-Api-Access-Key, X-Api-Resource-Id
响应：HTTP 流式 JSON（逐行，音频 base64 编码）
"""

from __future__ import annotations

import base64
import json
import logging
from typing import Any, AsyncGenerator, Optional

import aiohttp

from ....config_types import TTSProviderConfig
from ...base import BaseTTSService
from ...types import TTSChunk, TTSResult, TTSSentence, TTSWordTimestamp
from ...factory import TTSUpstreamError
from .base import (
    CODE_SUCCESS,
    DEFAULT_FORMAT,
    DEFAULT_SAMPLE_RATE,
    DEFAULT_SPEAKER,
    HTTP_UNIDIRECTIONAL_URL,
    RESOURCE_TTS_20,
    build_http_auth_headers,
    build_tts_request_params,
    new_connect_id,
    supports_subtitle_resource,
)

logger = logging.getLogger(__name__)


class ByteDanceHttpTTS(BaseTTSService):
    """字节跳动 V3 HTTP 单向流式 TTS"""

    def __init__(self, config: TTSProviderConfig):
        super().__init__(config)
        self.app_id: str = config.app_id
        self.access_token: str = config.access_token
        self.resource_id: str = config.resource_id or RESOURCE_TTS_20
        self.default_speaker: str = config.default_speaker or DEFAULT_SPEAKER

    async def synthesize(
        self,
        text: str,
        *,
        speaker: str = "",
        model: str = "",
        format: str = DEFAULT_FORMAT,
        sample_rate: int = DEFAULT_SAMPLE_RATE,
        speed_ratio: float = 1.0,
        volume_ratio: float = 1.0,
        pitch: int = 0,
        emotion: str = "",
        enable_timestamp: bool = False,
        **kwargs: Any,
    ) -> TTSResult:
        """完整合成（收集全部流式数据）"""
        self._raise_if_rate_limited()

        import time as _time
        _start = _time.monotonic()
        try:
            audio_chunks: list[bytes] = []
            sentences: list[TTSSentence] = []
            usage: dict[str, Any] = {}

            async for chunk in self.synthesize_stream(
                text,
                speaker=speaker,
                model=model,
                format=format,
                sample_rate=sample_rate,
                speed_ratio=speed_ratio,
                volume_ratio=volume_ratio,
                pitch=pitch,
                emotion=emotion,
                enable_timestamp=enable_timestamp,
                **kwargs,
            ):
                if chunk.audio_data:
                    audio_chunks.append(chunk.audio_data)
                if chunk.sentence:
                    sentences.append(chunk.sentence)

            full_audio = b"".join(audio_chunks)

            result = TTSResult(
                audio_data=full_audio,
                format=format,
                sample_rate=sample_rate,
                sentences=sentences,
                usage=usage,
                provider=self.provider_name,
                mode=self.mode,
            )
            self._report_call_result(
                success=True, latency_seconds=_time.monotonic() - _start,
            )
            return result
        except Exception as exc:
            self._report_call_result(
                success=False,
                latency_seconds=_time.monotonic() - _start,
                error_message=str(exc)[:500],
            )
            raise

    async def synthesize_stream(
        self,
        text: str,
        *,
        speaker: str = "",
        model: str = "",
        format: str = DEFAULT_FORMAT,
        sample_rate: int = DEFAULT_SAMPLE_RATE,
        speed_ratio: float = 1.0,
        volume_ratio: float = 1.0,
        pitch: int = 0,
        emotion: str = "",
        enable_timestamp: bool = False,
        **kwargs: Any,
    ) -> AsyncGenerator[TTSChunk, None]:
        """HTTP 流式合成（逐行 JSON）"""
        actual_speaker = speaker or self.default_speaker
        enable_subtitle = enable_timestamp and supports_subtitle_resource(self.resource_id)

        req_params = build_tts_request_params(
            text,
            speaker=actual_speaker,
            model=model,
            format=format,
            sample_rate=sample_rate,
            speed_ratio=speed_ratio,
            volume_ratio=volume_ratio,
            pitch=pitch,
            emotion=emotion,
            enable_timestamp=enable_timestamp and not enable_subtitle,
            enable_subtitle=enable_subtitle,
            **kwargs,
        )

        body: dict[str, Any] = {
            "user": {"uid": "tabtin"},
            "namespace": "BidirectionalTTS",
            "req_params": req_params,
        }

        headers = build_http_auth_headers(
            app_id=self.app_id,
            access_token=self.access_token,
            resource_id=self.resource_id,
            request_id=new_connect_id(),
        )

        timeout = aiohttp.ClientTimeout(total=self.timeout_seconds)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                HTTP_UNIDIRECTIONAL_URL,
                headers=headers,
                json=body,
            ) as resp:
                if resp.status != 200:
                    error_text = await resp.text()
                    raise TTSUpstreamError(
                        f"ByteDance HTTP TTS 失败: status={resp.status} body={error_text}"
                    )

                buffer = b""
                async for raw_chunk in resp.content.iter_any():
                    buffer += raw_chunk
                    while b"\n" in buffer:
                        line, buffer = buffer.split(b"\n", 1)
                        line = line.strip()
                        if not line:
                            continue
                        parsed = self._parse_stream_line(line)
                        if parsed is not None:
                            yield parsed

    def _parse_stream_line(self, line: bytes) -> Optional[TTSChunk]:
        """解析 HTTP 流式响应的单行 JSON"""
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            logger.warning("HTTP TTS: 无法解析行 %s", line[:200])
            return None

        code = obj.get("code", -1)

        if code == CODE_SUCCESS:
            return TTSChunk(audio_data=b"", is_last=True, event_type="done")

        if code != 0:
            error_msg = obj.get("message", "")
            logger.error("HTTP TTS 错误: code=%s msg=%s", code, error_msg)
            raise TTSUpstreamError(f"ByteDance HTTP TTS 错误: code={code} msg={error_msg}")

        audio_data = b""
        data_b64 = obj.get("data")
        if data_b64 and isinstance(data_b64, str):
            audio_data = base64.b64decode(data_b64)

        sentence = None
        sentence_obj = obj.get("sentence") or obj.get("subtitle")
        if sentence_obj:
            words = []
            for w in sentence_obj.get("words", []):
                words.append(TTSWordTimestamp(
                    word=w.get("word", ""),
                    start_time=float(w.get("startTime", 0)),
                    end_time=float(w.get("endTime", 0)),
                    confidence=float(w.get("confidence", 0)),
                ))
            sentence = TTSSentence(
                text=sentence_obj.get("text", ""),
                words=words,
            )

        event_type = "audio" if audio_data else "sentence"
        return TTSChunk(
            audio_data=audio_data,
            sentence=sentence,
            is_last=False,
            event_type=event_type,
        )

    def get_provider_info(self) -> dict[str, Any]:
        return {
            "provider": self.provider_name,
            "mode": "http",
            "protocol": "V3 HTTP Unidirectional",
            "resource_id": self.resource_id,
        }
