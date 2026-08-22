import json
import os
from uuid import UUID

from django.contrib.auth import get_user_model
from django.db.models import F, Q
from django.test import RequestFactory
from django.utils import timezone

from apps.services.notification.models import Notification
from apps.tabdoc.models import Document, DocumentShareComment
from apps.tabdoc.services.document_service import DocumentService
from apps.tabtinspace.models import Space, SpaceMembership, Organization, OrganizationMember
from apps.users.auth.api._shared import _build_user_info, _create_auth_session
from apps.users.auth.models import RegistrationInviteCode, RegistrationInviteRedemption
from apps.users.auth.services.invite_code_service import is_invite_gate_enabled
from apps.users.auth.utils import hash_string


OWNER_DISPLAY_NAME = "TabDoc 评论 Owner"
MENTIONED_DISPLAY_NAME = "评论提醒成员"
PASSWORD = "TabDocCommentMentionE2E!12345"


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required env: {name}")
    return value


def emit(payload: dict) -> None:
    print("@@E2E@@" + json.dumps(payload, ensure_ascii=False, default=str))


def model_to_dict(obj, fields):
    data = {}
    for field in fields:
        value = getattr(obj, field)
        if hasattr(value, "isoformat"):
            value = value.isoformat().replace("+00:00", "Z")
        elif isinstance(value, UUID):
            value = str(value)
        data[field] = value
    return data


def ensure_user(email: str, username: str, nickname: str):
    User = get_user_model()
    user, created = User.objects.get_or_create(
        email=email,
        defaults={
            "username": username,
            "nickname": nickname,
            "is_active": True,
            "is_verified_email": True,
        },
    )
    changed = False
    if user.username != username:
        user.username = username
        changed = True
    if user.nickname != nickname:
        user.nickname = nickname
        changed = True
    if not user.is_active:
        user.is_active = True
        changed = True
    if not getattr(user, "is_verified_email", True):
        user.is_verified_email = True
        changed = True
    if created or not user.has_usable_password():
        user.set_password(PASSWORD)
        changed = True
    if changed:
        user.save()
    return user, created


def ensure_invite_redemption(user) -> bool:
    if not is_invite_gate_enabled():
        return False
    invite_code, _ = RegistrationInviteCode.objects.get_or_create(
        code="TABDOCCOMMENT",
        defaults={
            "description": "TabDoc comment mention member Electron E2E",
            "channel": "electron-e2e",
            "campaign": "tabdoc-comment-mention-member",
            "is_active": True,
        },
    )
    redemption, invite_redeemed = RegistrationInviteRedemption.objects.get_or_create(
        invite_code=invite_code,
        user=user,
        defaults={
            "identifier_hash": hash_string(user.email),
            "entrypoint": "electron-e2e",
            "ip_address": "127.0.0.1",
            "user_agent": "TabTin-Electron-E2E/1.0",
        },
    )
    if invite_redeemed:
        RegistrationInviteCode.objects.filter(id=redemption.invite_code_id).update(
            used_count=F("used_count") + 1
        )
    return invite_redeemed


def ensure_organization_member(organization, user, role: str):
    membership, _created = OrganizationMember.objects.get_or_create(
        organization=organization,
        user=user,
        defaults={"role": role},
    )
    if membership.role != role:
        membership.role = role
        membership.save(update_fields=["role"])
    return membership


def ensure_space_member(space, user, role: str):
    membership, _created = SpaceMembership.objects.get_or_create(
        space=space,
        user=user,
        defaults={"role": role, "is_active": True},
    )
    changed = False
    if membership.role != role:
        membership.role = role
        changed = True
    if not membership.is_active:
        membership.is_active = True
        changed = True
    if changed:
        membership.save(update_fields=["role", "is_active", "updated_at"])
    return membership


def build_auth_payload(user, organization, space, role: str, created_user: bool, invite_redeemed: bool) -> dict:
    request = RequestFactory().post("/api/auth/login")
    request.META["REMOTE_ADDR"] = "127.0.0.1"
    request.META["HTTP_USER_AGENT"] = "TabTin-Electron-E2E/1.0"
    access_token, refresh_token, access_expire_hours = _create_auth_session(
        user,
        request,
        remember_me=False,
    )
    user_info = _build_user_info(user).model_dump(mode="json")
    organization_payload = model_to_dict(
        organization,
        ["id", "name", "description", "icon", "type", "owner_id", "is_default", "created_at", "updated_at"],
    )
    organization_payload["settings"] = organization.settings or {}
    space_payload = model_to_dict(
        space,
        ["id", "organization_id", "name", "description", "icon", "type", "status", "is_default", "created_at", "updated_at"],
    )
    return {
        "accessToken": access_token,
        "refreshToken": refresh_token,
        "expiresAt": int((timezone.now().timestamp() + access_expire_hours * 3600) * 1000),
        "userInfo": user_info,
        "organization": organization_payload,
        "space": space_payload,
        "currentUserRole": role,
        "createdUser": created_user,
        "e2eSpaceCreated": False,
        "archivedE2eSpaceCount": 0,
        "inviteRedeemed": invite_redeemed,
    }


def ensure_context(run_id: str) -> dict:
    suffix = run_id[-12:].replace("-", "").replace("_", "")
    marker = f"[{run_id}]"
    owner, owner_created = ensure_user(
        f"tabdoc-comment-owner-{suffix}@example.com",
        f"tabdoc_comment_owner_{suffix}",
        OWNER_DISPLAY_NAME,
    )
    mentioned, mentioned_created = ensure_user(
        f"tabdoc-comment-mentioned-{suffix}@example.com",
        f"tabdoc_comment_mentioned_{suffix}",
        MENTIONED_DISPLAY_NAME,
    )
    invite_redeemed = ensure_invite_redemption(owner)
    ensure_invite_redemption(mentioned)

    organization, _organization_created = Organization.objects.get_or_create(
        name=f"{marker} TabDoc 评论 @ 团队",
        owner=owner,
        defaults={
            "description": "Run-scoped Organization for TabDoc comment mention E2E.",
            "icon": "💬",
            "type": Organization.OrganizationType.TEAM,
            "is_default": False,
            "settings": {"e2e": True, "scenario": "tabdoc.comment-mention-member"},
        },
    )
    changed = False
    if organization.type != Organization.OrganizationType.TEAM:
        organization.type = Organization.OrganizationType.TEAM
        changed = True
    if organization.owner_id != owner.id:
        organization.owner = owner
        changed = True
    if changed:
        organization.save(update_fields=["type", "owner", "updated_at"])
    ensure_organization_member(organization, owner, "owner")
    ensure_organization_member(organization, mentioned, "editor")

    space, _space_created = Space.objects.get_or_create(
        organization=organization,
        name=f"{marker} TabDoc 评论 @ Space",
        defaults={
            "type": Space.SpaceType.TEAM_SPACE,
            "description": "Run-scoped team Space for TabDoc comment mention E2E.",
            "status": "active",
            "is_default": False,
            "visibility": "shared",
        },
    )
    if space.type != Space.SpaceType.TEAM_SPACE:
        space.type = Space.SpaceType.TEAM_SPACE
        space.save(update_fields=["type", "updated_at"])
    ensure_space_member(space, owner, "owner")
    ensure_space_member(space, mentioned, "editor")

    title = f"{marker} 评论 @ 成员验收文档"
    document = (
        Document.objects
        .filter(
            organization_id=organization.id,
            space_id=space.id,
            owner_id=owner.id,
            title=title,
            status="active",
            trashed_at__isnull=True,
        )
        .order_by("-created_at")
        .first()
    )
    if document is None:
        document = DocumentService(user=owner).create_document(
            organization_id=str(organization.id),
            space_id=str(space.id),
            parent_id=None,
            collection_id=None,
            title=title,
            initial_content_pm_json={},
            initial_content_markdown="# 评论 @ 成员验收\n\n用于验证评论输入框 @ 成员选择和提醒。",
            initial_content_plaintext="评论 @ 成员验收 用于验证评论输入框 @ 成员选择和提醒。",
        )
    if document.status != "active":
        document.status = "active"
        document.save(update_fields=["status", "updated_at"])

    return {
        "runId": run_id,
        "marker": marker,
        "owner": owner,
        "ownerCreated": owner_created,
        "mentioned": mentioned,
        "mentionedCreated": mentioned_created,
        "organization": organization,
        "space": space,
        "document": document,
        "inviteRedeemed": invite_redeemed,
    }


def prepare_case() -> None:
    context = ensure_context(require_env("TABTIN_E2E_RUN_ID"))
    owner = context["owner"]
    mentioned = context["mentioned"]
    organization = context["organization"]
    space = context["space"]
    document = context["document"]
    comment_text = f"{context['marker']} 请 @{MENTIONED_DISPLAY_NAME} 看一下这条评论"
    emit(
        {
            "runId": context["runId"],
            "marker": context["marker"],
            "auth": build_auth_payload(owner, organization, space, "owner", context["ownerCreated"], context["inviteRedeemed"]),
            "owner": {
                "userId": str(owner.id),
                "displayName": owner.nickname or owner.username or owner.email,
                "email": owner.email,
            },
            "mentionedMember": {
                "userId": str(mentioned.id),
                "displayName": mentioned.nickname or mentioned.username or mentioned.email,
                "email": mentioned.email,
                "role": "editor",
                "created": context["mentionedCreated"],
            },
            "organizationId": str(organization.id),
            "space": {
                "id": str(space.id),
                "name": space.name,
                "type": space.type,
            },
            "document": {
                "id": str(document.id),
                "title": document.title,
                "spaceId": str(document.space_id),
                "organizationId": str(document.organization_id),
            },
            "comment": {
                "text": comment_text,
                "expectedMentionText": f"@{MENTIONED_DISPLAY_NAME}",
            },
            "source": "electron-e2e-tabdoc-comment-mention-member",
        }
    )


def verify_case() -> None:
    run_id = require_env("TABTIN_E2E_RUN_ID")
    document_id = require_env("TABTIN_E2E_DOCUMENT_ID")
    mentioned_user_id = require_env("TABTIN_E2E_MENTIONED_USER_ID")
    comment_marker = require_env("TABTIN_E2E_COMMENT_MARKER")
    comment = (
        DocumentShareComment.objects
        .filter(document_id=document_id, body__contains=comment_marker, is_deleted=False)
        .order_by("-created_at")
        .first()
    )
    notification = (
        Notification.objects
        .filter(user_id=mentioned_user_id)
        .filter(
            Q(body__contains=comment_marker)
            | Q(title__contains=comment_marker)
            | Q(metadata__icontains=comment_marker)
            | Q(metadata__resource_id=str(document_id))
            | Q(metadata__document_id=str(document_id))
        )
        .order_by("-created_at")
        .first()
    )
    emit(
        {
            "runId": run_id,
            "documentId": document_id,
            "commentCreated": comment is not None,
            "comment": {
                "id": str(comment.id),
                "body": comment.body,
                "authorId": str(comment.author_id) if comment.author_id else None,
            } if comment else None,
            "notificationCreated": notification is not None,
            "notification": {
                "id": str(notification.id),
                "type": notification.type,
                "title": notification.title,
                "body": notification.body,
                "metadata": notification.metadata,
            } if notification else None,
        }
    )


def main() -> None:
    mode = require_env("TABTIN_E2E_MODE")
    if mode == "prepare":
        prepare_case()
        return
    if mode == "verify":
        verify_case()
        return
    raise RuntimeError(f"Unknown TABTIN_E2E_MODE: {mode}")


main()
