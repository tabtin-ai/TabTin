"""
Tracker Celery 任务：残留 execute_tracker 只回 deferred_to_host。
cron/interval/at 由本机 agent-host 持钟；云不再扫到期、回收、重投或巡检发令。

2026-05-28 收编：ScheduledJob.table_automation 子系统已整体下线，并入
Tracker.trigger_type='table_event'；原来的 scan_due_scheduler_jobs /
execute_scheduled_job / recover_stuck_scheduler_jobs / process_table_event +
_emit_table_event_to_eventbus 全部删除。TabData 写入链路改为直接走 EventBus
（tabdata.record.*），由 apps/extensions/consumers.py:_on_event_for_tracker
转发到 tracker_trigger_service.trigger_by_table_event。
"""

from __future__ import annotations

import logging
from apps.services.common.db_router import postgres_app_db_alias
from celery import shared_task
from django.conf import settings
logger = logging.getLogger(__name__)

def _tracker_run_observability_context(task, *, error_code: str = "") -> dict:
    request = getattr(task, "request", None)
    delivery_info = getattr(request, "delivery_info", None) or {}
    task_id = str(getattr(request, "id", "") or "")
    configured_queue_name = str(getattr(settings, "TRACKER_AGENT_QUEUE", "tracker_agent") or "tracker_agent")
    queue_name = str(
        delivery_info.get("routing_key")
        or delivery_info.get("queue")
        or configured_queue_name
    )

    context = {
        "_celery_task_id": task_id,
        "task_id": task_id,
        "trace_id": task_id,
        "queue_name": queue_name,
        "consumer_queue_name": queue_name,
        "configured_queue_name": configured_queue_name,
    }
    if error_code:
        context["error_code"] = error_code
    return context


def _tracker_queue_mismatch(context: dict) -> bool:
    configured_queue_name = str(context.get("configured_queue_name") or "")
    consumer_queue_name = str(context.get("consumer_queue_name") or context.get("queue_name") or "")
    if not configured_queue_name or configured_queue_name == "tracker_agent":
        return False
    return bool(consumer_queue_name and consumer_queue_name != configured_queue_name)


def _fail_tracker_run_for_queue_mismatch(tracker_run_id: str, context: dict) -> None:
    configured_queue_name = str(context.get("configured_queue_name") or "")
    consumer_queue_name = str(context.get("consumer_queue_name") or context.get("queue_name") or "")
    error = (
        "Tracker 执行队列配置不一致：本机配置队列为 "
        f"{configured_queue_name}，但任务从 {consumer_queue_name} 队列被消费。"
        " 已阻止执行，避免误报设备不可达；请清理旧 tracker_agent 队列残留并重启 Tracker worker。"
    )
    try:
        from apps.tracker.models import TrackerRun
        from apps.tracker.services.tracker_executor import _fail_tracker_run

        tracker_run = (
            TrackerRun.objects.select_related("tracker")
            .filter(id=tracker_run_id)
            .first()
        )
        if not tracker_run:
            return
        _fail_tracker_run(
            tracker_run,
            error,
            error_category="queue_mismatch",
        )
    except Exception:
        logger.warning(
            "[Tracker] failed to mark queue mismatch for run=%s configured=%s consumer=%s",
            tracker_run_id,
            configured_queue_name,
            consumer_queue_name,
            exc_info=True,
        )


def _merge_tracker_run_context(tracker_run_id: str, patch: dict) -> None:
    from apps.tracker.models import TrackerRun

    tracker_run = TrackerRun.objects.filter(id=tracker_run_id).first()
    if not tracker_run:
        return

    context = tracker_run.context or {}
    for key, value in patch.items():
        if not value:
            continue
        if key == "trace_id" and context.get("trace_id"):
            continue
        context[key] = value
    TrackerRun.objects.filter(id=tracker_run_id).update(context=context)


@shared_task(
    bind=True,
    max_retries=0,
    soft_time_limit=35 * 60,
    time_limit=36 * 60,
)
def execute_tracker(self, tracker_run_id: str) -> dict:
    """已退役：执行队列在本机 agent-host。残留消息只记账，不在云上开跑。"""
    logger.info(
        "[Tracker] execute_tracker retired; host owns the queue run=%s",
        tracker_run_id,
    )
    return {
        "status": "deferred_to_host",
        "tracker_run_id": tracker_run_id,
    }


# Wave 2 (charter v1.8 §6.4)：删除 _expire_stale_checkpoints / expire_stale_checkpoints —
# step-level checkpoint 已废弃，CheckpointService 与 step run 模型已删除。
# Beat 调度表移除该 task 的注册（详见本文件底部 ``CELERYBEAT_SCHEDULE`` 段）。


@shared_task(bind=True, max_retries=0, ignore_result=True, time_limit=300, soft_time_limit=270)
def tracker_health_check(self) -> dict:
    """残留巡检入口：云不再周期扫库发告警，函数仅消化旧 Beat 消息。

    扫描 trigger_type=cron/interval 且 status=active 的 Tracker，连续失败时推警告。

    Wave 2 (charter v1.8 §6.4)：归因分析改为基于 TrackerRun.error_summary 的语义识别——
    多步骤 step 已删除，无法再细化到 step 级。
    """
    from apps.tracker.models import Tracker, TrackerRun
    from apps.tracker.services.tracker_notification import TrackerNotificationService

    CONSECUTIVE_FAIL_THRESHOLD = 3
    trackers = Tracker.objects.filter(
        status="active",
        trigger_type__in=("cron", "interval"),
    )

    alerts_sent = 0
    for tracker in trackers:
        recent_runs = list(
            TrackerRun.objects.filter(tracker=tracker)
            .order_by("-created_at")[:CONSECUTIVE_FAIL_THRESHOLD]
        )
        if len(recent_runs) < CONSECUTIVE_FAIL_THRESHOLD:
            continue

        all_failed = all(r.status == "failed" for r in recent_runs)
        if all_failed:
            latest_run = recent_runs[0]
            root_cause = _analyze_failure_root_cause(latest_run)

            from django.db import transaction as db_tx
            try:
                with db_tx.atomic(using=postgres_app_db_alias()):
                    tracker = Tracker.objects.select_for_update().get(id=tracker.id)
                    if tracker.status != "active":
                        continue
                    tracker.transition_status("paused")
                    tc = tracker.trigger_config or {}
                    tc["_health_alert"] = "consecutive_failures"
                    tc["_health_alert_count"] = CONSECUTIVE_FAIL_THRESHOLD
                    tc["_health_root_cause"] = root_cause
                    tracker.trigger_config = tc
                    tracker.save(update_fields=["status", "trigger_config"])
            except Tracker.DoesNotExist:
                continue

            alert_details = {
                "fail_count": CONSECUTIVE_FAIL_THRESHOLD,
                "last_error": latest_run.error_summary or "",
                "paused": True,
                **root_cause,
            }

            try:
                notifier = TrackerNotificationService(latest_run)
                notifier.notify_health_alert(tracker, "consecutive_failures", alert_details)
                alerts_sent += 1
            except Exception:
                logger.debug("[Tracker] health alert send failed for %s", tracker.id, exc_info=True)

            _send_health_webhook(tracker, "consecutive_failures", latest_run, root_cause)

    if alerts_sent > 0:
        logger.info("[Tracker] health_check: %d alerts sent", alerts_sent)
    return {"alerts_sent": alerts_sent}


def _analyze_failure_root_cause(tracker_run) -> dict:
    """分析 TrackerRun 失败的根因：基于 ``error_summary`` 文本归类。

    Wave 2：移除 step 级归因（charter v1.8 §6.4 单 Skill 模型，不再有 step）。
    """
    result = {
        "error_category": "unknown",
        "suggested_fix": "",
    }

    error_msg = (getattr(tracker_run, "error_summary", "") or "").lower()
    if not error_msg:
        return result

    if "daemon" in error_msg or "未连接" in error_msg:
        result["error_category"] = "daemon_disconnected"
        result["suggested_fix"] = "请检查 Daemon 是否已启动并连接。"
    elif "timeout" in error_msg or "超时" in error_msg:
        result["error_category"] = "timeout"
        result["suggested_fix"] = "执行超时，可尝试增加超时时间或简化任务指令。"
    elif "rate_limit" in error_msg or "429" in error_msg:
        result["error_category"] = "rate_limit"
        result["suggested_fix"] = "API 调用频率超限，建议增加触发间隔或升级 API 配额。"
    elif "permission" in error_msg or "forbidden" in error_msg or "403" in error_msg:
        result["error_category"] = "permission"
        result["suggested_fix"] = "权限不足，请检查相关资源的访问权限设置。"
    elif "not found" in error_msg or "404" in error_msg or "不存在" in error_msg:
        result["error_category"] = "resource_not_found"
        result["suggested_fix"] = "目标资源不存在，请确认资源 ID 是否正确。"
    else:
        result["error_category"] = "execution_error"
        result["suggested_fix"] = "执行出错，请检查 Tracker 指令和 Skill 参数配置。"

    return result


def _send_health_webhook(tracker, alert_type: str, latest_run=None, root_cause=None) -> None:
    """发送健康警告到用户配置的 webhook URL，支持通用/飞书/钉钉格式。"""
    from apps.services.common.url_security import ssrf_safe_request

    tc = tracker.trigger_config or {}
    webhook_url = tc.get("health_webhook_url")
    webhook_format = tc.get("health_webhook_format", "generic")
    if not webhook_url:
        return

    root_cause = root_cause or {}

    try:
        if webhook_format == "feishu":
            payload = _build_feishu_webhook_payload(tracker, alert_type, latest_run, root_cause)
        elif webhook_format == "dingtalk":
            payload = _build_dingtalk_webhook_payload(tracker, alert_type, latest_run, root_cause)
        else:
            payload = _build_generic_webhook_payload(tracker, alert_type, latest_run, root_cause)

        ssrf_safe_request("POST", webhook_url, json=payload, timeout=10)
    except Exception:
        logger.debug("[Tracker] health webhook failed for %s", tracker.id, exc_info=True)


def _build_generic_webhook_payload(tracker, alert_type, latest_run, root_cause):
    return {
        "tracker_id": str(tracker.id),
        "tracker_name": tracker.name,
        "alert_type": alert_type,
        "last_error": latest_run.error_summary if latest_run else "",
        "root_cause": root_cause,
    }


def _build_feishu_webhook_payload(tracker, alert_type, latest_run, root_cause):
    """飞书机器人 webhook 格式。

    Wave 2 续作 (charter v1.8 §6.4)：移除 ``failed_step_name`` / ``failed_step_capability``
    分支——单 Skill 执行模型下不再有「步骤」概念，``_analyze_failure_root_cause``
    已不再产生这两个 key（详见上方该函数的 Wave 2 注释）。
    """
    lines = [
        f"**Tracker 健康警告** 🚨",
        f"**名称**: {tracker.name}",
        f"**类型**: {alert_type}",
    ]
    if root_cause.get("error_category"):
        lines.append(f"**错误类型**: {root_cause['error_category']}")
    if root_cause.get("suggested_fix"):
        lines.append(f"**建议修复**: {root_cause['suggested_fix']}")
    if latest_run and latest_run.error_summary:
        lines.append(f"**错误详情**: {latest_run.error_summary[:200]}")

    return {
        "msg_type": "interactive",
        "card": {
            "header": {
                "title": {"tag": "plain_text", "content": "TabTin Tracker 健康警告"},
                "template": "red",
            },
            "elements": [
                {"tag": "markdown", "content": "\n".join(lines)},
            ],
        },
    }


def _build_dingtalk_webhook_payload(tracker, alert_type, latest_run, root_cause):
    """钉钉机器人 webhook 格式。

    Wave 2 续作 (charter v1.8 §6.4)：移除 ``failed_step_name`` 分支——
    单 Skill 执行模型下不再有「步骤」概念。
    """
    lines = [
        f"### Tracker 健康警告 🚨",
        f"- **名称**: {tracker.name}",
        f"- **类型**: {alert_type}",
    ]
    if root_cause.get("suggested_fix"):
        lines.append(f"- **建议修复**: {root_cause['suggested_fix']}")
    if latest_run and latest_run.error_summary:
        lines.append(f"- **错误**: {latest_run.error_summary[:200]}")

    return {
        "msgtype": "markdown",
        "markdown": {
            "title": "TabTin Tracker 健康警告",
            "text": "\n".join(lines),
        },
    }


# Tracker 模块收敛波次 1（2026-05-20）：删除 scan_agenda_reminders Celery 任务 +
# _compute_occurrences + _deliver_reminder 辅助函数 —— tabagenda 模块已下线，
# 日历提醒能力未来独立立项重做。Beat 注册同步移除。


# 2026-05-28 收编：原 SCHEDULER_BEAT_SCHEDULE 改名 TRACKER_BEAT_SCHEDULE，
# scan-due-scheduler-jobs / recover-stuck-scheduler-jobs 两个 ScheduledJob 调度
# 项随子系统下线一并移除（同步更新 tabtin/celery.py 的 BEAT attr 引用）。
TRACKER_BEAT_SCHEDULE = {}
