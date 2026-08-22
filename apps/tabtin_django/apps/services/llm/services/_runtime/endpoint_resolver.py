"""
Endpoint URL resolver — 按 (provider, model_name) 查 LLMModel.base_url。

v0.1.x Phase 2.5：``LLMProvider.base_url`` 已删，每个 ``LLMModel`` 自带 ``base_url``。
调用方持有 (provider, model_name) 二元组但没有 LLMModel 对象时，用本函数补查；
找不到时返回空字符串，由下游 factory / LiteLLM 拿默认 endpoint 兜底（如能兜的话）。

不要在热路径上滥用——能直接持有 LLMModel 对象的就走 ``model.base_url``，
本函数只服务于"capability 入口之前的旧调用方"（runtime probe、failover_executor 等）。
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from apps.services.llm.models import LLMProvider


def resolve_model_base_url(provider: "LLMProvider", model_name: str) -> str:
    """按 (provider, model_name) 查 ``LLMModel.base_url``。

    Returns:
        str: model.base_url 字符串；未找到 / 异常时返回 ''。
    """
    from apps.services.llm.models import LLMModel
    try:
        m = (
            LLMModel.objects
            .filter(provider=provider, model_name=model_name)
            .only('base_url')
            .first()
        )
        return (m.base_url or '') if m else ''
    except Exception:
        return ''
