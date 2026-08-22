"""
Model Resolver — 模型解析与 Agent 名称选择。

从 ChatService 提取的 Stage 1 模型解析逻辑。
纯 ORM 查询 + capability guard，无副作用。
"""

from __future__ import annotations

from typing import Any, NamedTuple, Optional, Sequence
from uuid import UUID

import logging

from django.conf import settings

from apps.services.common.agent_protocol.constants import TIN_AGENT_NAME

logger = logging.getLogger(__name__)

__all__ = [
    "ResolvedModel",
    "resolve_model",
    "resolve_agent_name",
    "resolve_execution_model_id",
]


class ResolvedModel(NamedTuple):
    instance: Any
    fell_back: bool


def _is_provider_routing_enabled(model) -> bool:
    """会话粘性模型也必须满足渠道可路由，禁止回退到已禁用自定义渠道。"""
    provider = getattr(model, "provider", None)
    return bool(provider and getattr(provider, "routing_enabled", False))


def _is_uuid_model_id(model_id: Any) -> bool:
    try:
        UUID(str(model_id))
    except (ValueError, TypeError, AttributeError):
        return False
    return True


def _chat_catalog_model_ids(
    *,
    organization_id: Optional[str],
    user_id: Optional[str],
) -> list[str]:
    """与模型选择列表同口径：routing + scope 可见 + chat 域 + 成员档位。"""
    from apps.services.llm.services import get_available_models
    from apps.services.llm.services.factory import filter_models_by_member_tier

    available = get_available_models(
        user_id=str(user_id) if user_id else None,
        organization_id=str(organization_id) if organization_id else None,
    )
    if organization_id and user_id:
        available = filter_models_by_member_tier(
            available,
            str(organization_id),
            str(user_id),
        )

    ids: list[str] = []
    for entry in available:
        mode = entry.get("mode") or entry.get("capability_domain")
        if mode not in (None, "chat", "completion"):
            continue
        model_id = entry.get("id")
        if not _is_uuid_model_id(model_id):
            continue
        ids.append(str(model_id))
    return ids


def _load_catalog_model(model_id: str):
    from apps.services.llm.models import LLMModel
    from apps.services.llm.services.capability_guard import is_llm_model_instance

    try:
        model = LLMModel.objects.select_related("provider").get(
            id=model_id,
            provider__routing_enabled=True,
        )
    except LLMModel.DoesNotExist:
        return None
    if not is_llm_model_instance(model, require_chat_mode=True):
        return None
    return model


def _pick_first_in_catalog(candidates: Sequence[Optional[str]], catalog_ids: set[str]):
    for candidate in candidates:
        if not candidate:
            continue
        model_id = str(candidate).strip()
        if not model_id or model_id not in catalog_ids:
            continue
        model = _load_catalog_model(model_id)
        if model is not None:
            return model
    return None


def resolve_execution_model_id(
    *,
    preferred_model_id: Optional[str] = None,
    organization_id: Optional[str] = None,
    user_id: Optional[str] = None,
    session: Any = None,
) -> Optional[str]:
    """无人值守 / 转发路径的统一选模。

    规则：
    1. ``preferred_model_id`` 仅当落在当前组织/用户 **chat catalog** 时可用
       （与 Electron 模型列表同口径；禁止非空即透传）。
    2. 否则回落：会话 sticky（若在 catalog）→ 组织默认 → ``DEFAULT_LLM_MODEL``
       → catalog 第一项。

    Returns:
        可用模型 UUID 字符串；catalog 全空时返回 None。
    """
    from apps.services.llm.api_common import _get_organization_default_model_id
    from apps.services.llm.models import LLMModel
    from apps.services.llm.services.capability_guard import apply_chat_model_filter

    org_id = str(organization_id) if organization_id else None
    uid = str(user_id) if user_id else None
    preferred = (str(preferred_model_id).strip() if preferred_model_id else "") or None

    catalog_ids_list = _chat_catalog_model_ids(
        organization_id=org_id,
        user_id=uid,
    )
    catalog_ids = set(catalog_ids_list)

    if preferred and preferred not in catalog_ids:
        logger.warning(
            "[model_resolver] preferred_model_id=%s 不在 chat catalog "
            "(org=%s user=%s)，跳过盲信透传",
            preferred,
            org_id,
            uid,
        )

    session_current = getattr(session, "current_model_id", None) if session is not None else None
    session_default = getattr(session, "default_model_id", None) if session is not None else None
    org_default = _get_organization_default_model_id(org_id) if org_id else None

    picked = _pick_first_in_catalog(
        [preferred, session_current, session_default, org_default],
        catalog_ids,
    )
    if picked is not None:
        return str(picked.id)

    default_model_name = getattr(settings, "DEFAULT_LLM_MODEL", "gpt-4o")
    if default_model_name and catalog_ids:
        by_name = apply_chat_model_filter(
            LLMModel.objects.select_related("provider").filter(
                model_name=default_model_name,
                provider__routing_enabled=True,
                id__in=list(catalog_ids),
            ),
        ).order_by("-provider__priority", "-created_at").first()
        if by_name is not None:
            return str(by_name.id)

    if catalog_ids_list:
        first = _load_catalog_model(catalog_ids_list[0])
        if first is not None:
            return str(first.id)

    # catalog 全空（含成员档位过滤后为空）：不得再走 resolve_model 选中 catalog 外
    # session/系统模型——与 docstring / 产品口径一致，清晰失败由调用方承接。
    logger.warning(
        "[model_resolver] chat catalog 为空，拒绝选中 catalog 外模型 "
        "(org=%s user=%s preferred=%s)",
        org_id,
        uid,
        preferred,
    )
    return None


def resolve_model(session, model_id: Optional[str]) -> ResolvedModel:
    """解析请求的模型 ID，必要时回退到会话默认或系统默认。

    回退链：指定 model_id → session.current_model / default_model → 系统默认（按 priority 排序）。
    每个候选模型均经 ``is_llm_model_instance(require_chat_mode=True)`` 与
    ``provider.routing_enabled`` 校验（：禁用渠道不得因会话粘性继续可用）。
    """
    from apps.services.llm.models import LLMModel
    from apps.services.llm.services.capability_guard import is_llm_model_instance

    model_instance = None
    fell_back = False
    if model_id:
        try:
            # v0.1：LLMProvider.is_active 字段已删（0022），可路由 = routing_enabled。
            model_instance = LLMModel.objects.select_related('provider').get(
                id=model_id, provider__routing_enabled=True,
            )
        except LLMModel.DoesNotExist:
            logger.warning(
                "[model_resolver] Specified model %s not found or provider disabled, "
                "using session default", model_id,
            )
            fell_back = True

        if model_instance and not is_llm_model_instance(model_instance, require_chat_mode=True):
            logger.warning(
                "[model_resolver] model %s (provider=%s, capability_domain=%s) "
                "不适用于聊天链路，回退到 session 默认模型",
                model_id,
                getattr(model_instance.provider, 'name', '?'),
                getattr(model_instance, 'capability_domain', '?'),
            )
            model_instance = None
            fell_back = True

    if not model_instance:
        # v0.1 宪法 §5.1：current_model / default_model 是软引用 property，调用一次会单独
        # fetch；先取 _id 字段判断哪个非空，再读 property 一次拿对象。
        candidate_id = session.current_model_id or session.default_model_id
        candidate = None
        if candidate_id:
            candidate = (
                session.current_model
                if str(session.current_model_id or '') == str(candidate_id)
                else session.default_model
            )
        if (
            candidate
            and is_llm_model_instance(candidate, require_chat_mode=True)
            and _is_provider_routing_enabled(candidate)
        ):
            model_instance = candidate
        else:
            if candidate and not _is_provider_routing_enabled(candidate):
                logger.warning(
                    "[model_resolver] session 默认模型 %s 的渠道 routing_enabled=False，"
                    "跳过粘性回退，尝试系统默认模型",
                    getattr(candidate, 'id', '?'),
                )
            elif candidate:
                logger.warning(
                    "[model_resolver] session 默认模型 %s (provider=%s, capability_domain=%s) "
                    "不适用于聊天，尝试系统默认模型",
                    getattr(candidate, 'id', '?'),
                    getattr(getattr(candidate, 'provider', None), 'name', '?'),
                    getattr(candidate, 'capability_domain', '?'),
                )
            from apps.services.llm.services.capability_guard import apply_chat_model_filter
            from apps.services.llm.models import LLMModel as _LLMModel
            model_instance = apply_chat_model_filter(
                _LLMModel.objects.filter(provider__routing_enabled=True),
            ).order_by('-provider__priority', '-created_at').first()
            fell_back = True

    return ResolvedModel(instance=model_instance, fell_back=fell_back)


def resolve_agent_name(agent_name: Optional[str] = None) -> str:
    """当前仅支持 tin，任何其他值均回退 tin。"""
    return TIN_AGENT_NAME
