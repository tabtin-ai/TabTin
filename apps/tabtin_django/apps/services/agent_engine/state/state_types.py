"""
State TypedDict 分层定义 — orchestration 引擎状态的规范类型。

设计原则
--------
1. 每个 key 只出现在一个 TypedDict 子类中（单一归属）
2. 所有 TypedDict 使用 ``total=False``，保持向后兼容
3. 纯类型标注层面，**不改变运行时行为**
4. 子类通过多继承组合为完整的 ``FullEngineState``

分层
----
- **CoreState**:            业务核心状态，序列化/持久化到数据库
- **ContextState**:         请求上下文，由入口注入，运行期间大部分不变
- **EngineInternalState**:  引擎内部控制，不序列化，per-run 生命周期
- **SecurityState**:        安全/权限/委托/HITL 上下文
- **MetricsState**:         指标收集/计费/可观测性

与 ``orchestration.state.agent_state.AgentState`` 的关系
-------------------------------------------------------
``AgentState`` 是 ``create_initial_state()`` 的返回类型，涵盖序列化到 DB 的字段子集。
``FullEngineState`` 是运行时的完整超集，涵盖所有引擎内部、安全、指标字段。
两者并行使用：持久化入口用 ``AgentState``，引擎内部用 ``FullEngineState``。

与 ``StateIsolation`` / ``key_registry`` 的关系
------------------------------------------------
``StateIsolation`` 使用的三组 frozenset（UNCOPYABLE / SHALLOW_COPY / IMMUTABLE）
及并行合并集由 ``state/key_registry.py`` 统一声明式管理，本模块导出兼容常量。
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from typing_extensions import TypedDict


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  1. CoreState — 业务核心，序列化/持久化
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class CoreState(TypedDict, total=False):
    """业务核心状态。序列化到 ConversationState，跨 run 持久化。"""

    # ── 消息历史 ──
    messages: List[dict]

    # ── 输出 ──
    final_answer: str
    todos: Optional[List[Dict[str, Any]]]

    # ── 意图/模式 ──
    intent: Optional[str]
    agent_mode: Optional[str]          # ask / agent / plan / study / group

    # ── 对话摘要 ──
    conversation_summary: Optional[str]
    session_notes: Optional[str]       # Markdown 分节结构

    # ── 运行时语义 ──
    status: Optional[str]              # running / waiting_for_input / completed / error
    next: Optional[str]                # 路由控制
    pause_reason: Optional[str]
    error: Optional[str]
    is_last_step: bool

    # ── ReAct 轨迹 ──
    react_trace: List[Dict[str, Any]]
    react_step_index: int
    react_trace_cursor: int

    # ── 文档引用（工具副作用） ──
    pending_document_refs: Optional[List[dict]]

    # ── 控制信号（跨 run 可持久化） ──
    __force_final__: bool              # 强制输出当前内容为 final_answer
    __interrupt__: Optional[list]      # HITL 中断载荷


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  2. ContextState — 请求上下文，入口注入，运行期大部分不变
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class ContextState(TypedDict, total=False):
    """请求上下文。由 create_initial_state 注入。

    大部分字段在单次 run 内不变，但 model_id 可被引擎修改。
    """

    # ── 用户身份 ──
    thread_id: str
    user_id: str
    identity_user_id: Optional[str]    # 外部可达 identity（Phase 1 = user_id）
    organization_id: str
    session_id: str
    identity_kind: Optional[str]       # user / api_token / ...

    # ── 模型/客户端 ──
    model_id: Optional[str]            # 模型 UUID；可被引擎 fallback 修改
    model_name: Optional[str]          # 已废弃，兼容保留
    client_type: Optional[str]         # electron / ios / android / web / server / channel / daemon
    agent_name: Optional[str]          # 解析后的 agent 名

    # ── App 上下文（per-app 字段由 app_registry manifest 驱动） ──
    current_app_type: Optional[str]
    current_space_id: Optional[str]
    current_project_id: Optional[str]
    current_table_id: Optional[str]
    current_view_id: Optional[str]
    current_doc_id: Optional[str]
    current_doc_title: Optional[str]
    current_slide_id: Optional[str]
    current_slide_title: Optional[str]
    current_video_id: Optional[str]
    current_video_title: Optional[str]
    current_video_playhead: Optional[str]
    current_video_scene_id: Optional[str]
    current_video_canvas_size: Optional[str]
    current_video_duration: Optional[str]
    current_canvas_id: Optional[str]
    current_canvas_title: Optional[str]
    current_memo_id: Optional[str]
    current_memo_title: Optional[str]
    current_site_id: Optional[str]
    current_site_title: Optional[str]
    current_browser_url: Optional[str]
    current_browser_title: Optional[str]
    current_terminal_cwd: Optional[str]
    current_code_project_path: Optional[str]
    current_code_file: Optional[str]
    current_git_branch: Optional[str]
    current_git_changed_files: Optional[str]
    current_device_id: Optional[str]

    # ── 三类目录 ──
    agent_dir: Optional[str]
    code_project_path: Optional[str]
    workspace_root: Optional[str]
    user_folders: Optional[List[str]]

    # ── UI 状态 ──
    open_tabs: Optional[List[Dict[str, Any]]]
    open_app_types: Optional[List[str]]
    recent_tables: List[str]
    recent_spaces: List[str]
    recent_views: List[str]

    # ── 执行配置 ──
    execution_profile: Optional[str]   # conversational / task / oneshot
    group_runtime: Optional[Dict[str, Any]]
    group_runtime_result: Optional[Dict[str, Any]]

    # ── Channel 上下文（CD-008） ──
    channel_sender_id: Optional[str]
    channel_sender_name: Optional[str]
    channel_name: Optional[str]
    channel_peer_kind: Optional[str]   # dm / group

    # ── 跨系统身份 ──
    _execution_agent_id: Optional[str]
    _owner_user_id_for_provider: Optional[str]
    _origin_user_id: Optional[str]
    _origin_organization_id: Optional[str]

    # ── Agent 配置 ──
    agent_config: Optional[Dict[str, Any]]  # Space.agent.agent_config，hooks/sandbox/memory 等

    # ── Legacy 兼容 ──
    configurable: Optional[Dict[str, Any]]  # 遗留字段
    context: Optional[Dict[str, Any]]       # 旧版上下文透传


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  3. EngineInternalState — 引擎内部控制，不序列化
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class EngineInternalState(TypedDict, total=False):
    """引擎内部控制状态。不序列化，per-run 生命周期。

    W11 精简：移除已删除的 ReAct 循环、中间件、内存管道、
    Doom Loop 等子系统的内部追踪字段。保留有活跃消费方的字段。
    """

    # ── 运行生命周期 ──
    run_id: Optional[str]
    trace_id: Optional[str]
    _current_iteration: int
    _is_resuming: bool
    _version: Optional[int]           # ConversationState 乐观锁版本

    # ── 执行上下文 ──
    _execution_context: Any           # ExecutionContext dataclass

    # ── 模型 fallback ──
    _model_downgrade_locked: bool
    _fallback_model_id: Optional[str]
    _user_selected_model: Optional[bool]

    # ── 工具状态（活跃消费方） ──
    _tool_result_store: dict          # tool_call_id → content
    _tool_params: Optional[dict]
    _tool_permissions: Optional[Dict[str, Any]]
    _pending_tool_activations: Optional[list]  # side_effect / tool_search 声明式激活意图
    _skills_cache: Any

    # ── Fork / 子 Agent ──
    _fork_system_prompt: Optional[str]
    _fork_parent_thread_id: Optional[str]
    parent_thread_id: Optional[str]
    thinking_level: Optional[str]
    requester_origin: Optional[str]
    allowed_tools: Optional[list]
    _agent_workspace: Optional[str]
    _sibling_agent_workspaces: Optional[list]
    subagent_run_id: Optional[str]

    # ── 调试 ──
    _debug_mode: bool
    _pg_persist_failed: bool
    _vision_content_dropped: bool

    # ── 其他内部标志 ──
    _active_app_types: Optional[list]   # 解析后的活跃 App
    app_id: Optional[str]
    _space_snapshot: Any
    llm_error_retry_attempt: int

    # ──────────────────────────────────────────────────
    #  上下文压缩（Compaction）— 顶层状态
    # ──────────────────────────────────────────────────
    compaction_directive: Optional[str]     # none / auto_condense / summarize
    compaction_force: bool
    compaction_reason: Optional[str]        # context_overflow / llm_error / model_fallback
    compaction_attempt: int
    compaction_snapshot: Any
    compaction_emergency_keep: Optional[int]
    compaction_events: list
    compaction_last: Optional[dict]

    # ──────────────────────────────────────────────────
    #  上下文压力（Context Pressure）
    # ──────────────────────────────────────────────────
    context_pressure: Optional[dict]
    context_pressure_level: Optional[str]   # low / medium / high / critical
    context_estimated_tokens: int
    context_window_tokens: Optional[int]

    # ──────────────────────────────────────────────────
    #  工具域 & 迭代
    # ──────────────────────────────────────────────────
    _active_tool_domains: Optional[list]
    tool_domains: Optional[list]
    _react_iteration: int


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  4. SecurityState — 安全/权限/委托/HITL
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class SecurityState(TypedDict, total=False):
    """安全与权限上下文。由请求入口注入，不序列化。"""

    # ── 授权规则 ──
    _authorization_rules: Optional[Dict[str, Any]]
    _authorization_rules_locked: Optional[bool]
    _sandbox_config: Optional[Dict[str, Any]]

    # ── 设备能力 ──
    _device_capabilities: Optional[Dict[str, Any]]
    _device_online: Optional[bool]
    _device_name: Optional[str]
    _device_fingerprint: Optional[str]
    _device_os_info: Optional[str]

    # ── 远程资源 ──
    _remote_git_status: Optional[Dict[str, Any]]
    _remote_servers: Optional[List[Dict[str, Any]]]

    # ── 授权上下文 ──
    _subagent_deny_tools: Optional[list]
    _api_token_space_ids: Optional[list]

    # ── HITL（Human-in-the-Loop） ──
    _hitl_interrupted_at: Any
    _hitl_authenticated_user_id: Optional[str]
    _channel_cautious_locked: bool

    # ── 权限缓存 ──
    _permission_decisions: Optional[dict]
    _permission_cache: Optional[dict]


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  5. MetricsState — 指标收集/计费/可观测性
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class MetricsState(TypedDict, total=False):
    """指标收集与计费状态。部分字段可选持久化。"""

    # ── 累计用量 ──
    usage: Optional[dict]              # agent_engine 累计 LLM usage
    token_usage: Optional[dict]        # token_usage 中间件累计
    run_cost_usd: Optional[float]

    # ── 最近一次 LLM 调用 ──
    _last_llm_usage: Optional[dict]

    # ── 中间件性能 ──
    _middleware_timing: Optional[dict]

    # ── 计费身份 ──

    # ── 计费控制 ──
    _current_freeze_id: Optional[str]
    _current_freeze_organization_id: Optional[str]
    _consecutive_charge_failures: int

    # ── Trace 标识 ──
    instance_id: Optional[str]


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  组合类型
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class FullEngineState(
    CoreState,
    ContextState,
    EngineInternalState,
    SecurityState,
    MetricsState,
):
    """完整引擎状态 — 五层 TypedDict 的联合类型。

    运行时仍以 ``dict`` 传递，此类型仅用于静态分析和文档化。
    """


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  行为元数据集合 — 由 State Key Registry 统一派生
#
#  所有 state key 的行为元数据（是否持久化、是否可拷贝、是否不可变、
#  并行合并策略等）在 state/key_registry.py 中声明式注册。
#  此处导出的 frozenset 由 registry 自动生成，保持向后兼容的导出名。
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

from apps.services.agent_engine.state.key_registry import (
    uncopyable_keys as _reg_uncopyable,
    shallow_copy_keys as _reg_shallow,
    immutable_keys as _reg_immutable,
    parallel_mutable_dict_keys as _reg_par_dict,
    parallel_mutable_list_keys as _reg_par_list,
    parallel_all_mutable_keys as _reg_par_all,
)

UNCOPYABLE_KEYS: frozenset[str] = _reg_uncopyable()
SHALLOW_COPY_KEYS: frozenset[str] = _reg_shallow()
IMMUTABLE_KEYS: frozenset[str] = _reg_immutable()
PARALLEL_MUTABLE_DICT_KEYS: frozenset[str] = _reg_par_dict()
PARALLEL_MUTABLE_LIST_KEYS: frozenset[str] = _reg_par_list()
PARALLEL_ALL_MUTABLE_KEYS: frozenset[str] = _reg_par_all()


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  动态工具状态代理
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


class _DynToolsProxy:
    """Proxy for dynamic tool state stored inside the engine state dict."""

    __slots__ = ("_state",)

    def __init__(self, state: dict):
        self._state = state

    @property
    def tool_params(self) -> Optional[dict]:
        return self._state.get("_tool_params")

    @tool_params.setter
    def tool_params(self, value: Optional[dict]):
        self._state["_tool_params"] = value

    @property
    def pending_activations(self) -> list:
        lst = self._state.get("_pending_tool_activations")
        if lst is None:
            lst = []
            self._state["_pending_tool_activations"] = lst
        return lst


def get_dyn_tools(state: dict) -> _DynToolsProxy:
    """Return a proxy to read/write dynamic tool state fields."""
    return _DynToolsProxy(state)


__all__ = [
    "CoreState",
    "ContextState",
    "EngineInternalState",
    "SecurityState",
    "MetricsState",
    "FullEngineState",
    "UNCOPYABLE_KEYS",
    "SHALLOW_COPY_KEYS",
    "IMMUTABLE_KEYS",
    "PARALLEL_MUTABLE_DICT_KEYS",
    "PARALLEL_MUTABLE_LIST_KEYS",
    "PARALLEL_ALL_MUTABLE_KEYS",
    "get_dyn_tools",
]
