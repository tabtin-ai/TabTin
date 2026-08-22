"""
AI 能力统一宪法 v0.1 — 共享类型定义

所有 8 个 capability 入口共用的 dataclass / Literal 类型。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

CapabilityDomain = Literal[
    "chat", "embedding", "vision", "asr", "tts",
    "image_gen", "video_gen", "audio_gen",
]

ProviderScope = Literal["global", "organization", "user"]
CostStatus = Literal["platform_paid", "byok_self_paid", "n_a"]


@dataclass(frozen=True)
class UsageBreakdown:
    """所有 capability 通用的用量分解。各 domain 选择性填写。"""
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    cache_read_input_tokens: int = 0
    cache_creation_input_tokens: int = 0
    duration_sec: float = 0.0
    asset_count: int = 0
    estimated: bool = False


@dataclass(frozen=True)
class CallTelemetry:
    """所有 capability 通用的调用元数据，跟 LLMUsageFact 同源。"""
    fact_id: str
    request_id: str
    scene_key: str
    capability_domain: CapabilityDomain
    model_used: str
    provider_used: str
    effective_provider_scope: ProviderScope
    prompt_bundle_version: str | None
    cost_status: CostStatus
    latency_ms: int
    attempt_count: int
    invocation_id: str = ""
    attempt_id: str = ""
    execution_key: str = ""
    stable_invocation: bool = False
    settlement_status: str = ""
