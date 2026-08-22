from django.conf import settings
"""
TabData Collab Adapter

TabData 的数据是关系型（Table + TableField + TableRecord），不是单一 JSON。
快照格式为 build_snapshot 返回的 dict（含 fields/records/row_order）。
当前使用全量快照，增量 diff 待后续实现。
"""
import copy
import json
import logging
import zlib
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Optional
from uuid import UUID

from .base import CollabAdapter

logger = logging.getLogger("collab.adapters.table")

DB = ('default' if getattr(settings, 'TABTIN_SINGLE_DATABASE_MODE', False) else 'postgresql')
def _snapshot_json_default(obj):
    """VH-003/VH-008: 替代 default=str 的类型感知 JSON 序列化。

    对已知非 JSON 原生类型做明确转换并保持语义，
    对未知类型记录 warning 后兜底 str()。
    """
    if isinstance(obj, datetime):
        return obj.isoformat()
    if isinstance(obj, date):
        return obj.isoformat()
    if isinstance(obj, Decimal):
        return float(obj)
    if isinstance(obj, UUID):
        return str(obj)
    if isinstance(obj, bytes):
        return obj.decode("utf-8", errors="replace")
    if isinstance(obj, set):
        return sorted(obj) if all(isinstance(x, str) for x in obj) else list(obj)
    logger.warning(
        "TabData snapshot JSON: unexpected type %s (value=%r), falling back to str()",
        type(obj).__name__, repr(obj)[:200],
    )
    return str(obj)


class TableCollabAdapter(CollabAdapter):
    resource_type = "table"

    # ── 版本历史：序列化 ─────────────────────────────

    def serialize_snapshot(self, data: Any) -> bytes:
        return zlib.compress(
            json.dumps(data, ensure_ascii=False, separators=(",", ":"),
                       default=_snapshot_json_default).encode("utf-8"),
            level=6,
        )

    def deserialize_snapshot(self, blob: bytes) -> Optional[Any]:
        try:
            raw = blob if isinstance(blob, bytes) else bytes(blob)
            return json.loads(zlib.decompress(raw).decode("utf-8"))
        except Exception as e:
            logger.error("Failed to deserialize table snapshot: %s", e)
            return None

    # ── 版本历史：增量 diff ──────────────────────────

    @staticmethod
    def _fields_to_map(fields: list) -> dict:
        """将 fields 列表转为 {id: field_def} 映射，用于 diff 对比。"""
        result = {}
        for f in fields:
            fid = f.get("id") or f.get("id_hex", "")
            if fid:
                result[fid] = f
        return result

    def compute_diff(self, base_data: Any, current_data: Any) -> Optional[bytes]:
        """
        表格级 diff：对比 records 和 fields 变更。

        diff 格式: {
            "added_records": {record_id: {field_hex: value}},
            "removed_records": [record_id, ...],
            "changed_records": {record_id: {field_hex: value}},
            "row_order": [record_id, ...],          # 仅行序变更时出现
            "fields": [{field_def}, ...],           # 仅字段结构变更时出现（全量快照）
            "schema_version": int,                  # 仅 schema_version 变更时出现
        }
        """
        if not isinstance(base_data, dict) or not isinstance(current_data, dict):
            return None

        base_records = base_data.get("records", {})
        curr_records = current_data.get("records", {})
        base_order = base_data.get("row_order", [])
        curr_order = current_data.get("row_order", [])

        added = {}
        changed = {}
        removed = []
        changed_removed_fields: dict = {}

        for rid, rdata in curr_records.items():
            if rid not in base_records:
                added[rid] = rdata
            elif rdata != base_records[rid]:
                # VH-004: 字段级 delta，而非全量覆盖
                base_rdata = base_records[rid]
                delta = {}
                for fk, fv in rdata.items():
                    if fk not in base_rdata or base_rdata[fk] != fv:
                        delta[fk] = fv
                removed_fkeys = [fk for fk in base_rdata if fk not in rdata]
                if delta or removed_fkeys:
                    changed[rid] = delta
                    if removed_fkeys:
                        changed_removed_fields[rid] = removed_fkeys

        for rid in base_records:
            if rid not in curr_records:
                removed.append(rid)

        # DC-004: 新增行必须出现在 row_order 中，否则 apply_diff 后
        # records 与 row_order 不一致。前端/collab-live 可能漏同步 row_order。
        if added:
            curr_order_set = set(curr_order)
            missing = [rid for rid in added if rid not in curr_order_set]
            if missing:
                curr_order = list(curr_order) + missing

        order_changed = base_order != curr_order

        # --- fields diff ---
        base_fields = base_data.get("fields", [])
        curr_fields = current_data.get("fields", [])
        base_field_map = self._fields_to_map(base_fields)
        curr_field_map = self._fields_to_map(curr_fields)
        fields_changed = base_field_map != curr_field_map
        views_changed = base_data.get("views", []) != current_data.get("views", [])

        # --- schema_version diff ---
        base_sv = base_data.get("schema_version")
        curr_sv = current_data.get("schema_version")
        sv_changed = base_sv != curr_sv and curr_sv is not None

        if (
            not added and not changed and not removed
            and not order_changed and not fields_changed and not views_changed and not sv_changed
        ):
            return None

        diff: dict = {
            "_diff_format": "field_delta",
            "added_records": added,
            "removed_records": removed,
            "changed_records": changed,
        }
        if changed_removed_fields:
            diff["changed_records_removed_fields"] = changed_removed_fields
        if order_changed:
            diff["row_order"] = curr_order
        if fields_changed:
            diff["fields"] = curr_fields
        if views_changed:
            diff["views"] = current_data.get("views", [])
        if sv_changed:
            diff["schema_version"] = curr_sv

        return zlib.compress(
            json.dumps(diff, ensure_ascii=False, separators=(",", ":"),
                       default=_snapshot_json_default).encode("utf-8"),
            level=6,
        )

    def apply_diff(self, base_data: Any, diff_blob: bytes) -> Any:
        """将记录级 + 字段级 diff 应用到 base snapshot。

        DC-005: 无论 diff 是否包含 ``fields``，始终根据结果快照的 fields
        过滤 records 中的幽灵字段。diff 在字段删除前计算时，
        changed_records/added_records 会携带已删除字段的 hex 键，
        仅在 diff 含 ``fields`` 时过滤不足以覆盖跨步骤场景。
        """
        try:
            raw = diff_blob if isinstance(diff_blob, bytes) else bytes(diff_blob)
            diff = json.loads(zlib.decompress(raw).decode("utf-8"))
        except Exception:
            logger.exception("Failed to decompress table diff")
            return None

        # DC-006: deepcopy 防止多步回放（rebuild_data）中共享引用导致上游数据被篡改
        result = copy.deepcopy(base_data)
        records = result.get("records", {})

        for rid in diff.get("removed_records", []):
            records.pop(rid, None)

        if diff.get("_diff_format") == "field_delta":
            # VH-004: 新格式 — 字段级 merge
            for rid, delta in diff.get("changed_records", {}).items():
                if rid in records:
                    records[rid].update(delta)
                else:
                    records[rid] = delta
            for rid, removed_keys in diff.get("changed_records_removed_fields", {}).items():
                if rid in records:
                    for k in removed_keys:
                        records[rid].pop(k, None)
        else:
            for rid, rdata in diff.get("changed_records", {}).items():
                records[rid] = rdata

        for rid, rdata in diff.get("added_records", {}).items():
            records[rid] = rdata

        if "fields" in diff:
            result["fields"] = diff["fields"]
        if "views" in diff:
            result["views"] = diff["views"]

        if "schema_version" in diff:
            result["schema_version"] = diff["schema_version"]

        result["records"] = records
        if "row_order" in diff:
            result["row_order"] = diff["row_order"]

        # DC-004 防御: 历史 diff 可能有 added_records 但无 row_order，
        # 确保所有新增行 ID 出现在 row_order 中。
        added_in_diff = diff.get("added_records", {})
        if added_in_diff:
            current_order = result.get("row_order", [])
            order_set = set(current_order)
            appended = [rid for rid in added_in_diff if rid not in order_set]
            if appended:
                result["row_order"] = list(current_order) + appended

        # DC-005: 始终根据当前 fields 过滤幽灵字段，而非仅在 diff 含 fields 时过滤。
        # 覆盖场景：diff 在字段删除前计算，changed_records/added_records 携带旧字段 hex。
        # : 版本历史快照可含 is_deleted=true 的字段定义；这些字段仍是合法 key，
        # 不能当幽灵剥掉——否则回看「删除前」版本时列值会丢。
        current_fields = result.get("fields", [])
        if current_fields:
            valid_keys: set = set()
            for f in current_fields:
                fid = f.get("id", "")
                fid_hex = f.get("id_hex", "")
                if fid_hex:
                    valid_keys.add(fid_hex)
                if fid:
                    # CL-014: 同时加入原始 id 和去 `-` 的 hex 形式，
                    # 防止非标准 UUID 格式 id 经 replace("-","") 后与 records key 不匹配
                    valid_keys.add(fid)
                    valid_keys.add(fid.replace("-", ""))
            if valid_keys:
                for rid, rdata in records.items():
                    ghost = [k for k in rdata if not k.startswith("__") and k not in valid_keys]
                    if ghost:
                        records[rid] = {k: v for k, v in rdata.items() if k.startswith("__") or k in valid_keys}

        # VH-009: 保留截断语义 — 截断快照的 total_records 和 is_truncated 不应被覆盖，
        # 否则 restore_from_snapshot 的截断检查会被绕过
        if not result.get("is_truncated"):
            result["total_records"] = len(records)

        return result

    # ── 版本历史：元数据 ─────────────────────────────

    def get_content_stats(self, data: Any) -> dict:
        if not isinstance(data, dict):
            return {}
        return {
            "record_count": data.get("total_records", len(data.get("records", {}))),
            "field_count": len(data.get("fields", [])),
        }

    # ── 协作：资源与权限 ─────────────────────────────

    def get_resource(self, resource_id: str) -> Optional[Any]:
        from apps.tabdata.models import Table

        try:
            return Table.objects.using(DB).get(id=resource_id, is_archived=False)
        except Table.DoesNotExist:
            return None

    def get_resource_for_rollback(self, resource_id: str) -> Optional[Any]:
        from apps.tabdata.models import Table

        try:
            return Table.objects.using(DB).get(id=resource_id)
        except Table.DoesNotExist:
            return None

    def check_permission(self, user, resource: Any, action: str = "edit") -> bool:
        if not user:
            return False
        try:
            from apps.tabdata.services.base import BaseService as TableBaseService

            svc = TableBaseService(user=user)
            required_role = "editor" if action == "edit" else "viewer"
            return svc.check_table_permission(str(resource.id), required_role)
        except Exception:
            logger.exception("Permission check failed for table %s", resource.id)
            return False

    # ── 协作：快照与持久化 ────────────────────────────

    def build_snapshot(self, resource: Any) -> dict:
        """委托 TabData CollabService 构建快照。表不存在时抛出 ValueError。

        协作 Y.Doc 初始化只含活跃字段。版本历史走 ``get_version_data``，
        会额外带上软删字段定义（ 自包含快照）。
        """
        from apps.tabdata.services.collab_service import CollabService as TableCollabService

        return TableCollabService.build_snapshot(str(resource.id))

    def get_version_data(self, resource: Any) -> dict:
        """版本历史快照：含软删字段定义与单元格值，保证历史回看自包含。"""
        from apps.tabdata.services.collab_service import CollabService as TableCollabService

        return TableCollabService.build_snapshot(
            str(resource.id),
            include_deleted_fields=True,
        )

    def prepare_collab_first_restore_snapshot(self, resource: Any, data: dict) -> dict:
        """: 补全 VH 快照中 collab-live applySnapshotToDoc 所需的运行时字段。"""
        snapshot = dict(data)
        snapshot.setdefault("table_id", str(resource.id))
        snapshot.setdefault("table_name", getattr(resource, "name", "") or "")
        snapshot.setdefault("table_version", getattr(resource, "record_version_seq", 0) or 0)
        if snapshot.get("schema_version") is None:
            snapshot["schema_version"] = getattr(resource, "schema_version", 1)
        return snapshot

    def persist_changes(self, resource: Any, changes: dict, editor_info: dict) -> dict:
        """
        委托 TabData CollabService 持久化变更。
        使用 select_for_update + base_version 乐观锁防止并发写入覆盖。
        """
        from django.db import transaction

        from apps.tabdata.models import Table

        base_version = changes.get("base_version")

        try:
            with transaction.atomic(using=DB):
                table = (
                    Table.objects.using(DB)
                    .select_for_update()
                    .filter(id=resource.id, is_archived=False)
                    .first()
                )
                if not table:
                    return {"error": "Table not found"}

                db_version = table.record_version_seq or 0
                # base_version=0 常见于 schema undo/resync 后 meta.version 未对齐；
                # 若放行，conflict 重试会带上「Y.Doc 空 vs 旧 snapshot」算出的
                # deleted_record_ids，把整表行软删掉。
                if base_version is not None and (
                    base_version < db_version
                    or (base_version == 0 and db_version > 0)
                ):
                    logger.info(
                        "persist_changes conflict: base_version %s < DB version %s for table %s",
                        base_version, db_version, table.id,
                    )
                    return {"conflict": True, "current_version": db_version}

                deleted_ids = [
                    str(item)
                    for item in (changes.get("deleted_record_ids") or [])
                    if item
                ]
                new_records = changes.get("new_records") or {}
                if deleted_ids and not new_records:
                    from apps.tabdata.models import TableRecord

                    active_count = (
                        TableRecord.objects.using(DB)
                        .filter(table_id=table.id, is_deleted=False)
                        .count()
                    )
                    # 单次 collab persist 试图删光当前全部活跃行 → 几乎一定是
                    # 空 Y.Doc / 过期 snapshot 推断出的缺失 diff，拒绝以免清空表格。
                    # 用户明确删除（explicit_delete）必须走 REST 权威命令，不经本路径。
                    if active_count > 0 and len(deleted_ids) >= active_count:
                        logger.warning(
                            "persist_changes refused_inferred_mass_delete: table=%s "
                            "deleted=%s active=%s base_version=%s "
                            "(explicit_delete must use REST)",
                            table.id,
                            len(deleted_ids),
                            active_count,
                            base_version,
                        )
                        return {
                            "conflict": True,
                            "current_version": db_version,
                            "rejected_mass_delete": True,
                        }

                from apps.tabdata.services.collab_service import CollabService as TableCollabService

                result = TableCollabService.persist_changes(
                    str(resource.id),
                    changed_records=changes.get("changed_records", {}),
                    new_records=changes.get("new_records"),
                    deleted_record_ids=changes.get("deleted_record_ids"),
                    row_order=changes.get("row_order"),
                    collab_views=changes.get("views"),
                    op_id=changes.get("op_id"),
                    source=changes.get("source", "collab_persist"),
                    editor_type=editor_info.get("editor_type", ""),
                    editor_id=editor_info.get("editor_id", ""),
                    record_editor_ids=changes.get("record_editor_ids"),
                    collab_fields=changes.get("fields"),
                    record_lifecycle_revalidation_ids=changes.get(
                        "record_lifecycle_revalidation_ids"
                    ),
                )
                return result
        except Exception:
            logger.exception("Failed to persist table changes for %s", resource.id)
            raise

    # ── 恢复 ────────────────────────────────────────

    def restore(self, resource: Any, data: Any, *, prepared: Any = None, user=None) -> None:
        """将表格恢复到快照数据。

        异常向上传播，由 VersionHistoryService._do_restore 的
        transaction.atomic 捕获并回滚，防止版本历史与实际数据不一致（SR-012）。

        CL-008: 快照必须包含非空 fields 定义，否则仅恢复 records 而跳过
        字段同步会导致字段-数据不一致。旧版快照若缺少 fields，应由调用方
        在入口处拦截，而非在 restore 中静默跳过。

        TR-001: 当快照因行数超限被截断时（is_truncated=True），不再直接抛异常，
        而是 fallback 到基于 RecordHistory 的反向回放恢复。RecordHistory 记录了
        每一行的 create/update/delete 变更，不受行数限制。
        """
        if not isinstance(data, dict):
            raise ValueError(f"Table restore: snapshot data is not a dict (got {type(data).__name__})")

        snapshot_fields = data.get("fields")
        if not snapshot_fields:
            raise ValueError(
                f"Table restore: snapshot for table {resource.id} has no field definitions. "
                f"Restoring without fields would cause field-data inconsistency. "
                f"This may indicate an old-format snapshot that predates field tracking."
            )

        from apps.tabdata.exceptions import TruncatedSnapshotError
        from apps.tabdata.services.collab_service import CollabService as TableCollabService

        try:
            TableCollabService.restore_from_snapshot(str(resource.id), data, user=user)
        except TruncatedSnapshotError as exc:

            vh_created_at = (prepared or {}).get('_vh_created_at') if isinstance(prepared, dict) else None
            if not vh_created_at:
                raise ValueError(
                    f"Table {resource.id}: 快照被截断且无法获取版本历史时间戳，"
                    f"无法 fallback 到 RecordHistory 恢复。原因: {exc}"
                ) from exc

            logger.warning(
                "Table %s: 快照被截断，尝试 RecordHistory 回放恢复 (vh_created_at=%s)",
                resource.id, vh_created_at,
            )
            self._fallback_restore_via_record_history(
                str(resource.id), vh_created_at, user=user,
            )

    def _fallback_restore_via_record_history(
        self, table_id_str: str, vh_created_at, *, user=None,
    ) -> None:
        """TR-001: 截断快照时 fallback 到 RecordHistory 反向回放恢复。

        基于 UndoRedoService.reconstruct_table_at_history 的核心逻辑，
        通过反向回放 RecordHistory 重建目标时间点的完整表状态，
        然后使用 replay_record_state 逐行应用。

        与 UndoRedoService 的区别：
        - 不执行权限检查（调用方已在 API 层校验过权限）
        - 按 VH created_at 时间戳定位而非 RecordHistory ID
        - user 由调用链从 API 层透传，用于 RecordHistory 归属
        """
        import uuid as _uuid_mod
        from uuid import UUID

        from apps.tabdata.constants import TABDATA_DB_ALIAS
        from apps.tabdata.models import RecordHistory, TableRecord
        from apps.tabdata.services.record_replay_helper import replay_record_state
        from apps.tabdata.services.record_service import RecordService, next_record_version
        from apps.tabdata.utils.record_data_access import read_data

        table_id = UUID(table_id_str)

        # ── 1. 定位目标 RecordHistory ──
        target_history = (
            RecordHistory.objects.using(TABDATA_DB_ALIAS)
            .filter(record__table_id=table_id, created_at__lte=vh_created_at)
            .order_by('-created_at')
            .only('id', 'created_at')
            .first()
        )
        if not target_history:
            raise ValueError(
                f"RecordHistory 回放兜底失败: 表 {table_id} 在 {vh_created_at} "
                f"之前没有 RecordHistory 记录，无法重建历史状态。"
                f"可能原因: RecordHistory 已被清理或表在该时间点前无修改历史。"
            )

        # ── 2. 重建目标时间点的全表状态（反向回放） ──
        record_states: dict[str, dict] = {}
        current_records = (
            TableRecord.objects.using(TABDATA_DB_ALIAS)
            .filter(table_id=table_id)
            .only('id', 'data', 'order', 'is_deleted')
        )
        for record in current_records:
            record_states[str(record.id)] = {
                "record_id": str(record.id),
                "order": float(record.order or 0),
                "is_deleted": bool(record.is_deleted),
                "data": dict(read_data(record)),
            }

        later_histories = (
            RecordHistory.objects.using(TABDATA_DB_ALIAS)
            .filter(record__table_id=table_id, created_at__gt=target_history.created_at)
            .only('id', 'record_id', 'action', 'field_changes', 'created_at')
            .order_by('-created_at', '-id')
        )

        for history in later_histories:
            record_id = str(history.record_id)
            state = record_states.get(record_id)
            if state is None:
                state = {
                    "record_id": record_id,
                    "order": 0.0,
                    "is_deleted": True,
                    "data": {},
                }
                record_states[record_id] = state

            action = str(history.action or '').lower()
            field_changes = (
                history.field_changes
                if isinstance(history.field_changes, dict)
                else {}
            )

            if action == 'create':
                state["is_deleted"] = True
            elif action == 'delete':
                state["is_deleted"] = False

            for field_key, change in field_changes.items():
                if not isinstance(change, dict):
                    continue
                key = str(field_key)

                if key == "data" and "old" not in change and "new" not in change:
                    continue

                old_value = change.get('old')

                if key == '_deleted':
                    state["is_deleted"] = bool(old_value)
                    continue
                if key == '_order':
                    if old_value is not None:
                        try:
                            state["order"] = float(old_value)
                        except (TypeError, ValueError):
                            pass
                    continue
                if key.startswith('_'):
                    continue

                state_data = state.get("data")
                if not isinstance(state_data, dict):
                    state_data = {}
                    state["data"] = state_data
                state_data[key] = old_value

        # ── 3. 构建快照行列表（仅未删除记录） ──
        snapshot_rows = [
            item for item in record_states.values()
            if not bool(item.get("is_deleted", False))
        ]
        snapshot_rows.sort(key=lambda x: (
            float(x.get("order", 0.0)),
            str(x.get("record_id", "")),
        ))
        snapshot_map = {item["record_id"]: item for item in snapshot_rows}

        # ── 4. 加载当前记录并应用重建后的状态 ──
        current_records_list = list(
            TableRecord.objects.using(TABDATA_DB_ALIAS)
            .select_for_update()
            .filter(table_id=table_id)
        )
        current_map = {str(r.id): r for r in current_records_list}

        ids_to_soft_delete = [
            rid for rid, rec in current_map.items()
            if rid not in snapshot_map and not rec.is_deleted
        ]

        total_affected = len(snapshot_map) + len(ids_to_soft_delete)
        if total_affected > 0:
            version_end = next_record_version(table_id, count=total_affected)
            version_start = version_end - total_affected + 1
        else:
            version_start = 0

        svc = RecordService(user=user)
        operation_group_id = _uuid_mod.uuid4()
        changed_count = 0
        version_cursor = version_start

        for record_id, snapshot_row in snapshot_map.items():
            record = current_map.get(record_id)
            if not record:
                continue
            result = replay_record_state(
                svc,
                record=record,
                next_data=dict(snapshot_row.get('data') or {}),
                next_is_deleted=False,
                next_order=float(snapshot_row.get('order', 0.0)),
                emit_history=True,
                operation_group_id=operation_group_id,
                push_history_to_stack=False,
                source="restore_truncated_snapshot_fallback",
                user=user,
                version_override=version_cursor,
                editor_type="system",
            )
            if result.changed:
                changed_count += 1
            version_cursor += 1

        for rid in ids_to_soft_delete:
            rec = current_map[rid]
            result = replay_record_state(
                svc,
                record=rec,
                next_data=dict(read_data(rec)),
                next_is_deleted=True,
                next_order=float(rec.order or 0),
                emit_history=True,
                operation_group_id=operation_group_id,
                push_history_to_stack=False,
                source="restore_truncated_snapshot_fallback",
                user=user,
                version_override=version_cursor,
                editor_type="system",
            )
            if result.changed:
                changed_count += 1
            version_cursor += 1

        logger.info(
            "TR-001: 表 %s 通过 RecordHistory 回放恢复完成: "
            "target_history=%s, changed=%d, snapshot_rows=%d, soft_deleted=%d",
            table_id, target_history.id, changed_count,
            len(snapshot_rows), len(ids_to_soft_delete),
        )

    # ── 回滚预览（TD-3 / Charter §3.4 / Wave 1.1） ────────────────

    # 大表阈值——超过这个值切到"基于 count 的粗估"而不是 record-by-record 精确 diff，
    # 给 RewindPreviewPanel 30s SLA 留余量（W0-2 audit §4 性能基线）。
    _PREVIEW_LARGE_TABLE_THRESHOLD = 50_000

    # 经验线性公式：基础 200ms + 每行 ~0.3ms (RecordHistory replay 路径估算，
    # W0-2 audit §4.1 给的"理论估算 5ms/insert"基础上考虑 batch_size + savepoint
    # 效率折半再 1/8 折扣，留 conservatively 的下界)。
    _PREVIEW_DURATION_BASE_MS = 200
    _PREVIEW_DURATION_PER_RECORD_MS = 0.3

    def preview_restore(
        self,
        resource: Any,
        target_data: Any,
        *,
        prepared: Any = None,
        user=None,
    ) -> dict:
        """TD-3 / Charter §3.4：回滚到 ``target_data`` 的影响摘要。

        对齐 :meth:`apps.collab.adapters.base.CollabAdapter.preview_restore`
        的标准 schema 输出，给 ``RewindPreviewPanel`` （DC-W0-1-1 / D15
        方案 A）展示"点回滚后会改多少行 / 多少字段"。

        实现要点：
        - **统计语义对齐 :meth:`restore`**：``records_to_create`` =
          target 在 / current 不在；``records_to_delete`` = current 在 /
          target 不在；``records_to_restore`` = 两边都在但 ``data`` 不一致。
        - **大表优化（>50000 行）**：仅做 count diff，跳过 record-by-record
          ``data`` 对比，``records_to_restore`` 用 max(target_count, current_count)
          作为上界，避免 30s+ 全表 hash。
        - **field diff**：当 target_data 的 ``fields`` 与当前 schema 不一致时，
          列出 added / removed 的字段标识（field id 字符串）。
        - **estimated_duration_ms**：基础 200ms + 影响行数 × 0.3ms 的线性估算，
          供前端给"长操作"加 spinner / 进度条。

        Fail-safe：
        - target_data 不是 dict / 缺 ``records`` → 返回全零摘要 + 日志 warning。
        - 数据库异常 → 返回全零摘要 + 日志 warning，**不抛异常**给上游
          （上游 ``RollbackImpactView`` 应能容忍单 adapter 失败）。
        """
        empty_result = {
            'records_to_restore': 0,
            'records_to_create': 0,
            'records_to_delete': 0,
            'fields_to_restore': [],
            'estimated_duration_ms': self._PREVIEW_DURATION_BASE_MS,
        }

        if not isinstance(target_data, dict):
            logger.warning(
                "preview_restore: target_data is not a dict (got %s) for table %s",
                type(target_data).__name__,
                getattr(resource, 'id', None),
            )
            return empty_result

        target_records = target_data.get('records')
        if not isinstance(target_records, dict):
            logger.warning(
                "preview_restore: target_data.records missing/invalid for table %s",
                getattr(resource, 'id', None),
            )
            return empty_result

        try:
            from apps.tabdata.constants import TABDATA_DB_ALIAS
            from apps.tabdata.models import TableField, TableRecord
            from apps.tabdata.utils.record_data_access import read_data
        except Exception:
            logger.exception("preview_restore: tabdata imports failed")
            return empty_result

        try:
            table_id = resource.id
            target_ids: set[str] = {str(rid) for rid in target_records.keys()}
            target_count = len(target_ids)

            current_qs = TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=table_id,
                is_deleted=False,
            )
            current_count = current_qs.count()
            is_large_table = max(target_count, current_count) > self._PREVIEW_LARGE_TABLE_THRESHOLD

            if is_large_table:
                # 大表粗估：count diff 即可，避免逐行 hash
                # ``records_to_restore`` 用两侧交集上界（``min(target, current)``）作为
                # **保守上界**——真实"会被覆写"的行数必然不超过这个值。前端展示时
                # 应带「约 / 最多」字样（DC-W0-1-1 / Wave 1.1 P1 修复）；精确值
                # 需 record-by-record，超大表场景下不在 30s SLA 内（W0-2 audit §4）。
                records_to_create = max(0, target_count - current_count)
                records_to_delete = max(0, current_count - target_count)
                records_to_restore = min(target_count, current_count)
            else:
                current_ids: set[str] = set(
                    str(rid) for rid in current_qs.values_list('id', flat=True)
                )
                # 仅 target 不在 current → 回滚后会重新出现
                records_to_create = len(target_ids - current_ids)
                # 仅 current 不在 target → 回滚后会消失
                records_to_delete = len(current_ids - target_ids)
                # 两侧都在 → 检查 data 是否一致
                common_ids = target_ids & current_ids
                records_to_restore = 0
                if common_ids:
                    # 一次拉数据避免 N+1
                    current_data_map = {
                        str(r.id): read_data(r)
                        for r in TableRecord.objects.using(TABDATA_DB_ALIAS)
                        .filter(table_id=table_id, id__in=common_ids)
                        .only('id', 'data')
                    }
                    for rid in common_ids:
                        target_row = target_records.get(rid) or target_records.get(str(rid)) or {}
                        target_row_data = (
                            target_row.get('data')
                            if isinstance(target_row, dict)
                            else None
                        ) or {}
                        if dict(current_data_map.get(rid) or {}) != dict(target_row_data):
                            records_to_restore += 1

            # 字段层面 diff：target snapshot 的 fields 列表 vs 当前 TableField
            target_fields = target_data.get('fields') or []
            target_field_ids: set[str] = set()
            for f in target_fields:
                if isinstance(f, dict):
                    fid = f.get('id') or f.get('id_hex')
                    if fid:
                        target_field_ids.add(str(fid))

            try:
                current_field_ids: set[str] = {
                    str(fid) for fid in TableField.objects.using(TABDATA_DB_ALIAS)
                    .filter(table_id=table_id, is_deleted=False)
                    .values_list('id', flat=True)
                }
            except Exception:
                current_field_ids = set()

            # fields_to_restore 包含 added（target 有，current 无）+ removed
            #（current 有，target 无）—— 对前端来说"会被结构性恢复的字段"
            # 涵盖两类（要么重建要么删除），合并展示。
            fields_to_restore = sorted(
                (target_field_ids - current_field_ids) | (current_field_ids - target_field_ids)
            )

            # 估算耗时：影响行数 × 单行成本，给 RewindPreviewPanel 加 spinner 用
            affected_rows = records_to_create + records_to_delete + records_to_restore
            estimated_duration_ms = int(
                self._PREVIEW_DURATION_BASE_MS
                + affected_rows * self._PREVIEW_DURATION_PER_RECORD_MS
            )

            return {
                'records_to_restore': int(records_to_restore),
                'records_to_create': int(records_to_create),
                'records_to_delete': int(records_to_delete),
                'fields_to_restore': fields_to_restore,
                'estimated_duration_ms': estimated_duration_ms,
            }
        except Exception:
            logger.warning(
                "preview_restore failed for table %s; returning empty summary",
                getattr(resource, 'id', None),
                exc_info=True,
            )
            return empty_result
