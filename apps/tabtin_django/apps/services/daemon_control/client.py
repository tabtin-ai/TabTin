from __future__ import annotations

import base64
import binascii
import hashlib
import re
from urllib.parse import quote, urljoin

import requests
from django.conf import settings

from apps.services.common.ws.protocol import FINGERPRINT_SAFE


class DaemonControlUnavailable(RuntimeError):
    pass


class TargetDeviceUnavailable(ValueError):
    pass


_DEVICE_CREDENTIAL_PATTERN = re.compile(r"^[A-Za-z0-9_-]{43}$")


def _device_credential_sha256(device_credential: str) -> str | None:
    credential = str(device_credential or "")
    if not _DEVICE_CREDENTIAL_PATTERN.fullmatch(credential):
        return None
    try:
        decoded = base64.b64decode(
            credential + "=", altchars=b"-_", validate=True
        )
    except (ValueError, binascii.Error):
        return None
    if len(decoded) != 32:
        return None
    return hashlib.sha256(decoded).hexdigest()


def _service_url(path: str) -> str:
    address = str(getattr(settings, "DAEMON_CONTROL_HTTP_ADDR", "") or "").strip()
    if not address:
        raise DaemonControlUnavailable("DAEMON_CONTROL_HTTP_ADDR is not configured")
    if "://" not in address:
        address = f"http://{address}"
    return urljoin(f"{address.rstrip('/')}/", path)


def _resolve_device(
    *,
    owner_user_id: str,
    path: str,
    expected_device_id: str = "",
    expected_installation_id: str = "",
) -> dict:
    token = str(
        getattr(settings, "DAEMON_CONTROL_INTERNAL_SERVICE_TOKEN", "") or ""
    ).strip()
    if len(token) < 32:
        raise DaemonControlUnavailable(
            "DAEMON_CONTROL_INTERNAL_SERVICE_TOKEN is not configured"
        )

    try:
        response = requests.post(
            _service_url(path),
            json={"owner_user_id": str(owner_user_id).strip()},
            headers={"Authorization": f"Bearer {token}"},
            timeout=5,
            allow_redirects=False,
        )
    except requests.RequestException as exc:
        raise DaemonControlUnavailable("daemon-control request failed") from exc

    if response.status_code in (404, 409):
        raise TargetDeviceUnavailable("目标设备不存在或当前不可接单")
    if response.status_code == 429 or response.status_code >= 500:
        raise DaemonControlUnavailable(
            f"daemon-control returned HTTP {response.status_code}"
        )
    if not 200 <= response.status_code < 300:
        raise DaemonControlUnavailable(
            f"daemon-control returned HTTP {response.status_code}"
        )

    try:
        payload = response.json()
    except ValueError as exc:
        raise DaemonControlUnavailable("daemon-control returned invalid JSON") from exc
    data = payload.get("data") if isinstance(payload, dict) else None
    device = data.get("device") if isinstance(data, dict) else None
    installation_id = (
        str(device.get("installation_id") or "").strip()
        if isinstance(device, dict)
        else ""
    )
    if (
        not isinstance(payload, dict)
        or not payload.get("success")
        or not isinstance(device, dict)
        or str(device.get("owner_user_id") or "") != str(owner_user_id).strip()
        or not FINGERPRINT_SAFE.fullmatch(installation_id)
        or (
            expected_device_id
            and str(device.get("device_id") or "") != expected_device_id
        )
        or (
            expected_installation_id
            and installation_id != expected_installation_id
        )
    ):
        raise DaemonControlUnavailable("daemon-control returned invalid device data")
    return device


def resolve_device(*, owner_user_id: str, device_id: str) -> dict:
    """Resolve an account-owned execution device into its Gateway installation id."""
    device_id = str(device_id).strip()
    return _resolve_device(
        owner_user_id=owner_user_id,
        path=(
            "internal/daemon-control/v1/devices/"
            f"{quote(device_id, safe='')}/resolve"
        ),
        expected_device_id=device_id,
    )


def resolve_device_by_installation(
    *, owner_user_id: str, installation_id: str
) -> dict:
    """Resolve a Workspace device without requiring clients to know control-plane IDs."""
    installation_id = str(installation_id).strip()
    if not FINGERPRINT_SAFE.fullmatch(installation_id):
        raise TargetDeviceUnavailable("目标设备不存在或当前不可接单")
    return _resolve_device(
        owner_user_id=owner_user_id,
        path=(
            "internal/daemon-control/v1/installations/"
            f"{quote(installation_id, safe='')}/resolve"
        ),
        expected_installation_id=installation_id,
    )


def verify_device_credential(
    *, owner_user_id: str, installation_id: str, device_credential: str
) -> bool:
    """Verify that an Electron connection owns the registered installation."""
    installation_id = str(installation_id).strip()
    credential_sha256 = _device_credential_sha256(device_credential)
    if not FINGERPRINT_SAFE.fullmatch(installation_id) or credential_sha256 is None:
        return False

    token = str(
        getattr(settings, "DAEMON_CONTROL_INTERNAL_SERVICE_TOKEN", "") or ""
    ).strip()
    if len(token) < 32:
        raise DaemonControlUnavailable(
            "DAEMON_CONTROL_INTERNAL_SERVICE_TOKEN is not configured"
        )

    path = (
        "internal/daemon-control/v1/installations/"
        f"{quote(installation_id, safe='')}/verify-credential"
    )
    try:
        response = requests.post(
            _service_url(path),
            json={"owner_user_id": str(owner_user_id).strip()},
            headers={
                "Authorization": f"Bearer {token}",
                "X-TabTin-Device-Credential-SHA256": credential_sha256,
            },
            timeout=5,
            allow_redirects=False,
        )
    except requests.RequestException as exc:
        raise DaemonControlUnavailable("daemon-control request failed") from exc

    if response.status_code in (401, 403, 404, 409):
        return False
    if response.status_code == 429 or response.status_code >= 500:
        raise DaemonControlUnavailable(
            f"daemon-control returned HTTP {response.status_code}"
        )
    if not 200 <= response.status_code < 300:
        return False

    try:
        payload = response.json()
    except ValueError as exc:
        raise DaemonControlUnavailable(
            "daemon-control returned invalid JSON"
        ) from exc
    data = payload.get("data") if isinstance(payload, dict) else None
    device = data.get("device") if isinstance(data, dict) else None
    return bool(
        isinstance(payload, dict)
        and payload.get("success")
        and isinstance(device, dict)
        and str(device.get("owner_user_id") or "")
        == str(owner_user_id).strip()
        and str(device.get("installation_id") or "") == installation_id
    )
