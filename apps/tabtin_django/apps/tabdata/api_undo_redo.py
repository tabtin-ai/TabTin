"""
撤销/重做 API 端点

提供表格记录的撤销和重做功能
"""
from typing import Any
from uuid import UUID
from ninja import Router
from django.http import HttpRequest

from apps.users.auth.permissions import JWTAuth
from apps.tabdata.exceptions import FieldRestoreNotSupportedError
from apps.tabdata.history_events import normalize_editor_type_for_response
from apps.tabdata.services import UndoRedoService
from apps.tabdata.services.undo_redo_service import (
    NO_UNDO_OPERATIONS_MSG,
    NO_REDO_OPERATIONS_MSG,
)
from apps.tabdata.services.undo_redo_operation_service import UndoRedoOperationName
from apps.tabdata.constants import SYSTEM_MANAGED_FIELD_TYPES
from apps.tabdata.schemas import (
    UndoRequest, RedoRequest,
    UndoRedoResponse, BatchUndoRedoResponse,
    UndoStackQuery, UndoStackResponse, RedoStackResponse,
    RecordHistoryQuery, RecordHistoryResponse,
    TableHistoryResponse,
    HistoryOperationOut, HistoryOperationUser, HistoryOperationItemOut,
    RecordSnapshotResponse, TableSnapshotResponse, TableSnapshotRecordOut,
    RestoreRecordRequest, RestoreRecordResponse,
    RestoreTableRequest, RestoreTableResponse,
    CreateTableNamedVersionRequest, RenameTableNamedVersionRequest,
    TableNamedVersionOut,
    ErrorResponse,
)
from django.core.exceptions import ObjectDoesNotExist

from apps.tabdata.api_helpers import (
    success_response, error_response,
    not_found_response, permission_denied_response, validation_error_response,
    api_error_handler,
)
from apps.tabdata.error_codes import ErrorCode, ErrorMessage
from apps.i18n import _


# 结构化 undo/redo 中会改动 Y.Doc `meta`（fields / views）的操作名。
# 这类操作撤销/重做后只改了 DB + native 列，collab-live 内存 Y.Doc 的
# meta.fields / meta.views 仍是过期快照——若不同步，随后前端 onStore
# debounce 会把过期快照回写 Django，`_persist_collab_fields` 的「缺席即删除」
# 又会把刚恢复的字段/视图再删一次（ 的第 4 个根因）。
_SCHEMA_META_OPERATION_NAMES = frozenset({
    UndoRedoOperationName.CREATE_FIELDS,
    UndoRedoOperationName.DELETE_FIELDS,
    UndoRedoOperationName.UPDATE_FIELDS,
    UndoRedoOperationName.CREATE_VIEW,
    UndoRedoOperationName.DELETE_VIEW,
    UndoRedoOperationName.UPDATE_VIEW,
})


def _histories_touch_schema_meta(histories: list) -> bool:
    """判断本次 undo/redo 是否改动了 Y.Doc schema meta（字段/视图结构）。

    结构化操作在服务层以 dict 形式返回（带 ``name``）；记录级历史是 ORM 对象，
    不含 schema 结构变化，直接跳过。
    """
    for op in histories or []:
        if isinstance(op, dict) and op.get("name") in _SCHEMA_META_OPERATION_NAMES:
            return True
    return False


def _resync_collab_after_schema_change(table_id: UUID) -> None:
    """字段/视图结构 undo/redo 后同步 collab-live，避免过期 Y.Doc meta 回写。

    ：禁止走「全量 document resync」权威覆盖——若瞬时快照 records 为空/不全，
    ``computeResyncDelta`` 会把在线 Y.Doc 里的行全部删掉，UI 表现为「整表行消失」。
    改为：
    1. 广播 ``table.schema.changed`` + ``fields_scope=full``，只更新 meta.fields
    2. 把当前活跃行 upsert 进 Y.Doc（不删行）
    """
    try:
        from apps.tabdata.constants import TABDATA_DB_ALIAS
        from apps.tabdata.models import TableField, TableRecord
        from apps.tabdata.services.table_event_service import table_event_service
        from apps.tabdata.utils.ydoc_sync import sync_records_to_ydoc

        active_fields = list(
            TableField.objects.using(TABDATA_DB_ALIAS)
            .filter(table_id=table_id, is_deleted=False)
            .order_by("order", "created_at")
        )
        field_payloads = [
            {
                "id": str(f.id),
                "id_hex": f.id.hex,
                "name": f.name,
                "field_type": f.field_type,
                "config": f.config or {},
                "order": f.order,
                "is_deleted": False,
            }
            for f in active_fields
        ]
        table_event_service.publish_field_change(
            str(table_id),
            action="schema_stack_sync",
            field_ids=[str(f.id) for f in active_fields],
            fields=field_payloads,
            metadata={"fields_scope": "full", "source": "undo_redo_schema"},
        )

        active_records = list(
            TableRecord.objects.using(TABDATA_DB_ALIAS)
            .filter(table_id=table_id, is_deleted=False)
            .order_by("order", "created_at")
        )
        if active_records:
            sync_records_to_ydoc(
                table_id,
                active_records,
                fields=active_fields,
                source="undo_redo_schema_stack",
                upsert_record_ids=[str(r.id) for r in active_records],
            )
    except Exception:
        import logging
        logging.getLogger(__name__).warning(
            "[undo_redo] collab schema sync 失败: table=%s", table_id, exc_info=True,
        )


def _resync_collab_after_history_restore(table_id: UUID) -> str:
    """同步整表还原结果，并把实际模式返回给客户端避免重复 forceReconnect。"""
    try:
        from apps.collab.api import _resync_or_force_close

        sync_result = _resync_or_force_close("table", str(table_id))
        return str(sync_result.get("sync_mode") or "failed")
    except Exception:
        import logging

        logging.getLogger(__name__).warning(
            "[restore_table] collab 通知失败: table=%s", table_id, exc_info=True,
        )
        return "failed"


def _field_restore_not_supported_response(exc: FieldRestoreNotSupportedError):
    """C1 / Wave 1.3:复杂字段 undo 失败时,按 W0-7 c5 文案规范返回 HTTP 409。

    - HTTP 409(Conflict):与 SCHEMA_VERSION_CONFLICT 等"业务前置条件"统一
    - code:``FIELD_RESTORE_NOT_SUPPORTED``(前端可路由到字段回收站引导)
    - 携带 ``field_id / field_name / field_type / reason_code`` 元数据,
      W1.4 删除前对话框 / 错误 toast 可直接消费

    W3.0c / G4 修复(三视角 Review P0):``reason_code='temporarily_disabled'``
    走专属 i18n key ``tabdata.field_restore_type_disabled``,英/日客户端
    收到对应语言的 message 而非 ``str(exc)`` 的硬编码中文。
    """
    if exc.reason_code == "temporarily_disabled":
        try:
            message = _(
                "tabdata.field_restore_type_disabled",
                field_name=exc.field_name or "",
                field_type=exc.field_type or "",
            )
        except Exception:
            message = str(exc)
    else:
        message = str(exc)

    return 409, {
        "success": False,
        "code": ErrorCode.FIELD_RESTORE_NOT_SUPPORTED,
        "message": message,
        "data": {
            "field_id": exc.field_id,
            "field_name": exc.field_name,
            "field_type": exc.field_type,
            "reason_code": exc.reason_code,
            "deferred_to": "version_history",
            "unrestorable_fields": getattr(exc, "unrestorable_fields", []) or [],
            "restorable_fields": getattr(exc, "restorable_fields", []) or [],
        },
    }

# 创建路由
router = Router(tags=["Undo/Redo"])
jwt_auth = JWTAuth()


def _resolve_window_id(request: HttpRequest) -> str | None:
    window_id = (
        request.headers.get("X-Window-Id")
        or request.headers.get("x-window-id")
        or request.META.get("HTTP_X_WINDOW_ID")
    )
    if not window_id:
        return None
    normalized = str(window_id).strip()
    return normalized[:128] if normalized else None


def _canonical_field_key(field_key: str, field_key_map: dict[str, str] | None = None) -> str:
    key = str(field_key)
    if key.startswith("_"):
        return key
    if not field_key_map:
        return key
    return field_key_map.get(key) or field_key_map.get(key.replace("-", "")) or key


def _is_hidden_history_field_type(field_type: str | None) -> bool:
    return bool(field_type) and field_type in SYSTEM_MANAGED_FIELD_TYPES


def _normalize_history_field_changes(
    field_changes: Any,
    field_key_map: dict[str, str] | None = None,
    field_metadata_map: dict[str, dict[str, str]] | None = None,
) -> dict[str, Any]:
    if not isinstance(field_changes, dict):
        return {}

    normalized: dict[str, Any] = {}
    for raw_key, raw_value in field_changes.items():
        raw_key_str = str(raw_key)
        if raw_key_str == "data" and isinstance(raw_value, dict):
            for data_key, data_value in raw_value.items():
                canonical_key = _canonical_field_key(str(data_key), field_key_map)
                metadata_key = canonical_key.removeprefix("field:")
                metadata = (field_metadata_map or {}).get(metadata_key, {})
                if _is_hidden_history_field_type(metadata.get("field_type")):
                    continue
                normalized[canonical_key] = {"old": None, "new": data_value}
            continue

        canonical_key = _canonical_field_key(raw_key_str, field_key_map)
        metadata_key = canonical_key.removeprefix("field:")
        metadata = (field_metadata_map or {}).get(metadata_key, {})
        if _is_hidden_history_field_type(metadata.get("field_type")):
            continue
        if isinstance(raw_value, dict) and ("old" in raw_value or "new" in raw_value):
            normalized[canonical_key] = raw_value
        else:
            normalized[canonical_key] = {"old": None, "new": raw_value}

    return normalized


def _build_history_items_payload(
    items,
    field_key_map: dict[str, str] | None = None,
    field_metadata_map: dict[str, dict[str, str]] | None = None,
) -> list[HistoryOperationItemOut]:
    payload: list[HistoryOperationItemOut] = []
    for item in items:
        if isinstance(item, dict):
            field_key = item.get("field_key", "")
            before = item.get("before")
            after = item.get("after")
            field_name = item.get("field_name")
            field_type = item.get("field_type")
        else:
            field_key = item.field_key
            before = item.before
            after = item.after
            field_name = getattr(item, "field_name", None)
            field_type = getattr(item, "field_type", None)
        canonical_key = _canonical_field_key(field_key, field_key_map)
        metadata_key = canonical_key.removeprefix("field:")
        metadata = (field_metadata_map or {}).get(metadata_key, {})
        if _is_hidden_history_field_type(field_type or metadata.get("field_type")):
            continue
        payload.append(
            HistoryOperationItemOut(
                field_key=canonical_key,
                field_name=metadata.get("name") or field_name,
                field_type=field_type or metadata.get("field_type"),
                before=before,
                after=after,
            )
        )
    return payload


def _load_field_maps_for_record_ids(
    record_ids,
) -> tuple[dict[str, dict[str, str]], dict[str, dict[str, dict[str, str]]]]:
    record_ids = [record_id for record_id in record_ids if record_id]
    if not record_ids:
        return {}, {}

    from apps.tabdata.constants import TABDATA_DB_ALIAS
    from apps.tabdata.models import TableField, TableRecord

    record_table_map: dict[str, str] = {}
    for row in TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
        id__in=record_ids,
    ).values("id", "table_id"):
        record_table_map[str(row["id"])] = str(row["table_id"])

    table_ids = {table_id for table_id in record_table_map.values() if table_id}
    field_key_maps_by_table: dict[str, dict[str, str]] = {}
    field_metadata_maps_by_table: dict[str, dict[str, dict[str, str]]] = {}
    if table_ids:
        for field in TableField.objects.using(TABDATA_DB_ALIAS).filter(
            table_id__in=table_ids,
        ).only("id", "table_id", "name", "field_type"):
            table_id = str(field.table_id)
            canonical = str(field.id)
            field_key_map = field_key_maps_by_table.setdefault(table_id, {})
            field_key_map[canonical] = canonical
            field_key_map[field.id.hex] = canonical
            field_metadata_map = field_metadata_maps_by_table.setdefault(table_id, {})
            metadata = {
                "name": field.name,
                "field_type": field.field_type,
            }
            field_metadata_map[canonical] = metadata
            field_metadata_map[field.id.hex] = metadata

    return (
        {
            record_id: field_key_maps_by_table.get(table_id, {})
            for record_id, table_id in record_table_map.items()
        },
        {
            record_id: field_metadata_maps_by_table.get(table_id, {})
            for record_id, table_id in record_table_map.items()
        },
    )


def _build_operation_out_from_history(history) -> HistoryOperationOut:
    """单条 ORM 历史 → HistoryOperationOut（仅在单条场景使用）。"""
    history_items = history.items.order_by('created_at', 'id')
    field_key_maps, field_metadata_maps = _load_field_maps_for_record_ids([history.record_id])
    record_id = str(history.record_id)
    field_key_map = field_key_maps.get(record_id, {})
    field_metadata_map = field_metadata_maps.get(record_id, {})
    return HistoryOperationOut(
        id=str(history.id),
        record_id=str(history.record_id),
        action=history.action,
        action_display=history.get_action_display(),
        field_changes=_normalize_history_field_changes(
            history.field_changes,
            field_key_map,
            field_metadata_map,
        ),
        items=_build_history_items_payload(history_items, field_key_map, field_metadata_map),
        user=HistoryOperationUser(
            id=history.user.id if history.user else None,
            name=history.user.get_display_name() if history.user else 'System'
        ) if history.user else None,
        created_at=history.created_at.isoformat(),
        is_undone=history.is_undone,
        undone_at=history.undone_at.isoformat() if history.undone_at else None,
        undone_by=HistoryOperationUser(
            id=history.undone_by.id if history.undone_by else None,
            name=history.undone_by.get_display_name() if history.undone_by else 'System'
        ) if history.undone_by else None,
        operation_group_id=str(history.operation_group_id) if history.operation_group_id else None,
        editor_type=normalize_editor_type_for_response(
            getattr(history, "editor_type", None) or "user"
        ),
    )


def _build_operations_batch(ops: list) -> list[HistoryOperationOut]:
    """
    批量构建 HistoryOperationOut，消除 N+1 查询。

    对 dict 直接走 _build_operation_out_from_dict；
    对 ORM RecordHistory 批量预加载 items 和 users（跨库）。
    """
    if not ops:
        return []

    dicts = []
    orm_objs = []
    order_map: dict[int, object] = {}  # 保留原始顺序
    for i, op in enumerate(ops):
        order_map[i] = op
        if isinstance(op, dict):
            dicts.append((i, op))
        else:
            orm_objs.append((i, op))

    result_map: dict[int, HistoryOperationOut] = {}
    record_field_key_maps, record_field_metadata_maps = _load_field_maps_for_record_ids(
        [
            op.get("record_id") if isinstance(op, dict) else getattr(op, "record_id", None)
            for op in ops
        ]
    )

    for i, op in dicts:
        record_id = str(op.get("record_id"))
        field_key_map = record_field_key_maps.get(record_id, {})
        field_metadata_map = record_field_metadata_maps.get(record_id, {})
        result_map[i] = _build_operation_out_from_dict(op, field_key_map, field_metadata_map)

    if orm_objs:
        from apps.tabdata.models import RecordHistoryItem
        from apps.tabdata.constants import TABDATA_DB_ALIAS
        from apps.users.auth.models import User

        histories = [h for _, h in orm_objs]
        history_by_id = {str(h.id): h for h in histories}

        # 批量加载 RecordHistoryItem
        history_ids = [h.id for h in histories]
        items_map: dict[str, list] = {}
        for row in RecordHistoryItem.objects.using(TABDATA_DB_ALIAS).filter(
            history_id__in=history_ids,
        ).order_by('created_at', 'id').values('history_id', 'field_key', 'before', 'after'):
            history = history_by_id.get(str(row['history_id']))
            field_key_map = (
                record_field_key_maps.get(str(history.record_id), {})
                if history
                else {}
            )
            field_metadata_map = (
                record_field_metadata_maps.get(str(history.record_id), {})
                if history
                else {}
            )
            canonical_key = _canonical_field_key(row['field_key'], field_key_map)
            metadata = field_metadata_map.get(canonical_key, {})
            if _is_hidden_history_field_type(metadata.get("field_type")):
                continue
            items_map.setdefault(str(row['history_id']), []).append(
                HistoryOperationItemOut(
                    field_key=canonical_key,
                    field_name=metadata.get("name"),
                    field_type=metadata.get("field_type"),
                    before=row.get('before'),
                    after=row.get('after'),
                )
            )

        # 批量加载用户（跨库 MySQL）
        all_user_ids = set()
        for h in histories:
            if h.user_id:
                all_user_ids.add(h.user_id)
            if h.is_undone and getattr(h, 'undone_by_id', None):
                all_user_ids.add(h.undone_by_id)
        user_map: dict = {}
        if all_user_ids:
            try:
                for u in User.objects.filter(id__in=all_user_ids):
                    user_map[u.id] = u
            except Exception:
                pass

        def _user_out(user_id):
            if not user_id:
                return None
            u = user_map.get(user_id)
            if u:
                return HistoryOperationUser(
                    id=u.id,
                    name=u.get_display_name() if hasattr(u, 'get_display_name') else str(u),
                )
            return HistoryOperationUser(id=user_id, name=f'User#{user_id}')

        for i, h in orm_objs:
            field_key_map = record_field_key_maps.get(str(h.record_id), {})
            field_metadata_map = record_field_metadata_maps.get(str(h.record_id), {})
            result_map[i] = HistoryOperationOut(
                id=str(h.id),
                record_id=str(h.record_id),
                action=h.action,
                action_display=h.get_action_display(),
                field_changes=_normalize_history_field_changes(
                    h.field_changes,
                    field_key_map,
                    field_metadata_map,
                ),
                items=items_map.get(str(h.id), []),
                user=_user_out(h.user_id),
                created_at=h.created_at.isoformat(),
                is_undone=h.is_undone,
                undone_at=h.undone_at.isoformat() if h.undone_at else None,
                undone_by=_user_out(getattr(h, 'undone_by_id', None)) if h.is_undone else None,
                operation_group_id=str(h.operation_group_id) if h.operation_group_id else None,
                editor_type=normalize_editor_type_for_response(
                    getattr(h, "editor_type", None) or "user"
                ),
            )

    return [result_map[i] for i in range(len(ops))]


def _build_operation_out_from_dict(
    op: dict,
    field_key_map: dict[str, str] | None = None,
    field_metadata_map: dict[str, dict[str, str]] | None = None,
) -> HistoryOperationOut:
    operation = HistoryOperationOut(
        id=op['id'],
        record_id=op['record_id'],
        action=op['action'],
        action_display=op['action_display'],
        field_changes=_normalize_history_field_changes(
            op['field_changes'],
            field_key_map,
            field_metadata_map,
        ),
        items=_build_history_items_payload(
            op.get('items') or [],
            field_key_map,
            field_metadata_map,
        ),
        user=HistoryOperationUser(**op['user']) if op.get('user') else None,
        created_at=op['created_at'],
        is_undone=op['is_undone'],
        undone_at=op.get('undone_at'),
        operation_group_id=op.get('operation_group_id'),
        editor_type=normalize_editor_type_for_response(
            op.get("editor_type") or "user"
        ),
    )

    if op['is_undone'] and op.get('undone_by'):
        operation.undone_by = HistoryOperationUser(**op['undone_by'])

    return operation


def _build_operation_out(op: object) -> HistoryOperationOut:
    if isinstance(op, dict):
        return _build_operation_out_from_dict(op)
    return _build_operation_out_from_history(op)


def _build_history_user_map(operations: list[HistoryOperationOut]) -> dict[str, HistoryOperationUser] | None:
    user_map: dict[str, HistoryOperationUser] = {}
    for operation in operations:
        if operation.user and operation.user.id is not None:
            user_map[str(operation.user.id)] = operation.user
        if operation.undone_by and operation.undone_by.id is not None:
            user_map[str(operation.undone_by.id)] = operation.undone_by
    return user_map or None


# ============ 记录级别撤销/重做 ============

@router.post(
    "/records/{record_id}/undo",
    response={200: UndoRedoResponse, 400: dict, 403: dict, 404: dict, 409: dict, 500: ErrorResponse},
    auth=jwt_auth,
    summary="撤销记录的最后一次操作",
    description="撤销指定记录的最后一次操作，支持只撤销当前用户的操作"
)
@api_error_handler
def undo_record_operation(
    request: HttpRequest,
    record_id: UUID,
    payload: UndoRequest = UndoRequest()
):
    """
    撤销记录的最后一次操作

    - 撤销成功后，可以通过重做功能恢复
    - 支持只撤销当前用户的操作（协作场景）
    """
    try:
        service = UndoRedoService(user=request.auth, window_id=_resolve_window_id(request))
        try:
            success, error_msg, history = service.undo_record_operation(
                record_id=record_id,
                only_my_operations=payload.only_my_operations
            )
        except FieldRestoreNotSupportedError as exc:
            return _field_restore_not_supported_response(exc)

        if not success:
            return error_response(ErrorCode.UNDO_FAILED, error_msg or "撤销失败")

        operation_out = None
        if history:
            operation_out = _build_operation_out_from_history(history)

        return 200, UndoRedoResponse(
            success=True,
            message=_("tabdata.undo_success"),
            operation=operation_out
        )

    except ObjectDoesNotExist:
        return not_found_response("记录")


@router.post(
    "/records/{record_id}/redo",
    response={200: UndoRedoResponse, 400: dict, 403: dict, 404: dict, 500: ErrorResponse},
    auth=jwt_auth,
    summary="重做记录的最后一次撤销操作",
    description="重做指定记录的最后一次撤销操作"
)
@api_error_handler
def redo_record_operation(
    request: HttpRequest,
    record_id: UUID,
    payload: RedoRequest = RedoRequest()
):
    """
    重做记录的最后一次撤销操作

    - 只能重做已经撤销的操作
    - 支持只重做当前用户撤销的操作
    """
    try:
        service = UndoRedoService(user=request.auth, window_id=_resolve_window_id(request))
        success, error_msg, history = service.redo_record_operation(
            record_id=record_id,
            only_my_operations=payload.only_my_operations
        )

        if not success:
            return error_response(ErrorCode.REDO_FAILED, error_msg or "重做失败")

        operation_out = None
        if history:
            operation_out = _build_operation_out_from_history(history)

        return 200, UndoRedoResponse(
            success=True,
            message=_("tabdata.redo_success"),
            operation=operation_out
        )

    except ObjectDoesNotExist:
        return not_found_response("记录")


# ============ 表格级别撤销/重做 ============

@router.post(
    "/tables/{table_id}/undo",
    response={200: BatchUndoRedoResponse, 400: dict, 403: dict, 404: dict, 409: dict, 500: ErrorResponse},
    auth=jwt_auth,
    summary="撤销表格的最后一次操作",
    description="撤销指定表格的最后一次操作（可能涉及多条记录）。"
                "关联字段撤销返回 409 + 引导版本历史文案。"
)
@api_error_handler
def undo_table_operation(
    request: HttpRequest,
    table_id: UUID,
    payload: UndoRequest = UndoRequest()
):
    """
    撤销表格的最后一次操作

    - 如果是批量操作，会整体撤销
    - 支持只撤销当前用户的操作
    - C1 / Wave 1.3：撤销删除复杂字段时返回 HTTP 409 + ``FIELD_RESTORE_NOT_SUPPORTED``
    """
    try:
        service = UndoRedoService(user=request.auth, window_id=_resolve_window_id(request))
        try:
            success, error_msg, histories = service.undo_table_operation(
                table_id=table_id,
                only_my_operations=payload.only_my_operations
            )
        except FieldRestoreNotSupportedError as exc:
            return _field_restore_not_supported_response(exc)

        if not success:
            # 栈为空 → NO_UNDO_OPERATIONS（中性提示）；其余是真正执行失败 →
            # UNDO_FAILED + 具体原因，前端据 code 分别展示，不再一律"撤销失败"。
            if error_msg == NO_UNDO_OPERATIONS_MSG:
                return error_response(ErrorCode.NO_UNDO_OPERATIONS, error_msg)
            return error_response(ErrorCode.UNDO_FAILED, error_msg or "撤销失败")

        # 根因 #4：字段/视图结构撤销后同步 collab-live，
        # 否则内存 Y.Doc 的过期 meta 会被回写，把刚恢复的字段再删一次。
        if _histories_touch_schema_meta(histories):
            _resync_collab_after_schema_change(table_id)

        operations = _build_operations_batch(histories)

        return 200, BatchUndoRedoResponse(
            success=True,
            message=_("tabdata.batch_undo_success", count=len(operations)),
            operations=operations,
            count=len(operations)
        )

    except ObjectDoesNotExist:
        return not_found_response("表格")


@router.post(
    "/tables/{table_id}/redo",
    response={200: BatchUndoRedoResponse, 400: dict, 403: dict, 404: dict, 409: dict, 500: ErrorResponse},
    auth=jwt_auth,
    summary="重做表格的最后一次撤销操作",
    description="重做指定表格的最后一次撤销操作（可能涉及多条记录）"
)
@api_error_handler
def redo_table_operation(
    request: HttpRequest,
    table_id: UUID,
    payload: RedoRequest = RedoRequest()
):
    """
    重做表格的最后一次撤销操作

    - 如果是批量操作，会整体重做
    - 支持只重做当前用户撤销的操作
    """
    try:
        service = UndoRedoService(user=request.auth, window_id=_resolve_window_id(request))
        try:
            success, error_msg, histories = service.redo_table_operation(
                table_id=table_id,
                only_my_operations=payload.only_my_operations
            )
        except FieldRestoreNotSupportedError as exc:
            return _field_restore_not_supported_response(exc)

        if not success:
            if error_msg == NO_REDO_OPERATIONS_MSG:
                return error_response(ErrorCode.NO_REDO_OPERATIONS, error_msg)
            return error_response(ErrorCode.REDO_FAILED, error_msg or "重做失败")

        # 根因 #4：字段/视图结构重做同样需要同步 collab-live，
        # 例如 CREATE_FIELDS redo 重新建列、DELETE_FIELDS redo 删列。
        if _histories_touch_schema_meta(histories):
            _resync_collab_after_schema_change(table_id)

        operations = _build_operations_batch(histories)

        return 200, BatchUndoRedoResponse(
            success=True,
            message=_("tabdata.batch_redo_success", count=len(operations)),
            operations=operations,
            count=len(operations)
        )

    except ObjectDoesNotExist:
        return not_found_response("表格")


# ============ 操作栈查询 ============

@router.get(
    "/tables/{table_id}/undo-stack",
    response={200: UndoStackResponse, 403: dict, 404: dict, 500: ErrorResponse},
    auth=jwt_auth,
    summary="获取表格的撤销栈",
    description="获取指定表格可以撤销的操作列表"
)
@api_error_handler
def get_undo_stack(
    request: HttpRequest,
    table_id: UUID,
    only_my_operations: bool = False,
    limit: int = 20
):
    """
    获取表格的撤销栈

    - 返回可以撤销的操作列表
    - 支持只显示当前用户的操作
    - 按时间倒序排列（最新的在前）
    """
    try:
        service = UndoRedoService(user=request.auth, window_id=_resolve_window_id(request))
        operations_data, total = service.get_undo_stack_page(
            table_id=table_id,
            only_my_operations=only_my_operations,
            limit=min(limit, 100)
        )

        operations = _build_operations_batch(operations_data)

        return 200, UndoStackResponse(
            operations=operations,
            total=total
        )

    except ObjectDoesNotExist:
        return not_found_response("表格")


@router.get(
    "/tables/{table_id}/redo-stack",
    response={200: RedoStackResponse, 403: dict, 404: dict, 500: ErrorResponse},
    auth=jwt_auth,
    summary="获取表格的重做栈",
    description="获取指定表格可以重做的操作列表"
)
@api_error_handler
def get_redo_stack(
    request: HttpRequest,
    table_id: UUID,
    only_my_operations: bool = False,
    limit: int = 20
):
    """
    获取表格的重做栈

    - 返回可以重做的操作列表（已撤销的）
    - 支持只显示当前用户撤销的操作
    - 按撤销时间倒序排列（最新撤销的在前）
    """
    try:
        service = UndoRedoService(user=request.auth, window_id=_resolve_window_id(request))
        operations_data, total = service.get_redo_stack_page(
            table_id=table_id,
            only_my_operations=only_my_operations,
            limit=min(limit, 100)
        )

        operations = _build_operations_batch(operations_data)

        return 200, RedoStackResponse(
            operations=operations,
            total=total
        )

    except ObjectDoesNotExist:
        return not_found_response("表格")


# ============ 记录历史查询 ============

@router.get(
    "/records/{record_id}/history",
    response={200: RecordHistoryResponse, 403: dict, 404: dict, 500: ErrorResponse},
    auth=jwt_auth,
    summary="获取记录的完整历史",
    description="获取指定记录的完整操作历史（包括已撤销的）"
)
@api_error_handler
def get_record_history(
    request: HttpRequest,
    record_id: UUID,
    cursor: str = None,
    startDate: str = None,
    endDate: str = None,
    include_undone: bool = True,
    limit: int = 50
):
    """
    获取记录的完整历史

    - 返回记录的所有操作历史
    - 可以选择是否包含已撤销的操作
    - 按时间倒序排列
    """
    try:
        service = UndoRedoService(user=request.auth, window_id=_resolve_window_id(request))
        operations_data, total, next_cursor = service.get_record_history_page(
            record_id=record_id,
            cursor=cursor,
            start_date=startDate,
            end_date=endDate,
            include_undone=include_undone,
            limit=min(limit, 200)
        )

        operations = _build_operations_batch(operations_data)
        user_map = _build_history_user_map(operations)

        return 200, RecordHistoryResponse(
            operations=operations,
            history_list=operations,
            user_map=user_map,
            total=total,
            next_cursor=next_cursor
        )

    except ObjectDoesNotExist:
        return not_found_response("记录")


@router.get(
    "/tables/{table_id}/history",
    response={200: TableHistoryResponse, 403: dict, 404: dict, 500: ErrorResponse},
    auth=jwt_auth,
    summary="获取表格范围内的完整历史",
    description="获取指定表格内所有记录的操作历史（包括已撤销的）"
)
@api_error_handler
def get_table_history(
    request: HttpRequest,
    table_id: UUID,
    cursor: str = None,
    startDate: str = None,
    endDate: str = None,
    include_undone: bool = True,
    only_my_operations: bool = False,
    limit: int = 50
):
    """
    获取表格范围内的完整历史

    - 返回整个表格的历史操作（跨记录）
    - 可以选择是否包含已撤销的操作
    - 支持仅查看当前用户操作
    - 按时间倒序排列
    """
    try:
        service = UndoRedoService(user=request.auth, window_id=_resolve_window_id(request))
        operations_data, total, next_cursor = service.get_table_history_page(
            table_id=table_id,
            cursor=cursor,
            start_date=startDate,
            end_date=endDate,
            include_undone=include_undone,
            only_my_operations=only_my_operations,
            limit=min(limit, 200)
        )

        operations = _build_operations_batch(operations_data)
        user_map = _build_history_user_map(operations)

        return 200, TableHistoryResponse(
            operations=operations,
            history_list=operations,
            user_map=user_map,
            total=total,
            next_cursor=next_cursor
        )

    except ObjectDoesNotExist:
        return not_found_response("表格")


@router.get(
    "/records/{record_id}/snapshot",
    response={200: RecordSnapshotResponse, 400: dict, 404: dict, 500: ErrorResponse},
    auth=jwt_auth,
    summary="获取记录的历史快照",
    description="重建记录在指定历史时间点的完整状态"
)
@api_error_handler
def get_record_snapshot(
    request: HttpRequest,
    record_id: UUID,
    history_id: str = None,
):
    """
    获取记录在指定历史时间点的快照。

    通过反向回溯 RecordHistoryItem 来重建记录的历史状态。
    """
    if not history_id:
        return validation_error_response("history_id 参数必填")

    try:
        service = UndoRedoService(user=request.auth, window_id=_resolve_window_id(request))
        snapshot = service.reconstruct_record_at_history(
            record_id=record_id,
            history_id=UUID(history_id),
        )

        if snapshot is None:
            return not_found_response("记录")

        return 200, RecordSnapshotResponse(
            record_id=str(record_id),
            history_id=history_id,
            snapshot=snapshot,
        )

    except ValueError:
        return validation_error_response("无效的 history_id 格式")
    except ObjectDoesNotExist:
        return not_found_response("记录")


def _try_snapshot_from_version_history(table_id: UUID, history_uuid: UUID):
    """当 RecordHistory 查不到时，尝试从 VersionHistory.blob 读取快照。"""
    try:
        from apps.collab.models import VersionHistory
        from apps.collab.adapters.table import TableCollabAdapter

        vh = (
            VersionHistory.objects.using("postgresql")
            .filter(id=history_uuid, resource_type="table", resource_id=table_id)
            .only("id", "blob", "blob_size")
            .first()
        )
        if not vh or not vh.blob:
            return None

        adapter = TableCollabAdapter()
        data = adapter.deserialize_snapshot(vh.blob)
        if not isinstance(data, dict):
            return None

        records = data.get("records", {})
        row_order = data.get("row_order", [])

        ordered_ids = list(row_order) if row_order else sorted(records.keys())
        snapshot_rows = []
        for idx, record_id in enumerate(ordered_ids):
            record_data = records.get(record_id)
            if record_data is None:
                continue
            snapshot_rows.append({
                "record_id": record_id,
                "row_id": record_id,
                "order": float(idx),
                "data": record_data if isinstance(record_data, dict) else {},
            })
        return snapshot_rows
    except Exception:
        import logging
        logging.getLogger(__name__).warning(
            "VH blob fallback failed: table=%s vh=%s", table_id, history_uuid, exc_info=True,
        )
        return None


def _normalize_record_field_keys(raw: dict, hex_by_alias: dict) -> dict:
    """把 reconstruct 行数据的字段 key 归一到 build_snapshot 使用的 id_hex。"""
    normalized = {}
    for key, value in (raw or {}).items():
        key_str = str(key)
        nk = hex_by_alias.get(key_str) or hex_by_alias.get(key_str.replace("-", "")) or key_str
        if isinstance(nk, str) and len(nk) == 36 and nk.count("-") == 4:
            nk = nk.replace("-", "")
        normalized[nk] = value
    return normalized


def _version_data_from_history_id(
    table_id: UUID,
    history_uuid: UUID,
    *,
    user,
    window_id: str | None,
) -> tuple[dict | None, str | None, bool]:
    """
    ：从选中历史构造命名版本要用的 version data。

    Returns:
        (data, source_history_id, set_legacy_history_id)
        set_legacy_history_id=True 表示来源是 RecordHistory/ChangeLog，
        可写入 metadata.legacy_history_id 以便时间线对齐。
    """
    from apps.collab.adapters.table import TableCollabAdapter
    from apps.collab.models import VersionHistory
    from apps.tabdata.services.collab_service import CollabService as TableCollabService

    vh = (
        VersionHistory.objects.using("postgresql")
        .filter(id=history_uuid, resource_type="table", resource_id=table_id)
        .only("id", "blob", "blob_size")
        .first()
    )
    if vh and vh.blob:
        data = TableCollabAdapter().deserialize_snapshot(vh.blob)
        if isinstance(data, dict) and isinstance(data.get("records"), dict):
            return data, str(vh.id), False

    service = UndoRedoService(user=user, window_id=window_id)
    rows = service.reconstruct_table_at_history(
        table_id=table_id,
        history_id=history_uuid,
        include_target_deleted_records=False,
    )
    if rows is None:
        return None, None, False

    base = TableCollabService.build_snapshot(str(table_id), include_deleted_fields=True)
    hex_by_alias: dict[str, str] = {}
    for field in base.get("fields") or []:
        if not isinstance(field, dict):
            continue
        fid = str(field.get("id") or "")
        id_hex = str(field.get("id_hex") or (fid.replace("-", "") if fid else ""))
        if not fid or not id_hex:
            continue
        hex_by_alias[fid] = id_hex
        hex_by_alias[id_hex] = id_hex
        hex_by_alias[fid.replace("-", "")] = id_hex

    records: dict[str, dict] = {}
    row_order: list[str] = []
    for item in rows:
        if item.get("is_deleted"):
            continue
        rid = str(item.get("record_id") or "")
        if not rid:
            continue
        raw = item.get("data") if isinstance(item.get("data"), dict) else {}
        records[rid] = _normalize_record_field_keys(raw, hex_by_alias)
        row_order.append(rid)

    base["records"] = records
    base["row_order"] = row_order
    # 避免沿用当前表 total_records，导致命名版本 metadata.record_count 虚高
    base["total_records"] = len(records)
    return base, str(history_uuid), True


@router.get(
    "/tables/{table_id}/snapshot",
    response={200: TableSnapshotResponse, 400: dict, 404: dict, 500: ErrorResponse},
    auth=jwt_auth,
    summary="获取表格的历史快照",
    description="重建表格在指定历史时间点的完整状态"
)
@api_error_handler
def get_table_snapshot(
    request: HttpRequest,
    table_id: UUID,
    history_id: str = None,
    max_rows: int = 500,
):
    """
    获取表格在指定历史时间点的快照。

    支持两种来源：
    1. RecordHistory 反向回放（传统 history_id）
    2. VersionHistory blob 直接读取（VH 命名版本等）
    """
    if not history_id:
        return validation_error_response("history_id 参数必填")

    safe_max_rows = max(1, min(int(max_rows or 500), 10000))

    try:
        history_uuid = UUID(history_id)
    except ValueError:
        return validation_error_response("无效的 history_id 格式")

    try:
        # ：若 history_id 本身就是带 blob 的 VersionHistory（命名版本），
        # 优先读独立 blob，避免被共用的 legacy RecordHistory 锚点「抢答」成同一份内容。
        snapshot = _try_snapshot_from_version_history(table_id, history_uuid)
        if snapshot is None:
            service = UndoRedoService(user=request.auth, window_id=_resolve_window_id(request))
            snapshot = service.reconstruct_table_at_history(
                table_id=table_id,
                history_id=history_uuid,
                include_target_deleted_records=True,
            )

        if snapshot is None:
            return not_found_response("表格")

        is_truncated = len(snapshot) > safe_max_rows
        if is_truncated:
            snapshot = snapshot[:safe_max_rows]

        return 200, TableSnapshotResponse(
            table_id=str(table_id),
            history_id=history_id,
            snapshot=[
                TableSnapshotRecordOut(
                    record_id=item["record_id"],
                    row_id=item.get("row_id") or item["record_id"],
                    order=float(item.get("order") or 0.0),
                    is_deleted=bool(item.get("is_deleted", False)),
                    data=item.get("data") or {},
                )
                for item in snapshot
            ],
            total=len(snapshot),
            is_truncated=is_truncated,
        )

    except ObjectDoesNotExist:
        return not_found_response("表格")


@router.post(
    "/records/{record_id}/restore-history",
    response={200: RestoreRecordResponse, 400: dict, 403: dict, 404: dict, 500: ErrorResponse},
    auth=jwt_auth,
    summary="还原记录到指定历史版本",
    description="将记录的数据恢复到指定历史时间点的状态"
)
@api_error_handler
def restore_record_to_history(
    request: HttpRequest,
    record_id: UUID,
    payload: RestoreRecordRequest,
):
    """
    还原记录到指定历史版本。

    此操作本身也会产生一条新的历史记录，可以被撤销。
    """
    try:
        service = UndoRedoService(user=request.auth, window_id=_resolve_window_id(request))
        result = service.restore_record_to_history(
            record_id=record_id,
            history_id=UUID(payload.history_id),
        )

        if result is None:
            return not_found_response("记录")

        changed_fields = len(list(result.keys()))

        return 200, RestoreRecordResponse(
            record_id=str(record_id),
            data=result,
            changed_fields=changed_fields,
        )

    except ValueError:
        return validation_error_response("无效的 history_id 格式")
    except ObjectDoesNotExist:
        return not_found_response("记录")


@router.post(
    "/tables/{table_id}/history-restore",
    response={200: RestoreTableResponse, 400: dict, 403: dict, 404: dict, 500: ErrorResponse},
    auth=jwt_auth,
    summary="还原表格到指定历史版本",
    description="将整张表格恢复到指定历史时间点的状态"
)
@api_error_handler
def restore_table(
    request: HttpRequest,
    table_id: UUID,
    payload: RestoreTableRequest,
):
    """
    还原表格到指定历史版本。
    """
    try:
        from apps.tabdata.models import RecordHistory
        from apps.tabdata.constants import TABDATA_DB_ALIAS
        from apps.collab.models import ChangeLog

        target_history_id = UUID(payload.history_id)

        # DV-021: 提前检测 history_id 是否仍有效（可能被 TTL 清理）
        history_exists = RecordHistory.objects.using(TABDATA_DB_ALIAS).filter(
            id=target_history_id,
            record__table_id=table_id,
        ).exists()
        if not history_exists:
            history_exists = ChangeLog.objects.using("postgresql").filter(
                id=target_history_id,
                resource_type="table",
                resource_id=table_id,
                change_type__in=[
                    "create_field",
                    "batch_create_fields",
                    "update_field",
                    "delete_field",
                    "convert_field_type",
                    "reorder_fields",
                    "restore",
                ],
            ).exists()

        # ：命名版本预览/还原统一传 VH id；无 RecordHistory 时走 VH blob 还原
        if not history_exists:
            from apps.collab.models import VersionHistory
            from apps.collab.service import RestoreError, VersionHistoryService

            vh = (
                VersionHistory.objects.using("postgresql")
                .filter(
                    id=target_history_id,
                    resource_type="table",
                    resource_id=table_id,
                )
                .first()
            )
            if not vh or not vh.blob:
                return error_response(
                    ErrorCode.RESTORE_FAILED,
                    _("tabdata.history_expired", default="历史记录已过期或被清理，无法还原到该版本"),
                )

            adapter = _get_table_adapter()
            resource = adapter.get_resource(str(table_id))
            if not resource:
                return not_found_response("表格")
            if not adapter.check_permission(request.auth, resource, "edit"):
                return permission_denied_response("无权还原")

            editor_info = _get_vh_editor_info(request)
            organization_id = getattr(resource, "organization_id", None) or getattr(
                resource, "team_id", None
            )
            svc = VersionHistoryService(adapter)
            try:
                restored = svc.restore_to_version(
                    table_id,
                    target_history_id,
                    editor_info,
                    resource=resource,
                    target=vh,
                    organization_id=organization_id,
                    user=request.auth,
                )
            except RestoreError as exc:
                return error_response(
                    ErrorCode.RESTORE_FAILED,
                    str(exc) or "还原失败",
                )
            if restored is None:
                return error_response(
                    ErrorCode.RESTORE_FAILED,
                    _("tabdata.history_expired", default="历史记录已过期或被清理，无法还原到该版本"),
                )

            sync_mode = _resync_collab_after_history_restore(table_id)
            return 200, RestoreTableResponse(
                table_id=str(table_id),
                history_id=payload.history_id,
                changed_records=1,
                changed_histories=0,
                changed_fields=0,
                operation_group_id=None,
                sync_mode=sync_mode,
            )

        service = UndoRedoService(user=request.auth, window_id=_resolve_window_id(request))
        result = service.restore_table_to_history(
            table_id=table_id,
            history_id=target_history_id,
        )

        if result is None:
            return not_found_response("表格")
        if result.get("field_restore_error"):
            return error_response(
                ErrorCode.RESTORE_FAILED,
                str(result.get("field_restore_error") or "恢复字段失败"),
            )
        if result.get("restore_error"):
            return error_response(
                ErrorCode.RESTORE_FAILED,
                str(result.get("restore_error") or "还原失败"),
            )

        changed_records = int(result.get("changed_records") or 0)
        changed_histories = int(result.get("changed_histories") or 0)
        changed_fields = int(result.get("changed_fields") or 0)
        skipped_records = result.get("skipped_records") or []
        sync_mode = "none"

        if changed_records > 0 or changed_fields > 0:
            # : 优先 Yjs 增量重同步；把实际模式透给前端，resync 成功后不得重复重连。
            sync_mode = _resync_collab_after_history_restore(table_id)

        try:
            from apps.collab.models import ChangeLog
            # QC-05 / B-1：restore 通常由用户发起，但若由 Agent 代理用户操作
            # （例如「帮我回到 v3」），ContextVar 中仍可能携带 agent_run_id /
            # session_id；W0-2 audit §3.4.1 要求二者一并写入，否则
            # TableResourceContributor 反查 turn 涉及资源时会漏掉本次 restore。
            _restore_agent_run_id = ""
            _restore_session_id = ""
            try:
                from apps.services.common.platform_context import (
                    get_current_run_id, get_current_session_id,
                )
                _restore_agent_run_id = get_current_run_id() or ""
                _restore_session_id = get_current_session_id() or ""
            except Exception:
                pass
            ChangeLog.objects.using("postgresql").create(
                resource_type="table",
                resource_id=table_id,
                change_type="restore",
                summary=f"还原到版本 {payload.history_id[:8]}",
                changes={
                    "history_id": str(target_history_id),
                    "changed_records": changed_records,
                    "changed_fields": changed_fields,
                    "operation_group_id": result.get("operation_group_id"),
                },
                editor_type="user",
                editor_id=str(request.auth.id),
                editor_name=getattr(request.auth, 'nickname', '') or '',
                agent_run_id=_restore_agent_run_id,
                session_id=_restore_session_id,
            )
        except Exception:
            import logging as _logging
            _logging.getLogger(__name__).warning(
                "[restore_table] ChangeLog 写入失败: table=%s", table_id, exc_info=True,
            )

        response = RestoreTableResponse(
            table_id=str(table_id),
            history_id=payload.history_id,
            changed_records=changed_records,
            changed_histories=changed_histories,
            changed_fields=changed_fields,
            operation_group_id=result.get("operation_group_id"),
            sync_mode=sync_mode,
        )

        if skipped_records:
            import logging as _logging
            _logging.getLogger(__name__).warning(
                "[restore_table] %d 条记录因物理删除被跳过: table=%s, skipped=%s",
                len(skipped_records), table_id, skipped_records[:10],
            )

        return 200, response

    except ValueError:
        return validation_error_response("无效的 history_id 格式")
    except ObjectDoesNotExist:
        return not_found_response("表格")


# ============ 命名版本（手动保存）============
# [DEPRECATED] 以下端点已迁移到统一 Collab VH API。
# 保留用于向后兼容，内部转发到 VersionHistoryService。
# 前端应迁移到 /api/collab/table/{table_id}/versions?named_only=true


def _get_vh_editor_info(request: HttpRequest) -> dict:
    """从请求中提取 VersionHistoryService 需要的 editor_info。"""
    return {
        "editor_type": "user",
        "editor_id": str(request.auth.id),
        "editor_name": getattr(request.auth, "nickname", "") or str(request.auth.id)[:8],
    }


def _get_table_adapter():
    from apps.collab.registry import get_adapter_or_raise
    return get_adapter_or_raise("table")


def _vh_to_named_version_dict(vh) -> dict:
    """将 VersionHistory ORM 实例或 serialize_history_item dict 转换为前端兼容的命名版本格式。"""
    if isinstance(vh, dict):
        return {
            "id": vh.get("id", ""),
            "table_id": "",
            "history_id": None,
            "history_valid": True,
            "snapshot_at": vh.get("created_at"),
            "name": vh.get("name", ""),
            "created_by": vh.get("editor_id") or None,
            "created_at": vh.get("created_at"),
        }
    metadata = vh.metadata or {}
    legacy_history_id = metadata.get("legacy_history_id")
    snapshot_at = metadata.get("snapshot_at") or (
        vh.created_at.isoformat() if vh.created_at else None
    )
    # 新建的 VH 命名版本（非迁移）没有 legacy_history_id，blob 始终有效
    history_valid = True
    if legacy_history_id:
        history_valid = bool(vh.blob and vh.blob_size > 0)
    return {
        "id": str(vh.id),
        "table_id": str(vh.resource_id),
        "history_id": legacy_history_id,
        "history_valid": history_valid,
        "snapshot_at": snapshot_at,
        "name": vh.name or "",
        "created_by": vh.editor_id or None,
        "created_at": vh.created_at.isoformat() if vh.created_at else None,
    }


@router.get(
    "/tables/{table_id}/named-versions",
    response={200: dict, 400: dict, 403: dict, 500: ErrorResponse},
    auth=jwt_auth,
    summary="[Deprecated] 列出表格命名版本 → 转发到 VH API",
    deprecated=True,
)
@api_error_handler
def list_table_named_versions(
    request: HttpRequest,
    table_id: UUID,
    limit: int = 50,
):
    """列出表格的命名版本（已迁移到 VH，此端点保留向后兼容）"""
    try:
        from apps.collab.models import VersionHistory

        adapter = _get_table_adapter()
        resource = adapter.get_resource(str(table_id))
        if not resource:
            return not_found_response("表格")

        if not adapter.check_permission(request.auth, resource, "view"):
            return permission_denied_response("无权访问")

        qs = (
            VersionHistory.objects.using("postgresql")
            .filter(resource_type="table", resource_id=table_id, is_named=True)
            .order_by("-created_at")[:min(limit, 200)]
        )
        result = [_vh_to_named_version_dict(vh) for vh in qs]
        return 200, success_response({"versions": result})
    except ObjectDoesNotExist:
        return not_found_response("表格")


@router.post(
    "/tables/{table_id}/named-versions",
    response={200: dict, 400: dict, 403: dict, 500: ErrorResponse},
    auth=jwt_auth,
    summary="[Deprecated] 创建表格命名版本 → 转发到 VH API",
    deprecated=True,
)
@api_error_handler
def create_table_named_version(
    request: HttpRequest,
    table_id: UUID,
    payload: CreateTableNamedVersionRequest,
):
    """创建命名版本（已迁移到 VH，此端点保留向后兼容）"""
    try:
        from apps.collab.service import VersionHistoryService

        adapter = _get_table_adapter()
        resource = adapter.get_resource(str(table_id))
        if not resource:
            return not_found_response("表格")

        if not adapter.check_permission(request.auth, resource, "edit"):
            return permission_denied_response("无权保存版本")

        source_history_id = None
        set_legacy = False
        history_id_raw = (payload.history_id or "").strip()
        if history_id_raw:
            # ：保存侧栏正在预览的历史快照，而非默默拍当前表
            try:
                history_uuid = UUID(history_id_raw)
            except ValueError:
                return validation_error_response("无效的 history_id 格式")
            data, source_history_id, set_legacy = _version_data_from_history_id(
                table_id,
                history_uuid,
                user=request.auth,
                window_id=_resolve_window_id(request),
            )
            if data is None:
                return not_found_response("历史记录")
        else:
            data = adapter.get_version_data(resource)

        editor_info = _get_vh_editor_info(request)
        svc = VersionHistoryService(adapter)
        organization_id = getattr(resource, "organization_id", None) or getattr(resource, "team_id", None)
        extra_metadata = {}
        if source_history_id:
            extra_metadata["source_history_id"] = source_history_id
            if set_legacy:
                extra_metadata["legacy_history_id"] = source_history_id
        vh = svc.create_history(
            table_id,
            data,
            editor_info,
            force_snapshot=True,
            is_named=True,
            name=payload.name or "",
            organization_id=organization_id,
            extra_metadata=extra_metadata or None,
        )
        if not vh:
            return permission_denied_response("无权保存版本或表格不存在")

        return 200, success_response({"version": _vh_to_named_version_dict(vh)})
    except ObjectDoesNotExist:
        return not_found_response("表格")


@router.patch(
    "/tables/{table_id}/named-versions/{version_id}",
    response={200: dict, 400: dict, 403: dict, 404: dict, 500: ErrorResponse},
    auth=jwt_auth,
    summary="[Deprecated] 重命名表格命名版本 → 转发到 VH API",
    deprecated=True,
)
@api_error_handler
def rename_table_named_version(
    request: HttpRequest,
    table_id: UUID,
    version_id: UUID,
    payload: RenameTableNamedVersionRequest,
):
    """修改命名版本的名称（已迁移到 VH，此端点保留向后兼容）"""
    try:
        from apps.collab.models import VersionHistory

        adapter = _get_table_adapter()
        resource = adapter.get_resource(str(table_id))
        if not resource:
            return not_found_response("表格")
        if not adapter.check_permission(request.auth, resource, "edit"):
            return permission_denied_response("无权操作")

        vh = VersionHistory.objects.using("postgresql").filter(
            id=version_id, resource_type="table", resource_id=table_id,
            is_named=True,
        ).first()
        if not vh:
            return not_found_response("版本")

        vh.name = (payload.name or "").strip()
        vh.save(using="postgresql", update_fields=["name"])
        return 200, success_response({"version": _vh_to_named_version_dict(vh)})
    except ObjectDoesNotExist:
        return not_found_response("版本")


@router.delete(
    "/tables/{table_id}/named-versions/{version_id}",
    response={200: dict, 400: dict, 403: dict, 404: dict, 500: ErrorResponse},
    auth=jwt_auth,
    summary="[Deprecated] 删除表格命名版本 → 转发到 VH API",
    deprecated=True,
)
@api_error_handler
def delete_table_named_version(
    request: HttpRequest,
    table_id: UUID,
    version_id: UUID,
):
    """删除命名版本（已迁移到 VH，此端点保留向后兼容）"""
    try:
        from apps.collab.models import VersionHistory

        adapter = _get_table_adapter()
        resource = adapter.get_resource(str(table_id))
        if not resource:
            return not_found_response("表格")
        if not adapter.check_permission(request.auth, resource, "edit"):
            return permission_denied_response("无权操作")

        deleted, _ = VersionHistory.objects.using("postgresql").filter(
            id=version_id, resource_type="table", resource_id=table_id,
            is_named=True,
        ).delete()
        if not deleted:
            return not_found_response("版本")
        return 200, success_response({"deleted": True})
    except ObjectDoesNotExist:
        return not_found_response("版本")
