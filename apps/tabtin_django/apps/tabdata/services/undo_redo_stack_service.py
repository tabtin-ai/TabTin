"""
Undo/Redo 栈存储服务

目标：
1. 使用 Redis/Cache 维护独立 Undo/Redo 栈（user + table + window 维度）
2. 与 RecordHistory 审计职责解耦
3. 在测试环境（locmem cache）下保持可运行
"""

from __future__ import annotations

import logging
from copy import deepcopy
from typing import Any, Dict, Iterable, List, Optional, Tuple

from django.conf import settings
from django.core.cache import cache

logger = logging.getLogger(__name__)


class UndoRedoStackService:
    """Undo/Redo 栈服务（基于 Django cache，默认 Redis backend）。"""

    GLOBAL_WINDOW_KEY = "__global__"
    DEFAULT_MAX_STACK_SIZE = 200
    DEFAULT_EXPIRATION_SECONDS = 24 * 60 * 60

    def __init__(self) -> None:
        self.enabled = self._as_bool(
            getattr(settings, "TABDATA_UNDO_REDIS_STACK_ENABLED", True),
            default=True,
        )
        self.max_stack_size = max(
            1,
            int(getattr(settings, "TABDATA_UNDO_MAX_STACK_SIZE", self.DEFAULT_MAX_STACK_SIZE) or 1),
        )
        self.expiration_seconds = max(
            1,
            int(
                getattr(
                    settings,
                    "TABDATA_UNDO_EXPIRATION_SECONDS",
                    self.DEFAULT_EXPIRATION_SECONDS,
                )
                or 1
            ),
        )

    @staticmethod
    def _as_bool(value: Any, default: bool) -> bool:
        if value is None:
            return default
        if isinstance(value, bool):
            return value
        normalized = str(value).strip().lower()
        if normalized in {"", "0", "false", "no", "off"}:
            return False
        if normalized in {"1", "true", "yes", "on"}:
            return True
        return default

    def _normalize_window_key(self, window_id: Optional[str]) -> str:
        if not window_id:
            return self.GLOBAL_WINDOW_KEY
        normalized = str(window_id).strip()
        return normalized[:128] if normalized else self.GLOBAL_WINDOW_KEY

    def _undo_key(self, user_id: str, table_id: str, window_id: Optional[str]) -> str:
        return f"operations:undo:{user_id}:{table_id}:{self._normalize_window_key(window_id)}"

    def _redo_key(self, user_id: str, table_id: str, window_id: Optional[str]) -> str:
        return f"operations:redo:{user_id}:{table_id}:{self._normalize_window_key(window_id)}"

    def _get_stack(self, key: str) -> List[Dict[str, Any]]:
        try:
            value = cache.get(key)
            if isinstance(value, list):
                # 防止调用方就地修改缓存对象
                return deepcopy(value)
        except Exception as exc:
            logger.warning("[UndoRedoStack] 读取缓存失败 key=%s err=%s", key, exc)
        return []

    def _set_stack(self, key: str, stack: List[Dict[str, Any]]) -> None:
        try:
            cache.set(key, deepcopy(stack), timeout=self.expiration_seconds)
        except Exception as exc:
            logger.warning("[UndoRedoStack] 写入缓存失败 key=%s err=%s", key, exc)

    def _clear_stack(self, key: str) -> None:
        try:
            cache.delete(key)
        except Exception as exc:
            logger.warning("[UndoRedoStack] 清空缓存失败 key=%s err=%s", key, exc)

    def _trim_stack(self, stack: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        if len(stack) <= self.max_stack_size:
            return stack
        return stack[-self.max_stack_size :]

    @staticmethod
    def _history_user_payload(history) -> Optional[Dict[str, Any]]:
        if not getattr(history, "user", None):
            return None
        user = history.user
        return {
            "id": user.id,
            "name": user.get_display_name() if hasattr(user, "get_display_name") else str(user),
        }

    @classmethod
    def build_operation_from_history(
        cls,
        history,
        *,
        is_undone: bool = False,
        undone_at: Optional[str] = None,
        undone_by: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        return {
            "id": str(history.id),
            "history_id": str(history.id),
            "record_id": str(history.record_id),
            "table_id": str(history.record.table_id),
            "action": history.action,
            "action_display": history.get_action_display(),
            "field_changes": history.field_changes or {},
            "user": cls._history_user_payload(history),
            "created_at": history.created_at.isoformat(),
            "is_undone": bool(is_undone),
            "undone_at": undone_at,
            "undone_by": undone_by,
            "operation_group_id": str(history.operation_group_id) if history.operation_group_id else None,
            "window_id": history.window_id,
        }

    def push_undo_operation(
        self,
        *,
        user_id: str,
        table_id: str,
        window_id: Optional[str],
        operation: Dict[str, Any],
        clear_redo: bool = True,
    ) -> None:
        if not self.enabled or not user_id:
            return

        undo_key = self._undo_key(user_id, table_id, window_id)
        redo_key = self._redo_key(user_id, table_id, window_id)
        undo_stack = self._get_stack(undo_key)
        undo_stack.append(operation)
        undo_stack = self._trim_stack(undo_stack)
        self._set_stack(undo_key, undo_stack)

        if clear_redo:
            self._clear_stack(redo_key)

    def push_redo_operations(
        self,
        *,
        user_id: str,
        table_id: str,
        window_id: Optional[str],
        operations: Iterable[Dict[str, Any]],
    ) -> None:
        if not self.enabled or not user_id:
            return
        redo_key = self._redo_key(user_id, table_id, window_id)
        redo_stack = self._get_stack(redo_key)
        redo_stack.extend(list(operations))
        redo_stack = self._trim_stack(redo_stack)
        self._set_stack(redo_key, redo_stack)

    def push_undo_operations(
        self,
        *,
        user_id: str,
        table_id: str,
        window_id: Optional[str],
        operations: Iterable[Dict[str, Any]],
        clear_redo: bool = False,
    ) -> None:
        if not self.enabled or not user_id:
            return
        undo_key = self._undo_key(user_id, table_id, window_id)
        undo_stack = self._get_stack(undo_key)
        undo_stack.extend(list(operations))
        undo_stack = self._trim_stack(undo_stack)
        self._set_stack(undo_key, undo_stack)
        if clear_redo:
            self._clear_stack(self._redo_key(user_id, table_id, window_id))

    def pop_undo_operation(
        self,
        *,
        user_id: str,
        table_id: str,
        window_id: Optional[str],
    ) -> Optional[Dict[str, Any]]:
        if not self.enabled or not user_id:
            return None
        undo_key = self._undo_key(user_id, table_id, window_id)
        undo_stack = self._get_stack(undo_key)
        if not undo_stack:
            return None
        operation = undo_stack.pop()
        self._set_stack(undo_key, undo_stack)
        return operation

    def pop_redo_operation(
        self,
        *,
        user_id: str,
        table_id: str,
        window_id: Optional[str],
    ) -> Optional[Dict[str, Any]]:
        if not self.enabled or not user_id:
            return None
        redo_key = self._redo_key(user_id, table_id, window_id)
        redo_stack = self._get_stack(redo_key)
        if not redo_stack:
            return None
        operation = redo_stack.pop()
        self._set_stack(redo_key, redo_stack)
        return operation

    def remove_history_ids_from_undo(
        self,
        *,
        user_id: str,
        table_id: str,
        window_id: Optional[str],
        history_ids: Iterable[str],
    ) -> None:
        self._remove_history_ids_from_stack(
            key=self._undo_key(user_id, table_id, window_id),
            history_ids=history_ids,
        )

    def remove_history_ids_from_redo(
        self,
        *,
        user_id: str,
        table_id: str,
        window_id: Optional[str],
        history_ids: Iterable[str],
    ) -> None:
        self._remove_history_ids_from_stack(
            key=self._redo_key(user_id, table_id, window_id),
            history_ids=history_ids,
        )

    @staticmethod
    def operation_identity(operation: Dict[str, Any]) -> str:
        """稳定标识一条栈条目，用于精确移除（：过滤未命中不得 pop 即弃）。"""
        for key in ("history_id", "id", "operation_id"):
            value = operation.get(key)
            if value:
                return str(value)
        # 结构化 operation 兜底：name + 关键 params 摘要
        name = str(operation.get("name") or operation.get("action") or "")
        params = operation.get("params") or {}
        table_id = operation.get("table_id") or params.get("table_id") or ""
        return f"{name}:{table_id}:{id(operation)}"

    def remove_operation_from_undo(
        self,
        *,
        user_id: str,
        table_id: str,
        window_id: Optional[str],
        operation: Dict[str, Any],
    ) -> bool:
        return self._remove_one_operation_from_stack(
            key=self._undo_key(user_id, table_id, window_id),
            operation=operation,
        )

    def remove_operation_from_redo(
        self,
        *,
        user_id: str,
        table_id: str,
        window_id: Optional[str],
        operation: Dict[str, Any],
    ) -> bool:
        return self._remove_one_operation_from_stack(
            key=self._redo_key(user_id, table_id, window_id),
            operation=operation,
        )

    def _remove_one_operation_from_stack(
        self,
        *,
        key: str,
        operation: Dict[str, Any],
    ) -> bool:
        """从栈中精确移除一条命中项（优先按 identity，从栈顶往下找最近一条）。"""
        if not self.enabled or not operation:
            return False
        target = self.operation_identity(operation)
        stack = self._get_stack(key)
        if not stack:
            return False
        # 栈顶在末尾：从后往前找，移除最近匹配项，保留其余条目原位
        for index in range(len(stack) - 1, -1, -1):
            if self.operation_identity(stack[index]) == target:
                del stack[index]
                self._set_stack(key, stack)
                return True
        return False

    def clear_table_stacks(
        self,
        *,
        user_id: str,
        table_id: str,
        window_id: Optional[str] = None,
        all_windows: bool = False,
    ) -> None:
        """清空指定 user+table 维度的 undo 和 redo 栈。

        all_windows=True 时尝试清空所有窗口的栈（需 django-redis 的
        delete_pattern 支持），否则仅清空指定 window_id 的栈。
        """
        if not self.enabled or not user_id:
            return

        if all_windows:
            undo_pattern = f"operations:undo:{user_id}:{table_id}:*"
            redo_pattern = f"operations:redo:{user_id}:{table_id}:*"
            try:
                if hasattr(cache, "delete_pattern"):
                    cache.delete_pattern(undo_pattern)
                    cache.delete_pattern(redo_pattern)
                    return
            except Exception as exc:
                logger.warning("[UndoRedoStack] Pattern delete failed, falling back: %s", exc)
            self._clear_stack(self._undo_key(user_id, table_id, None))
            self._clear_stack(self._redo_key(user_id, table_id, None))
        else:
            self._clear_stack(self._undo_key(user_id, table_id, window_id))
            self._clear_stack(self._redo_key(user_id, table_id, window_id))

    def _remove_history_ids_from_stack(self, *, key: str, history_ids: Iterable[str]) -> None:
        if not self.enabled:
            return
        ids = {str(item) for item in history_ids if item}
        if not ids:
            return
        stack = self._get_stack(key)
        if not stack:
            return
        filtered_stack = [
            item
            for item in stack
            if str(item.get("history_id") or item.get("id")) not in ids
        ]
        self._set_stack(key, filtered_stack)

    def get_undo_stack(
        self,
        *,
        user_id: str,
        table_id: str,
        window_id: Optional[str],
        limit: int,
    ) -> Tuple[List[Dict[str, Any]], int]:
        return self._get_stack_page(
            key=self._undo_key(user_id, table_id, window_id),
            limit=limit,
        )

    def get_redo_stack(
        self,
        *,
        user_id: str,
        table_id: str,
        window_id: Optional[str],
        limit: int,
    ) -> Tuple[List[Dict[str, Any]], int]:
        return self._get_stack_page(
            key=self._redo_key(user_id, table_id, window_id),
            limit=limit,
        )

    def _get_stack_page(self, *, key: str, limit: int) -> Tuple[List[Dict[str, Any]], int]:
        if not self.enabled:
            return [], 0
        safe_limit = max(1, int(limit or 20))
        stack = self._get_stack(key)
        total = len(stack)
        # 栈顶在列表末尾，接口返回按“最近优先”
        ordered = list(reversed(stack))
        return ordered[:safe_limit], total

