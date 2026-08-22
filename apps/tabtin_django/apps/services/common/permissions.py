"""
通用组织权限工具

从 llm/permissions.py 迁移而来——这些函数被 membership、wallet、
channel_gateway 等非 LLM 模块广泛引用，放在 common 更符合语义。
"""

from typing import Optional

import logging

from ninja.errors import HttpError

from apps.i18n import get_text
from apps.tabtinspace.services import OrganizationService

logger = logging.getLogger(__name__)


def ensure_organization_permission_for_user(
    user,
    organization_id: str,
    role: str = "viewer",
) -> None:
    """检查指定用户对组织的权限，不满足则抛 403。

    适用于已持有 user 对象但没有 request 的场景（如 channel_gateway）。
    organization_id 为空时抛出 403，禁止跳过权限检查。
    """
    if not organization_id:
        logger.error("ensure_organization_permission called without organization_id")
        raise HttpError(403, "organization_id is required")
    ws_service = OrganizationService(user=user)
    if not ws_service.check_organization_permission(organization_id, role):
        raise HttpError(403, get_text("llm.organization_access_denied"))


def ensure_organization_permission(
    request,
    organization_id: str,
    role: str = "viewer",
) -> None:
    """检查当前用户对指定组织的权限，不满足则抛 403。

    organization_id 为空时抛出 403，禁止跳过权限检查。
    """
    ensure_organization_permission_for_user(request.auth, organization_id, role)
