"""
LLM 服务统一权限工具

将分散在各 api_*.py 中的权限检查逻辑集中管理，
消除重复代码并确保行为一致。

通用的 organization 权限函数已迁移至 ``apps.services.common.permissions``，
此处保留 re-export 以维持向后兼容。
"""

from typing import Optional
from ninja.errors import HttpError
import logging

from apps.i18n import get_text
from apps.services.common.permissions import (  # noqa: F401 — re-export for backward compat
    ensure_organization_permission,
    ensure_organization_permission_for_user,
)

logger = logging.getLogger(__name__)


def require_auth_user_id(request) -> str:
    """从请求中提取经过认证的用户 ID，未认证则抛 401。"""
    auth_user = getattr(request, "auth", None)
    auth_user_id = str(getattr(auth_user, "id", "") or "").strip()
    if not auth_user_id:
        from apps.i18n import _
        raise HttpError(401, _("auth.unauthorized"))
    return auth_user_id


def is_admin_user(user) -> bool:
    """判断用户是否为超级管理员（仅 superuser）。

    staff 用户（运营/客服）不具备管理员权限，不可代操作或查看全平台数据。
    """
    return bool(getattr(user, "is_superuser", False))


def ensure_self_user_id(
    request,
    requested_user_id: Optional[str] = None,
    *,
    organization_id: Optional[str] = None,
) -> str:
    """
    确保调用者只能访问自己的资源。

    常见模式的统一封装：
    1. 提取认证用户 ID
    2. 如果 requested_user_id 非空且与自身不同 → 403
    3. 返回最终的 user_id（始终等于认证用户自身）

    替代原先各 endpoint 中的:
        auth_user_id = str(request.auth.id)
        if user_id and user_id != auth_user_id:
            raise HttpError(403, ...)
        user_id = auth_user_id
    """
    auth_user_id = require_auth_user_id(request)
    if requested_user_id and requested_user_id != auth_user_id:
        raise HttpError(403, get_text("llm.access_denied"))
    return auth_user_id


def ensure_admin_or_self(
    request,
    target_user_id: str,
    *,
    organization_id: Optional[str] = None,
) -> str:
    """
    确保调用者是管理员或正在访问自身资源。

    用于统计/请求记录等需要"管理员可查看全部、普通用户只看自己"的场景。
    返回认证用户 ID。
    """
    auth_user_id = require_auth_user_id(request)
    target = (target_user_id or "").strip()
    if target and target != auth_user_id and not is_admin_user(request.auth):
        raise HttpError(403, get_text("llm.access_denied"))
    return auth_user_id


def resolve_effective_user_id(
    request,
    requested_user_id: Optional[str],
    *,
    organization_id: str,
    allow_admin_override: bool = False,
) -> str:
    """
    解析最终生效的用户 ID（支持管理员代操作）。

    - 普通用户：只能使用自身 ID，同时验证 organization 权限
    - 管理员 + allow_admin_override：可使用任意 requested_user_id，但必须提供 organization_id
    - organization_id 为必填，禁止跳过团队权限检查
    """
    auth_user_id = require_auth_user_id(request)
    normalized_requested = (requested_user_id or "").strip()
    if normalized_requested and normalized_requested != auth_user_id:
        if allow_admin_override and is_admin_user(request.auth):
            if not organization_id:
                raise HttpError(400, get_text("llm.organization_id_required"))
            ensure_organization_permission(request, organization_id, role="viewer")
            return normalized_requested
        raise HttpError(403, get_text("llm.access_denied"))
    ensure_organization_permission(request, organization_id, role="viewer")
    return normalized_requested or auth_user_id
