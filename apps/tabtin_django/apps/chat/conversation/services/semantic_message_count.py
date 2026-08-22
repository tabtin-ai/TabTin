"""回退/展示用语义消息计数。

与前端 MessageList / semanticMessageCount 方案 A 对齐：
- 只计真实用户消息与 Agent（assistant）消息；
- 相邻 assistant 合并为 1 条（中间可夹 context_injection / tool_artifact / hitl）；
- 不再按 agent_run_id 拆开相邻 Agent。
"""

from __future__ import annotations

from typing import Iterable, Protocol, Sequence

from apps.services.agent_execution.user_context_wrapper import find_first_user_context_wrapper

# 对用户不可见的注入型 message_kind（SSoT）。标题生成 / 回退预览 / 语义计数共用。
# 与前端 semanticMessageCount.CONTEXT_INJECTION_KINDS 对齐（含 external_archive）。
CONTEXT_INJECTION_KINDS = frozenset({
    'environment_context',
    'agent_profile_context',
    'system_prompt_context',
    'external_archive_context',
})
# 兼容旧调用方私有名。
_CONTEXT_INJECTION_KINDS = CONTEXT_INJECTION_KINDS
_CONTEXT_INJECTION_WRAPPER_TYPES = frozenset({
    'environment',
    'agent-profile',
    'external-archive',
})

_USER_TURN_MESSAGE_KIND = 'llm'
_USER_TRIGGERED_BY = 'user'
_SKILL_INVOKE_SOURCE = 'skill_invoke'
_TRANSPARENT_ASSISTANT_KINDS = frozenset({'tool_artifact', 'hitl_interaction'})


class _SemanticCountMessage(Protocol):
    role: str
    message_kind: str
    agent_run_id: str
    text_summary: str


def _message_text(msg: _SemanticCountMessage) -> str:
    return (getattr(msg, 'text_summary', None) or '').lstrip()


def _read_metadata(msg: _SemanticCountMessage) -> dict:
    meta = getattr(msg, 'metadata', None)
    return meta if isinstance(meta, dict) else {}


def is_context_injection_message(msg: _SemanticCountMessage) -> bool:
    """判定 context_injection：对用户不可见的环境 / agent-profile / fork 注入。"""
    meta = _read_metadata(msg)
    if meta.get('share_briefing') is True or meta.get('share_contract') is True:
        return True
    if getattr(msg, 'message_kind', 'llm') in _CONTEXT_INJECTION_KINDS:
        return True
    if msg.role != 'user':
        return False
    wrapper = find_first_user_context_wrapper(_message_text(msg), start_from=0)
    return (
        wrapper is not None
        and wrapper.start_offset == 0
        and wrapper.type in _CONTEXT_INJECTION_WRAPPER_TYPES
    )


def is_regular_user_message(msg: _SemanticCountMessage) -> bool:
    """人从输入框发出的真实用户轮（与前端 isRegularUserMessage 对齐）。"""
    if msg.role != 'user':
        return False
    if getattr(msg, 'message_kind', _USER_TURN_MESSAGE_KIND) != _USER_TURN_MESSAGE_KIND:
        return False
    meta = _read_metadata(msg)
    triggered_by = meta.get('triggered_by')
    if triggered_by is not None and triggered_by != _USER_TRIGGERED_BY:
        return False
    if meta.get('source') == _SKILL_INVOKE_SOURCE:
        return False
    return True


def _is_turn_transparent_assistant(msg: _SemanticCountMessage) -> bool:
    # tool_artifact：产物气泡并入所属 Agent 轮；hitl_interaction：审批/追问
    # 持久化事实，UI 隐藏，不构成用户感知的轮次。
    return (
        msg.role == 'assistant'
        and getattr(msg, 'message_kind', 'llm') in _TRANSPARENT_ASSISTANT_KINDS
    )


def _is_countable_assistant(msg: _SemanticCountMessage) -> bool:
    return msg.role == 'assistant' and not _is_turn_transparent_assistant(msg)


def count_semantic_messages(messages: Sequence[_SemanticCountMessage]) -> int:
    """按用户感知的「轮次/条」计数，而非 DB 原始行数。"""
    count = 0
    i = 0
    n = len(messages)
    while i < n:
        msg = messages[i]
        if is_context_injection_message(msg) or _is_turn_transparent_assistant(msg):
            i += 1
            continue
        if _is_countable_assistant(msg):
            count += 1
            i += 1
            while i < n:
                nxt = messages[i]
                if is_context_injection_message(nxt) or _is_turn_transparent_assistant(nxt):
                    i += 1
                    continue
                if _is_countable_assistant(nxt):
                    i += 1
                    continue
                break
            continue
        if is_regular_user_message(msg):
            count += 1
            i += 1
            continue
        # 伪用户 / system / 其它角色：不计
        i += 1
    return count


class _Row:
    __slots__ = ('role', 'message_kind', 'agent_run_id', 'text_summary', 'metadata')

    def __init__(self, row: dict) -> None:
        self.role = row.get('role') or ''
        self.message_kind = row.get('message_kind') or 'llm'
        self.agent_run_id = row.get('agent_run_id') or ''
        self.text_summary = row.get('text_summary') or ''
        self.metadata = row.get('metadata')


def count_semantic_messages_from_values(rows: Iterable[dict]) -> int:
    """dict 形态（rollback preview queryset .values()）的语义计数。"""
    ordered = sorted(
        rows,
        key=lambda row: (row.get('created_at'), str(row.get('id', ''))),
    )
    return count_semantic_messages([_Row(row) for row in ordered])


def is_context_injection_row(row: dict) -> bool:
    """dict 形态的 context_injection 判定，与 is_context_injection_message 同口径。

    回退预览列表（messages_preview）需与「将移除 N 条」的语义计数口径对齐：环境 /
    agent-profile 快照对用户不可见，不应出现在「将移除」列表里。
    """
    return is_context_injection_message(_Row(row))
