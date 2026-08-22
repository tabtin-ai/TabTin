"""Tracker 离线相关事件的系统通知桥接（离线韧性 M2）。

两类**必达**系统通知（落 ``notification_notification`` 表，App 通知中心可见，
WS 用户级推送 + 离线 inbox 补送由 NotificationService 统一处理）：

1. Run 进入 ``waiting_device``（挂起等设备上线）；
2. 等待超窗（6h）失败。

普通业务失败（Agent 报错等）**不进**系统通知——维持 WS + 连败熔断告警现状，
避免通知疲劳（业务失败不重试不轰炸）。

收件人 = ``tracker.created_by``（运行身份），不发 Space 全员。
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

# metadata.category 统一值，前端/查询按此过滤离线类通知。
OFFLINE_NOTIFY_CATEGORY = "tracker_offline"

def _notify_owner(tracker, title: str, body: str, extra_meta: dict | None = None) -> None:
    """给 Tracker 创建者发一条系统通知。任何失败只记日志，不影响主流程。"""
    user_id = getattr(tracker, "created_by_id", None)
    if not user_id:
        return
    try:
        from apps.services.notification.services.notification_service import (
            NotificationService,
        )

        metadata = {
            "category": OFFLINE_NOTIFY_CATEGORY,
            "tracker_id": str(tracker.id),
            "space_id": str(tracker.workspace_id) if tracker.workspace_id else "",
            **(extra_meta or {}),
        }
        NotificationService.notify(
            user_id=str(user_id),
            type="system",
            title=title,
            body=body,
            metadata=metadata,
            organization_id=str(tracker.organization_id),
        )
    except Exception:
        logger.warning(
            "[TrackerOfflineNotify] system notification failed for tracker %s",
            getattr(tracker, "id", None),
            exc_info=True,
        )


def notify_run_waiting_device(tracker_run, device_name: str) -> None:
    """Run 挂起等设备上线时通知（每个 Run 只在进入等待时发一次）。"""
    tracker = tracker_run.tracker
    from apps.tracker.constants import WAITING_DEVICE_TIMEOUT_SECONDS

    hours = WAITING_DEVICE_TIMEOUT_SECONDS // 3600
    _notify_owner(
        tracker,
        title=f"自动化任务「{tracker.name}」正在等待设备上线",
        body=(
            f"执行设备「{device_name}」当前不在线，本次执行已挂起等待，"
            f"设备上线后会自动继续（最长等 {hours} 小时）。"
        ),
        extra_meta={"run_id": str(tracker_run.id), "event": "waiting_device"},
    )


def notify_run_waiting_timeout(tracker_run, device_name: str) -> None:
    """等待超窗失败时通知。"""
    tracker = tracker_run.tracker
    from apps.tracker.constants import WAITING_DEVICE_TIMEOUT_SECONDS

    hours = WAITING_DEVICE_TIMEOUT_SECONDS // 3600
    _notify_owner(
        tracker,
        title=f"自动化任务「{tracker.name}」因设备持续离线未能执行",
        body=(
            f"等待设备「{device_name}」上线超过 {hours} 小时，本次执行已放弃。"
            "请检查该设备是否长期关机，或为执行 Agent 换绑一台常开设备。"
        ),
        extra_meta={"run_id": str(tracker_run.id), "event": "waiting_timeout"},
    )
