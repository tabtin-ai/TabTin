"""present_to_user 失败路径迁移到标准 error envelope。"""
from __future__ import annotations

import json

from apps.services.tools.domains.common.present_to_user import PresentToUserTool
from apps.services.tools.error_envelope import is_standard_tool_error


def test_present_to_user_all_invalid_uses_standard_envelope(monkeypatch):
    from apps.services.tools.domains.common import present_to_user

    monkeypatch.setattr(
        present_to_user,
        "get_supported_resource_types",
        lambda: frozenset({"table"}),
    )

    payload = json.loads(
        PresentToUserTool().run(
            summary="bad items",
            items=[{"kind": "image", "summary": "x", "url": "http://insecure.example/a.png"}],
        )
    )
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "invalid_param_format"
    assert payload["retryable"] is False
    assert isinstance(payload["errors"], list)
    assert payload["errors"]
    assert "https://" in payload["errors"][0]


def test_present_to_user_partial_success_keeps_accepted_blocks(monkeypatch):
    from apps.services.tools.domains.common import present_to_user

    monkeypatch.setattr(
        present_to_user,
        "get_supported_resource_types",
        lambda: frozenset({"table"}),
    )

    payload = json.loads(
        PresentToUserTool().run(
            summary="mixed",
            items=[
                {
                    "kind": "resource_ref",
                    "resource_type": "table",
                    "resource_id": "0021d10c-404d-4528-a091-2741a3e64744",
                    "summary": "ok table",
                },
                {"kind": "image", "summary": "bad", "url": "ftp://x"},
            ],
        )
    )
    assert payload["success"] is True
    assert payload["accepted"] == 1
    assert payload["partial_errors"]
    assert "llm_message" in payload
