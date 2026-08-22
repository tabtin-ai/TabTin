"""tabmemo 失败路径迁移到标准 error envelope（dict 返回）。"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

from apps.services.tools.domains.tabmemo.memo_tools import (
    TabmemoCreateMemoTool,
    TabmemoGetMemoTool,
)
from apps.services.tools.error_envelope import is_standard_tool_error


def test_create_memo_missing_user_uses_standard_envelope():
    payload = TabmemoCreateMemoTool().run(content="hello", user_id=None)
    assert isinstance(payload, dict)
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "runtime_misconfig"
    assert payload["retryable"] is False
    assert "user" in payload["hint"].lower() or "会话" in payload["hint"]


def test_create_memo_missing_organization_uses_standard_envelope():
    with patch(
        "apps.services.tools.domains.tabmemo.memo_tools._load_user",
        return_value=MagicMock(),
    ):
        payload = TabmemoCreateMemoTool().run(content="hello", user_id="u1")
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "runtime_misconfig"
    assert "organization" in payload["hint"].lower() or "Space" in payload["hint"]


def test_get_memo_invalid_uuid_uses_standard_envelope():
    with patch(
        "apps.services.tools.domains.tabmemo.memo_tools._load_user",
        return_value=MagicMock(),
    ):
        payload = TabmemoGetMemoTool().run(memo_id="not-a-uuid", user_id="u1")
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "invalid_param_format"
    assert "uuid" in payload["hint"].lower() or "memo_id" in payload["hint"]
