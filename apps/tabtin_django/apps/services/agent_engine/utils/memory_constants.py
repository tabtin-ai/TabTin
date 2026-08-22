"""
Agent 记忆系统共享常量。

统一维护 legacy 类型映射、有效类型集合、注入 slot key 等，避免多处重复定义。
"""

from __future__ import annotations

import logging
from typing import Dict, Optional

logger = logging.getLogger(__name__)

# Agent 可写入的 memory_type 集合（：已迁出 TabMemo，与 AgentMemory.MemoType 对齐）
AGENT_MEMO_TYPES = frozenset({"about_you", "insight", "task_summary", "diary"})
# 兼容旧别名（曾挂在 tabmemo.constants）
AGENT_MEMORY_MEMO_TYPES = AGENT_MEMO_TYPES

# 旧中文类型 → 新 memo_type 映射
LEGACY_TYPE_MAP: Dict[str, str] = {
    "事实": "about_you",
    "偏好": "about_you",
    "经验": "insight",
    "洞察": "insight",
    "上下文": "about_you",
}

# ── 注入消息 slot 标识 ──
# 必须与 middleware/slots.py 中的 MSG_SLOT_KEY 保持一致
MSG_SLOT_KEY = "_msg_slot"
# 整数值，须在 SLOT_SYSTEM_PROMPT(0) 与 SLOT_CONTEXT(20) 之间
SLOT_MEMORY = 15
SLOT_PITFALL = 16

# ── 去重阈值 ──
# 此值作为 agent_config 未配置时的 fallback 默认值。
# 全局可调默认值通过 OrchestrationConfiguration.memory_dedup_threshold 管理，
# 但消费方优先读 per-agent 的 observer_config.dedup_threshold。
DEFAULT_DEDUP_THRESHOLD = 0.85

# ── Token 估算常量 ──
CHARS_PER_TOKEN_CJK = 1.5   # CJK 字符：约 1–2 token/字
CHARS_PER_TOKEN_EN = 4.0    # 英文/ASCII：约 4 chars/token
CHARS_PER_TOKEN = 2.5       # 中英混合 fallback（向后兼容）


def _cjk_ratio(text: str) -> float:
    """返回文本中 CJK 字符的比例（0.0–1.0）。"""
    if not text:
        return 0.0
    cjk = sum(
        1 for ch in text
        if '\u4e00' <= ch <= '\u9fff'
        or '\u3400' <= ch <= '\u4dbf'
        or '\uf900' <= ch <= '\ufaff'
        or '\U00020000' <= ch <= '\U0002a6df'
        or '\u3000' <= ch <= '\u303f'
        or '\uff00' <= ch <= '\uffef'
    )
    return cjk / len(text)


def estimate_chars_per_token(text: str) -> float:
    """根据 CJK 比例动态估算每 token 对应的字符数。

    与 context_pruning/utils.py 中的同名函数逻辑一致，供记忆模块复用。
    """
    ratio = _cjk_ratio(text)
    return CHARS_PER_TOKEN_CJK * ratio + CHARS_PER_TOKEN_EN * (1.0 - ratio)


def estimate_tokens(text: str) -> int:
    """估算文本的 token 数（语言感知）。"""
    if not text:
        return 0
    cpt = estimate_chars_per_token(text)
    return max(1, int(len(text) / cpt)) if cpt > 0 else len(text)


def normalize_agent_memo_type(raw_type: str) -> str:
    """将旧类型名或新类型名统一为合法的 Agent memo_type。"""
    mapped = LEGACY_TYPE_MAP.get(raw_type, raw_type)
    return mapped if mapped in AGENT_MEMO_TYPES else "about_you"


# ── 统一数据库路由 QuerySet 工厂（ M4.5/C5：切独立 AgentMemory 表）──


def get_memo_queryset():
    """返回使用 TABMEMO_DB 正确路由的 **AgentMemory** 基础 QuerySet。

    历史命名保留（记忆系统全部调用方经此工厂）；分家拆表后指向独立的
    ``agent_memory_entry`` 表（``agent_memory`` 域），不再触碰用户笔记 Memo 表。
    用于按 ID 进行 update/archive 等不需要标准过滤条件的操作。

     W5：收口到 AgentMemory 领域仓储的唯一读写 seam。
    """
    from apps.agent_memory.repository import AgentMemoryRepository

    return AgentMemoryRepository.base_qs()


def get_agent_memo_queryset(space_id=None, agent_id=None):
    """返回预过滤的 Agent 记忆 QuerySet（正确路由 + status=ACTIVE）。

    ``space_id`` 兼容入参：内部经 space→执行 agent 解析后按 agent 过滤
    （记忆已挂 agent 维度）；解析不到 agent 时返回空集——绝不跨 agent
    泄漏。``agent_id`` 提供时直接按 agent 过滤（diary 等 Agent 维度视图）。
    两者都为 None 表示不加 agent 过滤（调用方自行圈定范围）。
    """
    from apps.agent_memory.models import AgentMemory

    qs = get_memo_queryset().filter(
        status=AgentMemory.Status.ACTIVE,
        forgotten_at__isnull=True,
    )
    if space_id is not None:
        resolved = resolve_space_execution_agent_id(space_id)
        if not resolved:
            return qs.none()
        qs = qs.filter(agent_id=resolved)
    if agent_id is not None:
        qs = qs.filter(agent_id=agent_id)
    return qs


def resolve_workspace_space_ids_for_agents(agent_ids) -> dict:
    """批量反查 agent → 最近使用的 workspace_id（dispatch 任务签名兼容）。

    ：Workspace 不再 1:1 挂 Agent。取每个 agent 最近一条
    ``ChatSession.workspace_id``；无会话则跳过。
    """
    if not agent_ids:
        return {}
    try:
        from apps.chat.conversation.models import ChatSession

        result = {}
        for agent_id in list(agent_ids):
            workspace_id = (
                ChatSession.objects.filter(
                    agent_id=agent_id,
                    workspace_id__isnull=False,
                )
                .order_by("-updated_at")
                .values_list("workspace_id", flat=True)
                .first()
            )
            if workspace_id:
                result[agent_id] = workspace_id
        return result
    except Exception as exc:
        logger.warning("[MemoryConstants] agent→workspace batch resolve failed: %s", exc)
        return {}


def resolve_space_execution_agent_id(space_id, thread_id=None) -> Optional[str]:
    """解析记忆归属的执行 agent_id。

    只认会话锚点：
    1. ``thread_id`` → ``ChatSession.agent_id``
    2. 否则 ``space_id``（实为 workspace_id）下最近会话的 ``agent_id``

    不再回退 ``Workspace.agent``（该 FK 已下线）。
    """
    if thread_id:
        try:
            from apps.chat.conversation.models import ChatSession

            session_agent_id = (
                ChatSession.objects.filter(thread_id=thread_id)
                .values_list("agent_id", flat=True)
                .first()
            )
            if session_agent_id:
                return str(session_agent_id)
        except Exception as exc:
            logger.warning(
                "[MemoryConstants] resolve session agent failed: thread=%s err=%s",
                thread_id, exc,
            )
    if not space_id:
        return None
    try:
        from apps.chat.conversation.models import ChatSession

        agent_id = (
            ChatSession.objects.filter(
                workspace_id=space_id,
                agent_id__isnull=False,
            )
            .order_by("-updated_at")
            .values_list("agent_id", flat=True)
            .first()
        )
        if agent_id:
            return str(agent_id)
    except Exception as exc:
        logger.warning(
            "[MemoryConstants] resolve execution agent failed: space=%s err=%s",
            space_id, exc,
        )
    return None
