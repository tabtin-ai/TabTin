"""
present_to_user Python 镜像测试。

不依赖 Django 配置，直接验证工具 contract 与 TS agent-runtime 保持一致。
"""
from __future__ import annotations

import json


def test_present_to_user_normalizes_resource_ref_alias(monkeypatch):
    from apps.services.tools.domains.common import present_to_user

    monkeypatch.setattr(
        present_to_user,
        "get_supported_resource_types",
        lambda: frozenset({"table"}),
    )

    result = json.loads(
        present_to_user.PresentToUserTool().run(
            summary="36Kr import result",
            items=[
                {
                    "kind": "resource_ref",
                    "ref": "0021d10c-404d-4528-a091-2741a3e64744",
                    "metadata": {"type": "table"},
                    "summary": "36氪项目库表格",
                }
            ],
        )
    )

    assert result["success"] is True
    assert result["accepted"] == 1
    assert result["_blocks"][0]["resource_type"] == "table"
    assert result["_blocks"][0]["resource_id"] == "0021d10c-404d-4528-a091-2741a3e64744"


def test_present_to_user_resource_ref_error_includes_example(monkeypatch):
    from apps.services.tools.domains.common import present_to_user

    monkeypatch.setattr(
        present_to_user,
        "get_supported_resource_types",
        lambda: frozenset({"table"}),
    )

    result = json.loads(
        present_to_user.PresentToUserTool().run(
            summary="36Kr import result",
            items=[
                {
                    "kind": "resource_ref",
                    "ref": "0021d10c-404d-4528-a091-2741a3e64744",
                    "summary": "36氪项目库表格",
                }
            ],
        )
    )

    assert result["success"] is False
    assert result["error_kind"] == "invalid_param_format"
    assert result["hint"]
    assert "resource_type" in result["errors"][0]
    assert "resource_id" in result["errors"][0]
    assert "metadata: {type}" in result["errors"][0]
