"""
Prometheus 计费监控指标注册表

所有计费 Prometheus 指标在此统一定义，避免多模块重复注册冲突。

用法::

    from apps.services.billing.services.billing_metrics import (
        billing_charges_total,
        billing_refunds_total,
        billing_guard_checks_total,
        billing_auto_renew_total,
    )
"""

from __future__ import annotations

import logging

_logger = logging.getLogger(__name__)


class _NullMetric:
    """prometheus_client 不可用时的静默替代，保持调用方接口不变。"""

    def labels(self, **kwargs) -> "_NullMetric":
        return self

    def inc(self, amount: float = 1) -> None:
        pass

    def observe(self, value: float) -> None:
        pass


def _null() -> _NullMetric:
    return _NullMetric()


try:
    from prometheus_client import Counter, Histogram

    # ── 账单扣款（invoice 级） ──
    billing_charges_total = Counter(
        "billing_charges_total",
        "账单扣款操作总次数",
        ["result"],
        # result: paid | already_paid | already_charged | zero_amount_paid |
        #   failed_insufficient_credits | failed_no_payer |
        #   failed_exception | failed_unexpected | failed_unhandled
    )

    billing_charge_amount_credits = Histogram(
        "billing_charge_amount_credits",
        "账单扣款金额分布（点券）",
        buckets=[0.01, 0.1, 1, 5, 10, 50, 100, 500, 1000, 5000],
    )

    # ── 退款 ──
    billing_refunds_total = Counter(
        "billing_refunds_total",
        "退款操作计数",
        ["result"],
        # result: initiated | success | failed
    )

    # ── Guard 阻断 ──
    billing_guard_checks_total = Counter(
        "billing_guard_checks_total",
        "计费 Guard 检查次数",
        ["result"],
        # result: pass | block
    )

    billing_guard_blocks_total = Counter(
        "billing_guard_blocks_total",
        "计费 Guard 阻断详情（按阻断类型）",
        ["block_type"],
        # block_type: membership_expired | billing_guard_alert | unknown
    )

    # ── 自动续费 ──
    billing_auto_renew_total = Counter(
        "billing_auto_renew_total",
        "自动续费操作计数",
        ["membership_type", "result"],
        # membership_type: organization | user
        # result: success | failed | skipped_balance | skipped_dedup
    )

    # ── LLM 配额 ──
    billing_quota_exhausted_total = Counter(
        "billing_quota_exhausted_total",
        "LLM 月度配额耗尽（切换 paygo）次数",
        [],
    )

    # ── 预算告警 ──
    billing_budget_alert_total = Counter(
        "billing_budget_alert_total",
        "预算告警触发次数",
        ["level"],
        # level: warning | critical
    )

    # ── 冻结泄漏自动回收 ──
    billing_frozen_credits_auto_released_total = Counter(
        "billing_frozen_credits_auto_released_total",
        "冻结泄漏自动回收次数",
        [],
    )

except Exception as _exc:  # noqa: BLE001
    _logger.warning(
        "[BillingMetrics] prometheus_client 不可用，指标已降级为空操作: %s", _exc
    )
    billing_charges_total = _null()
    billing_charge_amount_credits = _null()
    billing_refunds_total = _null()
    billing_guard_checks_total = _null()
    billing_guard_blocks_total = _null()
    billing_auto_renew_total = _null()
    billing_quota_exhausted_total = _null()
    billing_budget_alert_total = _null()
    billing_frozen_credits_auto_released_total = _null()
