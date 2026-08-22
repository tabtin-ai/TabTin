"""
成员级费用管控服务

三级策略继承：个人策略 > 角色策略 > 默认策略 > 不限。
用量计数器通过 Redis 缓存加速预检路径。
"""

from __future__ import annotations

import logging
from datetime import date
from decimal import Decimal
from typing import Any, Dict, List, Optional

from django.core.cache import cache
from django.db import transaction
from django.db.models import Case, IntegerField, Value, When
from django.utils import timezone

from apps.services.billing.constants import BILLING_TZ
from apps.services.billing.exceptions import BillingError
from apps.services.billing.models import (
    MEMBER_BUDGET_SENTINEL,
    MemberLlmBudgetPolicy,
    MemberLlmUsageCounter,
    OrganizationBillingPolicy,
)

logger = logging.getLogger(__name__)

SENTINEL = MEMBER_BUDGET_SENTINEL


class MemberBudgetExceededError(BillingError):
    """成员级限额阻断异常（L5 专用，与 InsufficientBalanceError 分离）。"""

    def __init__(
        self,
        organization_id: str = "",
        user_id: str = "",
        reason: str = "",
        error_category: str = "",
    ):
        self.organization_id = organization_id
        self.user_id = user_id
        self.reason = reason
        self.error_category = error_category or reason
        code = {
            "member_monthly_limit": "MEMBER_MONTHLY_LIMIT",
            "member_daily_limit": "MEMBER_DAILY_LIMIT",
            "member_model_restricted": "MEMBER_MODEL_RESTRICTED",
        }.get(self.error_category, "MEMBER_BUDGET_EXCEEDED")
        super().__init__(reason or "member budget exceeded", code=code)


class MemberBudgetService:
    """成员级费用管控服务"""

    POLICY_CACHE_TTL = 60
    USAGE_CACHE_TTL = 30
    ROLE_CACHE_TTL = 300

    MODEL_TIER_ORDER: Dict[str, int] = {"standard": 1, "premium": 2, "enterprise": 3}

    # ── 缓存键 ──────────────────────────────────

    @staticmethod
    def _policy_cache_key(organization_id: str, user_id: str) -> str:
        return f"member_budget:policy:{organization_id}:{user_id}"

    @staticmethod
    def _monthly_usage_cache_key(organization_id: str, user_id: str, month: date) -> str:
        return f"member_budget:monthly:{organization_id}:{user_id}:{month}"

    @staticmethod
    def _daily_usage_cache_key(organization_id: str, user_id: str, day: date) -> str:
        return f"member_budget:daily:{organization_id}:{user_id}:{day}"

    # ── 豁免角色 ────────────────────────────────

    @classmethod
    def _get_exempt_roles(cls, organization_id: str) -> list:
        """从 OrganizationBillingPolicy.metadata.member_budget_exempt_roles 读取豁免角色列表（缓存 300s）。"""
        cache_key = f"member_budget:exempt_roles:{organization_id}"
        cached = cache.get(cache_key)
        if cached is not None:
            return cached

        policy = OrganizationBillingPolicy.objects.filter(organization_id=organization_id).first()
        if not policy or not policy.metadata:
            cache.set(cache_key, [], cls.ROLE_CACHE_TTL)
            return []
        roles = policy.metadata.get("member_budget_exempt_roles", [])
        result = roles if isinstance(roles, list) else []
        cache.set(cache_key, result, cls.ROLE_CACHE_TTL)
        return result

    # ── 用户角色解析 ────────────────────────────

    @classmethod
    def resolve_user_role(cls, organization_id: str, user_id: str) -> Optional[str]:
        """解析用户在团队中的角色（Redis 缓存 300s）。

        被多个调用方频繁调用（每次 LLM 预检都需要用户角色），
        缓存能显著减少 DB 查询。
        """
        cache_key = f"member_budget:role:{organization_id}:{user_id}"
        cached = cache.get(cache_key)
        if cached is not None:
            return None if cached == "__none__" else cached

        try:
            from apps.tabtinspace.models import OrganizationMember

            role = (
                OrganizationMember.objects.filter(
                    organization_id=organization_id,
                    user_id=user_id,
                )
                .values_list("role", flat=True)
                .first()
            )
        except Exception:
            role = None

        cache.set(cache_key, role if role is not None else "__none__", cls.ROLE_CACHE_TTL)
        return role

    # ── 模型费用等级计算 ───────────────────────

    @staticmethod
    def compute_model_cost_tier(model_instance_or_cost) -> str:
        """根据模型费用计算费用等级（single source of truth）。

        参数可以是 LLMModel 实例（有 cost_per_1k_tokens 属性）或 float/Decimal 数值。
        阈值来自产品方案 §2.3：
          standard  — cost < 0.01（GPT-4o-mini, DeepSeek-V3 等）
          premium   — 0.01 <= cost < 0.05（GPT-4o, Claude Sonnet 等）
          enterprise — cost >= 0.05（Claude Opus, o1-pro 等）
        """
        if hasattr(model_instance_or_cost, "cost_per_1k_tokens"):
            cost = model_instance_or_cost.cost_per_1k_tokens
        else:
            cost = model_instance_or_cost

        cost = Decimal(str(cost)) if not isinstance(cost, Decimal) else cost

        if cost < Decimal("0.01"):
            return "standard"
        if cost < Decimal("0.05"):
            return "premium"
        return "enterprise"

    # ── 核心：获取生效策略 ──────────────────────

    @classmethod
    def get_effective_policy(
        cls,
        organization_id: str,
        user_id: str,
        user_role: str = None,
    ) -> Optional[MemberLlmBudgetPolicy]:
        """查询对该成员生效的策略（个人 > 角色 > 默认 > None）。

        优先级通过 annotate(priority=Case(...)) 单次查询实现：
          1 = 个人策略（user_id 匹配）
          2 = 角色策略（target_role 匹配）
          3 = 默认策略（两者均为 SENTINEL）
        """
        if not organization_id or not user_id:
            return None

        if user_role is None and user_id != MEMBER_BUDGET_SENTINEL:
            user_role = cls.resolve_user_role(organization_id, user_id)

        if user_role:
            exempt_roles = cls._get_exempt_roles(organization_id)
            if user_role in exempt_roles:
                return None

        cache_key = cls._policy_cache_key(organization_id, user_id)
        cached = cache.get(cache_key)
        if cached is not None:
            return None if cached == "__none__" else cached

        whens = [
            When(user_id=user_id, target_role=SENTINEL, then=Value(1)),
        ]
        if user_role:
            whens.append(
                When(user_id=SENTINEL, target_role=user_role, then=Value(2)),
            )
        whens.append(
            When(user_id=SENTINEL, target_role=SENTINEL, then=Value(3)),
        )

        policy = (
            MemberLlmBudgetPolicy.objects.filter(
                organization_id=organization_id,
                is_active=True,
            )
            .annotate(priority=Case(*whens, output_field=IntegerField()))
            .filter(priority__isnull=False)
            .order_by("priority")
            .first()
        )

        cache.set(cache_key, policy if policy else "__none__", cls.POLICY_CACHE_TTL)
        return policy

    # ── 用量读取 ────────────────────────────────

    @classmethod
    def get_member_usage(cls, organization_id: str, user_id: str) -> Dict[str, Any]:
        """获取成员的月度和日度已用量（缓存 30s）。"""
        today = timezone.now().astimezone(BILLING_TZ).date()
        month_start = today.replace(day=1)

        monthly = cls._get_cached_usage(organization_id, user_id, month_start, "monthly")
        daily = cls._get_cached_usage(organization_id, user_id, today, "daily")

        return {
            "organization_id": organization_id,
            "user_id": user_id,
            "monthly_consumed": str(monthly),
            "monthly_cycle": month_start.isoformat(),
            "daily_consumed": str(daily),
            "daily_date": today.isoformat(),
        }

    # 对账写回口径：与 _increment_member_usage_counter 一致，累加每笔 llm.tokens 事件
    # metadata 里的 raw_credits_cost（= 配额覆盖 + 溢出 + 钱包实扣），而非 amount 字段。
    # amount 仅记钱包实扣（paygo），quota_only 模式下恒为 0，用它对账会把成员计数器
    # 错误清零，导致月度限额失效。llm_blocked / charge_failed 等不产生真实消耗，排除。
    _RECONCILE_EXCLUDED_BIZ_TYPES = (
        "charge_failed", "charge_skipped", "charge_reversed", "llm_blocked",
    )

    @classmethod
    def sum_consumed_credits_from_events(
        cls,
        organization_id: str,
        user_id: str,
        period_start,
        period_end,
    ) -> Decimal:
        """聚合成员在 [period_start, period_end) 内的真实 LLM 点券消耗，供对账写回。

        统计 raw_credits_cost 而非 amount，确保 quota_only（配额覆盖，钱包不扣）
        场景下也能反映真实用量，与递增计数器口径一致。
        """
        from django.db.models import DecimalField, Sum
        from django.db.models.fields.json import KeyTextTransform
        from django.db.models.functions import Cast

        from apps.services.billing.models import BillingUsageEvent

        agg = (
            BillingUsageEvent.objects.filter(
                organization_id=organization_id,
                user_id=user_id,
                meter_key="llm.tokens",
                occurred_at__gte=period_start,
                occurred_at__lt=period_end,
            )
            .exclude(biz_type__in=cls._RECONCILE_EXCLUDED_BIZ_TYPES)
            .annotate(
                _raw=Cast(
                    KeyTextTransform("raw_credits_cost", "metadata"),
                    output_field=DecimalField(max_digits=20, decimal_places=8),
                )
            )
            .aggregate(total=Sum("_raw"))
        )
        return agg["total"] or Decimal("0")

    @classmethod
    def _get_cached_usage(
        cls,
        organization_id: str,
        user_id: str,
        cycle_date: date,
        cycle_type: str,
    ) -> Decimal:
        if cycle_type == "monthly":
            cache_key = cls._monthly_usage_cache_key(organization_id, user_id, cycle_date)
        else:
            cache_key = cls._daily_usage_cache_key(organization_id, user_id, cycle_date)

        cached = cache.get(cache_key)
        if cached is not None:
            return Decimal(str(cached))

        counter = MemberLlmUsageCounter.objects.filter(
            organization_id=organization_id,
            user_id=user_id,
            cycle_date=cycle_date,
            cycle_type=cycle_type,
        ).first()

        value = counter.consumed_credits if counter else Decimal("0")
        cache.set(cache_key, str(value), cls.USAGE_CACHE_TTL)
        return value

    # ── 管理员：用量摘要 ────────────────────────

    @classmethod
    def get_member_usage_summary(cls, organization_id: str) -> List[Dict[str, Any]]:
        """获取团队所有成员的当月用量摘要。

        返回每个成员的月度/日度消费、生效策略限额、模型等级。
        """
        today = timezone.now().astimezone(BILLING_TZ).date()
        month_start = today.replace(day=1)

        monthly_counters = MemberLlmUsageCounter.objects.filter(
            organization_id=organization_id,
            cycle_date=month_start,
            cycle_type="monthly",
        ).order_by("-consumed_credits")

        user_ids = [c.user_id for c in monthly_counters]
        daily_map: Dict[str, Decimal] = {}
        if user_ids:
            daily_counters = MemberLlmUsageCounter.objects.filter(
                organization_id=organization_id,
                user_id__in=user_ids,
                cycle_date=today,
                cycle_type="daily",
            )
            daily_map = {c.user_id: c.consumed_credits for c in daily_counters}

        role_map = cls._batch_resolve_roles(organization_id, user_ids)

        results = []
        for c in monthly_counters:
            user_role = role_map.get(c.user_id)
            policy = cls.get_effective_policy(organization_id, c.user_id, user_role=user_role)

            results.append({
                "user_id": c.user_id,
                "role": user_role,
                "monthly_consumed": str(c.consumed_credits),
                "monthly_limit": (
                    str(policy.monthly_credits_limit)
                    if policy and policy.monthly_credits_limit is not None
                    else None
                ),
                "daily_consumed": str(daily_map.get(c.user_id, Decimal("0"))),
                "daily_limit": (
                    str(policy.daily_credits_limit)
                    if policy and policy.daily_credits_limit is not None
                    else None
                ),
                "max_model_tier": policy.max_model_tier if policy else "enterprise",
                "is_exempt": policy is None and user_role in cls._get_exempt_roles(organization_id),
                "monthly_cycle": month_start.isoformat(),
            })

        return results

    @staticmethod
    def _batch_resolve_roles(organization_id: str, user_ids: list) -> Dict[str, str]:
        """批量查询用户在团队中的角色。"""
        if not user_ids:
            return {}
        try:
            from apps.tabtinspace.models import OrganizationMember

            members = OrganizationMember.objects.filter(
                organization_id=organization_id,
                user_id__in=user_ids,
            ).values_list("user_id", "role")
            return {str(uid): role for uid, role in members}
        except Exception:
            return {}

    # ── 策略 CRUD ────────────────────────────────

    @classmethod
    def upsert_policy(
        cls,
        organization_id: str,
        user_id: str = None,
        target_role: str = None,
        **kwargs,
    ) -> MemberLlmBudgetPolicy:
        """创建或更新策略，on_commit 失效缓存。"""
        effective_user_id = user_id if user_id else SENTINEL
        effective_role = target_role if target_role else SENTINEL

        defaults = {}
        for field in ("monthly_credits_limit", "daily_credits_limit", "max_model_tier", "is_active"):
            if field in kwargs:
                defaults[field] = kwargs[field]

        policy, created = MemberLlmBudgetPolicy.objects.update_or_create(
            organization_id=organization_id,
            user_id=effective_user_id,
            target_role=effective_role,
            defaults=defaults,
        )

        wt_id = organization_id
        uid = effective_user_id
        rl = effective_role

        def _on_commit():
            cls._invalidate_policy_caches(wt_id, uid)
            cls._publish_member_budget_resolved(wt_id, uid, action="upsert", target_role=rl)
            cls._publish_member_budget_event(
                wt_id, uid,
                event_type="member_budget_policy_changed",
                action="upsert",
                target_role=rl,
            )

        transaction.on_commit(_on_commit)

        logger.info(
            "[MemberBudget] %s policy: organization=%s user=%s role=%s id=%s",
            "Created" if created else "Updated",
            organization_id,
            effective_user_id,
            effective_role,
            policy.id,
        )
        return policy

    @classmethod
    def delete_policy(cls, policy_id: str) -> bool:
        """删除策略，on_commit 失效缓存。"""
        policy = MemberLlmBudgetPolicy.objects.filter(id=policy_id).first()
        if not policy:
            return False

        wt_id = policy.organization_id
        uid = policy.user_id
        rl = policy.target_role
        policy.delete()

        def _on_commit():
            cls._invalidate_policy_caches(wt_id, uid)
            cls._publish_member_budget_resolved(wt_id, uid, action="delete", target_role=rl)
            cls._publish_member_budget_event(
                wt_id, uid,
                event_type="member_budget_policy_changed",
                action="delete",
                target_role=rl,
            )

        transaction.on_commit(_on_commit)

        logger.info("[MemberBudget] Deleted policy: id=%s organization=%s", policy_id, wt_id)
        return True

    @classmethod
    def list_policies(cls, organization_id: str) -> List[MemberLlmBudgetPolicy]:
        """列出团队的所有策略。"""
        return list(
            MemberLlmBudgetPolicy.objects.filter(organization_id=organization_id).order_by("-updated_at")
        )

    # ── 缓存失效 ────────────────────────────────

    @classmethod
    def _invalidate_policy_caches(cls, organization_id: str, user_id: str) -> None:
        """失效策略缓存和告警去重 key。

        默认/角色策略变更时（user_id 为哨兵值），批量清除该团队
        所有成员的策略缓存；个人策略变更时仅清除单个键。
        P1-8: 同步清除告警去重 key，确保限额调整后能重新触发告警。
        """
        try:
            cache.delete(f"member_budget:exempt_roles:{organization_id}")

            if user_id == MEMBER_BUDGET_SENTINEL:
                try:
                    from django_redis import get_redis_connection

                    conn = get_redis_connection("default")
                    for pat in (
                        f"member_budget:policy:{organization_id}:*",
                        f"member_budget:alert:*:{organization_id}:*",
                    ):
                        cursor = 0
                        while True:
                            cursor, keys = conn.scan(cursor, match=pat, count=100)
                            if keys:
                                conn.delete(*keys)
                            if cursor == 0:
                                break
                except Exception:
                    cache.delete(cls._policy_cache_key(organization_id, user_id))
            else:
                cache.delete(cls._policy_cache_key(organization_id, user_id))
                cls._clear_alert_dedup_keys(organization_id, user_id)
        except Exception as exc:
            logger.warning("[MemberBudget] 缓存失效失败: %s", exc)

    @staticmethod
    def _clear_alert_dedup_keys(organization_id: str, user_id: str) -> None:
        """清除指定成员的告警去重 key，使限额调整后告警可重新触发。"""
        try:
            from django_redis import get_redis_connection
            conn = get_redis_connection("default")
            pattern = f"member_budget:alert:*:{organization_id}:{user_id}:*"
            cursor = 0
            while True:
                cursor, keys = conn.scan(cursor, match=pattern, count=50)
                if keys:
                    conn.delete(*keys)
                if cursor == 0:
                    break
        except Exception as exc:
            logger.debug("[MemberBudget] _clear_alert_dedup_keys failed: %s", exc)

    @staticmethod
    def _publish_member_budget_event(
        organization_id: str,
        user_id: str,
        *,
        event_type: str = "member_budget_resolved",
        action: str = "",
        target_role: str = "",
    ) -> None:
        """推送成员预算事件，payload 含 scope 以便前端正确分发。

        scope 规则：
        - personal: user_id 为具体用户
        - role:     user_id 为哨兵值且 target_role 非哨兵
        - default:  user_id 和 target_role 均为哨兵
        前端 personal 精确匹配 user_id；role 匹配角色；default 全员响应。
        """
        try:
            from apps.services.billing.ws_events import publish_billing_event

            if user_id != MEMBER_BUDGET_SENTINEL:
                scope = "personal"
            elif target_role and target_role != MEMBER_BUDGET_SENTINEL:
                scope = "role"
            else:
                scope = "default"

            payload: Dict[str, Any] = {
                "user_id": user_id if scope == "personal" else "*",
                "scope": scope,
                "action": action,
            }
            if scope == "role":
                payload["affected_role"] = target_role

            publish_billing_event(organization_id, event_type, payload)
        except Exception as exc:
            logger.warning("[MemberBudget] Failed to publish %s event: %s", event_type, exc)

    @classmethod
    def _publish_member_budget_resolved(
        cls, organization_id: str, user_id: str, *, action: str = "",
        target_role: str = "",
    ) -> None:
        cls._publish_member_budget_event(
            organization_id, user_id,
            event_type="member_budget_resolved",
            action=action,
            target_role=target_role,
        )
