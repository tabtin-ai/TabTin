"""
计费防护服务 — 根据 BillingBudgetPolicy + AnomalyAlert 实现运行时阻断。
"""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Optional, Tuple

from django.conf import settings as django_settings
from django.core.cache import cache
from django.utils import timezone

from apps.i18n import _
from apps.services.billing.exceptions import BillingError
from apps.services.billing.services.billing_metrics import (
    billing_guard_checks_total as GUARD_CHECKS_TOTAL,
    billing_guard_blocks_total as GUARD_BLOCKS_TOTAL,
)
from apps.services.llm.services.billed_call import MIN_BALANCE_THRESHOLD

logger = logging.getLogger(__name__)


class BillingBlockedError(BillingError):
    """组织因计费异常被临时阻断。

    Attributes:
        organization_id: 被阻断的组织 ID。
        reason: 阻断原因文本。
        block_type: 结构化阻断类型，供调用方区分阻断原因并提供差异化引导。
            - ``membership_expired``: 会员过期
            - ``billing_guard_alert``: 计费异常告警触发
        unblock_actions: 可供用户执行的解除阻断操作列表（GRD-21）。
    """

    UNBLOCK_ACTIONS_MAP = {
        "membership_expired": ["renew_membership"],
        "billing_guard_alert": ["recharge", "adjust_budget_policy"],
    }

    def __init__(
        self,
        organization_id: str,
        reason: str,
        *,
        block_type: Optional[str] = None,
        unblock_actions: Optional[list] = None,
    ):
        self.organization_id = organization_id
        self.reason = reason
        self.block_type = block_type or "unknown"
        self.unblock_actions = (
            unblock_actions
            or self.UNBLOCK_ACTIONS_MAP.get(self.block_type, ["contact_support"])
        )
        super().__init__(
            f"Organization {organization_id} blocked by billing guard: {reason}",
            code="BILLING_BLOCKED",
        )

    def to_dict(self) -> dict:
        """结构化输出，供 API 层序列化返回给前端。"""
        return {
            "organization_id": self.organization_id,
            "reason": self.reason,
            "block_type": self.block_type,
            "unblock_actions": self.unblock_actions,
        }


class BillingGuardService:
    """运行时计费防护检查。

    当 organization 配置了 block_on_critical=True 的 BillingBudgetPolicy，
    且近 N 小时内存在未处理的 critical 级异常告警时，抛出 BillingBlockedError 阻断请求。
    """

    CACHE_KEY_PREFIX = "billing:guard:"
    CACHE_TTL_PASS = 30
    CACHE_TTL_BLOCK = 30                   # GRD-07: 10→30s，减少高并发 cache miss 的 thundering herd

    NOTIFY_DEDUP_TTL_BLOCKED = 3600        # GRD-03: 60→3600s，避免用户每分钟收到阻断弹窗
    NOTIFY_DEDUP_TTL_UNBLOCKED = 300       # GRD-02/09: 解除通知去重窗口 5min
    NOTIFY_DEDUP_TTL_MEMBERSHIP = 300      # 会员过期通知去重窗口 5min

    MEMBERSHIP_CACHE_KEY_PREFIX = "billing:membership_status:"
    MEMBERSHIP_CACHE_TTL = 60
    BUDGET_POLICY_CACHE_KEY_PREFIX = "llm:budget_policy:"

    # 充值/状态恢复时仅自动 resolve 以下 metric；财务类异常须人工处理
    AUTO_RESOLVABLE_METRICS = frozenset({
        "budget_warning",
        "budget_critical",
        "entitlement_sync_failure",
    })

    # ------------------------------------------------------------------
    # 内部工具
    # ------------------------------------------------------------------

    @classmethod
    def _get_alert_lookback(cls) -> timedelta:
        hours = getattr(django_settings, "BILLING_GUARD_ALERT_LOOKBACK_HOURS", 1)
        return timedelta(hours=hours)

    @classmethod
    def _current_month_tag(cls) -> str:
        """当前月份标签 (YYYYMM)，用于 dedup key 防止跨月去重冲突。"""
        return timezone.now().strftime("%Y%m")

    @classmethod
    def _publish_event_with_dedup(
        cls,
        organization_id: str,
        event_type: str,
        payload: dict,
        *,
        dedup_key: str,
        dedup_ttl: int,
    ) -> None:
        """带去重保护的 WS 事件发布，合并 GRD-02/03/09/24 的通知去重逻辑。"""
        try:
            from apps.services.billing.ws_events import publish_billing_event

            if not cache.get(dedup_key):
                cache.set(dedup_key, 1, dedup_ttl)
                publish_billing_event(organization_id, event_type, payload)
        except Exception as exc:
            logger.warning("[BillingGuard] WS publish %s failed: %s", event_type, exc)

    @classmethod
    def _extract_block_from_cache(cls, cached) -> Tuple[str, Optional[str]]:
        """从缓存值中解析 (reason, block_type)，兼容新旧格式。

        新格式: ``{"rk": reason_key, "rp": reason_params, "t": block_type}``
        兼容格式: ``{"r": reason, "t": block_type}``
        旧格式: 纯字符串 reason
        """
        if isinstance(cached, dict):
            block_type = cached.get("t")
            reason_key = cached.get("rk")
            reason_params = cached.get("rp") or {}
            if reason_key:
                return _(reason_key, **reason_params), block_type
            if "r" in cached:
                return str(cached["r"]), block_type
        return str(cached), None

    @classmethod
    def _build_block_cache_value(
        cls,
        *,
        block_type: str,
        reason_key: str,
        reason_params: Optional[dict] = None,
    ) -> dict:
        """构造可国际化的阻断缓存值。

        缓存保存 ``reason_key + params``，读取时再按当前语言渲染，
        避免不同语言请求共享同一条缓存时出现串语种。
        """
        return {
            "t": block_type,
            "rk": reason_key,
            "rp": reason_params or {},
        }

    @classmethod
    def _build_block_result(
        cls,
        *,
        block_type: str,
        reason_key: str,
        reason_params: Optional[dict] = None,
    ) -> tuple[str, str, dict]:
        cache_value = cls._build_block_cache_value(
            block_type=block_type,
            reason_key=reason_key,
            reason_params=reason_params,
        )
        reason, cached_block_type = cls._extract_block_from_cache(cache_value)
        return reason, cached_block_type or block_type, cache_value

    # ------------------------------------------------------------------
    # 核心检查
    # ------------------------------------------------------------------

    @classmethod
    def check_organization_billing_guard(
        cls,
        organization_id: str,
        *,
        raise_on_block: bool = True,
    ) -> Optional[str]:
        """检查 organization 是否被计费防护阻断。

        Args:
            organization_id: 组织 ID。
            raise_on_block: True 时阻断则抛出 BillingBlockedError；False 时返回阻断原因或 None。

        Returns:
            None 表示放行，非 None 字符串为阻断原因。

        Raises:
            BillingBlockedError: raise_on_block=True 且命中阻断条件。
        """
        if not organization_id:
            return None

        cache_key = f"{cls.CACHE_KEY_PREFIX}{organization_id}"
        cached = cache.get(cache_key)
        if cached is not None:
            if cached == "":
                GUARD_CHECKS_TOTAL.labels(result="pass").inc()
                return None
            reason, block_type = cls._extract_block_from_cache(cached)
            GUARD_CHECKS_TOTAL.labels(result="block").inc()
            if raise_on_block:
                raise BillingBlockedError(organization_id, reason, block_type=block_type)
            return reason

        # ---- 会员过期检查 ----
        membership_result = cls._check_membership_expired(organization_id)
        if membership_result:
            reason, block_type, cache_value = membership_result
            cache.set(cache_key, cache_value, cls.CACHE_TTL_BLOCK)
            GUARD_CHECKS_TOTAL.labels(result="block").inc()
            GUARD_BLOCKS_TOTAL.labels(block_type=block_type or "membership_expired").inc()
            logger.warning(
                "[BillingGuard] 阻断请求: organization=%s block_type=%s reason=%.120s",
                organization_id, block_type, reason,
            )

            month = cls._current_month_tag()
            cls._publish_event_with_dedup(
                organization_id,
                "membership_expired",
                {
                    "reason": reason,
                    "block_type": block_type,
                },
                dedup_key=f"billing:guard:membership_expired:{organization_id}:{month}",
                dedup_ttl=cls.NOTIFY_DEDUP_TTL_MEMBERSHIP,
            )

            if raise_on_block:
                raise BillingBlockedError(organization_id, reason, block_type=block_type)
            return reason

        # ---- 异常告警检查 ----
        from apps.services.billing.models import BillingBudgetPolicy, BillingAnomalyAlert

        policy = BillingBudgetPolicy.objects.filter(
            organization_id=organization_id,
            is_active=True,
            block_on_critical=True,
        ).first()

        if not policy:
            cache.set(cache_key, "", cls.CACHE_TTL_PASS)
            GUARD_CHECKS_TOTAL.labels(result="pass").inc()
            return None

        cutoff = timezone.now() - cls._get_alert_lookback()
        has_critical = BillingAnomalyAlert.objects.filter(
            organization_id=organization_id,
            severity="critical",
            is_resolved=False,
            created_at__gte=cutoff,
        ).exclude(
            metric_name__startswith="degradation:",
        ).exists()

        if not has_critical:
            cache.set(cache_key, "", cls.CACHE_TTL_PASS)
            GUARD_CHECKS_TOTAL.labels(result="pass").inc()
            return None

        # 快速放行：余额充足时仅 auto_resolve 白名单类 critical，无残留 critical 才写放行缓存
        if cls._wallet_has_positive_balance(organization_id):
            cls._auto_resolve_critical_alerts(organization_id, cutoff=cutoff)
            remaining_critical = BillingAnomalyAlert.objects.filter(
                organization_id=organization_id,
                severity="critical",
                is_resolved=False,
                created_at__gte=cutoff,
            ).exclude(
                metric_name__startswith="degradation:",
            ).exists()
            if not remaining_critical:
                cache.set(cache_key, "", cls.CACHE_TTL_PASS)
                cls._invalidate_billing_caches(organization_id)
                GUARD_CHECKS_TOTAL.labels(result="pass").inc()
                logger.info(
                    "[BillingGuard] 余额充足，自动解除 organization=%s 的 critical alerts",
                    organization_id,
                )
                month = cls._current_month_tag()
                cls._publish_event_with_dedup(
                    organization_id,
                    "billing_unblocked",
                    {"trigger": "balance_positive"},
                    dedup_key=f"billing:guard:unblocked:{organization_id}:{month}",
                    dedup_ttl=cls.NOTIFY_DEDUP_TTL_UNBLOCKED,
                )
                return None

        block_type = "billing_guard_alert"
        reason, block_type, cache_value = cls._build_block_result(
            block_type=block_type,
            reason_key="billing.guard_critical_alert_blocked",
        )
        cache.set(cache_key, cache_value, cls.CACHE_TTL_BLOCK)
        GUARD_CHECKS_TOTAL.labels(result="block").inc()
        GUARD_BLOCKS_TOTAL.labels(block_type=block_type).inc()
        logger.warning(
            "[BillingGuard] 阻断请求（critical alert）: organization=%s block_type=%s",
            organization_id, block_type,
        )

        month = cls._current_month_tag()
        cls._publish_event_with_dedup(
            organization_id,
            "billing_blocked",
            {
                "reason": reason,
                "block_type": block_type,
                "unblock_actions": ["recharge", "adjust_budget_policy"],
            },
            dedup_key=f"billing:guard:notified:{organization_id}:{month}",
            dedup_ttl=cls.NOTIFY_DEDUP_TTL_BLOCKED,
        )

        if raise_on_block:
            raise BillingBlockedError(organization_id, reason, block_type=block_type)
        return reason

    # ------------------------------------------------------------------
    # 余额 / 告警辅助
    # ------------------------------------------------------------------

    @staticmethod
    def _wallet_has_positive_balance(organization_id: str) -> bool:
        """检查 organization 钱包可用余额是否 >= MIN_BALANCE_THRESHOLD (0.01)。

        使用 get_available_credits_precise()（= credits_precise - credits_frozen_precise）
        与 billed_call.check_balance_before_request 完全一致，
        避免 Guard 解除但预检仍阻断的窗口。
        """
        try:
            from apps.users.wallet.models import OrganizationWallet

            wallet = OrganizationWallet.objects.filter(organization_id=organization_id).first()
            if wallet and wallet.get_available_credits_precise() >= MIN_BALANCE_THRESHOLD:
                return True
        except Exception as exc:
            logger.debug("[BillingGuard] 余额检查异常: %s", exc)
        return False

    @classmethod
    def _auto_resolve_critical_alerts(cls, organization_id: str, *, cutoff=None) -> int:
        """自动 resolve lookback 窗口内白名单类的未处理 critical 告警。

        与 ``check_organization_billing_guard`` / ``clear_guard_cache`` 的 lookback 对齐，
        避免 resolve 窗口外的历史记录；财务类 critical（如 charge_failed）不自动关闭。
        """
        from apps.services.billing.models import BillingAnomalyAlert

        if cutoff is None:
            cutoff = timezone.now() - cls._get_alert_lookback()

        return BillingAnomalyAlert.objects.filter(
            organization_id=organization_id,
            severity="critical",
            is_resolved=False,
            metric_name__in=cls.AUTO_RESOLVABLE_METRICS,
            created_at__gte=cutoff,
        ).update(is_resolved=True, resolved_at=timezone.now())

    @classmethod
    def _invalidate_billing_caches(cls, organization_id: str) -> None:
        """清除 Guard 解除时需要连带失效的全部关联缓存。

        与 ``clear_guard_cache`` 中 delete 的 key 列表保持一致，
        确保所有调用方（check_organization_billing_guard / publish_budget_resolved 等）
        都能完整清理缓存，不遗漏预算通知去重 key。
        """
        from datetime import date as _date

        now = timezone.now()
        cycle_month = _date(now.year, now.month, 1)
        month = cls._current_month_tag()

        cache.delete(f"{cls.MEMBERSHIP_CACHE_KEY_PREFIX}{organization_id}")
        cache.delete(f"{cls.BUDGET_POLICY_CACHE_KEY_PREFIX}{organization_id}")
        cache.delete(f"llm:quota_remaining:{organization_id}:{cycle_month.isoformat()}")
        cache.delete(f"llm:block_on_critical:{organization_id}")
        for _level in ("warning", "critical"):
            cache.delete(f"llm:budget_notified:{organization_id}:{_level}:{month}")
        cache.delete(f"llm:budget_last_alert_level:{organization_id}")

    # ------------------------------------------------------------------
    # 外部入口：显式清缓存
    # ------------------------------------------------------------------

    @classmethod
    def clear_guard_cache(
        cls,
        organization_id: str,
        *,
        trigger: str = "cache_cleared",
    ) -> None:
        """清除指定 organization 的所有 Guard / 预算 / 通知去重缓存并尝试解除阻断。

        供外部模块在状态变更后调用，确保后续请求不会命中过期缓存。
        统一收口所有缓存清理逻辑，避免各调用方各自维护 key 列表。

        Args:
            organization_id: 组织 ID。
            trigger: 触发来源，用于 WS 事件语义区分
                （如 ``"recharge"`` / ``"membership_activated"``）。
        """
        if not organization_id:
            return

        guard_key = f"{cls.CACHE_KEY_PREFIX}{organization_id}"
        was_blocked = cache.get(guard_key)

        cache.delete(guard_key)
        cls._invalidate_billing_caches(organization_id)

        cutoff = timezone.now() - cls._get_alert_lookback()
        resolved_count = cls._auto_resolve_critical_alerts(organization_id, cutoff=cutoff)

        from apps.services.billing.models import BillingAnomalyAlert

        remaining_critical = BillingAnomalyAlert.objects.filter(
            organization_id=organization_id,
            severity="critical",
            is_resolved=False,
            created_at__gte=cutoff,
        ).exclude(
            metric_name__startswith="degradation:",
        ).exists()

        month = cls._current_month_tag()
        if (was_blocked or resolved_count > 0) and not remaining_critical:
            cls._publish_event_with_dedup(
                organization_id,
                "billing_unblocked",
                {
                    "trigger": trigger,
                    "resolved_alerts": resolved_count,
                },
                dedup_key=f"billing:guard:unblocked:{organization_id}:{month}",
                dedup_ttl=cls.NOTIFY_DEDUP_TTL_UNBLOCKED,
            )
            try:
                cls.publish_budget_resolved(
                    organization_id,
                    previous_level="critical" if was_blocked else "warning",
                )
            except Exception:
                pass

        logger.info(
            "[BillingGuard] clear_guard_cache: organization=%s trigger=%s was_blocked=%s resolved=%d",
            organization_id, trigger, bool(was_blocked), resolved_count,
        )

    # ------------------------------------------------------------------
    # 结构化检查（GRD-05 补全）
    # ------------------------------------------------------------------

    @classmethod
    def check_organization_billing_guard_detailed(
        cls,
        organization_id: str,
    ) -> dict:
        """返回结构化阻断检查结果，不抛异常。

        GRD-05/21: 调用方可通过 ``block_type`` / ``unblock_actions`` 字段
        给用户提供差异化引导，而非仅拿到一个 reason 字符串。

        Returns:
            dict with keys:
            - ``blocked`` (bool)
            - ``reason`` (str|None)
            - ``block_type`` (str|None)
            - ``unblock_actions`` (list[str])
        """
        try:
            cls.check_organization_billing_guard(organization_id, raise_on_block=True)
            return {
                "blocked": False,
                "reason": None,
                "block_type": None,
                "unblock_actions": [],
            }
        except BillingBlockedError as exc:
            return exc.to_dict() | {"blocked": True}

    # ------------------------------------------------------------------
    # 预算告警基础设施（GRD-14/18/19）
    # ------------------------------------------------------------------

    @classmethod
    def generate_budget_dedup_key(cls, organization_id: str, level: str) -> str:
        """生成含月维度的预算告警去重 key。

        GRD-14: 原 ``billing:budget:{level}:{organization_id}`` 跨月不失效，
        月初新周期告警被旧 dedup key 吞掉。加上 ``YYYYMM`` 后缀即可。
        llm/services/billing.py 的 ``_notify_budget_alert`` 应迁移为使用此方法。
        """
        month = cls._current_month_tag()
        return f"billing:budget:{level}:{organization_id}:{month}"

    @classmethod
    def persist_budget_alert(
        cls,
        organization_id: str,
        *,
        level: str,
        usage_percent: float,
        budget_limit: float,
        consumed: float = 0,
    ):
        """将预算阈值告警持久化为 BillingAnomalyAlert。

        GRD-18: warning/critical 仅通过 Cache + WS 处理，不写入持久表，
        运维无法查询历史，审计能力为零。此方法补齐持久化链路。

        GRD-12: Guard 不感知预算阻断的桥接——创建 BillingAnomalyAlert 后，
        ``check_organization_billing_guard`` 的 ``has_critical`` 查询即可命中。

        Args:
            organization_id: 组织 ID
            level: ``"warning"`` 或 ``"critical"``
            usage_percent: 当前用量百分比
            budget_limit: 预算上限（点券）
            consumed: 已消耗额度

        Returns:
            创建的 BillingAnomalyAlert 实例
        """
        from decimal import Decimal as D
        from apps.services.billing.models import BillingAnomalyAlert

        BillingAnomalyAlert.objects.filter(
            organization_id=organization_id,
            alert_type="pattern",
            metric_name__startswith="budget_",
            is_resolved=False,
        ).exclude(metric_name=f"budget_{level}").update(
            is_resolved=True, resolved_at=timezone.now()
        )

        alert = BillingAnomalyAlert.objects.create(
            alert_type="pattern",
            severity=level,
            organization_id=organization_id,
            metric_name=f"budget_{level}",
            current_value=D(str(round(usage_percent, 2))),
            baseline_value=D(str(round(budget_limit, 4))),
            threshold_ratio=D(str(round(usage_percent, 2))),
            message=_(
                "billing.guard_budget_alert_message",
                usage_percent=f"{usage_percent:.1f}",
                consumed=f"{consumed:.2f}",
                budget_limit=f"{budget_limit:.2f}",
                level=level,
            ),
        )
        logger.info(
            "[BillingGuard] persist_budget_alert: organization=%s level=%s usage=%.1f%% "
            "consumed=%.2f budget=%.2f",
            organization_id, level, usage_percent, consumed, budget_limit,
        )

        from apps.services.billing.services.billing_metrics import billing_budget_alert_total
        billing_budget_alert_total.labels(level=level).inc()

        if level == "critical":
            cache_key = f"{cls.CACHE_KEY_PREFIX}{organization_id}"
            cache.delete(cache_key)

        return alert

    @classmethod
    def publish_budget_resolved(
        cls,
        organization_id: str,
        *,
        previous_level: str = "warning",
        current_percent: float = 0,
    ) -> None:
        """推送预算恢复正常事件。

        GRD-19: warning/critical 告警无对应的"已恢复"推送，
        用户收到告警后即使余额恢复也感知不到。

        同时 auto-resolve 未处理的 budget 类 BillingAnomalyAlert。
        """
        from apps.services.billing.models import BillingAnomalyAlert

        resolved_count = BillingAnomalyAlert.objects.filter(
            organization_id=organization_id,
            alert_type="pattern",
            metric_name__startswith="budget_",
            is_resolved=False,
        ).update(is_resolved=True, resolved_at=timezone.now())

        if resolved_count > 0:
            cls._invalidate_billing_caches(organization_id)
            cache_key = f"{cls.CACHE_KEY_PREFIX}{organization_id}"
            cache.delete(cache_key)

        month = cls._current_month_tag()
        cls._publish_event_with_dedup(
            organization_id,
            "budget_resolved",
            {
                "previous_level": previous_level,
                "current_percent": round(current_percent, 1),
                "resolved_alerts": resolved_count,
            },
            dedup_key=f"billing:budget_resolved:{organization_id}:{month}",
            dedup_ttl=cls.NOTIFY_DEDUP_TTL_UNBLOCKED,
        )

        logger.info(
            "[BillingGuard] publish_budget_resolved: organization=%s prev=%s resolved=%d",
            organization_id, previous_level, resolved_count,
        )

    # ------------------------------------------------------------------
    # 会员过期检查
    # ------------------------------------------------------------------

    @classmethod
    def _check_membership_expired(cls, organization_id: str) -> Optional[Tuple[str, str, dict]]:
        """检查 organization 会员是否已过期（含宽限期校验）。

        GRD-08: 宽限期通过 settings.BILLING_GUARD_MEMBERSHIP_GRACE_HOURS 配置，
        默认 2 小时。应至少为 Celery ``downgrade_expired_entitlements`` 调度间隔
        的 2 倍，确保 worker 异常恢复后有足够时间处理过期降级。

        结果缓存 60s（独立于 guard 主缓存），避免高频查库。

        Returns:
            None 表示会员有效（或无会员记录），
            ``(reason, block_type)`` 元组表示阻断。
        """
        cache_key = f"{cls.MEMBERSHIP_CACHE_KEY_PREFIX}{organization_id}"
        cached = cache.get(cache_key)
        if cached is not None:
            if cached == "":
                return None
            if isinstance(cached, dict):
                reason, block_type = cls._extract_block_from_cache(cached)
                return (reason, block_type or "membership_expired", cached)
            # 兼容旧格式（纯 str）和新格式（tuple/list）
            if isinstance(cached, (list, tuple)) and len(cached) == 2:
                return (cached[0], cached[1], {"r": cached[0], "t": cached[1]})
            return (
                str(cached),
                "membership_expired",
                {"r": str(cached), "t": "membership_expired"},
            )

        try:
            from apps.users.membership.models import OrganizationMembership

            wm = OrganizationMembership.objects.filter(
                organization_id=organization_id,
            ).only("status", "end_date", "auto_renew").order_by("-created_at").first()

            if wm is None:
                cache.set(cache_key, "", cls.MEMBERSHIP_CACHE_TTL)
                return None

            # GRD-10: status='expired' 直接阻断，不受 end_date 影响
            # 防止 end_date 为未来时间的异常数据导致放行
            if wm.status == "expired":
                reason, block_type, cache_value = cls._build_block_result(
                    block_type="membership_expired",
                    reason_key="billing.guard_membership_expired_status",
                )
                result = (reason, block_type, cache_value)
                cache.set(cache_key, cache_value, cls.MEMBERSHIP_CACHE_TTL)
                return result

            if wm.status == "active" and (wm.end_date is None or wm.end_date > timezone.now()):
                cache.set(cache_key, "", cls.MEMBERSHIP_CACHE_TTL)
                return None

            grace_hours = getattr(django_settings, "BILLING_GUARD_MEMBERSHIP_GRACE_HOURS", 2)
            grace_cutoff = timezone.now() - timedelta(hours=grace_hours)

            if wm.end_date and wm.end_date > grace_cutoff:
                cache.set(cache_key, "", cls.MEMBERSHIP_CACHE_TTL)
                return None

            reason, block_type, cache_value = cls._build_block_result(
                block_type="membership_expired",
                reason_key="billing.guard_membership_expired_grace",
                reason_params={
                    "end_date": str(wm.end_date),
                    "grace_hours": grace_hours,
                },
            )
            result = (reason, block_type, cache_value)
            cache.set(cache_key, cache_value, cls.MEMBERSHIP_CACHE_TTL)
            return result
        except Exception as exc:
            logger.warning("[BillingGuard] 会员过期检查异常，放行: %s", exc)
            return None
