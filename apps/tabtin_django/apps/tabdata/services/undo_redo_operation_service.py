"""
TabData 结构化 Undo/Redo 操作服务

目标：
1. 承载 fields/views 等非记录操作的栈模型
2. 与 RecordHistory 审计解耦，避免把结构操作硬塞到记录历史表
3. 为 UndoRedoService 提供统一执行入口
"""

from __future__ import annotations

import copy
import logging
from typing import Any, Dict, Iterable, List, Optional, Tuple
from uuid import UUID, uuid4

from django.utils import timezone

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import Table, TableField, TableView
from apps.tabdata.services.undo_redo_stack_service import UndoRedoStackService
from apps.tabdata.utils.record_data_access import read_data, write_fields

logger = logging.getLogger(__name__)


class UndoRedoOperationName:
    CREATE_FIELDS = "createFields"
    DELETE_FIELDS = "deleteFields"
    UPDATE_FIELDS = "updateFields"
    CREATE_VIEW = "createView"
    DELETE_VIEW = "deleteView"
    UPDATE_VIEW = "updateView"
    # 粘贴选区 / 记录排序等扩展操作类型
    PASTE_SELECTION = "pasteSelection"
    UPDATE_RECORDS_ORDER = "updateRecordsOrder"


SUPPORTED_OPERATION_NAMES = {
    UndoRedoOperationName.CREATE_FIELDS,
    UndoRedoOperationName.DELETE_FIELDS,
    UndoRedoOperationName.UPDATE_FIELDS,
    UndoRedoOperationName.CREATE_VIEW,
    UndoRedoOperationName.DELETE_VIEW,
    UndoRedoOperationName.UPDATE_VIEW,
    UndoRedoOperationName.PASTE_SELECTION,
    UndoRedoOperationName.UPDATE_RECORDS_ORDER,
}


class UndoRedoOperationService:
    """结构化操作构建与回放。"""

    def __init__(self, user=None):
        self.user = user
        self.stack_service = UndoRedoStackService()

    @staticmethod
    def _normalize_window_id(window_id: Optional[str]) -> Optional[str]:
        if not window_id:
            return None
        normalized = str(window_id).strip()
        return normalized[:128] if normalized else None

    def _resolve_stack_user_id(self) -> Optional[str]:
        if not self.user or not getattr(self.user, "id", None):
            return None
        return str(self.user.id)

    def _history_user_payload(self) -> Optional[Dict[str, Any]]:
        if not self.user:
            return None
        return {
            "id": str(self.user.id),
            "name": self.user.get_display_name() if hasattr(self.user, "get_display_name") else str(self.user),
        }

    @staticmethod
    def _to_uuid(value: Any) -> Optional[UUID]:
        try:
            return UUID(str(value))
        except Exception:
            return None

    @staticmethod
    def serialize_field(field: TableField) -> Dict[str, Any]:
        return {
            "id": str(field.id),
            "table_id": str(field.table_id),
            "name": field.name,
            "field_type": field.field_type,
            "description": field.description or "",
            "config": copy.deepcopy(field.config or {}),
            "order": int(field.order or 0),
            "width": int(field.width or 150),
            "is_primary": bool(field.is_primary),
            "is_hidden": bool(field.is_hidden),
            "default_value": copy.deepcopy(field.default_value),
            "validation_rules": copy.deepcopy(field.validation_rules or {}),
            "is_deleted": bool(field.is_deleted),
            # cellValueType 抽象层
            "cellValueType": getattr(field, 'cell_value_type', None) or 'string',
            "isMultipleCellValue": bool(getattr(field, 'is_multiple_cell_value', False)),
        }

    @staticmethod
    def serialize_view(view: TableView) -> Dict[str, Any]:
        return {
            "id": str(view.id),
            "table_id": str(view.table_id),
            "name": view.name,
            "view_type": view.view_type,
            "description": view.description or "",
            "config": copy.deepcopy(view.config or {}),
            "filter": copy.deepcopy(getattr(view, "filter", None)),
            "filters": copy.deepcopy(view.filters or []),
            "sorts": copy.deepcopy(view.sorts or []),
            "groups": copy.deepcopy(view.groups or []),
            "visible_fields": copy.deepcopy(view.visible_fields or []),
            "field_order": copy.deepcopy(view.field_order or []),
            "column_meta": copy.deepcopy(view.column_meta or {}),
            "config_rev": int(getattr(view, "config_rev", 0) or 0),
            "is_shared": bool(view.is_shared),
            "is_locked": bool(view.is_locked),
            "created_by_id": str(view.created_by_id) if view.created_by_id else None,
            "order": int(view.order or 0),
            "is_default": bool(view.table.default_view_id == view.id),
        }

    @classmethod
    def is_structured_operation(cls, operation: Optional[Dict[str, Any]]) -> bool:
        if not isinstance(operation, dict):
            return False
        name = str(operation.get("name") or "").strip()
        return name in SUPPORTED_OPERATION_NAMES

    def build_operation(
        self,
        *,
        name: str,
        table_id: UUID | str,
        action: str,
        action_display: str,
        field_changes: Optional[Dict[str, Any]] = None,
        items: Optional[List[Dict[str, Any]]] = None,
        params: Optional[Dict[str, Any]] = None,
        result: Optional[Dict[str, Any]] = None,
        window_id: Optional[str] = None,
        operation_group_id: Optional[UUID] = None,
    ) -> Dict[str, Any]:
        now = timezone.now().isoformat()
        table_id_str = str(table_id)
        return {
            "id": str(uuid4()),
            "record_id": table_id_str,
            "table_id": table_id_str,
            "action": str(action),
            "action_display": str(action_display),
            "field_changes": field_changes or {},
            "items": items or [],
            "user": self._history_user_payload(),
            "created_at": now,
            "is_undone": False,
            "undone_at": None,
            "undone_by": None,
            "operation_group_id": str(operation_group_id) if operation_group_id else None,
            "window_id": self._normalize_window_id(window_id),
            "name": str(name),
            "params": params or {},
            "result": result or {},
        }

    def push_operation(self, *, table_id: UUID | str, window_id: Optional[str], operation: Dict[str, Any]) -> None:
        if not self.stack_service.enabled:
            return
        user_id = self._resolve_stack_user_id()
        if not user_id:
            return
        self.stack_service.push_undo_operation(
            user_id=user_id,
            table_id=str(table_id),
            window_id=self._normalize_window_id(window_id),
            operation=operation,
            clear_redo=True,
        )

    def push_create_fields(
        self,
        *,
        table_id: UUID | str,
        fields: Iterable[TableField],
        window_id: Optional[str],
    ) -> None:
        field_list = [self.serialize_field(field) for field in fields]
        if not field_list:
            return
        operation = self.build_operation(
            name=UndoRedoOperationName.CREATE_FIELDS,
            table_id=table_id,
            action="create",
            action_display="创建字段",
            field_changes={
                "_fields": {
                    "old": None,
                    "new": [
                        {"id": item["id"], "name": item["name"], "field_type": item["field_type"]}
                        for item in field_list
                    ],
                }
            },
            items=[
                {
                    "field_key": f"field:{item['id']}",
                    "before": None,
                    "after": {"name": item["name"], "field_type": item["field_type"]},
                }
                for item in field_list
            ],
            params={"table_id": str(table_id)},
            result={"fields": field_list},
            window_id=window_id,
        )
        self.push_operation(table_id=table_id, window_id=window_id, operation=operation)

    def push_delete_fields(
        self,
        *,
        table_id: UUID | str,
        fields_before_delete: Iterable[Dict[str, Any]],
        window_id: Optional[str],
    ) -> None:
        field_list = [copy.deepcopy(item) for item in fields_before_delete if item]
        if not field_list:
            return
        operation = self.build_operation(
            name=UndoRedoOperationName.DELETE_FIELDS,
            table_id=table_id,
            action="delete",
            action_display="删除字段",
            field_changes={
                "_fields": {
                    "old": [
                        {"id": item["id"], "name": item["name"], "field_type": item["field_type"]}
                        for item in field_list
                    ],
                    "new": None,
                }
            },
            items=[
                {
                    "field_key": f"field:{item['id']}",
                    "before": {"name": item["name"], "field_type": item["field_type"]},
                    "after": None,
                }
                for item in field_list
            ],
            params={"table_id": str(table_id)},
            result={"fields": field_list},
            window_id=window_id,
        )
        self.push_operation(table_id=table_id, window_id=window_id, operation=operation)

    def push_update_fields(
        self,
        *,
        table_id: UUID | str,
        old_fields: Iterable[Dict[str, Any]],
        new_fields: Iterable[Dict[str, Any]],
        window_id: Optional[str],
        action_display: str = "更新字段",
    ) -> None:
        old_list = [copy.deepcopy(item) for item in old_fields if item]
        new_list = [copy.deepcopy(item) for item in new_fields if item]
        if not old_list or not new_list:
            return
        old_map = {str(item["id"]): item for item in old_list}
        pairs: List[Tuple[Dict[str, Any], Dict[str, Any]]] = []
        for new_item in new_list:
            old_item = old_map.get(str(new_item["id"]))
            if not old_item:
                continue
            if old_item == new_item:
                continue
            pairs.append((old_item, new_item))
        if not pairs:
            return
        operation = self.build_operation(
            name=UndoRedoOperationName.UPDATE_FIELDS,
            table_id=table_id,
            action="update",
            action_display=action_display,
            field_changes={
                "_fields": {
                    "old": [
                        {"id": old_item["id"], "name": old_item["name"], "field_type": old_item["field_type"]}
                        for old_item, _new_item in pairs
                    ],
                    "new": [
                        {"id": new_item["id"], "name": new_item["name"], "field_type": new_item["field_type"]}
                        for _old_item, new_item in pairs
                    ],
                }
            },
            items=[
                {
                    "field_key": f"field:{old_item['id']}",
                    "before": {"name": old_item["name"], "field_type": old_item["field_type"]},
                    "after": {"name": new_item["name"], "field_type": new_item["field_type"]},
                }
                for old_item, new_item in pairs
            ],
            params={"table_id": str(table_id)},
            result={
                "old_fields": [old_item for old_item, _ in pairs],
                "new_fields": [new_item for _, new_item in pairs],
            },
            window_id=window_id,
        )
        self.push_operation(table_id=table_id, window_id=window_id, operation=operation)

    def push_create_view(
        self,
        *,
        view: TableView,
        window_id: Optional[str],
    ) -> None:
        payload = self.serialize_view(view)
        operation = self.build_operation(
            name=UndoRedoOperationName.CREATE_VIEW,
            table_id=view.table_id,
            action="create",
            action_display="创建视图",
            field_changes={
                "_view": {
                    "old": None,
                    "new": {"id": payload["id"], "name": payload["name"], "view_type": payload["view_type"]},
                }
            },
            items=[
                {
                    "field_key": f"view:{payload['id']}",
                    "before": None,
                    "after": {"name": payload["name"], "view_type": payload["view_type"]},
                }
            ],
            params={"table_id": str(view.table_id)},
            result={"views": [payload]},
            window_id=window_id,
        )
        self.push_operation(table_id=view.table_id, window_id=window_id, operation=operation)

    def push_delete_view(
        self,
        *,
        view_payload_before_delete: Dict[str, Any],
        window_id: Optional[str],
    ) -> None:
        if not view_payload_before_delete:
            return
        table_id = view_payload_before_delete.get("table_id")
        if not table_id:
            return
        payload = copy.deepcopy(view_payload_before_delete)
        operation = self.build_operation(
            name=UndoRedoOperationName.DELETE_VIEW,
            table_id=table_id,
            action="delete",
            action_display="删除视图",
            field_changes={
                "_view": {
                    "old": {"id": payload["id"], "name": payload["name"], "view_type": payload["view_type"]},
                    "new": None,
                }
            },
            items=[
                {
                    "field_key": f"view:{payload['id']}",
                    "before": {"name": payload["name"], "view_type": payload["view_type"]},
                    "after": None,
                }
            ],
            params={"table_id": str(table_id), "view_id": str(payload["id"])},
            result={"views": [payload]},
            window_id=window_id,
        )
        self.push_operation(table_id=table_id, window_id=window_id, operation=operation)

    def push_update_view(
        self,
        *,
        table_id: UUID | str,
        old_view_payload: Dict[str, Any],
        new_view_payload: Dict[str, Any],
        window_id: Optional[str],
        action_display: str = "更新视图",
    ) -> None:
        if not old_view_payload or not new_view_payload:
            return
        if old_view_payload == new_view_payload:
            return
        operation = self.build_operation(
            name=UndoRedoOperationName.UPDATE_VIEW,
            table_id=table_id,
            action="update",
            action_display=action_display,
            field_changes={
                "_view": {
                    "old": {
                        "id": old_view_payload["id"],
                        "name": old_view_payload["name"],
                        "view_type": old_view_payload["view_type"],
                    },
                    "new": {
                        "id": new_view_payload["id"],
                        "name": new_view_payload["name"],
                        "view_type": new_view_payload["view_type"],
                    },
                }
            },
            items=[
                {
                    "field_key": f"view:{old_view_payload['id']}",
                    "before": {
                        "name": old_view_payload["name"],
                        "view_type": old_view_payload["view_type"],
                        "order": old_view_payload["order"],
                    },
                    "after": {
                        "name": new_view_payload["name"],
                        "view_type": new_view_payload["view_type"],
                        "order": new_view_payload["order"],
                    },
                }
            ],
            params={"table_id": str(table_id), "view_id": str(old_view_payload["id"])},
            result={
                "old_views": [copy.deepcopy(old_view_payload)],
                "new_views": [copy.deepcopy(new_view_payload)],
            },
            window_id=window_id,
        )
        self.push_operation(table_id=table_id, window_id=window_id, operation=operation)

    def push_update_views(
        self,
        *,
        table_id: UUID | str,
        old_views: Iterable[Dict[str, Any]],
        new_views: Iterable[Dict[str, Any]],
        window_id: Optional[str],
        action_display: str = "更新视图",
    ) -> None:
        old_list = [copy.deepcopy(item) for item in old_views if item]
        new_list = [copy.deepcopy(item) for item in new_views if item]
        if not old_list or not new_list:
            return

        old_map = {str(item["id"]): item for item in old_list}
        pairs: List[Tuple[Dict[str, Any], Dict[str, Any]]] = []
        for new_item in new_list:
            old_item = old_map.get(str(new_item["id"]))
            if not old_item:
                continue
            if old_item == new_item:
                continue
            pairs.append((old_item, new_item))
        if not pairs:
            return

        operation = self.build_operation(
            name=UndoRedoOperationName.UPDATE_VIEW,
            table_id=table_id,
            action="update",
            action_display=action_display,
            field_changes={
                "_views": {
                    "old": [
                        {
                            "id": old_item["id"],
                            "name": old_item["name"],
                            "view_type": old_item["view_type"],
                            "order": old_item["order"],
                        }
                        for old_item, _ in pairs
                    ],
                    "new": [
                        {
                            "id": new_item["id"],
                            "name": new_item["name"],
                            "view_type": new_item["view_type"],
                            "order": new_item["order"],
                        }
                        for _, new_item in pairs
                    ],
                }
            },
            items=[
                {
                    "field_key": f"view:{old_item['id']}",
                    "before": {
                        "name": old_item["name"],
                        "view_type": old_item["view_type"],
                        "order": old_item["order"],
                    },
                    "after": {
                        "name": new_item["name"],
                        "view_type": new_item["view_type"],
                        "order": new_item["order"],
                    },
                }
                for old_item, new_item in pairs
            ],
            params={"table_id": str(table_id)},
            result={
                "old_views": [old_item for old_item, _ in pairs],
                "new_views": [new_item for _, new_item in pairs],
            },
            window_id=window_id,
        )
        self.push_operation(table_id=table_id, window_id=window_id, operation=operation)

    def _mark_fields_deleted(self, field_payloads: Iterable[Dict[str, Any]]) -> None:
        field_ids = [
            self._to_uuid(item.get("id"))
            for item in field_payloads
            if isinstance(item, dict)
        ]
        field_ids = [item for item in field_ids if item]
        if not field_ids:
            return
        TableField.objects.using(TABDATA_DB_ALIAS).filter(id__in=field_ids).update(is_deleted=True)

    def _restore_fields(
        self, field_payloads: Iterable[Dict[str, Any]]
    ) -> Tuple[List[str], List[Tuple[str, str]]]:
        """C1 / Wave 1.3：字段 restore 走原子全链路。

        旧实现只做 ORM ``update_or_create``，导致 native 列缺失、关联依赖未重注册、
        Link 对称字段未恢复（PRD §C1 "回来一半" 破口）。

        新实现委托给 :func:`apps.tabdata.services.undo_redo_field_restore.restore_fields`：
        - 简单字段 11 种 → 原子重建（ORM 反软删 + native 列 + view + ChangeLog）
        - 复杂字段 4 种 → 抛 :class:`FieldRestoreNotSupportedError`，由 ``execute()``
          上抛给 :class:`UndoRedoService`，再转 HTTP 409

        :returns: ``(restored_field_ids, errors)``；``errors`` 元素为 ``(field_id, message)``。
            调用方（:meth:`execute`）据此判定撤销/重做是否真正生效——全部失败时
            必须向上返回失败，避免"假成功"（前端 toast 撤销成功但字段没恢复）。
        """
        from apps.tabdata.services.undo_redo_field_restore import restore_fields

        payload_list = [p for p in field_payloads if isinstance(p, dict)]
        if not payload_list:
            return [], []

        # restore_fields 内部已包 atomic + 抛 FieldRestoreNotSupportedError；
        # 任何 simple-field 单条失败都进 errors，不抛异常。complex-field 整体抛错。
        restored, errors = restore_fields(payload_list, user=self.user)

        if errors:
            for fid, msg in errors:
                logger.warning(
                    "[FieldRestore] 单条恢复失败 field=%s err=%s", fid, msg,
                )

        return restored, errors

    def _restore_result(
        self, field_payloads: Iterable[Dict[str, Any]]
    ) -> Tuple[bool, Optional[str]]:
        """跑字段 restore 并把"全部失败"折叠成 ``execute()`` 可返回的失败信号。

        语义边界（对齐本轮 bug 根因 #1「恢复失败静默吞掉」）：
        - 空 payload：视为无需恢复 → 成功。
        - 有 payload 但一条都没恢复且有 errors：**整体失败**，把首个错误上抛，
          让上层返回 HTTP 400 + 具体原因（如"同名字段冲突"），避免前端假成功。
        - 部分成功（有 restored 也有 errors）：已恢复的字段不回滚，按成功处理，
          单条错误已在 :meth:`_restore_fields` 记日志（部分失败的更细粒度回报是
          后续技术债，见 issue-logging）。
        """
        restored, errors = self._restore_fields(field_payloads)
        if errors and not restored:
            first_error = errors[0][1] if errors else None
            return False, first_error or "字段恢复失败"
        return True, None

    def _apply_updated_fields(self, field_payloads: Iterable[Dict[str, Any]]) -> None:
        """Apply UPDATE_FIELDS payloads to existing active fields.

        ``_restore_fields`` is intentionally for delete undo: it restores
        soft-deleted fields and skips active rows. Field updates, including
        primary-field switches and reorder operations, need to overwrite the
        active metadata row instead.
        """
        payload_list = [p for p in field_payloads if isinstance(p, dict)]
        if not payload_list:
            return

        table_fields: Dict[UUID, List[TableField]] = {}
        for payload in payload_list:
            field_id = self._to_uuid(payload.get("id"))
            table_id = self._to_uuid(payload.get("table_id"))
            if not field_id or not table_id:
                continue
            try:
                field = (
                    TableField.objects.using(TABDATA_DB_ALIAS)
                    .select_for_update()
                    .get(id=field_id, table_id=table_id, is_deleted=False)
                )
            except TableField.DoesNotExist:
                logger.warning("[FieldUpdateRestore] active field not found: %s", field_id)
                continue

            field.name = str(payload.get("name") or field.name)
            field.description = str(payload.get("description") or "")
            field.order = int(payload.get("order") or 0)
            field.width = int(payload.get("width") or field.width or 150)
            field.is_primary = bool(payload.get("is_primary", field.is_primary))
            field.is_hidden = bool(payload.get("is_hidden", field.is_hidden))
            field.validation_rules = copy.deepcopy(payload.get("validation_rules") or {})
            from apps.tabdata.services.field_configuration_service import (
                DEFAULT_VALUE_UNSET,
                apply_field_configuration_change,
            )
            apply_field_configuration_change(
                field,
                config=copy.deepcopy(payload.get("config") or {}),
                default_value=(
                    copy.deepcopy(payload.get("default_value"))
                    if "default_value" in payload
                    else DEFAULT_VALUE_UNSET
                ),
            )
            field.save(update_fields=[
                "name",
                "description",
                "config",
                "order",
                "width",
                "is_primary",
                "is_hidden",
                "default_value",
                "validation_rules",
                "updated_at",
            ])
            table_fields.setdefault(table_id, []).append(field)

        if not table_fields:
            return

        from apps.tabdata.services.table_service import TableService

        table_service = TableService(user=self.user)
        for table_id, fields in table_fields.items():
            try:
                table_service._increment_schema_version(table_id)  # noqa: SLF001
                table_service._publish_field_event(table_id, "update_field", fields)  # noqa: SLF001
            except Exception as exc:
                logger.warning(
                    "[FieldUpdateRestore] schema/event refresh failed table=%s err=%s",
                    table_id,
                    exc,
                )

    def _delete_views(self, view_payloads: Iterable[Dict[str, Any]]) -> None:
        for payload in view_payloads:
            view_id = self._to_uuid(payload.get("id"))
            table_id = self._to_uuid(payload.get("table_id"))
            if not view_id or not table_id:
                continue
            Table.objects.using(TABDATA_DB_ALIAS).filter(id=table_id, default_view_id=view_id).update(default_view=None)
            TableView.objects.using(TABDATA_DB_ALIAS).filter(id=view_id, table_id=table_id).delete()

    def _restore_views(self, view_payloads: Iterable[Dict[str, Any]]) -> None:
        for payload in view_payloads:
            view_id = self._to_uuid(payload.get("id"))
            table_id = self._to_uuid(payload.get("table_id"))
            if not view_id or not table_id:
                continue

            # User.id 是 CharField(UUID 字符串)，不能 int()——否则静默丢成 None
            created_by_id = payload.get("created_by_id")
            created_by_value: Optional[str] = None
            if created_by_id is not None and str(created_by_id).strip():
                created_by_value = str(created_by_id).strip()[:36]

            defaults: Dict[str, Any] = {
                "table_id": table_id,
                "name": payload.get("name") or "",
                "view_type": payload.get("view_type") or "grid",
                "description": payload.get("description") or "",
                "config": copy.deepcopy(payload.get("config") or {}),
                "filters": copy.deepcopy(payload.get("filters") or []),
                "sorts": copy.deepcopy(payload.get("sorts") or []),
                "groups": copy.deepcopy(payload.get("groups") or []),
                "visible_fields": copy.deepcopy(payload.get("visible_fields") or []),
                "field_order": copy.deepcopy(payload.get("field_order") or []),
                "column_meta": copy.deepcopy(payload.get("column_meta") or {}),
                "is_shared": bool(payload.get("is_shared")),
                "is_locked": bool(payload.get("is_locked")),
                "created_by_id": created_by_value,
                "order": int(payload.get("order") or 0),
            }
            # 嵌套 FilterSet（优先于旧版 filters）；序列化侧若未带则不覆盖
            if "filter" in payload:
                defaults["filter"] = copy.deepcopy(payload.get("filter"))
            if "config_rev" in payload:
                try:
                    defaults["config_rev"] = int(payload.get("config_rev") or 0)
                except Exception:
                    defaults["config_rev"] = 0

            TableView.objects.using(TABDATA_DB_ALIAS).update_or_create(
                id=view_id,
                defaults=defaults,
            )

            if payload.get("is_default"):
                Table.objects.using(TABDATA_DB_ALIAS).filter(id=table_id).update(default_view_id=view_id)

    def _operation_user_payload(self, undone: bool) -> Optional[Dict[str, Any]]:
        if not undone or not self.user:
            return None
        return self._history_user_payload()

    def _build_next_operation_state(self, operation: Dict[str, Any], *, undone: bool) -> Dict[str, Any]:
        next_operation = copy.deepcopy(operation)
        next_operation["is_undone"] = bool(undone)
        next_operation["undone_at"] = timezone.now().isoformat() if undone else None
        next_operation["undone_by"] = self._operation_user_payload(undone)
        return next_operation

    def execute(
        self,
        *,
        operation: Dict[str, Any],
        direction: str,
    ) -> Tuple[bool, Optional[str], Optional[Dict[str, Any]]]:
        """
        执行结构化栈操作。

        direction:
        - undo: 执行撤销语义，并返回写入 redo 栈的 operation
        - redo: 执行重做语义，并返回写入 undo 栈的 operation
        """
        if not self.is_structured_operation(operation):
            return False, "不支持的结构化操作", None

        name = str(operation.get("name"))
        result = operation.get("result") or {}

        try:
            if name == UndoRedoOperationName.CREATE_FIELDS:
                fields = result.get("fields") or []
                if direction == "undo":
                    self._mark_fields_deleted(fields)
                    return True, None, self._build_next_operation_state(operation, undone=True)
                ok, restore_error = self._restore_result(fields)
                if not ok:
                    return False, restore_error, None
                return True, None, self._build_next_operation_state(operation, undone=False)

            if name == UndoRedoOperationName.DELETE_FIELDS:
                fields = result.get("fields") or []
                if direction == "undo":
                    ok, restore_error = self._restore_result(fields)
                    if not ok:
                        return False, restore_error, None
                    return True, None, self._build_next_operation_state(operation, undone=True)
                self._mark_fields_deleted(fields)
                return True, None, self._build_next_operation_state(operation, undone=False)

            if name == UndoRedoOperationName.UPDATE_FIELDS:
                old_fields = result.get("old_fields") or []
                new_fields = result.get("new_fields") or []
                if direction == "undo":
                    self._apply_updated_fields(old_fields)
                    return True, None, self._build_next_operation_state(operation, undone=True)
                self._apply_updated_fields(new_fields)
                return True, None, self._build_next_operation_state(operation, undone=False)

            if name == UndoRedoOperationName.CREATE_VIEW:
                views = result.get("views") or []
                if direction == "undo":
                    self._delete_views(views)
                    return True, None, self._build_next_operation_state(operation, undone=True)
                self._restore_views(views)
                return True, None, self._build_next_operation_state(operation, undone=False)

            if name == UndoRedoOperationName.DELETE_VIEW:
                views = result.get("views") or []
                if direction == "undo":
                    self._restore_views(views)
                    return True, None, self._build_next_operation_state(operation, undone=True)
                self._delete_views(views)
                return True, None, self._build_next_operation_state(operation, undone=False)

            if name == UndoRedoOperationName.UPDATE_VIEW:
                old_views = result.get("old_views") or []
                new_views = result.get("new_views") or []
                if direction == "undo":
                    self._restore_views(old_views)
                    return True, None, self._build_next_operation_state(operation, undone=True)
                self._restore_views(new_views)
                return True, None, self._build_next_operation_state(operation, undone=False)

            if name == UndoRedoOperationName.PASTE_SELECTION:
                return self._execute_paste_selection(operation, result, direction)

            if name == UndoRedoOperationName.UPDATE_RECORDS_ORDER:
                return self._execute_update_records_order(operation, result, direction)

            return False, f"不支持的操作类型: {name}", None
        except Exception as exc:
            # C1 / Wave 1.3：FieldRestoreNotSupportedError 必须**不被吞**，由
            # UndoRedoService.undo_table_operation 上抛给 api_undo_redo 转 409 + 文案。
            from apps.tabdata.exceptions import FieldRestoreNotSupportedError
            if isinstance(exc, FieldRestoreNotSupportedError):
                raise
            logger.error("[UndoRedoOperation] 执行失败: name=%s direction=%s err=%s", name, direction, exc, exc_info=True)
            return False, str(exc), None

    # ── PasteSelection ──

    def _apply_cell_updates(self, cells: List[Dict[str, Any]], table_id_str: str) -> None:
        """
        批量写入单元格值。

        cells 结构: [{"record_id": ..., "field_key": ..., "value": ...}, ...]

        field_key 应与 TableRecord.data 中的 key 保持一致（当前约定为 field_id）。
        为兼容旧数据，同时接受 ``field_name`` 别名。
        """
        from apps.tabdata.models import TableRecord

        table_uuid = self._to_uuid(table_id_str)
        if not table_uuid:
            return

        table = Table.objects.using(TABDATA_DB_ALIAS).get(id=table_uuid)
        all_fields = list(TableField.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=table_uuid, is_deleted=False,
        ))

        for cell in cells:
            record_id = self._to_uuid(cell.get("record_id"))
            field_key = cell.get("field_key") or cell.get("field_name")
            value = cell.get("value")
            if not record_id or not field_key:
                continue
            try:
                record = TableRecord.objects.using(TABDATA_DB_ALIAS).select_for_update().get(
                    id=record_id, table_id=table_uuid, is_deleted=False
                )
                write_fields(record, {field_key: value}, table, all_fields)
                record._skip_record_history = True  # noqa: SLF001  — 避免重复历史
                record.save(update_fields=["data", "updated_at"])
                from apps.tabdata.subscribers._utils import notify_record_changed_for_rag
                notify_record_changed_for_rag(record.table_id, record.id)
            except TableRecord.DoesNotExist:
                logger.warning("[PasteSelection] record %s not found", record_id)

    def _execute_paste_selection(
        self, operation: Dict[str, Any], result: Dict[str, Any], direction: str
    ) -> Tuple[bool, Optional[str], Optional[Dict[str, Any]]]:
        table_id = str(operation.get("table_id") or "")
        old_cells = result.get("old_cells") or []
        new_cells = result.get("new_cells") or []

        if direction == "undo":
            self._apply_cell_updates(old_cells, table_id)
            return True, None, self._build_next_operation_state(operation, undone=True)
        else:
            self._apply_cell_updates(new_cells, table_id)
            return True, None, self._build_next_operation_state(operation, undone=False)

    def push_paste_selection(
        self,
        *,
        table_id: UUID | str,
        old_cells: List[Dict[str, Any]],
        new_cells: List[Dict[str, Any]],
        window_id: Optional[str],
        action_display: str = "粘贴",
    ) -> None:
        """
        将粘贴操作推入 undo 栈。

        old_cells / new_cells 格式：
        [{"record_id": "...", "field_key": "...", "value": ...}, ...]

        field_key 应与 TableRecord.data 中的 key 保持一致（当前约定为 field_id）。
        """
        if not old_cells and not new_cells:
            return
        operation = self.build_operation(
            name=UndoRedoOperationName.PASTE_SELECTION,
            table_id=table_id,
            action="update",
            action_display=action_display,
            field_changes={"_paste": {"cell_count": len(new_cells)}},
            params={"table_id": str(table_id)},
            result={
                "old_cells": copy.deepcopy(old_cells),
                "new_cells": copy.deepcopy(new_cells),
            },
            window_id=window_id,
        )
        self.push_operation(table_id=table_id, window_id=window_id, operation=operation)

    # ── UpdateRecordsOrder ──

    def _apply_record_order(self, order_map: Dict[str, int], table_id_str: str) -> None:
        """
        批量更新记录排序位置。

        order_map: {"record_id": sort_position, ...}
        """
        from apps.tabdata.models import TableRecord

        table_uuid = self._to_uuid(table_id_str)
        if not table_uuid:
            return

        for record_id_str, position in order_map.items():
            record_id = self._to_uuid(record_id_str)
            if not record_id:
                continue
            TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                id=record_id, table_id=table_uuid, is_deleted=False
            ).update(order=position)

    def _execute_update_records_order(
        self, operation: Dict[str, Any], result: Dict[str, Any], direction: str
    ) -> Tuple[bool, Optional[str], Optional[Dict[str, Any]]]:
        table_id = str(operation.get("table_id") or "")
        old_order = result.get("old_order") or {}
        new_order = result.get("new_order") or {}

        if direction == "undo":
            self._apply_record_order(old_order, table_id)
            return True, None, self._build_next_operation_state(operation, undone=True)
        else:
            self._apply_record_order(new_order, table_id)
            return True, None, self._build_next_operation_state(operation, undone=False)

    def push_update_records_order(
        self,
        *,
        table_id: UUID | str,
        old_order: Dict[str, int],
        new_order: Dict[str, int],
        window_id: Optional[str],
        action_display: str = "调整排序",
    ) -> None:
        """
        将记录排序变更推入 undo 栈。

        old_order / new_order: {"record_id": sort_position, ...}
        """
        if not old_order and not new_order:
            return
        operation = self.build_operation(
            name=UndoRedoOperationName.UPDATE_RECORDS_ORDER,
            table_id=table_id,
            action="update",
            action_display=action_display,
            field_changes={"_order": {"record_count": len(new_order)}},
            params={"table_id": str(table_id)},
            result={
                "old_order": copy.deepcopy(old_order),
                "new_order": copy.deepcopy(new_order),
            },
            window_id=window_id,
        )
        self.push_operation(table_id=table_id, window_id=window_id, operation=operation)
