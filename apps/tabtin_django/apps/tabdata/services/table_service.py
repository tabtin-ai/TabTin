"""
表格管理服务

提供表格和字段的增删改查功能
"""
import logging
from typing import List, Optional, Dict, Any, Tuple
from uuid import UUID, uuid4
from django.db import IntegrityError, connections, transaction, models, DatabaseError
from django.db.models import Q, QuerySet, F
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.tabdata.exceptions import PrimaryFieldDeleteError, SchemaVersionMismatchError
from apps.i18n import _

from apps.tabdata.constants import COLLAB_SNAPSHOT_MAX_ROWS, FILE_BASED_FIELD_TYPES, MAX_BULK_FIELDS, TABDATA_DB_ALIAS
from apps.collab.constants import (
    CHANGE_TYPE_CREATE_FIELD,
    CHANGE_TYPE_UPDATE_FIELD,
    CHANGE_TYPE_DELETE_FIELD,
    CHANGE_TYPE_CONVERT_FIELD,
    CHANGE_TYPE_REORDER_FIELDS,
)
from apps.tabdata.history_events import emit_record_history_event, get_editor_type
from apps.tabdata.models import Table, TableField, TableRecord, TableView
from apps.tabdata.request_context import get_current_window_id
from apps.tabdata.services.undo_redo_operation_service import UndoRedoOperationService
from apps.tabtinspace.models import Collection, Space
from apps.tabtinspace.services.asset_host import asset_host_q
from apps.tabtinspace.services.resource_bridge import ResourceBridge
from apps.tabtinspace.services.organization_control_guard import (
    assert_organization_resource_write_allowed_optional,
)
from apps.tabdata.utils.field_converters import (
    can_convert_field_type,
)
from apps.tabdata.utils.field_target_validators import (
    convert_to_target_type,
    collect_auto_create_options,
    MAX_OPTIONS_COUNT
)
from apps.tabdata.utils.record_data_access import invalidate_cache, read_data, read_data_bulk

FIELD_TYPE_ALIASES: dict[str, str] = {
    'string': 'text',
    'textarea': 'long_text',
    'integer': 'number',
    'float': 'number',
    'bool': 'checkbox',
    'boolean': 'checkbox',
    'single_select': 'select',
    'multiple_select': 'multi_select',
    'multiselect': 'multi_select',
    'file': 'attachment',
    'image': 'attachment',
    'enum': 'select',
}

_FIELD_CONVERSION_BATCH_SIZE = 200
INSERT_POSITION_BEFORE = 'before'
INSERT_POSITION_AFTER = 'after'
VIEW_TYPES_WITH_HIDDEN_COLUMN_META = {'grid', 'list', 'plugin'}


def resolve_field_type_alias(raw_type: str) -> str:
    """将常见别名映射到规范字段类型名，不识别的原样返回。"""
    return FIELD_TYPE_ALIASES.get(raw_type.strip().lower(), raw_type.strip().lower())
from apps.tabdata.error_codes import ErrorCode, get_error_response
from apps.tabdata.services.table_event_service import table_event_service
from apps.tabdata.services.record_service import next_record_version
import hashlib

from apps.tabdata.native.ddl_manager import DDLManager, resolve_schema_partition_id
from apps.tabdata.native.pg_type_map import UnknownNativeFieldTypeError, is_system_field
from apps.users.membership.services.quota_service import QuotaService
from .base import BaseService

User = get_user_model()
logger = logging.getLogger(__name__)

_DEFAULT_VALUE_UNSET = object()

# 主字段允许的类型
PRIMARY_FIELD_ALLOWED_TYPES = {'text', 'number', 'select', 'url', 'email', 'phone'}


def _strip_field_from_filter_set(filter_set: dict, field_id_str: str) -> Optional[dict]:
    """递归移除嵌套 FilterSet 中引用指定字段的条件项。

    返回清理后的 filter_set；若 filterSet 数组变空则返回 None。
    若无任何变化，返回原对象（调用方用 ``is`` 判断是否修改过）。
    """
    items = filter_set.get('filterSet')
    if not isinstance(items, list):
        return filter_set

    cleaned: list = []
    modified = False
    for item in items:
        if not isinstance(item, dict):
            cleaned.append(item)
            continue
        if 'conjunction' in item and 'filterSet' in item:
            sub = _strip_field_from_filter_set(item, field_id_str)
            if sub is None:
                modified = True
            else:
                if sub is not item:
                    modified = True
                cleaned.append(sub)
        else:
            ref = str(item.get('fieldId', '') or item.get('field_id', '') or item.get('field', '') or '')
            if ref == field_id_str:
                modified = True
            else:
                cleaned.append(item)

    if not modified:
        return filter_set
    if not cleaned:
        return None
    return {**filter_set, 'filterSet': cleaned}


def strip_field_from_views(table_id, field_id_str: str) -> None:
    """从指定表的所有视图中移除对指定字段的引用。独立函数，供 TableService 和 LinkFieldService 共用。"""
    views = list(TableView.objects.using(TABDATA_DB_ALIAS).filter(table_id=table_id))
    to_update = []
    update_fields = {'visible_fields', 'field_order'}
    for view in views:
        changed = False
        vf = view.visible_fields or []
        fo = view.field_order or []
        new_vf = [f for f in vf if f != field_id_str]
        new_fo = [f for f in fo if f != field_id_str]
        if len(new_vf) != len(vf) or len(new_fo) != len(fo):
            view.visible_fields = new_vf
            view.field_order = new_fo
            changed = True

        cm = view.column_meta
        if isinstance(cm, dict) and field_id_str in cm:
            view.column_meta = {k: v for k, v in cm.items() if k != field_id_str}
            update_fields.add('column_meta')
            changed = True

        if view.filters:
            cleaned = [
                r for r in view.filters
                if str(r.get('fieldId', '')) != field_id_str
                and str(r.get('field_id', '')) != field_id_str
                and str(r.get('field', '')) != field_id_str
            ]
            if len(cleaned) != len(view.filters):
                view.filters = cleaned
                update_fields.add('filters')
                changed = True

        if view.sorts:
            cleaned = [
                r for r in view.sorts
                if str(r.get('fieldId', '')) != field_id_str
                and str(r.get('field_id', '')) != field_id_str
                and str(r.get('field', '')) != field_id_str
            ]
            if len(cleaned) != len(view.sorts):
                view.sorts = cleaned
                update_fields.add('sorts')
                changed = True

        if view.groups:
            cleaned = [
                r for r in view.groups
                if str(r.get('fieldId', '')) != field_id_str
                and str(r.get('field_id', '')) != field_id_str
                and str(r.get('field', '')) != field_id_str
            ]
            if len(cleaned) != len(view.groups):
                view.groups = cleaned
                update_fields.add('groups')
                changed = True

        if view.filter and isinstance(view.filter, dict):
            cleaned_filter = _strip_field_from_filter_set(view.filter, field_id_str)
            if cleaned_filter is not view.filter:
                view.filter = cleaned_filter
                update_fields.add('filter')
                changed = True

        # 删除活动父字段时清除层级配置，避免「高亮但无树」的失效状态
        cfg = view.config
        if isinstance(cfg, dict) and str(cfg.get('subRecordParentFieldId') or '') == field_id_str:
            next_config = dict(cfg)
            next_config['subRecordParentFieldId'] = None
            view.config = next_config
            update_fields.add('config')
            changed = True

        if changed:
            to_update.append(view)
    if to_update:
        TableView.objects.using(TABDATA_DB_ALIAS).bulk_update(to_update, list(update_fields))


class TableService(BaseService):
    """
    表格管理服务

    提供表格的CRUD操作和字段管理
    """

    def _normalize_table_name(self, name: str) -> str:
        normalized = (name or '').strip()
        if not normalized:
            raise ValueError(_("tabdata.table_name_cannot_be_empty"))
        return normalized

    def _get_operation_service(self) -> UndoRedoOperationService:
        return UndoRedoOperationService(user=self.user)

    def _publish_field_event(
        self,
        table_id,
        action: str,
        fields: list,
    ) -> None:
        """发布字段结构变更 WS 事件（fire-and-forget，延迟到事务提交后）。

        EP-6 fix: 所有字段操作方法均包裹在 @transaction.atomic 中，
        直接同步发布会在事务回滚时产生幽灵通知。改为 on_commit 后发布，
        与记录变更的 _publish_table_event 保持一致。
        """
        from apps.tabdata.subscribers._utils import run_after_commit

        try:
            serializer = self._get_operation_service().serialize_field
            table_id_str = str(table_id)
            action_val = action
            field_ids = [str(f.id) for f in fields]
            serialized_fields = [serializer(f) for f in fields]
            user_id = str(self.user.id) if self.user else None

            def _publish():
                try:
                    table_event_service.publish_field_change(
                        table_id_str,
                        action=action_val,
                        field_ids=field_ids,
                        fields=serialized_fields,
                        metadata={"user_id": user_id},
                    )
                except Exception as exc:
                    logger.warning("[WS] field event publish failed: %s", exc)

            run_after_commit(_publish)
        except Exception as exc:
            logger.warning("[WS] field event publish setup failed: %s", exc)

    def _trigger_field_version_history(
        self,
        table_id,
        action: str,
        *,
        change_type: str = "",
        summary: str = "",
        field_details: list | None = None,
    ) -> None:
        """字段 CRUD 后触发 VersionHistory + ChangeLog 写入（fire-and-forget，延迟到事务提交后）。

        FH-001 fix: 字段增删改完全不触发版本历史和变更日志，此方法填补这一空洞。
        在事务提交后构建表格快照、写入 VersionHistory 并创建字段级 ChangeLog 记录，
        使字段结构变更出现在版本时间线上。
        """
        from apps.tabdata.subscribers._utils import run_after_commit
        from apps.services.common.platform_context import get_current_run_id, get_current_session_id

        table_id_str = str(table_id)
        user_id = str(self.user.id) if self.user else None
        ct = change_type or action
        sm = summary
        fd = list(field_details) if field_details else []
        agent_run_id = get_current_run_id() or ""
        session_id = get_current_session_id() or ""  # QC-05

        def _write_history():
            try:
                from apps.collab.registry import get_adapter
                from apps.collab.service import VersionHistoryService
                from apps.collab.models import ChangeLog

                adapter = get_adapter("table")
                if not adapter:
                    return

                resource = adapter.get_resource(table_id_str)
                if not resource:
                    return

                version_data = adapter.get_version_data(resource)
                if version_data is None:
                    return

                editor_info = {
                    "editor_type": "user" if user_id else "system",
                    "editor_id": user_id or "",
                    "editor_name": "",
                }

                svc = VersionHistoryService(adapter)
                organization_id = getattr(resource, "organization_id", None)

                from django.db import transaction as db_tx
                with db_tx.atomic(using=TABDATA_DB_ALIAS):
                    vh = svc.create_history(
                        resource.id,
                        version_data,
                        editor_info,
                        force_snapshot=True,
                        organization_id=organization_id,
                    )

                    ChangeLog.objects.using(TABDATA_DB_ALIAS).create(
                        resource_type="table",
                        resource_id=resource.id,
                        change_type=ct,
                        summary=sm,
                        changes={"fields": fd},
                        editor_type="user" if user_id else "system",
                        editor_id=user_id or "",
                        version_history=vh,
                        agent_run_id=agent_run_id,
                        session_id=session_id,
                    )
            except Exception as exc:
                logger.warning(
                    "[FieldHistory] write failed: "
                    "table=%s change_type=%s err=%s",
                    table_id_str, ct, exc,
                )

        run_after_commit(_write_history)

    @staticmethod
    def _sync_table_records_to_ydoc(table_id, *, source: str = "table_service") -> None:
        """字段生命周期操作后，将全表记录同步到 Y.js（fire-and-forget）。"""
        try:
            from apps.tabdata.utils.ydoc_sync import sync_records_to_ydoc
            from apps.tabdata.models import TableRecord
            records = list(
                TableRecord.objects.using(TABDATA_DB_ALIAS).filter(table_id=table_id, is_deleted=False)
                .only("id", "table_id")[:COLLAB_SNAPSHOT_MAX_ROWS]
            )
            if records:
                sync_records_to_ydoc(table_id, records, source=source)
        except Exception as exc:
            logger.warning("_sync_table_records_to_ydoc failed table=%s source=%s err=%s", table_id, source, exc)

    # ──────────────────────────────────
    # 原生列存储 DDL 钩子
    # ──────────────────────────────────

    @staticmethod
    def _advisory_lock_key(space_id: UUID, table_id: UUID) -> int:
        """基于 space_id + table_id 生成 advisory lock key（bigint 范围）"""
        h = hashlib.md5(f"{space_id}:{table_id}".encode()).hexdigest()
        return int(h[:15], 16) % (2**63)

    def _native_ensure_table(self, space_id: UUID, table_id: UUID, fields: list) -> None:
        """确保原生表已创建并同步所有字段列。

        数据库级异常（连接断开、超时、SQL 错误等）和 native 类型漏映射向上传播触发事务回滚；
        仅非数据库异常（如配置读取失败）被 warn 并继续。
        """
        try:
            with connections[TABDATA_DB_ALIAS].cursor() as cursor:
                cursor.execute(
                    "SELECT pg_advisory_xact_lock(%s)",
                    [self._advisory_lock_key(space_id, table_id)],
                )
            ddl = DDLManager()
            ddl.ensure_schema(space_id)
            # ：首建时把用户字段列并进 CREATE TABLE，省掉逐列 ALTER 往返。
            user_fields = [
                field for field in fields
                if not is_system_field(field.field_type)
            ]
            ddl.create_native_table(space_id, table_id, extra_fields=user_fields)
            from apps.tabdata.models import NativeTableStatus
            NativeTableStatus.objects.using(TABDATA_DB_ALIAS).update_or_create(
                table_id=table_id,
                defaults={
                    'native_table_created': True,
                    'columns_synced': True,
                },
            )
            logger.info('[Native] Table DDL synced: space=%s table=%s fields=%d',
                        space_id, table_id, len(fields))
            self._invalidate_resolver_cache(space_id)
        except Exception as exc:
            logger.exception(
                '[Native] Failed to ensure native table: space=%s table=%s',
                space_id, table_id,
            )
            raise

    @staticmethod
    def _topo_sort_advanced_fields(
        created_fields: List['TableField'],
        normalized_options_by_name: Dict[str, Dict[str, Any]],
    ) -> List[int]:
        """返回批量字段的稳定初始化顺序。"""
        return list(range(len(created_fields)))

    def _initialize_advanced_field_pre_native(
        self,
        field: 'TableField',
        normalized_options: Dict[str, Any],
    ) -> 'TableField':
        """
        关联字段初始化（在 native 列创建之前执行）。

        Returns:
            更新后的 field（同一实例，已在 service 内 .save(update_fields=[...])）
        """
        field_type = field.field_type

        if field_type == 'link':
            from apps.tabdata.services.link_field_service import LinkFieldService
            return LinkFieldService.create_link_field(field, normalized_options, user=self.user)

        return field

    def _initialize_advanced_field_post_native(self, field: 'TableField') -> None:
        """保留关联字段两阶段初始化的调用边界。"""
        return None

    def _native_add_column(self, table_id: UUID, field) -> None:
        """原生列存储：添加字段列。

        数据库级异常（连接断开、超时、SQL 错误等）和 native 类型漏映射向上传播触发事务回滚；
        仅非数据库异常（如配置读取失败）被 warn 并继续。
        """
        try:
            from apps.tabdata.models import Table
            table = Table.objects.using(TABDATA_DB_ALIAS).get(id=table_id)
            space_id = resolve_schema_partition_id(table)
            ddl = DDLManager()
            ddl.add_column(space_id, table_id, field.id, field.field_type, field.config)
            logger.info('[Native] Column added: table=%s field=%s type=%s',
                        table_id, field.id, field.field_type)
            self._invalidate_resolver_cache(space_id)
        except (DatabaseError, UnknownNativeFieldTypeError):
            raise
        except Exception as exc:
            logger.warning('[Native] Failed to add column: table=%s field=%s err=%s',
                           table_id, field.id, exc)

    def _native_drop_column(self, table_id: UUID, field_id: UUID) -> None:
        """原生列存储：删除字段列。

        数据库级异常（连接断开、超时、SQL 错误等）向上传播触发事务回滚；
        仅非数据库异常（如配置读取失败）被 warn 并继续。
        """
        try:
            from apps.tabdata.models import Table as _Table
            table = _Table.objects.using(TABDATA_DB_ALIAS).get(id=table_id)
            space_id = resolve_schema_partition_id(table)
            ddl = DDLManager()
            ddl.drop_column(space_id, table_id, field_id)
            logger.info('[Native] Column dropped: table=%s field=%s', table_id, field_id)
            self._invalidate_resolver_cache(space_id)
        except DatabaseError:
            raise
        except Exception as exc:
            logger.warning('[Native] Failed to drop column: table=%s field=%s err=%s',
                           table_id, field_id, exc)

    def _native_alter_column_type(self, table_id: UUID, field_id: UUID,
                                   old_type: str, new_type: str, config=None) -> None:
        """原生列存储：修改字段列类型。

        数据库级异常（连接断开、超时、SQL 错误等）向上传播触发事务回滚；
        仅非数据库异常（如配置读取失败）被 warn 并继续。
        """
        try:
            from apps.tabdata.models import Table
            table = Table.objects.using(TABDATA_DB_ALIAS).get(id=table_id)
            space_id = resolve_schema_partition_id(table)
            ddl = DDLManager()
            ddl.alter_column_type(space_id, table_id, field_id, new_type, old_type, config)
            logger.info('[Native] Column type altered: table=%s field=%s %s→%s',
                        table_id, field_id, old_type, new_type)
            self._invalidate_resolver_cache(space_id)
        except DatabaseError:
            raise
        except Exception as exc:
            logger.warning('[Native] Failed to alter column type: table=%s field=%s err=%s',
                           table_id, field_id, exc)

    @classmethod
    def _native_drop_table(cls, space_id: UUID, table_id: UUID) -> None:
        """原生列存储：删除原生表。失败时异常向上传播，由调用方决定处理策略。"""
        ddl = DDLManager()
        ddl.drop_native_table(space_id, table_id)
        from apps.tabdata.models import NativeTableStatus
        NativeTableStatus.objects.using(TABDATA_DB_ALIAS).filter(table_id=table_id).delete()
        logger.info('[Native] Table dropped: space=%s table=%s', space_id, table_id)
        cls._invalidate_resolver_cache(space_id)

    @staticmethod
    def _invalidate_resolver_cache(space_id: UUID) -> None:
        """Invalidate the NameResolver cache after schema changes."""
        try:
            from apps.tabdata.native.name_resolver import invalidate_resolver
            invalidate_resolver(space_id)
        except Exception:
            pass  # Non-critical; TTL will expire naturally

    def _validate_primary_field_type(self, field_type: str, is_primary: bool = False) -> None:
        """
        验证主字段类型是否被允许

        Args:
            field_type: 字段类型
            is_primary: 是否为主字段

        Raises:
            ValueError: 如果主字段类型不被允许
        """
        if is_primary and field_type not in PRIMARY_FIELD_ALLOWED_TYPES:
            raise ValueError(f"主键字段类型 '{field_type}' 不被支持，只允许使用：{', '.join(sorted(PRIMARY_FIELD_ALLOWED_TYPES))}")

    def _normalize_field_options(
        self,
        table_id: UUID,
        field_type: str,
        options: Optional[Dict[str, Any]],
        *,
        current_field_id: Optional[UUID] = None,
    ) -> Dict[str, Any]:
        """
        规范化字段 options。

        对 link 做 foreignTableId / relationship 校验。
        其他字段保持原样。
        """
        if field_type == 'link':
            opts = dict(options or {})
            # 验证必填项
            if not opts.get('foreignTableId'):
                raise ValueError("link 字段缺少 foreignTableId")
            valid_relationships = {'OneOne', 'OneMany', 'ManyOne', 'ManyMany'}
            rel = opts.get('relationship', 'ManyOne')
            if rel not in valid_relationships:
                raise ValueError(f"不支持的关联类型: {rel}")
            opts.setdefault('relationship', 'ManyOne')
            opts.setdefault('isOneWay', False)
            # 验证目标表存在
            try:
                Table.objects.using(TABDATA_DB_ALIAS).get(id=opts['foreignTableId'], is_archived=False)
            except Table.DoesNotExist:
                raise ValueError(f"目标表不存在: {opts['foreignTableId']}")
            # 编辑模式：合并后端管理的字段（前端不会发送 symmetricFieldId / lookupFieldId 等）
            if current_field_id:
                try:
                    existing = TableField.objects.using(TABDATA_DB_ALIAS).get(id=current_field_id, is_deleted=False)
                    existing_config = existing.config or {}
                    # 保留后端管理的字段（前端未发送时不覆盖）
                    for key in ('symmetricFieldId', 'lookupFieldId'):
                        if key not in opts and key in existing_config:
                            opts[key] = existing_config[key]
                except TableField.DoesNotExist:
                    pass
            # lookupFieldId 为空时，回退到目标表 Label / 主字段
            if not opts.get('lookupFieldId'):
                label_field = TableField.objects.using(TABDATA_DB_ALIAS).filter(
                    table_id=opts['foreignTableId'],
                    name='Label',
                    is_deleted=False,
                ).order_by('order').first()
                if label_field:
                    opts['lookupFieldId'] = str(label_field.id)
                else:
                    primary_field = TableField.objects.using(TABDATA_DB_ALIAS).filter(
                        table_id=opts['foreignTableId'],
                        is_primary=True,
                        is_deleted=False,
                    ).first()
                    if primary_field:
                        opts['lookupFieldId'] = str(primary_field.id)
            return opts

        if field_type in ('select', 'multi_select'):
            from apps.tabdata.utils.field_types import get_field_type
            field_type_cls = get_field_type(field_type)
            if field_type_cls and hasattr(field_type_cls, 'validate_options'):
                return field_type_cls.validate_options(options) or dict(options or {})
            return dict(options or {})

        return dict(options or {})

    def _refresh_field_count(self, table_id: UUID, table_obj: Optional[Table] = None) -> int:
        """
        重新计算并更新表格的字段数量统计

        Args:
            table_id: 表格ID
            table_obj: 可选的表格实例，如果提供将同步内存中的属性

        Returns:
            int: 最新的字段数量
        """
        field_count = TableField.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=table_id,
            is_deleted=False
        ).count()
        Table.objects.using(TABDATA_DB_ALIAS).filter(id=table_id).update(field_count=field_count)
        if table_obj is not None:
            table_obj.field_count = field_count
        return field_count

    @staticmethod
    def _increment_schema_version(table_id: UUID) -> None:
        """
        字段结构变更时自动递增 schema_version。

        SDK 客户端通过 schema_version 判断 field map 缓存是否过期，
        避免在字段增删改名后使用过期的 name→id 映射。

        触发场景：字段创建 / 删除 / 改名 / 类型变更 / 配置变更
        """
        Table.objects.using(TABDATA_DB_ALIAS).filter(id=table_id).update(
            schema_version=F('schema_version') + 1,
        )

    def _insert_field_id_by_reference(
        self,
        current_ids: List[str],
        field_id: str,
        reference_field_id: Optional[str],
        insert_position: Optional[str],
        field_order_map: Dict[str, float],
        field_order: float,
    ) -> List[str]:
        if field_id in current_ids:
            return current_ids

        if reference_field_id and reference_field_id in current_ids:
            reference_index = current_ids.index(reference_field_id)
            insert_index = (
                reference_index
                if insert_position == INSERT_POSITION_BEFORE
                else reference_index + 1
            )
        else:
            insert_index = len(current_ids)
            for index, existing_field_id in enumerate(current_ids):
                if field_order_map.get(existing_field_id, float('inf')) >= field_order:
                    insert_index = index
                    break

        return current_ids[:insert_index] + [field_id] + current_ids[insert_index:]

    def _build_column_meta_entry(
        self,
        view_type: str,
        order: int,
        is_hidden: bool = False,
    ) -> Dict[str, Any]:
        entry: Dict[str, Any] = {'order': order}
        if view_type in VIEW_TYPES_WITH_HIDDEN_COLUMN_META:
            entry['hidden'] = is_hidden
        else:
            entry['visible'] = not is_hidden
        return entry

    def _insert_field_into_column_meta(
        self,
        column_meta: Dict[str, Any],
        view_type: str,
        field_id: str,
        reference_field_id: Optional[str],
        insert_position: Optional[str],
        active_field_ids_by_order: List[str],
        visible_field_ids: List[str],
        view_field_order: List[str],
    ) -> Dict[str, Any]:
        if field_id in column_meta:
            return column_meta

        had_column_meta = bool(column_meta)
        if column_meta and reference_field_id in column_meta:
            ordered_ids = sorted(
                column_meta.keys(),
                key=lambda fid: (
                    column_meta.get(fid, {}).get('order', float('inf'))
                    if isinstance(column_meta.get(fid), dict)
                    else float('inf')
                ),
            )
        else:
            base_ids = view_field_order or active_field_ids_by_order
            ordered_ids = [fid for fid in base_ids if fid != field_id]

        ordered_ids = self._insert_field_id_by_reference(
            ordered_ids,
            field_id,
            reference_field_id,
            insert_position,
            {fid: float(index) for index, fid in enumerate(active_field_ids_by_order)},
            (
                float(active_field_ids_by_order.index(field_id))
                if field_id in active_field_ids_by_order
                else float('inf')
            ),
        )

        visible_field_set = set(visible_field_ids)
        next_meta: Dict[str, Any] = {}
        for order, ordered_field_id in enumerate(ordered_ids):
            raw_entry = column_meta.get(ordered_field_id)
            entry = dict(raw_entry) if isinstance(raw_entry, dict) else {}
            entry['order'] = order
            if ordered_field_id == field_id or not had_column_meta:
                is_hidden = (
                    ordered_field_id not in visible_field_set
                    if visible_field_set and ordered_field_id != field_id
                    else False
                )
                entry.update(self._build_column_meta_entry(view_type, order, is_hidden))
            next_meta[ordered_field_id] = entry
        return next_meta

    def _add_field_to_views_at_position(
        self,
        table_id: UUID,
        field: TableField,
        insert_position: str,
        reference_field_id: UUID,
    ) -> None:
        field_id = str(field.id)
        reference_id = str(reference_field_id)
        active_fields = list(
            TableField.objects.using(TABDATA_DB_ALIAS)
            .filter(table_id=table_id, is_deleted=False)
            .only('id', 'order')
            .order_by('order')
        )
        field_order_map = {str(item.id): float(item.order or 0) for item in active_fields}
        active_field_ids_by_order = [str(item.id) for item in active_fields]
        field_order = field_order_map.get(field_id, float(field.order or 0))

        views = list(TableView.objects.using(TABDATA_DB_ALIAS).filter(table_id=table_id))
        to_update = []
        update_fields_set = {'visible_fields', 'field_order', 'column_meta'}
        for view in views:
            changed = False
            vf = view.visible_fields or []
            if vf and field_id not in vf:
                view.visible_fields = self._insert_field_id_by_reference(
                    vf,
                    field_id,
                    reference_id,
                    insert_position,
                    field_order_map,
                    field_order,
                )
                changed = True

            fo = view.field_order or []
            if fo and field_id not in fo:
                view.field_order = self._insert_field_id_by_reference(
                    fo,
                    field_id,
                    reference_id,
                    insert_position,
                    field_order_map,
                    field_order,
                )
                changed = True

            cm = view.column_meta if isinstance(view.column_meta, dict) else {}
            if field_id not in cm:
                view_type = str(getattr(view, 'view_type', '') or '').lower()
                view.column_meta = self._insert_field_into_column_meta(
                    dict(cm),
                    view_type,
                    field_id,
                    reference_id,
                    insert_position,
                    active_field_ids_by_order,
                    view.visible_fields or [],
                    view.field_order or [],
                )
                changed = True

            if changed:
                to_update.append(view)

        if to_update:
            TableView.objects.using(TABDATA_DB_ALIAS).bulk_update(
                to_update,
                list(update_fields_set),
            )

    def _auto_add_field_to_views(
        self,
        table_id: UUID,
        field: TableField,
        insert_position: Optional[str] = None,
        reference_field_id: Optional[UUID] = None,
    ) -> None:
        """
        新建字段后，自动将其加入视图。

        普通新建保持追加语义；从列头左/右插入时，视图顺序必须与用户
        操作的参考字段对齐，否则 Grid 会优先按 column_meta / field_order
        渲染成"总在最右侧"。
        """
        if (
            insert_position in (INSERT_POSITION_BEFORE, INSERT_POSITION_AFTER)
            and reference_field_id
        ):
            self._add_field_to_views_at_position(
                table_id,
                field,
                insert_position,
                reference_field_id,
            )
            return
        self._batch_add_fields_to_views(table_id, [field])

    def _batch_add_fields_to_views(self, table_id: UUID, fields: list) -> None:
        """
        批量将多个新字段追加到所有非空 visible_fields 的视图中。
        同时更新 column_meta，确保新字段在前端立即可见。
        单次查询 + bulk_update，避免 N*M 次写入。
        """
        if not fields:
            return
        new_ids = [str(f.id) for f in fields]
        views = list(TableView.objects.using(TABDATA_DB_ALIAS).filter(table_id=table_id))
        to_update = []
        update_fields_set = {'visible_fields', 'field_order'}
        for view in views:
            changed = False
            vf = view.visible_fields or []
            if vf:
                ids_to_add = [fid for fid in new_ids if fid not in vf]
                if ids_to_add:
                    view.visible_fields = vf + ids_to_add
                    fo = view.field_order or []
                    if fo:
                        fo_to_add = [fid for fid in ids_to_add if fid not in fo]
                        if fo_to_add:
                            view.field_order = fo + fo_to_add
                    changed = True

            cm = view.column_meta if isinstance(view.column_meta, dict) else {}
            cm_ids_to_add = [fid for fid in new_ids if fid not in cm]
            if cm_ids_to_add:
                max_order = max(
                    (m.get('order', 0) for m in cm.values() if isinstance(m, dict)),
                    default=-1,
                ) if cm else -1
                cm = dict(cm)
                view_type = str(getattr(view, 'view_type', '') or '').lower()
                use_hidden = view_type in VIEW_TYPES_WITH_HIDDEN_COLUMN_META
                for i, fid in enumerate(cm_ids_to_add):
                    entry = {'order': max_order + 1 + i}
                    if use_hidden:
                        entry['hidden'] = False
                    else:
                        entry['visible'] = True
                    cm[fid] = entry
                view.column_meta = cm
                update_fields_set.add('column_meta')
                changed = True

            if changed:
                to_update.append(view)
        if to_update:
            TableView.objects.using(TABDATA_DB_ALIAS).bulk_update(to_update, list(update_fields_set))
            # ：column_meta / visible_fields 已改，但原先不发 view 事件；
            # CLI/Agent 导入时前端协作路径只听 table.view.changed / schema.changed，
            # 漏通知会导致 UI 长时间停留在旧视图快照（空列 / 空表）。
            self._publish_views_updated_after_field_add(table_id, to_update)

    def _publish_views_updated_after_field_add(self, table_id: UUID, views: list) -> None:
        """字段追加进视图后广播 view.changed（事务提交后）。"""
        from apps.tabdata.subscribers._utils import run_after_commit

        table_id_str = str(table_id)
        view_ids = [str(v.id) for v in views]
        user_id = str(self.user.id) if self.user else None

        def _publish() -> None:
            for view_id in view_ids:
                try:
                    table_event_service.publish_view_change(
                        table_id_str,
                        action="update_view",
                        view_id=view_id,
                        metadata={
                            "user_id": user_id,
                            "source": "batch_add_fields_to_views",
                        },
                    )
                except Exception as exc:
                    logger.warning(
                        "[WS] view event after field add failed: table=%s view=%s err=%s",
                        table_id_str, view_id, exc,
                    )

        try:
            run_after_commit(_publish)
        except Exception as exc:
            logger.warning("[WS] view event after field add setup failed: %s", exc)

    def _remove_field_from_views(self, table_id: UUID, field_id_str: str) -> None:
        """
        字段删除后，从所有视图的 visible_fields / field_order / column_meta 中移除该字段 ID。
        与 _batch_add_fields_to_views 对称。
        """
        strip_field_from_views(table_id, field_id_str)

    def list_tables(
        self,
        organization_id: Optional[UUID] = None,
        space_id: Optional[UUID] = None,
        search: Optional[str] = None,
        is_archived: Optional[bool] = False,
        is_trashed: Optional[bool] = False,
        include_system: Optional[bool] = None,
    ) -> QuerySet:
        """
        获取表格列表（按 Organization）。

        ：``space_id`` 已废弃。若只传 space_id，会反查其 Organization 后按
        组织列全部表（含历史仍带 space_id 的行与 org-only 行）。
        """
        resolved_organization_id = organization_id
        if space_id and not resolved_organization_id:
            from apps.tabtinspace.services.host_resolver import resolve_host
            host = resolve_host(space_id)
            if host is None:
                return Table.objects.none()
            resolved_organization_id = getattr(host, "organization_id", None)
            logger.info(
                "list_tables: deprecated space_id=%s → organization_id=%s ",
                space_id, resolved_organization_id,
            )

        if not resolved_organization_id:
            return Table.objects.none()

        if not self.check_organization_permission(str(resolved_organization_id), 'viewer'):
            return Table.objects.none()

        #  / ：组织只做归属边界；列表只返回当前用户可读表
        # （owner ∪ 有效 TablePermission），不再按组织角色放行全组织表。
        queryset = Table.objects.using(TABDATA_DB_ALIAS).filter(
            organization_id=resolved_organization_id,
        ).filter(self.build_table_permission_filter_q("viewer"))

        # 搜索
        if search:
            queryset = queryset.filter(
                Q(name__icontains=search) |
                Q(description__icontains=search)
            )

        # 过滤归档状态
        queryset = queryset.filter(is_archived=is_archived)

        # 过滤回收站状态（trashed_at NULL = 未删；NOT NULL = 在回收站）
        if is_trashed:
            queryset = queryset.filter(trashed_at__isnull=False)
        else:
            queryset = queryset.filter(trashed_at__isnull=True)

        # 过滤可见性
        if include_system is None:
            # 默认：返回 normal + system，隐藏 hidden
            queryset = queryset.exclude(visibility=Table.VISIBILITY_HIDDEN)
        elif not include_system:
            # 仅返回普通表
            queryset = queryset.filter(visibility=Table.VISIBILITY_NORMAL)
        # include_system=True 时不过滤，返回全部

        return queryset.select_related('owner', 'default_view').order_by('-created_at')

    def get_table(self, table_id: UUID, *, allow_trashed: bool = False) -> Optional[Table]:
        """
        获取表格详情。

        Returns:
            Table: 有 viewer 权限时的表格对象。

        Raises:
            PermissionError: 表存在、当前用户是同组织成员，但没有资源级 viewer 权限。
            ValueError: 表已在回收站且未显式 allow_trashed（对齐 TabDoc 活跃读门禁）。
            跨组织探测仍返回 None（由 API 映射为 404，防枚举）。
        """
        try:
            table = Table.objects.using(TABDATA_DB_ALIAS).get(id=table_id)
        except Table.DoesNotExist:
            return None

        if self.check_table_permission(str(table_id), 'viewer'):
            # ：活跃打开链路拒绝回收站表；restore/permanent 等入口显式 allow_trashed
            if not allow_trashed and table.is_trashed:
                raise ValueError(_("tabdata.table_in_trash_not_accessible"))
            return table

        org_id = getattr(table, 'organization_id', None)
        if org_id and self.check_organization_permission(str(org_id), 'viewer'):
            raise PermissionError(_("auth.permission_denied"))
        return None

    @transaction.atomic(using=TABDATA_DB_ALIAS)
    def create_table(
        self,
        organization_id: Optional[UUID] = None,
        space_id: Optional[UUID] = None,
        name: str = '',
        description: Optional[str] = None,
        icon: Optional[str] = None,
        use_default_fields: bool = True,
        schema_history_id: Optional[UUID] = None,
        default_source_url: Optional[str] = None,
        collection_id: Optional[UUID] = None,
        parent_item_id: Optional[UUID] = None,
    ) -> Optional[Table]:
        """
        创建表格。

        ：表只挂 Organization。``space_id`` 参数已废弃——传入会被忽略，
        落库恒为 ``NULL``，权限只校验 Organization editor。

        Args:
            organization_id: 所属 Organization ID（必填）
            space_id: 已废弃，忽略
            name: 表格名称
            description: 描述
            icon: 图标
            use_default_fields: 是否使用默认字段模板（标题、状态、创建时间）
            schema_history_id: 关联的Schema历史记录ID（可选，用于定时刷新）
            default_source_url: 默认数据源URL（可选，用于定时刷新）
            parent_item_id:  知识库树父 ContextItem

        Returns:
            Table: 创建的表格，如果无权限则返回None
        """
        if not organization_id:
            raise ValueError("organization_id 必填")

        if not self.user:
            raise ValueError("用户未登录")

        if space_id:
            logger.info(
                "create_table: ignoring deprecated space_id=%s (org-only )",
                space_id,
            )

        resolved_organization_id = organization_id
        if not self.check_organization_permission(str(organization_id), 'editor'):
            return None
        from apps.tabtinspace.models import Organization
        try:
            # 串行化同组织的建表额度检查，但不阻塞附件计费等引用组织的外键写入。
            # PostgreSQL NO KEY UPDATE 仍与另一个建表锁冲突，同时兼容 FK KEY SHARE。
            organization = (
                Organization.objects.using(TABDATA_DB_ALIAS)
                .select_for_update(no_key=True)
                .get(id=organization_id)
            )
        except Organization.DoesNotExist:
            return None
        resolved_organization_id = organization.id

        # 与 TabDoc 对齐：暂停 / 只读 / 禁资源写入时拦截表格创建
        assert_organization_resource_write_allowed_optional(resolved_organization_id)

        collection_uuid = None
        if collection_id:
            collection_qs = Collection.objects.filter(id=collection_id).filter(
                Q(workspace__organization_id=resolved_organization_id)
                | Q(project__organization_id=resolved_organization_id)
                | Q(organization_id=resolved_organization_id)
            )
            if not collection_qs.exists():
                raise ValueError(_("tabdata.collection_not_in_same_space"))
            collection_uuid = collection_id

        parent_item_uuid = None
        if parent_item_id:
            from apps.tabtinspace.models import ContextItem as CtxItem
            from apps.tabtinspace.services.context_item_parent import (
                resolve_parent_item,
                validate_parent_for_item,
            )

            parent_ctx = resolve_parent_item(parent_item_id)
            host_stub = CtxItem(
                organization_id=resolved_organization_id,
                item_type="tabdata",
            )
            validate_parent_for_item(item=None, parent=parent_ctx, host_item=host_stub)
            parent_item_uuid = parent_item_id

        normalized_name = self._normalize_table_name(name)

        QuotaService().check_quota(
            quota_type='max_tables',
            increment=1,
            organization_id=str(resolved_organization_id) if resolved_organization_id else None,
            actor=self.user,
        )

        table = Table.objects.using(TABDATA_DB_ALIAS).create(
            organization_id=resolved_organization_id,
            space_id=None,
            name=normalized_name,
            description=description or '',
            icon=icon or '📊',
            owner_id=self.user.id,
            is_archived=False,
            schema_history_id=schema_history_id,
            default_source_url=default_source_url or ''
        )

        # 创建默认字段（仅「标题」主字段；状态 / 创建时间不再默认下发）
        if use_default_fields:
            default_fields = [
                {
                    'name': _('tabdata.default_field_title'),
                    'field_type': 'text',
                    'is_primary': True,
                    'order': 0,
                    'description': _('tabdata.default_field_title_desc')
                }
            ]

            from apps.tabdata.utils.choice_utils import normalize_select_choices
            for field_data in default_fields:
                config = field_data.get('config', {})
                if 'choices' in config:
                    config = {**config, 'choices': normalize_select_choices(config['choices'])}
                TableField.objects.using(TABDATA_DB_ALIAS).create(
                    table=table,
                    name=field_data['name'],
                    field_type=field_data['field_type'],
                    is_primary=field_data['is_primary'],
                    order=field_data['order'],
                    description=field_data['description'],
                    config=config,
                )
        # ✅ 改造：use_default_fields=False 时不创建任何字段
        # 采集场景下，前端会立即批量创建字段，不需要默认的"标题"字段
        # else:
        #     TableField.objects.create(
        #         table=table,
        #         name='标题',
        #         field_type='text',
        #         is_primary=True,
        #         order=0,
        #         description='记录标题'
        #     )

        self._refresh_field_count(table.id, table)

        # ── 原生列存储：创建 native schema / table / columns ──
        # 无 Space 时 schema 分区改用 organization_id（as_{org_hex}），
        # 见 resolve_schema_partition_id。
        created_fields = list(TableField.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=table.id, is_deleted=False,
        ))
        self._native_ensure_table(resolve_schema_partition_id(table), table.id, created_fields)

        # 创建初始表格视图。default_view 字段仅作为旧接口兼容锚点，语义上等同 order 第一的视图。
        default_view = TableView.objects.using(TABDATA_DB_ALIAS).create(
            table=table,
            name='表格视图',
            view_type='grid',
            description='',
            filters=[],
            sorts=[],
            visible_fields=[],
            field_order=[],
            column_meta={},
            created_by=self.user,
            order=0
        )
        table.default_view = default_view
        table.save(update_fields=['default_view'])

        # 新建表格不预填任何记录：新表即空表（0 条记录）。
        # ：曾由前端 prefillNewTableRows 落库 12 条空白行做"可见占位"，
        # 用户一建表就会看到 12 条无业务数据的"记录"。空白可输入行改由网格
        # 常驻 append row 提供，不落库。

        # ：与 TabDoc 对齐，ContextItem / 搜索向量 / WS 推送放到 commit 之后，
        # 避免在 Organization 行锁仍持有时做额外写与推送，缩短同组织并发创建排队。
        _table_for_bridge = table
        _user_for_bridge = self.user
        _collection_for_bridge = collection_uuid
        _parent_item_for_bridge = parent_item_uuid
        transaction.on_commit(
            lambda: ResourceBridge.on_create(
                _table_for_bridge,
                user=_user_for_bridge,
                collection_id=_collection_for_bridge,
                parent_item_id=_parent_item_for_bridge,
            ),
            using=TABDATA_DB_ALIAS,
        )
        return table

    @transaction.atomic(using=TABDATA_DB_ALIAS)
    def update_table(
        self,
        table_id: UUID,
        name: Optional[str] = None,
        description: Optional[str] = None,
        icon: Optional[str] = None
    ) -> Optional[Table]:
        """
        更新表格

        Args:
            table_id: 表格ID
            name: 新名称
            description: 新描述
            icon: 新图标

        Returns:
            Table: 更新后的表格，如果无权限则返回None
        """
        # 检查权限（需要editor或owner）
        if not self.check_table_permission(str(table_id), 'editor'):
            return None

        try:
            table = Table.objects.using(TABDATA_DB_ALIAS).select_for_update().get(id=table_id)
            assert_organization_resource_write_allowed_optional(table.organization_id)

            if name is not None:
                normalized_name = self._normalize_table_name(name)
                if table.name != normalized_name:
                    table.name = normalized_name
            if description is not None:
                table.description = description
            if icon is not None:
                table.icon = icon

            table.save()
            if name is not None:
                self._invalidate_resolver_cache(resolve_schema_partition_id(table))
            ResourceBridge.on_update(table, user=self.user)
            return table

        except Table.DoesNotExist:
            return None

    @transaction.atomic(using=TABDATA_DB_ALIAS)
    def archive_table(self, table_id: UUID) -> bool:
        """
        归档表格

        Args:
            table_id: 表格ID

        Returns:
            bool: 是否归档成功
        """
        if not self.check_table_permission(str(table_id), 'editor'):
            return False

        try:
            table = Table.objects.using(TABDATA_DB_ALIAS).get(id=table_id)
            assert_organization_resource_write_allowed_optional(table.organization_id)
            table.is_archived = True
            table.save()
            ResourceBridge.on_archive(table, user=self.user)
            return True
        except Table.DoesNotExist:
            return False

    @transaction.atomic(using=TABDATA_DB_ALIAS)
    def restore_table(self, table_id: UUID) -> bool:
        """
        恢复归档的表格

        Args:
            table_id: 表格ID

        Returns:
            bool: 是否恢复成功
        """
        if not self.check_table_permission(str(table_id), 'editor'):
            return False

        try:
            table = Table.objects.using(TABDATA_DB_ALIAS).get(id=table_id)
            assert_organization_resource_write_allowed_optional(table.organization_id)
            table.is_archived = False
            table.save()
            fields = list(TableField.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=table.id, is_deleted=False,
            ))
            self._native_ensure_table(resolve_schema_partition_id(table), table.id, fields)
            ResourceBridge.on_restore(table, user=self.user)
            return True
        except Table.DoesNotExist:
            return False

    _TABLE_DELETE_BATCH = 2000

    def _batch_pre_cleanup_table_records(self, table_id: UUID) -> None:
        """分批预清理表格下的高量级关联数据，将 table.delete() 的级联规模从 O(N×7) 降到 O(1)。

        设计说明：预清理有意在 table.delete() 的 atomic 事务外执行，
        以避免单个超长事务锁住数据库。权衡：若预清理后 table.delete() 失败，
        Table 仍在但部分关联数据已删除——这是可接受的，因为重试时 table.delete()
        的级联规模已经很小，可快速完成。预清理本身是幂等的。
        """
        from apps.tabdata.models import (
            RecordHistoryItem, RecordHistory,
            AttachmentUpload, AttachmentReference, RecordComment,
            LinkRecord,
        )
        db = TABDATA_DB_ALIAS
        batch = self._TABLE_DELETE_BATCH

        targets: list[tuple[type[models.Model], Q]] = [
            (RecordHistoryItem,    Q(record__table_id=table_id)),
            (RecordHistory,        Q(record__table_id=table_id)),
            (RecordComment,        Q(record__table_id=table_id)),
            (AttachmentUpload,     Q(table_id=table_id)),
            (AttachmentReference,  Q(table_id=table_id)),
            (LinkRecord,           Q(self_record__table_id=table_id) | Q(foreign_record__table_id=table_id)),
            (TableRecord,          Q(table_id=table_id)),
        ]

        for model, condition in targets:
            total = 0
            try:
                while True:
                    ids = list(
                        model.objects.using(db)
                        .filter(condition)
                        .values_list('id', flat=True)[:batch]
                    )
                    if not ids:
                        break
                    deleted, _ = model.objects.using(db).filter(id__in=ids).delete()
                    total += deleted
            except Exception:
                logger.warning(
                    "[TableCleanup] pre_cleanup %s failed after deleting %d rows, table=%s",
                    model.__name__, total, table_id, exc_info=True,
                )
                raise
            if total:
                logger.info(
                    "[TableCleanup] pre_cleanup %s: deleted=%d table=%s",
                    model.__name__, total, table_id,
                )

    def delete_table(self, table_id: UUID) -> bool:
        """
        删除表格（永久删除）

        C3 / Wave 1.3：bump ``schema_version_token`` + 删除业务必须在同一事务,
        否则 token 已变但表删失败（如 native_drop 异常）→ 活表所有未消费 task
        全部 ``assert_table_token_or_skip`` 返 False → 业务被冻结（P0 修复
        Review §1）。

        Args:
            table_id: 表格ID

        Returns:
            bool: 是否删除成功

        Raises:
            PermissionError: 系统表不可删除
        """
        from apps.tabdata.services.schema_version_token import bump_table_schema_version_token

        try:
            table = Table.objects.using(TABDATA_DB_ALIAS).get(id=table_id)

            if table.is_system_table:
                raise PermissionError("系统表不可删除")

            assert_organization_resource_write_allowed_optional(table.organization_id)

            if not self.check_organization_permission(str(table.organization_id), 'owner'):
                return False

            self._batch_pre_cleanup_table_records(table_id)

            # P0 修复：bump 必须与 native_drop / table.delete() 同一事务,
            # 失败时 token 也一起回滚（trash → skill 任务自动恢复正常运行）
            with transaction.atomic(using=TABDATA_DB_ALIAS):
                bump_table_schema_version_token(
                    table_id, reason="delete", user=self.user,
                )

                self._native_drop_table(resolve_schema_partition_id(table), table.id)

                if not ResourceBridge.on_delete(table, user=self.user):
                    logger.warning(
                        "[PermanentDelete] ResourceBridge.on_delete 返回 False, "
                        "ContextItem 可能未清理: %s(%s)",
                        type(table).__name__, table.id,
                    )
                table.delete()
            return True

        except Table.DoesNotExist:
            return False

    @transaction.atomic(using=TABDATA_DB_ALIAS)
    def trash_table(self, table_id: UUID) -> bool:
        """将表格移入回收站。

        C3 / Wave 1.3：trash 前 bump ``schema_version_token``，让所有未消费的旧任务
        校验失败 no-op；同样 restore_from_trash 时也会再次 bump（双重防御：
        防止 trash 期间发布的任务在 restore 后误执行残留的旧逻辑）。
        """
        from apps.tabdata.services.schema_version_token import bump_table_schema_version_token

        # ：trash 仅 owner / resource admin（与 can_trash 能力位对齐）
        if not self.check_table_permission(str(table_id), 'admin'):
            return False

        try:
            table = Table.objects.using(TABDATA_DB_ALIAS).get(id=table_id)
        except Table.DoesNotExist:
            return False

        if table.is_system_table:
            raise PermissionError("系统表不可删除")

        # ：源已在回收站时幂等成功，仅补齐 ContextItem（避免重复 bump）
        if table.is_trashed:
            if not ResourceBridge.on_trash(table, user=self.user):
                raise ValueError(_("tabdata.trash_context_sync_failed"))
            return True

        table.trash(user_id=self.user.id if self.user else None)
        # C3：bump 在 trash 之后（先 trash 再 bump 让 ChangeLog summary 与状态一致）
        bump_table_schema_version_token(
            table_id, reason="trash", user=self.user,
        )
        # ：源资源与 ContextItem 必须同步 trash，否则整笔事务回滚
        if not ResourceBridge.on_trash(table, user=self.user):
            raise ValueError(_("tabdata.trash_context_sync_failed"))
        return True

    def _can_manage_personal_trashed_table(self, table: Table) -> bool:
        """个人回收站：删除者可恢复/永删（历史空 trashed_by 回退 owner）。"""
        from apps.tabtinspace.services.cloud_resource_acl import is_personal_trash_operator

        return is_personal_trash_operator(
            self.user,
            trashed_by=getattr(table, 'trashed_by', None),
            created_by_id=getattr(table, 'owner_id', None),
        )

    @transaction.atomic(using=TABDATA_DB_ALIAS)
    def restore_table_from_trash(self, table_id: UUID) -> bool:
        """从回收站恢复表格。

        C3 / Wave 1.3：restore 时 bump ``schema_version_token``，确保 trash 期间
        发布的旧任务（不应该在 restore 后再触发）失效，强制以 restore 后的"全新
        生命周期"重新发布。
        """
        from apps.tabdata.services.schema_version_token import bump_table_schema_version_token
        from apps.tabtinspace.services.cloud_resource_acl import check_restore_count_quota

        try:
            table = Table.objects.using(TABDATA_DB_ALIAS).get(id=table_id)
            if not table.is_trashed:
                return False
            if not self._can_manage_personal_trashed_table(table):
                return False

            assert_organization_resource_write_allowed_optional(table.organization_id)

            # 锁定 Space 行序列化恢复操作，与 create_table 保持一致
            if table.space_id:
                from apps.tabtinspace.services.host_resolver import lock_host_for_update
                lock_host_for_update(table.space_id, using=TABDATA_DB_ALIAS)

            check_restore_count_quota(
                'tabdata',
                table.organization_id,
                self.user,
            )
            ResourceBridge.check_restore_quota(table)
            table.restore_from_trash()
            # C3：restore 后 bump，强制 trash 期间残留任务失效
            bump_table_schema_version_token(
                table_id, reason="restore", user=self.user,
            )
            fields = list(TableField.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=table.id, is_deleted=False,
            ))
            self._native_ensure_table(resolve_schema_partition_id(table), table.id, fields)
            ResourceBridge.on_restore(table, user=self.user)
            return True
        except Table.DoesNotExist:
            return False

    def permanent_delete_table(self, table_id: UUID) -> bool:
        """从回收站永久删除表格。

        C3 / Wave 1.3：与 ``delete_table`` 同步加 token bump（P0 修复后置入事务内）。
        """
        from apps.tabdata.services.schema_version_token import bump_table_schema_version_token

        try:
            table = Table.objects.using(TABDATA_DB_ALIAS).get(id=table_id)
            if not table.is_trashed:
                raise ValueError("只能永久删除回收站中的表格")
            if table.is_system_table:
                raise PermissionError("系统表不可删除")
            if not self._can_manage_personal_trashed_table(table):
                return False

            user_id = getattr(self.user, "id", None)
            logger.debug(
                "[PermanentDelete] module=tabdata resource=%s name=%r user=%s",
                table.id, table.name, user_id,
            )

            self._batch_pre_cleanup_table_records(table_id)

            # P0 修复：bump 进事务,与 native drop / orm delete 同存亡
            with transaction.atomic(using=TABDATA_DB_ALIAS):
                bump_table_schema_version_token(
                    table_id, reason="permanent_delete", user=self.user,
                )
                self._native_drop_table(resolve_schema_partition_id(table), table.id)
                if not ResourceBridge.on_delete(table, user=self.user):
                    logger.warning(
                        "[PermanentDelete] ResourceBridge.on_delete 返回 False, "
                        "ContextItem 可能未清理: %s(%s)",
                        type(table).__name__, table.id,
                    )
                table.delete()
            return True
        except Table.DoesNotExist:
            return False

    # ==================== 字段管理 ====================

    def list_fields(self, table_id: UUID) -> QuerySet:
        """
        获取表格的字段列表

        Args:
            table_id: 表格ID

        Returns:
            QuerySet: 字段查询集（不包含已删除的字段；已按有效角色过滤 visibility_roles）
        """
        if not self.check_table_permission(str(table_id), 'viewer'):
            return TableField.objects.none()

        from apps.tabdata.services.field_visibility import (
            get_visible_fields,
            resolve_effective_table_role,
        )

        qs = TableField.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=table_id,
            is_deleted=False,
        ).order_by('order')
        role = resolve_effective_table_role(self.user, table_id)
        if role is None:
            return TableField.objects.none()

        visible = get_visible_fields(table_id, role, fields=list(qs))
        visible_ids = [field.id for field in visible]
        if not visible_ids:
            return TableField.objects.none()
        # 保持 order：用 id__in 后再按原 order 排序
        return qs.filter(id__in=visible_ids)

    def get_field(self, field_id: UUID) -> Optional[TableField]:
        """
        获取字段详情

        Args:
            field_id: 字段ID

        Returns:
            TableField: 字段对象，如果无权限、已删除或对当前角色不可见则返回None
        """
        try:
            field = TableField.objects.using(TABDATA_DB_ALIAS).get(id=field_id, is_deleted=False)

            # 检查表格权限
            if not self.check_table_permission(str(field.table_id), 'viewer'):
                return None

            # ：与 list_fields 一致——对当前有效角色不可见的字段按「不存在」处理
            from apps.tabdata.services.field_visibility import (
                get_visible_fields,
                resolve_effective_table_role,
            )

            role = resolve_effective_table_role(self.user, field.table_id)
            if role is None:
                return None
            visible_ids = {
                f.id for f in get_visible_fields(field.table_id, role)
            }
            if field.id not in visible_ids:
                return None

            return field
        except TableField.DoesNotExist:
            return None

    def _ensure_unique_active_field_name(
        self,
        table_id: UUID,
        name: str,
        *,
        exclude_field_id: Optional[UUID] = None,
    ) -> None:
        """当前表活跃字段名不可重复；编辑时用 exclude_field_id 排除自身。"""
        qs = TableField.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=table_id,
            name=name,
            is_deleted=False,
        )
        if exclude_field_id is not None:
            qs = qs.exclude(id=exclude_field_id)
        if qs.exists():
            raise ValueError(f'字段名称"{name}"已存在，请输入其他字段名称')

    @transaction.atomic(using=TABDATA_DB_ALIAS)
    def create_field(
        self,
        table_id: UUID,
        name: str,
        field_type: str,
        default_value: Optional[Dict[str, Any]] = None,
        description: Optional[str] = None,
        options: Optional[Dict[str, Any]] = None,
        validation_rules: Optional[Dict[str, Any]] = None,
        insert_position: Optional[str] = None,
        reference_field_id: Optional[UUID] = None,
        expected_schema_version: Optional[int] = None,
        field_id: Optional[UUID] = None,
        *,
        skip_permission_check: bool = False,
    ) -> Optional[TableField]:
        """
        创建字段（同名同类型幂等， / ）

        语义对齐 bulk_create_fields：同名同类型视为目标状态已达成，直接返回已有字段；
        同名不同类型仍报错。客户端超时后重试不会再看到「字段已存在」。

        Args:
            table_id: 表格ID
            name: 字段名称
            field_type: 字段类型
            description: 描述
            options: 字段选项配置
            validation_rules: 字段验证规则
            insert_position: 插入位置（'before' 或 'after'）
            reference_field_id: 参考字段ID（指定在哪个字段前/后插入）
            expected_schema_version: 客户端期望的当前 schema_version（可选）。
                若提供且与服务端不一致，则抛出 SchemaVersionMismatchError（409 冲突）。

        Returns:
            TableField: 创建的字段（或已存在的同名同类型字段），如果无权限则返回None

        Raises:
            SchemaVersionMismatchError: 当提供了 expected_schema_version 且版本不匹配时
        """
        # 检查权限（需要editor或owner）。collab persist 已在 collab API 边界鉴权，
        # 内部 schema 快照回放可显式跳过此处的二次 user 映射校验。
        if not skip_permission_check and not self.check_table_permission(str(table_id), 'editor'):
            return None

        # 系统表保护：不可增加字段。始终 select_for_update，与 bulk FH-012 对齐，
        # 序列化同名校验，避免并发双写撞 uniq_active_field_name_per_table。
        try:
            table = (
                Table.objects.using(TABDATA_DB_ALIAS)
                .select_for_update()
                .get(id=table_id)
            )
            if expected_schema_version is not None and table.schema_version != expected_schema_version:
                raise SchemaVersionMismatchError(
                    f"字段结构已被他人修改（期望版本 {expected_schema_version}，"
                    f"当前版本 {table.schema_version}），请刷新后重试",
                    current_version=table.schema_version,
                    expected_version=expected_schema_version,
                )
            if table.is_system_table:
                raise PermissionError(_("tabdata.system_table_field_immutable", table_name=getattr(table, "name", "") or str(getattr(table, "id", ""))))
            assert_organization_resource_write_allowed_optional(table.organization_id)
        except Table.DoesNotExist:
            return None

        field_type = resolve_field_type_alias(field_type)
        valid_field_types = {choice[0] for choice in TableField.FIELD_TYPE_CHOICES}
        if field_type not in valid_field_types:
            raise ValueError(f"不支持的字段类型: {field_type}")

        existing_same_name = (
            TableField.objects.using(TABDATA_DB_ALIAS)
            .filter(table_id=table_id, name=name, is_deleted=False)
            .first()
        )
        if existing_same_name is not None:
            if existing_same_name.field_type == field_type:
                if field_id is not None and existing_same_name.id != field_id:
                    logger.info(
                        "create_field idempotent reuse: table=%s name=%s "
                        "existing_id=%s requested_id=%s",
                        table_id,
                        name,
                        existing_same_name.id,
                        field_id,
                    )
                return existing_same_name
            raise ValueError(f'字段名称"{name}"已存在，请输入其他字段名称')

        normalized_options = self._normalize_field_options(table_id, field_type, options)
        from apps.tabdata.utils.default_values import validate_default_value
        normalized_default = validate_default_value(field_type, default_value, normalized_options)
        # 计算插入位置的 order 值
        if insert_position and reference_field_id:
            try:
                reference_field = TableField.objects.using(TABDATA_DB_ALIAS).get(
                    id=reference_field_id,
                    table_id=table_id,
                    is_deleted=False
                )
                reference_order = reference_field.order

                # 根据插入位置计算新字段的 order
                if insert_position == 'before':
                    # 在参考字段之前插入
                    new_order = reference_order
                else:  # after
                    # 在参考字段之后插入
                    new_order = reference_order + 1

                # 将受影响的字段的 order 值后移
                TableField.objects.using(TABDATA_DB_ALIAS).filter(
                    table_id=table_id,
                    is_deleted=False,
                    order__gte=new_order
                ).update(order=F('order') + 1)

            except TableField.DoesNotExist:
                # 参考字段不存在，则添加到末尾
                new_order = TableField.objects.using(TABDATA_DB_ALIAS).filter(
                    table_id=table_id,
                    is_deleted=False
                ).count()
        else:
            # 未指定插入位置，添加到末尾
            new_order = TableField.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=table_id,
                is_deleted=False
            ).count()

        # 创建字段（savepoint 吞掉竞态 IntegrityError，按同名同类型回查）
        try:
            with transaction.atomic(using=TABDATA_DB_ALIAS):
                field = TableField.objects.using(TABDATA_DB_ALIAS).create(
                    id=field_id or uuid4(),
                    table_id=table_id,
                    name=name,
                    field_type=field_type,
                    is_primary=False,
                    default_value=normalized_default,
                    order=new_order,
                    description=description or '',
                    config=normalized_options,
                    validation_rules=dict(validation_rules or {}),
                )
        except IntegrityError:
            raced = (
                TableField.objects.using(TABDATA_DB_ALIAS)
                .filter(table_id=table_id, name=name, is_deleted=False)
                .first()
            )
            if raced is not None and raced.field_type == field_type:
                logger.warning(
                    "create_field IntegrityError reconciled: table=%s name=%s field_id=%s",
                    table_id,
                    name,
                    raced.id,
                )
                return raced
            raise ValueError(f'字段名称"{name}"已存在，请输入其他字段名称') from None

        # ── 关联字段：在 native 列建之前创建对称字段并注册依赖边 ──
        field = self._initialize_advanced_field_pre_native(field, normalized_options)

        # ── 原生列存储：添加字段列 ──
        if not is_system_field(field_type):
            self._native_add_column(table_id, field)

        self._initialize_advanced_field_post_native(field)

        self._refresh_field_count(table_id)
        self._increment_schema_version(table_id)

        if field_type == 'link':
            self._sync_table_records_to_ydoc(table_id, source=f"create_field:{field_type}")

        self._auto_add_field_to_views(
            table_id,
            field,
            insert_position=insert_position,
            reference_field_id=reference_field_id,
        )

        try:
            self._get_operation_service().push_create_fields(
                table_id=table_id,
                fields=[field],
                window_id=get_current_window_id(),
            )
        except Exception as exc:
            logger.warning("[UndoRedo] 字段创建操作入栈失败 field_id=%s err=%s", field.id, exc)
        self._publish_field_event(table_id, "create_field", [field])
        self._trigger_field_version_history(
            table_id, "create_field",
            change_type=CHANGE_TYPE_CREATE_FIELD,
            summary=f"创建字段 '{name}' ({field_type})",
            field_details=[{"id": str(field.id), "name": name, "field_type": field_type}],
        )
        return field

    @transaction.atomic(using=TABDATA_DB_ALIAS)
    def bulk_create_fields(
        self,
        table_id: UUID,
        fields_data: List[Dict[str, Any]],
        *,
        push_to_undo_stack: bool = True,
    ) -> Tuple[List[TableField], List[str], List[Dict[str, str]]]:
        """
        批量创建字段（幂等语义，）

        bulk-add 的语义是"确保这些字段存在"：同名同类型字段视为已就绪，
        记入 skipped 而非 error——部分成功后按原批重试不再整批失败。
        同名不同类型仍报错，避免调用方误以为字段类型是自己声明的那个。

        Args:
            table_id: 表格ID
            fields_data: 字段数据列表，每项包含 name, field_type, description, options
            push_to_undo_stack: 是否写入窗级 undo 栈。导入自动建列应传 False，
                与导入行侧 push_to_stack=False 对齐，避免连续撤销软删导入字段导致空壳表。

        Returns:
            Tuple[List[TableField], List[str], List[Dict[str, str]]]:
                (成功创建的字段列表, 错误信息列表, 幂等跳过的字段列表 [{name, field_type}])
        """
        # 检查权限（需要editor或owner）
        if not self.check_table_permission(str(table_id), 'editor'):
            return [], ["无权限创建字段"], []

        if len(fields_data) > MAX_BULK_FIELDS:
            raise ValueError(f"单次最多创建 {MAX_BULK_FIELDS} 个字段，请分批提交")

        created_fields = []
        errors = []
        skipped: List[Dict[str, str]] = []

        # FH-012: 锁定 Table 行序列化并发请求，消除字段名重复校验的竞态窗口。
        # 在 READ COMMITTED 下，无锁的 SELECT 无法阻止并发事务同时通过重复检查。
        try:
            table_for_control = Table.objects.using(TABDATA_DB_ALIAS).select_for_update().get(id=table_id)
        except Table.DoesNotExist:
            return [], ["表格不存在"], []
        assert_organization_resource_write_allowed_optional(table_for_control.organization_id)

        # 获取表格当前的字段数量，作为起始 order
        current_field_count = TableField.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=table_id,
            is_deleted=False
        ).count()

        # 已存在字段的 name → field_type 映射，用于去重检查与同类型幂等判定
        existing_field_types_by_name = dict(
            TableField.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=table_id,
                is_deleted=False
            ).values_list('name', 'field_type')
        )

        # ✅ 检查前端是否指定了主字段
        has_primary_in_request = any(f.get('is_primary', False) for f in fields_data)

        # ✅ 检查表格是否已有主字段
        has_existing_primary = TableField.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=table_id,
            is_deleted=False,
            is_primary=True
        ).exists()

        # 批量验证和准备数据
        fields_to_create = []
        created_names = set()  # 记录本次批量创建中已使用的字段名
        # 记录每个字段的规范化选项，便于后续按名称回查做高级字段初始化
        normalized_options_by_name: Dict[str, Dict[str, Any]] = {}

        for idx, field_data in enumerate(fields_data):
            field_name = field_data.get('name')
            field_type = field_data.get('field_type')

            # 验证必填字段
            if not field_name or not field_type:
                errors.append(f"第{idx+1}个字段: 缺少必填字段 name 或 field_type")
                continue

            # 检查字段名称是否重复（与现有字段或本批次内）
            if field_name in existing_field_types_by_name:
                existing_type = existing_field_types_by_name[field_name]
                if existing_type == field_type:
                    # 幂等 skip：同名同类型 = 目标状态已达成
                    skipped.append({"name": field_name, "field_type": field_type})
                else:
                    errors.append(
                        f"第{idx+1}个字段: 字段名称 '{field_name}' 已存在且类型不同"
                        f"（已有 {existing_type}，请求 {field_type}）"
                    )
                continue

            if field_name in created_names:
                errors.append(f"第{idx+1}个字段: 字段名称 '{field_name}' 在本批次中重复")
                continue

            # 验证字段类型（使用模型定义的字段类型）
            # 从 TableField.FIELD_TYPE_CHOICES 获取所有支持的字段类型
            valid_field_types = {choice[0] for choice in TableField.FIELD_TYPE_CHOICES}

            if field_type not in valid_field_types:
                errors.append(f"第{idx+1}个字段: 不支持的字段类型 '{field_type}'")
                continue

            # ✅ 智能主字段设置
            is_primary = field_data.get('is_primary', False)

            # 如果表格没有任何字段，且前端没有指定主字段，自动将第一个字段设为主字段
            if (current_field_count == 0 and
                idx == 0 and
                not has_primary_in_request and
                not has_existing_primary):
                is_primary = True
                logger.info("表格 %s 没有字段，自动将第一个字段 '%s' 设为主字段", table_id, field_name)

            # 准备创建数据
            try:
                normalized_options = self._normalize_field_options(
                    table_id,
                    field_type,
                    field_data.get('options'),
                )
            except ValueError as exc:
                errors.append(f"第{idx+1}个字段: {exc}")
                continue

            from apps.tabdata.utils.default_values import validate_default_value
            try:
                normalized_default = validate_default_value(
                    field_type,
                    field_data.get('default_value'),
                    normalized_options,
                )
            except ValueError as exc:
                errors.append(f"第{idx+1}个字段: {exc}")
                continue

            field_to_create = TableField(
                table_id=table_id,
                name=field_name,
                field_type=field_type,
                is_primary=is_primary,  # ✅ 使用智能判断后的 is_primary
                default_value=normalized_default,
                order=current_field_count + len(fields_to_create),
                description=field_data.get('description', ''),
                config=normalized_options
            )

            fields_to_create.append(field_to_create)
            created_names.add(field_name)
            normalized_options_by_name[field_name] = normalized_options

        # 批量创建字段
        if fields_to_create:
            try:
                TableField.objects.using(TABDATA_DB_ALIAS).bulk_create(fields_to_create)
                # 重新查询获取带 ID 的字段对象
                created_fields = list(
                    TableField.objects.using(TABDATA_DB_ALIAS).filter(
                        table_id=table_id,
                        name__in=created_names,
                        is_deleted=False
                    ).order_by('order')
                )

                # 对齐单字段路径，确保批量创建的关联字段完成对称字段初始化。
                advanced_field_types = {'link'}
                topo_order = self._topo_sort_advanced_fields(
                    created_fields, normalized_options_by_name,
                )
                for idx in topo_order:
                    field = created_fields[idx]
                    if field.field_type in advanced_field_types:
                        opts = normalized_options_by_name.get(field.name, field.config or {})
                        updated = self._initialize_advanced_field_pre_native(field, opts)
                        created_fields[idx] = updated

                # ── 原生列存储：批量添加字段列 ──
                if created_fields:
                    for field in created_fields:
                        if not is_system_field(field.field_type):
                            self._native_add_column(table_id, field)

                for idx in topo_order:
                    field = created_fields[idx]
                    if field.field_type in advanced_field_types:
                        self._initialize_advanced_field_post_native(field)

                # 更新表格字段计数
                self._refresh_field_count(table_id)
                if created_fields:
                    self._increment_schema_version(table_id)

                self._batch_add_fields_to_views(table_id, created_fields)

                if any(f.field_type == 'link' for f in created_fields):
                    self._sync_table_records_to_ydoc(table_id, source="bulk_create_fields:advanced")

                if push_to_undo_stack:
                    try:
                        self._get_operation_service().push_create_fields(
                            table_id=table_id,
                            fields=created_fields,
                            window_id=get_current_window_id(),
                        )
                    except Exception as exc:
                        logger.warning("[UndoRedo] 批量字段创建操作入栈失败 table_id=%s err=%s", table_id, exc)
                if created_fields:
                    self._publish_field_event(table_id, "batch_create_fields", created_fields)
                    self._trigger_field_version_history(
                        table_id, "batch_create_fields",
                        change_type=CHANGE_TYPE_CREATE_FIELD,
                        summary=f"批量创建 {len(created_fields)} 个字段",
                        field_details=[
                            {"id": str(f.id), "name": f.name, "field_type": f.field_type}
                            for f in created_fields
                        ],
                    )

            except Exception as e:
                # 失败必须整 atomic 回滚，与单字段路径 create_field 行为一致。
                # 当前函数装饰了 @transaction.atomic(using=TABDATA_DB_ALIAS)：
                # 我们 catch 异常后标记 rollback，装饰器退出时会执行 ROLLBACK 而非 COMMIT，
                # bulk_create 写入的字段、advanced init 中已 save 的 config 全部回滚。
                # 同时清空 created_fields，让调用方拿到 ([], errors) 明确"全失败"语义。
                logger.warning(
                    "[bulk_create_fields] 批量创建失败，触发事务回滚 table_id=%s err=%s",
                    table_id, e,
                )
                transaction.set_rollback(True, using=TABDATA_DB_ALIAS)
                errors.append(f"批量创建失败: {str(e)}")
                return [], errors, []

        return created_fields, errors, skipped

    @transaction.atomic(using=TABDATA_DB_ALIAS)
    def update_field(
        self,
        field_id: UUID,
        name: Optional[str] = None,
        description: Optional[str] = None,
        default_value: Any = _DEFAULT_VALUE_UNSET,
        options: Optional[Dict[str, Any]] = None,
        is_hidden: Optional[bool] = None,
        width: Optional[int] = None,
        validation_rules: Optional[Dict[str, Any]] = None,
        visibility_roles: Optional[List[str]] = None,
        is_primary: Optional[bool] = None,
        expected_schema_version: Optional[int] = None,
    ) -> Optional[TableField]:
        """
        更新字段

        Args:
            field_id: 字段ID
            name: 新名称
            description: 新描述
            options: 新选项配置

        Returns:
            TableField: 更新后的字段，如果无权限则返回None
        """
        try:
            # 先无锁解析归属，只用于权限定位；真正写入前统一按
            # Table -> Field 取锁，避免与记录写入的 Table -> Field 顺序反向等待。
            field_table_id = (
                TableField.objects.using(TABDATA_DB_ALIAS)
                .filter(id=field_id, is_deleted=False)
                .values_list('table_id', flat=True)
                .first()
            )
            if field_table_id is None:
                return None

            # 检查权限
            if not self.check_table_permission(str(field_table_id), 'editor'):
                raise PermissionError("无权限更新字段")

            # 系统表保护：不可修改字段结构
            try:
                table = (
                    Table.objects.using(TABDATA_DB_ALIAS)
                    .select_for_update()
                    .get(id=field_table_id)
                )
                assert_organization_resource_write_allowed_optional(table.organization_id)
                if (
                    expected_schema_version is not None
                    and table.schema_version != expected_schema_version
                ):
                    raise SchemaVersionMismatchError(
                        f"字段结构已被他人修改（期望版本 {expected_schema_version}，"
                        f"当前版本 {table.schema_version}），请刷新后重试",
                        current_version=table.schema_version,
                        expected_version=expected_schema_version,
                    )
                if table.is_system_table:
                    raise PermissionError(_("tabdata.system_table_field_immutable", table_name=getattr(table, "name", "") or str(getattr(table, "id", ""))))
            except Table.DoesNotExist:
                return None

            # Table 锁之后再锁 Field，并重校验字段仍活跃且仍属于探针读取到的表。
            # 字段在两次读取之间被删除或归属变化时，按不存在处理，不能继续写旧对象。
            field = (
                TableField.objects.using(TABDATA_DB_ALIAS)
                .select_for_update()
                .get(
                    id=field_id,
                    table_id=field_table_id,
                    is_deleted=False,
                )
            )
            old_field_payload = self._get_operation_service().serialize_field(field)

            if is_primary is False and field.is_primary:
                raise ValueError("主字段不可取消；请将其他字段设为主字段")
            primary_changed = False
            primary_old_payloads: list[dict] = []
            primary_changed_fields: list[TableField] = []
            if is_primary is True:
                if not field.is_primary and field.field_type not in PRIMARY_FIELD_ALLOWED_TYPES:
                    allowed = "、".join(sorted(PRIMARY_FIELD_ALLOWED_TYPES))
                    raise ValueError(
                        f"字段类型 {field.field_type} 不能设为主字段；仅支持 {allowed}"
                    )

                current_primary_fields = list(
                    TableField.objects.using(TABDATA_DB_ALIAS)
                    .select_for_update()
                    .filter(table_id=field.table_id, is_primary=True, is_deleted=False)
                    .order_by('order', 'id')
                )
                primary_targets: dict[str, TableField] = {
                    str(item.id): item for item in current_primary_fields
                }
                primary_targets[str(field.id)] = field
                primary_old_payloads = [
                    self._get_operation_service().serialize_field(item)
                    for item in primary_targets.values()
                ]

                dirty_primary_fields = [
                    item for item in current_primary_fields if item.id != field.id
                ]
                should_promote_target = not field.is_primary
                if dirty_primary_fields or should_promote_target:
                    primary_changed = True

                for old_primary in dirty_primary_fields:
                    old_primary.is_primary = False
                    old_primary.save(update_fields=['is_primary', 'updated_at'])
                    primary_changed_fields.append(old_primary)

                if should_promote_target:
                    field.is_primary = True

            old_name = field.name
            if name is not None:
                if name != old_name:
                    self._ensure_unique_active_field_name(
                        field.table_id,
                        name,
                        exclude_field_id=field.id,
                    )
                field.name = name
            if description is not None:
                field.description = description
            # 记录字段旧 config（用于后续变更检测）
            old_config = dict(field.config or {})
            old_link_config = old_config if field.field_type == 'link' and options is not None else None
            normalized_options = _DEFAULT_VALUE_UNSET
            if options is not None:
                normalized_options = self._normalize_field_options(
                    field.table_id,
                    field.field_type,
                    options,
                    current_field_id=field.id,
                )
            if options is not None or default_value is not _DEFAULT_VALUE_UNSET:
                from apps.tabdata.services.field_configuration_service import (
                    CONFIG_UNSET,
                    DEFAULT_VALUE_UNSET,
                    apply_field_configuration_change,
                )
                apply_field_configuration_change(
                    field,
                    config=(normalized_options if options is not None else CONFIG_UNSET),
                    default_value=(
                        default_value
                        if default_value is not _DEFAULT_VALUE_UNSET
                        else DEFAULT_VALUE_UNSET
                    ),
                )
            if is_hidden is not None:
                field.is_hidden = is_hidden
            if width is not None:
                if width < 80:
                    raise ValueError("字段宽度不能小于80")
                field.width = width
            if validation_rules is not None:
                field.validation_rules = dict(validation_rules)
            if visibility_roles is not None:
                config = field.config or {}
                config['visibility_roles'] = visibility_roles
                field.config = config

            field.save()

            # ⭐ Link 字段配置变更处理（关系转换、lookupFieldId 变更等）
            if field.field_type == 'link' and old_link_config is not None:
                new_link_config = dict(field.config or {})
                # 保留旧 config 中的 symmetricFieldId（前端不感知此字段）
                if 'symmetricFieldId' not in new_link_config and 'symmetricFieldId' in old_link_config:
                    new_link_config['symmetricFieldId'] = old_link_config['symmetricFieldId']
                    field.config = new_link_config
                    field.save(update_fields=['config'])
                # 检测是否有实质性变更
                check_keys = ('foreignTableId', 'relationship', 'isOneWay', 'lookupFieldId')
                has_link_change = any(
                    old_link_config.get(k) != new_link_config.get(k) for k in check_keys
                )
                if has_link_change:
                    from apps.tabdata.services.link_field_service import LinkFieldService
                    try:
                        LinkFieldService.update_link_field(
                            field, old_link_config, new_link_config,
                            user=self.user,
                        )
                    except PermissionError:
                        raise
                    except Exception as exc:
                        logger.warning("Link 字段配置更新失败 field=%s err=%s", field.id, exc)
                        raise ValueError(f"Link 字段配置更新失败: {exc}") from exc

            # ⭐ 新增：如果是 select/multi_select 且 choices 为空，自动从现有数据补全
            if field.field_type in ['select', 'multi_select']:
                current_config = field.config or {}
                current_choices = current_config.get('choices') or []

                # 如果 choices 为空，尝试自动补全
                if not current_choices:
                    logger.info("字段 %s 是 %s 类型但 choices 为空，尝试自动补全", field_id, field.field_type)
                    populate_result, error = self.populate_field_choices(field_id)

                    if populate_result and not error:
                        logger.info("自动补全成功：%d 个新选项", populate_result.get('added_count', 0))
                        # 刷新字段以获取最新的 config
                        field.refresh_from_db()
                    elif error:
                        logger.warning("自动补全失败：%s", error)

            # : 单选/多选选项重命名后，把已用记录的旧 value 同步迁移到新 value
            if (
                field.field_type in ('select', 'multi_select')
                and options is not None
            ):
                try:
                    self._migrate_select_choice_renames(
                        field,
                        old_config.get('choices') or [],
                        (field.config or {}).get('choices') or [],
                    )
                except Exception as exc:
                    logger.exception(
                        "select choice rename migration failed field=%s err=%s",
                        field.id,
                        exc,
                    )
                    raise ValueError(f"选项重命名后同步记录失败: {exc}") from exc

            # Invalidate resolver cache if field name changed
            if name is not None and name != old_name:
                try:
                    table_obj = Table.objects.using(TABDATA_DB_ALIAS).get(id=field.table_id)
                    self._invalidate_resolver_cache(resolve_schema_partition_id(table_obj))
                except Table.DoesNotExist:
                    pass

            # schema_version 递增：任何影响客户端 field map 缓存的变更都需要递增
            schema_affecting_change = (
                (name is not None and name != old_name)
                or options is not None
                or default_value is not _DEFAULT_VALUE_UNSET
                or is_hidden is not None
                or width is not None
                or validation_rules is not None
                or visibility_roles is not None
                or primary_changed
            )
            if schema_affecting_change:
                self._increment_schema_version(field.table_id)
            try:
                changed_fields_for_history = [*primary_changed_fields, field] if primary_changed else [field]
                old_payloads_for_undo = primary_old_payloads if primary_changed else [old_field_payload]
                new_field_payload = self._get_operation_service().serialize_field(field)
                new_payloads_for_undo = (
                    [
                        self._get_operation_service().serialize_field(item)
                        for item in changed_fields_for_history
                    ]
                    if primary_changed
                    else [new_field_payload]
                )
                self._get_operation_service().push_update_fields(
                    table_id=field.table_id,
                    old_fields=old_payloads_for_undo,
                    new_fields=new_payloads_for_undo,
                    window_id=get_current_window_id(),
                    action_display='设为主字段' if primary_changed else '更新字段',
                )
            except Exception as exc:
                logger.warning("[UndoRedo] 字段更新操作入栈失败 field_id=%s err=%s", field.id, exc)
            if field.field_type == 'link':
                self._sync_table_records_to_ydoc(field.table_id, source=f"update_field:{field.field_type}")

            changed_fields_for_event = [*primary_changed_fields, field] if primary_changed else [field]
            self._publish_field_event(field.table_id, "update_field", changed_fields_for_event)
            self._trigger_field_version_history(
                field.table_id, "update_field",
                change_type=CHANGE_TYPE_UPDATE_FIELD,
                summary=f"将 '{field.name}' 设为主字段" if primary_changed else f"更新字段 '{field.name}'",
                field_details=[
                    {"id": str(item.id), "name": item.name, "field_type": item.field_type}
                    for item in changed_fields_for_event
                ],
            )

            return field

        except (TableField.DoesNotExist, ValueError) as e:
            if isinstance(e, ValueError):
                raise
            return None

    @transaction.atomic(using=TABDATA_DB_ALIAS)
    def reorder_fields(
        self,
        table_id: UUID,
        field_orders: List[Dict[str, Any]],
        expected_schema_version: Optional[int] = None,
    ) -> bool:
        """
        重新排序字段

        Args:
            table_id: 表格ID
            field_orders: 字段排序列表，格式：[{"field_id": "uuid", "sort_order": 0}, ...]
            expected_schema_version: 客户端期望的当前 schema_version（可选）。
                若提供且与服务端不一致，则抛出 SchemaVersionMismatchError（409 冲突）。

        Returns:
            bool: 是否排序成功

        Raises:
            SchemaVersionMismatchError: 当提供了 expected_schema_version 且版本不匹配时
            ValueError: 当 sort_order 缺失时
        """
        if not self.check_table_permission(str(table_id), 'editor'):
            return False

        try:
            # 字段结构写统一先锁 Table，再锁 Field。即使旧客户端没有提供
            # expected_schema_version，也必须持有 Table 锁，避免与记录保存的
            # Table -> Field 路径形成反向等待。
            table_obj = (
                Table.objects.using(TABDATA_DB_ALIAS)
                .select_for_update()
                .get(id=table_id)
            )

            # 乐观锁：若客户端提供了期望版本，在锁住 Table 后比较版本。
            if expected_schema_version is not None:
                if table_obj.schema_version != expected_schema_version:
                    raise SchemaVersionMismatchError(
                        f"字段结构已被他人修改（期望版本 {expected_schema_version}，"
                        f"当前版本 {table_obj.schema_version}），请刷新后重试",
                        current_version=table_obj.schema_version,
                        expected_version=expected_schema_version,
                    )

            # 解析 field_orders，构建 field_id → sort_order 映射
            order_map: Dict[str, int] = {}
            field_ids: List[UUID] = []
            for item in field_orders:
                try:
                    fid = UUID(str(item['field_id']))
                except (ValueError, KeyError):
                    continue
                sort_order = item.get('sort_order')
                if sort_order is None:
                    sort_order = item.get('order')
                if sort_order is None:
                    raise ValueError(f"字段排序缺少 sort_order（field_id={item.get('field_id')}）")
                order_map[str(fid)] = int(sort_order)
                field_ids.append(fid)

            # 行锁：select_for_update 防止并发 TOCTOU
            # 同一事务内独占锁，保证读取 → 修改 → 写入 的原子性
            locked_fields = list(
                TableField.objects.using(TABDATA_DB_ALIAS)
                .select_for_update()
                .filter(id__in=field_ids, table_id=table_id, is_deleted=False)
            )

            # 校验：所有请求的字段都必须存在
            found_ids = {str(f.id) for f in locked_fields}
            for fid in field_ids:
                if str(fid) not in found_ids:
                    raise TableField.DoesNotExist(f"字段 {fid} 不存在或已删除")

            old_field_payloads = [
                self._get_operation_service().serialize_field(f) for f in locked_fields
            ]

            # 批量更新 order：内存修改后一次 bulk_update，避免 N 次 save()
            for field in locked_fields:
                new_order = order_map.get(str(field.id))
                if new_order is not None:
                    field.order = new_order
            TableField.objects.using(TABDATA_DB_ALIAS).bulk_update(locked_fields, ['order'])

            # schema_version 递增（修复遗漏：reorder 同样是 schema 结构变更）
            self._increment_schema_version(table_id)

            refreshed_fields = list(
                TableField.objects.using(TABDATA_DB_ALIAS).filter(
                    id__in=[f.id for f in locked_fields],
                    table_id=table_id,
                )
            )
            new_field_payloads = [
                self._get_operation_service().serialize_field(f) for f in refreshed_fields
            ]
            try:
                self._get_operation_service().push_update_fields(
                    table_id=table_id,
                    old_fields=old_field_payloads,
                    new_fields=new_field_payloads,
                    window_id=get_current_window_id(),
                    action_display='重排字段',
                )
            except Exception as exc:
                logger.warning("[UndoRedo] 字段重排操作入栈失败 table_id=%s err=%s", table_id, exc)
            if refreshed_fields:
                self._publish_field_event(table_id, "reorder_fields", refreshed_fields)
                self._trigger_field_version_history(
                    table_id, "reorder_fields",
                    change_type=CHANGE_TYPE_REORDER_FIELDS,
                    summary=f"重排 {len(refreshed_fields)} 个字段顺序",
                    field_details=[
                        {"id": str(f.id), "name": f.name, "order": f.order}
                        for f in refreshed_fields
                    ],
                )
            return True
        except (Table.DoesNotExist, TableField.DoesNotExist):
            return False

    @transaction.atomic(using=TABDATA_DB_ALIAS)
    def delete_field(
        self,
        field_id: UUID,
        expected_schema_version: Optional[int] = None,
        *,
        skip_permission_check: bool = False,
    ) -> bool:
        """
        删除字段（软删除）

        Args:
            field_id: 字段ID
            expected_schema_version: 客户端期望的当前 schema_version（可选）。
                若提供且与服务端不一致，则抛出 SchemaVersionMismatchError（409 冲突）。

        Returns:
            bool: 是否删除成功

        Raises:
            SchemaVersionMismatchError: 当提供了 expected_schema_version 且版本不匹配时
        """
        try:
            # 先无锁解析归属，只用于权限定位；真正删除前按 Table -> Field
            # 统一取锁，避免与记录保存的 Table -> Field 路径反向等待。
            field_table_id = (
                TableField.objects.using(TABDATA_DB_ALIAS)
                .filter(id=field_id)
                .values_list('table_id', flat=True)
                .first()
            )
            if field_table_id is None:
                raise TableField.DoesNotExist

            # 检查权限。collab persist 已在 collab API 边界鉴权，内部 schema
            # 快照回放可显式跳过此处的二次 user 映射校验。
            if not skip_permission_check and not self.check_table_permission(str(field_table_id), 'editor'):
                raise PermissionError("无权限删除此字段")

            # 乐观锁 + 系统表保护
            try:
                table = (
                    Table.objects.using(TABDATA_DB_ALIAS)
                    .select_for_update()
                    .get(id=field_table_id)
                )
                if expected_schema_version is not None:
                    if table.schema_version != expected_schema_version:
                        raise SchemaVersionMismatchError(
                            f"字段结构已被他人修改（期望版本 {expected_schema_version}，"
                            f"当前版本 {table.schema_version}），请刷新后重试",
                            current_version=table.schema_version,
                            expected_version=expected_schema_version,
                        )
                assert_organization_resource_write_allowed_optional(table.organization_id)
                if table.is_system_table:
                    raise PermissionError(_("tabdata.system_table_field_immutable", table_name=getattr(table, "name", "") or str(getattr(table, "id", ""))))
            except Table.DoesNotExist:
                raise TableField.DoesNotExist from None

            # Table 锁之后再锁 Field，并重校验归属；并发删除或异常归属变化
            # 都按字段不存在处理，不能继续操作探针阶段的旧对象。
            field = (
                TableField.objects.using(TABDATA_DB_ALIAS)
                .select_for_update()
                .get(id=field_id, table_id=field_table_id)
            )
            operation_service = self._get_operation_service()
            field_payload_before_delete = operation_service.serialize_field(field)

            # 主键字段不允许删除
            if field.is_primary:
                raise PrimaryFieldDeleteError(
                    _("tabdata.primary_field_delete_forbidden", field_name=field.name or field.id)
                )

            # ── Link 字段：删除 LinkRecord + 对称字段 ──
            if field.field_type == 'link':
                from apps.tabdata.services.link_field_service import LinkFieldService
                LinkFieldService.delete_link_field(field)

            # ── 统一清理 FieldReference 依赖边（所有字段类型）──
            from apps.tabdata.services.cascade_service import FieldReferenceManager
            try:
                FieldReferenceManager.deregister_field(str(field.id))
            except Exception as exc:
                logger.warning("清理字段依赖边失败 field=%s err=%s", field.id, exc)

            # ── 附件字段：清理 AttachmentReference + deactivate FileUsage ──
            if field.field_type in FILE_BASED_FIELD_TYPES:
                try:
                    from apps.tabdata.services.attachment_service import AttachmentService
                    AttachmentService(user=self.user).cleanup_field_attachments(
                        table_id=field.table_id, field_id=field.id,
                    )
                except Exception as exc:
                    logger.warning(
                        "清理字段附件引用失败 field=%s err=%s", field.id, exc,
                    )

            # 软删除
            table_id_for_event = field.table_id
            needs_ydoc_sync = field.field_type == 'link'
            field.is_deleted = True
            field.save(update_fields=['is_deleted'])

            # ：软删字段**不再**物理 DROP native 列。
            # 旧的 FH-007 即时 drop 会不可逆销毁该列所有单元格数据，与
            # 「删字段可 Ctrl+Z 追悔」承诺（PRD §C1）及回收站
            # field_recycle_cleanup（软删后保留 TTL 才物理 drop）直接冲突——
            # 撤销时 restore_field 的 add_column 只能建回空列，数据已丢。
            # 现在列 + 数据保留至 TTL 清理：活跃读写 / 快照均按 is_deleted
            # 过滤，忽略 dead 列；restore_field 的 add_column IF NOT EXISTS
            # 幂等复用原列，撤销后单元格数据原样回来。

            self._refresh_field_count(table_id_for_event)
            self._increment_schema_version(table_id_for_event)

            if needs_ydoc_sync:
                self._sync_table_records_to_ydoc(table_id_for_event, source=f"delete_field:{field.field_type}")

            self._remove_field_from_views(table_id_for_event, str(field.id))
            # : 入栈失败必须回滚整次删除——否则字段已软删但 Ctrl+Z 无操作可撤。
            # 本方法在 @transaction.atomic 内，异常会触发事务回滚。
            operation_service.push_delete_fields(
                table_id=table_id_for_event,
                fields_before_delete=[field_payload_before_delete],
                window_id=get_current_window_id(),
            )
            self._publish_field_event(table_id_for_event, "delete_field", [field])
            self._trigger_field_version_history(
                table_id_for_event, "delete_field",
                change_type=CHANGE_TYPE_DELETE_FIELD,
                summary=f"删除字段 '{field.name}' ({field.field_type})",
                field_details=[{"id": str(field.id), "name": field.name, "field_type": field.field_type}],
            )
            return True

        except TableField.DoesNotExist:
            raise
        except PrimaryFieldDeleteError:
            raise
        except PermissionError:
            raise
        except SchemaVersionMismatchError:
            raise
        except Exception as exc:
            logger.exception("delete_field unexpected error field=%s", field_id)
            raise

    def can_convert_field(self, field_id: UUID, target_type: str) -> Dict[str, Any]:
        """
        检查字段是否可以转换为目标类型

        Args:
            field_id: 字段ID
            target_type: 目标字段类型

        Returns:
            Dict: 转换检查结果
        """
        try:
            field = TableField.objects.using(TABDATA_DB_ALIAS).get(id=field_id)

            # 检查权限
            if not self.check_table_permission(str(field.table_id), 'viewer'):
                return {
                    'can_convert': False,
                    'error': '无权限访问此字段'
                }

            # 检查是否为主字段
            if field.is_primary:
                # 主字段只能转换为允许的类型
                if target_type not in PRIMARY_FIELD_ALLOWED_TYPES:
                    return {
                        'can_convert': False,
                        'error': f'主字段不能转换为 {target_type} 类型'
                    }

            if target_type == 'link':
                return {
                    'can_convert': False,
                    'field_id': str(field_id),
                    'from_type': field.field_type,
                    'to_type': target_type,
                    'is_primary': field.is_primary,
                    'error': '关联字段不支持通过类型转换直接修改，请新建字段后迁移数据',
                }

            # 检查类型转换是否支持
            can_convert = can_convert_field_type(field.field_type, target_type)

            return {
                'can_convert': can_convert,
                'field_id': str(field_id),
                'from_type': field.field_type,
                'to_type': target_type,
                'is_primary': field.is_primary,
                'error': None if can_convert else f'不支持从 {field.field_type} 转换到 {target_type}'
            }

        except TableField.DoesNotExist:
            return {
                'can_convert': False,
                'error': '字段不存在'
            }

    def preview_field_conversion(
        self,
        field_id: UUID,
        target_type: str,
        target_options: Optional[Dict[str, Any]] = None,
        sample_size: int = 10
    ) -> Dict[str, Any]:
        """
        预览字段类型转换

        Args:
            field_id: 字段ID
            target_type: 目标字段类型
            target_options: 目标字段选项
            sample_size: 采样数量

        Returns:
            Dict: 转换预览结果
        """
        try:
            field = TableField.objects.using(TABDATA_DB_ALIAS).get(id=field_id)

            # 检查权限
            if not self.check_table_permission(str(field.table_id), 'viewer'):
                return {
                    'can_convert': False,
                    'error': '无权限访问此字段'
                }

            # 检查转换是否支持
            conversion_check = self.can_convert_field(field_id, target_type)
            if not conversion_check['can_convert']:
                return conversion_check

            sample_values = self._get_sample_field_values(field, sample_size)

            # 获取转换预览。预览必须复用执行转换的目标类型校验器，
            # 否则会出现“预览 100%，执行失败”的错觉。
            preview_result = self._get_target_conversion_preview(
                target_type,
                sample_values,
                target_options,
            )

            preview_result.update({
                'field_id': str(field_id),
                'field_name': field.name,
                'from_type': field.field_type,
                'to_type': target_type,
                'is_primary': field.is_primary
            })

            return preview_result

        except TableField.DoesNotExist:
            return {
                'can_convert': False,
                'error': '字段不存在'
            }

    @transaction.atomic(using=TABDATA_DB_ALIAS)
    def convert_field_type(
        self,
        field_id: UUID,
        target_type: str,
        target_options: Optional[Dict[str, Any]] = None,
        force: bool = False
    ) -> Dict[str, Any]:
        """
        执行字段类型转换

        使用新的目标类型校验器：能转就转，转不了就清空

        Args:
            field_id: 字段ID
            target_type: 目标字段类型
            target_options: 目标字段选项（可选）
            force: 保留参数，兼容性（新逻辑默认就是智能转换）

        Returns:
            Dict: 转换结果
        """
        try:
            # 先无锁解析归属，只用于权限定位；真正转换前统一按
            # Table -> Field 取锁，避免与记录保存的同序锁链反向等待。
            field_table_id = (
                TableField.objects.using(TABDATA_DB_ALIAS)
                .filter(id=field_id)
                .values_list('table_id', flat=True)
                .first()
            )
            if field_table_id is None:
                raise TableField.DoesNotExist

            if not self.check_table_permission(str(field_table_id), 'editor'):
                return get_error_response(ErrorCode.PERMISSION_DENIED, '无权限修改此字段')

            try:
                convert_table = (
                    Table.objects.using(TABDATA_DB_ALIAS)
                    .select_for_update()
                    .get(id=field_table_id)
                )
            except Table.DoesNotExist:
                raise TableField.DoesNotExist from None

            # Table 锁之后再锁 Field，并重校验字段仍属于探针读取到的表。
            field = (
                TableField.objects.using(TABDATA_DB_ALIAS)
                .select_for_update()
                .get(id=field_id, table_id=field_table_id)
            )

            if field.is_primary and target_type not in PRIMARY_FIELD_ALLOWED_TYPES:
                return get_error_response(
                    ErrorCode.PRIMARY_FIELD_CONVERSION_DENIED,
                    f'主键字段不能转换为 \'{target_type}\' 类型，只允许转换为：{", ".join(sorted(PRIMARY_FIELD_ALLOWED_TYPES))}'
                )

            if target_type == 'link':
                return get_error_response(
                    ErrorCode.UNSUPPORTED,
                    '暂不支持通过字段转换改为关联字段，请新建对应字段后迁移数据'
                )

            # 如果目标类型与当前类型相同，只更新选项
            if field.field_type == target_type:
                if target_options:
                    field.config = target_options
                    if field.default_value is not None:
                        from apps.tabdata.utils.default_values import validate_default_value
                        try:
                            field.default_value = validate_default_value(
                                target_type, field.default_value, field.config,
                            )
                        except ValueError:
                            field.default_value = None
                    field.save()
                return {
                    'success': True,
                    'field_id': str(field_id),
                    'message': '字段选项已更新'
                }

            old_type = field.field_type
            old_config = dict(field.config or {})

            # Table -> Field 已在上方锁定；记录也按稳定主键顺序一次拿齐锁，
            # 与单条/批量记录写的 Table -> Record 顺序保持一致。
            records_qs = (
                TableRecord.objects.using(TABDATA_DB_ALIAS)
                .select_for_update()
                .filter(table_id=field.table_id, is_deleted=False)
                .order_by('id')
            )

            # 第一步：扫描所有记录，转换值
            records_to_update: List[Tuple[TableRecord, List[str], Any]] = []
            auto_create_values: List[Any] = []  # 用于收集自动创建的选项值
            converted_count = 0
            cleared_count = 0

            for record_batch in self._iter_record_batches(records_qs, _FIELD_CONVERSION_BATCH_SIZE):
                self._preload_record_data_for_fields(record_batch, convert_table, [field])

                for record in record_batch:
                    record_data = read_data(record)
                    keys, original_value = self._resolve_field_keys(field, record_data)

                    if not keys:
                        continue

                    # 使用新的目标类型校验器
                    success, converted_value, _error_msg = convert_to_target_type(
                        original_value,
                        target_type,
                        target_options
                    )

                    if success:
                        # 转换成功
                        records_to_update.append((record, keys, converted_value))
                        converted_count += 1

                        # 如果是单选/多选，收集值用于自动创建选项
                        if target_type in ['select', 'multi_select'] and converted_value:
                            auto_create_values.append(converted_value)
                    else:
                        # 转换失败，清空该单元格
                        records_to_update.append((record, keys, None))
                        cleared_count += 1

            # 第二步：如果是单选/多选，且用户没有指定 choices，自动创建选项
            final_target_options = target_options
            auto_created_options = []

            if target_type in ['select', 'multi_select']:
                if not target_options or not target_options.get('choices'):
                    # 自动创建选项
                    auto_created_options = collect_auto_create_options(
                        auto_create_values,
                        target_type
                    )

                    if auto_created_options:
                        final_target_options = {'choices': auto_created_options}
                        # 如果选项太多，警告用户有些值会被清空
                        if len(auto_created_options) >= 200:
                            # 重新过滤，只保留在选项列表中的值
                            filtered_updates = []
                            for record, keys, value in records_to_update:
                                if value is None:
                                    filtered_updates.append((record, keys, value))
                                elif target_type == 'select':
                                    if value in auto_created_options:
                                        filtered_updates.append((record, keys, value))
                                    else:
                                        filtered_updates.append((record, keys, None))
                                        cleared_count += 1
                                        converted_count -= 1
                                elif target_type == 'multi_select':
                                    filtered_value = [v for v in value if v in auto_created_options]
                                    if filtered_value:
                                        filtered_updates.append((record, keys, filtered_value))
                                    else:
                                        filtered_updates.append((record, keys, None))
                                        cleared_count += 1
                                        converted_count -= 1
                            records_to_update = filtered_updates
                    else:
                        # 没有可创建的选项，所有值都清空
                        final_target_options = {'choices': []}

            # 第三步：批量更新记录
            # DATA-1: 整个转换包裹 transaction.atomic，失败自动回滚
            # DATA-2: 分批 bulk_update + 批量预取版本号，消除 N+1
            native_column_available = self._native_field_column_available(convert_table, field)

            try:
                with transaction.atomic(using=TABDATA_DB_ALIAS):
                    operation_group_id = uuid4()
                    window_id = get_current_window_id()

                    for batch_start in range(0, len(records_to_update), _FIELD_CONVERSION_BATCH_SIZE):
                        batch = records_to_update[batch_start:batch_start + _FIELD_CONVERSION_BATCH_SIZE]
                        batch_size = len(batch)

                        max_version = next_record_version(field.table_id, count=batch_size)
                        version_base = max_version - batch_size + 1

                        bulk_records = []
                        history_events = []

                        now = timezone.now()

                        for idx, (record, keys, new_value) in enumerate(batch):
                            cached_data = dict(read_data(record))
                            record_data = dict(record.__dict__.get('data') or {})
                            target_keys = keys or [field.name]
                            field_changes: Dict[str, Dict[str, Any]] = {}

                            # Native preload may contain only the converted field. Preserve
                            # unrelated JSONField keys while removing stale aliases for this field.
                            field_aliases = {str(field.id), field.id.hex, field.name}
                            for alias in field_aliases.difference(target_keys):
                                record_data.pop(alias, None)

                            for key in target_keys:
                                old_value = cached_data.get(key, record_data.get(key))
                                if old_value != new_value:
                                    field_changes[key] = {'old': old_value, 'new': new_value}
                                record_data[key] = new_value

                            record.__dict__['data'] = record_data
                            invalidate_cache(record)
                            record.version = version_base + idx
                            record.updated_at = now
                            if self.user:
                                record.updated_by_id = self.user.id
                            bulk_records.append(record)

                            if field_changes:
                                history_events.append((record, field_changes))

                        update_fields = ['data', 'version', 'updated_at']
                        if self.user:
                            update_fields.append('updated_by')
                        TableRecord.objects.using(TABDATA_DB_ALIAS).bulk_update(
                            bulk_records, update_fields, batch_size=_FIELD_CONVERSION_BATCH_SIZE,
                        )

                        if native_column_available:
                            try:
                                from apps.tabdata.native.record_io import NativeRecordIO
                                from apps.tabdata.native.value_converter import python_to_pg
                                native_io = NativeRecordIO(
                                    resolve_schema_partition_id(convert_table), convert_table.id,
                                )
                                for record, _keys, new_value in batch:
                                    pg_val = python_to_pg(new_value, target_type, field.config)
                                    native_io.update_record(record.id, {field.id.hex: pg_val})
                            except Exception as _exc:
                                logger.warning(
                                    "convert_field_type native sync batch failed: err=%s", _exc,
                                )

                        for record, field_changes in history_events:
                            emit_record_history_event(
                                record=record,
                                action='update',
                                field_changes=field_changes,
                                user=self.user,
                                window_id=window_id,
                                operation_group_id=operation_group_id,
                                editor_type=get_editor_type(),
                                sender=self.convert_field_type,
                            )

                    # 第四步：更新字段类型和配置（在同一事务内）
                    field.field_type = target_type
                    field.config = final_target_options or {}
                    if field.default_value is not None:
                        from apps.tabdata.utils.default_values import validate_default_value
                        try:
                            field.default_value = validate_default_value(
                                target_type, field.default_value, field.config,
                            )
                        except ValueError:
                            field.default_value = None
                    field.save()

                    # ── 原生列存储：修改字段列类型 ──
                    if native_column_available and not is_system_field(target_type):
                        self._native_alter_column_type(
                            field.table_id, field.id,
                            old_type, target_type,
                            config=final_target_options,
                        )

                    # FH-011: schema_version 递增必须在同一事务内，
                    # 确保字段类型变更与版本号递增的原子性
                    self._increment_schema_version(field.table_id)

            except Exception as e:
                return get_error_response(
                    ErrorCode.FIELD_CONVERSION_FAILED,
                    f'转换失败: {str(e)}'
                )

            # ── 类型转换后依赖链清理 ──
            if old_type != target_type:
                # 1. 从 Link 转走：清理 LinkRecord + 对称字段
                if old_type == 'link':
                    try:
                        from apps.tabdata.services.link_field_service import LinkFieldService
                        # delete_link_field 不会软删除主字段，只清理 LinkRecord + 对称字段。
                        # 转换事务中 field.config 已被覆盖，需临时恢复旧配置。
                        saved_config = field.config
                        field.config = old_config
                        try:
                            LinkFieldService.delete_link_field(field)
                        finally:
                            field.config = saved_config
                    except Exception as exc:
                        logger.warning("convert_field_type link cleanup failed field=%s: %s", field.id, exc)

            # 构建返回结果
            result: Dict[str, Any] = {
                'success': True,
                'field_id': str(field_id),
                'from_type': old_type,
                'to_type': target_type,
                'affected_records': len(records_to_update),
                'converted_count': converted_count,
                'cleared_count': cleared_count,
                'forced_null_count': cleared_count,
                'message': self._build_smart_conversion_message(
                    old_type,
                    target_type,
                    len(records_to_update),
                    converted_count,
                    cleared_count
                )
            }

            # 如果自动创建了选项，添加到结果中
            if auto_created_options:
                result['auto_created_options'] = auto_created_options
                result['message'] += f'；自动创建了 {len(auto_created_options)} 个选项'

            if records_to_update:
                try:
                    from apps.tabdata.utils.ydoc_sync import sync_records_to_ydoc
                    affected_records = [r for r, _, _ in records_to_update]
                    sync_records_to_ydoc(
                        field.table_id, affected_records, source="convert_field_type",
                    )
                except Exception as _exc:
                    logger.warning("convert_field_type Y.js sync failed: %s", _exc)

            self._trigger_field_version_history(
                field.table_id, "convert_field_type",
                change_type=CHANGE_TYPE_CONVERT_FIELD,
                summary=f"转换字段 '{field.name}' 类型 {old_type} → {target_type}",
                field_details=[{
                    "id": str(field.id), "name": field.name,
                    "from_type": old_type, "to_type": target_type,
                }],
            )

            return result

        except TableField.DoesNotExist:
            return get_error_response(ErrorCode.FIELD_NOT_FOUND, '字段不存在')

    def _build_conversion_message(
        self,
        from_type: str,
        to_type: str,
        records_with_value: int,
        converted_count: int,
        forced_null_count: int
    ) -> str:
        parts = [f'字段类型已从 {from_type} 转换为 {to_type}']
        if records_with_value:
            parts.append(f'涉及 {records_with_value} 条数据')
            parts.append(f'成功转换 {converted_count} 条')
            if forced_null_count:
                parts.append(f'强制置空 {forced_null_count} 条')
        return '；'.join(parts)

    def _build_smart_conversion_message(
        self,
        from_type: str,
        to_type: str,
        total_records: int,
        converted_count: int,
        cleared_count: int
    ) -> str:
        """构建智能转换的消息"""
        parts = [f'字段类型已从 {from_type} 转换为 {to_type}']
        if total_records:
            parts.append(f'涉及 {total_records} 条数据')
            if converted_count:
                parts.append(f'成功转换 {converted_count} 条')
            if cleared_count:
                parts.append(f'清空 {cleared_count} 条（无法转换）')
        return '；'.join(parts)

    def _resolve_field_keys(self, field: TableField, data: Dict[str, Any]) -> Tuple[List[str], Any]:
        """
        提取记录中与字段匹配的键，兼容字段ID与字段名称
        """
        keys: List[str] = []
        for candidate in (str(field.id), field.id.hex, field.name):
            if candidate in data:
                keys.append(candidate)
        value = data[keys[0]] if keys else None
        return keys, value

    def _migrate_select_choice_renames(
        self,
        field: TableField,
        old_choices,
        new_choices,
    ) -> int:
        """把选项重命名映射应用到表内已有记录，返回受影响记录数。

        字段设置面板以 string[] 提交 choices 时，normalize 会让 value 跟着文案变；
        若不改写记录，单元格仍显示旧文案。
        """
        from apps.tabdata.utils.choice_utils import (
            apply_select_choice_renames,
            build_select_choice_value_renames,
        )

        renames = build_select_choice_value_renames(old_choices, new_choices)
        if not renames:
            return 0

        try:
            # caller update_field 已经持有同一 Table + Field 锁；这里只复用
            # Table 对象做 native 配置，不能另起新的锁入口破坏全域闸门约定。
            migrate_table = Table.objects.using(TABDATA_DB_ALIAS).get(id=field.table_id)
        except Table.DoesNotExist:
            return 0

        records_qs = (
            TableRecord.objects.using(TABDATA_DB_ALIAS)
            .select_for_update()
            .filter(table_id=field.table_id, is_deleted=False)
            .order_by('id')
        )
        records_to_update: List[Tuple[TableRecord, List[str], Any]] = []

        for record_batch in self._iter_record_batches(records_qs, _FIELD_CONVERSION_BATCH_SIZE):
            self._preload_record_data_for_fields(record_batch, migrate_table, [field])
            for record in record_batch:
                record_data = read_data(record)
                keys, original_value = self._resolve_field_keys(field, record_data)
                if not keys:
                    continue
                new_value, changed = apply_select_choice_renames(
                    original_value,
                    renames,
                    field.field_type,
                )
                if changed:
                    records_to_update.append((record, keys, new_value))

        if not records_to_update:
            return 0

        native_column_available = self._native_field_column_available(migrate_table, field)
        with transaction.atomic(using=TABDATA_DB_ALIAS):
            operation_group_id = uuid4()
            window_id = get_current_window_id()

            for batch_start in range(0, len(records_to_update), _FIELD_CONVERSION_BATCH_SIZE):
                batch = records_to_update[batch_start:batch_start + _FIELD_CONVERSION_BATCH_SIZE]
                batch_size = len(batch)
                max_version = next_record_version(field.table_id, count=batch_size)
                version_base = max_version - batch_size + 1
                bulk_records = []
                history_events = []
                now = timezone.now()

                for idx, (record, keys, new_value) in enumerate(batch):
                    cached_data = dict(read_data(record))
                    record_data = dict(record.__dict__.get('data') or {})
                    target_keys = keys or [field.name]
                    field_changes: Dict[str, Dict[str, Any]] = {}

                    field_aliases = {str(field.id), field.id.hex, field.name}
                    for alias in field_aliases.difference(target_keys):
                        record_data.pop(alias, None)

                    for key in target_keys:
                        old_value = cached_data.get(key, record_data.get(key))
                        if old_value != new_value:
                            field_changes[key] = {'old': old_value, 'new': new_value}
                        record_data[key] = new_value

                    record.__dict__['data'] = record_data
                    invalidate_cache(record)
                    record.version = version_base + idx
                    record.updated_at = now
                    if self.user:
                        record.updated_by_id = self.user.id
                    bulk_records.append(record)
                    if field_changes:
                        history_events.append((record, field_changes))

                update_fields = ['data', 'version', 'updated_at']
                if self.user:
                    update_fields.append('updated_by')
                TableRecord.objects.using(TABDATA_DB_ALIAS).bulk_update(
                    bulk_records, update_fields, batch_size=_FIELD_CONVERSION_BATCH_SIZE,
                )

                if native_column_available:
                    try:
                        from apps.tabdata.native.record_io import NativeRecordIO
                        from apps.tabdata.native.value_converter import python_to_pg
                        native_io = NativeRecordIO(migrate_table.space_id, migrate_table.id)
                        for record, _keys, new_value in batch:
                            pg_val = python_to_pg(new_value, field.field_type, field.config)
                            native_io.update_record(record.id, {field.id.hex: pg_val})
                    except Exception as _exc:
                        logger.warning(
                            "select choice rename native sync batch failed: err=%s", _exc,
                        )

                for record, field_changes in history_events:
                    emit_record_history_event(
                        record=record,
                        action='update',
                        field_changes=field_changes,
                        user=self.user,
                        window_id=window_id,
                        operation_group_id=operation_group_id,
                        editor_type=get_editor_type(),
                        sender=self._migrate_select_choice_renames,
                    )

        try:
            from apps.tabdata.utils.ydoc_sync import sync_records_to_ydoc
            affected_records = [record for record, _, _ in records_to_update]
            sync_records_to_ydoc(
                field.table_id,
                affected_records,
                source="update_field:select_choice_rename",
            )
        except Exception as _exc:
            logger.warning("select choice rename Y.js sync failed: %s", _exc)

        logger.info(
            "select choice rename migrated field=%s renames=%s affected=%s",
            field.id,
            renames,
            len(records_to_update),
        )
        return len(records_to_update)

    def populate_field_choices(
        self,
        field_id: UUID,
        max_options: int = MAX_OPTIONS_COUNT
    ) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
        """
        扫描记录数据，自动收集 select/multi_select 的选项并写回字段配置

        Args:
            field_id: 字段ID
            max_options: 最大选项数量（默认与转换逻辑保持一致）

        Returns:
            (结果字典, 错误信息)
        """
        try:
            field = TableField.objects.using(TABDATA_DB_ALIAS).get(id=field_id, is_deleted=False)
        except TableField.DoesNotExist:
            return None, ErrorCode.NOT_FOUND

        if field.field_type not in ['select', 'multi_select']:
            return None, ErrorCode.UNSUPPORTED

        # 权限：需要 editor/owner
        if not self.check_table_permission(str(field.table_id), 'editor'):
            return None, ErrorCode.PERMISSION_DENIED

        from apps.tabdata.utils.choice_utils import (
            extract_choice_values,
            merge_select_choice_values,
        )

        options = field.config or {}
        existing_choices = options.get('choices') or []
        existing_values = extract_choice_values(existing_choices)

        values: List[Any] = []
        try:
            table = Table.objects.using(TABDATA_DB_ALIAS).get(id=field.table_id)
        except Table.DoesNotExist:
            return None, ErrorCode.NOT_FOUND

        records_qs = TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=field.table_id,
            is_deleted=False,
        )

        for record_batch in self._iter_record_batches(records_qs, 200):
            self._preload_record_data_for_fields(record_batch, table, [field])
            for record in record_batch:
                record_data = read_data(record)
                keys, raw_value = self._resolve_field_keys(field, record_data)
                if not keys:
                    continue

                success, converted_value, _ = convert_to_target_type(
                    raw_value,
                    field.field_type,
                    options,
                )
                if not success or converted_value in (None, ''):
                    continue

                if field.field_type == 'select':
                    values.append(converted_value)
                else:  # multi_select
                    if isinstance(converted_value, list):
                        values.extend(converted_value)
                    else:
                        values.append(converted_value)

        if not values and existing_values:
            return {
                'choices': existing_choices,
                'added_count': 0,
                'total_count': len(existing_values),
            }, None

        # 按扫描出现顺序合并；保留已有顺序/颜色，并归一化为 {value,label,color}。
        merged = merge_select_choice_values(
            existing_choices,
            values,
            max_options=max_options,
        )
        added_count = max(0, len(merged) - len(existing_values))

        field.config = {**options, 'choices': merged}
        field.save(update_fields=['config', 'updated_at'])

        return {
            'choices': merged,
            'added_count': added_count,
            'total_count': len(merged),
        }, None

    def _iter_record_batches(self, records_qs: QuerySet, batch_size: int):
        """Yield records in bounded batches so native data can be preloaded once per batch."""
        batch = []
        for record in records_qs.iterator(chunk_size=batch_size):
            batch.append(record)
            if len(batch) >= batch_size:
                yield batch
                batch = []
        if batch:
            yield batch

    def _preload_record_data_for_fields(
        self,
        records: List[TableRecord],
        table: Table,
        fields: List[TableField],
    ) -> None:
        """
        Preload native record data when native storage is present.

        Field conversion still needs to run in legacy tests and degraded environments
        where the native table/column may not exist. Checking first avoids a caught
        DatabaseError leaving the surrounding PostgreSQL transaction in a failed state.
        """
        if not records or not fields:
            return

        try:
            for field in fields:
                if not self._native_field_column_available(table, field):
                    return
            read_data_bulk(records, table, fields)
        except DatabaseError:
            raise
        except Exception as exc:
            logger.warning(
                "field conversion native preload skipped: table=%s err=%s",
                table.id,
                exc,
            )

    def _native_field_column_available(self, table: Table, field: TableField) -> bool:
        """Return whether the native table and field column exist."""
        ddl = DDLManager()
        partition_id = resolve_schema_partition_id(table)
        return (
            ddl.native_table_exists(partition_id, table.id)
            and ddl.column_exists(partition_id, table.id, field.id)
        )

    def _get_target_conversion_preview(
        self,
        target_type: str,
        sample_values: List[Any],
        target_options: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Preview values with the same converter used by convert_field_type."""
        preview = []
        success_count = 0

        for value in sample_values:
            success, converted_value, error = convert_to_target_type(
                value,
                target_type,
                target_options,
            )
            preview.append({
                'original': value,
                'converted': converted_value,
                'success': success,
                'error': error,
            })
            if success:
                success_count += 1

        return {
            'can_convert': True,
            'success_rate': success_count / len(sample_values) if sample_values else 1.0,
            'preview': preview,
        }

    def _get_sample_field_values(self, field: TableField, sample_size: int) -> List[Any]:
        """
        获取字段的样本数据

        Args:
            field: 字段对象
            sample_size: 样本数量

        Returns:
            List: 样本值列表
        """
        if sample_size <= 0:
            return []

        sample_values: List[Any] = []
        records = list(TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=field.table_id,
            is_deleted=False
        ).order_by('-updated_at')[:sample_size])
        if not records:
            return []

        table = Table.objects.using(TABDATA_DB_ALIAS).get(id=field.table_id)
        self._preload_record_data_for_fields(records, table, [field])

        for record in records:
            data = read_data(record)
            keys, value = self._resolve_field_keys(field, data)
            if not keys:
                continue

            sample_values.append(value)
            if len(sample_values) >= sample_size:
                break

        return sample_values
