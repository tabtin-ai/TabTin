"""
Context Manager - 上下文管理服务

负责管理会话上下文，帮助AI理解当前对话环境
"""

from typing import Dict, List, Optional

from ..models import ChatSession, ChatContext


class ContextManager:
    """
    上下文管理器

    功能：
    - 获取/更新会话上下文
    - 管理当前关注对象（space/table/view）
    - 管理最近访问历史
    - 为 Agent 提供上下文信息
    """

    @staticmethod
    def get_or_create_context(session_id: str, *, user_id: Optional[str]) -> ChatContext:
        """获取或创建会话上下文。

        user_id 为 keyword-only 必填参数。外部 API 调用方必须传入当前
        用户 ID 以校验会话归属；内部信任路径（如 Agent 引擎）传入从
        state 获取的 user_id（可能为 None，此时跳过归属校验）。
        """
        session = ChatSession.objects.filter(id=session_id).first()
        if not session:
            raise ValueError(f"ChatSession {session_id} not found")
        if user_id is not None and str(session.user_id) != str(user_id):
            from django.core.exceptions import PermissionDenied
            raise PermissionDenied("ChatSession does not belong to this user")
        context, created = ChatContext.objects.get_or_create(session=session)
        return context

    @staticmethod
    def get_context_summary(
        session_id: str, *, user_id: Optional[str] = None
    ) -> Dict:
        """获取上下文摘要，用于传递给 Agent 引擎"""
        context = ContextManager.get_or_create_context(session_id, user_id=user_id)

        return {
            "current_space_id": context.current_space_id,
            "current_project_id": str(context.current_project_id or context.session.project_id or ""),
            "current_table_id": context.current_table_id,
            "current_view_id": context.current_view_id,
            "recent_spaces": context.recent_spaces,
            "recent_tables": context.recent_tables,
            "recent_views": context.recent_views,
            "context_data": context.context_data,
            "conversation_summary": context.context_data.get("conversation_summary")
        }

    @staticmethod
    def set_current_table(
        session_id: str, table_id: str,
        space_id: str = None, *, user_id: Optional[str] = None,
    ) -> ChatContext:
        """设置当前表格"""
        context = ContextManager.get_or_create_context(session_id, user_id=user_id)
        context.set_current_table(table_id, space_id)
        return context

    @staticmethod
    def set_current_space(
        session_id: str, space_id: str, *, user_id: Optional[str] = None,
    ) -> ChatContext:
        """设置当前智能体空间"""
        context = ContextManager.get_or_create_context(session_id, user_id=user_id)
        context.current_space_id = space_id
        context.add_recent_space(space_id)
        return context

    @staticmethod
    def clear_current(session_id: str, *, user_id: Optional[str] = None) -> ChatContext:
        """清除当前上下文"""
        context = ContextManager.get_or_create_context(session_id, user_id=user_id)
        context.clear_current()
        return context

    @staticmethod
    def update_context_data(
        session_id: str, key: str, value, *, user_id: Optional[str] = None
    ) -> ChatContext:
        """更新自定义上下文数据"""
        context = ContextManager.get_or_create_context(session_id, user_id=user_id)
        context.context_data[key] = value
        context.save(update_fields=['context_data', 'updated_at'])
        return context

    @staticmethod
    def get_context_for_prompt(
        session_id: str, *, user_id: Optional[str] = None,
    ) -> str:
        """生成用于 Prompt 的上下文描述，可直接插入到 system prompt 中。"""
        context_summary = ContextManager.get_context_summary(session_id, user_id=user_id)

        parts = ["【当前上下文】"]

        if context_summary["current_table_id"]:
            parts.append(f"- 当前表格: {context_summary['current_table_id']}")

        if context_summary["current_space_id"]:
            parts.append(f"- 当前智能体空间: {context_summary['current_space_id']}")

        if context_summary["current_project_id"]:
            parts.append(f"- 当前协作 Project: {context_summary['current_project_id']}")

        if context_summary["recent_tables"]:
            recent = ", ".join(context_summary["recent_tables"][:3])
            parts.append(f"- 最近表格: {recent}")

        conversation_summary = context_summary.get("conversation_summary") if context_summary else None
        if conversation_summary:
            parts.append("【对话摘要】")
            parts.append(conversation_summary)

        if len(parts) == 1:
            return ""

        return "\n".join(parts)
