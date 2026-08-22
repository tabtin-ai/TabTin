from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from typing import Any

from django.db import transaction
from django.utils import timezone
from ninja import Router
from ninja.errors import HttpError

from apps.services.agent_engine.services.frontend_action_service import (
    get_frontend_action_service,
)
from apps.services.common.device_capability_registry import (
    DEVICE_AVAILABLE_STATUSES,
    DEVICE_ROLE_BY_TYPE,
    USER_LEVEL_DEVICE_TYPES,
)
from apps.tabtinspace.models import Device, Workspace
from apps.tabtinspace.services.base import check_space_access
from apps.tabtinspace.services.execution_binding import resolve_control_device
from apps.users.auth.permissions import JWTAuth
from .models import LoginRelayPackage
from .schemas import (
    ConsumeOut,
    CreatePackageIn,
    CreatePackageOut,
    relay_cookie_payload,
)
from .timeout_contract import (
    IMPORT_WAIT_TIMEOUT_SECONDS,
    LOGIN_RELAY_PROTOCOL_VERSION_HEADER,
    resolve_import_wait_timeout_seconds,
)


logger = logging.getLogger(__name__)
router = Router(auth=JWTAuth())

_ELECTRON_DEVICE_TYPE = Device._meta.get_field("device_type").default
_ACTIVE_CONTROL_STATUS = Device._meta.get_field("control_status").default
_LOGIN_RELAY_DEVICE_TYPES = frozenset({_ELECTRON_DEVICE_TYPE}) & USER_LEVEL_DEVICE_TYPES
_LOGIN_RELAY_DEVICE_ROLE = DEVICE_ROLE_BY_TYPE[_ELECTRON_DEVICE_TYPE]
_SAFE_IMPORT_ERROR_CODES = frozenset({
    "invalid_action",
    "consume_failed",
    "invalid_package",
    "domain_mismatch",
    "invalid_cookie",
    "partition_unavailable",
    "cookie_write_failed",
    "target_tab_unavailable",
    "target_tab_mismatch",
    "reload_failed",
    "import_failed",
})


@dataclass(frozen=True)
class ClaimedPackagePayload:
    domain: str
    cookies: list[dict[str, Any]]


def _get_owned_workspace(user, space_id) -> Workspace:
    workspace = Workspace.objects.filter(id=space_id).first()
    if workspace is None or not check_space_access(user, str(space_id), "owner"):
        raise HttpError(404, "执行现场不存在。")
    return workspace


def _normalize_import_result(result: Any) -> dict[str, Any]:
    if not isinstance(result, dict):
        return {"success": False, "error": "timeout"}
    if result.get("success") is not True:
        normalized_failure: dict[str, Any] = {"success": False, "error": "import_failed"}
        error_code = result.get("error_code")
        if isinstance(error_code, str) and error_code in _SAFE_IMPORT_ERROR_CODES:
            normalized_failure["error_code"] = error_code
        return normalized_failure
    normalized: dict[str, Any] = {"success": True}
    result_data = result.get("data")
    imported_count = (
        result_data.get("imported_count")
        if isinstance(result_data, dict)
        else None
    )
    if isinstance(imported_count, int) and not isinstance(imported_count, bool) and imported_count >= 0:
        normalized["imported_count"] = imported_count
    reloaded = result_data.get("reloaded") if isinstance(result_data, dict) else None
    if isinstance(reloaded, bool):
        normalized["reloaded"] = reloaded
    return normalized


def claim_package_payload(*, package_id, user) -> ClaimedPackagePayload | None:
    """Atomically claim and scrub one package.

    A row lock serializes concurrent consumers. Expired packages are scrubbed
    under the same lock and deliberately return no sensitive payload.
    """
    with transaction.atomic():
        package = (
            LoginRelayPackage.objects.select_for_update()
            .filter(id=package_id, user=user)
            .first()
        )
        if package is None:
            raise LoginRelayPackage.DoesNotExist
        if package.status != LoginRelayPackage.Status.PENDING:
            return None

        expired = package.is_expired()
        cookies = package.encrypted_payload
        package.status = LoginRelayPackage.Status.CONSUMED
        package.consumed_at = timezone.now()
        package.encrypted_payload = []
        package.save(update_fields=["status", "consumed_at", "encrypted_payload"])
        if expired:
            return None
        return ClaimedPackagePayload(domain=package.domain, cookies=cookies)


@router.post("/packages", response=CreatePackageOut, exclude_none=True)
def create_package(request, payload: CreatePackageIn):
    workspace = _get_owned_workspace(request.auth, payload.space_id)
    device = resolve_control_device(space=workspace)
    if device is None or getattr(device, "status", None) not in DEVICE_AVAILABLE_STATUSES:
        raise HttpError(409, "执行设备不可用。")
    if (
        getattr(device, "device_type", None) not in _LOGIN_RELAY_DEVICE_TYPES
        or getattr(device, "role", None) != _LOGIN_RELAY_DEVICE_ROLE
        or getattr(device, "control_status", None) != _ACTIVE_CONTROL_STATUS
    ):
        raise HttpError(409, "执行设备不可用。")
    if str(getattr(device, "user_id", "")) != str(request.auth.id):
        raise HttpError(409, "执行设备不可用。")
    fingerprint = str(getattr(device, "fingerprint", "") or "")
    if not fingerprint:
        raise HttpError(409, "执行设备缺少可用标识。")

    package = LoginRelayPackage.objects.create(
        user=request.auth,
        space=workspace,
        target_device=device,
        domain=payload.domain,
        encrypted_payload=relay_cookie_payload(payload.cookies),
    )
    task_id = str(uuid.uuid4())
    action_service = get_frontend_action_service()
    event = {
        "data": {
            "task_id": task_id,
            "type": "login_relay.import",
            "params": {
                "package_id": str(package.id),
                "space_id": str(payload.space_id),
                "organization_id": str(workspace.organization_id),
                "domain": payload.domain,
                **({"tab_id": payload.tab_id} if payload.tab_id else {}),
            },
        },
    }

    try:
        published = action_service.publish_action(
            payload.thread_id,
            event,
            target_device_fingerprint=fingerprint,
        )
    except Exception:
        logger.warning(
            "login relay publish failed: package_id=%s user_id=%s",
            package.id,
            request.auth.id,
        )
        return {
            "package_id": package.id,
            "import_result": {"success": False, "error": "publish_failed"},
        }
    if not published:
        logger.warning(
            "login relay publish reached no device: package_id=%s user_id=%s",
            package.id,
            request.auth.id,
        )
        return {
            "package_id": package.id,
            "import_result": {"success": False, "error": "publish_failed"},
        }

    wait_timeout_seconds = resolve_import_wait_timeout_seconds(
        request.headers.get(LOGIN_RELAY_PROTOCOL_VERSION_HEADER),
        IMPORT_WAIT_TIMEOUT_SECONDS,
    )
    try:
        result = action_service.wait_for_result(
            payload.thread_id,
            task_id,
            wait_timeout_seconds,
        )
    except Exception:
        logger.warning(
            "login relay result wait failed: package_id=%s user_id=%s",
            package.id,
            request.auth.id,
        )
        import_result = {"success": False, "error": "wait_failed"}
    else:
        import_result = _normalize_import_result(result)
    return {"package_id": package.id, "import_result": import_result}


@router.post("/packages/{package_id}/consume", response=ConsumeOut, exclude_none=True)
def consume_package(request, package_id: uuid.UUID):
    try:
        claimed = claim_package_payload(package_id=package_id, user=request.auth)
    except LoginRelayPackage.DoesNotExist:
        raise HttpError(404, "接力包不存在。")
    if claimed is None:
        raise HttpError(410, "接力包已使用或已过期。")
    return {"domain": claimed.domain, "cookies": claimed.cookies}
