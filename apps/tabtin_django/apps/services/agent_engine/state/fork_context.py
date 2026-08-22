"""
Fork Context — state_json 清理（用户级 Fork Chat）

子 Agent fork 上下文构造已下沉到 ``packages/agent-runtime/src/engine/fork-query.ts``；
本模块仅保留 Django 侧复制 PG ConversationState 时清理 state_json 的 helper。
"""

from __future__ import annotations

from typing import Any, Dict

from apps.services.agent_engine.state.key_registry import fork_excluded_keys as _get_fork_excluded

_FORK_EXCLUDED_STATE_KEYS: frozenset[str] = _get_fork_excluded()


def clean_state_for_fork(state_json: Dict[str, Any]) -> Dict[str, Any]:
    """清理 state_json 中不应继承到 fork session 的字段。"""
    if not state_json:
        return {}
    return {k: v for k, v in state_json.items() if k not in _FORK_EXCLUDED_STATE_KEYS}
