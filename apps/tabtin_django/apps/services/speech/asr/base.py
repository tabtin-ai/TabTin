"""
ASR 服务抽象基类

设计原则：
  1. 统一输出 ASRResult / ASRTaskStatus / ASRStreamEvent
  2. 支持 audio_url（OSS CDN 链接）和 audio_data（base64 / bytes）两种输入
  3. 各 Provider 实现具体的 recognize / submit / query / stream
  4. 配置可从 Django settings、DB (LLMProvider) 或直接传参获取
  5. 内置 Provider 级限流 + 调用结果上报（共享 LLM 熔断基础设施）
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from typing import Any, AsyncGenerator, Optional

from ..config_types import ASRProviderConfig
from .types import ASRResult, ASRStreamEvent, ASRTaskStatus

logger = logging.getLogger(__name__)


class BaseASRService(ABC):
    """ASR 服务抽象基类"""

    def __init__(self, config: ASRProviderConfig):
        self.config = config
        self.provider_name: str = config.provider_name
        self.mode: str = config.mode
        self.max_retries: int = config.max_retries
        self.timeout_seconds: int = config.timeout_seconds
        self._provider_id: str = config.provider_id
        self._rate_limit: int = config.rate_limit

    def _check_rate_limit(self) -> Optional[dict[str, Any]]:
        """Provider 级限流检查（共享 LLM 的滑动窗口机制）。"""
        from apps.services.llm.services.rate_limiter import check_provider_rate_limit
        return check_provider_rate_limit(
            provider_id=self._provider_id,
            rate_limit=self._rate_limit,
            provider_name=self.provider_name,
            service_tag="asr",
        )

    def _report_call_result(
        self, *, success: bool, latency_seconds: float = 0, error_message: str = "",
    ) -> None:
        """上报调用结果，驱动 Provider 熔断状态机。"""
        from apps.services.llm.services.rate_limiter import report_call_result_by_id
        report_call_result_by_id(
            self._provider_id,
            success=success,
            latency_seconds=latency_seconds,
            error_message=error_message,
        )

    def _raise_if_rate_limited(self) -> None:
        """限流检查便捷方法——触发限流时直接抛异常。"""
        rate_limit_error = self._check_rate_limit()
        if rate_limit_error:
            from ..exceptions import SpeechUpstreamError
            raise SpeechUpstreamError(rate_limit_error["error"])

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
        同步识别（极速版等）— 一次请求返回完整结果。

        Args:
            audio_url: 音频文件 URL（OSS / CDN 链接）
            audio_data: base64 编码的音频数据
            language: 指定语言（空字符串 = 自动检测）
            audio_format: 音频格式 (wav / mp3 / ogg)
            **kwargs: Provider 特有参数（enable_itn, enable_punc 等）

        Returns:
            ASRResult: 归一化识别结果
        """
        raise NotImplementedError(
            f"{self.__class__.__name__} 不支持同步识别 (recognize)"
        )

    def submit(
        self,
        *,
        audio_url: str,
        language: str = "",
        audio_format: str = "mp3",
        callback_url: Optional[str] = None,
        **kwargs: Any,
    ) -> ASRTaskStatus:
        """
        提交异步识别任务（标准版）。

        Args:
            audio_url: 音频文件 URL
            language: 指定语言
            audio_format: 音频格式
            callback_url: 回调通知地址
            **kwargs: Provider 特有参数

        Returns:
            ASRTaskStatus: 包含 task_id 的状态对象
        """
        raise NotImplementedError(
            f"{self.__class__.__name__} 不支持异步提交 (submit)"
        )

    def query(self, task_id: str, **kwargs: Any) -> ASRTaskStatus:
        """
        查询异步识别任务结果（标准版）。

        Args:
            task_id: submit 返回的任务 ID

        Returns:
            ASRTaskStatus: 当前任务状态 + 结果（如已完成）
        """
        raise NotImplementedError(
            f"{self.__class__.__name__} 不支持异步查询 (query)"
        )

    async def stream(
        self,
        audio_data: bytes,
        *,
        language: str = "",
        audio_format: str = "wav",
        sample_rate: int = 16000,
        **kwargs: Any,
    ) -> AsyncGenerator[ASRStreamEvent, None]:
        """
        流式识别（WebSocket）— 逐包发送音频，实时获取识别结果。

        Args:
            audio_data: 完整音频 bytes（内部自动分包发送）
            language: 指定语言
            audio_format: 音频格式 (pcm / wav / ogg / mp3)
            sample_rate: 采样率
            **kwargs: Provider 特有参数

        Yields:
            ASRStreamEvent: 每次返回的部分/最终识别结果。
                当上游返回错误时，event.has_error 为 True 且 is_final 为 True，
                调用方应检查 has_error 以区分正常结束和错误终止。
        """
        raise NotImplementedError(
            f"{self.__class__.__name__} 不支持流式识别 (stream)"
        )
        yield  # pragma: no cover — make this a proper async generator

    def get_supported_languages(self) -> list[str]:
        """返回该 Provider 支持的语言代码列表"""
        return []

    def get_provider_info(self) -> dict[str, Any]:
        """返回 Provider 的元信息"""
        return {
            "provider": self.provider_name,
            "mode": self.mode,
            "supported_languages": self.get_supported_languages(),
        }
