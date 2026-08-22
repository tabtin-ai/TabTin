from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Optional

from ninja.errors import HttpError

from apps.users.auth.models import AdminAccount

SUPER_ADMIN_ROLE_CODE = "super_admin"

LAST_SUPER_ADMIN_CANNOT_BE_DISABLED = "LAST_SUPER_ADMIN_CANNOT_BE_DISABLED"
LAST_SUPER_ADMIN_ROLE_CANNOT_BE_REMOVED = "LAST_SUPER_ADMIN_ROLE_CANNOT_BE_REMOVED"
NO_ACTIVE_SUPER_ADMIN_REMAINING = "NO_ACTIVE_SUPER_ADMIN_REMAINING"


@dataclass(frozen=True)
class AdminAccountState:
    status: str
    admin_login_enabled: bool
    role_codes: set[str]
    user_is_active: bool

    @property
    def is_active_super_admin(self) -> bool:
        return (
            self.user_is_active
            and self.status == AdminAccount.STATUS_ACTIVE
            and self.admin_login_enabled
            and SUPER_ADMIN_ROLE_CODE in self.role_codes
        )


def _active_role_codes(account: AdminAccount) -> set[str]:
    return set(
        account.role_assignments.filter(role__is_active=True).values_list("role__code", flat=True)
    )


def _build_state(
    account: AdminAccount,
    *,
    status: Optional[str] = None,
    admin_login_enabled: Optional[bool] = None,
    role_codes: Optional[Iterable[str]] = None,
) -> AdminAccountState:
    if role_codes is None:
        active_roles = _active_role_codes(account)
    else:
        active_roles = {code for code in role_codes if code}
    return AdminAccountState(
        status=status if status is not None else account.status,
        admin_login_enabled=(
            admin_login_enabled
            if admin_login_enabled is not None
            else account.admin_login_enabled
        ),
        role_codes=active_roles,
        user_is_active=bool(getattr(account.user, "is_active", False)),
    )


def count_active_super_admin_accounts(*, exclude_account_id: Optional[str] = None) -> int:
    qs = (
        AdminAccount.objects.filter(
            user__is_active=True,
            status=AdminAccount.STATUS_ACTIVE,
            admin_login_enabled=True,
            role_assignments__role__code=SUPER_ADMIN_ROLE_CODE,
            role_assignments__role__is_active=True,
        )
        .distinct()
    )
    if exclude_account_id:
        qs = qs.exclude(id=exclude_account_id)
    return qs.count()


def ensure_active_super_admin_not_lost(
    account: AdminAccount,
    *,
    next_status: Optional[str] = None,
    next_admin_login_enabled: Optional[bool] = None,
    next_role_codes: Optional[Iterable[str]] = None,
) -> None:
    before = _build_state(account)
    after = _build_state(
        account,
        status=next_status,
        admin_login_enabled=next_admin_login_enabled,
        role_codes=next_role_codes,
    )

    if not before.is_active_super_admin or after.is_active_super_admin:
        return

    remaining = count_active_super_admin_accounts(exclude_account_id=str(account.id))
    if remaining > 0:
        return

    if SUPER_ADMIN_ROLE_CODE not in after.role_codes:
        raise HttpError(
            409,
            {
                "code": LAST_SUPER_ADMIN_ROLE_CANNOT_BE_REMOVED,
                "message": "最后一个 active Super Admin 的角色不能被移除",
            },
        )

    if after.status != AdminAccount.STATUS_ACTIVE or not after.admin_login_enabled:
        raise HttpError(
            409,
            {
                "code": LAST_SUPER_ADMIN_CANNOT_BE_DISABLED,
                "message": "最后一个 active Super Admin 账号不能被禁用",
            },
        )

    raise HttpError(
        409,
        {
            "code": NO_ACTIVE_SUPER_ADMIN_REMAINING,
            "message": "系统中至少需要一个 active Super Admin",
        },
    )
