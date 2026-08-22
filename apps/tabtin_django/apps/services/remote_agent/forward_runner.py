"""把 prompt 推给本地 AgentRuntime 并阻塞等待结果。

执行链路：
1. ``PromptForwardService.forward_prompt(runtime_mode='local')`` 推送 envelope；
2. 设备上的 DaemonAgentHost / ElectronAgentHost 接管 prompt → 跑本地 Runtime；
3. 完成后由 ``services/common/ws/handlers/relay_handler.py`` 在收到
   ``agent.stream.done`` 时把结果写到 Redis ``runtime:result:{task_id}``
   （``_write_runtime_result_from_relay_done``）；
4. 本模块阻塞轮询该 key，超时或拿到结果后返回。

返回值是 ``ChatService.send_message_sync`` 兼容的 dict，调用方完全感知不到
路由层的存在。
"""

from __future__ import annotations

import json
import logging
import re
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

_BRACKET_ERROR_CODE_RE = re.compile(r'^\[([a-zA-Z][a-zA-Z0-9_]*)\](?:\s+|$)')

from apps.services.agent_execution.reply_context import (
    extract_reply_context_from_app_context,
)
from apps.services.common.device_capability_registry import DEVICE_AVAILABLE_STATUSES

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT_SECONDS = 600
"""对话默认 10 分钟超时；scheduler 等长任务由调用方在 ``app_context`` 显式覆盖。"""

MAX_TIMEOUT_SECONDS = 7200
"""单次同步等待最长 2 小时，再长就破坏 Celery / Channels worker 资源了。"""

MIN_TIMEOUT_SECONDS = 30

_POLL_INITIAL_INTERVAL = 1.0
_POLL_MAX_INTERVAL = 5.0
_POLL_BACKOFF = 1.4

_DEVICE_ALIVE_CHECK_EVERY_N_POLLS = 15
"""每 N 次轮询检查一次 device.status，避免轮询期内设备掉线只能死等
``DEFAULT_TIMEOUT_SECONDS``。"""


def _resolve_timeout(app_context: Optional[Dict[str, Any]]) -> int:
    """优先 app_context.runtime_timeout_seconds，否则用对话默认 600s。"""
    if app_context:
        explicit = app_context.get("runtime_timeout_seconds") or app_context.get(
            "remote_agent_timeout_seconds"
        )
        if explicit:
            try:
                value = int(explicit)
                return max(MIN_TIMEOUT_SECONDS, min(value, MAX_TIMEOUT_SECONDS))
            except (TypeError, ValueError):
                logger.debug(
                    "[remote_agent] invalid timeout in app_context: %r, using default",
                    explicit,
                )
    return DEFAULT_TIMEOUT_SECONDS


def _ensure_thread_id(session) -> str:
    """复用 ``ensure_thread_id``，保证 forward 用的 thread_id 与 ChatSession 一致。"""
    from apps.services.agent_engine.services.persistence_pipeline import (
        ensure_thread_id,
    )

    return ensure_thread_id(session, str(session.id))


def _normalize_attachments(attachments: Optional[List[Any]]) -> List[Dict[str, Any]]:
    if not attachments:
        return []
    normalized: List[Dict[str, Any]] = []
    for item in attachments:
        if isinstance(item, dict):
            normalized.append(item)
        else:
            normalized.append({"value": item})
    return normalized


def _build_agent_backend_config() -> Dict[str, Any]:
    """本地 runtime 路径下 backend type 固定为 ``local``。"""
    return {"type": "local"}


def _resolve_system_prompt(app_context: Optional[Dict[str, Any]]) -> Optional[str]:
    """仅从内部上下文 key 读取完整 system prompt override。"""
    if not app_context:
        return None
    for key in ("_request_system_prompt", "_rendered_system_prompt"):
        value = app_context.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return None


def _normalize_result_payload(raw: Any) -> Dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            decoded = json.loads(raw)
            if isinstance(decoded, dict):
                return decoded
            return {"content": str(decoded)}
        except Exception:
            return {"content": raw}
    return {"content": str(raw or "")}


def _normalize_error_token(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    token = value.strip()
    if not token:
        return None
    # 兼容偶发的 ``[code]`` 包装，避免再次压成 runtime_failed。
    bracketed = _BRACKET_ERROR_CODE_RE.match(token)
    if bracketed and bracketed.end() == len(token):
        return bracketed.group(1)
    return token


def _parse_bracket_error_code(*texts: str) -> Optional[str]:
    for text in texts:
        match = _BRACKET_ERROR_CODE_RE.match(text or "")
        if match:
            return match.group(1)
    return None


def _resolve_runtime_error_fields(
    payload: Dict[str, Any],
    *,
    content: str,
    error_message: str,
    is_error: bool,
) -> Tuple[Optional[str], Optional[str]]:
    """解析 runtime 错误分类，优先稳定字段，其次 ``[code]`` 前缀。

    返回 ``(error_category, error_code)``。成功路径两者均为 ``None``；
    失败且无法识别时回落 ``runtime_failed``，不再把已知计费类压平。
    """
    if not is_error:
        return None, None

    explicit_category = _normalize_error_token(
        payload.get("error_category") or payload.get("errorCategory"),
    )
    explicit_code = _normalize_error_token(
        payload.get("error_code") or payload.get("errorCode"),
    )
    parsed_code = _parse_bracket_error_code(error_message, content)

    error_code = explicit_code or parsed_code or explicit_category
    error_category = explicit_category or parsed_code or explicit_code or "runtime_failed"
    return error_category, error_code


def _build_chat_service_compat_dict(
    *,
    payload: Dict[str, Any],
    task_id: str,
) -> Dict[str, Any]:
    """把 daemon 写入 Redis 的 runtime payload 翻译成 ChatService 兼容的 dict。

    必填字段保持与 ``ChatService.send_message_sync`` 返回值一致：
    ``message_id`` / ``reply`` / ``model_id`` / ``model_name`` / ``trace_id``
    / ``error_category`` / ``error_message`` / ``content``。

    本地 runtime 路径不持有 server 端的 ``message_id`` / ``model_id``，相关字段
    返回 ``None``，调用方现有的 ``or`` 容错（``result.get('reply') or
    result.get('content') or ''``）能正确兜底。

    错误分类优先透传 payload 的 ``error_category`` / ``error_code``；旧 payload
    可从标准 ``[code]`` 前缀保守解析，避免一律压成 ``runtime_failed``。
    """
    content = str(payload.get("content", "") or "")
    is_error = bool(payload.get("error", False))
    error_message = str(payload.get("error_message", "") or "")

    if is_error and not content:
        content = error_message

    error_category, error_code = _resolve_runtime_error_fields(
        payload,
        content=content,
        error_message=error_message,
        is_error=is_error,
    )

    result = {
        "message_id": None,
        "reply": content,
        "content": content,
        "model_id": None,
        "model_name": None,
        "trace_id": None,
        "error_category": error_category,
        "error_message": error_message or None,
        "_remote_agent_task_id": task_id,
        "_remote_agent_runtime_mode": "local",
    }
    if error_code:
        result["error_code"] = error_code
    return result


def _check_device_dropped_offline(device_id: str) -> bool:
    """轮询期内检查设备是否仍可用；不可用（offline 等）返回 True。

    W13 D6 短期实施：busy 视为可用，不再误判为掉线。详见
    `` D6。
    任何 DB 异常视为"无法判断 → 继续等"（False），不主动制造误判。
    """
    if not device_id:
        return False
    try:
        from apps.tabtinspace.models import Device

        status = (
            Device.objects.filter(id=device_id)
            .values_list("status", flat=True)
            .first()
        )
        return status is not None and status not in DEVICE_AVAILABLE_STATUSES
    except Exception:
        logger.debug(
            "[remote_agent] _check_device_dropped_offline failed device=%s",
            device_id, exc_info=True,
        )
        return False


def forward_to_local_runtime(
    *,
    session,
    space,
    agent,
    message: str,
    attachments: Optional[List[Any]],
    app_context: Optional[Dict[str, Any]],
    control_device: Any = None,
    model_id: Optional[str] = None,
    client_message_id: Optional[str] = None,
    # ：content_blocks 透传 → wire user_message_blocks；Host 拼装 preset/@/MCP
    blocks: Optional[List[Any]] = None,
    # PR4-yolo (PRD v3 §5.6 Daemon 路径)：消息 body 透传过来的 AgentMode，
    # 落到 thread_context._agent_mode_var 让 FrontendActionService 在
    # publish_action 时取到（PR0 改完入参后会喂给 SandboxPolicyResolver.from_agent_config
    # 的 requested_agent_mode 参数；PR0 未合并时该 ContextVar 写但读端
    # fail-safe，等同 Daemon 路径继续走 collaborative）。
    agent_mode: Optional[str] = None,
    # 交互档（HITL 四态）。无人值守任务传 'scheduled' → 设备 host 让审批 + ask
    # 工具 fail-fast。缺省 None → host 走 'interactive'（行为不变）。
    interaction_mode: Optional[str] = None,
) -> Dict[str, Any]:
    """同步将 prompt 推给本地 Runtime 并等待结果。

    ``control_device`` 由 dispatcher 传入；轮询期内会按 ``_DEVICE_ALIVE_CHECK_EVERY_N_POLLS``
    的节奏检查它是否仍 online，避免半路掉线只能死等超时。
    """
    from django.core.cache import cache

    from apps.services.agent_engine.services.prompt_forward_service import (
        PromptForwardService,
    )

    thread_id = _ensure_thread_id(session)
    timeout_seconds = _resolve_timeout(app_context)

    # 无人值守第三类挂死修复：把 agent_mode 按 thread_id 写进 Redis（服务端可信源），
    # 让设备 frontend action（browser.open 等）回 Django 走 FrontendActionService 审批
    # 决策时，能在 WS-consumer 线程（ContextVar 取不到本 celery 线程设的值）回落读到
    # —— 否则 yolo 无人值守任务的高危前端动作仍会弹审批。仅在 agent_mode 非空时写；
    # finally 清理。TTL 比本次轮询超时略长，避免动作晚到时键已过期。
    if agent_mode:
        from apps.services.common.thread_context import set_forward_agent_mode
        set_forward_agent_mode(thread_id, agent_mode, timeout_seconds=timeout_seconds + 120)

    # ── TS-24：forward 路径转发前先把 prompt 落成带 content 的 user 消息 ──
    #
    # 背景：IPC / lightweight 路径在 ``ChatService._stage_ingest`` 里通过
    # ``persist_user_messages`` 把用户输入落成 ``ChatMessage.content`` —— Django
    # 是数据权威。但 forward 路径（设备在线，Tracker / channel / delegation 等
    # 经 ``RemoteAgentDispatcher`` 触发）此前**完全不落 user 消息**，只把 prompt
    # 转发给 daemon，唯一的 user 消息来自 daemon 回显的 ``agent.stream.user``
    # 事件经 ``relay_message_writer._write_chat_messages`` 落库——而该路径只写
    # ``text_summary``、不写 ``content``，且 user 事件无 ``blocks_json`` →
    # ``content_blocks_json`` 也空。结果：会话里 user 气泡空、追溯看不到「问了
    # 什么」（TS-24）。
    #
    # 修复：与 IPC 路径对齐，转发前在服务端落一条带 ``content`` 的 user 消息。
    # ``client_message_id`` 作为 ``(session, client_event_id)`` 幂等键——daemon
    # 回显的 user 事件命中 UniqueConstraint 去重，**不会**产生第二条 user 消息
    # （与 IPC 同机制）。缺省（Tracker/channel 不传）时自生成 UUID 并一路透传
    # 给下方 ``forward_prompt``——否则 daemon 自生成不同 id，回显的 user 事件
    # 反而会另起一条空 content 消息（即本 bug 的成因）。落库失败不阻断转发
    # （daemon 回显仍兜底落库，只是退回空 content）。
    if not (client_message_id or "").strip():
        client_message_id = str(uuid.uuid4())
    reply_context = extract_reply_context_from_app_context(app_context)
    reply_to_message_id = reply_context.get("reply_to_message_id")
    reply_to_preview = reply_context.get("reply_to_preview")
    display_message = reply_context.get("display_message")
    # ：quoted / preset / @ 拼装归执行端 Host；此处只透传用户原文。
    prompt_for_runtime = message
    skill_slash_invoke = None
    if isinstance(app_context, dict):
        skill_raw = app_context.get("_skill_slash_invoke")
        if isinstance(skill_raw, dict):
            skill_key = skill_raw.get("skill_key")
            if isinstance(skill_key, str) and skill_key.strip():
                skill_slash_invoke = {"skill_key": skill_key.strip()}
                skill_args = skill_raw.get("args")
                if isinstance(skill_args, str):
                    skill_slash_invoke["args"] = skill_args
        # 勿把隧道字段投影进 Host Focus
        if "_skill_slash_invoke" in app_context:
            app_context = {k: v for k, v in app_context.items() if k != "_skill_slash_invoke"}

    # forward 路径（服务端编排 + 设备在线，经 RemoteAgentDispatcher 直连）同样是
    # 「用户发下一条消息」的权威时刻：代发 prompt 落库前，若会话处于软回退态，
    # 先补回退清理（与 ChatService._stage_prepare / relay_message_writer 一致）。
    # 否则这条直连 forward 的会话不经 _stage_prepare，revert_message_id 永不清除、
    # revert_active 永久 true。复用 Django 权威实现；清算失败时必须拒绝转发，
    # 不能先启动新一轮 Agent 再留下未消费的回退状态。
    if session.revert_message_id:
        try:
            from apps.services.agent_engine.services.persistence_pipeline import (
                cleanup_reverted_messages,
            )

            cleanup_reverted_messages(session)
        except Exception:
            logger.warning(
                "[remote_agent] cleanup reverted messages failed thread=%s; refusing forward",
                thread_id, exc_info=True,
            )
            # 两阶段文件 finalize pending 时尤其不能继续：设备若先执行新一轮，
            # 旧 Host 随后回退文件会造成对话/工作区错位。让上层把本轮明确判失败。
            raise
    try:
        from apps.services.agent_engine.services.persistence_pipeline import (
            persist_user_messages,
            resolve_sender_attribution,
        )

        #  共享对话：shared-chat 以 owner 身份 dispatch，但发言人是
        # grantee——app_context._shared_chat_by 命中时这条 user 消息落库
        # sender=grantee + shared_chat metadata；既有调用方不带该 key，
        # 保持 sender=session owner 的旧口径。
        sender_user_id, shared_chat_metadata = resolve_sender_attribution(
            str(getattr(session, "user_id", "") or ""), app_context,
        )
        persist_user_messages(
            session,
            [display_message if isinstance(display_message, str) else message],
            None,
            None,
            blocks,
            attachments,
            sender_user_id=sender_user_id,
            client_message_id=client_message_id,
            extra_metadata=shared_chat_metadata,
            reply_to_message_id=reply_to_message_id if isinstance(reply_to_message_id, str) else None,
            reply_to_preview=reply_to_preview if isinstance(reply_to_preview, dict) else None,
        )
    except Exception:
        logger.warning(
            "[remote_agent] persist user message failed thread=%s (non-fatal)",
            thread_id, exc_info=True,
        )

    # Tracker 执行进度不再写入伪 assistant ChatMessage（曾用
    # tracker_start_placeholder「任务已开始…」）。该行只落 Django、不进本机
    # transcript，造成本地 vs 落库条数不一致，且会污染 cross-turn history。
    # 进度改由 TrackerRun.status + 前端状态指示 / 顶栏「查看自动化任务」表达。

    custom_rules = (getattr(agent, "custom_rules", "") or "") if agent else ""
    # 分层规则·个人基线层（IA Phase 3 §8.6，与 AgentDispatcher 对称）：个人取
    # Agent owner 的 UserProfile.personal_rules（per-owner，非当前说话人；helper
    # docstring 详述）。
    _layered_rules = PromptForwardService.resolve_layered_rules_for_forward(space)
    personal_rules = _layered_rules["personal_rules"]
    agent_id = str(getattr(agent, "id", "") or "") if agent else None
    device_id = str(getattr(control_device, "id", "") or "") if control_device else ""

    # work_mode：Workspace 工作目录类型（code/doc/mixed），驱动 Daemon 路径
    # system prompt 的 `<work_mode>` 默认执行策略段。取值方式与 AgentDispatcher
    # 对齐（''/None 归一为 None）；forward_prompt 内部只在合法枚举值时写 wire payload，
    # 故空/未设/脏值在此透传为 None 即被下游跳过。
    working_dir_type = getattr(space, "working_dir_type", None) or None

    workspace_root: Optional[str] = getattr(space, "working_dir", None) or None
    agent_config = getattr(agent, "agent_config", None) if agent else None

    # ── PRD 05 v0.4 §7.1（W3-轮 1）crash resume 状态快照透传 ──
    # 与 ``AgentDispatcher.dispatch_external`` 对称：把 PG 里
    # ``ConversationState.interrupt_state`` 整包透传给 daemon，让
    # DaemonAgentHost 在 runtime.query 入口按 ``pending_approvals`` 回灌
    # PendingApprovalRegistry。
    # peek 语义只读不清，daemon 处理完审批后通过 approval_resolved 路径在
    # ``relay_audit_writer._persist_approval_resolved`` 清除。
    # 行不存在（新会话）→ None，forward_prompt 看到 None 不进 payload。
    from apps.services.agent_engine.persistence.conversation_store import (
        ConversationStore,
    )
    interrupt_state = ConversationStore.peek_interrupt_state(thread_id)

    # ：yolo gate 是**组织准入天花板**——读 space.organization.settings，
    # 不再读 Agent 配置。本地变量名 ``yolo_mode`` 保留（下游 prompt_forward_service
    # 入参语义不变，不暴露到 API）。execution_limits 仍读 Agent 配置。
    from apps.services.common.agent_governance_resolver import (
        resolve_allow_yolo_mode,
        resolve_execution_limits,
        compact_execution_limits,
    )
    _organization = getattr(space, "organization", None) if space else None
    _org_settings = getattr(_organization, "settings", None) if _organization else None
    yolo_mode = resolve_allow_yolo_mode(_org_settings)
    # execution_limits per-key 下发。修既有缺口——dispatcher 路径一直下发
    # execution_limits，而 forward_runner（remote_agent / scheduler /
    # lightweight_dispatch 旁路任务）从未传，导致这些路径的执行限制全失效。
    governance_execution_limits = compact_execution_limits(
        resolve_execution_limits(agent_config)
    )

    # L-W6-02 (W6 M3)：从 app_context 抽 workspace_snapshot 透传给
    # PromptForwardService —— 与 AgentDispatcher.dispatch_external 同源。
    # 这条路径由 RemoteAgent / scheduler / lightweight_dispatch 触发，
    # app_context 通常无 workspace_snapshot（scheduler 没有"主控端"），但
    # 若调用方（譬如未来某个移动端 quick-action 走 forward_runner 而非
    # chat.send_message handler）显式带上，链路就直接接通。
    workspace_snapshot: Optional[Dict[str, Any]] = None
    if isinstance(app_context, dict):
        ws_raw = app_context.get("workspace_snapshot")
        if isinstance(ws_raw, dict) and ws_raw:
            workspace_snapshot = ws_raw
    interrupt_active = bool(
        isinstance(app_context, dict)
        and app_context.get("_interrupt_agent_active") is True
    )

    # ── W7c · Stage 4 Daemon 路径对齐（agent-prompt 治理 99 §阶段 4）──
    # 与 ``AgentDispatcher.dispatch_external`` 对称：把 Daemon ``buildSystemPrompt``
    # 缺的关键入参从 Django 这条上游派生并透传。详细动机见 dispatcher 同名块注释。
    user_id_for_wire = str(getattr(session, "user_id", "") or "")
    enabled_apps_for_wire = PromptForwardService.derive_enabled_apps_for_forward(
        space=space,
        user_id=user_id_for_wire or None,
    )
    _human_names = PromptForwardService.derive_human_readable_names_for_forward(space)
    space_name_for_wire = _human_names["space_name"]
    organization_name_for_wire = _human_names["organization_name"]

    # 路径权限治理 Wave 4：写 (thread_id, snapshot) 到 ContextVar，让
    # FrontendActionService 能在 publish_action 时取到（与 dispatch_external
    # 同语义）；try/finally + Token.reset 收尾防 prefork worker 残留（CA-007
    # 同款治理）。
    snapshot_token = None
    from apps.services.common.thread_context import (
        set_current_workspace_snapshot,
        reset_current_workspace_snapshot,
        set_current_agent_mode,
        reset_current_agent_mode,
    )
    try:
        snapshot_token = set_current_workspace_snapshot(thread_id, workspace_snapshot)
    except Exception:
        logger.debug(
            "[forward_runner] set_current_workspace_snapshot failed (non-critical)",
            exc_info=True,
        )

    # PR4-yolo (PRD v3 §5.6 Daemon 路径)：与 snapshot 同模式写 agent_mode，让
    # FrontendActionService._resolve_sandbox_policy 拿到 LLM 任务级 AgentMode。
    # 同样 try/finally + Token.reset 防 prefork worker 残留越权。
    agent_mode_token = None
    try:
        agent_mode_token = set_current_agent_mode(thread_id, agent_mode)
    except Exception:
        logger.debug(
            "[forward_runner] set_current_agent_mode failed (non-critical)",
            exc_info=True,
        )

    # Space-first Phase 4：Space.type 不再承载 group 语义。
    # 未来多 Agent 群聊若需要 yolo 互斥，应从 group runtime 配置派生。
    is_group_space = False

    # W7c · Stage 4 顺手补：cdbf47a31 给 forward_prompt 加 agent_mode/is_group_space 形参时，
    # dispatcher 改了但 forward_runner 漏了实例化 ``service = PromptForwardService()``，
    # 导致这条路径在 ``service.forward_prompt(...)`` 处 NameError。补齐让 Daemon 路径
    # 新增字段透传链路真实可达。
    service = PromptForwardService()
    from apps.services.agent_engine.engine.agent_dispatcher import (
        _normalize_user_message_blocks,
    )

    try:
        forward_result = service.forward_prompt(
            thread_id=thread_id,
            space=space,
            prompt=prompt_for_runtime,
            attachments=_normalize_attachments(attachments),
            user_message_blocks=_normalize_user_message_blocks(blocks),
            agent_backend_config=_build_agent_backend_config(),
            workspace_root=workspace_root,
            runtime_mode="local",
            custom_rules=custom_rules,
            # 分层规则·个人基线层（IA Phase 3 §8.6）：与 custom_rules 对称透传。
            personal_rules=personal_rules,
            agent_id=agent_id,
            model_id=model_id,
            system_prompt=_resolve_system_prompt(app_context),
            yolo_mode=yolo_mode,
            # PR4-yolo (PRD v3 §5.6)：把 forward_runner 入参 agent_mode 真正落进
            # wire payload，让 Daemon resolveAgentMode 拿到（任务 2）。
            agent_mode=agent_mode,
            # 交互档透传（无人值守 fail-fast）。
            interaction_mode=interaction_mode,
            # PRD §1.4 + DR-15：wire 强写 is_group_space，让 Daemon 写
            # policyContext.isGroupSpace 修 H5。
            is_group_space=is_group_space,
            # L-W6-02：调用链补齐 —— 见上方 workspace_snapshot 计算注释。
            workspace_snapshot=workspace_snapshot,
            # work_mode：透传 Agent 工作目录类型，Daemon 据此注入 `<work_mode>` 段
            # （与 AgentDispatcher.dispatch_external 对称）。修 scheduler/remote_agent
            # 旁路任务 system prompt 缺 `<work_mode>` 的 bug。
            working_dir_type=working_dir_type,
            display_message=display_message if isinstance(display_message, str) else None,
            reply_to_message_id=reply_to_message_id if isinstance(reply_to_message_id, str) else None,
            reply_to_preview=reply_to_preview if isinstance(reply_to_preview, dict) else None,
            skill_slash_invoke=skill_slash_invoke,
            client_message_id=client_message_id,
            interrupt_state=interrupt_state,
            # W7c · Stage 4：Daemon 路径关键 prompt 字段透传（与 dispatcher 对称）。
            app_context=app_context,
            enabled_apps=enabled_apps_for_wire or None,
            space_name=space_name_for_wire,
            organization_name=organization_name_for_wire,
            # ：user+device 路由——同机异账号不得串跑
            execution_owner_user_id=user_id_for_wire or None,
            interrupt_active=interrupt_active,
            # prompt.forward 的 workspace_id 负责执行场绑定；space_id 负责
            # runtime 工具、环境提示与 CLI profile。两者必须同源，禁止缺省后
            # 回退到设备端当前选中的 Workspace。
            space_id=str(getattr(space, "id", "") or "") or None,
            # IA Phase 3 §8.5：补齐 execution_limits 下发（与 dispatcher 对称，
            # 修旁路任务历史漏传缺口）。
            execution_limits=governance_execution_limits,
        )

        task_id = forward_result.get("task_id") or ""
        published = int(forward_result.get("published") or 0)
        tracker_run_id = (
            (app_context or {}).get("_tracker_tracker_run_id")
            if isinstance(app_context, dict)
            else None
        )
        project_task_run_id = (
            (app_context or {}).get("_project_task_run_id")
            if isinstance(app_context, dict)
            else None
        )
        if task_id and tracker_run_id:
            try:
                from apps.tracker.services.tracker_executor import _record_runtime_task_id

                _record_runtime_task_id(str(tracker_run_id), str(task_id))
            except Exception:
                logger.debug(
                    "[remote_agent] record runtime task_id failed run=%s task=%s",
                    tracker_run_id,
                    task_id,
                    exc_info=True,
                )

        if published == 0:
            logger.warning(
                "[remote_agent] forward published=0 thread=%s — daemon 不可达",
                thread_id,
            )
            return {
                "message_id": None,
                "reply": (
                    "本地 Agent Runtime 未能接收任务，请检查设备客户端是否在线。"
                ),
                "content": "",
                "model_id": None,
                "model_name": None,
                "trace_id": None,
                "error_category": "device_unreachable",
                "error_message": "PromptForward published=0 (no daemon/electron reachable)",
                "_remote_agent_task_id": task_id,
                "_remote_agent_runtime_mode": "local",
            }

        result_key = f"runtime:result:{task_id}"
        deadline = time.monotonic() + timeout_seconds
        interval = _POLL_INITIAL_INTERVAL
        poll_count = 0
        # 最近一次读 result key 是否因缓存后端（Redis）异常失败。用于在轮询结束时
        # 区分「真超时」与「缓存后端持续不可用导致读不到结果」——后者绝不能误标成
        # 执行超时（见下方 deadline 分支 + GH ）。
        last_cache_error: Optional[Exception] = None

        while time.monotonic() < deadline:
            if tracker_run_id:
                try:
                    from apps.tracker.services.tracker_executor import _is_tracker_run_cancelled

                    if _is_tracker_run_cancelled(str(tracker_run_id)):
                        logger.info(
                            "[remote_agent] tracker run cancelled mid-task: run=%s task=%s",
                            tracker_run_id,
                            task_id,
                        )
                        try:
                            service.forward_cancel(
                                thread_id=thread_id,
                                task_id=task_id,
                                space=space,
                                agent_id=agent_id,
                            )
                        except Exception:
                            logger.debug(
                                "[remote_agent] forward_cancel after tracker cancel failed",
                                exc_info=True,
                            )
                        return {
                            "message_id": None,
                            "reply": "",
                            "content": "",
                            "model_id": None,
                            "model_name": None,
                            "trace_id": None,
                            "error_category": "cancelled",
                            "error_message": "tracker_run_cancelled",
                            "_remote_agent_task_id": task_id,
                            "_remote_agent_runtime_mode": "local",
                        }
                except Exception:
                    logger.debug(
                        "[remote_agent] tracker cancel poll check failed run=%s",
                        tracker_run_id,
                        exc_info=True,
                    )

            if project_task_run_id:
                try:
                    from apps.tabtinspace.services.project_task_runtime import (
                        is_project_task_run_cancelled,
                    )

                    if is_project_task_run_cancelled(str(project_task_run_id)):
                        logger.info(
                            "[remote_agent] project task run cancelled mid-task: run=%s task=%s",
                            project_task_run_id,
                            task_id,
                        )
                        try:
                            service.forward_cancel(
                                thread_id=thread_id,
                                task_id=task_id,
                                space=space,
                                agent_id=agent_id,
                            )
                        except Exception:
                            logger.debug(
                                "[remote_agent] forward_cancel after project task cancel failed",
                                exc_info=True,
                            )
                        return {
                            "message_id": None,
                            "reply": "",
                            "content": "",
                            "model_id": None,
                            "model_name": None,
                            "trace_id": None,
                            "error_category": "cancelled",
                            "error_message": "project_task_run_cancelled",
                            "_remote_agent_task_id": task_id,
                            "_remote_agent_runtime_mode": "local",
                        }
                except Exception:
                    logger.debug(
                        "[remote_agent] project task cancel poll check failed run=%s",
                        project_task_run_id,
                        exc_info=True,
                    )

            # GH ：`cache.get` 直连远程 Redis；Redis 抖动（"Timeout reading from
            # socket" 等）会让它抛异常。django_redis 默认 IGNORE_EXCEPTIONS=False →
            # 异常会冒泡出本函数、被 execute_tracker 外层 catch humanize 成「执行时间
            # 超过了上限」，把**已成功执行**的任务误判失败。这里吞掉单次读失败、继续
            # 轮询：让设备侧 relay recover（重连重投 done）有机会把 runtime:result 补
            # 写进来，run 仍能正常收到结果。
            try:
                cached = cache.get(result_key)
                last_cache_error = None
            except Exception as exc:  # noqa: BLE001 — 任何缓存后端异常都不应中断轮询
                last_cache_error = exc
                cached = None
                logger.warning(
                    "[remote_agent] result cache.get transient error (keep polling): "
                    "thread=%s task=%s err=%r",
                    thread_id, task_id, exc,
                )
            if cached is not None:
                payload = _normalize_result_payload(cached)
                logger.info(
                    "[remote_agent] received result thread=%s task=%s error=%s len=%d",
                    thread_id,
                    task_id,
                    payload.get("error", False),
                    len(str(payload.get("content", "") or "")),
                )
                return _build_chat_service_compat_dict(payload=payload, task_id=task_id)

            poll_count += 1
            if (
                device_id
                and poll_count % _DEVICE_ALIVE_CHECK_EVERY_N_POLLS == 0
                and _check_device_dropped_offline(device_id)
            ):
                logger.warning(
                    "[remote_agent] device dropped offline mid-task: thread=%s task=%s device=%s",
                    thread_id, task_id, device_id,
                )
                try:
                    service.forward_cancel(thread_id=thread_id, task_id=task_id, space=space, agent_id=agent_id)
                except Exception:
                    logger.debug("[remote_agent] forward_cancel after device-drop failed", exc_info=True)
                return {
                    "message_id": None,
                    "reply": "执行设备在任务中途掉线，请确认客户端在线后重试。",
                    "content": "",
                    "model_id": None,
                    "model_name": None,
                    "trace_id": None,
                    "error_category": "device_dropped",
                    "error_message": f"control_device {device_id} dropped to offline mid-task",
                    "_remote_agent_task_id": task_id,
                    "_remote_agent_runtime_mode": "local",
                }

            time.sleep(interval)
            interval = min(interval * _POLL_BACKOFF, _POLL_MAX_INTERVAL)

        try:
            service.forward_cancel(thread_id=thread_id, task_id=task_id, space=space, agent_id=agent_id)
        except Exception:
            logger.debug("[remote_agent] forward_cancel after deadline failed", exc_info=True)

        # GH ：临到 deadline 仍因缓存后端异常读不到结果 → 这不是「执行超时」，
        # 而是结果存储（Redis）在等待窗口内持续不可用，无法确认本次执行的最终状态
        # （任务很可能已成功）。单独归类 result_backend_unavailable，避免 humanize 误标
        # 「执行时间超过了上限」，并给出「稍后确认/重试」而非「任务太慢」的建议。
        if last_cache_error is not None:
            logger.warning(
                "[remote_agent] result polling ended with cache backend unavailable: "
                "thread=%s task=%s timeout=%ds err=%r",
                thread_id, task_id, timeout_seconds, last_cache_error,
            )
            return {
                "message_id": None,
                "reply": (
                    "这次执行可能已经完成，但暂时连不上结果存储，没法确认最终状态，"
                    "请稍后再看一眼或重新运行确认。"
                ),
                "content": "",
                "model_id": None,
                "model_name": None,
                "trace_id": None,
                "error_category": "result_backend_unavailable",
                "error_message": "runtime result backend unavailable; completion unconfirmed",
                "_remote_agent_task_id": task_id,
                "_remote_agent_runtime_mode": "local",
            }

        logger.warning(
            "[remote_agent] timed out waiting for local runtime: thread=%s task=%s timeout=%ds",
            thread_id,
            task_id,
            timeout_seconds,
        )

        return {
            "message_id": None,
            "reply": (
                f"本地 Agent Runtime 在 {timeout_seconds}s 内未返回结果，请稍后重试。"
            ),
            "content": "",
            "model_id": None,
            "model_name": None,
            "trace_id": None,
            "error_category": "remote_agent_timeout",
            "error_message": f"timed out after {timeout_seconds}s waiting for runtime result",
            "_remote_agent_task_id": task_id,
            "_remote_agent_runtime_mode": "local",
        }
    finally:
        if snapshot_token is not None:
            try:
                reset_current_workspace_snapshot(snapshot_token)
            except Exception:
                logger.debug(
                    "[forward_runner] reset_current_workspace_snapshot failed",
                    exc_info=True,
                )
        if agent_mode_token is not None:
            try:
                reset_current_agent_mode(agent_mode_token)
            except Exception:
                logger.debug(
                    "[forward_runner] reset_current_agent_mode failed",
                    exc_info=True,
                )
        # 清理上面写入的 Redis agent_mode（防止键残留影响同 thread_id 的后续请求；
        # 本身有 TTL 兜底，这里主动删更干净）。
        if agent_mode:
            try:
                from apps.services.common.thread_context import clear_forward_agent_mode
                clear_forward_agent_mode(thread_id)
            except Exception:
                logger.debug("[forward_runner] clear_forward_agent_mode failed", exc_info=True)


__all__ = [
    "DEFAULT_TIMEOUT_SECONDS",
    "MAX_TIMEOUT_SECONDS",
    "forward_to_local_runtime",
]
