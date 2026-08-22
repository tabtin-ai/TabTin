"""
模型解析工具

统一使用 model_id 作为主键，同时兼容 model_name 回退。
"""

from typing import Any, Iterable, Optional, Tuple
import logging

from ..models import LLMModel
from .capability_guard import apply_llm_provider_filter, normalize_model_modes
from .routing_pool import select_model_from_pool

logger = logging.getLogger(__name__)


_DECLARED_PREFIX = "declared:"


def _parse_declared_id(model_id: str) -> Optional[tuple]:
    """解析 declared:{provider}:{model_name} 格式，返回 (provider_name, model_name) 或 None。"""
    if not model_id.startswith(_DECLARED_PREFIX):
        return None
    parts = model_id[len(_DECLARED_PREFIX):].split(":", 1)
    if len(parts) == 2 and parts[0] and parts[1]:
        return parts[0], parts[1]
    return None


def resolve_model(
    *,
    model_id: Optional[str] = None,
    model_name: Optional[str] = None,
    organization_id: Optional[str] = None,
    user_id: Optional[str] = None,
    require_active: bool = True,
    allowed_modes: Optional[Iterable[str]] = None,
) -> Optional[LLMModel]:
    """
    解析模型实例（优先 model_id，其次 model_name）。

    支持 declared:{provider}:{model_name} 格式的 ID：
    自动提取 model_name 并回退到按名称查询，使 Catalog 中的
    静态声明模型能正确解析到 DB 中对应的实际记录。
    """
    queryset = apply_llm_provider_filter(
        LLMModel.objects.select_related("provider"),
        field_prefix="provider__",
    )
    # v0.1：LLMModel.mode 字段已删（0022）；含 chat/completion 的 allowed_modes 等价于 capability_domain='chat'。
    normalized_modes = normalize_model_modes(allowed_modes)
    if normalized_modes and any(m in {"chat", "completion"} for m in normalized_modes):
        queryset = queryset.filter(capability_domain="chat")
    if require_active:
        # v0.1：is_active 字段已删，路由活性 = provider.routing_enabled。
        queryset = queryset.filter(provider__routing_enabled=True)

    if model_id:
        declared = _parse_declared_id(model_id)
        if declared:
            provider_name, declared_model_name = declared
            logger.debug(
                "declared model_id=%s → provider=%s model_name=%s，回退按名称解析",
                model_id, provider_name, declared_model_name,
            )
            return _resolve_by_name(
                queryset, declared_model_name,
                organization_id=organization_id, user_id=user_id,
                require_active=require_active,
                prefer_provider=provider_name,
                allowed_modes=normalized_modes,
            )
        return queryset.filter(id=model_id).first()

    if model_name:
        return _resolve_by_name(
            queryset, model_name,
            organization_id=organization_id, user_id=user_id,
            require_active=require_active,
            allowed_modes=normalized_modes,
        )

    return None


def _resolve_by_name(
    queryset,
    model_name: str,
    *,
    organization_id: Optional[str] = None,
    user_id: Optional[str] = None,
    require_active: bool = True,
    prefer_provider: Optional[str] = None,
    allowed_modes: Optional[Iterable[str]] = None,
) -> Optional[LLMModel]:
    """按 model_name 解析，可选优先匹配指定 provider。"""
    selected = select_model_from_pool(
        model_name=model_name,
        organization_id=organization_id,
        user_id=user_id,
        provider_name=prefer_provider,
        require_active=require_active,
        allowed_modes=allowed_modes,
    )
    if selected:
        return selected

    qs = apply_llm_provider_filter(
        queryset.filter(model_name=model_name),
        field_prefix="provider__",
    )
    if prefer_provider:
        preferred = qs.filter(provider__name=prefer_provider).first()
        if preferred:
            return preferred

    candidates = list(qs[:2])
    if len(candidates) > 1:
        logger.warning(
            "model_name=%s 匹配到多个模型，轮询池未命中时回退首个模型：%s",
            model_name,
            candidates[0].id,
        )
    return candidates[0] if candidates else None


def resolve_model_identity(
    *,
    model_id: Optional[str] = None,
    model_name: Optional[str] = None,
    organization_id: Optional[str] = None,
    user_id: Optional[str] = None,
    require_active: bool = True,
    allowed_modes: Optional[Iterable[str]] = None,
) -> Tuple[Optional[str], Optional[str]]:
    """
    解析并返回 (model_id, model_name)。
    """
    model = resolve_model(
        model_id=model_id,
        model_name=model_name,
        organization_id=organization_id,
        user_id=user_id,
        require_active=require_active,
        allowed_modes=allowed_modes,
    )
    if not model:
        return None, None
    return str(model.id), model.model_name


def check_provider_scope(
    provider: Any,
    organization_id: Optional[str],
    user_id: Optional[str],
    *,
    owner_user_id: Optional[str] = None,
) -> bool:
    """
    判断 provider 的 scope 对 (organization_id, user_id) 组合是否可见。

    当 ``owner_user_id`` 传入或线程上下文中存在 inherit_owner_provider 时，
    Owner 的 scope=user 渠道也视为可见。

    NOTE: routing_pool.resolve_provider_scope_q 实现了等价的 ORM Q 版本，
    修改此处逻辑时务必同步更新 routing_pool 中的 Q 表达式，反之亦然。
    """
    scope = getattr(provider, "scope", "global")

    if scope == "global":
        return True

    if scope == "organization":
        return bool(organization_id) and str(getattr(provider, "organization_id", "")) == str(organization_id)

    if scope == "user":
        # 个人渠道跟随 user_id 跨组织可见；organization_id 仅作历史字段。
        provider_uid = str(getattr(provider, "user_id", ""))

        if user_id and provider_uid == str(user_id):
            return True

        effective_owner = owner_user_id
        if not effective_owner:
            try:
                from apps.services.common.thread_context import get_owner_user_id_for_provider
                effective_owner = get_owner_user_id_for_provider()
            except Exception:
                pass
        if effective_owner and provider_uid == str(effective_owner):
            return True

        return False

    return False


def is_model_visible_for_user(
    model: Optional[LLMModel],
    organization_id: Optional[str],
    user_id: Optional[str],
    *,
    owner_user_id: Optional[str] = None,
) -> bool:
    """v0.1：LLMModel/LLMProvider.is_active 字段已删，可见性 = provider.routing_enabled + scope。"""
    if not model:
        return False
    provider = getattr(model, "provider", None)
    if not provider or not getattr(provider, "routing_enabled", False):
        return False

    return check_provider_scope(provider, organization_id, user_id, owner_user_id=owner_user_id)
