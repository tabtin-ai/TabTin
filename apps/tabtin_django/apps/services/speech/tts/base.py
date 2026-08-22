"""
TTS 服务抽象基类

设计原则：
  1. 统一输出 TTSResult / TTSChunk / TTSStreamEvent
  2. 支持同步合成 (synthesize) 和流式合成 (synthesize_stream)
  3. 配置可从 Django settings、DB (LLMProvider) 或直接传参获取
  4. 内置 Provider 级限流 + 调用结果上报（共享 LLM 熔断基础设施）
"""

from __future__ import annotations

import logging
import time
from abc import ABC, abstractmethod
from typing import Any, AsyncGenerator, Optional

from ..config_types import TTSProviderConfig
from .types import TTSChunk, TTSResult

logger = logging.getLogger(__name__)


class BaseTTSService(ABC):
    """TTS 服务抽象基类"""

    def __init__(self, config: TTSProviderConfig):
        self.config = config
        self.provider_name: str = config.provider_name
        self.mode: str = config.mode
        self.max_retries: int = config.max_retries
        self.timeout_seconds: int = config.timeout_seconds
        self._provider_id: str = config.provider_id
        self._rate_limit: int = config.rate_limit

    def _check_rate_limit(self) -> Optional[dict[str, Any]]:
        """Provider 级限流检查（共享 LLM 的滑动窗口机制）。

        子类在 synthesize / synthesize_stream 入口处调用。
        返回 None 表示未触发限流，否则返回标准错误结构。
        """
        from apps.services.llm.services.rate_limiter import check_provider_rate_limit
        return check_provider_rate_limit(
            provider_id=self._provider_id,
            rate_limit=self._rate_limit,
            provider_name=self.provider_name,
            service_tag="tts",
        )

    def _report_call_result(
        self, *, success: bool, latency_seconds: float = 0, error_message: str = "",
    ) -> None:
        """上报调用结果，驱动 Provider 熔断状态机。

        子类在 synthesize / synthesize_stream 完成（成功或失败）后调用。
        """
        from apps.services.llm.services.rate_limiter import report_call_result_by_id
        report_call_result_by_id(
            self._provider_id,
            success=success,
            latency_seconds=latency_seconds,
            error_message=error_message,
        )

    def _raise_if_rate_limited(self) -> None:
        """限流检查的便捷方法——触发限流时直接抛异常。"""
        rate_limit_error = self._check_rate_limit()
        if rate_limit_error:
            from ..exceptions import SpeechUpstreamError
            raise SpeechUpstreamError(rate_limit_error["error"])

    @abstractmethod
    async def synthesize(
        self,
        text: str,
        *,
        speaker: str = "",
        model: str = "",
        format: str = "mp3",
        sample_rate: int = 24000,
        speed_ratio: float = 1.0,
        volume_ratio: float = 1.0,
        pitch: int = 0,
        emotion: str = "",
        enable_timestamp: bool = False,
        **kwargs: Any,
    ) -> TTSResult:
        """
        合成完整音频（收集全部流式数据后返回）。

        子类实现时应在入口调用 self._raise_if_rate_limited()，
        在完成/失败后调用 self._report_call_result()。

        Args:
            text: 合成文本
            speaker: 音色 ID
            model: 模型版本（如 seed-tts-2.0-expressive）
            format: 音频格式 (mp3/pcm/ogg_opus)
            sample_rate: 采样率
            speed_ratio: 语速比（1.0 = 正常）
            volume_ratio: 音量比（1.0 = 正常）
            pitch: 音调 [-12, 12]
            emotion: 情感标签
            enable_timestamp: 是否返回时间戳

        Returns:
            TTSResult: 完整合成结果
        """
        ...

    async def synthesize_stream(
        self,
        text: str,
        *,
        speaker: str = "",
        model: str = "",
        format: str = "mp3",
        sample_rate: int = 24000,
        speed_ratio: float = 1.0,
        volume_ratio: float = 1.0,
        pitch: int = 0,
        emotion: str = "",
        enable_timestamp: bool = False,
        **kwargs: Any,
    ) -> AsyncGenerator[TTSChunk, None]:
        """
        流式合成（逐块返回音频数据）。

        Yields:
            TTSChunk: 音频数据块
        """
        raise NotImplementedError(
            f"{self.__class__.__name__} 不支持流式合成 (synthesize_stream)"
        )
        yield  # pragma: no cover

    def get_provider_info(self) -> dict[str, Any]:
        """返回 Provider 的元信息"""
        return {
            "provider": self.provider_name,
            "mode": self.mode,
        }
