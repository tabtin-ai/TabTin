"""设备离线时的桌面通知（W13 D3）。

scheduler / 内部服务（``client_type='server'``）触发的对话如果遇到
control_device 离线，除了同步返回 ``error_category='device_offline'``
外，还要通过 ``NotificationService`` 异步推送桌面通知给 Agent owner，
让 owner 知道设备掉线、自己手动唤起客户端。

为什么只在 server 路径通知：
- 渠道侧（飞书/微信，``client_type='channel'``）的回执最终会回到外部用户，
  我们不希望把"设备离线"这种内部错误暴露给外部用户；
- 用户在 Electron 客户端（``client_type='electron'``）发消息却遇到自己设备
  "离线"的情况几乎不可能（消息发出本身就证明设备在线），无意义噪声。
"""

from __future__ import annotations

import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)


def _extract_tracker_label(app_context: Optional[dict]) -> str:
    """从 ``app_context`` 抽取 Tracker 名作为通知文案的细化补充。

    波次 4 Stage 2.4 一刀切：``goal_name`` → ``tracker_name``。
    没有 Tracker 上下文时返回空串，由调用方拼通用文案。
    """
    if not app_context:
        return ""
    tracker_name = str(app_context.get("tracker_name") or "").strip()
    if tracker_name:
        return f"Tracker \"{tracker_name}\""
    return ""


def notify_owner_device_offline(
    *,
    agent: Any,
    device: Any,
    device_name: str,
    context_label: str,
    app_context: Optional[dict] = None,
) -> None:
    """异步推送桌面通知；任何失败都吞掉，绝不影响主流程。

    若 ``app_context`` 里有 ``tracker_name``，会拼进文案；没有时退化为通用文案。
    """
    if agent is None:
        return

    user_id = str(getattr(agent, "user_id", "") or "").strip()
    if not user_id:
        logger.debug(
            "[remote_agent] notify_owner_device_offline skipped: agent=%s has no owner user",
            getattr(agent, "id", None),
        )
        return

    organization_id = str(getattr(agent, "organization_id", "") or "").strip()
    agent_name = (getattr(agent, "name", "") or "").strip() or "Agent"

    tracker_label = _extract_tracker_label(app_context)
    if tracker_label:
        title = f"{tracker_label} 失败：设备 \"{device_name}\" 不在线"
        body = (
            f"{context_label}尝试调用 {agent_name} 执行 {tracker_label}，"
            f"但其执行设备 \"{device_name}\" 当前不在线。"
            "请在该设备上启动 TabTin 客户端后重试。"
        )
    else:
        title = f"设备 \"{device_name}\" 不在线"
        body = (
            f"{context_label}尝试调用 {agent_name}，但其执行设备 \"{device_name}\" 当前不在线。"
            "请在该设备上启动 TabTin 客户端后重试。"
        )

    metadata = {
        "category": "device_offline",
        "priority": "high",
        "agent_id": str(getattr(agent, "id", "") or ""),
        "device_id": str(getattr(device, "id", "") or "") if device is not None else "",
        "device_name": device_name,
        "context_label": context_label,
    }
    if tracker_label:
        metadata["tracker_label"] = tracker_label
    if app_context:
        for key in ("tracker_id", "tracker_run_id"):
            value = app_context.get(key)
            if value:
                metadata[key] = str(value)

    try:
        from apps.services.notification.services.notification_service import (
            NotificationService,
        )

        NotificationService.notify(
            user_id=user_id,
            type="device_offline",
            title=title,
            body=body,
            metadata=metadata,
            organization_id=organization_id,
        )
    except Exception:
        logger.warning(
            "[remote_agent] notify_owner_device_offline failed (user=%s agent=%s)",
            user_id,
            getattr(agent, "id", None),
            exc_info=True,
        )


__all__ = ["notify_owner_device_offline"]
