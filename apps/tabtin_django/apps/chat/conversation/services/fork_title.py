"""Fork 会话标题：数字编号占位（替代历史 ``(fork)`` 后缀）。"""

from __future__ import annotations

import re
from typing import Optional

from django.db.models import Q

# 剥掉历史 ``(fork)`` 与已有 `` 数字`` 后缀，得到家族基础名
_FORK_TITLE_SUFFIX_RE = re.compile(r"(?:\s+\d+|\s*\(fork\))+$", re.IGNORECASE)


def fork_title_base(title: Optional[str]) -> str:
    base = (title or "").strip() or "Chat"
    while True:
        stripped = _FORK_TITLE_SUFFIX_RE.sub("", base).strip()
        if stripped == base:
            break
        base = stripped
    return base or "Chat"


def resolve_fork_family_root(session):
    """沿 forked_from_id 走到列表族根（无父或父不在库中时停）。"""
    from ..models import ChatSession

    current = session
    seen: set[str] = set()
    while current.forked_from_id and str(current.forked_from_id) not in seen:
        seen.add(str(current.id))
        parent = (
            ChatSession.objects.filter(id=current.forked_from_id)
            .only("id", "forked_from_id", "title")
            .first()
        )
        if not parent:
            break
        current = parent
    return current


def allocate_fork_session_title(*, source_session, user) -> str:
    """为新 fork 分配 ``{根标题} {n}``，n 从 2 起在同 Workspace / 用户下递增。

    调用方必须已在 ``transaction.atomic()`` 内。对家族根行
    ``select_for_update``，串行同族并发 fork，避免撞同一 ``n``。
    """
    from ..models import ChatSession

    root = resolve_fork_family_root(source_session)
    # 锁族根：并发 fork 同一家族时串行分配编号
    locked = (
        ChatSession.objects.select_for_update()
        .filter(id=root.id)
        .only("id", "title", "forked_from_id", "workspace_id")
        .first()
    )
    if locked is not None:
        root = locked

    base = fork_title_base(root.title)
    numbered_re = re.compile(rf"^{re.escape(base)} (\d+)$")

    max_n = 1
    for title in ChatSession.objects.filter(
        workspace_id=source_session.workspace_id,
        user=user,
    ).filter(
        Q(title__regex=rf"^{re.escape(base)} \d+$")
        | Q(id=root.id)
    ).values_list("title", flat=True):
        match = numbered_re.match(title or "")
        if match:
            max_n = max(max_n, int(match.group(1)))

    return f"{base} {max_n + 1}"


def is_fork_numbered_placeholder(title: Optional[str]) -> bool:
    """标题是否形如 fork 数字编号或历史 ``(fork)`` 后缀。

    仅用于标题形态识别 / 测试；自动重命名门槛见
    ``TitleGeneratorService.is_fork_title_pending``（血缘 + pending）。
    """
    text = (title or "").strip()
    if not text:
        return False
    if re.search(r"\(fork\)\s*$", text, re.IGNORECASE):
        return True
    return bool(re.search(r"\s+\d+$", text))
