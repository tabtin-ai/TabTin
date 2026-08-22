import json

import pytest
from pydantic import ValidationError


def test_show_flow_view_input_rejects_cycles():
    from apps.services.tools.domains.common.show_flow_view import ShowFlowViewInput

    with pytest.raises(ValidationError, match="cycle"):
        ShowFlowViewInput(
            title="异常流程",
            summary="异常流程",
            nodes=[
                {"id": "a", "parent_id": "b", "label": "A"},
                {"id": "b", "parent_id": "a", "label": "B"},
            ],
        )


def test_show_flow_view_tool_outputs_semantic_flow_and_safe_html():
    from apps.services.tools.domains.common.show_flow_view import ShowFlowViewTool

    result = json.loads(ShowFlowViewTool().run(
        title="登录排查",
        summary="登录排查流程",
        nodes=[
            {"id": "root", "label": "收集 <证据>", "status": "active"},
            {"id": "cause", "parent_id": "root", "label": "定位根因"},
        ],
        tool_call_id="tool-flow-python-1",
    ))

    assert result["success"] is True
    assert result["__llm_strip__"] == ["_block"]
    block = result["_block"]
    assert block["kind"] == "widget"
    assert block["widget_variant"] == "flow_view"
    assert block["format"] == "html"
    assert block["tool_call_id"] == "tool-flow-python-1"
    assert block["flow_view"]["version"] == 1
    assert block["flow_view"]["nodes"][1]["parent_id"] == "root"
    assert "收集 &lt;证据&gt;" in block["code"]
    assert "<script" not in block["code"].lower()


def test_show_flow_view_is_not_registered_as_a_global_chat_tool():
    from apps.services.tools.domains.common.show_flow_view import ShowFlowViewTool
    from apps.services.tools.domains.common.tool_registry import get_tool_by_name

    compatibility_tool = ShowFlowViewTool()
    assert compatibility_tool.risk_level == "medium"
    assert "已弃用" in compatibility_tool.description
    assert "不得注册到 Agent Chat 通用工具表" in compatibility_tool.description
    assert "TabDoc" in compatibility_tool.description
    assert get_tool_by_name("show_flow_view") is None
