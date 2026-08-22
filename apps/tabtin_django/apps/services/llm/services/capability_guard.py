"""能力域守卫（v0.1 AI 能力统一宪法）。

v0.1 的 ``LLMProvider.capability_domain`` 把过去含糊的「LLM」拆成 8 个明确域：
``chat / embedding / vision / asr / tts / image_gen / video_gen / audio_gen``。
chat 链路只关心 ``chat`` 域，所以这里的工具函数就只针对 chat 域提供过滤。

旧名 ``LLM_CAPABILITY_DOMAIN`` / ``provider_supports_llm_capability`` 仍以
``CHAT_CAPABILITY_DOMAIN`` / ``provider_supports_chat_capability`` 保留 alias，
但具体取值不再是已经死掉的 ``"llm"``。
"""

from __future__ import annotations

import logging
from typing import Iterable, Optional

logger = logging.getLogger(__name__)

# v0.1 chat 链路用的 capability_domain。旧字段 ``LLMModel.mode`` 已删（0022），
# 仍然在配置层兼容这两个值，避免 wire_adapter 老配置把 chat 模型误标成非 chat。
CHAT_MODEL_MODES = frozenset({"chat", "completion"})

CHAT_CAPABILITY_DOMAIN = "chat"

# 兼容老导入路径：v0.1 把含糊的 "llm" 改成具体的 "chat"，旧符号继续可用，
# 但具体值已对齐到 chat capability_domain。
LLM_CAPABILITY_DOMAIN = CHAT_CAPABILITY_DOMAIN


def provider_supports_chat_capability(
    provider_name: Optional[str],
    *,
    allow_unregistered: bool = True,
) -> bool:
    """判断 provider 是否支持 chat 能力域。

    chat 是热路径——每次 LLM 调用都会查一次。本函数用 1 次 DB 查询完成判断：
    拉所有同名 provider 的 capability_domains 集合，Python 端 union；
    DB 未命中时再回退到 ProviderRegistry 元数据。
    """
    if not provider_name:
        return True
    try:
        from apps.services.llm.models import LLMProvider

        caps_per_provider = list(
            LLMProvider.objects.filter(name=provider_name)
            .values_list("capability_domains", flat=True)
        )
        if caps_per_provider:
            return any(
                CHAT_CAPABILITY_DOMAIN in (c or []) for c in caps_per_provider
            )

        from apps.services.llm.registry import ProviderRegistry

        meta = ProviderRegistry.get(provider_name)
        if meta is None:
            return allow_unregistered
        # ProviderRegistry 元数据仍沿用旧的 "llm" 标识，等价于 v0.1 的 chat 域。
        return "llm" in meta.capability_domains
    except Exception as exc:
        logger.warning(
            "[capability_guard] provider_supports_chat 异常，放行 '%s': %s",
            provider_name, exc,
        )
        return allow_unregistered


# 旧调用方仍用 provider_supports_llm_capability，保留 alias。
provider_supports_llm_capability = provider_supports_chat_capability


def get_chat_capable_provider_names() -> set[str]:
    """返回 DB 中 ``capability_domains`` 包含 chat 的 provider 名集合。"""
    try:
        from apps.services.llm.models import LLMProvider

        return set(
            LLMProvider.objects.filter(
                capability_domains__contains=[CHAT_CAPABILITY_DOMAIN],
            )
            .values_list("name", flat=True)
            .distinct()
        )
    except Exception as exc:
        logger.warning("[capability_guard] get_chat_capable_provider_names 异常: %s", exc)
        return set()


# 旧名兼容
get_llm_capable_provider_names = get_chat_capable_provider_names


def apply_chat_provider_filter(queryset, *, field_prefix: str = ""):
    """对 queryset 追加"仅 chat 能力域 provider"过滤。

    ArrayField __contains lookup：``capability_domains @> ARRAY['chat']``。
    """
    field_name = (
        f"{field_prefix}capability_domains__contains"
        if field_prefix
        else "capability_domains__contains"
    )
    return queryset.filter(**{field_name: [CHAT_CAPABILITY_DOMAIN]})


# 旧名兼容
apply_llm_provider_filter = apply_chat_provider_filter


def pick_first_chat_provider(provider_queryset):
    """按既有排序选出首个 chat 能力域 provider。"""
    for provider in provider_queryset:
        domains = getattr(provider, "capability_domains", None)
        if domains is None:
            # 兼容 mock 对象（旧测试用 SimpleNamespace 单值 capability_domain）
            legacy = getattr(provider, "capability_domain", CHAT_CAPABILITY_DOMAIN)
            if legacy == CHAT_CAPABILITY_DOMAIN:
                return provider
            continue
        if CHAT_CAPABILITY_DOMAIN in (domains or []):
            return provider
    return None


# 旧名兼容
pick_first_llm_provider = pick_first_chat_provider


def is_chat_model_mode(mode: Optional[str]) -> bool:
    """判断（旧）``model.mode`` 是否属于 chat/completion。

    v0.1 后 ``LLMModel.mode`` 已删，本函数仅供 wire_adapter / 旧 service 兼容路径调用，
    传入空值时按"chat 兜底"处理，与 v0.1 capability_domain='chat' 等价。
    """
    normalized = str(mode or "chat").strip().lower()
    return normalized in CHAT_MODEL_MODES


def normalize_model_modes(allowed_modes: Optional[Iterable[str]]) -> Optional[list[str]]:
    """归一化 allowed_modes，返回稳定排序后的 mode 列表。"""
    if allowed_modes is None:
        return None
    normalized = sorted(
        {str(mode or "").strip().lower() for mode in allowed_modes if str(mode or "").strip()}
    )
    return normalized or None


def apply_chat_model_filter(
    queryset,
    *,
    provider_field_prefix: str = "provider__",
    mode_field: str = None,  # noqa: ARG001 - 兼容老调用方，v0.1 不再按 mode 过滤
):
    """对 queryset 追加 v0.1 chat 链路过滤。

    v0.1 chat 模型 = LLMModel.capability_domain='chat' 且其 provider 仍参与路由
    （provider.routing_enabled=True 且 provider.capability_domains 包含 'chat'）。
    """
    queryset = apply_chat_provider_filter(queryset, field_prefix=provider_field_prefix)
    queryset = queryset.filter(
        **{
            f"{provider_field_prefix}routing_enabled": True,
            "capability_domain": CHAT_CAPABILITY_DOMAIN,
        }
    )
    return queryset


def _provider_has_chat(provider) -> bool:
    """工具：判断 provider 实例是否包含 chat 能力。兼容 mock 单值 capability_domain。"""
    domains = getattr(provider, "capability_domains", None)
    if domains is not None:
        return CHAT_CAPABILITY_DOMAIN in (domains or [])
    legacy = getattr(provider, "capability_domain", None)
    if legacy is None:
        return True  # 没字段时按默认 chat 处理（与旧逻辑等价）
    return legacy == CHAT_CAPABILITY_DOMAIN


def is_llm_model_instance(model, *, require_chat_mode: bool = False) -> bool:
    """判断模型实例是否属于 chat 能力域 provider/model。"""
    if not model:
        return False
    provider = getattr(model, "provider", None)
    if provider is None:
        return False
    if not _provider_has_chat(provider):
        return False
    if require_chat_mode:
        model_domain = getattr(model, "capability_domain", CHAT_CAPABILITY_DOMAIN)
        if model_domain != CHAT_CAPABILITY_DOMAIN:
            return False
    return True
