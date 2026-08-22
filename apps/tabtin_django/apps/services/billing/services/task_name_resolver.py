"""
用量事件 → 任务名（会话标题）反查。

#4572：BillingUsageEvent.metadata.session_id（= 客户端 X-TabTin-Session-Id）
由 LLM proxy 结算时写入。本模块把一批事件里的 session_id 批量反查成
用户可读的会话标题（产品语言里的「任务名」），供用量明细 API 与 CSV 导出展示。

session_id 的真实形态有两种（客户端 threadId 取值口径不一）：
- **纯 UUID** —— 等于 ChatSession.id（主键）；这是当前实测的主路径。
- **`chat-session-<id>` 前缀串** —— 等于 ChatSession.thread_id 字段。

所以反查必须**同时**按主键 id 和 thread_id 命中，只匹配 thread_id 会漏掉
纯 UUID 那一路（历史 bug：任务列恒为空）。

- 限定 organization_id，防止跨组织读取会话标题。
- 查不到（非会话类消耗：存储、后台记忆提取等，或会话已删）返回空串。
- 只做一次查询，调用方每批最多几千条事件，无 N+1。
"""

from __future__ import annotations

import logging
from typing import Dict, Iterable, Optional

logger = logging.getLogger(__name__)

# 单批反查的 session_id 数量上限（明细页每页 <=100，CSV 每批 2000）。
_MAX_SESSION_IDS_PER_QUERY = 2000


def extract_session_id(event) -> str:
    """从事件 metadata 里取 session_id；历史数据无此键时返回空串。"""
    metadata = getattr(event, "metadata", None) or {}
    if not isinstance(metadata, dict):
        return ""
    value = metadata.get("session_id")
    return str(value).strip() if value else ""


def build_task_name_map(
    session_ids: Iterable[str],
    organization_id: str,
) -> Dict[str, str]:
    """批量把 session_id 映射成会话标题。

    session_id 可能是 ChatSession.id（纯 UUID）或 thread_id（`chat-session-*`），
    返回的 map 同时以 id 串与 thread_id 为 key，让调用方拿原始 session_id 直接命中。
    查不到的 id 不出现在结果里。任何异常降级为空 map——任务名是展示增强，
    不能拖垮明细/导出主流程。
    """
    import uuid as _uuid

    ids = [s for s in {str(s).strip() for s in session_ids if s} if s]
    if not ids or not organization_id:
        return {}
    ids = ids[:_MAX_SESSION_IDS_PER_QUERY]

    # 只有形如合法 UUID 的 session_id 才能拿去撞主键，避免 id__in 抛类型错误。
    uuid_ids = []
    for s in ids:
        try:
            _uuid.UUID(s)
            uuid_ids.append(s)
        except (ValueError, AttributeError, TypeError):
            pass

    try:
        from apps.chat.conversation.models import ChatSession

        # 拆成两次等值 IN，避免 OR 导致规划器放弃索引、拉长导出首包静默期。
        result: Dict[str, str] = {}

        def _absorb(rows) -> None:
            for session_pk, thread_id, title in rows:
                clean_title = title or ""
                if session_pk is not None:
                    result[str(session_pk)] = clean_title
                if thread_id:
                    result[thread_id] = clean_title

        if uuid_ids:
            _absorb(
                ChatSession.objects.filter(
                    organization_id=organization_id,
                    id__in=uuid_ids,
                ).values_list("id", "thread_id", "title")
            )

        thread_ids = [s for s in ids if s not in result]
        if thread_ids:
            _absorb(
                ChatSession.objects.filter(
                    organization_id=organization_id,
                    thread_id__in=thread_ids,
                ).values_list("id", "thread_id", "title")
            )

        return result
    except Exception:
        logger.warning("[task_name_resolver] 会话标题反查失败（降级为空）", exc_info=True)
        return {}


def resolve_task_names_for_events(
    events,
    organization_id: str,
) -> Dict[str, str]:
    """对一批 BillingUsageEvent 返回 {event.id(str): task_name}。"""
    session_by_event: Dict[str, str] = {}
    for event in events:
        session_id = extract_session_id(event)
        if session_id:
            session_by_event[str(event.id)] = session_id
    if not session_by_event:
        return {}
    title_map = build_task_name_map(session_by_event.values(), organization_id)
    return {
        event_id: title_map.get(session_id, "")
        for event_id, session_id in session_by_event.items()
    }
