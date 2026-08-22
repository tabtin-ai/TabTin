import json
import os
from uuid import UUID

from django.contrib.auth import get_user_model
from django.db.models import F
from django.test import RequestFactory
from django.utils import timezone

from apps.tabdoc.models import Document, DocumentPermission
from apps.tabdoc.services.share_service import invite_collaborators, list_documents_shared_with_me
from apps.tabtinspace.models import Space, SpaceMembership, Organization, OrganizationMember
from apps.users.auth.api._shared import _build_user_info, _create_auth_session
from apps.users.auth.models import RegistrationInviteCode, RegistrationInviteRedemption
from apps.users.auth.services.invite_code_service import is_invite_gate_enabled
from apps.users.auth.utils import hash_string


TEAM_BASE_NAME = "测试团队文件共享-0706"
OWNER_DISPLAY_NAME = "文件共享Owner"
MEMBER_NAMES = ["成员A", "成员B", "成员C"]
VIEWER_MEMBER_NAME = "成员B"
PASSWORD = "FileShareE2E!12345"


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
        code="FILESHAREE2E",
        defaults={
            "description": "File shared visible to member Electron E2E",
            "channel": "electron-e2e",
            "campaign": "file-shared-visible-to-member",
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


def ensure_membership(organization, user, role: str):
    membership, _created = OrganizationMember.objects.get_or_create(
        organization=organization,
        user=user,
        defaults={"role": role},
    )
    if membership.role != role:
        membership.role = role
        membership.save(update_fields=["role"])
    return membership


def ensure_space_membership(space, user, role: str):
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


def ensure_context(run_id: str):
    suffix = run_id[-12:].replace("-", "").replace("_", "")
    marker = f"[{run_id}]"
    owner, owner_created = ensure_user(
        f"file-share-owner-{suffix}@example.com",
        f"file_share_owner_{suffix}",
        OWNER_DISPLAY_NAME,
    )
    invite_redeemed = ensure_invite_redemption(owner)

    organization, organization_created = Organization.objects.get_or_create(
        name=f"{marker} {TEAM_BASE_NAME}",
        owner=owner,
        defaults={
            "description": "Run-scoped team Organization for file sharing visibility E2E.",
            "icon": "📁",
            "type": Organization.OrganizationType.TEAM,
            "is_default": False,
            "settings": {"e2e": True, "scenario": "file.shared-visible-to-member"},
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
    ensure_membership(organization, owner, "owner")

    owner_space, owner_space_created = Space.objects.get_or_create(
        organization=organization,
        name=f"{marker} owner 文件资源空间",
        defaults={
            "type": Space.SpaceType.WORKSPACE,
            "description": "Owner workspace that holds the shared TabDoc resource.",
            "status": "active",
            "is_default": False,
            "visibility": "private",
        },
    )
    if owner_space.type != Space.SpaceType.WORKSPACE:
        owner_space.type = Space.SpaceType.WORKSPACE
        owner_space.save(update_fields=["type", "updated_at"])
    ensure_space_membership(owner_space, owner, "owner")

    team_space, team_space_created = Space.objects.get_or_create(
        organization=organization,
        name=f"{marker} {TEAM_BASE_NAME} Space",
        defaults={
            "type": Space.SpaceType.TEAM_SPACE,
            "description": "Target team Space used by members to open the shared file list.",
            "status": "active",
            "is_default": False,
            "visibility": "shared",
            "execution_space": owner_space,
        },
    )
    changed = False
    if team_space.type != Space.SpaceType.TEAM_SPACE:
        team_space.type = Space.SpaceType.TEAM_SPACE
        changed = True
    if team_space.execution_space_id != owner_space.id:
        team_space.execution_space = owner_space
        changed = True
    if team_space.visibility != "shared":
        team_space.visibility = "shared"
        changed = True
    if changed:
        team_space.save(update_fields=["type", "execution_space", "visibility", "updated_at"])
    ensure_space_membership(team_space, owner, "owner")

    members = []
    for name in MEMBER_NAMES:
        key = name[-1]
        user, created = ensure_user(
            f"file-share-member-{key.lower()}-{suffix}@example.com",
            f"file_share_member_{key.lower()}_{suffix}",
            name,
        )
        ensure_invite_redemption(user)
        ensure_membership(organization, user, "editor")
        ensure_space_membership(team_space, user, "editor")
        members.append(
            {
                "key": key,
                "user": user,
                "created": created,
                "role": "editor",
            }
        )

    return {
        "marker": marker,
        "owner": owner,
        "ownerCreated": owner_created,
        "organization": organization,
        "organizationCreated": organization_created,
        "ownerSpace": owner_space,
        "ownerSpaceCreated": owner_space_created,
        "teamSpace": team_space,
        "teamSpaceCreated": team_space_created,
        "members": members,
        "inviteRedeemed": invite_redeemed,
    }


def build_auth_payload(
    user,
    organization,
    space,
    created_user: bool,
    space_created: bool,
    invite_redeemed: bool,
    role: str,
) -> dict:
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
        [
            "id",
            "name",
            "description",
            "icon",
            "type",
            "owner_id",
            "is_default",
            "created_at",
            "updated_at",
        ],
    )
    organization_payload["settings"] = organization.settings or {}
    space_payload = model_to_dict(
        space,
        [
            "id",
            "organization_id",
            "name",
            "description",
            "icon",
            "type",
            "status",
            "is_default",
            "created_at",
            "updated_at",
        ],
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
        "e2eSpaceCreated": space_created,
        "archivedE2eSpaceCount": 0,
        "inviteRedeemed": invite_redeemed,
    }


def user_summary(user, key: str, role: str, created: bool) -> dict:
    return {
        "key": key,
        "userId": str(user.id),
        "displayName": user.nickname or user.username or user.email,
        "email": user.email,
        "role": role,
        "created": created,
    }


def prepare_case() -> None:
    run_id = require_env("TABTIN_E2E_RUN_ID")
    context = ensure_context(run_id)
    marker = context["marker"]
    owner = context["owner"]
    organization = context["organization"]
    owner_space = context["ownerSpace"]
    team_space = context["teamSpace"]
    viewer = next(item for item in context["members"] if item["user"].nickname == VIEWER_MEMBER_NAME)
    member_user_ids = [str(item["user"].id) for item in context["members"]]

    emit(
        {
            "runId": run_id,
            "marker": marker,
            "teamName": organization.name,
            "organizationId": str(organization.id),
            "targetSpace": {
                "id": str(team_space.id),
                "name": team_space.name,
                "type": team_space.type,
            },
            "ownerSpace": {
                "id": str(owner_space.id),
                "name": owner_space.name,
                "type": owner_space.type,
            },
            "owner": {
                "userId": str(owner.id),
                "displayName": owner.nickname or owner.username or owner.email,
                "email": owner.email,
            },
            "viewerMember": user_summary(viewer["user"], viewer["key"], viewer["role"], viewer["created"]),
            "members": [
                user_summary(item["user"], item["key"], item["role"], item["created"])
                for item in context["members"]
            ],
            "memberUserIds": member_user_ids,
            "source": "electron-e2e-member-shared-file",
        }
    )


def auth_case() -> None:
    user_id = require_env("TABTIN_E2E_AUTH_USER_ID")
    organization_id = require_env("TABTIN_E2E_ORGANIZATION_ID")
    space_id = require_env("TABTIN_E2E_SPACE_ID")
    role = os.environ.get("TABTIN_E2E_ROLE", "editor")
    User = get_user_model()
    user = User.objects.get(id=user_id)
    organization = Organization.objects.get(id=organization_id)
    space = Space.objects.get(id=space_id)
    emit(
        build_auth_payload(
            user,
            organization,
            space,
            created_user=False,
            space_created=False,
            invite_redeemed=ensure_invite_redemption(user),
            role=role,
        )
    )


def share_created_document_case() -> None:
    run_id = require_env("TABTIN_E2E_RUN_ID")
    marker = f"[{run_id}]"
    owner_id = require_env("TABTIN_E2E_OWNER_ID")
    owner_space_id = require_env("TABTIN_E2E_OWNER_SPACE_ID")
    member_user_ids = json.loads(require_env("TABTIN_E2E_MEMBER_USER_IDS"))
    expected_title = require_env("TABTIN_E2E_EXPECTED_TITLE")
    owner = get_user_model().objects.get(id=owner_id)
    document = (
        Document.objects
        .filter(
            owner_id=owner_id,
            space_id=owner_space_id,
            status="active",
            trashed_at__isnull=True,
        )
        .order_by("-created_at")
        .first()
    )
    if document is None:
        raise RuntimeError("No UI-created TabDoc found for file.shared-visible-to-member")
    if document.title != expected_title:
        raise RuntimeError(
            "UI-created TabDoc title was not saved by owner input: "
            f"expected={expected_title!r}, actual={document.title!r}"
        )

    share_result = invite_collaborators(
        document.id,
        [str(item) for item in member_user_ids],
        "viewer",
        owner,
    )
    permission_count = DocumentPermission.objects.filter(
        document=document,
        subject_type="user",
        subject_id__in=[str(item) for item in member_user_ids],
        permission="viewer",
        is_active=True,
    ).count()
    emit(
        {
            "runId": run_id,
            "marker": marker,
            "resource": {
                "resourceType": "doc",
                "documentId": str(document.id),
                "title": document.title,
                "organizationId": str(document.organization_id),
                "spaceId": str(document.space_id),
            },
            "share": {
                "permission": "viewer",
                "notified": share_result.get("notified", 0),
                "skipped": share_result.get("skipped", []),
                "permissionCount": permission_count,
            },
        }
    )


def verify_case() -> None:
    run_id = require_env("TABTIN_E2E_RUN_ID")
    document_id = require_env("TABTIN_E2E_DOCUMENT_ID")
    organization_id = require_env("TABTIN_E2E_ORGANIZATION_ID")
    expected_member_ids = json.loads(require_env("TABTIN_E2E_EXPECTED_MEMBER_IDS"))
    viewer_member_id = require_env("TABTIN_E2E_VIEWER_MEMBER_ID")
    User = get_user_model()
    viewer = User.objects.get(id=viewer_member_id)
    shared_docs = list_documents_shared_with_me(viewer, organization_id=organization_id)
    visible_doc = next((item for item in shared_docs if item.get("document_id") == document_id), None)
    permissions = list(
        DocumentPermission.objects.filter(
            document_id=document_id,
            subject_type="user",
            subject_id__in=[str(item) for item in expected_member_ids],
            permission="viewer",
            is_active=True,
        ).values("subject_id", "permission", "is_active")
    )
    emit(
        {
            "runId": run_id,
            "documentId": document_id,
            "organizationId": organization_id,
            "viewerMemberId": viewer_member_id,
            "sharedWithMeMatched": visible_doc is not None,
            "sharedWithMeItem": visible_doc,
            "expectedMemberIds": expected_member_ids,
            "permissionCount": len(permissions),
            "allMembersHavePermission": len(permissions) == len(expected_member_ids),
            "permissions": permissions,
        }
    )


def main() -> None:
    mode = require_env("TABTIN_E2E_MODE")
    if mode == "prepare":
        prepare_case()
        return
    if mode == "auth":
        auth_case()
        return
    if mode == "share_created":
        share_created_document_case()
        return
    if mode == "verify":
        verify_case()
        return
    raise RuntimeError(f"Unknown TABTIN_E2E_MODE: {mode}")


main()
