"""
ModelFamily — 模型族枚举 + ProviderProfile 能力画像

整个多模型适配体系的地基。所有链条（工具变体、prompt 变体、工具名合规、
prompt caching、错误检测等）的条件分支都从这里读取配置，
而不是散布在各处的 `if "claude" in name` 硬编码。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field, replace
from enum import Enum
from typing import Dict, List

__all__ = [
    "ModelFamily",
    "ProviderProfile",
    "PROVIDER_PROFILES",
    "get_provider_profile",
    "DEFAULT_OVERFLOW_KEYWORDS",
    "get_all_overflow_keywords",
]


class ModelFamily(str, Enum):
    GENERIC = "generic"
    CLAUDE = "claude"
    GPT = "gpt"
    GEMINI = "gemini"
    DEEPSEEK = "deepseek"
    QWEN = "qwen"

    @classmethod
    def detect(cls, model_name: str) -> ModelFamily:
        """从 litellm model 名检测模型族。

        支持格式:
            "anthropic/claude-4-sonnet", "claude-4-sonnet",
            "gpt-4o", "openai/gpt-4.1",
            "gpt-5-codex", "openai-codex",
            "gemini/gemini-2.5-pro",
            "deepseek/deepseek-chat",
            "dashscope/qwen-max" 等
        """
        name = model_name.lower()
        for fam, keywords in _DETECTION_RULES.items():
            if any(kw in name for kw in keywords):
                return fam
        return cls.GENERIC

    @classmethod
    def from_str(cls, value: str | None) -> ModelFamily:
        """从字符串安全转换，兼容旧代码中的 ``model_family: str | None``。"""
        if value is None:
            return cls.GENERIC
        if isinstance(value, cls):
            return value
        try:
            return cls(value.lower())
        except ValueError:
            return cls.detect(value)


# 检测规则：按优先级排列，先匹配先返回
_DETECTION_RULES: Dict[ModelFamily, List[str]] = {
    ModelFamily.CLAUDE: ["claude", "anthropic"],
    ModelFamily.GPT: ["gpt", "codex", "o1-", "o3-", "o4-", "openai", "moonshot", "kimi"],
    ModelFamily.GEMINI: ["gemini"],
    ModelFamily.DEEPSEEK: ["deepseek"],
    ModelFamily.QWEN: ["qwen", "dashscope"],
}


# ---------------------------------------------------------------------------
# ProviderProfile — 模型族的能力画像
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ProviderProfile:
    """模型族的能力画像 — 驱动全链条条件分支的唯一配置源。

    各字段说明：
      supports_parallel_tool_calls — 是否支持单次响应多个 tool_calls
      supports_prompt_caching     — 是否支持 prompt caching
      supports_vision             — 是否支持 multimodal（图片）输入
      prompt_cache_header         — prompt caching 所需的 extra header key（如 anthropic-beta）
      prompt_cache_header_value   — 对应的 header value
      tool_name_pattern           — provider 接受的工具名正则
      tool_name_max_length        — 工具名最大长度
      context_overflow_keywords   — 上下文溢出错误消息中的关键词
    """
    family: ModelFamily
    supports_parallel_tool_calls: bool = True
    supports_prompt_caching: bool = False
    supports_vision: bool = False
    prompt_cache_header: str | None = None
    prompt_cache_header_value: str | None = None
    tool_name_pattern: str = r"^[a-zA-Z][a-zA-Z0-9_.\-]*$"
    tool_name_max_length: int = 64
    supports_reasoning: bool = False
    context_overflow_keywords: tuple[str, ...] = (
        "context length", "maximum context", "token limit",
        "too many tokens", "prompt too long",
    )

    _compiled_re: re.Pattern | None = field(default=None, repr=False, compare=False)

    def __post_init__(self):
        object.__setattr__(self, "_compiled_re", re.compile(self.tool_name_pattern))

    @property
    def tool_name_re(self) -> re.Pattern:
        if self._compiled_re is None:
            object.__setattr__(self, "_compiled_re", re.compile(self.tool_name_pattern))
        return self._compiled_re


PROVIDER_PROFILES: Dict[ModelFamily, ProviderProfile] = {
    ModelFamily.GENERIC: ProviderProfile(
        family=ModelFamily.GENERIC,
    ),
    ModelFamily.CLAUDE: ProviderProfile(
        family=ModelFamily.CLAUDE,
        supports_parallel_tool_calls=False,
        supports_prompt_caching=True,
        supports_vision=True,
        supports_reasoning=True,
        prompt_cache_header="anthropic-beta",
        prompt_cache_header_value="prompt-caching-2024-07-31",
        tool_name_pattern=r"^[a-zA-Z0-9_\-]+$",
        context_overflow_keywords=(
            "context length", "maximum context", "prompt is too long",
            "too many tokens", "exceeds the maximum",
            "credit balance is too low",
        ),
    ),
    ModelFamily.GPT: ProviderProfile(
        family=ModelFamily.GPT,
        supports_prompt_caching=True,
        supports_vision=True,
        tool_name_pattern=r"^[a-zA-Z0-9_\-]+$",
        tool_name_max_length=64,
        context_overflow_keywords=(
            "context length", "maximum context", "token limit",
            "too many tokens", "max_tokens",
            "reduce the length", "context_length_exceeded",
        ),
    ),
    ModelFamily.GEMINI: ProviderProfile(
        family=ModelFamily.GEMINI,
        supports_parallel_tool_calls=False,
        supports_prompt_caching=False,
        supports_vision=True,
        tool_name_pattern=r"^[a-zA-Z_][a-zA-Z0-9_]*$",
        context_overflow_keywords=(
            "context length", "token limit", "too many tokens",
            "exceeds the maximum", "input too long",
        ),
    ),
    ModelFamily.DEEPSEEK: ProviderProfile(
        family=ModelFamily.DEEPSEEK,
        supports_prompt_caching=True,
        supports_reasoning=True,
        context_overflow_keywords=(
            "context length", "token limit", "too many tokens",
            "prompt too long",
        ),
    ),
    ModelFamily.QWEN: ProviderProfile(
        family=ModelFamily.QWEN,
        supports_parallel_tool_calls=False,
        tool_name_pattern=r"^[a-zA-Z][a-zA-Z0-9_]*$",
        context_overflow_keywords=(
            "context length", "token limit", "too many tokens",
            "maximum context", "input too long",
        ),
    ),
}


def _enhance_profile_from_db(base: ProviderProfile, model_name: str) -> ProviderProfile:
    """尝试从 DB 读取 LLMModel.capabilities_config，覆盖硬编码能力字段。

    DB 不可用或模型未注册时返回原始 profile（静默降级）。
    """
    try:
        from apps.services.llm.models import LLMModel
        from apps.services.llm.utils.capabilities import get_capability_flag

        from apps.services.llm.services.capability_guard import apply_llm_provider_filter

        # v0.1：LLMModel.is_active 字段已删（0022），下线模型直接 DELETE。
        model = apply_llm_provider_filter(
            LLMModel.objects.filter(model_name=model_name),
            field_prefix="provider__",
        ).first()
        if not model and "/" in model_name:
            bare = model_name.split("/", 1)[1]
            model = apply_llm_provider_filter(
                LLMModel.objects.filter(model_name=bare),
                field_prefix="provider__",
            ).first()
        if not model:
            return base

        return replace(
            base,
            supports_vision=get_capability_flag(
                model, "supports_vision", default=base.supports_vision,
            ),
            supports_parallel_tool_calls=get_capability_flag(
                model, "supports_parallel_function_calling",
                default=base.supports_parallel_tool_calls,
            ),
            supports_prompt_caching=get_capability_flag(
                model, "supports_prompt_caching", default=base.supports_prompt_caching,
            ),
        )
    except Exception:
        return base


def get_provider_profile(
    family: ModelFamily,
    *,
    model_name: str | None = None,
) -> ProviderProfile:
    """获取模型族的能力画像，未知族回退到 GENERIC。

    当提供 model_name 时，尝试从 DB 读取 LLMModel.capabilities_config
    覆盖硬编码的能力字段（supports_vision / supports_parallel_tool_calls /
    supports_prompt_caching），DB 查询失败则保留硬编码值。
    """
    base = PROVIDER_PROFILES.get(family, PROVIDER_PROFILES[ModelFamily.GENERIC])
    if not model_name:
        return base
    profile = _enhance_profile_from_db(base, model_name)
    if not profile.supports_reasoning:
        _mn = model_name.lower()
        _REASONING_MODEL_KEYWORDS = ("kimi", "moonshot", "qwq", "qwen3", "o1-", "o3-", "o4-")
        if any(kw in _mn for kw in _REASONING_MODEL_KEYWORDS):
            profile = replace(profile, supports_reasoning=True)
    return profile


DEFAULT_OVERFLOW_KEYWORDS: frozenset[str] = frozenset((
    "context length", "maximum context", "context window",
    "too many tokens", "prompt too long", "token limit",
    "exceeds the maximum", "max tokens",
))
"""get_all_overflow_keywords 的兜底值，也供 chat_service / react_agent 等模块在动态
导入失败时作为 fallback。修改此处请同步检查各 ProviderProfile 的 keywords。"""


def get_all_overflow_keywords() -> frozenset[str]:
    """聚合所有模型族的上下文溢出关键词（供错误检测使用）。"""
    kw: set[str] = set()
    for profile in PROVIDER_PROFILES.values():
        kw.update(profile.context_overflow_keywords)
    return frozenset(kw)
