"""
BillingPrecheck — 计费前置检查

check_balance + check_budget → E17
先做骨架，具体计费逻辑引用现有 billing 服务。
"""

from __future__ import annotations

import logging

from apps.services.llm.scenes.exceptions import BudgetExceeded

logger = logging.getLogger(__name__)


def _current_funding_mode() -> str:
    from apps.services.llm.services._runtime.invocation import current_funding_mode

    return current_funding_mode()


def _record_precheck_observability(
    *,
    scene_key: str,
    capability_domain: str,
    model_id: str | None,
    context: dict,
    status: str,
) -> None:
    logger.info(
        "ai_scene_billing_precheck",
        extra={
            "event": "ai_scene_billing_precheck",
            "scene_key": scene_key,
            "capability_domain": capability_domain,
            "payer": "user",
            "model_source": "official",
            "model_id": model_id,
            "stable_invocation": bool(context.get("stable_invocation", False)),
            "billing_precheck_status": status,
            "funding_mode": context.get("funding_mode") or _current_funding_mode(),
            "request_id": context.get("request_id"),
        },
    )


def check_billing(
    *,
    organization_id: str,
    user_id: str,
    scene_key: str,
    capability_domain: str,
    estimated_tokens: int = 0,
    model_id: str | None = None,
    context: dict | None = None,
    perform_side_effects: bool = True,
) -> None:
    """
    检查团队余额和预算。

    不足时抛 BudgetExceeded (E17)。
    BYOK 路径不走此检查（在入口层判断）。

    骨架实现：后续对接 BillingService 的 check_balance / check_budget。
    """
    billing_context = dict(context or {})
    legacy_block: BudgetExceeded | None = None
    try:
        from apps.services.billing.services.billing_precheck import billing_precheck

        result = billing_precheck(organization_id, user_id, context=f"scene:{scene_key}")
        if result.blocked:
            legacy_block = BudgetExceeded(
                f"organization_id='{organization_id}' 计费预检拦截 "
                f"(layer={result.layer}, reason={result.reason})",
                scene_key=scene_key,
            )
            # Model-aware precheck below can account for model-specific funding
            # such as provider credits. Keep legacy fail-close behavior only for
            # model-less probes.
            if not (model_id and estimated_tokens > 0):
                _record_precheck_observability(
                    scene_key=scene_key,
                    capability_domain=capability_domain,
                    model_id=model_id,
                    context=billing_context,
                    status="blocked",
                )
                raise legacy_block
    except ImportError:
        logger.debug("billing_precheck 未就绪，跳过 legacy 预检")
    except BudgetExceeded:
        raise
    except Exception as e:
        logger.warning("Legacy BillingPrecheck 异常，跳过: %s", e)

    if estimated_tokens <= 0:
        if legacy_block:
            _record_precheck_observability(
                scene_key=scene_key,
                capability_domain=capability_domain,
                model_id=model_id,
                context=billing_context,
                status="blocked",
            )
            raise legacy_block
        _record_precheck_observability(
            scene_key=scene_key,
            capability_domain=capability_domain,
            model_id=model_id,
            context=billing_context,
            status="allowed",
        )
        return

    try:
        from apps.services.billing.services.gateway import BillingGateway

        gateway_decision = BillingGateway.precheck_llm_usage(
            organization_id=organization_id,
            user_id=user_id,
            estimated_tokens=estimated_tokens,
            model_id=model_id,
            context={
                **billing_context,
                "scene_key": scene_key,
                "capability_domain": capability_domain,
            },
            idempotency_key=billing_context.get("idempotency_key"),
            perform_side_effects=perform_side_effects,
        )
    except Exception as e:
        logger.warning("BillingGateway 预检异常，阻断 LLM 调用: %s", e)
        _record_precheck_observability(
            scene_key=scene_key,
            capability_domain=capability_domain,
            model_id=model_id,
            context=billing_context,
            status="error",
        )
        raise BudgetExceeded("LLM 计费预检异常，已阻断调用", scene_key=scene_key) from e

    if not gateway_decision.get("allowed"):
        _record_precheck_observability(
            scene_key=scene_key,
            capability_domain=capability_domain,
            model_id=model_id,
            context=billing_context,
            status="blocked",
        )
        raise BudgetExceeded(
            gateway_decision.get("message") or "LLM 计费预检拦截",
            scene_key=scene_key,
        )
    _record_precheck_observability(
        scene_key=scene_key,
        capability_domain=capability_domain,
        model_id=model_id,
        context=billing_context,
        status="allowed",
    )
