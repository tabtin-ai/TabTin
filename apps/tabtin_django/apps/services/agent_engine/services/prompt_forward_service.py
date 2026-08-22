"""
PromptForwardService — forwards user prompts to the device's local agent
runtime (Daemon / Electron) for execution.

Publishes ``agent.prompt.forward`` to the device topic so the bound
Daemon or Electron can pick it up and run it through the local runtime.
"""

from __future__ import annotations

import copy
import logging
import time
import uuid
from typing import Any, Dict, List, Optional

from pydantic import ValidationError

from apps.chat.conversation.services.message_role_policy import (
    is_system_authored_message,
    llm_role_for_persisted_message,
)
from apps.services.common.agent_protocol.constants import PromptForwardEvent as PFE
from apps.services.common.agent_protocol.namespace import device_action_topic
from apps.services.common.device_capability_registry import DEVICE_RUNTIME_TYPES
from apps.services.common.ws.bus import publish_device_ws_event_exact, publish_ws_event, publish_ws_event_reliable, WsPublishError, is_daemon_ws_connected, is_device_ws_connected
from apps.services.common.ws.protocol import build_envelope, new_event_id
from apps.services.agent_engine.services.action_transport_service import ActionTransportService

logger = logging.getLogger(__name__)

# ：跨轮记忆「滑动窗口」已统一禁用——_assemble_cross_turn_history 恒取全量历史，
# 与共享包 DEFAULT_MAX_HISTORY_MESSAGES=Infinity 对齐，截断统一交给本地 runtime
# CompactionOrchestrator。原 _DEFAULT_MAX_HISTORY_MESSAGES(10) / _MAX_HISTORY_MESSAGES_CAP(50)
# 常量随之移除（不再有调用方）。
# tool_call output 预截断阈值（char）——**灾难保护，正常路径不触发**。
#  canonical result 契约：截断只发生在一个边界。执行端装填历史时按共享包
# TOOL_RESULT_MAX_CHARS（40_000）统一截一次；转发层若先截（旧值 5000/40_000），
# 「截后 + 说明」长度仍超执行端阈值，会被再截一次、第一层说明被切掉——两端各自
# slice 即双重截断。故本层不改内容，只保留与 storage 灾难上限同量级的保护
# （终端 canonical envelope 上限 150K，正常永不触发本阈值）。
_BLOCK_OUTPUT_PRE_TRUNCATE_CHARS = 400_000

# P1-28/P1-30: drain backpressure and pagination constants
DRAIN_BATCH_SIZE = 20
DRAIN_PAGE_SIZE = 100
DRAIN_INTER_BATCH_SLEEP = 0.5  # seconds between batches
DRAIN_DEDUP_PREFIX = "pf:drain:dedup:"
DRAIN_DEDUP_TTL = 3600  # 1 hour
DRAIN_STREAM_KEY_PREFIX = "ws:evt:"


def _thread_binding_keys(thread_id: str) -> list[str]:
    value = str(thread_id or "").strip()
    if not value:
        return []
    if value.startswith("chat-session-"):
        raw = value[len("chat-session-"):]
        return [value, raw] if raw else [value]
    return [value, f"chat-session-{value}"]


def _resolve_model_capability_fields(model_id: Optional[str]) -> Dict[str, Any]:
    """按 ``model_id`` 解出该模型的上下文窗口 / 最大输出 / 多模态能力旗标。

    TS-18 H2 修复：forward 路径之前从不透传 ``context_window_tokens``，
    客户端（Electron/Daemon）的解析端读不到 → 回落 ``FALLBACK_MODEL_CAPABILITIES``
    的 32k（``ElectronAgentHost.ts:5848``），导致 ~19k 的 skill system prompt
    单条消息触发 ``emergency_blocking``。

    ：透传 ``supports_video_input``（Daemon 视频原生/降级门控）。
    ：透传 ``supports_document_input``（对话附件原生 file_url 直传门控）。
    同时补发 ``supports_vision``——forward-request-decoder 早已消费该字段，
    但此前 Django 从未下发，Daemon 视觉门控长期失效；与本改同批补洞。

    数据来源是 SSoT —— ``LLMModel.context_window_tokens`` /
    ``max_output_tokens_resolved`` / ``resolve_model_capabilities``（与 IPC
    路径、wire_adapter 同源），不硬编码任何数值。``model_id`` 在路由层就是
    ``str(LLMModel.id)``（见 ``agent_router._model_fields``）；为兼容历史调用方
    偶传 ``model_name`` 的情况，UUID 命中失败时回退按 ``model_name`` 查一次。

    解析失败（model_id 缺省 / 非法 UUID / 查无此模型 / DB 异常）一律返回 ``{}``
    —— 客户端继续走原 fallback 行为，向后兼容、绝不阻断 forward。
    """
    if not model_id:
        return {}
    try:
        from apps.services.llm.models import LLMModel
        from apps.services.llm.utils.capabilities import resolve_model_capabilities

        model = LLMModel.objects.filter(id=model_id).first()
        if model is None:
            # 历史兜底：个别调用方可能传 model_name 而非 UUID。
            model = LLMModel.objects.filter(model_name=str(model_id)).first()
        if model is None:
            return {}

        fields: Dict[str, Any] = {}
        ctx_window = model.context_window_tokens
        if isinstance(ctx_window, int) and ctx_window > 0:
            fields["context_window_tokens"] = ctx_window
            # max_output_tokens_resolved 永远返回正整数（带 4096 兜底），
            # 仅在拿到有效 context window 时一并透传，保持成对语义。
            max_output = model.max_output_tokens_resolved
            if isinstance(max_output, int) and max_output > 0:
                fields["max_output_tokens"] = max_output

        caps = resolve_model_capabilities(model)
        if caps.get("supports_vision") is True:
            fields["supports_vision"] = True
        if caps.get("supports_video_input") is True:
            fields["supports_video_input"] = True
        if caps.get("supports_document_input") is True:
            fields["supports_document_input"] = True
        capabilities_config = getattr(model, "capabilities_config", None)
        provider = getattr(model, "provider", None)
        provider_scope = str(getattr(provider, "scope", "") or "").strip().lower()
        supports_zip_input = (
            provider_scope in {"organization", "user"}
            or (
                isinstance(capabilities_config, dict)
                and capabilities_config.get("supports_zip_input") is True
            )
        )
        if supports_zip_input:
            fields["supports_zip_input"] = True
        return fields
    except Exception:
        logger.warning(
            "[PromptForward] resolve model capability fields failed for "
            "model_id=%s (non-critical, client falls back)",
            model_id,
            exc_info=True,
        )
        return {}


def _resolve_pressure_threshold_fields() -> Dict[str, Any]:
    """从 ``EngineRuntimeConfig`` 单例解出压缩分档阈值（ 第三波）。

    字段语义映射（三档口径，与本地 runtime ``pressure-router`` 对齐）：

    - ``ctx_pressure_high``              → ``micro_compact_start``（微压缩起点）
    - ``ctx_summary_trigger_fraction``   → ``llm_summary_start``（摘要档起点）
    - ``ctx_pressure_critical``          → ``emergency_start``（紧急档起点）

    宿主收到后按「云端 > env 旋钮 > runtime 默认」优先级落到
    ``EngineConfig.pressureThresholds``——AdminDash 上下文管理页调参由此真实生效。

    校验与 runtime 侧 ``resolvePressureThresholds`` 同口径：三值均在 (0, 1]
    且 ``micro <= llm_summary < emergency``。配置非法 / DB 异常一律返回 ``{}``
    （宿主走 env / 默认兜底），绝不阻断 forward。
    """
    try:
        from apps.chat.conversation.models import EngineRuntimeConfig

        cfg = EngineRuntimeConfig.get_config()
        micro = float(cfg.ctx_pressure_high)
        llm_summary = float(cfg.ctx_summary_trigger_fraction)
        emergency = float(cfg.ctx_pressure_critical)

        def _in_range(v: float) -> bool:
            return 0 < v <= 1

        if not (_in_range(micro) and _in_range(llm_summary) and _in_range(emergency)):
            return {}
        if not (micro <= llm_summary < emergency):
            return {}
        return {
            "pressure_thresholds": {
                "micro_compact_start": micro,
                "llm_summary_start": llm_summary,
                "emergency_start": emergency,
            }
        }
    except Exception:
        logger.warning(
            "[PromptForward] resolve pressure threshold fields failed "
            "(non-critical, host falls back to env/defaults)",
            exc_info=True,
        )
        return {}


class PromptForwardService:
    """Publishes agent.prompt.forward envelopes to bound devices."""

    # ── W7c · Stage 4 双路径对齐 ───────────────────────────────────────
    # Daemon 路径上 ``<apps>`` 段恒空 / ``<environment>`` 段只显 UUID（agent-prompt
    # 治理 07 §F.1 / §F.7）。下面 4 个白名单字段（app_context / enabled_apps /
    # space_name / organization_name）由 chat dispatcher / forward_runner 派生后透传
    # 到 wire payload，Daemon 解码后喂给 ``buildSystemPrompt``，让 prompt 关键段
    # 在 Daemon 路径上与 Electron 对齐。

    # app_context → wire Focus 投影见
    # ``apps.services.agent_engine.context.focus_snapshot.project_focus_for_wire``
    # （兼容 camel/snake/flat current_*；Host 只读 camelCase）。

    @staticmethod
    def _project_app_context_for_wire(
        app_context: Optional[Dict[str, Any]],
    ) -> Optional[Dict[str, Any]]:
        """投影 ``app_context`` 为 Host FocusSnapshot（camelCase）。

        委托 ``focus_snapshot.project_focus_for_wire``：
        视觉 Focus 经 normalizer；执行身份 / project_task 锚点仅接受
        ``_server_focus_authority`` 在投影后强制写入（ P1-1）。
        - 接受 camel / snake / flat ``current_*``
        - 用 App manifest 生成安全 ``appMeta`` + active ``openTabs``
        - 丢弃危险字段与客户端伪造 meta
        - 输出 ``appType`` / ``appMeta`` / ``openTabs`` / ``spaceId`` /
          ``userTimeZone`` 及 collaboration/execution 身份键

        作为绕过 WS 入口的兜底（scheduler / project_task / 直调 forward）。

        - 返回 ``None`` 表示"无可透传内容"（调用方应跳过 ``payload['app_context']``）。
        - daemon ``resolveAppContext`` 对 ``None`` / 缺字段同样兜底（语义对齐）。
        """
        from apps.services.agent_engine.context.focus_snapshot import (
            project_focus_for_wire,
        )

        return project_focus_for_wire(app_context)

    @staticmethod
    def derive_enabled_apps_for_forward(
        space,
        user_id: Optional[str],
    ) -> List[Dict[str, Any]]:
        """从 manifest + ``AppSettingsService`` 派生当前 Space 启用的 App 列表。

        与 Electron renderer 端 ``useSpaceApps.getEnabledApps`` + ``ContextRegistry``
        派生对齐 —— 字段集合（``key`` / ``cli_key`` / ``display_name`` / ``capability``
        / ``aliases``）严格对齐 ``@tabtin/agent-prompt`` 的 ``EnabledAppInfo``。

        **降级边界（必须在 99 文档登记）**：

        当前 manifest ``agentIntegration`` 块没有 ``displayName`` / ``capability`` /
        ``aliases`` 字段，本 helper 从 ``manifest.name`` / ``manifest.description``
        派生：
          - ``display_name = manifest.name``（英文产品名 "Tables" / "Docs"）—— 比
            Electron renderer ``handler.agent.displayName``（中文 "多维表" / "文档"）
            粗。**有意保留英文产品名而不是回退 raw id**（"tabdata"）：英文产品名对
            用户更友好，raw id 更糟。这是已知文案差距，待 manifest agentIntegration
            加 displayName 字段时提升（见 99 §阶段 4 留给后续）。
          - ``capability = manifest.description``；**空 description 时跳过该 app**
            （review P1：不输出 ``capability=""`` 的脏 entry）。
          - **不输出 ``aliases``**（review P1）：manifest ``typeAliases`` 是后端类型
            别名（'goal' / 'files' / 'folder' 等技术词），与 Electron handler
            ``agent.aliases``（用户口语词 "记事本" / "便签"）语义错位，注入 ``<apps>``
            段是噪音 + 误导 LLM。待 manifest 加真正的 ``agent.aliases`` 字段再输出。
          - ``cli_key = typeAliases[0]``：与 Electron ``handler.backendAliases[0]``
            同义（CLI 命令前缀，譬如 tabdata 的 cli_key 是 'table'）。

        **没 user_id（review P0）**：scheduler / system call / event-triggered
        RemoteAgent 路径 ``session.user_id`` 可能为空。这时 ``resolve_enabled_app_ids``
        会返回 None（不过滤），若 fallback 到 ``is_default_enabled`` 全集会把 Space
        实际禁用的 App 也透传给 LLM。改为**没 user_id 直接返回 []**（``<apps>`` 段
        跳过）——比让 LLM 看到错误 App 列表安全。

        Returns:
            list of {key, cli_key, display_name, capability} —— 形态匹配
            ``EnabledAppDtoSchema``。空列表表示派生失败 / 无 user_id / Space 无启用 App。
        """
        space_id = str(getattr(space, "id", "") or "") if space is not None else ""
        if not space_id:
            return []

        # review P0：没 user_id 时不能 fallback 到"全集"——会把 Space 禁用的 App
        # 透传给 LLM。直接返回 [] 让 daemon ``<apps>`` 段跳过（安全降级）。
        normalized_user_id = str(user_id) if user_id else ""
        if not normalized_user_id:
            logger.debug(
                "[PromptForward] enabled_apps 派生跳过：无 user_id（scheduler / system 路径），"
                "<apps> 段在 Daemon 路径上跳过",
            )
            return []

        try:
            from apps.services.common.app_registry import CORE_APPS, MARKETPLACE_APPS
            from apps.tabtinspace.services.app_settings_service import AppSettingsService
        except Exception:
            logger.error(
                "[PromptForward] enabled_apps 派生失败：app_registry / AppSettingsService 不可用 —— "
                "Daemon <apps> 段将缺失，Agent 失去 App 能力图谱",
                exc_info=True,
            )
            return []

        all_apps = {**CORE_APPS, **MARKETPLACE_APPS}
        if not all_apps:
            return []

        available_ids = {
            app_id
            for app_id, app_def in all_apps.items()
            if getattr(app_def, "has_prompt_section", False)
        }
        if not available_ids:
            return []

        enabled_ids = AppSettingsService.resolve_enabled_app_ids(
            user_id=normalized_user_id,
            space_id=space_id,
            available_app_ids=available_ids,
        )
        if enabled_ids is None:
            #: resolve_enabled_app_ids 返回 None 意为"无禁用记录、不做过滤" —— 此时
            #: 已确认有 user_id（上面早返回过），用 manifest ``is_default_enabled``
            #: 兜底（与 Space settings 初始化语义对齐：默认启用的 App 集合）。
            enabled_ids = sorted(
                app_id for app_id in available_ids
                if getattr(all_apps[app_id], "is_default_enabled", True)
            )
        if not enabled_ids:
            return []

        result: List[Dict[str, Any]] = []
        for app_id in enabled_ids:
            app_def = all_apps.get(app_id)
            if app_def is None:
                continue
            display_name = (getattr(app_def, "name", "") or app_def.id or "").strip()
            capability = (getattr(app_def, "description", "") or "").strip()
            # review P1：空 capability / display_name 的 app 不输出（避免脏 entry）。
            if not display_name or not capability:
                continue
            type_aliases = getattr(app_def, "type_aliases", ()) or ()
            cli_key = type_aliases[0] if type_aliases else None
            entry: Dict[str, Any] = {
                "key": app_def.id,
                "display_name": display_name,
                "capability": capability,
            }
            if cli_key and cli_key != app_def.id:
                entry["cli_key"] = cli_key
            # 注意：**不输出 aliases** —— manifest typeAliases 是技术别名，语义错位
            # （见上方 docstring）。manifest 加真正的 agent.aliases 字段后再补。
            result.append(entry)
        return result

    @staticmethod
    def derive_human_readable_names_for_forward(
        space,
    ) -> Dict[str, Optional[str]]:
        """从 ``space.name`` / ``space.organization.name`` 派生人类可读名。

        给 Daemon 的 ``<environment>`` 段用（治理 07 §F.1）：让段显"团队：研究组 /
        空间：研究 Space"而不是裸 UUID。

        抽成 staticmethod（与 ``derive_enabled_apps_for_forward`` 同模式）让
        ``AgentDispatcher.dispatch_external`` 与 ``forward_runner`` 两条调用路径
        共用 SSoT，避免各自 inline 22 行派生块漂移（review P1）。

        Returns:
            ``{"space_name": str|None, "organization_name": str|None}`` —— 空 / 缺失
            字段为 None，调用方直接透传给 ``forward_prompt``（内部再做非空才写入）。
        """
        space_name: Optional[str] = None
        organization_name: Optional[str] = None
        if space is not None:
            raw_space_name = getattr(space, "name", None)
            if isinstance(raw_space_name, str) and raw_space_name.strip():
                space_name = raw_space_name.strip()
            organization = getattr(space, "organization", None)
            if organization is not None:
                raw_organization_name = getattr(organization, "name", None)
                if isinstance(raw_organization_name, str) and raw_organization_name.strip():
                    organization_name = raw_organization_name.strip()
        return {"space_name": space_name, "organization_name": organization_name}

    @staticmethod
    def resolve_layered_rules_for_forward(space) -> Dict[str, Optional[str]]:
        """读分层规则的 个人基线（IA Phase 3 §8.6），供 forward 透传。

        - **个人基线**：Agent **owner**（= ``Organization.owner``）的
          ``UserProfile.personal_rules``，per-User 全局跨 Organization。

        **owner 身份取法**（与 userPortrait 现状对齐，PM 决策）：按 owner 而非当前
        说话人——共享 / 群聊 Space 下也注入 Agent 主人的个人规则，与 userPortrait
        per-owner 语义一致（host ``loadUserPortraitAsync`` 也按 organization → owner 装配）。

        抽成 staticmethod（与 ``derive_*_for_forward`` 同模式）让 dispatcher /
        forward_runner 两条路径共用 SSoT。跨库读（``owner_id`` 为跨库 User PK，
        UserProfile 在 default/MySQL）；读失败 → None（host 端该层在
        ``buildCustomRulesBlock`` 跳过，不阻塞 forward）。

        （原团队基线层 ``Organization.agent_rules`` 已下线，岗位差异化交给 skill 系统。）

        Returns:
            ``{"personal_rules": str|None}`` —— 空 / 缺失为 None，调用方直接透传给
            ``forward_prompt``（内部再做非空才写入 payload）。
        """
        organization = getattr(space, "organization", None) if space is not None else None
        owner_id = getattr(organization, "owner_id", None) if organization is not None else None
        return {
            "personal_rules": PromptForwardService.resolve_personal_rules_by_owner_id(
                owner_id
            ),
        }

    @staticmethod
    def resolve_personal_rules_by_owner_id(
        owner_id,
    ) -> Optional[str]:
        """读 Agent owner 的 UserProfile.personal_rules（per-owner 全局跨 Organization）。

        供 forward 与 Agent 详情 API 序列化共用 SSoT。owner_id 为空 / profile 无内容 /
        跨库读失败 → None（不阻塞调用方）。
        """
        if not owner_id:
            return None
        try:
            from apps.users.auth.models import UserProfile

            personal_val = (
                UserProfile.objects.filter(user_id=owner_id)
                .values_list("personal_rules", flat=True)
                .first()
            )
            if isinstance(personal_val, str) and personal_val.strip():
                return personal_val
        except Exception:
            logger.debug(
                "[PromptForward] resolve personal_rules failed (non-critical)",
                exc_info=True,
            )
        return None

    def forward_prompt(
        self,
        thread_id: str,
        space,
        prompt: str,
        attachments: List[Dict[str, Any]],
        agent_backend_config: Dict[str, Any],
        # ：用户 context / 结构化块（与 Electron userMessageBlocks 同源）。
        # 非空才写 wire `user_message_blocks`；旧 Daemon 忽略未知字段。
        user_message_blocks: Optional[List[Dict[str, Any]]] = None,
        workspace_root: Optional[str] = None,
        allow_busy: bool = False,
        agent_id: Optional[str] = None,
        model_id: Optional[str] = None,
        system_prompt: Optional[str] = None,
        attachment_strategy: Optional[str] = None,
        runtime_mode: Optional[str] = None,
        # ：Agent 专属规则（配置页「人设与规则」）。非空才写 payload；
        # host 写入 session.agentProfile.customRules，由 agent-profile hook
        # 贴用户消息前注入（不再进 system <custom_rules>）。
        custom_rules: Optional[str] = None,
        # ：Agent 展示名。与 custom_rules 同路径——非空才写 payload；
        # host 解包后写入 session.agentProfile，由 agent-profile hook 贴用户消息前注入。
        # 产品已去掉独立「当前目标」设计，不再透传 goal。
        agent_name: Optional[str] = None,
        # 设置 IA Phase 3 §8.6 分层规则·个人基线层。调用方（dispatcher /
        # forward_runner）通过 resolve_layered_rules_for_forward(space) 从 Agent owner
        # 的 UserProfile.personal_rules 读出后传入。非空才写 payload；host 组装
        # system <custom_rules>（仅个人层）。缺省 None 向后兼容。（团队基线层已下线。）
        personal_rules: Optional[str] = None,
        space_id: Optional[str] = None,
        yolo_mode: Optional[bool] = None,
        # PR4-yolo (PRD v3 §5.6 Daemon 路径 wire 字段透传)：客户端任务级
        # ``AgentMode``（yolo / agent / plan / ask / study / group）。
        # Daemon 收到后做两件事：
        #   1. ``DaemonAgentHost`` 据此构造 ``policyContext.agentMode``，
        #      让本地 SandboxPolicyResolver / two-step authorization 知道当前
        #      yolo 是否合法。
        #   2. 工具发回 Django publish_action 时，daemon 把 agent_mode 注回
        #      action params 让 Django 端 ContextVar 在跨进程边界重建（任务 3）。
        # 缺省 None 时 Daemon ``resolveAgentMode`` fail-safe 走 'agent'。
        agent_mode: Optional[str] = None,
        #  三档审批策略：对话级请求的审批档位（always_ask/auto/full_access）。
        # host 透传给 buildPolicyFromAgentConfigV2({ requestedApprovalMode }) 派生
        # judge 三档。缺省 None 不进 payload → host 走 legacy 归一
        # （agent_mode='yolo' → 'auto'，否则 'always_ask'）。
        approval_mode: Optional[str] = None,
        approval_grant: Optional[str] = None,
        # 交互档（HITL 四态 interactive/solo/scheduled/batch）。无人值守任务
        # （Tracker 后台 / 立即执行）传 'scheduled'，让设备 host 把
        # LocalPermissionHandler.runtimeMode 设为 scheduled（审批 0 秒 fail-fast）
        # 并让 host waitForUserInput 对该 session 立即 reject（LLM 主动 ask 也
        # fail-fast）。缺省 None → host 走 'interactive'，普通 chat 行为不变。
        interaction_mode: Optional[str] = None,
        # PRD §1.4 + DR-15：群协作 runtime 强制禁止 yolo。
        # Space-first Phase 4 后不再从 ``Space.type`` 派生；调用方当前显式传
        # False。未来多 Agent 群聊应由 group runtime 配置提供本字段。
        # 缺省 False 与历史 wire 行为兼容。
        is_group_space: bool = False,
        # Hilt v3 / W6 M2：客户端工作区快照（主要给 Daemon 用 —— Daemon 没有
        # 自己的 TabCode UI 来跟踪用户当前打开的项目，必须由调用方从主控端
        # 收集后透传过来）。Electron 主对话路径走 IPC，不需要走 forward。
        # 形态参考 ``@tabtin/security-policy`` 的 ``WorkspaceSnapshot``；
        # service 这里不强校验，DaemonAgentHost 内做 type guard + sandbox 兜底。
        workspace_snapshot: Optional[Dict[str, Any]] = None,
        execution_limits: Optional[Dict[str, Any]] = None,
        memory_capability: Optional[bool] = None,
        # work_mode：Agent 工作目录类型（code/doc/mixed），由 dispatcher 从
        # Agent.working_dir_type 读出后传入。透传到 wire payload，Daemon 据此
        # 注入 system prompt 的 `<work_mode>` 默认执行策略段。缺省时不透传。
        working_dir_type: Optional[str] = None,
        display_message: Optional[str] = None,
        reply_to_message_id: Optional[str] = None,
        reply_to_preview: Optional[Dict[str, Any]] = None,
        #  / ：斜杠 / quick-use Skill 直链 → wire skill_slash_invoke
        skill_slash_invoke: Optional[Dict[str, Any]] = None,
        # ── M2.5 方案 B（P1.3）: 客户端 message UUID 透传链路终端 ──
        # ChatService.send_message 传入 client_message_id → _stage_route →
        # agent_router.resolve_route → AgentDispatcher.dispatch_external →
        # 本字段 → payload['client_message_id'] → DaemonAgentHost 解出后透传给
        # runtime.query({ clientMessageId }) → runtime 主轮 yield USER 事件时
        # 用此 id（而非自己生成 UUID） → Django relay_message_writer 写入
        # ChatMessage.client_event_id → 客户端 temp id → server id 映射闭环。
        # 缺省时 Daemon 收到 undefined → runtime fallback 自生成 UUID（消息仍能
        # 入库，但客户端 temp id 映射会断）。详见
        client_message_id: Optional[str] = None,
        # ── PRD 05 v0.4 §7.1 + §7.2.3（W3-轮 1）crash resume 状态快照 ──
        # 上游（譬如 Django ``ConversationStateResumeService`` 或 daemon-online
        # 监听器在检测到 ``conversation_state.status='waiting_approval'`` 时）
        # 把 ``ConversationState.interrupt_state`` 直接透传过来——本服务只负责
        # 装进 payload，不负责拉 PG。``None`` / 空 ``{}`` 时不进 payload，向后
        # 兼容旧客户端。schema 见 ``InterruptState`` Pydantic 类。
        interrupt_state: Optional[Dict[str, Any]] = None,
        # ── W7c · Stage 4 Daemon 路径对齐（agent-prompt 治理 99 §阶段 4）──
        #
        # 这 5 个字段补上 Daemon 路径之前缺的 ``buildSystemPrompt`` 关键入参：
        #
        #   - ``app_context``    → ``buildContextInjectorHook`` 每轮注入 ``<context>``
        #   - ``enabled_apps``   → ``buildAppsSection`` 渲染 ``<apps>`` 段（07 §F.7）
        #   - ``space_name``     → ``buildEnvironmentSection`` 渲染人类可读 Space 名（07 §F.1）
        #   - ``organization_name``  → 同上，Organization 名
        #   - ``cli_reference``  → ``buildCliCapabilitiesSection`` 渲染 ``<cli_capabilities>`` 段
        #
        # 所有字段都 optional——缺省时 Daemon 走原 fallback 行为（``<apps>`` 段跳过、
        # ``<environment>`` 只显 UUID、Daemon 自己 spawn ``tabtin capabilities`` 取 CLI）。
        app_context: Optional[Dict[str, Any]] = None,
        enabled_apps: Optional[List[Dict[str, Any]]] = None,
        space_name: Optional[str] = None,
        organization_name: Optional[str] = None,
        cli_reference: Optional[str] = None,
        # ：执行主人用户 id。路由时 device.user_id 必须与此一致，
        # 防止同机多账号把 A 的会话打进 B 当前登录的 Electron。
        execution_owner_user_id: Optional[str] = None,
        interrupt_active: bool = False,
        # Daemon Control 已校验的目标 installation_id。非空时只投递该设备，
        # 离线不回退、不广播，也不静默排队给其它执行端。
        target_device_fingerprint: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Build and publish an ``agent.prompt.forward`` envelope.

        Returns ``{"task_id": ..., "published": int}`` where
        ``published`` is the number of successful publishes
        (0 = no device received it).

        When ``runtime_mode='local'``, the Daemon routes the envelope to
        DaemonAgentHost (local agent-runtime).  The optional ``custom_rules``
        is a user-configured field from ``tabtinspace.Agent`` (配置页「人设与规则」)
        and is forwarded verbatim so DaemonAgentHost can put it on
        ``session.agentProfile`` for the agent-profile hook .
        Empty / ``None`` values are omitted from the payload (backward compatible).

        Hilt W4 精简：删除 authorization_preset / permission_mode /
        operation_switches / authorization_rules / device_permissions。
        新增 yolo_mode 作为唯一安全开关。
        """
        task_id = f"prompt_{uuid.uuid4().hex[:12]}"
        run_id = str(uuid.uuid4())

        resolved_workspace_root = workspace_root or self._resolve_workspace_root(space)

        payload: Dict[str, Any] = {
            "task_id": task_id,
            "run_id": run_id,
            "prompt": prompt,
            "attachments": attachments,
            "agent_config": agent_backend_config,
            "workspace_root": resolved_workspace_root,
            "workspace_id": str(space.id),
        }
        if interrupt_active:
            payload["interrupt_active"] = True
        # ：非空才写，保持旧客户端兼容 + wire 体积。
        if user_message_blocks:
            payload["user_message_blocks"] = user_message_blocks
        if getattr(space, "organization_id", None):
            payload["organization_id"] = str(space.organization_id)
        if yolo_mode is not None:
            payload["yolo_mode"] = bool(yolo_mode)
        # PR4-yolo (PRD v3 §5.6)：wire 透传 AgentMode 给 Daemon —— 缺省（None）
        # 不进 payload，Daemon ``resolveAgentMode`` fail-safe 走 'agent'（任务 2）。
        if agent_mode is not None:
            payload["agent_mode"] = str(agent_mode)
        # ：审批档位 + Agent 已授权档位（grant）下发。
        #   - approval_mode：对话级请求档，仅显式给定时写入（同 agent_mode 语义）。
        #   - approval_grant：服务端权威 resolve（security.approval_grant，legacy
        #     allow_yolo_mode=true → 'auto'），始终显式写入——host 端 deriveApprovalMode
        #     用它做升档闸门（requested ≤ grant），避免 wire 默认值漂移 fail-open。
        if approval_mode is not None:
            payload["approval_mode"] = str(approval_mode)
        if approval_grant is not None:
            payload["approval_grant"] = approval_grant
        else:
            workspace_grant = getattr(space, "approval_grant", None)
            payload["approval_grant"] = (
                workspace_grant
                if workspace_grant in {"always_ask", "auto", "full_access"}
                else "always_ask"
            )
        # 交互档透传：仅在显式给定时写入（与 agent_mode 同语义）。缺省不写 →
        # host parsePromptForwardEnvelope 看不到 → 走 'interactive' 默认。
        if interaction_mode is not None:
            payload["interaction_mode"] = str(interaction_mode)
        # PRD §1.4 + DR-15：group / yolo 互斥 wire 透传。即使缺省 False 也写入，
        # 让 Daemon 端 ``parsePromptForwardEnvelope`` 始终有显式信号（任务 2 / 4）；
        # 与 yolo_mode 的"仅显式时写入"语义不同——这里 H5 fail-open 修复需要
        # Daemon 端默认 false 而非 undefined，强制写入避免 wire 默认值漂移。
        payload["is_group_space"] = bool(is_group_space)
        # Hilt v3 / W6 M2：仅在显式给定时塞入 payload，避免无谓的网络包膨胀
        # 与"Django 端推断 workspace"职责漂移（workspace 来源由主控端定义）。
        if workspace_snapshot:
            payload["workspace_snapshot"] = workspace_snapshot
        if agent_id:
            payload["agent_id"] = str(agent_id)
        if model_id:
            payload["model_id"] = str(model_id)
            # TS-18 H2：补发模型上下文窗口（及最大输出 token），从 LLMModel SSoT
            # 解析。缺这两个字段时客户端解析端回落 32k → ~19k skill system prompt
            # 触发 emergency_blocking。解析失败返回 {}（客户端走原 fallback）。
            payload.update(_resolve_model_capability_fields(str(model_id)))
        #  第三波：压缩分档阈值下发（AdminDash 上下文管理页 → 宿主
        # EngineConfig.pressureThresholds）。配置非法 / 读取失败返回 {}，
        # 宿主回落 env / runtime 默认。
        payload.update(_resolve_pressure_threshold_fields())
        if system_prompt and system_prompt.strip():
            payload["system_prompt"] = system_prompt
        if attachment_strategy:
            payload["attachment_strategy"] = attachment_strategy
        if runtime_mode:
            payload["runtime_mode"] = runtime_mode
        if custom_rules and custom_rules.strip():
            payload["custom_rules"] = custom_rules
        # ：与 custom_rules 同语义，非空才写（旧 host 忽略未知字段）。
        if agent_name and agent_name.strip():
            payload["agent_name"] = agent_name.strip()
        # 分层规则·个人基线层（IA Phase 3 §8.6）：与 custom_rules 同语义，非空才写
        # payload（保持 wire 体积小 + 向后兼容——旧 host 忽略未知字段、新 host 缺
        # 字段时该层在 buildCustomRulesBlock 跳过）。
        if personal_rules and personal_rules.strip():
            payload["personal_rules"] = personal_rules
        # W7b M3：仅在非空时塞入 payload，保持网络包小且向后兼容（旧客户端忽略未知字段）。
        if space_id:
            payload["space_id"] = space_id
        if execution_limits:
            payload["execution_limits"] = execution_limits
        if memory_capability is not None:
            payload["memory_capability"] = bool(memory_capability)
        # work_mode：仅在合法枚举值时透传（空串 / 未设置 / 脏值 → 不进 payload，
        # Daemon 跳过 `<work_mode>` 段注入）。
        if working_dir_type in ("code", "doc", "mixed"):
            payload["working_dir_type"] = working_dir_type
        if display_message is not None:
            payload["display_message"] = display_message
        if reply_to_message_id:
            payload["reply_to_message_id"] = reply_to_message_id
        if isinstance(reply_to_preview, dict):
            payload["reply_to_preview"] = reply_to_preview
        if isinstance(skill_slash_invoke, dict):
            skill_key = skill_slash_invoke.get("skill_key")
            if isinstance(skill_key, str) and skill_key.strip():
                wire_skill: Dict[str, Any] = {"skill_key": skill_key.strip()}
                skill_args = skill_slash_invoke.get("args")
                if isinstance(skill_args, str):
                    wire_skill["args"] = skill_args
                payload["skill_slash_invoke"] = wire_skill
        # M2.5 方案 B（P1.3）：仅在非空时塞入，向后兼容旧客户端。
        if client_message_id:
            payload["client_message_id"] = client_message_id
        # 消息作者与执行设备 owner 是两个身份：SessionShare 由访问者发言、
        # owner 设备执行。统一下发标准 sender_user_id，供本地 transcript 与
        # Django 副本记录同一事实。
        shared_sender_id = (
            app_context.get("_shared_chat_by")
            if isinstance(app_context, dict)
            else None
        )
        sender_user_id = shared_sender_id or execution_owner_user_id
        if sender_user_id:
            payload["sender_user_id"] = str(sender_user_id)
        if skill_slash_invoke and skill_slash_invoke.get("skill_key"):
            payload["skill_slash_invoke"] = skill_slash_invoke
        billing_scope = (
            app_context.get("billing_idempotency_key")
            if isinstance(app_context, dict)
            and app_context.get("_invoked_from") == "tabchat_mention"
            else None
        )
        if isinstance(billing_scope, str) and billing_scope:
            payload["billing_idempotency_scope"] = billing_scope

        # ── W7c · Stage 4 Daemon 路径对齐 ──
        # 这一段全是 optional 写入，缺省字段不进 payload（保持 wire 体积小 +
        # 与未升级 Daemon 客户端 100% 兼容）。
        projected_app_context = self._project_app_context_for_wire(app_context)
        if projected_app_context:
            payload["app_context"] = projected_app_context
        if enabled_apps:
            payload["enabled_apps"] = enabled_apps
        if space_name and space_name.strip():
            payload["space_name"] = space_name.strip()
        if organization_name and organization_name.strip():
            payload["organization_name"] = organization_name.strip()
        if cli_reference and cli_reference.strip():
            payload["cli_reference"] = cli_reference.strip()

        # PRD 05 v0.4 §7.1 W3-轮 1：crash resume 状态快照透传。
        # 仅在非空且含 ``pending_approvals`` 时塞入；其它形态（譬如 ``ask_user``
        # 等历史 interrupt 字段）不在本期范围内，避免污染 prompt.forward 体积。
        #
        # **schema 形状对齐（W3-轮 1 三视角 review 自修：避免 Daemon 整包 Zod
        # safeParse 失败）**：Django ``relay_audit_writer`` 在 PG 里存的是嵌套
        # batches（``[{batch_id, entries: [...]}]``），但 wire schema
        # ``InterruptStatePendingApprovalSchema`` 要求**每条 item 即一条 pending**
        # （含 ``request_id`` / ``tool_call_id`` 等扁平字段，详见
        # ``packages/agent-wire/src/prompt.ts:139-165``）。
        # 这里把存储格式 flatten 成 wire 格式：把 batch 元数据（``batch_id``
        # / ``runtime_mode``）下放到每条 entry，保证 Daemon 的
        # ``PromptForwardPayloadSchema.safeParse`` 通过、客户端
        # ``decodeWirePendingApprovals`` 收到的形状一致。
        if interrupt_state and isinstance(interrupt_state, dict):
            wire_interrupt_state: Optional[Dict[str, Any]] = None
            # TS ``InterruptStateSchema`` 的 version / snapshot 是 optional，
            # 不是 nullable。单 HITL 可以在没有 ConversationState 的情况下
            # 独立恢复，此时 dispatcher 合成的 interrupt_state 没有这两个
            # 元数据；wire 边界必须省略缺失值，不能把 ``dict.get`` 的 None
            # 序列化成 null 导致整条 prompt.forward 被 Zod 拒绝。
            wire_interrupt_metadata: Dict[str, Any] = {}
            interrupt_version = interrupt_state.get("version")
            if isinstance(interrupt_version, int) and not isinstance(
                interrupt_version,
                bool,
            ):
                wire_interrupt_metadata["version"] = interrupt_version
            interrupt_snapshot = interrupt_state.get("snapshot")
            if interrupt_snapshot is not None:
                wire_interrupt_metadata["snapshot"] = interrupt_snapshot

            pending_approvals = interrupt_state.get("pending_approvals")
            if isinstance(pending_approvals, list) and pending_approvals:
                flat_pending = self._flatten_pending_approvals_for_wire(pending_approvals)
                if flat_pending:
                    wire_interrupt_state = {
                        **wire_interrupt_metadata,
                        "pending_approvals": flat_pending,
                    }

            # ：单 HITL 断点恢复——ask_choice / ask_form /
            # permission_request 未闭合行由 ``agent_dispatcher`` 从
            # ``PendingInteraction`` 读出后合并到 ``interrupt_state``，此处
            # 直接透传（形态已经是 wire snake_case，见
            # ``pending_interaction_service._serialize_pending_single_hitl_wire``）。
            pending_single_hitl = interrupt_state.get("pending_single_hitl")
            if isinstance(pending_single_hitl, list) and pending_single_hitl:
                if wire_interrupt_state is None:
                    wire_interrupt_state = dict(wire_interrupt_metadata)
                wire_interrupt_state["pending_single_hitl"] = pending_single_hitl

            if wire_interrupt_state is not None:
                payload["interrupt_state"] = wire_interrupt_state

        # ── Phase 1 跨轮记忆：runtime_mode='local' 时组装 history ──
        # Daemon 收到后由 buildInitialMessages 消费，Agent 在多轮对话中
        # 能看到前几轮的内容和工具结果，不再每轮失忆。
        if runtime_mode == "local":
            history = self._assemble_cross_turn_history(
                thread_id=thread_id,
                space=space,
                # ：按本轮落库身份排除，勿用「最新是不是 user」位置启发式
                # （同 session 多 attempt / 同 turn 后插 assistant 都会让本轮指令泄漏进 history）。
                exclude_client_event_id=client_message_id,
            )
            if history:
                payload["history"] = history

        envelope = build_envelope(
            PFE.FORWARD,
            new_event_id(),
            payload,
            thread_id=thread_id,
        )

        from apps.services.agent_engine.services.session_run_state_service import (
            SessionRunStateService,
        )

        SessionRunStateService.accept_dispatch(
            thread_id=thread_id,
            run_id=run_id,
            task_id=task_id,
            execution_owner_user_id=execution_owner_user_id,
            target_device_installation_id=target_device_fingerprint,
        )
        try:
            published = self._route_to_device(
                thread_id,
                space,
                envelope,
                reliable=True,
                allow_busy=allow_busy,
                agent_id=agent_id,
                execution_owner_user_id=execution_owner_user_id,
                target_device_fingerprint=target_device_fingerprint,
            )
        except Exception:
            SessionRunStateService.transition(
                run_id=run_id,
                status="failed",
                stop_reason="forward_exception",
                error_class="dispatch_error",
            )
            raise

        if published == 0:
            SessionRunStateService.transition(
                run_id=run_id,
                status="failed",
                stop_reason="forward_failed",
                error_class="device_unreachable",
            )
            logger.error(
                "CRITICAL: No device received prompt forward for thread=%s "
                "(no bound daemon or Electron online for owner=%s)",
                thread_id,
                execution_owner_user_id or "",
            )

        return {"task_id": task_id, "run_id": run_id, "published": published}

    def forward_cancel(
        self,
        thread_id: str,
        task_id: Optional[str],
        space,
        agent_id: Optional[str] = None,
        *,
        withdraw_unanswered: bool = False,
        client_message_id: Optional[str] = None,
        target_content: Optional[str] = None,
        session_id: Optional[str] = None,
        target_device_fingerprint: Optional[str] = None,
    ) -> int:
        """Publish agent.prompt.cancel to the bound device.

         按 thread 取消：``task_id`` 改为可选。取消的权威身份是 envelope
        顶层 ``thread_id``（业务会话）——设备端（Electron ``handleAbortFromEnvelope``
        / Daemon ``handlePromptCancel``）按 task_id → thread_id 顺序解析候选，
        经 ``resolveAbortSessionKeys`` 统一命中。缺省 task_id（普通 chat stop
        没有 Tracker 那样的 ``_runtime_task_id`` 记录）时 payload 不带该字段，
        设备端按业务会话命中当前 run。
        """
        payload: Dict[str, Any] = {"task_id": task_id} if task_id else {}
        if withdraw_unanswered and client_message_id and session_id:
            payload.update({
                "withdraw_unanswered": True,
                "client_message_id": client_message_id,
                "session_id": session_id,
                "target_content": target_content or "",
                "space_id": str(space.id),
                "organization_id": str(space.organization_id),
            })
        envelope = build_envelope(
            PFE.CANCEL,
            new_event_id(),
            payload,
            thread_id=thread_id,
        )
        return self._publish_exclusive(
            thread_id,
            space,
            envelope,
            agent_id=agent_id,
            target_device_fingerprint=target_device_fingerprint,
        )

    def forward_pause_control(
        self,
        thread_id: str,
        space,
        *,
        paused: bool,
        agent_id: Optional[str] = None,
        target_device_fingerprint: Optional[str] = None,
    ) -> int:
        """在下一次安全迭代边界暂停或继续同一个 runtime run。"""
        envelope = build_envelope(
            PFE.PAUSE if paused else PFE.RESUME,
            new_event_id(),
            {},
            thread_id=thread_id,
        )
        return self._publish_exclusive(
            thread_id,
            space,
            envelope,
            agent_id=agent_id,
            target_device_fingerprint=target_device_fingerprint,
        )

    def forward_subagent_cancel(
        self,
        thread_id: str,
        child_id: str,
        space,
        agent_id: Optional[str] = None,
        target_device_fingerprint: Optional[str] = None,
    ) -> int:
        """Publish agent.subagent.cancel to the bound device (W5-a).

        与 :meth:`forward_cancel`（整轮取消）对称，但只取消单个子 Agent：
        下行 envelope ``type`` 必须正好是 ``agent.subagent.cancel``、payload 只带
        ``{child_id}``——daemon 接收端（``daemon.ts`` ``handleSubagentCancel`` →
        ``localAgentHost.cancelSubagentById(child_id)``）就按此契约解码。
        """
        envelope = build_envelope(
            PFE.SUBAGENT_CANCEL,
            new_event_id(),
            {"child_id": child_id},
            thread_id=thread_id,
        )
        return self._publish_exclusive(
            thread_id,
            space,
            envelope,
            agent_id=agent_id,
            target_device_fingerprint=target_device_fingerprint,
        )

    def _publish_exclusive(
        self,
        thread_id: str,
        space,
        envelope: dict,
        *,
        agent_id: Optional[str] = None,
        execution_owner_user_id: Optional[str] = None,
        target_device_fingerprint: Optional[str] = None,
    ) -> int:
        """Route to Daemon or Electron. Returns 0 when no device is reachable."""
        bound_device = (
            (target_device_fingerprint or "").strip()
            or self._get_frozen_target_device(thread_id)
            or self._get_bound_action_device(thread_id)
        )
        return self._route_to_device(
            thread_id,
            space,
            envelope,
            reliable=True,
            allow_busy=True,
            agent_id=agent_id,
            execution_owner_user_id=execution_owner_user_id,
            target_device_fingerprint=bound_device,
        )

    @staticmethod
    def _get_frozen_target_device(thread_id: str) -> Optional[str]:
        """Read the immutable target for control paths that do not carry a session."""
        from apps.chat.conversation.models import ChatSession

        value = str(thread_id or "").strip()
        if not value:
            return None
        session = (
            ChatSession.objects.filter(thread_id=value)
            .only("target_device_installation_id")
            .first()
        )
        if session is None and value.startswith("chat-session-"):
            raw_id = value[len("chat-session-") :]
            try:
                uuid.UUID(raw_id)
            except (TypeError, ValueError, AttributeError):
                pass
            else:
                session = (
                    ChatSession.objects.filter(id=raw_id)
                    .only("target_device_installation_id")
                    .first()
                )
        target = getattr(session, "target_device_installation_id", "")
        return target.strip() if isinstance(target, str) and target.strip() else None

    @staticmethod
    def _get_bound_action_device(thread_id: str) -> Optional[str]:
        try:
            transport = ActionTransportService()
            for key in _thread_binding_keys(thread_id):
                device = transport.get_action_device(key)
                if device:
                    return device
        except Exception:
            logger.debug(
                "[PromptForward] resolve bound action device failed: thread=%s",
                thread_id,
                exc_info=True,
            )
        return None

    @staticmethod
    def probe_execution_device_reachable(
        space,
        *,
        agent_id: Optional[str] = None,
        execution_owner_user_id: Optional[str] = None,
        allow_busy: bool = True,
    ) -> Dict[str, Any]:
        """只读探测执行机是否可达（与 ``_route_to_device`` 投递成功条件同源）。

        不 publish、不写 Redis Stream、无审计副作用。供 shared-chat 发送前预检
        （打开 pane / 刷新 / 点发送）使用，避免先落 user 消息再报 offline。

        Returns:
            ``{reachable: bool, error_category: str|None, runtime: str|None}``
            ``error_category`` 在不可达时为 ``device_offline``（与 router 分类对齐）。
        """
        owner_user_id = (execution_owner_user_id or "").strip() or None
        daemon_fp = PromptForwardService._resolve_daemon_fingerprint(
            space,
            allow_busy=allow_busy,
            agent_id=agent_id,
            execution_owner_user_id=owner_user_id,
        )
        if daemon_fp and is_daemon_ws_connected(daemon_fp):
            return {
                "reachable": True,
                "error_category": None,
                "runtime": "daemon",
            }

        electron_fp = PromptForwardService._resolve_electron_control_fingerprint(
            space,
            agent_id=agent_id,
            execution_owner_user_id=owner_user_id,
        )
        if electron_fp and is_device_ws_connected(electron_fp):
            return {
                "reachable": True,
                "error_category": None,
                "runtime": "electron",
            }

        return {
            "reachable": False,
            "error_category": "device_offline",
            "runtime": None,
        }

    def _route_to_device(
        self,
        thread_id: str,
        space,
        envelope: dict,
        *,
        reliable: bool = False,
        allow_busy: bool = False,
        agent_id: Optional[str] = None,
        execution_owner_user_id: Optional[str] = None,
        target_device_fingerprint: Optional[str] = None,
    ) -> int:
        """
        Unified device routing: Daemon first, then Electron control_device.
        Returns the number of successful publishes (0 or 1).

        When a Daemon is bound but offline, the envelope is still persisted
        to the Redis Stream so the resume protocol can deliver it once the
        Daemon reconnects.

         / ：执行机必须同时满足「绑定设备 + 归属执行主人」；
        同物理机上另一账号的 Device 行不得承接本用户会话。
        """
        target_device = (target_device_fingerprint or "").strip()
        if target_device:
            try:
                if publish_device_ws_event_exact(
                    target_device,
                    envelope,
                    reliable=reliable,
                ):
                    self._bind_action_device_for_thread(thread_id, target_device)
                    return 1
            except WsPublishError:
                logger.warning(
                    "[PromptForward] exact target WS unreachable for thread=%s",
                    thread_id,
                )
            # 点对点 ready 租约丢失时，同一台设备的 topic group 可能还在
            # （Electron 聊天频道活着、action lease 过期）。入 resume stream
            # 后再试同 fingerprint 的 group 投递；绝不改投其它设备。
            topic = device_action_topic(target_device)
            self._persist_to_stream(topic, dict(envelope), thread_id, target_device)
            if self._try_publish(
                topic, envelope, False, thread_id, "frozen-target-group",
            ):
                self._bind_action_device_for_thread(thread_id, target_device)
                return 1
            return 0

        owner_user_id = (execution_owner_user_id or "").strip() or None
        daemon_fp = self._resolve_daemon_fingerprint(
            space,
            allow_busy=allow_busy,
            agent_id=agent_id,
            execution_owner_user_id=owner_user_id,
        )
        if daemon_fp:
            topic = device_action_topic(daemon_fp)
            if is_daemon_ws_connected(daemon_fp):
                if self._try_publish(topic, envelope, reliable, thread_id, "daemon"):
                    self._bind_action_device_for_thread(thread_id, daemon_fp)
                    return 1
            else:
                self._persist_to_stream(topic, dict(envelope), thread_id, daemon_fp)
        else:
            bound_fp = self._resolve_bound_daemon_fingerprint(
                space,
                agent_id=agent_id,
                execution_owner_user_id=owner_user_id,
            )
            if bound_fp:
                topic = device_action_topic(bound_fp)
                self._persist_to_stream(topic, dict(envelope), thread_id, bound_fp)

        # Electron：只认显式 control_device，且 device.user_id == 执行主人。
        electron_fp = self._resolve_electron_control_fingerprint(
            space,
            agent_id=agent_id,
            execution_owner_user_id=owner_user_id,
        )
        if electron_fp:
            topic = device_action_topic(electron_fp)
            if is_device_ws_connected(electron_fp):
                if self._try_publish(topic, envelope, reliable, thread_id, "Electron"):
                    self._bind_action_device_for_thread(thread_id, electron_fp)
                    logger.info("[PromptForward] Routed to Electron device for thread=%s", thread_id)
                    return 1
            else:
                self._persist_to_stream(topic, dict(envelope), thread_id, electron_fp)
                if self._try_publish(topic, envelope, False, thread_id, "Electron"):
                    self._bind_action_device_for_thread(thread_id, electron_fp)
                    logger.info(
                        "[PromptForward] Routed to Electron group after ready-lease miss: thread=%s",
                        thread_id,
                    )
                    return 1

        return 0

    @staticmethod
    def _bind_action_device_for_thread(thread_id: str, device_fingerprint: str) -> None:
        """Remember the runtime that actually accepted this turn.

        HITL responses often arrive from a different client than the prompt
        sender.  Binding the thread to the successfully-routed runtime keeps
        ``localrt.user_response`` from falling back to session-level guessing,
        especially for mobile-created sessions that are not yet visible in the
        Electron conversation list.
        """
        try:
            transport = ActionTransportService()
            for key in _thread_binding_keys(thread_id):
                transport.bind_action_device(key, device_fingerprint)
            logger.info(
                "[PromptForward] Bound action device for thread=%s device=%s",
                thread_id, device_fingerprint,
            )
        except Exception:
            logger.debug(
                "[PromptForward] bind action device failed: thread=%s device=%s",
                thread_id, device_fingerprint, exc_info=True,
            )

    @staticmethod
    def _persist_to_stream(topic: str, envelope: dict, thread_id: str, fingerprint: str) -> None:
        """Write envelope to Redis Stream for later resume consumption (Daemon offline)."""
        try:
            from apps.services.common.ws.event_buffer import get_event_buffer
            buf = get_event_buffer()
            buf.append_event(topic, envelope)
            logger.warning(
                "[PromptForward] daemon offline — persisted to stream for resume: "
                "thread=%s fp=%s",
                thread_id, fingerprint,
            )
        except Exception:
            logger.error(
                "[PromptForward] failed to persist to stream while daemon offline: "
                "thread=%s fp=%s",
                thread_id, fingerprint, exc_info=True,
            )

    @staticmethod
    def _try_publish(topic: str, envelope: dict, reliable: bool, thread_id: str, label: str) -> bool:
        """Publish to a device topic. Returns True on success."""
        try:
            if reliable:
                publish_ws_event_reliable(topic, envelope)
                return True
            else:
                return bool(publish_ws_event(topic, envelope))
        except WsPublishError:
            logger.warning("[PromptForward] %s WS unreachable for thread=%s", label, thread_id)
            return False

    @staticmethod
    def drain_pending_forwards(fingerprint: str) -> Dict[str, Any]:
        """Paginated, batched drain of pending ``agent.prompt.forward`` events.

        Fixes P1-28 / P1-29 / P1-30:

        * **P1-28 backpressure** — publishes at most ``DRAIN_BATCH_SIZE``
          events per batch with ``DRAIN_INTER_BATCH_SLEEP`` pause between
          batches so Celery and the DB are not overwhelmed.
        * **P1-29 idempotency** — each event is dedup-checked via Redis
          ``SET NX`` (key ``pf:drain:dedup:{stream_id}``) before publish.
          Successfully published (or dedup-skipped) events are removed
          from the stream with ``XDEL`` (ACK).
        * **P1-30 pagination** — reads ``DRAIN_PAGE_SIZE`` events at a
          time using cursor advancement; loops until the stream is
          exhausted.

        Returns a stats dict::

            {"total": int, "published": int, "skipped_dedup": int,
             "failed": int, "pages": int}
        """
        stats: Dict[str, Any] = {
            "total": 0, "published": 0, "skipped_dedup": 0,
            "failed": 0, "pages": 0,
        }
        try:
            from apps.services.common.ws.event_buffer import get_event_buffer
            from django_redis import get_redis_connection

            topic = device_action_topic(fingerprint)
            buf = get_event_buffer()
            redis_client = get_redis_connection("default")
            stream_key = f"{DRAIN_STREAM_KEY_PREFIX}{topic}"

            cursor = "0-0"
            batch_count = 0

            while True:
                events = buf.read_after(topic, cursor, limit=DRAIN_PAGE_SIZE)
                if not events:
                    break
                stats["pages"] += 1

                page_forwards: List[tuple] = []
                for stream_id, envelope in events:
                    cursor = stream_id
                    if envelope.get("type", "") == PFE.FORWARD:
                        page_forwards.append((stream_id, envelope))

                stats["total"] += len(page_forwards)

                for i in range(0, len(page_forwards), DRAIN_BATCH_SIZE):
                    batch = page_forwards[i:i + DRAIN_BATCH_SIZE]

                    if batch_count > 0:
                        time.sleep(DRAIN_INTER_BATCH_SLEEP)
                    batch_count += 1

                    acked_ids: List[str] = []
                    for stream_id, envelope in batch:
                        dedup_key = f"{DRAIN_DEDUP_PREFIX}{stream_id}"
                        if not redis_client.set(dedup_key, "1", nx=True, ex=DRAIN_DEDUP_TTL):
                            stats["skipped_dedup"] += 1
                            acked_ids.append(stream_id)
                            continue

                        if PromptForwardService._try_publish(
                            topic, envelope, reliable=True,
                            thread_id=envelope.get("thread_id", ""),
                            label="drain",
                        ):
                            stats["published"] += 1
                            acked_ids.append(stream_id)
                        else:
                            stats["failed"] += 1
                            try:
                                redis_client.delete(dedup_key)
                            except Exception:
                                pass  # defensive: 去重键删除失败，下次 drain 可能重复尝试
                            logger.warning(
                                "[PromptForward] drain: publish failed stream_id=%s, "
                                "will retry on next drain",
                                stream_id,
                            )

                    if acked_ids:
                        try:
                            redis_client.xdel(stream_key, *acked_ids)
                        except Exception:
                            logger.warning(
                                "[PromptForward] drain: XDEL failed for %d events",
                                len(acked_ids), exc_info=True,
                            )

                if len(events) < DRAIN_PAGE_SIZE:
                    break

            logger.info(
                "[PromptForward] drain completed: fp=%s total=%d published=%d "
                "dedup=%d failed=%d pages=%d",
                fingerprint, stats["total"], stats["published"],
                stats["skipped_dedup"], stats["failed"], stats["pages"],
            )
            return stats
        except Exception:
            logger.error(
                "[PromptForward] drain_pending_forwards failed for fp=%s",
                fingerprint, exc_info=True,
            )
            stats["error"] = True
            return stats

    @staticmethod
    def _device_belongs_to_execution_owner(
        device,
        execution_owner_user_id: Optional[str],
    ) -> bool:
        """#6799：执行机必须归属执行主人（user + device），同机异账号不得串跑。

        ``execution_owner_user_id`` 缺失时 fail-closed（不当作可投递设备），
        避免账号切换改写 Device.user 后仍按 fingerprint 误投。
        """
        owner = (execution_owner_user_id or "").strip()
        if not owner:
            return False
        device_user = getattr(device, "user_id", None)
        if device_user is None:
            return False
        return str(device_user) == owner

    @staticmethod
    def _resolve_bound_daemon_fingerprint(
        space,
        *,
        agent_id: Optional[str] = None,
        execution_owner_user_id: Optional[str] = None,
    ) -> Optional[str]:
        """Get the fingerprint of the bound daemon device regardless of its
        online status.  Used for Redis Stream persistence so the resume
        protocol can deliver messages when the Daemon reconnects."""
        if space is None and not agent_id:
            return None
        from apps.tabtinspace.services.execution_binding import resolve_control_device

        bound_device = resolve_control_device(space=space, agent_id=agent_id)
        if bound_device is None:
            return None
        if getattr(bound_device, "device_type", None) not in DEVICE_RUNTIME_TYPES:
            return None
        if not PromptForwardService._device_belongs_to_execution_owner(
            bound_device, execution_owner_user_id,
        ):
            logger.info(
                "[PromptForward] skip bound daemon: device user mismatch owner=%s device_user=%s",
                execution_owner_user_id,
                getattr(bound_device, "user_id", None),
            )
            return None
        fingerprint = getattr(bound_device, "fingerprint", None)
        return fingerprint or None

    @staticmethod
    def _resolve_daemon_fingerprint(
        space,
        *,
        allow_busy: bool = False,
        agent_id: Optional[str] = None,
        execution_owner_user_id: Optional[str] = None,
    ) -> Optional[str]:
        """Get the fingerprint of the bound daemon device if it is reachable."""
        if space is None and not agent_id:
            return None
        from apps.tabtinspace.services.execution_binding import resolve_control_device

        bound_device = resolve_control_device(space=space, agent_id=agent_id)
        if bound_device is None:
            return None
        if getattr(bound_device, "device_type", None) not in DEVICE_RUNTIME_TYPES:
            return None
        if not PromptForwardService._device_belongs_to_execution_owner(
            bound_device, execution_owner_user_id,
        ):
            logger.info(
                "[PromptForward] skip daemon: device user mismatch owner=%s device_user=%s",
                execution_owner_user_id,
                getattr(bound_device, "user_id", None),
            )
            return None
        allowed_statuses = {"online", "busy"} if allow_busy else {"online"}
        if getattr(bound_device, "status", None) not in allowed_statuses:
            return None
        fingerprint = getattr(bound_device, "fingerprint", None)
        return fingerprint or None

    @staticmethod
    def _resolve_electron_control_fingerprint(
        space,
        *,
        agent_id: Optional[str] = None,
        execution_owner_user_id: Optional[str] = None,
    ) -> Optional[str]:
        """Get the fingerprint of the Agent's **explicitly bound** control_device when
        it is an online/busy Electron owned by the execution user.

        Honors the explicit binding regardless of organization (e.g. a team-space Agent
        whose control_device is the user's Electron registered under their personal
        organization). ：不再回退到「同 organization 任意 Electron」。
        ：device.user_id 必须等于 execution_owner_user_id。
        """
        if space is None and not agent_id:
            return None
        from apps.tabtinspace.services.execution_binding import resolve_control_device

        bound_device = resolve_control_device(space=space, agent_id=agent_id)
        if bound_device is None:
            return None
        if getattr(bound_device, "device_type", None) != "electron":
            return None
        if getattr(bound_device, "status", None) not in ("online", "busy"):
            return None
        if not PromptForwardService._device_belongs_to_execution_owner(
            bound_device, execution_owner_user_id,
        ):
            logger.info(
                "[PromptForward] skip electron: device user mismatch owner=%s device_user=%s fp=%s",
                execution_owner_user_id,
                getattr(bound_device, "user_id", None),
                getattr(bound_device, "fingerprint", None),
            )
            return None
        fingerprint = getattr(bound_device, "fingerprint", None)
        return fingerprint or None

    @staticmethod
    def _flatten_pending_approvals_for_wire(
        nested_pending: List[Any],
    ) -> List[Dict[str, Any]]:
        """把 PG 嵌套 batches 形态 flatten 成 wire schema 扁平形态。

        PG 存储（``relay_audit_writer._persist_approval_requested`` 写入）::
            [
                {
                    "batch_id": "...", "approval_type": "tool_permission",
                    "runtime_mode": "solo", "expires_at": ..., "schema_version": 1,
                    "created_at": ..., "entries": [<pending_entry>, ...],
                },
                ...
            ]

        Wire schema（``InterruptStatePendingApprovalSchema`` / Pydantic
        ``InterruptStatePendingApproval``）::
            [
                {
                    "batch_id": "...", "request_id": "...", "tool_call_id": "...",
                    "tool_name": "...", "status": "pending", "outcome": ...,
                    "runtime_mode": "solo", "expires_at": ..., "created_at": ...,
                    ...其它 per-request 字段
                },
                ...
            ]

        转换规则：
        - 把 batch_meta 的 ``batch_id`` / ``runtime_mode`` / ``expires_at`` /
          ``created_at`` 下放到每条 entry（已有同名字段时**优先保留 entry 上的值**）；
        - 单条 entry 必须含 ``request_id`` / ``tool_call_id`` / ``tool_name``
          才进入输出（缺一即 skip + 后续日志由调用方处理）；
        - 容错：非 dict 元素直接跳过；entries 缺失 / 非数组也跳过。

        若 PG 端已经被改成扁平形态（双方都各自满足 wire schema），本函数对单条
        ``request_id`` 顶层 dict 直接透传——保证未来 schema 演进期不破坏。
        """
        flat: List[Dict[str, Any]] = []
        for batch_meta in nested_pending:
            if not isinstance(batch_meta, dict):
                continue

            entries = batch_meta.get("entries")
            # 检测形态：含 ``entries`` 数组 → 嵌套；否则 batch_meta 自身就是
            # 扁平 entry（含 request_id / tool_call_id 顶层）。
            if isinstance(entries, list):
                # 嵌套形态：从 batch_meta 提取共享字段，下放到 entries
                shared_batch_id = batch_meta.get("batch_id")
                shared_runtime_mode = batch_meta.get("runtime_mode") or "interactive"
                shared_expires_at = batch_meta.get("expires_at")
                shared_created_at = batch_meta.get("created_at")
                shared_approval_type = batch_meta.get("approval_type") or "tool_permission"

                for entry in entries:
                    if not isinstance(entry, dict):
                        continue
                    if not (
                        entry.get("request_id")
                        and entry.get("tool_call_id")
                        and entry.get("tool_name")
                    ):
                        continue
                    flat_entry: Dict[str, Any] = dict(entry)
                    # 下放 batch 元字段（entry 已有同名字段则保留 entry 值）
                    if not flat_entry.get("batch_id"):
                        flat_entry["batch_id"] = shared_batch_id
                    if not flat_entry.get("runtime_mode"):
                        flat_entry["runtime_mode"] = shared_runtime_mode
                    if shared_expires_at is not None:
                        flat_entry.setdefault("expires_at", shared_expires_at)
                    if shared_created_at is not None:
                        flat_entry.setdefault("created_at", shared_created_at)
                    flat_entry.setdefault("approval_type", shared_approval_type)
                    normalized = PromptForwardService._normalize_pending_approval_for_wire(
                        flat_entry,
                    )
                    if normalized is not None:
                        flat.append(normalized)
            elif (
                batch_meta.get("request_id")
                and batch_meta.get("tool_call_id")
                and batch_meta.get("tool_name")
            ):
                # 已是扁平形态（罕见，但向前兼容）—— 同样经过 wire 边界清洗，
                # 避免历史 JSON 里的 nullable optional 字段击穿 Zod。
                normalized = PromptForwardService._normalize_pending_approval_for_wire(
                    batch_meta,
                )
                if normalized is not None:
                    flat.append(normalized)
            # 否则 skip（既非嵌套也非扁平 → 损坏数据）
        return flat

    @staticmethod
    def _normalize_pending_approval_for_wire(
        candidate: Dict[str, Any],
    ) -> Optional[Dict[str, Any]]:
        """把 PG 宽松 JSON 投影成客户端严格的 pending approval wire 形态。

        ``relay_audit_writer`` 为了表达“尚未决定”，会把 ``outcome`` /
        ``scope`` / ``resolved_at`` 等字段存成 ``null``；TS Zod schema 对这些
        字段采用 ``optional()``，语义是“可省略但不可为 null”。旧数据若直接
        透传，会让整条 ``agent.prompt.forward`` 被客户端拒绝。

        这里先移除无语义的 null / 空 optional 枚举，再用 Django 侧镜像模型
        校验并 JSON dump。损坏的单条审批只跳过该条，不能拖垮整轮消息。
        """
        from apps.services.common.agent_protocol.agent_wire import (
            InterruptStatePendingApproval,
        )

        projected = {
            key: value
            for key, value in candidate.items()
            if value is not None
        }
        for optional_enum in ("outcome", "scope", "risk_level", "runtime_mode"):
            if projected.get(optional_enum) == "":
                projected.pop(optional_enum)
        for optional_object in ("ask_hint", "approver_identity"):
            if projected.get(optional_object) == {}:
                projected.pop(optional_object)

        try:
            model = InterruptStatePendingApproval.model_validate(projected)
        except ValidationError as exc:
            logger.warning(
                "[PromptForward] skip invalid pending approval at wire boundary: "
                "batch=%s request=%s errors=%s",
                projected.get("batch_id"),
                projected.get("request_id"),
                exc.errors(include_input=False),
            )
            return None
        return model.model_dump(mode="json", exclude_none=True)

    @staticmethod
    def _assemble_cross_turn_history(
        *,
        thread_id: str,
        space,
        exclude_client_event_id: Optional[str] = None,
    ) -> Optional[List[Dict[str, Any]]]:
        """从 ChatMessage 表组装跨轮 history（仅 runtime_mode='local'）。

        决策优先级（v2 嵌套形状）：
        1. agent_config.conversation.cross_turn_memory === False → 不组装
           （兼容 v1 顶层 cross_turn_memory，老数据未迁移时仍尊重）
        2. 找不到 session / 无历史消息 → 返回 None
        3. ：按本轮 ``client_event_id`` / 同值 ``ChatMessage.id`` 排除已落库的
           当前轮 user（Stage-Ingest 已写入）。禁止用「最新一条是不是 user」位置
           启发式——同 session 复用后多 attempt、或同 turn 后插任意 assistant，
           都会让本轮指令泄漏进 history，与本轮 prompt 形成双份用户意图。
        4. 序列化为 HistorySourceMessage 兼容格式（id/role/content/blocks_json）
        """
        t0 = time.monotonic()

        try:
            from apps.agent.models import Agent
            from apps.chat.conversation.models import ChatSession

            session = ChatSession.objects.filter(thread_id=thread_id).first()
            if not session:
                logger.debug("[cross-turn] 未找到 session: thread_id=%s", thread_id)
                return None
            agent_config = (
                Agent.objects.filter(id=session.agent_id)
                .values_list("agent_config", flat=True)
                .first()
                if session.agent_id
                else {}
            )
            if not isinstance(agent_config, dict):
                agent_config = {}
        except Exception:
            logger.warning(
                "[cross-turn] 加载 Session Agent 配置失败: thread_id=%s",
                thread_id,
                exc_info=True,
            )
            return None

        # ── v1 → v2 入口归一（W2.1 决议）──
        # migration 0044 已把库内 agent_config 全转 v2，但部分历史路径
        # （SubAgent context 装配 / 测试 fixture）可能仍传 v1 形状，入口 promote
        # 保证业务读取路径仅触碰 v2 嵌套。
        from apps.tabtinspace.agent_config_v2 import migrate_v1_to_v2
        if agent_config and agent_config.get("schema_version") != 2:
            agent_config = migrate_v1_to_v2(agent_config)

        # v2: conversation.cross_turn_memory（顶层 conversation 块，非 capabilities.*）
        conversation = agent_config.get("conversation") or {}
        cross_turn_enabled = conversation.get("cross_turn_memory", True)

        if cross_turn_enabled is False:
            logger.info(
                "[cross-turn] 跨轮记忆已关闭 (agent_config): space=%s",
                getattr(space, "id", "?"),
            )
            return None

        # ：滑动窗口**统一禁用**——本路径无条件取全量历史，与 TS 侧
        # DEFAULT_MAX_HISTORY_MESSAGES=Infinity 对齐。截断职责统一交给本地 runtime
        # CompactionOrchestrator（按 token 预算处理超 context window）。
        #
        # 为什么忽略 conversation.max_history_messages：agent_config_v2 把该字段默认填
        # 10 并已 migrate 进所有存量 agent，按配置取值会让「取最后 N 条」窗口每轮右移、
        # 打掉 prompt cache 前缀（与  context 注入位置无关的独立前缀杀手）。要对
        # 存量 + 新建 agent 统一禁用，这里不读该配置、恒全量。
        #
        # ⚠️ 取舍：全量历史经 WS 下发给 daemon，超长会话帧体增大（原先的 50 条硬顶
        # 即为防此）。现由 daemon compaction 兜底；blocks_json 仍走 _truncate_block_outputs
        # 预截断大 tool output。极端长会话的 WS 帧体见  备注。

        try:
            from apps.chat.conversation.models import ChatMessage

            # 全量历史（按时间倒序取，下方再反转为升序），不做条数截断。
            #  / ：hitl_interaction、system_prompt_context 绝不进 LLM 历史——
            # 与 renderer 侧 EXCLUDED_FROM_LLM_HISTORY_MESSAGE_KINDS 对齐。
            qs = ChatMessage.objects.filter(
                session=session,
                role__in=["user", "assistant", "system"],
            ).exclude(
                message_kind__in=["hitl_interaction", "system_prompt_context"],
            )

            # ：本轮用户消息身份排除（persist_user_messages 把 client_message_id
            # 同时写入 client_event_id 与 ChatMessage.id）。
            exclude_uuid = _coerce_exclude_client_event_uuid(exclude_client_event_id)
            if exclude_uuid is not None:
                qs = qs.exclude(client_event_id=exclude_uuid).exclude(id=exclude_uuid)

            raw = list(qs.order_by("-created_at"))

            if not raw:
                return None

            # 无本轮身份时保留旧行为：仅当最新一条是 user 才裁掉（兼容未传
            # client_message_id 的旧调用方）。有身份时禁止再用位置启发式。
            if exclude_uuid is None and raw[0].role == "user":
                raw = raw[1:]

            messages = raw
            if not messages:
                logger.info("[cross-turn] 首轮或无历史: thread=%s", thread_id)
                return None

            # 反转为时间升序
            messages.reverse()

            # W3 §3.3.1：content → text_summary, blocks_json → content_blocks_json
            # ：透传 message_kind，供下游 keep-latest（agent_profile_context）。
            history: List[Dict[str, Any]] = []
            for msg in messages:
                if msg.role == "system":
                    if not is_system_authored_message(
                        message_kind=msg.message_kind,
                        metadata=msg.metadata,
                    ):
                        continue
                entry: Dict[str, Any] = {
                    "id": str(msg.id),
                    "role": llm_role_for_persisted_message(
                        role=msg.role,
                        message_kind=msg.message_kind or "llm",
                    ),
                    "content": msg.text_summary or "",
                    "message_kind": msg.message_kind or "llm",
                }
                if msg.content_blocks_json:
                    entry["blocks_json"] = _truncate_block_outputs(msg.content_blocks_json)
                history.append(entry)

            history = _keep_latest_agent_profile_history(history)

            elapsed_ms = (time.monotonic() - t0) * 1000
            logger.info(
                "[cross-turn] history 组装完成: thread=%s messages=%d elapsed=%.0fms",
                thread_id,
                len(history),
                elapsed_ms,
            )
            return history

        except Exception:
            logger.error(
                "[cross-turn] history 组装失败: thread=%s",
                thread_id,
                exc_info=True,
            )
            return None

    @staticmethod
    def _resolve_workspace_root(space) -> Optional[str]:
        """Derive workspace_root from a Workspace row."""
        if space is None:
            return None
        return getattr(space, "working_dir", None) or None


def _coerce_exclude_client_event_uuid(value: Optional[str]):
    """#8322：把本轮 client_message_id 安全转为 UUID，供 history 身份排除。"""
    if not value:
        return None
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError, AttributeError):
        return None


def _is_agent_profile_history_entry(entry: Dict[str, Any]) -> bool:
    """#7289：识别落库 / 历史里的 agent-profile 块（kind 或 content 兜底）。"""
    if entry.get("message_kind") == "agent_profile_context":
        return True
    content = (entry.get("content") or "").lstrip()
    return content.startswith('<context type="agent-profile"') or content.startswith(
        "<context type='agent-profile'"
    )


def _keep_latest_agent_profile_history(
    history: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """#7289：历史中多份 agent-profile 只保留时间上最新一份。"""
    latest_index = -1
    for index, entry in enumerate(history):
        if _is_agent_profile_history_entry(entry):
            latest_index = index
    if latest_index < 0:
        return history
    return [
        entry
        for index, entry in enumerate(history)
        if not _is_agent_profile_history_entry(entry) or index == latest_index
    ]


def _truncate_block_outputs(blocks: list) -> list:
    """Deep-copy blocks and pre-truncate oversized tool_call output for WS transfer."""
    truncated = copy.deepcopy(blocks)
    for block in truncated:
        if not isinstance(block, dict):
            continue
        if block.get("type") != "tool_call":
            continue
        output = block.get("output")
        if isinstance(output, str) and len(output) > _BLOCK_OUTPUT_PRE_TRUNCATE_CHARS:
            original_len = len(output)
            block["output"] = (
                output[:_BLOCK_OUTPUT_PRE_TRUNCATE_CHARS]
                + f"\n[... pre-truncated from {original_len} chars for WS transfer"
                " — full output may be available in tool-logs if archived]"
            )
    return truncated
