"""DebugModeService - per-thread 调试模式管理。

封装 _debug_mode 的读写逻辑，避免 API 层直接操作 state dict。
"""

from __future__ import annotations

import logging
from typing import Optional

logger = logging.getLogger(__name__)


class DebugModeService:
    """管理 per-thread 的调试模式开关。"""

    @staticmethod
    def toggle(thread_id: str, enabled: bool) -> bool:
        """开启或关闭指定 thread 的调试模式。

        使用 update_state_field 原子更新，避免与活跃 Agent run 并发时覆盖 state。

        Returns:
            True 如果操作成功，False 如果 thread 不存在。
        """
        from apps.services.agent_engine.persistence.conversation_store import ConversationStore

        success = ConversationStore.update_state_field(
            thread_id, "_debug_mode", bool(enabled),
        )
        if success:
            logger.info(
                "[DebugModeService] thread=%s debug_mode=%s",
                thread_id, enabled,
            )
        return success

    @staticmethod
    def is_enabled(thread_id: str) -> Optional[bool]:
        """查询指定 thread 的调试模式状态。

        Returns:
            True/False 表示开关状态，None 表示 thread 不存在。
        """
        from apps.services.agent_engine.persistence.conversation_store import ConversationStore

        # ATK-3: 仅由 superuser 专用的 agentdash toggle_debug_mode API 调用，不传 expected_user_id
        state = ConversationStore.load_state(thread_id)
        if state is None:
            return None
        return bool(state.get("_debug_mode", False))


__all__ = ["DebugModeService"]
