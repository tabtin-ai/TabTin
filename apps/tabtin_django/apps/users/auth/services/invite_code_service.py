"""注册邀请码校验与消费服务。"""

from __future__ import annotations

import secrets
import string
from dataclasses import dataclass
from typing import Optional

from django.conf import settings
from django.db import transaction
from django.db.models import F
from django.utils import timezone

from apps.users.auth.models import RegistrationInviteCode, RegistrationInviteRedemption, User
from apps.users.auth.utils import get_client_ip, get_user_agent, hash_string


INVITE_CODE_ERROR_MESSAGES = {
    "INVITE_CODE_REQUIRED": "请输入邀请码",
    "INVITE_CODE_INVALID": "邀请码无效",
    "INVITE_CODE_INACTIVE": "邀请码已停用",
    "INVITE_CODE_NOT_STARTED": "邀请码尚未生效",
    "INVITE_CODE_EXPIRED": "邀请码已过期",
    "INVITE_CODE_USAGE_EXHAUSTED": "邀请码使用次数已用完",
}


class InviteCodeValidationError(ValueError):
    """可安全返回给注册端的邀请码错误。"""

    def __init__(self, code: str):
        super().__init__(INVITE_CODE_ERROR_MESSAGES.get(code, "邀请码无效"))
        self.code = code
        self.message = INVITE_CODE_ERROR_MESSAGES.get(code, "邀请码无效")


@dataclass(frozen=True)
class InviteCodeCheckResult:
    invite: RegistrationInviteCode
    code: str


def is_invite_gate_enabled() -> bool:
    """默认关闭；私有部署可通过配置显式开启。"""
    raw = getattr(settings, "TABTIN_REQUIRE_INVITE_CODE", None)
    if raw is None:
        raw = getattr(settings, "REQUIRE_INVITE_CODE", None)
    if raw is None:
        return False
    return str(raw).strip().lower() not in {"0", "false", "no", "off"}


def normalize_invite_code(code: Optional[str]) -> str:
    return (code or "").strip().replace(" ", "").upper()


def generate_invite_code(length: int = 10) -> str:
    alphabet = string.ascii_uppercase + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(max(6, min(length, 32))))


def _validate_invite_record(invite: RegistrationInviteCode) -> None:
    now = timezone.now()
    if not invite.is_active:
        raise InviteCodeValidationError("INVITE_CODE_INACTIVE")
    if invite.starts_at and invite.starts_at > now:
        raise InviteCodeValidationError("INVITE_CODE_NOT_STARTED")
    if invite.expires_at and invite.expires_at <= now:
        raise InviteCodeValidationError("INVITE_CODE_EXPIRED")
    if invite.usage_limit is not None and invite.used_count >= invite.usage_limit:
        raise InviteCodeValidationError("INVITE_CODE_USAGE_EXHAUSTED")


def validate_for_registration(code: Optional[str]) -> Optional[InviteCodeCheckResult]:
    """校验邀请码。gate 关闭时返回 None。"""
    if not is_invite_gate_enabled():
        return None

    normalized = normalize_invite_code(code)
    if not normalized:
        raise InviteCodeValidationError("INVITE_CODE_REQUIRED")

    try:
        invite = RegistrationInviteCode.objects.get(code=normalized)
    except RegistrationInviteCode.DoesNotExist as exc:
        raise InviteCodeValidationError("INVITE_CODE_INVALID") from exc

    _validate_invite_record(invite)
    return InviteCodeCheckResult(invite=invite, code=normalized)


def precheck_for_registration(code: Optional[str]) -> None:
    validate_for_registration(code)


def consume_after_user_created(
    *,
    code: Optional[str],
    user: User,
    identifier: str,
    request,
    entrypoint: str,
) -> Optional[RegistrationInviteRedemption]:
    """用户创建成功后原子消费邀请码。

    调用方应在 personal organization 等注册后置依赖也成功后再调用，避免
    「用户创建失败但邀请码已消耗」。
    """
    if not is_invite_gate_enabled():
        return None

    normalized = normalize_invite_code(code)
    if not normalized:
        raise InviteCodeValidationError("INVITE_CODE_REQUIRED")

    with transaction.atomic():
        User.objects.select_for_update().get(pk=user.pk)
        existing_redemption = RegistrationInviteRedemption.objects.filter(user=user).first()
        if existing_redemption:
            return existing_redemption

        try:
            invite = RegistrationInviteCode.objects.select_for_update().get(code=normalized)
        except RegistrationInviteCode.DoesNotExist as exc:
            raise InviteCodeValidationError("INVITE_CODE_INVALID") from exc
        # 锁内重跑校验，避免并发把最后一次使用抢走。
        _validate_invite_record(invite)

        redemption, created = RegistrationInviteRedemption.objects.get_or_create(
            invite_code=invite,
            user=user,
            defaults={
                "identifier_hash": hash_string(identifier or ""),
                "entrypoint": entrypoint[:32],
                "ip_address": get_client_ip(request) if request else None,
                "user_agent": get_user_agent(request) if request else "",
            },
        )
        if created:
            RegistrationInviteCode.objects.filter(id=invite.id).update(used_count=F("used_count") + 1)
        return redemption
