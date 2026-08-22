"""
LLM 渠道路由池。

目标：
1. 对同名模型的多渠道配置提供轮询调度
2. 跳过不可路由渠道（停用/摘流/异常）
3. 支持按 organization/user 可见性过滤
"""

from __future__ import annotations

import logging
from typing import Iterable, List, Optional, TYPE_CHECKING

from django.core.cache import cache
from django.db.models import Q
from django.utils import timezone

from .capability_guard import apply_llm_provider_filter, normalize_model_modes

if TYPE_CHECKING:
    from ..models import LLMModel

logger = logging.getLogger(__name__)

DEGRADED_WEIGHT_FACTOR = 0.5
EXPANDED_WEIGHT_CAP = 50


def _build_pool_key(
    *,
    model_name: str,
    organization_id: Optional[str],
    user_id: Optional[str],
    provider_name: Optional[str],
    provider_key: Optional[str],
    allowed_modes: Optional[Iterable[str]],
) -> str:
    normalized_modes = normalize_model_modes(allowed_modes)
    return (
        "llm:pool:"
        f"model:{model_name}|ws:{organization_id or '-'}|user:{user_id or '-'}"
        f"|pn:{provider_name or '-'}|pk:{provider_key or '-'}"
        f"|modes:{','.join(normalized_modes or ['*'])}"
    )


def _get_owner_user_id_from_context() -> Optional[str]:
    """从线程上下文读取可选 provider owner user_id override。"""
    try:
        from apps.services.common.thread_context import get_owner_user_id_for_provider
        return get_owner_user_id_for_provider()
    except Exception:
        return None


def resolve_provider_scope_q(
    organization_id: Optional[str],
    user_id: Optional[str],
    *,
    owner_user_id: Optional[str] = None,
) -> Q:
    """
    构建 provider scope 三级可见性 Q 对象（global > organization > user）。

    用于 LLMModel queryset 过滤。查询字段以 ``provider__`` 为前缀。

    当 ``owner_user_id`` 显式传入或线程上下文中存在 inherit_owner_provider 时，
    额外将 Owner 的 scope=user 渠道纳入可见范围。

    **重要**：model_resolver.is_model_visible_for_user / check_provider_scope
    实现了等价的 per-object 可见性检查。两处逻辑必须保持同步，修改一处时请同步另一处。
    """
    effective_owner = owner_user_id or _get_owner_user_id_from_context()

    q = Q(provider__scope="global")

    if organization_id:
        q |= Q(provider__scope="organization", provider__organization_id=organization_id)
    # scope=user 跟随本人跨组织可见；勿再按 organization_id 收窄。
    if user_id:
        q |= Q(provider__scope="user", provider__user_id=user_id)

    if effective_owner and effective_owner != user_id:
        q |= Q(provider__scope="user", provider__user_id=effective_owner)

    return q


def _expand_weighted_candidates(candidates: List["LLMModel"]) -> List["LLMModel"]:
    expanded: List[LLMModel] = []
    for model in candidates:
        provider = model.provider
        weight = max(1, int(getattr(provider, "routing_weight", 1) or 1))
        if provider.runtime_status == "degraded":
            weight = max(1, int(weight * DEGRADED_WEIGHT_FACTOR))
        expanded.extend([model] * min(weight, EXPANDED_WEIGHT_CAP))
    return expanded


def select_model_from_pool(
    *,
    model_name: str,
    organization_id: Optional[str] = None,
    user_id: Optional[str] = None,
    provider_name: Optional[str] = None,
    provider_key: Optional[str] = None,
    require_active: bool = True,
    owner_user_id: Optional[str] = None,
    allowed_modes: Optional[Iterable[str]] = None,
) -> Optional["LLMModel"]:
    """
    从同名模型池中选择一个模型实例（加权轮询）。

    返回值：
    - 命中时返回 LLMModel
    - 未命中返回 None
    """
    from ..models import LLMModel

    queryset = apply_llm_provider_filter(
        LLMModel.objects.select_related("provider").filter(model_name=model_name),
        field_prefix="provider__",
    )
    # v0.1：LLMModel.mode 字段已删（0022），allowed_modes 入参仅保留给历史调用方，
    # 真正过滤改为按 capability_domain；非 chat/completion 直接落到 chat 域。
    normalized_modes = normalize_model_modes(allowed_modes)
    if normalized_modes and any(m in {"chat", "completion"} for m in normalized_modes):
        queryset = queryset.filter(capability_domain="chat")
    if require_active:
        # v0.1：LLMProvider.is_active / LLMModel.is_active 字段已删（0022）；
        # 路由活性 = routing_enabled + runtime_status 非 unhealthy + 不在冷却期。
        now = timezone.now()
        queryset = queryset.filter(
            provider__routing_enabled=True,
        ).exclude(
            provider__runtime_status="unhealthy",
        ).exclude(
            provider__runtime_cooldown_until__gt=now,
        )

    scope_q = resolve_provider_scope_q(organization_id, user_id, owner_user_id=owner_user_id)
    queryset = queryset.filter(scope_q)

    if provider_name:
        queryset = queryset.filter(provider__name=provider_name)
    if provider_key:
        queryset = queryset.filter(provider__provider_key=provider_key)

    candidates = list(
        queryset.order_by(
            "-provider__priority",
            "-provider__routing_weight",
            "provider__updated_at",
            "id",
        )[:200]
    )

    if not candidates and require_active:
        fallback_queryset = apply_llm_provider_filter(
            LLMModel.objects.select_related("provider")
            .filter(model_name=model_name, provider__routing_enabled=True),
            field_prefix="provider__",
        )
        if normalized_modes and any(m in {"chat", "completion"} for m in normalized_modes):
            fallback_queryset = fallback_queryset.filter(capability_domain="chat")
        candidates = list(
            fallback_queryset
            .exclude(provider__runtime_cooldown_until__gt=now)
            .filter(scope_q)
            .order_by("-provider__priority", "-provider__routing_weight", "provider__updated_at", "id")[:200]
        )

    if not candidates:
        return None

    expanded = _expand_weighted_candidates(candidates)
    if not expanded:
        expanded = candidates

    pool_key = _build_pool_key(
        model_name=model_name,
        organization_id=organization_id,
        user_id=user_id,
        provider_name=provider_name,
        provider_key=provider_key,
        allowed_modes=normalized_modes,
    )
    cursor_key = f"{pool_key}:cursor"

    cursor = cache.get(cursor_key) or 0
    idx = int(cursor) % len(expanded)
    selected = expanded[idx]
    cache.set(cursor_key, int(cursor) + 1, 86400)

    logger.debug(
        "[LLM Pool] model=%s selected_model_id=%s provider=%s cursor=%s pool_size=%s expanded_size=%s",
        model_name,
        selected.id,
        selected.provider.provider_key,
        cursor,
        len(candidates),
        len(expanded),
    )

    return selected
