"""
AgentState — TinAgent 主入口状态定义

说明：
- ReAct 作为主入口
- State 仅保留 ReAct 必需字段
- 所有消息使用 OpenAI dict 格式
"""

import logging
from typing import List, Optional, Dict, Any
from typing_extensions import TypedDict, NotRequired
from operator import add

from apps.services.agent_engine.execution_profile import (
    PROFILE_CONVERSATIONAL,
    get_profile,
)
from apps.services.common.agent_protocol.constants import (
    ORIGIN_STATE_PREFIX,
    TRACKER_STATE_PREFIX,
)
from apps.services.agent_engine.state._generated_context_fields import (
    APP_CONTEXT_FIELDS,
)  # noqa: F401

logger = logging.getLogger(__name__)


def _assert_context_fields_in_sync() -> None:
    """启动时断言 AgentState 的 per-app 字段覆盖了 manifest 声明的所有 context fields。"""
    state_keys = set(AgentState.__annotations__)
    missing = [name for name in APP_CONTEXT_FIELDS if name not in state_keys]
    if missing:
        logger.warning(
            "[AgentState] TypedDict 缺少 manifest 声明的 context fields: %s — "
            "请运行 python scripts/generate-context-types.py 并同步 AgentState",
            missing,
        )


class AgentState(TypedDict):
    """
    TinAgent 共享状态。

    所有节点共享的状态，包含完整的对话上下文。
    消息使用 OpenAI dict 格式: {"role": "user"|"assistant"|"system"|"tool", "content": str}
    """

    # ==================== 用户上下文 ====================
    thread_id: str  # 线程 ID（用于 trace 关联）
    user_id: str  # 用户 ID
    identity_user_id: Optional[str]  # 外部可达 identity（Phase 1 为 user）
    organization_id: str  # 组织 ID
    session_id: str  # 会话 ID（关联 ChatSession）

    # ==================== 消息历史 ====================
    messages: List[dict]  # OpenAI dict 格式消息列表

    # ==================== 意图识别 ====================
    intent: Optional[str]  # 用户意图（可选）

    # ==================== 任务上下文 ====================
    # NOTE: 以下 per-app 字段应与 APP_CONTEXT_FIELDS 保持一致。
    # 运行 `python scripts/generate-context-types.py --check` 可校验一致性。
    current_app_type: Optional[
        str
    ]  # 当前标签类型: tabdata / tabdoc / tabslide / tabcode / tabweb / tabfolder / terminal
    current_space_id: Optional[str]  # 当前资源宿主 ID
    current_project_id: Optional[str]  # 当前协作 Project ID
    current_table_id: Optional[str]  # 当前操作的表格 ID (tabdata)
    current_view_id: Optional[str]  # 当前视图 ID (tabdata)
    current_doc_id: Optional[str]  # 当前文档 ID (tabdoc)
    current_doc_title: Optional[str]  # 当前文档标题 (tabdoc)
    current_slide_id: Optional[str]  # 当前演示文稿 ID (tabslide)
    current_slide_title: Optional[str]  # 当前演示文稿标题 (tabslide)
    current_video_id: Optional[str]  # 当前视频项目 ID (tabvideo)
    current_video_title: Optional[str]  # 当前视频项目标题 (tabvideo)
    current_video_playhead: Optional[str]  # 视频播放位置（秒） (tabvideo)
    current_video_scene_id: Optional[str]  # 当前视频场景 ID (tabvideo)
    current_video_canvas_size: Optional[str]  # 视频画布尺寸 (tabvideo)
    current_video_duration: Optional[str]  # 视频总时长（秒） (tabvideo)
    current_canvas_id: Optional[str]  # 当前画布 ID (tabwhiteboard)
    current_canvas_title: Optional[str]  # 当前画布标题 (tabwhiteboard)
    current_page_id: Optional[str]  # 当前画布页面 ID (tabwhiteboard)
    current_memo_id: Optional[str]  # 当前备忘 ID (tabmemo)
    current_memo_title: Optional[str]  # 当前备忘标题 (tabmemo)
    current_site_id: Optional[str]  # 当前站点 ID (tabsite)
    current_site_title: Optional[str]  # 当前站点标题 (tabsite)
    current_tracker_id: Optional[str]  # 当前 Tracker ID (tabtracker, charter v1.8 §6.8)
    current_tracker_title: Optional[str]  # 当前 Tracker 名称 (tabtracker)
    current_file_id: Optional[str]  # 当前文件 ID (tabfiles)
    current_file_name: Optional[str]  # 当前文件名 (tabfiles)
    current_folder_path: Optional[str]  # 当前文件夹路径 (tabfolder)
    current_file_path: Optional[str]  # 目录视图当前正在查看的文件 (tabfolder)
    current_browser_url: Optional[str]  # 当前浏览器 URL (browser)
    current_browser_title: Optional[str]  # 当前页面标题 (browser)
    current_terminal_cwd: Optional[str]  # 当前终端工作目录 (terminal)
    current_code_project_path: Optional[str]  # 代码项目路径（TabCode / 远程 Git）
    current_code_file: Optional[str]  # 当前打开的代码文件
    current_git_branch: Optional[str]  # 当前 Git 分支
    current_git_changed_files: Optional[
        str
    ]  # Git 变更文件列表（逗号分隔字符串，由前端 join）
    current_device_id: Optional[str]  # 当前设备 ID (tabphone)

    # ==================== 三类目录（始终可见） ====================
    agent_dir: Optional[str]  # Agent 产出目录（日志/运行时/各 App 产出）
    code_project_path: Optional[str]  # TabCode 代码项目路径（用户的代码仓库）
    user_folders: Optional[List[str]]  # TabFolder 用户文件夹列表（素材/资料等）
    workspace_root: Optional[str]  # 工具默认 cwd（跟随聚焦标签动态切换）

    open_tabs: Optional[
        List[Dict[str, Any]]
    ]  # [{type, id, title?, active?, group_id?}, ...]
    open_app_types: Optional[List[str]]  # 所有打开标签的 app 类型（去重有序）
    recent_tables: List[str]  # 最近访问的表格列表
    recent_spaces: List[str]  # 最近访问的 Space 列表
    recent_views: List[str]  # 最近访问的视图列表
    conversation_summary: Optional[str]  # 对话摘要（用于长上下文压缩）
    execution_profile: Optional[str]  # 执行模式：conversational / task / oneshot
    agent_mode: Optional[str]  # 用户交互模式：ask / agent / plan / study / group
    identity_kind: Optional[str]  # identity 类型（Phase 1 固定为 user）
    group_runtime: Optional[Dict[str, Any]]  # group 模式协作配置与已解析角色
    # **DEPRECATED** (W5 cleanup 2026-05-26)：旧 GroupRuntimeOrchestrator
    # 预编排产物。GroupRuntimeOrchestrator 已删，本字段在 W5 之后所有写入
    # 路径都已被移除（create_initial_state / context_assembler）。字段定义
    # 保留是为了：
    #   (a) 兼容历史数据库里旧 state JSON 的 deserialize（key 仍可能存在）
    #   (b) 下游 reader 在迁移期间避免 KeyError
    # 计划下个版本（迁移完成后）连同字段定义一并移除。**不要新增写入**。
    group_runtime_result: Optional[Dict[str, Any]]

    # ==================== 输出 ====================
    final_answer: str  # 最终回复（给用户）
    todos: Optional[List[Dict[str, Any]]]  # TodoListMiddleware 输出的任务列表
    react_step_index: int  # ReAct 循环步数
    react_trace_cursor: int  # react_trace 消息游标（避免重复记录）
    react_trace: List[Dict[str, Any]]  # ReAct 轨迹（模型/工具事件）

    # ==================== 模型配置 ====================
    model_id: Optional[str]  # 用户指定的模型 UUID（推荐）
    model_name: Optional[str]  # 用户指定的模型名称（已废弃，兼容用）

    # ==================== 客户端信息 ====================
    client_type: Optional[str]  # electron / ios / android / web / server

    # ==================== 运行时语义 ====================
    status: Optional[str]  # running/waiting_for_input/completed/error
    next: Optional[str]  # 路由控制
    pause_reason: Optional[str]  # 暂停原因
    error: Optional[str]  # 错误信息（统一字段）
    is_last_step: bool  # 运行标识
    agent_name: NotRequired[Optional[str]]  # 解析后的 agent 名

    # ==================== 运行时注入（由 preprocessor / middleware 写入） ====================
    _user_selected_model: NotRequired[Optional[bool]]
    _authorization_rules: NotRequired[Optional[Dict[str, Any]]]
    _sandbox_config: NotRequired[Optional[Dict[str, Any]]]
    _device_capabilities: NotRequired[Optional[Dict[str, Any]]]
    _device_online: NotRequired[Optional[bool]]
    _device_name: NotRequired[Optional[str]]
    _device_fingerprint: NotRequired[Optional[str]]
    _device_os_info: NotRequired[Optional[str]]
    _remote_git_status: NotRequired[Optional[Dict[str, Any]]]
    _remote_servers: NotRequired[Optional[List[Dict[str, Any]]]]
    _execution_agent_id: NotRequired[Optional[str]]
    _execution_context: NotRequired[Any]
    _tool_permissions: NotRequired[Optional[Dict[str, Any]]]
    _authorization_rules_locked: NotRequired[Optional[bool]]

    # W13d: 由 RemoteAgentDispatcher 的 control_device is None 分支通过
    # app_context['runtime_mode'] 注入；'lightweight' 表示用户主动选择
    # "不绑定设备（纯对话）"，工具加载阶段需自动排除 ClientTool/HybridTool。
    runtime_mode: NotRequired[Optional[str]]


import functools

from apps.services.common.app_registry import get_all_context_field_names

_assert_context_fields_in_sync()


@functools.cache
def _get_context_app_fields() -> tuple[str, ...]:
    return ("current_app_type", "current_space_id", "current_project_id") + get_all_context_field_names()


def apply_context_to_state(state: dict, context: dict) -> None:
    """将 context dict 中的 App 上下文字段同步到 state（单一事实源）。

    首次消息（create_initial_state）和非首次消息分支都应调用此函数，
    避免字段映射不同步导致的数据断层。
    """
    for key in _get_context_app_fields():
        state[key] = context.get(key)

    for key in ("recent_tables", "recent_spaces", "recent_views"):
        state[key] = context.get(key, [])

    raw_tabs = context.get("open_tabs") or []

    # ── 三类目录：始终从 context + open_tabs 提取 ──
    #
    # 单根契约（见 docs/single-root-space-prd.md §2.1）：每个 Space 的执行根
    # 唯一 = agent.working_dir。客户端 commit 1 之后 TabCode tab 的 meta.path
    # 永远 = working_dir，不再有"多代码项目"语义。
    #
    # `code_path` 解析顺序（统一 SSoT，避免 stale context 与 open_tabs 不一致）：
    #   1. open_tabs 里 type='tabcode' 的最新 path（real-time UI 真相）
    #   2. fallback：context.current_code_project_path（服务端独立 forward 场景）
    #
    # 旧"not code_path 兜底"反过来——优先 context 让 stale 值压住 open_tabs 的
    # 真值，单根模型下应当 open_tabs 优先。`user_folders` 在单根契约下永远为空。
    agent_dir = context.get("sandbox_path")
    code_path: str | None = None
    user_folders: list = []

    from apps.services.common.app_registry import normalize_type, get_app

    for t in raw_tabs:
        if not isinstance(t, dict):
            continue
        tp, p, kind = normalize_type(t.get("type", "")), t.get("path"), t.get("kind")
        if not p:
            continue
        if tp == "tabfolder" and kind == "sandbox" and not agent_dir:
            agent_dir = p
        elif tp == "tabcode":
            # 单根契约下 TabCode tab 的 path 永远 = working_dir，最近的覆盖
            code_path = p
        # 单根契约下 user_folders 永远为空——TabFolder 不再支持 kind='user'
        # 多目录挂载（见 single-root-space-prd.md §2.1）。

    # fallback 到 context 的字段——覆盖客户端没传 open_tabs 的远端 forward 场景
    if not code_path:
        code_path = context.get("current_code_project_path")

    state["agent_dir"] = agent_dir
    state["code_project_path"] = code_path
    state["user_folders"] = user_folders

    # workspace_root: 跟随聚焦标签切换工具默认 cwd（由 app_registry.workspace_root_source 驱动）
    app_type = context.get("current_app_type")
    normalized_app_type = normalize_type(app_type) if app_type else None
    workspace_root = None
    if normalized_app_type:
        app_def = get_app(normalized_app_type)
        if app_def and app_def.workspace_root_source:
            workspace_root = context.get(app_def.workspace_root_source)
    if not workspace_root and normalized_app_type == "tabfolder" and agent_dir:
        workspace_root = agent_dir
    # 兜底：context 中显式携带的 workspace_root（Daemon 场景下来自 agent_config 或 app_context）
    if not workspace_root:
        workspace_root = context.get("workspace_root")
    state["workspace_root"] = workspace_root or code_path or agent_dir or None

    # 归一化 current_app_type（如 'folder' → 'tabfolder'）
    if normalized_app_type and normalized_app_type != app_type:
        state["current_app_type"] = normalized_app_type

    state["open_tabs"] = raw_tabs
    state["open_app_types"] = list(
        dict.fromkeys(
            normalize_type(t.get("type"))
            for t in raw_tabs
            if isinstance(t, dict) and t.get("type")
        )
    )

    # 透传跨系统执行上下文（Tracker / origin 前缀）。
    # 波次 4 Stage 2.4 一刀切：legacy ``_tabgoal_`` / ``_agenda_goal_`` 前缀已下线，
    # 统一 ``_tracker_``（charter v1.8 §3.4 + PRD v2 §3 决策 6）。
    for k, v in context.items():
        if (
            k.startswith(TRACKER_STATE_PREFIX)
            or k.startswith(ORIGIN_STATE_PREFIX)
        ) and v is not None:
            state[k] = v

    # CD-008: 透传 Channel 发送者身份，供 Agent 感知真实发送者
    for k in (
        "channel_sender_id",
        "channel_sender_name",
        "channel_name",
        "channel_peer_kind",
    ):
        if k in context and context.get(k) is not None:
            state[k] = context[k]

    for k in ("identity_user_id", "identity_kind"):
        if k in context and context.get(k) is not None:
            state[k] = context[k]

    if context.get("group_runtime") is not None:
        state["group_runtime"] = context.get("group_runtime")

    if context.get("_execution_agent_id") is not None:
        state["_execution_agent_id"] = context.get("_execution_agent_id")

    # W13d: runtime_mode 由 RemoteAgentDispatcher 通过 app_context 注入
    # （control_device is None → 'lightweight'），ReactAgent._collect_tools
    # 后续读取它过滤 ClientTool/HybridTool。
    # 仅当 context 显式给出非 None 值时写入，避免覆盖 ConversationStore
    # 复用的历史 state（非首次消息走 apply_context_to_state 时同样适用）。
    if context.get("runtime_mode") is not None:
        state["runtime_mode"] = context["runtime_mode"]


def create_initial_state(
    user_id: str,
    organization_id: str,
    session_id: str,
    user_message: str,
    thread_id: Optional[str] = None,
    context: Optional[Dict] = None,
    model_id: Optional[str] = None,
    model_name: Optional[str] = None,
    client_type: Optional[str] = None,
    execution_profile: Optional[str] = None,
    agent_mode: Optional[str] = None,
) -> AgentState:
    """
    创建初始状态

    Args:
        user_id: 用户 ID
        organization_id: 组织 ID
        session_id: 会话 ID
        user_message: 用户消息
        context: 上下文信息（可选）
        model_id: 模型 UUID（推荐）
        model_name: 模型名称（已废弃）
        client_type: 客户端类型（electron / ios / android / web / server）
        execution_profile: 执行模式（conversational / task / oneshot）
        agent_mode: 用户交互模式（ask / agent / plan / study / group）

    Returns:
        初始 AgentState
    """
    profile = get_profile(execution_profile or PROFILE_CONVERSATIONAL)

    from apps.services.common.unicode_security import sanitize_and_log

    safe_user_message = sanitize_and_log(
        user_message,
        context="create_initial_state",
    )

    state: AgentState = {
        # 用户上下文
        "thread_id": thread_id or "",
        "user_id": user_id,
        "identity_user_id": user_id,
        "organization_id": organization_id,
        "session_id": session_id,
        # 消息历史（OpenAI dict 格式）
        "messages": [{"role": "user", "content": safe_user_message}],
        # 意图识别
        "intent": None,
        # 任务上下文（由 app_registry 驱动，新增 App 无需修改此处）
        "current_app_type": None,
        "current_space_id": None,
        "current_project_id": None,
        **{field_name: None for field_name in get_all_context_field_names()},
        # 基础设施字段
        "agent_dir": None,
        "code_project_path": None,
        "user_folders": [],
        "workspace_root": None,
        "open_tabs": [],
        "open_app_types": [],
        "recent_tables": [],
        "recent_spaces": [],
        "recent_views": [],
        "conversation_summary": "",
        "execution_profile": profile.name,
        "agent_mode": agent_mode or "agent",
        "identity_kind": "user",
        "group_runtime": None,
        # W5 cleanup (2026-05-26)：旧 GroupRuntimeOrchestrator 预编排字段
        # group_runtime_result 已 deprecated（实际从未被生产代码消费），
        # 这里不再写入；字段定义保留在 AgentState 仅为历史数据兼容。
        # 输出
        "final_answer": "",
        "todos": [],
        "react_step_index": 0,
        "react_trace_cursor": 0,
        "react_trace": [],
        # 模型配置
        "model_id": model_id,
        "model_name": model_name,
        # 客户端信息
        "client_type": client_type,
        # 运行时语义
        "status": "running",
        "next": None,
        "pause_reason": None,
        "error": None,
        "is_last_step": False,
    }

    # 填充上下文信息
    if context:
        apply_context_to_state(state, context)

    # Profile 声明的 authorization_preset 优先注入（task/oneshot → server_auto）
    # PAS-002: 锁定标记防止 inject_chat_context 用 Space 配置覆盖，
    # 避免无头执行场景（Scheduler/oneshot）因降级到 collaborative 触发 HITL 而永久挂起
    if profile.authorization_preset:
        state["_authorization_rules_locked"] = True

    # task/oneshot 模式缺少 current_app_type 时发出警告
    if profile.name != "conversational" and not state.get("current_app_type"):
        logger.warning(
            "[AgentState] %s 模式未设置 current_app_type，Agent 可能无法选择正确的工具和策略",
            profile.name,
        )

    return state


__all__ = [
    "AgentState",
    "apply_context_to_state",
    "create_initial_state",
    "PROFILE_CONVERSATIONAL",
]
