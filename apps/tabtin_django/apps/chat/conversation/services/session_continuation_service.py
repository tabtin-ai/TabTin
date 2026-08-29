from __future__ import annotations

import logging
import uuid
from datetime import datetime
from urllib.parse import quote

from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils import timezone

from ..models import (
    ChatSession,
    SessionContinuation,
    SessionContinuationEvent,
)
from .execution_target import resolve_execution_target
from .im_business_projection_service import (
    PermanentIMBusinessProjectionError,
    refresh_user_business_projection,
    resolve_direct_conversation,
    send_user_business_projection,
)
from .session_continuation_resources import (
    grant_continuation_resources,
    resource_snapshot,
    resource_status as compute_resource_status,
)
from .session_continuation_local_files import (
    ContinuationLocalFileHandoffError,
    ContinuationLocalFileTooLargeError,
    prepare_local_file_handoffs,
    restore_local_file_handoffs,
)
from .session_materializer import materialize_session_from_turns
from .share_fork_turns import collect_share_turns

logger = logging.getLogger(__name__)


class SessionContinuationAccessError(PermissionError):
    pass


class SessionContinuationDeliveryError(RuntimeError):
    def __init__(self, code: str, detail: dict):
        super().__init__("任务续接卡投递未完成，请重试")
        self.code = code
        self.detail = detail


def _canonical_uuid(value, field: str) -> uuid.UUID:
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError, AttributeError) as exc:
        raise ValueError(f"{field} 必须是 UUID") from exc


_BRIEFING_RESOURCE_TYPES = {
    "tabdata": "table",
    "tabdoc": "document",
    "tabfiles": "file",
}


def _briefing_resource_url(resource: dict) -> str | None:
    kind = str(resource.get("kind") or "")
    if kind == "local_file":
        relative_path = str(resource.get("target_relative_path") or "")
        if not relative_path:
            return None
        return f"tabtin://resource/file/{quote(relative_path, safe='')}"
    client_type = _BRIEFING_RESOURCE_TYPES.get(kind)
    resource_id = str(resource.get("id") or "")
    if not client_type or not resource_id:
        return None
    return f"tabtin://resource/{client_type}/{resource_id}"


def _materialization_briefing(continuation: SessionContinuation) -> str:
    lines = ["本任务由任务续接卡创建，内容冻结于卡片发送时。"]
    available = [
        resource
        for resource in continuation.resources_json
        if isinstance(resource, dict) and not resource.get("unavailable")
    ]
    if available:
        lines.extend(["", "可用材料："])
        for resource in available:
            label = resource.get("label") or "关联资源"
            url = _briefing_resource_url(resource)
            lines.append(f"- {label}：{url}" if url else f"- {label}")
    return "\n".join(lines)


def _metadata(continuation: SessionContinuation) -> dict:
    return {
        "card": {
            "type": "session_continuation",
            "schema_version": 1,
            "object_id": str(continuation.id),
            "version": continuation.version,
            "title_snapshot": continuation.title_snapshot or "未命名任务",
            "sender_id": continuation.sender_user_id,
            "recipient_id": continuation.recipient_user_id,
        },
    }


def _detail(continuation: SessionContinuation, viewer_user_id: str) -> dict:
    role = "owner" if continuation.sender_user_id == viewer_user_id else "recipient"
    from apps.tabtinspace.models import OrganizationMember

    eligible = (
        role == "owner"
        or OrganizationMember.objects.filter(
            organization_id=continuation.organization_id,
            user_id=viewer_user_id,
        ).exists()
    )
    return {
        "object_id": str(continuation.id),
        "version": continuation.version,
        "role": role,
        "title_snapshot": continuation.title_snapshot,
        "context_status": continuation.context_status,
        "snapshot_turn_count": continuation.snapshot_turn_count,
        "resource_status": continuation.resource_status,
        "resources": continuation.resources_json,
        "delivery_status": continuation.delivery_status,
        "creation_status": continuation.creation_status,
        "linked_session_id": (
            str(continuation.linked_session_id)
            if continuation.linked_session_id and role == "recipient"
            else None
        ),
        "target_workspace_id": (
            str(continuation.target_workspace_id)
            if continuation.target_workspace_id and role == "recipient"
            else None
        ),
        "organization_id": continuation.organization_id,
        "eligibility": {
            "can_create": eligible
            and role == "recipient"
            and continuation.context_status != "empty",
            "reason": "" if eligible else "membership_invalid",
        },
        "created_at": continuation.created_at.isoformat(),
        "updated_at": continuation.updated_at.isoformat(),
    }


def get_detail(*, continuation_id, viewer_user) -> dict:
    continuation_uuid = _canonical_uuid(continuation_id, "object_id")
    continuation = SessionContinuation.objects.filter(id=continuation_uuid).first()
    viewer_id = str(viewer_user.id)
    if continuation is None or viewer_id not in {
        continuation.sender_user_id,
        continuation.recipient_user_id,
    }:
        raise SessionContinuationAccessError("续接任务不存在或无权查看")
    return _detail(continuation, viewer_id)


def batch_get_details(*, object_ids: list[str], viewer_user) -> list[dict]:
    if not object_ids or len(object_ids) > 100:
        raise ValueError("object_ids 数量必须在 1 到 100 之间")
    items = []
    for object_id in dict.fromkeys(str(value) for value in object_ids):
        try:
            detail = get_detail(
                continuation_id=object_id,
                viewer_user=viewer_user,
            )
            items.append({"object_id": object_id, "ok": True, "detail": detail})
        except (ValueError, SessionContinuationAccessError):
            items.append(
                {
                    "object_id": object_id,
                    "ok": False,
                    "error": "NOT_FOUND_OR_FORBIDDEN",
                }
            )
    return items


def create_and_send(
    *,
    sender_user,
    source_session_id,
    recipient_user_id,
    client_request_id,
    authorization_header: str = "",
    conversation_id_hint: str | None = None,
    include_context: bool = True,
) -> dict:
    request_uuid = _canonical_uuid(client_request_id, "client_request_id")
    source_uuid = _canonical_uuid(source_session_id, "source_session_id")
    source = ChatSession.objects.filter(id=source_uuid).first()
    if source is None or str(source.user_id) != str(sender_user.id):
        raise SessionContinuationAccessError("来源任务不存在或无权查看")
    recipient_id = str(recipient_user_id or "").strip()
    if not recipient_id or recipient_id == str(sender_user.id):
        raise ValueError("接收人无效")
    from apps.tabtinspace.models import OrganizationMember

    if not OrganizationMember.objects.filter(
        organization_id=source.organization_id,
        user_id=recipient_id,
    ).exists():
        raise ValueError("接收人不是该组织成员")
    recipient_user = get_user_model().objects.filter(id=recipient_id).first()
    if recipient_user is None:
        raise ValueError("接收人无效")

    existing = SessionContinuation.objects.filter(
        client_request_id=request_uuid
    ).first()
    if existing is not None:
        if (
            existing.sender_user_id != str(sender_user.id)
            or existing.source_session_id != source_uuid
            or existing.recipient_user_id != recipient_id
        ):
            raise ValueError("client_request_id 已用于其他续接任务")
        continuation = existing
        if continuation.delivery_status == "confirmed":
            return _detail(continuation, str(sender_user.id))
    else:
        turns, truncated = collect_share_turns(source)
        if include_context:
            resources, resource_status = resource_snapshot(
                source,
                sender_user,
                recipient_user,
            )
        else:
            resources, resource_status = [], "none"
        frozen_turns = [
            {
                **turn,
                "created_at": (
                    turn["created_at"].isoformat() if turn.get("created_at") else None
                ),
            }
            for turn in turns
        ]
        continuation_id = uuid.uuid4()
        frozen_turns, local_resources = prepare_local_file_handoffs(
            continuation_id=str(continuation_id),
            organization_id=str(source.organization_id),
            source_session_id=str(source.id),
            source=source,
            sender_user=sender_user,
            turns=frozen_turns,
            include_context=include_context,
        )
        if local_resources:
            resources = [*resources, *local_resources]
            resource_status = compute_resource_status(resources)
        continuation = SessionContinuation.objects.create(
            id=continuation_id,
            organization_id=str(source.organization_id),
            source_session_id=source.id,
            sender_user_id=str(sender_user.id),
            recipient_user_id=recipient_id,
            title_snapshot=(source.title or "")[:255],
            frozen_context_json=frozen_turns,
            snapshot_turn_count=len(frozen_turns),
            context_status=(
                "empty"
                if not frozen_turns
                else "truncated" if truncated else "complete"
            ),
            resources_json=resources,
            resource_status=resource_status,
            client_request_id=request_uuid,
            card_message_ref=request_uuid,
        )
        SessionContinuationEvent.objects.create(
            continuation=continuation,
            actor_user_id=str(sender_user.id),
            event_type="created",
        )

    try:
        conversation_id = resolve_direct_conversation(
            organization_id=continuation.organization_id,
            other_user_id=continuation.recipient_user_id,
            authorization_header=authorization_header,
            conversation_id_hint=conversation_id_hint,
            actor_user_id=str(sender_user.id),
        )
        receipt = send_user_business_projection(
            organization_id=continuation.organization_id,
            conversation_id=conversation_id,
            message_ref=str(continuation.card_message_ref),
            client_request_id=str(continuation.client_request_id),
            user_id=str(sender_user.id),
            content=f"[任务续接] {continuation.title_snapshot or '未命名任务'}",
            message_type=1,
            metadata=_metadata(continuation),
        )
    except PermanentIMBusinessProjectionError as exc:
        _set_delivery_status(continuation, "rejected")
        raise SessionContinuationDeliveryError(
            "IM_DELIVERY_REJECTED",
            _detail(continuation, str(sender_user.id)),
        ) from exc
    except Exception as exc:
        _set_delivery_status(continuation, "unconfirmed")
        raise SessionContinuationDeliveryError(
            "IM_DELIVERY_UNCONFIRMED",
            _detail(continuation, str(sender_user.id)),
        ) from exc

    with transaction.atomic():
        continuation = SessionContinuation.objects.select_for_update().get(
            id=continuation.id,
        )
        continuation.card_conversation_id = conversation_id
        continuation.card_message_sequence = (
            int(
                receipt.get("seq") or receipt.get("id") or 0,
            )
            or None
        )
        continuation.delivery_status = "confirmed"
        continuation.delivered_at = timezone.now()
        continuation.version += 1
        continuation.save(
            update_fields=[
                "card_conversation_id",
                "card_message_sequence",
                "delivery_status",
                "delivered_at",
                "version",
                "updated_at",
            ]
        )
        SessionContinuationEvent.objects.create(
            continuation=continuation,
            actor_user_id=str(sender_user.id),
            event_type="delivery_confirmed",
        )
    return _detail(continuation, str(sender_user.id))


def _set_delivery_status(continuation: SessionContinuation, status: str) -> None:
    with transaction.atomic():
        continuation = SessionContinuation.objects.select_for_update().get(
            id=continuation.id,
        )
        continuation.delivery_status = status
        continuation.version += 1
        continuation.save(
            update_fields=["delivery_status", "version", "updated_at"],
        )
        SessionContinuationEvent.objects.create(
            continuation=continuation,
            event_type=f"delivery_{status}",
        )


def _refresh_card(continuation: SessionContinuation) -> None:
    refresh_user_business_projection(
        organization_id=continuation.organization_id,
        message_ref=str(continuation.card_message_ref),
        business_projection_revision=str(uuid.uuid4()),
        content=f"[任务续接] {continuation.title_snapshot or '未命名任务'}",
        message_type=1,
        metadata=_metadata(continuation),
    )


def create_task(
    *,
    continuation_id,
    recipient_user,
    agent_id,
    workspace_id,
    client_request_id,
) -> dict:
    continuation_uuid = _canonical_uuid(continuation_id, "object_id")
    request_uuid = _canonical_uuid(client_request_id, "client_request_id")
    try:
        with transaction.atomic():
            continuation = (
                SessionContinuation.objects.select_for_update()
                .filter(
                    id=continuation_uuid,
                )
                .first()
            )
            if continuation is None or continuation.recipient_user_id != str(
                recipient_user.id
            ):
                raise SessionContinuationAccessError("续接任务不存在或无权查看")
            from apps.tabtinspace.models import OrganizationMember

            if not OrganizationMember.objects.filter(
                organization_id=continuation.organization_id,
                user_id=recipient_user.id,
            ).exists():
                raise SessionContinuationAccessError("续接资格已失效")
            if continuation.context_status == "empty":
                raise ValueError("续接任务没有可创建的上下文")
            if continuation.creation_status == "created":
                if (
                    continuation.materialize_request_id == request_uuid
                    and str(continuation.target_agent_id) == str(agent_id)
                    and str(continuation.target_workspace_id) == str(workspace_id)
                ):
                    return _detail(continuation, str(recipient_user.id))
                raise ValueError("该续接卡已经创建过任务")

            agent, workspace = resolve_execution_target(
                user=recipient_user,
                agent_id=agent_id,
                workspace_id=workspace_id,
                organization_id=continuation.organization_id,
            )
            turns = [
                {
                    **turn,
                    "created_at": (
                        datetime.fromisoformat(turn["created_at"])
                        if turn.get("created_at")
                        else None
                    ),
                }
                for turn in continuation.frozen_context_json
            ]
            sender_user = get_user_model().objects.filter(
                id=continuation.sender_user_id,
            ).first()
            if sender_user is not None:
                resources, resource_status = grant_continuation_resources(
                    continuation.resources_json,
                    sender_user=sender_user,
                    recipient_user=recipient_user,
                )
                continuation.resources_json = resources
                continuation.resource_status = resource_status
            turns, resources = restore_local_file_handoffs(
                continuation=continuation,
                recipient_user=recipient_user,
                workspace=workspace,
                turns=turns,
            )
            continuation.resources_json = resources
            continuation.resource_status = compute_resource_status(resources)
            new_session = materialize_session_from_turns(
                user=recipient_user,
                organization_id=continuation.organization_id,
                agent=agent,
                workspace=workspace,
                title=f"{continuation.title_snapshot or '未命名任务'}（续接）",
                turns=turns,
                briefing_text=_materialization_briefing(continuation),
                contract_payload={
                    "type": "session-continuation",
                    "continuation_id": str(continuation.id),
                    "source_session_id": str(continuation.source_session_id),
                    "snapshot_turn_count": continuation.snapshot_turn_count,
                    "context_status": continuation.context_status,
                },
                source_meta={
                    "source_type": "session_continuation",
                    "source_id": str(continuation.id),
                },
            )
            continuation.creation_status = "created"
            continuation.materialize_request_id = request_uuid
            continuation.target_agent_id = agent.id
            continuation.target_workspace_id = workspace.id
            continuation.linked_session_id = new_session.id
            continuation.materialized_at = timezone.now()
            continuation.last_error_code = ""
            continuation.version += 1
            continuation.save(
                update_fields=[
                    "creation_status",
                    "resources_json",
                    "resource_status",
                    "materialize_request_id",
                    "target_agent_id",
                    "target_workspace_id",
                    "linked_session_id",
                    "materialized_at",
                    "last_error_code",
                    "version",
                    "updated_at",
                ]
            )
            SessionContinuationEvent.objects.create(
                continuation=continuation,
                actor_user_id=str(recipient_user.id),
                event_type="task_created",
                payload_json={"linked_session_id": str(new_session.id)},
            )
        try:
            _refresh_card(continuation)
        except Exception:
            logger.exception(
                "[session-continuation] card refresh failed continuation=%s",
                continuation.id,
            )
        return _detail(continuation, str(recipient_user.id))
    except (SessionContinuationAccessError, ValueError, ContinuationLocalFileHandoffError):
        raise
    except Exception:
        failed = None
        with transaction.atomic():
            failed = SessionContinuation.objects.select_for_update().filter(
                id=continuation_uuid,
            ).first()
            if failed is not None:
                failed.creation_status = "failed"
                failed.last_error_code = "MATERIALIZE_FAILED"
                failed.version += 1
                failed.save(
                    update_fields=[
                        "creation_status",
                        "last_error_code",
                        "version",
                        "updated_at",
                    ],
                )
                SessionContinuationEvent.objects.create(
                    continuation=failed,
                    actor_user_id=str(recipient_user.id),
                    event_type="task_create_failed",
                    payload_json={"error_code": "MATERIALIZE_FAILED"},
                )
        if failed is not None:
            try:
                _refresh_card(failed)
            except Exception:
                logger.exception(
                    "[session-continuation] failed-state card refresh failed continuation=%s",
                    failed.id,
                )
        raise
