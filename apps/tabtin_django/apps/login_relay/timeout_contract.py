"""Login Relay 同步导入等待的跨运行时与发布兼容契约。

Electron 在构建时直接导入同目录的 ``timeout-contract.json``，Django 在运行时
加载它。已发布的 v1 客户端可能不带版本头，也可能仍持有旧构建值，因此 v1
服务端等待上限永久冻结；未来只有显式的新协议版本可以使用更高窗口。
"""

from __future__ import annotations

import json
import re
from pathlib import Path


_CONTRACT_PATH = Path(__file__).with_name("timeout-contract.json")
LOGIN_RELAY_PROTOCOL_VERSION_HEADER = "X-TabTin-Login-Relay-Protocol-Version"
_V1_PROTOCOL_VERSION = "v1"
_V1_IMPORT_WAIT_TIMEOUT_SECONDS = 15


def _read_positive_int(field: str) -> int:
    try:
        value = json.loads(_CONTRACT_PATH.read_text(encoding="utf-8"))[field]
    except (KeyError, OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"登录接力超时契约无效：{field}") from error
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise RuntimeError(f"登录接力超时契约无效：{field}")
    return value


def _read_protocol_version() -> str:
    try:
        value = json.loads(_CONTRACT_PATH.read_text(encoding="utf-8"))["protocol_version"]
    except (KeyError, OSError, json.JSONDecodeError) as error:
        raise RuntimeError("登录接力超时契约无效：protocol_version") from error
    if not isinstance(value, str) or re.fullmatch(r"v[1-9]\d*", value) is None:
        raise RuntimeError("登录接力超时契约无效：protocol_version")
    return value


LOGIN_RELAY_PROTOCOL_VERSION = _read_protocol_version()
IMPORT_WAIT_TIMEOUT_SECONDS = _read_positive_int("import_wait_timeout_seconds")
UPLOAD_RESPONSE_GRACE_MS = _read_positive_int("upload_response_grace_ms")


def resolve_import_wait_timeout_seconds(
    protocol_version: str | None,
    configured_wait_seconds: int,
) -> int:
    """Return the synchronous wait safe for the caller's published protocol.

    Missing, v1, and unknown versions are all conservative v1 callers. When a
    future release raises the configured wait, it must also publish and receive
    a new current protocol version before the server may use that larger value.
    """
    normalized_version = (protocol_version or "").strip()
    if (
        normalized_version == LOGIN_RELAY_PROTOCOL_VERSION
        and normalized_version != _V1_PROTOCOL_VERSION
    ):
        return configured_wait_seconds
    return min(configured_wait_seconds, _V1_IMPORT_WAIT_TIMEOUT_SECONDS)
