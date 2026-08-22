"""
组织 LLM 月预算池服务
"""

from __future__ import annotations

import logging
from datetime import date
from decimal import Decimal
from typing import Any, Dict, List

from django.db import transaction
from django.utils import timezone

from apps.services.billing.models import OrganizationLlmMonthlyBudget
from apps.services.billing.services.billing_metrics import billing_quota_exhausted_total
from apps.services.billing.services.policy_service import OrganizationBillingPolicyService

logger = logging.getLogger(__name__)


class OrganizationLlmBudgetService:
    """按 organization + 月份 管理 LLM 预算池"""

    CREDITS_QUANT = Decimal("0.0001")

    # WAL-22: get_remaining_quota_credits 短时缓存 TTL（秒）
    QUOTA_REMAINING_CACHE_TTL = 60

    @classmethod
    def _quota_remaining_cache_key(cls, organization_id: str, month: date) -> str:
        return f"llm:quota_remaining:{organization_id}:{month.isoformat()}"

    @classmethod
    def _invalidate_quota_remaining_cache(cls, organization_id: str, month: date) -> None:
        """consume_llm_credits 成功后主动失效预检缓存，防止乐观估计过于陈旧。"""
        try:
            from django.core.cache import cache
            cache.delete(cls._quota_remaining_cache_key(organization_id, month))
        except Exception:
            pass

    @classmethod
    def _quantize(cls, value) -> Decimal:
        return Decimal(str(value or 0)).quantize(cls.CREDITS_QUANT)

    @staticmethod
    def cycle_month(at_time=None) -> date:
        now = at_time or timezone.now()
        return date(now.year, now.month, 1)

    @classmethod
    def _resolve_monthly_included_credits(
        cls,
        organization_id: str,
        at_time=None,
        *,
        sync_entitlement: bool = True,
    ) -> Decimal:
        entitlement = OrganizationBillingPolicyService.get_entitlement_snapshot(organization_id, at_time=at_time)
        credits = cls._quantize(entitlement.get("included_llm_credits_monthly", 0))
        if credits <= 0:
            credits = cls._resolve_membership_fallback_credits(
                organization_id,
                sync_entitlement=sync_entitlement,
            )
        return credits

    @classmethod
    def _resolve_membership_fallback_credits(
        cls,
        organization_id: str,
        *,
        sync_entitlement: bool = True,
    ) -> Decimal:
        """XM-06: entitlement 尚未同步时，直接从 active membership tier 读取 credits。

        当 _sync_entitlement 失败且补偿任务尚未执行时，entitlement 快照返回 0。
        此 fallback 直接查询 OrganizationMembership → MembershipTier 获取 credits，
        避免窗口期内 LLM 调用被全额 paygo 计费。同时触发 entitlement 重同步。
        """
        try:
            from apps.users.membership.models import OrganizationMembership
            wm = OrganizationMembership.objects.filter(
                organization_id=organization_id,
                status="active",
            ).select_related("tier").order_by("-start_date").first()
            if wm and wm.tier and wm.tier.tier_type != "free":
                tier_credits = getattr(wm.tier, "included_llm_credits_monthly", None)
                if tier_credits and Decimal(str(tier_credits)) > 0:
                    logger.warning(
                        "[LlmBudget] XM-06 fallback: entitlement=0 但存在 active membership "
                        "(tier=%s, credits=%s), 使用 tier 值%s: organization=%s",
                        wm.tier.name,
                        tier_credits,
                        "并触发重同步" if sync_entitlement else "",
                        organization_id,
                    )
                    try:
                        from apps.services.billing.services.entitlement_service import (
                            OrganizationEntitlementSyncService,
                        )
                        if sync_entitlement:
                            OrganizationEntitlementSyncService.sync_organization_entitlement(
                                organization_id,
                            )
                    except Exception as sync_exc:
                        logger.warning(
                            "[LlmBudget] entitlement 重同步失败: organization=%s, err=%s",
                            organization_id, sync_exc,
                        )
                    return cls._quantize(tier_credits)
        except Exception as exc:
            logger.debug("[LlmBudget] membership fallback 查询异常: %s", exc)
        return cls._quantize(0)

    @classmethod
    @transaction.atomic
    def get_or_create_monthly_budget_locked(
        cls,
        organization_id: str,
        *,
        at_time=None,
    ) -> OrganizationLlmMonthlyBudget:
        month = cls.cycle_month(at_time)
        full_included = cls._resolve_monthly_included_credits(organization_id, at_time=at_time)

        budget, created = OrganizationLlmMonthlyBudget.objects.select_for_update().get_or_create(
            organization_id=organization_id,
            cycle_month=month,
            defaults={
                "included_credits": full_included,
                "consumed_credits": Decimal("0"),
                "overflow_credits": Decimal("0"),
                "topup_credits": Decimal("0"),
                "updated_from_entitlement_at": at_time or timezone.now(),
            },
        )

        if not created:
            # 权益变更后动态同步当月预算总额，不回退已消费值。
            expected = full_included
            if cls._quantize(budget.included_credits) != expected:
                budget.included_credits = expected
                budget.updated_from_entitlement_at = at_time or timezone.now()
                budget.save(update_fields=["included_credits", "updated_from_entitlement_at", "updated_at"])

        return budget

    # ── WAL-17 fix: 对已存在 budget 也刷新 entitlement ──

    @classmethod
    def get_remaining_quota_credits(
        cls,
        organization_id: str,
        *,
        at_time=None,
        sync_entitlement: bool = True,
    ) -> Decimal:
        """只读获取当月预算剩余，不持锁。仅用于预检的乐观判断。
        WAL-17: 对已存在的 budget 也重新读取 entitlement，确保会员升级后立即反映到预检结果。
        WAL-22: 添加 60s 短时缓存，减少高频 LLM 预检的 DB 压力；
                consume_llm_credits 成功后主动失效，防止乐观估计过于陈旧。
        """
        from django.core.cache import cache

        month = cls.cycle_month(at_time)
        # at_time 非 None 时（如测试/回填场景）跳过缓存，保证时间准确性
        use_cache = at_time is None and sync_entitlement
        cache_key = cls._quota_remaining_cache_key(organization_id, month)

        if use_cache:
            cached = cache.get(cache_key)
            if cached is not None:
                return cached

        budget = OrganizationLlmMonthlyBudget.objects.filter(
            organization_id=organization_id,
            cycle_month=month,
        ).first()

        if not budget:
            included = cls._resolve_monthly_included_credits(
                organization_id,
                at_time=at_time,
                sync_entitlement=sync_entitlement,
            )
            result = included if included > 0 else cls._quantize(0)
            if use_cache:
                try:
                    cache.set(cache_key, result, cls.QUOTA_REMAINING_CACHE_TTL)
                except Exception:
                    pass
            return result

        # WAL-17: 重新读取 entitlement 并比较
        full_included = cls._resolve_monthly_included_credits(
            organization_id,
            at_time=at_time,
            sync_entitlement=sync_entitlement,
        )
        expected = full_included
        current_included = cls._quantize(budget.included_credits)

        if current_included != expected and sync_entitlement:
            try:
                budget.included_credits = expected
                budget.updated_from_entitlement_at = at_time or timezone.now()
                budget.save(update_fields=["included_credits", "updated_from_entitlement_at", "updated_at"])
                current_included = expected
            except Exception as exc:
                logger.warning(
                    "[LLMBudget] get_remaining_quota_credits 刷新 entitlement 失败（不影响预检）: %s",
                    exc,
                )
        elif current_included != expected:
            current_included = expected

        total_quota = current_included + cls._quantize(budget.topup_credits)
        result = max(
            cls._quantize(0),
            total_quota
            - cls._quantize(budget.consumed_credits)
            - cls._quantize(budget.active_reserved_credits),
        )
        if use_cache:
            try:
                cache.set(cache_key, result, cls.QUOTA_REMAINING_CACHE_TTL)
            except Exception:
                pass
        return result

    # ── WAL-20: 配额耗尽通知 ──

    @classmethod
    def _notify_quota_exhausted(cls, organization_id: str, budget_result: dict) -> None:
        """WAL-20: quota_then_paygo 模式下配额耗尽后推送 WS 事件。
        需要 ws_events.VALID_EVENT_TYPES 中注册 "quota_exhausted"。
        """
        try:
            from apps.services.billing.ws_events import publish_billing_event

            publish_billing_event(organization_id, "quota_exhausted", {
                "cycle_month": budget_result.get("cycle_month", ""),
                "included_credits": str(budget_result.get("included_credits", 0)),
                "consumed_credits": str(budget_result.get("consumed_credits", 0)),
            })
        except Exception as exc:
            logger.warning(
                "[LLMBudget] 发送 quota_exhausted 事件失败（不阻断）: organization=%s err=%s",
                organization_id, exc,
            )

    @classmethod
    @transaction.atomic
    def consume_llm_credits(
        cls,
        *,
        organization_id: str,
        requested_credits: Decimal,
        llm_billing_mode: str,
        at_time=None,
        emit_events: bool = True,
    ) -> Dict[str, Any]:
        requested = cls._quantize(requested_credits)
        if requested <= 0:
            return {
                "organization_id": organization_id,
                "cycle_month": cls.cycle_month(at_time).isoformat(),
                "llm_billing_mode": llm_billing_mode,
                "requested_credits": cls._quantize(0),
                "quota_covered_credits": cls._quantize(0),
                "paygo_credits": cls._quantize(0),
                "overflow_credits": cls._quantize(0),
                "remaining_quota_credits": cls._quantize(0),
                "included_credits": cls._quantize(0),
                "consumed_credits": cls._quantize(0),
            }

        if llm_billing_mode == "paygo_only":
            return {
                "organization_id": organization_id,
                "cycle_month": cls.cycle_month(at_time).isoformat(),
                "llm_billing_mode": llm_billing_mode,
                "requested_credits": requested,
                "quota_covered_credits": cls._quantize(0),
                "paygo_credits": requested,
                "overflow_credits": cls._quantize(0),
                "remaining_quota_credits": cls._quantize(0),
                "included_credits": cls._quantize(0),
                "consumed_credits": cls._quantize(0),
            }

        budget = cls.get_or_create_monthly_budget_locked(organization_id, at_time=at_time)
        included = cls._quantize(budget.included_credits) + cls._quantize(budget.topup_credits)
        consumed = cls._quantize(budget.consumed_credits)
        remaining = max(
            cls._quantize(0),
            included
            - consumed
            - cls._quantize(budget.active_reserved_credits),
        )

        quota_covered = min(requested, remaining)
        paygo_credits = requested - quota_covered
        overflow_credits = cls._quantize(0)

        budget.consumed_credits = cls._quantize(consumed + quota_covered)

        # ：quota_only 不再把超出月度配额的部分记为"免费溢出"。
        # 现在与 quota_then_paygo 同口径——配额覆盖 quota_covered，剩余 paygo_credits
        # 交由下游从持久点券钱包 OrganizationWallet 扣减；钱包耗尽再触发现金自动补充。
        # overflow_credits 保留字段但对所有模式恒为 0（历史"免费溢出"语义已废弃）。
        budget.save(update_fields=["consumed_credits", "overflow_credits", "updated_at"])

        # WAL-22: 扣款成功后主动失效预检缓存
        cls._invalidate_quota_remaining_cache(organization_id, budget.cycle_month)

        result = {
            "organization_id": organization_id,
            "cycle_month": budget.cycle_month.isoformat(),
            "llm_billing_mode": llm_billing_mode,
            "requested_credits": requested,
            "quota_covered_credits": quota_covered,
            "paygo_credits": paygo_credits,
            "overflow_credits": overflow_credits,
            "remaining_quota_credits": max(
                cls._quantize(0),
                cls._quantize(budget.included_credits)
                + cls._quantize(budget.topup_credits)
                - cls._quantize(budget.consumed_credits)
                - cls._quantize(budget.active_reserved_credits),
            ),
            "included_credits": cls._quantize(budget.included_credits),
            "topup_credits": cls._quantize(budget.topup_credits),
            "consumed_credits": cls._quantize(budget.consumed_credits),
        }

        # WAL-20: 配额耗尽切换钱包扣费时通知前端（ 起 quota_only 同口径）
        if (
            emit_events
            and llm_billing_mode in ("quota_then_paygo", "quota_only")
            and paygo_credits > 0
            and remaining > 0
        ):
            logger.warning(
                "[LLMBudget] 配额耗尽切换 paygo: organization=%s month=%s "
                "requested=%s quota_covered=%s paygo=%s included=%s consumed=%s",
                organization_id,
                budget.cycle_month.isoformat(),
                requested,
                quota_covered,
                paygo_credits,
                cls._quantize(budget.included_credits),
                cls._quantize(budget.consumed_credits),
            )
            billing_quota_exhausted_total.inc()
            cls._notify_quota_exhausted(organization_id, result)

        return result

    # ── WAL-21: 批量预热 ──

    @classmethod
    def preheat_monthly_budgets(cls, organization_ids: List[str], *, at_time=None) -> int:
        """批量预创建活跃 organization 的新月 budget，缓解月初懒创建 DB 压力。"""
        count = 0
        for ws_id in organization_ids:
            try:
                cls.get_or_create_monthly_budget_locked(ws_id, at_time=at_time)
                count += 1
            except Exception as exc:
                logger.warning("[LLMBudget] preheat 失败: organization=%s err=%s", ws_id, exc)
        return count
