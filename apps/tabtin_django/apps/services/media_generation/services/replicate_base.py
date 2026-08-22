"""
Replicate 服务公共基类

封装 Replicate predictions API 的通用逻辑：认证、异步提交、轮询、取消、错误映射。
子类只需实现 submit_task() 和 _extract_result_urls() 即可。
"""

import logging
import requests
from abc import abstractmethod
from typing import Any, Dict, List

from apps.i18n import _
from .base import BaseMediaService, MediaRequest, SubmitResult, PollResult
from ..errors import MediaErrorCode, MediaServiceError

logger = logging.getLogger(__name__)

_STATUS_MAP = {
    "starting": "pending",
    "processing": "running",
    "succeeded": "succeeded",
    "failed": "failed",
    "canceled": "cancelled",
}


class BaseReplicateService(BaseMediaService):
    """Replicate predictions API 公共基类"""

    PROVIDER_NAME = "replicate"

    def __init__(self, provider_config: Dict[str, Any]):
        super().__init__(provider_config)
        self._base_url = (self.base_url or "https://api.replicate.com/v1").rstrip("/")
        self._timeout = provider_config.get("timeout", 60)

    def _build_headers(self) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    def _get_version_hash(self, extra_params: Dict[str, Any] | None = None) -> str | None:
        """从 model capabilities_config 或 extra_params 获取 version hash。"""
        caps = {}
        if self.model_obj:
            caps = getattr(self.model_obj, "capabilities_config", None) or {}
        extra = extra_params or {}
        return caps.get("version") or extra.get("version")

    def _submit_prediction(
        self, model_ref: str, input_data: Dict[str, Any],
        extra_params: Dict[str, Any] | None, log_tag: str,
    ) -> SubmitResult:
        """向 Replicate 提交预测任务的公共逻辑。"""
        version_hash = self._get_version_hash(extra_params)

        if version_hash:
            url = f"{self._base_url}/predictions"
            body: Dict[str, Any] = {"version": version_hash, "input": input_data}
        else:
            url = f"{self._base_url}/models/{model_ref}/predictions"
            body = {"input": input_data}

        try:
            resp = requests.post(
                url, json=body, headers=self._build_headers(), timeout=self._timeout,
            )
            data = resp.json()

            if resp.status_code not in (200, 201):
                error_msg = data.get("detail", data.get("title", resp.text))
                logger.error("[%s] 提交失败: %s - %s", log_tag, resp.status_code, error_msg)
                raise MediaServiceError(
                    code=self._map_replicate_error(resp.status_code, data),
                    message=str(error_msg),
                    status_code=resp.status_code,
                    error_details=data,
                )

            prediction_id = data.get("id", "")
            if not prediction_id:
                raise MediaServiceError(
                    code=MediaErrorCode.API_ERROR,
                    message="Replicate 未返回 prediction id",
                    error_details=data,
                )

            logger.info("[%s] 任务已提交: prediction_id=%s", log_tag, prediction_id)
            return SubmitResult(
                provider_task_id=prediction_id,
                status=_STATUS_MAP.get(data.get("status", "starting"), "pending"),
                metadata={
                    "get_url": data.get("urls", {}).get("get", ""),
                    "cancel_url": data.get("urls", {}).get("cancel", ""),
                },
            )

        except MediaServiceError:
            raise
        except requests.Timeout:
            raise MediaServiceError(
                code=MediaErrorCode.TIMEOUT, message="Replicate 请求超时", retryable=True,
            )
        except Exception as exc:
            logger.exception("[%s] 提交异常: %s", log_tag, exc)
            raise MediaServiceError(
                code=MediaErrorCode.API_ERROR, message=str(exc), provider_error=exc,
            )

    def poll_task(self, provider_task_id: str) -> PollResult:
        log_tag = f"Replicate {self._media_type}"
        url = f"{self._base_url}/predictions/{provider_task_id}"

        try:
            resp = requests.get(
                url, headers=self._build_headers(), timeout=self._timeout,
            )
            data = resp.json()

            if resp.status_code != 200:
                return PollResult(
                    status="failed",
                    error_code="API_ERROR",
                    error_message=data.get("detail", resp.text),
                )

            raw_status = data.get("status", "")
            status = _STATUS_MAP.get(raw_status, "running")

            if status == "failed":
                return PollResult(
                    status="failed",
                    error_code="PREDICTION_FAILED",
                    error_message=data.get("error", "Prediction failed"),
                )

            result_urls: List[str] = []
            if status == "succeeded":
                result_urls = self._extract_result_urls(data.get("output"))
                if not result_urls:
                    return PollResult(
                        status="failed",
                        error_code="NO_OUTPUT",
                        error_message=f"Replicate 返回成功但无{self._media_type} URL",
                    )

            metadata: Dict[str, Any] = {}
            metrics = data.get("metrics")
            if metrics:
                metadata["metrics"] = metrics
                if metrics.get("predict_time"):
                    metadata["task_metrics"] = {"duration": metrics["predict_time"]}

            return PollResult(
                status=status,
                result_urls=result_urls,
                metadata=metadata,
            )

        except requests.Timeout:
            return PollResult(status="running", error_message=_("media_generation.poll_timeout"))
        except Exception as exc:
            logger.exception(
                "[%s] 轮询异常: prediction_id=%s, error=%s", log_tag, provider_task_id, exc,
            )
            return PollResult(
                status="running",
                error_message=_("media_generation.poll_error", error=str(exc)),
            )

    def cancel_task(self, provider_task_id: str) -> bool:
        url = f"{self._base_url}/predictions/{provider_task_id}/cancel"
        try:
            resp = requests.post(url, headers=self._build_headers(), timeout=self._timeout)
            return resp.status_code == 200
        except Exception as exc:
            logger.warning("[Replicate %s] 取消任务失败: %s - %s", self._media_type, provider_task_id, exc)
            return False

    @property
    def _media_type(self) -> str:
        """子类覆盖，返回 'Image' 或 'Video'。"""
        return "Media"

    @abstractmethod
    def _extract_result_urls(self, output: Any) -> List[str]:
        """从 Replicate output 提取结果 URL 列表。"""

    @staticmethod
    def _parse_aspect_ratio(size: str) -> str:
        """将 '1920*1080' 或 '16:9' 转为 aspect_ratio 字符串。"""
        if ":" in size:
            return size
        from math import gcd
        for sep in ("*", "x", "X", "×"):
            if sep in size:
                parts = size.split(sep)
                if len(parts) == 2:
                    try:
                        w, h = int(parts[0].strip()), int(parts[1].strip())
                        g = gcd(w, h)
                        return f"{w // g}:{h // g}"
                    except ValueError:
                        pass
        return size

    @staticmethod
    def _parse_dimensions(size: str) -> tuple[int, int]:
        """将 '1024*1024' 转为 (width, height) 元组。"""
        for sep in ("*", "x", "X", "×"):
            if sep in size:
                parts = size.split(sep)
                if len(parts) == 2:
                    try:
                        return int(parts[0].strip()), int(parts[1].strip())
                    except ValueError:
                        pass
        return 1024, 1024

    @staticmethod
    def _extract_urls_from_output(output: Any) -> List[str]:
        """通用 output URL 提取（字符串/列表/FileOutput 对象均支持）。"""
        if output is None:
            return []
        if isinstance(output, str):
            return [output] if output.startswith("http") else []
        if isinstance(output, dict):
            url = output.get("url", "")
            return [url] if url else []
        if isinstance(output, list):
            urls = []
            for item in output:
                if isinstance(item, str) and item.startswith("http"):
                    urls.append(item)
                elif isinstance(item, dict) and item.get("url"):
                    urls.append(item["url"])
            return urls
        return []

    @staticmethod
    def _map_replicate_error(status_code: int, data: Dict[str, Any]) -> str:
        if status_code == 401:
            return MediaErrorCode.AUTH_FAILED
        if status_code == 402:
            return MediaErrorCode.QUOTA_EXCEEDED
        if status_code == 404:
            return MediaErrorCode.MODEL_NOT_FOUND
        if status_code == 422:
            return MediaErrorCode.INVALID_REQUEST
        if status_code == 429:
            return MediaErrorCode.RATE_LIMIT
        if status_code >= 500:
            return MediaErrorCode.PROVIDER_DOWN
        return MediaErrorCode.API_ERROR
