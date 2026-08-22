"""媒体 Scene 的最终用户结算契约。"""

from __future__ import annotations

from decimal import Decimal
from urllib.parse import urlparse

from apps.services.llm.services._runtime.invocation import (
    FUNDING_MODE_PROVIDER_CREDIT_V1,
    SettlementIdempotencyKeyBuilder,
    normalize_funding_mode,
)
from apps.services.media_generation.pricing import (
    IMAGE_SUCCESS_METER_KEY,
    IMAGE_SUCCESS_UNIT_PRICE,
)

IMAGE_SCENE_KEY = "media_image_generate"


def _is_valid_image_url(value: object) -> bool:
    if not isinstance(value, str):
        return False
    parsed = urlparse(value.strip())
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def successful_image_urls(task, result) -> list[str]:
    """返回实际通过基础校验的 Provider 图片，不读取 requested_count。"""
    candidates = result.result_urls or getattr(task, "result_urls", None) or []
    if not isinstance(candidates, list):
        return []
    return [url.strip() for url in candidates if _is_valid_image_url(url)]


def settle_image_task(task, result) -> dict:
    """按成功图片数做一次稳定的最终结算。"""
    if getattr(task, "task_type", "") not in {
        "text2image",
        "image2image",
        "image_edit",
    }:
        raise ValueError("settle_image_task 只接受图片生成任务")
    if getattr(result, "status", "") != "succeeded":
        raise ValueError("只有 Provider succeeded 结果可以进入图片最终结算")

    parameters = dict(getattr(task, "parameters", None) or {})
    valid_urls = successful_image_urls(task, result)
    successful_count = len(valid_urls)
    total_credits = (Decimal(successful_count) * IMAGE_SUCCESS_UNIT_PRICE).quantize(
        Decimal("0.0001")
    )
    funding_mode = normalize_funding_mode(parameters.get("_funding_mode"))
    idempotency_key = SettlementIdempotencyKeyBuilder.build(
        organization_id=str(getattr(task, "organization_id", "") or ""),
        execution_key=IMAGE_SCENE_KEY,
        invocation_id=f"media-task:{task.id}",
    )

    from apps.services.billing.services.gateway import BillingGateway

    gateway_result = BillingGateway.settle_fixed_usage(
        organization_id=str(getattr(task, "organization_id", "") or ""),
        user_id=str(getattr(task, "user_id", "") or ""),
        required_credits=total_credits,
        meter_key=IMAGE_SUCCESS_METER_KEY,
        quantity=Decimal(successful_count),
        unit="image",
        unit_price=IMAGE_SUCCESS_UNIT_PRICE,
        provider_key=str(parameters.get("_llm_provider_name") or ""),
        model_id=str(parameters.get("_llm_model_id") or ""),
        model_name=str(parameters.get("_llm_model_name") or ""),
        idempotency_key=idempotency_key,
        scene_key=IMAGE_SCENE_KEY,
        biz_type="media_generation",
        biz_id=str(task.id),
        funding_mode=funding_mode,
        context={
            "successful_image_count": successful_count,
            "funding_mode": funding_mode,
            "pricing_source": "image_success_unit_price_v1",
        },
    )

    task.cost_amount = total_credits
    task.cost_unit = "points"
    task.save(update_fields=["cost_amount", "cost_unit", "updated_at"])
    return {
        **(gateway_result or {}),
        "successful_image_count": successful_count,
        "unit_price": str(IMAGE_SUCCESS_UNIT_PRICE),
        "total_credits": str(total_credits),
        "idempotency_key": idempotency_key,
        "funding_mode": funding_mode,
        "provider_credit_enabled": funding_mode == FUNDING_MODE_PROVIDER_CREDIT_V1,
    }


__all__ = [
    "IMAGE_SCENE_KEY",
    "IMAGE_SUCCESS_METER_KEY",
    "IMAGE_SUCCESS_UNIT_PRICE",
    "settle_image_task",
    "successful_image_urls",
]
