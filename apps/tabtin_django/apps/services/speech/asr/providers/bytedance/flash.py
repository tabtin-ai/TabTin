"""
字节跳动 ASR 极速版（Flash）

特点：
  - 单次 HTTP POST，同步返回识别结果
  - 音频时长 ≤ 2h，大小 ≤ 100MB
  - 支持 WAV / MP3 / OGG OPUS
  - Resource ID: volc.bigasr.auc_turbo
  - 请求字段同标准版，但移除 callback 和客服相关能力
"""

from __future__ import annotations

import base64
import logging
from typing import Any, Optional

import requests

from ...base import BaseASRService
from ....config_types import ASRProviderConfig
from ...types import ASRResult
from ...factory import ASRUpstreamError
from .base import (
    FLASH_URL,
    RESOURCE_ID_FLASH,
    build_auth_headers,
    build_corpus_params,
    build_request_params,
    new_request_id,
    parse_asr_response,
    BYTEDANCE_STATUS_SUCCESS,
    BYTEDANCE_STATUS_SILENT,
)

logger = logging.getLogger(__name__)


class ByteDanceFlashASR(BaseASRService):
    """
    字节跳动极速版 ASR

    一次请求即返回识别结果，适合 ≤2h 的音频文件。
    支持通过 audio_url（OSS 链接）或 audio_data（base64）输入。
    """

    def __init__(self, config: ASRProviderConfig):
        super().__init__(config)
        self.app_id: str = config.app_id
        self.access_token: str = config.access_token
        self.base_url: str = config.base_url or FLASH_URL
        self.resource_id: str = config.resource_id or RESOURCE_ID_FLASH

    def recognize(
        self,
        *,
        audio_url: Optional[str] = None,
        audio_data: Optional[str] = None,
        audio_bytes: Optional[bytes] = None,
        language: str = "",
        audio_format: str = "mp3",
        **kwargs: Any,
    ) -> ASRResult:
        """
        极速版同步识别（带限流检查 + 调用结果上报）。

        Args:
            audio_url: 音频文件可访问 URL（与 audio_data/audio_bytes 三选一）
            audio_data: base64 编码的音频内容
            audio_bytes: 原始音频 bytes（自动转 base64）
            language: 指定语言代码（空 = 自动检测中英文+方言）
            audio_format: 音频格式 (wav / mp3 / ogg)
            **kwargs: 字节跳动 ASR 参数（enable_itn, enable_punc, enable_ddc 等）
        """
        self._raise_if_rate_limited()

        import time as _time
        _start = _time.monotonic()

        request_id = new_request_id()
        headers = build_auth_headers(
            app_id=self.app_id,
            access_token=self.access_token,
            resource_id=self.resource_id,
            request_id=request_id,
            sequence="-1",
        )

        audio_payload = self._build_audio_payload(
            audio_url=audio_url,
            audio_data=audio_data,
            audio_bytes=audio_bytes,
        )

        request_params = {"model_name": "bigmodel"}
        extra_params = build_request_params(**kwargs)
        request_params.update(extra_params)

        corpus = build_corpus_params(**kwargs)
        if corpus:
            request_params["corpus"] = corpus

        body: dict[str, Any] = {
            "user": {"uid": self.app_id},
            "audio": audio_payload,
            "request": request_params,
        }

        if language:
            body["audio"]["language"] = language

        logger.debug(
            "ByteDance Flash ASR: request_id=%s url=%s",
            request_id,
            audio_url or "<base64>",
        )

        response = requests.post(
            self.base_url,
            json=body,
            headers=headers,
            timeout=self.timeout_seconds,
        )

        status_code = response.headers.get("X-Api-Status-Code", "")
        message = response.headers.get("X-Api-Message", "")
        log_id = response.headers.get("X-Tt-Logid", "")

        logger.debug(
            "ByteDance Flash ASR response: status=%s message=%s logid=%s",
            status_code,
            message,
            log_id,
        )

        if status_code == BYTEDANCE_STATUS_SILENT:
            return ASRResult(
                text="",
                provider="bytedance",
                mode="flash",
                raw_response={"status_code": status_code, "message": "静音音频"},
            )

        if status_code != BYTEDANCE_STATUS_SUCCESS:
            error_msg = f"ByteDance Flash ASR 失败: code={status_code} msg={message} logid={log_id}"
            logger.error(error_msg)
            self._report_call_result(
                success=False,
                latency_seconds=_time.monotonic() - _start,
                error_message=error_msg[:500],
            )
            raise ASRUpstreamError(error_msg)

        data = response.json()
        result = parse_asr_response(data, provider="bytedance", mode="flash")
        self._report_call_result(
            success=True, latency_seconds=_time.monotonic() - _start,
        )
        return result

    def get_supported_languages(self) -> list[str]:
        return [
            "auto", "zh", "en", "ja", "ko", "id", "es", "pt",
            "de", "fr", "fil", "ms", "th", "ar",
        ]

    @staticmethod
    def _build_audio_payload(
        *,
        audio_url: Optional[str] = None,
        audio_data: Optional[str] = None,
        audio_bytes: Optional[bytes] = None,
    ) -> dict[str, str]:
        if audio_url:
            return {"url": audio_url}
        if audio_data:
            return {"data": audio_data}
        if audio_bytes:
            return {"data": base64.b64encode(audio_bytes).decode("utf-8")}
        raise ValueError("必须提供 audio_url、audio_data 或 audio_bytes 其中之一")
