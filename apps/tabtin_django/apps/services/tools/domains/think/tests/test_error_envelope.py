"""think 域（仅 tool_search）失败路径迁移到标准 error envelope。"""
from __future__ import annotations

import json

from apps.services.tools.domains.think.tool_search_tool import ToolSearchTool
from apps.services.tools.error_envelope import is_standard_tool_error


def test_tool_search_missing_query_uses_standard_envelope():
    payload = json.loads(ToolSearchTool().run(query="   "))
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "missing_required_param"
    assert payload["retryable"] is False
