"""error_envelope 共享 helper 单测。

钉死 BaseTool 失败路径的标准 envelope：
  success=False + error + error_kind + hint，并可附带必要 context。
"""
from __future__ import annotations

import json

import pytest

from apps.services.tools.error_envelope import (
    REQUIRED_TOOL_ERROR_KEYS,
    build_tool_error,
    is_standard_tool_error,
    json_tool_error,
)


def test_build_tool_error_required_fields():
    payload = build_tool_error(
        "search_term is required",
        error_kind="missing_required_param",
        hint="Provide search_term before calling web_search.",
    )
    assert payload == {
        "success": False,
        "error": "search_term is required",
        "error_kind": "missing_required_param",
        "hint": "Provide search_term before calling web_search.",
    }
    assert set(REQUIRED_TOOL_ERROR_KEYS) <= set(payload)


def test_build_tool_error_includes_context_fields():
    payload = build_tool_error(
        "The search provider could not complete the request.",
        error_kind="upstream_error",
        hint="Retry web_search once.",
        retryable=True,
        upstream_code="search_provider_timeout",
        context={"provider": "bing"},
    )
    assert payload["success"] is False
    assert payload["error_kind"] == "upstream_error"
    assert payload["hint"] == "Retry web_search once."
    assert payload["retryable"] is True
    assert payload["upstream_code"] == "search_provider_timeout"
    assert payload["provider"] == "bing"


def test_build_tool_error_omits_none_optional_fields():
    payload = build_tool_error(
        "x",
        error_kind="internal_error",
        hint="ask for help",
        retryable=None,
        upstream_code=None,
    )
    assert "retryable" not in payload
    assert "upstream_code" not in payload


def test_build_tool_error_rejects_reserved_context_keys():
    with pytest.raises(ValueError, match="reserved"):
        build_tool_error(
            "x",
            error_kind="internal_error",
            hint="h",
            context={"error_kind": "hijack"},
        )


def test_json_tool_error_roundtrip_matches_dict():
    raw = json_tool_error(
        "search_term is required",
        error_kind="missing_required_param",
        hint="Provide search_term before calling web_search.",
        retryable=False,
    )
    parsed = json.loads(raw)
    assert parsed == build_tool_error(
        "search_term is required",
        error_kind="missing_required_param",
        hint="Provide search_term before calling web_search.",
        retryable=False,
    )


def test_is_standard_tool_error_positive_and_negative():
    ok = build_tool_error("e", error_kind="k", hint="h")
    assert is_standard_tool_error(ok) is True
    assert is_standard_tool_error({"success": False, "error": "e"}) is False
    assert is_standard_tool_error({"success": True, "error": "e", "error_kind": "k", "hint": "h"}) is False
    assert is_standard_tool_error("not a mapping") is False
