"""
fal.ai 服务公共基类

封装 fal.ai 队列 API 的通用逻辑：认证、状态轮询、结果获取、取消、错误映射。
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
    "IN_QUEUE": "pending",
    "IN_PROGRESS": "running",
    "COMPLETED": "succeeded",
}


class BaseFalService(BaseMediaService):
    """fal.ai 队列 API 公共基类"""

    PROVIDER_NAME = "fal"

    def __init__(self, provider_config: Dict[str, Any]):
        super().__init__(provider_config)
        self._base_url = (self.base_url or "https://queue.fal.run").rstrip("/")
        self._timeout = provider_config.get("timeout", 60)

    def _build_headers(self) -> Dict[str, str]:
        return {
            "Authorization": f"Key {self.api_key}",
            "Content-Type": "application/json",
        }

    def _model_path(self, model_name: str) -> str:
        return model_name.strip("/")

    def _resolve_model_path(self) -> str:
        if self.model_obj:
            name = getattr(self.model_obj, "model_name", "")
            if name:
                return self._model_path(name)
        return ""

    def _submit_to_queue(self, model_path: str, body: Dict[str, Any], log_tag: str) -> SubmitResult:
        """向 fal 队列提交任务的公共逻辑。"""
        url = f"{self._base_url}/{model_path}"

        try:
            resp = requests.post(
                url, json=body, headers=self._build_headers(), timeout=self._timeout,
            )
            data = resp.json()

            if resp.status_code not in (200, 201):
                error_msg = data.get("detail", data.get("message", resp.text))
                logger.error("[%s] 提交失败: %s - %s", log_tag, resp.status_code, error_msg)
                raise MediaServiceError(
                    code=self._map_fal_error(resp.status_code, data),
                    message=str(error_msg),
                    status_code=resp.status_code,
                    error_details=data,
                )

            request_id = data.get("request_id", "")
            if not request_id:
                raise MediaServiceError(
                    code=MediaErrorCode.API_ERROR,
                    message="fal 未返回 request_id",
                    error_details=data,
                )

            logger.info("[%s] 任务已提交: request_id=%s", log_tag, request_id)
            return SubmitResult(
                provider_task_id=request_id,
                status="pending",
                metadata={
                    "model_path": model_path,
                    "status_url": data.get("status_url", ""),
                    "response_url": data.get("response_url", ""),
                    "cancel_url": data.get("cancel_url", ""),
                },
            )

        except MediaServiceError:
            raise
        except requests.Timeout:
            raise MediaServiceError(
                code=MediaErrorCode.TIMEOUT, message="fal 请求超时", retryable=True,
            )
        except Exception as exc:
            logger.exception("[%s] 提交异常: %s", log_tag, exc)
            raise MediaServiceError(
                code=MediaErrorCode.API_ERROR, message=str(exc), provider_error=exc,
            )

    def poll_task(self, provider_task_id: str) -> PollResult:
        model_path = self._resolve_model_path()
        log_tag = f"fal {self._media_type}"
        status_url = f"{self._base_url}/{model_path}/requests/{provider_task_id}/status"

        try:
            resp = requests.get(
                status_url, headers=self._build_headers(), timeout=self._timeout,
            )
            data = resp.json()

            if resp.status_code != 200:
                return PollResult(
                    status="failed",
                    error_code=data.get("error_type", "API_ERROR"),
                    error_message=data.get("detail", resp.text),
                )

            raw_status = data.get("status", "")

            if raw_status == "COMPLETED":
                return self._fetch_result(model_path, provider_task_id, data)

            status = _STATUS_MAP.get(raw_status, "running")
            metadata: Dict[str, Any] = {}
            if "queue_position" in data:
                metadata["queue_position"] = data["queue_position"]
            if data.get("metrics"):
                metadata["metrics"] = data["metrics"]

            return PollResult(status=status, metadata=metadata)

        except requests.Timeout:
            return PollResult(status="running", error_message=_("media_generation.poll_timeout"))
        except Exception as exc:
            logger.exception(
                "[%s] 轮询异常: request_id=%s, error=%s", log_tag, provider_task_id, exc,
            )
            return PollResult(
                status="running",
                error_message=_("media_generation.poll_error", error=str(exc)),
            )

    def _fetch_result(
        self, model_path: str, request_id: str, status_data: Dict[str, Any],
    ) -> PollResult:
        """COMPLETED 后获取完整结果。"""
        log_tag = f"fal {self._media_type}"
        response_url = f"{self._base_url}/{model_path}/requests/{request_id}"
        try:
            resp = requests.get(
                response_url, headers=self._build_headers(), timeout=self._timeout,
            )
            data = resp.json()

            if resp.status_code != 200:
                error_msg = data.get("detail", resp.text)
                if data.get("error"):
                    return PollResult(
                        status="failed",
                        error_code=data.get("error_type", "TASK_FAILED"),
                        error_message=data.get("error", error_msg),
                    )
                return PollResult(
                    status="failed",
                    error_code="RESULT_FETCH_FAILED",
                    error_message=str(error_msg),
                )

            result_urls = self._extract_result_urls(data)

            if not result_urls:
                return PollResult(
                    status="failed",
                    error_code="NO_OUTPUT",
                    error_message=f"fal 返回结果中无{self._media_type} URL",
                )

            metadata: Dict[str, Any] = {}
            if status_data.get("metrics"):
                metadata["metrics"] = status_data["metrics"]
            if data.get("seed") is not None:
                metadata["seed"] = data["seed"]

            self._enrich_metadata(data, metadata)

            return PollResult(
                status="succeeded",
                result_urls=result_urls,
                metadata=metadata,
            )

        except Exception as exc:
            logger.exception(
                "[%s] 获取结果异常: request_id=%s, error=%s", log_tag, request_id, exc,
            )
            return PollResult(status="running", error_message=str(exc))

    def cancel_task(self, provider_task_id: str) -> bool:
        model_path = self._resolve_model_path()
        cancel_url = f"{self._base_url}/{model_path}/requests/{provider_task_id}/cancel"
        try:
            resp = requests.put(
                cancel_url, headers=self._build_headers(), timeout=self._timeout,
            )
            return resp.status_code == 200
        except Exception as exc:
            logger.warning("[fal %s] 取消任务失败: %s - %s", self._media_type, provider_task_id, exc)
            return False

    @property
    def _media_type(self) -> str:
        """子类覆盖，返回 'Image' 或 'Video'。"""
        return "Media"

    @abstractmethod
    def _extract_result_urls(self, data: Dict[str, Any]) -> List[str]:
        """从 fal 返回数据中提取结果 URL 列表。"""

    def _enrich_metadata(self, data: Dict[str, Any], metadata: Dict[str, Any]) -> None:
        """子类可覆盖，向 metadata 中追加额外字段。"""

    @staticmethod
    def _parse_size(size: str) -> Dict[str, int] | None:
        """将 '1024*1024' 或 '1024x1024' 格式转为 fal 的 image_size 对象。"""
        for sep in ("*", "x", "X", "×"):
            if sep in size:
                parts = size.split(sep)
                if len(parts) == 2:
                    try:
                        return {"width": int(parts[0].strip()), "height": int(parts[1].strip())}
                    except ValueError:
                        pass
        return None

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
    def _map_fal_error(status_code: int, data: Dict[str, Any]) -> str:
        if status_code == 401:
            return MediaErrorCode.AUTH_FAILED
        if status_code == 422:
            return MediaErrorCode.INVALID_REQUEST
        if status_code == 429:
            return MediaErrorCode.RATE_LIMIT
        if status_code >= 500:
            return MediaErrorCode.PROVIDER_DOWN
        return MediaErrorCode.API_ERROR
