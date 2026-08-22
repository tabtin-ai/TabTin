"""Domain-neutral authorization helpers for collaboration flows."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Literal

from django.contrib.auth import get_user_model

from apps.collab.constants import (
    ADAPTER_RESOURCE_TYPES,
    EDITOR_TYPE_AGENT,
    EDITOR_TYPE_SHARE,
    EDITOR_TYPE_SYSTEM,
    EDITOR_TYPE_USER,
)
from apps.collab.registry import get_adapter_or_raise

logger = logging.getLogger(__name__)

CollabAction = Literal["view", "edit"]
CollabPermission = Literal["view", "edit"]

SYSTEM_POLICY_TRUSTED_INTERNAL = "trusted_internal"
SYSTEM_POLICY_RESOURCE_MAINTENANCE = "resource_ownerless_maintenance"

ALLOWED_SYSTEM_POLICIES = frozenset({
    SYSTEM_POLICY_TRUSTED_INTERNAL,
    SYSTEM_POLICY_RESOURCE_MAINTENANCE,
})


class CollabPermissionError(PermissionError):
    """Raised when a collab actor cannot perform the requested action."""

    def __init__(self, code: str, message: str, *, status_code: int = 403):
        super().__init__(message)
        self.code = code
        self.status_code = status_code


@dataclass(frozen=True)
class CollabResource:
    resource_type: str
    resource_id: str
    adapter: Any
    resource: Any


def parse_collab_document_name(resource_type: str, document_name: str) -> str:
    """Return resource id from a canonical ``{resource_type}:{resource_id}`` name."""
    if resource_type not in ADAPTER_RESOURCE_TYPES:
        raise CollabPermissionError(
            "invalid_collab_module",
            f"resource_type must be one of {','.join(ADAPTER_RESOURCE_TYPES)}",
            status_code=400,
        )
    prefix = f"{resource_type}:"
    if not document_name or not document_name.startswith(prefix):
        raise CollabPermissionError(
            "invalid_document_name",
            f"document_name must start with {prefix}",
            status_code=400,
        )
    resource_id = document_name[len(prefix):]
    if not resource_id:
        raise CollabPermissionError(
            "invalid_document_name",
            "document_name resource id is required",
            status_code=400,
        )
    return resource_id


def resolve_collab_resource(resource_type: str, resource_id: str) -> CollabResource:
    if resource_type not in ADAPTER_RESOURCE_TYPES:
        raise CollabPermissionError(
            "invalid_collab_module",
            f"resource_type must be one of {','.join(ADAPTER_RESOURCE_TYPES)}",
            status_code=400,
        )
    try:
        adapter = get_adapter_or_raise(resource_type)
    except ValueError as exc:
        raise CollabPermissionError(
            "invalid_collab_module",
            str(exc),
            status_code=400,
        ) from exc
    resource = adapter.get_resource(str(resource_id))
    if not resource:
        raise CollabPermissionError(
            "resource_not_found",
            "resource.not_found",
            status_code=404,
        )
    return CollabResource(resource_type, str(resource_id), adapter, resource)


def resolve_collab_permission(user: Any, resource_type: str, resource_id: str) -> CollabPermission | None:
    collab_resource = resolve_collab_resource(resource_type, resource_id)
    if collab_resource.adapter.check_permission(user, collab_resource.resource, "edit"):
        return "edit"
    if collab_resource.adapter.check_permission(user, collab_resource.resource, "view"):
        return "view"
    return None


def resolve_write_subject(
    *,
    editor_type: str,
    editor_id: str = "",
    agent_run_id: str = "",
) -> Any | None:
    """Resolve user-like editor types to the User whose permission is authoritative."""
    User = get_user_model()
    if editor_type == EDITOR_TYPE_USER:
        if not editor_id:
            return None
        try:
            return User.objects.filter(id=editor_id).first()
        except Exception:
            logger.debug("Failed to resolve collab user editor_id=%s", editor_id, exc_info=True)
            return None

    if editor_type == EDITOR_TYPE_AGENT:
        user_id = None
        if agent_run_id:
            try:
                from apps.services.agent_engine.models import ExecutionRun

                user_id = (
                    ExecutionRun.objects
                    .filter(run_id=agent_run_id)
                    .values_list("user_id", flat=True)
                    .first()
                )
            except Exception:
                logger.debug("Failed to resolve ExecutionRun %s for collab auth", agent_run_id, exc_info=True)
        if user_id:
            try:
                resolved = User.objects.filter(id=user_id).first()
                if resolved:
                    return resolved
            except Exception:
                logger.debug("Failed to resolve collab agent owner user_id=%s", user_id, exc_info=True)
        #  / FAR-011：ExecutionRun.user_id 未写入或 run 头缺失时，回退到 editor_id。
        # save_content 已用 JWT 校验权限，editor_id 即发起请求的 User UUID。
        if editor_id:
            try:
                return User.objects.filter(id=editor_id).first()
            except Exception:
                logger.debug(
                    "Failed to resolve collab agent editor_id fallback=%s",
                    editor_id,
                    exc_info=True,
                )
        return None

    if editor_type == EDITOR_TYPE_SYSTEM:
        return None

    if editor_type == EDITOR_TYPE_SHARE:
        _, user_id = _parse_share_guest_user_id(editor_id)
        if not user_id:
            return None
        try:
            return User.objects.filter(id=user_id).first()
        except Exception:
            logger.debug("Failed to resolve share collab user editor_id=%s", editor_id, exc_info=True)
            return None

    return None


def _parse_share_guest_user_id(guest_id: str) -> tuple[str, str | None]:
    from apps.services.common.public_share.collab_token import parse_share_guest_id

    return parse_share_guest_id(guest_id)


def _share_service_cls_for_resource_type(resource_type: str):
    if resource_type == "docs":
        from apps.tabdoc.services.share_service import DocumentShareService

        return DocumentShareService
    if resource_type == "table":
        from apps.tabdata.services.share_service import TableShareService

        return TableShareService
    return None


def _assert_share_collab_write_allowed(
    *,
    editor_id: str,
    resource_type: str,
    resource_id: str,
) -> Any:
    """校验 share grant 写权限并返回真实 User 主体。"""
    from apps.services.common.public_share.exceptions import ShareExpiredError, ShareNotFoundError

    share_id, user_id = _parse_share_guest_user_id(editor_id)
    if not share_id or not user_id:
        raise CollabPermissionError(
            "collab_share_grant_denied",
            "auth.permission_denied",
            status_code=403,
        )

    service_cls = _share_service_cls_for_resource_type(resource_type)
    if service_cls is None:
        raise CollabPermissionError(
            "collab_share_grant_denied",
            "auth.permission_denied",
            status_code=403,
        )

    try:
        share = service_cls.get_share_by_id(share_id)
    except (ShareNotFoundError, ShareExpiredError):
        raise CollabPermissionError(
            "collab_share_grant_denied",
            "auth.permission_denied",
            status_code=403,
        ) from None

    if getattr(share, "permission", "view") != "edit":
        raise CollabPermissionError(
            "collab_share_grant_denied",
            "auth.permission_denied",
            status_code=403,
        )

    resource = service_cls._resource_from_share(share)
    if str(resource.id) != str(resource_id):
        raise CollabPermissionError(
            "collab_share_grant_denied",
            "auth.permission_denied",
            status_code=403,
        )

    User = get_user_model()
    subject = User.objects.filter(id=user_id).first()
    if not subject:
        raise CollabPermissionError(
            "collab_subject_not_resolved",
            "auth.permission_denied",
            status_code=403,
        )
    return subject


def _adapter_allows_system_policy(adapter: Any, resource: Any, system_policy: str) -> bool:
    hook = getattr(adapter, "allows_system_collab_write", None)
    if hook is None:
        return True
    try:
        return bool(hook(resource, system_policy))
    except Exception:
        logger.exception("System collab policy hook failed for policy=%s", system_policy)
        return False


def assert_collab_action_allowed(
    *,
    resource_type: str,
    resource_id: str,
    action: CollabAction,
    editor_type: str,
    editor_id: str = "",
    agent_run_id: str = "",
    system_policy: str = "",
) -> CollabResource:
    """Validate that an editor may perform a collab action on a resource."""
    collab_resource = resolve_collab_resource(resource_type, resource_id)

    if editor_type == EDITOR_TYPE_SYSTEM:
        if system_policy not in ALLOWED_SYSTEM_POLICIES:
            raise CollabPermissionError(
                "collab_system_policy_denied",
                "auth.permission_denied",
                status_code=403,
            )
        if not _adapter_allows_system_policy(collab_resource.adapter, collab_resource.resource, system_policy):
            raise CollabPermissionError(
                "collab_system_policy_denied",
                "auth.permission_denied",
                status_code=403,
            )
        return collab_resource

    if editor_type == EDITOR_TYPE_SHARE:
        _assert_share_collab_write_allowed(
            editor_id=editor_id,
            resource_type=resource_type,
            resource_id=resource_id,
        )
        return collab_resource

    subject = resolve_write_subject(
        editor_type=editor_type,
        editor_id=editor_id,
        agent_run_id=agent_run_id,
    )
    if not subject:
        raise CollabPermissionError(
            "collab_subject_not_resolved",
            "auth.permission_denied",
            status_code=403,
        )

    if not collab_resource.adapter.check_permission(subject, collab_resource.resource, action):
        raise CollabPermissionError(
            "collab_permission_denied",
            "auth.permission_denied",
            status_code=403,
        )
    return collab_resource


def error_response_from_exception(exc: CollabPermissionError) -> tuple[int, dict]:
    return exc.status_code, {
        "status": "error",
        "code": exc.code,
        "message": str(exc),
    }
