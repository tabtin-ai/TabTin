"""
State Key Registry — orchestration state 的统一元数据声明。

将分散在多个文件中的硬编码 frozenset 统一到声明式注册表：
- persistence/conversation_store.py 中 ``_EXCLUDED_STATE_KEYS``
- engine/state_isolation.py 中 ``_UNCOPYABLE_STATE_KEYS`` / ``_SHALLOW_COPY_KEYS`` / ``_IMMUTABLE_STATE_KEYS``
- engine/state_types.py 中 ``PARALLEL_MUTABLE_DICT_KEYS`` / ``PARALLEL_MUTABLE_LIST_KEYS``
- state/fork_context.py 中 ``_FORK_EXCLUDED_STATE_KEYS``

每个 state key 的行为元数据只在此处声明一次（Single Source of Truth）。

消费方通过派生集合函数获取特定类别的 key 集合::

    from apps.services.agent_engine.state.key_registry import excluded_keys
    _EXCLUDED = excluded_keys()   # persist=False 的 key

设计原则
--------
- 遗漏一个 key 的注册 → 回退到安全默认值（persist/copyable/mutable 均为 True）
- 重复注册同一 key → 后注册覆盖前注册（便于中间件覆盖默认值）
- 动态注册线程安全
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Dict, Iterable


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  元数据定义
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


_VALID_PARALLEL_MERGE = frozenset({"none", "dict", "list"})


@dataclass(frozen=True)
class StateKeyMeta:
    """State key 的行为元数据。

    Attributes:
        persist: 是否写入 state_json（False → ConversationStore 排除）。
            ``messages`` 和 ``__interrupt__`` 有独立列，也标为 False。
        copyable: 是否可 deepcopy（False → 含线程锁/DB连接等运行时对象）。
        shallow_copy: 仅浅拷贝（True → 大列表，内部元素不修改）。
        immutable: 运行期不可变（True → StateIsolation 跳过拷贝和合并）。
        parallel_merge: 并行工具 state 合并策略：
            ``"none"`` — 标量/默认（由 ref-change 检测决定是否合并）
            ``"dict"`` — dict.update 合并
            ``"list"`` — append 新增元素
        fork_exclude: fork 子 Agent 时从 state_json 中排除。
    """
    persist: bool = True
    copyable: bool = True
    shallow_copy: bool = False
    immutable: bool = False
    parallel_merge: str = "none"
    fork_exclude: bool = False

    def __post_init__(self) -> None:
        if self.parallel_merge not in _VALID_PARALLEL_MERGE:
            raise ValueError(
                f"Invalid parallel_merge={self.parallel_merge!r}, "
                f"must be one of {_VALID_PARALLEL_MERGE}"
            )


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  注册表内部状态
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

_DEFAULT = StateKeyMeta()
_registry: Dict[str, StateKeyMeta] = {}
_derived_cache: Dict[str, frozenset] = {}
_lock = threading.Lock()


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  注册 API
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


def register_key(key: str, meta: StateKeyMeta) -> None:
    """注册或覆盖一个 state key 的元数据。"""
    with _lock:
        _registry[key] = meta
        _derived_cache.clear()


def register_transient_key(key: str, **overrides) -> None:
    """中间件/工具自注册临时 state key（persist=False）。

    **时序约束**：必须在消费方模块导入之前调用（即 startup-time），
    因为 ``state_types.py`` 等消费方在模块级别对派生集合做一次性快照。
    运行时（请求处理期间）调用此函数不会影响已快照的 frozenset。

    Example::

        register_transient_key("_my_middleware_cache", copyable=False)
    """
    import sys
    if "apps.services.agent_engine.engine.state_types" in sys.modules:
        import logging
        logging.getLogger(__name__).warning(
            "[StateKeyRegistry] register_transient_key('%s') called after "
            "state_types.py was imported — module-level frozenset snapshots "
            "will NOT include this key. Call before consumer modules load.",
            key,
        )
    register_key(key, StateKeyMeta(persist=False, **overrides))


def get_meta(key: str) -> StateKeyMeta:
    """获取 key 的元数据，未注册则返回安全默认值。"""
    return _registry.get(key, _DEFAULT)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  派生集合
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


def _ensure_derived() -> None:
    """延迟计算并缓存所有派生集合（double-checked locking）。"""
    if _derived_cache:
        return
    with _lock:
        if _derived_cache:
            return
        r = dict(_registry)
        cache: Dict[str, frozenset] = {}
        cache["excluded"] = frozenset(
            k for k, m in r.items() if not m.persist
        )
        cache["uncopyable"] = frozenset(
            k for k, m in r.items() if not m.copyable
        )
        cache["shallow_copy"] = frozenset(
            k for k, m in r.items() if m.shallow_copy
        )
        cache["immutable"] = frozenset(
            k for k, m in r.items() if m.immutable
        )
        cache["parallel_dict"] = frozenset(
            k for k, m in r.items() if m.parallel_merge == "dict"
        )
        cache["parallel_list"] = frozenset(
            k for k, m in r.items() if m.parallel_merge == "list"
        )
        cache["parallel_all"] = cache["parallel_dict"] | cache["parallel_list"]
        cache["fork_excluded"] = frozenset(
            k for k, m in r.items() if m.fork_exclude
        )
        _derived_cache.update(cache)


def excluded_keys() -> frozenset[str]:
    """persist=False 的 key — 替代 ``_EXCLUDED_STATE_KEYS``。"""
    _ensure_derived()
    return _derived_cache["excluded"]


def uncopyable_keys() -> frozenset[str]:
    """copyable=False 的 key — 替代 ``UNCOPYABLE_KEYS``。"""
    _ensure_derived()
    return _derived_cache["uncopyable"]


def shallow_copy_keys() -> frozenset[str]:
    """shallow_copy=True 的 key — 替代 ``SHALLOW_COPY_KEYS``。"""
    _ensure_derived()
    return _derived_cache["shallow_copy"]


def immutable_keys() -> frozenset[str]:
    """immutable=True 的 key — 替代 ``IMMUTABLE_KEYS``。"""
    _ensure_derived()
    return _derived_cache["immutable"]


def parallel_mutable_dict_keys() -> frozenset[str]:
    """parallel_merge='dict' 的 key — 替代 ``PARALLEL_MUTABLE_DICT_KEYS``。"""
    _ensure_derived()
    return _derived_cache["parallel_dict"]


def parallel_mutable_list_keys() -> frozenset[str]:
    """parallel_merge='list' 的 key — 替代 ``PARALLEL_MUTABLE_LIST_KEYS``。"""
    _ensure_derived()
    return _derived_cache["parallel_list"]


def parallel_all_mutable_keys() -> frozenset[str]:
    """所有 parallel_merge != 'none' 的 key。"""
    _ensure_derived()
    return _derived_cache["parallel_all"]


def fork_excluded_keys() -> frozenset[str]:
    """fork_exclude=True 的 key — 替代 ``_FORK_EXCLUDED_STATE_KEYS``。"""
    _ensure_derived()
    return _derived_cache["fork_excluded"]


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  初始注册（按 state_types.py 的五层 TypedDict 分组）
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

_M = StateKeyMeta
_initialized = False


def _bulk(keys: Iterable[str], **kw) -> None:
    """批量注册相同元数据的 key。仅限 ``_init_registry()`` 期间调用。"""
    assert not _initialized, "_bulk() must only be called during _init_registry()"
    meta = _M(**kw)
    for k in keys:
        _registry[k] = meta


def _init_registry() -> None:
    """静态初始化：注册所有已知 state key 的元数据。

    注册规则：只注册有非默认元数据的 key。
    未注册的 key 通过 get_meta() 返回全默认值。
    """
    r = _registry

    # ──────────────────────────────────────────────────────────
    #  1. CoreState — 业务核心，序列化/持久化
    # ──────────────────────────────────────────────────────────

    r["messages"] = _M(persist=False, shallow_copy=True)
    r["react_trace"] = _M(shallow_copy=True)
    r["todos"] = _M(parallel_merge="list")
    r["pending_document_refs"] = _M(parallel_merge="list")
    r["conversation_summary"] = _M(fork_exclude=True)

    _bulk(
        ["__force_final__", "__interrupt__"],
        persist=False,
    )

    # ──────────────────────────────────────────────────────────
    #  2. ContextState — 请求上下文，运行期大部分不变
    #
    #  所有 ContextState 字段标记为 immutable=True。
    #  thread_id 和 open_tabs 有额外属性，单独注册。
    # ──────────────────────────────────────────────────────────

    r["thread_id"] = _M(persist=False, immutable=True)
    r["open_tabs"] = _M(immutable=True, shallow_copy=True)

    _bulk(
        [
            # 用户身份
            "user_id", "identity_user_id", "organization_id", "session_id",
            "identity_kind",
            # 模型/客户端
            "model_id", "model_name", "client_type", "agent_name",
            # App 上下文
            "current_app_type", "current_space_id", "current_project_id", "current_table_id",
            "current_view_id", "current_doc_id", "current_doc_title",
            "current_slide_id", "current_slide_title",
            "current_video_id", "current_video_title",
            "current_video_playhead", "current_video_scene_id",
            "current_video_canvas_size", "current_video_duration",
            "current_canvas_id", "current_canvas_title",
            "current_memo_id", "current_memo_title",
            "current_site_id", "current_site_title",
            "current_browser_url", "current_browser_title",
            "current_terminal_cwd", "current_code_project_path",
            "current_code_file", "current_git_branch",
            "current_git_changed_files", "current_device_id",
            # 三类目录
            "agent_dir", "code_project_path", "workspace_root", "user_folders",
            # UI 状态
            "open_app_types", "recent_tables", "recent_spaces", "recent_views",
            # 执行配置
            "execution_profile", "group_runtime", "group_runtime_result",
            # Channel 上下文
            "channel_sender_id", "channel_sender_name",
            "channel_name", "channel_peer_kind",
            # 跨系统身份
            "_execution_agent_id", "_owner_user_id_for_provider",
            "_origin_user_id", "_origin_organization_id",
            # Agent 配置
            "agent_config",
            # Legacy 兼容
            "configurable", "context",
        ],
        immutable=True,
    )

    # ──────────────────────────────────────────────────────────
    #  3. EngineInternalState — 引擎内部控制，不序列化
    # ──────────────────────────────────────────────────────────

    # 3a. 不可拷贝字段（含线程锁/DB连接/Event等运行时对象）
    # 同时标 persist=False：这些对象无法序列化，不应出现在 state_json 中
    _bulk(
        [
            "_s1_streaming_executor", "_lifecycle_hooks", "_cancel_event",
            "_compaction_hook_chain", "_cache_break_detector",
        ],
        persist=False, copyable=False,
    )
    r["_execution_context"] = _M(persist=False, copyable=False)
    r["_dynamic_tool_instances"] = _M(
        persist=False, copyable=False, parallel_merge="dict",
    )

    # 3b. 并行工具可合并的 dict 型 key（persist=False）
    _bulk(
        ["_dynamic_injected_state", "_dynamic_tool_last_used"],
        persist=False, parallel_merge="dict",
    )
    r["_pending_condense"] = _M(
        persist=False, parallel_merge="dict", fork_exclude=True,
    )

    # 3c. 并行工具可合并的 dict 型 key（persist=True）
    _bulk(
        ["_tool_cache", "_tool_cache_stats", "_permission_decisions",
         "_tool_result_store"],
        parallel_merge="dict",
    )

    # 3d. 并行工具可合并的 list 型 key（persist=False）
    r["_pending_tool_activations"] = _M(persist=False, parallel_merge="list")

    # 3e. 并行工具可合并的 list 型 key（persist=True）
    r["_memory_signals"] = _M(parallel_merge="list")

    # 3f. persist=False + fork_exclude=True（compaction/condense 临时状态）
    _bulk(
        [
            "compaction_snapshot", "compaction_force", "compaction_directive",
            "_layered_prune_done",
            "_condense_in_progress", "_condense_started_iteration",
        ],
        persist=False, fork_exclude=True,
    )

    # 3g. fork_exclude=True（persist=True）
    r["_rendered_system_prompt"] = _M(fork_exclude=True)

    # 3g-2. per-request system prompt（persist=False, fork_exclude=True）
    r["_request_system_prompt"] = _M(persist=False, fork_exclude=True)

    # 3h. 额外的 immutable key（不在 ContextState 中但语义不可变）
    r["_debug_mode"] = _M(immutable=True, fork_exclude=True)
    r["_pg_persist_failed"] = _M(immutable=True)

    # 3i. persist=False — 原有字段
    _bulk(
        [
            "_version",
            "_current_iteration", "_tool_permissions", "_skills_cache",
            "_dynamic_tools_schema", "_preload_tool_names", "_active_app_types",
            "_ctx_window_tokens", "_user_selected_model",
            "_fork_system_prompt", "_fork_parent_thread_id",
            "_tool_params", "_space_snapshot",
            "_screen_trajectory",
            # 运行时工具诊断
            "_runtime_tool_domains", "_runtime_tool_names",
            "_runtime_tools_count", "_runtime_tools_unique_count",
            "_runtime_tools_duplicate_count", "_registry_tools_count",
            # Doom loop 防护（DoomLoopGuardState 封装，10 key → 1）
            "_doom",
            "_token_budget",
        ],
        persist=False,
    )

    # 3j. persist=False — LLM 输出控制 / S5 恢复 / 模型 fallback
    _bulk(
        [
            "_consecutive_empty_llm_responses",
            "_s5_ptl_recovery_attempted", "_s5_output_recovery_count",
            "_had_substantive_output", "_model_downgrade_locked",
            "_fallback_model_id",
        ],
        persist=False,
    )

    # 3k. persist=False — 上下文压缩内部状态（per-run 重置）
    _bulk(
        [
            "_compaction_consecutive_failures", "_compaction_metrics",
            "_emergency_truncate_attempts", "_just_condensed_at_iteration",
            "_pending_truncation_notice", "_session_max_summary_tokens",
        ],
        persist=False,
    )

    # 3l. persist=False — 系统通知 / post-sampling hooks
    _bulk(
        [
            "_system_notices", "_pending_system_notice",
            "_hook_rewake_messages", "_s12_completeness_inject_count",
            "_vision_content_dropped",
        ],
        persist=False,
    )

    # 3m. persist=False — 记忆管道（per-run，DB 侧有独立持久化追踪）
    _bulk(
        [
            "_memory_l1_scanned_index", "_memory_l3_extracted_upto",
            "_memory_extract_eligible_count", "_memory_extract_every_n",
            "_memory_extract_last_triggered_at", "_memory_recall_count",
            "_pending_skill_recall", "_force_memory_extract", "_error_context",
        ],
        persist=False,
    )

    # 3n. persist=False — Session Notes（per-run，before_agent 幂等初始化）
    _bulk(
        [
            "_session_notes_tool_count", "_session_notes_last_token_count",
            "_session_notes_last_tool_count", "_session_notes_update_pending",
        ],
        persist=False,
    )

    # 3o. persist=False — 计费冻结（per-iteration 冻结/释放闭环）
    _bulk(
        [
            "_current_freeze_id", "_current_freeze_organization_id",
            "_consecutive_charge_failures",
        ],
        persist=False,
    )

    # 3o-2. persist=False, fork_exclude=True — 中间件/权限/上下文管理 per-run 缓存
    r["_token_counter_cache"] = _M(persist=False, fork_exclude=True)
    r["_ctx_pressure_counter_cache"] = _M(persist=False, fork_exclude=True)
    r["_permission_cache"] = _M(persist=False, fork_exclude=True)
    r["_ctx_pending_notices"] = _M(persist=False, fork_exclude=True)
    r["_ctx_truncation_count"] = _M(persist=False, fork_exclude=True)

    # 3p. persist=False — per-request 注入 / 运行时缓存
    _bulk(
        [
            "_active_tool_domains", "_connected_extension_domains",
            "_ctx_window_model_id",
            "_is_resuming", "_max_run_credits", "_react_iteration",
        ],
        persist=False,
    )

    # 3q. persist=True — resume / 安全不变量（显式注册以使审计清零）
    _bulk(
        [
            # 子 Agent / 工作区隔离
            "_agent_workspace", "_sibling_agent_workspaces",
            "_is_subagent", "_is_background_task",
            # 执行限制（resume 依赖）
            "_max_iterations_override", "_max_run_credits_override",
            # 屏幕操作历史（跨 run 上下文）
            "_screen_action_history",
        ],
    )

    # ──────────────────────────────────────────────────────────
    #  4. SecurityState — 安全/权限/委托/HITL
    # ──────────────────────────────────────────────────────────

    # 4a. persist=False — 设备/执行环境（每次请求实时构建）+ HITL 临时
    _bulk(
        [
            "_device_fingerprint", "_device_capabilities", "_device_online",
            "_device_name", "_device_os_info",
            "_remote_servers", "_remote_git_status",
            "_hitl_interrupted_at", "_hitl_authenticated_user_id",
        ],
        persist=False,
    )

    # 4b. persist=True — 安全/权限不变量（HITL resume 强依赖）
    _bulk(
        [
            "_authorization_rules", "_authorization_rules_locked",
            "_channel_cautious_locked", "_sandbox_config",
            "_subagent_deny_tools", "_api_token_space_ids",
        ],
    )

    # ──────────────────────────────────────────────────────────
    #  5. MetricsState — 指标收集/计费/可观测性
    # ──────────────────────────────────────────────────────────

    r["_middleware_timing"] = _M(persist=False, parallel_merge="dict")
    r["_last_llm_usage"] = _M(persist=False)

    # ──────────────────────────────────────────────────────────
    #  6. 遗留/防御性 key（不在 TypedDict 中，但 state 中可能残留）
    # ──────────────────────────────────────────────────────────

    _bulk(
        [
            "_memory_injected_count", "_memory_injected_ids",
            "_memory_extracted_count",
            # Doom loop 旧式扁平 key（已迁移至 DoomLoopGuardState / state["_doom"]）
            "_doom_loop_history", "_doom_loop_warned", "_doom_ping_pong_count",
            "_doom_poll_in_pattern", "_doom_loop_streak", "_doom_tool_error_streak",
            "_diminishing_continuation_count", "_diminishing_total_turn_tokens",
            "_diminishing_consecutive_hits", "_diminishing_warned",
            "_model_route_complexity",
            "_screen_macro",
        ],
        persist=False,
    )

    global _initialized
    _initialized = True


_init_registry()


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  漂移审计
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

_LEGACY_KEYS = frozenset({
    "_memory_injected_count", "_memory_injected_ids",
    "_memory_extracted_count",
    # Doom loop 旧式扁平 key（已迁移至 DoomLoopGuardState / state["_doom"]）
    "_doom_loop_history", "_doom_loop_warned", "_doom_ping_pong_count",
    "_doom_poll_in_pattern", "_doom_loop_streak", "_doom_tool_error_streak",
    "_diminishing_continuation_count", "_diminishing_total_turn_tokens",
    "_diminishing_consecutive_hits", "_diminishing_warned",
    "_model_route_complexity", "_screen_macro",
})


def audit_registry_coverage() -> dict[str, list[str]]:
    """双向审计 TypedDict 与 Registry 的覆盖情况。

    方向 A（TypedDict → Registry）：
        EngineInternalState / SecurityState / MetricsState 中以 ``_`` 开头的字段
        如果未在 registry 注册，将回退到安全默认值 (persist=True)——对临时字段
        这通常是错误的。

    方向 B（Registry → TypedDict）：
        registry 中注册的 key（排除遗留防御性 key）如果不在任何 TypedDict 中，
        说明 TypedDict 声明遗漏。

    方向 C（运行时 state dict → Registry）：
        检查 state dict 中存在但 registry 未注册的 key。
        通过 ``audit_state_keys(state)`` 调用。

    **不可在 _init_registry() 期间调用**——会触发与 state_types.py 的循环导入。

    Returns:
        ``{"unregistered": [...], "undeclared": [...]}``
        两个列表均为空表示完全覆盖。
    """
    assert _initialized, (
        "audit_registry_coverage() must not be called during _init_registry() "
        "— delayed import of state_types.py would cause circular import"
    )
    from apps.services.agent_engine.state.state_types import (
        EngineInternalState, SecurityState, MetricsState,
    )

    typed_internal: set[str] = set()
    for td in (EngineInternalState, SecurityState, MetricsState):
        typed_internal.update(td.__annotations__)

    registered = set(_registry.keys())

    underscore_typed = {k for k in typed_internal if k.startswith("_")}
    unregistered = sorted(underscore_typed - registered)

    from apps.services.agent_engine.state.state_types import (
        CoreState, ContextState, FullEngineState,
    )
    all_typed: set[str] = set()
    for td in (CoreState, ContextState, EngineInternalState, SecurityState, MetricsState):
        all_typed.update(td.__annotations__)

    undeclared = sorted((registered - all_typed) - _LEGACY_KEYS)

    return {"unregistered": unregistered, "undeclared": undeclared}


def audit_state_keys(state: dict) -> list[str]:
    """检查运行时 state dict 中未在 TypedDict 中声明的 key。

    替代原 ``state_types.audit_state_keys()``，额外交叉检查 registry。
    """
    from apps.services.agent_engine.state.state_types import (
        CoreState, ContextState, EngineInternalState,
        SecurityState, MetricsState,
    )
    declared: set[str] = set()
    for td in (CoreState, ContextState, EngineInternalState, SecurityState, MetricsState):
        declared.update(td.__annotations__)
    declared.update(_registry.keys())
    unknown = [k for k in state if k not in declared]
    if unknown:
        import logging
        logging.getLogger(__name__).warning(
            "[StateKeyRegistry] Undeclared state keys: %s", unknown,
        )
    return unknown


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  导出
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

__all__ = [
    "StateKeyMeta",
    "register_key",
    "register_transient_key",
    "get_meta",
    "excluded_keys",
    "uncopyable_keys",
    "shallow_copy_keys",
    "immutable_keys",
    "parallel_mutable_dict_keys",
    "parallel_mutable_list_keys",
    "parallel_all_mutable_keys",
    "fork_excluded_keys",
    "audit_registry_coverage",
    "audit_state_keys",
]
