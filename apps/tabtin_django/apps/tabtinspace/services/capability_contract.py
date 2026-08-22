from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Dict, Iterable, Optional

from apps.services.repo_root import get_repo_root

_ROOT = get_repo_root()
_CONTRACT_PATH = _ROOT / "packages" / "tabtin-shared" / "src" / "capability-discovery-contract.json"

with _CONTRACT_PATH.open("r", encoding="utf-8") as fp:
    _CONTRACT = json.load(fp)

CAPABILITY_DISCOVERY_SNAPSHOT_VERSION = int(_CONTRACT.get("version", 1) or 1)
CAPABILITY_LEAF_NAMESPACES = tuple(_CONTRACT.get("namespaces", {}).get("leaf", []))
CAPABILITY_CONTAINER_NAMESPACES = tuple(_CONTRACT.get("namespaces", {}).get("container", []))
CAPABILITY_NAMESPACES = tuple(dict.fromkeys([*CAPABILITY_LEAF_NAMESPACES, *CAPABILITY_CONTAINER_NAMESPACES]))
CAPABILITY_DISCOVERY_SOURCES = tuple(_CONTRACT.get("discoverySources", []))
CAPABILITY_RUNTIME_SOURCES = tuple(_CONTRACT.get("snapshotSources", []))
CAPABILITY_MOUNT_STATES = tuple(_CONTRACT.get("mountStates", []))
CAPABILITY_AVAILABILITY_STATES = tuple(_CONTRACT.get("availabilityStates", []))
CAPABILITY_FRESHNESS_STATES = tuple(_CONTRACT.get("freshnessStates", []))
CAPABILITY_POLICY_STATES = tuple(_CONTRACT.get("policyStates", []))
CAPABILITY_REASON_CODES = tuple(_CONTRACT.get("reasonCodes", []))

_SEGMENT_RE = re.compile(r"[^A-Za-z0-9._/-]+")
_REASON_CODE_SET = frozenset(CAPABILITY_REASON_CODES)
_RUNTIME_SOURCE_SET = frozenset(CAPABILITY_RUNTIME_SOURCES)


def sanitize_capability_segment(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    text = re.sub(r"^tabtin:", "", text)
    text = _SEGMENT_RE.sub("-", text)
    text = re.sub(r"-{2,}", "-", text)
    return text.strip("-/")


def build_capability_id(namespace: str, name: Any, owner: Any = None) -> str:
    if namespace not in CAPABILITY_NAMESPACES:
        raise ValueError(f"unsupported capability namespace: {namespace}")
    normalized_name = sanitize_capability_segment(name)
    if not normalized_name:
        raise ValueError(f"capability name is required for namespace {namespace}")
    normalized_owner = sanitize_capability_segment(owner)
    suffix = f"{normalized_owner}/{normalized_name}" if normalized_owner else normalized_name
    return f"{namespace}:{suffix}"


def normalize_reason_codes(raw: Any) -> list[str]:
    if not isinstance(raw, list):
        return []
    seen: set[str] = set()
    result: list[str] = []
    for item in raw:
        if isinstance(item, str) and item in _REASON_CODE_SET and item not in seen:
            seen.add(item)
            result.append(item)
    return result


def _dedupe_items(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    result: list[dict[str, Any]] = []
    for item in items:
        capability_id = str(item.get("capability_id") or "")
        if not capability_id or capability_id in seen:
            continue
        seen.add(capability_id)
        result.append(item)
    return result


def _normalize_tool_item(
    namespace: str,
    raw: Any,
    observed_at: str,
    owner: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    if isinstance(raw, str):
        name = sanitize_capability_segment(raw)
        if not name:
            return None
        return {
            "capability_id": build_capability_id(namespace, name, owner),
            "name": name,
            "observed_at": observed_at or None,
        }

    if not isinstance(raw, dict):
        return None

    name = sanitize_capability_segment(
        raw.get("name")
        or raw.get("tool")
        or raw.get("id")
        or ""
    )
    if not name:
        return None

    capability_id = raw.get("capability_id")
    if not isinstance(capability_id, str) or ":" not in capability_id:
        capability_id = build_capability_id(namespace, name, owner)

    item: dict[str, Any] = {
        "capability_id": capability_id,
        "name": name,
        "observed_at": raw.get("observed_at") if isinstance(raw.get("observed_at"), str) else (observed_at or None),
    }
    reason_codes = normalize_reason_codes(raw.get("reason_codes"))
    if reason_codes:
        item["reason_codes"] = reason_codes
    metadata = raw.get("metadata")
    if isinstance(metadata, dict):
        item["metadata"] = metadata
    source_name = raw.get("source_name")
    if namespace == "mcp_tool" and isinstance(source_name, str) and source_name:
        item["source_name"] = source_name
    return item


def normalize_host_runtime_snapshot(raw: Any, fallback_source: str = "unknown") -> Optional[dict[str, Any]]:
    if not isinstance(raw, dict):
        return None

    reported_at = raw.get("reported_at") if isinstance(raw.get("reported_at"), str) else ""
    source = raw.get("source") if isinstance(raw.get("source"), str) else fallback_source
    if source not in _RUNTIME_SOURCE_SET:
        source = fallback_source if fallback_source in _RUNTIME_SOURCE_SET else "unknown"

    version = raw.get("version")
    if isinstance(version, bool):
        normalized_version = 0
    elif isinstance(version, int):
        normalized_version = max(0, version)
    else:
        normalized_version = 0

    reason_codes = normalize_reason_codes(raw.get("reason_codes"))
    if normalized_version == 0 and "legacy_snapshot" not in reason_codes:
        reason_codes.append("legacy_snapshot")

    runtime_tools = _dedupe_items([
        item
        for item in (
            _normalize_tool_item("runtime_tool", entry, reported_at)
            for entry in (raw.get("runtime_tools") or [])
        )
        if item
    ])

    result: dict[str, Any] = {
        "version": normalized_version,
        "source": source,
        "reported_at": reported_at,
        "runtime_tools": runtime_tools,
    }

    if reason_codes:
        result["reason_codes"] = reason_codes

    metadata = raw.get("metadata")
    if isinstance(metadata, dict):
        result["metadata"] = metadata

    mcp_server = raw.get("mcp_server")
    if isinstance(mcp_server, dict):
        subtype = mcp_server.get("subtype") if isinstance(mcp_server.get("subtype"), str) else None
        tools = _dedupe_items([
            item
            for item in (
                _normalize_tool_item("mcp_tool", entry, reported_at, subtype or "builtin")
                for entry in (mcp_server.get("tools") or [])
            )
            if item
        ])
        normalized_mcp: dict[str, Any] = {
            "running": mcp_server.get("running") is True,
            "tools": tools,
            "observed_at": mcp_server.get("observed_at") if isinstance(mcp_server.get("observed_at"), str) else (reported_at or None),
        }
        if subtype:
            normalized_mcp["subtype"] = subtype
        if isinstance(mcp_server.get("port"), int):
            normalized_mcp["port"] = mcp_server.get("port")
        if isinstance(mcp_server.get("endpoint"), str):
            normalized_mcp["endpoint"] = mcp_server.get("endpoint")
        if isinstance(mcp_server.get("error"), str):
            normalized_mcp["error"] = mcp_server.get("error")
        mcp_reason_codes = normalize_reason_codes(mcp_server.get("reason_codes"))
        if mcp_reason_codes:
            normalized_mcp["reason_codes"] = mcp_reason_codes
        if isinstance(mcp_server.get("metadata"), dict):
            normalized_mcp["metadata"] = mcp_server.get("metadata")
        result["mcp_server"] = normalized_mcp

    return result


def create_runtime_tool_items(names: Iterable[str], observed_at: str = "") -> list[dict[str, Any]]:
    return _dedupe_items([
        item
        for item in (_normalize_tool_item("runtime_tool", name, observed_at) for name in names)
        if item
    ])


def create_mcp_tool_items(
    names: Iterable[str],
    observed_at: str = "",
    owner: str = "builtin",
) -> list[dict[str, Any]]:
    return _dedupe_items([
        item
        for item in (_normalize_tool_item("mcp_tool", name, observed_at, owner) for name in names)
        if item
    ])


__all__ = [
    "CAPABILITY_AVAILABILITY_STATES",
    "CAPABILITY_CONTAINER_NAMESPACES",
    "CAPABILITY_DISCOVERY_SNAPSHOT_VERSION",
    "CAPABILITY_DISCOVERY_SOURCES",
    "CAPABILITY_FRESHNESS_STATES",
    "CAPABILITY_LEAF_NAMESPACES",
    "CAPABILITY_MOUNT_STATES",
    "CAPABILITY_NAMESPACES",
    "CAPABILITY_POLICY_STATES",
    "CAPABILITY_REASON_CODES",
    "CAPABILITY_RUNTIME_SOURCES",
    "build_capability_id",
    "create_mcp_tool_items",
    "create_runtime_tool_items",
    "normalize_host_runtime_snapshot",
    "normalize_reason_codes",
    "sanitize_capability_segment",
]
