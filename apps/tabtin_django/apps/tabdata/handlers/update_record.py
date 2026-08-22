"""UpdateRecordHandler — 单条记录更新编排。

数据流：获取现有记录 → 事务内 Table/Record 闸门 → 获取字段 → 版本分配 →（Link 处理 +
聚合根 diff + 持久化 + Link Title 传播）→ 事件发布 + 跨表 WS。
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Any, Dict, List, Optional, Set, Tuple

from apps.tabdata.domain.aggregates import RecordAggregate
from apps.tabdata.domain.value_objects import SYSTEM_MANAGED_FIELD_TYPES, FieldSchema
from apps.tabdata.exceptions import RecordVersionConflictError
from apps.tabdata.handlers._base import RecordHandlerBase
from apps.tabdata.native.value_converter import build_native_field_values
from apps.tabdata.utils.choice_utils import (
    iter_select_cell_values,
    merge_select_choice_values,
)
from apps.tabdata.utils.field_types import (
    format_field_value,
    get_field_type_label,
    validate_field_value,
)
from apps.tabdata.utils.default_values import apply_record_defaults
from apps.tabdata.utils.field_validation_rules import validate_with_rules

if TYPE_CHECKING:
    from apps.tabdata.domain.value_objects import RecordCommandContext, RecordSnapshot


def _prepare_update_data(
    raw_data: Dict[str, Any],
    fields: List[FieldSchema],
    *,
    actor_id: Optional[str] = None,
    reject_system_managed: bool = True,
) -> Tuple[Optional[Dict[str, Any]], Dict[str, List[str]], Optional[str]]:
    """按锁内 schema 校验并格式化原始更新请求。"""
    name_map: Dict[str, FieldSchema] = {}
    id_map: Dict[str, FieldSchema] = {}
    db_field_map: Dict[str, FieldSchema] = {}
    for field in fields:
        if field.is_deleted:
            continue
        name_map[field.name] = field
        id_map[str(field.id)] = field
        if field.db_field_name:
            db_field_map[field.db_field_name] = field
        configured_db_key = (field.config or {}).get('db_field_name')
        if configured_db_key not in (None, ''):
            db_field_map[str(configured_db_key)] = field

    prepared: Dict[str, Any] = {}
    select_choice_values: Dict[str, List[str]] = {}
    matched_count = 0
    unknown_keys: List[str] = []

    for raw_key, value in (raw_data or {}).items():
        normalized_key = str(raw_key)
        field = (
            name_map.get(normalized_key)
            or id_map.get(normalized_key)
            or db_field_map.get(normalized_key)
        )
        if field is None:
            unknown_keys.append(normalized_key)
            continue

        matched_count += 1
        if field.field_type in SYSTEM_MANAGED_FIELD_TYPES:
            if reject_system_managed:
                return None, {}, f"系统托管字段不可编辑: {normalized_key}"
            continue
        config = dict(field.config or {})
        pending_choices: List[str] = []
        if field.field_type in ('select', 'multi_select'):
            pending_choices = iter_select_cell_values(value, field.field_type)
            if pending_choices:
                config['choices'] = merge_select_choice_values(
                    config.get('choices') or [],
                    pending_choices,
                )

        if not validate_field_value(field.field_type, value, config):
            label = get_field_type_label(field.field_type)
            return (
                None,
                {},
                f"字段 '{field.name}' 格式不符：{label}类型不支持此值",
            )

        is_valid, rule_error = validate_with_rules(
            field.validation_rules or {},
            value,
        )
        if not is_valid:
            if rule_error:
                return None, {}, f"字段 '{field.name}' 校验失败: {rule_error}"
            return None, {}, f"字段 '{field.name}' 未通过验证规则"

        formatted = format_field_value(field.field_type, value, config)
        prepared[str(field.id)] = formatted
        if pending_choices:
            select_choice_values[str(field.id)] = pending_choices

    if raw_data and matched_count == 0:
        unknown_preview = ', '.join(unknown_keys[:10])
        if len(unknown_keys) > 10:
            unknown_preview = f"{unknown_preview} 等{len(unknown_keys)}个"
        available = [field.name for field in fields if not field.is_deleted][:20]
        available_preview = ', '.join(available) if available else '(无可用字段)'
        return None, {}, (
            "无有效字段匹配（输入 key 均不在表字段中）。"
            f"未知: {unknown_preview}；可用字段: {available_preview}"
        )

    apply_record_defaults(
        prepared,
        fields,
        is_create=False,
        actor_id=actor_id,
    )
    return prepared, select_choice_values, None


class UpdateRecordHandler(RecordHandlerBase):
    """编排单条记录更新。"""

    def handle(self, context: RecordCommandContext) -> Tuple[Optional[RecordSnapshot], Optional[str]]:
        """更新一条记录并发布 RecordUpdated 事件。

        Returns:
            (updated_snapshot, None) 成功；
            (existing_snapshot, None) 无实际变化；
            (None, error_msg) 记录不存在。
        """
        existing = self._repo.get_by_id(context.record_id)
        if existing is None:
            return None, "记录不存在"

        self._prepare_native_io(existing.table_id)
        cross_table_ws: Dict[str, Set[str]] = {}
        result_snapshot: Optional[RecordSnapshot] = None
        result_event = None
        result_error: Optional[str] = None

        def _persist() -> None:
            nonlocal result_snapshot, result_event, result_error

            # 全域不变量：任何可能交叉触及 Record + Field 的写事务都必须先锁
            # Table。拿到此闸门后，内部 Record -> Field 可保留 CAS 零副作用，
            # 同时不会和 Table -> Field -> Record 的字段结构写形成等待环。
            self._repo.lock_table(existing.table_id)
            locked_existing = self._repo.get_by_id_for_update(existing.id)
            if locked_existing is None:
                # 删除在本次更新拿到生命周期锁之前已建立 tombstone。
                return

            if (
                context.expected_version is not None
                and locked_existing.version != context.expected_version
            ):
                raise RecordVersionConflictError(
                    locked_existing.id,
                    expected_version=context.expected_version,
                )

            # 等待 Table 闸门期间字段转换可能已经完成。必须在闸门内重新读
            # schema，后续聚合、link 与 native 投影都只使用同一份新快照。
            fields = self._field_repo.get_fields(locked_existing.table_id)

            patch = dict(context.data or {})
            select_choice_values = dict(context.select_choice_values or {})
            if context.raw_data is not None:
                prepared, select_choice_values, validation_error = _prepare_update_data(
                    context.raw_data,
                    fields,
                    actor_id=context.user_id,
                )
                if validation_error:
                    result_error = validation_error
                    return
                patch = prepared or {}

            # CAS 必须先于任何可观察副作用。这里已经持有 Table + Record；
            # 字段结构写路径会先等待 Table，无法持有 Field 反向等待本 Record。
            if select_choice_values:
                self._field_repo.merge_select_choices(
                    locked_existing.table_id,
                    select_choice_values,
                )

            # 版本必须在等待记录锁之后分配。否则较早预留版本的迟到写入可能
            # 覆盖较新版本，令 version__gt 增量游标漏掉最终状态。
            new_version, _ = self._allocate_versions_after(
                locked_existing.table_id,
                locked_existing.version,
            )

            link_fids = self._apply_link_fields(patch, locked_existing, fields)

            result = RecordAggregate.update(
                existing=locked_existing,
                patch=patch,
                fields=fields,
                user_id=context.user_id,
                version=new_version,
                skip_flags=context.skip_flags,
                operation_group_id=str(context.operation_group_id) if context.operation_group_id else None,
            )
            if result is None:
                result_snapshot = locked_existing
                return

            updated, event = result
            persisted = self._repo.update_one(
                record_id=updated.id,
                data=updated.formatted_data,
                version=updated.version,
            )
            if not persisted:
                # 删除先建立了 tombstone：该修改属于旧生命周期，静默舍弃。
                result_snapshot = None
                return
            # 必须 python_to_pg：link 等 JSONB 单元格是 list[dict]/dict，
            # 裸传给 psycopg 会 ProgrammingError: can't adapt type 'dict'。
            self._native_io.update_record(
                record_id=updated.id,
                field_values=build_native_field_values(updated.formatted_data, fields),
                system_values=self._build_system_values(updated),
            )
            self._attachment_svc.sync_record_attachments(updated)

            all_changed = set(event.changed_field_ids)
            all_changed.update(link_fids)
            self._handle_link_title_propagation(
                updated, all_changed, fields, cross_table_ws,
            )
            self._handle_cascade_compute(
                updated.table_id,
                list(all_changed),
                [str(updated.id)],
                cross_table_ws,
            )

            result_snapshot = updated
            result_event = event

        self._uow.with_transaction(_persist)

        if result_event is not None:
            if self._should_publish_event(context):
                self._event_bus.publish(result_event)
            self._publish_cross_table_ws(cross_table_ws)

        return result_snapshot, result_error
