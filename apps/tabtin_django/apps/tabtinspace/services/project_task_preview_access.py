"""Project Task 完成前候选文档的只读预览授权。

#7261：只要任务**未完成**且候选 TabDoc 在 ``result_items`` 里，同 Project 的
有效成员即可以 viewer 打开正文；不改变归属、不等于发布。任务完成（走 Project
资产权限）或被取消后，此兜底授权自动失效。

``result_visibility`` 是历史兼容字段，不影响成员打开候选文档正文。
"""

from __future__ import annotations

from typing import Any

from django.db import connection

from apps.tabtinspace.models import ProjectMembership, ProjectTask, ProjectTaskRun

# 未完成（可预览）工作态：任务尚未 DONE / CANCELLED 时，候选产物对成员开放只读。
PREVIEWABLE_WORK_STATUSES = (
    ProjectTask.WorkStatus.TODO,
    ProjectTask.WorkStatus.IN_PROGRESS,
    ProjectTask.WorkStatus.IN_REVIEW,
    ProjectTask.WorkStatus.BLOCKED,
)

# 向后兼容旧引用名。
_PREVIEWABLE_WORK_STATUSES = PREVIEWABLE_WORK_STATUSES

_DOC_RESOURCE_TYPES = frozenset({'tabdoc', 'doc', 'document'})


def _item_matches_document(item: Any, document_id: str) -> bool:
    if not isinstance(item, dict):
        return False
    if str(item.get('resource_id') or '') != document_id:
        return False
    resource_type = str(
        item.get('resource_type') or item.get('item_type') or '',
    ).lower()
    # 历史条目偶发缺类型；有类型时必须是文档。
    return not resource_type or resource_type in _DOC_RESOURCE_TYPES


def _run_ids_containing_document(document_id: str) -> list:
    # ：只按「任务未完成」筛选候选 Run，不再要求 result_visibility=project_preview。
    base = ProjectTaskRun.objects.filter(
        task__work_status__in=PREVIEWABLE_WORK_STATUSES,
    )
    if connection.vendor == 'postgresql':
        return list(
            base.filter(result_items__contains=[{'resource_id': document_id}])
            .values_list('id', flat=True)[:50]
        )

    matched: list = []
    for run_id, items in base.values_list('id', 'result_items').iterator(chunk_size=100):
        if not isinstance(items, list):
            continue
        if any(_item_matches_document(item, document_id) for item in items):
            matched.append(run_id)
            if len(matched) >= 50:
                break
    return matched


def user_can_preview_project_task_document(user: Any, document: Any) -> bool:
    """Project 有效成员是否可只读预览该文档（完成前候选， 不再看可见性开关）。"""
    if not user or not getattr(user, 'id', None):
        return False
    document_id = str(getattr(document, 'id', '') or '')
    if not document_id:
        return False

    run_ids = _run_ids_containing_document(document_id)
    if not run_ids:
        return False

    # PostgreSQL jsonb @> 只保证 resource_id 命中；再校验文档类型，避免误放行表格。
    project_ids: list = []
    for run_id, project_id, items in (
        ProjectTaskRun.objects.filter(id__in=run_ids)
        .values_list('id', 'task__project_id', 'result_items')
    ):
        del run_id
        if not isinstance(items, list):
            continue
        if any(_item_matches_document(item, document_id) for item in items):
            project_ids.append(project_id)

    if not project_ids:
        return False

    return ProjectMembership.objects.filter(
        project_id__in=project_ids,
        user_id=user.id,
        is_active=True,
        status=ProjectMembership.Status.ACTIVE,
    ).exists()


__all__ = [
    'PREVIEWABLE_WORK_STATUSES',
    'user_can_preview_project_task_document',
]
