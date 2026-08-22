import json
import os
from uuid import UUID

from django.contrib.auth import get_user_model
from django.db.models import F
from django.test import RequestFactory
from django.utils import timezone

from apps.tabtinspace.models import Space, SpaceMembership
from apps.tabtinspace.services.organization_service import OrganizationService
from apps.users.auth.api._shared import _build_user_info, _create_auth_session
from apps.users.auth.models import RegistrationInviteCode, RegistrationInviteRedemption
from apps.users.auth.services.invite_code_service import is_invite_gate_enabled
from apps.users.auth.utils import hash_string


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


def optional_env(name: str, fallback: str = "") -> str:
    return os.environ.get(name, "").strip() or fallback


def ensure_run_space(user, organization, run_id: str) -> tuple[Space, bool, int]:
    default_space = (
        Space.objects.filter(
            organization=organization,
            type=Space.SpaceType.WORKSPACE,
            status="active",
            is_archived=False,
            trashed_at__isnull=True,
        )
        .order_by("-is_default", "order", "created_at")
        .first()
    )
    if default_space is None:
        default_space = OrganizationService.ensure_default_space_for_member(organization, user)
    if default_space is None:
        raise RuntimeError(f"No workspace Space available for organization {organization.id}")

    archived_count = (
        Space.objects.filter(
            organization=organization,
            type=Space.SpaceType.WORKSPACE,
            status="active",
            is_archived=False,
            trashed_at__isnull=True,
            name__startswith="[e2e-chat] ",
        )
        .exclude(name=f"[e2e-chat] {run_id}")
        .update(is_archived=True, status="archived")
    )

    space, created = Space.objects.get_or_create(
        organization=organization,
        name=f"[e2e-chat] {run_id}",
        defaults={
            "agent": default_space.agent,
            "bound_device": default_space.bound_device,
            "control_device": default_space.control_device,
            "working_dir": default_space.working_dir,
            "normalized_working_dir": default_space.normalized_working_dir,
            "working_dir_type": default_space.working_dir_type,
            "type": Space.SpaceType.WORKSPACE,
            "description": "Run-scoped Space for Electron chat persistence E2E.",
            "icon": default_space.icon or "",
            "status": "active",
            "is_default": False,
            "visibility": "private",
        },
    )
    SpaceMembership.objects.get_or_create(
        space=space,
        user=user,
        defaults={"role": "owner", "is_active": True},
    )
    if space.agent_id:
        SpaceMembership.objects.get_or_create(
            space=space,
            agent=space.agent,
            defaults={"role": "owner", "is_active": True},
        )

    organization.space_count = Space.objects.filter(
        organization=organization,
        type=Space.SpaceType.WORKSPACE,
        status="active",
        is_archived=False,
        trashed_at__isnull=True,
    ).count()
    organization.save(update_fields=["space_count"])

    return space, created, archived_count


def main() -> None:
    User = get_user_model()
    run_id = optional_env("TABTIN_E2E_RUN_ID", "manual")
    email = "electron-chat-e2e@example.com"
    password = "E2eChat!12345"
    user, created = User.objects.get_or_create(
        email=email,
        defaults={
            "username": "electron_chat_e2e",
            "nickname": "Electron Chat E2E",
            "is_active": True,
            "is_verified_email": True,
        },
    )
    if created or not user.has_usable_password():
        user.set_password(password)
    if not user.is_active or not user.is_verified_email:
        user.is_active = True
        user.is_verified_email = True
    user.save()

    invite_redeemed = False
    if is_invite_gate_enabled():
        invite_code, _ = RegistrationInviteCode.objects.get_or_create(
            code="ELECTRONCHAT",
            defaults={
                "description": "Electron chat persistence E2E",
                "channel": "electron-e2e",
                "campaign": "chat-message-persistence",
                "is_active": True,
            },
        )
        redemption, invite_redeemed = RegistrationInviteRedemption.objects.get_or_create(
            invite_code=invite_code,
            user=user,
            defaults={
                "identifier_hash": hash_string(email),
                "entrypoint": "electron-e2e",
                "ip_address": "127.0.0.1",
                "user_agent": "TabTin-Electron-E2E/1.0",
            },
        )
        if invite_redeemed:
            RegistrationInviteCode.objects.filter(id=redemption.invite_code_id).update(
                used_count=F("used_count") + 1
            )

    organization, _ = OrganizationService.ensure_personal_organization(user)
    space, e2e_space_created, archived_e2e_space_count = ensure_run_space(user, organization, run_id)

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

    print(
        "@@E2E@@"
        + json.dumps(
            {
                "accessToken": access_token,
                "refreshToken": refresh_token,
                "expiresAt": int(
                    (timezone.now().timestamp() + access_expire_hours * 3600) * 1000
                ),
                "userInfo": user_info,
                "organization": organization_payload,
                "space": space_payload,
                "createdUser": created,
                "e2eSpaceCreated": e2e_space_created,
                "archivedE2eSpaceCount": archived_e2e_space_count,
                "inviteRedeemed": invite_redeemed,
            },
            ensure_ascii=False,
        )
    )


main()
