"""
点券业务服务
"""

import logging
from decimal import Decimal, ROUND_HALF_UP
from typing import Dict, Any, Optional

from django.conf import settings
from django.db import IntegrityError, transaction

from apps.services.billing.services import (
    BillingUsageService,
    MeterPricingService,
    OrganizationBillingPolicyService,
    OrganizationLlmBudgetService,
)
from ..models import OrganizationWallet, WalletTransaction, CreditPackage
from apps.i18n import _
from ..exceptions import InsufficientCreditsError, TransactionFailedError

logger = logging.getLogger(__name__)


class CreditsService:
    """
    点券服务：充值、通用消费、LLM 消费、充值落地订单
    """

    @staticmethod
    def get_organization_monthly_budget(organization_id: str) -> Optional[Decimal]:
        """返回 organization 当月 LLM 预算额度（点券），无预算配置时返回 None"""
        try:
            included = OrganizationLlmBudgetService._resolve_monthly_included_credits(organization_id)
            return included if included and included > 0 else None
        except Exception as exc:
            logger.warning("获取 organization 月预算失败: organization=%s, err=%s", organization_id, exc)
            return None

    @staticmethod
    def _quantize_credits(value: Decimal | int | float | str) -> Decimal:
        return OrganizationWallet.quantize_credits(value)

    @staticmethod
    def _to_display_delta(before_display: int, after_display: int) -> int:
        return after_display - before_display

    @staticmethod
    def _resolve_llm_prices(
        *,
        model_config: Dict[str, Any],
        organization_id: Optional[str],
    ) -> tuple[Decimal, Decimal, str, str]:
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

        fallback_input_price = Decimal(str(model_config.get("input_price_per_1k", 0)))
        fallback_output_price = Decimal(str(model_config.get("output_price_per_1k", 0)))

        # XM-07: charge_llm_usage 已精确计算 cache token 折算价格并写入
        # model_config["input_price_per_1k"]，此时不应再用 MeterPricing 覆盖，
        # 否则 cache token 折扣失效导致用户被多收费。
        if model_config.get("effective_input_price_computed"):
            return (
                fallback_input_price,
                fallback_output_price,
                provider_key,
                model_name,
            )

        input_meter_key = (
            f"llm.{provider_key}.{model_name}.input_tokens"
            if provider_key and model_name
            else "llm.input_tokens"
        )
        output_meter_key = (
            f"llm.{provider_key}.{model_name}.output_tokens"
            if provider_key and model_name
            else "llm.output_tokens"
        )

        input_price = MeterPricingService.get_unit_price(
            input_meter_key,
            organization_id=organization_id,
            provider_key=provider_key,
            model_name=model_name,
            default_price=fallback_input_price,
        )
        output_price = MeterPricingService.get_unit_price(
            output_meter_key,
            organization_id=organization_id,
            provider_key=provider_key,
            model_name=model_name,
            default_price=fallback_output_price,
        )

        return (
            Decimal(str(input_price or 0)),
            Decimal(str(output_price or 0)),
            provider_key,
            model_name,
        )

    # ------------------------------------------------------------------
    # consume_credits: 通用按量扣费（非 LLM 场景）
    # ------------------------------------------------------------------

    @staticmethod
    @transaction.atomic
    def consume_credits(
        *,
        user_id: str,
        organization_id: Optional[str] = None,
        meter_key: str,
        quantity: Decimal,
        unit: str,
        unit_price: Optional[Decimal] = None,
        provider_key: str = "",
        description: str = "",
        biz_type: str = "",
        biz_id: str = "",
        idempotency_key: str = "",
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        通用按量扣费：用于 Speech、媒体生成、Embedding 等非 LLM 场景。

        仅从 OrganizationWallet 扣款（organization-only）；余额不足或团队钱包不可用时抛出 InsufficientCreditsError。
        同时写入 BillingUsageEvent 用量记录。
        支持 idempotency_key 防止重复扣费。
        """
        from apps.services.billing.models import BillingUsageEvent

        if not user_id:
            logger.warning("[consume_credits] user_id 为空，跳过计费")
            return {"charged": False, "reason": "missing_user_id"}

        if quantity <= 0:
            return {"charged": False, "reason": "zero_quantity", "amount": Decimal("0")}

        if not (organization_id or "").strip():
            logger.warning(
                "[consume_credits] organization_id 为空，拒绝计费: "
                "user=%s meter_key=%s quantity=%s",
                str(user_id)[:8], meter_key, quantity,
            )
            return {"charged": False, "reason": "missing_organization_id"}

        if not getattr(settings, "BILLING_LEGACY_NON_LLM_CONSUME_ENABLED", False):
            logger.warning(
                "[consume_credits] legacy non-LLM wallet consume disabled: "
                "user=%s organization=%s meter_key=%s quantity=%s",
                str(user_id)[:8], organization_id, meter_key, quantity,
            )
            BillingUsageService.record_event(
                organization_id=organization_id or "",
                user_id=user_id,
                meter_key=meter_key,
                quantity=quantity,
                unit=unit,
                unit_price=Decimal("0"),
                amount=Decimal("0"),
                currency="CREDITS",
                provider_key=provider_key,
                biz_type=biz_type,
                biz_id=biz_id,
                idempotency_key=idempotency_key,
                metadata={
                    **(metadata or {}),
                    "legacy_billing_disabled": True,
                    "disabled_reason": "statement_mode",
                    "requested_charge_entrypoint": "CreditsService.consume_credits",
                },
            )
            return {
                "charged": False,
                "reason": "legacy_non_llm_charge_disabled",
                "amount": Decimal("0"),
                "meter_key": meter_key,
            }

        if unit_price is None:
            resolved = MeterPricingService.get_unit_price(
                meter_key,
                organization_id=organization_id,
                provider_key=provider_key,
            )
            if resolved is None:
                logger.warning(
                    "[consume_credits] meter_key=%s 无定价配置，跳过计费",
                    meter_key,
                )
                try:
                    from apps.services.billing.services.degradation_tracker import track_billing_degradation
                    track_billing_degradation(
                        meter_key=meter_key,
                        organization_id=organization_id or "",
                        biz_type="no_pricing",
                        error=f"Missing pricing for {meter_key}",
                    )
                except Exception:
                    pass
                return {"charged": False, "reason": "no_pricing", "meter_key": meter_key}
            unit_price = Decimal(str(resolved))

        amount = CreditsService._quantize_credits(quantity * unit_price)
        if amount <= 0:
            BillingUsageService.record_event(
                organization_id=organization_id or "",
                user_id=user_id,
                meter_key=meter_key,
                quantity=quantity,
                unit=unit,
                unit_price=unit_price,
                amount=Decimal("0"),
                currency="CREDITS",
                provider_key=provider_key,
                biz_type=biz_type,
                biz_id=biz_id,
                idempotency_key=idempotency_key,
                metadata=metadata,
            )
            return {"charged": False, "reason": "zero_amount", "amount": Decimal("0")}

        # WAL-01 fix: 原子幂等检查 —— 利用 idempotency_key 唯一约束，
        # 在扣款前先 INSERT BillingUsageEvent。并发请求中后到者触发
        # IntegrityError 被 savepoint 回滚，从而安全跳过。
        _billing_event_pre_created = False
        billing_event = None
        if idempotency_key:
            try:
                with transaction.atomic():
                    billing_event = BillingUsageEvent.objects.create(
                        organization_id=organization_id or None,
                        user_id=user_id,
                        meter_key=meter_key,
                        quantity=quantity,
                        unit=unit,
                        unit_price=unit_price,
                        amount=amount,
                        currency="CREDITS",
                        provider_key=provider_key or "",
                        biz_type=biz_type or "",
                        biz_id=biz_id or "",
                        idempotency_key=idempotency_key,
                        metadata=metadata or {},
                    )
                _billing_event_pre_created = True
            except IntegrityError:
                logger.info(
                    "[consume_credits] 幂等命中（唯一约束），跳过重复扣费: %s",
                    idempotency_key,
                )
                return {"charged": False, "reason": "idempotent_hit"}

        deducted = False
        try:
            # WAL-02: savepoint 包裹团队扣款+流水；异常向上抛出（organization-only）
            with transaction.atomic():
                from apps.users.wallet.models import OrganizationWallet as WSWalletModel
                ws_wallet = WSWalletModel.objects.select_for_update().filter(
                    organization_id=organization_id,
                ).first()
                if ws_wallet and ws_wallet.get_available_credits_precise() >= amount:
                    ws_before = ws_wallet.credits_precise
                    ws_wallet.credits_precise = CreditsService._quantize_credits(
                        ws_wallet.credits_precise - amount,
                    )
                    ws_wallet.sync_display_balances()
                    ws_wallet.save(update_fields=["credits_precise", "credits", "updated_at"])
                    tx = WalletTransaction.objects.create(
                        organization_wallet=ws_wallet,
                        transaction_type="consume",
                        amount=CreditsService._to_display_delta(
                            int(ws_before.to_integral_value()),
                            ws_wallet.credits,
                        ),
                        amount_precise=-amount,
                        balance_before=int(ws_before.to_integral_value()),
                        balance_before_precise=ws_before,
                        balance_after=ws_wallet.credits,
                        balance_after_precise=ws_wallet.credits_precise,
                        organization_id=organization_id,
                        operator_user_id=user_id,
                        related_order_id=str(billing_event.id) if billing_event else "",
                        usage_event_id=str(billing_event.id) if billing_event else "",
                        billing_metadata=metadata or {},
                        description=description or f"{meter_key} 消费 {quantity}{unit}",
                    )
                    deducted = True
        except Exception as exc:
            logger.error(
                "[consume_credits] OrganizationWallet 扣款异常（savepoint 已回滚）: %s",
                exc,
            )
            raise

        if not deducted:
            from apps.users.wallet.models import OrganizationWallet as WSWalletModel
            ws_wallet = WSWalletModel.objects.filter(organization_id=organization_id).first()
            available = ws_wallet.get_available_credits_precise() if ws_wallet else Decimal("0")
            raise InsufficientCreditsError(
                message=_("wallet.organization_credits_insufficient"),
                required=amount,
                current=available,
            )

        if not _billing_event_pre_created:
            billing_event = BillingUsageService.record_event(
                organization_id=organization_id or "",
                user_id=user_id,
                meter_key=meter_key,
                quantity=quantity,
                unit=unit,
                unit_price=unit_price,
                amount=amount,
                currency="CREDITS",
                provider_key=provider_key,
                biz_type=biz_type,
                biz_id=biz_id,
                idempotency_key=idempotency_key,
                metadata=metadata,
            )
            if billing_event:
                WalletTransaction.objects.filter(id=tx.id).update(
                    related_order_id=str(billing_event.id),
                    usage_event_id=str(billing_event.id),
                    billing_metadata=metadata or {},
                )

        logger.info(
            "[consume_credits] meter=%s qty=%s amount=%s ws=%s user=%s",
            meter_key, quantity, amount, organization_id, user_id,
        )
        return {
            "charged": True,
            "meter_key": meter_key,
            "quantity": quantity,
            "unit_price": unit_price,
            "amount": amount,
        }

    @staticmethod
    @transaction.atomic
    def consume_funded_credits(
        *,
        user_id: str,
        organization_id: str,
        required_credits: Decimal,
        meter_key: str,
        quantity: Decimal,
        unit: str,
        unit_price: Decimal,
        provider_key: str,
        model_id: str,
        model_name: str,
        idempotency_key: str,
        scene_key: str,
        biz_type: str,
        biz_id: str,
        funding_mode: str,
        billing_metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """按已确定点数使用统一 Provider/Monthly/Wallet 资金瀑布。"""
        from apps.services.billing.models import BillingUsageEvent
        from apps.services.billing.services.funding_allocator import (
            MONTHLY_BUDGET,
            ORGANIZATION_WALLET,
            PROVIDER_CREDIT,
            FundingAllocator,
        )

        user_id = str(user_id or "").strip()
        organization_id = str(organization_id or "").strip()
        idempotency_key = str(idempotency_key or "").strip()
        required = CreditsService._quantize_credits(required_credits)
        quantity = Decimal(str(quantity or 0))
        unit_price = CreditsService._quantize_credits(unit_price)
        if not user_id or not organization_id:
            raise ValueError("funded credits 结算缺少 user_id 或 organization_id")
        if not idempotency_key:
            raise ValueError("funded credits 结算必须提供稳定 idempotency_key")
        if required < 0 or quantity < 0:
            raise ValueError("funded credits 结算金额和数量不能为负数")

        billing_event_pre_created = False
        try:
            with transaction.atomic():
                BillingUsageEvent.objects.create(
                    organization_id=organization_id,
                    user_id=user_id,
                    meter_key=meter_key,
                    quantity=Decimal("0"),
                    unit=unit,
                    unit_price=Decimal("0"),
                    amount=Decimal("0"),
                    currency="CREDITS",
                    provider_key=provider_key or "",
                    model_name=model_name or "",
                    biz_type=biz_type or "",
                    biz_id=biz_id or "",
                    scene_key=scene_key or "",
                    idempotency_key=idempotency_key,
                    metadata={"status": "pending_deduction"},
                )
            billing_event_pre_created = True
        except IntegrityError:
            existing_event = (
                BillingUsageEvent.objects.select_for_update()
                .filter(idempotency_key=idempotency_key)
                .first()
            )
            existing_status = (existing_event.metadata or {}).get("status") if existing_event else ""
            if existing_event and existing_status in {"charged", "already_settled"}:
                return {
                    "charged": False,
                    "reason": "already_settled",
                    "amount": Decimal("0.0000"),
                    "total_credits": required,
                    "funding_allocations": [],
                }
            if existing_event is None:
                raise
            billing_event_pre_created = True

        policy = OrganizationBillingPolicyService.get_effective_policy(
            organization_id
        )
        llm_billing_mode = (
            policy.get("llm_billing_mode")
            or OrganizationBillingPolicyService.DEFAULT_LLM_BILLING_MODE
        )
        allocations = []
        provider_credits = Decimal("0.0000")
        quota_credits = Decimal("0.0000")
        wallet_credits = Decimal("0.0000")
        overflow_credits = Decimal("0.0000")

        if FundingAllocator.is_enabled(funding_mode):
            allocations = FundingAllocator.allocate_funding(
                organization=organization_id,
                provider_key=provider_key,
                model_id=model_id,
                required_credits=required,
                billing_context={
                    **(billing_metadata or {}),
                    "idempotency_key": idempotency_key,
                    "biz_id": biz_id,
                    "llm_billing_mode": llm_billing_mode,
                },
                funding_mode=funding_mode,
            )
            provider_credits = FundingAllocator.credits_for(
                allocations, PROVIDER_CREDIT
            )
            quota_credits = FundingAllocator.credits_for(
                allocations, MONTHLY_BUDGET
            )
            wallet_credits = FundingAllocator.credits_for(
                allocations, ORGANIZATION_WALLET
            )
        else:
            legacy_budget = CreditsService._apply_organization_budget(
                organization_id,
                required,
            )
            quota_credits = legacy_budget["quota_covered_credits"]
            wallet_credits = legacy_budget["credits_to_deduct"]
            overflow_credits = legacy_budget["overflow_credits"]
            llm_billing_mode = legacy_budget["llm_billing_mode"]

        charge_mode = CreditsService._resolve_llm_charge_mode(
            total_credits=required,
            provider_credits=provider_credits,
            quota_covered_credits=quota_credits,
            paygo_credits=wallet_credits,
        )
        serialized_allocations = FundingAllocator.serialize(allocations)
        event_metadata = {
            **(billing_metadata or {}),
            "status": "charged",
            "funding_mode": funding_mode,
            "charge_mode": charge_mode,
            "raw_credits_cost": str(required),
            "provider_credit_credits": str(provider_credits),
            "quota_covered_credits": str(quota_credits),
            "paygo_credits": str(wallet_credits),
            "overflow_credits": str(overflow_credits),
            "llm_billing_mode": llm_billing_mode,
            "funding_allocations": {
                "total_credits": str(required),
                "allocations": serialized_allocations,
            },
            "model_id": str(model_id or ""),
        }

        wallet_tx_id = ""
        if wallet_credits > 0:
            wallet_result = CreditsService._deduct_from_organization_wallet(
                organization_id,
                wallet_credits,
                required,
                quota_credits,
                0,
                0,
                operator_user_id=user_id,
                meter_key=meter_key,
                quantity=quantity,
                unit=unit,
                description=(
                    f"{scene_key} 消耗（{quantity}{unit}，总计{required}点券，"
                    f"钱包实扣{wallet_credits}点券）"
                ),
                billing_metadata=event_metadata,
            )
            if wallet_result is None:
                wallet = OrganizationWallet.objects.filter(
                    organization_id=organization_id
                ).first()
                available = (
                    wallet.get_available_credits_precise()
                    if wallet
                    else Decimal("0")
                )
                raise InsufficientCreditsError(
                    message=_("wallet.organization_credits_insufficient"),
                    required=wallet_credits,
                    current=available,
                )
            wallet_tx_id = str(wallet_result.get("wallet_tx_id") or "")

        if billing_event_pre_created:
            BillingUsageEvent.objects.filter(
                idempotency_key=idempotency_key
            ).update(
                organization_id=organization_id,
                user_id=user_id,
                meter_key=meter_key,
                quantity=quantity,
                unit=unit,
                unit_price=unit_price,
                amount=wallet_credits,
                provider_key=provider_key or "",
                model_name=model_name or "",
                biz_type=biz_type or "",
                biz_id=biz_id or "",
                scene_key=scene_key or "",
                metadata=event_metadata,
            )
            event = BillingUsageEvent.objects.filter(
                idempotency_key=idempotency_key
            ).only("id").first()
            if event and wallet_tx_id:
                WalletTransaction.objects.filter(id=wallet_tx_id).update(
                    related_order_id=str(event.id),
                    usage_event_id=str(event.id),
                    billing_metadata=event_metadata,
                )

        return {
            "charged": required > 0,
            "reason": "charged" if required > 0 else "zero_amount",
            "amount": wallet_credits,
            "total_credits": required,
            "provider_credit_credits_precise": provider_credits,
            "quota_covered_credits_precise": quota_credits,
            "credits_consumed_precise": wallet_credits,
            "funding_allocations": serialized_allocations,
            "charge_mode": charge_mode,
            "funding_mode": funding_mode,
        }

    # ------------------------------------------------------------------
    # consume_credits_for_llm 主方法 + 拆分出的子方法
    # ------------------------------------------------------------------

    @staticmethod
    def _llm_usage_event_is_settled(event) -> bool:
        metadata = event.metadata or {}
        if metadata.get("status") in {"charged", "already_settled"}:
            return True
        if metadata.get("status") == "pending_deduction":
            return False

        from apps.users.wallet.models import WalletTransaction

        if WalletTransaction.objects.filter(
            transaction_type="consume",
            usage_event_id=str(event.id),
        ).exists():
            return True

        amount = CreditsService._quantize_credits(event.amount or Decimal("0"))
        quantity = Decimal(event.quantity or 0)
        raw_credits = CreditsService._quantize_credits(
            metadata.get("raw_credits_cost")
            or metadata.get("quota_covered_credits")
            or metadata.get("paygo_credits")
            or metadata.get("overflow_credits")
            or Decimal("0"),
        )
        return event.biz_type == "llm_call" and quantity > 0 and (amount > 0 or raw_credits > 0)

    @staticmethod
    def _already_settled_llm_result() -> Dict[str, Any]:
        return {
            "charged": False,
            "reason": "already_settled",
            "used_quota": False,
            "credits_consumed": 0,
            "credits_consumed_precise": Decimal("0.0000"),
        }

    @staticmethod
    @transaction.atomic
    def consume_credits_for_llm(
        user,
        input_tokens: int,
        output_tokens: int,
        model_config: Dict[str, Any],
        organization_id: Optional[str] = None,
        biz_id: str = "",
        idempotency_key: str = "",
        billing_metadata: Optional[Dict[str, Any]] = None,
        scene_key: str = "",
    ) -> Dict[str, Any]:
        """
        LLM 调用扣减点券/配额。
        按 organization 策略执行（总预算池/按量）；无 organization 时拒绝计费（organization-only）。
        """
        # R6: user 参数支持 User 对象或 user_id 字符串（organization-only 模式跳过 User 查询）
        _is_user_object = not isinstance(user, str)
        user_id_str = str(getattr(user, "id", "")) if _is_user_object else str(user)

        total_tokens = int(input_tokens or 0) + int(output_tokens or 0)
        if total_tokens <= 0:
            return {
                "used_quota": False,
                "credits_consumed": 0,
                "credits_consumed_precise": Decimal("0.0000"),
            }

        organization_id = CreditsService._resolve_organization_id(organization_id, model_config)
        if not organization_id:
            logger.warning(
                "[consume_credits_for_llm] organization_id 为空，拒绝计费: "
                "user=%s tokens=%d",
                user_id_str[:8], total_tokens,
            )
            return {
                "charged": False,
                "reason": "missing_organization_id",
                "used_quota": False,
                "credits_consumed": 0,
                "credits_consumed_precise": Decimal("0.0000"),
                "credits_remaining": 0,
                "credits_remaining_precise": Decimal("0.0000"),
            }

        # WAL-28: 原子幂等检查 — 复用 WAL-01 模式，利用 idempotency_key 唯一约束，
        # 在扣款前先 INSERT BillingUsageEvent 占位。并发请求中后到者触发
        # IntegrityError 被 savepoint 回滚，从而安全跳过，杜绝双重扣费。
        _billing_event_pre_created = False
        if idempotency_key:
            from apps.services.billing.models import BillingUsageEvent
            try:
                with transaction.atomic():
                    BillingUsageEvent.objects.create(
                        organization_id=organization_id or None,
                        user_id=user_id_str,
                        meter_key="llm.tokens",
                        quantity=Decimal(0),
                        unit="tokens",
                        unit_price=Decimal(0),
                        amount=Decimal(0),
                        currency="CREDITS",
                        idempotency_key=idempotency_key,
                        biz_id=biz_id or "",
                        scene_key=scene_key or "",
                        metadata={"status": "pending_deduction"},
                    )
                _billing_event_pre_created = True
            except IntegrityError:
                existing_event = (
                    BillingUsageEvent.objects.select_for_update()
                    .filter(idempotency_key=idempotency_key)
                    .first()
                )
                if existing_event and CreditsService._llm_usage_event_is_settled(existing_event):
                    logger.info(
                        "[consume_credits_for_llm] 幂等命中（已结算），跳过重复扣费: %s",
                        idempotency_key,
                    )
                    return CreditsService._already_settled_llm_result()
                if existing_event:
                    logger.warning(
                        "[consume_credits_for_llm] 接管未完成 WAL-28 占位并继续结算: %s",
                        idempotency_key,
                    )
                    _billing_event_pre_created = True
                else:
                    raise
        cost_info = CreditsService._compute_llm_credits_cost(
            input_tokens, output_tokens, model_config, organization_id,
        )

        # ---- 预算/配额阶段 ----
        credits_to_deduct = cost_info["credits_cost"]
        used_quota = False
        quota_remaining = None
        quota_covered_credits = Decimal("0.0000")
        overflow_credits = Decimal("0.0000")
        provider_credit_credits = Decimal("0.0000")
        funding_allocations: list[dict[str, Any]] = []
        llm_billing_mode = "paygo_only"
        funding_mode = str(
            (billing_metadata or {}).get("funding_mode") or ""
        ).strip()

        from apps.services.billing.services.funding_allocator import FundingAllocator

        if FundingAllocator.is_enabled(funding_mode or None):
            from apps.services.billing.services.funding_allocator import (
                MONTHLY_BUDGET,
                ORGANIZATION_WALLET,
                PROVIDER_CREDIT,
            )

            policy = OrganizationBillingPolicyService.get_effective_policy(
                organization_id
            )
            llm_billing_mode = (
                policy.get("llm_billing_mode")
                or OrganizationBillingPolicyService.DEFAULT_LLM_BILLING_MODE
            )
            allocations = FundingAllocator.allocate_funding(
                organization=organization_id,
                provider_key=(
                    model_config.get("canonical_provider_key")
                    if "canonical_provider_key" in model_config
                    else model_config.get("provider_key")
                ),
                model_id=model_config.get("model_id"),
                required_credits=cost_info["credits_cost"],
                billing_context={
                    **(billing_metadata or {}),
                    "idempotency_key": idempotency_key,
                    "biz_id": biz_id,
                    "llm_billing_mode": llm_billing_mode,
                },
                funding_mode=funding_mode or None,
            )
            provider_credit_credits = FundingAllocator.credits_for(
                allocations,
                PROVIDER_CREDIT,
            )
            quota_covered_credits = FundingAllocator.credits_for(
                allocations,
                MONTHLY_BUDGET,
            )
            credits_to_deduct = FundingAllocator.credits_for(
                allocations,
                ORGANIZATION_WALLET,
            )
            used_quota = quota_covered_credits > 0
            quota_remaining = OrganizationLlmBudgetService.get_remaining_quota_credits(
                organization_id
            )
            funding_allocations = FundingAllocator.serialize(allocations)
        else:
            budget = CreditsService._apply_organization_budget(
                organization_id,
                cost_info["credits_cost"],
            )
            credits_to_deduct = budget["credits_to_deduct"]
            used_quota = budget["used_quota"]
            quota_remaining = budget["quota_remaining"]
            quota_covered_credits = budget["quota_covered_credits"]
            overflow_credits = budget["overflow_credits"]
            llm_billing_mode = budget["llm_billing_mode"]

        # ---- 扣款阶段 ----
        deducted_from_organization = False
        ws_wallet_remaining = None
        ws_wallet_remaining_precise = None
        wallet_tx_id = ""

        if credits_to_deduct > 0:
            # organization_id 上文已校验非空；无团队上下文直接拒绝（organization-only）
            # WAL-05: _deduct_from_organization_wallet 返回 Optional[Dict]，
            # 成功时包含 organization wallet 余额信息
            ws_deduct_result = CreditsService._deduct_from_organization_wallet(
                organization_id, credits_to_deduct, cost_info["credits_cost"],
                quota_covered_credits, input_tokens, output_tokens,
                operator_user_id=user_id_str,
                billing_metadata=billing_metadata,
            )
            if ws_deduct_result is None and llm_billing_mode == "quota_only":
                #  结算侧兜底：钱包不足时尝试现金自动补充一档后重扣一次，
                # 覆盖「预检通过后钱包被并发耗尽 / 实际用量超预估」的竞态窗口。
                # try_auto_topup 内部吞异常（不 fail-open），失败即维持不足并向上拒绝。
                try:
                    from apps.services.billing.services.llm_topup_service import (
                        LlmQuotaTopupService,
                    )

                    topup = LlmQuotaTopupService.try_auto_topup(
                        organization_id, trigger="settlement_retry",
                        required_credits=credits_to_deduct,
                    )
                    if topup.get("topped_up"):
                        ws_deduct_result = CreditsService._deduct_from_organization_wallet(
                            organization_id, credits_to_deduct, cost_info["credits_cost"],
                            quota_covered_credits, input_tokens, output_tokens,
                            operator_user_id=user_id_str,
                            billing_metadata=billing_metadata,
                        )
                except Exception as _topup_exc:
                    logger.warning(
                        "[consume_credits_for_llm] 结算侧自动补充失败（维持余额不足）: "
                        "organization=%s err=%s",
                        organization_id, _topup_exc,
                    )
            deducted_from_organization = ws_deduct_result is not None
            if ws_deduct_result:
                ws_wallet_remaining = ws_deduct_result["remaining"]
                ws_wallet_remaining_precise = ws_deduct_result["remaining_precise"]
                wallet_tx_id = ws_deduct_result.get("wallet_tx_id", "")
            else:
                # organization-only：团队钱包不足时拒绝扣费
                from apps.users.wallet.models import OrganizationWallet as _WsWallet
                _ws = _WsWallet.objects.filter(organization_id=organization_id).first()
                _available = _ws.get_available_credits_precise() if _ws else Decimal("0")
                raise InsufficientCreditsError(
                    message=_("wallet.organization_credits_insufficient"),
                    required=credits_to_deduct,
                    current=_available,
                )

        # ---- 计费记录（organization 维度，保证全量可追踪）----
        CreditsService._record_billing_usage(
            organization_id=organization_id or "",
            user_id_str=user_id_str,
            total_tokens=total_tokens,
            credits_to_deduct=credits_to_deduct,
            cost_info=cost_info,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            quota_covered_credits=quota_covered_credits,
            overflow_credits=overflow_credits,
            provider_credit_credits=provider_credit_credits,
            funding_allocations=funding_allocations,
            funding_mode=funding_mode,
            llm_billing_mode=llm_billing_mode,
            biz_id=biz_id,
            idempotency_key=idempotency_key,
            billing_metadata=billing_metadata,
            billing_event_pre_created=_billing_event_pre_created,
            wallet_tx_id=wallet_tx_id,
            scene_key=scene_key,
        )

        return CreditsService._build_consume_result(
            used_quota=used_quota,
            credits_to_deduct=credits_to_deduct,
            credits_cost=cost_info["credits_cost"],
            quota_covered_credits=quota_covered_credits,
            overflow_credits=overflow_credits,
            provider_credit_credits=provider_credit_credits,
            funding_allocations=funding_allocations,
            quota_remaining=quota_remaining,
            ws_wallet_remaining=ws_wallet_remaining,
            ws_wallet_remaining_precise=ws_wallet_remaining_precise,
        )

    # ------------------------------------------------------------------
    # 以下为 consume_credits_for_llm 拆分出的内部子方法
    # ------------------------------------------------------------------

    @staticmethod
    def _resolve_organization_id(
        organization_id: Optional[str],
        model_config: Dict[str, Any],
    ) -> str:
        """从参数和 model_config 解析 organization_id"""
        if not organization_id:
            organization_id = (
                str(model_config.get("organization_id", "")).strip()
                or str(model_config.get("subject_organization_id", "")).strip()
            )
        return organization_id

    @staticmethod
    def _compute_llm_credits_cost(
        input_tokens: int,
        output_tokens: int,
        model_config: Dict[str, Any],
        organization_id: str,
    ) -> Dict[str, Any]:
        """价格解析 + 成本计算 + 点券换算"""
        input_price, output_price, provider_key, model_name = (
            CreditsService._resolve_llm_prices(
                model_config=model_config,
                organization_id=organization_id or None,
            )
        )
        input_cost = (Decimal(input_tokens or 0) / Decimal(1000)) * input_price
        output_cost = (Decimal(output_tokens or 0) / Decimal(1000)) * output_price
        total_cost = input_cost + output_cost

        credits_rate = int(getattr(settings, "CREDITS_PER_YUAN", 100))
        credits_cost = CreditsService._quantize_credits(total_cost * Decimal(credits_rate))

        return {
            "input_price": input_price,
            "output_price": output_price,
            "provider_key": provider_key,
            "model_name": model_name,
            "input_cost": input_cost,
            "output_cost": output_cost,
            "total_cost": total_cost,
            "credits_rate": credits_rate,
            "credits_cost": credits_cost,
        }

    @staticmethod
    def _apply_organization_budget(
        organization_id: str,
        credits_cost: Decimal,
    ) -> Dict[str, Any]:
        """调用 OrganizationLlmBudgetService 消费预算，返回预算分配结果"""
        policy = OrganizationBillingPolicyService.get_effective_policy(organization_id)
        llm_billing_mode = policy.get("llm_billing_mode") or OrganizationBillingPolicyService.DEFAULT_LLM_BILLING_MODE
        budget_result = OrganizationLlmBudgetService.consume_llm_credits(
            organization_id=organization_id,
            requested_credits=credits_cost,
            llm_billing_mode=llm_billing_mode,
        )
        quota_covered_credits = CreditsService._quantize_credits(
            budget_result.get("quota_covered_credits", 0),
        )
        credits_to_deduct = CreditsService._quantize_credits(
            budget_result.get("paygo_credits", 0),
        )
        overflow_credits = CreditsService._quantize_credits(
            budget_result.get("overflow_credits", 0),
        )
        quota_remaining = CreditsService._quantize_credits(
            budget_result.get("remaining_quota_credits", 0),
        )
        return {
            "quota_covered_credits": quota_covered_credits,
            "credits_to_deduct": credits_to_deduct,
            "overflow_credits": overflow_credits,
            "quota_remaining": quota_remaining,
            "used_quota": quota_covered_credits > 0,
            "llm_billing_mode": llm_billing_mode,
        }

    @staticmethod
    def _deduct_from_organization_wallet(
        organization_id: str,
        credits_to_deduct: Decimal,
        credits_cost: Decimal,
        quota_covered_credits: Decimal,
        input_tokens: int,
        output_tokens: int,
        *,
        operator_user_id: str = "",
        meter_key: str = "llm.tokens",
        quantity: Decimal | int | None = None,
        unit: str = "tokens",
        description: str = "",
        billing_metadata: Optional[Dict[str, Any]] = None,
    ) -> Optional[Dict[str, Any]]:
        """
        尝试从 OrganizationWallet 扣款并创建交易记录。

        Returns:
            成功时返回 {"remaining": int, "remaining_precise": Decimal}，
            余额不足时返回 None（organization-only：调用方应拒绝扣费），
            系统异常时抛出原始异常。
        """
        try:
            from apps.users.wallet.models import OrganizationWallet as WSWalletModel

            ws_wallet = WSWalletModel.objects.select_for_update().filter(organization_id=organization_id).first()
            freeze_id = str((billing_metadata or {}).get("freeze_id") or "").strip()
            frozen_amount = Decimal("0.0000")
            if ws_wallet and freeze_id:
                freeze_tx = WalletTransaction.objects.filter(
                    organization_wallet=ws_wallet,
                    transaction_type="freeze",
                    reference_key=freeze_id,
                ).first()
                already_unfrozen = WalletTransaction.objects.filter(
                    organization_wallet=ws_wallet,
                    transaction_type="unfreeze",
                    reference_key=freeze_id,
                ).exists()
                if freeze_tx and not already_unfrozen:
                    frozen_amount = min(
                        CreditsService._quantize_credits(max(freeze_tx.amount_precise, Decimal("0"))),
                        ws_wallet.credits_frozen_precise,
                    )

            spendable_credits = (
                ws_wallet.get_available_credits_precise() + frozen_amount
                if ws_wallet else Decimal("0.0000")
            )
            if ws_wallet and spendable_credits >= credits_to_deduct:
                ws_balance_before_precise = ws_wallet.credits_precise
                ws_balance_before = ws_wallet.credits

                ws_wallet.credits_precise = CreditsService._quantize_credits(
                    ws_wallet.credits_precise - credits_to_deduct,
                )
                if frozen_amount > 0:
                    ws_wallet.credits_frozen_precise = CreditsService._quantize_credits(
                        ws_wallet.credits_frozen_precise - frozen_amount,
                    )
                ws_wallet.sync_display_balances()
                ws_wallet.save(update_fields=[
                    "credits_precise",
                    "credits",
                    "credits_frozen_precise",
                    "credits_frozen",
                    "updated_at",
                ])

                ws_balance_after = ws_wallet.credits
                ws_balance_after_precise = ws_wallet.credits_precise
                ws_display_delta = CreditsService._to_display_delta(ws_balance_before, ws_balance_after)

                quota_note = f"，预算抵扣{quota_covered_credits}" if quota_covered_credits > 0 else ""
                resolved_billing_metadata = {
                    "meter_key": meter_key,
                    "quantity": str(
                        quantity
                        if quantity is not None
                        else int(input_tokens or 0) + int(output_tokens or 0)
                    ),
                    "unit": unit,
                    "raw_credits_cost": str(credits_cost),
                    "quota_covered_credits": str(quota_covered_credits),
                    **(billing_metadata or {}),
                }
                tx = WalletTransaction.objects.create(
                    organization_wallet=ws_wallet,
                    transaction_type="consume",
                    amount=ws_display_delta,
                    amount_precise=-credits_to_deduct,
                    balance_before=ws_balance_before,
                    balance_before_precise=ws_balance_before_precise,
                    balance_after=ws_balance_after,
                    balance_after_precise=ws_balance_after_precise,
                    organization_id=organization_id,
                    operator_user_id=operator_user_id,
                    billing_metadata=resolved_billing_metadata,
                    description=description or (
                        f"LLM调用消耗（{input_tokens}+{output_tokens} tokens，"
                        f"原始成本{credits_cost}点券，实扣{credits_to_deduct}点券{quota_note}）"
                    ),
                )
                if frozen_amount > 0:
                    WalletTransaction.objects.create(
                        organization_wallet=ws_wallet,
                        transaction_type="unfreeze",
                        amount=-int(frozen_amount.to_integral_value()),
                        amount_precise=-frozen_amount,
                        balance_before=ws_balance_after,
                        balance_before_precise=ws_balance_after_precise,
                        balance_after=ws_balance_after,
                        balance_after_precise=ws_balance_after_precise,
                        organization_id=organization_id,
                        reference_key=freeze_id,
                        description=(
                            f"[freeze_id:{freeze_id}] LLM 扣费结算同步释放冻结 "
                            f"{frozen_amount} 点券"
                        ),
                    )
                # WAL-05: 返回 organization wallet 余额，供调用方在返回值中标注来源
                return {
                    "remaining": ws_balance_after,
                    "remaining_precise": ws_balance_after_precise,
                    "wallet_tx_id": tx.id,
                }
        except InsufficientCreditsError:
            logger.info(
                "OrganizationWallet 余额不足: organization=%s",
                organization_id,
            )
        except Exception as exc:
            logger.error(
                "OrganizationWallet LLM扣款系统异常: organization=%s err=%s",
                organization_id, exc,
            )
            raise
        return None

    @staticmethod
    def _record_billing_usage(
        *,
        organization_id: str,
        user_id_str: str,
        total_tokens: int,
        credits_to_deduct: Decimal,
        cost_info: Dict[str, Any],
        input_tokens: int,
        output_tokens: int,
        quota_covered_credits: Decimal,
        overflow_credits: Decimal,
        provider_credit_credits: Decimal,
        funding_allocations: list[dict[str, Any]],
        funding_mode: str,
        llm_billing_mode: str,
        biz_id: str,
        idempotency_key: str,
        billing_metadata: Optional[Dict[str, Any]] = None,
        billing_event_pre_created: bool = False,
        wallet_tx_id: str = "",
        scene_key: str = "",
    ) -> None:
        """调用 BillingUsageService 记录 LLM 用量事件"""
        resolved_idem_key = idempotency_key or ""
        charge_mode = CreditsService._resolve_llm_charge_mode(
            total_credits=cost_info["credits_cost"],
            provider_credits=provider_credit_credits,
            quota_covered_credits=quota_covered_credits,
            paygo_credits=credits_to_deduct,
        )

        event_metadata: Dict[str, Any] = {
            "input_tokens": int(input_tokens or 0),
            "output_tokens": int(output_tokens or 0),
            "input_price_per_1k": str(cost_info["input_price"]),
            "output_price_per_1k": str(cost_info["output_price"]),
            "total_cost": str(cost_info["total_cost"]),
            "credits_rate": cost_info["credits_rate"],
            "raw_credits_cost": str(cost_info["credits_cost"]),
            "quota_covered_credits": str(quota_covered_credits),
            "paygo_credits": str(credits_to_deduct),
            "overflow_credits": str(overflow_credits),
            "llm_billing_mode": llm_billing_mode,
            "charge_mode": charge_mode,
        }
        from apps.services.billing.services.funding_allocator import FundingAllocator

        if FundingAllocator.is_enabled(funding_mode or None):
            event_metadata.update(
                {
                    "provider_credit_credits": str(provider_credit_credits),
                    "funding_allocations": {
                        "total_credits": str(cost_info["credits_cost"]),
                        "allocations": funding_allocations,
                    },
                    "funding_mode": funding_mode or "provider_credit_v1",
                }
            )
        if billing_metadata:
            event_metadata.update(billing_metadata)
            if event_metadata.get("charge_mode") == "pending":
                event_metadata["charge_mode"] = charge_mode
        event_metadata["status"] = "charged"

        computed_unit_price = (
            CreditsService._quantize_credits(credits_to_deduct / Decimal(total_tokens))
            if total_tokens > 0
            else Decimal("0.0000")
        )

        # WAL-28: 占位记录已在 consume_credits_for_llm 入口处创建，
        # 此处用实际扣费数据更新占位记录，避免重复 INSERT。
        if billing_event_pre_created and resolved_idem_key:
            try:
                from apps.services.billing.models import BillingUsageEvent
                BillingUsageEvent.objects.filter(
                    idempotency_key=resolved_idem_key,
                ).update(
                    organization_id=organization_id,
                    user_id=user_id_str,
                    quantity=Decimal(total_tokens),
                    unit_price=computed_unit_price,
                    amount=credits_to_deduct,
                    provider_key=cost_info["provider_key"] or "",
                    model_name=cost_info["model_name"] or "",
                    biz_type="llm_call",
                    biz_id=biz_id or "",
                    scene_key=scene_key or "",
                    metadata=event_metadata,
                )
                event = BillingUsageEvent.objects.filter(
                    idempotency_key=resolved_idem_key,
                ).only("id").first()
                if event and wallet_tx_id:
                    WalletTransaction.objects.filter(id=wallet_tx_id).update(
                        related_order_id=str(event.id),
                        usage_event_id=str(event.id),
                        billing_metadata=event_metadata,
                    )
            except Exception as exc:
                logger.error(
                    "[_record_billing_usage] WAL-28 占位记录更新失败，raise 回滚: "
                    "key=%s ws=%s err=%s",
                    resolved_idem_key, organization_id, exc,
                )
                from apps.users.wallet.exceptions import BillingEventUpdateError
                raise BillingEventUpdateError(
                    idempotency_key=resolved_idem_key,
                    organization_id=organization_id,
                ) from exc
            return

        # WAL-09: 无占位记录时的原始路径——预检幂等键后 INSERT
        if resolved_idem_key:
            from apps.services.billing.models import BillingUsageEvent
            if BillingUsageEvent.objects.filter(idempotency_key=resolved_idem_key).exists():
                logger.info(
                    "[_record_billing_usage] 用量事件已存在(source=idempotent_hit): "
                    "key=%s ws=%s meter=llm.tokens",
                    resolved_idem_key, organization_id,
                )
                return

        event = BillingUsageService.record_event(
            organization_id=organization_id,
            user_id=user_id_str,
            meter_key="llm.tokens",
            quantity=Decimal(total_tokens),
            unit="tokens",
            unit_price=computed_unit_price,
            amount=credits_to_deduct,
            currency="CREDITS",
            provider_key=cost_info["provider_key"],
            model_name=cost_info["model_name"],
            biz_type="llm_call",
            biz_id=biz_id,
            scene_key=scene_key or "",
            idempotency_key=resolved_idem_key,
            metadata=event_metadata,
        )
        if event and wallet_tx_id:
            WalletTransaction.objects.filter(id=wallet_tx_id).update(
                related_order_id=str(event.id),
                usage_event_id=str(event.id),
                billing_metadata=event_metadata,
            )
        # WAL-09 + R1+: record_event 内部 IntegrityError 会静默返回已有记录，
        # 比对 amount 检测潜在的并发竞争（钱已扣但事件由另一个请求写入）。
        # 金额不匹配意味着可能发生了双重扣费，升级为 critical 告警。
        if event and CreditsService._quantize_credits(event.amount) != credits_to_deduct:
            logger.warning(
                "[_record_billing_usage] 用量事件金额不匹配(source=concurrent_race): "
                "key=%s expected_amount=%s actual_amount=%s ws=%s",
                resolved_idem_key, credits_to_deduct, event.amount, organization_id,
            )

            try:
                from apps.services.billing.models import BillingAnomalyAlert
                BillingAnomalyAlert.objects.create(
                    alert_type="pattern",
                    severity="critical",
                    organization_id=organization_id or "",
                    user_id=user_id_str,
                    metric_name="billing_amount_mismatch",
                    current_value=float(credits_to_deduct),
                    baseline_value=float(event.amount),
                    message=(
                        f"LLM 用量事件金额不匹配（疑似并发竞态双重扣费）: "
                        f"key={resolved_idem_key}, expected={credits_to_deduct}, "
                        f"actual={event.amount}, organization={organization_id}"
                    ),
                )
            except Exception as alert_exc:
                logger.error(
                    "[_record_billing_usage] R1+ 金额不匹配告警写入失败: %s",
                    alert_exc,
                )

    @staticmethod
    def _resolve_llm_charge_mode(
        *,
        total_credits: Decimal,
        provider_credits: Decimal,
        quota_covered_credits: Decimal,
        paygo_credits: Decimal,
    ) -> str:
        total = CreditsService._quantize_credits(total_credits)
        provider = CreditsService._quantize_credits(provider_credits)
        quota = CreditsService._quantize_credits(quota_covered_credits)
        paygo = CreditsService._quantize_credits(paygo_credits)
        if total <= 0:
            return "free"
        if provider >= total and quota <= 0 and paygo <= 0:
            return "provider_credit"
        if provider > 0 and (quota > 0 or paygo > 0):
            return "mixed_provider_funding"
        if quota >= total and paygo <= 0:
            return "included_quota"
        if quota > 0 and paygo > 0:
            return "mixed_quota_wallet"
        if paygo > 0:
            return "wallet_charge"
        return "free"

    @staticmethod
    def _build_consume_result(
        *,
        used_quota: bool,
        credits_to_deduct: Decimal,
        credits_cost: Decimal,
        quota_covered_credits: Decimal,
        overflow_credits: Decimal,
        provider_credit_credits: Decimal,
        funding_allocations: list[dict[str, Any]],
        quota_remaining,
        ws_wallet_remaining: Optional[int] = None,
        ws_wallet_remaining_precise: Optional[Decimal] = None,
    ) -> Dict[str, Any]:
        """构建 consume_credits_for_llm 的返回字典"""
        remaining = ws_wallet_remaining if ws_wallet_remaining is not None else 0
        remaining_precise = ws_wallet_remaining_precise if ws_wallet_remaining_precise is not None else Decimal("0.0000")

        result = {
            "used_quota": used_quota,
            "credits_consumed": int(
                credits_to_deduct.to_integral_value(rounding=ROUND_HALF_UP)
            ),
            "credits_consumed_precise": credits_to_deduct,
            "raw_credits_cost_precise": credits_cost,
            "quota_covered_credits_precise": quota_covered_credits,
            "overflow_credits_precise": overflow_credits,
            "quota_remaining": quota_remaining,
            "credits_remaining": remaining,
            "credits_remaining_precise": remaining_precise,
            "credits_remaining_source": "organization_wallet",
        }
        if getattr(settings, "PROVIDER_CREDIT_FUNDING_ENABLED", False):
            result.update(
                {
                    "provider_credit_credits_precise": provider_credit_credits,
                    "funding_allocations": funding_allocations,
                }
            )
        if ws_wallet_remaining is not None:
            result["organization_credits_remaining"] = ws_wallet_remaining
            result["organization_credits_remaining_precise"] = ws_wallet_remaining_precise
        return result

    # ------------------------------------------------------------------
    # WAL-07: 预扣费冻结机制 — freeze / settle / release
    # ------------------------------------------------------------------

    @staticmethod
    @transaction.atomic
    def freeze_credits_for_llm(organization_id: str, estimated_cost: Decimal, freeze_id: str) -> bool:
        """WAL-07: 预扣费冻结——在 LLM 调用前冻结预估消费金额。

        冻结不扣减余额，仅增加 credits_frozen_precise，从而减少
        get_available_credits_precise() 返回值，堵死并发请求在预检通过后
        将余额耗尽的竞态窗口。

        Args:
            organization_id: 团队 ID
            estimated_cost: 预估消费点券
            freeze_id: 幂等键（格式：freeze:{run_id}:{iteration}）

        Returns:
            True = 冻结成功，False = 余额不足或钱包不存在
        """
        from ..models import OrganizationWallet as WsWallet

        estimated_cost = CreditsService._quantize_credits(estimated_cost)
        if estimated_cost <= 0:
            return True

        ws_wallet = (
            WsWallet.objects.select_for_update()
            .filter(organization_id=organization_id)
            .first()
        )
        if not ws_wallet:
            logger.warning("[freeze_credits] 团队钱包不存在: %s", organization_id)
            return False

        # 幂等检查（在行锁保护下，防止并发重复冻结）
        if WalletTransaction.objects.filter(
            transaction_type="freeze",
            reference_key=freeze_id,
        ).exists():
            logger.info("[freeze_credits] 幂等命中，跳过重复冻结: %s", freeze_id)
            return True

        available = ws_wallet.get_available_credits_precise()
        if available < estimated_cost:
            logger.info(
                "[freeze_credits] 余额不足: organization=%s available=%s required=%s",
                organization_id, available, estimated_cost,
            )
            return False

        # P1-02: savepoint 包裹钱包更新 + 流水创建，防止 IntegrityError 污染外层事务
        try:
            with transaction.atomic():
                ws_wallet.credits_frozen_precise = CreditsService._quantize_credits(
                    ws_wallet.credits_frozen_precise + estimated_cost,
                )
                ws_wallet.sync_display_balances()
                ws_wallet.save(update_fields=[
                    "credits_frozen_precise", "credits_frozen", "updated_at",
                ])

                WalletTransaction.objects.create(
                    organization_wallet=ws_wallet,
                    transaction_type="freeze",
                    amount=int(estimated_cost.to_integral_value()),
                    amount_precise=estimated_cost,
                    balance_before=ws_wallet.credits,
                    balance_before_precise=ws_wallet.credits_precise,
                    balance_after=ws_wallet.credits,
                    balance_after_precise=ws_wallet.credits_precise,
                    organization_id=organization_id,
                    reference_key=freeze_id,
                    description=f"[freeze_id:{freeze_id}] LLM 预扣费冻结 {estimated_cost} 点券",
                )
        except IntegrityError:
            logger.info("[freeze_credits] DB 唯一约束命中，幂等跳过: %s", freeze_id)
            return True

        logger.info(
            "[freeze_credits] 冻结成功: organization=%s amount=%s freeze_id=%s",
            organization_id, estimated_cost, freeze_id,
        )
        return True

    @staticmethod
    @transaction.atomic
    def settle_frozen_credits(organization_id: str, freeze_id: str, actual_cost: Decimal) -> Dict:
        """WAL-07: 结算冻结——LLM 调用并扣费完成后，释放冻结保证金。

        实际扣费已由 consume_credits_for_llm（通过 charge_llm_usage）完成，
        本方法仅释放 credits_frozen_precise 中对应的冻结金额，
        避免冻结额度持续占用可用余额。

        Args:
            organization_id: 团队 ID
            freeze_id: 冻结时使用的幂等键
            actual_cost: 实际消费金额（用于审计记录，不再重复扣减 credits_precise）

        Returns:
            Dict: {settled, frozen_amount, actual_cost, difference}
        """
        from ..models import OrganizationWallet as WsWallet

        actual_cost = CreditsService._quantize_credits(actual_cost)

        ws_wallet = (
            WsWallet.objects.select_for_update()
            .filter(organization_id=organization_id)
            .first()
        )
        if not ws_wallet:
            logger.warning("[settle_frozen] 团队钱包不存在: %s", organization_id)
            return {"settled": False, "reason": "wallet_not_found"}

        # 幂等检查（在行锁保护下）
        if WalletTransaction.objects.filter(
            transaction_type="unfreeze",
            reference_key=freeze_id,
        ).exists():
            logger.info("[settle_frozen] 幂等命中，已结算: %s", freeze_id)
            return {"settled": True, "reason": "already_settled"}

        freeze_tx = WalletTransaction.objects.filter(
            transaction_type="freeze",
            reference_key=freeze_id,
        ).first()

        if not freeze_tx:
            logger.info("[settle_frozen] 未找到冻结记录，跳过结算: %s", freeze_id)
            return {"settled": False, "reason": "freeze_not_found"}

        frozen_amount = freeze_tx.amount_precise

        # WAL-07/P2-10: 冻结余额不一致检查（在修改前检测）
        if ws_wallet.credits_frozen_precise < frozen_amount:
            logger.warning(
                "[settle_frozen] 冻结余额不一致：frozen_precise=%.4f < frozen_amount=%.4f freeze_id=%s",
                ws_wallet.credits_frozen_precise, frozen_amount, freeze_id,
            )

        # P1-02: savepoint 包裹钱包更新 + 流水创建，防止 IntegrityError 污染外层事务
        try:
            with transaction.atomic():
                ws_wallet.credits_frozen_precise = CreditsService._quantize_credits(
                    max(ws_wallet.credits_frozen_precise - frozen_amount, Decimal("0")),
                )
                ws_wallet.sync_display_balances()
                ws_wallet.save(update_fields=[
                    "credits_frozen_precise", "credits_frozen", "updated_at",
                ])

                WalletTransaction.objects.create(
                    organization_wallet=ws_wallet,
                    transaction_type="unfreeze",
                    amount=-int(frozen_amount.to_integral_value()),
                    amount_precise=-frozen_amount,
                    balance_before=ws_wallet.credits,
                    balance_before_precise=ws_wallet.credits_precise,
                    balance_after=ws_wallet.credits,
                    balance_after_precise=ws_wallet.credits_precise,
                    organization_id=organization_id,
                    reference_key=freeze_id,
                    description=(
                        f"[freeze_id:{freeze_id}] LLM 预扣费结算："
                        f"冻结 {frozen_amount} 点券，实际消费 {actual_cost} 点券"
                    ),
                )
        except IntegrityError:
            logger.info("[settle_frozen] DB 唯一约束命中，已结算: %s", freeze_id)
            return {"settled": True, "reason": "already_settled"}

        # WAL-07/P2-10: 冻结偏差率监控（阈值 200%，即实际消费超过冻结额 3 倍时 warning）
        diff_ratio = abs(actual_cost - frozen_amount) / max(frozen_amount, Decimal("0.01"))
        if actual_cost > frozen_amount * 3:
            logger.warning(
                "[settle_frozen] 冻结偏差率 %.0f%%：冻结=%.4f 实际=%.4f freeze_id=%s",
                diff_ratio * 100, frozen_amount, actual_cost, freeze_id,
            )
        else:
            logger.info(
                "[settle_frozen] 结算完成: organization=%s freeze_id=%s frozen=%s actual=%s diff=%.0f%%",
                organization_id, freeze_id, frozen_amount, actual_cost, diff_ratio * 100,
            )

        return {
            "settled": True,
            "frozen_amount": frozen_amount,
            "actual_cost": actual_cost,
            "difference": frozen_amount - actual_cost,
        }

    @staticmethod
    @transaction.atomic
    def settle_frozen_credits_with_debit(
        organization_id: str,
        freeze_id: str,
        debit_amount: Decimal,
        *,
        operator_user_id: str = "",
        description: str = "",
        billing_metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """把固定成本 Reservation 的钱包冻结原子转为实际扣款。"""
        from ..models import OrganizationWallet as WsWallet

        debit = CreditsService._quantize_credits(debit_amount)
        ws_wallet = (
            WsWallet.objects.select_for_update()
            .filter(organization_id=organization_id)
            .first()
        )
        if ws_wallet is None:
            return {"settled": False, "reason": "wallet_not_found"}

        existing_consume = WalletTransaction.objects.filter(
            transaction_type="consume",
            reference_key=freeze_id,
        ).first()
        if existing_consume is not None:
            return {
                "settled": True,
                "reason": "already_settled",
                "wallet_transaction_id": str(existing_consume.id),
            }

        freeze_tx = WalletTransaction.objects.filter(
            transaction_type="freeze",
            reference_key=freeze_id,
            organization_wallet=ws_wallet,
        ).first()
        if freeze_tx is None:
            return {"settled": False, "reason": "freeze_not_found"}
        frozen_amount = CreditsService._quantize_credits(freeze_tx.amount_precise)
        if debit < 0 or debit > frozen_amount:
            raise ValueError("钱包结算金额必须位于 0 与冻结金额之间")
        if ws_wallet.credits_precise < debit:
            raise InsufficientCreditsError(
                message=_("wallet.organization_credits_insufficient"),
                required=debit,
                current=ws_wallet.credits_precise,
            )

        balance_before = ws_wallet.credits_precise
        ws_wallet.credits_precise = CreditsService._quantize_credits(
            ws_wallet.credits_precise - debit
        )
        ws_wallet.credits_frozen_precise = CreditsService._quantize_credits(
            max(ws_wallet.credits_frozen_precise - frozen_amount, Decimal("0"))
        )
        ws_wallet.sync_display_balances()
        ws_wallet.save(
            update_fields=[
                "credits_precise",
                "credits",
                "credits_frozen_precise",
                "credits_frozen",
                "updated_at",
            ]
        )
        consume_tx = WalletTransaction.objects.create(
            organization_wallet=ws_wallet,
            transaction_type="consume",
            amount=CreditsService._to_display_delta(
                int(balance_before.to_integral_value()),
                ws_wallet.credits,
            ),
            amount_precise=-debit,
            balance_before=int(balance_before.to_integral_value()),
            balance_before_precise=balance_before,
            balance_after=ws_wallet.credits,
            balance_after_precise=ws_wallet.credits_precise,
            organization_id=organization_id,
            operator_user_id=operator_user_id,
            reference_key=freeze_id,
            billing_metadata=billing_metadata or {},
            description=description or f"固定成本调用结算 {debit} 点券",
        )
        WalletTransaction.objects.create(
            organization_wallet=ws_wallet,
            transaction_type="unfreeze",
            amount=-int(frozen_amount.to_integral_value()),
            amount_precise=-frozen_amount,
            balance_before=ws_wallet.credits,
            balance_before_precise=ws_wallet.credits_precise,
            balance_after=ws_wallet.credits,
            balance_after_precise=ws_wallet.credits_precise,
            organization_id=organization_id,
            operator_user_id=operator_user_id,
            reference_key=freeze_id,
            billing_metadata=billing_metadata or {},
            description=f"固定成本调用解冻 {frozen_amount} 点券",
        )
        return {
            "settled": True,
            "wallet_transaction_id": str(consume_tx.id),
            "frozen_amount": frozen_amount,
            "debited_amount": debit,
        }

    @staticmethod
    @transaction.atomic
    def release_frozen_credits(organization_id: str, freeze_id: str) -> bool:
        """WAL-07: 异常释放——LLM 调用失败或扣费失败时释放全部冻结金额。

        Args:
            organization_id: 团队 ID
            freeze_id: 冻结时使用的幂等键

        Returns:
            True = 释放成功（含幂等命中），False = 无对应冻结记录
        """
        from ..models import OrganizationWallet as WsWallet

        ws_wallet = (
            WsWallet.objects.select_for_update()
            .filter(organization_id=organization_id)
            .first()
        )
        if not ws_wallet:
            logger.warning("[release_frozen] 团队钱包不存在: %s", organization_id)
            return False

        # 幂等检查（在行锁保护下）
        if WalletTransaction.objects.filter(
            transaction_type="unfreeze",
            reference_key=freeze_id,
        ).exists():
            logger.info("[release_frozen] 幂等命中，已释放: %s", freeze_id)
            return True

        freeze_tx = WalletTransaction.objects.filter(
            transaction_type="freeze",
            reference_key=freeze_id,
        ).first()

        if not freeze_tx:
            logger.info("[release_frozen] 未找到冻结记录: %s", freeze_id)
            return False

        frozen_amount = freeze_tx.amount_precise

        # P1-02: savepoint 包裹钱包更新 + 流水创建，防止 IntegrityError 污染外层事务
        try:
            with transaction.atomic():
                ws_wallet.credits_frozen_precise = CreditsService._quantize_credits(
                    max(ws_wallet.credits_frozen_precise - frozen_amount, Decimal("0")),
                )
                ws_wallet.sync_display_balances()
                ws_wallet.save(update_fields=[
                    "credits_frozen_precise", "credits_frozen", "updated_at",
                ])

                WalletTransaction.objects.create(
                    organization_wallet=ws_wallet,
                    transaction_type="unfreeze",
                    amount=-int(frozen_amount.to_integral_value()),
                    amount_precise=-frozen_amount,
                    balance_before=ws_wallet.credits,
                    balance_before_precise=ws_wallet.credits_precise,
                    balance_after=ws_wallet.credits,
                    balance_after_precise=ws_wallet.credits_precise,
                    organization_id=organization_id,
                    reference_key=freeze_id,
                    description=(
                        f"[freeze_id:{freeze_id}] LLM 调用异常，释放冻结 {frozen_amount} 点券"
                    ),
                )
        except IntegrityError:
            logger.info("[release_frozen] DB 唯一约束命中，已释放: %s", freeze_id)
            return True

        logger.info(
            "[release_frozen] 释放成功: organization=%s freeze_id=%s amount=%s",
            organization_id, freeze_id, frozen_amount,
        )
        return True
