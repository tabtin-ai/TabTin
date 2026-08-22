"""Unified Billing Gateway for LLM token consumption.

This gateway is the only new code path that should settle wallet-backed
LLM consumption. It intentionally wraps the existing LLM ledger and wallet
implementation first, so the entrypoint can be centralized before later PRs
expand the billing schema.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Dict, Optional

from django.conf import settings
from django.db import IntegrityError

from apps.services.billing.services.llm_budget_service import OrganizationLlmBudgetService
from apps.services.billing.services.policy_service import OrganizationBillingPolicyService
from apps.services.billing.services.pricing_service import MeterPricingService
from apps.services.billing.services.usage_service import BillingUsageService

logger = logging.getLogger(__name__)


LLM_QUOTA_INSUFFICIENT = "BILLING_LLM_QUOTA_INSUFFICIENT"
LLM_WALLET_INSUFFICIENT = "BILLING_WALLET_INSUFFICIENT"


@dataclass(frozen=True)
class BillingGatewayDecision:
    allowed: bool
    code: str | None = None
    message: str | None = None
    required_credits: Decimal = Decimal("0")
    included_available: Decimal = Decimal("0")
    wallet_available: Decimal = Decimal("0")
    wallet_required: Decimal = Decimal("0")
    charge_mode: str = "free"
    metadata: Dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {
            "allowed": self.allowed,
            "code": self.code,
            "message": self.message,
            "required_credits": str(self.required_credits),
            "included_available": str(self.included_available),
            "wallet_available": str(self.wallet_available),
            "wallet_required": str(self.wallet_required),
            "charge_mode": self.charge_mode,
            "metadata": self.metadata,
        }


class BillingGateway:
    """Single entrypoint for platform-paid LLM billing."""

    CREDITS_QUANT = Decimal("0.0001")

    @classmethod
    def _quantize(cls, value: Decimal | int | str | float | None) -> Decimal:
        return Decimal(str(value or 0)).quantize(cls.CREDITS_QUANT)

    @classmethod
    def _resolve_model_config(
        cls,
        *,
        model_id: str | None = None,
        model_config: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        if model_config is not None:
            resolved = dict(model_config)
            if model_id:
                resolved.setdefault("model_id", str(model_id))
            resolved.setdefault(
                "canonical_provider_key",
                str(resolved.get("provider_key") or "").strip(),
            )
            return resolved
        if not model_id:
            return {}
        try:
            from apps.services.llm.models import LLMModel

            model = LLMModel.objects.select_related("provider").get(id=model_id)
            provider = getattr(model, "provider", None)
            return {
                "provider_key": str(getattr(provider, "provider_key", "") or getattr(provider, "name", "") or ""),
                "canonical_provider_key": str(
                    getattr(provider, "provider_key", "") or ""
                ),
                "model_name": str(getattr(model, "model_name", "") or ""),
                "input_price_per_1k": str(getattr(model, "input_price_per_1k", 0) or 0),
                "output_price_per_1k": str(getattr(model, "output_price_per_1k", 0) or 0),
                "model_id": str(model_id),
                "provider_id": str(getattr(model, "provider_id", "") or ""),
            }
        except Exception as exc:
            logger.warning("[BillingGateway] model config resolve failed: model_id=%s err=%s", model_id, exc)
            return {"model_id": str(model_id or "")}

    @classmethod
    def _estimate_credits(
        cls,
        *,
        organization_id: str,
        estimated_tokens: int,
        model_config: Dict[str, Any],
    ) -> Decimal:
        if estimated_tokens <= 0:
            return Decimal("0")
        provider_key = str(
            model_config.get("provider_key")
            or model_config.get("provider")
            or ""
        ).strip()
        model_name = str(
            model_config.get("model_name")
            or model_config.get("model")
            or ""
        ).strip()
        meter_key = (
            f"llm.{provider_key}.{model_name}.input_tokens"
            if provider_key and model_name
            else "llm.input_tokens"
        )
        fallback_price = Decimal(str(model_config.get("input_price_per_1k", 0) or 0))
        configured_input_price = MeterPricingService.get_unit_price(
            meter_key,
            organization_id=organization_id,
            provider_key=provider_key,
            model_name=model_name,
            default_price=fallback_price,
        )
        output_price = Decimal(str(model_config.get("output_price_per_1k", 0) or 0))
        # Precheck receives an estimate rather than the final usage split. Use the
        # higher token price so output-heavy calls cannot be under-estimated.
        price = max(Decimal(str(configured_input_price or 0)), output_price)
        credits_rate = Decimal(str(getattr(settings, "CREDITS_PER_YUAN", 100)))
        return cls._quantize((Decimal(estimated_tokens) / Decimal(1000)) * price * credits_rate)

    @classmethod
    def _wallet_available(cls, organization_id: str) -> Decimal:
        if not organization_id:
            return Decimal("0")
        try:
            from apps.users.wallet.models import OrganizationWallet

            wallet = OrganizationWallet.objects.filter(organization_id=organization_id).first()
            return wallet.get_available_credits_precise() if wallet else Decimal("0")
        except Exception as exc:
            logger.warning("[BillingGateway] wallet lookup failed: organization=%s err=%s", organization_id, exc)
            return Decimal("0")

    @classmethod
    def _resolve_charge_mode(
        cls,
        *,
        total_credits: Decimal,
        included_credits: Decimal,
        wallet_credits: Decimal,
        provider_credits: Decimal = Decimal("0"),
    ) -> str:
        if total_credits <= 0:
            return "free"
        if provider_credits >= total_credits and included_credits <= 0 and wallet_credits <= 0:
            return "provider_credit"
        if provider_credits > 0 and (included_credits > 0 or wallet_credits > 0):
            return "mixed_provider_funding"
        if included_credits >= total_credits and wallet_credits <= 0:
            return "included_quota"
        if included_credits > 0 and wallet_credits > 0:
            return "mixed_quota_wallet"
        if wallet_credits > 0:
            return "wallet_charge"
        return "free"

    @classmethod
    def _snapshot_funding_mode(
        cls,
        *,
        organization_id: str,
        user_id: str,
        idempotency_key: str,
        requested_mode: str | None,
        scene_key: str = "",
        persist: bool,
    ) -> str:
        """复用 BillingUsageEvent.metadata 冻结 invocation 的资金契约。"""
        from apps.services.llm.services._runtime.invocation import (
            normalize_funding_mode,
        )

        resolved = normalize_funding_mode(requested_mode)
        stable_key = str(idempotency_key or "").strip()
        if not persist or not stable_key or not organization_id or not user_id:
            return resolved

        from apps.services.billing.models import BillingUsageEvent

        defaults = {
            "organization_id": organization_id,
            "user_id": user_id,
            "meter_key": "llm.tokens",
            "quantity": Decimal("0"),
            "unit": "tokens",
            "unit_price": Decimal("0"),
            "amount": Decimal("0"),
            "currency": "CREDITS",
            "scene_key": scene_key or "",
            "metadata": {
                "status": "pending_deduction",
                "funding_mode": resolved,
            },
        }
        try:
            event, created = BillingUsageEvent.objects.get_or_create(
                idempotency_key=stable_key,
                defaults=defaults,
            )
        except IntegrityError:
            event = BillingUsageEvent.objects.get(idempotency_key=stable_key)
            created = False

        metadata = dict(event.metadata or {})
        persisted_mode = str(metadata.get("funding_mode") or "").strip()
        if persisted_mode:
            return normalize_funding_mode(persisted_mode)
        if not created:
            metadata["funding_mode"] = resolved
            event.metadata = metadata
            event.save(update_fields=["metadata"])
        return resolved

    @classmethod
    def precheck_llm_usage(
        cls,
        organization_id,
        user_id,
        estimated_tokens,
        model_id=None,
        context=None,
        idempotency_key=None,
        model_config=None,
        perform_side_effects=True,
    ) -> dict:
        organization_id = str(organization_id or "").strip()
        user_id = str(user_id or "").strip()
        context = dict(context or {})
        estimated_tokens = int(estimated_tokens or 0)
        resolved_model_config = cls._resolve_model_config(
            model_id=str(model_id or "") or None,
            model_config=model_config,
        )

        if not organization_id or not user_id:
            decision = BillingGatewayDecision(
                allowed=False,
                code=LLM_WALLET_INSUFFICIENT,
                message="LLM 计费缺少 organization_id 或 user_id。",
                charge_mode="blocked",
                metadata={"missing_organization_id": not bool(organization_id), "missing_user_id": not bool(user_id)},
            )
            return decision.as_dict()

        funding_mode = cls._snapshot_funding_mode(
            organization_id=organization_id,
            user_id=user_id,
            idempotency_key=str(idempotency_key or ""),
            requested_mode=str(context.get("funding_mode") or "") or None,
            scene_key=str(context.get("scene_key") or ""),
            persist=perform_side_effects,
        )
        context["funding_mode"] = funding_mode

        required = cls._estimate_credits(
            organization_id=organization_id,
            estimated_tokens=estimated_tokens,
            model_config=resolved_model_config,
        )
        policy = OrganizationBillingPolicyService.get_effective_policy(organization_id)
        llm_billing_mode = policy.get("llm_billing_mode") or OrganizationBillingPolicyService.DEFAULT_LLM_BILLING_MODE
        included_available = cls._quantize(
            OrganizationLlmBudgetService.get_remaining_quota_credits(
                organization_id,
                sync_entitlement=perform_side_effects,
            ),
        )
        ui_preview_enabled = bool(
            getattr(settings, "PROVIDER_CREDIT_UI_ENABLED", False)
        )
        funding_preview: list[dict[str, Any]] = []
        provider_available = Decimal("0")
        from apps.services.billing.services.funding_allocator import FundingAllocator

        provider_funding_enabled = FundingAllocator.is_enabled(
            funding_mode
        )
        if provider_funding_enabled:
            provider_funding_enabled = True
            try:
                from apps.services.billing.services.provider_credit_service import (
                    ProviderCreditService,
                )

                provider_available = cls._quantize(
                    ProviderCreditService.get_available_credit(
                        organization=organization_id,
                        provider_key=str(
                            resolved_model_config.get("canonical_provider_key") or ""
                        ).strip(),
                        model_id=str(
                            model_id
                            or resolved_model_config.get("model_id")
                            or ""
                        ).strip(),
                    )
                )
            except Exception as exc:
                logger.warning(
                    "[BillingGateway] provider credit precheck failed closed for "
                    "provider pool only: organization=%s err=%s",
                    organization_id,
                    exc,
                )
                provider_available = Decimal("0")

        provider_covered = min(required, provider_available)
        required_after_provider = max(Decimal("0"), required - provider_covered)
        effective_included_available = included_available
        if provider_funding_enabled and llm_billing_mode == "paygo_only":
            effective_included_available = Decimal("0")
        if ui_preview_enabled and provider_funding_enabled:
            try:
                from apps.services.billing.services.provider_credit_capability import (
                    ProviderCreditCapabilityService,
                )

                funding_preview = ProviderCreditCapabilityService.preview_funding(
                    organization=organization_id,
                    provider_key=str(
                        resolved_model_config.get("canonical_provider_key") or ""
                    ).strip(),
                    model_id=str(
                        model_id
                        or resolved_model_config.get("model_id")
                        or ""
                    ).strip(),
                    required_credits=required,
                    billing_context={
                        **context,
                        "idempotency_key": idempotency_key or "",
                        "llm_billing_mode": llm_billing_mode,
                    },
                    funding_mode=funding_mode,
                )
                provider_covered = cls._quantize(
                    sum(
                        (
                            Decimal(str(item.get("credits") or 0))
                            for item in funding_preview
                            if item.get("source_type") == "provider_credit"
                        ),
                        Decimal("0"),
                    )
                )
                included_covered = cls._quantize(
                    sum(
                        (
                            Decimal(str(item.get("credits") or 0))
                            for item in funding_preview
                            if item.get("source_type") == "monthly_budget"
                        ),
                        Decimal("0"),
                    )
                )
                preview_wallet_required = cls._quantize(
                    sum(
                        (
                            Decimal(str(item.get("credits") or 0))
                            for item in funding_preview
                            if item.get("source_type") == "organization_wallet"
                        ),
                        Decimal("0"),
                    )
                )
                required_after_provider = max(
                    Decimal("0"),
                    required - provider_covered,
                )
                effective_included_available = included_covered
            except Exception as exc:
                logger.warning(
                    "[BillingGateway] funding preview failed; returning empty preview: "
                    "organization=%s model_id=%s err=%s",
                    organization_id,
                    model_id,
                    exc,
                )
                funding_preview = []
                preview_wallet_required = None
        else:
            preview_wallet_required = None
        # ：quota_only 现在也会在月度配额耗尽后扣持久点券钱包，
        # 钱包需覆盖的部分与其他模式同口径 = max(0, 预估 - 月度配额剩余)。
        wallet_required = (
            cls._quantize(preview_wallet_required)
            if preview_wallet_required is not None
            else max(
                Decimal("0"),
                required_after_provider - effective_included_available,
            )
        )
        wallet_available = cls._wallet_available(organization_id)
        if llm_billing_mode == "quota_only":
            # 扣费瀑布：月度配额 + 钱包 组合可覆盖本次预估即放行；
            # 组合不足时尝试现金自动补充一档（入账钱包），补充后复查。
            allowed = (
                provider_covered + effective_included_available + wallet_available
            ) >= required
            if not allowed and perform_side_effects:
                from apps.services.billing.services.llm_topup_service import LlmQuotaTopupService

                topup = LlmQuotaTopupService.try_auto_topup(
                    organization_id,
                    trigger="gateway_precheck",
                    required_credits=(
                        wallet_required if provider_funding_enabled else required
                    ),
                )
                if topup.get("topped_up") or topup.get("reason") == "not_needed":
                    included_available = cls._quantize(
                        OrganizationLlmBudgetService.get_remaining_quota_credits(organization_id),
                    )
                    wallet_available = cls._wallet_available(organization_id)
                    effective_included_available = included_available
                    wallet_required = max(
                        Decimal("0"),
                        required_after_provider - effective_included_available,
                    )
                    allowed = (
                        provider_covered
                        + effective_included_available
                        + wallet_available
                    ) >= required
        else:
            allowed = wallet_available >= wallet_required
        charge_mode = cls._resolve_charge_mode(
            total_credits=required,
            provider_credits=provider_covered,
            included_credits=min(required_after_provider, effective_included_available),
            wallet_credits=wallet_required,
        )
        decision = BillingGatewayDecision(
            allowed=allowed,
            code=None if allowed else LLM_WALLET_INSUFFICIENT,
            message=None if allowed else "组织钱包余额不足，请充值后重试。",
            required_credits=required,
            included_available=included_available,
            wallet_available=wallet_available,
            wallet_required=wallet_required,
            charge_mode=charge_mode if allowed else "blocked",
            metadata={
                **context,
                "idempotency_key": idempotency_key or "",
                "estimated_tokens": estimated_tokens,
                "llm_billing_mode": llm_billing_mode,
                "model_id": str(model_id or resolved_model_config.get("model_id", "") or ""),
                **(
                    {
                        "provider_credit_available": str(provider_available),
                        "provider_credit_covered": str(provider_covered),
                    }
                    if provider_funding_enabled
                    else {}
                ),
            },
        )
        if (
            not allowed
            and perform_side_effects
            and not context.get("suppress_blocked_event")
        ):
            cls.record_blocked_llm_usage(
                organization_id,
                user_id,
                LLM_WALLET_INSUFFICIENT,
                context=decision.metadata,
                idempotency_key=idempotency_key,
            )
        result = decision.as_dict()
        if ui_preview_enabled:
            result.update(
                {
                    "estimated_credits": str(required),
                    "funding_preview": funding_preview,
                }
            )
        return result

    @classmethod
    def settle_llm_usage(
        cls,
        organization_id,
        user_id,
        actual_tokens,
        model_id,
        provider_id=None,
        idempotency_key=None,
        context=None,
        model_config=None,
        input_tokens=None,
        output_tokens=None,
    ) -> dict:
        from apps.users.wallet.exceptions import InsufficientCreditsError
        from apps.users.wallet.services.credits_service import CreditsService

        organization_id = str(organization_id or "").strip()
        user_id = str(user_id or "").strip()
        context = dict(context or {})
        actual_tokens = int(actual_tokens or 0)
        input_tokens = int(input_tokens if input_tokens is not None else actual_tokens)
        output_tokens = int(output_tokens if output_tokens is not None else 0)
        resolved_model_config = cls._resolve_model_config(
            model_id=str(model_id or "") or None,
            model_config=model_config,
        )
        resolved_model_config.setdefault("organization_id", organization_id)
        resolved_model_config.setdefault("model_id", str(model_id or ""))
        resolved_model_config.setdefault("provider_id", str(provider_id or resolved_model_config.get("provider_id", "") or ""))

        stable_key = (idempotency_key or "").strip() or str(
            context.get("message_id")
            or context.get("task_id")
            or context.get("request_id")
            or ""
        ).strip()
        if not stable_key:
            raise ValueError(
                "BILLING_GATEWAY_REQUIRED: settle_llm_usage requires a stable "
                "idempotency_key, request_id, message_id, or task_id",
            )

        funding_mode = cls._snapshot_funding_mode(
            organization_id=organization_id,
            user_id=user_id,
            idempotency_key=stable_key,
            requested_mode=str(context.get("funding_mode") or "") or None,
            scene_key=str(context.get("scene_key") or ""),
            persist=True,
        )
        context["funding_mode"] = funding_mode

        if actual_tokens > 0 and input_tokens <= 0 and output_tokens <= 0:
            input_tokens = actual_tokens

        billing_metadata = {
            **context,
            "billing_gateway": True,
            "charge_mode": "pending",
            "model_id": str(model_id or resolved_model_config.get("model_id", "") or ""),
            "provider_id": str(provider_id or resolved_model_config.get("provider_id", "") or ""),
            "actual_tokens": actual_tokens,
        }

        try:
            result = CreditsService.consume_credits_for_llm(
                user=user_id,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                model_config=resolved_model_config,
                organization_id=organization_id,
                biz_id=str(context.get("biz_id") or context.get("request_id") or stable_key),
                idempotency_key=stable_key,
                billing_metadata=billing_metadata,
                scene_key=str(context.get("scene_key") or ""),
            )
        except InsufficientCreditsError as exc:
            cls.record_blocked_llm_usage(
                organization_id,
                user_id,
                LLM_WALLET_INSUFFICIENT,
                context={
                    **context,
                    "required": str(getattr(exc, "required", "")),
                    "current": str(getattr(exc, "current", "")),
                },
                idempotency_key=stable_key,
                publish_ws=False,
            )
            raise

        total_credits = cls._quantize(
            result.get("raw_credits_cost_precise")
            or result.get("credits_cost_precise")
            or result.get("raw_credits_cost")
            or result.get("credits_consumed_precise")
            or 0,
        )
        wallet_credits = cls._quantize(result.get("credits_consumed_precise") or 0)
        provider_credits = cls._quantize(
            result.get("provider_credit_credits_precise") or 0
        )
        included_credits = cls._quantize(
            result.get("quota_covered_credits_precise")
            or result.get("quota_covered_credits")
            or result.get("included_credits")
            or 0,
        )
        charge_mode = cls._resolve_charge_mode(
            total_credits=(
                total_credits
                if total_credits > 0
                else provider_credits + included_credits + wallet_credits
            ),
            provider_credits=provider_credits,
            included_credits=included_credits,
            wallet_credits=wallet_credits,
        )
        normalized_result = {
            **result,
            "billing_gateway": True,
            "charge_mode": (
                "idempotent"
                if result.get("reason") in {"idempotent_hit", "already_settled"}
                else charge_mode
            ),
            "charge_status": (
                "charged"
                if wallet_credits > 0 or provider_credits > 0
                else "included"
            ),
            "included_credits": str(included_credits),
            "wallet_credits": str(wallet_credits),
            "total_credits": str(
                total_credits
                if total_credits > 0
                else provider_credits + included_credits + wallet_credits
            ),
            "idempotency_key": stable_key,
        }
        from apps.services.billing.services.funding_allocator import FundingAllocator

        funding_mode = str(context.get("funding_mode") or "").strip()
        if provider_credits > 0 or FundingAllocator.is_enabled(
            funding_mode or None
        ):
            normalized_result["provider_credit_credits"] = str(provider_credits)
        return normalized_result

    @classmethod
    def settle_fixed_usage(
        cls,
        *,
        organization_id,
        user_id,
        required_credits,
        meter_key,
        quantity,
        unit,
        unit_price,
        provider_key,
        model_id,
        model_name,
        idempotency_key,
        scene_key,
        biz_type,
        biz_id,
        funding_mode,
        context=None,
    ) -> dict:
        """用统一资金瀑布结算一个已确定点数的非 token Scene。"""
        from apps.users.wallet.services.credits_service import CreditsService

        return CreditsService.consume_funded_credits(
            user_id=str(user_id or ""),
            organization_id=str(organization_id or ""),
            required_credits=required_credits,
            meter_key=meter_key,
            quantity=quantity,
            unit=unit,
            unit_price=unit_price,
            provider_key=provider_key,
            model_id=model_id,
            model_name=model_name,
            idempotency_key=idempotency_key,
            scene_key=scene_key,
            biz_type=biz_type,
            biz_id=biz_id,
            funding_mode=funding_mode,
            billing_metadata=dict(context or {}),
        )

    @classmethod
    def record_blocked_llm_usage(
        cls,
        organization_id,
        user_id,
        reason_code,
        context=None,
        idempotency_key=None,
        publish_ws=True,
    ) -> dict:
        context = dict(context or {})
        stable_key = (idempotency_key or "").strip() or str(
            context.get("request_id")
            or context.get("message_id")
            or context.get("task_id")
            or ""
        ).strip()
        if not stable_key:
            stable_key = f"blocked:{organization_id}:{user_id}:{reason_code}"
        event_key = f"blocked:llm:{stable_key}"
        metadata = {
            **context,
            "billing_gateway": True,
            "charge_mode": "blocked",
            "charge_status": "blocked",
            "reason_code": reason_code,
        }
        try:
            event = BillingUsageService.record_event(
                organization_id=str(organization_id or ""),
                user_id=str(user_id or ""),
                meter_key="llm.tokens",
                quantity=Decimal(str(context.get("estimated_tokens") or context.get("actual_tokens") or 0)),
                unit="tokens",
                unit_price=Decimal("0"),
                amount=Decimal("0"),
                currency="CREDITS",
                provider_key=str(context.get("provider_key", "")),
                model_name=str(context.get("model_name", "")),
                biz_type="llm_blocked",
                biz_id=str(context.get("biz_id") or context.get("request_id") or stable_key),
                scene_key=str(context.get("scene_key") or ""),
                idempotency_key=event_key,
                metadata=metadata,
                charge_status="failed",
            )
        except IntegrityError:
            event = None
        except Exception as exc:
            logger.warning("[BillingGateway] blocked usage audit failed: %s", exc)
            event = None

        # 结算失败路径（settle_llm_usage 的 except）传 publish_ws=False：内层只落
        # 审计，由外层 charge_llm_usage catch 统一广播 organization_insufficient_credits
        # （面向组织的产品语义），避免同一次失败双发 WS。预检阻断路径仍需广播。
        if publish_ws:
            try:
                from apps.services.billing.ws_events import publish_billing_blocked_deduped

                publish_billing_blocked_deduped(
                    str(organization_id or ""),
                    reason_code,
                    request_id=str(context.get("request_id", "")),
                )
            except Exception:
                pass

        return {
            "blocked": True,
            "code": reason_code,
            "event_id": str(getattr(event, "id", "") or ""),
            "idempotency_key": event_key,
        }
