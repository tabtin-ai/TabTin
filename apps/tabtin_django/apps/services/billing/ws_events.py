"""
计费 WebSocket 事件发布。

通过 WS Bus 向 billing.events.{organization_id} topic 推送实时计费事件，
前端据此展示 toast / 桌面通知。
"""

from __future__ import annotations

import logging
import time
import uuid
from typing import Any, Dict

logger = logging.getLogger(__name__)

VALID_EVENT_TYPES = frozenset({
    "budget_warning",
    "budget_critical",
    "balance_low",
    "budget_resolved",
    "billing_blocked",
    "billing_unblocked",
    "degradation_alert",
    "invoice_refunded",
    "credits_recharged",
    "cash_recharged",           # 组织人民币钱包充值成功（后台代充 / 自助支付）
    "quota_exhausted",          # WAL-20: 配额耗尽时推送 WS 事件
    "quota_topup",              # LLM 点券自动补充成功（钱包扣款 → 预算池加量）
    "membership_activated",
    "membership_expiring",
    "membership_expired",
    "auto_renew_failed",
    "membership_renewal_cancelled",
    "membership_downgraded_overlimit",
    "platform_refund_failed",       # D10: 支付平台退款失败通知
    "platform_refund_completed",    # D10: 支付平台退款完成通知
    "refund_partial_failure",       # D10: 退款部分失败（平台已退但内部未完成）
    "storage_warning",              # STOR: 存储用量 ≥90% 告警
    "storage_critical",             # STOR: 存储用量 ≥95% 紧急告警
    "storage_resolved",             # STOR: 存储用量恢复至 <80%
    "storage_package_expiring",     # STOR: 存储套餐即将到期提醒
    "storage_auto_renew_failed",    # STOR: 存储套餐自动续费失败
    "invoice_collection_succeeded",  # P0-2: 催收成功通知
    "invoice_collection_failed",     # P0-2: 催收失败通知
    "member_budget_warning",         # PR5: 成员月度额度达 80%
    "member_budget_exhausted",       # PR5: 成员月度额度达 100%
    "member_budget_resolved",        # PR5: 管理员提额/删策略后，前端重置 memberLimitReached
    "member_budget_policy_changed",  # PR5: 策略新增/修改/删除，前端刷新策略面板
    "usage_aggregated",              # W3-1: 小额异步聚合扣款完成
})


def publish_billing_event(organization_id: str, event_type: str, payload: dict) -> bool:
    """向 billing.events.{organization_id} topic 发布事件。

    Returns:
        True on success, False on failure (never raises).
    """
    if not organization_id:
        logger.warning("[BillingWS] publish_billing_event called with empty organization_id")
        return False
    if event_type not in VALID_EVENT_TYPES:
        logger.warning("[BillingWS] unknown event_type=%s", event_type)
        return False

    projection = None
    # 账户消息中心是业务事实的持久投影；失败不能阻断原有 WS 数据刷新。
    try:
        from apps.services.notification.services.account_notification_adapter import (
            project_account_notification,
        )

        projection = project_account_notification(str(organization_id), event_type, payload)
    except Exception:
        logger.warning(
            "[BillingWS] persist account notification failed event=%s organization=%s",
            event_type,
            organization_id,
            exc_info=True,
        )

    from apps.services.common.ws.bus import publish_ws_event

    topic = f"billing.events.{organization_id}"
    envelope: Dict[str, Any] = {
        "v": 1,
        "type": f"billing.{event_type}",
        "request_id": f"evt_{uuid.uuid4().hex[:16]}",
        "ts": int(time.time()),
        "payload": {
            "event_type": event_type,
            "organization_id": organization_id,
            **payload,
        },
    }
    if (
        projection
        and projection.authoritative
        and projection.projected
        and projection.recipient_count > 0
        and projection.source_event_id
    ):
        envelope["presentation"] = {
            "owner": "notification_projection",
            "authoritative": True,
            "projected": True,
            "source_event_id": projection.source_event_id,
            "recipient_count": projection.recipient_count,
        }

    ok = publish_ws_event(topic, envelope)
    if ok:
        logger.info(
            "[BillingWS] published %s to %s",
            event_type, topic,
        )
    return ok


# 同一次 LLM 请求失败可能在结算的内层（BillingGateway.settle_llm_usage 捕获
# InsufficientCreditsError）与外层（charge_llm_usage 的 catch）各触发一次
# billing_blocked，reason 分别为 BILLING_WALLET_INSUFFICIENT 与
# organization_insufficient_credits。前端每条各弹一个 toast，用户看到重复阻断提示。
# 按 (org, request_id) 去重，保证同一次请求只广播一条。
_BLOCKED_DEDUP_TTL_SECONDS = 60

# 阻断是「组织级持续状态」而非「每次请求各发一次的事件」。一个 Agent 回合会拆成
# 多次 LLM 调用、用户会连续发多条消息，每个请求都有独立 request_id，仅靠
# (org, request_id) 去重无法合并这些「不同请求各发一条」的广播，前端/移动端就被
# billing_blocked toast 刷屏。再叠一层「按 org」的节流：窗口内同一组织只广播一条，
# 与 request_id 无关。钱包是组织级资源，「组织被阻断」对所有成员是同一条事实，
# 合并广播符合语义而非丢信息。
_BLOCKED_ORG_THROTTLE_SECONDS = 60


def publish_billing_blocked_deduped(
    organization_id: str,
    reason: str,
    request_id: str = "",
    extra: dict | None = None,
) -> bool:
    """发布 billing_blocked WS 事件，按 (org, request_id) 去重 + 按 org 节流。

    两道闸叠加（任一命中即不广播）：
    1. 同请求去重：同一 request_id 在 TTL 窗口内只广播一条（先到者胜）；
       request_id 为空时无法关联同一次请求，跳过这道闸。
    2. org 级节流：窗口内同一组织只广播一条 billing_blocked，与 request_id 无关，
       用于合并「一个回合多次 LLM 调用 / 连续多条消息」产生的跨请求风暴。

    展示文案由前端按 reason 映射，因此窗口内先到的 reason 即最终展示语义。
    """
    organization_id = str(organization_id or "")
    request_id = str(request_id or "").strip()
    normalized_reason = str(reason or "")
    request_shortfall_codes = {
        "organization_insufficient_credits",
        "billing_wallet_insufficient",
        "insufficient_credits",
    }
    is_request_shortfall = normalized_reason.lower() in request_shortfall_codes
    payload: Dict[str, Any] = {
        "reason": normalized_reason,
        "code": normalized_reason,
        "error_code": (
            "ORGANIZATION_INSUFFICIENT_CREDITS"
            if is_request_shortfall
            else "BILLING_BLOCKED"
        ),
        "block_type": (
            "request_insufficient_credits"
            if is_request_shortfall
            else "organization_billing_guard"
        ),
    }
    if request_id:
        payload["request_id"] = request_id
    if extra:
        protected = {
            "reason",
            "code",
            "error_code",
            "block_type",
            "organization_id",
        }
        payload.update({
            key: value
            for key, value in extra.items()
            if key not in protected
        })

    from django.core.cache import cache

    if request_id:
        dedup_key = f"billing:blocked:sent:{organization_id}:{request_id}"
        # cache.add 原子：key 不存在才写入并返回 True；已存在返回 False → 已发过，跳过。
        if not cache.add(dedup_key, 1, _BLOCKED_DEDUP_TTL_SECONDS):
            logger.info(
                "[BillingWS] billing_blocked deduped org=%s request_id=%s reason=%s",
                organization_id, request_id, reason,
            )
            return False

    # org 级节流：即便 request_id 各不相同，窗口内同一 org 也只放行一条。
    org_key = f"billing:blocked:org:{organization_id}"
    if not cache.add(org_key, 1, _BLOCKED_ORG_THROTTLE_SECONDS):
        logger.info(
            "[BillingWS] billing_blocked org-throttled org=%s request_id=%s reason=%s",
            organization_id, request_id or "-", reason,
        )
        return False

    return publish_billing_event(organization_id, "billing_blocked", payload)
