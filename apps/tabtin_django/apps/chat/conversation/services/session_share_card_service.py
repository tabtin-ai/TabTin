"""任务共享卡的 IM 编排。

SessionShare 是授权事实；卡片消息是展示投影。
走 Django IM 私聊 + Centrifugo。
"""

from __future__ import annotations

import logging
import uuid

from django.contrib.auth import get_user_model
from django.db import IntegrityError, models, transaction
from django.utils import timezone

from apps.services.common.db_router import postgres_app_db_alias
from . import session_share_service
from .im_business_projection_service import PermanentIMBusinessProjectionError
from .share_fork_turns import _share_visible_queryset
from .session_share_resource_permission_service import (
    _load_shareable_resource,
    revoke_session_share_resource_grants,
    supersede_prior_session_share_resource_grants,
    sync_session_share_resource_grants,
)

logger = logging.getLogger(__name__)


class SessionShareResourceRevokeError(RuntimeError):
    pass


class SessionShareDeliveryUnconfirmed(RuntimeError):
    def __init__(self, *, result: dict, client_request_id: str):
        super().__init__("共享待确认，消息发送状态未确认，请重试")
        self.result = {**result, "client_request_id": client_request_id}


class SessionShareDeliveryRejected(RuntimeError):
    def __init__(self, *, result: dict, client_request_id: str):
        super().__init__("共享未生效，消息发送失败，请联系管理员")
        self.result = {**result, "client_request_id": client_request_id}


class SessionShareRefreshUnconfirmed(RuntimeError):
    def __init__(self, *, result: dict):
        super().__init__("共享已停止，卡片状态同步未确认，请重试")
        self.result = result


def _canonical_uuid(value: str | None) -> str:
    raw = str(value or "").strip() or str(uuid.uuid4())
    try:
        canonical = str(uuid.UUID(raw))
    except (ValueError, TypeError, AttributeError) as exc:
        raise ValueError("client_request_id 必须是规范 UUID") from exc
    if canonical != raw.lower():
        raise ValueError("client_request_id 必须是规范 UUID")
    return canonical


def _refreshable_message_ref(share) -> str | None:
    """返回可编辑的 UUID 消息锚点；旧数字锚点不可用于当前链路。"""
    raw = str(share.card_message_ref or "").strip()
    if not raw or not share.card_conversation_id:
        return None
    try:
        canonical = str(uuid.UUID(raw))
    except (ValueError, TypeError, AttributeError):
        return None
    return canonical if canonical == raw.lower() else None


def _card_metadata(share) -> dict:
    if getattr(share, "card_contract", "session_share") == "session_share_v2":
        return {
            "card": {
                "type": "session_share_v2",
                "schema_version": int(share.card_schema_version),
                "object_id": str(share.id),
                "version": int(share.version),
                "title_snapshot": (share.session.title or "").strip() or "未命名任务",
                "sender_id": str(share.owner_user_id),
                "recipient_id": str(share.grantee_user_id),
            },
        }
    snapshot = session_share_service.serialize_share(share)
    return {
        "card": {
            "type": "session_share",
            "share_id": snapshot["id"],
            "session_id": snapshot["session_id"],
            "session_title": snapshot["session_title"],
            "owner_user_id": snapshot["owner_user_id"],
            "grantee_user_id": snapshot["grantee_user_id"],
            "can_fork": snapshot["can_fork"],
            "can_chat": snapshot["can_chat"],
            "status": snapshot["status"],
        },
    }


def _card_content(share) -> str:
    title = (share.session.title or "").strip() or "未命名任务"
    return f"[共享任务] {title}"


def _result(share) -> dict:
    return {
        **session_share_service.serialize_share(share),
        "conversation_id": str(share.card_conversation_id or ""),
        "message_id": share.card_message_id,
        "message_ref": str(share.card_message_ref or ""),
    }


def _same_share_intent(
    share,
    *,
    actor_user,
    session_id: str,
    grantee_user_id: str,
    can_fork: bool,
    can_chat: bool,
    card_contract: str,
) -> bool:
    return (
        share.owner_user_id == str(actor_user.id)
        and str(share.session_id) == str(session_id)
        and share.grantee_user_id == str(grantee_user_id)
        and share.can_fork == bool(can_fork)
        and share.can_chat == bool(can_chat)
        and getattr(share, "card_contract", "session_share") == card_contract
    )


def _finalize_delivered_share(*, share, actor_user, conversation_id, message_ref, sequence):
    """发卡确认后回填锚点；v2 等接收方加入后再授予访问权。"""
    with transaction.atomic(using=postgres_app_db_alias()):
        if getattr(share, "card_contract", "session_share") == "session_share_v2":
            share = session_share_service.confirm_share_delivery(
                share=share,
                conversation_id=conversation_id,
                message_ref=message_ref,
                message_sequence=sequence or None,
            )
        else:
            share = session_share_service.activate_share(
                share=share,
                actor_user=actor_user,
            )
            session_share_service.attach_card_anchor(
                share,
                conversation_id,
                message_ref,
                sequence or None,
            )
        if getattr(share, "card_contract", "session_share") != "session_share_v2":
            supersede_prior_session_share_resource_grants(share=share)
            sync_session_share_resource_grants(share=share, owner_user=actor_user)
    if getattr(share, "card_contract", "session_share") != "session_share_v2":
        from .session_collaboration_events import invalidate_runtime_topics

        invalidate_runtime_topics(
            str(share.session.thread_id or f"chat-session-{share.session_id}"),
        )
    _ensure_workspace_file_refs(share)
    return share


def _activate_restored_share_without_card(*, share, actor_user):
    """恢复没有可编辑消息锚点的旧共享，但绝不补发第二张卡。"""
    with transaction.atomic(using=postgres_app_db_alias()):
        share = session_share_service.activate_share(share=share, actor_user=actor_user)
        sync_session_share_resource_grants(share=share, owner_user=actor_user)
    _ensure_workspace_file_refs(share)
    return share


def _load_or_create_pending_share(
    *,
    actor_user,
    session_id,
    grantee_user_id,
    can_fork,
    can_chat,
    card_contract,
    message_ref,
):
    from ..models import SessionShare

    existing = SessionShare.objects.select_related("session").filter(
        card_message_ref=message_ref,
    ).first()
    if existing is None:
        try:
            with transaction.atomic():
                existing = session_share_service.create_or_update_share(
                    session_id=session_id,
                    owner_user=actor_user,
                    grantee_user_id=grantee_user_id,
                    can_fork=can_fork,
                    can_chat=can_chat,
                    card_contract=card_contract,
                    status="pending",
                )
                existing.card_message_ref = message_ref
                existing.save(update_fields=["card_message_ref"])
        except IntegrityError:
            existing = SessionShare.objects.select_related("session").get(
                card_message_ref=message_ref,
            )
    if not _same_share_intent(
        existing,
        actor_user=actor_user,
        session_id=session_id,
        grantee_user_id=grantee_user_id,
        can_fork=can_fork,
        can_chat=can_chat,
        card_contract=card_contract,
    ):
        raise ValueError("client_request_id 已用于其他共享消息")
    return existing


def _refresh_pending_card(share) -> None:
    _refresh_django_share_card(share)


def _resolve_django_direct_conversation(
    *,
    organization_id: str,
    actor_user_id: str,
    other_user_id: str,
    conversation_id_hint: str | None = None,
) -> str:
    from apps.tabchat.services.conversation_service import ConversationService

    hint = str(conversation_id_hint or "").strip()
    if hint:
        try:
            hint = str(uuid.UUID(hint))
        except (ValueError, TypeError, AttributeError):
            hint = ""
    conversation = ConversationService.resolve_or_create_dm(
        organization_id=str(organization_id),
        requester_id=str(actor_user_id),
        other_user_id=str(other_user_id),
        conversation_id_hint=hint or None,
    )
    return str(conversation.id)


def _send_django_share_card(
    *,
    conversation_id: str,
    actor_user_id: str,
    message_ref: str,
    content: str,
    metadata: dict,
) -> dict:
    from apps.tabchat.constants import MessageType
    from apps.tabchat.services.message_service import MessageService

    message = MessageService.send_message(
        conversation_id=str(conversation_id),
        sender_id=str(actor_user_id),
        content=content,
        message_type=MessageType.TEXT,
        metadata={**metadata, "message_ref": message_ref},
        client_request_id=message_ref,
    )
    return {
        "id": message.id,
        "seq": message.seq,
        "conversation_id": str(message.conversation_id),
    }


def _refresh_django_share_card(share) -> None:
    from apps.tabchat.constants import IMEventType
    from apps.tabchat.models import Conversation, Message
    from apps.tabchat.services.im_outbox_service import IMOutboxService

    conversation_id = str(share.card_conversation_id or "").strip()
    if not conversation_id:
        return
    try:
        conversation_id = str(uuid.UUID(conversation_id))
    except (ValueError, TypeError, AttributeError):
        return
    conversation = Conversation.objects.filter(pk=conversation_id).first()
    if conversation is None:
        return
    message_ref = _refreshable_message_ref(share)
    message = None
    if message_ref:
        message = Message.objects.filter(
            conversation_id=conversation_id,
            client_request_id=message_ref,
        ).first()
        if message is not None:
            metadata = {
                **(message.metadata or {}),
                **_card_metadata(share),
                "message_ref": message_ref,
            }
            message.metadata = metadata
            message.save(update_fields=["metadata"])
    IMOutboxService.enqueue(
        organization_id=str(share.organization_id),
        event_type=IMEventType.SESSION_SHARE_UPDATE,
        target_channels=[f"chat:{conversation_id}"],
        data={
            "share_id": str(share.id),
            "conversation_id": conversation_id,
            "status": share.status,
            "message_id": share.card_message_id,
        },
        conversation=conversation,
        message=message,
    )


def share_and_send_card(
    *,
    actor_user,
    session_id: str,
    grantee_user_id: str,
    can_fork: bool = False,
    can_chat: bool = False,
    card_contract: str = "session_share",
    authorization_header: str = "",
    conversation_id_hint: str | None = None,
    client_request_id: str | None = None,
    restore_share_id: str | None = None,
) -> dict:
    """owner 共享会话并发任务卡。

    新建路径：先落 ``pending``（不授 ACL）→ 发 IM → 确认后 ``activate``。
    同 ``client_request_id`` 重试复用同一行，避免失败重试叠出多条授权。
    """
    if restore_share_id:
        share = session_share_service.get_share_for_user(
            share_id=restore_share_id,
            user=actor_user,
        )
        if not _same_share_intent(
            share,
            actor_user=actor_user,
            session_id=session_id,
            grantee_user_id=grantee_user_id,
            can_fork=share.can_fork,
            can_chat=share.can_chat,
            card_contract=getattr(share, "card_contract", "session_share"),
        ):
            raise session_share_service.SessionShareAccessError(
                "共享不存在或无权查看",
            )
        share = session_share_service.restore_share(
            share_id=restore_share_id,
            owner_user=actor_user,
            status="pending",
        )
        message_ref = _refreshable_message_ref(share)
        if message_ref:
            try:
                _refresh_pending_card(share)
            except PermanentIMBusinessProjectionError as exc:
                raise SessionShareDeliveryRejected(
                    result=_result(share),
                    client_request_id=message_ref,
                ) from exc
            except Exception as exc:
                raise SessionShareDeliveryUnconfirmed(
                    result=_result(share),
                    client_request_id=message_ref,
                ) from exc
            conversation_id = str(share.card_conversation_id)
            sequence = share.card_message_id
            share = _finalize_delivered_share(
                share=share,
                actor_user=actor_user,
                conversation_id=conversation_id,
                message_ref=message_ref,
                sequence=sequence,
            )
            try:
                _refresh_card_with_retry_tracking(share)
            except Exception as exc:
                raise SessionShareDeliveryUnconfirmed(
                    result=_result(share),
                    client_request_id=message_ref,
                ) from exc
            _publish_v2_state_changed(share, revoked=False)
            return _result(share)
        # 旧卡可能没有 UUID 锚点，或仍保存旧版 Django IM 的数字锚点。恢复只改变
        # 原授权状态，不能退化为重新发一张任务卡；客户端会从详情接口刷新。
        share = _activate_restored_share_without_card(
            share=share,
            actor_user=actor_user,
        )
        _publish_v2_state_changed(share, revoked=False)
        return _result(share)
    else:
        message_ref = _canonical_uuid(client_request_id)
        share = _load_or_create_pending_share(
            actor_user=actor_user,
            session_id=session_id,
            grantee_user_id=grantee_user_id,
            can_fork=can_fork,
            can_chat=can_chat,
            card_contract=card_contract,
            message_ref=message_ref,
        )
        if share.status == "active" and share.card_conversation_id:
            try:
                _refresh_card_with_retry_tracking(share)
            except Exception as exc:
                raise SessionShareDeliveryUnconfirmed(
                    result=_result(share),
                    client_request_id=message_ref,
                ) from exc
            return _result(share)
        if (
            share.card_contract == "session_share_v2"
            and share.delivery_status == "confirmed"
            and share.card_conversation_id
        ):
            return _result(share)
        if share.status == "revoked":
            raise ValueError("已停止的共享必须通过恢复操作重新发送")

    provisional = {
        **_result(share),
        "message_ref": message_ref,
    }
    delivery_stage = "resolve_dm"
    try:
        conversation_id = _resolve_django_direct_conversation(
            organization_id=str(share.organization_id),
            actor_user_id=str(actor_user.id),
            other_user_id=str(share.grantee_user_id),
            conversation_id_hint=conversation_id_hint,
        )
        provisional["conversation_id"] = conversation_id
        delivery_stage = "send_projection"
        receipt = _send_django_share_card(
            conversation_id=conversation_id,
            actor_user_id=str(actor_user.id),
            message_ref=message_ref,
            content=_card_content(share),
            metadata=_card_metadata(share),
        )
    except PermissionError:
        raise
    except ValueError as exc:
        logger.warning(
            "[session-share] django delivery rejected: "
            "share=%s message_ref=%s stage=%s error_type=%s",
            share.id,
            message_ref,
            delivery_stage,
            type(exc).__name__,
        )
        if card_contract == "session_share_v2":
            share = session_share_service.set_share_delivery_status(share, "rejected")
            provisional.update(_result(share))
        raise SessionShareDeliveryRejected(
            result=provisional,
            client_request_id=message_ref,
        ) from exc
    except PermanentIMBusinessProjectionError as exc:
        if card_contract == "session_share_v2":
            share = session_share_service.set_share_delivery_status(share, "rejected")
            provisional.update(_result(share))
        raise SessionShareDeliveryRejected(
            result=provisional,
            client_request_id=message_ref,
        ) from exc
    except Exception as exc:
        logger.warning(
            "[session-share] delivery remains unconfirmed: "
            "share=%s message_ref=%s stage=%s error_type=%s",
            share.id,
            message_ref,
            delivery_stage,
            type(exc).__name__,
            exc_info=True,
        )
        if card_contract == "session_share_v2":
            share = session_share_service.set_share_delivery_status(
                share,
                "unconfirmed",
            )
            provisional.update(_result(share))
        raise SessionShareDeliveryUnconfirmed(
            result=provisional,
            client_request_id=message_ref,
        ) from exc

    sequence = int(receipt.get("seq") or receipt.get("id") or 0)
    share = _finalize_delivered_share(
        share=share,
        actor_user=actor_user,
        conversation_id=conversation_id,
        message_ref=message_ref,
        sequence=sequence,
    )
    try:
        _refresh_card_with_retry_tracking(share)
    except Exception as exc:
        if card_contract == "session_share_v2":
            share = session_share_service.set_share_delivery_status(
                share,
                "unconfirmed",
            )
        raise SessionShareDeliveryUnconfirmed(
            result=_result(share),
            client_request_id=message_ref,
        ) from exc
    _publish_v2_state_changed(share, revoked=False)
    return _result(share)


def revoke_and_refresh_card(*, actor_user, share_id: str) -> dict:
    share = session_share_service.get_share_for_user(
        share_id=share_id,
        user=actor_user,
    )
    if share.owner_user_id != str(actor_user.id):
        raise session_share_service.SessionShareAccessError(
            "共享不存在或无权查看",
        )
    try:
        with transaction.atomic():
            share = session_share_service.revoke_share(
                share_id=share_id,
                actor_user=actor_user,
            )
            revoke_session_share_resource_grants(share=share)
    except Exception as exc:
        raise SessionShareResourceRevokeError(
            "回收产出物访问权限失败，请重试停止共享",
        ) from exc
    if getattr(share, "card_contract", "session_share") == "session_share_v2":
        from .session_collaboration_events import send_collaboration_state_changed

        send_collaboration_state_changed(share, revoked=True)
    try:
        _refresh_card_with_retry_tracking(share)
    except Exception as exc:
        raise SessionShareRefreshUnconfirmed(result=_result(share)) from exc
    return _result(share)


def revoke_membership_shares(*, organization_id: str, user_id: str) -> int:
    """成员失去组织资格时，停止其参与的全部共享任务。"""
    from ..models import SessionShare, SessionShareEvent

    with transaction.atomic(using=postgres_app_db_alias()):
        shares = list(
            SessionShare.objects.select_for_update().select_related('session').filter(
                organization_id=str(organization_id),
                status__in=('pending', 'active'),
            ).filter(
                models.Q(owner_user_id=str(user_id))
                | models.Q(grantee_user_id=str(user_id)),
            )
        )
        for share in shares:
            revoke_session_share_resource_grants(share=share)
            share.status = 'revoked'
            share.revoked_at = timezone.now()
            share.save(update_fields=['status', 'revoked_at'])
            SessionShareEvent.objects.create(
                share=share,
                actor_user_id=str(user_id),
                event_type='revoked',
                payload_json={'reason': 'organization_membership_ended'},
            )
            transaction.on_commit(
                lambda share_id=share.id: _refresh_membership_revoked_card(share_id),
                using=postgres_app_db_alias(),
            )
    return len(shares)


def _refresh_membership_revoked_card(share_id) -> None:
    from ..models import SessionShare

    share = SessionShare.objects.select_related('session').filter(id=share_id).first()
    if share is None:
        return
    try:
        _refresh_card_with_retry_tracking(share)
    except Exception:
        logger.exception(
            "[session-share] membership revoke card refresh unconfirmed: share=%s",
            share_id,
        )


def retry_unconfirmed_card_refresh(*, share_id: str) -> bool:
    """重试已提交授权事实但尚未同步成功的 IM 卡片投影。"""
    from ..models import SessionShare

    with transaction.atomic():
        share = SessionShare.objects.select_for_update().select_related("session").filter(
            id=share_id,
            status__in=("active", "revoked"),
            card_refresh_status="unconfirmed",
        ).first()
        if share is None:
            return False
        # 恢复操作会等待此行锁，避免过期 revoked 投影覆盖新的 active 卡片。
        _refresh_card(share)
        _mark_card_refresh_status(share, "confirmed")
    return True


def _mark_card_refresh_status(share, status: str) -> None:
    if getattr(share, "card_refresh_status", "confirmed") == status:
        return
    share.card_refresh_status = status
    share.save(update_fields=["card_refresh_status"])


def _enqueue_card_refresh_retry(share) -> None:
    try:
        from ..tasks import retry_session_share_card_refresh

        retry_session_share_card_refresh.delay(str(share.id))
    except Exception:
        # 持久状态仍由 beat 扫描恢复，broker 短暂不可用不能反转已提交的撤销。
        logger.exception(
            "[session-share] enqueue card refresh retry failed: share=%s",
            share.id,
        )


def _refresh_card_with_retry_tracking(share) -> None:
    try:
        _refresh_card(share)
    except Exception:
        _mark_card_refresh_status(share, "unconfirmed")
        _enqueue_card_refresh_retry(share)
        raise
    _mark_card_refresh_status(share, "confirmed")


def refresh_after_fork(share) -> None:
    """fork 已成功后刷新 v2 原卡；投影失败只进入重试，不反转副本。"""
    if share.card_contract != "session_share_v2":
        return
    try:
        _refresh_card_with_retry_tracking(share)
    except Exception:
        logger.exception(
            "[session-share] forked but card refresh is pending: share=%s",
            share.id,
        )


def restore_and_refresh_card(*, actor_user, share_id: str) -> dict:
    current = session_share_service.get_share_for_user(
        share_id=share_id,
        user=actor_user,
    )
    if current.owner_user_id != str(actor_user.id):
        raise session_share_service.SessionShareAccessError(
            "共享不存在或无权查看",
        )
    if current.status == "pending":
        raise ValueError("投递未完成的共享不能恢复")
    share = session_share_service.restore_share(
        share_id=share_id,
        owner_user=actor_user,
    )
    sync_session_share_resource_grants(share=share, owner_user=actor_user)
    if share.card_contract == "session_share_v2":
        from .session_collaboration_events import send_collaboration_state_changed

        send_collaboration_state_changed(share, revoked=False)
    try:
        _refresh_card_with_retry_tracking(share)
    except Exception as exc:
        raise SessionShareRefreshUnconfirmed(result=_result(share)) from exc
    return get_share_detail(viewer_user=actor_user, share_id=str(share.id))


def accept_and_refresh_card(*, actor_user, share_id: str) -> dict:
    """接收方显式加入 v2 协作；激活授权后再同步资源与卡片。"""
    requested = session_share_service.get_share_for_user(
        share_id=share_id,
        user=actor_user,
    )
    if requested.grantee_user_id != str(actor_user.id):
        raise session_share_service.SessionShareAccessError(
            "共享不存在或无权查看",
        )
    share = requested
    lifecycle = _resolve_lifecycle_share(requested)
    if lifecycle.status == "pending":
        share = lifecycle
    if share.card_contract != "session_share_v2":
        raise ValueError("历史共享卡不支持加入操作")
    if share.delivery_status != "confirmed":
        raise ValueError("邀请尚未送达，暂不能加入")

    from apps.tabtinspace.models import OrganizationMember

    if not OrganizationMember.objects.filter(
        organization_id=share.organization_id,
        user_id=actor_user.id,
    ).exists():
        raise session_share_service.SessionShareAccessError(
            "共享不存在或无权查看",
        )
    owner = get_user_model().objects.filter(id=share.owner_user_id).first()
    if owner is None:
        raise ValueError("任务发起人不存在")

    with transaction.atomic(using=postgres_app_db_alias()):
        share = session_share_service.activate_share(
            share=share,
            actor_user=actor_user,
        )
        supersede_prior_session_share_resource_grants(share=share)
        sync_session_share_resource_grants(share=share, owner_user=owner)

    from .session_collaboration_events import send_collaboration_state_changed

    send_collaboration_state_changed(share, revoked=False)
    try:
        _refresh_card_with_retry_tracking(share)
    except Exception:
        logger.exception(
            "[session-share] joined but card refresh is pending: share=%s",
            share.id,
        )
    return get_share_detail(viewer_user=actor_user, share_id=str(requested.id))


def retry_share_delivery(
    *,
    actor_user,
    share_id: str,
    authorization_header: str = "",
) -> dict:
    share = session_share_service.get_share_for_user(
        share_id=share_id,
        user=actor_user,
    )
    if share.owner_user_id != str(actor_user.id):
        raise session_share_service.SessionShareAccessError(
            "共享不存在或无权查看",
        )
    if share.card_contract != "session_share_v2":
        raise ValueError("历史共享卡不支持此重试接口")
    if share.status == "active":
        if share.delivery_status != "confirmed":
            share = session_share_service.set_share_delivery_status(share, "confirmed")
        try:
            _refresh_card_with_retry_tracking(share)
        except Exception as exc:
            share = session_share_service.set_share_delivery_status(
                share,
                "unconfirmed",
            )
            raise SessionShareDeliveryUnconfirmed(
                result=_result(share),
                client_request_id=str(share.card_message_ref),
            ) from exc
        return get_share_detail(viewer_user=actor_user, share_id=str(share.id))
    return share_and_send_card(
        actor_user=actor_user,
        session_id=str(share.session_id),
        grantee_user_id=share.grantee_user_id,
        can_chat=share.can_chat,
        card_contract=share.card_contract,
        authorization_header=authorization_header,
        conversation_id_hint=share.card_conversation_id or None,
        client_request_id=str(share.card_message_ref),
    )


def _refresh_card(share) -> None:
    _refresh_django_share_card(share)


def _publish_v2_state_changed(share, *, revoked: bool) -> None:
    if getattr(share, "card_contract", "session_share") != "session_share_v2":
        return
    if getattr(share, "session", None) is None:
        return
    from .session_collaboration_events import send_collaboration_state_changed

    send_collaboration_state_changed(share, revoked=revoked)


def _resolve_lifecycle_share(share):
    """同一任务 + 接收人的多张卡：生命周期跟最新授权。

    最新撤销 → 旧卡也停。最新恢复/再邀请为 pending，且当前已没有仍有效的
    落地授权时 → 旧卡跟着变成待确认。关系仍有效时，新 pending 不能把已
    参与的旧卡改成待确认。
    """
    if share.status == "pending":
        return share
    from ..models import SessionShare

    siblings = list(
        SessionShare.objects.select_related("session", "session__workspace")
        .filter(
            session_id=share.session_id,
            grantee_user_id=share.grantee_user_id,
        )
        .order_by("-created_at", "-id")
    )
    if not siblings:
        return share
    latest = siblings[0]
    if latest.status != "pending":
        return latest
    latest_settled = next(
        (row for row in siblings if row.status != "pending"),
        None,
    )
    if latest_settled is not None and latest_settled.status == "active":
        return latest_settled
    return latest


def get_share_detail(*, viewer_user, share_id: str) -> dict:
    share = session_share_service.get_share_for_user(
        share_id=share_id,
        user=viewer_user,
    )
    effective_share = _resolve_lifecycle_share(share)
    users = {
        str(user.id): user
        for user in get_user_model().objects.filter(
            id__in=[share.owner_user_id, share.grantee_user_id],
        )
    }
    owner = users.get(str(share.owner_user_id))
    if effective_share.status == 'active' and owner is not None:
        try:
            sync_session_share_resource_grants(share=effective_share, owner_user=owner)
        except Exception:
            logger.exception(
                "[session-share] detail resource permission reconciliation failed: share=%s",
                effective_share.id,
            )

    def display_name(user_id: str) -> str:
        user = users.get(str(user_id))
        return user.get_display_name() if user else ""

    detail = {
        **_result(share),
        "owner_display_name": display_name(share.owner_user_id),
        "grantee_display_name": display_name(share.grantee_user_id),
    }
    if getattr(share, "card_contract", "session_share") == "session_share_v2":
        effective_detail = _result(effective_share)
        for field in (
            "can_fork",
            "can_chat",
            "status",
            "delivery_status",
            "eligibility_status",
            "ineligibility_reason",
            "revoked_at",
        ):
            detail[field] = effective_detail[field]
        detail["effective_share_id"] = str(effective_share.id)
        detail = _serialize_v2_detail(
            effective_share,
            viewer_user_id=str(viewer_user.id),
            detail=detail,
            object_id=str(share.id),
        )
    return detail


def _serialize_live_detail(share) -> dict:
    """从现有运行投影和消息事实构建卡片快照，不维护第二份运行状态。"""
    from apps.services.agent_engine.models import SessionRunProjection
    from apps.services.agent_engine.services.session_run_state_service import (
        serialize_run_state,
    )

    projection = SessionRunProjection.objects.filter(session_id=share.session_id).first()
    run_state = serialize_run_state(projection)
    duration_ms = None
    if projection and projection.started_at:
        ended_at = projection.ended_at or (
            timezone.now() if projection.status == "running" else projection.state_changed_at
        )
        duration_ms = max(0, int((ended_at - projection.started_at).total_seconds() * 1000))

    step_count = _share_visible_queryset(share.session).filter(
        role="assistant",
        message_kind="llm",
    ).count()
    messages = share.session.messages.filter(role="assistant")
    if projection:
        messages = messages.filter(agent_run_id=projection.current_run_id)
    messages = list(
        messages.only("content_blocks_json").order_by("created_at", "id")
    )

    steps: list[dict] = []
    for message in messages:
        for block in message.content_blocks_json or []:
            if not isinstance(block, dict) or block.get("type") != "tool_use":
                continue
            title = str(block.get("title") or block.get("name") or "执行任务").strip()
            steps.append({
                "id": str(block.get("id") or f"step-{len(steps) + 1}"),
                "title": title,
                "status": "done",
            })

    resources = []
    for grant in share.resource_grants.filter(is_active=True).order_by("created_at")[:3]:
        resource = _load_shareable_resource(grant.resource_type, grant.resource_id)
        resources.append({
            "type": grant.resource_type,
            "id": str(grant.resource_id),
            "label": (
                getattr(resource, "name", None)
                or getattr(resource, "title", None)
                or str(grant.resource_id)
            ),
        })

    return {
        "run_state": run_state,
        "duration_ms": duration_ms,
        # 卡片中的“步”按任务累计的 Agent 对话轮次计算；工具明细只展示当前运行。
        "step_count": step_count,
        "current_step": None,
        "recent_steps": steps[-3:],
        "resources": resources,
    }


def batch_get_share_details(*, viewer_user, object_ids: list[str]) -> list[dict]:
    if not object_ids or len(object_ids) > 100:
        raise ValueError("object_ids 数量必须在 1 到 100 之间")
    items = []
    for object_id in dict.fromkeys(str(value) for value in object_ids):
        try:
            detail = get_share_detail(viewer_user=viewer_user, share_id=object_id)
            items.append({"object_id": object_id, "ok": True, "detail": detail})
        except PermissionError:
            items.append({
                "object_id": object_id,
                "ok": False,
                "error": "NOT_FOUND_OR_FORBIDDEN",
            })
    return items


def _serialize_v2_detail(
    share,
    *,
    viewer_user_id: str,
    detail: dict,
    object_id: str | None = None,
) -> dict:
    from apps.tabtinspace.models import OrganizationMember

    role = "owner" if share.owner_user_id == viewer_user_id else "recipient"
    eligible = share.eligibility_status == "eligible"
    if role == "recipient":
        eligible = eligible and OrganizationMember.objects.filter(
            organization_id=share.organization_id,
            user_id=viewer_user_id,
        ).exists()

    if not eligible:
        phase = "ineligible"
    elif share.delivery_status == "pending":
        phase = "sending"
    elif share.delivery_status in {"unconfirmed", "rejected"}:
        phase = "deliveryUnconfirmed"
    elif share.status == "pending":
        phase = "awaitingJoin"
    elif share.status == "revoked":
        phase = "stopped"
    elif share.can_chat:
        phase = "activeCollaborate"
    else:
        phase = "activeView"

    can_join = (
        role == "recipient"
        and eligible
        and share.status == "pending"
        and share.delivery_status == "confirmed"
    )
    can_open = role == "owner" or (eligible and lifecycle.status == "active")
    shared_session_id = str(share.session_id) if share.session_id else None
    if not can_open:
        detail["session_id"] = None
        detail["forked_session_id"] = None
    else:
        detail["live"] = _serialize_live_detail(share)
    return {
        **detail,
        "shared_session_id": shared_session_id,
        "object_id": object_id or str(share.id),
        "role": role,
        "phase": phase,
        "access_mode": (
            "collaborate" if share.can_chat else "fork" if share.can_fork else "view"
        ),
        "eligibility": {
            "eligible": eligible,
            "reason": "" if eligible else (share.ineligibility_reason or "membership_invalid"),
        },
        "actions": {
            "can_join": can_join,
            "can_open": can_open,
            "can_stop": role == "owner" and share.status == "active",
            "can_restore": role == "owner" and share.status == "revoked" and eligible,
            "can_change_access": role == "owner" and share.status == "active",
        },
    }


def update_access_and_refresh_card(
    *, actor_user, share_id: str, can_chat: bool, can_fork: bool,
) -> dict:
    share = session_share_service.update_share_access(
        share_id=share_id,
        owner_user=actor_user,
        can_chat=can_chat,
        can_fork=can_fork,
    )
    from .session_collaboration_events import invalidate_runtime_topics

    invalidate_runtime_topics(
        str(share.session.thread_id or f"chat-session-{share.session_id}"),
    )
    try:
        _refresh_card(share)
    except Exception as exc:
        raise SessionShareRefreshUnconfirmed(result=_result(share)) from exc
    return get_share_detail(viewer_user=actor_user, share_id=str(share.id))


def list_shares_for_session(*, owner_user, session_id: str) -> list[dict]:
    shares = list(session_share_service.list_shares_for_session(
        session_id=session_id,
        owner_user=owner_user,
    ))
    return _serialize_share_list(shares, viewer_user_id=str(owner_user.id))


def list_shares_with_peer(
    *,
    viewer_user,
    peer_user_id: str,
    organization_id: str | None = None,
) -> list[dict]:
    shares = list(session_share_service.list_shares_between(
        user_id=viewer_user.id,
        peer_user_id=peer_user_id,
        organization_id=organization_id,
    ))
    return _serialize_share_list(shares, viewer_user_id=str(viewer_user.id))


def list_incoming_shares(*, viewer_user, organization_id: str) -> list[dict]:
    from apps.tabtinspace.models import OrganizationMember

    if not OrganizationMember.objects.filter(
        organization_id=organization_id,
        user_id=viewer_user.id,
    ).exists():
        raise session_share_service.SessionShareAccessError(
            "共享不存在或无权查看",
        )
    shares = list(session_share_service.list_latest_incoming_shares(
        user_id=viewer_user.id,
        organization_id=organization_id,
    ))
    return _serialize_share_list(shares, viewer_user_id=str(viewer_user.id))


def _serialize_share_list(shares, *, viewer_user_id: str) -> list[dict]:
    user_ids = {share.owner_user_id for share in shares} | {
        share.grantee_user_id for share in shares
    }
    users = {
        str(user.id): user
        for user in get_user_model().objects.filter(id__in=user_ids)
    }

    def display_name(user_id: str) -> str:
        user = users.get(str(user_id))
        return user.get_display_name() if user else ""

    return [
        {
            **_result(share),
            "owner_display_name": display_name(share.owner_user_id),
            "grantee_display_name": display_name(share.grantee_user_id),
            "direction": (
                "outgoing" if share.owner_user_id == viewer_user_id else "incoming"
            ),
        }
        for share in shares
    ]


def _ensure_workspace_file_refs(share) -> None:
    try:
        from .workspace_file import ensure_workspace_file_refs_indexed

        ensure_workspace_file_refs_indexed(share.session)
    except Exception:
        logger.exception(
            "[SessionShare] workspace file ref backfill failed share=%s",
            share.id,
        )
