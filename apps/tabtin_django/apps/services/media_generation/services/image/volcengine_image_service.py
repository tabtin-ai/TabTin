"""火山方舟 Seedream 图片生成服务。

方舟 ``/images/generations`` 同步返回临时图片 URL；适配到媒体任务的
submit → poll 契约时，submit 直接产出 succeeded 结果，由 API 层落库、计费和转存。
"""

from __future__ import annotations

import logging
import re
import uuid
from typing import Any, Dict

import requests

from ..base import BaseMediaService, MediaRequest, PollResult, SubmitResult
from ...errors import MediaErrorCode, MediaServiceError

logger = logging.getLogger(__name__)

_SIZE_PATTERN = re.compile(r"^\s*(\d+)\s*[*xX]\s*(\d+)\s*$")


class VolcengineImageService(BaseMediaService):
    """通过火山方舟 Seedream 生成图片。"""

    PROVIDER_NAME = "volcengine"
    _DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"
    _SUBMIT_PATH = "/images/generations"

    def __init__(self, provider_config: Dict[str, Any]):
        super().__init__(provider_config)
        base_url = (self.base_url or self._DEFAULT_BASE_URL).rstrip("/")
        self._submit_url = f"{base_url}{self._SUBMIT_PATH}"
        self._headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        # Seedream 5 Pro 的真实响应可能超过普通 API 默认超时。
        self._timeout = int(provider_config.get("timeout", 120))

    def submit_task(self, request: MediaRequest) -> SubmitResult:
        size = self._normalize_size(request.size)
        if request.negative_prompt:
            raise MediaServiceError(
                code=MediaErrorCode.INVALID_REQUEST,
                message="当前 Seedream 接入尚未验证 negative_prompt，不能安全透传",
            )
        try:
            image_count = int((request.extra_params or {}).get("n", 1))
        except (TypeError, ValueError) as exc:
            raise MediaServiceError(
                code=MediaErrorCode.INVALID_REQUEST,
                message="图片数量 n 必须是整数",
                provider_error=exc,
            ) from exc
        if image_count != 1:
            raise MediaServiceError(
                code=MediaErrorCode.INVALID_REQUEST,
                message="当前 Seedream 接入每次只支持生成 1 张图片",
            )

        body: Dict[str, Any] = {
            "model": request.model_name,
            "prompt": request.prompt,
            "response_format": "url",
            "n": image_count,
        }
        if size:
            body["size"] = size
        if request.seed is not None:
            body["seed"] = request.seed
        logger.info(
            "[Volcengine Image] 提交 Seedream 生图: model=%s size=%s prompt_length=%d",
            request.model_name,
            size or "provider_default",
            len(request.prompt),
        )

        try:
            response = requests.post(
                self._submit_url,
                json=body,
                headers=self._headers,
                timeout=self._timeout,
            )
            try:
                data = response.json()
            except ValueError as exc:
                raise MediaServiceError(
                    code=MediaErrorCode.API_ERROR,
                    message="火山方舟返回了非 JSON 响应",
                    status_code=response.status_code,
                    provider_error=exc,
                ) from exc

            if response.status_code != 200:
                error = data.get("error") if isinstance(data, dict) else None
                error_code = (
                    error.get("code", "API_ERROR")
                    if isinstance(error, dict)
                    else "API_ERROR"
                )
                error_message = (
                    error.get("message", response.text)
                    if isinstance(error, dict)
                    else response.text
                )
                raise MediaServiceError(
                    code=self._map_error_code(error_code),
                    message=error_message,
                    status_code=response.status_code,
                    error_details=data if isinstance(data, dict) else None,
                )

            urls = self._extract_urls(data)
            if not urls:
                raise MediaServiceError(
                    code=MediaErrorCode.API_ERROR,
                    message="火山方舟未返回图片 URL",
                    error_details=data if isinstance(data, dict) else None,
                )

            provider_task_id = (
                str(data.get("id") or data.get("request_id") or uuid.uuid4())
                if isinstance(data, dict)
                else str(uuid.uuid4())
            )
            logger.info(
                "[Volcengine Image] Seedream 生图完成: model=%s result_count=%d request_id=%s",
                request.model_name,
                len(urls),
                provider_task_id,
            )
            return SubmitResult(
                provider_task_id=provider_task_id,
                status="succeeded",
                metadata={
                    "result_urls": urls,
                    "request_id": provider_task_id,
                    "effective_size": size,
                },
            )
        except MediaServiceError:
            raise
        except requests.Timeout as exc:
            raise MediaServiceError(
                code=MediaErrorCode.TIMEOUT,
                message="火山方舟 Seedream 请求超时",
                provider_error=exc,
                retryable=True,
            ) from exc
        except requests.RequestException as exc:
            raise MediaServiceError(
                code=MediaErrorCode.PROVIDER_DOWN,
                message=f"火山方舟 Seedream 请求失败: {exc}",
                provider_error=exc,
                retryable=True,
            ) from exc

    def poll_task(self, provider_task_id: str) -> PollResult:
        """Seedream 在 submit 时已返回图片 URL，不应进入异步轮询。"""
        return PollResult(
            status="failed",
            error_code=MediaErrorCode.SERVICE_ERROR,
            error_message=(
                "Seedream 同步生成结果未在提交阶段落库，无法按 provider_task_id 重新查询"
            ),
        )

    def _normalize_size(self, requested_size: str) -> str:
        """规范化 ``1024*1024`` / ``1024x1024``，并执行模型声明的最小像素约束。"""
        if not requested_size:
            return ""

        match = _SIZE_PATTERN.match(requested_size)
        if not match:
            return requested_size

        width, height = (int(value) for value in match.groups())
        min_pixels = self._minimum_pixels()
        if min_pixels and width * height < min_pixels:
            raise MediaServiceError(
                code=MediaErrorCode.INVALID_REQUEST,
                message=(
                    f"当前模型要求图片至少 {min_pixels} 像素，"
                    f"{width}x{height} 仅有 {width * height} 像素；"
                    "请提高分辨率并保持所需宽高比"
                ),
            )
        return f"{width}x{height}"

    def _minimum_pixels(self) -> int:
        capabilities = getattr(self.model_obj, "capabilities_config", {}) or {}
        media_gen = capabilities.get("media_gen", {})
        try:
            return max(0, int(media_gen.get("min_pixels", 0)))
        except (TypeError, ValueError):
            return 0

    @staticmethod
    def _extract_urls(data: Any) -> list[str]:
        if not isinstance(data, dict):
            return []
        items = data.get("data", [])
        if not isinstance(items, list):
            return []
        return [
            item["url"]
            for item in items
            if isinstance(item, dict) and isinstance(item.get("url"), str) and item["url"]
        ]

    @staticmethod
    def _map_error_code(provider_code: str) -> str:
        normalized = provider_code.lower()
        if "auth" in normalized or "apikey" in normalized or "accessdenied" in normalized:
            return MediaErrorCode.AUTH_FAILED
        if "quota" in normalized or "balance" in normalized:
            return MediaErrorCode.QUOTA_EXCEEDED
        if "rate" in normalized or "throttle" in normalized:
            return MediaErrorCode.RATE_LIMIT
        if "model" in normalized and "not" in normalized:
            return MediaErrorCode.MODEL_NOT_FOUND
        if "parameter" in normalized or "invalid" in normalized:
            return MediaErrorCode.INVALID_REQUEST
        if "content" in normalized or "safety" in normalized:
            return MediaErrorCode.CONTENT_FILTERED
        if "timeout" in normalized:
            return MediaErrorCode.TIMEOUT
        if "server" in normalized or "internal" in normalized:
            return MediaErrorCode.PROVIDER_DOWN
        return MediaErrorCode.API_ERROR
