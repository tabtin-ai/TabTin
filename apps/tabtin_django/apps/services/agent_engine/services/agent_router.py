"""
Agent 路由决策模块 — 从 ChatService._process_message_sync_core 提取。

职责：根据 Space 配置和设备状态，决定消息应由哪个后端处理：
  - Agent runtime（Daemon/Cloud 上的第三方 Agent）

路由决策与执行分离：本模块只做决策，不执行。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# 设备不可达类错误：user 消息已受理，用结构化 error_category 告知客户端即可。
# 不再落 error_envelope 气泡——否则共享侧栏会出现「[device_offline]…」+「出了点问题」
# 与底部离线提示条三重重复（ / shared-chat）。
_DEVICE_UNAVAILABLE_ERROR_CATEGORIES = frozenset({
    "device_offline",
    "device_busy",
    "device_unreachable",
    "device_dropped",
    "owner_execution_device_unavailable",
})


def _model_fields(model_instance) -> Dict[str, Any]:
    return {
        "model_id": str(model_instance.id) if model_instance else None,
        "model_name": model_instance.model_name if model_instance else None,
    }


def _resolve_forward_system_prompt(input_state: Dict[str, Any]) -> Optional[str]:
    """仅接受内部渲染链路写入的完整 system prompt override。"""
    for key in ("_request_system_prompt", "_rendered_system_prompt"):
        value = input_state.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return None


@dataclass(frozen=True)
class RoutingDecision:
    """路由决策结果（不可变）。"""

    target: str  # "external" | "error"
    handled: bool = False
    result: Optional[Dict[str, str]] = None

    # Agent runtime 路由需要的额外信息
    space_obj: Any = None
    dispatch_result: Optional[Dict[str, Any]] = None

    # 错误信封（统一格式）
    error: Optional["RoutingError"] = None


@dataclass(frozen=True)
class RoutingError:
    """路由层错误信封 — 无论哪种路由后端失败，返回结构一致。"""

    error_category: str
    user_message: str
    trace_id: Optional[str] = None
    retryable: bool = False

    def to_error_envelope(self) -> "ErrorEnvelope":
        from apps.services.agent_engine.observability.error_category import ErrorEnvelope
        return ErrorEnvelope(
            category=self.error_category,
            message=self.user_message,
            trace_id=self.trace_id,
            retryable=self.retryable,
        )


def resolve_route(
    *,
    session: Any,
    user: Any,
    workspace_id: Optional[str],
    input_state: Dict[str, Any],
    plain_text: str,
    model_id: Optional[str],
    model_instance: Any,
    effective_thread_id: str,
    user_messages: List[Any],
    blocks: Optional[list],
    attachments: Optional[list],
    client_type: Optional[str],
    execution_profile: Optional[str],
    app_context: Optional[Dict[str, Any]],
    client_message_id: Optional[str] = None,
    # PR4-yolo (PRD v3 §5.6)：消息 body 透传的 AgentMode，最终落到
    # thread_context._agent_mode_var（由 AgentDispatcher.dispatch_external set）。
    agent_mode: Optional[str] = None,
    # ：对话级审批档位，透传到 forward payload（approval_mode 字段）。
    approval_mode: Optional[str] = None,
    execution_context=None,
) -> RoutingDecision:
    """统一路由决策入口。

    返回 RoutingDecision：
    - target="builtin" + handled=False → 调用方继续内置执行
    - target="external" + handled=True + result → 调用方直接返回 result
    - target="error" + handled=True + error → 调用方构建错误响应
    """
    # Agent runtime 路由 — 所有 Agent 均走外部执行面
    workspace = None
    if workspace_id:
        from apps.tabtinspace.models import Workspace
        workspace = (
            Workspace.objects
            .select_related("organization", "device")
            .filter(id=workspace_id)
            .first()
        )

    from apps.services.agent_engine.engine.agent_dispatcher import AgentDispatcher
    dispatcher = AgentDispatcher()

    # Agent runtime dispatch
    dispatch_result = dispatcher.dispatch_external(
        session, plain_text, workspace,
        attachments=attachments,
        blocks=blocks,
        thread_id=effective_thread_id,
        model_id=model_id,
        system_prompt=_resolve_forward_system_prompt(input_state),
        # M2.5 方案 B（P1.3）：透传客户端 UUID 到 DaemonAgentHost。
        client_message_id=client_message_id,
        # L-W6-02 (W6 M3)：把 app_context 透传给 AgentDispatcher，让它从
        # ``app_context['workspace_snapshot']`` 读主控端上传的 WorkspaceSnapshot
        # 并塞进 forward_prompt payload。chat.send_message handler 在白名单加
        # workspace_snapshot 字段，path：客户端 → handler → ChatService →
        # _stage_route → 本字段 → AgentDispatcher → PromptForwardService。
        app_context=app_context,
        # PR4-yolo (PRD v3 §5.6)：透传当前 chat 的 AgentMode 给 dispatch_external，
        # 让它落到 thread_context._agent_mode_var 给 publish_action 链路读到。
        agent_mode=agent_mode,
        # ：审批档位透传到 forward payload。
        approval_mode=approval_mode,
        execution_context=execution_context,
    )
    published = dispatch_result.get("published", 0)

    logger.info(
        "[AgentRouter] External agent forwarded: thread=%s backend=%s task=%s published=%d",
        effective_thread_id, dispatch_result.get("backend_type", "external"),
        dispatch_result.get("task_id", ""), published,
    )

    if published > 0:
        return RoutingDecision(
            target="external",
            handled=True,
            space_obj=workspace,
            dispatch_result=dispatch_result,
        )

    # published == 0: Agent runtime 离线/失败
    dispatch_error = dispatch_result.get("error")
    if dispatch_error:
        return RoutingDecision(
            target="error",
            handled=True,
            space_obj=workspace,
            dispatch_result=dispatch_result,
            error=RoutingError(
                error_category=dispatch_error,
                user_message="",
                retryable=True,
            ),
        )

    # Agent runtime 不可达 → 返回设备离线错误
    error_category = _resolve_device_error_category(workspace)
    from apps.i18n import get_text as _i18n
    return RoutingDecision(
        target="error",
        handled=True,
        space_obj=workspace,
        dispatch_result=dispatch_result,
        error=RoutingError(
            error_category=error_category,
            user_message=_i18n(f"agent.{error_category}"),
            retryable=True,
        ),
    )


def handle_routing_decision(
    routing: RoutingDecision,
    *,
    session: Any,
    effective_thread_id: str,
    model_instance: Any,
    user_messages: List[Any],
) -> Optional[Dict[str, Any]]:
    """将 RoutingDecision 转换为 ChatService 可直接返回的结果字典。

    Returns None if target is "builtin"（调用方继续内置执行）。
    """
    user_msg_id = str(user_messages[0].id) if user_messages else None
    source_client_event_id = None
    if user_messages:
        source_client_event_id = str(
            getattr(user_messages[0], "client_event_id", None)
            or user_messages[0].id
        )

    if routing.target == "external" and routing.handled:
        from apps.services.agent_engine.services.daemon_checkpoint_service import DaemonCheckpointService
        DaemonCheckpointService.maybe_checkpoint_init(effective_thread_id)
        session.update_last_message_time()

        dispatch_result = routing.dispatch_result
        backend_type = dispatch_result.get("backend_type", "external")
        task_id = dispatch_result.get("task_id", "")

        from apps.services.common.agent_protocol.constants import AgentStreamEvent
        from apps.services.common.agent_protocol.namespace import stream_event_type, stream_topic
        from apps.services.common.ws.bus import publish_ws_event as _pub_ws
        from apps.services.common.ws.protocol import (
            build_envelope as _build_env,
            new_event_id as _new_eid,
        )
        _pub_ws(stream_topic(effective_thread_id), _build_env(
            stream_event_type(AgentStreamEvent.LIFECYCLE),
            _new_eid(),
            {"phase": "start", "source": "external",
             "backend_type": backend_type, "task_id": task_id,
             "source_client_event_id": source_client_event_id},
            thread_id=effective_thread_id,
        ))

        return {
            "message_id": user_msg_id or "",
            "reply": "",
            **_model_fields(model_instance),
            "trace_id": None,
            "dispatched_external": True,
            "task_id": task_id,
            "backend_type": backend_type,
        }

    if routing.target == "error" and routing.handled:
        routing_error = routing.error

        if routing.dispatch_result and routing.dispatch_result.get("error"):
            return {
                "message_id": user_msg_id or "",
                "reply": "",
                **_model_fields(model_instance),
                "trace_id": None,
                "dispatched_external": False,
                "error_category": routing_error.error_category,
                "error_message": routing_error.user_message,
                "retryable": bool(routing_error.retryable),
            }

        # 设备不可达：只回结构化字段，不落 assistant error_envelope、不推 stream done。
        if routing_error.error_category in _DEVICE_UNAVAILABLE_ERROR_CATEGORIES:
            logger.info(
                "[AgentRouter] device unavailable without error envelope: "
                "session=%s category=%s",
                getattr(session, "id", None),
                routing_error.error_category,
            )
            return {
                "message_id": user_msg_id or "",
                "reply": "",
                **_model_fields(model_instance),
                "trace_id": None,
                "dispatched_external": False,
                "error_category": routing_error.error_category,
                "error_message": routing_error.user_message,
                "retryable": bool(routing_error.retryable),
            }

        from apps.services.agent_engine.services.persistence_pipeline import (
            persist_error_message,
        )
        from apps.services.common.chat_stream_publisher import (
            ChatStreamPublisher as Publisher,
        )
        err_msg = f"[{routing_error.error_category}] {routing_error.user_message}"
        err_assistant = persist_error_message(
            session,
            err_msg,
            error_category=routing_error.error_category,
            model_instance=model_instance,
            source_client_event_id=source_client_event_id,
        )
        Publisher.publish_stream_done(
            effective_thread_id, err_msg,
            message_id=str(err_assistant.id),
            metadata={"error_category": routing_error.error_category},
            source_client_event_id=source_client_event_id,
        )
        return {
            # ACK/NAK 的 message_id 始终指向本次客户端提交的 user 消息。
            # assistant error envelope 另列，避免移动端拿错误气泡 ID 去闭合
            # 本地 optimistic user 气泡。
            "message_id": user_msg_id or "",
            "error_message_id": str(err_assistant.id),
            "reply": err_msg,
            **_model_fields(model_instance),
            "trace_id": None,
            "dispatched_external": False,
            "error_category": routing_error.error_category,
            "retryable": bool(routing_error.retryable),
        }

    return None


def _resolve_device_error_category(space_obj: Any) -> str:
    """判断设备不可达的具体原因（离线 vs 忙碌）。"""
    from apps.services.common.device_capability_registry import DEVICE_RUNTIME_TYPES

    if space_obj is None:
        return "device_offline"
    try:
        from apps.tabtinspace.services.execution_binding import resolve_control_device
        bound_device = resolve_control_device(space=space_obj)
        if (getattr(bound_device, "device_type", None) in DEVICE_RUNTIME_TYPES
                and getattr(bound_device, "status", None) == "busy"):
            return "device_busy"
    except Exception:
        logger.debug("[AgentRouter] resolve device status failed", exc_info=True)
    return "device_offline"
