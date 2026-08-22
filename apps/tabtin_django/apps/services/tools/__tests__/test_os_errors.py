"""os_errors 模块单测。可直接 `pytest apps/tabtin_django/apps/services/tools/__tests__/test_os_errors.py` 执行。"""
from __future__ import annotations

import json
import pytest

from apps.tabtin_django.apps.services.tools.os_errors import (
    OS_ERROR_CODES,
    OSToolError,
    as_tool_failure,
    is_os_tool_error_payload,
    parse_os_tool_error,
)


SAMPLE_PAYLOAD = {
    "code": "OS_PERMISSION_DENIED",
    "category": "RemovableVolume",
    "platform": "darwin",
    "path": "/Volumes/MyDisk/x.txt",
    "terminal": True,
    "llm_message": "macOS 拦截了... 请去系统设置开权限然后重启。",
    "raw_detail": "EPERM open",
}


def test_parse_dict_payload():
    err = parse_os_tool_error(SAMPLE_PAYLOAD)
    assert err is not None
    assert err.code == "OS_PERMISSION_DENIED"
    assert err.terminal is True
    assert err.path == "/Volumes/MyDisk/x.txt"


def test_parse_json_string():
    err = parse_os_tool_error(json.dumps(SAMPLE_PAYLOAD))
    assert err is not None
    assert err.code == "OS_PERMISSION_DENIED"


def test_parse_none_returns_none():
    assert parse_os_tool_error(None) is None
    assert parse_os_tool_error("not json") is None
    assert parse_os_tool_error(123) is None


def test_parse_business_error_returns_none():
    assert parse_os_tool_error({"success": False, "message": "user not found"}) is None


def test_explicit_kind_marker_overrides_required_fields():
    payload = {"__kind__": "os_tool_error", "code": "OS_PERMISSION_DENIED", "path": "/x", "llm_message": "msg"}
    assert parse_os_tool_error(payload) is not None


def test_unknown_code_returns_none():
    bad = dict(SAMPLE_PAYLOAD)
    bad["code"] = "MADE_UP"
    assert parse_os_tool_error(bad) is None


def test_is_os_tool_error_payload_helper():
    assert is_os_tool_error_payload(SAMPLE_PAYLOAD) is True
    assert is_os_tool_error_payload({"a": 1}) is False


def test_as_tool_failure_default_hides_raw_detail():
    err = OSToolError.from_dict(SAMPLE_PAYLOAD)
    out = as_tool_failure(err)
    assert out["success"] is False
    assert out["error_kind"] == "os_access"
    assert out["error_code"] == "OS_PERMISSION_DENIED"
    assert out["content"] == SAMPLE_PAYLOAD["llm_message"]
    assert "raw_detail" not in out


def test_as_tool_failure_include_raw_detail():
    err = OSToolError.from_dict(SAMPLE_PAYLOAD)
    out = as_tool_failure(err, include_raw_detail=True)
    assert out.get("raw_detail") == "EPERM open"


def test_to_dict_to_json_roundtrip():
    err = OSToolError.from_dict(SAMPLE_PAYLOAD)
    d = err.to_dict()
    assert d["code"] == "OS_PERMISSION_DENIED"
    j = err.to_json()
    parsed = json.loads(j)
    assert parsed["llm_message"].startswith("macOS")


def test_all_codes_match_typescript_set():
    expected = {
        "OS_PERMISSION_DENIED",
        "OS_AV_BLOCKED",
        "CLOUD_NOT_DOWNLOADED",
        "NETWORK_CREDENTIAL_REQUIRED",
        "PATH_TOO_LONG",
        "DISK_LOCKED",
        "TARGET_BUSY",
        "TARGET_NOT_FOUND",
    }
    assert set(OS_ERROR_CODES) == expected
