"""Project Task Workbench 的统一资源投影。

合并最新 Run 的 result_items（candidate）与全部 ProjectTaskDeliverable，
按 (normalized_resource_type, resource_id) 去重，deliverable 优先。
"""

from __future__ import annotations

import logging
from typing import Any
from uuid import UUID

from apps.tabtinspace.models import (
    ContextItem,
    ProjectTask,
    ProjectTaskDeliverable,
    ProjectTaskRun,
    ResourceAccess,
)
from apps.tabtinspace.services.project_task_results import normalize_resource_type

logger = logging.getLogger(__name__)

_SUMMARY_KEYS = ('record_count', 'field_count', 'field_names')


def _isoformat(value) -> str | None:
    if value is None:
        return None
    if hasattr(value, 'isoformat'):
        return value.isoformat()
    return str(value)


def _safe_summary(metadata: Any) -> dict:
    if not isinstance(metadata, dict):
        return {}
    summary: dict[str, Any] = {}
    for key in _SUMMARY_KEYS:
        if key not in metadata:
            continue
        value = metadata[key]
        if key == 'field_names':
            if isinstance(value, list):
                names = [str(item) for item in value if isinstance(item, (str, int, float))]
                if names:
                    summary[key] = names
            continue
        if isinstance(value, bool):
            continue
        if isinstance(value, int):
            summary[key] = value
        elif isinstance(value, float) and value.is_integer():
            summary[key] = int(value)
    return summary


def _organization_id_of(item: ContextItem | None, *, task: ProjectTask) -> str:
    if item is not None:
        if item.organization_id:
            return str(item.organization_id)
        if item.workspace_id and getattr(item, 'workspace', None) is not None:
            org_id = getattr(item.workspace, 'organization_id', None)
            if org_id:
                return str(org_id)
        if item.project_id and getattr(item, 'project', None) is not None:
            org_id = getattr(item.project, 'organization_id', None)
            if org_id:
                return str(org_id)
    return str(task.project.organization_id)


def _belongs_to_task_organization(item: ContextItem | None, *, task: ProjectTask) -> bool:
    """拒绝把其他 Organization 的 ContextItem 混入当前 Task 投影。"""
    if item is None:
        return False
    expected = str(task.project.organization_id)
    if item.organization_id:
        return str(item.organization_id) == expected
    if item.workspace_id and getattr(item, 'workspace', None) is not None:
        return str(item.workspace.organization_id) == expected
    if item.project_id and getattr(item, 'project', None) is not None:
        return str(item.project.organization_id) == expected
    return False


def _resource_space_id(
    item: ContextItem | None,
    *,
    snapshot: dict | None,
    latest_run: ProjectTaskRun | None,
) -> str | None:
    if item is not None and item.space_id:
        return str(item.space_id)
    if isinstance(snapshot, dict):
        space_id = str(snapshot.get('resource_space_id') or '').strip()
        if space_id:
            return space_id
    if latest_run is not None and latest_run.workspace_id:
        return str(latest_run.workspace_id)
    return None


def _can_open_item(user, item: ContextItem | None) -> bool:
    if item is None:
        return False
    if item.is_archived or item.trashed_at is not None or item.status == 'trashed':
        return False
    from apps.tabtinspace.services.context_item_service import ContextItemService

    return bool(ContextItemService(user=user)._check_item_permission(item, 'viewer'))


def _batch_last_visited(user, context_item_ids: list[UUID]) -> dict[str, Any]:
    user_id = getattr(user, 'id', None)
    if not user_id or not context_item_ids:
        return {}
    try:
        return {
            str(row['context_item_id']): row['last_visited_at']
            for row in ResourceAccess.objects.filter(
                user_id=user_id,
                context_item_id__in=context_item_ids,
            ).values('context_item_id', 'last_visited_at')
        }
    except Exception as exc:
        logger.warning('[project_task_workbench_resources] last_visited query failed: %s', exc)
        return {}


def _identity_from_snapshot(item: dict) -> tuple[str, str] | None:
    resource_type = str(item.get('resource_type') or item.get('item_type') or '').strip()
    resource_id = str(item.get('resource_id') or '').strip()
    if not resource_type or not resource_id:
        return None
    return normalize_resource_type(resource_type), resource_id


def _identity_from_context_item(item: ContextItem) -> tuple[str, str] | None:
    resource_id = str(item.resource_id or '').strip()
    if not resource_id:
        return None
    return normalize_resource_type(item.item_type), resource_id


def _context_item_id_from_snapshot(snapshot: dict) -> str | None:
    for key in ('context_item_id', 'id'):
        value = snapshot.get(key)
        if value:
            return str(value)
    return None


def project_task_workbench_resources(
    *,
    task: ProjectTask,
    user,
    latest_run: ProjectTaskRun | None,
    is_responsible: bool,
) -> list[dict]:
    """投影当前 Task 对调用者可见的统一资源列表。"""
    deliverables = list(
        ProjectTaskDeliverable.objects.filter(task=task)
        .select_related(
            'context_item',
            'context_item__workspace',
            'context_item__project',
            'context_item__organization',
            'task_run',
        )
        .order_by('-created_at', 'id')
    )

    candidate_snapshots: list[dict] = []
    if is_responsible and latest_run is not None:
        for raw in latest_run.result_items or []:
            if isinstance(raw, dict) and _identity_from_snapshot(raw):
                candidate_snapshots.append(raw)

    context_item_ids: list[UUID] = []
    for deliverable in deliverables:
        context_item_ids.append(deliverable.context_item_id)
    for snapshot in candidate_snapshots:
        raw_id = _context_item_id_from_snapshot(snapshot)
        if not raw_id:
            continue
        try:
            context_item_ids.append(UUID(str(raw_id)))
        except (TypeError, ValueError):
            continue

    items_by_id = {
        str(item.id): item
        for item in ContextItem.objects.filter(id__in=context_item_ids).select_related(
            'workspace', 'project', 'organization',
        )
    }

    primary_identity: tuple[str, str] | None = None
    if latest_run is not None:
        for raw in latest_run.result_items or []:
            if isinstance(raw, dict):
                primary_identity = _identity_from_snapshot(raw)
                if primary_identity:
                    break

    merged: dict[tuple[str, str], dict] = {}

    # 先放 candidate，再被 deliverable 覆盖（deliverable 胜出）。
    if is_responsible and latest_run is not None:
        for snapshot in candidate_snapshots:
            identity = _identity_from_snapshot(snapshot)
            if identity is None:
                continue
            item_id = _context_item_id_from_snapshot(snapshot)
            item = items_by_id.get(item_id) if item_id else None
            # 无 ContextItem（缺 id 或库中不存在）：一律丢弃，保证 context_item_id 非空。
            if item is None:
                continue
            if not _belongs_to_task_organization(item, task=task):
                continue
            resource_type, resource_id = identity
            merged[identity] = {
                'context_item_id': str(item.id),
                'resource_type': resource_type,
                'resource_id': resource_id,
                'title': item.title or snapshot.get('title') or '未命名',
                'preview': item.preview or snapshot.get('preview') or '',
                'summary': _safe_summary(item.metadata),
                'organization_id': _organization_id_of(item, task=task),
                'resource_space_id': _resource_space_id(
                    item, snapshot=snapshot, latest_run=latest_run,
                ),
                'source': 'candidate',
                'task_run_id': str(latest_run.id),
                'is_primary': identity == primary_identity,
                'can_open': _can_open_item(user, item),
                'created_at': _isoformat(item.created_at),
                'updated_at': _isoformat(item.updated_at),
                '_context_item_id': item.id,
            }

    for deliverable in deliverables:
        item = deliverable.context_item
        if item is None or not _belongs_to_task_organization(item, task=task):
            continue
        identity = _identity_from_context_item(item)
        if identity is None:
            continue
        resource_type, resource_id = identity
        merged[identity] = {
            'context_item_id': str(item.id),
            'resource_type': resource_type,
            'resource_id': resource_id,
            'title': item.title or '未命名',
            'preview': item.preview or '',
            'summary': _safe_summary(item.metadata),
            'organization_id': _organization_id_of(item, task=task),
            'resource_space_id': _resource_space_id(
                item, snapshot=None, latest_run=latest_run,
            ),
            'source': 'deliverable',
            'task_run_id': str(deliverable.task_run_id),
            'is_primary': identity == primary_identity,
            'can_open': _can_open_item(user, item),
            'created_at': _isoformat(item.created_at or deliverable.created_at),
            'updated_at': _isoformat(item.updated_at or deliverable.created_at),
            '_context_item_id': item.id,
        }

    resources = list(merged.values())
    visited_map = _batch_last_visited(
        user,
        [row['_context_item_id'] for row in resources if row.get('_context_item_id')],
    )
    for row in resources:
        item_id = row.pop('_context_item_id', None)
        visited = visited_map.get(str(item_id)) if item_id else None
        row['last_visited_at'] = _isoformat(visited)
        if row.get('resource_space_id') is None:
            row.pop('resource_space_id', None)

    # 主产物优先，其余按 updated_at 新→旧。
    primary = [row for row in resources if row.get('is_primary')]
    others = [row for row in resources if not row.get('is_primary')]
    others.sort(
        key=lambda row: (row.get('updated_at') or '', row.get('resource_id') or ''),
        reverse=True,
    )
    return primary + others


__all__ = ['project_task_workbench_resources']
