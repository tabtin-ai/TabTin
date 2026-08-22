"""
阿里云百炼 DashScope 视频生成服务

支持模型：
- 文生视频: wan2.6-t2v, wan2.5-t2v-preview, wan2.2-t2v-plus, wanx2.1-t2v-turbo, wanx2.1-t2v-plus
- 图生视频: wan2.6-i2v-flash, wan2.5-i2v-preview, wan2.2-i2v-plus, wanx2.1-i2v-turbo, wanx2.1-i2v-plus
- 视频编辑: wanx2.1-vace-plus

API 模式：异步任务（submit → poll），耗时 1~10 分钟
- 创建: POST /api/v1/services/aigc/video-generation/video-synthesis
- 查询: GET /api/v1/tasks/{task_id}
"""

import logging
import requests
from typing import Any, Dict

from apps.i18n import _
from ..base import BaseMediaService, MediaRequest, SubmitResult, PollResult
from ...errors import MediaErrorCode, MediaServiceError

logger = logging.getLogger(__name__)

_STATUS_MAP = {
    "PENDING": "pending",
    "RUNNING": "running",
    "SUCCEEDED": "succeeded",
    "FAILED": "failed",
    "CANCELED": "cancelled",
    "UNKNOWN": "failed",
}


class DashScopeVideoService(BaseMediaService):
    """阿里云百炼 DashScope 视频生成服务"""

    PROVIDER_NAME = "dashscope"

    SUBMIT_URL_SUFFIX = "/services/aigc/video-generation/video-synthesis"
    TASK_URL_SUFFIX = "/tasks/{task_id}"

    def __init__(self, provider_config: Dict[str, Any]):
        super().__init__(provider_config)
        base = (self.base_url or "https://dashscope.aliyuncs.com/api/v1").rstrip("/")
        self._submit_url = f"{base}{self.SUBMIT_URL_SUFFIX}"
        self._task_url_template = f"{base}{self.TASK_URL_SUFFIX}"
        self._headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "X-DashScope-Async": "enable",
        }
        self._timeout = provider_config.get("timeout", 30)

    def submit_task(self, request: MediaRequest) -> SubmitResult:
        input_data: Dict[str, Any] = {"prompt": request.prompt}
        if request.negative_prompt:
            input_data["negative_prompt"] = request.negative_prompt
        if request.input_image_url:
            input_data["img_url"] = request.input_image_url
        if request.input_audio_url:
            input_data["audio_url"] = request.input_audio_url

        parameters: Dict[str, Any] = {}
        if request.size:
            parameters["size"] = request.size
        if request.duration and request.duration > 0:
            parameters["duration"] = request.duration
        if request.seed is not None:
            parameters["seed"] = request.seed
        if request.prompt_extend is not None:
            parameters["prompt_extend"] = request.prompt_extend

        extra = request.extra_params or {}
        for key in ("resolution", "watermark", "shot_type", "audio"):
            if key in extra:
                parameters[key] = extra[key]

        body: Dict[str, Any] = {
            "model": request.model_name,
            "input": input_data,
        }
        if parameters:
            body["parameters"] = parameters

        logger.info(
            f"[DashScope Video] 提交任务: model={request.model_name}, "
            f"type={request.task_type}, prompt={request.prompt[:80]}"
        )

        try:
            resp = requests.post(
                self._submit_url,
                json=body,
                headers=self._headers,
                timeout=self._timeout,
            )
            data = resp.json()

            if resp.status_code != 200:
                error_code = data.get("code", "API_ERROR")
                error_msg = data.get("message", resp.text)
                logger.error(f"[DashScope Video] 提交失败: {error_code} - {error_msg}")
                raise MediaServiceError(
                    code=self._map_dashscope_error(error_code),
                    message=error_msg,
                    status_code=resp.status_code,
                    error_details=data,
                )

            output = data.get("output", {})
            task_id = output.get("task_id", "")
            if not task_id:
                raise MediaServiceError(
                    code=MediaErrorCode.API_ERROR,
                    message="DashScope 未返回 task_id",
                    error_details=data,
                )

            logger.info(f"[DashScope Video] 任务已提交: task_id={task_id}")
            return SubmitResult(
                provider_task_id=task_id,
                status=_STATUS_MAP.get(output.get("task_status", "PENDING"), "pending"),
                metadata={"request_id": data.get("request_id", "")},
            )

        except MediaServiceError:
            raise
        except requests.Timeout:
            raise MediaServiceError(code=MediaErrorCode.TIMEOUT, message="DashScope 请求超时", retryable=True)
        except Exception as exc:
            logger.exception(f"[DashScope Video] 提交异常: {exc}")
            raise MediaServiceError(code=MediaErrorCode.API_ERROR, message=str(exc), provider_error=exc)

    def poll_task(self, provider_task_id: str) -> PollResult:
        url = self._task_url_template.format(task_id=provider_task_id)
        headers = {k: v for k, v in self._headers.items() if k != "X-DashScope-Async"}

        try:
            resp = requests.get(url, headers=headers, timeout=self._timeout)
            data = resp.json()

            if resp.status_code != 200:
                return PollResult(
                    status="failed",
                    error_code=data.get("code", "API_ERROR"),
                    error_message=data.get("message", resp.text),
                )

            output = data.get("output", {})
            raw_status = output.get("task_status", "UNKNOWN")
            status = _STATUS_MAP.get(raw_status, "failed")
            usage = data.get("usage", {})

            result_urls = []
            if status == "succeeded":
                results = output.get("results", [])
                result_urls = [
                    r.get("video_url") or r.get("url", "")
                    for r in results
                    if r.get("video_url") or r.get("url")
                ]

            metadata = {
                "request_id": data.get("request_id", ""),
                "task_metrics": output.get("task_metrics", {}),
                "usage": usage,
                "submit_time": output.get("submit_time", ""),
                "end_time": output.get("end_time", ""),
            }

            error_code = ""
            error_message = ""
            if status == "failed":
                error_code = output.get("code", "TASK_FAILED")
                error_message = output.get("message", "任务执行失败")

            return PollResult(
                status=status,
                result_urls=result_urls,
                error_code=error_code,
                error_message=error_message,
                metadata=metadata,
            )

        except requests.Timeout:
            return PollResult(status="running", error_message=_("media_generation.poll_timeout"))
        except Exception as exc:
            logger.exception(f"[DashScope Video] 轮询异常: task_id={provider_task_id}, error={exc}")
            return PollResult(status="running", error_message=_("media_generation.poll_error", error=str(exc)))

    @staticmethod
    def _map_dashscope_error(code: str) -> str:
        mapping = {
            "InvalidApiKey": MediaErrorCode.AUTH_FAILED,
            "AccessDenied": MediaErrorCode.AUTH_FAILED,
            "Throttling": MediaErrorCode.RATE_LIMIT,
            "Throttling.RateQuota": MediaErrorCode.RATE_LIMIT,
            "QuotaExhausted": MediaErrorCode.QUOTA_EXCEEDED,
            "InvalidParameter": MediaErrorCode.INVALID_REQUEST,
            "BadRequest": MediaErrorCode.INVALID_REQUEST,
            "ModelNotFound": MediaErrorCode.MODEL_NOT_FOUND,
            "DataInspectionFailed": MediaErrorCode.CONTENT_FILTERED,
            "InternalError": MediaErrorCode.PROVIDER_DOWN,
            "ServerError": MediaErrorCode.PROVIDER_DOWN,
        }
        return mapping.get(code, MediaErrorCode.API_ERROR)
