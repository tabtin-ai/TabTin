"""
模型参数适配注册表。

temperature / variants 集中式参数适配设计，
将分散在各 Service 子类 ``_prepare_chat_params`` 中的模型特定参数调整
集中到一处声明式配置中。

使用方式：
    from apps.services.llm.utils.param_adaptor import adapt_params
    params = adapt_params(params, model_name, model_obj=self.model)
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Sequence

logger = logging.getLogger(__name__)

# ── 采样参数集合 ──

_SAMPLING_PARAMS = ("temperature", "top_p", "frequency_penalty", "presence_penalty")
_ANTHROPIC_CONFLICT_PARAMS = ("frequency_penalty", "presence_penalty")

# Moonshot / Kimi Coding：上游只接受 temperature=1（发 0 / 0.3 / 0.7 会 400）。
# 覆盖 K3 / K2.x 与 BYOK「Kimi For Coding」预设模型名（kimi-for-coding / k3-256k）。
# 注意：kimi-k3 必须写完整前缀，避免误伤无关模型名。
KIMI_TEMPERATURE_ONE_MARKERS = (
    "kimi-k3",
    "kimi-k2.7",
    "kimi-k2p7",
    "kimi-k2-7",
    "kimi-k2.6",
    "kimi-k2p6",
    "kimi-k2-6",
    "kimi-k2.5",
    "kimi-k2p5",
    "kimi-k2-5",
    "kimi-for-coding",
    "k3-256k",
)


def requires_kimi_temperature_one(model_name: str) -> bool:
    normalized = (model_name or "").strip().lower()
    return any(marker in normalized for marker in KIMI_TEMPERATURE_ONE_MARKERS)


# ── 规则定义 ──
# 每条规则包含：
#   match_keywords  — 模型名中包含任一关键词即命中
#   match_capability — 如果 model_obj 有该能力标记也命中
#   remove_params   — 需要从 params 中移除的参数
#   extra_params    — 需要追加/覆盖到 params 中的参数

class _ParamRule:
    __slots__ = ("name", "match_keywords", "match_capability", "remove_params", "extra_params")

    def __init__(
        self,
        name: str,
        *,
        match_keywords: Sequence[str] = (),
        match_capability: Optional[str] = None,
        remove_params: Sequence[str] = (),
        extra_params: Optional[Dict[str, Any]] = None,
    ):
        self.name = name
        self.match_keywords = [kw.lower() for kw in match_keywords]
        self.match_capability = match_capability
        self.remove_params = list(remove_params)
        self.extra_params = extra_params or {}

    def matches(self, model_name_lower: str, model_obj: Any = None) -> bool:
        if self.match_capability and model_obj is not None:
            from apps.services.llm.utils.capabilities import get_capability_flag
            if get_capability_flag(model_obj, self.match_capability):
                return True

        return any(kw in model_name_lower for kw in self.match_keywords)


_STREAM_OPTIONS_UNSUPPORTED = ("stream_options",)

_RULES: List[_ParamRule] = [
    # Reasoning 模型禁用所有采样参数
    _ParamRule(
        "reasoning_strip_sampling",
        match_keywords=[
            # Moonshot Kimi K2.x / Coding：见 requires_kimi_temperature_one
            *KIMI_TEMPERATURE_ONE_MARKERS,
            "-thinking",
            "o1-mini", "o1-preview", "o1",
            "o3-mini", "o3",
            "o4-mini", "o4",
            "deepseek-r1",
            # DeepSeek V4 默认开启 thinking，采样参数被上游忽略（无效但不报错）；
            # 旧别名 deepseek-reasoner 亦然。见 api-docs.deepseek.com/guides/thinking_mode
            "deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4",
            "deepseek-reasoner",
        ],
        match_capability="supports_reasoning",
        remove_params=list(_SAMPLING_PARAMS),
    ),
    # Anthropic 兼容（Claude / MiniMax 走 Anthropic SDK 时的参数冲突）
    _ParamRule(
        "anthropic_compat",
        match_keywords=["claude", "anthropic", "minimax"],
        remove_params=list(_ANTHROPIC_CONFLICT_PARAMS),
    ),
    # Gemini / Claude / MiniMax 兼容层不支持 stream_options
    _ParamRule(
        "strip_stream_options",
        match_keywords=["gemini", "claude", "anthropic", "minimax"],
        remove_params=list(_STREAM_OPTIONS_UNSUPPORTED),
    ),
]


def adapt_params(
    params: Dict[str, Any],
    model_name: str,
    *,
    model_obj: Any = None,
) -> Dict[str, Any]:
    """
    根据模型名和能力配置，自动调整 API 请求参数。

    遍历 ``_RULES``，对命中的规则执行参数删除和追加。
    规则按声明顺序执行；先命中的 remove 优先生效。

    Args:
        params:     由 _prepare_chat_params 构建的原始参数字典
        model_name: 当前模型名
        model_obj:  可选的 LLMModel DB 对象

    Returns:
        调整后的 params（原地修改并返回）
    """
    name_lower = (model_name or "").lower()

    for rule in _RULES:
        if not rule.matches(name_lower, model_obj):
            continue

        for key in rule.remove_params:
            if key in params:
                params.pop(key)
                logger.debug(
                    "[ParamAdaptor] 规则 '%s' 移除参数 '%s' (model=%s)",
                    rule.name, key, model_name,
                )

        for key, value in rule.extra_params.items():
            params[key] = value
            logger.debug(
                "[ParamAdaptor] 规则 '%s' 追加参数 '%s'=%r (model=%s)",
                rule.name, key, value, model_name,
            )

    # 若上游仍带了 temperature（未走 strip 或其它路径写入），强制为 1。
    if requires_kimi_temperature_one(model_name) and "temperature" in params and params["temperature"] != 1:
        logger.debug(
            "[ParamAdaptor] force temperature=1 for kimi model=%s (was %r)",
            model_name,
            params.get("temperature"),
        )
        params["temperature"] = 1

    return params
