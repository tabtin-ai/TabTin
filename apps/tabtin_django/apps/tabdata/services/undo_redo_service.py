"""
撤销/重做服务

提供表格记录的撤销和重做功能：基于操作历史的双栈实现
"""
import logging
from typing import List, Optional, Dict, Any, Tuple
from uuid import UUID
from django.db import transaction
from django.conf import settings
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from django.db.models import Q
from django.contrib.auth import get_user_model

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.history_events import normalize_editor_type_for_response
from apps.tabdata.models import Table, TableField, TableRecord, RecordHistory, RecordHistoryItem, TableNamedVersion
from apps.tabdata.utils.record_data_access import read_data
from apps.tabdata.services.base import BaseService
from apps.tabdata.services.undo_redo_operation_service import UndoRedoOperationService
from apps.tabdata.services.undo_redo_stack_service import UndoRedoStackService

User = get_user_model()
logger = logging.getLogger(__name__)

# 栈为空的标准提示——API 层据此映射到 NO_UNDO/REDO_OPERATIONS 错误码，
# 与"执行失败"区分开，避免前端把"没得撤"误报成"撤销失败"。
NO_UNDO_OPERATIONS_MSG = "没有可撤销的操作"
NO_REDO_OPERATIONS_MSG = "没有可重做的操作"


class _HistoryReplayError(Exception):
    """单条 history 回放失败，用于触发当前记录 savepoint 回滚。"""


class UndoRedoService(BaseService):
    """
    撤销/重做服务

    核心功能：
    1. 记录级别的撤销/重做
    2. 表格级别的批量撤销/重做
    3. 操作组的整体撤销/重做（批量操作）
    4. 操作历史栈管理
    5. 支持多人协作场景（只撤销自己的操作）
    """

    MAX_UNDO_STACK_SIZE = 100  # 最大撤销栈深度

    def __init__(self, user=None, window_id: Optional[str] = None):
        super().__init__(user)
        self._record_service = None
        self.window_id = self._normalize_window_id(window_id)
        self.stack_service = UndoRedoStackService()
        self.operation_service = UndoRedoOperationService(user=self.user)

    @property
    def record_service(self):
        """延迟加载 RecordService 避免循环导入"""
        if self._record_service is None:
            from apps.tabdata.services.record_service import RecordService
            self._record_service = RecordService(user=self.user)
        return self._record_service

    # ============ 记录级别撤销/重做 ============

    def _normalize_window_id(self, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        normalized = str(value).strip()
        if not normalized:
            return None
        return normalized[:128]

    def _apply_window_scope(self, query):
        """
        应用窗口隔离：
        - 有 window_id：默认只看当前窗口；可按配置兼容旧数据（window_id 为空）
        - 无 window_id：保持历史兼容（不过滤）
        """
        if not self.window_id:
            return query
        include_null_window = bool(
            getattr(settings, "TABDATA_UNDO_INCLUDE_NULL_WINDOW_COMPAT", False)
        )
        if include_null_window:
            return query.filter(Q(window_id=self.window_id) | Q(window_id__isnull=True))
        return query.filter(window_id=self.window_id)

    def _allow_db_compat_fallback(self) -> bool:
        """
        是否允许在栈未命中时回退 DB 状态位（兼容开关）。
        """
        return bool(
            getattr(settings, "TABDATA_UNDO_DB_COMPAT_FALLBACK", True)
        )

    def _resolve_stack_user_id(self) -> Optional[str]:
        if not self.user or not getattr(self.user, "id", None):
            return None
        return str(self.user.id)

    def _use_stack(self) -> bool:
        return bool(self.stack_service.enabled and self._resolve_stack_user_id())

    def _load_history_from_operation(
        self,
        operation: Optional[Dict[str, Any]],
        *,
        table_id: UUID,
        only_my_operations: bool = False,
        require_undone: Optional[bool] = None,
    ) -> Optional[RecordHistory]:
        if not operation:
            return None

        raw_history_id = operation.get('history_id') or operation.get('id')
        if not raw_history_id:
            return None

        try:
            history_uuid = UUID(str(raw_history_id))
        except Exception:
            return None

        query = RecordHistory.objects.using(TABDATA_DB_ALIAS).select_related('record').filter(
            id=history_uuid,
            record__table_id=table_id,
        )

        if only_my_operations and self.user:
            if require_undone is True:
                query = query.filter(undone_by=self.user)
            else:
                query = query.filter(user=self.user)

        history = query.first()
        if not history:
            return None

        # 栈为事实来源：不再以 is_undone 作为硬过滤条件，避免状态位漂移导致回放失败。
        if require_undone is True and not history.is_undone:
            logger.info(
                "[UndoRedo] 栈/DB 状态不一致（期望 undone=True）history_id=%s",
                history.id,
            )
        elif require_undone is False and history.is_undone:
            logger.info(
                "[UndoRedo] 栈/DB 状态不一致（期望 undone=False）history_id=%s",
                history.id,
            )

        return history

    def _find_stack_history_for_record(
        self,
        *,
        table_id: UUID,
        record_id: UUID,
        operation_type: str,
        only_my_operations: bool,
        require_undone: Optional[bool],
    ) -> Optional[RecordHistory]:
        """
        记录级撤销/重做专用：
        只读扫描栈（不 pop），找到目标 record 的候选 history。
        """
        if not self._use_stack():
            return None

        user_id = self._resolve_stack_user_id()
        if not user_id:
            return None

        table_key = str(table_id)
        record_key = str(record_id)
        scan_limit = max(1, min(self.stack_service.max_stack_size, 500))
        if operation_type == 'redo':
            stack_operations, _ = self.stack_service.get_redo_stack(
                user_id=user_id,
                table_id=table_key,
                window_id=self.window_id,
                limit=scan_limit,
            )
        else:
            stack_operations, _ = self.stack_service.get_undo_stack(
                user_id=user_id,
                table_id=table_key,
                window_id=self.window_id,
                limit=scan_limit,
            )

        for operation in stack_operations:
            if str(operation.get('record_id') or '') != record_key:
                continue
            history = self._load_history_from_operation(
                operation,
                table_id=table_id,
                only_my_operations=only_my_operations,
                require_undone=require_undone,
            )
            if history and str(history.record_id) == record_key:
                return history
        return None

    def _load_structured_operation_from_stack(
        self,
        operation: Optional[Dict[str, Any]],
        *,
        table_id: UUID,
        only_my_operations: bool = False,
        require_undone: Optional[bool] = None,
    ) -> Optional[Dict[str, Any]]:
        if not self.operation_service.is_structured_operation(operation):
            return None

        op_table_id = (
            operation.get('table_id')
            or (operation.get('params') or {}).get('table_id')
        )
        if str(op_table_id or '') != str(table_id):
            return None

        if only_my_operations and self.user:
            op_user_id = str((operation.get('user') or {}).get('id') or '')
            if not op_user_id or op_user_id != str(self.user.id):
                return None

        op_is_undone = bool(operation.get('is_undone'))
        if require_undone is True and not op_is_undone:
            return None
        if require_undone is False and op_is_undone:
            return None

        return operation

    def _collect_group_histories(
        self,
        *,
        table_id: UUID,
        seed_history: RecordHistory,
        only_my_operations: bool,
        target_undone_state: bool,
    ) -> List[RecordHistory]:
        if seed_history.operation_group_id:
            query = RecordHistory.objects.using(TABDATA_DB_ALIAS).filter(
                record__table_id=table_id,
                operation_group_id=seed_history.operation_group_id,
            ).select_for_update().order_by('-created_at')
            query = self._apply_window_scope(query)
            if only_my_operations and self.user:
                query = query.filter(user=self.user)
            histories = list(query)
            matched = [item for item in histories if item.is_undone == target_undone_state]
            if matched:
                return matched
            # 状态位漂移时，至少保证当前 seed 可回放，避免整组丢失。
            return [seed_history]
        return [seed_history]

    def _build_stack_operation_from_history(
        self,
        history: RecordHistory,
        *,
        is_undone: bool,
    ) -> Dict[str, Any]:
        undone_by = None
        if is_undone and self.user:
            undone_by = {
                'id': self.user.id,
                'name': self.user.get_display_name() if hasattr(self.user, "get_display_name") else str(self.user),
            }
        undone_at = timezone.now().isoformat() if is_undone else None
        return self.stack_service.build_operation_from_history(
            history,
            is_undone=is_undone,
            undone_at=undone_at,
            undone_by=undone_by,
        )

    def _sync_stack_after_undo(self, table_id: UUID, histories: List[RecordHistory]) -> None:
        if not histories or not self._use_stack():
            return
        user_id = self._resolve_stack_user_id()
        if not user_id:
            return
        table_key = str(table_id)
        history_ids = {str(history.id) for history in histories}
        self.stack_service.remove_history_ids_from_undo(
            user_id=user_id,
            table_id=table_key,
            window_id=self.window_id,
            history_ids=history_ids,
        )
        redo_operations = [
            self._build_stack_operation_from_history(history, is_undone=True)
            for history in histories
        ]
        self.stack_service.push_redo_operations(
            user_id=user_id,
            table_id=table_key,
            window_id=self.window_id,
            operations=redo_operations,
        )

    def _sync_stack_after_redo(self, table_id: UUID, histories: List[RecordHistory]) -> None:
        if not histories or not self._use_stack():
            return
        user_id = self._resolve_stack_user_id()
        if not user_id:
            return
        table_key = str(table_id)
        history_ids = {str(history.id) for history in histories}
        self.stack_service.remove_history_ids_from_redo(
            user_id=user_id,
            table_id=table_key,
            window_id=self.window_id,
            history_ids=history_ids,
        )
        undo_operations = [
            self._build_stack_operation_from_history(history, is_undone=False)
            for history in histories
        ]
        self.stack_service.push_undo_operations(
            user_id=user_id,
            table_id=table_key,
            window_id=self.window_id,
            operations=undo_operations,
            clear_redo=False,
        )

    def _stack_window_candidates(self) -> List[Optional[str]]:
        """撤销/重做要扫描的 window 候选，按优先级返回。

        当前窗口优先；带 window_id 时追加全局（``window_id=None`` → ``__global__``）
        作为回退。这样早期在 window 尚未就绪时（前端 ``getWindowId()`` 返回空）落到
        全局栈的结构操作，仍能被后来带上 window 的 Ctrl+Z 撤销找到。

        只回退到"无窗口归属"的全局栈，**绝不**跨到别的具体窗口，保持多窗口隔离。
        """
        if self.window_id is None:
            return [None]
        return [self.window_id, None]

    def _pop_stack_entry(
        self,
        *,
        table_id: UUID,
        operation_type: str,
        only_my_operations: bool,
        require_undone: Optional[bool],
    ) -> Tuple[Optional[RecordHistory], Optional[Dict[str, Any]], Optional[str]]:
        """
        从栈中取出一个可用项（RecordHistory 或结构化 operation）。

        ：只读扫描 + 精确移除命中项。过滤（only_my_operations /
        require_undone）未命中的条目原位保留，禁止 pop 即弃。

        :returns: ``(history, structured_operation, effective_window)``；
            ``effective_window`` 是实际命中的 window（可能是当前窗口，也可能是回退
            的全局 ``None``），调用方据此把 next/回退 操作推回**同一个** window 栈。
        """
        if not self._use_stack():
            return None, None, None

        user_id = self._resolve_stack_user_id()
        if not user_id:
            return None, None, None

        table_key = str(table_id)
        scan_limit = max(1, min(self.stack_service.max_stack_size, 500))
        get_stack_fn = (
            self.stack_service.get_undo_stack
            if operation_type == 'undo'
            else self.stack_service.get_redo_stack
        )
        remove_fn = (
            self.stack_service.remove_operation_from_undo
            if operation_type == 'undo'
            else self.stack_service.remove_operation_from_redo
        )

        for effective_window in self._stack_window_candidates():
            stack_operations, _ = get_stack_fn(
                user_id=user_id,
                table_id=table_key,
                window_id=effective_window,
                limit=scan_limit,
            )
            # get_*_stack 返回「最近优先」（栈顶在前）
            for operation in stack_operations:
                structured_operation = self._load_structured_operation_from_stack(
                    operation,
                    table_id=table_id,
                    only_my_operations=only_my_operations,
                    require_undone=require_undone,
                )
                if structured_operation:
                    removed = remove_fn(
                        user_id=user_id,
                        table_id=table_key,
                        window_id=effective_window,
                        operation=operation,
                    )
                    if not removed:
                        logger.warning(
                            "[UndoRedo] 精确移除结构化栈项失败 type=%s table=%s",
                            operation_type,
                            table_key,
                        )
                    return None, structured_operation, effective_window

                history = self._load_history_from_operation(
                    operation,
                    table_id=table_id,
                    only_my_operations=only_my_operations,
                    require_undone=require_undone,
                )
                if history:
                    removed = remove_fn(
                        user_id=user_id,
                        table_id=table_key,
                        window_id=effective_window,
                        operation=operation,
                    )
                    if not removed:
                        logger.warning(
                            "[UndoRedo] 精确移除历史栈项失败 type=%s history=%s",
                            operation_type,
                            history.id,
                        )
                    return history, None, effective_window
                # 未命中：跳过，保留在栈中，继续扫描下一条
        return None, None, None

    def _restore_popped_operation(
        self,
        *,
        table_id: UUID,
        operation: Dict[str, Any],
        direction: str,
        window_id: Optional[str],
    ) -> None:
        """把 ``_pop_stack_entry`` 弹出、但执行失败的结构化 operation 推回原栈。

        栈用 Redis list，pop 取栈顶、push 追加到栈顶，回栈后 LIFO 顺序不变，
        下次 undo/redo 仍会先命中它，用户可在修复前置条件（如删除冲突同名字段）
        后重试，避免操作永久丢失。

        ``window_id`` 必须是 :meth:`_pop_stack_entry` 返回的实际命中窗口（可能是
        全局回退的 ``None``），否则回栈会落到错误的 window 栈。
        """
        if not self._use_stack():
            return
        user_id = self._resolve_stack_user_id()
        if not user_id:
            return
        table_key = str(table_id)
        if direction == 'undo':
            self.stack_service.push_undo_operations(
                user_id=user_id,
                table_id=table_key,
                window_id=window_id,
                operations=[operation],
                clear_redo=False,
            )
        else:
            self.stack_service.push_redo_operations(
                user_id=user_id,
                table_id=table_key,
                window_id=window_id,
                operations=[operation],
            )

    @transaction.atomic(using=TABDATA_DB_ALIAS)
    def undo_record_operation(
        self,
        record_id: UUID,
        only_my_operations: bool = False
    ) -> Tuple[bool, Optional[str], Optional[RecordHistory]]:
        """
        撤销记录的最后一次操作

        Args:
            record_id: 记录ID
            only_my_operations: 是否只撤销当前用户的操作

        Returns:
            tuple: (是否成功, 错误消息, 撤销的历史记录)
        """
        try:
            # 获取记录
            record = TableRecord.objects.using(TABDATA_DB_ALIAS).select_for_update().get(id=record_id)

            # 检查权限
            if not self.check_table_permission(str(record.table_id), 'editor'):
                return False, "没有权限执行撤销操作", None

            last_history = self._find_stack_history_for_record(
                table_id=record.table_id,
                record_id=record.id,
                operation_type='undo',
                only_my_operations=only_my_operations,
                require_undone=False,
            )
            # 栈关闭或兼容开关开启时，允许回退 DB 旧逻辑
            if last_history is None and (not self._use_stack() or self._allow_db_compat_fallback()):
                query = RecordHistory.objects.using(TABDATA_DB_ALIAS).filter(
                    record=record,
                    is_undone=False
                )
                if only_my_operations and self.user:
                    query = query.filter(user=self.user)
                query = self._apply_window_scope(query)
                last_history = query.order_by('-created_at').first()

            if not last_history:
                return False, "没有可撤销的操作", None

            # 根据操作类型执行撤销
            success, error = self._execute_undo(record, last_history)

            if not success:
                return False, error, None

            # 标记为已撤销
            last_history.is_undone = True
            last_history.undone_at = timezone.now()
            last_history.undone_by = self.user
            last_history.save()
            self._sync_stack_after_undo(record.table_id, [last_history])

            logger.info(
                "[UndoRedo] 撤销成功: record_id=%s, action=%s, user=%s",
                record_id, last_history.action,
                self.user.get_display_name() if self.user else 'System',
            )

            return True, None, last_history

        except TableRecord.DoesNotExist:
            return False, "记录不存在", None
        except Exception as e:
            logger.error("[UndoRedo] 撤销失败: %s", e, exc_info=True)
            return False, f"撤销失败: {str(e)}", None

    @transaction.atomic(using=TABDATA_DB_ALIAS)
    def redo_record_operation(
        self,
        record_id: UUID,
        only_my_operations: bool = False
    ) -> Tuple[bool, Optional[str], Optional[RecordHistory]]:
        """
        重做记录的最后一次撤销操作

        Args:
            record_id: 记录ID
            only_my_operations: 是否只重做当前用户的操作

        Returns:
            tuple: (是否成功, 错误消息, 重做的历史记录)
        """
        try:
            # 获取记录
            record = TableRecord.objects.using(TABDATA_DB_ALIAS).select_for_update().get(id=record_id)

            # 检查权限
            if not self.check_table_permission(str(record.table_id), 'editor'):
                return False, "没有权限执行重做操作", None

            last_undone = self._find_stack_history_for_record(
                table_id=record.table_id,
                record_id=record.id,
                operation_type='redo',
                only_my_operations=only_my_operations,
                require_undone=True,
            )
            # 栈关闭或兼容开关开启时，允许回退 DB 旧逻辑
            if last_undone is None and (not self._use_stack() or self._allow_db_compat_fallback()):
                query = RecordHistory.objects.using(TABDATA_DB_ALIAS).filter(
                    record=record,
                    is_undone=True
                )
                if only_my_operations and self.user:
                    query = query.filter(undone_by=self.user)
                query = self._apply_window_scope(query)
                last_undone = query.order_by('-undone_at').first()

            if not last_undone:
                return False, "没有可重做的操作", None

            # 根据操作类型执行重做
            success, error = self._execute_redo(record, last_undone)

            if not success:
                return False, error, None

            # 取消撤销标记
            last_undone.is_undone = False
            last_undone.undone_at = None
            last_undone.undone_by = None
            last_undone.save()
            self._sync_stack_after_redo(record.table_id, [last_undone])

            logger.info(
                "[UndoRedo] 重做成功: record_id=%s, action=%s, user=%s",
                record_id, last_undone.action,
                self.user.get_display_name() if self.user else 'System',
            )

            return True, None, last_undone

        except TableRecord.DoesNotExist:
            return False, "记录不存在", None
        except Exception as e:
            logger.error("[UndoRedo] 重做失败: %s", e, exc_info=True)
            return False, f"重做失败: {str(e)}", None

    # ============ 表格级别撤销/重做 ============

    @transaction.atomic(using=TABDATA_DB_ALIAS)
    def undo_table_operation(
        self,
        table_id: UUID,
        only_my_operations: bool = False
    ) -> Tuple[bool, Optional[str], List[Any]]:
        """
        撤销表格的最后一次操作（可能涉及多条记录）

        Args:
            table_id: 表格ID
            only_my_operations: 是否只撤销当前用户的操作

        Returns:
            tuple: (是否成功, 错误消息, 撤销的历史记录列表)

        Raises:
            FieldRestoreNotSupportedError: C1 / Wave 1.3 复杂字段类型 undo 时抛出，
                由 :func:`apps.tabdata.api_undo_redo.undo_table_operation` 转 409。
        """
        # C1 / Wave 1.3：在最外层捕获 FieldRestoreNotSupportedError 并上抛——
        # 不能进 try/except 通用兜底，否则会被转成 "撤销失败: <message>" 的 500。
        from apps.tabdata.exceptions import FieldRestoreNotSupportedError

        try:
            # 检查权限
            if not self.check_table_permission(str(table_id), 'editor'):
                return False, "没有权限执行撤销操作", []

            latest_history, latest_operation, effective_window = self._pop_stack_entry(
                table_id=table_id,
                operation_type='undo',
                only_my_operations=only_my_operations,
                require_undone=False,
            )

            if latest_operation:
                success, error, next_operation = self.operation_service.execute(
                    operation=latest_operation,
                    direction='undo',
                )
                if not success:
                    # 根因 #2：pop 出来的结构化操作执行失败时必须推回 undo 栈，
                    # 否则操作永久丢失，用户既无法重试、再按 Ctrl+Z 又会报"没有可
                    # 撤销的操作"。回栈保持 LIFO（push_undo_operations extend 到栈顶，
                    # 与 pop 对称），clear_redo=False 不动 redo 栈。回到实际命中的 window。
                    self._restore_popped_operation(
                        table_id=table_id,
                        operation=latest_operation,
                        direction='undo',
                        window_id=effective_window,
                    )
                    return False, error or "撤销失败", []
                if next_operation and self._use_stack():
                    user_id = self._resolve_stack_user_id()
                    if user_id:
                        # next 操作推回**命中的** window（可能是全局回退），保证
                        # 后续 redo 能在同一栈找到它。
                        self.stack_service.push_redo_operations(
                            user_id=user_id,
                            table_id=str(table_id),
                            window_id=effective_window,
                            operations=[next_operation],
                        )
                return True, None, [next_operation] if next_operation else []

            # 栈关闭或兼容开关开启时，允许回退 DB 旧逻辑
            if latest_history is None and (not self._use_stack() or self._allow_db_compat_fallback()):
                query = RecordHistory.objects.using(TABDATA_DB_ALIAS).filter(
                    record__table_id=table_id,
                    is_undone=False
                )
                if only_my_operations and self.user:
                    query = query.filter(user=self.user)
                query = self._apply_window_scope(query)
                latest_history = query.order_by('-created_at').first()

            if not latest_history:
                return False, NO_UNDO_OPERATIONS_MSG, []

            histories_to_undo = self._collect_group_histories(
                table_id=table_id,
                seed_history=latest_history,
                only_my_operations=only_my_operations,
                target_undone_state=False,
            )

            # 批量执行撤销：每条记录独立 savepoint，避免单条 native DB
            # 约束错误污染整批外层事务。
            undone_histories = []
            first_error = None
            for history in histories_to_undo:
                try:
                    with transaction.atomic(using=TABDATA_DB_ALIAS, savepoint=True):
                        record = TableRecord.objects.using(TABDATA_DB_ALIAS).select_for_update().get(id=history.record_id)
                        success, error = self._execute_undo(
                            record,
                            history,
                            strict_native_sync=True,
                        )

                        if not success:
                            raise _HistoryReplayError(error or "撤销失败")

                        history.is_undone = True
                        history.undone_at = timezone.now()
                        history.undone_by = self.user
                        history.save()
                except FieldRestoreNotSupportedError:
                    raise
                except Exception as exc:
                    error_text = str(exc) or exc.__class__.__name__
                    if first_error is None:
                        first_error = error_text
                    logger.warning(
                        "[UndoRedo] 单条撤销失败: history_id=%s record_id=%s error=%s",
                        history.id, history.record_id, error_text,
                        exc_info=True,
                    )
                    continue
                else:
                    undone_histories.append(history)

            if not undone_histories:
                return False, f"撤销失败: {first_error}" if first_error else "撤销失败", []

            self._sync_stack_after_undo(table_id, undone_histories)

            logger.info(
                "[UndoRedo] 表格批量撤销成功: table_id=%s, count=%d, user=%s",
                table_id, len(undone_histories),
                self.user.get_display_name() if self.user else 'System',
            )

            return True, None, undone_histories

        except FieldRestoreNotSupportedError:
            # C1 / Wave 1.3：复杂字段 undo 必须由 API 层转 409 + 文案，不能吞成 500
            raise
        except Exception as e:
            logger.error("[UndoRedo] 表格撤销失败: %s", e, exc_info=True)
            return False, f"撤销失败: {str(e)}", []

    @transaction.atomic(using=TABDATA_DB_ALIAS)
    def redo_table_operation(
        self,
        table_id: UUID,
        only_my_operations: bool = False
    ) -> Tuple[bool, Optional[str], List[Any]]:
        """
        重做表格的最后一次撤销操作

        Args:
            table_id: 表格ID
            only_my_operations: 是否只重做当前用户的操作

        Returns:
            tuple: (是否成功, 错误消息, 重做的历史记录列表)
        """
        try:
            # 检查权限
            if not self.check_table_permission(str(table_id), 'editor'):
                return False, "没有权限执行重做操作", []

            latest_undone, latest_operation, effective_window = self._pop_stack_entry(
                table_id=table_id,
                operation_type='redo',
                only_my_operations=only_my_operations,
                require_undone=True,
            )

            if latest_operation:
                success, error, next_operation = self.operation_service.execute(
                    operation=latest_operation,
                    direction='redo',
                )
                if not success:
                    # 根因 #2（redo 对称）：执行失败把 operation 推回 redo 栈，
                    # 保证可重试、不丢操作。回到实际命中的 window。
                    self._restore_popped_operation(
                        table_id=table_id,
                        operation=latest_operation,
                        direction='redo',
                        window_id=effective_window,
                    )
                    return False, error or "重做失败", []
                if next_operation and self._use_stack():
                    user_id = self._resolve_stack_user_id()
                    if user_id:
                        self.stack_service.push_undo_operations(
                            user_id=user_id,
                            table_id=str(table_id),
                            window_id=effective_window,
                            operations=[next_operation],
                            clear_redo=False,
                        )
                return True, None, [next_operation] if next_operation else []

            # 栈关闭或兼容开关开启时，允许回退 DB 旧逻辑
            if latest_undone is None and (not self._use_stack() or self._allow_db_compat_fallback()):
                query = RecordHistory.objects.using(TABDATA_DB_ALIAS).filter(
                    record__table_id=table_id,
                    is_undone=True
                )
                if only_my_operations and self.user:
                    query = query.filter(undone_by=self.user)
                query = self._apply_window_scope(query)
                latest_undone = query.order_by('-undone_at').first()

            if not latest_undone:
                return False, NO_REDO_OPERATIONS_MSG, []

            histories_to_redo = self._collect_group_histories(
                table_id=table_id,
                seed_history=latest_undone,
                only_my_operations=only_my_operations,
                target_undone_state=True,
            )

            # 批量执行重做：每条记录独立 savepoint，避免单条 native DB
            # 约束错误污染整批外层事务。
            redone_histories = []
            first_error = None
            for history in histories_to_redo:
                try:
                    with transaction.atomic(using=TABDATA_DB_ALIAS, savepoint=True):
                        record = TableRecord.objects.using(TABDATA_DB_ALIAS).select_for_update().get(id=history.record_id)
                        success, error = self._execute_redo(
                            record,
                            history,
                            strict_native_sync=True,
                        )

                        if not success:
                            raise _HistoryReplayError(error or "重做失败")

                        history.is_undone = False
                        history.undone_at = None
                        history.undone_by = None
                        history.save()
                except Exception as exc:
                    error_text = str(exc) or exc.__class__.__name__
                    if first_error is None:
                        first_error = error_text
                    logger.warning(
                        "[UndoRedo] 单条重做失败: history_id=%s record_id=%s error=%s",
                        history.id, history.record_id, error_text,
                        exc_info=True,
                    )
                    continue
                else:
                    redone_histories.append(history)

            if not redone_histories:
                return False, f"重做失败: {first_error}" if first_error else "重做失败", []

            self._sync_stack_after_redo(table_id, redone_histories)

            logger.info(
                "[UndoRedo] 表格批量重做成功: table_id=%s, count=%d, user=%s",
                table_id, len(redone_histories),
                self.user.get_display_name() if self.user else 'System',
            )

            return True, None, redone_histories

        except Exception as e:
            logger.error("[UndoRedo] 表格重做失败: %s", e, exc_info=True)
            return False, f"重做失败: {str(e)}", []

    # ============ 操作栈查询 ============

    def get_undo_stack_page(
        self,
        table_id: UUID,
        only_my_operations: bool = False,
        limit: int = 20,
    ) -> Tuple[List[Dict[str, Any]], int]:
        """
        获取可撤销操作分页（含 total）。
        """
        try:
            if not self.check_table_permission(str(table_id), 'viewer'):
                return [], 0

            safe_limit = max(1, min(int(limit or 20), 100))

            if self._use_stack():
                user_id = self._resolve_stack_user_id()
                stack_ops, total = self.stack_service.get_undo_stack(
                    user_id=user_id,
                    table_id=str(table_id),
                    window_id=self.window_id,
                    limit=safe_limit,
                )
                # 当前窗口栈为空时回退全局栈（早期 window 未就绪落到 __global__ 的
                # 结构操作），让撤销按钮/预览如实反映可撤项。
                if total == 0 and self.window_id is not None:
                    g_ops, g_total = self.stack_service.get_undo_stack(
                        user_id=user_id,
                        table_id=str(table_id),
                        window_id=None,
                        limit=safe_limit,
                    )
                    if g_total > 0:
                        stack_ops, total = g_ops, g_total
                # 栈优先：默认不回退 DB 状态位，避免 undo 语义再次耦合到 is_undone。
                if total > 0 or not self._allow_db_compat_fallback():
                    return stack_ops, total

            query = RecordHistory.objects.using(TABDATA_DB_ALIAS).filter(
                record__table_id=table_id,
                is_undone=False,
            )
            if only_my_operations and self.user:
                query = query.filter(user=self.user)
            query = self._apply_window_scope(query)

            total = query.count()
            histories = query.order_by('-created_at')[:safe_limit]
            return self._format_history_stack(histories), total
        except Exception as e:
            logger.error("[UndoRedo] 获取撤销栈失败: %s", e, exc_info=True)
            return [], 0

    def get_undo_stack(
        self,
        table_id: UUID,
        only_my_operations: bool = False,
        limit: int = 20
    ) -> List[Dict[str, Any]]:
        operations, _total = self.get_undo_stack_page(
            table_id=table_id,
            only_my_operations=only_my_operations,
            limit=limit,
        )
        return operations

    def get_redo_stack_page(
        self,
        table_id: UUID,
        only_my_operations: bool = False,
        limit: int = 20,
    ) -> Tuple[List[Dict[str, Any]], int]:
        """
        获取可重做操作分页（含 total）。
        """
        try:
            if not self.check_table_permission(str(table_id), 'viewer'):
                return [], 0

            safe_limit = max(1, min(int(limit or 20), 100))

            if self._use_stack():
                user_id = self._resolve_stack_user_id()
                stack_ops, total = self.stack_service.get_redo_stack(
                    user_id=user_id,
                    table_id=str(table_id),
                    window_id=self.window_id,
                    limit=safe_limit,
                )
                # 当前窗口 redo 栈为空时回退全局栈，与 undo 对称。
                if total == 0 and self.window_id is not None:
                    g_ops, g_total = self.stack_service.get_redo_stack(
                        user_id=user_id,
                        table_id=str(table_id),
                        window_id=None,
                        limit=safe_limit,
                    )
                    if g_total > 0:
                        stack_ops, total = g_ops, g_total
                # 栈优先：默认不回退 DB 状态位，避免 redo 语义再次耦合到 is_undone。
                if total > 0 or not self._allow_db_compat_fallback():
                    return stack_ops, total

            query = RecordHistory.objects.using(TABDATA_DB_ALIAS).filter(
                record__table_id=table_id,
                is_undone=True,
            )
            if only_my_operations and self.user:
                query = query.filter(undone_by=self.user)
            query = self._apply_window_scope(query)

            total = query.count()
            histories = query.order_by('-undone_at')[:safe_limit]
            return self._format_history_stack(histories), total
        except Exception as e:
            logger.error("[UndoRedo] 获取重做栈失败: %s", e, exc_info=True)
            return [], 0

    def get_redo_stack(
        self,
        table_id: UUID,
        only_my_operations: bool = False,
        limit: int = 20
    ) -> List[Dict[str, Any]]:
        operations, _total = self.get_redo_stack_page(
            table_id=table_id,
            only_my_operations=only_my_operations,
            limit=limit,
        )
        return operations

    def _normalize_datetime_param(self, value: Optional[str]):
        """解析时间参数并标准化为时区感知 datetime。"""
        if not value:
            return None
        dt = parse_datetime(str(value))
        if not dt:
            return None
        if timezone.is_naive(dt):
            return timezone.make_aware(dt, timezone.get_current_timezone())
        return dt

    def _apply_history_date_range(
        self,
        query,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
    ):
        """按时间范围过滤历史记录。"""
        parsed_start = self._normalize_datetime_param(start_date)
        parsed_end = self._normalize_datetime_param(end_date)

        if parsed_start:
            query = query.filter(created_at__gte=parsed_start)
        if parsed_end:
            query = query.filter(created_at__lte=parsed_end)
        return query

    def _apply_history_cursor(
        self,
        query,
        cursor: Optional[str],
    ):
        """应用游标分页（按 created_at desc, id desc）。"""
        if not cursor:
            return query

        try:
            cursor_id = UUID(str(cursor))
        except Exception:
            logger.warning("[UndoRedo] 非法历史游标: %s", cursor)
            return query.none()

        cursor_item = query.filter(id=cursor_id).only('id', 'created_at').first()
        if not cursor_item:
            return query.none()

        return query.filter(
            Q(created_at__lt=cursor_item.created_at) |
            Q(created_at=cursor_item.created_at, id__lt=cursor_item.id)
        )

    def get_record_history_page(
        self,
        record_id: UUID,
        include_undone: bool = True,
        limit: int = 50,
        cursor: Optional[str] = None,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
    ) -> Tuple[List[Dict[str, Any]], int, Optional[str]]:
        """
        分页获取记录历史（cursor + 时间过滤）
        """
        try:
            record = TableRecord.objects.using(TABDATA_DB_ALIAS).get(id=record_id)

            # 检查权限
            if not self.check_table_permission(str(record.table_id), 'viewer'):
                return [], 0, None

            # 注意：user / undone_by 外键指向 MySQL 用户表，不能用 select_related 跨库 JOIN
            base_query = RecordHistory.objects.using(TABDATA_DB_ALIAS).filter(record=record)

            if not include_undone:
                base_query = base_query.filter(is_undone=False)

            base_query = self._apply_history_date_range(
                base_query,
                start_date=start_date,
                end_date=end_date,
            )

            total = base_query.count()
            page_query = self._apply_history_cursor(base_query, cursor)
            histories = list(page_query.order_by('-created_at', '-id')[:limit + 1])

            has_more = len(histories) > limit
            if has_more:
                histories = histories[:limit]

            next_cursor = str(histories[-1].id) if has_more and histories else None

            return self._format_history_list(histories), total, next_cursor

        except TableRecord.DoesNotExist:
            return [], 0, None
        except Exception as e:
            logger.error("[UndoRedo] 分页获取记录历史失败: %s", e, exc_info=True)
            return [], 0, None

    def get_record_history(
        self,
        record_id: UUID,
        include_undone: bool = True,
        limit: int = 50,
        cursor: Optional[str] = None,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """
        获取记录的完整历史（包括已撤销的）

        Args:
            record_id: 记录ID
            include_undone: 是否包含已撤销的操作
            limit: 返回数量限制

        Returns:
            历史记录列表
        """
        history_list, _total, _next_cursor = self.get_record_history_page(
            record_id=record_id,
            include_undone=include_undone,
            limit=limit,
            cursor=cursor,
            start_date=start_date,
            end_date=end_date,
        )
        return history_list

    def get_table_history_page(
        self,
        table_id: UUID,
        include_undone: bool = True,
        only_my_operations: bool = False,
        limit: int = 50,
        cursor: Optional[str] = None,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
    ) -> Tuple[List[Dict[str, Any]], int, Optional[str]]:
        """
        分页获取表格范围历史（cursor + 时间过滤）
        """
        try:
            # 检查权限
            if not self.check_table_permission(str(table_id), 'viewer'):
                return [], 0, None

            # 注意：user / undone_by 外键指向 MySQL 用户表，不能用 select_related 跨库 JOIN
            base_query = RecordHistory.objects.using(TABDATA_DB_ALIAS).filter(record__table_id=table_id)

            if not include_undone:
                base_query = base_query.filter(is_undone=False)

            if only_my_operations and self.user:
                base_query = base_query.filter(user=self.user)

            base_query = self._apply_history_date_range(
                base_query,
                start_date=start_date,
                end_date=end_date,
            )

            histories = list(base_query.order_by('-created_at', '-id'))
            operations = self._format_history_list(histories)
            field_operations = self._build_field_change_history_operations(
                table_id,
                start_date=start_date,
                end_date=end_date,
                only_my_operations=only_my_operations,
            )
            operations = self._collapse_restore_history_operations(operations, field_operations)
            operations.sort(
                key=lambda item: (
                    item.get('created_at') or '',
                    item.get('id') or '',
                ),
                reverse=True,
            )

            total = len(operations)
            if cursor:
                cursor_index = next(
                    (idx for idx, item in enumerate(operations) if item.get('id') == cursor),
                    None,
                )
                if cursor_index is not None:
                    operations = operations[cursor_index + 1:]

            page_operations = operations[:limit + 1]
            has_more = len(page_operations) > limit
            if has_more:
                page_operations = page_operations[:limit]

            next_cursor = str(page_operations[-1]['id']) if has_more and page_operations else None

            return page_operations, total, next_cursor

        except Exception as e:
            logger.error("[UndoRedo] 分页获取表格历史失败: %s", e, exc_info=True)
            return [], 0, None

    @staticmethod
    def _collapse_restore_history_operations(
        record_operations: List[Dict[str, Any]],
        field_operations: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        """把同一次版本还原的内部明细折叠成一个历史事件。

        RecordHistory(action=restore) 是快照重建所需的逐记录投影；ChangeLog(change_type=restore)
        是用户可感知的整表事件。两者通过现有 operation_group_id 关联，不新增协议字段。
        """
        restore_summaries = {
            str(op.get('operation_group_id')): op
            for op in field_operations
            if op.get('action') == 'restore' and op.get('operation_group_id')
        }
        if not restore_summaries:
            return [*record_operations, *field_operations]

        collapsed: List[Dict[str, Any]] = []
        emitted_restore_groups: set[str] = set()
        for op in [*record_operations, *field_operations]:
            group_id = str(op.get('operation_group_id') or '')
            if group_id in restore_summaries:
                if group_id in emitted_restore_groups:
                    continue
                emitted_restore_groups.add(group_id)
                # 保留 ChangeLog id 作为快照锚点：reconstruct_table_at_history 可用 restore
                # ChangeLog 的 created_at 重建“还原后”的表状态。
                collapsed.append(restore_summaries[group_id])
                continue
            collapsed.append(op)
        return collapsed

    @staticmethod
    def _restore_target_history_id(changes: Dict[str, Any]) -> str:
        """从既有 restore metadata 中提取目标版本/历史 id。"""
        return str(
            changes.get('history_id')
            or changes.get('restored_from')
            or changes.get('restored_from_history')
            or ''
        )

    def _build_field_change_history_operations(
        self,
        table_id: UUID,
        *,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        only_my_operations: bool = False,
    ) -> List[Dict[str, Any]]:
        """把字段结构 ChangeLog 合并进表格版本历史。"""
        try:
            from apps.collab.models import ChangeLog

            query = ChangeLog.objects.using('postgresql').filter(
                resource_type='table',
                resource_id=table_id,
                change_type__in=[
                    'create_field',
                    'batch_create_fields',
                    'update_field',
                    'delete_field',
                    'convert_field_type',
                    'reorder_fields',
                    'restore',
                ],
            )
            if start_date:
                parsed_start = parse_datetime(start_date)
                if parsed_start:
                    query = query.filter(created_at__gte=parsed_start)
            if end_date:
                parsed_end = parse_datetime(end_date)
                if parsed_end:
                    query = query.filter(created_at__lte=parsed_end)
            if only_my_operations and self.user:
                query = query.filter(editor_id=str(self.user.id))

            operations: List[Dict[str, Any]] = []
            for change_log in query.order_by('-created_at', '-id'):
                if change_log.change_type == 'restore':
                    changes = change_log.changes or {}
                    target_history_id = self._restore_target_history_id(changes)
                    operation_group_id = str(changes.get('operation_group_id') or change_log.id)
                    restore_label = (
                        f"还原到版本 {target_history_id[:8]}"
                        if target_history_id
                        else '还原到历史版本'
                    )
                    editor_name = change_log.editor_name or ''
                    if not editor_name and self.user and str(self.user.id) == str(change_log.editor_id):
                        editor_name = self.user.get_display_name()
                    operations.append({
                        'id': str(change_log.id),
                        'record_id': str(table_id),
                        'action': 'restore',
                        'action_display': restore_label,
                        'field_changes': {
                            'restore': {
                                'old': None,
                                'new': {
                                    'name': restore_label,
                                    'field_type': 'restore',
                                },
                            },
                        },
                        'items': [{
                            'field_key': 'restore',
                            'field_name': '版本还原',
                            'before': None,
                            'after': {
                                'name': restore_label,
                                'field_type': 'restore',
                            },
                        }],
                        'user': {
                            'id': change_log.editor_id or None,
                            'name': editor_name or 'System',
                        },
                        'created_at': change_log.created_at.isoformat(),
                        'is_undone': False,
                        'undone_at': None,
                        'operation_group_id': operation_group_id,
                        'editor_type': normalize_editor_type_for_response(
                            change_log.editor_type or 'user'
                        ),
                        'agent_run_id': change_log.agent_run_id or None,
                    })
                    continue

                fields = (change_log.changes or {}).get('fields') or []
                if not isinstance(fields, list) or not fields:
                    continue

                action, action_display = self._field_change_action_display(change_log.change_type)
                items = []
                field_changes: Dict[str, Any] = {}
                for field in fields:
                    if not isinstance(field, dict):
                        continue
                    field_id = str(field.get('id') or '')
                    if not field_id:
                        continue
                    field_name = self._normalize_field_history_name(field.get('name') or field_id)
                    field_type = str(field.get('field_type') or field.get('to_type') or 'text')
                    payload = {
                        'name': field_name,
                        'field_type': field_type,
                    }
                    if change_log.change_type in {'create_field', 'batch_create_fields'}:
                        before, after = None, payload
                    elif change_log.change_type == 'delete_field':
                        before, after = payload, None
                    else:
                        before, after = None, payload

                    field_key = f'field:{field_id}'
                    field_changes[field_key] = {'old': before, 'new': after}
                    items.append({
                        'field_key': field_key,
                        'field_name': field_name,
                        'before': before,
                        'after': after,
                    })

                if not items:
                    continue

                editor_name = change_log.editor_name or ''
                if not editor_name and self.user and str(self.user.id) == str(change_log.editor_id):
                    editor_name = self.user.get_display_name()

                operations.append({
                    'id': str(change_log.id),
                    'record_id': str(table_id),
                    'action': action,
                    'action_display': action_display,
                    'field_changes': field_changes,
                    'items': items,
                    'user': {
                        'id': change_log.editor_id or None,
                        'name': editor_name or 'System',
                    },
                    'created_at': change_log.created_at.isoformat(),
                    'is_undone': False,
                    'undone_at': None,
                    'operation_group_id': str(change_log.id),
                    'editor_type': normalize_editor_type_for_response(
                        change_log.editor_type or 'user'
                    ),
                    'agent_run_id': change_log.agent_run_id or None,
                })

            return operations
        except Exception as exc:
            logger.warning(
                "[UndoRedo] 字段结构历史合并失败 table=%s err=%s",
                table_id,
                exc,
                exc_info=True,
            )
            return []

    @staticmethod
    def _field_change_action_display(change_type: str) -> Tuple[str, str]:
        if change_type in {'create_field', 'batch_create_fields'}:
            return 'create', '新增字段'
        if change_type == 'delete_field':
            return 'delete', '删除字段'
        return 'update', '更新字段'

    @staticmethod
    def _normalize_field_history_name(name: Any) -> str:
        text = str(name or '').strip()
        if len(text) >= 2 and text[0] == text[-1] and text[0] in {'"', "'"}:
            return text[1:-1]
        return text

    def get_table_history(
        self,
        table_id: UUID,
        include_undone: bool = True,
        only_my_operations: bool = False,
        limit: int = 50,
        cursor: Optional[str] = None,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """
        获取表格范围内的完整历史（跨记录）

        Args:
            table_id: 表格ID
            include_undone: 是否包含已撤销的操作
            only_my_operations: 是否仅返回当前用户操作
            limit: 返回数量限制

        Returns:
            历史记录列表
        """
        history_list, _total, _next_cursor = self.get_table_history_page(
            table_id=table_id,
            include_undone=include_undone,
            only_my_operations=only_my_operations,
            limit=limit,
            cursor=cursor,
            start_date=start_date,
            end_date=end_date,
        )
        return history_list

    # ============ 私有辅助方法 ============

    def _resolve_replay_target(
        self,
        record: TableRecord,
        history: RecordHistory,
        direction: str,
    ) -> Tuple[Dict[str, Any], bool, float]:
        """从 history 的 field_changes 推导 undo/redo 目标状态。"""
        cur_data = dict(read_data(record))
        old_is_deleted = bool(record.is_deleted)
        old_order = float(record.order) if record.order is not None else 0.0

        if direction == "undo":
            val_key = "old"
        else:
            val_key = "new"

        # action → is_deleted 目标
        if history.action == "create":
            next_is_deleted = (direction == "undo")
        elif history.action == "delete":
            next_is_deleted = (direction == "redo")
        else:
            next_is_deleted = old_is_deleted

        # 数据字段回放
        next_data = dict(cur_data)
        for field_id, change in (history.field_changes or {}).items():
            if field_id.startswith("_"):
                continue
            # 兼容旧版 create 格式 {"data": {field: value, ...}}
            if field_id == "data" and isinstance(change, dict) and "old" not in change and "new" not in change:
                if direction == "undo":
                    for fk in change:
                        next_data[str(fk)] = None
                else:
                    for fk, fv in change.items():
                        next_data[str(fk)] = fv
                continue
            next_data[field_id] = change.get(val_key) if isinstance(change, dict) else change

        # 排序回放
        order_change = (history.field_changes or {}).get("_order")
        if order_change and order_change.get(val_key) is not None:
            next_order = float(order_change[val_key])
        else:
            next_order = old_order

        return next_data, next_is_deleted, next_order

    def _execute_undo(
        self,
        record: TableRecord,
        history: RecordHistory,
        *,
        strict_native_sync: bool = False,
    ) -> Tuple[bool, Optional[str]]:
        """通过 replay helper 执行撤销。"""
        try:
            from apps.tabdata.services.record_replay_helper import (
                UNDO_DB_HISTORY_SOURCE,
                replay_record_state,
            )
            from apps.tabdata.services.record_service import RecordService

            next_data, next_is_deleted, next_order = self._resolve_replay_target(
                record, history, "undo",
            )
            svc = RecordService(user=self.user)
            result = replay_record_state(
                svc,
                record=record,
                next_data=next_data,
                next_is_deleted=next_is_deleted,
                next_order=next_order,
                emit_history=False,
                source=UNDO_DB_HISTORY_SOURCE if strict_native_sync else "undo",
                user=self.user,
            )
            return True, None

        except Exception as e:
            transaction.set_rollback(True, using=TABDATA_DB_ALIAS)
            logger.error("[UndoRedo] 执行撤销失败: %s", e, exc_info=True)
            return False, str(e)

    def _execute_redo(
        self,
        record: TableRecord,
        history: RecordHistory,
        *,
        strict_native_sync: bool = False,
    ) -> Tuple[bool, Optional[str]]:
        """通过 replay helper 执行重做。"""
        try:
            from apps.tabdata.services.record_replay_helper import (
                REDO_DB_HISTORY_SOURCE,
                replay_record_state,
            )
            from apps.tabdata.services.record_service import RecordService

            next_data, next_is_deleted, next_order = self._resolve_replay_target(
                record, history, "redo",
            )
            svc = RecordService(user=self.user)
            result = replay_record_state(
                svc,
                record=record,
                next_data=next_data,
                next_is_deleted=next_is_deleted,
                next_order=next_order,
                emit_history=False,
                source=REDO_DB_HISTORY_SOURCE if strict_native_sync else "redo",
                user=self.user,
            )
            return True, None

        except Exception as e:
            transaction.set_rollback(True, using=TABDATA_DB_ALIAS)
            logger.error("[UndoRedo] 执行重做失败: %s", e, exc_info=True)
            return False, str(e)

    def _format_history_stack(self, histories) -> List[Dict[str, Any]]:
        """格式化历史栈数据"""
        histories = list(histories)
        history_items_map = self._build_history_items_map(histories)

        result = []
        for history in histories:
            result.append({
                'id': str(history.id),
                'record_id': str(history.record_id),
                'action': history.action,
                'action_display': history.get_action_display(),
                'field_changes': history.field_changes,
                'items': history_items_map.get(str(history.id), []),
                'user': {
                    'id': history.user.id if history.user else None,
                    'name': history.user.get_display_name() if history.user else 'System'
                } if history.user else None,
                'created_at': history.created_at.isoformat(),
                'is_undone': history.is_undone,
                'undone_at': history.undone_at.isoformat() if history.undone_at else None,
                'operation_group_id': str(history.operation_group_id) if history.operation_group_id else None,
                'editor_type': normalize_editor_type_for_response(
                    getattr(history, "editor_type", None) or "user"
                ),
            })
        return result

    @staticmethod
    def _batch_load_users(user_ids) -> Dict[int, Any]:
        """
        从 MySQL 用户表批量加载用户数据。

        user / undone_by 是跨库 FK（PostgreSQL → MySQL），不能用 select_related，
        因此这里单独查 MySQL 并缓存到 dict 以避免 N+1。
        """
        valid_ids = [uid for uid in user_ids if uid is not None]
        if not valid_ids:
            return {}
        try:
            users = User.objects.filter(id__in=valid_ids)
            return {u.id: u for u in users}
        except Exception as exc:
            logger.warning("[UndoRedo] 批量加载用户失败: %s", exc)
            return {}

    def _format_history_list(self, histories) -> List[Dict[str, Any]]:
        """格式化完整历史列表（用户数据通过批量查询从 MySQL 获取）"""
        histories = list(histories)
        history_items_map = self._build_history_items_map(histories)

        # 收集所有 user_id / undone_by_id，从 MySQL 批量获取
        all_user_ids = set()
        for history in histories:
            if history.user_id:
                all_user_ids.add(history.user_id)
            if history.is_undone and getattr(history, 'undone_by_id', None):
                all_user_ids.add(history.undone_by_id)
        user_map = self._batch_load_users(all_user_ids)

        def _user_payload(user_id):
            if not user_id:
                return None
            u = user_map.get(user_id)
            if u:
                return {
                    'id': u.id,
                    'name': u.get_display_name() if hasattr(u, 'get_display_name') else str(u),
                }
            # 用户不在 MySQL 中（已删除等），返回 fallback
            return {'id': user_id, 'name': f'User#{user_id}'}

        result = []
        for history in histories:
            item = {
                'id': str(history.id),
                'record_id': str(history.record_id),
                'action': history.action,
                'action_display': history.get_action_display(),
                'field_changes': history.field_changes,
                'items': history_items_map.get(str(history.id), []),
                'user': _user_payload(history.user_id),
                'created_at': history.created_at.isoformat(),
                'is_undone': history.is_undone,
                'editor_type': normalize_editor_type_for_response(
                    getattr(history, "editor_type", None) or "user"
                ),
            }

            if history.is_undone:
                item['undone_at'] = history.undone_at.isoformat() if history.undone_at else None
                item['undone_by'] = _user_payload(getattr(history, 'undone_by_id', None))

            if history.operation_group_id:
                item['operation_group_id'] = str(history.operation_group_id)

            result.append(item)
        return result

    def _build_history_items_map(
        self,
        histories: List[RecordHistory],
    ) -> Dict[str, List[Dict[str, Any]]]:
        """
        批量加载字段级历史明细，避免列表渲染时出现 N+1 查询。
        """
        if not histories:
            return {}

        history_ids = [history.id for history in histories if getattr(history, 'id', None)]
        if not history_ids:
            return {}

        history_record_ids = [history.record_id for history in histories if getattr(history, 'record_id', None)]
        table_ids = set()
        if history_record_ids:
            for row in TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                id__in=history_record_ids,
            ).values('table_id'):
                table_ids.add(row['table_id'])

        items_map: Dict[str, List[Dict[str, Any]]] = {}
        rows = list(RecordHistoryItem.objects.using(TABDATA_DB_ALIAS).filter(
            history_id__in=history_ids
        ).order_by('created_at', 'id').values(
            'history_id',
            'field_key',
            'before',
            'after',
        ))
        field_keys = {str(row['field_key']) for row in rows if row.get('field_key') and not str(row['field_key']).startswith('_')}
        field_name_map: Dict[str, str] = {}
        if field_keys:
            candidate_ids = set()
            for key in field_keys:
                lookup_key = key.removeprefix('field:')
                try:
                    candidate_ids.add(str(UUID(lookup_key)))
                except Exception:
                    continue

            if candidate_ids:
                fields_query = TableField.objects.using(TABDATA_DB_ALIAS).filter(id__in=candidate_ids)
                if table_ids:
                    fields_query = fields_query.filter(table_id__in=table_ids)
                fields = fields_query.values('id', 'name')
                for field in fields:
                    field_id = str(field['id'])
                    field_name = str(field['name'])
                    field_name_map[field_id] = field_name
                    field_name_map[field_id.replace('-', '')] = field_name
                    field_name_map[f'field:{field_id}'] = field_name
                    field_name_map[f'field:{field_id.replace("-", "")}'] = field_name

        for row in rows:
            history_id = str(row['history_id'])
            field_key = str(row['field_key'])
            before = row.get('before')
            after = row.get('after')
            embedded_field_name = None
            for value in (before, after):
                if isinstance(value, dict) and isinstance(value.get('name'), str):
                    embedded_field_name = str(value['name'])
                    break
            items_map.setdefault(history_id, []).append(
                {
                    'field_key': field_key,
                    'field_name': field_name_map.get(field_key) or embedded_field_name,
                    'before': before,
                    'after': after,
                }
            )

        return items_map

    @staticmethod
    def _safe_float(value: Any, default: float = 0.0) -> float:
        try:
            return float(value)
        except (TypeError, ValueError):
            return float(default)

    def _build_table_snapshot_entry(self, record: TableRecord) -> Dict[str, Any]:
        record_id = str(record.id)
        return {
            "record_id": record_id,
            "row_id": record_id,
            "order": self._safe_float(getattr(record, "order", 0.0), 0.0),
            "is_deleted": bool(getattr(record, "is_deleted", False)),
            "data": dict(read_data(record)),
        }

    @staticmethod
    def _add_field_alias(
        field_key_map: Dict[str, Tuple[str, int]],
        field_aliases_by_id: Dict[str, set[str]],
        *,
        alias: str,
        field_id: str,
        priority: int,
    ) -> None:
        if not alias:
            return
        field_aliases_by_id.setdefault(field_id, set()).add(alias)
        existing = field_key_map.get(alias)
        if existing is None or priority < existing[1]:
            field_key_map[alias] = (field_id, priority)

    def _build_field_alias_maps(
        self,
        table_id: UUID,
        *,
        active_only: bool,
    ) -> Tuple[Dict[str, Tuple[str, int]], Dict[str, set[str]]]:
        field_key_map: Dict[str, Tuple[str, int]] = {}
        field_aliases_by_id: Dict[str, set[str]] = {}
        field_query = (
            TableField.objects.using(TABDATA_DB_ALIAS)
            .filter(table_id=table_id)
            .only('id', 'name', 'api_name')
        )
        if active_only:
            field_query = field_query.filter(is_deleted=False)
        fields = list(field_query)

        # 明确 alias 优先级，避免字段名/api_name 与 UUID 字符串撞名时误映射。
        for field in fields:
            field_id = str(field.id)
            self._add_field_alias(
                field_key_map,
                field_aliases_by_id,
                alias=field_id,
                field_id=field_id,
                priority=0,
            )
        for field in fields:
            self._add_field_alias(
                field_key_map,
                field_aliases_by_id,
                alias=field.id.hex,
                field_id=str(field.id),
                priority=1,
            )
        for field in fields:
            self._add_field_alias(
                field_key_map,
                field_aliases_by_id,
                alias=str(getattr(field, 'api_name', '') or ''),
                field_id=str(field.id),
                priority=2,
            )
        for field in fields:
            self._add_field_alias(
                field_key_map,
                field_aliases_by_id,
                alias=str(getattr(field, 'name', '') or ''),
                field_id=str(field.id),
                priority=3,
            )
        return field_key_map, field_aliases_by_id

    @staticmethod
    def _prune_snapshot_rows_to_active_fields(
        snapshot_rows: List[Dict[str, Any]],
        active_field_key_map: Dict[str, Tuple[str, int]],
    ) -> List[Dict[str, Any]]:
        """把快照字段 key 归一为字段 ID，并移除目标版本不存在的字段数据。

        历史数据可能以字段 ID、hex ID、字段名或 api_name 为 key；restore 写 native
        列时只认字段 ID，因此这里不能只“保留”字段名 key，必须统一成 ID。
        """
        pruned_rows: List[Dict[str, Any]] = []
        for row in snapshot_rows:
            next_row = dict(row)
            row_data = row.get("data")
            if isinstance(row_data, dict):
                normalized_data: Dict[str, Any] = {}
                normalized_priorities: Dict[str, int] = {}
                for key, value in row_data.items():
                    key_str = str(key)
                    if key_str.startswith("_meta:"):
                        normalized_data[key_str] = value
                        continue
                    field_info = active_field_key_map.get(key_str)
                    if not field_info:
                        continue
                    field_id, priority = field_info
                    existing_priority = normalized_priorities.get(field_id)
                    if existing_priority is None or priority < existing_priority:
                        normalized_data[field_id] = value
                        normalized_priorities[field_id] = priority
                next_row["data"] = normalized_data
            else:
                next_row["data"] = {}
            pruned_rows.append(next_row)
        return pruned_rows

    def reconstruct_table_at_history(
        self,
        table_id: UUID,
        history_id: UUID,
        include_target_deleted_records: bool = False,
    ) -> Optional[List[Dict[str, Any]]]:
        """
        重建表格在指定历史时间点的完整快照。

        默认仅返回该时间点未删除记录；历史预览可通过
        include_target_deleted_records 返回该时间点所有已存在记录（含当时
        已删除记录），用于在 UI 上标记删除行。还原逻辑保持默认行为，
        避免把已删除行恢复回来。
        """
        try:
            if not self.check_table_permission(str(table_id), 'viewer'):
                return None

            target_history = RecordHistory.objects.using(TABDATA_DB_ALIAS).filter(
                id=history_id,
                record__table_id=table_id,
            ).only('id', 'record_id', 'action', 'field_changes', 'created_at', 'operation_group_id').first()
            target_created_at = target_history.created_at if target_history else None
            if not target_history:
                try:
                    from apps.collab.models import ChangeLog

                    change_log = ChangeLog.objects.using('postgresql').filter(
                        id=history_id,
                        resource_type='table',
                        resource_id=table_id,
                        change_type__in=[
                            'create_field',
                            'batch_create_fields',
                            'update_field',
                            'delete_field',
                            'convert_field_type',
                            'reorder_fields',
                            'restore',
                        ],
                    ).only('id', 'created_at').first()
                    target_created_at = change_log.created_at if change_log else None
                except Exception:
                    target_created_at = None

            if target_created_at is None:
                logger.warning(
                    "[UndoRedo] reconstruct_table_at_history: 历史不存在或不属于表格 table=%s history=%s",
                    table_id,
                    history_id,
                )
                return None

            try:
                field_key_map, field_aliases_by_id = self._build_field_alias_maps(
                    table_id,
                    active_only=False,
                )
            except Exception as exc:
                logger.warning(
                    "[UndoRedo] build field alias map failed during reconstruct table=%s err=%s",
                    table_id,
                    exc,
                )
                field_key_map, field_aliases_by_id = {}, {}

            record_states: Dict[str, Dict[str, Any]] = {}
            current_records = TableRecord.objects.using(TABDATA_DB_ALIAS).filter(table_id=table_id).only(
                'id', 'data', 'order', 'is_deleted'
            )
            for record in current_records:
                record_states[str(record.id)] = self._build_table_snapshot_entry(record)
                record_states[str(record.id)]["exists_at_target"] = True

            later_histories = RecordHistory.objects.using(TABDATA_DB_ALIAS).filter(
                record__table_id=table_id,
                created_at__gt=target_created_at,
            ).only(
                'id', 'record_id', 'action', 'field_changes', 'created_at'
            ).order_by('-created_at', '-id')

            for history in later_histories:
                record_id = str(history.record_id)
                state = record_states.get(record_id)
                if state is None:
                    state = {
                        "record_id": record_id,
                        "row_id": record_id,
                        "order": 0.0,
                        "is_deleted": True,
                        "data": {},
                        "exists_at_target": True,
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
                    state["exists_at_target"] = False
                elif action == 'delete':
                    state["is_deleted"] = False
                    state["exists_at_target"] = True

                canonical_old_values: Dict[str, Tuple[Any, int]] = {}
                unknown_old_values: Dict[str, Any] = {}

                for field_key, change in field_changes.items():
                    if not isinstance(change, dict):
                        continue

                    key = str(field_key)

                    # 兼容旧版 create 格式 {"data": {field: value, ...}}
                    if key == "data" and "old" not in change and "new" not in change:
                        continue

                    old_value = change.get('old')

                    if key == '_deleted':
                        state["is_deleted"] = bool(old_value)
                        state["exists_at_target"] = True
                        continue

                    if key == '_order':
                        state["order"] = self._safe_float(old_value, state.get("order", 0.0))
                        continue

                    if key.startswith('_'):
                        continue

                    field_info = field_key_map.get(key)
                    if field_info:
                        canonical_key, priority = field_info
                        existing = canonical_old_values.get(canonical_key)
                        if (
                            existing is None
                            or (existing[0] is None and old_value is not None)
                            or (
                                existing[0] is not None
                                and old_value is not None
                                and priority < existing[1]
                            )
                        ):
                            canonical_old_values[canonical_key] = (old_value, priority)
                    else:
                        unknown_old_values[key] = old_value

                if canonical_old_values or unknown_old_values:
                    state_data = state.get("data")
                    if not isinstance(state_data, dict):
                        state_data = {}
                        state["data"] = state_data
                    for canonical_key, (old_value, _) in canonical_old_values.items():
                        for alias in field_aliases_by_id.get(canonical_key, {canonical_key}):
                            state_data.pop(alias, None)
                        state_data[canonical_key] = old_value
                    for key, old_value in unknown_old_values.items():
                        state_data[key] = old_value

            # 默认还原路径排除已删行；历史预览可带上当时已存在的删除行。
            snapshot_rows = [
                {
                    "record_id": item["record_id"],
                    "row_id": item.get("row_id") or item["record_id"],
                    "order": self._safe_float(item.get("order"), 0.0),
                    "is_deleted": bool(item.get("is_deleted", False)),
                    "data": item.get("data") if isinstance(item.get("data"), dict) else {},
                }
                for item in record_states.values()
                if (
                    bool(item.get("exists_at_target", True))
                    and (
                        include_target_deleted_records
                        or not bool(item.get("is_deleted", False))
                    )
                )
            ]
            snapshot_rows.sort(
                key=lambda item: (
                    self._safe_float(item.get("order"), 0.0),
                    str(item.get("record_id") or ''),
                )
            )
            return snapshot_rows

        except Exception as exc:
            logger.error("[UndoRedo] reconstruct_table_at_history 失败: %s", exc, exc_info=True)
            return None

    _MAX_SCHEMA_ANCHOR_DEPTH = 32
    _SCHEMA_ANCHOR_CYCLE = object()
    _STRUCTURE_CHANGE_TYPES = (
        'create_field',
        'batch_create_fields',
        'delete_field',
    )

    @staticmethod
    def _extract_structure_log_field_ids(changes: Any) -> List[str]:
        """从结构 ChangeLog.changes.fields 提取字段 ID。"""
        raw_fields = (changes or {}).get('fields') if isinstance(changes, dict) else None
        if not isinstance(raw_fields, list):
            return []
        field_ids: List[str] = []
        for raw in raw_fields:
            if not isinstance(raw, dict):
                continue
            raw_id = str(raw.get('id') or '').strip()
            if not raw_id:
                continue
            try:
                field_ids.append(str(UUID(raw_id)))
            except Exception:
                continue
        return field_ids

    def _resolve_effective_schema_anchor(
        self,
        table_id: UUID,
        history_id: UUID,
        *,
        _seen: Optional[set] = None,
        _depth: int = 0,
    ) -> Optional[Dict[str, Any]]:
        """解析字段结构对齐的有效时间锚点。

        - RecordHistory / 普通结构 ChangeLog：用自身 created_at
        - restore ChangeLog：递归跟随 changes.history_id，避免按还原动作墙钟算 schema
        """
        if _depth > self._MAX_SCHEMA_ANCHOR_DEPTH:
            logger.warning(
                "[UndoRedo] schema anchor depth exceeded table=%s history=%s",
                table_id,
                history_id,
            )
            return None

        seen = _seen if _seen is not None else set()
        history_key = str(history_id)
        if history_key in seen:
            logger.warning(
                "[UndoRedo] schema anchor cycle detected table=%s history=%s",
                table_id,
                history_id,
            )
            return self._SCHEMA_ANCHOR_CYCLE
        seen.add(history_key)

        target_history = RecordHistory.objects.using(TABDATA_DB_ALIAS).filter(
            id=history_id,
            record__table_id=table_id,
        ).only('id', 'created_at').first()
        if target_history is not None:
            return {
                'anchor_id': target_history.id,
                'created_at': target_history.created_at,
                'change_log': None,
            }

        from apps.collab.models import ChangeLog

        change_log = ChangeLog.objects.using('postgresql').filter(
            id=history_id,
            resource_type='table',
            resource_id=table_id,
            change_type__in=[
                *self._STRUCTURE_CHANGE_TYPES,
                'update_field',
                'convert_field_type',
                'reorder_fields',
                'restore',
            ],
        ).only('id', 'created_at', 'change_type', 'changes').first()
        if change_log is None:
            return None

        if change_log.change_type == 'restore':
            target_raw = self._restore_target_history_id(change_log.changes or {})
            if target_raw:
                try:
                    nested_id = UUID(str(target_raw))
                except Exception:
                    nested_id = None
                if nested_id is not None and str(nested_id) != history_key:
                    if str(nested_id) in seen:
                        logger.warning(
                            "[UndoRedo] schema anchor cycle detected table=%s history=%s target=%s",
                            table_id,
                            history_id,
                            nested_id,
                        )
                        return self._SCHEMA_ANCHOR_CYCLE
                    nested = self._resolve_effective_schema_anchor(
                        table_id,
                        nested_id,
                        _seen=seen,
                        _depth=_depth + 1,
                    )
                    if nested is self._SCHEMA_ANCHOR_CYCLE:
                        return self._SCHEMA_ANCHOR_CYCLE
                    if nested is not None:
                        return nested
                    # 嵌套目标已不存在：回退 restore 墙钟，避免整段 schema 被静默跳过。
                    logger.warning(
                        "[UndoRedo] restore schema target missing, fallback to restore wall-clock "
                        "table=%s history=%s target=%s",
                        table_id,
                        history_id,
                        nested_id,
                    )

        return {
            'anchor_id': change_log.id,
            'created_at': change_log.created_at,
            'change_log': change_log,
        }

    def _compute_expected_field_ids_at(
        self,
        table_id: UUID,
        anchor_created_at,
        *,
        all_fields: List[Any],
    ) -> Tuple[Optional[set], Optional[str]]:
        """按 create/delete ChangeLog 正向回放，计算目标时刻应存在的字段 ID 集合。"""
        from apps.collab.models import ChangeLog

        structure_logs = list(
            ChangeLog.objects.using('postgresql').filter(
                resource_type='table',
                resource_id=table_id,
                change_type__in=list(self._STRUCTURE_CHANGE_TYPES),
            ).only('id', 'created_at', 'change_type', 'changes').order_by('created_at', 'id')
        )

        created_in_logs: set = set()
        for change_log in structure_logs:
            if change_log.change_type not in ('create_field', 'batch_create_fields'):
                continue
            field_ids = self._extract_structure_log_field_ids(change_log.changes)
            if field_ids:
                created_in_logs.update(field_ids)

        expected: set = set()
        for field in all_fields:
            field_id = str(field.id)
            if field_id in created_in_logs:
                continue
            field_created_at = getattr(field, 'created_at', None)
            if field_created_at is None or field_created_at <= anchor_created_at:
                expected.add(field_id)

        for change_log in structure_logs:
            if change_log.created_at > anchor_created_at:
                continue
            field_ids = self._extract_structure_log_field_ids(change_log.changes)
            if not field_ids:
                # 仅目标时刻及之前的坏日志才阻断；晚于锚点的脏数据不影响本次还原。
                return None, "字段结构历史缺少字段快照，无法还原到该版本"
            if change_log.change_type in ('create_field', 'batch_create_fields'):
                expected.update(field_ids)
            elif change_log.change_type == 'delete_field':
                expected.difference_update(field_ids)

        return expected, None

    def _apply_field_structure_at_history(
        self,
        table_id: UUID,
        history_id: UUID,
    ) -> Dict[str, Any]:
        """把字段结构双向对齐到目标历史时刻应存在的集合。

        记录快照 replay 只能还原行数据；字段新增/删除来自 ChangeLog。
        对齐规则：
        - 目标应存在但当前软删 → restore_fields（幂等重建 native 列 / 插回视图）
        - 目标不应存在但当前活跃 → 仅软删并移出视图，不再即时 DROP
        - restore 节点递归解析到真实目标后再算 schema
        """
        empty = {
            "changed_fields": 0,
            "field_restore_error": None,
            "revived_field_ids": [],
            "hidden_field_ids": [],
            "missing_field_ids": [],
        }
        try:
            from apps.tabdata.services.undo_redo_field_restore import restore_fields
            from apps.tabdata.services.table_service import TableService

            anchor = self._resolve_effective_schema_anchor(table_id, history_id)
            if anchor is self._SCHEMA_ANCHOR_CYCLE:
                return {
                    **empty,
                    "field_restore_error": "版本还原链路存在循环引用，无法对齐字段结构",
                }
            if anchor is None or not isinstance(anchor, dict) or anchor.get('created_at') is None:
                return empty

            all_fields = list(
                TableField.objects.using(TABDATA_DB_ALIAS)
                .select_for_update()
                .filter(table_id=table_id)
                .order_by('order', 'created_at')
            )
            expected_ids, compute_error = self._compute_expected_field_ids_at(
                table_id,
                anchor['created_at'],
                all_fields=all_fields,
            )
            if compute_error:
                return {
                    **empty,
                    "field_restore_error": compute_error,
                }
            assert expected_ids is not None

            field_by_id = {str(field.id): field for field in all_fields}
            missing_field_ids = sorted(expected_ids - set(field_by_id))
            if missing_field_ids:
                logger.warning(
                    "[UndoRedo] target schema fields missing ORM rows table=%s fields=%s",
                    table_id,
                    missing_field_ids,
                )

            to_hide = [
                field for field in all_fields
                if not bool(getattr(field, 'is_deleted', False))
                and str(field.id) not in expected_ids
                and not bool(getattr(field, 'is_primary', False))
            ]
            to_revive = [
                field for field in all_fields
                if bool(getattr(field, 'is_deleted', False))
                and str(field.id) in expected_ids
            ]

            changed_fields = 0
            hidden_field_ids: List[str] = []
            revived_field_ids: List[str] = []
            table_service = TableService(user=self.user)

            if to_hide:
                for field in to_hide:
                    field.is_deleted = True
                    field.save(update_fields=['is_deleted'])
                    table_service._remove_field_from_views(table_id, str(field.id))  # noqa: SLF001
                    hidden_field_ids.append(str(field.id))
                table_service._refresh_field_count(table_id)  # noqa: SLF001
                table_service._increment_schema_version(table_id)  # noqa: SLF001
                try:
                    table_service._publish_field_event(table_id, "delete_field", to_hide)  # noqa: SLF001
                except Exception as exc:
                    logger.warning(
                        "[UndoRedo] publish field delete event failed table=%s err=%s",
                        table_id,
                        exc,
                    )
                changed_fields += len(to_hide)

            if to_revive:
                payloads = [
                    UndoRedoOperationService.serialize_field(field)
                    for field in to_revive
                ]
                restored_ids, errors = restore_fields(
                    payloads,
                    user=self.user,
                    write_changelog=False,
                )
                for field_id, message in errors:
                    logger.warning(
                        "[UndoRedo] restore field for version failed table=%s field=%s err=%s",
                        table_id,
                        field_id,
                        message,
                    )
                revived_field_ids = [str(field_id) for field_id in restored_ids]
                changed_fields += len(revived_field_ids)
                if payloads and not restored_ids and errors:
                    return {
                        "changed_fields": changed_fields,
                        "field_restore_error": errors[0][1] or "恢复字段失败",
                        "revived_field_ids": revived_field_ids,
                        "hidden_field_ids": hidden_field_ids,
                        "missing_field_ids": missing_field_ids,
                    }

            return {
                "changed_fields": changed_fields,
                "field_restore_error": None,
                "revived_field_ids": revived_field_ids,
                "hidden_field_ids": hidden_field_ids,
                "missing_field_ids": missing_field_ids,
            }
        except Exception as exc:
            logger.error(
                "[UndoRedo] apply field structure at history failed: table=%s history=%s err=%s",
                table_id,
                history_id,
                exc,
                exc_info=True,
            )
            return {
                "changed_fields": 0,
                "field_restore_error": str(exc) or "恢复字段失败",
                "revived_field_ids": [],
                "hidden_field_ids": [],
                "missing_field_ids": [],
            }

    @transaction.atomic(using=TABDATA_DB_ALIAS)
    def restore_table_to_history(
        self,
        table_id: UUID,
        history_id: UUID,
    ) -> Optional[Dict[str, Any]]:
        """将整张表格还原到指定历史版本（canonical replay 写链路）。"""
        try:
            from apps.tabdata.services.record_replay_helper import replay_record_state
            from apps.tabdata.services.record_service import RecordService

            if not self.check_table_permission(str(table_id), 'editor'):
                logger.warning("[UndoRedo] restore_table: 用户无 editor 权限 table=%s", table_id)
                return None

            field_structure_result = self._apply_field_structure_at_history(table_id, history_id)
            if field_structure_result.get("field_restore_error"):
                return {
                    "changed_records": 0,
                    "changed_histories": 0,
                    "changed_fields": 0,
                    "skipped_records": [],
                    "operation_group_id": None,
                    "field_restore_error": field_structure_result.get("field_restore_error"),
                }
            changed_fields = int(field_structure_result.get("changed_fields") or 0)

            snapshot_rows = self.reconstruct_table_at_history(table_id, history_id)
            if snapshot_rows is None:
                return None
            # 结构已双向对齐：prune 只保留当前活跃字段，避免把已隐藏列的残留
            # cell 再写回 soft-deleted 字段。部分 revive 失败的字段保持软删并剥值。
            target_field_key_map, _ = self._build_field_alias_maps(
                table_id,
                active_only=True,
            )
            snapshot_rows = self._prune_snapshot_rows_to_active_fields(
                snapshot_rows,
                target_field_key_map,
            )

            revived_field_ids = [
                str(field_id)
                for field_id in (field_structure_result.get("revived_field_ids") or [])
            ]
            missing_snapshot_field_ids: List[str] = []
            if revived_field_ids:
                present_field_ids = set()
                for row in snapshot_rows:
                    row_data = row.get("data") if isinstance(row, dict) else None
                    if not isinstance(row_data, dict):
                        continue
                    for key in row_data:
                        present_field_ids.add(str(key))
                missing_snapshot_field_ids = [
                    field_id
                    for field_id in revived_field_ids
                    if field_id not in present_field_ids
                ]
                if missing_snapshot_field_ids:
                    logger.warning(
                        "[UndoRedo] revived fields lack snapshot values table=%s history=%s fields=%s",
                        table_id,
                        history_id,
                        missing_snapshot_field_ids,
                    )

            current_records = list(
                TableRecord.objects.using(TABDATA_DB_ALIAS).select_for_update().filter(table_id=table_id)
            )
            current_map = {str(record.id): record for record in current_records}
            snapshot_map = {str(item["record_id"]): item for item in snapshot_rows}
            operation_group_id = self.create_operation_group()
            svc = RecordService(user=self.user)

            # 收集需要还原的记录和需要软删的记录
            restore_targets: list = []
            skipped_records: list = []
            for record_id, snapshot_row in snapshot_map.items():
                record = current_map.get(record_id)
                if not record:
                    skipped_records.append(record_id)
                    logger.warning(
                        "[restore_table] 快照中的记录已被物理删除，跳过: record_id=%s, table_id=%s",
                        record_id, table_id,
                    )
                    continue
                restore_targets.append((record, snapshot_row))

            ids_to_soft_delete = [
                rid for rid, rec in current_map.items()
                if rid not in snapshot_map and not rec.is_deleted
            ]
            soft_delete_targets = [current_map[rid] for rid in ids_to_soft_delete]

            # 批量预分配版本号：一次 DB round-trip
            total_affected = len(restore_targets) + len(soft_delete_targets)
            if total_affected > 0:
                from apps.tabdata.services.record_service import next_record_version
                version_end = next_record_version(table_id, count=total_affected)
                version_start = version_end - total_affected + 1
            else:
                version_start = 0

            # 整表 restore：预加载字段/表，抑制逐行 WS / YDoc / row_count。
            # 权威 YDoc 仍由 api_undo_redo._resync_collab_after_history_restore 负责。
            from apps.tabdata.services.record_replay_helper import (
                ReplayBatchContext,
                finalize_restore_batch_side_effects,
            )

            table = Table.objects.using(TABDATA_DB_ALIAS).filter(id=table_id).first()
            if table is None and current_records:
                table = current_records[0].table
            preloaded_fields = list(
                TableField.objects.using(TABDATA_DB_ALIAS).filter(
                    table_id=table_id, is_deleted=False,
                )
            )
            restore_batch = ReplayBatchContext(
                table=table,
                fields=preloaded_fields,
                suppress_ydoc=True,
                suppress_ws=True,
                suppress_row_count=True,
            )

            changed_records = 0
            new_history_count = 0
            version_cursor = version_start
            changed_results = []

            for record, snapshot_row in restore_targets:
                result = replay_record_state(
                    svc,
                    record=record,
                    next_data=dict(snapshot_row.get('data') or {}),
                    next_is_deleted=False,
                    next_order=self._safe_float(
                        snapshot_row.get('order'),
                        self._safe_float(record.order, 0.0),
                    ),
                    emit_history=True,
                    operation_group_id=operation_group_id,
                    push_history_to_stack=False,
                    window_id=self.window_id,
                    source="restore_table_to_history",
                    user=self.user,
                    version_override=version_cursor,
                    force_native_sync=True,
                    batch=restore_batch,
                )
                if result.changed:
                    changed_records += 1
                    new_history_count += 1
                    changed_results.append(result)
                version_cursor += 1

            for record in soft_delete_targets:
                result = replay_record_state(
                    svc,
                    record=record,
                    next_data=dict(read_data(record)),
                    next_is_deleted=True,
                    next_order=self._safe_float(record.order, 0.0),
                    emit_history=True,
                    operation_group_id=operation_group_id,
                    push_history_to_stack=False,
                    window_id=self.window_id,
                    source="restore_table_to_history",
                    user=self.user,
                    version_override=version_cursor,
                    batch=restore_batch,
                )
                if result.changed:
                    changed_records += 1
                    new_history_count += 1
                    changed_results.append(result)
                version_cursor += 1

            if changed_results:
                finalize_restore_batch_side_effects(
                    table_id=table_id,
                    changed_results=changed_results,
                    user_id=str(self.user.id) if self.user and hasattr(self.user, "id") else None,
                )

            # DV-017: 先清空旧 undo/redo 栈，再推入 restore 产生的新条目，
            # 防止旧条目与新条目共存导致用户重复 undo 或时序混乱。
            if changed_records > 0 and self._use_stack():
                user_id = self._resolve_stack_user_id()
                if user_id:
                    self.stack_service.clear_table_stacks(
                        user_id=user_id,
                        table_id=str(table_id),
                        all_windows=True,
                    )

                    from apps.tabdata.models import RecordHistory as _RH
                    changed_histories = list(
                        _RH.objects.using(TABDATA_DB_ALIAS).filter(
                            operation_group_id=operation_group_id,
                        ).order_by('created_at')
                    )
                    if changed_histories:
                        operations = [
                            self._build_stack_operation_from_history(h, is_undone=False)
                            for h in changed_histories
                        ]
                        self.stack_service.push_undo_operations(
                            user_id=user_id,
                            table_id=str(table_id),
                            window_id=self.window_id,
                            operations=operations,
                            clear_redo=False,
                        )

            logger.info(
                "[UndoRedo] 表格 %s 已还原到历史 %s，变更记录=%d",
                table_id, history_id, changed_records,
            )

            return {
                "changed_records": changed_records,
                "changed_histories": new_history_count,
                "changed_fields": changed_fields,
                "skipped_records": skipped_records,
                "operation_group_id": str(operation_group_id) if (changed_records or changed_fields) else None,
                "revived_field_ids": revived_field_ids,
                "hidden_field_ids": list(field_structure_result.get("hidden_field_ids") or []),
                "missing_field_ids": list(field_structure_result.get("missing_field_ids") or []),
                "missing_snapshot_field_ids": missing_snapshot_field_ids,
            }

        except RuntimeError as exc:
            # 并发冲突等可诊断错误：原样透出，勿吞成 None →「表格不存在」
            # Refs:  /
            transaction.set_rollback(True, using=TABDATA_DB_ALIAS)
            logger.error("[UndoRedo] restore_table_to_history 失败: %s", exc, exc_info=True)
            return {
                "changed_records": 0,
                "changed_histories": 0,
                "changed_fields": 0,
                "skipped_records": [],
                "operation_group_id": None,
                "restore_error": str(exc),
            }
        except Exception as exc:
            transaction.set_rollback(True, using=TABDATA_DB_ALIAS)
            logger.error("[UndoRedo] restore_table_to_history 失败: %s", exc, exc_info=True)
            return None

    # ============ 版本快照与还原 ============

    def reconstruct_record_at_history(
        self,
        record_id: UUID,
        history_id: UUID,
    ) -> Optional[Dict[str, Any]]:
        """
        重建记录在指定历史时间点的状态快照。

        算法：
        1. 获取记录当前 data
        2. 查询 history_id 对应的时间点
        3. 获取该时间点之后的所有 RecordHistoryItem（按时间倒序）
        4. 逐条用 before 值替换 after 值（反向回溯）
        5. 若某条 RecordHistory 无对应 RecordHistoryItem，回退到 field_changes 兜底
        6. 得到历史快照

        Returns:
            记录在该时间点的 data 字典，或 None（如果不存在）
        """
        try:
            record = TableRecord.objects.using(TABDATA_DB_ALIAS).get(id=record_id)
            target_history = RecordHistory.objects.using(TABDATA_DB_ALIAS).get(id=history_id)

            if not self.check_table_permission(str(record.table_id), 'viewer'):
                return None

            current_data = dict(read_data(record))

            later_items = RecordHistoryItem.objects.using(TABDATA_DB_ALIAS).filter(
                record_id=record_id,
                history__created_at__gt=target_history.created_at,
            ).order_by('-created_at', '-id')

            covered_history_ids = set()
            for item in later_items:
                current_data[item.field_key] = item.before
                covered_history_ids.add(item.history_id)

            # DV-009/DV-019: RecordHistoryItem 缺失时，从 field_changes 兜底
            later_histories = RecordHistory.objects.using(TABDATA_DB_ALIAS).filter(
                record_id=record_id,
                created_at__gt=target_history.created_at,
            ).exclude(
                id__in=covered_history_ids,
            ).only('id', 'action', 'field_changes').order_by('-created_at', '-id')

            for history in later_histories:
                fc = history.field_changes if isinstance(history.field_changes, dict) else {}
                # 兼容旧版 create 格式 {"data": {field: value, ...}}
                if "data" in fc and isinstance(fc["data"], dict) and "old" not in fc["data"] and "new" not in fc["data"]:
                    for fk in fc["data"]:
                        current_data[str(fk)] = None
                    continue
                for field_key, change in fc.items():
                    if not isinstance(change, dict) or field_key.startswith('_'):
                        continue
                    if 'old' in change:
                        current_data[str(field_key)] = change['old']

            return current_data

        except TableRecord.DoesNotExist:
            logger.warning("[UndoRedo] reconstruct_record_at_history: 记录不存在 %s", record_id)
            return None
        except RecordHistory.DoesNotExist:
            logger.warning("[UndoRedo] reconstruct_record_at_history: 历史不存在 %s", history_id)
            return None
        except Exception as exc:
            logger.error("[UndoRedo] reconstruct_record_at_history 失败: %s", exc, exc_info=True)
            return None

    def restore_record_to_history(
        self,
        record_id: UUID,
        history_id: UUID,
    ) -> Optional[Dict[str, Any]]:
        """
        将记录还原到指定历史版本（canonical replay 写链路）。

        Returns:
            还原后的记录 data，或 None（如果失败）
        """
        try:
            from apps.tabdata.services.record_replay_helper import replay_record_state
            from apps.tabdata.services.record_service import RecordService

            record = TableRecord.objects.using(TABDATA_DB_ALIAS).get(id=record_id)

            if not self.check_table_permission(str(record.table_id), 'editor'):
                logger.warning("[UndoRedo] restore: 用户无 editor 权限")
                return None

            snapshot = self.reconstruct_record_at_history(record_id, history_id)
            if snapshot is None:
                return None

            op_group_id = self.create_operation_group()
            svc = RecordService(user=self.user)
            result = replay_record_state(
                svc,
                record=record,
                next_data=snapshot,
                next_is_deleted=False,
                next_order=float(record.order) if record.order is not None else 0.0,
                emit_history=True,
                operation_group_id=op_group_id,
                push_history_to_stack=True,
                window_id=self.window_id,
                source="restore_record_to_history",
                user=self.user,
                force_native_sync=True,
            )

            if not result.changed and not result.native_synced:
                return dict(read_data(record))

            logger.info(
                "[UndoRedo] 记录 %s 已还原到历史 %s，变更 %d 个字段",
                record_id, history_id, len(result.field_changes),
            )
            return snapshot

        except TableRecord.DoesNotExist:
            logger.warning("[UndoRedo] restore: 记录不存在 %s", record_id)
            return None
        except Exception as exc:
            logger.error("[UndoRedo] restore 失败: %s", exc, exc_info=True)
            return None

    # ============ 命名版本（手动保存）============

    def list_table_named_versions(
        self,
        table_id: UUID,
        limit: int = 50,
    ) -> List[Dict[str, Any]]:
        """列出表格的命名版本"""
        if not self.check_table_permission(str(table_id), 'viewer'):
            return []

        qs = list(
            TableNamedVersion.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=table_id,
            ).order_by('-created_at')[:max(1, min(limit, 200))]
        )

        # 批量校验 history_id 有效性，避免逐条查 DB
        candidate_ids = {v.history_id for v in qs if v.history_id}
        if candidate_ids:
            valid_ids = set(
                RecordHistory.objects.using(TABDATA_DB_ALIAS)
                .filter(id__in=candidate_ids)
                .values_list('id', flat=True)
            )
        else:
            valid_ids = set()

        return [self._serialize_named_version(v, valid_history_ids=valid_ids) for v in qs]

    def create_table_named_version(
        self,
        table_id: UUID,
        name: str = '',
    ) -> Optional[Dict[str, Any]]:
        """
        创建表格命名版本（书签式，引用当前最新的 RecordHistory）。
        """
        from apps.tabdata.models import Table

        if not self.check_table_permission(str(table_id), 'editor'):
            logger.warning("[NamedVersion] 无 editor 权限 table=%s", table_id)
            return None

        try:
            table = Table.objects.using(TABDATA_DB_ALIAS).get(id=table_id)
        except Table.DoesNotExist:
            return None

        now = timezone.now()

        # 找到该表最新的 RecordHistory 作为书签
        latest_history = (
            RecordHistory.objects.using(TABDATA_DB_ALIAS).filter(record__table_id=table_id)
            .order_by('-created_at')
            .values_list('id', flat=True)
            .first()
        )

        version = TableNamedVersion.objects.using(TABDATA_DB_ALIAS).create(
            table=table,
            organization_id=table.organization_id,
            history_id=latest_history,  # 可能为 None（表格从未编辑过）
            snapshot_at=now,
            name=(name or '').strip(),
            created_by=self.user,
        )

        # P2: 同时写入统一 VersionHistory（双写过渡期）
        try:
            from apps.collab.registry import get_adapter
            from apps.collab.service import VersionHistoryService

            adapter = get_adapter("table")
            if adapter:
                resource = adapter.get_resource(str(table_id))
                if resource:
                    version_data = adapter.get_version_data(resource)
                    editor_info = {
                        "editor_type": "user",
                        "editor_id": str(self.user.id) if self.user else "",
                    }
                    svc = VersionHistoryService(adapter)
                    svc.create_named_version(
                        table_id,
                        (name or '').strip(),
                        version_data,
                        editor_info,
                        organization_id=table.organization_id,
                    )
        except Exception:
            logger.warning(
                "[NamedVersion] VH 双写失败（不影响私有表记录）: table=%s",
                table_id, exc_info=True,
            )

        logger.info(
            "[NamedVersion] 创建: table=%s name=%r history=%s",
            table_id, version.name, latest_history,
        )
        return self._serialize_named_version(version)

    def rename_table_named_version(
        self,
        table_id: UUID,
        version_id: UUID,
        name: str,
    ) -> Optional[Dict[str, Any]]:
        """重命名表格命名版本"""
        if not self.check_table_permission(str(table_id), 'editor'):
            return None

        version = TableNamedVersion.objects.using(TABDATA_DB_ALIAS).filter(
            id=version_id, table_id=table_id,
        ).first()
        if not version:
            return None

        version.name = (name or '').strip()
        version.save(update_fields=['name'])
        return self._serialize_named_version(version)

    def delete_table_named_version(
        self,
        table_id: UUID,
        version_id: UUID,
    ) -> bool:
        """删除表格命名版本"""
        if not self.check_table_permission(str(table_id), 'editor'):
            return False

        deleted, _ = TableNamedVersion.objects.using(TABDATA_DB_ALIAS).filter(
            id=version_id, table_id=table_id,
        ).delete()
        if deleted:
            logger.info("[NamedVersion] 删除: table=%s version=%s", table_id, version_id)
        return deleted > 0

    def _serialize_named_version(
        self,
        v: TableNamedVersion,
        valid_history_ids: Optional[set] = None,
    ) -> Dict[str, Any]:
        # 当调用方提供了有效 history_id 集合时直接查集合，否则查 DB
        if v.history_id:
            if valid_history_ids is not None:
                history_valid = v.history_id in valid_history_ids
            else:
                history_valid = RecordHistory.objects.using(TABDATA_DB_ALIAS).filter(
                    id=v.history_id,
                ).exists()
        else:
            history_valid = False

        return {
            'id': str(v.id),
            'table_id': str(v.table_id),
            'history_id': str(v.history_id) if v.history_id else None,
            'history_valid': history_valid,
            'snapshot_at': v.snapshot_at.isoformat() if v.snapshot_at else None,
            'name': v.name or '',
            'created_by': str(v.created_by_id) if v.created_by_id else None,
            'created_at': v.created_at.isoformat() if v.created_at else None,
        }

    # ============ 批量操作支持 ============

    def create_operation_group(self) -> UUID:
        """
        创建操作组ID（用于批量操作）

        Returns:
            操作组UUID
        """
        import uuid
        return uuid.uuid4()
