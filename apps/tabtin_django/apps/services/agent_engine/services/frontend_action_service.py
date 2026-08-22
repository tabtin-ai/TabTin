"""
Frontend Action Service

集中管理前端动作的 Redis 通道、结果存储与等待逻辑。
"""

import json
import logging
import threading
from typing import Dict, Any, Optional

import redis
from django.conf import settings
from apps.services.common.execution_agent_cache import get_cached_execution_agent_id
from apps.services.common.agent_protocol.namespace import action_event_type, action_topic, device_action_topic, redis_key
from apps.services.common.ws.bus import publish_ws_event
from apps.services.common.ws.protocol import build_envelope, new_event_id
from apps.services.agent_engine.services.action_transport_service import ActionTransportService
from apps.services.common.device_capability_registry import (
    DEVICE_AVAILABLE_STATUSES,
    DEVICE_RUNTIME_TYPES,
)
from apps.services.agent_engine.services.device_dispatch_service import (
    DEVICE_FALLBACK_POLICY,
    DeviceDispatchService,
)
from apps.tabtinspace.services.execution_binding import (
    resolve_control_device,
    resolve_execution_agent,
)

logger = logging.getLogger(__name__)

DEFAULT_RESULT_TTL = 300
ORPHAN_RESULT_TTL = 600
ACTION_DEVICE_TTL = 60 * 60
DAEMON_FP_CACHE_TTL = 60  # thread → daemon fingerprint 缓存 60 秒（减少设备离线后错误路由窗口）
DAEMON_FP_CACHE_PREFIX = "agent:daemon_fp:"
DAEMON_FP_NONE_SENTINEL = "__none__"
ACTION_BUFFER_PREFIX = "agent:action_buffer:"
ACTION_BUFFER_TTL = 300  # 未送达 action 缓冲 5 分钟（覆盖网络波动重连场景）

_VIDEO_DEVICE_CAPABILITIES = frozenset({"video_render_mg", "video_export"})


def _capability_label(capability: Optional[str]) -> str:
    if capability == "video_render_mg":
        return "MG 视频渲染"
    if capability == "video_export":
        return "视频导出"
    return "该操作"


def _device_only_error_payload(
    required_capability: Optional[str],
    reason: Optional[str],
) -> Dict[str, Any]:
    label = _capability_label(required_capability)

    if required_capability in _VIDEO_DEVICE_CAPABILITIES:
        if reason == "space_not_found":
            return {
                "success": False,
                "error": (
                    f"{label}需要在可解析的 TabVideo/Agent Space 会话中发起。"
                    "请打开对应 Space 或 TabVideo 项目会话，并确保 Agent 已绑定 TabTin Daemon 后重试。"
                ),
                "error_code": "VIDEO_EXECUTION_CONTEXT_MISSING",
                "required_capability": required_capability,
            }
        if reason == "capability_mismatch":
            return {
                "success": False,
                "error": (
                    f"{label}需要后台设备上报 {required_capability} 能力。"
                    "请在执行设备安装 FFmpeg，启动或重启 TabTin Daemon，然后刷新设备能力后重试。"
                ),
                "error_code": "VIDEO_CAPABILITY_MISSING",
                "required_capability": required_capability,
            }
        if reason in {"device_offline", "runtime_ws_offline"}:
            return {
                "success": False,
                "error": (
                    f"{label}需要具备 {required_capability} 能力的后台设备在线。"
                    "请启动 TabTin Daemon 并确认设备已连接后重试。"
                ),
                "error_code": "VIDEO_DEVICE_OFFLINE",
                "required_capability": required_capability,
            }
        if reason in {"no_control_device", "control_device_no_runtime"}:
            return {
                "success": False,
                "error": (
                    f"{label}需要绑定具备 {required_capability} 能力的后台导出设备。"
                    "请为当前 Agent 绑定 TabTin Daemon 设备；如设备缺少 FFmpeg，请先安装后刷新能力。"
                ),
                "error_code": "VIDEO_NO_CONTROL_DEVICE",
                "required_capability": required_capability,
            }
        if reason == "delivery_failed":
            return {
                "success": False,
                "error": f"{label}任务下发到后台设备失败，请确认 TabTin Daemon 仍在线后重试。",
                "error_code": "VIDEO_DEVICE_DELIVERY_FAILED",
                "required_capability": required_capability,
            }

    generic_code = {
        "capability_mismatch": "DEVICE_CAPABILITY_MISSING",
        "device_offline": "DEVICE_OFFLINE",
        "runtime_ws_offline": "DEVICE_OFFLINE",
        "no_control_device": "DEVICE_NOT_BOUND",
        "space_not_found": "DEVICE_CONTEXT_MISSING",
        "control_device_no_runtime": "DEVICE_RUNTIME_UNAVAILABLE",
        "delivery_failed": "DEVICE_ACTION_DELIVERY_FAILED",
    }.get(reason or "", "DEVICE_RUNTIME_UNAVAILABLE")
    return {
        "success": False,
        "error": "该操作需要具备对应能力的执行设备，请绑定或启动设备后重试。",
        "error_code": generic_code,
        "required_capability": required_capability,
    }


class FrontendActionService:
    """前端动作服务（Redis 通道/结果的统一封装）"""

    def __init__(self):
        self._redis_client: Optional[redis.Redis] = None
        self._transport = ActionTransportService()
        self._device_dispatch = DeviceDispatchService()

    @property
    def redis_client(self) -> redis.Redis:
        """延迟初始化 Redis 客户端"""
        if self._redis_client is None:
            self._redis_client = self._transport.redis_client
        return self._redis_client

    @staticmethod
    def build_action_channel(thread_id: str) -> str:
        return ActionTransportService.build_action_channel(thread_id)

    @staticmethod
    def build_result_key(thread_id: str, task_id: str) -> str:
        return ActionTransportService.build_result_key(thread_id, task_id)

    @staticmethod
    def build_action_device_key(thread_id: str) -> str:
        return ActionTransportService.build_action_device_key(thread_id)

    def publish_action(
        self,
        thread_id: str,
        event: Dict[str, Any],
        authorization_rules: Optional[Dict[str, str]] = None,
        target_device_fingerprint: Optional[str] = None,
        timeout_ms: Optional[int] = None,
    ) -> int:
        """发布前端动作事件。

        路由策略（互斥，防止重复执行）：
        - 若指定 target_device_fingerprint，跳过 dispatch 直接发往目标设备
        - 否则优先走 DeviceDispatchService 解析出来的 runtime 设备
        - 不满足条件时 fallback 到 Electron 的 agent.action.{thread_id} topic

        自动附加 sandbox_policy 到 payload，供 Daemon/Electron 执行时使用。

        Args:
            authorization_rules: 可选的授权规则（来自 Agent state）。
                未传入时从 ContextVar 或 Space 自动解析。
            target_device_fingerprint: 指定目标设备 fingerprint（跨设备场景）。
                传入时跳过 resolve_action_target，直接路由到该设备。
        """
        runtime_fp = None
        envelope = None
        should_buffer_runtime_action = False
        try:
            if not target_device_fingerprint:
                from apps.services.agent_engine.services.prompt_forward_service import (
                    PromptForwardService,
                )

                frozen_target = PromptForwardService._get_frozen_target_device(thread_id)
                if frozen_target and not settings.DAEMON_CONTROL_ENABLED:
                    logger.warning(
                        "[FrontendActionService] frozen target rejected while daemon control is disabled: thread=%s",
                        thread_id,
                    )
                    return 0
                target_device_fingerprint = frozen_target

            event_data = event.get("data", {}) if isinstance(event, dict) else {}
            task_id = event_data.get("task_id")
            action_type = event_data.get("type") or event_data.get("action")
            params = event_data.get("params") or {}
            trace_id = event_data.get("trace_id")

            effective_auth_rules = self._resolve_effective_auth_rules(
                thread_id, authorization_rules
            )
            sandbox_policy = self._resolve_sandbox_policy(
                thread_id, action_type, params, authorization_rules=effective_auth_rules
            )

            # PR4-yolo (PRD v3 §5.6 Daemon 路径) + PRD §1.4 / DR-15：
            # 顶层透传当前 chat 任务的 agent_mode / is_group_space 到 wire envelope，
            # 让 Daemon action-bridge ``handleAction`` 注入 ``params._agent_mode``
            # / ``params._is_group_space``（与 sandbox_policy 同模式），daemon 端
            # 工具 handler 可读取做防御性 audit / 二次自检。
            #
            # 数据源（任务 5 落定为方案 A · ContextVar 权威源）：
            #   - agent_mode：``thread_context.get_current_agent_mode(thread_id)``
            #     —— chat.send_message handler 在收到 payload.agent_mode 后写
            #     的同一份 SSoT，跨进程边界（Daemon）必然丢，所以这里在 Django
            #     端**显式塞进 wire**让 Daemon 端有显式信号。
            #   - is_group_space：Space-first Phase 4 后不再从 Space.type 派生；
            #     当前显式 false，未来多 Agent 群聊应改由 group runtime 配置提供。
            from apps.services.common.thread_context import get_current_agent_mode
            agent_mode_val = get_current_agent_mode(expected_thread_id=thread_id)
            is_group_space_val = False

            shared_event_id = new_event_id()
            payload = {
                "task_id": task_id,
                "action": action_type,
                "params": params,
                "thread_id": thread_id,
                "trace_id": trace_id,
                "sandbox_policy": sandbox_policy,
                # PR4-yolo (PRD v3 §5.6) / DR-15：顶层 wire 字段，daemon 端
                # action-bridge 注入 _agent_mode / _is_group_space 到 params。
                # agent_mode 仅在 ContextVar 命中时写（None 不写避免 wire 噪声）；
                # is_group_space 强写 boolean 避免下游 default 漂移。
                "is_group_space": is_group_space_val,
            }
            if agent_mode_val:
                payload["agent_mode"] = agent_mode_val
            if timeout_ms is not None:
                payload["timeout_ms"] = timeout_ms
            envelope = build_envelope(
                action_event_type("request"),
                shared_event_id,
                payload,
                event_id=shared_event_id,
                thread_id=thread_id,
                trace_id=trace_id,
            )

            published = 0

            if target_device_fingerprint:
                runtime_fp = target_device_fingerprint
                should_buffer_runtime_action = True
                if not self._transport.is_device_connected(runtime_fp):
                    logger.warning(
                        "[FrontendActionService] target device WS not connected: fp=%s",
                        runtime_fp,
                    )
                    if task_id:
                        try:
                            self._transport.store_result(thread_id, task_id, {
                                "success": False,
                                "error": "目标设备不在线，无法执行操作",
                                "error_code": "TARGET_DEVICE_OFFLINE",
                            })
                        except Exception:
                            logger.warning(
                                "[FrontendActionService] store_result failed (target offline): "
                                "thread=%s task=%s fp=%s",
                                thread_id, task_id, runtime_fp, exc_info=True,
                            )
                    return 0
                published = self._transport.publish_device_action(runtime_fp, envelope)
                if published:
                    logger.info(
                        "[FrontendActionService] action routed to explicit target device: fp=%s action=%s",
                        runtime_fp, action_type,
                    )
                return published

            decision = self._device_dispatch.resolve_action_target(thread_id, action_type)
            runtime_fp = decision.device_fingerprint
            should_buffer_runtime_action = decision.kind == "device_runtime" and runtime_fp is not None

            if decision.error:
                logger.warning(
                    "[FrontendActionService] dispatch blocked (no fallback): error=%s capability=%s thread=%s",
                    decision.error, decision.required_capability, thread_id,
                )
                if task_id:
                    error_payload = _device_only_error_payload(
                        decision.required_capability,
                        decision.error,
                    )
                    try:
                        self._transport.store_result(thread_id, task_id, error_payload)
                    except Exception:
                        logger.warning(
                            "[FrontendActionService] store_result failed (no fallback): "
                            "thread=%s task=%s capability=%s",
                            thread_id, task_id, decision.required_capability, exc_info=True,
                        )
                return 0

            if decision.kind == "device_runtime" and runtime_fp:
                if not self._transport.is_device_connected(runtime_fp):
                    if DEVICE_FALLBACK_POLICY.get(decision.required_capability or "") == "device_only":
                        logger.warning(
                            "[FrontendActionService] runtime device WS not connected and capability disallows fallback: fp=%s capability=%s",
                            runtime_fp,
                            decision.required_capability,
                        )
                        if task_id:
                            error_payload = _device_only_error_payload(
                                decision.required_capability,
                                "runtime_ws_offline",
                            )
                            try:
                                self._transport.store_result(thread_id, task_id, error_payload)
                            except Exception:
                                logger.warning(
                                    "[FrontendActionService] store_result failed (runtime offline): "
                                    "thread=%s task=%s capability=%s",
                                    thread_id, task_id, decision.required_capability, exc_info=True,
                                )
                        return 0
                    logger.warning(
                        "[FrontendActionService] runtime device WS not connected, fallback to Electron: fp=%s",
                        runtime_fp,
                    )
                    self.force_release_action_device(thread_id)
                    published = self._transport.publish_session_action(thread_id, envelope)
                else:
                    published = self._transport.publish_device_action(runtime_fp, envelope)
                    if published:
                        self.bind_action_device(thread_id, runtime_fp)
                        logger.info(
                            "[FrontendActionService] action routed to runtime device: fp=%s type=%s source=%s",
                            runtime_fp,
                            decision.device_type,
                            decision.binding_source,
                        )
                    else:
                        if DEVICE_FALLBACK_POLICY.get(decision.required_capability or "") == "device_only":
                            logger.warning(
                                "[FrontendActionService] runtime publish failed and capability disallows fallback: fp=%s capability=%s",
                                runtime_fp,
                                decision.required_capability,
                            )
                            if task_id:
                                error_payload = _device_only_error_payload(
                                    decision.required_capability,
                                    "delivery_failed",
                                )
                                try:
                                    self._transport.store_result(thread_id, task_id, error_payload)
                                except Exception:
                                    logger.warning(
                                        "[FrontendActionService] store_result failed (runtime publish failed): "
                                        "thread=%s task=%s capability=%s",
                                        thread_id, task_id, decision.required_capability, exc_info=True,
                                    )
                            return 0
                        logger.warning(
                            "[FrontendActionService] runtime publish failed, fallback to Electron: fp=%s",
                            runtime_fp,
                        )
                        self.force_release_action_device(thread_id)
                        published = self._transport.publish_session_action(thread_id, envelope)
            else:
                self.force_release_action_device(thread_id)
                published = self._transport.publish_session_action(thread_id, envelope)

        except Exception as exc:
            logger.warning("[FrontendActionService] WS publish failed: %s", exc)
            published = 0

        if published == 0 and should_buffer_runtime_action and runtime_fp and envelope:
            self._transport.buffer_action(runtime_fp, envelope)

        return published

    def drain_buffered_actions(self, daemon_fp: str) -> list:
        """Daemon 重连时调用，委托给 transport 层统一实现（按 ts 升序排序）。"""
        return self._transport.drain_buffered_actions(daemon_fp)

    def _resolve_daemon_info(self, thread_id: str) -> tuple:
        """从 thread_id 解析出关联 Daemon 设备的 (fingerprint, capabilities)。

        支持所有合法 thread_id 前缀：chat-session-、tin-、browser-。
        先查 Redis 缓存，miss 时查 DB 并回填。
        缓存 None 结果（用 sentinel）避免反复查 DB。
        返回 (fingerprint_or_None, capabilities_list_or_None)。
        """

        cache_key = f"{DAEMON_FP_CACHE_PREFIX}{thread_id}"
        caps_key = f"{DAEMON_FP_CACHE_PREFIX}caps:{thread_id}"
        try:
            cached = self.redis_client.get(cache_key)
            if cached is not None:
                if cached == DAEMON_FP_NONE_SENTINEL:
                    return None, None
                caps_raw = self.redis_client.get(caps_key)
                caps = json.loads(caps_raw) if caps_raw else None
                return cached, caps
        except Exception:
            pass  # defensive: Redis 缓存读取失败，回落到 DB 查询

        fp, caps = self._query_daemon_info(thread_id)

        try:
            pipe = self.redis_client.pipeline(transaction=False)
            pipe.set(cache_key, fp if fp else DAEMON_FP_NONE_SENTINEL, ex=DAEMON_FP_CACHE_TTL)
            if fp and caps is not None:
                pipe.set(caps_key, json.dumps(caps), ex=DAEMON_FP_CACHE_TTL)
            pipe.execute()
        except Exception:
            pass  # defensive: 缓存回写失败不影响本次返回值

        return fp, caps

    def _resolve_daemon_fingerprint(self, thread_id: str) -> Optional[str]:
        """Backward-compatible wrapper."""
        fp, _ = self._resolve_daemon_info(thread_id)
        return fp

    @staticmethod
    def _resolve_effective_auth_rules(
        thread_id: str,
        explicit_rules: Optional[Dict[str, str]] = None,
    ) -> Optional[Dict[str, str]]:
        """解析生效的 authorization_rules。

        优先级：
        1. 调用方显式传入（如工具层从 Agent state 获取）
        2. ContextVar（仅在当前 thread_id 匹配时信任）
        3. Space 的 agent_config 推导（兜底）

        CA-007: Celery prefork 同进程顺序任务中，上一任务崩溃可能残留
        ContextVar。通过 get_current_thread_id() 交叉验证 freshness，
        仅在 thread_id 匹配时信任 ContextVar，否则跳过到 Space 解析。
        """
        if explicit_rules:
            return explicit_rules

        try:
            from apps.services.tools.base import _authorization_rules_ctx
            ctx_rules = _authorization_rules_ctx.get()
            if ctx_rules:
                from apps.services.common.thread_context import get_current_thread_id
                current_thread_id = get_current_thread_id()
                if current_thread_id == thread_id:
                    return ctx_rules
                logger.debug(
                    "[FrontendActionService] Skipping potentially stale ContextVar auth rules: "
                    "ctx_thread=%s request_thread=%s",
                    current_thread_id, thread_id,
                )
        except Exception:
            pass  # defensive: ContextVar 降级到 Space 解析

        space = FrontendActionService._get_space_for_thread(thread_id)
        agent_id = FrontendActionService._get_explicit_agent_id_for_thread(thread_id)
        explicit_agent_requested = bool(agent_id)
        return None

    @staticmethod
    def _resolve_sandbox_policy(
        thread_id: str,
        action_type: Optional[str],
        params: Optional[Dict[str, Any]],
        authorization_rules: Optional[Dict[str, str]] = None,
    ) -> Optional[Dict[str, Any]]:
        """根据 thread 关联的 Space 解析 sandbox policy。

        对于无法关联到 Space 的线程（非 chat-session 类型），
        fallback 到 collaborative 预设而非返回 None，确保所有线程
        都有基线安全策略。

        多 Agent 并行时，自动从 ContextVar 读取 sibling workspace 信息，
        合并到 deny_write_paths 实现工作目录隔离。

        Args:
            authorization_rules: 授权规则，用于与 sandbox policy 双向对齐。
                传入后会转发给 SandboxPolicyResolver，确保 approval_required
                与 PermissionRuleEngine 体系一致。
        """
        sibling_workspaces = FrontendActionService._get_sibling_agent_workspaces()
        # 路径权限治理 Wave 4：从 ContextVar 取主控端透传上来的 v3
        # WorkspaceSnapshot —— AgentDispatcher.dispatch_external /
        # forward_runner 在 chat 链路起跑前 set，本调用栈一定能读到。
        # 缺省 None → SandboxPolicyResolver 走原有 deny lists 检查（兼容
        # 老路径，与"未传 workspace_snapshot"等价）。
        # P1-4 修复：必须传当前 thread_id 做交叉校验，避免 prefork worker
        # 残留让一个 user 读到上一个 user 的 snapshot（CA-007 同款治理）。
        workspace_snapshot = FrontendActionService._get_workspace_snapshot_from_context(thread_id)

        if not action_type:
            try:
                from apps.services.common.sandbox_policy import SandboxPolicyResolver
                fallback = SandboxPolicyResolver(
                    authorization_rules=authorization_rules,
                    other_agent_workspaces=sibling_workspaces,
                )
                return fallback.resolve(
                    "__default__", {}, workspace_snapshot=workspace_snapshot
                ).to_dict()
            except Exception:
                logger.debug(
                    "[FrontendActionService] 无 action_type 时 sandbox 策略解析失败: thread_id=%s",
                    thread_id,
                    exc_info=True,
                )
                return None
        try:
            from apps.services.common.sandbox_policy import SandboxPolicyResolver
            space = FrontendActionService._get_space_for_thread(thread_id)
            agent_id = FrontendActionService._get_explicit_agent_id_for_thread(thread_id)
            explicit_agent_requested = bool(agent_id)
            execution_agent = resolve_execution_agent(space=space, agent_id=agent_id)

            if not space and execution_agent is None:
                resolver = SandboxPolicyResolver(
                    authorization_rules=authorization_rules,
                    other_agent_workspaces=sibling_workspaces,
                )
                decision = resolver.resolve(
                    action_type, params or {}, workspace_snapshot=workspace_snapshot
                )
                return decision.to_dict()

            device_home_dir = None
            bound_device = resolve_control_device(space=space, agent_id=agent_id)
            if bound_device:
                os_info = getattr(bound_device, 'os_info', None) or {}
                device_home_dir = os_info.get('home_dir')

            agent_config = (
                getattr(execution_agent, "agent_config", None)
                if execution_agent is not None
                else (None if explicit_agent_requested else getattr(getattr(space, 'agent', None), 'agent_config', None))
            )

            # PRD v3 PR4-yolo H4 修复（2026-05-19）：
            # **不读 ``params.get("agent_mode")``**——params 是 LLM 工具调用参数，
            # 可被 prompt injection 控制（譬如用户被恶意诱导让模型生成
            # ``read_file(path="/etc/passwd", agent_mode="yolo")``，本端读 params
            # 会误把 yolo 当真）。
            #
            # 改读权威源（方案 A · ContextVar）：
            # ``thread_context.get_current_agent_mode(expected_thread_id=thread_id)``
            # —— 这是 chat.send_message handler 在收到消息体 ``payload.agent_mode``
            # 后写入的服务端 SSoT；与 _get_workspace_snapshot_from_context 同款
            # ContextVar + thread_id 交叉校验治理（CA-007）。
            #
            # 跨进程 / 跨设备边界（daemon / electron）不在本路径上：
            # publish_action 是 Django **同进程** chat 请求栈调用，ContextVar 当下
            # 一定活着。daemon 侧的对应 wire 透传已在任务 3 落地（params._agent_mode
            # 是给 daemon-handler 用，不参与 Django _resolve_sandbox_policy 决策）。
            #
            # Fallback：ContextVar 未命中（None）→ 'agent' fail-safe，与 PR0 缺省
            # 行为一致，永远不会误升级 yolo。
            # is_group_space：Space-first Phase 4 后不再从 Space.type 派生。
            # 当前显式 false；未来多 Agent 群聊应改由 group runtime 配置提供，
            # 且仍必须是服务端属性，永远不读 params。
            from apps.services.common.thread_context import (
                get_current_agent_mode,
                get_forward_agent_mode,
            )
            authoritative_agent_mode = get_current_agent_mode(expected_thread_id=thread_id)
            # 无人值守第三类挂死修复：forward/设备路径下 publish_action 在 **WS-consumer
            # 线程**处理，拿不到 `forward_runner`（celery 线程）写的 ContextVar agent_mode
            # —— 上方注释「publish_action 同进程 ContextVar 一定活着」对设备 forward 路径
            # 不成立。此时回落读 `forward_runner` 按 thread_id 写进 Redis 的**服务端可信源**
            # （非 LLM 可控 params，与 params.agent_mode 有本质区别）。这样 yolo 无人值守
            # 任务的 browser.open 等高危前端动作不再误弹审批；真实 yolo 闸门仍由下方
            # SandboxPolicyResolver 读组织准入天花板（，organization.settings.
            # allow_member_yolo）决定（本值只补 requested_agent_mode 入参，缺省仍
            # 'agent' fail-safe，绝不误升级）。
            if not authoritative_agent_mode:
                authoritative_agent_mode = get_forward_agent_mode(thread_id)
            requested_agent_mode = authoritative_agent_mode if authoritative_agent_mode else "agent"

            # 防御性 log：params 里若同时携带 agent_mode 且与权威源不一致 → 警告。
            # 不阻断业务（只丢弃 params 端），但留下证据供安全审计追踪 prompt
            # injection 攻击尝试 / 客户端不规范行为。
            if isinstance(params, dict):
                mode_raw = params.get("agent_mode")
                if isinstance(mode_raw, str) and mode_raw and mode_raw != requested_agent_mode:
                    logger.warning(
                        "[FrontendActionService] params.agent_mode=%r 与 ContextVar"
                        " authoritative=%r 不一致——丢弃 params 端（疑似 LLM"
                        " prompt injection / 客户端不规范）。thread=%s action=%s",
                        mode_raw, requested_agent_mode, thread_id, action_type,
                    )

            is_group_space = False

            # ：yolo gate 是组织准入天花板——从 Space/Agent 所属组织的
            # settings 读。space 已 select_related("organization")；execution_agent
            # 兜底（explicit agent 且无 space 的边界）。
            organization = (
                getattr(space, "organization", None)
                or getattr(execution_agent, "organization", None)
            )
            organization_settings = getattr(organization, "settings", None) if organization else None

            resolver = SandboxPolicyResolver.from_agent_config(
                agent_config,
                device_home_dir=device_home_dir,
                authorization_rules=authorization_rules,
                other_agent_workspaces=sibling_workspaces,
                requested_agent_mode=requested_agent_mode,
                is_group_space=is_group_space,
                organization_settings=organization_settings,
            )
            decision = resolver.resolve(
                action_type, params or {}, workspace_snapshot=workspace_snapshot
            )
            return decision.to_dict()
        except Exception as exc:
            logger.debug("[FrontendActionService] sandbox policy resolve failed, using collaborative fallback: %s", exc)
            try:
                from apps.services.common.sandbox_policy import SandboxPolicyResolver
                fallback = SandboxPolicyResolver(
                    authorization_rules=authorization_rules,
                    other_agent_workspaces=sibling_workspaces,
                )
                return fallback.resolve(
                    action_type, params or {}, workspace_snapshot=workspace_snapshot
                ).to_dict()
            except Exception:
                from apps.services.common.sandbox_policy import SandboxPolicyResolver, SANDBOX_PRESETS, DEFAULT_SANDBOX_PRESET
                return SandboxPolicyResolver(
                    sandbox_config=dict(SANDBOX_PRESETS[DEFAULT_SANDBOX_PRESET]),
                    other_agent_workspaces=sibling_workspaces,
                ).resolve(
                    action_type or "__default__",
                    params or {},
                    workspace_snapshot=workspace_snapshot,
                ).to_dict()

    @staticmethod
    def _get_workspace_snapshot_from_context(
        expected_thread_id: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """路径权限治理 Wave 4：从 ContextVar 读 v3 WorkspaceSnapshot。

        来源：AgentDispatcher.dispatch_external / forward_runner 在 chat
        链路起跑前调 set_current_workspace_snapshot 写入；本调用栈在同一
        ContextVar scope 内（与 _get_sibling_agent_workspaces 同模式）。

        P1-4 修复：传 expected_thread_id 做 thread_id 交叉校验
        （与 _resolve_effective_auth_rules 同款 CA-007 治理）。 daphne /
        celery prefork worker 复用线程时，ContextVar 残留会让一个 user 读到
        上一个 user 的 snapshot —— mismatch → 视为残留 → 返回 None。
        """
        try:
            from apps.services.common.thread_context import (
                get_current_workspace_snapshot,
                get_current_thread_id,
            )
            # 双重校验：(1) thread_context 模块内的元组校验
            # (2) 当前 ContextVar 上的 thread_id 也必须 = expected_thread_id
            #     —— 防御 set 时漏传 thread_id 的退化路径
            snapshot = get_current_workspace_snapshot(expected_thread_id=expected_thread_id)
            if snapshot is None:
                return None
            if expected_thread_id is not None:
                current_tid = get_current_thread_id()
                if current_tid is not None and current_tid != expected_thread_id:
                    logger.debug(
                        "[FrontendActionService] Skipping potentially stale ContextVar workspace_snapshot: "
                        "current_thread_id=%s expected=%s",
                        current_tid,
                        expected_thread_id,
                    )
                    return None
            return snapshot
        except Exception:
            logger.debug(
                "[FrontendActionService] 读取 workspace_snapshot 失败",
                exc_info=True,
            )
            return None

    @staticmethod
    def _get_sibling_agent_workspaces() -> Optional[list]:
        """从 ContextVar 获取当前 Agent 的兄弟 Agent 工作目录列表。"""
        try:
            from apps.services.common.thread_context import get_current_sibling_agent_workspaces
            return get_current_sibling_agent_workspaces()
        except Exception:
            logger.debug(
                "[FrontendActionService] 兄弟 Agent 工作区读取失败: detail=%s",
                "get_current_sibling_agent_workspaces",
                exc_info=True,
            )
            return None

    @staticmethod
    def _get_space_for_thread(thread_id: str):
        """从 thread_id 获取关联的 Space 对象。

        支持所有合法 thread_id 前缀：chat-session-、tin-、browser-。
        chat-session- 走快速 id 查询，其他前缀走 thread_id 字段查询。

        注意：ChatSession 在 MySQL，Space 在 PostgreSQL，不能 select_related 跨库 JOIN。
        """
        from apps.chat.conversation.models import ChatSession
        from apps.tabtinspace.models import Workspace

        try:
            from apps.services.common.thread_context import (
                get_current_space_id,
                get_current_thread_id,
            )

            current_thread_id = get_current_thread_id()
            current_space_id = get_current_space_id()
            if current_thread_id == thread_id and current_space_id:
                context_space = Workspace.objects.select_related(
                    "device", "organization",
                ).filter(id=current_space_id).first()
                if context_space:
                    return context_space
        except Exception:
            pass  # defensive: ContextVar 快速路径失败，回落到 ChatSession 查询

        try:
            if thread_id.startswith("chat-session-"):
                session_id = thread_id[len("chat-session-"):]
                session = ChatSession.objects.filter(id=session_id).first()
            else:
                session = ChatSession.objects.filter(thread_id=thread_id).first()
            if session and session.workspace_id:
                return Workspace.objects.select_related(
                    "device", "organization",
                ).filter(id=session.workspace_id).first()
        except Exception:
            logger.warning(
                "[FrontendActionService] Space lookup by thread_id failed: thread=%s",
                thread_id, exc_info=True,
            )
        return None

    @staticmethod
    def _get_explicit_agent_id_for_thread(thread_id: str) -> Optional[str]:
        try:
            from apps.services.common.thread_context import (
                get_current_execution_agent_id,
                get_current_thread_id,
            )

            current_thread_id = get_current_thread_id()
            current_agent_id = get_current_execution_agent_id()
            if current_thread_id == thread_id and current_agent_id:
                return str(current_agent_id)
        except Exception:
            pass  # defensive: ContextVar 快速路径失败，回落到缓存/ChannelBinding

        cached_agent_id = get_cached_execution_agent_id(thread_id)
        if cached_agent_id:
            return cached_agent_id

        try:
            from apps.chat.conversation.models import ChatSession

            if thread_id.startswith("chat-session-"):
                session_id = thread_id[len("chat-session-"):]
                session_agent_id = (
                    ChatSession.objects.filter(id=session_id)
                    .values_list("agent_id", flat=True)
                    .first()
                )
            else:
                session_agent_id = (
                    ChatSession.objects.filter(thread_id=thread_id)
                    .values_list("agent_id", flat=True)
                    .first()
                )
            if session_agent_id:
                return str(session_agent_id)
        except Exception:
            logger.debug(
                "[FrontendActionService] ChatSession 查询 agent_id 失败: thread_id=%s",
                thread_id,
                exc_info=True,
            )

        try:
            from apps.channel_gateway.models import ChannelBinding

            agent_id = (
                ChannelBinding.objects
                .filter(thread_id=thread_id)
                .values_list("agent_id", flat=True)
                .first()
            )
            return str(agent_id) if agent_id else None
        except Exception:
            logger.debug(
                "[FrontendActionService] ChannelBinding 查询 agent_id 失败: thread_id=%s",
                thread_id,
                exc_info=True,
            )
            return None

    @staticmethod
    def _query_daemon_info(thread_id: str) -> tuple:
        """DB 查询：thread_id → ChatSession → Space → bound_device (fingerprint, capabilities)

        支持所有合法 thread_id 前缀：chat-session-、tin-、browser-。
        chat-session- 走快速 id 查询，其他前缀走 thread_id 字段查询。

        注意：ChatSession 在 MySQL，Space 在 PostgreSQL，不能 select_related 跨库 JOIN。
        """
        try:
            from apps.chat.conversation.models import ChatSession
            from apps.tabtinspace.models import Workspace
            agent_id = FrontendActionService._get_explicit_agent_id_for_thread(thread_id)
            if thread_id.startswith("chat-session-"):
                session_id = thread_id[len("chat-session-"):]
                session = ChatSession.objects.filter(id=session_id).first()
            else:
                session = ChatSession.objects.filter(thread_id=thread_id).first()
            space = None
            if session and session.workspace_id:
                space = Workspace.objects.select_related('device').filter(
                    id=session.workspace_id,
                ).first()
            device = resolve_control_device(space=space, agent_id=agent_id)
            if not device or device.device_type not in DEVICE_RUNTIME_TYPES:
                return None, None
            # W13 D6 短期实施：busy 视为可用，不阻挡前端 action 路由。
            if device.status not in DEVICE_AVAILABLE_STATUSES:
                logger.debug("[FrontendActionService] daemon device offline: %s", device.fingerprint)
                return None, None
            caps = device.capabilities if isinstance(device.capabilities, list) else []
            return device.fingerprint, caps
        except Exception as exc:
            logger.debug("[FrontendActionService] _query_daemon_info failed: %s", exc)
            return None, None

    def _invalidate_daemon_cache(self, thread_id: str) -> None:
        """清除 thread_id 的 daemon fp/caps 缓存（实例方法，复用连接池）。"""
        try:
            pipe = self.redis_client.pipeline(transaction=False)
            pipe.delete(f"{DAEMON_FP_CACHE_PREFIX}{thread_id}")
            pipe.delete(f"{DAEMON_FP_CACHE_PREFIX}caps:{thread_id}")
            pipe.execute()
        except Exception:
            pass  # defensive: Redis 清除 daemon 缓存失败，下次查询走 DB

    @staticmethod
    def invalidate_daemon_fp_cache(thread_id: str) -> None:
        """设备绑定变更时清除缓存（由 DeviceService / API 层调用）。"""
        try:
            from django_redis import get_redis_connection
            client = get_redis_connection("default")
            pipe = client.pipeline(transaction=False)
            pipe.delete(f"{DAEMON_FP_CACHE_PREFIX}{thread_id}")
            pipe.delete(f"{DAEMON_FP_CACHE_PREFIX}caps:{thread_id}")
            pipe.execute()
        except Exception:
            pass  # defensive: 静态方法下 Redis pipeline 失败，缓存可能短期不一致

    def get_action_device(self, thread_id: str) -> Optional[str]:
        """获取 thread_id 当前绑定的 action 设备"""
        return ActionTransportService.normalize_redis_string(
            self.redis_client.get(self.build_action_device_key(thread_id))
        )

    def bind_action_device(
        self,
        thread_id: str,
        device_id: str,
        ttl: int = ACTION_DEVICE_TTL,
    ) -> None:
        """绑定 thread_id -> device_id（带 TTL 防止死锁）"""
        self.redis_client.set(self.build_action_device_key(thread_id), device_id, ex=ttl)

    def touch_action_device(
        self,
        thread_id: str,
        device_id: str,
        ttl: int = ACTION_DEVICE_TTL,
    ) -> bool:
        """刷新绑定的 TTL（仅当设备匹配时）"""
        key = self.build_action_device_key(thread_id)
        current = ActionTransportService.normalize_redis_string(self.redis_client.get(key))
        if current != device_id:
            return False
        self.redis_client.expire(key, ttl)
        return True

    def release_action_device(self, thread_id: str, device_id: str) -> bool:
        """释放 action 设备绑定（仅当设备匹配时）"""
        key = self.build_action_device_key(thread_id)
        current = ActionTransportService.normalize_redis_string(self.redis_client.get(key))
        if current != device_id:
            return False
        self.redis_client.delete(key)
        return True

    def force_release_action_device(self, thread_id: str) -> bool:
        """强制释放 action 设备绑定（用于抢占陈旧绑定）"""
        key = self.build_action_device_key(thread_id)
        return bool(self.redis_client.delete(key))

    def wait_for_result(
        self,
        thread_id: str,
        task_id: str,
        timeout: int,
        cancel_event: Optional[threading.Event] = None,
    ) -> Optional[Dict[str, Any]]:
        """P1-6 fix: 统一委托给 ActionTransportService.wait_for_result，消除重复实现。

        P1-8 fix: 透传 cancel_event，ToolExecutor 超时时 set event
        使底层 BRPOP 轮询在 ≤2s 内退出，防止僵尸线程。
        """
        return self._transport.wait_for_result(thread_id, task_id, timeout, cancel_event=cancel_event)

    def store_result(
        self,
        thread_id: str,
        task_id: str,
        result_data: Dict[str, Any],
        ttl: int = DEFAULT_RESULT_TTL,
    ) -> str:
        """P1-6 fix: 统一委托给 ActionTransportService.store_result（含孤立 key 保护）。"""
        return self._transport.store_result(thread_id, task_id, result_data, ttl=ttl)


_singleton_instance: Optional[FrontendActionService] = None


def get_frontend_action_service() -> FrontendActionService:
    """获取 FrontendActionService 全局单例，复用同一 Redis 连接池。"""
    global _singleton_instance
    if _singleton_instance is None:
        _singleton_instance = FrontendActionService()
    return _singleton_instance


__all__ = ["FrontendActionService", "get_frontend_action_service"]
