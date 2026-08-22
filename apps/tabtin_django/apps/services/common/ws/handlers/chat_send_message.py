"""
chat.send_message handler — 客户端 WS 上行发消息（瘦客户端入口）。

Wave 1 / iOS 瘦客户端管线：iOS / mobile / electron 等 GUI 客户端通过这个
handler 把"用户发了一条消息"投递到后端，由后端走完 ChatService 流水线
（prepare → ingest → contextualize → route）→ PromptForward 到 Daemon /
本地 runtime 跑 Agent。

协议契约
========

上行 envelope::

    {
      "v": 1,
      "type": "chat.send_message",
      "request_id": "<client-req-uuid>",
      "ts": <epoch>,
      "device_id": "<fingerprint>",
      "role": "mobile" | "electron" | "admin" | "web",
      "payload": {
        "session_id": "<uuid>",
        "message": "纯文本",
        "client_event_id": "<uuid>",   # 必填，必须合法 UUID
        "blocks": [...],               # 可选；单 block.content > 32KB 拒绝
        "metadata": {...},             # 可选；走白名单过滤
        "model_id": "<uuid>",          # 可选
        "agent_mode": "auto" | "manual",  # 可选
        "execution_profile": "conversational" | "task" | "oneshot",  # 可选
        "app_context": {...}           # 可选；走 FocusSnapshot normalizer
        "skill_slash_invoke": {"skill_key": "...", "args": "..."}  # 可选；#9234 Host 直链
      }
    }

下行 ACK / NAK::

    chat.send_message.ok  payload = {
      "message_id":  "<server-uuid>",
      "task_id":     "<thread/run id>",
      "trace_id":    "<uuid|null>",
      "model_id":    "<uuid|null>",
      "model_name":  "<str|null>",
      "run_state":   { ... } | null   # 可选；#9051 远控/旁观 busy SSoT 快照
    }

    chat.send_message.nak payload = {
      "error_code":     "schema_invalid|session_not_found|permission_denied|"
                        "blocks_too_large|concurrent_rejected|"
                        "billing_precheck_failed|route_failed|"
                        "device_offline|internal_error|...",
      "error_message":  "<人类可读>",
      "error_category": "<可选，用于细分>",
      "retryable":      true | false
    }

设计要点
========

* role 闸门：仅 GUI 客户端（electron/mobile/admin/web）可以发消息；
  daemon / device_runtime 是后端到设备的传输角色，不应回头调发消息。
* `client_event_id` 必须合法 UUID——是 ChatMessage.client_event_id 唯一约束
  的 key，让 Daemon relay 回来的 user 事件能合并成同一行（见 Wave 1 总控）。
* `blocks` 单条 content > 32KB 拒绝——Daphne 默认 1MB WS 帧，给附件 base64
  留余量；大附件走 HTTP upload + WS 只传 file_id 的方案（followup）。
* `metadata` 白名单过滤；`app_context` 走 FocusSnapshot normalizer——
  兼容 camel/snake/flat ``current_*``，丢弃危险字段，限制 tabs/字符串大小。
* `ChatService.send_message_sync` 是阻塞同步流水线，必须用
  ``asyncio.to_thread`` 卸载，绝不能在 event loop 直接跑。
* 跨线程 ORM：``to_thread`` 内部用 user_id 重新 ``get`` User 实例，不要
  把 consumer.user 跨线程传——Django ORM 实例不是线程安全的。
* NAK 必须复用入站 envelope 的 request_id，前端 ``sendAndWaitAck`` 才能
  按 request_id 匹配回包。
"""

from __future__ import annotations

import asyncio
import logging
import re
import uuid
from typing import Any, Dict, Optional

from apps.i18n import get_text

from asgiref.sync import sync_to_async
from channels.db import database_sync_to_async
from django.contrib.auth import get_user_model
from django.db import transaction
from ninja.errors import HttpError

from apps.services.agent_execution.effective_runtime_config import EffectiveRuntimeConfigError
from apps.services.agent_engine.context.focus_snapshot import normalize_focus_snapshot

from ..protocol import (
    ERROR_PERMISSION_DENIED,
    ERROR_SCHEMA_INVALID,
    build_envelope,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

CHAT_SEND_MESSAGE_TYPE = "chat.send_message"
CHAT_SEND_MESSAGE_OK = "chat.send_message.ok"
CHAT_SEND_MESSAGE_NAK = "chat.send_message.nak"

_ALLOWED_ROLES = frozenset({"electron", "mobile", "admin", "web"})

# 与 daphne 默认 1MB WS 帧 + base64 大附件预算对齐：单 block.content 上限。
_MAX_BLOCK_CONTENT_BYTES = 32 * 1024
_MAX_SKILL_ARGUMENT_BYTES = 32 * 1024

# metadata 白名单：客户端只能填这些字段进 ChatService。
# 业务上敏感的 runtime_mode / billing_precheck_source / api_token_space_ids
# 等只允许后端注入，禁止客户端伪造。
_METADATA_WHITELIST = frozenset({
    "client_request_id",
    "client_session_id",
    "client_app_version",
    "client_platform",
    "client_locale",
    "voice_mode",
    "input_method",
    "draft_id",
    "draft_revision",
    "user_visible_label",
})

_APP_CONTEXT_WHITELIST = frozenset({
    "current_app_type",
    "current_organization_id",
    "current_space_id",
    "current_table_id",
    "current_doc_id",
    "current_slide_id",
    "current_code_id",
    "current_video_id",
    "current_site_id",
    "current_record_id",
    "current_field_id",
    "current_view_id",
    "current_url",
    "current_browser_tab_id",
    "selected_text",
    "_invoked_from",
    "user_intent",
    # 用户设备 IANA 时区（譬如 "Asia/Shanghai"）。客户端（mobile/web）上传后，
    # 经 PromptForwardService 投影归一化为 camelCase userTimeZone → wire payload →
    # Daemon AppContext.userTimeZone，让 Agent 的 current_datetime 按用户本地渲染。
    "user_time_zone",
    # L-W6-02 (W6 M3)：客户端工作区快照（Space sandbox + TabCode 项目 +
    # TabFolder 浏览目录 + 拖拽附件）。主控端（Electron / 未来 iOS/Android
    # 接 TabCode 时）通过 chat.send_message app_context.workspace_snapshot
    # 上传，AgentDispatcher / forward_runner 从 app_context 读出后透传给
    # PromptForwardService.forward_prompt(workspace_snapshot=...)，最终落到
    # wire payload `prompt.forward.workspace_snapshot`，Daemon / Electron
    # 接 forward 时 decode + 注入 EffectivePolicy。
    #
    # 形态参考 `@tabtin/security-policy` 的 `WorkspaceSnapshot`；handler 这里
    # 不强校验形态（避免反向依赖 wire schema），下游 AgentDispatcher 只做
    # is-dict 判断，wire 用 z.unknown() / Optional[Any]，Daemon / Electron
    # 端有 type guard 兜底。
    "workspace_snapshot",
    "display_message",
    #  引用回复：Electron remote viewer 把引用目标放进 app_context，
    # ChatService → forward_runner → Daemon 用它恢复与本地 IPC 同款引用语义。
    "reply_to_message_id",
    "reply_to_preview",
})


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------


def _is_valid_uuid(value: Any) -> bool:
    if not isinstance(value, str) or not value:
        return False
    try:
        uuid.UUID(value)
        return True
    except (ValueError, AttributeError):
        return False


def _validate_blocks(blocks: Any) -> Optional[str]:
    """返回 None 表示通过；返回字符串则是错误原因。"""
    if blocks is None:
        return None
    if not isinstance(blocks, list):
        return "blocks must be a list"
    for idx, block in enumerate(blocks):
        if not isinstance(block, dict):
            return f"blocks[{idx}] must be an object"
        content = block.get("content")
        if isinstance(content, (str, bytes)):
            size = len(content.encode("utf-8")) if isinstance(content, str) else len(content)
            if size > _MAX_BLOCK_CONTENT_BYTES:
                return (
                    f"blocks[{idx}].content too large ({size}B), "
                    f"max {_MAX_BLOCK_CONTENT_BYTES}B; "
                    "use file upload + file_id reference instead"
                )
    return None


def _has_text_value(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _has_valid_image_source(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    source = value.get("source")
    if isinstance(source, dict):
        source_type = source.get("type")
        if source_type == "url" and _has_text_value(source.get("url")):
            return True
        if source_type == "file_id" and _has_text_value(source.get("file_id")):
            return True
        if source_type == "base64" and _has_text_value(source.get("data")):
            return True
    return (
        _has_text_value(value.get("url"))
        or _has_text_value(value.get("image_url"))
        or _has_text_value(value.get("file_id"))
    )


def _has_valid_attachment(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    attachment_type = value.get("type")
    if attachment_type == "image":
        return _has_valid_image_source(value)
    return any(
        _has_text_value(value.get(key))
        for key in ("url", "file_id", "filename")
    )


def _has_valid_content_block(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    block_type = value.get("type")
    if block_type == "text":
        return _has_text_value(value.get("text")) or _has_text_value(value.get("content"))
    if block_type == "image":
        return _has_valid_image_source(value)
    if block_type in {"document", "file"}:
        return _has_valid_image_source(value) or _has_text_value(value.get("file_id"))
    if block_type == "composer_preset":
        # ：Skill 表单卡（Composer Preset）远控发送时 message 为空、
        # 内容全在 preset 块里（preset_id + params）。preset_id 有值即视为
        # 有效用户内容，否则远控路径的表单卡消息会被整体判空拒收。
        params = value.get("params")
        return _has_text_value(value.get("preset_id")) or (
            isinstance(params, dict) and bool(params)
        )
    return any(
        _has_text_value(value.get(key))
        for key in ("content", "summary", "title", "file_id", "source_id")
    )


def _has_user_content(message: Any, blocks: Any, attachments: Any) -> bool:
    """消息整体有效：文本非空，或存在可用内容块 / 附件。"""
    if _has_text_value(message):
        return True
    if isinstance(blocks, list) and any(_has_valid_content_block(block) for block in blocks):
        return True
    if isinstance(attachments, list) and any(_has_valid_attachment(item) for item in attachments):
        return True
    return False


def _validate_skill_slash_invoke(raw: Any) -> tuple[Optional[Dict[str, str]], Optional[str]]:
    """校验客户端显式选择的 Skill。

    这是执行意图而非 Focus 快照：handler 校验后才放入内部 app_context，
    避免客户端通过任意 app_context 字段绕过边界校验。
    """
    if raw is None:
        return None, None
    if not isinstance(raw, dict):
        return None, "skill_slash_invoke must be an object or omitted"
    skill_key = raw.get("skill_key")
    if not isinstance(skill_key, str) or not skill_key.strip():
        return None, "skill_slash_invoke.skill_key is required"
    args = raw.get("args")
    if args is not None and not isinstance(args, str):
        return None, "skill_slash_invoke.args must be a string or omitted"
    if isinstance(args, str) and len(args.encode("utf-8")) > _MAX_SKILL_ARGUMENT_BYTES:
        return None, "skill_slash_invoke.args is too large"
    result = {"skill_key": skill_key.strip()}
    if isinstance(args, str):
        result["args"] = args
    return result, None


def _filter_dict(raw: Any, whitelist: frozenset) -> Optional[Dict[str, Any]]:
    if not isinstance(raw, dict):
        return None
    cleaned = {k: v for k, v in raw.items() if k in whitelist}
    return cleaned or None


# ---------------------------------------------------------------------------
# Session / DB helpers (sync, wrapped via database_sync_to_async)
# ---------------------------------------------------------------------------


def _resolve_session_sync(session_id: str, user) -> Optional[Any]:
    """复用 ChatService 已有的 shared-context 回退逻辑。

    v0.1 宪法 §5.1：``current_model`` / ``default_model`` 已是软引用，
    ``select_related_fields`` 旧参数已无效；下游 ChatService.send_message_sync
    自己会调 ``attach_llm_models_to_sessions``，本入口不需要预加载。
    """
    from apps.chat.conversation.models import ChatSession
    from apps.chat.conversation.api import _get_session_with_shared_access

    session = ChatSession.objects.filter(id=session_id, user=user).first()
    if session:
        return session
    # legacy session_share grantee 仍走 HTTP shared-chat；v2 协作者由下方
    # _resolve_collaboration_session_sync 按 relation/version/epoch 独立验权。
    session, _is_shared = _get_session_with_shared_access(
        session_id, user, include_session_share=False,
    )
    return session


_resolve_session = database_sync_to_async(_resolve_session_sync)


def _validate_execution_target_sync(session_id: str, target: Dict[str, Any]) -> Optional[str]:
    """校验客户端执行目标与会话冻结目标或当前 Workspace 绑定一致。"""
    from apps.chat.conversation.models import ChatSession

    session = ChatSession.objects.select_related("workspace").filter(id=session_id).first()
    workspace = getattr(session, "workspace", None) if session else None
    if not workspace:
        return "binding_stale"
    expected_device_id = session.target_device_id or workspace.device_id
    if str(expected_device_id) != str(target.get("device_identity_key") or ""):
        return "binding_stale"
    return None


def _resolve_collaboration_session_sync(
    session_id: str,
    collaboration_id: str,
    collaboration_version: int,
    access_epoch: int,
    user,
):
    from apps.chat.conversation.models import SessionShare
    from apps.tabtinspace.models import OrganizationMember

    share = SessionShare.objects.select_related("session").filter(
        id=collaboration_id,
        session_id=session_id,
        grantee_user_id=str(user.id),
        card_contract="session_share_v2",
        status="active",
        eligibility_status="eligible",
    ).first()
    if share is None or not OrganizationMember.objects.filter(
        organization_id=share.organization_id,
        user_id=user.id,
    ).exists():
        return None, "access_revoked"
    if share.access_epoch != access_epoch:
        return None, "access_revoked"
    if share.version != collaboration_version:
        return None, "version_conflict"
    if not share.can_chat:
        return None, "permission_denied"
    return share, None


_resolve_collaboration_session = database_sync_to_async(
    _resolve_collaboration_session_sync,
)


def _load_user_sync(user_id: str):
    """跨线程重新拿 User 实例（不要把 consumer.user 跨线程传）。"""
    User = get_user_model()
    return User.objects.filter(id=user_id).first()


_load_user = database_sync_to_async(_load_user_sync)


@transaction.atomic
def _apply_turn_binding_sync(
    session_id: str,
    user_id: str,
    agent_id: Optional[str],
    agent_mode: Optional[str],
    approval_mode: Optional[str],
) -> None:
    from apps.chat.conversation.models import ChatMessage, ChatSession
    from apps.tabtinspace.models import Agent

    session = ChatSession.objects.select_for_update().filter(
        id=session_id,
        user_id=user_id,
    ).first()
    if session is None:
        raise HttpError(404, "session not found")
    update_fields: list[str] = []
    if agent_id is not None:
        agent = Agent.objects.filter(
            id=agent_id,
            organization_id=session.organization_id,
            owner_user_id=user_id,
            is_active=True,
        ).first()
        if agent is None:
            raise HttpError(403, "Agent 不存在或不属于当前用户")
        if session.agent_id != agent.id:
            previous_agent_id = session.agent_id
            session.agent = agent
            update_fields.append('agent')
            # ：落库 system 事实供审计/追溯；前端时间线不再展示。
            agent_name = (agent.name or '').strip() or str(agent.id)
            ChatMessage.objects.create(
                session=session,
                role='system',
                message_kind='llm',
                text_summary=f'Agent 已切换成{agent_name}',
                metadata={
                    'system_fact': 'agent_switched',
                    'from_agent_id': str(previous_agent_id) if previous_agent_id else None,
                    'to_agent_id': str(agent.id),
                    'to_agent_name': agent_name,
                    'actor_user_id': str(user_id),
                },
            )
    if agent_mode is not None and session.agent_mode != agent_mode:
        session.agent_mode = agent_mode
        update_fields.append('agent_mode')
    if update_fields:
        session.save(update_fields=[*update_fields, 'updated_at'])


_apply_turn_binding = database_sync_to_async(_apply_turn_binding_sync)


def _load_ack_run_state_sync(session_id: str) -> Optional[Dict[str, Any]]:
    from apps.services.agent_engine.models import SessionRunProjection
    from apps.services.agent_engine.services.session_run_state_service import (
        serialize_run_state,
    )

    projection = SessionRunProjection.objects.filter(session_id=session_id).first()
    return serialize_run_state(projection)


_load_ack_run_state = database_sync_to_async(_load_ack_run_state_sync)


def _evaluate_project_task_chat_send_gate(session_id: str) -> Optional[Dict[str, Any]]:
    """同步包装：project_task 会话无可运行 Run 时返回 NAK 字段。"""
    from apps.tabtinspace.services.project_task_runtime import (
        evaluate_project_task_chat_send_gate,
    )

    return evaluate_project_task_chat_send_gate(session_id)


# ---------------------------------------------------------------------------
# ChatService 同步调用（卸载到线程池，避免阻塞 event loop）
# ---------------------------------------------------------------------------


def _invoke_chat_service_sync(
    *,
    user_id: str,
    session_id: str,
    message: str,
    model_id: Optional[str],
    agent_name: Optional[str],
    blocks: Optional[list],
    attachments: Optional[list],
    client_type: str,
    execution_profile: Optional[str],
    app_context: Optional[Dict[str, Any]],
    agent_mode: Optional[str],
    approval_mode: Optional[str],
    client_message_id: str,
) -> Dict[str, Any]:
    """在线程池里跑同步 ChatService.send_message_sync。

    必须在线程池里：ChatService 内部要做 ``time.sleep`` / Redis lock /
    DB 同步事务，主 event loop 跑会导致整个 Daphne worker 卡死。
    """
    user = _load_user_sync(user_id)
    if user is None:
        raise HttpError(404, "user not found")

    from apps.services.agent_execution.chat_service import ChatService

    return ChatService.send_message_sync(
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
        approval_mode=approval_mode,
        client_message_id=client_message_id,
    )


# ---------------------------------------------------------------------------
# Error mapping
# ---------------------------------------------------------------------------


def _map_http_error(exc: HttpError) -> Dict[str, Any]:
    status = getattr(exc, "status_code", 500)
    msg = str(exc)
    if status == 400:
        return {"error_code": "schema_invalid", "error_message": msg, "retryable": False}
    if status == 401:
        return {"error_code": "auth_required", "error_message": msg, "retryable": False}
    if status == 403:
        return {"error_code": "permission_denied", "error_message": msg, "retryable": False}
    if status == 404:
        return {"error_code": "session_not_found", "error_message": msg, "retryable": False}
    if status == 409:
        return {"error_code": "conflict", "error_message": msg, "retryable": True}
    if status == 429:
        return {"error_code": "rate_limited", "error_message": msg, "retryable": True}
    return {"error_code": "internal_error", "error_message": msg, "retryable": True}


def _map_effective_runtime_config_error(exc: EffectiveRuntimeConfigError) -> Dict[str, Any]:
    """将不可通过盲重试恢复的执行绑定错误显式回传给客户端。"""
    code_map = {
        "AGENT_REQUIRED": "agent_required",
        "AGENT_NOT_FOUND": "agent_unavailable",
        "OBSERVER_SESSION": "workspace_required",
        "WORKSPACE_NOT_FOUND": "workspace_unavailable",
        "AGENT_FORBIDDEN": "permission_denied",
        "WORKSPACE_FORBIDDEN": "permission_denied",
        "ORGANIZATION_MISMATCH": "permission_denied",
    }
    return {
        "error_code": code_map.get(exc.code, "session_execution_invalid"),
        "error_message": str(exc),
        "retryable": False,
    }


# ---------------------------------------------------------------------------
# Handler factory
# ---------------------------------------------------------------------------


def create_chat_send_message_handler(consumer):
    """工厂：返回绑定到 *consumer* 的 ``chat.send_message`` async 处理器。"""

    async def _send_nak(
        request_id: str,
        error_code: str,
        error_message: str,
        *,
        retryable: bool = False,
        error_category: Optional[str] = None,
        extra: Optional[Dict[str, Any]] = None,
    ) -> None:
        payload: Dict[str, Any] = {
            "error_code": error_code,
            "error_message": error_message,
            "retryable": bool(retryable),
        }
        if error_category:
            payload["error_category"] = error_category
        if extra:
            payload.update(extra)
        # ：拒收必须在服务端留痕，否则「客户端发了但没任何执行」类问题
        # 完全无法从服务端日志取证（此前 nak 静默，pod 日志一片空白）。
        logger.warning(
            "[chat.send_message] NAK request_id=%s error_code=%s retryable=%s "
            "user=%s device=%s role=%s detail=%s",
            request_id, error_code, bool(retryable),
            getattr(getattr(consumer, "user", None), "id", None),
            getattr(consumer, "device_id", None),
            getattr(consumer, "role", None),
            error_message,
        )
        await consumer._send_envelope(build_envelope(
            CHAT_SEND_MESSAGE_NAK, request_id, payload,
        ))

    async def handle_chat_send_message(envelope: Dict[str, Any]) -> None:
        request_id = envelope["request_id"]
        payload = envelope.get("payload") or {}

        # ── role 闸门 ────────────────────────────────────────────────
        if consumer.role not in _ALLOWED_ROLES:
            await _send_nak(
                request_id, "permission_denied",
                f"role '{consumer.role}' cannot send chat messages",
            )
            return

        # ── 字段校验 ─────────────────────────────────────────────────
        session_id = payload.get("session_id")
        if not isinstance(session_id, str) or not session_id:
            await _send_nak(
                request_id, "schema_invalid",
                "session_id is required",
            )
            return

        message = payload.get("message")
        if not isinstance(message, str):
            await _send_nak(
                request_id, "schema_invalid",
                "message is required and must be a string",
            )
            return

        client_event_id = payload.get("client_event_id")
        if not _is_valid_uuid(client_event_id):
            await _send_nak(
                request_id, "schema_invalid",
                "client_event_id is required and must be a valid UUID",
            )
            return

        blocks_raw = payload.get("blocks")
        block_err = _validate_blocks(blocks_raw)
        if block_err is not None:
            await _send_nak(
                request_id,
                "blocks_too_large" if "too large" in block_err else "schema_invalid",
                block_err,
            )
            return

        attachments_raw = payload.get("attachments")
        if attachments_raw is not None and not isinstance(attachments_raw, list):
            await _send_nak(
                request_id, "schema_invalid",
                "attachments must be a list",
            )
            return

        attachments_clean = attachments_raw if isinstance(attachments_raw, list) else None
        if not _has_user_content(message, blocks_raw, attachments_clean):
            await _send_nak(
                request_id, "schema_invalid",
                "message, blocks, or attachments must contain user content",
            )
            return

        model_id = payload.get("model_id")
        if model_id is not None and not isinstance(model_id, str):
            await _send_nak(
                request_id, "schema_invalid",
                "model_id must be a string or omitted",
            )
            return

        execution_target = payload.get("execution_target")
        if execution_target is not None:
            if not isinstance(execution_target, dict):
                await _send_nak(
                    request_id, "schema_invalid",
                    "execution_target must be an object or omitted",
                )
                return
            if execution_target.get("kind") != "bound_device":
                await _send_nak(
                    request_id, "schema_invalid",
                    "execution_target.kind must be bound_device",
                )
                return
            if not isinstance(execution_target.get("device_identity_key"), str):
                await _send_nak(
                    request_id, "schema_invalid",
                    "execution_target.device_identity_key must be a string for bound_device",
                )
                return

        agent_mode = payload.get("agent_mode")
        if agent_mode is not None and not isinstance(agent_mode, str):
            await _send_nak(
                request_id, "schema_invalid",
                "agent_mode must be a string or omitted",
            )
            return

        agent_id = payload.get("agent_id")
        if agent_id is not None and not _is_valid_uuid(agent_id):
            await _send_nak(
                request_id, "schema_invalid",
                "agent_id must be a valid UUID or omitted",
            )
            return

        #  三档审批策略：对话级请求的审批档位（与 agent_mode 正交）。
        # 枚举强校验——非法值直接 nak，避免脏值一路透传到设备 host。
        approval_mode = payload.get("approval_mode")
        if approval_mode is not None and approval_mode not in (
            "always_ask", "auto", "full_access",
        ):
            await _send_nak(
                request_id, "schema_invalid",
                "approval_mode must be one of always_ask/auto/full_access or omitted",
            )
            return

        execution_profile = payload.get("execution_profile")
        if execution_profile is not None and not isinstance(execution_profile, str):
            await _send_nak(
                request_id, "schema_invalid",
                "execution_profile must be a string or omitted",
            )
            return

        collaboration_id = payload.get("collaboration_id")
        collaboration_version = payload.get("collaboration_version")
        access_epoch = payload.get("access_epoch")
        if collaboration_id is not None:
            if (
                not _is_valid_uuid(collaboration_id)
                or not isinstance(collaboration_version, int)
                or not isinstance(access_epoch, int)
            ):
                await _send_nak(
                    request_id,
                    "schema_invalid",
                    "collaboration_id, collaboration_version and access_epoch are required together",
                )
                return

        skill_slash_invoke, skill_slash_error = _validate_skill_slash_invoke(
            payload.get("skill_slash_invoke"),
        )
        if skill_slash_error is not None:
            await _send_nak(
                request_id, "schema_invalid", skill_slash_error,
            )
            return

        collaboration_id = payload.get("collaboration_id")
        collaboration_version = payload.get("collaboration_version")
        access_epoch = payload.get("access_epoch")
        if collaboration_id is not None:
            if (
                not _is_valid_uuid(collaboration_id)
                or not isinstance(collaboration_version, int)
                or not isinstance(access_epoch, int)
            ):
                await _send_nak(
                    request_id,
                    "schema_invalid",
                    "collaboration_id, collaboration_version and access_epoch are required together",
                )
                return

        # metadata 仍走白名单；app_context 走 FocusSnapshot normalizer
        # （兼容 camel/snake/flat，组装 Host Focus，丢弃危险字段）。
        # ChatService.send_message_sync 不接 metadata 参数，但客户端在 metadata
        # 里塞的几个字段（client_request_id / client_locale 等）对排障 / i18n
        # 有用，所以合并到 app_context 透传给 ChatService（带 _client_metadata
        # 前缀避免和已有 app_context 字段冲突）。合并后再 normalize 一次，
        # 确保 metadata 偷渡不进 Focus。
        metadata_clean = _filter_dict(payload.get("metadata"), _METADATA_WHITELIST)
        app_context_clean = normalize_focus_snapshot(payload.get("app_context"))
        if metadata_clean:
            merged = dict(app_context_clean or {})
            for k, v in metadata_clean.items():
                merged.setdefault(f"_client_metadata_{k}", v)
            app_context_clean = normalize_focus_snapshot(merged)
        # Focus / metadata 完成最后一次 normalizer 后再注入受信任的执行意图；
        # 否则 normalize_focus_snapshot 会把该内部字段当成未知 Focus 键删掉。
        if skill_slash_invoke is not None:
            app_context_clean = dict(app_context_clean or {})
            app_context_clean["_skill_slash_invoke"] = skill_slash_invoke

        #  / ：Skill 直链经 app_context 隧道进 ChatService →
        # AgentDispatcher → wire skill_slash_invoke（Focus normalizer 之后合并，避免被剥）。
        skill_slash_raw = payload.get("skill_slash_invoke")
        if isinstance(skill_slash_raw, dict):
            skill_key = skill_slash_raw.get("skill_key")
            if isinstance(skill_key, str) and skill_key.strip():
                skill_tunnel: Dict[str, Any] = {"skill_key": skill_key.strip()}
                skill_args = skill_slash_raw.get("args")
                if isinstance(skill_args, str):
                    skill_tunnel["args"] = skill_args
                app_context_clean = dict(app_context_clean or {})
                app_context_clean["_skill_slash_invoke"] = skill_tunnel

        # ── 用户身份校验（防匿名 / 越权）──────────────────────────────
        if not consumer.user_id:
            await _send_nak(
                request_id, "auth_required",
                "authenticated user_id required",
            )
            return

        # ── session 权限校验 ────────────────────────────────────────
        collaboration_share = None
        try:
            if collaboration_id is not None:
                collaboration_share, collaboration_error = await _resolve_collaboration_session(
                    session_id,
                    collaboration_id,
                    collaboration_version,
                    access_epoch,
                    consumer.user,
                )
                if collaboration_error:
                    await _send_nak(
                        request_id,
                        collaboration_error,
                        "collaboration access is stale or unavailable",
                        retryable=collaboration_error == "version_conflict",
                    )
                    return
                session = collaboration_share.session if collaboration_share else None
            else:
                session = await _resolve_session(session_id, consumer.user)
        except Exception:
            logger.exception(
                "[chat.send_message] session lookup failed: session=%s user=%s",
                session_id, consumer.user_id,
            )
            await _send_nak(
                request_id, "internal_error",
                "session lookup failed",
                retryable=True,
            )
            return

        if session is None:
            await _send_nak(
                request_id,
                "access_revoked" if collaboration_id is not None else "session_not_found",
                (
                    "collaboration access revoked"
                    if collaboration_id is not None
                    else "session not found or access denied"
                ),
            )
            return

        if execution_target is not None:
            target_error = await database_sync_to_async(
                _validate_execution_target_sync,
            )(session_id, execution_target)
            if target_error:
                await _send_nak(
                    request_id,
                    target_error,
                    "workspace execution binding changed; refresh the session before retrying",
                    retryable=True,
                )
                return

        if getattr(session, 'fork_copy_status', None) == 'pending':
            await _send_nak(
                request_id, "conflict",
                "fork message copy is still in progress; please wait",
                retryable=True,
            )
            return

        if getattr(session, 'is_paused', False) is True:
            await _send_nak(
                request_id,
                "session_paused",
                "session is paused; resume it before sending another message",
            )
            return

        # Project Task 会话：无可运行 Run 时拒绝同 session「重新发送」旁路。
        # 门禁只认 ChatContext._origin_source == 'project_task'，不误伤普通聊天。
        try:
            project_task_gate = await database_sync_to_async(
                _evaluate_project_task_chat_send_gate,
            )(session_id)
        except Exception:
            logger.exception(
                "[chat.send_message] project_task gate failed: session=%s user=%s",
                session_id, consumer.user_id,
            )
            await _send_nak(
                request_id, "internal_error",
                "project task run gate failed",
                retryable=True,
            )
            return
        if project_task_gate:
            await _send_nak(
                request_id,
                project_task_gate["error_code"],
                project_task_gate["error_message"],
                retryable=bool(project_task_gate.get("retryable")),
                error_category=project_task_gate.get("error_category"),
            )
            return

        try:
            if collaboration_share is not None:
                if any(value is not None for value in (agent_id, agent_mode, approval_mode)):
                    raise HttpError(403, "共享协作不能修改任务执行配置")
            else:
                await _apply_turn_binding(
                    session_id,
                    consumer.user_id,
                    agent_id,
                    agent_mode,
                    approval_mode,
                )
        except HttpError as http_exc:
            mapped = _map_http_error(http_exc)
            await _send_nak(
                request_id,
                mapped["error_code"],
                mapped["error_message"],
                retryable=mapped["retryable"],
            )
            return


        # ── 调 ChatService（卸载到线程池）───────────────────────────────
        # 客户端 UUID 直接透传——Wave 1 修复后 ChatService 内部不再覆盖。
        client_message_id = client_event_id

        # 尽量保留客户端类型语义；mobile / web / admin / electron 直接透传，
        # ChatService 内部用 client_type 选 UA / sandbox 行为。
        client_type = consumer.role

        execution_user_id = (
            collaboration_share.owner_user_id
            if collaboration_share is not None
            else consumer.user_id
        )
        if collaboration_share is not None:
            merged_context = dict(app_context_clean or {})
            merged_context["_shared_chat_by"] = str(consumer.user_id)
            app_context_clean = merged_context

        try:
            result = await asyncio.to_thread(
                _invoke_chat_service_sync,
                user_id=execution_user_id,
                session_id=session_id,
                message=message,
                model_id=model_id,
                agent_name=None,
                blocks=blocks_raw if isinstance(blocks_raw, list) else None,
                attachments=attachments_clean,
                client_type=client_type,
                execution_profile=execution_profile,
                app_context=app_context_clean,
                agent_mode=agent_mode,
                approval_mode=approval_mode,
                client_message_id=client_message_id,
            )
        except EffectiveRuntimeConfigError as config_exc:
            mapped = _map_effective_runtime_config_error(config_exc)
            await _send_nak(
                request_id,
                mapped["error_code"],
                mapped["error_message"],
                retryable=mapped["retryable"],
            )
            return
        except HttpError as http_exc:
            mapped = _map_http_error(http_exc)
            await _send_nak(
                request_id,
                mapped["error_code"],
                mapped["error_message"],
                retryable=mapped["retryable"],
            )
            return
        except Exception as exc:
            # LockLostError / Redis 故障 / 任何未预期异常 → 让客户端可重试。
            logger.exception(
                "[chat.send_message] ChatService failed: session=%s user=%s err=%s",
                session_id, consumer.user_id, exc,
            )
            await _send_nak(
                request_id, "internal_error",
                "internal error while processing message",
                retryable=True,
            )
            return

        # ── 结果分支 ────────────────────────────────────────────────
        if not isinstance(result, dict):
            await _send_nak(
                request_id, "internal_error",
                "ChatService returned unexpected result",
                retryable=True,
            )
            return

        if result.get("_rejected_concurrent"):
            await _send_nak(
                request_id, "concurrent_rejected",
                "another message is being processed for this session",
                retryable=True,
            )
            return

        error_category = result.get("error_category")
        if error_category:
            # 计费 / 路由 / device_offline 等业务错误。
            # 未收录的 category 默认走 internal_error（语义保守）——历史曾默认
            # 走 "billing_precheck_failed"，结果新增 category 没补表时用户看到
            # "余额不足"提示，与真实原因完全错位。Wave 3 修复：默认 internal_error
            # 让客户端走"服务暂时不可用，请稍后重试"，不再误导用户。
            error_code = _ERROR_CATEGORY_TO_CODE.get(error_category, "internal_error")
            persisted_message_id = result.get("message_id")
            delivery_extra = None
            if persisted_message_id:
                waiting_for_device = error_category in _DEVICE_WAITING_ERROR_CATEGORIES
                delivery_extra = {
                    "message_id": str(persisted_message_id),
                    "delivery": "persisted",
                    "execution_state": (
                        "awaiting_device" if waiting_for_device else "failed_after_persist"
                    ),
                }
            await _send_nak(
                request_id, error_code,
                _resolve_nak_user_message(result, error_category),
                retryable=(
                    bool(result.get("retryable"))
                    if "retryable" in result
                    else error_category in _RETRYABLE_ERROR_CATEGORIES
                ),
                error_category=error_category,
                extra=delivery_extra,
            )
            return

        message_id = result.get("message_id") or ""
        # 委托 / 远程 Agent 成功路径会返回 message_id=None 但带
        # ``dispatched_external`` 或 ``_remote_agent_task_id`` 标记
        # （详见 forward_runner._build_chat_service_compat_dict）。这种情况
        # 不能当成 internal_error——任务已成功投递，只是没有立即落库的
        # server message id。返回 ok 让客户端按 task_id 订阅流式结果即可。
        is_async_dispatched = bool(
            result.get("dispatched_external")
            or result.get("_remote_agent_task_id")
        )
        if not message_id and not is_async_dispatched:
            await _send_nak(
                request_id, "internal_error",
                "ChatService produced empty message_id",
                retryable=True,
            )
            return

        if collaboration_share is not None:
            from apps.chat.conversation.services import session_share_service

            await database_sync_to_async(session_share_service.mark_share_chatted)(
                collaboration_share,
                consumer.user,
                message,
            )

        # task_id 优先用 ChatService 返回的真实任务 ID（PromptForward 在
        # ``prompt_forward_service`` 里生成的 ``prompt_xxx``）。
        # 不再 fallback 到 message_id——iOS 端 cancel 会把这个值传到
        # external-agent/cancel，传错 ID 会导致 cancel 失灵。
        # task_id 为 None 时客户端应跳过 cancel HTTP 请求。
        task_id_raw = (
            result.get("task_id")
            or result.get("_remote_agent_task_id")
        )

        ack_payload: Dict[str, Any] = {
            "message_id": str(message_id) if message_id else None,
            "trace_id": result.get("trace_id"),
            "model_id": result.get("model_id"),
            "model_name": result.get("model_name"),
            "task_id": str(task_id_raw) if task_id_raw else None,
        }
        if is_async_dispatched and not message_id:
            # 显式标记"已投递但 server message id 待 relay 回灌"，让客户端
            # 渲染 user 气泡时知道走 client_event_id 闭合而不是 server_id。
            ack_payload["delivery"] = "async_dispatched"
        elif result.get("delivery"):
            ack_payload["delivery"] = str(result["delivery"])
            if result.get("execution_state"):
                ack_payload["execution_state"] = str(result["execution_state"])

        #  方案 A：ACK 同步带回当前 run_state，缩短远控发起端等待
        # on_commit → Centrifugo 的空窗（前端立刻 apply，不依赖乐观 markRun*）。
        try:
            run_state = await _load_ack_run_state(session_id)
            if run_state is not None:
                ack_payload["run_state"] = run_state
        except Exception:
            logger.exception(
                "[chat.send_message] attach run_state to ACK failed: session=%s",
                session_id,
            )

        await consumer._send_envelope(build_envelope(
            CHAT_SEND_MESSAGE_OK, request_id, ack_payload,
        ))

    return handle_chat_send_message


_DIAGNOSTIC_CONTROL_DEVICE_RE = re.compile(
    r"control_device\b.*\bstatus\s*=",
    re.IGNORECASE,
)

# 与 agent_router 对齐：无独立 i18n 键的设备类 category 回落到 device_offline 文案。
_CATEGORY_I18N_ALIASES: Dict[str, str] = {
    "device_unreachable": "agent.device_offline",
    "device_dropped": "agent.device_offline",
    "owner_execution_device_unavailable": "agent.device_offline",
}


def _is_diagnostic_error_message(
    message: str,
    *,
    error_category: Optional[str] = None,
) -> bool:
    """判断 error_message 是否为运维/诊断文本，不可直接展示给用户。"""
    text = (message or "").strip()
    if not text:
        return True
    if error_category and text == error_category:
        return True
    if _DIAGNOSTIC_CONTROL_DEVICE_RE.search(text):
        return True
    return False


def _get_i18n_message(key: str) -> Optional[str]:
    msg = get_text(key, default="")
    if msg and msg != key:
        return msg
    return None


def _localized_category_message(error_category: str) -> Optional[str]:
    """按 category 查找本地化文案（与 agent_router 的 agent.{category} 口径一致）。"""
    direct = _get_i18n_message(f"agent.{error_category}")
    if direct:
        return direct

    alias_key = _CATEGORY_I18N_ALIASES.get(error_category)
    if alias_key:
        aliased = _get_i18n_message(alias_key)
        if aliased:
            return aliased

    billing = _get_i18n_message(f"billing.{error_category}")
    if billing:
        return billing

    return None


def _resolve_nak_user_message(result: Dict[str, Any], error_category: str) -> str:
    """NAK 用户可见文案：reply → 非 diagnostic 的 error_message → 本地化 → 通用兜底。

    禁止把 snake_case 的 error_category 原样当作 error_message 下发客户端。
    """
    reply = str(result.get("reply") or "").strip()
    if reply:
        return reply

    raw_error = str(result.get("error_message") or "").strip()
    if raw_error and not _is_diagnostic_error_message(
        raw_error, error_category=error_category,
    ):
        return raw_error

    localized = _localized_category_message(error_category)
    if localized:
        return localized

    return (
        _get_i18n_message("agent.generation_failed")
        or _get_i18n_message("billing.internal_error")
        or "服务暂时不可用，请稍后重试。"
    )


# 业务 error_category → WS 协议层 error_code 映射。
# 新增类目时同步更新本表。**未命中默认走 ``internal_error``**——曾默认
# ``billing_precheck_failed``，结果新增类目漏补时用户看到"余额不足"
# 与真实原因完全错位（Wave 4 verifier 揪出的隐患 2）。internal_error 保守
# 但语义正确：客户端展示"服务暂时不可用，请稍后重试"，不再误导。
_ERROR_CATEGORY_TO_CODE: Dict[str, str] = {
    # ── 计费类 ────────────────────────────────────────
    "conversation_quota_exceeded": "billing_precheck_failed",
    "budget_exceeded": "billing_precheck_failed",
    "member_budget": "billing_precheck_failed",
    "member_monthly_limit": "billing_precheck_failed",
    "member_daily_limit": "billing_precheck_failed",
    "member_model_restricted": "billing_precheck_failed",
    "insufficient_credits": "billing_precheck_failed",
    "organization_insufficient_credits": "billing_precheck_failed",
    "billing_error": "billing_precheck_failed",
    "billing_blocked": "billing_precheck_failed",
    # ── 设备 / 路由类 ─────────────────────────────────
    # device_offline / device_busy / device_unreachable / device_dropped
    # 都属于"设备相关，可重试"——客户端按 device_offline code 给统一引导文案，
    # 同时通过 error_category 拿到细分类型供进阶展示。
    "device_offline": "device_offline",
    "device_busy": "device_offline",
    "device_unreachable": "device_offline",
    "device_dropped": "device_offline",
    "owner_execution_device_unavailable": "device_offline",
    # 路由 / 委托 / Runtime 转发类
    "route_none": "route_failed",
    "runtime_failed": "route_failed",
    "queue_full": "rate_limited",
    "queue_unavailable": "internal_error",
    "queue_recovery_unavailable": "internal_error",
    "queue_processing_failed": "internal_error",
    "missing_organization_id": "configuration_error",
    "service_disabled": "configuration_error",
    # ── 持久化类 ────────────────────────────────────
    "persist_error": "internal_error",
}

# 这些类目触发的 NAK 标记 retryable=True，让客户端 toast 引导用户重试。
# 计费类绝大多数 retryable=False（重试也不会成功），需要用户先解决配额 / 升级；
# 设备类全部 retryable=True，体现"等设备恢复就能继续"。
# 消息已落库、只是执行设备这一下没接到：手机应等设备接手，不要标成执行失败。
_DEVICE_WAITING_ERROR_CATEGORIES = frozenset({
    "device_offline",
    "device_busy",
    "device_unreachable",
    "device_dropped",
    "owner_execution_device_unavailable",
})

_RETRYABLE_ERROR_CATEGORIES = frozenset({
    *_DEVICE_WAITING_ERROR_CATEGORIES,
    "runtime_failed",
    "queue_full",
    "queue_unavailable",
    "queue_recovery_unavailable",
    "queue_processing_failed",
    "billing_error",
    "persist_error",
})


__all__ = [
    "CHAT_SEND_MESSAGE_TYPE",
    "CHAT_SEND_MESSAGE_OK",
    "CHAT_SEND_MESSAGE_NAK",
    "create_chat_send_message_handler",
]
