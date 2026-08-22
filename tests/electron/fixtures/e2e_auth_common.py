from uuid import UUID

from django.contrib.auth import get_user_model
from django.db.models import F
from django.test import RequestFactory
from django.utils import timezone

from apps.users.auth.api._shared import _build_user_info, _create_auth_session
from apps.users.auth.models import RegistrationInviteCode, RegistrationInviteRedemption
from apps.users.auth.services.invite_code_service import is_invite_gate_enabled
from apps.users.auth.utils import hash_string


DEFAULT_E2E_INVITE_CODE = "ELECTRONE2E"
DEFAULT_E2E_PASSWORD = "ElectronE2E!12345"


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


def ensure_e2e_user(
    *,
    email: str,
    username: str,
    nickname: str,
    password: str = DEFAULT_E2E_PASSWORD,
):
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
        user.set_password(password)
        changed = True
    if changed:
        user.save()
    return user, created


def ensure_e2e_invite_redemption(user) -> bool:
    if not is_invite_gate_enabled():
        return False
    invite_code, _ = RegistrationInviteCode.objects.get_or_create(
        code=DEFAULT_E2E_INVITE_CODE,
        defaults={
            "description": "Shared Electron E2E invite code",
            "channel": "electron-e2e",
            "campaign": "electron-e2e",
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


def build_electron_auth_payload(
    *,
    user,
    organization,
    space,
    role: str = "owner",
    created_user: bool = False,
    space_created: bool = False,
    archived_e2e_space_count: int = 0,
    invite_redeemed: bool | None = None,
) -> dict:
    resolved_invite_redeemed = (
        ensure_e2e_invite_redemption(user) if invite_redeemed is None else invite_redeemed
    )
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
        "archivedE2eSpaceCount": archived_e2e_space_count,
        "inviteRedeemed": resolved_invite_redeemed,
    }
