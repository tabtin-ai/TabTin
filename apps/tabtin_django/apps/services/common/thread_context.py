"""
Thread context - 运行时上下文管理

在单次 Agent 运行周期内，跨节点和工具共享线程级上下文。
管理 thread_id、space_id、workspace_root、cancel_event 等
ContextVar，兼容同步与异步执行环境。

包含的上下文变量：
- thread_id: 会话 ID
- space_id / organization_id / user_id: 身份与归属
- workspace_root / agent_workspace: 文件系统隔离
- execution_agent_id / identity_user_id: 执行身份
- execution_context / subagent_tool_policy: 运行时策略
- cancel_event: 取消信号
- owner_user_id_for_provider: LLM Provider 路由扩展可见性
- sibling_agent_workspaces: 跨 Agent 写入防护

Migration note:
    从 orchestration.context.thread_context 迁移而来，
    原模块保留 re-export 以兼容 orchestration 内部引用。
"""

from __future__ import annotations

import threading
from contextvars import ContextVar, Token
from typing import Any, Optional


_thread_id_var: ContextVar[Optional[str]] = ContextVar("thread_id", default=None)
_cancel_event_var: ContextVar[Optional[threading.Event]] = ContextVar("cancel_event", default=None)
_workspace_root_var: ContextVar[Optional[str]] = ContextVar("workspace_root", default=None)
_space_id_var: ContextVar[Optional[str]] = ContextVar("space_id", default=None)
_execution_agent_id_var: ContextVar[Optional[str]] = ContextVar("execution_agent_id", default=None)
_identity_user_id_var: ContextVar[Optional[str]] = ContextVar("identity_user_id", default=None)
_subagent_tool_policy_var: ContextVar[Any] = ContextVar("subagent_tool_policy", default=None)
_execution_context_var: ContextVar[Any] = ContextVar("execution_context", default=None)
_user_id_var: ContextVar[Optional[str]] = ContextVar("user_id", default=None)
_organization_id_var: ContextVar[Optional[str]] = ContextVar("organization_id", default=None)
# 当前 Agent 的独占工作目录（per-agent 隔离）。
# 当前仅由 parallel_subagent_tool 分配，未来可用于设置子 Agent 终端 CWD。
_agent_workspace_var: ContextVar[Optional[str]] = ContextVar("agent_workspace", default=None)
# 兄弟 Agent 的工作目录列表，用于生成 deny_write_paths 防止跨 Agent 写入。
_sibling_agent_workspaces_var: ContextVar[Optional[list]] = ContextVar("sibling_agent_workspaces", default=None)
# 可选 owner user_id override，供 LLM Provider 路由将指定用户的
# scope=user 渠道纳入可见范围。
_owner_user_id_for_provider_var: ContextVar[Optional[str]] = ContextVar("owner_user_id_for_provider", default=None)
# 路径权限治理 Wave 4：当前 chat 链路上传的 v3 WorkspaceSnapshot（dict 形态）。
#
# 来源：chat.send_message handler 收到的 app_context.workspace_snapshot，由
# AgentDispatcher 转发给 PromptForwardService（已通）—— 本 ContextVar 让
# FrontendActionService._resolve_sandbox_policy 在 publish_action 时也能
# 读到同一份 SSoT，让云端 Django sandbox 决策与本地 Daemon/Electron 走同一
# 工作区语义（修 01 图谱 §断层 6 "Django SandboxPolicyResolver 没有
# workspace_snapshot 概念"）。
#
# 安全设计（Wave 4 用户视角 Review · P0 修复）：
#   存 `(thread_id, snapshot)` 元组而非裸 snapshot —— daphne / celery prefork
#   worker 复用线程会让 ContextVar 残留到下一个请求，单存 snapshot 则下一个
#   user 读到的是上一个 user 的工作区授权（真实越权）。caller 取 snapshot 时
#   必须用 `get_current_workspace_snapshot(expected_thread_id=...)` 做交叉
#   校验，thread_id mismatch → 视为残留 → 返回 None（与 `_authorization_rules_ctx`
#   的 thread_id 校验同模式，CA-007 同款治理）。
#
# 形态对应 TS 端 `@tabtin/security-policy` 的 `WorkspaceSnapshot`；至少含
# `allowedPaths: list[str]`，sandbox_policy.py 内部用 _normalize_path 比较。
_workspace_snapshot_var: ContextVar[Optional[tuple]] = ContextVar(
    "workspace_snapshot", default=None
)

# PR4-yolo (PRD v3 §5.6 Daemon 路径 / §5.4.2 wire 字段透传)：当前 chat 请求的
# AgentMode（来自消息 body.agent_mode）。
#
# 为什么需要 ContextVar：
#   `FrontendActionService._resolve_sandbox_policy` 在 publish_action 时被
#   每个工具调用（Daemon 工具执行）走一次；它只能拿到工具 params（文件路径
#   等），拿不到 LLM 任务级的 AgentMode。如果不存 ContextVar，sandbox_policy
#   永远没法落 PRD §5.6 "Daemon 路径"图谱里的 `requested_agent_mode` 入参。
#
# 安全设计（与 workspace_snapshot 同模式，CA-007 同款治理）：
#   存 `(thread_id, agent_mode)` 元组而非裸字符串——daphne / celery prefork
#   worker 复用线程会让 ContextVar 残留到下一个请求，单存字符串则下一个
#   user 读到的是上一个 user 的 AgentMode（伪 yolo 越权）。caller 必须用
#   `get_current_agent_mode(expected_thread_id=...)` 做交叉校验，mismatch 视为
#   残留 → 返回 None → 下游 SandboxPolicyResolver fail-safe 走 'agent' / collaborative。
#
# 谁来设：chat_send_message handler 接收 payload.agent_mode 时，与 thread_id
# 配对 set。LLM 任务结束时 try/finally reset。
# 谁来读：FrontendActionService._resolve_sandbox_policy（PR0 改完入参后
# 透给 SandboxPolicyResolver.from_agent_config(requested_agent_mode=...)）。
#
# 形态对应 TS 端 `AgentModeName` union；至少含 'yolo' / 'agent' / 'plan' / 'ask' /
# 'study' / 'group'，但 ContextVar 不做白名单校验，由下游 SandboxPolicyResolver
# 在落 policy 时做兜底（非法 mode → fail-safe 'agent'）。
_agent_mode_var: ContextVar[Optional[tuple]] = ContextVar(
    "agent_mode", default=None
)


def set_current_thread_id(thread_id: str | None) -> Token:
    """
    设置当前上下文的 thread_id

    Args:
        thread_id: 会话 ID（None 表示清除）

    Returns:
        Token，可用于 reset 还原
    """
    return _thread_id_var.set(thread_id)


def get_current_thread_id() -> str | None:
    """
    获取当前上下文的 thread_id

    Returns:
        thread_id 或 None
    """
    return _thread_id_var.get()


def is_subagent_thread_id(thread_id: str | None) -> bool:
    if not thread_id:
        return False
    return "-sub-" in thread_id


def is_subagent_context() -> bool:
    return is_subagent_thread_id(get_current_thread_id())


def set_subagent_tool_policy(policy: Any) -> Token:
    return _subagent_tool_policy_var.set(policy)


def get_subagent_tool_policy() -> Any:
    return _subagent_tool_policy_var.get()


def set_current_execution_context(ctx: Any) -> Token:
    return _execution_context_var.set(ctx)


def get_current_execution_context() -> Any:
    return _execution_context_var.get()


def set_current_workspace_root(root: str | None) -> Token:
    return _workspace_root_var.set(root)


def get_current_workspace_root() -> str | None:
    return _workspace_root_var.get()


def set_current_workspace_snapshot(
    thread_id: Optional[str], snapshot: Optional[dict]
) -> Token:
    """路径权限治理 Wave 4：设置当前 chat 链路的 (thread_id, snapshot) 元组。

    由 chat.send_message / AgentDispatcher.dispatch_external / forward_runner
    在 LLM 任务起跑前调用；caller 必须用 try/finally + Token.reset 在任务
    收尾时清理，避免 daphne / celery prefork worker 复用线程时 ContextVar
    残留到下一个请求（CA-007 同款治理）。

    `thread_id` 缺省（None）：清空。`snapshot` 缺省也清空。
    """
    if thread_id is None or snapshot is None:
        return _workspace_snapshot_var.set(None)
    return _workspace_snapshot_var.set((thread_id, snapshot))


def get_current_workspace_snapshot(
    expected_thread_id: Optional[str] = None,
) -> Optional[dict]:
    """读取当前 chat 链路的 workspace snapshot（路径权限治理 Wave 4）。

    `expected_thread_id` 提供时做 thread_id 交叉校验：mismatch 视为
    上一次请求的残留，返回 None。强烈建议 caller 显式传 expected_thread_id
    避免 fail-open（与 `_authorization_rules_ctx` thread_id 校验同模式）。
    """
    raw = _workspace_snapshot_var.get()
    if raw is None:
        return None
    if not isinstance(raw, tuple) or len(raw) != 2:
        return None
    stored_thread_id, snapshot = raw
    if expected_thread_id is not None and stored_thread_id != expected_thread_id:
        return None
    if not isinstance(snapshot, dict):
        return None
    return snapshot


def reset_current_workspace_snapshot(token: Token) -> None:
    """与 set_current_workspace_snapshot 配对，try/finally 收尾时调用。"""
    _workspace_snapshot_var.reset(token)


def set_current_agent_mode(
    thread_id: Optional[str], agent_mode: Optional[str]
) -> Token:
    """PR4-yolo (PRD v3 §5.6)：设置当前 chat 链路的 (thread_id, agent_mode)。

    由 chat.send_message / chat_service 在 LLM 任务起跑前调用；caller 必须用
    try/finally + Token.reset 在任务收尾时清理，避免 daphne / celery prefork
    worker 复用线程时 ContextVar 残留到下一个请求。

    `thread_id` 缺省（None）或 `agent_mode` 缺省时清空（None）。
    """
    if thread_id is None or agent_mode is None:
        return _agent_mode_var.set(None)
    return _agent_mode_var.set((thread_id, agent_mode))


def get_current_agent_mode(
    expected_thread_id: Optional[str] = None,
) -> Optional[str]:
    """读取当前 chat 链路的 agent_mode（PR4-yolo PRD v3 §5.6）。

    `expected_thread_id` 提供时做 thread_id 交叉校验：mismatch 视为上一次
    请求的残留，返回 None。强烈建议 caller 显式传 expected_thread_id 避免
    fail-open（与 `_workspace_snapshot_var` 同模式）。
    """
    raw = _agent_mode_var.get()
    if raw is None:
        return None
    if not isinstance(raw, tuple) or len(raw) != 2:
        return None
    stored_thread_id, agent_mode = raw
    if expected_thread_id is not None and stored_thread_id != expected_thread_id:
        return None
    if not isinstance(agent_mode, str):
        return None
    return agent_mode


def reset_current_agent_mode(token: Token) -> None:
    """与 set_current_agent_mode 配对，try/finally 收尾时调用。"""
    _agent_mode_var.reset(token)


# ── forward/设备路径的 agent_mode 跨边界透传（Redis，按 thread_id）─────────────
#
# 背景（无人值守第三类挂死根因）：`_agent_mode_var`（上面的 ContextVar）只在**设置它
# 的那个线程/异步上下文**里可见。`forward_runner` 在 **celery 任务线程**里 set 它，但
# 设备 Electron/Daemon 执行 `browser.open` 等 frontend action 时，动作经 WS 回到
# Django 的 **Channels consumer 线程**走 `FrontendActionService._resolve_sandbox_policy`
# —— 那是**另一个线程**，ContextVar 取不到 → 回落 'agent' → 高危前端动作即使在
# 无人值守 yolo 任务下也弹审批（实测 browser.open risk=write 弹「Agent 操作审批」）。
#
# 解法：forward 起跑时把 agent_mode 按 thread_id 写进 Redis（**服务端可信源**，
# 非 LLM 可控 params），publish_action 决策点在 ContextVar 取空时回落读它。Redis
# 跨线程/跨进程共享，天然补上 ContextVar 的边界缺口。key 按 thread_id 隔离 + 调用方
# 显式传 thread_id 读取，无 prefork 残留串台风险（与 ContextVar 的 expected_thread_id
# 校验同等安全）。**仅承载「请求档」**：真实 yolo 闸门仍由 SandboxPolicyResolver
# 读 agent_config.allow_yolo_mode 决定，本值只补 requested_agent_mode 入参。
_FORWARD_AGENT_MODE_KEY_PREFIX = "forward:agent_mode:"


def set_forward_agent_mode(thread_id: str, agent_mode: str, timeout_seconds: int) -> None:
    """forward_runner 起跑时写入（按 thread_id）。失败静默——审批回落 'agent' 是安全侧。"""
    if not thread_id or not agent_mode:
        return
    try:
        from django.core.cache import cache
        cache.set(f"{_FORWARD_AGENT_MODE_KEY_PREFIX}{thread_id}", agent_mode, timeout=timeout_seconds)
    except Exception:
        pass


def get_forward_agent_mode(thread_id: str) -> Optional[str]:
    """publish_action 决策点回落读取（ContextVar 取空时）。失败 / 缺省 → None。"""
    if not thread_id:
        return None
    try:
        from django.core.cache import cache
        val = cache.get(f"{_FORWARD_AGENT_MODE_KEY_PREFIX}{thread_id}")
        return val if isinstance(val, str) and val else None
    except Exception:
        return None


def clear_forward_agent_mode(thread_id: str) -> None:
    """forward_runner 收尾时清理（finally）。"""
    if not thread_id:
        return
    try:
        from django.core.cache import cache
        cache.delete(f"{_FORWARD_AGENT_MODE_KEY_PREFIX}{thread_id}")
    except Exception:
        pass


def set_current_space_id(space_id: str | None) -> Token:
    return _space_id_var.set(space_id)


def get_current_space_id() -> str | None:
    return _space_id_var.get()


def set_current_execution_agent_id(agent_id: str | None) -> Token:
    return _execution_agent_id_var.set(agent_id)


def get_current_execution_agent_id() -> str | None:
    return _execution_agent_id_var.get()


def set_current_identity_user_id(user_id: str | None) -> Token:
    return _identity_user_id_var.set(user_id)


def get_current_identity_user_id() -> str | None:
    return _identity_user_id_var.get()


def set_current_user_id(user_id: str | None) -> Token:
    return _user_id_var.set(user_id)


def get_current_user_id() -> str | None:
    return _user_id_var.get()


def set_current_organization_id(organization_id: str | None) -> Token:
    return _organization_id_var.set(organization_id)


def get_current_organization_id() -> str | None:
    return _organization_id_var.get()


def set_current_agent_workspace(workspace: str | None) -> Token:
    return _agent_workspace_var.set(workspace)


def get_current_agent_workspace() -> str | None:
    return _agent_workspace_var.get()


def set_current_sibling_agent_workspaces(workspaces: list | None) -> Token:
    return _sibling_agent_workspaces_var.set(workspaces)


def get_current_sibling_agent_workspaces() -> list | None:
    return _sibling_agent_workspaces_var.get()


def set_owner_user_id_for_provider(user_id: str | None) -> Token:
    return _owner_user_id_for_provider_var.set(user_id)


def get_owner_user_id_for_provider() -> str | None:
    return _owner_user_id_for_provider_var.get()


def set_current_cancel_event(event: threading.Event | None) -> Token:
    return _cancel_event_var.set(event)


def get_current_cancel_event() -> threading.Event | None:
    return _cancel_event_var.get()


def clear_context():
    """清除当前上下文（重置为默认值）"""
    _thread_id_var.set(None)
    _workspace_root_var.set(None)
    _space_id_var.set(None)
    _execution_agent_id_var.set(None)
    _identity_user_id_var.set(None)
    _subagent_tool_policy_var.set(None)
    _execution_context_var.set(None)
    _user_id_var.set(None)
    _organization_id_var.set(None)
    _agent_workspace_var.set(None)
    _sibling_agent_workspaces_var.set(None)
    _owner_user_id_for_provider_var.set(None)
    _cancel_event_var.set(None)
    # 路径权限治理 Wave 4 P1-4 修复：reset workspace_snapshot 避免 prefork
    # worker 残留串台
    _workspace_snapshot_var.set(None)
    # PR4-yolo (PRD v3 §5.6)：同模式 reset agent_mode 避免残留越权（伪 yolo）
    _agent_mode_var.set(None)


__all__ = [
    "_thread_id_var",
    "_cancel_event_var",
    "_workspace_root_var",
    "_space_id_var",
    "_execution_agent_id_var",
    "_identity_user_id_var",
    "_subagent_tool_policy_var",
    "_execution_context_var",
    "_user_id_var",
    "_organization_id_var",
    "_agent_workspace_var",
    "_sibling_agent_workspaces_var",
    "_owner_user_id_for_provider_var",
    "set_current_thread_id",
    "get_current_thread_id",
    "is_subagent_thread_id",
    "is_subagent_context",
    "set_current_execution_context",
    "get_current_execution_context",
    "set_current_workspace_root",
    "get_current_workspace_root",
    "set_current_space_id",
    "get_current_space_id",
    "set_current_execution_agent_id",
    "get_current_execution_agent_id",
    "set_current_identity_user_id",
    "get_current_identity_user_id",
    "set_subagent_tool_policy",
    "get_subagent_tool_policy",
    "set_current_user_id",
    "get_current_user_id",
    "set_current_organization_id",
    "get_current_organization_id",
    "set_current_agent_workspace",
    "get_current_agent_workspace",
    "set_current_sibling_agent_workspaces",
    "get_current_sibling_agent_workspaces",
    "set_owner_user_id_for_provider",
    "get_owner_user_id_for_provider",
    "set_current_cancel_event",
    "get_current_cancel_event",
    "clear_context",
    # 路径权限治理 Wave 4：v3 WorkspaceSnapshot 跨 chat 链路传递
    "_workspace_snapshot_var",
    "set_current_workspace_snapshot",
    "get_current_workspace_snapshot",
    "reset_current_workspace_snapshot",
    # PR4-yolo (PRD v3 §5.6)：当前 chat 的 AgentMode 跨 chat 链路传递。
    # 由 chat_send_message 在拿到 payload.agent_mode 后 set；由
    # FrontendActionService._resolve_sandbox_policy 在 publish_action 时
    # 读出来透给 SandboxPolicyResolver.from_agent_config(requested_agent_mode=...)。
    "_agent_mode_var",
    "set_current_agent_mode",
    "get_current_agent_mode",
    "reset_current_agent_mode",
]
