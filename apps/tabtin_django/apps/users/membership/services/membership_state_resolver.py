"""只读解析 Organization 当前套餐状态。

Resolver 只做无副作用解析，不写数据库。PR5 起宽限期以
OrganizationMembership.grace_period_end 为事实源；旧的 3 天配置只保留给尚未
落库 grace_period_end 的 active 历史数据做兼容展示。
"""

from dataclasses import dataclass
from datetime import timedelta
from typing import Any, Optional, Tuple

from django.conf import settings
from django.utils import timezone

from ..exceptions import MembershipLifecycleError


SUPPORTED_BILLING_CYCLES = frozenset({"monthly", "yearly"})


@dataclass(frozen=True)
class MembershipResolvedState:
    lifecycle_state: str
    has_effective_membership: bool
    effective_tier: Any
    membership_status: Optional[str]
    period_start: Any
    period_end: Any
    is_expired_by_time: bool
    current_billing_cycle: str
    pending_change: Any = None
    allowed_actions: Tuple[str, ...] = ()


class MembershipStateResolver:
    """将会员记录解析成无副作用、可供分类器复用的当前状态。"""

    @classmethod
    def resolve_billing_cycle(cls, membership) -> str:
        if membership is None:
            return "monthly"

        # TODO(subscription-lifecycle-pr2): 模型增加 billing_cycle 后删除 monthly 兼容推断。
        cycle = getattr(membership, "billing_cycle", None) or "monthly"
        return cls.validate_billing_cycle(cycle)

    @staticmethod
    def validate_billing_cycle(value: str) -> str:
        if not isinstance(value, str):
            raise MembershipLifecycleError(
                "会员计费周期无效",
                "MEMBERSHIP_BILLING_CYCLE_INVALID",
            )
        normalized = value.strip().lower()
        if normalized not in SUPPORTED_BILLING_CYCLES:
            raise MembershipLifecycleError(
                "会员计费周期无效",
                "MEMBERSHIP_BILLING_CYCLE_INVALID",
            )
        return normalized

    @staticmethod
    def _legacy_grace_period() -> timedelta:
        """历史 active 记录未落库 grace_period_end 时的兼容窗口。"""
        days = getattr(settings, "ENTITLEMENT_GRACE_PERIOD_DAYS", 3)
        try:
            days = int(days)
        except (TypeError, ValueError) as exc:
            raise MembershipLifecycleError(
                "会员宽限期配置无效",
                "MEMBERSHIP_GRACE_POLICY_INVALID",
            ) from exc
        if days < 0:
            raise MembershipLifecycleError(
                "会员宽限期配置无效",
                "MEMBERSHIP_GRACE_POLICY_INVALID",
            )
        return timedelta(days=days)

    @classmethod
    def resolve(cls, membership, *, now=None, grace_period=None) -> MembershipResolvedState:
        resolved_now = now or timezone.now()
        if membership is None:
            return MembershipResolvedState(
                lifecycle_state="free",
                has_effective_membership=False,
                effective_tier=None,
                membership_status=None,
                period_start=None,
                period_end=None,
                is_expired_by_time=False,
                current_billing_cycle="monthly",
                allowed_actions=("new",),
            )

        if grace_period is None:
            grace_period = cls._legacy_grace_period()
        if not isinstance(grace_period, timedelta) or grace_period < timedelta(0):
            raise MembershipLifecycleError(
                "会员宽限期配置无效",
                "MEMBERSHIP_GRACE_POLICY_INVALID",
            )

        cycle = cls.resolve_billing_cycle(membership)
        status = str(getattr(membership, "status", "") or "").strip().lower()
        tier = getattr(membership, "tier", None)
        period_start = getattr(membership, "start_date", None)
        period_end = getattr(membership, "end_date", None)
        is_expired_by_time = bool(period_end and resolved_now > period_end)
        explicit_grace_end = getattr(membership, "grace_period_end", None)

        legacy_grace_end = explicit_grace_end
        if not legacy_grace_end and period_end and resolved_now > period_end:
            legacy_grace_end = period_end + grace_period

        is_in_legacy_grace = bool(period_end and resolved_now > period_end and legacy_grace_end and resolved_now <= legacy_grace_end)

        if status == "suspended":
            lifecycle_state = "suspended"
            is_effective = False
        elif status == "cancelled":
            lifecycle_state = "cancelled"
            is_effective = False
        elif status == "grace":
            is_effective = bool(tier) and bool(explicit_grace_end) and resolved_now <= explicit_grace_end
            if resolved_now <= (explicit_grace_end or resolved_now):
                is_effective = bool(tier) and explicit_grace_end is not None
                lifecycle_state = "grace_period"
            else:
                lifecycle_state = "expired"
                is_effective = False
        elif status == "expired" and explicit_grace_end and resolved_now <= explicit_grace_end:
            # 历史老记录可能将过期状态写为 expired，但仍写了 grace_period_end。
            # 任务还没执行到期切换时，前端应按 grace_period 保持可用。
            is_effective = bool(tier)
            lifecycle_state = "grace_period"
        elif status == "expired":
            lifecycle_state = "expired"
            is_effective = False
        elif status == "active":
            if tier is not None and getattr(tier, "price", 0) == 0:
                lifecycle_state = "free"
                is_effective = False
            elif is_in_legacy_grace:
                lifecycle_state = "grace_period"
                is_effective = bool(tier)
            elif period_end and resolved_now > period_end:
                # 到期执行任务尚未跑到时，按任务入库后状态恢复；若历史宽限期已存在，显示为 grace。
                is_effective = False
                lifecycle_state = "expired"
            else:
                is_effective = bool(tier)
                lifecycle_state = "active" if is_effective else "unknown"
        else:
            lifecycle_state = "unknown"
            is_effective = False

        return MembershipResolvedState(
            lifecycle_state=lifecycle_state,
            has_effective_membership=is_effective,
            effective_tier=tier if is_effective else None,
            membership_status=status or None,
            period_start=period_start,
            period_end=period_end,
            is_expired_by_time=is_expired_by_time,
            current_billing_cycle=cycle,
            allowed_actions=(
                ("renew", "upgrade", "downgrade", "switch")
                if lifecycle_state in {"active", "grace_period"}
                else ("new",)
            ),
        )
