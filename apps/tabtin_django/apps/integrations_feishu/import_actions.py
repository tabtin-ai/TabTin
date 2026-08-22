"""飞书导入任务的单表跳过 / 取消（写入 job.result，供 runner 协作读取）。"""

from __future__ import annotations

from typing import Any, Dict, List, Set, Tuple

from django.db import transaction

from .models import FeishuImportJob


def table_key(app_token: str, table_id: str) -> str:
    return f"{app_token}:{table_id}"


def action_key_set(result: Dict[str, Any] | None, field: str) -> Set[str]:
    raw = (result or {}).get(field) or []
    if not isinstance(raw, list):
        return set()
    return {str(item) for item in raw if item}


def _append_unique_key(result: Dict[str, Any], field: str, key: str) -> None:
    existing = result.get(field)
    keys: List[str] = list(existing) if isinstance(existing, list) else []
    if key not in keys:
        keys.append(key)
    result[field] = keys


def _is_already_finished(result: Dict[str, Any], key: str) -> bool:
    for field in (
        "created_tables",
        "failed_tables",
        "skipped_tables",
        "cancelled_tables",
    ):
        rows = result.get(field) or []
        if not isinstance(rows, list):
            continue
        for row in rows:
            if not isinstance(row, dict):
                continue
            app_token = row.get("app_token") or ""
            table_id = row.get("table_id") or ""
            if table_key(str(app_token), str(table_id)) == key:
                return True
    return False


def mark_table_started(job: FeishuImportJob, app_token: str, table_id: str) -> None:
    """表开始 Phase A 前写入 started_keys，供 cancel 拒绝与重投递跳过。"""
    key = table_key(app_token, table_id)
    with transaction.atomic():
        locked = FeishuImportJob.objects.select_for_update().get(id=job.id)
        result = dict(locked.result or {})
        _append_unique_key(result, "started_keys", key)
        locked.result = result
        locked.save(update_fields=["result", "updated_at"])


def request_cancel_table(job: FeishuImportJob, app_token: str, table_id: str) -> Tuple[bool, str]:
    """将未开始的表标为取消。已开始 / 已完成则拒绝。"""
    key = table_key(app_token, table_id)
    if job.status not in (
        FeishuImportJob.Status.PENDING,
        FeishuImportJob.Status.RUNNING,
    ):
        return False, "任务已结束，无法取消"

    with transaction.atomic():
        locked = FeishuImportJob.objects.select_for_update().get(id=job.id)
        result = dict(locked.result or {})
        if _is_already_finished(result, key):
            return False, "该表已处理，无法取消"
        if key in action_key_set(result, "started_keys"):
            return False, "该表已开始导入，无法取消（可用跳过）"
        if key in action_key_set(result, "skipped_keys"):
            return False, "该表已跳过，无法取消"
        _append_unique_key(result, "cancelled_keys", key)
        locked.result = result
        locked.save(update_fields=["result", "updated_at"])
    return True, ""


def request_skip_table(job: FeishuImportJob, app_token: str, table_id: str) -> Tuple[bool, str]:
    """请求跳过当前正在导入的表（停止后续行写入）。"""
    key = table_key(app_token, table_id)
    if job.status not in (
        FeishuImportJob.Status.PENDING,
        FeishuImportJob.Status.RUNNING,
    ):
        return False, "任务已结束，无法跳过"

    with transaction.atomic():
        locked = FeishuImportJob.objects.select_for_update().get(id=job.id)
        result = dict(locked.result or {})
        if _is_already_finished(result, key):
            return False, "该表已处理，无法跳过"
        if key in action_key_set(result, "cancelled_keys"):
            return False, "该表已取消，无法跳过"
        _append_unique_key(result, "skipped_keys", key)
        locked.result = result
        locked.save(update_fields=["result", "updated_at"])
    return True, ""
