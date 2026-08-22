"""
AgentDispatcher — forwards user messages to the bound device's local runtime.

`agent.prompt.forward` envelope is published over WebSocket; the device-side
DaemonAgentHost / ElectronAgentHost picks it up and runs the local agent
runtime (`@tabtin/agent-runtime`).
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from apps.services.agent_execution.reply_context import (
    extract_reply_context_from_app_context,
)

logger = logging.getLogger(__name__)


def _normalize_user_message_blocks(blocks: Optional[list]) -> Optional[list]:
    """Project structured context only; attachments have their own wire channel."""
    if not blocks:
        return None
    normalized: list = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        block_type = block.get("type")
        if (
            not isinstance(block_type, str)
            or not block_type
            or block_type in {"text", "image", "file", "video"}
        ):
            continue
        normalized.append(block)
    return normalized or None


def get_agent_backend_type(space) -> str:
    """Return the agent backend type. Always `'local'` (or legacy stored value)."""
    agent = getattr(space, "agent", None)
    config = getattr(agent, "agent_config", None) or {} if agent else {}
    backend = config.get("agent_backend", {})
    return backend.get("type", "builtin")


def get_yolo_mode(space) -> bool:
    """Return the resolved Yolo 准入天花板 for the given Space's organization.

    ：Yolo gate 从 Agent 级改为**组织准入天花板**——读
    ``space.organization.settings.allow_member_yolo``。函数名保留
    ``get_yolo_mode`` 不变（语义稳定 = "当前组织是否允许成员用 yolo"）。
    组织缺失 / settings 脏值由 resolver 内部 fail-safe 兜底为 False。
    """
    organization = getattr(space, "organization", None)
    settings = getattr(organization, "settings", None) if organization else None
    from apps.services.common.agent_governance_resolver import resolve_allow_yolo_mode
    return resolve_allow_yolo_mode(settings)


def _resolve_disabled_apps_for_space(session, space, *, user_id_override: Optional[str] = None) -> list:
    """解析 Space 级禁用 APP 列表，注入到本地 runtime 的转发 payload 中。

    fail-close：解析失败时返回空列表（日志告警），不阻塞转发。
    """
    user_id = None
    space_id = None

    try:
        user_id = str(user_id_override or getattr(session, "user_id", None) or "")
        space_id = str(getattr(space, "id", None) or "")
    except Exception:
        pass  # defensive: session/space 属性访问异常，禁用 APP 列表解析走空列表降级

    if not user_id or not space_id:
        logger.debug(
            "[Orchestrator] Cannot resolve disabled_apps: user_id=%s space_id=%s",
            user_id, space_id,
        )
        return []

    try:
        from apps.tabtinspace.services.app_settings_service import AppSettingsService
        disabled = AppSettingsService.resolve_disabled_apps(
            user_id=user_id,
            space_id=space_id,
        )
        return disabled or []
    except Exception:
        logger.warning(
            "[Orchestrator] Failed to resolve disabled_apps for space=%s",
            space_id, exc_info=True,
        )
        return []


def _resolve_disabled_tool_prefixes(disabled_apps: list) -> list:
    """把 Space 禁用 APP 映射到本地 runtime 可识别的工具域前缀。

    首选 App registry 里的 manifest 派生结果；registry 异常时降级为 app_id
    本身，保证策略仍能 fail-soft 下发给旧 runtime。
    """
    if not disabled_apps:
        return []

    try:
        from apps.services.common.app_registry import get_tool_domains_map

        domains_by_app = get_tool_domains_map()
        prefixes = []
        seen = set()
        for app_id in disabled_apps:
            if not isinstance(app_id, str):
                continue
            for prefix in domains_by_app.get(app_id, (app_id,)):
                if not isinstance(prefix, str):
                    continue
                normalized = prefix.strip()
                if normalized and normalized not in seen:
                    seen.add(normalized)
                    prefixes.append(normalized)
        return prefixes
    except Exception:
        logger.warning(
            "[Orchestrator] Failed to resolve disabled_tool_prefixes; "
            "falling back to app ids",
            exc_info=True,
        )
        return [
            app_id.strip()
            for app_id in disabled_apps
            if isinstance(app_id, str) and app_id.strip()
        ]


AgentOrchestrator = None  # set after class definition for backward compat


class AgentDispatcher:
    """Forwards user messages to the bound device's local runtime."""

    def dispatch_external(
        self,
        session,
        user_message: str,
        space,
        *,
        attachments: Optional[list] = None,
        # ：用户 content_blocks（非 text）→ wire user_message_blocks
        blocks: Optional[list] = None,
        thread_id: Optional[str] = None,
        model_id: Optional[str] = None,
        system_prompt: Optional[str] = None,
        client_message_id: Optional[str] = None,
        # L-W6-02 (W6 M3)：app_context 透传 —— 主要用来抽取
        # ``workspace_snapshot`` 给 forward_prompt。其它字段（current_*）当前
        # 不在 dispatch_external 决策路径里使用，保留全包透传是为了让未来
        # 加新的 forward 字段（譬如 current_browser_tab_id）时不需要再扩展
        # dispatcher 形参。
        app_context: Optional[Dict[str, Any]] = None,
        # PR4-yolo (PRD v3 §5.6 Daemon 路径)：消息 body 透传的 AgentMode，
        # 落到 thread_context._agent_mode_var 让 publish_action 链路读到。
        agent_mode: Optional[str] = None,
        #  三档审批策略：对话级请求的审批档位（always_ask/auto/full_access）。
        # 透传到 forward payload 给设备 host 派生 judge 三档；Django 侧
        # frontend-action（publish_action 自动批）链路在三档下沉 Django 之前
        # 走 legacy 归一（auto/full_access → agent_mode ContextVar 记 'yolo'）。
        approval_mode: Optional[str] = None,
        agent_id: Optional[str] = None,
        execution_context=None,
    ) -> Dict[str, Any]:
        """
        Build and publish the ``agent.prompt.forward`` envelope so the bound
        device can pick it up and run it through the local agent runtime.

        Returns a status dict.  The caller should NOT block — runtime
        results arrive asynchronously via ``agent.stream.*`` WebSocket
        messages (relay_events 批量回传，由 relay_handler 落库 + 广播)。
        """
        from apps.services.agent_engine.services.prompt_forward_service import (
            PromptForwardService,
        )
        from apps.services.agent_execution.effective_runtime_config import (
            resolve_effective_runtime_config,
        )

        effective_config = resolve_effective_runtime_config(
            session,
            getattr(session, "user", None),
            agent_id=agent_id,
        )
        is_team_execution = bool(
            execution_context is not None and execution_context.is_team_space
        )
        runtime_target = (
            execution_context.execution_space
            if is_team_execution
            else getattr(session, "workspace", None)
        )
        backend_config = effective_config.agent_config.get("agent_backend", {})
        backend_type = backend_config.get("type", "builtin")
        effective_thread_id = thread_id or getattr(session, "effective_thread_id", None) or str(session.id)
        execution_owner_user_id = (
            execution_context.execution_owner_user_id
            if is_team_execution
            else str(getattr(session, "user_id", "") or "")
        )
        target_device_fingerprint = None
        from django.conf import settings

        daemon_control_enabled_for_organization = False
        if settings.DAEMON_CONTROL_ENABLED:
            from apps.services.daemon_control.feature import (
                daemon_control_enabled_for_organization as feature_enabled,
            )

            daemon_control_enabled_for_organization = feature_enabled(
                user_id=execution_owner_user_id,
                organization_id=str(
                    getattr(runtime_target, "organization_id", "") or ""
                ),
            )

        if is_team_execution and daemon_control_enabled_for_organization:
            execution_device = getattr(runtime_target, "device", None)
            workspace_device_fingerprint = str(
                getattr(execution_device, "fingerprint", "") or ""
            ).strip()
            from apps.services.daemon_control.client import (
                DaemonControlUnavailable,
                TargetDeviceUnavailable,
                resolve_device_by_installation,
            )

            try:
                target_device = resolve_device_by_installation(
                    owner_user_id=execution_owner_user_id,
                    installation_id=workspace_device_fingerprint,
                )
                target_device_fingerprint = target_device["installation_id"]
            except (DaemonControlUnavailable, TargetDeviceUnavailable) as exc:
                logger.warning(
                    "[AgentDispatcher] team Workspace device cannot accept work: "
                    "installation=%s error=%s",
                    workspace_device_fingerprint,
                    exc,
                )
                return {
                    "dispatched": True,
                    "backend_type": backend_type,
                    "thread_id": effective_thread_id,
                    "task_id": "",
                    "published": 0,
                }
        raw_target_device_id = (
            "" if is_team_execution else getattr(session, "target_device_id", "")
        )
        target_device_id = (
            raw_target_device_id.strip()
            if isinstance(raw_target_device_id, str)
            else ""
        )
        if target_device_id:
            if not daemon_control_enabled_for_organization:
                logger.warning(
                    "[AgentDispatcher] frozen target rejected while daemon control is disabled for organization: device=%s",
                    target_device_id,
                )
                return {
                    "dispatched": True,
                    "backend_type": backend_type,
                    "thread_id": effective_thread_id,
                    "task_id": "",
                    "published": 0,
                }

            from apps.services.daemon_control.client import (
                DaemonControlUnavailable,
                TargetDeviceUnavailable,
                resolve_device,
            )

            try:
                target_device = resolve_device(
                    owner_user_id=execution_owner_user_id,
                    device_id=target_device_id,
                )
                target_device_fingerprint = target_device["installation_id"]
                frozen_installation_id = getattr(
                    session, "target_device_installation_id", ""
                )
                if (
                    isinstance(frozen_installation_id, str)
                    and frozen_installation_id
                    and frozen_installation_id != target_device_fingerprint
                ):
                    raise TargetDeviceUnavailable("目标设备安装身份已变化")
            except (DaemonControlUnavailable, TargetDeviceUnavailable) as exc:
                logger.warning(
                    "[AgentDispatcher] target device cannot accept work: device=%s error=%s",
                    target_device_id,
                    exc,
                )
                return {
                    "dispatched": True,
                    "backend_type": backend_type,
                    "thread_id": effective_thread_id,
                    "task_id": "",
                    "published": 0,
                }

        # Community does not use the SaaS Daemon Control resolver.  Freeze the
        # already-authorized Workspace device on the execution run so prompt
        # admission can prove that the acknowledging socket owns this exact
        # delivery.  SaaS keeps its existing resolver and fallback behavior.
        if (
            getattr(settings, "TABTIN_EDITION", "saas") == "community"
            and target_device_fingerprint is None
        ):
            target_device_fingerprint = effective_config.device_fingerprint

        # FP-014 fix: 解析 Space 级禁用 APP 列表，注入到转发 payload 中
        disabled_apps = _resolve_disabled_apps_for_space(
            session,
            space,
            user_id_override=execution_owner_user_id,
        )
        disabled_tool_prefixes = _resolve_disabled_tool_prefixes(disabled_apps)

        yolo_mode = effective_config.approval_mode == "full_access"

        agent_backend_config: Dict[str, Any] = {
            "type": backend_type,
        }
        if disabled_apps:
            agent_backend_config["disabled_apps"] = disabled_apps
        if disabled_tool_prefixes:
            agent_backend_config["disabled_tool_prefixes"] = disabled_tool_prefixes
        if disabled_apps or disabled_tool_prefixes:
            logger.info(
                "[Orchestrator] Forwarding disabled_apps to local runtime: "
                "thread=%s disabled=%s disabled_tool_prefixes=%s",
                effective_thread_id, disabled_apps, disabled_tool_prefixes,
            )

        agent_id = effective_config.agent_id
        custom_rules = effective_config.custom_rules
        # 分层规则·个人基线层（IA Phase 3 §8.6）：与 custom_rules（Agent 专属层）
        # 一起在 host 端组装进 <custom_rules> 块。owner 身份 per-owner 取（见
        # resolve_layered_rules_for_forward docstring，与 userPortrait 对齐、非说话人）。
        personal_rules = PromptForwardService.resolve_personal_rules_by_owner_id(
            effective_config.agent_owner_user_id,
        )

        space_id_str: Optional[str] = None
        execution_limits: Optional[Dict[str, Any]] = None
        memory_capability: Optional[bool] = None
        # work_mode：Agent 工作目录类型（root 字段，非 agent_config 内），驱动
        # Daemon 路径 system prompt 的 `<work_mode>` 段。
        working_dir_type: Optional[str] = None

        if effective_config.agent_config:
            # work_mode：root 字段（''/None 归一为 None），独立于 agent_config v2 迁移。
            working_dir_type = effective_config.working_dir_type or None
            agent_config_full = effective_config.agent_config
            if isinstance(agent_config_full, dict):
                from apps.tabtinspace.agent_config_v2 import (
                    V2_SCHEMA_VERSION,
                    migrate_v1_to_v2,
                )
                from apps.services.common.agent_governance_resolver import (
                    resolve_execution_limits,
                    compact_execution_limits,
                )
                if agent_config_full.get("schema_version") != V2_SCHEMA_VERSION:
                    agent_config_full = migrate_v1_to_v2(agent_config_full)

                # ：execution_limits 优先 Workspace 字段，缺省回落 Agent。
                workspace_el = getattr(space, "execution_limits", None)
                if workspace_el is None:
                    session_workspace = getattr(session, "workspace", None)
                    workspace_el = getattr(session_workspace, "execution_limits", None)
                execution_limits = compact_execution_limits(
                    resolve_execution_limits(
                        agent_config_full,
                        workspace_execution_limits=workspace_el,
                    )
                )
                # 记忆「记=用」（决策 1 / TM-10 批 B）：memory_capability 闸门从
                # per-Agent（agent_config.memory.enabled）迁到 per-(user, organization)
                # 的 MemoRecordStyle.enabled —— 与"记录"侧同一权威
                # （MemoryTableService.is_memory_enabled_for），消除"在记却不召回"
                # 的孤儿闸门。wire 字段 memory_capability 不变（协议零改）。
                from apps.services.agent_engine.services.memory_table_service import (
                    MemoryTableService,
                )
                if MemoryTableService.is_memory_enabled_for(execution_owner_user_id, space.id):
                    memory_capability = True
            space_id_raw = getattr(space, "id", None)
            if space_id_raw is not None:
                space_id_str = str(space_id_raw)

        # ── PRD 05 v0.4 §7.1（W3-轮 1）crash resume 状态快照透传 ──
        # 用户重发 prompt 时（譬如客户端重启、或 user 重新点 send）把 PG 里
        # ``ConversationState.interrupt_state`` 整包透传给 daemon → DaemonAgentHost
        # 在 runtime.query 入口按 ``pending_approvals`` 回灌
        # PendingApprovalRegistry，避免审批快照丢失导致空轮触发
        # ``Maximum tool re-emit``。
        # peek 语义只读不清，daemon 处理完审批后会通过 approval_resolved
        # 路径在 ``relay_audit_writer._persist_approval_resolved`` 里清除。
        # 行不存在（首轮 / 新会话）→ None，forward_prompt 看到 None 不进 payload。
        from apps.services.agent_engine.persistence.conversation_store import (
            ConversationStore,
        )
        interrupt_state = ConversationStore.peek_interrupt_state(effective_thread_id)

        # ：单 HITL 断点恢复。与 pending_approvals 对称但源不同
        # ——从 PendingInteraction 表读 ask_choice/ask_form/permission_request
        # 未闭合行，合并进 wire interrupt_state.pending_single_hitl。
        # 惰性 import 避免顶层循环依赖；服务模块随 Django app 一起加载。
        from apps.services.agent_engine.services.pending_interaction_service import (
            list_pending_single_hitl_for_thread,
        )
        pending_single_hitl = list_pending_single_hitl_for_thread(effective_thread_id)
        if pending_single_hitl:
            interrupt_state = dict(interrupt_state) if isinstance(interrupt_state, dict) else {}
            interrupt_state["pending_single_hitl"] = pending_single_hitl

        # L-W6-02 (W6 M3)：从 app_context 抽 workspace_snapshot 透传给
        # PromptForwardService。app_context 经 chat.send_message handler 白名单
        # 过滤后传到本层；非 dict / 缺字段时下游 wire schema z.unknown() +
        # Daemon `decodeWorkspaceSnapshot` type guard 会兜底为 undefined，
        # daemon 退化到 sandbox-only 工作区，与"未传 workspace_snapshot"等价。
        workspace_snapshot: Optional[Dict[str, Any]] = None
        if isinstance(app_context, dict):
            ws_raw = app_context.get("workspace_snapshot")
            if isinstance(ws_raw, dict) and ws_raw:
                workspace_snapshot = ws_raw
        reply_context = extract_reply_context_from_app_context(app_context)
        reply_to_message_id = reply_context.get("reply_to_message_id")
        reply_to_preview = reply_context.get("reply_to_preview")
        display_message = reply_context.get("display_message")
        # ：执行文本拼装（quoted / preset / @）归执行端 Host；
        # Django 只透传用户原文 + reply_* wire 字段，禁止双拼。
        prompt_for_runtime = user_message
        #  / ：chat.send_message 经 app_context 隧道带入的 Skill 直链
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
        forward_app_context = dict(app_context or {})
        forward_app_context.pop("_skill_slash_invoke", None)
        # 执行锚点 / 身份与视觉 Focus 拆开（ R2-1）：
        # - 视觉 Focus 随客户端导航变（可为 tabdoc/chat）
        # - Project/Task/Run + collaboration/execution 身份只由 Session/
        #   ChatContext/TaskRun（及 team-space execution_context）派生，
        #   经 _server_focus_authority 强制写入；永不把视觉 appType 改回
        #   project_task 来「保活」锚点。
        from apps.services.agent_engine.context.focus_snapshot import (
            SERVER_FOCUS_AUTHORITY_KEY,
            build_server_focus_authority,
        )
        task_anchor = None
        try:
            from apps.tabtinspace.services.project_task_runtime import (
                resolve_project_task_execution_anchor,
            )
            task_anchor = resolve_project_task_execution_anchor(session)
        except Exception:
            logger.debug(
                "[AgentDispatcher] resolve_project_task_execution_anchor failed",
                exc_info=True,
            )

        collab_space_id = None
        exec_space_id = None
        initiator_uid = None
        owner_uid = None
        if execution_context is not None and execution_context.is_team_space:
            collab_space_id = execution_context.collaboration_space_id
            exec_space_id = execution_context.execution_space_id
            initiator_uid = execution_context.initiator_user_id
            owner_uid = execution_context.execution_owner_user_id
            forward_app_context["space_id"] = execution_context.execution_space_id

        project_id = task_id = task_run_id = None
        if isinstance(task_anchor, dict):
            project_id = task_anchor.get("project_id")
            task_id = task_anchor.get("task_id")
            task_run_id = task_anchor.get("task_run_id")
            collab_space_id = collab_space_id or task_anchor.get("collaboration_space_id")
            exec_space_id = exec_space_id or task_anchor.get("execution_space_id")

        if (
            collab_space_id
            or exec_space_id
            or initiator_uid
            or owner_uid
            or (project_id and task_id)
        ):
            # 会话派生权威覆盖 kickoff / 客户端残留的 _server_focus_authority。
            forward_app_context[SERVER_FOCUS_AUTHORITY_KEY] = build_server_focus_authority(
                collaboration_space_id=collab_space_id,
                execution_space_id=exec_space_id,
                initiator_user_id=initiator_uid,
                execution_owner_user_id=owner_uid,
                project_id=project_id,
                task_id=task_id,
                task_run_id=task_run_id,
            )

        # ── W7c · Stage 4 Daemon 路径对齐 (agent-prompt 治理 99 §阶段 4) ──
        #
        # Daemon ``buildSystemPrompt`` 路径之前缺：
        #   - ``app_context``    → ``<context>`` 每轮恒空（07 §F.3）
        #   - ``enabled_apps``   → ``<apps>`` 段恒空（07 §F.7）
        #   - ``space_name`` / ``organization_name`` → ``<environment>`` 只显 UUID（07 §F.1）
        #
        # 这里在 dispatcher 层派生后透传 —— Electron 路径走 IPC 已经有这些字段，
        # Daemon 路径只能由 Django 这条上游补齐。
        user_id_str = execution_owner_user_id
        enabled_apps_for_wire = PromptForwardService.derive_enabled_apps_for_forward(
            space=space,
            user_id=user_id_str or None,
        )
        _human_names = PromptForwardService.derive_human_readable_names_for_forward(space)
        space_name_for_wire = _human_names["space_name"]
        organization_name_for_wire = _human_names["organization_name"]

        # 路径权限治理 Wave 4：把 (thread_id, workspace_snapshot) 写到 ContextVar，
        # 让 FrontendActionService._resolve_sandbox_policy 在 publish_action 时能
        # 取到同一份 SSoT，做 SandboxPolicyResolver allow short-circuit（修 01
        # 图谱 §断层 6 "Django SandboxPolicyResolver 没有 workspace_snapshot"）。
        #
        # 安全设计（用户视角 Review · P1-4）：必须 try/finally + Token.reset 收尾，
        # 防止 daphne / celery prefork worker 复用线程时 ContextVar 残留到下一个
        # 请求（CA-007 同款治理）；元组形态 (thread_id, snapshot) 让 caller
        # 取值时做 thread_id 交叉校验，避免误读上一次请求残留。
        snapshot_token = None
        # PR4-yolo (PRD v3 §5.6 Daemon 路径)：与 workspace_snapshot 同语义写
        # agent_mode 到 ContextVar，让 FrontendActionService._resolve_sandbox_policy
        # 在 publish_action 时取到。PR0 改 from_agent_config 接受 requested_agent_mode
        # 入参后，整条 Daemon fail-safe 链路接通；PR0 未合并时该 ContextVar 写但
        # 读端没消费——等同 Daemon 路径继续按现状 collaborative。
        agent_mode_token = None
        try:
            from apps.services.common.thread_context import (
                set_current_workspace_snapshot,
                reset_current_workspace_snapshot,
                set_current_agent_mode,
                reset_current_agent_mode,
            )
            try:
                snapshot_token = set_current_workspace_snapshot(
                    effective_thread_id, workspace_snapshot
                )
            except Exception:
                logger.debug(
                    "[AgentDispatcher] set_current_workspace_snapshot failed (non-critical)",
                    exc_info=True,
                )
            agent_mode_for_context = agent_mode
            try:
                agent_mode_token = set_current_agent_mode(
                    effective_thread_id, agent_mode_for_context
                )
            except Exception:
                logger.debug(
                    "[AgentDispatcher] set_current_agent_mode failed (non-critical)",
                    exc_info=True,
                )

            # Space-first Phase 4：Space.type 不再承载 group 语义。
            # 未来多 Agent 群聊若需要 yolo 互斥，应从 group runtime 配置派生。
            is_group_space = False

            from apps.services.agent_engine.services.user_attachment_contract import (
                merge_attachment_blocks,
            )

            service = PromptForwardService()
            result = service.forward_prompt(
                thread_id=effective_thread_id,
                space=runtime_target,
                prompt=prompt_for_runtime,
                attachments=merge_attachment_blocks(attachments, blocks),
                user_message_blocks=_normalize_user_message_blocks(blocks),
                agent_backend_config=agent_backend_config,
                agent_id=agent_id,
                workspace_root=effective_config.workspace_root,
                model_id=model_id,
                system_prompt=system_prompt,
                runtime_mode="local",
                custom_rules=custom_rules,
                # ：展示名 → host agent-profile hook（贴用户消息前）。
                # 产品已去掉独立「当前目标」，不再透传 goal。
                agent_name=effective_config.agent_name or None,
                # 分层规则·个人基线层（IA Phase 3 §8.6）：与 custom_rules 对称透传。
                personal_rules=personal_rules,
                space_id=space_id_str,
                yolo_mode=yolo_mode,
                # PR4-yolo (PRD v3 §5.6 Daemon 路径 wire 字段透传)：把 chat body
                # 上传的 AgentMode 真正放到 payload，Daemon resolveAgentMode
                # 据此构造 policyContext.agentMode；缺省 None Daemon fail-safe 走 'agent'。
                agent_mode=agent_mode or effective_config.agent_mode or None,
                # ：审批档位 wire 透传；缺省 None host 走 legacy 归一。
                approval_mode=effective_config.approval_mode,
                approval_grant=effective_config.approval_grant,
                # PRD §1.4 + DR-15：群协作 runtime 与 yolo 强制互斥；wire 字段始终写入，
                # Daemon 直读 payload.is_group_space 写 policyContext.isGroupSpace（修 H5）。
                is_group_space=is_group_space,
                # L-W6-02：把主控端上传的 WorkspaceSnapshot 真正落到 wire payload。
                # PromptForwardService.forward_prompt 已有 ``workspace_snapshot``
                # 形参（M1/M2 落地），但调用方此前永远传 None —— 调用链就此打通。
                workspace_snapshot=workspace_snapshot,
                execution_limits=execution_limits,
                memory_capability=memory_capability,
                # work_mode：透传 Agent 工作目录类型，Daemon 据此注入 `<work_mode>` 段。
                working_dir_type=working_dir_type,
                display_message=display_message if isinstance(display_message, str) else None,
                reply_to_message_id=reply_to_message_id if isinstance(reply_to_message_id, str) else None,
                reply_to_preview=reply_to_preview if isinstance(reply_to_preview, dict) else None,
                skill_slash_invoke=skill_slash_invoke,
                # M2.5 方案 B（P1.3）：客户端 message UUID 透传给 DaemonAgentHost，
                # runtime 主轮 yield USER 事件时用此 id 闭合 temp id → server id 映射。
                client_message_id=client_message_id,
                interrupt_state=interrupt_state,
                # W7c · Stage 4：Daemon 路径关键 prompt 字段透传。
                # forward_prompt 内部按白名单投影 app_context，避免 Django 内部字段
                # （workspace_snapshot / channel_* / _request_*）泄漏到 LLM。
                app_context=forward_app_context,
                enabled_apps=enabled_apps_for_wire or None,
                space_name=space_name_for_wire,
                organization_name=organization_name_for_wire,
                # ：user+device 路由门禁——同机异账号不得串跑
                execution_owner_user_id=execution_owner_user_id or None,
                target_device_fingerprint=target_device_fingerprint,
            )
        finally:
            if snapshot_token is not None:
                try:
                    reset_current_workspace_snapshot(snapshot_token)
                except Exception:
                    logger.debug(
                        "[AgentDispatcher] reset_current_workspace_snapshot failed",
                        exc_info=True,
                    )
            if agent_mode_token is not None:
                try:
                    reset_current_agent_mode(agent_mode_token)
                except Exception:
                    logger.debug(
                        "[AgentDispatcher] reset_current_agent_mode failed",
                        exc_info=True,
                    )

        published = result["published"]
        task_id = result["task_id"]

        logger.info(
            "Dispatched local-runtime prompt: thread=%s task=%s published=%d",
            effective_thread_id,
            task_id,
            published,
        )
        return {
            "dispatched": True,
            "backend_type": backend_type,
            "thread_id": effective_thread_id,
            "task_id": task_id,
            "published": published,
        }


AgentOrchestrator = AgentDispatcher
