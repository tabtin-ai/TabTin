"""Tracker WebSocket 进度推送（Module F 决策 3：Space 边界版）。

- 主 topic 统一 ``tracker.events.{space_id}``（修复前是 organization_id，会让同
  organization 不同 Space 的成员互相收到对方 Tracker 的 progress_message /
  error_summary，违反 Space 默认私有原则；详见 Module F 复盘 §决策 3）。
- payload key 统一 ``tracker_id``。
- event type 统一 ``tracker.*``。
- notify_trigger_filtered 与 instance 推送共用同一 fallback 路径。
"""

from __future__ import annotations

import json
import logging
import time
from typing import Optional

from apps.services.common.agent_protocol.constants import TrackerEvent
from apps.services.common.ws.bus import publish_ws_event
from apps.services.common.ws.protocol import build_envelope, new_event_id

logger = logging.getLogger(__name__)

FILTERED_CACHE_MAX = 20
FILTERED_CACHE_TTL = 86400  # 24h


# Wave 6 续作 (charter §4.4 / plan §Phase 6 验收 #1) ──────────────────────────
# envelope payload 辅助函数:从 TrackerRun.context 提取产物定位 / 恢复动作。
#
# charter §4.4 "看产物 1 步可达"要求 envelope 必须能让前端定位**具体**产物(不是
# 跳到 app 主面板让用户自己找)。Wave 6 主实施漏掉了 envelope 透传这一步;
# 续作补上。

# 已知产物定位字段(扁平 list,从 ``TrackerRun.context["agent_result"]`` 浅查找)。
_ARTIFACT_REF_FIELDS = (
    "artifact_id",
    "memo_id",
    "record_ids",
    "doc_id",
    "slide_id",
    "code_path",
)

# snake_case → camelCase 转换表(让前端 ArtifactRef 类型用 camelCase)。
_ARTIFACT_REF_CASE_MAP = {
    "artifact_id": "artifactId",
    "memo_id": "memoId",
    "record_ids": "recordIds",
    "doc_id": "docId",
    "slide_id": "slideId",
    "code_path": "codePath",
}


def _extract_artifact_ref(gr) -> Optional[dict]:
    """从 TrackerRun.context["agent_result"] 提取产物定位字段。

    返回 None → envelope 不携带 artifact_ref(前端走主面板兜底)。
    返回 dict → envelope payload.artifact_ref = {camelCaseKey: value, ...}。
    """
    try:
        ctx = getattr(gr, "context", None) or {}
    except Exception:
        return None
    if not isinstance(ctx, dict):
        return None

    sources: list[dict] = []
    agent_result = ctx.get("agent_result")
    if isinstance(agent_result, dict):
        sources.append(agent_result)
    sources.append(ctx)

    out: dict = {}
    for src in sources:
        for snake_key in _ARTIFACT_REF_FIELDS:
            if snake_key in src and src[snake_key] not in (None, "", []):
                camel_key = _ARTIFACT_REF_CASE_MAP[snake_key]
                if camel_key not in out:
                    out[camel_key] = src[snake_key]
    return out or None


def _extract_recovery_actions(gr) -> list[dict]:
    """从 TrackerRun.context["recovery_actions"] 提取结构化恢复动作。"""
    try:
        ctx = getattr(gr, "context", None) or {}
    except Exception:
        return []
    if not isinstance(ctx, dict):
        return []
    actions = ctx.get("recovery_actions")
    if not isinstance(actions, list):
        return []
    cleaned: list[dict] = []
    for it in actions:
        if not isinstance(it, dict):
            continue
        kind = it.get("kind")
        label = it.get("label")
        if not kind or not label:
            continue
        out_item = {"kind": str(kind), "label": str(label)}
        if "model" in it and it["model"]:
            out_item["model"] = str(it["model"])
        cleaned.append(out_item)
    return cleaned


def _publish_single_topic_with_buffer(topic: str, envelope: dict) -> bool:
    """单 topic 推送 + EventBuffer 失败补偿（resume 回放可恢复）。

    Module F 决策 3：topic 由 caller 传入，统一格式 ``tracker.events.{space_id}``。
    波次 4 Stage 2.3 已下线 legacy ``goal.events`` / ``agenda.events`` 兼容期三推。
    """
    ok = publish_ws_event(topic, envelope)
    if not ok:
        logger.warning(
            "[TrackerNotification] WS publish failed, writing to event buffer: topic=%s type=%s",
            topic, envelope.get("type"),
        )
        try:
            from apps.services.common.ws.event_buffer import get_event_buffer
            buf = get_event_buffer()
            buf.append_event(topic, envelope)
        except Exception as buf_exc:
            logger.error(
                "[TrackerNotification] EventBuffer fallback also failed: %s", buf_exc,
            )
    return ok


class TrackerNotificationService:

    # 主 topic 唯一定义点（前端 useTrackerEventStream 订阅）。
    # Module F 决策 3：Space 边界——每个 Space 一条独立 topic，避免跨 Space 数据泄漏。
    TRACKER_TOPIC_PREFIX = "tracker.events"

    def __init__(self, tracker_run):
        self.tracker_run = tracker_run
        self.organization_id = str(tracker_run.tracker.organization_id)
        # space_id 是 Tracker 的强约束（charter v1.8 §7.1：当前必须绑 Space）；
        # 若意外为空 → 回退到 organization topic 兜底（不丢消息），但日志告警。
        space_id = tracker_run.tracker.workspace_id
        if space_id:
            self.tracker_topic = f"{self.TRACKER_TOPIC_PREFIX}.{space_id}"
        else:
            logger.warning(
                "[TrackerNotification] tracker %s has no space_id, falling back to organization topic",
                tracker_run.tracker_id,
            )
            self.tracker_topic = f"{self.TRACKER_TOPIC_PREFIX}.{self.organization_id}"

    def _publish_with_fallback(self, envelope: dict) -> bool:
        return _publish_single_topic_with_buffer(self.tracker_topic, envelope)

    def notify_progress(self, tracker_run=None):
        gr = tracker_run or self.tracker_run
        payload = {
            "tracker_id": str(gr.tracker_id),
            "run_id": str(gr.id),
            "progress": gr.progress,
            "progress_message": getattr(gr, "progress_message", "") or "",
            "status": gr.status,
            "space_id": str(gr.tracker.workspace_id) if gr.tracker.workspace_id else None,
            "tokens_used": getattr(gr, "tokens_used", 0) or 0,
            "current_cycle": getattr(gr, "current_cycle", 1),
            "max_cycles": getattr(gr, "max_cycles", 3),
        }
        envelope = build_envelope(
            TrackerEvent.PROGRESS,
            new_event_id(),
            payload,
        )
        self._publish_with_fallback(envelope)

    def notify_run_completed(self, tracker_run=None):
        gr = tracker_run or self.tracker_run
        # Wave 6 (charter §4.4):携带 skill_key + artifact_ref，前端按 skill→app
        # 映射决定"看产物"按钮跳转目标 app（notificationTargetResolver / Bell 双按钮）。
        envelope = build_envelope(
            TrackerEvent.RUN_COMPLETED,
            new_event_id(),
            {
                "tracker_id": str(gr.tracker_id),
                "run_id": str(gr.id),
                "status": gr.status,
                "space_id": str(gr.tracker.workspace_id) if gr.tracker.workspace_id else None,
                "duration": gr.duration,
                "skill_key": getattr(gr.tracker, "skill_key", None),
                "artifact_ref": _extract_artifact_ref(gr),
            },
            organization_id=self.organization_id,
        )
        self._publish_with_fallback(envelope)
        self._persist_agent_task_notification(gr, success=True)

    def _persist_agent_task_notification(self, gr, *, success: bool) -> None:
        """落库通知中心记录，供跨重启点击跳转（与 WS 推送并行）。"""
        try:
            from apps.services.notification.services.agent_task_notification import (
                notify_tracker_run_terminal,
            )

            tracker_name = getattr(gr.tracker, "name", "") or "自动化任务"
            if success:
                title = f"自动化任务「{tracker_name}」已完成"
                body = getattr(gr, "progress_message", "") or "任务执行完成"
            else:
                title = f"自动化任务「{tracker_name}」执行失败"
                body = getattr(gr, "error_summary", "") or "任务执行失败"
            notify_tracker_run_terminal(
                tracker_run=gr,
                success=success,
                title=title,
                body=str(body)[:200],
            )
        except Exception:
            logger.debug(
                "[TrackerNotification] persist notification failed run=%s",
                getattr(gr, "id", None),
                exc_info=True,
            )

    def notify_health_alert(self, tracker, alert_type: str, details: dict):
        """推送周期性 Tracker 健康巡检警告。"""
        envelope = build_envelope(
            TrackerEvent.HEALTH_ALERT,
            new_event_id(),
            {
                "tracker_id": str(tracker.id),
                "alert_type": alert_type,
                "space_id": str(tracker.workspace_id) if tracker.workspace_id else None,
                **details,
            },
        )
        self._publish_with_fallback(envelope)

    def notify_run_failed(self, tracker_run=None):
        gr = tracker_run or self.tracker_run
        envelope = build_envelope(
            TrackerEvent.RUN_FAILED,
            new_event_id(),
            {
                "tracker_id": str(gr.tracker_id),
                "run_id": str(gr.id),
                "status": gr.status,
                "error_summary": gr.error_summary or "",
                "space_id": str(gr.tracker.workspace_id) if gr.tracker.workspace_id else None,
                "duration": gr.duration,
                "skill_key": getattr(gr.tracker, "skill_key", None),
                "recovery_actions": _extract_recovery_actions(gr),
            },
            organization_id=self.organization_id,
        )
        self._publish_with_fallback(envelope)
        self._persist_agent_task_notification(gr, success=False)

    def notify_run_cancelled(self, tracker_run=None):
        """Module F：用户主动 cancel_run 走独立事件，与 RUN_FAILED 区分语义。

        与 RUN_FAILED 的差异：
          - event type 不同，前端可按"用户主动取消"分支处理（不弹"失败"红色通知）
          - 不带 error_summary / recovery_actions（用户已知情，无需"恢复建议"）
        """
        gr = tracker_run or self.tracker_run
        envelope = build_envelope(
            TrackerEvent.RUN_CANCELLED,
            new_event_id(),
            {
                "tracker_id": str(gr.tracker_id),
                "run_id": str(gr.id),
                "status": gr.status,
                "space_id": str(gr.tracker.workspace_id) if gr.tracker.workspace_id else None,
                "duration": gr.duration,
            },
            organization_id=self.organization_id,
        )
        self._publish_with_fallback(envelope)


def notify_trigger_filtered(
    organization_id: str,
    tracker_id: str,
    event_type: str,
    reason: str = "conditions_not_met",
    event_label: str = "",
    space_id: str | None = None,
) -> None:
    """记录并推送"事件已接收但条件不匹配"的反馈。

    波次 4 Stage 2.3：与 instance 推送共用 ``_publish_single_topic_with_buffer``
    （review B6），单 topic + EventBuffer 失败补偿，行为对齐。
    """
    from django.core.cache import cache

    ts = time.time()
    entry = {
        "tracker_id": tracker_id,
        "event_type": event_type,
        "event_label": event_label,
        "reason": reason,
        "ts": ts,
    }

    cache_key = f"tracker:filtered:{tracker_id}"
    try:
        redis_client = getattr(cache, 'client', None)
        raw_client = getattr(redis_client, 'get_client', None)
        if raw_client:
            client = raw_client()
            pipe = client.pipeline()
            pipe.rpush(cache_key, json.dumps(entry))
            pipe.ltrim(cache_key, -FILTERED_CACHE_MAX, -1)
            pipe.expire(cache_key, FILTERED_CACHE_TTL)
            pipe.execute()
        else:
            raw = cache.get(cache_key) or "[]"
            entries = json.loads(raw) if isinstance(raw, str) else (raw if isinstance(raw, list) else [])
            entries.append(entry)
            entries = entries[-FILTERED_CACHE_MAX:]
            cache.set(cache_key, json.dumps(entries), timeout=FILTERED_CACHE_TTL)
    except Exception:
        logger.debug("[TrackerNotification] cache write failed for filtered event", exc_info=True)

    try:
        # Module F 决策 3：按 Space 边界发推；缺 space_id 时回退到 organization topic
        # 兜底（不丢消息，但日志告警，方便排查上游漏传 space_id 的 caller）。
        if space_id:
            topic = f"{TrackerNotificationService.TRACKER_TOPIC_PREFIX}.{space_id}"
        else:
            logger.warning(
                "[TrackerNotification] notify_trigger_filtered called without space_id "
                "(tracker_id=%s), falling back to organization topic",
                tracker_id,
            )
            topic = f"{TrackerNotificationService.TRACKER_TOPIC_PREFIX}.{organization_id}"
        envelope = build_envelope(
            TrackerEvent.TRIGGER_FILTERED,
            new_event_id(),
            {
                "tracker_id": tracker_id,
                "event_type": event_type,
                "event_label": event_label,
                "reason": reason,
                "space_id": space_id,
            },
        )
        _publish_single_topic_with_buffer(topic, envelope)
    except Exception:
        logger.debug("[TrackerNotification] ws publish failed for filtered event", exc_info=True)


def get_filtered_events(tracker_id: str) -> list[dict]:
    """从 cache 返回最近的被过滤事件列表。支持 Redis list 和 JSON 字符串两种格式。"""
    from django.core.cache import cache

    cache_key = f"tracker:filtered:{tracker_id}"
    try:
        redis_client = getattr(cache, 'client', None)
        raw_client = getattr(redis_client, 'get_client', None)
        if raw_client:
            client = raw_client()
            raw_entries = client.lrange(cache_key, 0, -1)
            if not raw_entries:
                return []
            entries = []
            for raw in raw_entries:
                try:
                    item = raw if isinstance(raw, dict) else json.loads(raw)
                    entries.append(item)
                except (json.JSONDecodeError, TypeError):
                    continue
            return entries
        else:
            raw = cache.get(cache_key)
            if not raw:
                return []
            entries = json.loads(raw) if isinstance(raw, str) else (raw if isinstance(raw, list) else [])
            return entries
    except Exception:
        return []
