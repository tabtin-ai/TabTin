"""
AdminDash 用户管理 API
"""

import csv
import io
import os
import re
from datetime import datetime, timedelta
from typing import Dict, Iterable, List, Optional

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.core.management import call_command
from django.db import models, transaction
from django.db.models import Count, Q, Sum
from django.http import HttpResponse
from django.utils import timezone
from ninja import Router, Schema
from ninja.errors import HttpError

from apps.users.auth.admin_audit import (
    filter_sensitive_actions_by_organization,
    record_admin_sensitive_action,
)
from apps.users.auth.permissions import AdminPermissionAuth, StaffAuth, SuperuserAuth
from apps.users.wallet.models import OrganizationWallet, WalletTransaction

from .admin_schemas import (
    AdminAuditExportRequestSchema,
    AdminAccountItemSchema,
    AdminAccountListResponseSchema,
    AdminAccountMutationRequestSchema,
    AdminAccountUpdateRequestSchema,
    AdminBatchSkipItemSchema,
    AdminDirtyUserCleanupByPhoneRequestSchema,
    AdminDirtyUserCleanupResponseSchema,
    AdminInviteCodeCreateRequestSchema,
    AdminInviteCodeItemSchema,
    AdminInviteCodeListResponseSchema,
    AdminInviteCodeMutationResponseSchema,
    AdminSensitiveActionRequestSchema,
    AdminInviteCodeSummarySchema,
    AdminInviteCodeUpdateRequestSchema,
    AdminInvitePaginationSchema,
    AdminInviteRedemptionItemSchema,
    AdminInviteRedemptionListResponseSchema,
    AdminIntentUserItemSchema,
    AdminIntentUserListResponseSchema,
    AdminIntentUserSummarySchema,
    AdminLoginLogItemSchema,
    AdminLoginLogListResponseSchema,
    AdminPermissionItemSchema,
    AdminRoleCreateRequestSchema,
    AdminRoleItemSchema,
    AdminRoleUpdateRequestSchema,
    AdminRolePermissionsUpdateSchema,
    AdminSensitiveActionItemSchema,
    AdminSensitiveActionListResponseSchema,
    AdminUserActionLogSchema,
    AdminUserBatchMutationResponseSchema,
    AdminUserBatchRoleUpdateSchema,
    AdminUserBatchStatusUpdateSchema,
    AdminUserDetailResponseSchema,
    AdminUserListItemSchema,
    AdminUserListResponseSchema,
    AdminUserMutationResponseSchema,
    AdminUserOrganizationItemSchema,
    AdminUserOrganizationListResponseSchema,
    AdminUserOrganizationSummarySchema,
    AdminUserPaginationSchema,
    AdminUserRechargeRequestSchema,
    AdminUserRechargeResponseSchema,
    AdminUserRoleUpdateSchema,
    AdminUserSessionSchema,
    AdminUserStatusUpdateSchema,
    AdminUserSummarySchema,
    AdminWalletSummarySchema,
    AdminWalletTransactionSchema,
    AdminWalletTransactionsResponseSchema,
)
from apps.i18n import _
from .models import (
    AdminAccount,
    AdminAccountRole,
    AdminLoginLog,
    AdminPermission,
    AdminRole,
    AdminSensitiveActionLog,
    IntentUser,
    RegistrationInviteCode,
    RegistrationInviteRedemption,
    UserActionLog,
    UserSession,
)
from .session_manager import SessionManager
from .utils import get_client_ip, get_user_agent
from .services.admin_guard import ensure_active_super_admin_not_lost
from .services.invite_code_service import generate_invite_code, normalize_invite_code

import logging as _logging

_admin_logger = _logging.getLogger(__name__)

User = get_user_model()
router = Router(auth=StaffAuth())

from tabtin.pagination import paginate_queryset as _paginate_qs

VALID_ROLES = {"admin", "operator", "user"}
VALID_STATUSES = {"active", "inactive"}
DIRTY_USER_CLEANUP_CONFIRMATION = "DELETE_DIRTY_USER_DATA"
SYSTEM_ROLE_CODES = {
    "super_admin",
}
ROLE_CODE_PATTERN = re.compile(r"^[a-z][a-z0-9_]{2,63}$")

CURRENTLY_ENABLED_STAFF_PERMISSIONS = {
    "user:list",
    "intent_user:list",
    "invite_code:list",
    "organization:list",
    "organization:view",
    "space:list",
}


def _resolve_admin_permissions(user) -> Dict[str, object]:
    admin_account = (
        AdminAccount.objects.filter(
            user=user,
            admin_login_enabled=True,
            status=AdminAccount.STATUS_ACTIVE,
        )
        .prefetch_related("role_assignments__role__permissions")
        .first()
    )
    if admin_account is None:
        raise HttpError(
            403,
            {
                "code": "ADMIN_ACCOUNT_REQUIRED",
                "message": "当前用户没有可用后台账号",
                "missing_permission": "admin_account:view",
            },
        )

    assigned_permissions = set()
    role_codes: List[str] = []

    for assignment in admin_account.role_assignments.all():
        role = assignment.role
        if not role.is_active:
            continue
        role_codes.append(role.code)
        assigned_permissions.update(
            role.permissions.filter(is_active=True).values_list("code", flat=True)
        )

    # User.is_superuser 与 RBAC super_admin 任一成立，都投影为通配超管。
    if getattr(user, "is_superuser", False) or "super_admin" in role_codes:
        return {
            "role": "super_admin",
            "roles": sorted(set(role_codes) | {"super_admin"}),
            "permissions": ["*"],
            "assigned_permissions": ["*"],
            "is_superuser": True,
            "admin_account": {
                "id": str(admin_account.id),
                "display_name": admin_account.display_name,
                "status": admin_account.status,
            },
        }

    if not role_codes:
        return {
            "role": "",
            "roles": [],
            "permissions": [],
            "assigned_permissions": [],
            "is_superuser": False,
            "admin_account": {
                "id": str(admin_account.id),
                "display_name": admin_account.display_name,
                "status": admin_account.status,
            },
        }

    return {
        "role": role_codes[0] if role_codes else "support_agent",
        "roles": sorted(role_codes or ["support_agent"]),
        "permissions": sorted(assigned_permissions),
        "assigned_permissions": sorted(assigned_permissions),
        "is_superuser": False,
        "admin_account": {
            "id": str(admin_account.id),
            "display_name": admin_account.display_name,
            "status": admin_account.status,
        },
    }


class AdminSensitiveReasonRequest(Schema):
    reason: str
    ticket_id: str = ""


def _assert_dirty_user_cleanup_enabled() -> None:
    """Only expose physical phone-based cleanup in dev/test-like environments."""
    env = os.getenv("ENVIRONMENT", "").strip().lower()
    django_env = os.getenv("DJANGO_ENV", "").strip().lower()
    tabtin_env = os.getenv("TABTIN_ENV", "").strip().lower()
    if env == "production" or django_env == "production":
        raise HttpError(403, "生产环境禁止使用手机号物理清理账号接口")
    if settings.DEBUG:
        return
    if tabtin_env == "ack-test":
        return
    if os.getenv("TABTIN_ENABLE_DEV_USER_CLEANUP_API") == "1":
        return
    raise HttpError(
        403,
        "临时清理接口未启用：设置 TABTIN_ENABLE_DEV_USER_CLEANUP_API=1 后仅在测试环境使用",
    )


def _collect_dirty_user_cleanup_counts(user_id: str) -> Dict[str, object]:
    """Best-effort preview/verification counts for the temporary cleanup endpoint."""
    counts: Dict[str, object] = {}

    def add(name: str, fn) -> None:
        try:
            counts[name] = fn()
        except Exception as exc:  # pragma: no cover - diagnostic surface only
            counts[name] = {"error": str(exc)}

    from .models import UserApiKey

    add("users_auth_user", lambda: User.objects.filter(id=user_id).count())
    add("users_auth_user_profile", lambda: User.objects.filter(id=user_id, profile__isnull=False).count())
    add("users_auth_user_session", lambda: UserSession.objects.filter(user_id=user_id).count())
    add("users_auth_user_action_log", lambda: UserActionLog.objects.filter(user_id=user_id).count())
    add("users_auth_user_api_key", lambda: UserApiKey.objects.filter(user_id=user_id).count())

    try:
        from apps.tabtinspace.models import (
            Agent,
            ContextItem,
            Device,
            SecureCredential,
            SpaceAppSettings,
            Organization,
            OrganizationMember,
        )

        add("tabtinspace_owned_organizations", lambda: Organization.objects.filter(owner_id=user_id).count())
        add("tabtinspace_memberships", lambda: OrganizationMember.objects.filter(user_id=user_id).count())
        add("tabtinspace_devices", lambda: Device.objects.filter(user_id=user_id).count())
        add("tabtinspace_secure_credentials", lambda: SecureCredential.objects.filter(user_id=user_id).count())
        add("tabtinspace_space_app_settings", lambda: SpaceAppSettings.objects.filter(user_id=user_id).count())
        add("tabtinspace_context_items_created", lambda: ContextItem.objects.filter(created_by_id=user_id).count())
        add("tabtinspace_context_items_updated", lambda: ContextItem.objects.filter(updated_by_id=user_id).count())
        counts["owned_organizations_sample"] = [
            {
                "id": str(row["id"]),
                "name": row["name"],
                "type": row["type"],
                "status": row["status"],
            }
            for row in Organization.objects.filter(owner_id=user_id)
            .values("id", "name", "type", "status")[:20]
        ]
    except Exception as exc:  # pragma: no cover - diagnostic surface only
        counts["tabtinspace_error"] = str(exc)

    try:
        from apps.tabdata.models import Table, TableRecord

        add("tabdata_tables_owner", lambda: Table.objects.filter(owner_id=user_id).count())
        add("tabdata_records_created", lambda: TableRecord.objects.filter(created_by_id=user_id).count())
        add("tabdata_records_updated", lambda: TableRecord.objects.filter(updated_by_id=user_id).count())
    except Exception as exc:  # pragma: no cover - diagnostic surface only
        counts["tabdata_error"] = str(exc)

    try:
        from apps.fts.models import SearchAnalytics

        add("fts_analytics", lambda: SearchAnalytics.objects.filter(user_id=user_id).count())
    except Exception as exc:  # pragma: no cover - diagnostic surface only
        counts["fts_error"] = str(exc)

    return counts


def _cleanup_search_traces_for_user(user_id: str, *, dry_run: bool) -> str:
    output = io.StringIO()
    kwargs: Dict[str, object] = {"stdout": output}
    if dry_run:
        kwargs["dry_run"] = True
    call_command("fts_forget_user", user_id, **kwargs)
    return output.getvalue()

def _resolve_user_role(user) -> str:
    if user.is_superuser:
        return "admin"
    if user.is_staff:
        return "operator"
    return "user"

def _resolve_user_status(user) -> str:
    return "active" if user.is_active else "inactive"


@router.get("/me/permissions", auth=AdminPermissionAuth(), tags=["后台权限"])
def get_admin_permissions(request):
    """Return current AdminDash permissions for menu and button pruning."""
    user = request.auth
    return _resolve_admin_permissions(user)


def _pagination(page: int, page_size: int) -> tuple[int, int]:
    safe_page = max(int(page or 1), 1)
    safe_page_size = min(max(int(page_size or 20), 1), 100)
    return safe_page, safe_page_size


def _serialize_admin_account(account: AdminAccount) -> AdminAccountItemSchema:
    roles = [
        assignment.role.code
        for assignment in account.role_assignments.all()
        if assignment.role and assignment.role.is_active
    ]
    user = account.user
    return AdminAccountItemSchema(
        id=str(account.id),
        user_id=str(account.user_id),
        display_name=account.display_name or user.get_display_name(),
        email=user.email,
        phone=user.phone,
        employee_no=account.employee_no,
        department=account.department,
        position=account.position,
        status=account.status,
        admin_login_enabled=account.admin_login_enabled,
        role_codes=sorted(roles),
        last_admin_login_at=account.last_admin_login_at,
        last_admin_login_ip=account.last_admin_login_ip,
        created_at=account.created_at,
    )


def _serialize_admin_role(role: AdminRole) -> AdminRoleItemSchema:
    return AdminRoleItemSchema(
        id=str(role.id),
        code=role.code,
        name=role.name,
        description=role.description,
        is_system=role.is_system,
        is_active=role.is_active,
        permission_codes=sorted(role.permissions.values_list("code", flat=True)),
    )


def _normalize_role_code(raw_code: str) -> str:
    code = (raw_code or "").strip().lower()
    if not ROLE_CODE_PATTERN.match(code):
        raise HttpError(
            400,
            "角色 code 只允许小写字母、数字、下划线，且长度为 3-64（需字母开头）",
        )
    return code


def _assert_custom_role_writable(role: AdminRole) -> None:
    if role.is_system or role.code in SYSTEM_ROLE_CODES:
        raise HttpError(409, "系统内置角色只读，不允许修改或删除")


def _resolve_permissions_by_codes(permission_codes: List[str]) -> tuple[list[AdminPermission], list[str]]:
    requested = list(dict.fromkeys(permission_codes or []))
    permissions = list(AdminPermission.objects.filter(code__in=requested, is_active=True))
    found_codes = {permission.code for permission in permissions}
    missing = [code for code in requested if code not in found_codes]
    return permissions, missing


def compute_user_legacy_admin_flags(account: AdminAccount) -> Dict[str, object]:
    """根据 AdminAccount 可用性与 RBAC 角色，计算期望的 User 旧标记。"""
    account_usable = (
        account.status == AdminAccount.STATUS_ACTIVE
        and bool(account.admin_login_enabled)
    )
    role_codes = set(
        account.role_assignments.filter(role__is_active=True).values_list(
            "role__code", flat=True
        )
    )
    return {
        "is_staff": account_usable,
        "is_superuser": account_usable and "super_admin" in role_codes,
        "role_codes": sorted(role_codes),
    }


def sync_user_legacy_admin_flags(account: AdminAccount) -> Dict[str, object]:
    """把 AdminAccount RBAC 状态同步到 User.is_staff / is_superuser。

    StaffAuth / SuperuserAuth / 部分菜单仍读这两个旧标记；只写
    AdminAccountRole 会导致「能登录、角色显示 super_admin，但无通配权限」。
    """
    user = account.user
    desired = compute_user_legacy_admin_flags(account)
    want_staff = bool(desired["is_staff"])
    want_super = bool(desired["is_superuser"])

    update_fields: List[str] = []
    if bool(user.is_staff) != want_staff:
        user.is_staff = want_staff
        update_fields.append("is_staff")
    if bool(user.is_superuser) != want_super:
        user.is_superuser = want_super
        update_fields.append("is_superuser")
    if update_fields:
        user.save(update_fields=update_fields)
    return {
        "is_staff": want_staff,
        "is_superuser": want_super,
        "updated_fields": update_fields,
    }


def _sync_admin_account_roles(
    account: AdminAccount,
    role_codes: List[str],
    *,
    actor_account: Optional[AdminAccount],
    reason: str,
) -> tuple[list[str], list[str]]:
    requested = list(dict.fromkeys(role_codes))
    roles = list(AdminRole.objects.filter(code__in=requested, is_active=True))
    found_codes = {role.code for role in roles}
    missing = [code for code in requested if code not in found_codes]
    if missing:
        raise HttpError(400, {"message": "部分角色不存在", "missing_roles": missing})
    before = sorted(account.role_assignments.values_list("role__code", flat=True))
    ensure_active_super_admin_not_lost(account, next_role_codes=found_codes)

    with transaction.atomic():
        AdminAccountRole.objects.filter(admin_account=account).exclude(role__code__in=found_codes).delete()
        for role in roles:
            AdminAccountRole.objects.get_or_create(
                admin_account=account,
                role=role,
                defaults={
                    "assigned_by_admin_account": actor_account,
                    "reason": reason,
                },
            )
        sync_user_legacy_admin_flags(account)

    account.refresh_from_db()
    after = sorted(account.role_assignments.values_list("role__code", flat=True))
    return before, after


@router.get(
    "/admin-accounts",
    response=AdminAccountListResponseSchema,
    auth=AdminPermissionAuth("admin_account:list"),
    tags=["后台治理"],
)
def list_admin_accounts(
    request,
    keyword: str = "",
    status: str = "",
    page: int = 1,
    page_size: int = 20,
):
    page, page_size = _pagination(page, page_size)
    qs = AdminAccount.objects.select_related("user").prefetch_related("role_assignments__role")
    if status:
        qs = qs.filter(status=status)
    if keyword:
        qs = qs.filter(
            Q(display_name__icontains=keyword)
            | Q(employee_no__icontains=keyword)
            | Q(department__icontains=keyword)
            | Q(user__email__icontains=keyword)
            | Q(user__phone__icontains=keyword)
        )
    total = qs.count()
    items = list(qs.order_by("-created_at")[(page - 1) * page_size : page * page_size])
    return AdminAccountListResponseSchema(
        items=[_serialize_admin_account(item) for item in items],
        total=total,
        page=page,
        page_size=page_size,
        total_pages=(total + page_size - 1) // page_size,
    )


@router.post(
    "/admin-accounts",
    response=AdminAccountItemSchema,
    auth=AdminPermissionAuth("admin_account:create"),
    tags=["后台治理"],
)
def create_admin_account(request, payload: AdminAccountMutationRequestSchema):
    actor_account = getattr(request, "admin_account", None)
    user = User.objects.filter(id=payload.user_id).first()
    if user is None:
        raise HttpError(404, "关联用户不存在")
    before = {}
    with transaction.atomic():
        account, created = AdminAccount.objects.get_or_create(
            user=user,
            defaults={
                "display_name": payload.display_name or user.get_display_name(),
                "employee_no": payload.employee_no,
                "department": payload.department,
                "position": payload.position,
                "admin_login_enabled": payload.admin_login_enabled,
                "created_by": request.auth,
            },
        )
        if not created:
            raise HttpError(409, "该用户已经绑定后台账号")
        _, after_roles = _sync_admin_account_roles(
            account,
            payload.role_codes,
            actor_account=actor_account,
            reason=payload.reason,
        )
        after = {
            "admin_account_id": str(account.id),
            "user_id": str(user.id),
            "role_codes": after_roles,
        }
        record_admin_sensitive_action(
            request,
            permission_code="admin_account:create",
            action="admin_account_create",
            target_type="admin_account",
            target_id=str(account.id),
            reason=payload.reason,
            ticket_id=payload.ticket_id,
            before_json=before,
            after_json=after,
        )
    return _serialize_admin_account(account)


@router.put(
    "/admin-accounts/{account_id}",
    response=AdminAccountItemSchema,
    auth=AdminPermissionAuth("admin_account:update"),
    tags=["后台治理"],
)
def update_admin_account(request, account_id: str, payload: AdminAccountUpdateRequestSchema):
    account = (
        AdminAccount.objects.select_related("user")
        .prefetch_related("role_assignments__role")
        .filter(id=account_id)
        .first()
    )
    if account is None:
        raise HttpError(404, "后台账号不存在")
    actor_account = getattr(request, "admin_account", None)
    before = {
        "display_name": account.display_name,
        "employee_no": account.employee_no,
        "department": account.department,
        "position": account.position,
        "admin_login_enabled": account.admin_login_enabled,
        "status": account.status,
        "role_codes": sorted(account.role_assignments.values_list("role__code", flat=True)),
    }
    next_status = payload.status if payload.status is not None else account.status
    next_admin_login_enabled = (
        payload.admin_login_enabled
        if payload.admin_login_enabled is not None
        else account.admin_login_enabled
    )
    next_role_codes = (
        payload.role_codes
        if payload.role_codes is not None
        else sorted(account.role_assignments.values_list("role__code", flat=True))
    )
    ensure_active_super_admin_not_lost(
        account,
        next_status=next_status,
        next_admin_login_enabled=next_admin_login_enabled,
        next_role_codes=next_role_codes,
    )
    for field in ["display_name", "employee_no", "department", "position", "admin_login_enabled", "status"]:
        value = getattr(payload, field)
        if value is not None:
            setattr(account, field, value)
    if payload.status == AdminAccount.STATUS_DISABLED:
        account.disabled_by = request.auth
        account.disabled_reason = payload.reason
    account.save()
    if payload.role_codes is not None:
        _sync_admin_account_roles(
            account,
            payload.role_codes,
            actor_account=actor_account,
            reason=payload.reason,
        )
    else:
        sync_user_legacy_admin_flags(account)
    account.refresh_from_db()
    account = (
        AdminAccount.objects.select_related("user")
        .prefetch_related("role_assignments__role")
        .get(id=account.id)
    )
    after = {
        "display_name": account.display_name,
        "employee_no": account.employee_no,
        "department": account.department,
        "position": account.position,
        "admin_login_enabled": account.admin_login_enabled,
        "status": account.status,
        "role_codes": sorted(account.role_assignments.values_list("role__code", flat=True)),
    }
    permission = "admin_account:assign_role" if payload.role_codes is not None else "admin_account:update"
    record_admin_sensitive_action(
        request,
        permission_code=permission,
        action="admin_account_update",
        target_type="admin_account",
        target_id=str(account.id),
        reason=payload.reason,
        ticket_id=payload.ticket_id,
        before_json=before,
        after_json=after,
    )
    return _serialize_admin_account(account)


@router.get(
    "/permissions",
    response=List[AdminPermissionItemSchema],
    auth=AdminPermissionAuth("admin_permission:list"),
    tags=["后台治理"],
)
def list_admin_permission_catalog(request):
    permissions = AdminPermission.objects.order_by("category", "code")
    return [
        AdminPermissionItemSchema(
            code=item.code,
            name=item.name,
            category=item.category,
            risk_level=item.risk_level,
            description=item.description,
            is_active=item.is_active,
        )
        for item in permissions
    ]


@router.get(
    "/roles",
    response=List[AdminRoleItemSchema],
    auth=AdminPermissionAuth("admin_role:list"),
    tags=["后台治理"],
)
def list_admin_roles(request):
    roles = AdminRole.objects.prefetch_related("permissions").order_by("code")
    return [_serialize_admin_role(role) for role in roles]


@router.post(
    "/roles",
    response=AdminRoleItemSchema,
    auth=AdminPermissionAuth("admin_role:create"),
    tags=["后台治理"],
)
def create_admin_role(request, payload: AdminRoleCreateRequestSchema):
    code = _normalize_role_code(payload.code)
    if AdminRole.objects.filter(code=code).exists():
        raise HttpError(409, "角色 code 已存在")

    name = (payload.name or "").strip()
    if not name:
        raise HttpError(400, "角色名称不能为空")

    permissions, missing = _resolve_permissions_by_codes(payload.permission_codes)
    if missing:
        raise HttpError(400, {"message": "部分权限点不存在", "missing_permissions": missing})

    with transaction.atomic():
        role = AdminRole.objects.create(
            code=code,
            name=name,
            description=(payload.description or "").strip(),
            is_system=False,
            is_active=True,
        )
        if permissions:
            role.permissions.set(permissions)
        after_codes = sorted(permission.code for permission in permissions)
        record_admin_sensitive_action(
            request,
            permission_code="admin_role:create",
            action="admin_role_create",
            target_type="admin_role",
            target_id=str(role.id),
            reason=payload.reason,
            ticket_id=payload.ticket_id,
            before_json={},
            after_json={
                "role": {
                    "id": str(role.id),
                    "code": role.code,
                    "name": role.name,
                    "description": role.description,
                    "is_active": role.is_active,
                },
                "permission_codes": after_codes,
            },
        )

    role = AdminRole.objects.prefetch_related("permissions").get(id=role.id)
    return _serialize_admin_role(role)


@router.put(
    "/roles/{role_id}",
    response=AdminRoleItemSchema,
    auth=AdminPermissionAuth("admin_role:update"),
    tags=["后台治理"],
)
def update_admin_role(request, role_id: str, payload: AdminRoleUpdateRequestSchema):
    role = AdminRole.objects.prefetch_related("permissions").filter(id=role_id).first()
    if role is None:
        raise HttpError(404, "后台角色不存在")
    _assert_custom_role_writable(role)

    name = payload.name.strip() if payload.name is not None else role.name
    if not name:
        raise HttpError(400, "角色名称不能为空")

    before = {
        "code": role.code,
        "name": role.name,
        "description": role.description,
        "is_active": role.is_active,
    }
    with transaction.atomic():
        role.name = name
        if payload.description is not None:
            role.description = payload.description.strip()
        if payload.is_active is not None:
            role.is_active = payload.is_active
        role.save(update_fields=["name", "description", "is_active", "updated_at"])
        after = {
            "code": role.code,
            "name": role.name,
            "description": role.description,
            "is_active": role.is_active,
        }
        record_admin_sensitive_action(
            request,
            permission_code="admin_role:update",
            action="admin_role_update",
            target_type="admin_role",
            target_id=str(role.id),
            reason=payload.reason,
            ticket_id=payload.ticket_id,
            before_json=before,
            after_json=after,
        )
    role.refresh_from_db()
    role = AdminRole.objects.prefetch_related("permissions").get(id=role.id)
    return _serialize_admin_role(role)


@router.put(
    "/roles/{role_id}/permissions",
    response=AdminRoleItemSchema,
    auth=AdminPermissionAuth("admin_role:update"),
    tags=["后台治理"],
)
def update_admin_role_permissions(request, role_id: str, payload: AdminRolePermissionsUpdateSchema):
    role = AdminRole.objects.prefetch_related("permissions").filter(id=role_id).first()
    if role is None:
        raise HttpError(404, "后台角色不存在")
    _assert_custom_role_writable(role)
    before_codes = sorted(role.permissions.values_list("code", flat=True))
    permissions, missing = _resolve_permissions_by_codes(payload.permission_codes)
    if missing:
        raise HttpError(400, {"message": "部分权限点不存在", "missing_permissions": missing})
    with transaction.atomic():
        AdminRole.objects.select_for_update().get(id=role.id)
        role.permissions.set(permissions)
        after_codes = sorted(permission.code for permission in permissions)
        record_admin_sensitive_action(
            request,
            permission_code="admin_role:update",
            action="admin_role_permissions_update",
            target_type="admin_role",
            target_id=str(role.id),
            reason=payload.reason,
            ticket_id=payload.ticket_id,
            before_json={"permission_codes": before_codes},
            after_json={"permission_codes": after_codes},
        )
    role.refresh_from_db()
    return _serialize_admin_role(role)


@router.post(
    "/roles/{role_id}/delete",
    response=dict,
    auth=AdminPermissionAuth("admin_role:delete"),
    tags=["后台治理"],
)
def delete_admin_role(request, role_id: str, payload: AdminSensitiveActionRequestSchema):
    role = AdminRole.objects.prefetch_related("permissions").filter(id=role_id).first()
    if role is None:
        raise HttpError(404, "后台角色不存在")
    _assert_custom_role_writable(role)
    assigned_count = AdminAccountRole.objects.filter(role_id=role.id).count()
    if assigned_count > 0:
        raise HttpError(
            409,
            {
                "message": "该角色仍被后台账号使用，无法删除",
                "assigned_account_count": assigned_count,
            },
        )

    before = {
        "code": role.code,
        "name": role.name,
        "description": role.description,
        "is_active": role.is_active,
        "permission_codes": sorted(role.permissions.values_list("code", flat=True)),
    }
    with transaction.atomic():
        role.delete()
        record_admin_sensitive_action(
            request,
            permission_code="admin_role:delete",
            action="admin_role_delete",
            target_type="admin_role",
            target_id=role_id,
            reason=payload.reason,
            ticket_id=payload.ticket_id,
            before_json=before,
            after_json={"deleted": True},
        )
    return {"success": True}


@router.get(
    "/admin-sensitive-actions",
    response=AdminSensitiveActionListResponseSchema,
    auth=AdminPermissionAuth("sensitive_action:list"),
    tags=["后台治理"],
)
def list_admin_sensitive_actions(
    request,
    action: str = "",
    permission_code: str = "",
    target_type: str = "",
    actor_admin_account_id: str = "",
    actor_user_id: str = "",
    organization_id: str = "",
    start_at: Optional[datetime] = None,
    end_at: Optional[datetime] = None,
    page: int = 1,
    page_size: int = 20,
):
    page, page_size = _pagination(page, page_size)
    qs = AdminSensitiveActionLog.objects.select_related("actor_user", "actor_admin_account")
    if action:
        qs = qs.filter(action=action)
    if permission_code:
        qs = qs.filter(permission_code=permission_code)
    if target_type:
        qs = qs.filter(target_type=target_type)
    if actor_admin_account_id:
        qs = qs.filter(actor_admin_account_id=actor_admin_account_id)
    if actor_user_id:
        qs = qs.filter(actor_user_id=actor_user_id)
    if organization_id:
        qs = filter_sensitive_actions_by_organization(qs, organization_id)
    if start_at:
        qs = qs.filter(created_at__gte=start_at)
    if end_at:
        qs = qs.filter(created_at__lte=end_at)
    total = qs.count()
    items = list(qs.order_by("-created_at")[(page - 1) * page_size : page * page_size])
    return AdminSensitiveActionListResponseSchema(
        items=[
            AdminSensitiveActionItemSchema(
                id=str(item.id),
                actor_user_id=str(item.actor_user_id) if item.actor_user_id else None,
                actor_admin_account_id=str(item.actor_admin_account_id) if item.actor_admin_account_id else None,
                actor_display_name=(
                    item.actor_admin_account.display_name
                    if item.actor_admin_account_id and item.actor_admin_account
                    else (item.actor_user.get_display_name() if item.actor_user_id and item.actor_user else "")
                ),
                permission_code=item.permission_code,
                action=item.action,
                target_type=item.target_type,
                target_id=item.target_id,
                reason=item.reason,
                ticket_id=item.ticket_id,
                before_json=item.before_json,
                after_json=item.after_json,
                ip=item.ip,
                request_id=item.request_id,
                created_at=item.created_at,
            )
            for item in items
        ],
        total=total,
        page=page,
        page_size=page_size,
        total_pages=(total + page_size - 1) // page_size,
    )


@router.get(
    "/admin-login-logs",
    response=AdminLoginLogListResponseSchema,
    auth=AdminPermissionAuth("admin_login_log:list"),
    tags=["后台治理"],
)
def list_admin_login_logs(request, page: int = 1, page_size: int = 20, success: Optional[bool] = None):
    page, page_size = _pagination(page, page_size)
    qs = AdminLoginLog.objects.select_related("admin_account")
    if success is not None:
        qs = qs.filter(success=success)
    total = qs.count()
    items = list(qs.order_by("-created_at")[(page - 1) * page_size : page * page_size])
    return AdminLoginLogListResponseSchema(
        items=[
            AdminLoginLogItemSchema(
                id=str(item.id),
                admin_account_id=str(item.admin_account_id) if item.admin_account_id else None,
                user_id=item.user_id,
                display_name=item.admin_account.display_name if item.admin_account_id and item.admin_account else "",
                ip=item.ip,
                login_method=item.login_method,
                success=item.success,
                fail_reason=item.fail_reason,
                created_at=item.created_at,
            )
            for item in items
        ],
        total=total,
        page=page,
        page_size=page_size,
        total_pages=(total + page_size - 1) // page_size,
    )


def _build_wallet_schema(wallet: Optional[OrganizationWallet]) -> Optional[AdminWalletSummarySchema]:
    if wallet is None:
        return None
    return AdminWalletSummarySchema(
        credits=wallet.credits,
        credits_precise=wallet.credits_precise,
        credits_frozen=wallet.credits_frozen,
        credits_frozen_precise=wallet.credits_frozen_precise,
    )

def _find_personal_wallet(user_id: str) -> Optional[OrganizationWallet]:
    """通过 personal organization 查找用户的团队钱包"""
    try:
        from apps.tabtinspace.models import Organization
        personal_wt = Organization.objects.filter(
            owner_id=user_id, type='personal'
        ).values_list('id', flat=True).first()
        if personal_wt:
            return OrganizationWallet.objects.filter(organization_id=str(personal_wt)).first()
    except Exception:
        pass
    return None

def _build_related_maps(
    user_ids: Iterable[str],
) -> tuple[Dict[str, OrganizationWallet], Dict[str, int]]:
    ids = [str(item) for item in user_ids]
    if not ids:
        return {}, {}

    wallet_map: Dict[str, OrganizationWallet] = {}
    try:
        from apps.tabtinspace.models import Organization
        # Organization.id 为 UUIDField；OrganizationWallet.organization 为真 FK。
        # dict key 必须统一成 str，否则 wallet_map.get(str(user.id)) 永远 miss，
        # AdminDash 用户详情「钱包」Tab 会误显示「暂无记录」。
        personal_wts = {
            str(owner_id): str(org_id)
            for owner_id, org_id in Organization.objects.filter(
                owner_id__in=ids, type='personal'
            ).values_list('owner_id', 'id')
        }
        wt_ids = list(personal_wts.values())
        ws_wallets = {
            str(w.organization_id): w
            for w in OrganizationWallet.objects.filter(organization_id__in=wt_ids)
        }
        for uid, wt_id in personal_wts.items():
            ww = ws_wallets.get(wt_id)
            if ww:
                wallet_map[uid] = ww
    except Exception:
        pass

    session_count_map = {
        str(item["user_id"]): item["count"]
        for item in (
            UserSession.objects.filter(user_id__in=ids, is_active=True)
            .values("user_id")
            .annotate(count=Count("id"))
        )
    }
    return wallet_map, session_count_map


def _build_organization_summary_map(
    user_ids: Iterable[str],
) -> Dict[str, AdminUserOrganizationSummarySchema]:
    """批量汇总用户所属组织：数量 + 优先展示个人身份组织。"""
    ids = [str(item) for item in user_ids]
    if not ids:
        return {}

    try:
        from apps.tabtinspace.models import OrganizationMember
    except Exception:
        return {}

    memberships = (
        OrganizationMember.objects.filter(user_id__in=ids)
        .select_related("organization")
        .order_by("user_id", "-joined_at")
    )

    summaries: Dict[str, Dict[str, object]] = {}
    for membership in memberships:
        user_id = str(membership.user_id)
        organization = membership.organization
        is_personal = (
            getattr(organization, "type", "") == "personal"
            or bool(getattr(organization, "is_default", False))
        )
        current = summaries.get(user_id)
        if current is None:
            summaries[user_id] = {
                "organization_count": 1,
                "primary_organization_id": str(organization.id),
                "primary_organization_name": organization.name,
                "has_personal": is_personal,
            }
            continue

        current["organization_count"] = int(current["organization_count"]) + 1
        if not current["has_personal"] and is_personal:
            current["primary_organization_id"] = str(organization.id)
            current["primary_organization_name"] = organization.name
            current["has_personal"] = True

    return {
        user_id: AdminUserOrganizationSummarySchema(
            organization_count=int(payload["organization_count"]),
            primary_organization_id=str(payload["primary_organization_id"])
            if payload.get("primary_organization_id")
            else None,
            primary_organization_name=str(payload["primary_organization_name"])
            if payload.get("primary_organization_name")
            else None,
        )
        for user_id, payload in summaries.items()
    }


def _serialize_user(
    user,
    wallet_map: Dict[str, OrganizationWallet],
    session_count_map: Dict[str, int],
    organization_summary_map: Optional[Dict[str, AdminUserOrganizationSummarySchema]] = None,
) -> AdminUserListItemSchema:
    user_id = str(user.id)
    wallet = wallet_map.get(user_id)
    organization_summary = None
    if organization_summary_map is not None:
        organization_summary = organization_summary_map.get(
            user_id,
            AdminUserOrganizationSummarySchema(organization_count=0),
        )
    return AdminUserListItemSchema(
        id=user_id,
        username=user.username,
        nickname=user.nickname,
        display_name=user.get_display_name(),
        email=user.email,
        phone=user.phone,
        role=_resolve_user_role(user),
        status=_resolve_user_status(user),
        is_staff=user.is_staff,
        is_superuser=user.is_superuser,
        is_verified_email=user.is_verified_email,
        is_verified_phone=user.is_verified_phone,
        date_joined=user.date_joined,
        last_login=user.last_login,
        login_count=user.login_count,
        failed_login_attempts=user.failed_login_attempts,
        active_session_count=session_count_map.get(user_id, 0),
        wallet=_build_wallet_schema(wallet),
        organization_summary=organization_summary,
    )


def _ensure_sensitive_reason(payload: AdminSensitiveReasonRequest) -> str:
    reason = (payload.reason or "").strip()
    if not reason:
        raise HttpError(400, "reason 必填")
    return reason


def _serialize_device(device) -> dict:
    return {
        "id": str(device.id),
        "user_id": str(device.user_id),
        "organization_id": str(device.organization_id),
        "device_id": device.fingerprint,
        "device_name": device.name,
        "client_type": device.device_type,
        "platform": (device.os_info or {}).get("platform") or (device.os_info or {}).get("os") or "",
        "os_version": (device.os_info or {}).get("version") or "",
        "app_version": device.app_version,
        "ip_address": device.ip_address,
        "last_seen_at": device.last_heartbeat_at,
        "online_status": device.status,
        "status": device.control_status,
        "blocked_reason": device.blocked_reason,
        "blocked_by_admin_account_id": device.blocked_by_admin_account_id,
        "blocked_at": device.blocked_at,
        "metadata_json": device.metadata_json or {},
        "created_at": device.created_at,
        "updated_at": device.updated_at,
    }


def _serialize_session(item: UserSession) -> dict:
    return {
        "id": str(item.id),
        "session_id": str(item.id),
        "user_id": str(item.user_id),
        "device_id": item.device_id or (item.device_info or {}).get("device_id", ""),
        "client_type": item.client_type or item.session_type,
        "session_type": item.session_type,
        "ip_address": item.ip_address,
        "user_agent": item.user_agent,
        "device_info": item.device_info or {},
        "created_at": item.created_at,
        "last_seen_at": item.last_activity,
        "last_activity": item.last_activity,
        "expires_at": item.expires_at,
        "is_active": item.is_active,
        "revoked_at": item.revoked_at,
        "revoked_by_admin_account_id": item.revoked_by_admin_account_id,
        "revoked_reason": item.revoked_reason,
    }


def _build_summary(filtered_total: int) -> AdminUserSummarySchema:
    stats = User.objects.aggregate(
        total_users=Count("id"),
        active_users=Count("id", filter=Q(is_active=True)),
        inactive_users=Count("id", filter=Q(is_active=False)),
        admin_users=Count("id", filter=Q(is_superuser=True)),
        operator_users=Count("id", filter=Q(is_staff=True, is_superuser=False)),
        normal_users=Count("id", filter=Q(is_staff=False, is_superuser=False)),
    )
    return AdminUserSummarySchema(
        filtered_users=filtered_total,
        **stats,
    )


def _serialize_intent_user(row: IntentUser) -> AdminIntentUserItemSchema:
    return AdminIntentUserItemSchema(
        id=str(row.id),
        phone=row.phone,
        created_at=row.created_at,
    )

def _apply_role_mutation(user, role: str) -> None:
    if role == "admin":
        user.is_staff = True
        user.is_superuser = True
        return
    if role == "operator":
        user.is_staff = True
        user.is_superuser = False
        return
    user.is_staff = False
    user.is_superuser = False

def _normalize_user_ids(user_ids: Optional[Iterable[str]]) -> List[str]:
    if not user_ids:
        return []
    normalized: List[str] = []
    seen: set[str] = set()
    for raw in user_ids:
        value = str(raw).strip()
        if not value or value in seen:
            continue
        seen.add(value)
        normalized.append(value)
    return normalized

def _cancel_active_agent_runs(user_id: str) -> int:
    """BO-024/BO-030: 账号禁用时取消该用户所有活跃的 SubAgent 运行。

    查询状态为 pending/running/queued 的 SubtaskRun，为每个设置 Redis cancel flag，
    使 SubagentCancelCheckMiddleware 在下次迭代前检测到取消。
    """
    import logging
    _logger = logging.getLogger(__name__)
    cancelled = 0
    try:
        from apps.services.agent_engine.agents.subagent.registry import SubagentRegistry
        from apps.services.agent_engine.models import SubtaskRun

        active_runs = SubtaskRun.objects.filter(
            user_id=user_id,
            status__in=["pending", "running", "queued"],
        ).values_list("subagent_run_id", flat=True)

        if not active_runs:
            return 0

        registry = SubagentRegistry()
        for run_id in active_runs:
            try:
                registry.cancel(str(run_id))
                cancelled += 1
            except Exception as exc:
                _logger.warning(
                    "[AdminAPI] Failed to cancel subagent run %s for user %s: %s",
                    run_id, user_id, exc,
                )
        _logger.info(
            "[AdminAPI] Cancelled %d active agent runs for disabled user %s",
            cancelled, user_id,
        )
    except Exception as exc:
        _logger.warning(
            "[AdminAPI] Failed to cancel agent runs for user %s: %s",
            user_id, exc,
        )
    return cancelled

def _schedule_account_collab_revoke(user_id: str) -> None:
    """账号禁用后，事务提交时异步通知 collab-live 断开该用户的所有协作连接。

    复用 RB-004 建立的 async_revoke_collab_access Celery 任务，
    organization_id 传标记值 "__account_disabled__" 用于审计区分。
    必须在 transaction.atomic() 块内调用，利用 on_commit 保证仅在事务成功后派发。
    """
    def _do_revoke():
        try:
            from apps.collab.tasks import async_revoke_collab_access
            async_revoke_collab_access.delay(user_id, "__account_disabled__")
        except Exception:
            _admin_logger.warning(
                "Failed to schedule collab revocation for disabled account: user=%s",
                user_id, exc_info=True,
            )

    transaction.on_commit(_do_revoke)

def _record_user_action(
    *,
    user,
    action_type: str,
    request,
    description: str,
    success: bool = True,
    error_message: str = "",
) -> None:
    try:
        UserActionLog.objects.create(
            user=user,
            action_type=action_type,
            description=description,
            ip_address=get_client_ip(request),
            user_agent=get_user_agent(request),
            success=success,
            error_message=error_message,
        )
    except Exception:
        # 审计记录不应中断主流程
        return


def _invite_status(invite: RegistrationInviteCode) -> str:
    now = timezone.now()
    if not invite.is_active:
        return "disabled"
    if invite.expires_at and invite.expires_at <= now:
        return "expired"
    if invite.starts_at and invite.starts_at > now:
        return "scheduled"
    if invite.usage_limit is not None and invite.used_count >= invite.usage_limit:
        return "exhausted"
    return "available"


def _serialize_invite_code(invite: RegistrationInviteCode) -> AdminInviteCodeItemSchema:
    return AdminInviteCodeItemSchema(
        id=str(invite.id),
        code=invite.code,
        description=invite.description,
        channel=invite.channel,
        campaign=invite.campaign,
        is_active=invite.is_active,
        status=_invite_status(invite),
        starts_at=invite.starts_at,
        expires_at=invite.expires_at,
        usage_limit=invite.usage_limit,
        used_count=invite.used_count,
        remaining_uses=invite.remaining_uses,
        created_by_display_name=invite.created_by.get_display_name() if invite.created_by else "",
        created_at=invite.created_at,
        updated_at=invite.updated_at,
        disabled_at=invite.disabled_at,
    )


def _invite_pagination(total: int, page: int, page_size: int) -> AdminInvitePaginationSchema:
    safe_page_size = max(1, min(page_size, 100))
    total_pages = max(1, (total + safe_page_size - 1) // safe_page_size)
    return AdminInvitePaginationSchema(
        total=total,
        page=max(1, page),
        page_size=safe_page_size,
        total_pages=total_pages,
    )


def _build_invite_summary() -> AdminInviteCodeSummarySchema:
    now = timezone.now()
    codes = RegistrationInviteCode.objects.all()
    aggregates = codes.aggregate(
        total_codes=Count("id"),
        active_codes=Count("id", filter=Q(is_active=True)),
        used_count=Sum("used_count"),
    )
    available_codes = 0
    for invite in codes.only("is_active", "starts_at", "expires_at", "usage_limit", "used_count"):
        if _invite_status(invite) == "available":
            available_codes += 1
    recent_7d_redemptions = RegistrationInviteRedemption.objects.filter(
        consumed_at__gte=now - timedelta(days=7)
    ).count()
    return AdminInviteCodeSummarySchema(
        total_codes=aggregates["total_codes"] or 0,
        active_codes=aggregates["active_codes"] or 0,
        available_codes=available_codes,
        used_count=aggregates["used_count"] or 0,
        recent_7d_redemptions=recent_7d_redemptions,
    )


def _apply_invite_filters(queryset, *, keyword: str, status: str, channel: str, expired: str):
    if keyword:
        queryset = queryset.filter(
            Q(code__icontains=keyword)
            | Q(description__icontains=keyword)
            | Q(channel__icontains=keyword)
            | Q(campaign__icontains=keyword)
        )
    if channel:
        queryset = queryset.filter(channel=channel)
    now = timezone.now()
    if expired == "true":
        queryset = queryset.filter(expires_at__isnull=False, expires_at__lte=now)
    elif expired == "false":
        queryset = queryset.filter(Q(expires_at__isnull=True) | Q(expires_at__gt=now))
    if status == "active":
        queryset = queryset.filter(is_active=True)
    elif status == "disabled":
        queryset = queryset.filter(is_active=False)
    elif status == "expired":
        queryset = queryset.filter(expires_at__isnull=False, expires_at__lte=now)
    elif status == "scheduled":
        queryset = queryset.filter(is_active=True, starts_at__isnull=False, starts_at__gt=now)
    elif status == "available":
        queryset = queryset.filter(is_active=True).filter(Q(starts_at__isnull=True) | Q(starts_at__lte=now)).filter(
            Q(expires_at__isnull=True) | Q(expires_at__gt=now)
        ).filter(Q(usage_limit__isnull=True) | Q(used_count__lt=models.F("usage_limit")))
    elif status == "exhausted":
        queryset = queryset.filter(usage_limit__isnull=False, used_count__gte=models.F("usage_limit"))
    return queryset


def _create_one_invite_code(payload: AdminInviteCodeCreateRequestSchema, *, code: str, operator) -> RegistrationInviteCode:
    normalized = normalize_invite_code(code)
    if not normalized:
        raise HttpError(400, "邀请码不能为空")
    if not payload.channel.strip():
        raise HttpError(400, "渠道不能为空")
    if payload.usage_limit is not None and payload.usage_limit < 1:
        raise HttpError(400, "使用上限必须大于 0，或留空表示不限量")
    if payload.starts_at and payload.expires_at and payload.starts_at >= payload.expires_at:
        raise HttpError(400, "过期时间必须晚于生效时间")
    return RegistrationInviteCode.objects.create(
        code=normalized,
        description=payload.description.strip(),
        channel=payload.channel.strip(),
        campaign=payload.campaign.strip(),
        is_active=payload.is_active,
        starts_at=payload.starts_at,
        expires_at=payload.expires_at,
        usage_limit=payload.usage_limit,
        created_by=operator,
    )


def _payload_has(payload, field: str) -> bool:
    fields = getattr(payload, "model_fields_set", None)
    if fields is None:
        fields = getattr(payload, "__fields_set__", set())
    return field in fields


@router.get(
    "/invite-codes",
    response=AdminInviteCodeListResponseSchema,
    auth=StaffAuth(),
    tags=["后台邀请码管理"],
)
def list_invite_codes(
    request,
    keyword: str = "",
    status: str = "all",
    channel: str = "",
    expired: str = "all",
    page: int = 1,
    page_size: int = 20,
):
    queryset = RegistrationInviteCode.objects.select_related("created_by").all()
    queryset = _apply_invite_filters(
        queryset,
        keyword=keyword.strip(),
        status=status,
        channel=channel.strip(),
        expired=expired,
    )
    total = queryset.count()
    safe_page = max(1, page)
    safe_page_size = max(1, min(page_size, 100))
    items = list(queryset[(safe_page - 1) * safe_page_size:safe_page * safe_page_size])
    return AdminInviteCodeListResponseSchema(
        items=[_serialize_invite_code(item) for item in items],
        pagination=_invite_pagination(total, safe_page, safe_page_size),
        summary=_build_invite_summary(),
    )


@router.post(
    "/invite-codes",
    response=AdminInviteCodeMutationResponseSchema,
    auth=StaffAuth(),
    tags=["后台邀请码管理"],
)
def create_invite_codes(request, payload: AdminInviteCodeCreateRequestSchema):
    count = max(1, min(payload.generate_count or 1, 200))
    if payload.code and count > 1:
        raise HttpError(400, "手动输入邀请码时一次只能创建 1 个")

    created: List[RegistrationInviteCode] = []
    with transaction.atomic():
        for _ in range(count):
            if payload.code:
                code = payload.code
            else:
                for _attempt in range(20):
                    candidate = generate_invite_code(payload.code_length)
                    if not RegistrationInviteCode.objects.filter(code=candidate).exists():
                        code = candidate
                        break
                else:
                    raise HttpError(500, "生成邀请码失败，请重试")
            try:
                created.append(_create_one_invite_code(payload, code=code, operator=request.auth))
            except Exception as exc:
                if isinstance(exc, HttpError):
                    raise
                raise HttpError(400, "邀请码已存在或参数无效") from exc

    return AdminInviteCodeMutationResponseSchema(
        success=True,
        message=f"已创建 {len(created)} 个邀请码",
        items=[_serialize_invite_code(item) for item in created],
    )


@router.patch(
    "/invite-codes/{invite_id}",
    response=AdminInviteCodeMutationResponseSchema,
    auth=StaffAuth(),
    tags=["后台邀请码管理"],
)
def update_invite_code(request, invite_id: str, payload: AdminInviteCodeUpdateRequestSchema):
    try:
        invite = RegistrationInviteCode.objects.select_related("created_by").get(id=invite_id)
    except RegistrationInviteCode.DoesNotExist as exc:
        raise HttpError(404, "邀请码不存在") from exc

    if payload.description is not None:
        invite.description = payload.description.strip()
    if payload.channel is not None:
        if not payload.channel.strip():
            raise HttpError(400, "渠道不能为空")
        invite.channel = payload.channel.strip()
    if payload.campaign is not None:
        invite.campaign = payload.campaign.strip()
    if _payload_has(payload, "starts_at"):
        invite.starts_at = payload.starts_at
    if _payload_has(payload, "expires_at"):
        invite.expires_at = payload.expires_at
    if invite.starts_at and invite.expires_at and invite.starts_at >= invite.expires_at:
        raise HttpError(400, "过期时间必须晚于生效时间")
    if _payload_has(payload, "usage_limit"):
        if payload.usage_limit is not None and payload.usage_limit < 1:
            raise HttpError(400, "使用上限必须大于 0")
        if payload.usage_limit is not None and payload.usage_limit < invite.used_count:
            raise HttpError(400, "使用上限不能小于已使用次数")
        invite.usage_limit = payload.usage_limit
    if payload.is_active is not None:
        invite.is_active = payload.is_active
        if payload.is_active:
            invite.disabled_at = None
            invite.disabled_by = None
        else:
            invite.disabled_at = timezone.now()
            invite.disabled_by = request.auth

    invite.save()
    invite.refresh_from_db()
    return AdminInviteCodeMutationResponseSchema(
        success=True,
        message="邀请码已更新",
        items=[_serialize_invite_code(invite)],
    )


@router.post(
    "/invite-codes/{invite_id}/disable",
    response=AdminInviteCodeMutationResponseSchema,
    auth=AdminPermissionAuth("invite_code:disable"),
    tags=["后台邀请码管理"],
)
def disable_invite_code(request, invite_id: str, payload: AdminSensitiveActionRequestSchema):
    reason = (payload.reason or "").strip()
    if not reason:
        raise HttpError(400, "reason 不能为空")
    try:
        invite = RegistrationInviteCode.objects.select_related("created_by").get(id=invite_id)
    except RegistrationInviteCode.DoesNotExist as exc:
        raise HttpError(404, "邀请码不存在") from exc
    before_is_active = bool(invite.is_active)
    invite.is_active = False
    invite.disabled_at = timezone.now()
    invite.disabled_by = request.auth
    invite.save(update_fields=["is_active", "disabled_at", "disabled_by", "updated_at"])
    masked_code = (
        f"{invite.code[:4]}***{invite.code[-2:]}"
        if invite.code and len(invite.code) >= 6
        else "***"
    )
    record_admin_sensitive_action(
        request,
        permission_code="invite_code:disable",
        action="invite_code.disable",
        target_type="invite_code",
        target_id=str(invite.id),
        reason=reason,
        ticket_id=(payload.ticket_id or "").strip(),
        before_json={
            "invite_code_id": str(invite.id),
            "code": masked_code,
            "status": "active" if before_is_active else "disabled",
            "is_active": before_is_active,
        },
        after_json={
            "invite_code_id": str(invite.id),
            "code": masked_code,
            "status": "disabled",
            "is_active": False,
        },
    )
    return AdminInviteCodeMutationResponseSchema(
        success=True,
        message="邀请码已停用",
        items=[_serialize_invite_code(invite)],
    )


@router.get(
    "/invite-codes/{invite_id}/redemptions",
    response=AdminInviteRedemptionListResponseSchema,
    auth=StaffAuth(),
    tags=["后台邀请码管理"],
)
def list_invite_redemptions(request, invite_id: str, page: int = 1, page_size: int = 20):
    queryset = RegistrationInviteRedemption.objects.select_related("user", "invite_code").filter(
        invite_code_id=invite_id
    )
    total = queryset.count()
    safe_page = max(1, page)
    safe_page_size = max(1, min(page_size, 100))
    rows = list(queryset[(safe_page - 1) * safe_page_size:safe_page * safe_page_size])
    return AdminInviteRedemptionListResponseSchema(
        items=[
            AdminInviteRedemptionItemSchema(
                id=str(row.id),
                user_id=str(row.user_id),
                user_display_name=row.user.get_display_name(),
                user_email=row.user.email,
                user_phone=row.user.phone,
                identifier_hash=row.identifier_hash,
                entrypoint=row.entrypoint,
                ip_address=row.ip_address,
                user_agent=row.user_agent,
                consumed_at=row.consumed_at,
            )
            for row in rows
        ],
        pagination=_invite_pagination(total, safe_page, safe_page_size),
    )


@router.get("/users", response=AdminUserListResponseSchema, auth=StaffAuth(), tags=["后台用户管理"])
def list_users(
    request,
    keyword: str = "",
    role: str = "all",
    status: str = "all",
    page: int = 1,
    page_size: int = 20,
):
    """后台用户列表（支持按关键词、角色、状态筛选）"""

    role = role.strip().lower()
    status = status.strip().lower()
    if role not in {"all", *VALID_ROLES}:
        raise HttpError(400, "role 参数不合法")
    if status not in {"all", *VALID_STATUSES}:
        raise HttpError(400, "status 参数不合法")

    page = max(page, 1)
    page_size = max(1, min(page_size, 100))

    queryset = User.objects.all()
    trimmed_keyword = keyword.strip()
    if trimmed_keyword:
        queryset = queryset.filter(
            Q(id__icontains=trimmed_keyword)
            | Q(username__icontains=trimmed_keyword)
            | Q(nickname__icontains=trimmed_keyword)
            | Q(email__icontains=trimmed_keyword)
            | Q(phone__icontains=trimmed_keyword)
        )

    if status != "all":
        queryset = queryset.filter(is_active=status == "active")

    if role == "admin":
        queryset = queryset.filter(is_superuser=True)
    elif role == "operator":
        queryset = queryset.filter(is_staff=True, is_superuser=False)
    elif role == "user":
        queryset = queryset.filter(is_staff=False, is_superuser=False)

    queryset = queryset.order_by("-date_joined")

    total = queryset.count()
    total_pages = (total + page_size - 1) // page_size if total else 0
    if total_pages and page > total_pages:
        page = total_pages

    offset = (page - 1) * page_size
    users = list(queryset[offset : offset + page_size])

    user_ids = [str(item.id) for item in users]
    wallet_map, session_count_map = _build_related_maps(user_ids)
    organization_summary_map = _build_organization_summary_map(user_ids)
    items = [
        _serialize_user(item, wallet_map, session_count_map, organization_summary_map)
        for item in users
    ]

    return AdminUserListResponseSchema(
        items=items,
        pagination=AdminUserPaginationSchema(
            total=total,
            page=page,
            page_size=page_size,
            total_pages=total_pages,
        ),
        summary=_build_summary(total),
    )


@router.get(
    "/intent-users",
    response=AdminIntentUserListResponseSchema,
    auth=StaffAuth(),
    tags=["后台用户管理"],
)
def list_intent_users(
    request,
    keyword: str = "",
    page: int = 1,
    page_size: int = 20,
):
    """后台意向用户列表。"""

    page = max(page, 1)
    page_size = max(1, min(page_size, 100))

    queryset = IntentUser.objects.all()
    trimmed_keyword = keyword.strip()
    if trimmed_keyword:
        queryset = queryset.filter(
            Q(id__icontains=trimmed_keyword)
            | Q(phone__icontains=trimmed_keyword)
        )

    queryset = queryset.order_by("-created_at")
    total = queryset.count()
    total_pages = (total + page_size - 1) // page_size if total else 0
    if total_pages and page > total_pages:
        page = total_pages

    offset = (page - 1) * page_size
    rows = list(queryset[offset : offset + page_size])

    return AdminIntentUserListResponseSchema(
        items=[_serialize_intent_user(row) for row in rows],
        pagination=AdminUserPaginationSchema(
            total=total,
            page=page,
            page_size=page_size,
            total_pages=total_pages,
        ),
        summary=AdminIntentUserSummarySchema(
            total_intent_users=IntentUser.objects.count(),
            filtered_intent_users=total,
        ),
    )


@router.post(
    "/dev/users/cleanup-by-phone",
    response=AdminDirtyUserCleanupResponseSchema,
    auth=SuperuserAuth(),
    tags=["后台用户管理"],
)
def cleanup_dirty_user_by_phone(request, payload: AdminDirtyUserCleanupByPhoneRequestSchema):
    """临时开发/测试接口：按手机号清理脏账号及其业务数据。

    默认 dry_run=True 只预览；真实删除必须同时提供 confirm_phone 和
    confirmation=DELETE_DIRTY_USER_DATA。生产环境禁用。
    """
    _assert_dirty_user_cleanup_enabled()

    from .validators import is_phone_number

    from .phone import users_with_phone_aliases

    phone = payload.phone.strip()
    if not is_phone_number(phone):
        raise HttpError(400, "手机号格式不正确")

    matched_qs = users_with_phone_aliases(phone, active_only=False)
    matched_count = matched_qs.count()
    if matched_count == 0:
        raise HttpError(404, "未找到该手机号对应的用户")
    if matched_count != 1:
        raise HttpError(409, f"手机号匹配到 {matched_count} 个用户，拒绝清理")

    user = matched_qs.get()
    user_id = str(user.id)
    username = user.username
    is_self_cleanup = str(request.auth.id) == user_id

    counts_before = _collect_dirty_user_cleanup_counts(user_id)
    search_output = ""
    if payload.include_search:
        search_output = _cleanup_search_traces_for_user(user_id, dry_run=True)

    if payload.dry_run:
        return AdminDirtyUserCleanupResponseSchema(
            success=True,
            message="dry_run 完成；如需真实清理，请传 dry_run=false、confirm_phone 和 confirmation",
            dry_run=True,
            user_id=user_id,
            phone=phone,
            username=username,
            counts_before=counts_before,
            search_cleanup_output=search_output,
        )

    if payload.confirm_phone != phone or payload.confirmation != DIRTY_USER_CLEANUP_CONFIRMATION:
        raise HttpError(
            400,
            f"真实清理需要 confirm_phone 与 phone 一致，并设置 confirmation={DIRTY_USER_CLEANUP_CONFIRMATION}",
        )

    from apps.services.common.db_router import postgres_app_db_alias
    from apps.tabtinspace.services.organization_service import OrganizationService

    with transaction.atomic(using=postgres_app_db_alias()):
        cleanup_stats = OrganizationService.cleanup_user_postgresql_data(user_id)

    if is_self_cleanup:
        delete_result = {
            "deleted_count": 0,
            "deleted_by_model": {},
            "skipped_user_delete": True,
            "reason": "保留当前登录管理员账号，避免影响管理后台登录态",
        }
    else:
        deleted_count, deleted_by_model = user.delete()
        delete_result = {
            "deleted_count": deleted_count,
            "deleted_by_model": deleted_by_model,
        }

    if payload.include_search:
        search_output = _cleanup_search_traces_for_user(user_id, dry_run=False)

    counts_after = _collect_dirty_user_cleanup_counts(user_id)
    try:
        _record_user_action(
            user=request.auth,
            action_type="profile_update",
            request=request,
            description=(
                f"临时清理脏账号数据：phone={phone}, user_id={user_id}, "
                f"username={username or ''}, "
                f"deleted_count={delete_result.get('deleted_count', 0)}, "
                f"skipped_user_delete={delete_result.get('skipped_user_delete', False)}"
            ),
        )
    except Exception:
        pass

    return AdminDirtyUserCleanupResponseSchema(
        success=True,
        message="客户端业务数据清理完成" if is_self_cleanup else "账号脏数据清理完成",
        dry_run=False,
        user_id=user_id,
        phone=phone,
        username=username,
        counts_before=counts_before,
        cleanup_stats=cleanup_stats,
        delete_result=delete_result,
        search_cleanup_output=search_output,
        counts_after=counts_after,
    )

@router.get("/users/{user_id}", response=AdminUserDetailResponseSchema, auth=StaffAuth(), tags=["后台用户管理"])
def get_user_detail(request, user_id: str):
    """后台用户详情（包含会话和行为日志）"""

    user = User.objects.filter(id=user_id).first()
    if user is None:
        raise HttpError(404, _("user_admin.user_not_found"))

    wallet_map, session_count_map = _build_related_maps([user_id])
    organization_summary_map = _build_organization_summary_map([user_id])
    user_data = _serialize_user(user, wallet_map, session_count_map, organization_summary_map)

    sessions = UserSession.objects.filter(user_id=user_id).order_by("-last_activity")[:20]
    actions = UserActionLog.objects.filter(user_id=user_id).order_by("-created_at")[:20]

    return AdminUserDetailResponseSchema(
        user=user_data,
        sessions=[
            AdminUserSessionSchema(
                id=str(item.id),
                session_type=item.session_type,
                ip_address=item.ip_address,
                user_agent=item.user_agent,
                created_at=item.created_at,
                last_activity=item.last_activity,
                expires_at=item.expires_at,
                is_active=item.is_active,
            )
            for item in sessions
        ],
        recent_actions=[
            AdminUserActionLogSchema(
                id=str(item.id),
                action_type=item.action_type,
                description=item.description,
                success=item.success,
                ip_address=item.ip_address,
                created_at=item.created_at,
            )
            for item in actions
        ],
    )


@router.get(
    "/users/{user_id}/organizations",
    response=AdminUserOrganizationListResponseSchema,
    auth=StaffAuth(),
    tags=["后台用户管理"],
)
def list_user_organizations(
    request,
    user_id: str,
    page: int = 1,
    page_size: int = 50,
):
    """后台查看用户加入的组织列表（OrganizationMember）。"""

    if not User.objects.filter(id=user_id).exists():
        raise HttpError(404, _("user_admin.user_not_found"))

    from apps.tabtinspace.models import OrganizationMember

    page = max(page, 1)
    page_size = max(1, min(page_size, 100))

    queryset = (
        OrganizationMember.objects.filter(user_id=user_id)
        .select_related("organization")
        .order_by("-joined_at")
    )
    total = queryset.count()
    total_pages = (total + page_size - 1) // page_size if total else 0
    if total_pages and page > total_pages:
        page = total_pages

    offset = (page - 1) * page_size
    memberships = list(queryset[offset : offset + page_size])

    organizations = [
        AdminUserOrganizationItemSchema(
            membership_id=str(membership.id),
            organization_id=str(membership.organization_id),
            organization_name=membership.organization.name,
            organization_type=getattr(membership.organization, "type", "") or "",
            organization_status=getattr(membership.organization, "status", "") or "",
            is_default=bool(getattr(membership.organization, "is_default", False)),
            role=membership.role,
            member_count=int(getattr(membership.organization, "member_count", 0) or 0),
            owner_id=str(membership.organization.owner_id),
            joined_at=membership.joined_at,
        )
        for membership in memberships
    ]

    return AdminUserOrganizationListResponseSchema(
        organizations=organizations,
        total=total,
        pagination=AdminUserPaginationSchema(
            total=total,
            page=page,
            page_size=page_size,
            total_pages=total_pages,
        ),
    )


@router.get("/users/{user_id}/devices", auth=AdminPermissionAuth("device:view"), tags=["后台设备治理"])
def admin_list_user_devices(request, user_id: str):
    from apps.tabtinspace.models import Device

    if not User.objects.filter(id=user_id).exists():
        raise HttpError(404, "用户不存在")
    items = list(Device.objects.filter(user_id=user_id).select_related("organization", "user").order_by("-updated_at")[:100])
    return {"items": [_serialize_device(item) for item in items], "total": len(items)}


@router.get("/devices", auth=AdminPermissionAuth("device:view"), tags=["后台设备治理"])
def admin_list_devices(
    request,
    user_id: Optional[str] = None,
    status: Optional[str] = None,
    client_type: Optional[str] = None,
):
    from apps.tabtinspace.models import Device

    qs = Device.objects.select_related("organization", "user").order_by("-updated_at")
    if user_id:
        qs = qs.filter(user_id=user_id)
    if status:
        qs = qs.filter(control_status=status)
    if client_type:
        qs = qs.filter(device_type=client_type)
    total = qs.count()
    items = list(qs[:100])
    return {"items": [_serialize_device(item) for item in items], "total": total}


def _get_device_or_404(device_id: str):
    from uuid import UUID
    from django.db.models import Q
    from apps.tabtinspace.models import Device

    query = Q(fingerprint=device_id)
    try:
        query |= Q(id=UUID(str(device_id)))
    except ValueError:
        pass
    device = Device.objects.select_related("organization", "user").filter(query).first()
    if not device:
        raise HttpError(404, "设备不存在")
    return device


@router.get("/devices/{device_id}", auth=AdminPermissionAuth("device:view"), tags=["后台设备治理"])
def admin_get_device(request, device_id: str):
    return _serialize_device(_get_device_or_404(device_id))


@router.post("/devices/{device_id}/block", auth=AdminPermissionAuth("device:block"), tags=["后台设备治理"])
def admin_block_device(request, device_id: str, payload: AdminSensitiveReasonRequest):
    reason = _ensure_sensitive_reason(payload)
    with transaction.atomic():
        device = _get_device_or_404(device_id)
        before = _serialize_device(device)
        device.control_status = "blocked"
        device.blocked_reason = reason
        device.blocked_by_admin_account_id = str(request.auth.id)
        device.blocked_at = timezone.now()
        device.save(update_fields=["control_status", "blocked_reason", "blocked_by_admin_account_id", "blocked_at", "updated_at"])
        after = _serialize_device(device)
        record_admin_sensitive_action(
            request,
            permission_code="device:block",
            action="device.block",
            target_type="device",
            target_id=str(device.id),
            reason=reason,
            ticket_id=payload.ticket_id,
            before_json=before,
            after_json=after,
        )
        try:
            from apps.tabtinspace.services.daemon_token_service import revoke_device_tokens
            revoke_device_tokens(device.fingerprint)
        except Exception:
            _admin_logger.warning("[DeviceAdmin] revoke daemon tokens failed: device=%s", device.fingerprint, exc_info=True)
    return {"success": True, "error_code": "DEVICE_BLOCKED", "device": after}


@router.post("/devices/{device_id}/unblock", auth=AdminPermissionAuth("device:unblock"), tags=["后台设备治理"])
def admin_unblock_device(request, device_id: str, payload: AdminSensitiveReasonRequest):
    reason = _ensure_sensitive_reason(payload)
    with transaction.atomic():
        device = _get_device_or_404(device_id)
        before = _serialize_device(device)
        device.control_status = "active"
        device.blocked_reason = ""
        device.blocked_by_admin_account_id = ""
        device.blocked_at = None
        device.save(update_fields=["control_status", "blocked_reason", "blocked_by_admin_account_id", "blocked_at", "updated_at"])
        after = _serialize_device(device)
        record_admin_sensitive_action(
            request,
            permission_code="device:unblock",
            action="device.unblock",
            target_type="device",
            target_id=str(device.id),
            reason=reason,
            ticket_id=payload.ticket_id,
            before_json=before,
            after_json=after,
        )
    return {"success": True, "error_code": "", "device": after}


@router.post("/users/{user_id}/devices/block-all", auth=AdminPermissionAuth("device:block"), tags=["后台设备治理"])
def admin_block_all_user_devices(request, user_id: str, payload: AdminSensitiveReasonRequest):
    from apps.tabtinspace.models import Device

    reason = _ensure_sensitive_reason(payload)
    if not User.objects.filter(id=user_id).exists():
        raise HttpError(404, "用户不存在")
    with transaction.atomic():
        devices = list(Device.objects.filter(user_id=user_id).order_by("id"))
        before = {"devices": [_serialize_device(item) for item in devices]}
        now = timezone.now()
        updated = Device.objects.filter(user_id=user_id).update(
            control_status="blocked",
            blocked_reason=reason,
            blocked_by_admin_account_id=str(request.auth.id),
            blocked_at=now,
            updated_at=now,
        )
        after_devices = list(Device.objects.filter(user_id=user_id).order_by("id"))
        after = {"devices": [_serialize_device(item) for item in after_devices]}
        record_admin_sensitive_action(
            request,
            permission_code="device:block",
            action="device.block_all_for_user",
            target_type="user",
            target_id=user_id,
            reason=reason,
            ticket_id=payload.ticket_id,
            before_json=before,
            after_json=after,
        )
        try:
            from apps.tabtinspace.services.daemon_token_service import revoke_device_tokens
            for item in after_devices:
                revoke_device_tokens(item.fingerprint)
        except Exception:
            _admin_logger.warning("[DeviceAdmin] bulk revoke daemon tokens failed: user=%s", user_id, exc_info=True)
    return {"success": True, "updated_count": updated, "error_code": "DEVICE_BLOCKED"}


@router.get("/users/{user_id}/sessions", auth=AdminPermissionAuth("session:view"), tags=["后台设备治理"])
def admin_list_user_sessions(request, user_id: str):
    if not User.objects.filter(id=user_id).exists():
        raise HttpError(404, "用户不存在")
    items = list(UserSession.objects.filter(user_id=user_id).order_by("-last_activity")[:100])
    return {"items": [_serialize_session(item) for item in items], "total": len(items)}


@router.post("/sessions/{session_id}/revoke", auth=AdminPermissionAuth("session:revoke"), tags=["后台设备治理"])
def admin_revoke_session(request, session_id: str, payload: AdminSensitiveReasonRequest):
    reason = _ensure_sensitive_reason(payload)
    with transaction.atomic():
        session = UserSession.objects.filter(id=session_id).first()
        if not session:
            raise HttpError(404, "会话不存在")
        before = _serialize_session(session)
        session.is_active = False
        session.revoked_at = timezone.now()
        session.revoked_by_admin_account_id = str(request.auth.id)
        session.revoked_reason = reason
        session.save(update_fields=["is_active", "revoked_at", "revoked_by_admin_account_id", "revoked_reason"])
        after = _serialize_session(session)
        record_admin_sensitive_action(
            request,
            permission_code="session:revoke",
            action="session.revoke",
            target_type="session",
            target_id=session_id,
            reason=reason,
            ticket_id=payload.ticket_id,
            before_json=before,
            after_json=after,
        )
    return {"success": True, "error_code": "SESSION_REVOKED", "session": after}


@router.post("/users/{user_id}/sessions/revoke-all", auth=AdminPermissionAuth("session:revoke"), tags=["后台设备治理"])
def admin_revoke_all_user_sessions(request, user_id: str, payload: AdminSensitiveReasonRequest):
    reason = _ensure_sensitive_reason(payload)
    if not User.objects.filter(id=user_id).exists():
        raise HttpError(404, "用户不存在")
    with transaction.atomic():
        sessions = list(UserSession.objects.filter(user_id=user_id, is_active=True).order_by("id"))
        before = {"sessions": [_serialize_session(item) for item in sessions]}
        now = timezone.now()
        updated = UserSession.objects.filter(user_id=user_id, is_active=True).update(
            is_active=False,
            revoked_at=now,
            revoked_by_admin_account_id=str(request.auth.id),
            revoked_reason=reason,
        )
        after_sessions = list(UserSession.objects.filter(user_id=user_id).order_by("id")[:100])
        after = {"sessions": [_serialize_session(item) for item in after_sessions]}
        record_admin_sensitive_action(
            request,
            permission_code="session:revoke",
            action="session.revoke_all_for_user",
            target_type="user",
            target_id=user_id,
            reason=reason,
            ticket_id=payload.ticket_id,
            before_json=before,
            after_json=after,
        )
    return {"success": True, "updated_count": updated, "error_code": "SESSION_REVOKED"}


@router.post(
    "/batch/users/status",
    response=AdminUserBatchMutationResponseSchema,
    auth=AdminPermissionAuth("user:update_status"),
    tags=["后台用户管理"],
)
def batch_update_user_status(request, payload: AdminUserBatchStatusUpdateSchema):
    """批量更新用户账号状态（superuser）

    使用 bulk_update / bulk session invalidation / bulk_create 将 O(3N)
    串行 SQL 降为 O(3) 次批量 SQL。
    """

    status = payload.status.strip().lower()
    if status not in VALID_STATUSES:
        raise HttpError(400, _("user_admin.only_active_or_inactive"))
    if not payload.reason.strip():
        raise HttpError(400, {"message": "批量启停客户用户必须填写原因"})

    user_ids = _normalize_user_ids(payload.user_ids)
    if not user_ids:
        raise HttpError(400, _("user_admin.batch_min_one_user"))
    if len(user_ids) > 500:
        raise HttpError(400, _("user_admin.batch_max_500_users"))

    target_active = status == "active"
    user_map = {str(item.id): item for item in User.objects.filter(id__in=user_ids)}

    updated_users: List = []
    before_status_map: Dict[str, str] = {}
    skipped: List[AdminBatchSkipItemSchema] = []

    for user_id in user_ids:
        user = user_map.get(user_id)
        if user is None:
            skipped.append(AdminBatchSkipItemSchema(user_id=user_id, reason="用户不存在"))
            continue
        if str(request.auth.id) == user_id and not target_active:
            skipped.append(AdminBatchSkipItemSchema(user_id=user_id, reason="不能停用当前登录账号"))
            continue
        if user.is_active == target_active:
            skipped.append(
                AdminBatchSkipItemSchema(
                    user_id=user_id,
                    reason="状态未变化",
                )
            )
            continue

        before_status_map[user_id] = "active" if user.is_active else "inactive"
        user.is_active = target_active
        if target_active and (user.failed_login_attempts != 0 or user.last_failed_login is not None):
            user.failed_login_attempts = 0
            user.last_failed_login = None
        updated_users.append(user)

    if updated_users:
        with transaction.atomic():
            User.objects.bulk_update(
                updated_users,
                ["is_active", "failed_login_attempts", "last_failed_login"],
            )

            if not target_active:
                deactivated_ids = [str(u.id) for u in updated_users]
                UserSession.objects.filter(
                    user_id__in=deactivated_ids, is_active=True,
                ).update(is_active=False)
                for uid in deactivated_ids:
                    _schedule_account_collab_revoke(uid)

        if not target_active:
            from apps.services.tools import invalidate_user_cache
            from apps.tabchat.centrifugo_proxy import disconnect_centrifugo_user
            for u in updated_users:
                uid = str(u.id)
                disconnect_centrifugo_user(uid)
                _cancel_active_agent_runs(uid)
                invalidate_user_cache(uid)

        ip_address = get_client_ip(request)
        user_agent = get_user_agent(request)
        action_type = "account_unlock" if target_active else "account_lock"
        operator_desc = f"{request.auth.get_display_name()}({request.auth.id})"
        status_label = "启用" if target_active else "停用"

        action_logs = [
            UserActionLog(
                user=u,
                action_type=action_type,
                description=f"后台批量{status_label}账号，操作人={operator_desc}",
                ip_address=ip_address,
                user_agent=user_agent,
                success=True,
            )
            for u in updated_users
        ]
        try:
            UserActionLog.objects.bulk_create(action_logs)
        except Exception:
            pass

        cache_keys = []
        for u in updated_users:
            uid = u.id
            cache_keys.extend([f"user:{uid}", f"user_profile:{uid}", f"user_permissions:{uid}"])
        if cache_keys:
            cache.delete_many(cache_keys)

        affected_user_ids = [str(item.id) for item in updated_users]
        affected_preview = affected_user_ids[:50]
        target_id = affected_preview[0] if len(affected_preview) == 1 else "batch"
        record_admin_sensitive_action(
            request,
            permission_code="user:update_status",
            action="customer_user.batch_update_status",
            target_type="user",
            target_id=target_id,
            reason=payload.reason,
            ticket_id=payload.ticket_id,
            before_json={
                "status_before_map": before_status_map,
                "affected_user_ids_preview": affected_preview,
                "affected_user_ids_total": len(affected_user_ids),
            },
            after_json={
                "status": status,
                "updated_count": len(updated_users),
                "affected_user_ids_preview": affected_preview,
                "affected_user_ids_total": len(affected_user_ids),
            },
        )

    wallet_map, session_count_map = _build_related_maps(
        [str(item.id) for item in updated_users]
    )

    return AdminUserBatchMutationResponseSchema(
        success=True,
        message=_("user_admin.batch_status_done", success=len(updated_users), skipped=len(skipped)),
        requested_count=len(user_ids),
        processed_count=len(updated_users),
        updated_count=len(updated_users),
        skipped=skipped,
        items=[
            _serialize_user(item, wallet_map, session_count_map)
            for item in updated_users
        ],
    )

# Deprecated: use AdminAccount role assignment APIs instead.
@router.post(
    "/batch/users/role",
    response=AdminUserBatchMutationResponseSchema,
    auth=SuperuserAuth(),
    tags=["后台用户管理"],
)
def batch_update_user_role(request, payload: AdminUserBatchRoleUpdateSchema):
    """Deprecated: use AdminAccount role assignment APIs instead."""

    role = payload.role.strip().lower()
    if role not in VALID_ROLES:
        raise HttpError(400, _("user_admin.only_admin_operator_user"))
    if not payload.reason.strip():
        raise HttpError(400, {"message": "Deprecated 批量角色接口必须填写原因"})

    user_ids = _normalize_user_ids(payload.user_ids)
    if not user_ids:
        raise HttpError(400, _("user_admin.batch_min_one_user"))
    if len(user_ids) > 500:
        raise HttpError(400, _("user_admin.batch_max_500_users"))

    user_map = {str(item.id): item for item in User.objects.filter(id__in=user_ids)}
    updated_users = []
    skipped: List[AdminBatchSkipItemSchema] = []
    old_role_summary: Dict[str, int] = {}

    for user_id in user_ids:
        user = user_map.get(user_id)
        if user is None:
            skipped.append(AdminBatchSkipItemSchema(user_id=user_id, reason="用户不存在"))
            continue
        if str(request.auth.id) == user_id and role != "admin":
            skipped.append(
                AdminBatchSkipItemSchema(
                    user_id=user_id,
                    reason="不能降级当前登录管理员账号",
                )
            )
            continue

        old_role = _resolve_user_role(user)
        if old_role == role:
            skipped.append(AdminBatchSkipItemSchema(user_id=user_id, reason="角色未变化"))
            continue

        old_role_summary[old_role] = old_role_summary.get(old_role, 0) + 1
        _apply_role_mutation(user, role)
        user.save(update_fields=["is_staff", "is_superuser"])
        updated_users.append(user)

        _record_user_action(
            user=user,
            action_type="profile_update",
            request=request,
            description=(
                f"后台批量调整角色：{old_role} -> {role}，"
                f"操作人={request.auth.get_display_name()}({request.auth.id})"
            ),
        )

    affected_user_ids = [str(item.id) for item in updated_users]
    affected_preview = affected_user_ids[:50]
    total_user_count = len(affected_user_ids)
    target_id = affected_preview[0] if total_user_count == 1 else "batch"
    record_admin_sensitive_action(
        request,
        permission_code="admin_account:assign_role",
        action="deprecated_batch_user_role_update",
        target_type="batch_user_role",
        target_id=target_id,
        reason=payload.reason,
        ticket_id=payload.ticket_id,
        before_json={
            "affected_count": total_user_count,
            "user_ids_preview": affected_preview,
            "total_user_count": total_user_count,
            "old_role_summary": old_role_summary,
        },
        after_json={
            "affected_count": total_user_count,
            "user_ids_preview": affected_preview,
            "total_user_count": total_user_count,
            "new_role": role,
            "old_role_summary": old_role_summary,
            "deprecated_notice": "Deprecated: use AdminAccount role assignment APIs instead.",
        },
    )

    wallet_map, session_count_map = _build_related_maps(
        [str(item.id) for item in updated_users]
    )

    return AdminUserBatchMutationResponseSchema(
        success=True,
        message=(
            f"{_('user_admin.batch_role_done', success=len(updated_users), skipped=len(skipped))} "
            "Deprecated: use AdminAccount role assignment APIs instead."
        ),
        requested_count=len(user_ids),
        processed_count=len(updated_users),
        updated_count=len(updated_users),
        skipped=skipped,
        items=[
            _serialize_user(item, wallet_map, session_count_map)
            for item in updated_users
        ],
    )

@router.post("/audit/export", auth=StaffAuth(), tags=["后台用户管理"])
def export_audit_logs(request, payload: AdminAuditExportRequestSchema):
    """导出审计日志（CSV）"""

    user_ids = _normalize_user_ids(payload.user_ids)
    limit = max(1, min(payload.limit, 20000))

    queryset = UserActionLog.objects.select_related("user").all()
    if user_ids:
        queryset = queryset.filter(user_id__in=user_ids)
    if payload.action_type:
        queryset = queryset.filter(action_type=payload.action_type.strip())
    if payload.success is not None:
        queryset = queryset.filter(success=payload.success)
    if payload.start_at:
        queryset = queryset.filter(created_at__gte=payload.start_at)
    if payload.end_at:
        queryset = queryset.filter(created_at__lte=payload.end_at)

    keyword = payload.keyword.strip() if payload.keyword else ""
    if keyword:
        queryset = queryset.filter(
            Q(user_id__icontains=keyword)
            | Q(user__username__icontains=keyword)
            | Q(user__nickname__icontains=keyword)
            | Q(user__email__icontains=keyword)
            | Q(user__phone__icontains=keyword)
            | Q(action_type__icontains=keyword)
            | Q(description__icontains=keyword)
            | Q(ip_address__icontains=keyword)
        )

    logs = list(queryset.order_by("-created_at")[:limit])

    stream = io.StringIO()
    writer = csv.writer(stream)
    writer.writerow(
        [
            "log_id",
            "user_id",
            "display_name",
            "username",
            "email",
            "phone",
            "action_type",
            "success",
            "ip_address",
            "created_at",
            "description",
            "error_message",
            "user_agent",
        ]
    )

    for item in logs:
        user = item.user
        writer.writerow(
            [
                str(item.id),
                str(user.id),
                user.get_display_name(),
                user.username or "",
                user.email or "",
                user.phone or "",
                item.action_type,
                "success" if item.success else "failed",
                item.ip_address,
                timezone.localtime(item.created_at).strftime("%Y-%m-%d %H:%M:%S"),
                item.description or "",
                item.error_message or "",
                item.user_agent or "",
            ]
        )

    response = HttpResponse(
        "\ufeff" + stream.getvalue(),
        content_type="text/csv; charset=utf-8",
    )
    filename = f"audit_logs_{timezone.localtime().strftime('%Y%m%d_%H%M%S')}.csv"
    response["Content-Disposition"] = f'attachment; filename="{filename}"'

    _record_user_action(
        user=request.auth,
        action_type="profile_update",
        request=request,
        description=f"后台导出审计日志，共 {len(logs)} 条",
    )
    return response

@router.put(
    "/users/{user_id}/status",
    response=AdminUserMutationResponseSchema,
    auth=AdminPermissionAuth("user:update_status"),
    tags=["后台用户管理"],
)
def update_user_status(request, user_id: str, payload: AdminUserStatusUpdateSchema):
    """更新用户账号状态（superuser）"""

    status = payload.status.strip().lower()
    if status not in VALID_STATUSES:
        raise HttpError(400, _("user_admin.only_active_or_inactive"))
    if not payload.reason.strip():
        raise HttpError(400, {"message": "启停客户用户必须填写原因"})
    if str(request.auth.id) == user_id and status != "active":
        raise HttpError(400, _("user_admin.cannot_deactivate_self"))

    user = User.objects.filter(id=user_id).first()
    if user is None:
        raise HttpError(404, _("user_admin.user_not_found"))

    before_status = "active" if user.is_active else "inactive"
    user.is_active = status == "active"
    update_fields = ["is_active"]
    if user.is_active:
        user.failed_login_attempts = 0
        user.last_failed_login = None
        update_fields.extend(["failed_login_attempts", "last_failed_login"])

    with transaction.atomic():
        user.save(update_fields=update_fields)
        if not user.is_active:
            SessionManager.invalidate_all_user_sessions(user_id)
            _schedule_account_collab_revoke(user_id)

    if not user.is_active:
        from apps.tabchat.centrifugo_proxy import disconnect_centrifugo_user
        disconnect_centrifugo_user(str(user_id))
        _cancel_active_agent_runs(user_id)
        from apps.services.tools import invalidate_user_cache
        invalidate_user_cache(user_id)

    record_admin_sensitive_action(
        request,
        permission_code="user:update_status",
        action="customer_user.update_status",
        target_type="user",
        target_id=user_id,
        reason=payload.reason,
        ticket_id=payload.ticket_id,
        before_json={"status": before_status},
        after_json={"status": status},
    )

    wallet_map, session_count_map = _build_related_maps([user_id])
    return AdminUserMutationResponseSchema(
        success=True,
        message=_("user_admin.user_status_updated"),
        user=_serialize_user(user, wallet_map, session_count_map),
    )

# Deprecated: use AdminAccount role assignment APIs instead.
@router.put(
    "/users/{user_id}/role",
    response=AdminUserMutationResponseSchema,
    auth=SuperuserAuth(),
    tags=["后台用户管理"],
)
def update_user_role(request, user_id: str, payload: AdminUserRoleUpdateSchema):
    """Deprecated: use AdminAccount role assignment APIs instead."""

    role = payload.role.strip().lower()
    if role not in VALID_ROLES:
        raise HttpError(400, _("user_admin.only_admin_operator_user"))
    if not payload.reason.strip():
        raise HttpError(400, {"message": "Deprecated 角色接口必须填写原因"})
    if str(request.auth.id) == user_id and role != "admin":
        raise HttpError(400, _("user_admin.cannot_demote_self"))

    user = User.objects.filter(id=user_id).first()
    if user is None:
        raise HttpError(404, _("user_admin.user_not_found"))

    before_role = _resolve_user_role(user)
    _apply_role_mutation(user, role)
    user.save(update_fields=["is_staff", "is_superuser"])
    record_admin_sensitive_action(
        request,
        permission_code="admin_account:assign_role",
        action="deprecated_user_role_update",
        target_type="user",
        target_id=user_id,
        reason=payload.reason,
        ticket_id=payload.ticket_id,
        before_json={
            "role": before_role,
            "is_staff": before_role in {"admin", "operator"},
            "is_superuser": before_role == "admin",
        },
        after_json={
            "role": role,
            "is_staff": role in {"admin", "operator"},
            "is_superuser": role == "admin",
            "deprecated_notice": "Deprecated: use AdminAccount role assignment APIs instead.",
        },
    )

    wallet_map, session_count_map = _build_related_maps([user_id])
    return AdminUserMutationResponseSchema(
        success=True,
        message=f"{_('user_admin.user_role_updated')} Deprecated: use AdminAccount role assignment APIs instead.",
        user=_serialize_user(user, wallet_map, session_count_map),
    )

# ── 用户钱包交易记录与管理员充值 ──

@router.get(
    "/users/{user_id}/wallet/transactions",
    response=AdminWalletTransactionsResponseSchema,
    auth=StaffAuth(),
    tags=["后台用户管理"],
)
def get_user_wallet_transactions(
    request,
    user_id: str,
    transaction_type: Optional[str] = None,
    page: int = 1,
    page_size: int = 20,
):
    """查询用户的钱包交易记录"""

    user = User.objects.filter(id=user_id).first()
    if user is None:
        raise HttpError(404, _("user_admin.user_not_found"))

    wallet = _find_personal_wallet(user_id)
    if wallet is None:
        return AdminWalletTransactionsResponseSchema(
            wallet_id=None,
            credits=0,
            credits_precise=0,
            credits_frozen=0,
            transactions=[],
            total=0,
            page=page,
            page_size=page_size,
            total_pages=0,
        )

    qs = WalletTransaction.objects.filter(organization_wallet=wallet).order_by("-created_at")
    if transaction_type:
        qs = qs.filter(transaction_type=transaction_type)

    items, pg = _paginate_qs(qs, page, page_size, max_size=100)

    operator_ids = {tx.operator_user_id for tx in items if tx.operator_user_id}
    operator_name_map: dict[str, str] = {}
    if operator_ids:
        for u in User.objects.filter(id__in=operator_ids).only("id", "nickname", "username"):
            operator_name_map[str(u.id)] = u.nickname or u.username or str(u.id)[:8]

    transactions = [
        AdminWalletTransactionSchema(
            id=str(tx.id),
            transaction_type=tx.transaction_type,
            amount=tx.amount,
            amount_precise=tx.amount_precise,
            balance_before=tx.balance_before,
            balance_before_precise=tx.balance_before_precise,
            balance_after=tx.balance_after,
            balance_after_precise=tx.balance_after_precise,
            description=tx.description or "",
            operator_user_id=str(tx.operator_user_id or ""),
            operator_display_name=operator_name_map.get(str(tx.operator_user_id or ""), ""),
            related_order_id=str(tx.related_order_id or ""),
            # organization_id 可能是 UUID；Schema 要 str，否则账单弹窗 500（ 同型）
            organization_id=str(tx.organization_id or ""),
            created_at=tx.created_at,
        )
        for tx in items
    ]

    return AdminWalletTransactionsResponseSchema(
        wallet_id=str(wallet.id),
        credits=wallet.credits,
        credits_precise=wallet.credits_precise,
        credits_frozen=wallet.credits_frozen,
        transactions=transactions,
        **pg,
    )

@router.post(
    "/users/{user_id}/wallet/recharge",
    response=AdminUserRechargeResponseSchema,
    auth=SuperuserAuth(),
    tags=["后台用户管理"],
)
def admin_recharge_user_wallet(
    request,
    user_id: str,
    data: AdminUserRechargeRequestSchema,
):
    """管理员给用户充值点券"""

    user = User.objects.filter(id=user_id).first()
    if user is None:
        raise HttpError(404, _("user_admin.user_not_found"))

    if data.amount <= 0:
        raise HttpError(400, _("user_admin.recharge_amount_positive"))
    if data.amount > 100000:
        raise HttpError(400, _("user_admin.recharge_amount_max"))

    from apps.users.wallet.services.organization_wallet_service import OrganizationWalletService
    from apps.users.wallet.exceptions import TransactionFailedError

    wallet_service = OrganizationWalletService()

    personal_wallet = _find_personal_wallet(user_id)
    if personal_wallet is None:
        raise HttpError(404, _("user_admin.user_wallet_not_found"))
    organization_id = personal_wallet.organization_id

    description = data.description.strip() if data.description else ""
    if not description:
        admin_name = getattr(request.auth, "username", "") or str(request.auth.id)[:8]
        description = f"管理员 {admin_name} 手动充值"

    admin_user_id = str(request.auth.id)

    try:
        tx = wallet_service.grant_credits(
            organization_id=organization_id,
            credits_amount=data.amount,
            description=description,
            user_id=admin_user_id,
        )
    except TransactionFailedError as e:
        raise HttpError(400, str(e))

    _record_user_action(
        user=user,
        action_type="admin_recharge",
        request=request,
        description=f"管理员充值 {data.amount} credits: {description}",
        success=True,
    )

    return AdminUserRechargeResponseSchema(
        success=True,
        message=_("user_admin.recharge_success", amount=data.amount),
        wallet_id=str(tx.organization_wallet_id) if tx.organization_wallet_id else "",
        credits_before=tx.balance_before,
        credits_after=tx.balance_after,
        amount=data.amount,
    )
