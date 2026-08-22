"""BatchUpdateRecordsHandler — 批量记录更新编排（A2 native SQL 批量写）。

Wave 2 / A2 改造：三阶段流水线
  Phase 1（校验 + 聚合）：批量预加载所有记录，逐条校验。
    仅当 patch 涉及 link 字段时才使用 savepoint（link junction 写入需要保护）。
  Phase 2（批量写）：一次 ORM bulk_update + 一次 NativeRecordIO.bulk_update_records，
    按同列集合分组，一条 SQL 批提交。
  Phase 3（级联 + Link Title）：汇总全量 changed_field_ids × record_ids，
    单次 cascade 调用。

性能目标：500 行 bulk p95 < 2s（PRD §A2）。
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Set, Tuple
from uuid import UUID

from apps.i18n import _
from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.domain.aggregates import RecordAggregate
from apps.tabdata.handlers._base import RecordHandlerBase
from apps.tabdata.handlers.update_record import _prepare_update_data
from apps.tabdata.models import TableRecord
from apps.tabdata.native.value_converter import python_to_pg

if TYPE_CHECKING:
    from apps.tabdata.domain.events import RecordUpdated
    from apps.tabdata.domain.value_objects import (
        FieldSchema,
        RecordCommandContext,
        RecordSnapshot,
    )

logger = logging.getLogger(__name__)


class BatchUpdateRecordsHandler(RecordHandlerBase):
    """编排批量记录更新。A2 native SQL 批量写入路径。"""

    def handle(
        self, context: RecordCommandContext,
    ) -> Tuple[List[RecordSnapshot], List[str]]:
        """批量更新记录并发布 RecordsBatchUpdated 事件。

        Returns:
            (snapshots, errors) — 成功更新的快照列表 + 逐条错误信息。
        """
        if not context.records_data:
            return [], [_("tabdata.batch_update_records_empty")]

        self._prepare_native_io(context.table_id)

        # Phase 1 批量预加载：1 次 DB 查询替代 N 次 get_by_id
        all_raw_ids: List[UUID] = []
        for item in context.records_data:
            rid = item.get('record_id') or item.get('id')
            if rid:
                try:
                    all_raw_ids.append(UUID(str(rid)))
                except (ValueError, AttributeError):
                    pass
        preloaded_map: Dict[UUID, RecordSnapshot] = {}
        if all_raw_ids:
            preloaded_map = {
                s.id: s for s in self._repo.get_by_ids(all_raw_ids)
            }

        results: List[Tuple[RecordSnapshot, RecordUpdated]] = []
        all_changed_field_ids: Set[str] = set()
        all_updated_record_ids: List[str] = []
        errors: List[str] = []
        cross_table_ws: Dict[str, Set[str]] = {}

        def _outer() -> None:
            self._repo.lock_table(context.table_id)
            locked_map = {
                snapshot.id: snapshot
                for snapshot in self._repo.get_by_ids_for_update(all_raw_ids)
            }
            lifecycle_ended_ids = set(preloaded_map) - set(locked_map)

            # 等待 Table/Record 闸门期间字段转换可能已经提交；批量聚合与 native
            # 写入必须使用全部生命周期锁拿到后刷新出的同一份 schema。
            fields = self._field_repo.get_fields(context.table_id)
            link_field_ids: set = set()
            link_field_names: set = set()
            for field in fields:
                if field.field_type == 'link':
                    # 同时支持 dashed UUID / hex 两种 key 形态（P1-1 修复）
                    link_field_ids.add(str(field.id))
                    link_field_ids.add(field.id.hex)
                    link_field_names.add(field.name)

            prepared_items: List[
                Tuple[int, Dict[str, Any], Dict[str, Any], Dict[str, List[str]]]
            ] = []
            locked_select_choice_values: Dict[str, List[str]] = {}
            has_locked_raw_data = any(
                item.get('raw_data') is not None
                for item in context.records_data
            )
            for i, item in enumerate(context.records_data):
                record_id = item.get('record_id') or item.get('id')
                if not record_id:
                    errors.append(_(
                        "tabdata.batch_update_record_missing_id",
                        row_no=i + 1,
                    ))
                    continue
                try:
                    normalized_record_id = UUID(str(record_id))
                except (ValueError, AttributeError):
                    errors.append(_(
                        "tabdata.batch_update_record_failed",
                        row_no=i + 1,
                        detail=str(record_id),
                    ))
                    continue
                if normalized_record_id in lifecycle_ended_ids:
                    # 事务外预加载后被并发删除：属于旧生命周期，静默舍弃。
                    continue

                raw_data = item.get('raw_data')
                if raw_data is None:
                    prepared_items.append((
                        i,
                        item,
                        dict(item.get('data', {})),
                        {},
                    ))
                    continue
                prepared, choice_values, validation_error = _prepare_update_data(
                    raw_data,
                    fields,
                    actor_id=context.user_id,
                    reject_system_managed=False,
                )
                if validation_error:
                    errors.append(_(
                        "tabdata.batch_update_record_failed",
                        row_no=i + 1,
                        detail=validation_error,
                    ))
                    continue
                prepared_items.append((i, item, prepared or {}, choice_values))

            if not prepared_items:
                return

            # 先按 ID 顺序拿齐生命周期锁，再预留本批版本，避免等待期间被
            # 更晚版本越过。保留按原输入索引分配版本的既有响应语义。
            count = len(context.records_data)
            current_version_floor = max(
                (snapshot.version for snapshot in locked_map.values()),
                default=0,
            )
            version_start, _version_end = self._allocate_versions_after(
                context.table_id,
                current_version_floor,
                count=count,
            )

            # ── Phase 1: 校验 + 聚合（批量预加载，条件性 savepoint）──
            for i, item, data, choice_values in prepared_items:
                record_id = item.get('record_id') or item.get('id')
                try:
                    patch_touches_link = bool(
                        link_field_ids
                        and (link_field_ids & data.keys()
                             or link_field_names & data.keys())
                    )
                    validated = self._validate_single(
                        record_id, data,
                        fields, context,
                        version=version_start + i,
                        preloaded_map=locked_map,
                        use_savepoint=patch_touches_link,
                    )
                    if validated is not None:
                        results.append((validated[0], validated[1]))
                        all_changed_field_ids.update(validated[2])
                        all_updated_record_ids.append(str(validated[0].id))
                        for field_id, values in choice_values.items():
                            target = locked_select_choice_values.setdefault(
                                field_id,
                                [],
                            )
                            for value in values:
                                if value not in target:
                                    target.append(value)
                except Exception as exc:
                    errors.append(_("tabdata.batch_update_record_failed", row_no=i + 1, detail=str(exc)))
                    logger.warning(
                        "batch_update validation failed record=%s err=%s",
                        record_id, exc,
                    )

            if not results:
                return

            # 选项自动补全也属于 Field 写。只在至少一条记录确实会持久化时
            # 执行，保持 Table -> Record -> Field，并随事务整体回滚。
            select_choice_values = (
                locked_select_choice_values
                if has_locked_raw_data
                else dict(getattr(context, 'select_choice_values', None) or {})
            )
            if select_choice_values:
                self._field_repo.merge_select_choices(
                    context.table_id,
                    select_choice_values,
                )

            # ── Phase 2: 批量持久化（ORM bulk_update + native SQL batch）──
            try:
                self._batch_persist(results, fields)

                # ORM 的条件 UPDATE 是记录生命周期门禁。并发删除先建立 tombstone
                # 时，_batch_persist 会把未实际命中的迟到修改从 results 中剔除；
                # 级联、附件和领域事件都必须只基于真正持久化的记录。
                all_updated_record_ids[:] = [str(snapshot.id) for snapshot, _ in results]
                all_changed_field_ids.clear()
                for _snapshot, persisted_event in results:
                    all_changed_field_ids.update(persisted_event.changed_field_ids)
            except Exception as exc:
                logger.error(
                    "batch_update Phase 2 persist failed table=%s count=%d err=%s",
                    context.table_id, len(results), exc,
                )
                raise

            # ── Phase 3: 聚合关联标题刷新 + Link Title 传播 ──
            # W3.1d: source='bulk' → flag=True 时强制 ASYNC 入 Outbox,
            # 避免大批量同步阻塞主写入(对齐 PRD §A2 SLA + L33 on_commit 异步化方向)
            if all_changed_field_ids and all_updated_record_ids:
                self._handle_cascade_compute(
                    context.table_id,
                    list(all_changed_field_ids),
                    all_updated_record_ids,
                    cross_table_ws,
                    cascade_source='bulk',
                    change_type='update',
                )
            if results:
                self._handle_batch_link_title(results, fields, cross_table_ws)

        self._uow.with_transaction(_outer)

        if results:
            batch_event = RecordAggregate.batch_updated_event(
                table_id=context.table_id,
                snapshots_and_events=results,
                user_id=context.user_id,
                skip_flags=context.skip_flags,
                operation_group_id=str(context.operation_group_id) if context.operation_group_id else None,
            )
            if self._should_publish_event(context):
                self._event_bus.publish(batch_event)

        self._publish_cross_table_ws(cross_table_ws)
        return [r[0] for r in results], errors

    # ── Phase 1: 单条校验 + 聚合 ─────────────────────────────

    def _validate_single(
        self,
        record_id: Any,
        data: Dict[str, Any],
        fields: List[FieldSchema],
        context: RecordCommandContext,
        version: int,
        preloaded_map: Optional[Dict[UUID, RecordSnapshot]] = None,
        use_savepoint: bool = True,
    ) -> Optional[Tuple[RecordSnapshot, RecordUpdated, List[str]]]:
        """校验单条记录并生成更新快照。

        当 *use_savepoint=False*（patch 不涉及 link 字段），直接执行，
        跳过 savepoint 开销。当 patch 涉及 link 字段时，set_link_cell
        会写 junction 表，需要 savepoint 保护以便单条失败时回滚。

        Returns:
            (snapshot, event, changed_field_ids) 或 None（无变化时）。
        """
        def _per_record() -> Optional[tuple]:
            rid = UUID(str(record_id))
            existing = (preloaded_map or {}).get(rid)
            if existing is None:
                existing = self._repo.get_by_id(rid)
            if existing is None:
                raise ValueError(_("tabdata.record_not_found", record_id=record_id))

            patch = dict(data)
            link_fids = self._apply_link_fields(patch, existing, fields)

            result = RecordAggregate.update(
                existing=existing,
                patch=patch,
                fields=fields,
                user_id=context.user_id,
                version=version,
                skip_flags=context.skip_flags,
                operation_group_id=str(context.operation_group_id) if context.operation_group_id else None,
            )
            if result is None:
                return None

            updated, event = result
            all_changed = list(event.changed_field_ids)
            for fid in link_fids:
                if fid not in all_changed:
                    all_changed.append(fid)
            return updated, event, all_changed

        if use_savepoint:
            return self._uow.with_savepoint(_per_record)
        return _per_record()

    # ── Phase 2: 批量持久化 ────────────────────────────────

    def _batch_persist(
        self,
        results: List[Tuple[RecordSnapshot, RecordUpdated]],
        fields: List[FieldSchema],
    ) -> None:
        """批量 ORM bulk_update + native SQL batch update。"""
        if not results:
            return

        # 2a. ORM batch update: 单条 raw SQL（跳过 ORM record 加载）
        persisted_ids = self._raw_orm_batch_update(results)
        results[:] = [
            item for item in results
            if item[0].id in persisted_ids
        ]
        if not results:
            return

        # 2b. Native SQL batch update: 按列集合分组，一次 SQL 批
        # Bug fix (Review P0-3): formatted_data 的 key 由
        # RecordService._format_record_data 写入为 hex (line 1389)，但
        # _normalize_data 在 RecordAggregate.update 中又会保留 hex 原样，
        # 导致 fid_str 多为 32 位 hex 而非 dashed UUID。同时也存在历史
        # 数据用 dashed UUID 的情况，因此 field_map 必须同时支持两种 key。
        field_map: Dict[str, FieldSchema] = {}
        for f in fields:
            field_map[str(f.id)] = f
            field_map[f.id.hex] = f
        native_rows: List[Dict[str, Any]] = []
        for snapshot, _event in results:
            row: Dict[str, Any] = {'__id': snapshot.id}
            sys_vals = self._build_system_values(snapshot)
            for sys_key, sys_val in sys_vals.items():
                if isinstance(sys_val, UUID):
                    sys_val = str(sys_val)
                row[sys_key] = sys_val
            for fid_str, value in snapshot.formatted_data.items():
                field = field_map.get(fid_str)
                if field is None:
                    continue
                col_hex = field.id.hex
                pg_val = python_to_pg(value, field.field_type, getattr(field, 'config', None))
                row[col_hex] = pg_val
            native_rows.append(row)

        if native_rows:
            self._native_io.bulk_update_records(native_rows)

        # 2c. 附件同步（仅当 patch 涉及文件类字段时）
        _FILE_TYPES = frozenset({'attachment', 'image', 'file'})
        file_field_id_keys: set = set()
        for f in fields:
            if f.field_type in _FILE_TYPES:
                file_field_id_keys.add(str(f.id))
                file_field_id_keys.add(f.id.hex)
        if file_field_id_keys:
            for snapshot, event in results:
                if not (file_field_id_keys & set(event.changed_field_ids)):
                    continue
                try:
                    self._attachment_svc.sync_record_attachments(snapshot)
                except Exception as exc:
                    logger.warning(
                        "batch_update attachment sync failed record=%s err=%s",
                        snapshot.id, exc,
                    )

    @staticmethod
    def _raw_orm_batch_update(
        results: List[Tuple[RecordSnapshot, RecordUpdated]],
    ) -> Set[UUID]:
        """批量更新 ORM 表。

        优先使用 raw SQL ``UPDATE ... FROM (VALUES ...)`` 一条 SQL 完成，
        跳过 Django ORM 的 N 次 record 加载。若**仅在测试环境**下因
        ``DatabaseOperationForbidden`` / ``ImproperlyConfigured`` 等
        cursor 访问限制无法直接执行，降级为 ORM ``bulk_update``。

        生产环境的 ``DatabaseError`` / lock timeout / deadlock 等不可降级，
        必须 re-raise 让上层事务回滚（Review P0-1 修复）。

        W3.0c / G1.a:当 ``TABDATA_BULK_UPDATE_USE_RAW_SQL=False`` 时
        跳过 raw SQL 直接走 ORM ``bulk_update``,用作 raw SQL 路径自身
        数据偏差类问题的热回退（无需 git revert）。
        """
        if not results:
            return set()

        from django.conf import settings as _dj_settings
        if not getattr(_dj_settings, 'TABDATA_BULK_UPDATE_USE_RAW_SQL', True):
            logger.info(
                "[A2] TABDATA_BULK_UPDATE_USE_RAW_SQL=False, "
                "skipping raw SQL path, using ORM bulk_update fallback "
                "(rows=%d)",
                len(results),
            )
            return BatchUpdateRecordsHandler._orm_bulk_update_fallback(results)

        try:
            return BatchUpdateRecordsHandler._raw_orm_batch_update_sql(results)
        except Exception as exc:
            if BatchUpdateRecordsHandler._is_test_db_restriction(exc):
                logger.info(
                    "[A2] raw SQL not available in test sandbox, "
                    "falling back to ORM bulk_update (%s)",
                    type(exc).__name__,
                )
                return BatchUpdateRecordsHandler._orm_bulk_update_fallback(results)
            raise

    @staticmethod
    def _is_test_db_restriction(exc: BaseException) -> bool:
        """判断是否为 pytest-django / SimpleTestCase 的 cursor 访问限制。

        生产环境的 ``DatabaseError``（lock / deadlock / connection lost 等）
        必须穿透降级路径，否则会静默掩盖真正的故障。
        """
        try:
            from django.test.testcases import DatabaseOperationForbidden
            if isinstance(exc, DatabaseOperationForbidden):
                return True
        except ImportError:
            pass
        msg = str(exc)
        return (
            "Database queries to" in msg
            or "Database access not allowed" in msg
        )

    @staticmethod
    def _raw_orm_batch_update_sql(
        results: List[Tuple[RecordSnapshot, RecordUpdated]],
    ) -> Set[UUID]:
        import json as _json

        from django.db import connections

        ids = []
        data_values = []
        versions = []
        updated_ats = []
        updated_bys = []

        for snapshot, _event in results:
            ids.append(str(snapshot.id))
            data_values.append(_json.dumps(snapshot.formatted_data, ensure_ascii=False))
            versions.append(snapshot.version)
            updated_ats.append(snapshot.updated_at)
            updated_bys.append(str(snapshot.updated_by) if snapshot.updated_by else None)

        placeholders = ", ".join(
            ["(%s, %s::jsonb, %s, %s, %s::uuid)"] * len(ids)
        )
        flat_params: list = []
        for i in range(len(ids)):
            flat_params.extend([ids[i], data_values[i], versions[i], updated_ats[i], updated_bys[i]])

        sql = (
            f"UPDATE tabdata_record AS r SET "
            f"  data = v.data, version = v.ver, "
            f"  updated_at = v.ts, updated_by_id = v.ub "
            f"FROM (VALUES {placeholders}) "
            f"  AS v(id, data, ver, ts, ub) "
            f"WHERE r.id = v.id::uuid AND r.is_deleted = FALSE "
            f"RETURNING r.id"
        )

        with connections[TABDATA_DB_ALIAS].cursor() as cursor:
            cursor.execute(sql, flat_params)
            return {UUID(str(row[0])) for row in cursor.fetchall()}

    @staticmethod
    def _orm_bulk_update_fallback(
        results: List[Tuple[RecordSnapshot, RecordUpdated]],
    ) -> Set[UUID]:
        record_ids = [snapshot.id for snapshot, _event in results]
        orm_records = {
            record.id: record
            for record in TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                id__in=record_ids,
                is_deleted=False,
            )
        }
        orm_to_update: list = []
        for snapshot, _event in results:
            orm_obj = orm_records.get(snapshot.id)
            if orm_obj is None:
                continue
            orm_obj.__dict__['data'] = snapshot.formatted_data
            orm_obj.version = snapshot.version
            orm_obj.updated_at = snapshot.updated_at
            if snapshot.updated_by:
                orm_obj.updated_by_id = snapshot.updated_by
            orm_obj._skip_record_history = True
            orm_to_update.append(orm_obj)

        if orm_to_update:
            TableRecord.objects.using(TABDATA_DB_ALIAS).bulk_update(
                orm_to_update,
                ['data', 'version', 'updated_at', 'updated_by_id'],
                batch_size=500,
            )
        return {record.id for record in orm_to_update}

    # ── 批量 Link Title 传播 ──────────────────────────────

    def _handle_batch_link_title(
        self,
        results: List[Tuple[RecordSnapshot, RecordUpdated]],
        fields: List[FieldSchema],
        cross_table_ws: Dict[str, Set[str]],
    ) -> None:
        """对所有成功更新的记录执行 Link Title 传播。外层事务内调用。

        展示字段可能是主字段或 lookupFieldId；``propagate_title_change`` 在无
        incoming LinkRecord 时快速空返回，故对有字段变更的记录统一调用。
        """
        for snapshot, event in results:
            if not event.changed_field_ids:
                continue
            try:
                self._handle_link_title_propagation(
                    snapshot, set(event.changed_field_ids), fields, cross_table_ws,
                )
            except Exception as exc:
                logger.warning(
                    "batch_update link title propagation failed record=%s err=%s",
                    snapshot.id, exc,
                )
