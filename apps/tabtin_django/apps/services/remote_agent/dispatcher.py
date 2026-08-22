"""``RemoteAgentDispatcher`` — W13 替代云端编排消费者直接调用云端 ChatService 的统一入口。

API 100% 兼容云端 ChatService 的同步入口（参数列表、返回 dict 字段都不变），
原来的云端编排消费者（Wave 2 后清单）：

* ``apps/scheduler/services/skill_executor.py`` (单 Skill 执行)
* ``apps/scheduler/services/executor.py`` (run_agent action)
* ``apps/channel_gateway/tasks.py`` (飞书/微信 inbound)
* ``apps/tabtinspace/tasks.py`` (delegation forward)

(Wave 2 续作：原 ``apps/scheduler/services/step_executor.py`` /
``skill_executor_v2.py`` 在多步骤 DAG 删除时已删除，charter v1.8 §6.4 单 Skill 执行)

只需要把原来的 ``ChatService`` 同步入口替换为
``RemoteAgentDispatcher.send_message_sync(...)``，其余业务逻辑保持原状。

三分支路由（W13 D2 + W13 D6 短期实施）：
1. 未绑 ``control_device`` → 用户主动选了"轻量模式"，把
   ``app_context['runtime_mode'] = 'lightweight'`` 注入后委托给
   ``services.agent_execution.lightweight_dispatch``，由云端轻量引擎处理。
2. 绑了且 ``control_device.status`` **不在** ``DEVICE_AVAILABLE_STATUSES``
   （即 ``status not in {'online', 'busy'}``）→ 立即返回带
   ``error_category='device_offline'`` 的兼容字典，
   并在 ``client_type='server'`` 场景下推送桌面通知给 Agent owner（D3）。
   ``busy`` 视为可用——daemon/electron 端按 sessionId 互斥，多 session 并发安全；
3. 绑了且 ``status in {'online', 'busy'}`` → 通过 ``PromptForwardService``
   将 prompt 推给设备上的 DaemonAgentHost / ElectronAgentHost
   （``runtime_mode='local'``），阻塞等待结果。
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from apps.services.common.api_errors import (
    MSG_SESSION_NOT_FOUND,
    raise_not_found,
)
from apps.services.common.device_capability_registry import DEVICE_AVAILABLE_STATUSES
from apps.services.remote_agent.device_resolver import (
    DispatchTarget,
    format_device_name,
    resolve_dispatch_target,
)
from apps.services.remote_agent.forward_runner import forward_to_local_runtime
from apps.services.remote_agent.offline_notifier import notify_owner_device_offline

logger = logging.getLogger(__name__)


_CLIENT_TYPE_TO_CONTEXT_LABEL = {
    "server": "后端定时任务",
    "channel": "外部渠道（飞书/微信等）",
    "electron": "桌面客户端",
    "ios": "iOS 客户端",
    "android": "Android 客户端",
    "web": "Web 客户端",
}


def _context_label(client_type: Optional[str]) -> str:
    if not client_type:
        return "TabTin 系统"
    return _CLIENT_TYPE_TO_CONTEXT_LABEL.get(client_type, f"{client_type} 调用")


def _load_session(session_id: str, user):
    """加载 ChatSession，含 shared context 兜底；与 ChatService 的查询语义一致。

    v0.1 宪法 §5.1 后 ``current_model`` / ``default_model`` 已是软引用 UUIDField，
    不能再 prefetch_related——本函数改为只 prefetch ``context``（OneToOne 反向 FK），
    LLMModel 通过 ``attach_llm_models_to_sessions`` 显式注入缓存。

    ``space`` / ``space__agent`` 在 PostgreSQL，本表在 MySQL，跨库 select_related
    不可用——只取 ``space_id`` UUID，下游需要 Space/Agent 实体时按需 fetch。
    """
    from apps.chat.conversation.models import ChatSession
    from apps.chat.conversation.services.llm_model_loader import attach_llm_models_to_sessions

    session = (
        ChatSession.objects
        .prefetch_related("context")
        .filter(id=session_id, user=user)
        .first()
    )
    if not session:
        from apps.chat.conversation.api._common import _get_session_with_shared_access
        # ：dispatch 即执行（副作用）——执行身份必须是 owner 或 workspace
        # 成员；session-share grantee 不得直呼（shared-chat 端点以 owner 身份调入）。
        session, _is_shared = _get_session_with_shared_access(
            session_id, user, include_session_share=False,
        )

    if session:
        attach_llm_models_to_sessions([session])
    return session


def _build_notification_context(app_context: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """从 ``app_context`` 抽取 Tracker 元信息供桌面通知使用。

    波次 4 Stage 2.4 一刀切：唯一 ``_tracker_*`` 前缀；legacy ``_agenda_goal_*``
    / ``_tabgoal_*`` 已下线。
    """
    if not app_context:
        return {}

    extracted: Dict[str, Any] = {}
    tracker_id = app_context.get("_tracker_tracker_id")
    tracker_run_id = app_context.get("_tracker_tracker_run_id")
    if tracker_id:
        extracted["tracker_id"] = str(tracker_id)
    if tracker_run_id:
        extracted["tracker_run_id"] = str(tracker_run_id)

    tracker_name = app_context.get("tracker_name") or app_context.get("_tracker_name")
    if tracker_name:
        extracted["tracker_name"] = str(tracker_name)

    return extracted


def _dispatch_offline(
    *,
    session,
    target: DispatchTarget,
    client_type: Optional[str],
    app_context: Optional[Dict[str, Any]],
) -> Dict[str, Any]:
    """设备离线：立即返回 error_category='device_offline' 的兼容字典。

    ``client_type='server'`` 场景额外推送桌面通知给 Agent owner（D3）。
    其他客户端类型（channel / electron 等）不通知，避免把内部错误暴露给
    外部用户或制造无意义的自我提醒。
    """
    device = target.control_device
    device_name = format_device_name(device)
    reply_text = f"当前设备 \"{device_name}\" 不在线，请打开客户端后重试。"

    if (client_type or "").lower() == "server":
        notify_owner_device_offline(
            agent=target.agent,
            device=device,
            device_name=device_name,
            context_label=_context_label(client_type),
            app_context=_build_notification_context(app_context),
        )

    return {
        "message_id": None,
        "reply": reply_text,
        "content": "",
        "model_id": None,
        "model_name": None,
        "trace_id": None,
        "error_category": "device_offline",
        "error_message": (
            f"control_device {device_name} status="
            f"{getattr(device, 'status', 'unknown')}"
        ),
        "_remote_agent_device_name": device_name,
        "_remote_agent_device_id": (
            str(getattr(device, "id", "") or "") if device is not None else ""
        ),
    }


class RemoteAgentDispatcher:
    """6 个云端编排消费者改造后的统一入口。

    使用方式::

        from apps.services.remote_agent import RemoteAgentDispatcher

        result = RemoteAgentDispatcher.send_message_sync(
            session_id=session_id,
            user=user,
            message=prompt,
            client_type="server",
            execution_profile="task",
            app_context=app_context,
        )
        reply = result.get("reply") or result.get("content") or ""
        if result.get("error_category"):
            ...  # 走调用方原有的错误分支即可
    """

    @staticmethod
    def send_message_sync(
        session_id: str,
        user,
        message: str,
        model_id: Optional[str] = None,
        agent_name: Optional[str] = None,
        blocks: Optional[list] = None,
        attachments: Optional[list] = None,
        client_type: Optional[str] = None,
        execution_profile: Optional[str] = None,
        app_context: Optional[Dict[str, Any]] = None,
        agent_mode: Optional[str] = None,
        api_token_space_ids: Optional[List[str]] = None,
        client_message_id: Optional[str] = None,
        # 交互档（HITL 四态）。无人值守调用方（Tracker）传 'scheduled' → 设备
        # forward 路径让审批 + ask 工具 fail-fast。缺省 None → 'interactive'。
        interaction_mode: Optional[str] = None,
    ) -> Dict[str, Any]:
        session = _load_session(session_id, user)
        if not session:
            raise_not_found(MSG_SESSION_NOT_FOUND)

        target = resolve_dispatch_target(session, app_context)
        device = target.control_device

        if device is None:
            logger.info(
                "[remote_agent] lightweight branch: session=%s reason=no_control_device",
                session_id,
            )
            from apps.services.agent_execution.lightweight_dispatch import (
                dispatch_lightweight,
            )
            return dispatch_lightweight(
                session_id=session_id,
                user=user,
                message=message,
                model_id=model_id,
                agent_name=agent_name,
                blocks=blocks,
                attachments=attachments,
                client_type=client_type,
                execution_profile=execution_profile,
                app_context=app_context,
                agent_mode=agent_mode,
                api_token_space_ids=api_token_space_ids,
                client_message_id=client_message_id,
            )

        device_status = getattr(device, "status", None)
        # W13 D6 短期实施：busy 视为可用（与 PromptForward allow_busy=True、
        # skill_executor `_check_device_still_alive` 一致）；详见
        if device_status not in DEVICE_AVAILABLE_STATUSES:
            logger.info(
                "[remote_agent] device_offline branch: session=%s device=%s status=%s",
                session_id,
                getattr(device, "id", None),
                device_status,
            )
            return _dispatch_offline(
                session=session,
                target=target,
                client_type=client_type,
                app_context=app_context,
            )

        logger.info(
            "[remote_agent] local_runtime branch: session=%s device=%s agent=%s",
            session_id,
            getattr(device, "id", None),
            getattr(target.agent, "id", None) if target.agent else None,
        )
        return forward_to_local_runtime(
            session=session,
            space=target.space,
            agent=target.agent,
            control_device=device,
            message=message,
            attachments=attachments,
            app_context=app_context,
            model_id=model_id,
            # ：blocks → Host user_message_blocks（preset/@/MCP 拼装）
            blocks=blocks,
            # M2.5 方案 B（P1.3）：透传客户端 UUID，让 Daemon runtime 主轮 yield
            # USER 事件用此 id 闭合 temp id → server id 映射。
            client_message_id=client_message_id,
            # PR4-yolo (PRD v3 §5.6)：透传 AgentMode 给 forward_runner，落到
            # thread_context._agent_mode_var 给 publish_action 链路用。
            agent_mode=agent_mode,
            # 交互档透传（无人值守 fail-fast）。
            interaction_mode=interaction_mode,
        )


__all__ = ["RemoteAgentDispatcher"]
