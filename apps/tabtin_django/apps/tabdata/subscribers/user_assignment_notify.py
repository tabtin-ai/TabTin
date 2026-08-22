"""UserAssignmentNotifySubscriber — 成员/用户字段新增指派时发站内通知。

产品语义：在表格「成员」字段里勾选/@ 某人后，被新增的成员应收到铃铛通知。
只通知「相对 before 新增」的 user_id，排除操作者本人；失败不阻断主写路径。
"""
from __future__ import annotations

import logging
from typing import Any, Dict, Iterable, List, Optional, Set
from uuid import UUID

from apps.tabdata.domain.events import (
    DomainEventBase,
    RecordCreated,
    RecordUpdated,
    RecordsBatchCreated,
    RecordsBatchUpdated,
)
from apps.tabdata.domain.ports import IEventSubscriber
from apps.tabdata.subscribers._utils import run_after_commit

logger = logging.getLogger(__name__)

NOTIFY_TYPE = "tabdata.record.user_assigned"


def extract_user_ids_from_field_value(value: Any) -> Set[str]:
    """兼容 user 字段的多种落库形态：str / {id} / [{id}] / [str]。"""
    if value is None:
        return set()

    items: Iterable[Any]
    if isinstance(value, list):
        items = value
    else:
        items = (value,)

    ids: Set[str] = set()
    for item in items:
        if isinstance(item, str):
            uid = item.strip()
            if uid:
                ids.add(uid)
            continue
        if isinstance(item, dict):
            raw = item.get("id") or item.get("user_id")
            if raw is None:
                continue
            uid = str(raw).strip()
            if uid:
                ids.add(uid)
    return ids


class UserAssignmentNotifySubscriber(IEventSubscriber):
    def handles(self) -> List[type]:
        return [
            RecordCreated,
            RecordUpdated,
            RecordsBatchCreated,
            RecordsBatchUpdated,
        ]

    def priority(self) -> int:
        return 210

    def handle(self, event: DomainEventBase) -> None:
        try:
            if isinstance(event, RecordCreated):
                self._schedule_for_record(
                    table_id=event.table_id,
                    record_id=event.record_id,
                    before={},
                    after=event.after or event.data or {},
                    actor_id=event.triggered_by,
                    changed_field_ids=None,
                )
            elif isinstance(event, RecordUpdated):
                self._schedule_for_record(
                    table_id=event.table_id,
                    record_id=event.record_id,
                    before=event.before or {},
                    after=event.after or {},
                    actor_id=event.triggered_by,
                    changed_field_ids=set(event.changed_field_ids or ()),
                )
            elif isinstance(event, RecordsBatchCreated):
                for payload in event.records:
                    self._schedule_for_record(
                        table_id=event.table_id,
                        record_id=payload.record_id,
                        before={},
                        after=payload.after or payload.data or {},
                        actor_id=event.triggered_by,
                        changed_field_ids=None,
                    )
            elif isinstance(event, RecordsBatchUpdated):
                for payload in event.records:
                    changed = set(payload.changes.keys()) if payload.changes else None
                    self._schedule_for_record(
                        table_id=event.table_id,
                        record_id=payload.record_id,
                        before=payload.before or {},
                        after=payload.after or {},
                        actor_id=event.triggered_by,
                        changed_field_ids=changed,
                    )
        except Exception:
            logger.error(
                "[UserAssignmentNotifySubscriber] failed: event=%s",
                type(event).__name__,
                exc_info=True,
            )

    def _schedule_for_record(
        self,
        *,
        table_id: UUID,
        record_id: UUID,
        before: Dict[str, Any],
        after: Dict[str, Any],
        actor_id: Optional[str],
        changed_field_ids: Optional[Set[str]],
    ) -> None:
        # 在 after_commit 里再查字段元数据，避免订阅路径拖长写事务
        def _push() -> None:
            try:
                self._notify_new_assignees(
                    table_id=table_id,
                    record_id=record_id,
                    before=before,
                    after=after,
                    actor_id=actor_id,
                    changed_field_ids=changed_field_ids,
                )
            except Exception:
                logger.warning(
                    "[UserAssignmentNotifySubscriber] notify failed table=%s record=%s",
                    table_id,
                    record_id,
                    exc_info=True,
                )

        run_after_commit(_push)

    def _notify_new_assignees(
        self,
        *,
        table_id: UUID,
        record_id: UUID,
        before: Dict[str, Any],
        after: Dict[str, Any],
        actor_id: Optional[str],
        changed_field_ids: Optional[Set[str]],
    ) -> None:
        from apps.tabdata.constants import TABDATA_DB_ALIAS
        from apps.tabdata.models import Table, TableField
        from apps.services.notification.services.notification_service import NotificationService

        user_fields = list(
            TableField.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=table_id,
                field_type="user",
                is_deleted=False,
            ).only("id", "name")
        )
        if not user_fields:
            return

        if changed_field_ids is not None:
            user_fields = [
                field for field in user_fields
                if str(field.id) in changed_field_ids
            ]
            if not user_fields:
                return

        newly_assigned: Set[str] = set()
        field_names_by_user: Dict[str, List[str]] = {}
        for field in user_fields:
            field_key = str(field.id)
            added = extract_user_ids_from_field_value(after.get(field_key)) - extract_user_ids_from_field_value(
                before.get(field_key)
            )
            for uid in added:
                newly_assigned.add(uid)
                field_names_by_user.setdefault(uid, []).append(field.name or "成员")

        actor = str(actor_id or "").strip()
        if actor:
            newly_assigned.discard(actor)
        if not newly_assigned:
            return

        table = (
            Table.objects.using(TABDATA_DB_ALIAS)
            .filter(id=table_id)
            .only("id", "name", "organization_id", "space_id")
            .first()
        )
        if table is None:
            return

        organization_id = str(table.organization_id or "")
        space_id = str(table.space_id or "") if table.space_id else ""
        table_title = table.name or "未命名表格"
        actor_label = self._resolve_actor_label(actor)

        for user_id in newly_assigned:
            field_label = "、".join(field_names_by_user.get(user_id, ["成员"]))
            title = f"{actor_label} 在《{table_title}》的「{field_label}」中提到了你"
            metadata = {
                "resource_type": "table",
                "resource_id": str(table_id),
                "resource_title": table_title,
                "record_id": str(record_id),
                "action": "assigned",
                "field_names": field_names_by_user.get(user_id, []),
                "organization_id": organization_id,
                "space_id": space_id,
                "actor_id": actor,
                "actor_name": actor_label,
                "category": "collaboration",
                "behavior": "view_context",
            }
            try:
                NotificationService.notify(
                    user_id=user_id,
                    type=NOTIFY_TYPE,
                    title=title,
                    body=f"你被添加到表格《{table_title}》",
                    metadata=metadata,
                    organization_id=organization_id,
                )
            except Exception:
                logger.warning(
                    "[UserAssignmentNotifySubscriber] notify one failed user=%s table=%s",
                    user_id,
                    table_id,
                    exc_info=True,
                )

    @staticmethod
    def _resolve_actor_label(actor_id: str) -> str:
        if not actor_id:
            return "有人"
        try:
            from django.contrib.auth import get_user_model

            User = get_user_model()
            user = User.objects.filter(id=actor_id).only("nickname", "username", "email").first()
            if not user:
                return "有人"
            return (
                getattr(user, "nickname", "")
                or getattr(user, "username", "")
                or getattr(user, "email", "")
                or "有人"
            )
        except Exception:
            return "有人"
