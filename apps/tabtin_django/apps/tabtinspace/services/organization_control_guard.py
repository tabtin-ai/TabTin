"""Organization-level client control guard.

The guard centralizes company-side control over client behavior. It should be
called from narrow choke points instead of scattering policy field checks across
business APIs.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


ORGANIZATION_SUSPENDED = "ORGANIZATION_SUSPENDED"
ORGANIZATION_READONLY = "ORGANIZATION_READONLY"
ORGANIZATION_AI_DISABLED = "ORGANIZATION_AI_DISABLED"
ORGANIZATION_RESOURCE_WRITE_DISABLED = "ORGANIZATION_RESOURCE_WRITE_DISABLED"
ORGANIZATION_APP_TOOL_DISABLED = "ORGANIZATION_APP_TOOL_DISABLED"
ORGANIZATION_INVITE_DISABLED = "ORGANIZATION_INVITE_DISABLED"
ORGANIZATION_MEMBER_JOIN_DISABLED = "ORGANIZATION_MEMBER_JOIN_DISABLED"


@dataclass(frozen=True)
class OrganizationControlBlockedError(Exception):
    code: str
    message: str
    http_status: int = 403

    def __str__(self) -> str:
        return self.message

    def to_response_data(self) -> dict[str, Any]:
        return {
            "success": False,
            "error_code": self.code,
            "code": self.code,
            "message": self.message,
            "error_category": "organization_control",
        }


def _get_policy(organization_id: str):
    if not organization_id:
        return None
    from apps.tabtinspace.models import OrganizationControlPolicy

    return OrganizationControlPolicy.objects.filter(organization_id=organization_id).first()


def _raise(code: str, message: str) -> None:
    raise OrganizationControlBlockedError(code=code, message=message)


def assert_organization_access_allowed(organization_id: str) -> None:
    policy = _get_policy(organization_id)
    if policy and policy.is_suspended:
        _raise(ORGANIZATION_SUSPENDED, "团队已暂停，暂时不能进入团队核心能力")


def assert_organization_write_allowed(organization_id: str) -> None:
    policy = _get_policy(organization_id)
    if not policy:
        return
    if policy.is_suspended:
        _raise(ORGANIZATION_SUSPENDED, "团队已暂停，暂时不能写入团队数据")
    if policy.is_readonly:
        _raise(ORGANIZATION_READONLY, "团队已被设置为只读，暂时不能写入")


def assert_organization_ai_allowed(organization_id: str) -> None:
    policy = _get_policy(organization_id)
    if not policy:
        return
    if policy.is_suspended:
        _raise(ORGANIZATION_SUSPENDED, "团队已暂停，暂时不能调用 AI")
    if policy.ai_disabled:
        _raise(ORGANIZATION_AI_DISABLED, "团队 AI 能力已被后台禁用")


def assert_organization_resource_write_allowed(organization_id: str) -> None:
    policy = _get_policy(organization_id)
    if not policy:
        return
    if policy.is_suspended:
        _raise(ORGANIZATION_SUSPENDED, "团队已暂停，暂时不能写入资源")
    if policy.is_readonly:
        _raise(ORGANIZATION_READONLY, "团队已被设置为只读，暂时不能写入资源")
    if policy.resource_write_disabled:
        _raise(ORGANIZATION_RESOURCE_WRITE_DISABLED, "团队资源写入已被后台禁用")


def assert_organization_resource_write_allowed_optional(organization_id: Any) -> None:
    """同 assert_organization_resource_write_allowed，organization_id 为空时跳过。"""
    if not organization_id:
        return
    assert_organization_resource_write_allowed(str(organization_id))


def assert_org_resource_write_for_space(space_id: Any) -> None:
    """按 Space 解析 organization_id 后做资源写入强控（新建文件夹等入口用）。"""
    if not space_id:
        return
    from apps.tabtinspace.models import Project, Workspace

    org_id = (
        Workspace.objects.filter(id=space_id).values_list("organization_id", flat=True).first()
        or Project.objects.filter(id=space_id).values_list("organization_id", flat=True).first()
    )
    assert_organization_resource_write_allowed_optional(org_id)


def organization_control_blocked_response(exc: OrganizationControlBlockedError):
    """统一把强控异常转成 403 JsonResponse，避免各 API 复制粘贴。"""
    from django.http import JsonResponse

    return JsonResponse(exc.to_response_data(), status=exc.http_status)


def assert_organization_app_tool_allowed(organization_id: str) -> None:
    policy = _get_policy(organization_id)
    if not policy:
        return
    if policy.is_suspended:
        _raise(ORGANIZATION_SUSPENDED, "团队已暂停，暂时不能调用 App/Tool")
    if policy.app_tool_disabled:
        _raise(ORGANIZATION_APP_TOOL_DISABLED, "组织 App/Tool 能力已被后台禁用")


def assert_organization_invite_allowed(organization_id: str) -> None:
    policy = _get_policy(organization_id)
    if not policy:
        return
    if policy.is_suspended:
        _raise(ORGANIZATION_SUSPENDED, "组织已暂停，暂时不能邀请成员")
    if policy.invite_disabled:
        _raise(ORGANIZATION_INVITE_DISABLED, "组织邀请已被后台禁用")


def assert_organization_member_join_allowed(organization_id: str) -> None:
    policy = _get_policy(organization_id)
    if not policy:
        return
    if policy.is_suspended:
        _raise(ORGANIZATION_SUSPENDED, "组织已暂停，暂时不能加入")
    if policy.member_join_disabled:
        _raise(ORGANIZATION_MEMBER_JOIN_DISABLED, "组织成员加入已被后台禁用")
