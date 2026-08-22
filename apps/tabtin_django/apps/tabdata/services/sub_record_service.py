"""
子记录 (Sub-Record) 核心服务

通过自引用单向 Link 字段实现记录间的父子层级关系。
父记录字段特征: field_type='link', config.foreignTableId=本表ID,
config.isOneWay=true, config.relationship='ManyOne',
config.isSubRecordParentField=true

最大层级深度: 4 级子记录 (depth 0~4)
"""

import logging
from collections import defaultdict
from typing import Any, Dict, List, Optional, Set, Tuple
from uuid import UUID

from django.db import transaction

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import LinkRecord, Table, TableField, TableRecord

logger = logging.getLogger('tabdata.sub_record')

MAX_SUB_RECORD_DEPTH = 4


class SubRecordService:
    """子记录核心服务"""

    @staticmethod
    def _is_self_many_one_field_config(config: Dict[str, Any], table_id: UUID) -> bool:
        """校验字段配置是否为本表自引用单向 ManyOne。"""
        if str(config.get('foreignTableId', '')) != str(table_id):
            return False
        if config.get('isOneWay', False) is not True:
            return False
        return str(config.get('relationship', '')).strip() == 'ManyOne'

    # ──────────────────────────────────────────────────────
    # 父记录字段管理
    # ──────────────────────────────────────────────────────

    @classmethod
    def get_parent_field(cls, table_id: UUID) -> Optional[TableField]:
        """
        获取表格的子记录父字段。

        查找 config 中标记了 isSubRecordParentField=true 的自引用单向 link 字段。
        """
        fields = TableField.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=table_id,
            field_type='link',
            is_deleted=False,
        ).order_by('order', 'created_at')
        for field in fields:
            config = field.config or {}
            if config.get('isSubRecordParentField') and cls._is_self_many_one_field_config(config, table_id):
                return field
        return None

    @classmethod
    def get_parent_field_by_id(
        cls, table_id: UUID, field_id: UUID
    ) -> Optional[TableField]:
        """
        根据字段 ID 获取用作父记录的自引用单向 link 字段。
        该字段必须满足: isOneWay=true, foreignTableId=table_id。
        """
        try:
            field = TableField.objects.using(TABDATA_DB_ALIAS).get(
                id=field_id,
                table_id=table_id,
                field_type='link',
                is_deleted=False,
            )
        except TableField.DoesNotExist:
            return None

        config = field.config or {}
        if not cls._is_self_many_one_field_config(config, table_id):
            return None
        return field

    @classmethod
    def _allocate_parent_field_name(cls, table_id: UUID) -> str:
        """按「父记录 / 父记录 1 / …」规则分配不冲突的字段名。"""
        base_name = '父记录'
        existing_names = set(
            TableField.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=table_id,
                is_deleted=False,
            ).values_list('name', flat=True)
        )
        if base_name not in existing_names:
            return base_name
        index = 1
        while True:
            candidate = f"{base_name} {index}"
            if candidate not in existing_names:
                return candidate
            index += 1

    @classmethod
    def _build_parent_field_config(cls, table_id: UUID) -> Dict[str, Any]:
        """构建子记录父字段的 link config。"""
        primary_field = TableField.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=table_id, is_primary=True, is_deleted=False
        ).first()
        config: Dict[str, Any] = {
            'foreignTableId': str(table_id),
            'relationship': 'ManyOne',
            'isOneWay': True,
            'symmetricFieldId': None,
            'isSubRecordParentField': True,
        }
        if primary_field:
            config['lookupFieldId'] = str(primary_field.id)
        return config

    @classmethod
    def _create_parent_field_via_table_service(
        cls, table_id: UUID, user
    ) -> TableField:
        """
        始终创建一个新的父记录字段，走 TableService.create_field 完整生命周期。

        调用方须已完成权限校验，并处于事务中。先对表 select_for_update，
        再分配名称并创建，避免并发下撞上 create_field 的同名同类型幂等复用。
        """
        from apps.tabdata.services import TableService

        try:
            Table.objects.using(TABDATA_DB_ALIAS).select_for_update().get(
                id=table_id, is_archived=False
            )
        except Table.DoesNotExist as exc:
            raise ValueError(f"表格不存在: {table_id}") from exc

        existing_field_ids = set(
            TableField.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=table_id,
                is_deleted=False,
            ).values_list('id', flat=True)
        )
        field_name = cls._allocate_parent_field_name(table_id)
        config = cls._build_parent_field_config(table_id)

        table_service = TableService(user=user)
        field = table_service.create_field(
            table_id=table_id,
            name=field_name,
            field_type='link',
            description='子记录层级关系的父记录字段',
            options=config,
            # 外层 ensure/create 已显式 check_table_permission。
            skip_permission_check=True,
        )
        if field is None:
            raise ValueError(f"创建父记录字段失败: {table_id}")

        if field.id in existing_field_ids:
            raise ValueError(
                f'字段名称"{field_name}"创建未生效（被幂等复用），请重试'
            )
        if not (field.config or {}).get('isSubRecordParentField'):
            raise ValueError(
                f'字段名称"{field_name}"已被占用且不是父记录字段，请重试'
            )

        logger.info(
            "创建子记录父字段 table=%s field=%s name=%s",
            table_id, field.id, field.name,
        )
        return field

    @classmethod
    @transaction.atomic(using=TABDATA_DB_ALIAS)
    def ensure_parent_field(cls, table_id: UUID, user) -> TableField:
        """
        查找或创建子记录父字段（幂等）。

        如果表格中已存在 isSubRecordParentField=true 的字段则直接返回。
        否则创建一个名为 "父记录" 的自引用单向 link 字段。
        """
        from apps.tabdata.services import TableService

        permission_service = TableService(user=user)
        if not permission_service.check_table_permission(str(table_id), 'editor'):
            raise PermissionError("无权限修改该表格")

        existing = cls.get_parent_field(table_id)
        if existing:
            return existing

        # 锁表后重检，避免并发 ensure 各自新建一列
        try:
            Table.objects.using(TABDATA_DB_ALIAS).select_for_update().get(
                id=table_id, is_archived=False
            )
        except Table.DoesNotExist as exc:
            raise ValueError(f"表格不存在: {table_id}") from exc

        existing = cls.get_parent_field(table_id)
        if existing:
            return existing

        return cls._create_parent_field_via_table_service(table_id, user)

    @classmethod
    @transaction.atomic(using=TABDATA_DB_ALIAS)
    def create_parent_field(cls, table_id: UUID, user) -> TableField:
        """
        始终创建新的子记录父字段（非幂等）。

        用于工具栏「创建父记录字段」：每次点击生成独立关系列，
        命名沿用「父记录 / 父记录 1 / …」。
        """
        from apps.tabdata.services import TableService

        permission_service = TableService(user=user)
        if not permission_service.check_table_permission(str(table_id), 'editor'):
            raise PermissionError("无权限修改该表格")

        return cls._create_parent_field_via_table_service(table_id, user)

    @classmethod
    def validate_parent_field_selection(
        cls,
        table_id: UUID,
        sub_record_parent_field_id: Optional[Any],
    ) -> None:
        """
        校验视图 config.subRecordParentFieldId 是否为合法自引用单向 ManyOne。

        None / 空字符串表示关闭层级，合法。
        """
        if sub_record_parent_field_id is None:
            return
        field_id_str = str(sub_record_parent_field_id).strip()
        if not field_id_str:
            return
        try:
            field_uuid = UUID(field_id_str)
        except (ValueError, TypeError) as exc:
            raise ValueError("子记录父字段 ID 无效") from exc

        parent_field = cls.get_parent_field_by_id(table_id, field_uuid)
        if parent_field is None:
            raise ValueError(
                "子记录父字段必须是本表自引用单向 ManyOne 关联字段"
            )

    # ──────────────────────────────────────────────────────
    # 深度计算
    # ──────────────────────────────────────────────────────

    @classmethod
    def get_record_depth(
        cls, record_id: UUID, parent_field: TableField
    ) -> int:
        """
        计算记录在层级树中的深度 (根记录 depth=0)。
        沿父链向上遍历，带循环保护 (最多 MAX_DEPTH+2 次迭代)。
        """
        depth = 0
        current_id = record_id
        visited: Set[UUID] = set()
        max_iterations = MAX_SUB_RECORD_DEPTH + 2

        for _ in range(max_iterations):
            link = LinkRecord.objects.using(TABDATA_DB_ALIAS).filter(
                link_field=parent_field, self_record_id=current_id
            ).values_list('foreign_record_id', flat=True).first()

            if link is None:
                break
            if link in visited:
                logger.warning("检测到循环引用 record=%s", record_id)
                break

            visited.add(link)
            current_id = link
            depth += 1

        return depth

    @classmethod
    def get_ancestors(
        cls, record_id: UUID, parent_field: TableField
    ) -> List[UUID]:
        """
        获取记录的所有祖先 ID (从直接父记录到根)。
        """
        ancestors: List[UUID] = []
        current_id = record_id
        visited: Set[UUID] = set()
        max_iterations = MAX_SUB_RECORD_DEPTH + 2

        for _ in range(max_iterations):
            link = LinkRecord.objects.using(TABDATA_DB_ALIAS).filter(
                link_field=parent_field, self_record_id=current_id
            ).values_list('foreign_record_id', flat=True).first()

            if link is None:
                break
            if link in visited:
                break

            visited.add(link)
            ancestors.append(link)
            current_id = link

        return ancestors

    @classmethod
    def get_subtree_max_relative_depth(
        cls, record_id: UUID, parent_field: TableField
    ) -> int:
        """
        获取以 record_id 为根的子树最大相对深度。

        返回值含义：
        - 0：无子记录
        - 1：有一级子记录
        - 2：有二级子记录
        """
        max_depth = 0
        current_level: Set[UUID] = {record_id}
        visited: Set[UUID] = {record_id}

        # 最大深度固定 4 级，迭代上限加 2 用于循环保护。
        for depth in range(1, MAX_SUB_RECORD_DEPTH + 3):
            child_ids = set(
                LinkRecord.objects.using(TABDATA_DB_ALIAS).filter(
                    link_field=parent_field,
                    foreign_record_id__in=current_level,
                ).values_list('self_record_id', flat=True)
            )
            child_ids -= visited
            if not child_ids:
                break

            visited.update(child_ids)
            current_level = child_ids
            max_depth = depth

        return max_depth

    @classmethod
    def validate_parent_assignment(
        cls,
        *,
        record_id: UUID,
        new_parent_id: UUID,
        parent_field: TableField,
        subtree_relative_depth: Optional[int] = None,
    ) -> None:
        """校验把 record 挂到 new_parent 下是否违反环 / 深度不变量。

        Raises:
            ValueError: 自引用、环引用，或移动/创建后超过 ``MAX_SUB_RECORD_DEPTH``。
        """
        if str(new_parent_id) == str(record_id):
            raise ValueError("不能将记录设为自身的子记录")

        ancestors = {str(a) for a in cls.get_ancestors(new_parent_id, parent_field)}
        if str(record_id) in ancestors:
            raise ValueError("不能将记录移动到自己的子记录下")

        new_parent_depth = cls.get_record_depth(new_parent_id, parent_field)
        if subtree_relative_depth is None:
            subtree_relative_depth = cls.get_subtree_max_relative_depth(
                record_id, parent_field
            )

        if new_parent_depth + 1 + subtree_relative_depth > MAX_SUB_RECORD_DEPTH:
            raise ValueError(
                f"已达最大层级深度 ({MAX_SUB_RECORD_DEPTH} 级)，"
                f"无法继续添加子记录"
            )

    # ──────────────────────────────────────────────────────
    # 子记录创建
    # ──────────────────────────────────────────────────────

    @classmethod
    @transaction.atomic(using=TABDATA_DB_ALIAS)
    def create_sub_record(
        cls,
        table_id: UUID,
        parent_record_id: UUID,
        parent_field_id: Optional[UUID],
        data: Dict[str, Any],
        user,
        order_context: Optional[Dict[str, Any]] = None,
    ) -> Tuple[TableRecord, TableField]:
        """
        创建子记录。

        1. 确保父记录字段存在
        2. 验证父记录存在
        3. 验证深度限制
        4. 创建记录
        5. 设置父链接

        Returns:
            (新记录, 父字段)
        """
        from apps.tabdata.services.record_service import RecordService

        # 1. 解析父字段（优先使用指定字段）
        if parent_field_id is not None:
            parent_field = cls.get_parent_field_by_id(table_id, parent_field_id)
            if parent_field is None:
                raise ValueError("父记录字段无效，必须是本表自引用单向 ManyOne 字段")
        else:
            parent_field = cls.ensure_parent_field(table_id, user)

        # 2. 验证父记录
        try:
            parent_record = TableRecord.objects.using(TABDATA_DB_ALIAS).get(
                id=parent_record_id, table_id=table_id, is_deleted=False
            )
        except TableRecord.DoesNotExist:
            raise ValueError(f"父记录不存在: {parent_record_id}")

        # 3. 验证深度
        parent_depth = cls.get_record_depth(parent_record_id, parent_field)
        if parent_depth >= MAX_SUB_RECORD_DEPTH:
            raise ValueError(
                f"已达最大层级深度 ({MAX_SUB_RECORD_DEPTH} 级)，"
                f"无法继续添加子记录"
            )

        # 4. 如果没有指定 order_context，默认插入到父记录之后
        if order_context is None:
            order_context = {
                'position': 'after',
                'anchor_record_id': str(parent_record_id),
            }

        create_data = dict(data or {})
        create_data[str(parent_field.id)] = str(parent_record_id)

        # 5. 创建记录（B-3 / Wave 1.1：走标准路径，RH + ChangeLog + 其他订阅者
        # 自动接管，不再 skip_side_effects=True 制造 W0-2 audit §3.5 警告的
        # "ChangeLog 写但 RH 不写" Charter §3.1 最坏破口）。
        service = RecordService(user=user)
        result = service.create_record(
            table_id=table_id,
            data=create_data,
            order_context=order_context,
        )

        new_record, error_msg = result
        if error_msg:
            raise ValueError(error_msg)

        logger.info(
            "创建子记录 table=%s parent=%s child=%s depth=%d",
            table_id, parent_record_id, new_record.id, parent_depth + 1,
        )

        # 6. 之前在后台线程手动调用的所有副作用现已由 EventBus 订阅者自动接管：
        #    - WS 推送：RealtimeSubscriber（替代 _publish_table_event）
        #    - YDoc 同步：CollabYDocSubscriber（替代 sync_records_to_ydoc）
        #    - 调度器自动化：SchedulerSubscriber（替代 _trigger_scheduler_automations）
        #    - ChangeLog：ChangeLogSubscriber（替代 _write_change_log，已带
        #      agent_run_id / session_id 透传，B-1 后已对齐）
        #    - RecordHistory：RecordHistorySubscriber（之前的最大破口源头）
        #
        # 所有订阅者均在 record_service.create_record 内的 EventBus.publish(RecordCreated)
        # 上挂载；父字段 link cell 已在 CreateRecordHandler 事务内统一规范化，
        # 本入口不再进行 create 后补写，避免 LinkRecord / ORM / native / YDoc
        # 看到不同时间点的父子关系。

        return new_record, parent_field

    # ──────────────────────────────────────────────────────
    # 子记录移动 (改变父级)
    # ──────────────────────────────────────────────────────

    @classmethod
    @transaction.atomic(using=TABDATA_DB_ALIAS)
    def move_record(
        cls,
        table_id: UUID,
        record_id: UUID,
        new_parent_id: Optional[UUID],
        parent_field_id: Optional[UUID] = None,
        user=None,
    ) -> None:
        """
        移动记录到新的父记录下，或变为顶级记录。

        Args:
            table_id: 表格 ID
            record_id: 要移动的记录 ID
            new_parent_id: 新父记录 ID，None 表示变为顶级记录
            parent_field_id: 父字段 ID，None 则自动获取
        """
        from apps.tabdata.services.link_field_service import LinkFieldService

        if user is not None:
            from apps.tabdata.services import TableService

            permission_service = TableService(user=user)
            if not permission_service.check_table_permission(str(table_id), 'editor'):
                raise PermissionError("无权限修改该表格")

        if parent_field_id:
            parent_field = cls.get_parent_field_by_id(table_id, parent_field_id)
        else:
            parent_field = cls.get_parent_field(table_id)

        if parent_field is None:
            raise ValueError("未找到父记录字段")

        record = TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
            id=record_id, table_id=table_id, is_deleted=False
        ).first()
        if record is None:
            raise ValueError(f"记录不存在: {record_id}")

        if new_parent_id is not None:
            # 验证新父记录存在
            if not TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                id=new_parent_id, table_id=table_id, is_deleted=False
            ).exists():
                raise ValueError(f"目标父记录不存在: {new_parent_id}")

            # 防止循环: 新父不能是当前记录的后代
            ancestors = cls.get_ancestors(new_parent_id, parent_field)
            if record_id in ancestors or new_parent_id == record_id:
                raise ValueError("不能将记录移动到自己的子记录下")

            # 验证深度
            new_parent_depth = cls.get_record_depth(new_parent_id, parent_field)
            if new_parent_depth >= MAX_SUB_RECORD_DEPTH:
                raise ValueError(
                    f"已达最大层级深度 ({MAX_SUB_RECORD_DEPTH} 级)"
                )

            # 校验整棵子树移动后的最大深度，避免子树越界。
            subtree_depth = cls.get_subtree_max_relative_depth(
                record_id, parent_field
            )
            moved_root_depth = new_parent_depth + 1
            moved_subtree_max_depth = moved_root_depth + subtree_depth
            if moved_subtree_max_depth > MAX_SUB_RECORD_DEPTH:
                raise ValueError(
                    f"移动后将超过最大层级深度 ({MAX_SUB_RECORD_DEPTH} 级)"
                )

            LinkFieldService.set_link_cell(
                field=parent_field,
                record=record,
                new_linked_ids=[new_parent_id],
            )
        else:
            # 移除父链接 → 变为顶级记录
            LinkFieldService.set_link_cell(
                field=parent_field,
                record=record,
                new_linked_ids=[],
            )

        logger.info(
            "移动记录 table=%s record=%s new_parent=%s",
            table_id, record_id, new_parent_id,
        )

    # ──────────────────────────────────────────────────────
    # 树拖拽原子提交
    # ──────────────────────────────────────────────────────

    @classmethod
    @transaction.atomic(using=TABDATA_DB_ALIAS)
    def reorder_tree(
        cls,
        table_id: UUID,
        moved_root_record_id: UUID,
        new_parent_id: Optional[UUID],
        position: str = 'after',
        anchor_record_id: Optional[UUID] = None,
        parent_field_id: Optional[UUID] = None,
        move_with_descendants: bool = True,
        user=None,
    ) -> Dict[str, Any]:
        """
        树拖拽原子提交 — 单事务完成排序 + 层级变更。

        流程：
        1. 校验权限、循环引用、深度上限、子树越界
        2. 计算移动集合（根 + 后代 if move_with_descendants）
        3. 更新父链接（层级变更）
        4. 更新 order（排序变更）
        5. 统一写历史事件

        Returns:
            {'success': True, 'updated_record_ids': [...]}
        """
        from apps.tabdata.services.link_field_service import LinkFieldService
        from apps.tabdata.services.record_service import RecordService

        if user is not None:
            from apps.tabdata.services import TableService
            permission_service = TableService(user=user)
            if not permission_service.check_table_permission(str(table_id), 'editor'):
                raise PermissionError("无权限修改该表格")

        normalized_position = str(position or 'after').strip().lower()
        if normalized_position not in {'before', 'after', 'end'}:
            raise ValueError("position 仅支持 before/after/end")

        if normalized_position in {'before', 'after'} and not anchor_record_id:
            raise ValueError("before/after 模式下 anchor_record_id 不能为空")

        # 解析父字段
        if parent_field_id:
            parent_field = cls.get_parent_field_by_id(table_id, parent_field_id)
        else:
            parent_field = cls.get_parent_field(table_id)

        if parent_field is None:
            raise ValueError("未找到父记录字段")

        # 验证被拖拽记录存在
        moved_root = TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
            id=moved_root_record_id, table_id=table_id, is_deleted=False
        ).first()
        if moved_root is None:
            raise ValueError(f"记录不存在: {moved_root_record_id}")

        # ── 1. 层级变更校验 ──
        # 获取当前父记录
        current_parent_link = LinkRecord.objects.using(TABDATA_DB_ALIAS).filter(
            link_field=parent_field, self_record_id=moved_root_record_id
        ).values_list('foreign_record_id', flat=True).first()

        hierarchy_changed = (
            (new_parent_id is not None and current_parent_link != new_parent_id)
            or (new_parent_id is None and current_parent_link is not None)
        )

        if hierarchy_changed and new_parent_id is not None:
            # 验证新父记录存在
            if not TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                id=new_parent_id, table_id=table_id, is_deleted=False
            ).exists():
                raise ValueError(f"目标父记录不存在: {new_parent_id}")

            # 防止循环引用：新父不能是当前记录的后代
            ancestors = cls.get_ancestors(new_parent_id, parent_field)
            if moved_root_record_id in ancestors or new_parent_id == moved_root_record_id:
                raise ValueError("不能将记录移动到自己的子记录下")

            # 验证深度
            new_parent_depth = cls.get_record_depth(new_parent_id, parent_field)
            if new_parent_depth >= MAX_SUB_RECORD_DEPTH:
                raise ValueError(
                    f"已达最大层级深度 ({MAX_SUB_RECORD_DEPTH} 级)"
                )

            # 校验子树移动后总深度不越界
            subtree_depth = cls.get_subtree_max_relative_depth(
                moved_root_record_id, parent_field
            )
            moved_root_depth = new_parent_depth + 1
            if moved_root_depth + subtree_depth > MAX_SUB_RECORD_DEPTH:
                raise ValueError(
                    f"移动后将超过最大层级深度 ({MAX_SUB_RECORD_DEPTH} 级)"
                )

        # ── 2. 计算后代集合（用于返回值，不参与 reorder） ──
        descendant_ids: List[UUID] = []
        if move_with_descendants:
            descendant_ids = cls._get_all_descendants(moved_root_record_id, parent_field)

        # ── 3. 更新层级 ──
        if hierarchy_changed:
            if new_parent_id is not None:
                LinkFieldService.set_link_cell(
                    field=parent_field,
                    record=moved_root,
                    new_linked_ids=[new_parent_id],
                )
            else:
                LinkFieldService.set_link_cell(
                    field=parent_field,
                    record=moved_root,
                    new_linked_ids=[],
                )

        # ── 4. 更新排序（仅重排根节点，后代跟随 DFS 树序自动排列） ──
        # 注意：不能把后代也传给 reorder_records，因为 anchor 可能是后代之一，
        # 而且 DFS 树序会自动将后代放到根节点之后。
        record_service = RecordService(user=user)
        updated_records, reorder_errors = record_service.reorder_records(
            table_id=table_id,
            record_ids=[moved_root_record_id],
            anchor_record_id=anchor_record_id,
            position=normalized_position,
        )
        if reorder_errors:
            raise ValueError(
                f"排序更新失败: {'; '.join(reorder_errors)}"
            )

        all_affected_ids = [moved_root_record_id] + descendant_ids
        updated_ids = [str(rid) for rid in all_affected_ids]
        logger.info(
            "树拖拽原子提交 table=%s root=%s new_parent=%s updated=%d",
            table_id, moved_root_record_id, new_parent_id, len(updated_ids),
        )

        return {
            'success': True,
            'updated_record_ids': updated_ids,
        }

    @classmethod
    def _get_all_descendants(
        cls, record_id: UUID, parent_field: TableField
    ) -> List[UUID]:
        """
        获取记录的所有后代 ID (BFS)。
        """
        descendants: List[UUID] = []
        current_level: Set[UUID] = {record_id}
        visited: Set[UUID] = {record_id}

        for _ in range(MAX_SUB_RECORD_DEPTH + 2):
            child_ids = set(
                LinkRecord.objects.using(TABDATA_DB_ALIAS).filter(
                    link_field=parent_field,
                    foreign_record_id__in=current_level,
                ).values_list('self_record_id', flat=True)
            )
            child_ids -= visited
            if not child_ids:
                break
            visited.update(child_ids)
            descendants.extend(child_ids)
            current_level = child_ids

        return descendants

    # ──────────────────────────────────────────────────────
    # 树序排列
    # ──────────────────────────────────────────────────────

    @classmethod
    def build_tree_ordered_records(
        cls,
        record_ids: List[UUID],
        parent_field: TableField,
        table_id: UUID,
    ) -> List[Tuple[UUID, int]]:
        """
        将平坦的记录 ID 列表重新排列为 DFS 树序。

        Args:
            record_ids: 平坦的记录 ID 列表 (已按视图排序/筛选)
            parent_field: 父记录字段
            table_id: 表格 ID

        Returns:
            [(record_id, depth), ...] 按 DFS 树序排列
        """
        if not record_ids:
            return []

        record_id_set = set(record_ids)

        # 批量加载父子关系
        links = LinkRecord.objects.using(TABDATA_DB_ALIAS).filter(
            link_field=parent_field,
            self_record_id__in=record_id_set,
        ).values_list('self_record_id', 'foreign_record_id')

        parent_map: Dict[UUID, UUID] = {}  # child -> parent
        children_map: Dict[UUID, List[UUID]] = defaultdict(list)  # parent -> [children]

        for child_id, parent_id in links:
            # 只处理父记录也在当前列表中的情况
            if parent_id in record_id_set:
                parent_map[child_id] = parent_id
                children_map[parent_id].append(child_id)

        # 保持原始排序中的相对顺序
        id_order = {rid: idx for idx, rid in enumerate(record_ids)}
        for parent_id in children_map:
            children_map[parent_id].sort(key=lambda cid: id_order.get(cid, 0))

        # 找出根记录 (没有父记录或父记录不在列表中的)
        roots = [rid for rid in record_ids if rid not in parent_map]

        # DFS 遍历
        result: List[Tuple[UUID, int]] = []
        visited: Set[UUID] = set()

        def dfs(record_id: UUID, depth: int):
            if record_id in visited:
                return
            visited.add(record_id)
            result.append((record_id, depth))
            for child_id in children_map.get(record_id, []):
                if child_id not in visited:
                    dfs(child_id, depth + 1)

        for root_id in roots:
            dfs(root_id, 0)

        # 处理可能的孤立节点 (因循环引用等原因未被遍历到的)
        for rid in record_ids:
            if rid not in visited:
                result.append((rid, 0))

        return result

    @classmethod
    def build_tree_metadata(
        cls,
        tree_ordered: List[Tuple[UUID, int]],
        parent_field: TableField,
        table_id: UUID,
    ) -> Dict[str, Dict[str, Any]]:
        """
        构建树形元数据字典，供前端渲染使用。

        Returns:
            {
                "<record_id>": {
                    "depth": int,
                    "has_children": bool,
                    "parent_id": str | null
                }
            }
        """
        record_ids = [rid for rid, _ in tree_ordered]
        record_id_set = set(record_ids)

        # 加载父子关系
        links = LinkRecord.objects.using(TABDATA_DB_ALIAS).filter(
            link_field=parent_field,
            self_record_id__in=record_id_set,
        ).values_list('self_record_id', 'foreign_record_id')

        parent_map: Dict[UUID, UUID] = {}
        children_set: Set[UUID] = set()

        for child_id, parent_id in links:
            if parent_id in record_id_set:
                parent_map[child_id] = parent_id
                children_set.add(parent_id)

        metadata: Dict[str, Dict[str, Any]] = {}
        for record_id, depth in tree_ordered:
            metadata[str(record_id)] = {
                'depth': depth,
                'has_children': record_id in children_set,
                'parent_id': str(parent_map[record_id]) if record_id in parent_map else None,
            }

        return metadata

    # ──────────────────────────────────────────────────────
    # 筛选时保留祖先
    # ──────────────────────────────────────────────────────

    @classmethod
    def filter_with_ancestors(
        cls,
        matched_record_ids: Set[UUID],
        parent_field: TableField,
        table_id: UUID,
    ) -> Set[UUID]:
        """
        扩展筛选结果以包含所有祖先记录。

        当子记录匹配筛选条件时，其所有父记录也应显示。
        """
        if not matched_record_ids:
            return matched_record_ids

        expanded = set(matched_record_ids)
        frontier = set(matched_record_ids)

        for _ in range(MAX_SUB_RECORD_DEPTH + 2):
            links = LinkRecord.objects.using(TABDATA_DB_ALIAS).filter(
                link_field=parent_field,
                self_record_id__in=frontier,
            ).values_list('foreign_record_id', flat=True)
            parent_ids = {parent_id for parent_id in links if parent_id not in expanded}
            if not parent_ids:
                break
            expanded.update(parent_ids)
            frontier = parent_ids

        return expanded

    # ──────────────────────────────────────────────────────
    # 获取所有自引用单向 link 字段 (用于视图配置)
    # ──────────────────────────────────────────────────────

    @classmethod
    def get_self_link_fields(cls, table_id: UUID) -> List[TableField]:
        """
        获取表格中所有可用作父记录字段的自引用单向 link 字段。
        """
        fields = TableField.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=table_id,
            field_type='link',
            is_deleted=False,
        )
        result = []
        for field in fields:
            config = field.config or {}
            if (
                cls._is_self_many_one_field_config(config, table_id)
            ):
                result.append(field)
        return result

    # ──────────────────────────────────────────────────────
    # 子记录分组限制
    # ──────────────────────────────────────────────────────

    @classmethod
    def validate_grouping_policy(
        cls,
        table_id: UUID,
        groups: Optional[List[Dict[str, Any]]],
        sub_record_parent_field_id: Optional[str],
    ) -> None:
        """
        校验子记录模式下的分组规则。

        约束：子记录模式下暂不支持多级分组，仅允许按第一级父记录分组。
        """
        if not sub_record_parent_field_id or not groups:
            return

        parent_field_name: Optional[str] = None
        try:
            parent_field_uuid = UUID(str(sub_record_parent_field_id))
        except (ValueError, TypeError):
            parent_field_uuid = None
        if parent_field_uuid is not None:
            parent_field = cls.get_parent_field_by_id(table_id, parent_field_uuid)
            if parent_field is not None:
                parent_field_name = parent_field.name

        resolved_group_fields: List[str] = []
        for group in groups:
            if not isinstance(group, dict):
                continue
            field_ref = group.get('field_id') or group.get('field')
            if isinstance(field_ref, str):
                field_ref = field_ref.strip()
            if field_ref:
                resolved_group_fields.append(str(field_ref))

        if not resolved_group_fields:
            return

        if len(resolved_group_fields) > 1:
            raise ValueError("子记录模式下暂不支持多级分组，仅支持按第一级父记录分组")

        allowed_group_fields = {str(sub_record_parent_field_id)}
        if parent_field_name:
            allowed_group_fields.add(parent_field_name)

        if resolved_group_fields[0] not in allowed_group_fields:
            raise ValueError("子记录模式下仅支持按父记录字段分组")
