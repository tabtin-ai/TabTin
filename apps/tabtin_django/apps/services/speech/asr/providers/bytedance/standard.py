"""
字节跳动 ASR 标准版（Standard）

特点：
  - 异步 submit + query 两阶段
  - 音频时长 ≤ 5h，大小 ≤ 512MB
  - 支持 OPUS / WAV / MP3 / OGG / AMR / AAC / M4A
  - 支持说话人分离、情绪检测、性别检测、语种识别等高级能力
  - Resource ID: volc.bigasr.auc (v1) / volc.seedasr.auc (v2)
"""

from __future__ import annotations

import logging
import time
from typing import Any, Optional

import requests

from ...base import BaseASRService
from ....config_types import ASRProviderConfig
from ...types import ASRResult, ASRTaskStatus
from ...factory import ASRUpstreamError
from .base import (
    SUBMIT_URL,
    QUERY_URL,
    RESOURCE_ID_AUC_V1,
    RESOURCE_ID_AUC_V2,
    build_auth_headers,
    build_corpus_params,
    build_request_params,
    new_request_id,
    parse_asr_response,
    BYTEDANCE_STATUS_SUCCESS,
    BYTEDANCE_STATUS_PROCESSING,
    BYTEDANCE_STATUS_QUEUED,
    BYTEDANCE_STATUS_SILENT,
    resolve_status_code,
)

logger = logging.getLogger(__name__)


class ByteDanceStandardASR(BaseASRService):
    """
    字节跳动标准版 ASR

    异步处理：先 submit 提交音频 URL，再 query 查询结果。
    适合长音频（≤5h）和需要说话人分离等高级功能的场景。
    """

    def __init__(self, config: ASRProviderConfig):
        super().__init__(config)
        self.app_id: str = config.app_id
        self.access_token: str = config.access_token
        self.submit_url: str = config.submit_url or SUBMIT_URL
        self.query_url: str = config.query_url or QUERY_URL
        self.model_version: str = config.model_version
        # model_version "400" 对应字节跳动 SeedASR v2 (volc.seedasr.auc)，否则回退 v1 (volc.bigasr.auc)
        self.resource_id: str = config.resource_id or (
            RESOURCE_ID_AUC_V2 if self.model_version == "400" else RESOURCE_ID_AUC_V1
        )
        self.poll_interval: float = config.poll_interval
        self.poll_max_attempts: int = config.poll_max_attempts

    def submit(
        self,
        *,
        audio_url: str,
        language: str = "",
        audio_format: str = "mp3",
        callback_url: Optional[str] = None,
        callback_data: Optional[str] = None,
        **kwargs: Any,
    ) -> ASRTaskStatus:
        """
        提交识别任务（带限流检查）。

        Returns:
            ASRTaskStatus: status="queued" 且 task_id 可用于后续 query
        """
        self._raise_if_rate_limited()

        request_id = new_request_id()
        headers = build_auth_headers(
            app_id=self.app_id,
            access_token=self.access_token,
            resource_id=self.resource_id,
            request_id=request_id,
            sequence="-1",
        )

        request_params: dict[str, Any] = {"model_name": "bigmodel"}
        if self.model_version:
            request_params["model_version"] = self.model_version

        kwargs.setdefault("show_utterances", True)
        extra_params = build_request_params(**kwargs)
        request_params.update(extra_params)

        corpus = build_corpus_params(**kwargs)
        if corpus:
            request_params["corpus"] = corpus

        audio_payload: dict[str, Any] = {
            "url": audio_url,
            "format": audio_format,
        }
        if language:
            audio_payload["language"] = language

        body: dict[str, Any] = {
            "user": {"uid": self.app_id},
            "audio": audio_payload,
            "request": request_params,
        }

        if callback_url:
            body["callback"] = callback_url
        if callback_data:
            body["callback_data"] = callback_data

        logger.debug(
            "ByteDance Standard ASR submit: request_id=%s url=%s",
            request_id,
            audio_url,
        )

        response = requests.post(
            self.submit_url,
            json=body,
            headers=headers,
            timeout=self.timeout_seconds,
        )

        status_code = response.headers.get("X-Api-Status-Code", "")
        message = response.headers.get("X-Api-Message", "")
        log_id = response.headers.get("X-Tt-Logid", "")

        logger.debug(
            "ByteDance Standard ASR submit response: status=%s message=%s logid=%s",
            status_code,
            message,
            log_id,
        )

        if status_code != BYTEDANCE_STATUS_SUCCESS:
            error_msg = (
                f"ByteDance Standard ASR submit 失败: "
                f"code={status_code} msg={message} logid={log_id}"
            )
            logger.error(error_msg)
            return ASRTaskStatus(
                task_id=request_id,
                status="failed",
                error_code=int(status_code) if status_code.isdigit() else 0,
                error_message=error_msg,
                log_id=log_id,
            )

        return ASRTaskStatus(
            task_id=request_id,
            status="queued",
            log_id=log_id,
        )

    def query(self, task_id: str, **kwargs: Any) -> ASRTaskStatus:
        """查询识别任务结果。"""
        headers = build_auth_headers(
            app_id=self.app_id,
            access_token=self.access_token,
            resource_id=self.resource_id,
            request_id=task_id,
        )

        response = requests.post(
            self.query_url,
            json={},
            headers=headers,
            timeout=self.timeout_seconds,
        )

        status_code = response.headers.get("X-Api-Status-Code", "")
        message = response.headers.get("X-Api-Message", "")
        log_id = response.headers.get("X-Tt-Logid", "")

        mapped_status = resolve_status_code(status_code)

        if status_code == BYTEDANCE_STATUS_SUCCESS:
            data = response.json()
            result = parse_asr_response(data, provider="bytedance", mode="standard")
            return ASRTaskStatus(
                task_id=task_id,
                status="completed",
                result=result,
                log_id=log_id,
            )

        if status_code in (BYTEDANCE_STATUS_PROCESSING, BYTEDANCE_STATUS_QUEUED):
            return ASRTaskStatus(
                task_id=task_id,
                status=mapped_status,
                log_id=log_id,
            )

        if status_code == BYTEDANCE_STATUS_SILENT:
            return ASRTaskStatus(
                task_id=task_id,
                status="silent",
                result=ASRResult(
                    text="", provider="bytedance", mode="standard",
                    raw_response={"status_code": status_code, "message": "静音音频"},
                ),
                log_id=log_id,
            )

        return ASRTaskStatus(
            task_id=task_id,
            status="failed",
            error_code=int(status_code) if status_code.isdigit() else 0,
            error_message=f"code={status_code} msg={message}",
            log_id=log_id,
        )

    def recognize(
        self,
        *,
        audio_url: Optional[str] = None,
        audio_data: Optional[str] = None,
        language: str = "",
        audio_format: str = "mp3",
        **kwargs: Any,
    ) -> ASRResult:
        """
        同步便捷方法：内部自动 submit → 轮询 query → 返回结果（带调用结果上报）。
        适合后台任务（Celery task）调用，会阻塞直到完成。
        """
        import time as _time
        _start = _time.monotonic()
        if not audio_url:
            raise ValueError("标准版 recognize 需要 audio_url（不支持 base64 上传）")

        task_status = self.submit(
            audio_url=audio_url,
            language=language,
            audio_format=audio_format,
            **kwargs,
        )

        if task_status.status == "failed":
            raise ASRUpstreamError(
                f"ASR submit 失败: {task_status.error_message}"
            )

        for attempt in range(self.poll_max_attempts):
            time.sleep(self.poll_interval)

            task_status = self.query(task_status.task_id)

            if task_status.status == "completed":
                self._report_call_result(
                    success=True, latency_seconds=_time.monotonic() - _start,
                )
                return task_status.result  # type: ignore[return-value]

            if task_status.status in ("failed", "silent"):
                if task_status.result:
                    self._report_call_result(
                        success=task_status.status == "silent",
                        latency_seconds=_time.monotonic() - _start,
                        error_message=task_status.error_message[:500] if task_status.error_message else "",
                    )
                    return task_status.result
                self._report_call_result(
                    success=False,
                    latency_seconds=_time.monotonic() - _start,
                    error_message=task_status.error_message[:500] if task_status.error_message else "",
                )
                raise ASRUpstreamError(
                    f"ASR 任务失败: {task_status.error_message}"
                )

            logger.debug(
                "ASR task %s still %s (attempt %d/%d)",
                task_status.task_id,
                task_status.status,
                attempt + 1,
                self.poll_max_attempts,
            )

        self._report_call_result(
            success=False,
            latency_seconds=_time.monotonic() - _start,
            error_message="ASR 任务超时",
        )
        raise ASRUpstreamError(
            f"ASR 任务超时: task_id={task_status.task_id} "
            f"poll_attempts={self.poll_max_attempts}"
        )

    def get_supported_languages(self) -> list[str]:
        return [
            "auto", "zh", "en", "ja", "ko", "id", "es", "pt",
            "de", "fr", "fil", "ms", "th", "ar",
        ]
