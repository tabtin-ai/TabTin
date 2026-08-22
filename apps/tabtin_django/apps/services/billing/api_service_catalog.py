"""
服务目录 & 服务策略 API

提供 organization 级别的服务定价目录查询、服务开关策略管理。
"""

import logging
from decimal import Decimal
from typing import Any, Dict, List, Optional

from ninja import Router, Schema
from ninja.errors import HttpError

from apps.i18n import _
from apps.i18n.response import success_response
from apps.users.auth.permissions import JWTAuth

from .api_utils import billing_api_errors, safe_decimal
from .models import MeterPricing, OrganizationServicePolicy

logger = logging.getLogger(__name__)

router = Router()

jwt_auth = JWTAuth()

SERVICE_CATALOG_DEFINITION: List[Dict[str, Any]] = [
    {
        "service_key": "llm.tokens",
        "name": "大模型对话",
        "description": "LLM Token 消耗，按模型动态定价",
        "meter_key": "llm.tokens",
        "unit": "千token",
        "category": "llm",
        "managed_by": "llm",
    },
    {
        "service_key": "media.image",
        "name": "AI 文生图",
        "description": "使用 AI 根据文字描述生成图片",
        "meter_key": "media.image.count",
        "unit": "张",
        "category": "media",
        "toggle_field": "enable_media_image",
    },
    {
        "service_key": "media.video",
        "name": "AI 视频生成",
        "description": "使用 AI 根据文字描述生成视频",
        "meter_key": "media.video.seconds",
        "unit": "秒",
        "category": "media",
        "toggle_field": "enable_media_video",
    },
    {
        "service_key": "media.bgm",
        "name": "BGM 背景音乐",
        "description": "使用 AI 生成背景音乐（MiniMax）",
        "meter_key": "media.bgm.seconds",
        "unit": "秒",
        "category": "media",
        "managed_by": "media.audio",
    },
    {
        "service_key": "speech.asr",
        "name": "语音识别",
        "description": "将语音转换为文字（ASR）",
        "meter_key": "speech.asr.seconds",
        "unit": "秒",
        "category": "speech",
        "toggle_field": "enable_speech_asr",
    },
    {
        "service_key": "speech.tts",
        "name": "语音合成",
        "description": "将文字转换为语音（TTS）",
        "meter_key": "speech.tts.characters",
        "unit": "百字符",
        "category": "speech",
        "toggle_field": "enable_speech_tts",
    },
    {
        "service_key": "rag.embedding",
        "name": "RAG 向量化",
        "description": "文档与业务数据向量化索引，用于智能检索",
        "meter_key": "rag.embedding.tokens",
        "unit": "千token",
        "category": "knowledge",
        "toggle_field": "enable_rag_embedding",
        "sub_toggles": [
            {"key": "auto_doc_index", "name": "文档自动索引", "field": "enable_auto_doc_index"},
        ],
    },
    {
        "service_key": "web.search",
        "name": "网页搜索",
        "description": "AI 联网搜索，按次计费",
        "meter_key": "search.web.request",
        "unit": "次",
        "category": "knowledge",
        "toggle_field": "enable_web_search",
    },
    {
        "service_key": "storage",
        "name": "对象存储",
        "description": "文件存储空间，超出套餐部分按量计费",
        "meter_key": "storage.gb",
        "unit": "GB",
        "category": "storage",
        "managed_by": "billing",
    },
]

_TOGGLE_FIELDS = frozenset({
    "enable_media_image",
    "enable_media_video",
    "enable_speech_asr",
    "enable_speech_tts",
    "enable_rag_embedding",
    "enable_web_search",
    "enable_auto_doc_index",
})


def _check_organization_permission(request, organization_id: str, permission: str = "viewer") -> None:
    from apps.i18n import get_text
    from apps.tabtinspace.services import OrganizationService

    ws_service = OrganizationService(user=request.auth)
    if not ws_service.check_organization_permission(organization_id, permission):
        raise HttpError(403, get_text("chat.organization_mismatch", organization_id=organization_id))


def _get_meter_prices(organization_id: str) -> Dict[str, Dict[str, Any]]:
    """获取所有 meter 的当前生效价格"""
    from django.db.models import Q
    from django.utils import timezone

    now = timezone.now()
    rules = MeterPricing.objects.filter(
        is_active=True,
        effective_from__lte=now,
    ).filter(
        Q(effective_to__isnull=True) | Q(effective_to__gt=now)
    ).filter(
        Q(scope="global") | Q(scope="organization", organization_id=organization_id),
        provider_key="",
        model_name="",
    )

    price_map: Dict[str, Dict[str, Any]] = {}
    for rule in rules:
        key = rule.meter_key
        existing = price_map.get(key)
        if existing is None:
            price_map[key] = {
                "unit_price": rule.unit_price,
                "currency": rule.currency,
                "scope": rule.scope,
            }
        else:
            new_is_ws = rule.scope == "organization" and rule.organization_id == organization_id
            old_is_ws = existing["scope"] == "organization"
            if new_is_ws and not old_is_ws:
                price_map[key] = {
                    "unit_price": rule.unit_price,
                    "currency": rule.currency,
                    "scope": rule.scope,
                }

    return price_map


def _serialize_policy(policy: Optional[OrganizationServicePolicy]) -> Dict[str, Any]:
    if policy is None:
        return {field: True for field in _TOGGLE_FIELDS}
    return {field: getattr(policy, field, True) for field in _TOGGLE_FIELDS}


def build_service_catalog_data(organization_id: str) -> Dict[str, Any]:
    """构建服务目录 payload（用户侧与 Admin staff 共用）。"""
    price_map = _get_meter_prices(organization_id)
    policy = OrganizationServicePolicy.objects.filter(organization_id=organization_id).first()
    policy_data = _serialize_policy(policy)

    services = []
    for svc_def in SERVICE_CATALOG_DEFINITION:
        meter_key = svc_def["meter_key"]
        pricing = price_map.get(meter_key, {})

        toggle_field = svc_def.get("toggle_field")
        managed_by = svc_def.get("managed_by")

        item: Dict[str, Any] = {
            "service_key": svc_def["service_key"],
            "name": svc_def["name"],
            "description": svc_def["description"],
            "meter_key": meter_key,
            "unit": svc_def["unit"],
            "unit_price": str(safe_decimal(pricing.get("unit_price"))) if pricing else None,
            "currency": pricing.get("currency", "CREDITS") if pricing else "CREDITS",
            "category": svc_def["category"],
            "enabled": policy_data.get(toggle_field, True) if toggle_field else True,
            "toggleable": toggle_field is not None,
            "managed_by": managed_by,
        }

        sub_toggles = svc_def.get("sub_toggles")
        if sub_toggles:
            item["sub_toggles"] = [
                {
                    "key": st["key"],
                    "name": st["name"],
                    "enabled": policy_data.get(st["field"], True),
                }
                for st in sub_toggles
            ]

        services.append(item)

    return {
        "organization_id": organization_id,
        "services": services,
        "policy": policy_data,
    }


@router.get(
    "/organizations/{organization_id}/service-catalog",
    auth=jwt_auth,
    tags=["服务目录"],
)
@billing_api_errors
def get_service_catalog(request, organization_id: str):
    """获取组织服务目录（含定价和开关状态）"""
    _check_organization_permission(request, organization_id, "viewer")
    return success_response(
        data=build_service_catalog_data(organization_id),
        message="服务目录获取成功",
    )


class ServicePolicyUpdateIn(Schema):
    enable_media_image: Optional[bool] = None
    enable_media_video: Optional[bool] = None
    enable_speech_asr: Optional[bool] = None
    enable_speech_tts: Optional[bool] = None
    enable_rag_embedding: Optional[bool] = None
    enable_web_search: Optional[bool] = None
    enable_auto_doc_index: Optional[bool] = None


@router.patch(
    "/organizations/{organization_id}/service-policy",
    auth=jwt_auth,
    tags=["服务目录"],
)
@billing_api_errors
def update_service_policy(request, organization_id: str, data: ServicePolicyUpdateIn):
    """更新组织服务开关策略（需 admin 权限）"""
    _check_organization_permission(request, organization_id, "owner")

    from django.db import transaction

    with transaction.atomic():
        policy, _ = OrganizationServicePolicy.objects.select_for_update().get_or_create(
            organization_id=organization_id,
            defaults={"updated_by": str(getattr(request.auth, "id", ""))},
        )

        changed_fields = []
        for field in _TOGGLE_FIELDS:
            new_val = getattr(data, field, None)
            if new_val is not None and getattr(policy, field) != new_val:
                setattr(policy, field, new_val)
                changed_fields.append(field)

        if changed_fields:
            policy.updated_by = str(getattr(request.auth, "id", ""))
            policy.save(update_fields=changed_fields + ["updated_by", "updated_at"])

    if changed_fields:
        from .services.service_guard import ServiceGuardService
        ServiceGuardService.invalidate_cache(organization_id)

        logger.info(
            "[ServicePolicy] organization=%s updated fields=%s by user=%s",
            organization_id, changed_fields, policy.updated_by,
        )

    return success_response(
        data=_serialize_policy(policy),
        message="服务策略更新成功",
    )


class CostEstimateIn(Schema):
    meter_key: str
    quantity: float
    organization_id: str = ""
    provider_key: Optional[str] = None
    model_name: Optional[str] = None


@router.post(
    "/estimate",
    auth=jwt_auth,
    tags=["费用预估"],
)
@billing_api_errors
def estimate_cost(request, data: CostEstimateIn):
    """预估操作费用（支持按模型/渠道查询精确定价）"""
    effective_id = data.organization_id
    _check_organization_permission(request, effective_id, "viewer")

    from .services.pricing_service import MeterPricingService

    unit_price = MeterPricingService.get_unit_price(
        data.meter_key,
        organization_id=effective_id,
        provider_key=data.provider_key or None,
        model_name=data.model_name or None,
    )

    if unit_price is None:
        return success_response(
            data={
                "meter_key": data.meter_key,
                "quantity": data.quantity,
                "unit_price": None,
                "estimated_cost": None,
                "currency": "CREDITS",
            },
            message="无法获取定价",
        )

    quantity_dec = Decimal(str(data.quantity))
    estimated_cost = quantity_dec * unit_price

    svc_def = next(
        (s for s in SERVICE_CATALOG_DEFINITION if s["meter_key"] == data.meter_key),
        None,
    )

    return success_response(
        data={
            "meter_key": data.meter_key,
            "quantity": data.quantity,
            "unit_price": str(safe_decimal(unit_price)),
            "unit": svc_def["unit"] if svc_def else "unit",
            "estimated_cost": str(safe_decimal(estimated_cost)),
            "currency": "CREDITS",
            "service_name": svc_def["name"] if svc_def else data.meter_key,
        },
        message="费用预估成功",
    )
