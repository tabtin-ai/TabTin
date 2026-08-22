"""
媒体生成服务抽象基类

定义异步任务模式的统一接口：submit → poll → retrieve。
与 LLM 服务（同步/流式 chat）有本质区别。

限流/熔断：共享 LLM 的 Provider 级保护基础设施。
"""

import time
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional
from dataclasses import dataclass, field
import logging

logger = logging.getLogger(__name__)


@dataclass
class MediaRequest:
    """媒体生成请求（统一输入结构）"""
    task_type: str
    prompt: str
    model_name: str
    negative_prompt: str = ""
    size: str = ""
    duration: int = 0
    seed: Optional[int] = None
    prompt_extend: bool = True
    input_image_url: str = ""
    input_audio_url: str = ""
    extra_params: Dict[str, Any] = field(default_factory=dict)


@dataclass
class SubmitResult:
    """任务提交结果"""
    provider_task_id: str
    status: str = "pending"
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class PollResult:
    """任务轮询结果"""
    status: str
    result_urls: List[str] = field(default_factory=list)
    error_code: str = ""
    error_message: str = ""
    metadata: Dict[str, Any] = field(default_factory=dict)

    @property
    def is_terminal(self) -> bool:
        return self.status in ("succeeded", "failed", "cancelled")


class BaseMediaService(ABC):
    """媒体生成服务抽象基类"""

    PROVIDER_NAME: str = ""

    def __init__(self, provider_config: Dict[str, Any]):
        self.provider_name = provider_config.get('name', self.PROVIDER_NAME)
        self.api_key = provider_config.get('api_key')
        self.base_url = provider_config.get('base_url')
        self.config = provider_config
        self.provider = provider_config.get('provider_obj')
        self.model_obj = provider_config.get('model_obj')

        # 限流/熔断字段
        self._provider_id: str = str(getattr(self.provider, "id", "") or "") if self.provider else ""
        self._rate_limit: int = 0
        if self.provider:
            try:
                self._rate_limit = int(getattr(self.provider, "rate_limit", 0) or 0)
            except (TypeError, ValueError):
                pass

        logger.info("初始化 %s 媒体生成服务", self.provider_name)

    def _check_rate_limit(self) -> Optional[Dict[str, Any]]:
        """Provider 级限流检查（共享 LLM 的滑动窗口机制）。"""
        from apps.services.llm.services.rate_limiter import check_provider_rate_limit
        return check_provider_rate_limit(
            provider_id=self._provider_id,
            rate_limit=self._rate_limit,
            provider_name=self.provider_name,
            service_tag="media",
        )

    def _report_call_result(
        self, *, success: bool, latency_seconds: float = 0, error_message: str = "",
    ) -> None:
        """上报调用结果，驱动 Provider 熔断状态机。"""
        if not self.provider:
            return
        try:
            from apps.services.llm.services.rate_limiter import report_call_result
            report_call_result(
                self.provider,
                success=success,
                latency_seconds=latency_seconds,
                error_message=error_message,
            )
        except Exception as exc:
            logger.debug("Media 上报调用结果失败: %s", exc)

    def _raise_if_rate_limited(self) -> None:
        """限流检查便捷方法——触发限流时直接抛 MediaServiceError。"""
        rate_limit_error = self._check_rate_limit()
        if rate_limit_error:
            from ..errors import MediaErrorCode, MediaServiceError
            raise MediaServiceError(
                code=MediaErrorCode.RATE_LIMIT,
                message=rate_limit_error["error"],
                status_code=429,
            )

    def submit_task_with_protection(self, request: MediaRequest) -> SubmitResult:
        """submit_task 的保护封装：限流 + 调用结果上报。"""
        self._raise_if_rate_limited()

        start = time.monotonic()
        try:
            result = self.submit_task(request)
            self._report_call_result(
                success=True, latency_seconds=time.monotonic() - start,
            )
            return result
        except Exception as exc:
            self._report_call_result(
                success=False,
                latency_seconds=time.monotonic() - start,
                error_message=str(exc)[:500],
            )
            raise

    @abstractmethod
    def submit_task(self, request: MediaRequest) -> SubmitResult:
        """
        提交生成任务到 Provider，返回 provider_task_id。
        不等待结果，立即返回。
        """

    @abstractmethod
    def poll_task(self, provider_task_id: str) -> PollResult:
        """
        查询 Provider 侧的任务状态和结果。
        返回当前状态，若已完成则包含 result_urls。
        """

    def cancel_task(self, provider_task_id: str) -> bool:
        """取消 Provider 侧的任务（默认不支持，子类可覆盖）"""
        logger.warning("%s 不支持取消任务: %s", self.provider_name, provider_task_id)
        return False

    def _classify_error(self, exc: Exception) -> Dict[str, Any]:
        """
        将 Provider 原始异常映射为标准错误信息。
        子类应覆盖此方法做精确异常映射。
        """
        return {
            "error_code": "API_ERROR",
            "error_message": str(exc),
            "retryable": False,
        }
