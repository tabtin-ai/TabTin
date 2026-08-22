"""外部群使用的联系人关系查询服务。"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone

from apps.services.common.db_router import postgres_app_db_alias
from apps.tabchat.models import ExternalContact, ExternalContactInvitation
from apps.tabchat.services.external_group_errors import ExternalContactNotInvitableError
from apps.tabchat.utils import is_organization_member
from apps.services.oss.services.public_assets import build_public_asset_url
from apps.users.auth.phone import resolve_user_by_phone

logger = logging.getLogger(__name__)


def _notify_external_contact_invitation(invitation_id: str) -> None:
    """由 Django 外部联系人主链路直接创建申请通知。"""
    try:
        invitation = ExternalContactInvitation.objects.select_related(
            "sender_user",
        ).get(id=invitation_id)
        sender = invitation.sender_user
        display_name = sender.nickname or sender.username or "有人"
        from apps.services.notification.services.notification_service import (
            NotificationService,
        )

        NotificationService.notify(
            user_id=str(invitation.recipient_user_id),
            type="organization.invitation.external_contact",
            title="新的外部联系人申请",
            body=f"{display_name}请求添加你为外部联系人",
            organization_id="",
            metadata={
                "invitation_id": str(invitation.id),
                "requester_user_id": str(invitation.sender_user_id),
                "requester_organization_id": str(invitation.sender_organization_id),
                "source_event_id": str(invitation.id),
                "category": "organization",
                "navigate_to": {"type": "settings", "id": "teamMembers"},
            },
        )
    except Exception:
        # 通知是增强通道，不能反推联系人申请失败。
        logger.exception(
            "external contact invitation notification failed: invitation=%s",
            invitation_id,
        )


def _notify_external_contact_rejected(invitation_id: str) -> None:
    """由 Django 外部联系人主链路直接创建拒绝通知。"""
    try:
        invitation = ExternalContactInvitation.objects.get(id=invitation_id)
        from apps.services.notification.services.notification_service import (
            NotificationService,
        )

        NotificationService.notify(
            user_id=str(invitation.sender_user_id),
            type="organization.invitation.external_contact.rejected",
            title="外部联系人申请已被拒绝",
            body="对方拒绝了你的外部联系人申请",
            organization_id="",
            metadata={
                "invitation_id": str(invitation.id),
                "rejecting_user_id": str(invitation.recipient_user_id),
                "source_event_id": str(invitation.id),
                "category": "organization",
                "navigate_to": {"type": "im-contacts", "id": "outgoing"},
            },
        )
    except Exception:
        logger.exception(
            "external contact rejection notification failed: invitation=%s",
            invitation_id,
        )


@dataclass(frozen=True)
class ResolvedExternalContact:
    contact_id: str
    peer_user_id: str
    peer_organization_id: str
    peer_organization_name: str
    display_name: str
    avatar_url: str


class ExternalContactResolver:
    """把客户端 contact id 解析为经过服务端授权的外部用户。"""

    @staticmethod
    def resolve_for_group(
        actor_user_id: str,
        external_contact_ids: list[str],
    ) -> list[ResolvedExternalContact]:
        unique_ids = list(dict.fromkeys(str(contact_id) for contact_id in external_contact_ids))
        if not unique_ids:
            return []

        contacts = list(
            ExternalContact.objects.filter(
                id__in=unique_ids,
                owner_user_id=actor_user_id,
                relationship=ExternalContact.Relationship.FRIEND,
                peer_user__is_active=True,
            ).select_related("peer_user", "peer_organization")
        )
        contacts_by_id = {str(contact.id): contact for contact in contacts}
        if set(contacts_by_id) != set(unique_ids):
            raise ExternalContactNotInvitableError("外部联系人不可邀请")

        resolved: list[ResolvedExternalContact] = []
        for contact_id in unique_ids:
            contact = contacts_by_id[contact_id]
            peer_user_id = str(contact.peer_user_id)
            peer_organization_id = str(contact.peer_organization_id)
            if peer_user_id == str(actor_user_id) or not is_organization_member(
                peer_organization_id,
                peer_user_id,
            ):
                raise ExternalContactNotInvitableError("外部联系人不可邀请")
            peer_user = contact.peer_user
            resolved.append(
                ResolvedExternalContact(
                    contact_id=contact_id,
                    peer_user_id=peer_user_id,
                    peer_organization_id=peer_organization_id,
                    peer_organization_name=contact.peer_organization.name,
                    display_name=(
                        peer_user.nickname
                        or peer_user.username
                        or peer_user_id[:8]
                    ),
                    avatar_url=build_public_asset_url(peer_user.avatar or ""),
                ),
            )
        return resolved

    @staticmethod
    def list_for_user(owner_user_id: str, organization_id: str) -> list[dict[str, object]]:
        contacts = (
            ExternalContact.objects.filter(
                owner_user_id=owner_user_id,
                peer_user__is_active=True,
            )
            .select_related("peer_user", "peer_organization")
            .order_by("-updated_at", "id")
        )
        items: list[dict[str, object]] = []
        for contact in contacts:
            peer_user = contact.peer_user
            peer_user_id = str(contact.peer_user_id)
            if not is_organization_member(
                str(contact.peer_organization_id),
                peer_user_id,
            ):
                continue
            items.append(ExternalContactService.serialize_contact(contact, organization_id))
        return items


class ExternalContactService:
    """外部联系人申请与关系控制面；会话模块只消费其 FRIEND 投影。"""

    @staticmethod
    def serialize_contact(contact: ExternalContact, organization_id: str) -> dict[str, object]:
        peer_user = contact.peer_user
        peer_user_id = str(contact.peer_user_id)
        return {
            "contact_id": str(contact.id),
            "organization_id": str(organization_id),
            "peer_organization_id": str(contact.peer_organization_id),
            "peer_user_id": peer_user_id,
            "display_name": peer_user.nickname or peer_user.username or peer_user_id[:8],
            "avatar_url": build_public_asset_url(peer_user.avatar or ""),
            "relationship": contact.relationship,
            "suspended_reason": contact.suspended_reason or None,
            "is_restorable": contact.relationship == ExternalContact.Relationship.REMOVED,
            "updated_at": contact.updated_at.isoformat(),
            "peer_organization_name": contact.peer_organization.name,
        }

    @staticmethod
    def _expire_pending() -> None:
        now = timezone.now()
        ExternalContactInvitation.objects.filter(
            status=ExternalContactInvitation.Status.PENDING,
            expires_at__lte=now,
        ).update(
            status=ExternalContactInvitation.Status.EXPIRED,
            resolved_at=now,
            updated_at=now,
        )

    @staticmethod
    def _serialize_invitation(
        invitation: ExternalContactInvitation,
        viewer_user_id: str,
    ) -> dict[str, object]:
        incoming = str(invitation.recipient_user_id) == str(viewer_user_id)
        peer = invitation.sender_user if incoming else invitation.recipient_user
        peer_organization = (
            invitation.sender_organization
            if incoming
            else invitation.recipient_organization
        )
        peer_user_id = str(peer.id)
        return {
            "invitation_id": str(invitation.id),
            "direction": "incoming" if incoming else "outgoing",
            "status": invitation.status,
            "peer_user_id": peer_user_id,
            "peer_organization_id": (
                str(peer_organization.id) if peer_organization else None
            ),
            "display_name": peer.nickname or peer.username or peer_user_id[:8],
            "avatar_url": build_public_asset_url(peer.avatar or ""),
            "created_at": invitation.created_at.isoformat(),
            "expires_at": invitation.expires_at.isoformat(),
            "resolved_at": (
                invitation.resolved_at.isoformat() if invitation.resolved_at else None
            ),
            "note": invitation.note or None,
            "peer_organization_name": peer_organization.name if peer_organization else None,
        }

    @staticmethod
    def discover(
        actor_user_id: str,
        organization_id: str,
        phone: str,
    ) -> dict[str, object]:
        target = resolve_user_by_phone(phone, active_only=True)
        if target is None or str(target.id) == str(actor_user_id):
            raise ValueError("account not found")
        if is_organization_member(organization_id, str(target.id)):
            raise ValueError("该用户已是组织成员")
        contact = ExternalContact.objects.filter(
            owner_user_id=actor_user_id,
            peer_user=target,
        ).first()
        ExternalContactService._expire_pending()
        pending = ExternalContactInvitation.objects.filter(
            Q(sender_user_id=actor_user_id, recipient_user=target)
            | Q(sender_user=target, recipient_user_id=actor_user_id),
            status=ExternalContactInvitation.Status.PENDING,
        ).order_by("-created_at").first()
        relationship = (
            contact.relationship
            if contact is not None
            else "pending" if pending is not None else "none"
        )
        target_user_id = str(target.id)
        return {
            "user_id": target_user_id,
            "display_name": target.nickname or target.username or target_user_id[:8],
            "avatar_url": build_public_asset_url(target.avatar or ""),
            "relationship": relationship,
            "external_contact_id": str(contact.id) if contact else None,
            "pending_invitation_id": str(pending.id) if pending else None,
        }

    @staticmethod
    def invite(
        actor_user_id: str,
        organization_id: str,
        target_user_id: str,
        note: str = "",
    ) -> dict[str, object]:
        from django.contrib.auth import get_user_model

        User = get_user_model()
        target = User.objects.filter(id=target_user_id, is_active=True).first()
        if target is None or str(target.id) == str(actor_user_id):
            raise ValueError("account not found")
        if is_organization_member(organization_id, str(target.id)):
            raise ValueError("该用户已是组织成员")
        existing_contact = ExternalContact.objects.filter(
            owner_user_id=actor_user_id,
            peer_user=target,
        ).first()
        if existing_contact and existing_contact.relationship in {
            ExternalContact.Relationship.FRIEND,
            ExternalContact.Relationship.BLOCKED,
            ExternalContact.Relationship.SUSPENDED,
        }:
            raise ValueError("外部联系人关系已存在")
        ExternalContactService._expire_pending()
        reverse_pending = ExternalContactInvitation.objects.filter(
            sender_user=target,
            recipient_user_id=actor_user_id,
            status=ExternalContactInvitation.Status.PENDING,
        ).first()
        if reverse_pending is not None:
            raise ValueError("对方已向你发送联系人申请")
        try:
            invitation, created = ExternalContactInvitation.objects.get_or_create(
                sender_user_id=actor_user_id,
                recipient_user=target,
                status=ExternalContactInvitation.Status.PENDING,
                defaults={
                    "sender_organization_id": organization_id,
                    "note": note.strip()[:500],
                },
            )
        except IntegrityError:
            invitation = ExternalContactInvitation.objects.get(
                sender_user_id=actor_user_id,
                recipient_user=target,
                status=ExternalContactInvitation.Status.PENDING,
            )
            created = False
        if created:
            transaction.on_commit(
                lambda invitation_id=str(invitation.id): (
                    _notify_external_contact_invitation(invitation_id)
                ),
                using=postgres_app_db_alias(),
                robust=True,
            )
        return {
            "invitation": ExternalContactService._serialize_invitation(
                invitation,
                actor_user_id,
            ),
            "invitation_id": str(invitation.id),
            "status": invitation.status,
        }

    @staticmethod
    def list_invitations(
        user_id: str,
        *,
        direction: str | None,
        status: str | None,
    ) -> list[dict[str, object]]:
        ExternalContactService._expire_pending()
        if direction == "incoming":
            queryset = ExternalContactInvitation.objects.filter(recipient_user_id=user_id)
        elif direction == "outgoing":
            queryset = ExternalContactInvitation.objects.filter(sender_user_id=user_id)
        else:
            queryset = ExternalContactInvitation.objects.filter(
                Q(sender_user_id=user_id) | Q(recipient_user_id=user_id)
            )
        if status:
            queryset = queryset.filter(status=status)
        queryset = queryset.select_related(
            "sender_user",
            "recipient_user",
            "sender_organization",
            "recipient_organization",
        ).order_by("-created_at", "id")
        return [
            ExternalContactService._serialize_invitation(invitation, user_id)
            for invitation in queryset
        ]

    @staticmethod
    def accept(
        recipient_user_id: str,
        recipient_organization_id: str,
        invitation_id: str,
    ) -> dict[str, object]:
        ExternalContactService._expire_pending()
        now = timezone.now()
        with transaction.atomic():
            invitation = ExternalContactInvitation.objects.select_for_update().select_related(
                "sender_user",
                "sender_organization",
                "recipient_user",
            ).filter(
                id=invitation_id,
                recipient_user_id=recipient_user_id,
            ).first()
            if invitation is None:
                raise ValueError("联系人申请不存在")
            if invitation.status != ExternalContactInvitation.Status.PENDING:
                raise ValueError("联系人申请已处理")
            sender_contact, _ = ExternalContact.objects.update_or_create(
                owner_user=invitation.sender_user,
                peer_user_id=recipient_user_id,
                defaults={
                    "peer_organization_id": recipient_organization_id,
                    "relationship": ExternalContact.Relationship.FRIEND,
                    "suspended_reason": "",
                },
            )
            recipient_contact, _ = ExternalContact.objects.update_or_create(
                owner_user_id=recipient_user_id,
                peer_user=invitation.sender_user,
                defaults={
                    "peer_organization": invitation.sender_organization,
                    "relationship": ExternalContact.Relationship.FRIEND,
                    "suspended_reason": "",
                },
            )
            invitation.status = ExternalContactInvitation.Status.ACCEPTED
            invitation.recipient_organization_id = recipient_organization_id
            invitation.resolved_at = now
            invitation.save(update_fields=[
                "status",
                "recipient_organization",
                "resolved_at",
                "updated_at",
            ])
            ExternalContactInvitation.objects.filter(
                sender_user_id=recipient_user_id,
                recipient_user=invitation.sender_user,
                status=ExternalContactInvitation.Status.PENDING,
            ).update(
                status=ExternalContactInvitation.Status.CANCELLED,
                resolved_at=now,
                updated_at=now,
            )
        recipient_contact = ExternalContact.objects.select_related(
            "peer_user",
            "peer_organization",
        ).get(pk=recipient_contact.pk)
        return ExternalContactService.serialize_contact(
            recipient_contact,
            recipient_organization_id,
        )

    @staticmethod
    def resolve_invitation(
        actor_user_id: str,
        invitation_id: str,
        action: str,
    ) -> dict[str, object]:
        if action not in {"reject", "cancel"}:
            raise ValueError("不支持的申请操作")
        invitation = ExternalContactInvitation.objects.select_related(
            "sender_user",
            "recipient_user",
            "sender_organization",
            "recipient_organization",
        ).filter(id=invitation_id).first()
        if invitation is None:
            raise ValueError("联系人申请不存在")
        if invitation.status != ExternalContactInvitation.Status.PENDING:
            raise ValueError("联系人申请已处理")
        if action == "reject" and str(invitation.recipient_user_id) != str(actor_user_id):
            raise PermissionError("只能拒绝发给自己的申请")
        if action == "cancel" and str(invitation.sender_user_id) != str(actor_user_id):
            raise PermissionError("只能撤销自己发出的申请")
        invitation.status = (
            ExternalContactInvitation.Status.REJECTED
            if action == "reject"
            else ExternalContactInvitation.Status.CANCELLED
        )
        invitation.resolved_at = timezone.now()
        invitation.save(update_fields=["status", "resolved_at", "updated_at"])
        if action == "reject":
            transaction.on_commit(
                lambda resolved_invitation_id=str(invitation.id): (
                    _notify_external_contact_rejected(resolved_invitation_id)
                ),
                using=postgres_app_db_alias(),
                robust=True,
            )
        return ExternalContactService._serialize_invitation(invitation, actor_user_id)

    @staticmethod
    def update_contact(
        actor_user_id: str,
        organization_id: str,
        contact_id: str,
        action: str,
    ) -> dict[str, object]:
        if action not in {"block", "unblock", "remove"}:
            raise ValueError("不支持的联系人操作")
        with transaction.atomic():
            contact = ExternalContact.objects.select_for_update().select_related(
                "peer_user",
                "peer_organization",
            ).filter(id=contact_id, owner_user_id=actor_user_id).first()
            if contact is None:
                raise ValueError("外部联系人不存在")
            reverse = ExternalContact.objects.select_for_update().filter(
                owner_user=contact.peer_user,
                peer_user_id=actor_user_id,
            ).first()
            if action == "block":
                contact.relationship = ExternalContact.Relationship.BLOCKED
                contact.suspended_reason = ""
                if reverse and reverse.relationship != ExternalContact.Relationship.BLOCKED:
                    reverse.relationship = ExternalContact.Relationship.SUSPENDED
                    reverse.suspended_reason = "blocked_by_peer"
            elif action == "unblock":
                if contact.relationship != ExternalContact.Relationship.BLOCKED:
                    raise ValueError("当前联系人未被拉黑")
                contact.relationship = ExternalContact.Relationship.FRIEND
                contact.suspended_reason = ""
                if reverse and reverse.suspended_reason == "blocked_by_peer":
                    reverse.relationship = ExternalContact.Relationship.FRIEND
                    reverse.suspended_reason = ""
            else:
                contact.relationship = ExternalContact.Relationship.REMOVED
                contact.suspended_reason = ""
                if reverse:
                    reverse.relationship = ExternalContact.Relationship.REMOVED
                    reverse.suspended_reason = ""
            contact.save(update_fields=["relationship", "suspended_reason", "updated_at"])
            if reverse:
                reverse.save(update_fields=["relationship", "suspended_reason", "updated_at"])
            if action in {"block", "unblock"}:
                ExternalContactService._update_external_dm_access(
                    actor_user_id=str(actor_user_id),
                    peer_user_id=str(contact.peer_user_id),
                    action=action,
                )
        return ExternalContactService.serialize_contact(contact, organization_id)

    @staticmethod
    def _update_external_dm_access(
        *,
        actor_user_id: str,
        peer_user_id: str,
        action: str,
    ) -> None:
        """拉黑期间暂停操作者自己的外部私聊成员窗口，解黑后从当前水位恢复。"""
        from apps.tabchat.models import (
            Conversation,
            ConversationMember,
            ConversationMembershipWindow,
        )
        from apps.tabchat.constants import ConversationType
        from apps.tabchat.services.conversation_service import (
            _enqueue_personal_conversation_new,
            _serialize_conversation_summary,
        )

        conversation = Conversation.objects.select_for_update().filter(
            is_external=True,
            type=ConversationType.DM,
            dm_hash=Conversation.compute_dm_hash(actor_user_id, peer_user_id),
        ).first()
        if conversation is None:
            return
        member = ConversationMember.objects.select_for_update().filter(
            conversation=conversation,
            user_id=actor_user_id,
        ).first()
        if member is None:
            return

        now = timezone.now()
        if action == "block":
            if member.status != ConversationMember.Status.ACTIVE:
                return
            member.status = ConversationMember.Status.REMOVED
            member.left_at = now
            member.removed_by = "contact_blocked"
            member.save(update_fields=["status", "left_at", "removed_by"])
            for window in member.visibility_windows.filter(visible_until_seq__isnull=True):
                if conversation.latest_message_seq < window.visible_from_seq:
                    window.delete()
                    continue
                window.visible_until_seq = conversation.latest_message_seq
                window.left_at = now
                window.save(update_fields=["visible_until_seq", "left_at"])
        elif action == "unblock":
            if (
                member.status == ConversationMember.Status.ACTIVE
                or member.removed_by != "contact_blocked"
            ):
                return
            member.status = ConversationMember.Status.ACTIVE
            member.left_at = None
            member.removed_by = ""
            member.save(update_fields=["status", "left_at", "removed_by"])
            ConversationMembershipWindow.objects.get_or_create(
                conversation_member=member,
                visible_until_seq__isnull=True,
                defaults={"visible_from_seq": conversation.latest_message_seq + 1},
            )
            _enqueue_personal_conversation_new(
                conversation,
                [actor_user_id],
                _serialize_conversation_summary(
                    conversation,
                    prefs={"pinned": False, "is_muted": False},
                ),
            )
        else:
            return

        conversation.member_count = ConversationMember.objects.filter(
            conversation=conversation,
            status=ConversationMember.Status.ACTIVE,
        ).count()
        conversation.save(update_fields=["member_count", "updated_at"])
