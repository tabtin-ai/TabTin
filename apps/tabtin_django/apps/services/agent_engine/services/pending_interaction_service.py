"""Reliable user-interaction facts for Agent HITL prompts.

实时 stream 负责"快"，PendingInteraction 负责"准"：晚进入、断网恢复、
多端抢答和过期关闭都从这里收敛。
"""

from __future__ import annotations

import logging
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone as dt_timezone
from typing import Any

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from apps.services.common.agent_protocol.constants import AgentUserEvent
from apps.services.common.agent_protocol.namespace import user_event_type
from apps.services.common.db_router import postgres_app_db_alias
from apps.services.common.ws.bus import publish_to_user
from apps.services.common.ws.protocol import build_envelope, new_event_id

logger = logging.getLogger(__name__)

DEFAULT_INTERACTION_TTL_SECONDS = 120
SINGLE_HITL_INTERACTION_KINDS = ("ask_choice", "ask_form", "permission_request")

# ：hitl ChatMessage 幂等键的 uuid5 namespace（固定值，勿改——改了会导致
# 同一 interaction 落出第二条消息）。client_event_id = uuid5(ns, f"hitl:{kind}:{request_key}")，
# 借 ChatMessage (session, client_event_id) 唯一约束实现 upsert 幂等。
HITL_MESSAGE_NAMESPACE = uuid.UUID("7b1f4d2e-9c3a-4f6b-8d5e-2a0c1b3f4e5d")


def hitl_message_client_event_id(kind: str, request_key: str) -> uuid.UUID:
    return uuid.uuid5(HITL_MESSAGE_NAMESPACE, f"hitl:{kind}:{request_key}")


@dataclass(frozen=True)
class InteractionTenant:
    session_id: str | None
    thread_id: str
    organization_id: str
    user_id: str


def _normalize_thread_id(thread_id: str) -> str:
    value = str(thread_id or "").strip()
    if not value:
        return ""
    if value.startswith("chat-session-"):
        return value
    return f"chat-session-{value}"


def _raw_session_id(thread_id: str) -> str:
    normalized = _normalize_thread_id(thread_id)
    if normalized.startswith("chat-session-"):
        return normalized[len("chat-session-"):]
    return normalized


def resolve_interaction_tenant(thread_id: str) -> InteractionTenant | None:
    """Resolve ChatSession tenant fields for a stream/action thread id."""
    normalized = _normalize_thread_id(thread_id)
    if not normalized:
        return None

    from apps.chat.conversation.models import ChatSession

    raw_session_id = _raw_session_id(normalized)
    session = (
        ChatSession.objects
        .filter(thread_id=normalized)
        .only("id", "thread_id", "organization_id", "user_id")
        .first()
    )
    if session is None:
        try:
            uuid.UUID(raw_session_id)
        except (TypeError, ValueError):
            return None
        session = (
            ChatSession.objects
            .filter(id=raw_session_id)
            .only("id", "thread_id", "organization_id", "user_id")
            .first()
        )
    if session is None:
        return None

    return InteractionTenant(
        session_id=str(session.id),
        thread_id=session.thread_id or f"chat-session-{session.id}",
        organization_id=str(session.organization_id),
        user_id=str(session.user_id),
    )


def parse_expires_at(raw: Any, *, default_ttl_seconds: int | None = None) -> datetime | None:
    if isinstance(raw, datetime):
        return raw if timezone.is_aware(raw) else timezone.make_aware(raw)
    if isinstance(raw, (int, float)):
        # Wire approval payloads use unix milliseconds. Be lenient for seconds.
        seconds = raw / 1000 if raw > 10_000_000_000 else raw
        return datetime.fromtimestamp(seconds, tz=dt_timezone.utc)
    if isinstance(raw, str) and raw.strip():
        stripped = raw.strip()
        try:
            number = float(stripped)
            return parse_expires_at(number, default_ttl_seconds=default_ttl_seconds)
        except ValueError:
            try:
                parsed = datetime.fromisoformat(stripped.replace("Z", "+00:00"))
            except ValueError:
                parsed = None
            if parsed is not None:
                return parsed if timezone.is_aware(parsed) else timezone.make_aware(parsed)
    if default_ttl_seconds and default_ttl_seconds > 0:
        return timezone.now() + timedelta(seconds=default_ttl_seconds)
    return None


def _datetime_to_ms(value: datetime | None) -> int | None:
    if value is None:
        return None
    return int(value.timestamp() * 1000)


def serialize_interaction(interaction, *, viewer_user_id: str | None = None) -> dict[str, Any]:
    return {
        "id": str(interaction.id),
        "kind": interaction.kind,
        "status": interaction.status,
        "thread_id": interaction.thread_id,
        "session_id": str(interaction.session_id) if interaction.session_id else None,
        "organization_id": str(interaction.organization_id),
        "user_id": str(interaction.user_id),
        "request_key": interaction.request_key,
        "source": interaction.source,
        "payload": _payload_visible_to_user(interaction.payload or {}, viewer_user_id),
        "result": interaction.result or {},
        "expires_at": _datetime_to_ms(interaction.expires_at),
        "resolved_at": _datetime_to_ms(interaction.resolved_at),
        "created_at": _datetime_to_ms(interaction.created_at),
        "updated_at": _datetime_to_ms(interaction.updated_at),
    }


def _team_space_execution_meta(payload: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    meta = payload.get("team_space_execution")
    return meta if isinstance(meta, dict) else {}


def interaction_notify_user_ids(interaction) -> list[str]:
    """待办事实的通知对象：会话属主 + team space 的 execution owner（去重）。

    非 team space 场景（payload 无 team_space_execution）只有会话属主，
    与历史行为完全一致；team space 场景 owner 是预期审批人（决策 Q5：
    成员只读等待、owner 完整审批），不 fan-out 给 owner 时 owner 的
    pill / 弹窗 / 待办列表全部失明。
    """
    recipients = [str(interaction.user_id)]
    meta = _team_space_execution_meta(interaction.payload)
    execution_owner_user_id = str(meta.get("execution_owner_user_id") or "")
    if execution_owner_user_id and execution_owner_user_id not in recipients:
        recipients.append(execution_owner_user_id)
    return recipients


def _publish_interaction_event(event_name: str, interaction) -> bool:
    event_id = new_event_id()
    published_any = False
    for recipient_user_id in interaction_notify_user_ids(interaction):
        envelope = build_envelope(
            user_event_type(event_name),
            event_id,
            {
                "interaction": serialize_interaction(
                    interaction,
                    viewer_user_id=recipient_user_id,
                ),
            },
            thread_id=interaction.thread_id,
            organization_id=str(interaction.organization_id),
            session_id=str(interaction.session_id) if interaction.session_id else None,
        )
        if publish_to_user(recipient_user_id, envelope):
            published_any = True
    return published_any


def _team_space_execution_owner_user_id(payload: dict[str, Any] | None) -> str:
    meta = _team_space_execution_meta(payload)
    return str(meta.get("execution_owner_user_id") or "")


TEAM_SPACE_EXECUTION_REDACTION_REQUIRED_KEY = "__team_space_execution_redaction_required"
REDACTED_APPROVAL_TOOL_NAME = "redacted_tool"


def _redacted_approval_action_contract(action: Any) -> dict[str, Any]:
    if not isinstance(action, dict):
        return {}

    request_id = action.get("request_id")
    tool_call_id = action.get("tool_call_id")
    request_id = request_id if isinstance(request_id, str) and request_id else None
    tool_call_id = tool_call_id if isinstance(tool_call_id, str) and tool_call_id else None
    stable_id = request_id or tool_call_id
    if not stable_id:
        return {}

    return {
        "request_id": stable_id,
        "tool_call_id": tool_call_id or stable_id,
        "tool_name": REDACTED_APPROVAL_TOOL_NAME,
    }


def redact_team_space_tool_approval_payload(payload: dict[str, Any]) -> dict[str, Any]:
    if (
        not _team_space_execution_owner_user_id(payload)
        and payload.get(TEAM_SPACE_EXECUTION_REDACTION_REQUIRED_KEY) is not True
    ):
        return payload
    action_requests = payload.get("action_requests")
    redacted_actions = (
        [_redacted_approval_action_contract(action) for action in action_requests]
        if isinstance(action_requests, list)
        else []
    )
    redacted: dict[str, Any] = {
        "details_redacted": True,
        "action_requests": redacted_actions,
    }
    for key in (
        "batch_id",
        "approval_type",
        "interaction_type",
        "blocking_policy",
        "runtime_mode",
        "expires_at",
        "approval_ttl_seconds",
        "interrupted_at",
        "schema_version",
        "team_space_execution",
        # ：非 Owner 也需要同源 message_id 才能定位 hitl_interaction / 通知跳转
        "message_id",
    ):
        if key in payload:
            redacted[key] = payload[key]
    return redacted


def _payload_visible_to_user(payload: dict[str, Any], viewer_user_id: str | None) -> dict[str, Any]:
    if not viewer_user_id:
        return payload
    owner_user_id = _team_space_execution_owner_user_id(payload)
    if not owner_user_id or str(viewer_user_id) == owner_user_id:
        return payload
    return redact_team_space_tool_approval_payload(payload)


def _interaction_visible_to_user(interaction, user_id: str) -> bool:
    if str(interaction.user_id) == str(user_id):
        return True

    meta = _team_space_execution_meta(interaction.payload)
    collaboration_space_id = str(meta.get("collaboration_space_id") or "")
    if not collaboration_space_id:
        return False

    if str(meta.get("initiator_user_id") or "") == str(user_id):
        return True
    if str(meta.get("execution_owner_user_id") or "") == str(user_id):
        return True

    try:
        from apps.tabtinspace.models import ProjectMembership

        return ProjectMembership.objects.filter(
            project_id=collaboration_space_id,
            user_id=user_id,
            is_active=True,
            status=ProjectMembership.Status.ACTIVE,
        ).exists()
    except Exception:
        logger.debug(
            "[PendingInteraction] team visibility check failed: user=%s space=%s",
            user_id, collaboration_space_id, exc_info=True,
        )
        return False


def _resolve_interaction_session(thread_id: str):
    from apps.chat.conversation.models import ChatSession

    normalized = _normalize_thread_id(thread_id)
    if not normalized:
        return None
    session = (
        ChatSession.objects
        .select_related("workspace__device")
        .filter(thread_id=normalized)
        .only(
            "id",
            "thread_id",
            "organization_id",
            "user_id",
            "project_id",
            "target_device_installation_id",
            "workspace__device__fingerprint",
        )
        .first()
    )
    if session is not None:
        return session
    raw_session_id = _raw_session_id(normalized)
    try:
        uuid.UUID(raw_session_id)
    except (TypeError, ValueError):
        return None
    return (
        ChatSession.objects
        .select_related("workspace__device")
        .filter(id=raw_session_id)
        .only(
            "id",
            "thread_id",
            "organization_id",
            "user_id",
            "project_id",
            "target_device_installation_id",
            "workspace__device__fingerprint",
        )
        .first()
    )


def _resolve_interaction_run(thread_id: str, run_id: str):
    from apps.services.agent_engine.models import ExecutionRun

    try:
        normalized_run_id = uuid.UUID(str(run_id))
        session_id = uuid.UUID(_raw_session_id(thread_id))
    except (TypeError, ValueError):
        return None
    return (
        ExecutionRun.objects
        .filter(run_id=normalized_run_id, session_id=str(session_id))
        .only("run_id", "session_id", "user_id", "metadata")
        .first()
    )


def _resolve_current_interaction_run(thread_id: str):
    from apps.services.agent_engine.services.session_run_state_service import (
        SessionRunStateService,
    )

    return SessionRunStateService.get_current_run(thread_id)


def resolve_current_interaction_run_id(thread_id: str) -> str:
    """Resolve a server-attributed run for legitimate out-of-turn events."""
    run = _resolve_current_interaction_run(thread_id)
    return str(getattr(run, "run_id", "") or "")


def _personal_runtime_source_matches(session, user_id: str, source: str) -> bool:
    if str(session.user_id) != str(user_id):
        return False
    frozen = str(session.target_device_installation_id or "")
    if frozen:
        return source == frozen
    workspace = getattr(session, "workspace", None)
    device = getattr(workspace, "device", None)
    workspace_device = str(getattr(device, "fingerprint", "") or "")
    return bool(workspace_device and source == workspace_device)


def _bound_action_device_matches(thread_id: str, source: str) -> bool:
    try:
        from apps.services.agent_engine.services.action_transport_service import (
            ActionTransportService,
        )

        transport = ActionTransportService()
        normalized = _normalize_thread_id(thread_id)
        keys = tuple(dict.fromkeys((normalized, _raw_session_id(normalized))))
        return any(
            str(transport.get_action_device(key) or "") == source
            for key in keys
            if key
        )
    except Exception:
        logger.debug(
            "[PendingInteraction] action-device binding lookup failed: thread=%s",
            thread_id,
            exc_info=True,
        )
        return False


def _project_workspace_device_matches(session, user_id: str, source: str) -> bool:
    try:
        from django.contrib.auth import get_user_model

        from apps.tabtinspace.services.project_execution import (
            resolve_project_execution_workspace,
        )

        user = get_user_model().objects.filter(id=user_id).first()
        project = getattr(session, "project", None)
        if project is None and getattr(session, "project_id", None):
            from apps.tabtinspace.models import Project

            project = Project.objects.filter(id=session.project_id).first()
        if user is None or project is None:
            return False
        workspace = resolve_project_execution_workspace(
            project=project,
            user=user,
        )
        if workspace is None:
            return False
        device = getattr(workspace, "device", None)
        return str(getattr(device, "fingerprint", "") or "") == source
    except Exception:
        logger.debug(
            "[PendingInteraction] Project workspace device lookup failed: thread=%s",
            getattr(session, "thread_id", ""),
            exc_info=True,
        )
        return False


def _latest_project_initiator_matches(session, user_id: str) -> bool:
    try:
        from apps.chat.conversation.models import ChatMessage

        initiator_id = (
            ChatMessage.objects
            .filter(session_id=session.id, role="user")
            .order_by("-created_at", "-id")
            .values_list("sender_user_id", flat=True)
            .first()
        )
        return bool(initiator_id and str(initiator_id) == str(user_id))
    except Exception:
        return False


def _legacy_project_runtime_source_matches(
    *,
    session,
    thread_id: str,
    user_id: str,
    source: str,
    require_latest_initiator: bool,
) -> bool:
    if require_latest_initiator and not _latest_project_initiator_matches(
        session,
        user_id,
    ):
        return False
    return (
        _bound_action_device_matches(thread_id, source)
        or _project_workspace_device_matches(session, user_id, source)
    )


def _runtime_source_matches_run(
    *,
    session,
    thread_id: str,
    run,
    user_id: str,
    source: str,
) -> bool:
    if str(run.user_id or "") != str(user_id):
        return False
    metadata = run.metadata if isinstance(run.metadata, dict) else {}
    run_target = str(
        metadata.get("target_device_installation_id") or ""
    ).strip()
    if run_target:
        return source == run_target
    if getattr(session, "project_id", None):
        return _legacy_project_runtime_source_matches(
            session=session,
            thread_id=thread_id,
            user_id=user_id,
            source=source,
            require_latest_initiator=False,
        )
    return _personal_runtime_source_matches(session, user_id, source)


def _daemon_control_enabled_for_runtime(session, user_id: str) -> bool:
    from apps.services.daemon_control.feature import (
        daemon_control_enabled_for_organization,
    )

    return daemon_control_enabled_for_organization(
        user_id=str(user_id),
        organization_id=str(getattr(session, "organization_id", "") or ""),
    )


def runtime_can_open_interaction(
    *,
    thread_id: str,
    user_id: str,
    source_device_fingerprint: str,
    run_id: str | None = None,
) -> bool:
    """Validate a runtime against this turn's frozen owner and installation."""
    try:
        session = _resolve_interaction_session(thread_id)
        if session is None:
            return False
        source = str(source_device_fingerprint or "")
        if not source:
            return False

        normalized_run_id = str(run_id or "").strip()
        if normalized_run_id:
            run = _resolve_interaction_run(thread_id, normalized_run_id)
            if run is not None:
                return _runtime_source_matches_run(
                    session=session,
                    thread_id=thread_id,
                    run=run,
                    user_id=user_id,
                    source=source,
                )
            if not getattr(session, "project_id", None):
                # Personal legacy clients may relay lifecycle.start before the
                # local dispatch fact has reached Django.
                return _personal_runtime_source_matches(session, user_id, source)
            if _daemon_control_enabled_for_runtime(session, user_id):
                return False
            return _legacy_project_runtime_source_matches(
                session=session,
                thread_id=thread_id,
                user_id=user_id,
                source=source,
                require_latest_initiator=True,
            )

        if getattr(session, "project_id", None):
            current_run = _resolve_current_interaction_run(thread_id)
            if current_run is not None:
                return _runtime_source_matches_run(
                    session=session,
                    thread_id=thread_id,
                    run=current_run,
                    user_id=user_id,
                    source=source,
                )
            if _daemon_control_enabled_for_runtime(session, user_id):
                return False
            return _legacy_project_runtime_source_matches(
                session=session,
                thread_id=thread_id,
                user_id=user_id,
                source=source,
                require_latest_initiator=True,
            )

        return _personal_runtime_source_matches(session, user_id, source)
    except Exception:
        logger.warning(
            "[PendingInteraction] runtime source validation failed: thread=%s",
            thread_id,
            exc_info=True,
        )
        return False


def can_resolve_pending_interaction(
    *,
    thread_id: str,
    request_key: str,
    user_id: str,
    kinds: tuple[str, ...],
) -> bool:
    """Authorize a user response from the durable pending-interaction fact."""
    from apps.services.agent_engine.models import PendingInteraction

    try:
        normalized = _normalize_thread_id(thread_id)
        if not normalized or not request_key or not user_id or not kinds:
            return False
        interaction = (
            PendingInteraction.objects.using(postgres_app_db_alias())
            .filter(
                kind__in=kinds,
                thread_id=normalized,
                request_key=str(request_key),
                status="pending",
            )
            .only(
                "kind",
                "session_id",
                "organization_id",
                "user_id",
                "source_device_fingerprint",
                "payload",
            )
            .first()
        )
        if interaction is None or not isinstance(interaction.payload, dict):
            return False
        if interaction.payload.get(TEAM_SPACE_EXECUTION_REDACTION_REQUIRED_KEY) is True:
            return False

        session = _resolve_interaction_session(normalized)
        if (
            session is None
            or interaction.session_id != session.id
            or str(interaction.organization_id) != str(session.organization_id)
        ):
            return False

        expected_thread = session.thread_id or f"chat-session-{session.id}"
        if _normalize_thread_id(expected_thread) != normalized:
            return False

        team_meta = _team_space_execution_meta(interaction.payload)
        execution_owner_id = str(
            team_meta.get("execution_owner_user_id") or ""
        )
        runtime_owner_id = execution_owner_id or str(session.user_id)
        source = str(interaction.source_device_fingerprint or "")
        if not runtime_can_open_interaction(
            thread_id=normalized,
            run_id=str(interaction.payload.get("run_id") or "") or None,
            user_id=runtime_owner_id,
            source_device_fingerprint=source,
        ):
            return False

        if team_meta:
            if not execution_owner_id or str(user_id) != execution_owner_id:
                return False
            return str(interaction.user_id) == str(session.user_id)

        return (
            str(interaction.user_id) == str(session.user_id) == str(user_id)
        )
    except Exception:
        logger.warning(
            "[PendingInteraction] resolution authorization failed: thread=%s kind=%s",
            thread_id,
            ",".join(kinds),
            exc_info=True,
        )
        return False


def _sync_hitl_chat_message(interaction) -> None:
    """#4999：把 PendingInteraction 的当前状态镜像成一条持久化 ChatMessage。

    与调用方同一 transaction.atomic 内执行——interaction 与消息要么一起落、
    要么一起回滚，客户端不会看到「审批在等但消息里没有」的中间态。

    幂等：client_event_id 由 kind+request_key 确定性派生，upsert 命中同一条。
    状态翻转（pending→resolved/expired/cancelled）只更新 metadata.hitl，
    ChatMessage.updated_at auto_now 随之刷新 → 增量 sync（updated_after 水位）
    把状态变化带到所有端，前端面板据此开/清（见 renderer
    reconcileHitlPanelsFromMessages）。

    payload 存 thread 广播口径：team space 场景经 redact 脱敏（与 relay_handler
    的 thread 广播一致），owner 的完整明细仍走 IPC / owner user event 快路径。
    """
    session_id = str(interaction.session_id or "")
    if not session_id:
        return

    from apps.chat.conversation.models import ChatMessage

    payload = interaction.payload or {}
    if interaction.kind == "tool_approval":
        payload = redact_team_space_tool_approval_payload(payload)

    db_alias = postgres_app_db_alias()
    ChatMessage.objects.using(db_alias).update_or_create(
        session_id=session_id,
        client_event_id=hitl_message_client_event_id(interaction.kind, interaction.request_key),
        defaults={
            "role": "assistant",
            "message_kind": "hitl_interaction",
            "metadata": {
                "hitl": {
                    "kind": interaction.kind,
                    "request_key": interaction.request_key,
                    "status": interaction.status,
                    "interaction_id": str(interaction.id),
                    "payload": payload,
                    "result": interaction.result or {},
                    "expires_at": _datetime_to_ms(interaction.expires_at),
                    "resolved_at": _datetime_to_ms(interaction.resolved_at),
                },
            },
        },
    )


def upsert_pending_interaction(
    *,
    kind: str,
    thread_id: str,
    request_key: str,
    source: str,
    payload: dict[str, Any],
    organization_id: str | None = None,
    user_id: str | None = None,
    session_id: str | None = None,
    source_device_fingerprint: str | None = None,
    expires_at: Any = None,
    default_ttl_seconds: int | None = DEFAULT_INTERACTION_TTL_SECONDS,
    publish: bool = True,
):
    """Create/update a pending interaction and notify online user devices."""
    from apps.services.agent_engine.models import PendingInteraction

    normalized_thread_id = _normalize_thread_id(thread_id)
    if not normalized_thread_id or not request_key:
        return None

    tenant = None
    if not (organization_id and user_id and session_id):
        tenant = resolve_interaction_tenant(normalized_thread_id)
    resolved_organization_id = str(organization_id or (tenant.organization_id if tenant else "") or "")
    resolved_user_id = str(user_id or (tenant.user_id if tenant else "") or "")
    resolved_session_id = str(session_id or (tenant.session_id if tenant else "") or "") or None
    if not resolved_organization_id or not resolved_user_id:
        logger.warning(
            "[PendingInteraction] tenant unresolved, skip upsert: thread=%s kind=%s key=%s",
            normalized_thread_id, kind, request_key,
        )
        return None

    expires_dt = parse_expires_at(expires_at, default_ttl_seconds=default_ttl_seconds)
    db_alias = postgres_app_db_alias()
    now = timezone.now()

    defaults = {
        "status": "pending",
        "session_id": resolved_session_id,
        "organization_id": resolved_organization_id,
        "user_id": resolved_user_id,
        "source": source,
        "source_device_fingerprint": str(source_device_fingerprint or ""),
        "payload": payload,
        "result": {},
        "expires_at": expires_dt,
        "resolved_at": None,
    }
    with transaction.atomic(using=db_alias):
        interaction, created = PendingInteraction.objects.using(db_alias).select_for_update().get_or_create(
            kind=kind,
            thread_id=normalized_thread_id,
            request_key=str(request_key),
            defaults=defaults,
        )
        if not created and interaction.status == "pending":
            for field, value in defaults.items():
                setattr(interaction, field, value)
            interaction.save(update_fields=[
                "session_id",
                "organization_id",
                "user_id",
                "source",
                "source_device_fingerprint",
                "payload",
                "result",
                "expires_at",
                "resolved_at",
                "updated_at",
            ])
        # HITL transcript 消息本体由 runtime 权威产出（runtime 在发 *_required 卡片
        # 事件时同发 hitl_interaction persist_message，经 relay 落 ChatMessage）——
        # 这里不再自建，避免与 persist 双写（不同 id 键会撞 client_event_id 唯一约束）。
        # PendingInteraction（在线 waiter 登记 + 惰性过期）仍由本服务维护。

    if interaction.status == "pending" and interaction.expires_at and interaction.expires_at <= now:
        interaction = mark_interaction_resolved(
            kind=kind,
            thread_id=normalized_thread_id,
            request_key=str(request_key),
            status="expired",
            result={"reason": "expired_on_upsert"},
            publish=True,
        ) or interaction
    elif publish and created:
        _publish_interaction_event(AgentUserEvent.INTERACTION_REQUESTED, interaction)
        # 站内通知落库（通知中心）
        try:
            from apps.services.notification.services.agent_task_notification import (
                notify_agent_hitl_waiting,
            )

            kind = str(getattr(interaction, "kind", "") or "")
            if kind == "tool_approval":
                title = "Agent 等待确认"
                body = "Agent 需要你审核操作后继续"
            else:
                title = "Agent 向你提问"
                body = "Agent 需要你回答问题后继续"
            notify_agent_hitl_waiting(
                interaction=interaction,
                title=title,
                body=body,
            )
        except Exception:
            logger.warning(
                "[PendingInteraction] HITL notification failed: kind=%s key=%s",
                getattr(interaction, "kind", None),
                request_key,
                exc_info=True,
            )
        # 移动端远程推送叫醒（，与站内通知互补，异步/尽力而为）
        _schedule_interaction_push(interaction)

    if interaction.status == "pending":
        run_id = payload.get("run_id")
        if isinstance(run_id, str) and run_id:
            from apps.services.agent_engine.services.session_run_state_service import (
                SessionRunStateService,
            )

            SessionRunStateService.transition(
                run_id=run_id,
                status="waiting_user",
                event_revision=(
                    payload.get("arrival_seq")
                    if isinstance(payload.get("arrival_seq"), int)
                    and not isinstance(payload.get("arrival_seq"), bool)
                    else None
                ),
                waiting_interaction_id=str(interaction.id),
            )
    return interaction


def _schedule_interaction_push(interaction) -> None:
    """离线叫醒：交互创建后异步发移动端远程推送。

    尽力而为——推送开关未配置 / broker 故障都不阻断交互主链路；
    在线抑制、偏好过滤、幂等去重在 Celery task 侧统一处理。
    """
    try:
        from apps.services.notification.push.providers import is_push_enabled
        if not is_push_enabled():
            return
        from apps.services.notification.tasks import push_interaction_requested
        push_interaction_requested.delay(str(interaction.id))
    except Exception:
        logger.debug(
            "[PendingInteraction] schedule push failed: interaction=%s",
            getattr(interaction, "id", "?"), exc_info=True,
        )


def upsert_tool_approval_interaction(
    *,
    thread_id: str,
    payload: dict[str, Any],
    source: str = "agent_stream",
    source_device_fingerprint: str | None = None,
    organization_id: str | None = None,
    user_id: str | None = None,
    session_id: str | None = None,
    publish: bool = True,
):
    batch_id = payload.get("batch_id")
    if not isinstance(batch_id, str) or not batch_id:
        return None
    return upsert_pending_interaction(
        kind="tool_approval",
        thread_id=thread_id,
        request_key=batch_id,
        source=source,
        payload=payload,
        organization_id=organization_id,
        user_id=user_id,
        session_id=session_id,
        source_device_fingerprint=source_device_fingerprint,
        expires_at=payload.get("expires_at"),
        default_ttl_seconds=DEFAULT_INTERACTION_TTL_SECONDS,
        publish=publish,
    )


def upsert_action_approval_interaction(
    *,
    thread_id: str,
    approval_id: str,
    payload: dict[str, Any],
    organization_id: str | None = None,
    user_id: str | None = None,
    session_id: str | None = None,
    source_device_fingerprint: str | None = None,
    publish: bool = True,
):
    if not approval_id:
        return None
    action_payload = {
        **payload,
        "approval_id": approval_id,
        "schema_version": 1,
    }
    return upsert_pending_interaction(
        kind="tool_approval",
        thread_id=thread_id,
        request_key=approval_id,
        source="agent_action",
        payload=action_payload,
        organization_id=organization_id,
        user_id=user_id,
        session_id=session_id,
        source_device_fingerprint=source_device_fingerprint,
        expires_at=payload.get("expires_at"),
        default_ttl_seconds=DEFAULT_INTERACTION_TTL_SECONDS,
        publish=publish,
    )


def _first_non_empty_string(*values: Any) -> str | None:
    for value in values:
        if isinstance(value, str) and value:
            return value
    return None


def upsert_single_hitl_interaction(
    *,
    kind: str,
    thread_id: str,
    payload: dict[str, Any],
    source: str = "agent_stream",
    source_device_fingerprint: str | None = None,
    organization_id: str | None = None,
    user_id: str | None = None,
    session_id: str | None = None,
    publish: bool = True,
):
    request_key = _first_non_empty_string(
        payload.get("request_id"),
        payload.get("interrupt_id"),
        payload.get("ask_id"),
        payload.get("message_id"),
    )
    if not request_key:
        return None

    enriched_payload = dict(payload)
    enriched_payload.setdefault("request_id", request_key)

    return upsert_pending_interaction(
        kind=kind,
        thread_id=thread_id,
        request_key=request_key,
        source=source,
        payload=enriched_payload,
        organization_id=organization_id,
        user_id=user_id,
        session_id=session_id,
        source_device_fingerprint=source_device_fingerprint,
        expires_at=enriched_payload.get("expires_at"),
        default_ttl_seconds=DEFAULT_INTERACTION_TTL_SECONDS,
        publish=publish,
    )


def mark_interaction_resolved(
    *,
    kind: str,
    thread_id: str,
    request_key: str,
    status: str = "resolved",
    result: dict[str, Any] | None = None,
    publish: bool = True,
    sync_message: bool = True,
):
    """Mark an interaction terminal. Idempotent for duplicate resolve events.

    `sync_message`：是否由本服务把终态镜像成 hitl_interaction ChatMessage。
      - **runtime 在场的 resolve**（用户判决 / 追问回应）：runtime 已发终态
        persist_message 权威落库，传 False 避免双写。
      - **runtime 不在场的 expire/cancel**（Django 惰性过期 / runtime_gone 取消）：
        默认 True，按 client_event_id 更新 runtime 建的行（无 runtime 事件兜底）。
    """
    from apps.services.agent_engine.models import PendingInteraction

    if status not in {"resolved", "expired", "cancelled"}:
        raise ValueError(f"unsupported terminal status: {status}")

    normalized_thread_id = _normalize_thread_id(thread_id)
    db_alias = postgres_app_db_alias()
    with transaction.atomic(using=db_alias):
        interaction = (
            PendingInteraction.objects.using(db_alias)
            .select_for_update()
            .filter(kind=kind, thread_id=normalized_thread_id, request_key=str(request_key))
            .first()
        )
        if interaction is None:
            return None
        previous_status = interaction.status
        if previous_status == "pending":
            interaction.status = status
            interaction.result = result or {}
            interaction.resolved_at = timezone.now()
            interaction.save(update_fields=["status", "result", "resolved_at", "updated_at"])
            if sync_message:
                _sync_hitl_chat_message(interaction)

    if previous_status == "pending" and interaction is not None:
        # 铃铛 agent.hitl.waiting 随 HITL 终态自动已读；失败不阻断 resolve。
        _safe_mark_hitl_waiting_notifications_read(interaction)
        if publish:
            event = (
                AgentUserEvent.INTERACTION_EXPIRED
                if status == "expired"
                else AgentUserEvent.INTERACTION_RESOLVED
            )
            _publish_interaction_event(event, interaction)
        run_id = (interaction.payload or {}).get("run_id")
        if isinstance(run_id, str) and run_id:
            from apps.services.agent_engine.models import PendingInteraction
            from apps.services.agent_engine.services.session_run_state_service import (
                SessionRunStateService,
            )

            has_other_pending = PendingInteraction.objects.using(db_alias).filter(
                thread_id=normalized_thread_id,
                status="pending",
                payload__run_id=run_id,
            ).exclude(pk=interaction.pk).exists()
            session_is_paused = False
            if interaction.session_id:
                from apps.chat.conversation.models import ChatSession

                session_is_paused = ChatSession.objects.using(db_alias).filter(
                    pk=interaction.session_id,
                    is_paused=True,
                ).exists()
            if not has_other_pending and not session_is_paused:
                SessionRunStateService.transition(
                    run_id=run_id,
                    status="running",
                    allowed_from=frozenset({"waiting_user"}),
                )
    return interaction


def _safe_mark_hitl_waiting_notifications_read(interaction) -> None:
    """PendingInteraction 终态后，按 interaction_id（request_key 兜底）清铃铛 HITL 未读。"""
    try:
        from apps.services.notification.services.notification_service import (
            NotificationService,
        )

        NotificationService.mark_agent_hitl_waiting_read(
            interaction_id=str(getattr(interaction, "id", "") or ""),
            request_key=str(getattr(interaction, "request_key", "") or ""),
        )
    except Exception:
        logger.exception(
            "[PendingInteraction] mark hitl waiting notifications read failed id=%s",
            getattr(interaction, "id", None),
        )


def mark_tool_approval_resolved_from_payload(
    *,
    thread_id: str,
    payload: dict[str, Any],
    status: str | None = None,
    publish: bool = True,
):
    """把 runtime 上行的 approval_resolved payload 落成 PendingInteraction 终态。

    （第二刀）：``status`` 缺省时按 ``payload.decisions[*].outcome`` 推导
    （与 runtime ``deriveTerminalStatus`` 同规则）——无人及时响应 / 服务端过期回灌
    → ``expired``；mode 切换 / rollback / renderer dismiss → ``cancelled``；
    用户主动 allow/deny → ``resolved``。原实装强制 ``resolved``，让 PendingInteraction
    表与 ChatMessage.metadata.hitl.status 漂移。显式传 ``status`` 参数（譬如
    Django 侧兜底扫描）则以调用方为准，不再回落。
    """
    batch_id = payload.get("batch_id")
    if not isinstance(batch_id, str) or not batch_id:
        return None
    resolved_status = status if status is not None else _derive_approval_terminal_status(payload)
    return mark_interaction_resolved(
        kind="tool_approval",
        thread_id=thread_id,
        request_key=batch_id,
        status=resolved_status,
        result=payload,
        publish=publish,
        # runtime 在场的判决：runtime 已发终态 persist 权威落库，避免双写。
        sync_message=False,
    )


# runtime `deriveTerminalStatus` 的 Python 侧镜像——严档优先：
# expired > cancelled > resolved（默认）。
_APPROVAL_TERMINAL_EXPIRED_OUTCOMES = frozenset({"expired"})
_APPROVAL_TERMINAL_CANCELLED_OUTCOMES = frozenset({"cancelled"})


def _derive_approval_terminal_status(payload: dict[str, Any]) -> str:
    decisions = payload.get("decisions")
    if not isinstance(decisions, list) or not decisions:
        return "resolved"
    for decision in decisions:
        if not isinstance(decision, dict):
            continue
        outcome = decision.get("outcome") or decision.get("decision") or decision.get("type")
        if not isinstance(outcome, str):
            continue
        if outcome in _APPROVAL_TERMINAL_EXPIRED_OUTCOMES:
            return "expired"
        if outcome in _APPROVAL_TERMINAL_CANCELLED_OUTCOMES:
            return "cancelled"
    return "resolved"


def mark_single_hitl_resolved(
    *,
    thread_id: str,
    request_id: str,
    result: dict[str, Any] | None = None,
    status: str = "resolved",
    publish: bool = True,
):
    if not request_id:
        return None
    for kind in SINGLE_HITL_INTERACTION_KINDS:
        interaction = mark_interaction_resolved(
            kind=kind,
            thread_id=thread_id,
            request_key=request_id,
            status=status,
            result=result or {},
            publish=publish,
            # runtime 在场的追问回应：runtime 已发终态 persist 权威落库，避免双写。
            sync_message=False,
        )
        if interaction is not None:
            return interaction
    return None


# ─── ：单 HITL 断点恢复查询 ────────────────────────────────
#
# runtime 崩溃 / daemon 重启后，``PromptForwardService.forward_prompt`` 在
# resume 路径上调用本函数，把 thread 上尚未闭合的单 HITL（ask_choice /
# ask_form / permission_request）行按 wire 形态透传给 runtime。runtime
# ``pending-single-hitl-restorer`` 处理：resolved 直接 inject 用户答复，
# pending 走 ``InterruptPort.interrupt`` 重挂等待。
#
# 与 ``pending_approvals``（ConversationState.interrupt_state）不同源——
# 单 HITL 走 ``PendingInteraction`` 表（``relay_handler`` 处理
# ask_*_required / single_hitl_resolved 时 upsert / mark_resolved）。


def _serialize_pending_single_hitl_wire(interaction) -> dict[str, Any]:
    """``PendingInteraction`` → wire ``InterruptStatePendingSingleHitl`` 形态。

    字段命名与 ``packages/agent-wire/src/prompt.ts`` 的
    ``InterruptStatePendingSingleHitlSchema`` 严格对齐（snake_case wire）。

    ``payload`` 直接透传原 wire ASK_*_REQUIRED payload（含 request_id /
    questions / fields / etc）——runtime 重挂时用它复原卡片；``result``
    是用户答复（``mark_interaction_resolved`` 写入的原始 wire 形态），
    runtime 用它 inject tool_result。

    ``runtime_mode`` 从 payload 反推：ask-tools ``emitAndWait`` 把
    ``runtime_mode`` 写入 requestPayload 顶层。
    """
    payload = interaction.payload or {}
    result = interaction.result or {}
    runtime_mode = None
    if isinstance(payload, dict):
        candidate = payload.get("runtime_mode")
        if candidate in ("interactive", "solo", "scheduled", "batch"):
            runtime_mode = candidate

    return {
        "kind": interaction.kind,
        "request_key": interaction.request_key,
        "thread_id": interaction.thread_id,
        "status": interaction.status,
        "payload": payload if isinstance(payload, dict) else {},
        "result": result if isinstance(result, dict) else {},
        "expires_at": _datetime_to_ms(interaction.expires_at),
        "created_at": _datetime_to_ms(interaction.created_at),
        "resolved_at": _datetime_to_ms(interaction.resolved_at),
        "runtime_mode": runtime_mode,
    }


def list_pending_single_hitl_for_thread(
    thread_id: str,
    *,
    include_resolved: bool = True,
    max_entries: int = 20,
) -> list[dict[str, Any]]:
    """查询指定 thread 上尚未闭合的单 HITL（用于 crash resume 透传）。

    - ``pending``：runtime 崩前用户未答复；runtime 侧走 InterruptPort.interrupt 重挂。
    - ``resolved`` / ``expired``：runtime 崩前用户已答复但 runtime 未消费；
      runtime 侧走 inject 分支。仅返回近期终态（``resolved_at`` 在
      ``now - RESUME_RESOLVED_LOOKBACK_SECONDS`` 之后），避免把久远历史
      HITL 误当"未消费"重新 inject。

    ``max_entries`` 防御性上限；单 thread 未闭合 HITL 数量通常 <= 3
    （连续 ask 熔断在 4 处触发）。

    容错：DB 异常返回空列表（不阻塞 forward 主路径，与
    ``ConversationStore.peek_interrupt_state`` 同哲学）。
    """
    from apps.services.agent_engine.models import PendingInteraction
    from django.db.models import Q

    normalized_thread = _normalize_thread_id(thread_id)
    if not normalized_thread:
        return []

    db_alias = postgres_app_db_alias()
    now = timezone.now()
    # 与 wire schema 对齐的三种单 HITL 类型；``tool_approval`` /
    # ``browser_action_approval`` 走各自独立恢复路径（tool_approval 用
    # interrupt_state.pending_approvals；browser 尚未接入 crash resume）。
    kinds = list(SINGLE_HITL_INTERACTION_KINDS)

    try:
        qs = (
            PendingInteraction.objects.using(db_alias)
            .filter(
                thread_id=normalized_thread,
                kind__in=kinds,
            )
        )
        if include_resolved:
            # `resolved_at` 近期回窗防止「几天前的旧 hitl」被误重放
            resolved_lookback = timezone.now() - timedelta(
                seconds=RESUME_RESOLVED_LOOKBACK_SECONDS,
            )
            qs = qs.filter(
                Q(status="pending")
                | Q(status__in=("resolved", "expired"), resolved_at__gte=resolved_lookback),
            )
        else:
            qs = qs.filter(status="pending")

        qs = qs.order_by("created_at")[:max_entries]

        rows: list[dict[str, Any]] = []
        for interaction in qs:
            wire = _serialize_pending_single_hitl_wire(interaction)
            # ``pending`` 但已经过期的行：翻成 ``expired``，runtime 走
            # inject 兜底文案（与 ``mark_interaction_resolved`` 迟到扫盘
            # 未覆盖时的一致语义）。
            if (
                wire["status"] == "pending"
                and interaction.expires_at is not None
                and interaction.expires_at < now
            ):
                wire["status"] = "expired"
            rows.append(wire)
        return rows
    except Exception:
        logger.warning(
            "[PendingInteraction] list_pending_single_hitl_for_thread failed: thread=%s",
            thread_id, exc_info=True,
        )
        return []


# resume 时最多回窗多久的 resolved / expired 行（超过则视为「久远历史，
# runtime 已消费或已放弃」）。5 分钟：覆盖典型 daemon 重启窗口（~30s）
# + 用户切网络恢复（~1min）+ 缓冲；久于此的 resolved 若 runtime 真没
# 消费，用户会看到「答复消失」，但比起把几小时前的旧答复重新 inject
# 到当前对话，前者的用户可解释性更好。
RESUME_RESOLVED_LOOKBACK_SECONDS = 5 * 60


def mark_action_approval_resolved(
    *,
    thread_id: str,
    approval_id: str,
    approved: bool,
    scope: str | None = None,
    publish: bool = True,
):
    if not approval_id:
        return None
    return mark_interaction_resolved(
        kind="tool_approval",
        thread_id=thread_id,
        request_key=approval_id,
        status="resolved",
        result={
            "approval_id": approval_id,
            "approved": approved,
            **({"scope": scope} if scope else {}),
        },
        publish=publish,
    )


def _pending_ownership_q(user_id: str):
    """会话属主 OR「我是 team space execution owner」的查询条件。

    execution owner 走 payload JSON 路径（team space 待办量级小，且都会先
    命中 status='pending' 部分索引再做 JSON 过滤）；若未来量级上来，应落
    显式 resolver_user_id 列 + 索引。
    """
    from django.db.models import Q

    return Q(user_id=user_id) | Q(
        payload__team_space_execution__execution_owner_user_id=str(user_id),
    )


def expire_due_interactions_for_user(user_id: str, *, thread_id: str | None = None) -> int:
    """Expire stale pending interactions before serving query results."""
    from apps.services.agent_engine.models import PendingInteraction

    db_alias = postgres_app_db_alias()
    now = timezone.now()
    qs = PendingInteraction.objects.using(db_alias).filter(
        _pending_ownership_q(user_id),
        status="pending",
        expires_at__isnull=False,
        expires_at__lte=now,
    )
    if thread_id:
        qs = qs.filter(thread_id=_normalize_thread_id(thread_id))

    expired = list(qs.only("kind", "thread_id", "request_key")[:200])
    for interaction in expired:
        mark_interaction_resolved(
            kind=interaction.kind,
            thread_id=interaction.thread_id,
            request_key=interaction.request_key,
            status="expired",
            result={"reason": "query_expired", "expired_at": int(time.time() * 1000)},
            publish=True,
        )
    return len(expired)


def list_pending_interactions_for_user(user_id: str, *, organization_id: str | None = None) -> list[dict[str, Any]]:
    from apps.services.agent_engine.models import PendingInteraction

    expire_due_interactions_for_user(user_id)
    db_alias = postgres_app_db_alias()
    qs = PendingInteraction.objects.using(db_alias).filter(
        _pending_ownership_q(user_id),
        status="pending",
    )
    if organization_id:
        qs = qs.filter(organization_id=str(organization_id))
    qs = qs.order_by("created_at")[:100]
    return [serialize_interaction(item, viewer_user_id=user_id) for item in qs]


def list_pending_interactions_for_thread(user_id: str, thread_id: str) -> list[dict[str, Any]]:
    from apps.services.agent_engine.models import PendingInteraction

    normalized_thread_id = _normalize_thread_id(thread_id)
    expire_due_interactions_for_user(user_id, thread_id=normalized_thread_id)
    db_alias = postgres_app_db_alias()
    qs = (
        PendingInteraction.objects.using(db_alias)
        .filter(thread_id=normalized_thread_id, status="pending")
        .order_by("created_at")[:50]
    )
    return [
        serialize_interaction(item, viewer_user_id=user_id)
        for item in qs
        if _interaction_visible_to_user(item, user_id)
    ]


def cancel_pending_interactions_by_thread(
    thread_id: str,
    *,
    reason: str = "runtime_gone",
    publish: bool = True,
) -> int:
    """将 thread 下全部 pending HITL 标为 cancelled（ runtime 销毁）。

    同事务翻转 ``hitl_interaction`` 消息 ``metadata.hitl.status``，让
    HitlMessageReconcile 不再把已无 waiter 的审批卡恢复成可操作面板。
    """
    from apps.services.agent_engine.models import PendingInteraction

    normalized_thread_id = _normalize_thread_id(thread_id)
    if not normalized_thread_id:
        return 0

    cancel_reason = str(reason or "runtime_gone").strip() or "runtime_gone"
    db_alias = postgres_app_db_alias()
    pending = list(
        PendingInteraction.objects.using(db_alias)
        .filter(thread_id=normalized_thread_id, status="pending")
        .only("kind", "thread_id", "request_key")
    )
    cancelled = 0
    for item in pending:
        updated = mark_interaction_resolved(
            kind=item.kind,
            thread_id=item.thread_id,
            request_key=item.request_key,
            status="cancelled",
            result={"reason": cancel_reason},
            publish=publish,
        )
        if updated is not None and updated.status == "cancelled":
            cancelled += 1
    if cancelled:
        logger.info(
            "[PendingInteraction] cancelled %s pending for thread=%s reason=%s",
            cancelled,
            normalized_thread_id,
            cancel_reason,
        )
    return cancelled


def invalidate_single_hitl_interactions_for_timeline_rewrite(
    thread_id: str,
    tool_use_ids: set[str],
) -> int:
    """让被时间线清算移除的单次 HITL 不再进入 crash-resume。

    编辑重发会物理删除回滚边界之后的 assistant ``tool_use``。对应的近期
    ``resolved`` 交互若仍留在恢复窗口，下一轮会注入无法配对的
    ``tool_result``。这里只处理被删除消息中精确命中的 tool_use id；目标边界
    之前的交互和其它 thread 均不受影响。
    """
    from django.db.models import Q

    from apps.services.agent_engine.models import PendingInteraction

    normalized_thread_id = _normalize_thread_id(thread_id)
    normalized_tool_use_ids = {
        tool_use_id.strip()
        for tool_use_id in tool_use_ids
        if isinstance(tool_use_id, str) and tool_use_id.strip()
    }
    if not normalized_thread_id or not normalized_tool_use_ids:
        return 0

    db_alias = postgres_app_db_alias()
    now = timezone.now()
    with transaction.atomic(using=db_alias):
        interactions = list(
            PendingInteraction.objects.using(db_alias)
            .select_for_update()
            .filter(
                thread_id=normalized_thread_id,
                kind__in=SINGLE_HITL_INTERACTION_KINDS,
            )
            .filter(
                Q(payload__tool_use_id__in=normalized_tool_use_ids)
                | Q(request_key__in=normalized_tool_use_ids),
            )
        )
        for interaction in interactions:
            previous_result = interaction.result if isinstance(interaction.result, dict) else {}
            interaction.status = "cancelled"
            interaction.result = {**previous_result, "reason": "timeline_reverted"}
            interaction.resolved_at = interaction.resolved_at or now
            interaction.save(update_fields=["status", "result", "resolved_at", "updated_at"])

    if interactions:
        logger.info(
            "[PendingInteraction] invalidated %s reverted single HITL interactions for thread=%s",
            len(interactions),
            normalized_thread_id,
        )
    return len(interactions)
