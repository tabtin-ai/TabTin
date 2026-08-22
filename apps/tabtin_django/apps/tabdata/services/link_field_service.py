"""
Link 字段核心服务

负责关联字段的创建、删除、cell 值设置、对称字段同步等。

关系类型与对称关系映射：
  OneOne   → OneOne
  OneMany  → ManyOne
  ManyOne  → OneMany
  ManyMany → ManyMany
"""

import logging
import re
from typing import Any, Dict, List, Literal, Optional, Tuple
from uuid import UUID, uuid4

from django.db import connection, transaction
from django.db.models import CharField, F, Q
from django.db.models.functions import Cast

from apps.tabdata.constants import (
    DEFAULT_LINK_RELATIONSHIP,
    MULTI_VALUE_RELATIONSHIPS,
    SYMMETRIC_RELATIONSHIP_MAP,
    TABDATA_DB_ALIAS,
    UNNAMED_RECORD_DISPLAY_NAME,
)
from apps.tabdata.models import LinkRecord, Table, TableField, TableRecord
from apps.tabdata.services.table_event_service import table_event_service
from apps.tabdata.utils.record_data_access import read_data, read_data_fresh, skip_record_history

logger = logging.getLogger(__name__)


class LinkFieldService:
    """关联字段核心服务"""

    @classmethod
    def _resolve_lookup_field_id(cls, foreign_table_id: str) -> Optional[str]:
        """
        解析 Link 的默认显示字段：
        1. 优先名称为 Label 的字段
        2. 其次目标表主字段
        """
        label_field = TableField.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=foreign_table_id,
            name='Label',
            is_deleted=False,
        ).order_by('order').first()
        if label_field:
            return str(label_field.id)

        primary_field = TableField.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=foreign_table_id,
            is_primary=True,
            is_deleted=False,
        ).first()
        return str(primary_field.id) if primary_field else None

    @staticmethod
    def _normalize_linked_ids(new_linked_ids: List[Any]) -> List[UUID]:
        """
        规范化 Link 输入 ID：
        - 过滤空值
        - 转换为 UUID
        - 保持输入顺序
        - 禁止同一单元格内重复 ID
        """
        normalized: List[UUID] = []
        seen: set[UUID] = set()

        for raw_id in new_linked_ids or []:
            if raw_id in (None, ''):
                continue
            try:
                if isinstance(raw_id, UUID):
                    record_id = raw_id
                else:
                    record_id = UUID(str(raw_id).strip())
            except (TypeError, ValueError) as exc:
                raise ValueError(f"关联记录 ID 不是合法 UUID: {raw_id}") from exc
            if record_id in seen:
                raise ValueError(f"关联记录 ID 重复: {record_id}")
            seen.add(record_id)
            normalized.append(record_id)

        return normalized

    # ──────────────────────────────────────────────────────
    # 字段创建 / 删除
    # ──────────────────────────────────────────────────────

    @classmethod
    @transaction.atomic(using=TABDATA_DB_ALIAS)
    def create_link_field(
        cls,
        field: TableField,
        options: Dict[str, Any],
        *,
        user=None,
    ) -> TableField:
        """
        字段创建后的 link 初始化：验证 config、可选创建对称字段。

        Args:
            field: 已创建的 link 字段（config 已设置 relationship / foreignTableId）
            options: 原始 options dict
            user: 当前操作用户（用于对称字段目标表权限校验）

        Returns:
            经过对称字段补充后的 field
        """
        config = field.config or {}
        relationship = config.get('relationship', DEFAULT_LINK_RELATIONSHIP)
        foreign_table_id = config.get('foreignTableId')
        is_one_way = config.get('isOneWay', False)

        if not foreign_table_id:
            raise ValueError("link 字段缺少 foreignTableId")

        # 验证目标表存在
        try:
            foreign_table = Table.objects.using(TABDATA_DB_ALIAS).get(id=foreign_table_id, is_archived=False)
        except Table.DoesNotExist:
            raise ValueError(f"目标表不存在: {foreign_table_id}")

        # SDI-003: 无论单向/双向，都必须校验用户对目标表的访问权限
        if user is not None:
            if not cls._check_foreign_table_permission(foreign_table, user, 'viewer'):
                raise PermissionError(
                    f"无权限访问目标表 {foreign_table_id}，不允许创建 link 字段"
                )

        # 设置 lookupFieldId —— 优先 Label 字段，再回退主字段
        if not config.get('lookupFieldId'):
            lookup_field_id = cls._resolve_lookup_field_id(str(foreign_table_id))
            if lookup_field_id:
                config['lookupFieldId'] = lookup_field_id

        # 创建对称字段（双向模式）—— 带权限检查和降级
        if not is_one_way:
            sym_result = cls._try_create_symmetric_field(
                field, foreign_table, relationship, config, user=user,
            )
            if sym_result is not None:
                config['symmetricFieldId'] = str(sym_result.id)
            else:
                # 降级为单向模式
                config['symmetricFieldId'] = None
                config['isOneWay'] = True
                logger.info(
                    "对称字段创建失败，降级为单向模式: field=%s, foreign_table=%s",
                    field.id, foreign_table_id,
                )
        else:
            config['symmetricFieldId'] = None

        field.config = config
        field.save(update_fields=['config'])

        # 注册字段依赖边：link 字段依赖其 lookupFieldId（主显示字段）
        lookup_field_id = config.get('lookupFieldId')
        if lookup_field_id:
            from apps.tabdata.services.cascade_service import FieldReferenceManager
            try:
                FieldReferenceManager.register_references(
                    to_field_id=str(field.id),
                    from_field_ids=[str(lookup_field_id)],
                )
            except ValueError as exc:
                logger.warning("注册 Link 依赖边失败 field=%s err=%s", field.id, exc)
                raise
            except Exception as exc:
                logger.warning("注册 Link 依赖边失败 field=%s err=%s", field.id, exc)
                raise ValueError(f"注册 Link 依赖边失败: {exc}") from exc

        return field

    @classmethod
    def _cleanup_symmetric_field(cls, sym_field: TableField) -> None:
        """统一清理对称字段：LinkRecord + cell values + FieldReference + 软删除 + native 列 + 视图。

        每个操作独立 try-except，单步失败不影响后续步骤。
        """
        sym_field_id_str = str(sym_field.id)

        # 1. 删除 LinkRecord
        try:
            LinkRecord.objects.using(TABDATA_DB_ALIAS).filter(link_field=sym_field).delete()
        except Exception as exc:
            logger.warning("清理对称字段 LinkRecord 失败 sym_field=%s err=%s", sym_field.id, exc)

        # 2. 清理 cell values
        try:
            cls._clear_link_cell_values(sym_field)
        except Exception as exc:
            logger.warning("清理对称字段 cell values 失败 sym_field=%s err=%s", sym_field.id, exc)

        # 3. 清理 FieldReference 依赖边
        try:
            from apps.tabdata.services.cascade_service import FieldReferenceManager
            FieldReferenceManager.deregister_field(sym_field_id_str)
        except Exception as exc:
            logger.warning("清理对称字段 FieldReference 失败 sym_field=%s err=%s", sym_field.id, exc)

        # 4. 软删除
        try:
            sym_field.is_deleted = True
            sym_field.save(update_fields=['is_deleted'])
        except Exception as exc:
            logger.warning("软删除对称字段失败 sym_field=%s err=%s", sym_field.id, exc)

        # 5. 清理 native 列
        try:
            from apps.tabdata.native.pg_type_map import is_system_field
            if not is_system_field(sym_field.field_type):
                from apps.tabdata.native.ddl_manager import DDLManager, resolve_schema_partition_id
                table_obj = Table.objects.using(TABDATA_DB_ALIAS).only(
                    'id', 'space_id', 'organization_id',
                ).get(id=sym_field.table_id)
                ddl = DDLManager()
                ddl.drop_column(
                    resolve_schema_partition_id(table_obj), table_obj.id, sym_field.id,
                )
        except Exception as exc:
            logger.warning("清理对称字段 native 列失败 sym_field=%s err=%s", sym_field.id, exc)

        # 7. 清理视图引用（visible_fields / field_order / column_meta + filters / sorts / groups / filter）
        try:
            from apps.tabdata.services.table_service import strip_field_from_views
            strip_field_from_views(sym_field.table_id, sym_field_id_str)
        except Exception as view_exc:
            logger.warning("清理对称字段视图配置失败 sym_field=%s err=%s", sym_field.id, view_exc)

        # 8. 通知对端表：schema_version + field_count + WS delete_field + Y.Doc
        # 否则表 B 客户端仍按旧 field map 渲染已软删字段
        cls._notify_symmetric_field_deleted(sym_field)

    @classmethod
    def _notify_symmetric_field_deleted(cls, sym_field: TableField) -> None:
        """对称字段软删后，让对端表客户端失效缓存并移除该字段。

        ``_cleanup_symmetric_field`` 只做 ORM/DDL，原先不递增对端
        ``schema_version``、不发 WS，导致表 B 在 schema 未变时继续用旧
        field map（字段仍显示、可跳转，但 LinkRecord 已清 →「无匹配记录」）。
        """
        table_id = sym_field.table_id

        try:
            field_count = TableField.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=table_id,
                is_deleted=False,
            ).count()
            Table.objects.using(TABDATA_DB_ALIAS).filter(id=table_id).update(
                field_count=field_count,
                schema_version=F('schema_version') + 1,
            )
        except Exception as exc:
            logger.warning(
                "对称字段清理后更新对端 schema/field_count 失败 sym_field=%s err=%s",
                sym_field.id, exc,
            )

        try:
            from apps.tabdata.subscribers._utils import run_after_commit
            from apps.tabdata.services.undo_redo_operation_service import (
                UndoRedoOperationService,
            )

            table_id_str = str(table_id)
            field_ids = [str(sym_field.id)]
            serialized_fields = [UndoRedoOperationService.serialize_field(sym_field)]

            def _publish() -> None:
                try:
                    table_event_service.publish_field_change(
                        table_id_str,
                        action="delete_field",
                        field_ids=field_ids,
                        fields=serialized_fields,
                        metadata={},
                    )
                except Exception as pub_exc:
                    logger.warning(
                        "[WS] 对称字段 delete_field 发布失败 sym_field=%s err=%s",
                        sym_field.id, pub_exc,
                    )

            run_after_commit(_publish)
        except Exception as exc:
            logger.warning(
                "[WS] 对称字段 delete_field 发布准备失败 sym_field=%s err=%s",
                sym_field.id, exc,
            )

        try:
            from apps.tabdata.services.table_service import TableService
            TableService._sync_table_records_to_ydoc(
                table_id, source="cleanup_symmetric_field",
            )
        except Exception as exc:
            logger.warning(
                "对称字段清理后同步对端 Y.Doc 失败 sym_field=%s err=%s",
                sym_field.id, exc,
            )

    @classmethod
    @transaction.atomic(using=TABDATA_DB_ALIAS)
    def delete_link_field(cls, field: TableField) -> None:
        """
        删除 link 字段前的清理：删除 LinkRecord + 可选删除对称字段。

        注意：此方法应在字段软删除 **之前** 调用。
        """
        config = field.config or {}
        symmetric_field_id = config.get('symmetricFieldId')
        is_one_way = config.get('isOneWay', False)

        # 0. 清理主字段依赖边（对称字段的依赖边由 _cleanup_symmetric_field 统一处理）
        from apps.tabdata.services.cascade_service import FieldReferenceManager
        try:
            FieldReferenceManager.deregister_field(str(field.id))
        except Exception as exc:
            logger.warning("清理依赖边失败 field=%s err=%s", field.id, exc)

        # 1. 删除所有关联记录
        LinkRecord.objects.using(TABDATA_DB_ALIAS).filter(link_field=field).delete()

        # 2. 删除对称字段（双向模式）
        if not is_one_way and symmetric_field_id:
            try:
                sym_field = TableField.objects.using(TABDATA_DB_ALIAS).get(id=symmetric_field_id, is_deleted=False)
                cls._cleanup_symmetric_field(sym_field)
                logger.info("已删除对称字段 field_id=%s (来自 link_field=%s)", symmetric_field_id, field.id)
            except TableField.DoesNotExist:
                logger.warning("对称字段不存在 field_id=%s", symmetric_field_id)

    # ──────────────────────────────────────────────────────
    # 字段配置更新（关系转换）
    # ──────────────────────────────────────────────────────

    @classmethod
    @transaction.atomic(using=TABDATA_DB_ALIAS)
    def update_link_field(
        cls,
        field: TableField,
        old_config: Dict[str, Any],
        new_config: Dict[str, Any],
        *,
        user=None,
    ) -> TableField:
        """
        更新 link 字段配置。处理以下变更场景：

        1. lookupFieldId 变更 → 重建所有 cell title
        2. relationship 变更 → 基数验证 + 数据截断 + 对称字段更新
        3. foreignTableId 变更 → 全量数据迁移（清理旧数据 + 重建对称字段）
        4. isOneWay 变更 → 创建/删除对称字段
        5. filterByViewId / visibleFieldIds 变更 → 仅 config 更新（无需数据迁移）

        Args:
            user: 当前操作用户，用于目标表权限校验（BO-017 修复）
        """
        old_foreign_table = old_config.get('foreignTableId')
        new_foreign_table = new_config.get('foreignTableId')
        old_relationship = old_config.get('relationship', DEFAULT_LINK_RELATIONSHIP)
        new_relationship = new_config.get('relationship', DEFAULT_LINK_RELATIONSHIP)
        old_is_one_way = old_config.get('isOneWay', False)
        new_is_one_way = new_config.get('isOneWay', False)
        old_lookup_field = old_config.get('lookupFieldId')
        new_lookup_field = new_config.get('lookupFieldId')

        # ── 场景 A: 目标表变更 → 全量迁移 ──
        if old_foreign_table != new_foreign_table:
            # BO-017: 变更目标表时必须校验用户对新目标表的访问权限
            if new_foreign_table and user is not None:
                try:
                    new_target = Table.objects.using(TABDATA_DB_ALIAS).get(
                        id=new_foreign_table, is_archived=False,
                    )
                except Table.DoesNotExist:
                    raise ValueError(f"目标表不存在: {new_foreign_table}")
                if not cls._check_foreign_table_permission(new_target, user, 'viewer'):
                    raise PermissionError(
                        f"无权限访问目标表 {new_foreign_table}，不允许修改 link 字段指向"
                    )
            cls._handle_foreign_table_change(field, old_config, new_config, user=user)
            return field

        # ── 场景 B: 关系类型变更 ──
        if old_relationship != new_relationship:
            cls._handle_relationship_change(field, old_relationship, new_relationship)

        # ── 场景 C: 单向 ↔ 双向切换 ──
        if old_is_one_way != new_is_one_way:
            cls._handle_one_way_toggle(field, old_config, new_config)

        # ── 场景 D: lookupFieldId 变更 → 重建 title ──
        if old_lookup_field != new_lookup_field:
            config = dict(field.config or {})
            config['lookupFieldId'] = new_lookup_field
            field.config = config
            field.save(update_fields=['config'])
            cls._rebuild_all_cell_titles(field)
            from apps.tabdata.services.cascade_service import FieldReferenceManager
            try:
                FieldReferenceManager.deregister_field(str(field.id))
                if new_lookup_field:
                    FieldReferenceManager.register_references(
                        to_field_id=str(field.id),
                        from_field_ids=[str(new_lookup_field)],
                    )
            except ValueError as exc:
                logger.warning("更新 lookupFieldId 依赖边失败 field=%s err=%s", field.id, exc)
                raise
            except Exception as exc:
                logger.warning("更新 lookupFieldId 依赖边失败 field=%s err=%s", field.id, exc)
                raise ValueError(f"更新 lookupFieldId 依赖边失败: {exc}") from exc

        return field

    @classmethod
    def _handle_foreign_table_change(
        cls, field: TableField, old_config: Dict[str, Any], new_config: Dict[str, Any],
        *, user=None,
    ) -> None:
        """目标表变更：清理旧数据 + 删除旧对称字段 + 创建新对称字段"""
        old_sym_id = old_config.get('symmetricFieldId')
        old_is_one_way = old_config.get('isOneWay', False)

        # 1. 清理旧 LinkRecord
        LinkRecord.objects.using(TABDATA_DB_ALIAS).filter(link_field=field).delete()

        # 2. 清理旧对称字段
        if not old_is_one_way and old_sym_id:
            try:
                old_sym = TableField.objects.using(TABDATA_DB_ALIAS).get(id=old_sym_id, is_deleted=False)
                cls._cleanup_symmetric_field(old_sym)
                logger.info("目标表变更: 已删除旧对称字段 field_id=%s", old_sym_id)
            except TableField.DoesNotExist:
                logger.warning("目标表变更: 旧对称字段不存在 field_id=%s", old_sym_id)

        # 3. 清理本字段的 cell values
        cls._clear_link_cell_values(field)

        # 4. 设置新的 lookupFieldId
        new_foreign_table_id = new_config.get('foreignTableId')
        if not new_config.get('lookupFieldId'):
            lookup_field_id = cls._resolve_lookup_field_id(str(new_foreign_table_id))
            if lookup_field_id:
                new_config['lookupFieldId'] = lookup_field_id

        # 5. 创建新对称字段（如果双向）— 带降级
        new_is_one_way = new_config.get('isOneWay', False)
        if not new_is_one_way:
            try:
                foreign_table = Table.objects.using(TABDATA_DB_ALIAS).get(id=new_foreign_table_id, is_archived=False)
                new_relationship = new_config.get('relationship', DEFAULT_LINK_RELATIONSHIP)
                sym = cls._try_create_symmetric_field(field, foreign_table, new_relationship, new_config, user=user)
                if sym is not None:
                    new_config['symmetricFieldId'] = str(sym.id)
                else:
                    # 降级为单向
                    new_config['symmetricFieldId'] = None
                    new_config['isOneWay'] = True
            except Table.DoesNotExist:
                logger.warning("新目标表不存在 table_id=%s", new_foreign_table_id)
                new_config['symmetricFieldId'] = None
                new_config['isOneWay'] = True
        else:
            new_config['symmetricFieldId'] = None

        # 6. 更新依赖边
        from apps.tabdata.services.cascade_service import FieldReferenceManager
        try:
            FieldReferenceManager.deregister_field(str(field.id))
            new_lookup = new_config.get('lookupFieldId')
            if new_lookup:
                FieldReferenceManager.register_references(
                    to_field_id=str(field.id), from_field_ids=[str(new_lookup)],
                )
        except ValueError as exc:
            logger.warning("更新目标表依赖边失败 field=%s err=%s", field.id, exc)
            raise
        except Exception as exc:
            logger.warning("更新目标表依赖边失败 field=%s err=%s", field.id, exc)
            raise ValueError(f"更新目标表依赖边失败: {exc}") from exc

        field.config = new_config
        field.save(update_fields=['config'])

    @classmethod
    def _handle_relationship_change(
        cls, field: TableField, old_relationship: str, new_relationship: str,
    ) -> None:
        """关系类型变更。多值→单值时截断数据，同步更新对称字段。"""
        old_is_multi = old_relationship in MULTI_VALUE_RELATIONSHIPS
        new_is_multi = new_relationship in MULTI_VALUE_RELATIONSHIPS
        source_truncated = False

        # 多值→单值：截断
        if old_is_multi and not new_is_multi:
            cls._truncate_to_single_value(field)
            source_truncated = True

        # 提前更新 field.config 中的 relationship，保证后续 _rebuild_all_cell_titles
        # 使用新的基数来决定 cell 格式（单值 vs 多值）
        config = dict(field.config or {})
        config['relationship'] = new_relationship
        field.config = config
        field.save(update_fields=['config'])

        sym_field_id = config.get('symmetricFieldId')
        if sym_field_id:
            try:
                sym_field = TableField.objects.using(TABDATA_DB_ALIAS).get(id=sym_field_id, is_deleted=False)
                sym_config = dict(sym_field.config or {})
                sym_config['relationship'] = SYMMETRIC_RELATIONSHIP_MAP.get(new_relationship, 'ManyMany')
                sym_field.config = sym_config
                sym_field.save(update_fields=['config'])

                # 对称字段也可能需要截断
                sym_old_multi = SYMMETRIC_RELATIONSHIP_MAP.get(old_relationship, 'ManyMany') in MULTI_VALUE_RELATIONSHIPS
                sym_new_multi = SYMMETRIC_RELATIONSHIP_MAP.get(new_relationship, 'ManyMany') in MULTI_VALUE_RELATIONSHIPS
                symmetric_truncated = False
                if sym_old_multi and not sym_new_multi:
                    cls._truncate_to_single_value(sym_field)
                    symmetric_truncated = True

                # 关系收紧后需要对齐双侧 LinkRecord，防止出现单侧残留
                if source_truncated or symmetric_truncated:
                    if source_truncated and not symmetric_truncated:
                        reconcile_mode: Literal['source', 'symmetric', 'intersection'] = 'source'
                    elif symmetric_truncated and not source_truncated:
                        reconcile_mode = 'symmetric'
                    else:
                        reconcile_mode = 'intersection'
                    cls._reconcile_symmetric_link_records(field, sym_field, mode=reconcile_mode)

                cls._rebuild_all_cell_titles(sym_field)
            except TableField.DoesNotExist:
                logger.warning("更新对称字段关系失败: sym_field_id=%s", sym_field_id)

        cls._rebuild_all_cell_titles(field)

    @classmethod
    def _handle_one_way_toggle(
        cls, field: TableField, old_config: Dict[str, Any], new_config: Dict[str, Any],
    ) -> None:
        """单向 ↔ 双向切换"""
        old_is_one_way = old_config.get('isOneWay', False)
        new_is_one_way = new_config.get('isOneWay', False)

        if not old_is_one_way and new_is_one_way:
            # 双向 → 单向：删除对称字段
            old_sym_id = old_config.get('symmetricFieldId')
            if old_sym_id:
                try:
                    sym_field = TableField.objects.using(TABDATA_DB_ALIAS).get(id=old_sym_id, is_deleted=False)
                    cls._cleanup_symmetric_field(sym_field)
                    logger.info("双向→单向: 已删除对称字段 field_id=%s", old_sym_id)
                except TableField.DoesNotExist:
                    logger.warning("双向→单向: 对称字段不存在 field_id=%s", old_sym_id)
            new_config['symmetricFieldId'] = None
            field.config = new_config
            field.save(update_fields=['config'])

        elif old_is_one_way and not new_is_one_way:
            # 单向 → 双向：创建对称字段 + 同步已有数据（带降级）
            foreign_table_id = new_config.get('foreignTableId')
            relationship = new_config.get('relationship', DEFAULT_LINK_RELATIONSHIP)
            try:
                foreign_table = Table.objects.using(TABDATA_DB_ALIAS).get(id=foreign_table_id, is_archived=False)
                sym_field = cls._try_create_symmetric_field(field, foreign_table, relationship, new_config)
                if sym_field is None:
                    # 降级：保持单向
                    new_config['isOneWay'] = True
                    new_config['symmetricFieldId'] = None
                    field.config = new_config
                    field.save(update_fields=['config'])
                    return
                new_config['symmetricFieldId'] = str(sym_field.id)
                field.config = new_config
                field.save(update_fields=['config'])

                # 同步现有 LinkRecord 到对称字段
                existing_links = list(
                    LinkRecord.objects.using(TABDATA_DB_ALIAS).filter(link_field=field).order_by('order', 'created_at')
                )
                if existing_links:
                    from django.db.models import Max
                    target_self_ids = {lk.foreign_record_id for lk in existing_links}
                    order_cursor: Dict[UUID, int] = {
                        row['self_record_id']: int(row['max_order'] or 0)
                        for row in LinkRecord.objects.using(TABDATA_DB_ALIAS)
                        .filter(link_field=sym_field, self_record_id__in=target_self_ids)
                        .values('self_record_id')
                        .annotate(max_order=Max('order'))
                    }
                    for sid in target_self_ids:
                        order_cursor.setdefault(sid, 0)
                    sym_links: list[LinkRecord] = []
                    for link in existing_links:
                        target_self_id = link.foreign_record_id
                        order_cursor[target_self_id] += 1
                        sym_links.append(LinkRecord(
                            link_field=sym_field,
                            self_record_id=target_self_id,
                            foreign_record_id=link.self_record_id,
                            order=order_cursor[target_self_id],
                        ))
                    LinkRecord.objects.using(TABDATA_DB_ALIAS).bulk_create(sym_links, ignore_conflicts=True)
                cls._rebuild_all_cell_titles(sym_field)
            except Table.DoesNotExist:
                logger.warning("创建对称字段失败：目标表不存在 table_id=%s", foreign_table_id)

    @classmethod
    def _truncate_to_single_value(cls, field: TableField) -> None:
        """截断多值关联为单值：每个 self_record 只保留 order 最小的一条"""
        from django.db.models import Min

        keep_ids = set()
        min_orders = (
            LinkRecord.objects.using(TABDATA_DB_ALIAS).filter(link_field=field)
            .values('self_record_id')
            .annotate(min_order=Min('order'))
        )
        for item in min_orders:
            first_link = (
                LinkRecord.objects.using(TABDATA_DB_ALIAS).filter(
                    link_field=field,
                    self_record_id=item['self_record_id'],
                    order=item['min_order'],
                ).values_list('id', flat=True).first()
            )
            if first_link:
                keep_ids.add(first_link)

        deleted_count, _ = (
            LinkRecord.objects.using(TABDATA_DB_ALIAS).filter(link_field=field)
            .exclude(id__in=keep_ids)
            .delete()
        )
        if deleted_count:
            logger.info("截断多值→单值: field=%s, 删除 %d 条 LinkRecord", field.id, deleted_count)

    @classmethod
    def _reconcile_symmetric_link_records(
        cls,
        field: TableField,
        sym_field: TableField,
        *,
        mode: Literal['source', 'symmetric', 'intersection'],
    ) -> None:
        """
        对齐双向 LinkRecord（用于关系收紧后的数据整理）。

        mode:
          - source:      以主字段数据为准，同步到对称字段
          - symmetric:   以对称字段数据为准，同步到主字段
          - intersection:保留双侧交集（用于双方都发生截断时）
        """
        source_rows = list(
            LinkRecord.objects.using(TABDATA_DB_ALIAS).filter(link_field=field).values('id', 'self_record_id', 'foreign_record_id')
        )
        sym_rows = list(
            LinkRecord.objects.using(TABDATA_DB_ALIAS).filter(link_field=sym_field).values('id', 'self_record_id', 'foreign_record_id')
        )

        source_pairs = {
            (row['self_record_id'], row['foreign_record_id']): row['id']
            for row in source_rows
        }
        sym_pairs = {
            (row['foreign_record_id'], row['self_record_id']): row['id']
            for row in sym_rows
        }

        source_pair_keys = set(source_pairs.keys())
        sym_pair_keys = set(sym_pairs.keys())
        if mode == 'source':
            target_pairs = source_pair_keys
        elif mode == 'symmetric':
            target_pairs = sym_pair_keys
        else:
            target_pairs = source_pair_keys & sym_pair_keys

        source_delete_ids = [link_id for pair, link_id in source_pairs.items() if pair not in target_pairs]
        sym_delete_ids = [link_id for pair, link_id in sym_pairs.items() if pair not in target_pairs]

        if source_delete_ids:
            LinkRecord.objects.using(TABDATA_DB_ALIAS).filter(id__in=source_delete_ids).delete()
        if sym_delete_ids:
            LinkRecord.objects.using(TABDATA_DB_ALIAS).filter(id__in=sym_delete_ids).delete()

        source_missing_pairs = [pair for pair in target_pairs if pair not in source_pair_keys]
        if source_missing_pairs:
            from django.db.models import Max
            missing_self_ids = {p[0] for p in source_missing_pairs}
            order_cursor: Dict[UUID, int] = {
                row['self_record_id']: int(row['max_order'] or 0)
                for row in LinkRecord.objects.using(TABDATA_DB_ALIAS)
                .filter(link_field=field, self_record_id__in=missing_self_ids)
                .values('self_record_id')
                .annotate(max_order=Max('order'))
            }
            for sid in missing_self_ids:
                order_cursor.setdefault(sid, 0)
            records_to_create: list[LinkRecord] = []
            for self_record_id, foreign_record_id in sorted(source_missing_pairs, key=lambda p: (str(p[0]), str(p[1]))):
                order_cursor[self_record_id] += 1
                records_to_create.append(LinkRecord(
                    link_field=field,
                    self_record_id=self_record_id,
                    foreign_record_id=foreign_record_id,
                    order=order_cursor[self_record_id],
                ))
            LinkRecord.objects.using(TABDATA_DB_ALIAS).bulk_create(records_to_create, ignore_conflicts=True)

        sym_missing_pairs = [pair for pair in target_pairs if pair not in sym_pair_keys]
        if sym_missing_pairs:
            from django.db.models import Max
            sym_self_ids = {source_foreign_id for _, source_foreign_id in sym_missing_pairs}
            order_cursor: Dict[UUID, int] = {
                row['self_record_id']: int(row['max_order'] or 0)
                for row in LinkRecord.objects.using(TABDATA_DB_ALIAS)
                .filter(link_field=sym_field, self_record_id__in=sym_self_ids)
                .values('self_record_id')
                .annotate(max_order=Max('order'))
            }
            for sid in sym_self_ids:
                order_cursor.setdefault(sid, 0)
            records_to_create: list[LinkRecord] = []
            for source_self_id, source_foreign_id in sorted(sym_missing_pairs, key=lambda p: (str(p[0]), str(p[1]))):
                sym_self_id = source_foreign_id
                sym_foreign_id = source_self_id
                order_cursor[sym_self_id] += 1
                records_to_create.append(LinkRecord(
                    link_field=sym_field,
                    self_record_id=sym_self_id,
                    foreign_record_id=sym_foreign_id,
                    order=order_cursor[sym_self_id],
                ))
            LinkRecord.objects.using(TABDATA_DB_ALIAS).bulk_create(records_to_create, ignore_conflicts=True)

    @classmethod
    def _rebuild_all_cell_titles(cls, field: TableField) -> None:
        """重建一个 link 字段所有记录的 cell value，并同步 native 列。"""
        field_id_str = str(field.id)
        linked_record_ids = set(
            LinkRecord.objects.using(TABDATA_DB_ALIAS).filter(link_field=field).values_list('self_record_id', flat=True)
        )
        records = TableRecord.objects.using(TABDATA_DB_ALIAS).filter(table_id=field.table_id, is_deleted=False)
        if linked_record_ids:
            records = records.filter(Q(id__in=linked_record_ids) | Q(data__has_key=field_id_str))
        else:
            records = records.filter(data__has_key=field_id_str)

        batch: list[TableRecord] = []
        native_updates: Dict[UUID, Any] = {}
        _pf_cache: Dict[str, Optional[TableField]] = {}
        for rec in records.iterator(chunk_size=500):
            cell_value = cls._build_cell_value(field, rec, _primary_field_cache=_pf_cache)
            data = dict(read_data(rec))
            if cell_value is None:
                data.pop(field_id_str, None)
            else:
                data[field_id_str] = cell_value
            rec.__dict__['data'] = data
            batch.append(rec)
            native_updates[rec.id] = cell_value
            if len(batch) >= 500:
                with skip_record_history(*batch):
                    TableRecord.objects.using(TABDATA_DB_ALIAS).bulk_update(batch, ['data', 'updated_at'], batch_size=100)
                cls._sync_native_cells(field, native_updates)
                batch = []
                native_updates = {}
        if batch:
            with skip_record_history(*batch):
                TableRecord.objects.using(TABDATA_DB_ALIAS).bulk_update(batch, ['data', 'updated_at'], batch_size=100)
            cls._sync_native_cells(field, native_updates)

    # ──────────────────────────────────────────────────────
    # Cell 值设置（核心写入）
    # ──────────────────────────────────────────────────────

    @classmethod
    @transaction.atomic(using=TABDATA_DB_ALIAS)
    def set_link_cell(
        cls,
        field: TableField,
        record: TableRecord,
        new_linked_ids: List[Any],
        *,
        _skip_symmetric_sync: bool = False,
    ) -> Dict[str, Any]:
        """
        设置 link cell 的值：更新 LinkRecord + 双侧 JSONB 缓存。

        Args:
            field: link 字段
            record: 源记录
            new_linked_ids: 新的目标记录 ID 列表
            _skip_symmetric_sync: 内部标志，防止对称同步循环

        Returns:
            格式化后的 cell value（用于写入 record.data）
        """
        config = field.config or {}
        foreign_table_id = config.get('foreignTableId')
        if not foreign_table_id:
            raise ValueError("link 字段缺少 foreignTableId 配置")
        relationship = config.get('relationship', DEFAULT_LINK_RELATIONSHIP)
        normalized_linked_ids = cls._normalize_linked_ids(new_linked_ids)

        # 子记录父字段：环 / 深度不变量（depth 0~4）在所有写入口统一拦截，
        # 避免 REST create/update、协作 create 绕过 SubRecordService。
        if (
            normalized_linked_ids
            and bool(config.get('isSubRecordParentField'))
            and str(config.get('foreignTableId', '')) == str(record.table_id)
            and config.get('isOneWay', False) is True
            and str(config.get('relationship', '')).strip() == 'ManyOne'
        ):
            from apps.tabdata.services.sub_record_service import SubRecordService

            SubRecordService.validate_parent_assignment(
                record_id=record.id,
                new_parent_id=normalized_linked_ids[0],
                parent_field=field,
            )

        # 基数验证
        cls._validate_cardinality(relationship, normalized_linked_ids, record, field)

        # 获取当前关联
        current_links = set(
            LinkRecord.objects.using(TABDATA_DB_ALIAS).filter(
                link_field=field, self_record=record
            ).values_list('foreign_record_id', flat=True)
        )
        new_set = set(normalized_linked_ids)

        to_remove = current_links - new_set
        # 保持输入顺序，避免 set 打乱关联顺序
        ordered_to_add = [record_id for record_id in normalized_linked_ids if record_id not in current_links]
        to_add = set(ordered_to_add)

        # 删除取消关联的记录
        if to_remove:
            LinkRecord.objects.using(TABDATA_DB_ALIAS).filter(
                link_field=field, self_record=record, foreign_record_id__in=to_remove
            ).delete()

        # 添加新关联
        if ordered_to_add:
            # 验证目标记录存在且属于目标表
            existing_records = set(
                TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                    id__in=ordered_to_add,
                    table_id=foreign_table_id,
                    is_deleted=False,
                ).values_list('id', flat=True)
            )
            missing = [record_id for record_id in ordered_to_add if record_id not in existing_records]
            if missing:
                raise ValueError(f"目标记录不存在或不属于目标表: {missing[0]}")

            max_order = 0
            if current_links - to_remove:
                last = LinkRecord.objects.using(TABDATA_DB_ALIAS).filter(
                    link_field=field, self_record=record
                ).order_by('-order').values_list('order', flat=True).first()
                if last is not None:
                    max_order = last

            new_link_records = []
            for i, foreign_id in enumerate(ordered_to_add, start=1):
                new_link_records.append(LinkRecord(
                    link_field=field,
                    self_record=record,
                    foreign_record_id=foreign_id,
                    order=max_order + i,
                ))
            LinkRecord.objects.using(TABDATA_DB_ALIAS).bulk_create(new_link_records, ignore_conflicts=True)

        # 重建源侧 cell value
        cell_value = cls._build_cell_value(field, record)

        # 同步对称字段
        if not _skip_symmetric_sync:
            cls._sync_symmetric_cells(field, record, to_add, to_remove)

        return cell_value

    # ──────────────────────────────────────────────────────
    # 可关联记录查询
    # ──────────────────────────────────────────────────────

    # ── 按字段类型构建搜索 Q 对象 ──

    # 文本类字段 — 使用 JSONB 路径模糊匹配 (icontains)
    _TEXT_LIKE_FIELD_TYPES = {
        'text', 'url', 'email', 'phone',
    }
    # 数字字段 — 尝试转为数字精确匹配
    _NUMERIC_FIELD_TYPES = {'number', 'rating'}
    # 选择类字段 — 精确匹配值
    _SELECT_FIELD_TYPES = {'select', 'multi_select'}
    # 全局搜索可扫的字段类型（与 UI「全局」语义对齐）
    _GLOBAL_SEARCHABLE_FIELD_TYPES = (
        _TEXT_LIKE_FIELD_TYPES
        | _NUMERIC_FIELD_TYPES
        | _SELECT_FIELD_TYPES
        | {'date', 'link'}
    )
    _LINKABLE_SEARCH_MAX_FIELDS = 64
    _LINKABLE_ID_TEXT_ANNOTATION = '_linkable_id_text'

    @classmethod
    def _annotate_record_id_text(cls, qs):
        """为 UUID 主键补文本注解，供 ILIKE 子串匹配。"""
        return qs.annotate(**{
            cls._LINKABLE_ID_TEXT_ANNOTATION: Cast('id', CharField()),
        })

    @classmethod
    def _should_match_record_id(cls, search: str) -> bool:
        """
        仅在搜索词像 UUID 片段时才匹配 record.id。

        短数字（如 ``5`` / ``56``）若始终 ``id ILIKE``，几乎每条 UUID 都会命中，
        表现为「搜了等于没过滤」；而真实标题 ``567`` 又可能只在原生列里，
        JSONB 扫不到就会进一步变成「搜 56 无结果」。
        """
        normalized = (search or '').strip()
        if len(normalized) < 2:
            return False
        if '-' in normalized:
            return bool(re.fullmatch(r'[0-9a-fA-F-]{4,}', normalized))
        if not re.fullmatch(r'[0-9a-fA-F]+', normalized):
            return False
        if re.search(r'[a-fA-F]', normalized):
            # 含 a-f：按 UUID 前缀处理（对齐空标题回退展示后搜 ``ea``）
            return True
        # 纯数字：只有足够长才像 UUID 前缀，避免污染标题数字搜索
        return len(normalized) >= 8

    @classmethod
    def _record_id_search_q(cls, search: str) -> Q:
        """匹配记录 id 文本（调用方需已 annotate）。"""
        return Q(**{f'{cls._LINKABLE_ID_TEXT_ANNOTATION}__icontains': search})

    @classmethod
    def _resolve_linkable_search_field_ids(
        cls,
        foreign_table_id: str,
        search_field_id: Optional[str],
        search_field_ids: Optional[List[str]] = None,
    ) -> List[str]:
        """解析本次搜索要扫的目标字段 id 列表。"""
        if search_field_id:
            return [str(search_field_id)]

        # 选择器「全局」：仅扫前端传入的表头列（避免扫到隐藏列 / 污染选项外字段）
        if search_field_ids:
            requested: List[str] = []
            seen = set()
            for raw in search_field_ids:
                fid = str(raw).strip()
                if not fid or fid in seen:
                    continue
                seen.add(fid)
                requested.append(fid)
            if requested:
                valid = {
                    str(field_id)
                    for field_id in TableField.objects.using(TABDATA_DB_ALIAS)
                    .filter(
                        table_id=foreign_table_id,
                        is_deleted=False,
                        id__in=requested[: cls._LINKABLE_SEARCH_MAX_FIELDS],
                    )
                    .values_list('id', flat=True)
                }
                ordered = [fid for fid in requested if fid in valid]
                if ordered:
                    return ordered[: cls._LINKABLE_SEARCH_MAX_FIELDS]

        field_ids = [
            str(field_id)
            for field_id in TableField.objects.using(TABDATA_DB_ALIAS)
            .filter(
                table_id=foreign_table_id,
                is_deleted=False,
                field_type__in=cls._GLOBAL_SEARCHABLE_FIELD_TYPES,
            )
            .order_by('-is_primary', 'order')
            .values_list('id', flat=True)[: cls._LINKABLE_SEARCH_MAX_FIELDS]
        ]
        if field_ids:
            return field_ids
        fallback_field_id = cls._resolve_lookup_field_id(str(foreign_table_id))
        return [fallback_field_id] if fallback_field_id else []

    @classmethod
    def _native_fields_search_q(
        cls,
        foreign_table_id: str,
        field_ids: List[str],
        search: str,
    ) -> Optional[Q]:
        """
        原生列 ILIKE 命中 → ``Q(pk__in=...)``；表不存在/失败返回 None。

        native-first 下标题常只在原生列，JSONB ``data__icontains`` 会漏（ 复现）。
        """
        if not field_ids:
            return None
        try:
            from apps.tabdata.native.ddl_manager import DDLManager, resolve_schema_partition_id

            table_obj = Table.objects.using(TABDATA_DB_ALIAS).get(id=foreign_table_id)
            partition_id = resolve_schema_partition_id(table_obj)
            ddl = DDLManager()
            if not ddl.native_table_exists(partition_id, table_obj.id):
                return None
            qualified = DDLManager.qualified_table_name(partition_id, table_obj.id)
            escaped = (
                search.replace('\\', '\\\\')
                .replace('%', '\\%')
                .replace('_', '\\_')
                .lower()
            )
            like_pattern = f'%{escaped}%'
            from apps.tabdata.utils.searchable_cell_text import (
                build_searchable_column_sql_expr,
            )

            conditions: List[str] = []
            params: List[str] = []
            for raw_id in field_ids[: cls._LINKABLE_SEARCH_MAX_FIELDS]:
                try:
                    col_hex = UUID(str(raw_id)).hex
                except (TypeError, ValueError):
                    continue
                # 展示文本匹配，避免结构化列 UUID id 误命中
                text_expr = build_searchable_column_sql_expr(f'"{col_hex}"')
                conditions.append(f"{text_expr} LIKE %s ESCAPE '\\'")
                params.append(like_pattern)
            if not conditions:
                return None
            sql = (
                f'SELECT "__id" FROM {qualified} '
                f'WHERE {" OR ".join(conditions)}'
            )
            with connection.cursor() as cursor:
                cursor.execute(sql, params)
                matched_ids = [row[0] for row in cursor.fetchall()]
            return Q(pk__in=matched_ids)
        except Exception:
            logger.debug(
                'Native linkable search fallback failed for table %s',
                foreign_table_id,
                exc_info=True,
            )
            return None

    @classmethod
    def _jsonb_display_fields_search_q(
        cls,
        foreign_table_id: str,
        field_ids: List[str],
        search: str,
    ) -> Optional[Q]:
        """
        JSONB 回退：按展示文本匹配，避免整段 ``data__fid__icontains`` 扫到
        link/user 单元格 UUID id。
        """
        if not field_ids:
            return None
        try:
            from apps.tabdata.utils.searchable_cell_text import (
                build_searchable_cell_sql_expr,
            )

            escaped = (
                search.replace('\\', '\\\\')
                .replace('%', '\\%')
                .replace('_', '\\_')
                .lower()
            )
            like_pattern = f'%{escaped}%'
            conditions: List[str] = []
            params: List[Any] = [str(foreign_table_id)]
            for raw_id in field_ids[: cls._LINKABLE_SEARCH_MAX_FIELDS]:
                try:
                    field_id_str = str(UUID(str(raw_id)))
                except (TypeError, ValueError):
                    continue
                text_expr = build_searchable_cell_sql_expr(field_id_str)
                conditions.append(f"{text_expr} LIKE %s ESCAPE '\\'")
                params.append(like_pattern)
            if not conditions:
                return None
            sql = (
                f'SELECT id FROM {TableRecord._meta.db_table} '
                f'WHERE table_id = %s AND is_deleted = FALSE '
                f'AND ({" OR ".join(conditions)})'
            )
            with connection.cursor() as cursor:
                cursor.execute(sql, params)
                matched_ids = [row[0] for row in cursor.fetchall()]
            return Q(pk__in=matched_ids)
        except Exception:
            logger.debug(
                'JSONB display linkable search failed for table %s',
                foreign_table_id,
                exc_info=True,
            )
            return None

    @classmethod
    def _apply_linkable_records_search(
        cls,
        qs,
        search: str,
        *,
        search_field_id: Optional[str],
        search_field_ids: Optional[List[str]] = None,
        lookup_field_id: Optional[str],
        foreign_table_id: str,
    ):
        """
        应用关联选择器搜索：

        - 原生表可用 → 只走展示文本原生列（不再 OR 脏 JSONB icontains，）
        - 无原生表 → JSONB 展示文本回退
        - 未限定表头列时，条件满足才 OR record id（空标题回退展示 id）
        - 传入 search_field_ids（选择器表头范围）时只搜展示数据，不扫 record id
        """
        # lookup_field_id 保留兼容调用方；全局字段列表已含主字段，不再走旧 icontains。
        _ = lookup_field_id
        normalized = (search or '').strip()
        if not normalized:
            return qs

        field_ids = cls._resolve_linkable_search_field_ids(
            foreign_table_id,
            search_field_id,
            search_field_ids=search_field_ids,
        )
        # 表头范围搜索：只匹配单元格展示文本，不匹配 record / 单元格 UUID id
        scoped_to_columns = bool(search_field_id or search_field_ids)
        match_record_id = (
            (not scoped_to_columns) and cls._should_match_record_id(normalized)
        )
        if match_record_id:
            qs = cls._annotate_record_id_text(qs)

        search_q = Q()
        native_q = cls._native_fields_search_q(
            foreign_table_id, field_ids, normalized,
        )
        if native_q is not None:
            search_q |= native_q
        else:
            jsonb_q = cls._jsonb_display_fields_search_q(
                foreign_table_id, field_ids, normalized,
            )
            if jsonb_q is not None:
                search_q |= jsonb_q

        if match_record_id:
            search_q |= cls._record_id_search_q(normalized)

        if not search_q:
            return qs.none()
        return qs.filter(search_q)

    @classmethod
    def get_linkable_records(
        cls,
        field: TableField,
        *,
        search: str = '',
        search_field_id: Optional[str] = None,
        search_field_ids: Optional[List[str]] = None,
        page: int = 1,
        page_size: int = 50,
        exclude_record_id: Optional[str] = None,
        selected_record_ids: Optional[List[str]] = None,
        only_selected: bool = False,
        user=None,
    ) -> Tuple[List[Dict[str, Any]], int]:
        """
        获取目标表可关联的记录列表（支持搜索、分页、多列返回、视图过滤）。

        搜索策略：
        - 原生表可用 → 展示文本原生列匹配（不 OR 脏 JSONB icontains）
        - 无原生表 → JSONB 展示文本回退（``build_searchable_cell_sql_expr``）
        - 指定 search_field_id → 仅扫该列展示文本
        - 指定 search_field_ids（选择器全局/表头列）→ 仅扫这些列展示文本，不扫 record id
        - 未限定字段时 → 目标表可搜索字段；仅 UUID 片段才 OR record.id

        Args:
            user: 当前操作用户，用于校验目标表 Space 权限（SDI-002）

        Returns:
            (records, total) — 每条 record 含 {id, title, fields: {field_id: value}}
        """
        config = field.config or {}
        foreign_table_id = config.get('foreignTableId')
        lookup_field_id = config.get('lookupFieldId')
        relationship = config.get('relationship', DEFAULT_LINK_RELATIONSHIP)

        if not foreign_table_id:
            return [], 0

        # SDI-002: 校验用户对目标表的 Space 访问权限
        if user is not None:
            try:
                foreign_table = Table.objects.using(TABDATA_DB_ALIAS).get(
                    id=foreign_table_id, is_archived=False,
                )
            except Table.DoesNotExist:
                return [], 0
            if not cls._check_foreign_table_permission(foreign_table, user, 'viewer'):
                raise PermissionError(
                    f"无权限访问目标表 {foreign_table_id}"
                )

        normalized_selected_ids: List[str] = []
        if selected_record_ids:
            seen_selected = set()
            for record_id in selected_record_ids:
                record_id_str = str(record_id).strip()
                if not record_id_str or record_id_str in seen_selected:
                    continue
                seen_selected.add(record_id_str)
                normalized_selected_ids.append(record_id_str)

        qs = TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=foreign_table_id, is_deleted=False,
        )

        if exclude_record_id and not only_selected:
            qs = qs.exclude(id=exclude_record_id)

        # selected-only 模式：仅返回已选记录，并保持 selected_record_ids 顺序
        if only_selected:
            if not normalized_selected_ids:
                return [], 0
            qs = qs.filter(id__in=normalized_selected_ids)
        else:
            if normalized_selected_ids:
                qs = qs.exclude(id__in=normalized_selected_ids)

            # OneOne / OneMany 排除已被其他记录占用的目标记录
            if relationship in ('OneOne', 'OneMany'):
                occupied_foreign_ids = set(
                    LinkRecord.objects.using(TABDATA_DB_ALIAS).filter(link_field=field)
                    .exclude(self_record_id=exclude_record_id)
                    .values_list('foreign_record_id', flat=True)
                )
                if occupied_foreign_ids:
                    qs = qs.exclude(id__in=occupied_foreign_ids)

            # 视图过滤
            filter_by_view_id = config.get('filterByViewId')
            if filter_by_view_id:
                qs = cls._apply_view_filter_to_queryset(filter_by_view_id, qs)

            # 自定义过滤条件（config.filter / filterSet）
            custom_filter = config.get('filter')
            if custom_filter and isinstance(custom_filter, dict) and 'filterSet' in custom_filter:
                filter_q = cls._build_simple_filter_set_q(custom_filter)
                if filter_q is not None:
                    qs = qs.filter(filter_q)

        # 搜索：原生列优先 + JSONB 展示文本；表头范围不扫 record id
        normalized_search = (search or '').strip()
        if normalized_search:
            qs = cls._apply_linkable_records_search(
                qs,
                normalized_search,
                search_field_id=search_field_id,
                search_field_ids=search_field_ids,
                lookup_field_id=lookup_field_id,
                foreign_table_id=str(foreign_table_id),
            )

        offset = (page - 1) * page_size
        if only_selected:
            matched_ids = {
                str(record_id)
                for record_id in qs.values_list('id', flat=True)
            }
            ordered_selected_ids = [
                record_id
                for record_id in normalized_selected_ids
                if record_id in matched_ids
            ]
            total = len(ordered_selected_ids)
            page_record_ids = ordered_selected_ids[offset: offset + page_size]
            record_map = {
                str(record.id): record
                for record in TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                    id__in=page_record_ids,
                    is_deleted=False,
                )
            }
            records_qs = [
                record_map[record_id]
                for record_id in page_record_ids
                if record_id in record_map
            ]
        else:
            total = qs.count()
            records_qs = list(qs.order_by('order', 'created_at')[offset: offset + page_size])

        # 加载目标表字段（用于多列展示）
        visible_field_ids = config.get('visibleFieldIds')
        if visible_field_ids:
            foreign_fields = list(TableField.objects.using(TABDATA_DB_ALIAS).filter(
                id__in=visible_field_ids, table_id=foreign_table_id, is_deleted=False,
            ).order_by('order'))
        else:
            foreign_fields = list(TableField.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=foreign_table_id, is_deleted=False,
            ).order_by('order')[:8])

        # 获取主字段以构建 title
        primary_field = None
        if lookup_field_id:
            primary_field = TableField.objects.using(TABDATA_DB_ALIAS).filter(
                id=lookup_field_id, is_deleted=False
            ).first()

        results = []
        for rec in records_qs:
            title = cls._extract_record_title(rec, primary_field)
            # 多列字段值
            field_values = {}
            data = read_data(rec)
            for ff in foreign_fields:
                # collab 写 hex、REST/legacy 写 dashed；与 _extract_record_title 对齐
                fid_dashed = str(ff.id)
                fid_hex = ff.id.hex
                val = data.get(fid_hex) if fid_hex in data else data.get(fid_dashed)
                if val is not None:
                    field_values[fid_dashed] = val
            results.append({
                'id': str(rec.id),
                'title': title,
                'fields': field_values,
            })

        return results, total

    @classmethod
    def get_linkable_fields(
        cls,
        field: TableField,
        *,
        user=None,
    ) -> Dict[str, Any]:
        """
        获取关联字段的目标表字段元数据和视图列表。

        Args:
            user: 当前操作用户，用于校验目标表 Space 权限（SDI-010）

        Returns:
            { fields: [{id, name, field_type, is_primary}], views: [{id, name}] }
        """
        from apps.tabdata.models import TableView

        config = field.config or {}
        foreign_table_id = config.get('foreignTableId') or config.get('foreign_table_id')
        if not foreign_table_id:
            return {'fields': [], 'views': []}

        # SDI-010: 校验用户对目标表的 Space 访问权限
        if user is not None:
            try:
                foreign_table = Table.objects.using(TABDATA_DB_ALIAS).get(
                    id=foreign_table_id, is_archived=False,
                )
            except Table.DoesNotExist:
                return {'fields': [], 'views': []}
            if not cls._check_foreign_table_permission(foreign_table, user, 'viewer'):
                raise PermissionError(
                    f"无权限访问目标表 {foreign_table_id}"
                )

        # 字段列表
        foreign_fields = TableField.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=foreign_table_id, is_deleted=False,
        ).order_by('order').values('id', 'name', 'field_type', 'is_primary')

        fields_list = [
            {
                'id': str(f['id']),
                'name': f['name'],
                'field_type': f['field_type'],
                'is_primary': bool(f['is_primary']),
            }
            for f in foreign_fields
        ]

        # 视图列表
        views_qs = TableView.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=foreign_table_id, is_deleted=False,
        ).order_by('order').values('id', 'name')

        views_list = [
            {'id': str(v['id']), 'name': v['name']}
            for v in views_qs
        ]

        return {'fields': fields_list, 'views': views_list}

    # ──────────────────────────────────────────────────────
    # 记录删除时的清理
    # ──────────────────────────────────────────────────────

    @classmethod
    @transaction.atomic(using=TABDATA_DB_ALIAS)
    def cleanup_record_links(cls, record: TableRecord) -> List[Dict[str, Any]]:
        """
        记录物理删除前清理关联：删除 LinkRecord + 批量更新对侧 JSONB。

        Returns:
            需要发送 WS 通知的 (table_id, record_ids) 列表
        """
        affected = []

        # ── 作为 self_record 的关联（outgoing）──
        outgoing = list(
            LinkRecord.objects.using(TABDATA_DB_ALIAS).filter(self_record=record).select_related('link_field')
        )
        # 收集需要重建的 (sym_field_id, foreign_record_id) 对
        sym_rebuild_map: Dict[str, set] = {}  # sym_field_id -> {foreign_record_id, ...}
        for link in outgoing:
            field = link.link_field
            config = field.config or {}
            sym_field_id = config.get('symmetricFieldId')
            if sym_field_id:
                sym_rebuild_map.setdefault(sym_field_id, set()).add(link.foreign_record_id)

        # 先删除 LinkRecord（这样 _build_cell_value 重建时不含已删记录）
        LinkRecord.objects.using(TABDATA_DB_ALIAS).filter(self_record=record).delete()

        # 批量重建对称侧 cell value
        if sym_rebuild_map:
            all_sym_field_ids = set(sym_rebuild_map.keys())
            all_foreign_rec_ids: set = set()
            for ids in sym_rebuild_map.values():
                all_foreign_rec_ids |= ids

            sym_fields_map = {
                str(f.id): f
                for f in TableField.objects.using(TABDATA_DB_ALIAS).filter(id__in=all_sym_field_ids, is_deleted=False)
            }
            foreign_recs_map = {
                rec.id: rec
                for rec in TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                    id__in=all_foreign_rec_ids, is_deleted=False,
                )
            }
            records_to_update: list[TableRecord] = []
            native_updates_by_field: Dict[str, Dict[UUID, Any]] = {}
            _pf_cache: Dict[str, Optional[TableField]] = {}
            for sym_field_id, rec_ids in sym_rebuild_map.items():
                sym_field = sym_fields_map.get(str(sym_field_id))
                if not sym_field:
                    continue
                field_id_str = str(sym_field.id)
                for rec_id in rec_ids:
                    foreign_rec = foreign_recs_map.get(rec_id)
                    if not foreign_rec:
                        continue
                    data = dict(read_data(foreign_rec))
                    before_data = dict(data)
                    old_value = before_data.get(field_id_str)
                    cell_value = cls._build_cell_value(sym_field, foreign_rec, _primary_field_cache=_pf_cache)
                    data[field_id_str] = cell_value
                    foreign_rec.__dict__['data'] = data
                    foreign_rec._skip_record_history = True
                    records_to_update.append(foreign_rec)
                    native_updates_by_field.setdefault(field_id_str, {})[foreign_rec.id] = cell_value
                    affected.append({
                        'table_id': str(sym_field.table_id),
                        'record_id': str(foreign_rec.id),
                        'field_id': field_id_str,
                        'old_value': old_value,
                        'value': cell_value,
                        'before_data': before_data,
                        'after_data': dict(data),
                    })

            if records_to_update:
                TableRecord.objects.using(TABDATA_DB_ALIAS).bulk_update(
                    records_to_update, ['data', 'updated_at'], batch_size=100,
                )
                for fid, update_map in native_updates_by_field.items():
                    sym_field = sym_fields_map.get(fid)
                    if sym_field:
                        cls._sync_native_cells(sym_field, update_map)
                for rec in records_to_update:
                    if hasattr(rec, '_skip_record_history'):
                        delattr(rec, '_skip_record_history')

        # ── 作为 foreign_record 的关联（incoming）──
        incoming = list(
            LinkRecord.objects.using(TABDATA_DB_ALIAS).filter(foreign_record=record).select_related('link_field')
        )
        # 收集需要重建的 (field, self_record_id) 对
        incoming_rebuild: Dict[str, Tuple[TableField, set]] = {}  # field_id -> (field, {rec_ids})
        for link in incoming:
            field = link.link_field
            fid = str(field.id)
            if fid not in incoming_rebuild:
                incoming_rebuild[fid] = (field, set())
            incoming_rebuild[fid][1].add(link.self_record_id)

        # 先删除 incoming LinkRecord
        LinkRecord.objects.using(TABDATA_DB_ALIAS).filter(foreign_record=record).delete()

        # 批量重建源侧 cell value
        if incoming_rebuild:
            all_src_rec_ids: set = set()
            for _, (_, ids) in incoming_rebuild.items():
                all_src_rec_ids |= ids

            src_recs_map = {
                rec.id: rec
                for rec in TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                    id__in=all_src_rec_ids, is_deleted=False,
                )
            }
            src_records_to_update: list[TableRecord] = []
            native_updates_by_field: Dict[str, Dict[UUID, Any]] = {}
            _pf_cache_incoming: Dict[str, Optional[TableField]] = {}
            for fid, (link_field, rec_ids) in incoming_rebuild.items():
                field_id_str = str(link_field.id)
                for rec_id in rec_ids:
                    src_rec = src_recs_map.get(rec_id)
                    if not src_rec:
                        continue
                    data = dict(read_data(src_rec))
                    before_data = dict(data)
                    old_value = before_data.get(field_id_str)
                    cell_value = cls._build_cell_value(link_field, src_rec, _primary_field_cache=_pf_cache_incoming)
                    data[field_id_str] = cell_value
                    src_rec.__dict__['data'] = data
                    src_rec._skip_record_history = True
                    src_records_to_update.append(src_rec)
                    native_updates_by_field.setdefault(field_id_str, {})[src_rec.id] = cell_value
                    affected.append({
                        'table_id': str(link_field.table_id),
                        'record_id': str(rec_id),
                        'field_id': field_id_str,
                        'old_value': old_value,
                        'value': cell_value,
                        'before_data': before_data,
                        'after_data': dict(data),
                    })

            if src_records_to_update:
                TableRecord.objects.using(TABDATA_DB_ALIAS).bulk_update(
                    src_records_to_update, ['data', 'updated_at'], batch_size=100,
                )
                for fid, update_map in native_updates_by_field.items():
                    link_field = incoming_rebuild.get(fid, (None, set()))[0]
                    if link_field:
                        cls._sync_native_cells(link_field, update_map)
                for rec in src_records_to_update:
                    if hasattr(rec, '_skip_record_history'):
                        delattr(rec, '_skip_record_history')

        return affected

    # ──────────────────────────────────────────────────────
    # Title 传播
    # ──────────────────────────────────────────────────────

    @classmethod
    def propagate_title_change(
        cls, record: TableRecord, new_title: str,
    ) -> List[Dict[str, Any]]:
        """
        当记录的主字段值变化时，更新所有引用该记录的 link cell 中的 title。

        Returns:
            需要发送 WS 通知的变更列表
        """
        affected = []
        record_id = record.id

        # 查找所有引用该记录的 LinkRecord（作为 foreign_record）
        incoming_links = (
            LinkRecord.objects.using(TABDATA_DB_ALIAS)
            .filter(foreign_record_id=record_id)
            .select_related('link_field', 'self_record')
        )

        fields_to_update = {}  # {(field_id, self_record_id): link_field}
        for link in incoming_links:
            key = (link.link_field_id, link.self_record_id)
            fields_to_update[key] = link.link_field

        # 批量加载所有源记录
        src_record_ids = {sr_id for (_, sr_id) in fields_to_update.keys()}
        src_records_map = {
            rec.id: rec
            for rec in TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                id__in=src_record_ids, is_deleted=False,
            )
        }

        records_to_bulk_update: list[TableRecord] = []
        native_updates_by_field: Dict[str, Dict[UUID, Any]] = {}
        link_fields_by_id: Dict[str, TableField] = {}
        _pf_cache_title: Dict[str, Optional[TableField]] = {}
        for (field_id, self_record_id), link_field in fields_to_update.items():
            src_record = src_records_map.get(self_record_id)
            if not src_record:
                continue
            cell_value = cls._build_cell_value(link_field, src_record, _primary_field_cache=_pf_cache_title)
            field_id_str = str(link_field.id)
            field_id_hex = link_field.id.hex
            link_fields_by_id[field_id_str] = link_field
            data = dict(read_data(src_record))
            # hex/dashed 双写同一新 title：协作端读 hex、部分 REST/测试读 dashed，
            # 只写一侧会留下另一侧的陈旧标签。
            data[field_id_hex] = cell_value
            data[field_id_str] = cell_value
            src_record.__dict__['data'] = data
            src_record._skip_record_history = True
            records_to_bulk_update.append(src_record)
            native_updates_by_field.setdefault(field_id_str, {})[src_record.id] = cell_value
            affected.append({
                'table_id': str(link_field.table_id),
                'record_id': str(self_record_id),
            })

        if records_to_bulk_update:
            TableRecord.objects.using(TABDATA_DB_ALIAS).bulk_update(
                records_to_bulk_update, ['data', 'updated_at'], batch_size=100,
            )
            for fid, update_map in native_updates_by_field.items():
                link_field = link_fields_by_id.get(fid)
                if link_field:
                    cls._sync_native_cells(link_field, update_map)
            for rec in records_to_bulk_update:
                if hasattr(rec, '_skip_record_history'):
                    delattr(rec, '_skip_record_history')

        # 同样更新作为 self_record 的引用中的对称字段
        outgoing_links = (
            LinkRecord.objects.using(TABDATA_DB_ALIAS)
            .filter(self_record_id=record_id)
            .select_related('link_field')
        )
        sym_fields_to_update = {}
        for link in outgoing_links:
            config = link.link_field.config or {}
            sym_field_id = config.get('symmetricFieldId')
            if sym_field_id:
                key = (sym_field_id, link.foreign_record_id)
                sym_fields_to_update[key] = sym_field_id

        # 批量加载所有需要的对称字段和目标记录
        sym_field_ids = {sf_id for sf_id in sym_fields_to_update.values()}
        sym_foreign_rec_ids = {fr_id for (_, fr_id) in sym_fields_to_update.keys()}
        sym_fields_map = {
            str(f.id): f
            for f in TableField.objects.using(TABDATA_DB_ALIAS).filter(id__in=sym_field_ids, is_deleted=False)
        }
        sym_foreign_recs_map = {
            rec.id: rec
            for rec in TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                id__in=sym_foreign_rec_ids, is_deleted=False,
            )
        }

        sym_records_to_bulk_update: list[TableRecord] = []
        sym_native_updates_by_field: Dict[str, Dict[UUID, Any]] = {}
        _pf_cache_sym_title: Dict[str, Optional[TableField]] = {}
        for (sym_field_id, foreign_record_id), _ in sym_fields_to_update.items():
            sym_field = sym_fields_map.get(str(sym_field_id))
            foreign_rec = sym_foreign_recs_map.get(foreign_record_id)
            if not sym_field or not foreign_rec:
                continue
            cell_value = cls._build_cell_value(sym_field, foreign_rec, _primary_field_cache=_pf_cache_sym_title)
            field_id_str = str(sym_field.id)
            field_id_hex = sym_field.id.hex
            data = dict(read_data(foreign_rec))
            data[field_id_hex] = cell_value
            data[field_id_str] = cell_value
            foreign_rec.__dict__['data'] = data
            foreign_rec._skip_record_history = True
            sym_records_to_bulk_update.append(foreign_rec)
            sym_native_updates_by_field.setdefault(field_id_str, {})[foreign_rec.id] = cell_value
            affected.append({
                'table_id': str(sym_field.table_id),
                'record_id': str(foreign_record_id),
            })

        if sym_records_to_bulk_update:
            TableRecord.objects.using(TABDATA_DB_ALIAS).bulk_update(
                sym_records_to_bulk_update, ['data', 'updated_at'], batch_size=100,
            )
            for fid, update_map in sym_native_updates_by_field.items():
                sym_field = sym_fields_map.get(fid)
                if sym_field:
                    cls._sync_native_cells(sym_field, update_map)
            for rec in sym_records_to_bulk_update:
                if hasattr(rec, '_skip_record_history'):
                    delattr(rec, '_skip_record_history')

        # 协作端消费 Y.Doc 而非 table.events.delta；JSONB 更新后必须推对侧表，
        # 否则 A 表打开时仍显示旧 title。
        ydoc_by_table: Dict[str, list[TableRecord]] = {}
        for rec in records_to_bulk_update:
            ydoc_by_table.setdefault(str(rec.table_id), []).append(rec)
        for rec in sym_records_to_bulk_update:
            ydoc_by_table.setdefault(str(rec.table_id), []).append(rec)
        if ydoc_by_table:
            try:
                from apps.tabdata.utils.ydoc_sync import sync_records_to_ydoc
                for tid, recs in ydoc_by_table.items():
                    # 同表可能同时出现 incoming / symmetric 更新，按 id 去重
                    uniq = {str(r.id): r for r in recs}
                    sync_records_to_ydoc(
                        UUID(tid), list(uniq.values()), source="propagate_title_change",
                    )
            except Exception as exc:
                logger.warning("propagate_title_change Y.js sync failed: %s", exc)

        return affected

    # ──────────────────────────────────────────────────────
    # 内部方法
    # ──────────────────────────────────────────────────────

    @classmethod
    def _check_foreign_table_permission(
        cls,
        foreign_table: Table,
        user,
        required_role: str = 'editor',
    ) -> bool:
        """
        检查用户是否对目标表有编辑权限（用于创建对称字段）。

        如果 user 为 None（系统操作），默认放行。
        """
        if user is None:
            return True

        from apps.tabdata.services.base import BaseService
        service = BaseService(user=user)
        return service.check_table_permission(
            str(foreign_table.id), required_role,
        )

    @classmethod
    def _try_create_symmetric_field(
        cls,
        source_field: TableField,
        foreign_table: Table,
        relationship: str,
        source_config: Dict[str, Any],
        *,
        user=None,
    ) -> Optional[TableField]:
        """
        尝试创建对称字段，带权限检查和异常降级。

        权限不足或创建失败时返回 None（调用方应降级为单向模式）。
        """
        # 1. 权限检查
        if not cls._check_foreign_table_permission(foreign_table, user, 'editor'):
            logger.warning(
                "用户 %s 对目标表 %s 无编辑权限，跳过对称字段创建",
                getattr(user, 'id', 'unknown'), foreign_table.id,
            )
            return None

        # 2. 尝试创建
        try:
            # 使用内层 savepoint，确保任意失败都不会留下半成品对称字段。
            with transaction.atomic(using=TABDATA_DB_ALIAS):
                return cls._create_symmetric_field(
                    source_field, foreign_table, relationship, source_config,
                )
        except Exception as exc:
            logger.warning(
                "对称字段创建失败，降级为单向: field=%s, foreign_table=%s, err=%s",
                source_field.id, foreign_table.id, exc,
            )
            return None

    @classmethod
    def _create_symmetric_field(
        cls,
        source_field: TableField,
        foreign_table: Table,
        relationship: str,
        source_config: Dict[str, Any],
    ) -> TableField:
        """在目标表创建对称字段"""
        sym_relationship = SYMMETRIC_RELATIONSHIP_MAP.get(relationship, 'ManyMany')

        # 计算对称字段名
        source_table = Table.objects.using(TABDATA_DB_ALIAS).get(id=source_field.table_id)
        sym_name = f"{source_table.name}"

        # 确保名称不重复
        existing_names = set(
            TableField.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=foreign_table.id, is_deleted=False,
            ).values_list('name', flat=True)
        )
        if sym_name in existing_names:
            counter = 1
            while f"{sym_name} {counter}" in existing_names:
                counter += 1
            sym_name = f"{sym_name} {counter}"

        # 对称字段的主字段（源表的主字段）
        source_primary = TableField.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=source_field.table_id, is_primary=True, is_deleted=False
        ).first()

        # 计算 order
        max_order = TableField.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=foreign_table.id, is_deleted=False
        ).count()

        sym_config = {
            'relationship': sym_relationship,
            'foreignTableId': str(source_field.table_id),
            'lookupFieldId': str(source_primary.id) if source_primary else None,
            'symmetricFieldId': str(source_field.id),
            'isOneWay': False,
        }

        sym_field = TableField.objects.using(TABDATA_DB_ALIAS).create(
            table_id=foreign_table.id,
            name=sym_name,
            field_type='link',
            is_primary=False,
            order=max_order,
            config=sym_config,
        )

        # 对称字段走内部创建链路，需补齐 native 列创建，避免后续写入时报列不存在。
        from apps.tabdata.native.ddl_manager import DDLManager, resolve_schema_partition_id
        from apps.tabdata.native.pg_type_map import is_system_field

        if not is_system_field(sym_field.field_type):
            foreign_partition_id = resolve_schema_partition_id(foreign_table)
            ddl = DDLManager()
            ddl.add_column(
                foreign_partition_id,
                foreign_table.id,
                sym_field.id,
                sym_field.field_type,
                sym_field.config,
            )

            try:
                from apps.tabdata.native.name_resolver import invalidate_resolver
                invalidate_resolver(foreign_partition_id)
            except Exception:
                pass

            logger.info(
                "[Native] Symmetric column added: table=%s field=%s type=%s",
                foreign_table.id,
                sym_field.id,
                sym_field.field_type,
            )

        logger.info(
            "创建对称字段 sym_field=%s on table=%s (relationship=%s)",
            sym_field.id, foreign_table.id, sym_relationship,
        )
        return sym_field

    @classmethod
    def _validate_cardinality(
        cls,
        relationship: str,
        new_linked_ids: List[UUID],
        record: TableRecord,
        field: TableField,
    ) -> None:
        """基数约束验证"""
        if relationship in ('OneOne', 'ManyOne'):
            if len(new_linked_ids) > 1:
                raise ValueError(
                    f"关系类型 {relationship} 最多关联 1 条记录，"
                    f"当前尝试关联 {len(new_linked_ids)} 条"
                )

        if relationship in ('OneOne', 'OneMany') and new_linked_ids:
            # OneOne / OneMany: 目标记录不能被其他源记录重复占用
            occupied_target_ids = list(
                LinkRecord.objects.using(TABDATA_DB_ALIAS).filter(
                    link_field=field,
                    foreign_record_id__in=new_linked_ids,
                )
                .exclude(self_record=record)
                .values_list('foreign_record_id', flat=True)
                .distinct()
            )
            if not occupied_target_ids:
                return

            first_occupied = occupied_target_ids[0]
            if relationship == 'OneOne':
                raise ValueError(
                    f"一对一关系中，目标记录 {first_occupied} 已被其他记录关联"
                )

            raise ValueError(
                f"一对多关系中，目标记录 {first_occupied} 已被其他记录关联"
            )

    @classmethod
    def _sync_symmetric_cells(
        cls,
        field: TableField,
        record: TableRecord,
        added_ids: set,
        removed_ids: set,
    ) -> None:
        """同步对称字段的 LinkRecord + JSONB"""
        config = field.config or {}
        sym_field_id = config.get('symmetricFieldId')
        if not sym_field_id:
            return

        try:
            sym_field = TableField.objects.using(TABDATA_DB_ALIAS).get(id=sym_field_id, is_deleted=False)
        except TableField.DoesNotExist:
            logger.warning("对称字段不存在 sym_field_id=%s", sym_field_id)
            return

        # 删除对称方向的 LinkRecord
        if removed_ids:
            LinkRecord.objects.using(TABDATA_DB_ALIAS).filter(
                link_field=sym_field,
                self_record_id__in=removed_ids,
                foreign_record_id=record.id,
            ).delete()

        # 添加对称方向的 LinkRecord（计算正确的 order）
        if added_ids:
            from django.db.models import Max
            max_orders = dict(
                LinkRecord.objects.using(TABDATA_DB_ALIAS)
                .filter(link_field=sym_field, self_record_id__in=added_ids)
                .values('self_record_id')
                .annotate(max_order=Max('order'))
                .values_list('self_record_id', 'max_order')
            )
            sym_links = [
                LinkRecord(
                    link_field=sym_field,
                    self_record_id=foreign_id,
                    foreign_record_id=record.id,
                    order=(max_orders.get(foreign_id, 0) or 0) + 1,
                )
                for foreign_id in added_ids
            ]
            LinkRecord.objects.using(TABDATA_DB_ALIAS).bulk_create(sym_links, ignore_conflicts=True)

        # 重建受影响的对称 cell value（批量更新）
        affected_record_ids = added_ids | removed_ids
        if not affected_record_ids:
            return

        affected_records = list(
            TableRecord.objects.using(TABDATA_DB_ALIAS).filter(id__in=affected_record_ids, is_deleted=False)
        )
        records_to_update = []
        field_id_str = str(sym_field.id)
        _pf_cache_sym: Dict[str, Optional[TableField]] = {}
        for foreign_rec in affected_records:
            cell_value = cls._build_cell_value(sym_field, foreign_rec, _primary_field_cache=_pf_cache_sym)
            data = dict(read_data(foreign_rec))
            data[field_id_str] = cell_value
            foreign_rec.__dict__['data'] = data
            foreign_rec._skip_record_history = True
            records_to_update.append(foreign_rec)

        if records_to_update:
            TableRecord.objects.using(TABDATA_DB_ALIAS).bulk_update(
                records_to_update, ['data', 'updated_at'], batch_size=100
            )

            native_updates = {rec.id: read_data(rec).get(field_id_str) for rec in records_to_update}
            cls._sync_native_cells(sym_field, native_updates)

            for rec in records_to_update:
                if hasattr(rec, '_skip_record_history'):
                    delattr(rec, '_skip_record_history')

            try:
                from apps.tabdata.utils.ydoc_sync import sync_records_to_ydoc
                sync_records_to_ydoc(
                    sym_field.table_id, records_to_update,
                    source="sync_symmetric_cells",
                )
            except Exception as exc:
                logger.warning("_sync_symmetric_cells Y.js sync failed: %s", exc)

    @classmethod
    def _build_cell_value(
        cls, field: TableField, record: TableRecord,
        *, _primary_field_cache: Optional[Dict[str, Optional['TableField']]] = None,
    ) -> Any:
        """
        从 LinkRecord 重建 JSONB cell value。

        多值: [{id, title}, ...]
        单值: {id, title} 或 null

        _primary_field_cache: 可选的 {lookupFieldId: TableField|None} 缓存，
        批量调用时传入以避免 N+1 查询。
        """
        config = field.config or {}
        relationship = config.get('relationship', DEFAULT_LINK_RELATIONSHIP)
        lookup_field_id = config.get('lookupFieldId')
        is_multi = relationship in MULTI_VALUE_RELATIONSHIPS

        links = (
            LinkRecord.objects.using(TABDATA_DB_ALIAS)
            .filter(link_field=field, self_record=record)
            .select_related('foreign_record')
            .order_by('order', 'created_at')
        )

        primary_field = None
        if lookup_field_id:
            if _primary_field_cache is not None:
                if lookup_field_id not in _primary_field_cache:
                    _primary_field_cache[lookup_field_id] = TableField.objects.using(TABDATA_DB_ALIAS).filter(
                        id=lookup_field_id, is_deleted=False
                    ).first()
                primary_field = _primary_field_cache[lookup_field_id]
            else:
                primary_field = TableField.objects.using(TABDATA_DB_ALIAS).filter(
                    id=lookup_field_id, is_deleted=False
                ).first()

        values = []
        for link in links:
            foreign_rec = link.foreign_record
            if foreign_rec.is_deleted:
                continue
            title = cls._extract_record_title(foreign_rec, primary_field)
            values.append({'id': str(foreign_rec.id), 'title': title})

        if is_multi:
            return values
        else:
            return values[0] if values else None

    @classmethod
    def _write_cell_value(
        cls, record: TableRecord, field: TableField, cell_value: Any,
    ) -> None:
        """将 cell value 写入 record.data，并同步到 native 列。"""
        field_id_str = str(field.id)
        data = dict(read_data(record))
        data[field_id_str] = cell_value
        record.__dict__['data'] = data
        record._skip_record_history = True
        try:
            record.save(update_fields=['data', 'updated_at'])
            cls._sync_native_cells(field, {record.id: cell_value})
            from apps.tabdata.subscribers._utils import notify_record_changed_for_rag
            notify_record_changed_for_rag(record.table_id, record.id)
        finally:
            if hasattr(record, '_skip_record_history'):
                delattr(record, '_skip_record_history')

    @classmethod
    def _sync_native_cells(
        cls,
        field: TableField,
        record_cell_values: Dict[UUID, Any],
    ) -> None:
        """批量同步 link cell 到 native 列（best effort，不阻塞主流程）。"""
        if not record_cell_values:
            return
        try:
            from apps.tabdata.native.record_io import NativeRecordIO
            from apps.tabdata.native.value_converter import python_to_pg
            from apps.tabdata.native.ddl_manager import resolve_schema_partition_id

            table = Table.objects.using(TABDATA_DB_ALIAS).only(
                'id', 'space_id', 'organization_id',
            ).get(id=field.table_id)
            native_io = NativeRecordIO(resolve_schema_partition_id(table), table.id)
            field_hex = field.id.hex
            for record_id, cell_value in record_cell_values.items():
                native_io.update_record(
                    record_id=record_id,
                    field_values={
                        field_hex: python_to_pg(cell_value, field.field_type, field.config),
                    },
                )
        except Exception as exc:
            logger.warning("同步 link native 值失败 field=%s err=%s", field.id, exc)

    @classmethod
    def _extract_record_title(
        cls, record: TableRecord, primary_field: Optional[TableField],
    ) -> str:
        """从记录中提取显示标题——优先从 data/native 列实时读取 primary field 值。

        native-first 架构下，记录刚创建时 JSONB ``data`` 可能尚未回填，而主字段值
        已落原生列。若只读 ``read_data``（JSONB 缓存）会拿到空值，旧实现会兜底成
        ``id[:8]``——这个 8 位片段既不是真实标题，又因 ``!= 完整 id`` 骗过前端
        ``title === id`` 兜底，导致父链 cell 显示乱码（见 ）。这里在 JSONB
        缺值时回退读原生真源；若仍无可读标题，则返回统一占位符而非 UUID。
        """
        if primary_field:
            # collab persist 写 hex key、REST/legacy 写 dashed；优先 hex（协作 SSoT）
            pf_dashed = str(primary_field.id)
            pf_hex = primary_field.id.hex
            data = read_data(record)
            val = data.get(pf_hex) if pf_hex in data else data.get(pf_dashed)
            if val is None:
                # JSONB 缓存可能滞后于原生列，回退读原生真源（read_data_fresh 有实例缓存）
                fresh = read_data_fresh(record)
                val = fresh.get(pf_hex) if pf_hex in fresh else fresh.get(pf_dashed)
            if val is not None and str(val) != '':
                return str(val)
        title = getattr(record, 'title', None)
        if title:
            return title
        return UNNAMED_RECORD_DISPLAY_NAME

    @classmethod
    def _clear_link_cell_values(cls, field: TableField) -> None:
        """清空字段对应的所有 cell value（字段删除 / 切换关联表）— 批量更新，同步 native 列和 Y.js。

        collab 落库只写 ``field.id.hex`` 并删除 dashed key；REST/legacy
        仍可能写 dashed UUID。两种 key 都必须清，否则切换 foreignTableId 后
        JSONB/原生列残留旧关联，网格仍显示旧目标表记录。
        """
        field_id_str = str(field.id)
        field_id_hex = field.id.hex
        records = TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=field.table_id, is_deleted=False,
        )
        batch: list[TableRecord] = []
        cleared_record_ids: list[str] = []

        def _flush(pending: list[TableRecord]) -> None:
            if not pending:
                return
            TableRecord.objects.using(TABDATA_DB_ALIAS).bulk_update(
                pending, ['data', 'updated_at'], batch_size=100,
            )
            cls._sync_native_cells(field, {rec.id: None for rec in pending})
            for r in pending:
                if hasattr(r, '_skip_record_history'):
                    delattr(r, '_skip_record_history')

        for rec in records.iterator(chunk_size=500):
            data = dict(read_data(rec))
            changed = False
            if field_id_str in data:
                data.pop(field_id_str, None)
                changed = True
            if field_id_hex in data:
                data.pop(field_id_hex, None)
                changed = True
            if changed:
                rec.__dict__['data'] = data
                rec._skip_record_history = True
                batch.append(rec)
                cleared_record_ids.append(str(rec.id))
            if len(batch) >= 500:
                _flush(batch)
                batch = []
        _flush(batch)

        # 显式推送该字段的 null：batch_sync_all_records_to_ydoc 对「缺 key」不发
        # clear，且其 .only('id','table_id') 读不到 data，清空后无法驱动当前会话 UI。
        if not cleared_record_ids:
            return
        try:
            from apps.tabdata.subscribers._utils import run_after_commit

            table_id = field.table_id
            changes = [
                {
                    "record_id": rid,
                    "field_id_hex": field_id_hex,
                    "value": None,
                }
                for rid in cleared_record_ids
            ]
            push_batch_size = 200

            def _push_clears() -> None:
                try:
                    from apps.tabdata.services.collab_service import CollabService

                    for i in range(0, len(changes), push_batch_size):
                        CollabService.push_cells(
                            table_id=table_id,
                            changes=changes[i:i + push_batch_size],
                            agent_id="system:clear_link_cell_values",
                            editor_type="system",
                        )
                except Exception as push_exc:
                    logger.warning(
                        "_clear_link_cell_values Y.js push failed: %s", push_exc,
                    )

            run_after_commit(_push_clears)
        except Exception as ydoc_exc:
            logger.warning("_clear_link_cell_values Y.js sync failed: %s", ydoc_exc)

    @classmethod
    def _remove_from_symmetric_cell(
        cls,
        sym_field_id: str,
        foreign_record_id: UUID,
        removed_record_id: UUID,
    ) -> None:
        """从对称字段的 cell value 中移除指定记录引用"""
        try:
            sym_field = TableField.objects.using(TABDATA_DB_ALIAS).get(id=sym_field_id, is_deleted=False)
            foreign_rec = TableRecord.objects.using(TABDATA_DB_ALIAS).get(id=foreign_record_id, is_deleted=False)
        except (TableField.DoesNotExist, TableRecord.DoesNotExist):
            return

        cell_value = cls._build_cell_value(sym_field, foreign_rec)
        cls._write_cell_value(foreign_rec, sym_field, cell_value)

    @classmethod
    def _rebuild_source_cell(cls, field: TableField, record_id: UUID) -> None:
        """重建源侧 cell value"""
        try:
            record = TableRecord.objects.using(TABDATA_DB_ALIAS).get(id=record_id, is_deleted=False)
        except TableRecord.DoesNotExist:
            return
        cell_value = cls._build_cell_value(field, record)
        cls._write_cell_value(record, field, cell_value)

    @classmethod
    def _apply_view_filter_to_queryset(cls, view_id: str, qs):
        """
        加载视图过滤条件并应用到 queryset。

        使用简化的 JSONB 过滤逻辑（支持 equals / contains / is_empty / is_not_empty）。
        更复杂的操作符走 ViewDataService 全量实现。
        """
        from apps.tabdata.models import TableView

        try:
            view = TableView.objects.using(TABDATA_DB_ALIAS).get(id=view_id, is_deleted=False)
        except TableView.DoesNotExist:
            logger.warning("filterByViewId 指定的视图不存在 view_id=%s", view_id)
            return qs

        # 确定有效过滤器
        effective_filter = None
        view_filter = getattr(view, 'filter', None)
        if view_filter and isinstance(view_filter, dict) and 'filterSet' in view_filter:
            effective_filter = view_filter
        elif view.filters and isinstance(view.filters, list) and view.filters:
            logic = 'and'
            if hasattr(view, 'config') and view.config:
                logic = view.config.get('filter_logic', 'and')
            effective_filter = {
                'conjunction': logic,
                'filterSet': view.filters,
            }

        if not effective_filter:
            return qs

        combined_q = cls._build_simple_filter_set_q(effective_filter)
        if combined_q is not None:
            qs = qs.filter(combined_q)

        return qs

    @classmethod
    def _build_simple_filter_set_q(cls, filter_set: Dict[str, Any]) -> Optional[Q]:
        """
        简化版递归 FilterSet → Q 构建。

        支持的操作符: equals, not_equal, contains, does_not_contain,
        is_empty, is_not_empty, greater_than, less_than, is, is_not
        """
        from functools import reduce

        conjunction = (filter_set.get('conjunction') or 'and').strip().lower()
        items = filter_set.get('filterSet')
        if not isinstance(items, list) or not items:
            return None

        q_objects: List[Q] = []
        for item in items:
            if not isinstance(item, dict):
                continue

            # 嵌套 FilterSet
            if 'filterSet' in item and 'conjunction' in item:
                sub_q = cls._build_simple_filter_set_q(item)
                if sub_q is not None:
                    q_objects.append(sub_q)
                continue

            # 叶子节点
            if item.get('enabled') is False:
                continue
            field_ref = item.get('fieldId') or item.get('field_id') or item.get('field')
            operator = (item.get('operator') or '').strip().lower()
            value = item.get('value')
            if not field_ref or not operator:
                continue

            field_key = str(field_ref)
            data_lookup = f'data__{field_key}'

            q = cls._build_simple_filter_q(data_lookup, operator, value)
            if q is not None:
                q_objects.append(q)

        if not q_objects:
            return None

        use_or = conjunction == 'or'
        return reduce((lambda a, b: a | b) if use_or else (lambda a, b: a & b), q_objects)

    @staticmethod
    def _build_simple_filter_q(data_lookup: str, operator: str, value) -> Optional[Q]:
        """为单个 FilterItem 构建 Q 对象（简化版）"""
        op = operator.replace(' ', '_').lower()

        if op in ('equals', 'is', 'equal'):
            return Q(**{data_lookup: value})
        elif op in ('not_equal', 'is_not', 'not_equals'):
            return ~Q(**{data_lookup: value})
        elif op in ('contains',):
            return Q(**{f'{data_lookup}__icontains': value})
        elif op in ('does_not_contain', 'not_contains'):
            return ~Q(**{f'{data_lookup}__icontains': value})
        elif op in ('is_empty', 'empty'):
            return Q(**{f'{data_lookup}__isnull': True}) | Q(**{data_lookup: ''}) | Q(**{data_lookup: None})
        elif op in ('is_not_empty', 'not_empty'):
            return ~(Q(**{f'{data_lookup}__isnull': True}) | Q(**{data_lookup: ''}) | Q(**{data_lookup: None}))
        elif op in ('greater_than', 'gt'):
            return Q(**{f'{data_lookup}__gt': value})
        elif op in ('less_than', 'lt'):
            return Q(**{f'{data_lookup}__lt': value})
        elif op in ('greater_than_or_equal', 'gte'):
            return Q(**{f'{data_lookup}__gte': value})
        elif op in ('less_than_or_equal', 'lte'):
            return Q(**{f'{data_lookup}__lte': value})
        else:
            logger.debug("Unsupported filter operator in link field: %s", operator)
            return None
