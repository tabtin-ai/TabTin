"""
TableView 服务层

提供视图管理的业务逻辑
"""
import logging
from typing import Optional, List, Dict, Any
from types import SimpleNamespace
from uuid import UUID
from django.db import transaction
from django.db.models import QuerySet

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import TableView, Table, TableField
from apps.tabdata.request_context import get_current_window_id
from apps.tabdata.services.base import BaseService
from apps.tabdata.services.sub_record_service import SubRecordService
from apps.tabdata.services.undo_redo_operation_service import UndoRedoOperationService
from apps.tabdata.utils.view_serializers import build_view_column_meta, parse_view_column_meta
from apps.tabdata.utils.view_validators import ViewConfigValidator
from apps.tabdata.services.table_event_service import table_event_service

_COLUMN_META_EXTENSION_CONFIG_KEY = 'column_meta_ext'
logger = logging.getLogger(__name__)


class ViewService(BaseService):
    """视图服务"""

    _PRIMARY_REQUIRED_VISIBLE_VIEW_TYPES = {'grid', 'kanban', 'gallery', 'list'}

    @staticmethod
    def _extract_group_field_id(groups: Optional[List]) -> Optional[str]:
        if not groups:
            return None
        first = groups[0]
        if not isinstance(first, dict):
            return None
        field_id = first.get('field_id') or first.get('field')
        if isinstance(field_id, str) and field_id.strip():
            return field_id.strip()
        return None

    @classmethod
    def _sync_groups_and_group_by_field(
        cls,
        config: Optional[Dict[str, Any]],
        groups: Optional[List],
    ) -> tuple[Dict[str, Any], List]:
        """双向对齐 groups[0] 与 config.group_by_field（看板 UI / CLI 共用口径）。

        - 有 groups[0].field_id → 写入 config.group_by_field
        - 仅有 group_by_field、groups 为空 → 补 groups=[{field_id, direction:'asc'}]
        """
        synced_config: Dict[str, Any] = dict(config or {})
        synced_groups: List = list(groups) if groups is not None else []

        group_field_from_groups = cls._extract_group_field_id(synced_groups)
        group_by = synced_config.get('group_by_field')
        if isinstance(group_by, str):
            group_by = group_by.strip() or None
        else:
            group_by = None

        if group_field_from_groups:
            synced_config['group_by_field'] = str(group_field_from_groups)
        elif group_by and not synced_groups:
            synced_groups = [{'field_id': str(group_by), 'direction': 'asc'}]

        return synced_config, synced_groups

    def _get_operation_service(self) -> UndoRedoOperationService:
        return UndoRedoOperationService(user=self.user)

    def _publish_view_event(
        self,
        table_id,
        action: str,
        view: 'TableView',
    ) -> None:
        """发布视图变更 WS 事件（fire-and-forget）。"""
        try:
            serializer = self._get_operation_service().serialize_view
            table_event_service.publish_view_change(
                str(table_id),
                action=action,
                view_id=str(view.id),
                view=serializer(view),
                metadata={"user_id": str(self.user.id) if self.user else None},
            )
        except Exception as exc:
            logger.warning("[WS] view event publish failed: %s", exc)

    @staticmethod
    def _sync_table_first_view(table_id: UUID) -> Optional[TableView]:
        """把旧 default_view 字段同步为 order 第一的视图，供旧接口和导出链路兼容使用。"""
        first_view = (
            TableView.objects.using(TABDATA_DB_ALIAS)
            .filter(table_id=table_id)
            .order_by('order', 'created_at')
            .first()
        )
        Table.objects.using(TABDATA_DB_ALIAS).filter(id=table_id).update(
            default_view_id=first_view.id if first_view else None
        )
        return first_view

    @staticmethod
    def _move_view_to_first(table_id: UUID, view_id: UUID) -> Optional[TableView]:
        views = list(
            TableView.objects.using(TABDATA_DB_ALIAS)
            .filter(table_id=table_id)
            .order_by('order', 'created_at')
        )
        target = next((view for view in views if view.id == view_id), None)
        if target is None:
            return None

        ordered_views = [target, *[view for view in views if view.id != view_id]]
        for index, view in enumerate(ordered_views):
            view.order = index
        TableView.objects.using(TABDATA_DB_ALIAS).bulk_update(
            ordered_views,
            ['order'],
            batch_size=200,
        )
        Table.objects.using(TABDATA_DB_ALIAS).filter(id=table_id).update(default_view_id=view_id)
        return target

    @classmethod
    def _ensure_primary_fields_visible(
        cls,
        view_type: str,
        table_fields: List[TableField],
        visible_fields: Optional[List],
    ) -> None:
        normalized_view_type = str(view_type or '').strip().lower()
        if normalized_view_type not in cls._PRIMARY_REQUIRED_VISIBLE_VIEW_TYPES:
            return
        if visible_fields is None:
            return

        primary_field_ids = [str(field.id) for field in table_fields if field.is_primary]
        if not primary_field_ids:
            return

        # 与现有协议兼容：空列表表示“全部可见”
        visible_field_ids = [str(field_id) for field_id in visible_fields if field_id is not None]
        if not visible_field_ids:
            return

        visible_set = set(visible_field_ids)
        hidden_primary_ids = [field_id for field_id in primary_field_ids if field_id not in visible_set]
        if hidden_primary_ids:
            raise ValueError(
                f"{normalized_view_type} 视图中主字段不可隐藏（字段ID: {', '.join(hidden_primary_ids)}）"
            )

    def list_views(
        self,
        table_id: Optional[UUID] = None,
        view_type: Optional[str] = None
    ) -> QuerySet:
        """
        获取视图列表

        Args:
            table_id: 表格ID（可选）
            view_type: 视图类型（可选）

        Returns:
            视图查询集
        """
        views = TableView.objects.using(TABDATA_DB_ALIAS).all()

        # 按表格筛选
        if table_id:
            # 检查表格权限
            table = Table.objects.using(TABDATA_DB_ALIAS).filter(id=table_id).first()
            if not table:
                return TableView.objects.none()

            # 检查用户是否有权限访问表格
            if not self.check_table_permission(table_id, 'viewer'):
                return TableView.objects.none()

            views = views.filter(table_id=table_id)

        # 按类型筛选
        if view_type:
            views = views.filter(view_type=view_type)

        return views.select_related('table', 'created_by').order_by('order', 'created_at')

    def get_view(self, view_id: UUID) -> Optional[TableView]:
        """
        获取视图详情

        Args:
            view_id: 视图ID

        Returns:
            视图对象或None
        """
        try:
            # 注意：不能 select_related('created_by')，因为 User 在 MySQL，TableView 在 PostgreSQL
            view = TableView.objects.using(TABDATA_DB_ALIAS).select_related('table').get(id=view_id)

            # 检查权限
            if not self.check_table_permission(view.table.id, 'viewer'):
                return None

            return view
        except TableView.DoesNotExist:
            return None

    @transaction.atomic(using=TABDATA_DB_ALIAS)
    def create_view(
        self,
        table_id: UUID,
        name: str,
        view_type: str = 'grid',
        description: Optional[str] = None,
        filter: Optional[Dict[str, Any]] = None,
        filters: Optional[List] = None,
        sorts: Optional[List] = None,
        groups: Optional[List] = None,
        visible_fields: Optional[List] = None,
        field_order: Optional[List] = None,
        column_meta: Optional[Dict[str, Dict[str, Any]]] = None,
        config: Optional[dict] = None
    ) -> Optional[TableView]:
        """
        创建视图

        Args:
            table_id: 表格ID
            name: 视图名称
            view_type: 视图类型（grid/kanban/calendar/gallery/list/flashcard/form）
            description: 描述
            filters: 过滤条件
            sorts: 排序规则
            groups: 分组规则（看板分列字段；与 config.group_by_field 双向对齐）
            visible_fields: 可见字段列表
            field_order: 字段顺序
            column_meta: 列元数据格式（可选）
            config: 视图配置

        Returns:
            创建的视图或None

        Raises:
            ValueError: 配置验证失败时抛出
        """
        # 检查表格是否存在
        table = Table.objects.using(TABDATA_DB_ALIAS).filter(id=table_id).first()
        if not table:
            raise ValueError("表格不存在")

        # 检查权限
        if not self.check_table_permission(table_id, 'editor'):
            return None

        # 验证视图类型
        valid_types = ['grid', 'kanban', 'calendar', 'gallery', 'list', 'flashcard', 'form']
        if view_type not in valid_types:
            raise ValueError(f"不支持的视图类型: {view_type}，支持的类型: {valid_types}")

        table_fields = list(
            TableField.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=table_id,
                is_deleted=False
            ).only('id', 'name', 'field_type', 'order', 'is_primary').order_by('order')
        )
        all_field_ids = [str(field.id) for field in table_fields]

        if not visible_fields:
            visible_fields = list(all_field_ids)
        if not field_order:
            field_order = list(all_field_ids)

        # 空 config 保持空壳，不落库 get_config_suggestions。
        # 建议仍由校验 API 返回，供看板/日历配置卡预选；与 Collab createViewForRuntime 对齐。
        if config is None:
            config = {}

        # 仅看板：groups ↔ config.group_by_field 双向对齐（勿污染 grid 行分组）
        if view_type == 'kanban':
            config, groups = self._sync_groups_and_group_by_field(config, groups)
            if config.get('group_by_field') and not config.get('card_title_field'):
                title_field = (
                    next((field for field in table_fields if field.is_primary), None)
                    or next((field for field in table_fields if field.field_type == 'text'), None)
                    or (table_fields[0] if table_fields else None)
                )
                if title_field is not None:
                    config['card_title_field'] = str(title_field.id)

        column_meta_to_save: Optional[Dict[str, Dict[str, Any]]] = None
        if column_meta is not None:
            parsed = parse_view_column_meta(
                column_meta,
                table_fields=table_fields,
                view_type=view_type,
            )
            visible_fields = parsed['visible_fields']
            field_order = parsed['field_order']
            column_meta_to_save = parsed.get('column_meta')

            config = dict(config or {})
            existing_widths = config.get('column_widths')
            merged_widths: Dict[str, int] = {}
            if isinstance(existing_widths, dict):
                merged_widths.update(
                    {str(key): int(value) for key, value in existing_widths.items() if isinstance(value, (int, float))}
                )
            merged_widths.update(parsed['column_widths'])
            if merged_widths:
                config['column_widths'] = merged_widths

            extension_meta = parsed.get(_COLUMN_META_EXTENSION_CONFIG_KEY)
            if isinstance(extension_meta, dict) and extension_meta:
                config[_COLUMN_META_EXTENSION_CONFIG_KEY] = extension_meta
            else:
                config.pop(_COLUMN_META_EXTENSION_CONFIG_KEY, None)

        if column_meta_to_save is None:
            draft_view = SimpleNamespace(
                view_type=view_type,
                visible_fields=visible_fields,
                field_order=field_order,
                config=config,
                column_meta={},
            )
            column_meta_to_save = build_view_column_meta(
                draft_view,
                table_fields=table_fields,
                prefer_persisted=False,
            )

        self._ensure_primary_fields_visible(view_type, table_fields, visible_fields)

        # 用 lenient 模式验证（创建时允许配置不完整）
        is_valid, errors, warnings = ViewConfigValidator.validate(table, view_type, config, strict=False)
        if not is_valid:
            error_msg = f"视图配置验证失败: {'; '.join(errors)}"
            raise ValueError(error_msg)

        # 获取当前最大顺序号
        max_order = TableView.objects.using(TABDATA_DB_ALIAS).filter(table_id=table_id).count()

        # 创建视图
        view = TableView.objects.using(TABDATA_DB_ALIAS).create(
            table=table,
            name=name,
            view_type=view_type,
            description=description or '',
            filter=filter,
            filters=filters or [],
            sorts=sorts or [],
            groups=groups or [],
            visible_fields=visible_fields,
            field_order=field_order or [],
            column_meta=column_meta_to_save or {},
            config=config,
            created_by=self.user,
            order=max_order
        )

        try:
            self._get_operation_service().push_create_view(
                view=view,
                window_id=get_current_window_id(),
            )
        except Exception as exc:
            # 结构操作入栈失败不影响主流程
            logger.warning("[UndoRedo] 视图创建操作入栈失败 view_id=%s err=%s", view.id, exc)
        self._publish_view_event(table_id, "create_view", view)

        return view

    @transaction.atomic(using=TABDATA_DB_ALIAS)
    def update_view(
        self,
        view_id: UUID,
        name: Optional[str] = None,
        description: Optional[str] = None,
        filter: Optional[Dict[str, Any]] = None,
        filters: Optional[List] = None,
        sorts: Optional[List] = None,
        groups: Optional[List] = None,
        visible_fields: Optional[List] = None,
        field_order: Optional[List] = None,
        column_meta: Optional[Dict[str, Dict[str, Any]]] = None,
        config: Optional[dict] = None,
        is_shared: Optional[bool] = None,
        is_locked: Optional[bool] = None
    ) -> Optional[TableView]:
        """
        更新视图

        Args:
            view_id: 视图ID
            name: 视图名称
            description: 描述
            filters: 过滤条件
            sorts: 排序规则
            groups: 分组规则
            visible_fields: 可见字段列表
            field_order: 字段顺序
            column_meta: 列元数据格式（可选）
            config: 视图配置
            is_shared: 是否分享
            is_locked: 是否锁定

        Returns:
            更新后的视图或None
        """
        view = self.get_view(view_id)
        if not view:
            return None

        # 检查权限
        if not self.check_table_permission(view.table.id, 'editor'):
            return None

        # 如果视图被锁定，只有owner可以修改
        if view.is_locked:
            if not self.check_table_permission(view.table.id, 'owner'):
                return None
        operation_service = self._get_operation_service()
        old_view_payload = operation_service.serialize_view(view)

        config_to_validate: Optional[dict] = None
        if config is not None:
            config_to_validate = {**view.config, **config}

        table_fields: Optional[List[TableField]] = None
        if column_meta is not None or visible_fields is not None:
            table_fields = list(
                TableField.objects.using(TABDATA_DB_ALIAS).filter(
                    table_id=view.table_id,
                    is_deleted=False
                ).only('id', 'name', 'order', 'is_primary').order_by('order')
            )

        column_meta_to_save: Optional[Dict[str, Dict[str, Any]]] = None
        if column_meta is not None:
            parsed = parse_view_column_meta(
                column_meta,
                table_fields=table_fields or [],
                base_column_meta=build_view_column_meta(view, table_fields=table_fields or []),
                view_type=view.view_type,
            )
            visible_fields = parsed['visible_fields']
            field_order = parsed['field_order']
            column_meta_to_save = parsed.get('column_meta')

            next_config = dict(config_to_validate or view.config or {})
            existing_widths = next_config.get('column_widths')
            merged_widths: Dict[str, int] = {}
            if isinstance(existing_widths, dict):
                merged_widths.update(
                    {str(key): int(value) for key, value in existing_widths.items() if isinstance(value, (int, float))}
                )
            merged_widths.update(parsed['column_widths'])
            if merged_widths:
                next_config['column_widths'] = merged_widths

            extension_meta = parsed.get(_COLUMN_META_EXTENSION_CONFIG_KEY)
            if isinstance(extension_meta, dict) and extension_meta:
                next_config[_COLUMN_META_EXTENSION_CONFIG_KEY] = extension_meta
            else:
                next_config.pop(_COLUMN_META_EXTENSION_CONFIG_KEY, None)
            config_to_validate = next_config

        if visible_fields is not None:
            self._ensure_primary_fields_visible(view.view_type, table_fields or [], visible_fields)

        effective_view_config = (
            config_to_validate
            if config_to_validate is not None
            else (view.config or {})
        )
        effective_groups = groups if groups is not None else view.groups
        # 看板：任一侧更新时对齐 groups ↔ group_by_field，避免 CLI 只传一边导致空壳看板
        if view.view_type == 'kanban' and (groups is not None or config is not None):
            # 显式改 config.group_by_field 且未传 groups 时，以本次 config 为准（勿被旧 groups 盖回）
            if groups is None and config is not None and 'group_by_field' in config:
                sync_groups_input: Optional[List] = []
            else:
                sync_groups_input = effective_groups
            synced_config, synced_groups = self._sync_groups_and_group_by_field(
                effective_view_config if isinstance(effective_view_config, dict) else {},
                sync_groups_input,
            )
            config_to_validate = synced_config
            effective_view_config = synced_config
            groups = synced_groups
            effective_groups = synced_groups

        if config_to_validate is not None:
            effective_view_config = config_to_validate

        sub_record_parent_field_id = None
        if isinstance(effective_view_config, dict):
            sub_record_parent_field_id = effective_view_config.get(
                'subRecordParentFieldId'
            )
        # 仅在显式更新 config 时校验父字段候选，避免历史脏配置阻断无关更新
        if config_to_validate is not None:
            SubRecordService.validate_parent_field_selection(
                table_id=view.table_id,
                sub_record_parent_field_id=sub_record_parent_field_id,
            )
        SubRecordService.validate_grouping_policy(
            table_id=view.table_id,
            groups=effective_groups,
            sub_record_parent_field_id=sub_record_parent_field_id,
        )

        # 验证配置（如果提供了新的config，或 column_meta 导致 config 变化）
        if config_to_validate is not None:
            is_valid, errors, warnings = ViewConfigValidator.validate(view.table, view.view_type, config_to_validate)
            if not is_valid:
                error_msg = f"视图配置验证失败: {'; '.join(errors)}"
                raise ValueError(error_msg)
            view.config = config_to_validate

        # 更新字段
        if name is not None:
            view.name = name
        if description is not None:
            view.description = description
        if filter is not None:
            view.filter = filter
        if filters is not None:
            view.filters = filters
        if sorts is not None:
            view.sorts = sorts
        if groups is not None:
            view.groups = groups
        if visible_fields is not None:
            view.visible_fields = visible_fields
        if field_order is not None:
            view.field_order = field_order
        if is_shared is not None:
            view.is_shared = is_shared
        if is_locked is not None:
            view.is_locked = is_locked

        display_related_changed = (
            column_meta is not None
            or visible_fields is not None
            or field_order is not None
            or config is not None
        )
        if column_meta_to_save is not None:
            view.column_meta = column_meta_to_save
        elif display_related_changed:
            if table_fields is None:
                table_fields = list(
                    TableField.objects.using(TABDATA_DB_ALIAS).filter(
                        table_id=view.table_id,
                        is_deleted=False
                    ).only('id', 'name', 'order', 'is_primary').order_by('order')
                )
            view.column_meta = build_view_column_meta(
                view,
                table_fields=table_fields or [],
                prefer_persisted=False,
            )

        # config_rev 单调递增：REST 直接写配置维度时也 +1，保持与协作快照/Y.Doc 的
        # 回退防护口径一致（旧快照 config_rev 更低时不覆盖新配置，/#3329）。
        config_dims_changed = (
            display_related_changed
            or filter is not None
            or filters is not None
            or sorts is not None
            or groups is not None
        )
        if config_dims_changed:
            view.config_rev = (getattr(view, "config_rev", 0) or 0) + 1

        view.save()
        try:
            new_view_payload = operation_service.serialize_view(view)
            operation_service.push_update_view(
                table_id=view.table_id,
                old_view_payload=old_view_payload,
                new_view_payload=new_view_payload,
                window_id=get_current_window_id(),
                action_display='更新视图',
            )
        except Exception as exc:
            logger.warning("[UndoRedo] 视图更新操作入栈失败 view_id=%s err=%s", view.id, exc)
        self._publish_view_event(view.table_id, "update_view", view)
        return view

    @transaction.atomic(using=TABDATA_DB_ALIAS)
    def delete_view(self, view_id: UUID) -> bool:
        """
        删除视图

        Args:
            view_id: 视图ID

        Returns:
            是否删除成功
        """
        view = self.get_view(view_id)
        if not view:
            return False

        # 检查权限
        if not self.check_table_permission(view.table.id, 'editor'):
            return False

        locked_views = list(
            TableView.objects.using(TABDATA_DB_ALIAS)
            .select_for_update()
            .filter(table_id=view.table_id)
            .only('id')
        )
        if len(locked_views) <= 1:
            raise ValueError("至少需要保留一个视图")

        next_first_view = (
            TableView.objects.using(TABDATA_DB_ALIAS)
            .filter(table_id=view.table_id)
            .exclude(id=view.id)
            .order_by('order', 'created_at')
            .only('id')
            .first()
        )
        if view.table.default_view_id == view.id and next_first_view is not None:
            Table.objects.using(TABDATA_DB_ALIAS).filter(id=view.table_id).update(
                default_view_id=next_first_view.id
            )

        operation_service = self._get_operation_service()
        view_payload_before_delete = operation_service.serialize_view(view)
        table_id_for_event = view.table_id
        view_id_for_event = str(view.id)
        view.delete()
        # : 入栈失败必须回滚整次删除——否则视图已删但 Ctrl+Z 无操作可撤。
        # 本方法在 @transaction.atomic 内，异常会触发事务回滚。
        operation_service.push_delete_view(
            view_payload_before_delete=view_payload_before_delete,
            window_id=get_current_window_id(),
        )
        # 删除后推送事件（携带删除前的快照，方便前端识别被删视图）
        try:
            table_event_service.publish_view_change(
                str(table_id_for_event),
                action="delete_view",
                view_id=view_id_for_event,
                view=view_payload_before_delete,
                metadata={"user_id": str(self.user.id) if self.user else None},
            )
        except Exception as exc:
            logger.warning("[WS] view delete event publish failed: %s", exc)
        self._sync_table_first_view(table_id_for_event)
        return True

    @transaction.atomic(using=TABDATA_DB_ALIAS)
    def set_default_view(self, table_id: UUID, view_id: UUID) -> bool:
        """
        设置首个视图。

        旧 API 名称保留给外部调用方；当前产品语义为把目标视图移动到 order 第一。

        Args:
            table_id: 表格ID
            view_id: 视图ID

        Returns:
            是否设置成功
        """
        # 检查权限
        if not self.check_table_permission(table_id, 'editor'):
            return False

        table = Table.objects.using(TABDATA_DB_ALIAS).filter(id=table_id).first()
        if not table:
            return False

        view = self._move_view_to_first(table_id, view_id)
        if not view:
            return False

        self._publish_view_event(table_id, "set_default_view", view)

        return True

    @transaction.atomic(using=TABDATA_DB_ALIAS)
    def reorder_views(self, table_id: UUID, view_orders: List[dict]) -> bool:
        """
        重新排序视图

        Args:
            table_id: 表格ID
            view_orders: 视图顺序列表 [{"view_id": "xxx", "order": 0}, ...]

        Returns:
            是否重排成功
        """
        # 检查权限
        if not self.check_table_permission(table_id, 'editor'):
            return False

        # 批量更新顺序
        operation_service = self._get_operation_service()
        views_before = list(
            TableView.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=table_id,
                id__in=[item.get('view_id') for item in view_orders if item.get('view_id')],
            )
        )
        old_view_payloads = [operation_service.serialize_view(view) for view in views_before]

        for item in view_orders:
            view_id = item.get('view_id')
            order = item.get('order')

            if view_id and order is not None:
                TableView.objects.using(TABDATA_DB_ALIAS).filter(
                    id=view_id,
                    table_id=table_id
                ).update(order=order)

        self._sync_table_first_view(table_id)

        views_after = list(
            TableView.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=table_id,
                id__in=[view.id for view in views_before],
            )
        )
        new_view_payloads = [operation_service.serialize_view(view) for view in views_after]
        try:
            operation_service.push_update_views(
                table_id=table_id,
                old_views=old_view_payloads,
                new_views=new_view_payloads,
                window_id=get_current_window_id(),
                action_display='重排视图',
            )
        except Exception as exc:
            logger.warning("[UndoRedo] 视图重排操作入栈失败 table_id=%s err=%s", table_id, exc)

        return True

    def check_table_permission(self, table_id: UUID, required_role: str = 'viewer') -> bool:
        """
        检查用户对表格的权限（通过 Space -> Organization）

        Args:
            table_id: 表格ID
            required_role: 所需角色 (viewer/editor/owner)

        Returns:
            是否有权限
        """
        from apps.tabdata.services.table_service import TableService

        table_service = TableService(user=self.user)
        return table_service.check_table_permission(str(table_id), required_role)
