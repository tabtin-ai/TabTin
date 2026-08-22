"""
Speech 服务 Provider 配置的 typed dataclass。

替代原有的 dict[str, Any]，提供：
  - 编译期类型检查（IDE 自动补全、mypy）
  - 显式的字段定义和默认值
  - frozen=True 防止意外修改（缓存安全）
  - dataclasses.replace() 替代 dict.update（config_overrides）
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ASRProviderConfig:
    """ASR 服务 Provider 配置。"""

    provider_name: str = "unknown"
    mode: str = "flash"
    app_id: str = ""
    access_token: str = ""
    resource_id: str = ""
    max_retries: int = 3
    timeout_seconds: int = 300

    secret_key: str = ""
    model_version: str = ""
    ws_endpoint: str = "bigmodel_async"

    ws_url: str = ""
    base_url: str = ""
    submit_url: str = ""
    query_url: str = ""
    poll_interval: float = 5.0
    poll_max_attempts: int = 720
    segment_duration_ms: int = 200

    # 限流/熔断所需字段（由 factory 从 LLMProvider 填充）
    provider_id: str = ""
    rate_limit: int = 0


@dataclass(frozen=True)
class TTSProviderConfig:
    """TTS 服务 Provider 配置。"""

    provider_name: str = "unknown"
    mode: str = "http"
    app_id: str = ""
    access_token: str = ""
    resource_id: str = ""
    max_retries: int = 3
    timeout_seconds: int = 60

    default_speaker: str = ""

    # 限流/熔断所需字段（由 factory 从 LLMProvider 填充）
    provider_id: str = ""
    rate_limit: int = 0
