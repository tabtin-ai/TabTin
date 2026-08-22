"""web_search 示范迁移：失败路径走共享 error_envelope，外部语义不变。"""
from __future__ import annotations

import json
from unittest.mock import patch

from apps.services.tools.domains.common.web_search import WebSearchTool
from apps.services.tools.error_envelope import is_standard_tool_error


def test_web_search_missing_term_uses_standard_envelope():
    tool = WebSearchTool()
    raw = tool.run(search_term="   ")
    payload = json.loads(raw)
    assert is_standard_tool_error(payload)
    assert payload["error"] == "search_term is required"
    assert payload["error_kind"] == "missing_required_param"
    assert "search_term" in payload["hint"]
    assert payload["retryable"] is False


def test_python_legacy_tool_does_not_forward_agent_identity_arguments():
    tool = WebSearchTool()

    with patch(
        "apps.services.tools.domains.common._web_helpers.do_web_search",
        return_value=json.dumps({"success": True}),
    ) as do_search:
        tool.run(
            search_term="OpenAI",
            user_id="11111111-1111-1111-1111-111111111111",
            organization_id="22222222-2222-2222-2222-222222222222",
        )

    assert "agent_run_id" not in do_search.call_args.kwargs
    assert "client_tool_invocation_component" not in do_search.call_args.kwargs


def test_python_tool_call_id_does_not_activate_agent_identity():
    tool = WebSearchTool()

    with patch(
        "apps.services.tools.domains.common._web_helpers.do_web_search",
        return_value=json.dumps({"success": True}),
    ) as do_search:
        tool.invoke(
            {
                "id": "tool-python-injected-123",
                "name": "web_search",
                "args": {
                    "search_term": "OpenAI",
                    "user_id": "22222222-2222-2222-2222-222222222222",
                    "organization_id": "33333333-3333-3333-3333-333333333333",
                    "agent_run_id": "11111111-1111-1111-1111-111111111111",
                    "client_tool_invocation_component": "forged-component",
                },
                "type": "tool_call",
            }
        )

    assert do_search.call_args.kwargs["user_id"] == "22222222-2222-2222-2222-222222222222"
    assert (
        do_search.call_args.kwargs["organization_id"]
        == "33333333-3333-3333-3333-333333333333"
    )
    assert "agent_run_id" not in do_search.call_args.kwargs
    assert "client_tool_invocation_component" not in do_search.call_args.kwargs
