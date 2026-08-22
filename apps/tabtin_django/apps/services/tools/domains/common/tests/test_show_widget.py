"""
show_widget Python 镜像测试（Widget Wave 2.2，widget RFC §三 3.1 / §七 🔴 高严重度）。

守住的关键不变量（与 packages/agent-runtime/tests/show-widget.test.ts 字面对齐）：

  1. **risk_level 必须是 'medium'，不能改成 'safe'** — 'safe' 会被 action_tools_adapter
     映射成 TS Tool.isReadOnly = True，让 widget 工具进入 preStartedTools 池在
     LLM 流式期间被提前 execute，烤到半截 SVG（preStart 守卫在
     packages/agent-runtime/src/engine/query.ts:2628）。

  2. **__llm_strip__ 含顶层 ["_block"]** — 巨型 SVG 不回流 LLM next-turn history。
     **注意是顶层 key 不是 dotted path**：v1 曾写 ['_block.code', '_block.image_url']，
     `stripKeysFromResult` (engine/tool-system.ts) / Python strip 都只支持顶层 key，
     dotted path 默默 no-op，整个 5KB SVG 全部回流 LLM history——修法是 strip
     整个 `_block`（与 present_to_user 的 ['_blocks', '_title'] 同层级）。

  3. **支持三格式** — Wave 6 上线支持 svg/html/mermaid。

  4. **拒绝超长 code** — 8KB cap 防 LLM 失控吐 50KB SVG。

  5. **utf-8 字节数计算** — 中文 SVG 不能假性放过（每字符 3 bytes）。

  6. **生成的 _block 含 type/kind/widget_id/format/code/summary** — 前端
     RichContentRenderer 路由层依赖这些字段。

不依赖 Django 配置的纯 Python 测试——通过 ShowWidgetInput 直接验证 schema +
ShowWidgetTool.run 直接验证输出。
"""
from __future__ import annotations

import json

import pytest
from pydantic import ValidationError


# ─── ShowWidgetInput pydantic schema 防线 ─────────────────────────────


def test_show_widget_input_accepts_html_format():
    from apps.services.tools.domains.common.show_widget import ShowWidgetInput

    obj = ShowWidgetInput(summary="x", format="html", code="<div/>")
    assert obj.format == "html"


def test_show_widget_input_accepts_send_prompt_onclick_html():
    from apps.services.tools.domains.common.show_widget import ShowWidgetInput

    html = "<button onclick=\"sendPrompt('详细解释 ingress', { node: 'ingress' })\">Ingress</button>"
    obj = ShowWidgetInput(summary="x", format="html", code=html)
    assert obj.code == html


def test_show_widget_input_accepts_mermaid_format():
    from apps.services.tools.domains.common.show_widget import ShowWidgetInput

    obj = ShowWidgetInput(summary="x", format="mermaid", code="graph TD; A-->B;")
    assert obj.format == "mermaid"


def test_show_widget_input_accepts_svg_format():
    from apps.services.tools.domains.common.show_widget import ShowWidgetInput

    obj = ShowWidgetInput(summary="x", format="svg", code="<svg/>")
    assert obj.format == "svg"


def test_show_widget_input_rejects_unknown_format():
    from apps.services.tools.domains.common.show_widget import ShowWidgetInput

    with pytest.raises(ValidationError) as exc_info:
        ShowWidgetInput(summary="x", format="pdf", code="x")
    assert "format" in str(exc_info.value).lower()


@pytest.mark.parametrize(
    "html",
    [
        '<script src="https://evil.test/x.js"></script>',
        '<a href="javascript:alert(1)">x</a>',
        '<iframe src="https://evil.test"></iframe>',
        '<object data="x"></object>',
        '<embed src="x">',
        '<form action="/x"></form>',
        '<div onclick="alert(1)">x</div>',
        '<div onmouseover="sendPrompt(\'x\')">x</div>',
        '<div onclick="sendPrompt(\'x\'); alert(1)">x</div>',
    ],
)
def test_show_widget_input_rejects_unsafe_html(html: str):
    from apps.services.tools.domains.common.show_widget import ShowWidgetInput

    with pytest.raises(ValidationError):
        ShowWidgetInput(summary="x", format="html", code=html)


def test_show_widget_input_rejects_unsafe_mermaid_click_javascript():
    from apps.services.tools.domains.common.show_widget import ShowWidgetInput

    with pytest.raises(ValidationError):
        ShowWidgetInput(
            summary="x",
            format="mermaid",
            code='graph TD; A-->B; click A "javascript:alert(1)"',
        )


def test_show_widget_input_rejects_empty_code():
    from apps.services.tools.domains.common.show_widget import ShowWidgetInput

    with pytest.raises(ValidationError):
        ShowWidgetInput(summary="x", format="svg", code="")


def test_show_widget_input_rejects_empty_summary():
    """summary 是移动端 fallback + a11y 的兜底文案，不能空。"""
    from apps.services.tools.domains.common.show_widget import ShowWidgetInput

    with pytest.raises(ValidationError):
        ShowWidgetInput(summary="", format="svg", code="<svg/>")


def test_show_widget_input_rejects_oversize_code():
    """8KB cap 防 LLM 失控吐 50KB SVG（widget RFC §七风险登记）。"""
    from apps.services.tools.domains.common.show_widget import ShowWidgetInput

    huge = "<svg>" + ("x" * (9 * 1024)) + "</svg>"
    with pytest.raises(ValidationError) as exc_info:
        ShowWidgetInput(summary="x", format="svg", code=huge)
    assert "8KB" in str(exc_info.value) or "too large" in str(exc_info.value).lower()


def test_show_widget_input_byte_size_uses_utf8_not_character_count():
    """中文每字符 3 bytes —— 9KB 中文 character count 只 3K，不能假性放过。"""
    from apps.services.tools.domains.common.show_widget import ShowWidgetInput

    cn = "<svg>" + ("中" * (3 * 1024)) + "</svg>"  # > 8KB utf-8
    with pytest.raises(ValidationError):
        ShowWidgetInput(summary="x", format="svg", code=cn)


# ─── ShowWidgetTool risk_level / 输出格式防线 ─────────────────────────


def test_show_widget_tool_risk_level_is_not_safe():
    """**核心防线**：risk_level='safe' 会被映射成 TS isReadOnly=True 让工具进
    preStartedTools 池在流式期间被烤到半截 SVG。必须是 'medium'。

    详见 packages/agent-runtime/src/tools/show-widget.ts 同等防线。
    """
    from apps.services.tools.domains.common.show_widget import ShowWidgetTool

    tool = ShowWidgetTool()
    assert tool.risk_level != "safe", (
        "show_widget.risk_level must NOT be 'safe' — see widget RFC §七 🔴 高严重度风险。"
        " 'safe' 会让 action_tools_adapter 把工具标成 isReadOnly=true，被 preStartedTools"
        " 在 LLM 流式期间提前 execute 烤到半截 SVG。"
    )
    assert tool.risk_level == "medium"


def test_show_widget_tool_run_emits_block_with_correct_kind():
    from apps.services.tools.domains.common.show_widget import ShowWidgetTool

    tool = ShowWidgetTool()
    out_str = tool.run(
        summary="k8s 三层架构",
        format="svg",
        code='<svg viewBox="0 0 100 100"><rect/></svg>',
        title="K8s",
    )
    out = json.loads(out_str)

    assert out["success"] is True
    assert "widget_id" in out
    assert out["widget_id"].startswith("wgt_")
    assert out["summary"] == "k8s 三层架构"

    block = out["_block"]
    assert block["type"] == "rich_content"
    assert block["kind"] == "widget"
    assert block["format"] == "svg"
    assert block["code"] == '<svg viewBox="0 0 100 100"><rect/></svg>'
    assert block["summary"] == "k8s 三层架构"
    assert block["title"] == "K8s"
    assert block["widget_id"] == out["widget_id"]


def test_show_widget_tool_run_scrubs_svg_script_and_unsafe_event_handlers():
    from apps.services.tools.domains.common.show_widget import ShowWidgetTool

    dirty = '<svg onload="alert(1)"><script>alert(1)</script><text onclick="sendPrompt(\'解释 A\', { node: \'A\' })">A</text><a href="javascript:alert(1)"><text>B</text></a></svg>'
    out = json.loads(ShowWidgetTool().run(summary="dirty", format="svg", code=dirty))
    cleaned = out["_block"]["code"]
    assert "<svg" in cleaned
    assert "onclick=\"sendPrompt('解释 A', { node: 'A' })\"" in cleaned
    assert "<script" not in cleaned.lower()
    assert "onload=" not in cleaned.lower()
    assert "javascript:" not in cleaned.lower()


def test_show_widget_tool_run_emits_html_block():
    from apps.services.tools.domains.common.show_widget import ShowWidgetTool

    html = '<div style="color:hsl(var(--foreground))">设置页</div>'
    out = json.loads(ShowWidgetTool().run(summary="设置页", format="html", code=html))
    block = out["_block"]
    assert block["format"] == "html"
    assert block["code"] == html


def test_show_widget_tool_run_preserves_mermaid_source_fields():
    from apps.services.tools.domains.common.show_widget import ShowWidgetTool

    source = "erDiagram\n  USER ||--o{ ORDER : places"
    out = json.loads(ShowWidgetTool().run(summary="ER 图", format="mermaid", code=source))
    block = out["_block"]
    assert block["format"] == "mermaid"
    assert block["code"] == source
    assert block["source_code"] == source
    assert block["mermaid_source"] == source


def test_show_widget_tool_run_declares_top_level_block_strip():
    """巨型 SVG 不回流到 LLM next-turn history（widget RFC §三 3.1）。

    **必须用顶层 key `_block`，不能用 dotted path** —— TS / Python 两端的
    strip 实现都只支持顶层 key 匹配，`_block.code` / `_block.image_url`
    会**默默 no-op**让整个 5KB SVG 全部回流 history。这是技术 Review
    发现的真 P0 bug。
    """
    from apps.services.tools.domains.common.show_widget import ShowWidgetTool

    tool = ShowWidgetTool()
    out_str = tool.run(summary="x", format="svg", code="<svg/>")
    out = json.loads(out_str)

    strip_keys = out.get("__llm_strip__", [])
    assert strip_keys == ["_block"], (
        f"必须用顶层 ['_block']，dotted path 不生效。当前: {strip_keys}"
    )


def test_show_widget_tool_name_stable():
    """工具 name 是 sections.ts / 前端路由 / TS 镜像 共用的契约。"""
    from apps.services.tools.domains.common.show_widget import (
        SHOW_WIDGET_TOOL_NAME,
        ShowWidgetTool,
    )

    assert ShowWidgetTool().name == "show_widget"
    assert SHOW_WIDGET_TOOL_NAME == "show_widget"


def test_show_widget_optional_fields_present_when_passed():
    from apps.services.tools.domains.common.show_widget import ShowWidgetTool

    tool = ShowWidgetTool()
    out_str = tool.run(
        summary="x",
        format="svg",
        code="<svg/>",
        loading_message="正在画…",
        group_id="g1",
        group_title="架构图组",
    )
    block = json.loads(out_str)["_block"]
    assert block["loading_message"] == "正在画…"
    assert block["group_id"] == "g1"
    assert block["group_title"] == "架构图组"


def test_show_widget_optional_fields_absent_when_not_passed():
    """没传的可选字段不要硬塞 None / 空串到 _block——前端 type guard 会用 truthy 判断。"""
    from apps.services.tools.domains.common.show_widget import ShowWidgetTool

    tool = ShowWidgetTool()
    out_str = tool.run(summary="x", format="svg", code="<svg/>")
    block = json.loads(out_str)["_block"]
    assert "title" not in block
    assert "loading_message" not in block
    assert "group_id" not in block
    assert "group_title" not in block


# Wave 2.5 自修复（产品 Review P1-4 守护）：schema 字段顺序——loading_message
# 必须在 code 之前，让 LLM 流式吐 args 时先吐 loading_message，partial 期间
# RichWidget 能从 buffer 提取并显示 Agent 自定义文案；待 code 流入再切到 SVG
# iframe 渲染。旧顺序（loading_message 在 code 后）让自定义文案永远被覆盖。
def test_show_widget_input_schema_loading_message_before_code():
    """LLM 倾向按 pydantic 字段声明顺序输出 args；loading_message 必须早于 code。

    这条断言守住"自定义文案在 partial 期间真生效"的产品承诺——若有人后续
    refactor 把字段顺序改回去（比如按字母排序），本测试立即失败。
    """
    from apps.services.tools.domains.common.show_widget import ShowWidgetInput

    field_order = list(ShowWidgetInput.model_fields.keys())
    idx_loading = field_order.index("loading_message")
    idx_code = field_order.index("code")
    assert idx_loading < idx_code, (
        f"loading_message 必须在 code 之前 (got order: {field_order})。"
        " 否则 LLM 流式吐 args 时 code 先到、loading_message 后到，partial 期间"
        " 用户看到的永远是 SVG iframe，不是 Agent 自定义文案。"
    )


def test_show_widget_input_schema_json_keys_order_matches_field_order():
    """生成的 JSON schema (model_json_schema) properties 顺序也需 loading_message
    在 code 之前——LLM 实际看到的是 JSON schema，不是 pydantic 字段声明。

    额外守住：Wave 4 新增的 `tool_call_id` 字段必须在**所有 LLM 可见字段之后**
    （放在最末尾）——这样即便将来 schema 序列化链路意外绕开 `tool_call_schema`
    的过滤让 tool_call_id 泄漏到 LLM，也不会挤到 summary / format / code 前面
    干扰 LLM 按顺序流式输出关键字段。
    """
    from apps.services.tools.domains.common.show_widget import ShowWidgetInput

    schema = ShowWidgetInput.model_json_schema()
    properties = schema.get("properties", {})
    keys = list(properties.keys())
    idx_loading = keys.index("loading_message")
    idx_code = keys.index("code")
    assert idx_loading < idx_code, (
        f"JSON schema properties 顺序里 loading_message 必须早于 code (got: {keys})。"
    )
    # Wave 4：InjectedToolCallId 字段必须在末尾（或至少排在 code 之后），
    # 防止任何语义/序列化链路异常时字段顺序污染
    assert "tool_call_id" in keys, (
        f"InjectedToolCallId 字段丢失 (got: {keys})。检查 ShowWidgetInput"
        " 是否还声明了 tool_call_id: Annotated[..., InjectedToolCallId()]。"
    )
    assert keys.index("tool_call_id") > idx_code, (
        f"tool_call_id 必须排在 code 之后 (got: {keys})。"
    )


# ─── Wave 4：tool_call_id 注入 + Mermaid rendered_code 字段对齐 ────────────
#
# 用户场景（widget RFC §四 4.1 真流式 placeholder 关联 / harness 总控 "立即修"
# Wave 4 backlog）：云端 Agent 同 turn 调 3 个 show_widget（架构图 + 流程图 +
# 数据图），前端 3 个 placeholder 不再按 FIFO 错对，各自按 tool_call_id 精确
# 替换。
#
# Python 镜像对等实现（与 packages/agent-runtime/src/tools/show-widget/
# tool-call-id-finder.ts 语义对齐）：依赖 LangChain 标准路径——
# `langchain_core.tools.base._prep_run_args` 从 ToolCall dict["id"] 把
# tool_call_id 放进 run_kwargs，层层流到 ShowWidgetTool.run(**kwargs) 里直接
# 取走。BaseTool 接口不扩字段（避免 schema 泄漏给 LLM / 触碰热文件）。


def test_show_widget_tool_run_injects_tool_call_id_into_block():
    """LangChain 上游以 ToolCall 格式 invoke 时，tool_call_id 会被
    `_prep_run_args` 注入到 run() 的 kwargs；_block 需要把它透出去让前端
    按 tool_call_id 精确替换 placeholder。

    本测试直接调 `tool.run(tool_call_id=..., ...)` 验证 run() 层契约——
    端到端 invoke 路径有独立的 `test_show_widget_invoke_path_auto_injects_tool_call_id`
    测试守住。
    """
    from apps.services.tools.domains.common.show_widget import ShowWidgetTool

    tool = ShowWidgetTool()
    out_str = tool.run(
        summary="k8s 架构",
        format="svg",
        code="<svg viewBox='0 0 100 100'/>",
        tool_call_id="tc_abc_001",
    )
    block = json.loads(out_str)["_block"]
    assert block["tool_call_id"] == "tc_abc_001", (
        "_block 必须透出 tool_call_id 让前端 upsertRichContentBlocksByToolCallId "
        "精确替换 placeholder（详见 streamMessageHandler.ensureWidgetPlaceholder）。"
    )


def test_show_widget_tool_run_multi_widget_tool_call_ids_do_not_cross():
    """云端 Agent 同 turn 调 3 个 widget 的端到端模拟：3 次独立 run() 调用每个
    携带不同 tool_call_id，断言生成的 _block 各自匹配，不会因为模块级单例 /
    全局状态错对。

    守住反思 10（harness §7 多 turn / 多 widget 场景盲点）—— Python 镜像
    历史没覆盖这个场景，Wave 4 云端 Agent 上线前必须守住。
    """
    from apps.services.tools.domains.common.show_widget import ShowWidgetTool

    tool = ShowWidgetTool()
    calls = [
        ("tc_widget_1", "<svg id='arch'/>", "架构图"),
        ("tc_widget_2", "<svg id='flow'/>", "流程图"),
        ("tc_widget_3", "<svg id='data'/>", "数据图"),
    ]
    blocks = []
    for tool_call_id, code, summary in calls:
        out_str = tool.run(
            summary=summary,
            format="svg",
            code=code,
            tool_call_id=tool_call_id,
        )
        blocks.append(json.loads(out_str)["_block"])

    # 断言 3 个 _block 的 tool_call_id 跟输入一一对应不错位
    assert [b["tool_call_id"] for b in blocks] == [
        "tc_widget_1",
        "tc_widget_2",
        "tc_widget_3",
    ]
    # summary 也各自不互相污染（守住"同一 tool 实例可重入"的基础契约）
    assert [b["summary"] for b in blocks] == ["架构图", "流程图", "数据图"]
    # widget_id 天然 per-call 生成，3 个必须各不相同（防万一未来 widget_id
    # 逻辑错用全局状态导致多 widget 撞 id）
    widget_ids = [b["widget_id"] for b in blocks]
    assert len(set(widget_ids)) == 3, f"widget_id 撞车: {widget_ids}"


def test_show_widget_tool_run_omits_tool_call_id_when_upstream_not_injected():
    """上游走 plain dict invoke（而非 ToolCall dict）时 tool_call_id 拿不到，
    _block 应**不含** tool_call_id 字段——**不要** 硬塞 None 进去，因为
    前端 type guard 会用 truthy 判断，None 序列化成 null 会让判断空转多一层。

    这是降级路径：前端拿不到 tool_call_id 时走 FIFO 兜底启发式（与 TS 端
    `findToolCallIdHeuristically` 返回 undefined 时的 fallback 路径对齐）。
    """
    from apps.services.tools.domains.common.show_widget import ShowWidgetTool

    tool = ShowWidgetTool()

    out_none = json.loads(tool.run(summary="x", format="svg", code="<svg/>"))
    assert "tool_call_id" not in out_none["_block"], (
        "tool_call_id 缺失时不要硬塞到 _block 里——前端走 FIFO 兜底。"
    )

    out_explicit_none = json.loads(
        tool.run(summary="x", format="svg", code="<svg/>", tool_call_id=None)
    )
    assert "tool_call_id" not in out_explicit_none["_block"]

    out_empty = json.loads(
        tool.run(summary="x", format="svg", code="<svg/>", tool_call_id="")
    )
    assert "tool_call_id" not in out_empty["_block"], (
        "空字符串 tool_call_id 也是无效注入，等同于缺失——前端走 FIFO 兜底。"
    )


def test_show_widget_tool_run_mermaid_block_contains_rendered_code_field():
    """Wave 4 字段契约对齐：Mermaid 格式的 _block 必须含 rendered_code 字段，
    哪怕 Python 不做真编译（空字符串表示"Python 端未编译，前端自行处理"）。

    用户场景：TS runtime 在 execute() 阶段用 mermaid + jsdom 编译 source
    成 SVG 写到 rendered_code，Python 镜像不承载 Node 编译但字段得齐——
    这样前端 RichWidget 的 type guard 拿到 block 时不用分"哪端生成"判断，
    rendered_code 空即走 loading_message + source_code 降级渲染。
    """
    from apps.services.tools.domains.common.show_widget import ShowWidgetTool

    source = "graph TD; A-->B; B-->C"
    out = json.loads(ShowWidgetTool().run(summary="ER", format="mermaid", code=source))
    block = out["_block"]

    assert "rendered_code" in block, (
        "Mermaid 路径 _block 必须含 rendered_code 字段（空字符串 ok）"
        " —— 与 TS runtime 字段契约对齐，前端拿到 block 时不需要分端判断。"
    )
    assert block["rendered_code"] == "", (
        "Python 镜像不承载 mermaid Node 编译——rendered_code 应为空字符串"
        " 表意'未编译'（与 TS runtime 流式期间 rendered_code 未就绪时语义一致）。"
        " 如果将来 Python 接了 mermaid 编译器，这里会是真实 SVG；本测试"
        " 要同步更新。"
    )
    # source_code / mermaid_source 两个字段都保留，前端 RichWidget 优先
    # 拿 rendered_code，空时回退到 source_code
    assert block["source_code"] == source
    assert block["mermaid_source"] == source


@pytest.mark.parametrize("fmt,code", [
    ("svg", "<svg/>"),
    ("html", "<div/>"),
])
def test_show_widget_tool_run_non_mermaid_block_omits_rendered_code(fmt: str, code: str):
    """rendered_code 只出现在 Mermaid 路径——SVG / HTML 不应有这个字段。

    防回归：有人误把 rendered_code 提到所有 format 的 _block 里，会污染
    前端 type guard（rendered_code 存在就走编译后分支，但 SVG 本身就是编译
    完的，没 "source" 概念；HTML 没 "rendered" 概念）。
    """
    from apps.services.tools.domains.common.show_widget import ShowWidgetTool

    out = json.loads(ShowWidgetTool().run(summary="x", format=fmt, code=code))
    block = out["_block"]
    assert "rendered_code" not in block, (
        f"{fmt} 路径不应有 rendered_code 字段（仅 Mermaid 有，表示编译产出）"
    )
    assert "source_code" not in block
    assert "mermaid_source" not in block


def test_show_widget_tool_call_schema_hides_tool_call_id_from_llm():
    """守护 tool_call_id 字段**不暴露给 LLM**——LangChain `tool_call_schema`
    会自动过滤 InjectedToolArg 子类（含 InjectedToolCallId）。

    回归路径：
    1. 有人误把 tool_call_id 字段改成普通 `Optional[str]`（丢 InjectedToolCallId
       marker）→ LLM 会看到这个字段并胡乱填一个假 id → 前端 placeholder 替换
       错位
    2. 有人把 args_schema 直接塞到 LLM tools payload（绕过 `tool_call_schema`
       路径）→ 泄漏。本测试守住第一种情况，第二种属 schema 生成链路层面，由
       `test_tool_call_schema_hides_injected_state` / `tool_sync` 同型测试守护

    本仓库 `apps/capabilities/services/tool_sync.py:110` 目前直接写入
    `args_schema.model_json_schema()` 到 DB（仅供管理面板显示，不发给 LLM）；
    真正给 LLM 的 tools payload 在 TS agent-runtime 端生成并走 LangChain.js
    自身的 `tool_call_schema` 过滤。若未来这个假设变化，此测试的假设说明需
    同步更新。
    """
    from apps.services.tools.domains.common.show_widget import ShowWidgetTool

    tool = ShowWidgetTool()

    # LLM-facing schema（tool_call_schema）必须**不**含 tool_call_id
    llm_schema = tool.tool_call_schema
    llm_props = llm_schema.model_json_schema().get("properties", {}) \
        if hasattr(llm_schema, "model_json_schema") else llm_schema.get("properties", {})
    assert "tool_call_id" not in llm_props, (
        "LLM 看到的 schema 不能含 tool_call_id —— InjectedToolCallId marker 缺失?"
        f" 当前 LLM-facing properties: {sorted(llm_props.keys())}"
    )

    # 完整 args_schema 必须**含** tool_call_id（run() 注入靠这个字段被 pydantic
    # 校验时塞进 tool_input）
    full_props = tool.args_schema.model_json_schema().get("properties", {})
    assert "tool_call_id" in full_props, (
        "完整 args_schema 必须含 tool_call_id 字段（LangChain _parse_input 注入靠它）。"
        f" 当前 full properties: {sorted(full_props.keys())}"
    )


def test_show_widget_invoke_path_auto_injects_tool_call_id_from_tool_call_dict():
    """**端到端守护**：LangChain 上游以 ToolCall dict 格式 invoke 时，
    `langchain_core.tools.base._prep_run_args` 会从 `value["id"]` 自动
    提取 tool_call_id 放进 run_kwargs → BaseTool._run → self.run(**kwargs)。

    这条契约守住：
    1. 未来有人把 ShowWidgetTool.run 签名改成不接 `**kwargs`（比如改成
       显式参数），tool_call_id 链路会立即断——本测试立刻失败
    2. 未来有人把 BaseTool.invoke 改成绕过 `_prep_run_args`，tool_call_id
       注入路径也会断

    需要 monkeypatch `_permission_guard_check_fn`——本工具 risk_level=medium，
    invoke 路径会走 `_run_entry_permission_checks` fail-close 拒绝；测试
    场景里手动放行权限，只验 tool_call_id 注入链路。
    """
    from apps.services.tools import base as base_module
    from apps.services.tools.domains.common.show_widget import ShowWidgetTool

    original_guard = base_module._permission_guard_check_fn
    # 放行权限：返回 None 表示不拒绝（详见 base.py `_run_entry_permission_checks`）
    base_module._permission_guard_check_fn = lambda tool, params: None
    try:
        tool = ShowWidgetTool()
        # ToolCall dict 格式（标准调用方式）——
        # `_prep_run_args` 认这个格式并从 id 提取 tool_call_id
        tool_call = {
            "id": "tc_from_e2e_invoke",
            "name": "show_widget",
            "args": {
                "summary": "端到端路径",
                "format": "svg",
                "code": "<svg/>",
            },
            "type": "tool_call",
        }
        raw_result = tool.invoke(tool_call)
        # BaseTool.invoke 可能返回 ToolMessage / str / dict，统一解 content
        if isinstance(raw_result, str):
            payload_str = raw_result
        elif hasattr(raw_result, "content"):
            payload_str = raw_result.content
        else:
            payload_str = json.dumps(raw_result)

        payload = json.loads(payload_str)
        assert payload["success"] is True, f"invoke 失败: {payload}"
        assert payload["_block"]["tool_call_id"] == "tc_from_e2e_invoke", (
            "LangChain 标准 ToolCall invoke 路径必须把 tool_call_id 自动注入"
            " _block —— 本测试失败说明 BaseTool.invoke → _prep_run_args → "
            "_run → self.run(**kwargs) 链路被改动破坏。"
        )
    finally:
        base_module._permission_guard_check_fn = original_guard


# ─── P0-3 合同测试（2026-04-30 P0 波修复）──────────────────────────────
#
# **背景**：`__llm_strip__` 是 show_widget.py / present_to_user.py 自声明的"返回
# 给 LLM 的 content 里应该剥掉哪些字段"。**但本仓库目前没有任何 Python 代码
# 真正消费这个字段**（apps/tabtin_django 全仓搜索 `__llm_strip__` 只出现在工具
# 声明和本测试文件里，找不到消费者）。
#
# 独立验证 Agent 发现的事实确认：
#   - 云端 Agent 执行路径通过 `agent.prompt.forward` WebSocket envelope 分发给
#     设备端 DaemonAgentHost / ElectronAgentHost（见 apps/services/agent_engine/
#     engine/agent_dispatcher.py 头部注释 + `get_agent_backend_type`：
#     "Always 'local' (or legacy stored value)"）。
#   - 所有 LLM tool 执行在设备端 TS `@tabtin/agent-runtime` 完成，TS 的
#     `stripKeysFromResult` (engine/tool-system.ts) 已经处理 llmStripKeys。
#   - Python `ShowWidgetTool` 只在 `tool_registry.py` 实例化用作 manifest
#     metadata 声明，`run()` 方法在当前架构下**不会**被云端 LLM 调用后
#     把 content 塞回 history。
#
# 因此 P0-3 当前**不构成真实事故**，降级为 P2 backlog（harness 总控登记：
# "云端直接 invoke Python tool 的路径上线前必须补 __llm_strip__ 消费"）。
#
# 但 P0 波仍然要加本合同测试——**未来**如果新路径把 Python tool 直接接入
# LLM history，消费层必须 work。测试定义"合同应该长这样"，并验证 *strip helper*
# 真的能把声明的 key 剥干净——这是留给未来接入者的已经烘焙好的契约层。
# （harness 反思 5：测试守合同不是守实现。）


def _strip_llm_keys_from_content(content_json: str) -> str:
    """P0-3 合同守护层：strip helper（合约 reference 实现）。

    读取 ``content_json`` 里的 ``__llm_strip__`` 列表，把列表中的 key
    从结果 dict 里删掉（同时删 __llm_strip__ 自己），再 json.dumps 返回。

    当前仓库**没有**消费者——本函数是"接入层参考实现"的模板。
    真正接入时应参考 TS `stripKeysFromResult` (packages/agent-runtime/src/
    engine/tool-system.ts) 的行为：
      - 只支持顶层 key（dotted path 不展开）
      - strip 后也删除 ``__llm_strip__`` 自身
    """
    parsed = json.loads(content_json)
    strip_keys = parsed.pop("__llm_strip__", []) or []
    for key in strip_keys:
        parsed.pop(key, None)
    return json.dumps(parsed, ensure_ascii=False)


def test_show_widget_p0_strip_contract_removes_block_from_llm_content():
    """**P0-3 合同测试**：消费层 strip 后，content 里不再有 `_block`。

    未来如果把 Python `ShowWidgetTool.run()` 的 content 直接接入 LLM history，
    必须先经过 strip 层消费 `__llm_strip__` 声明——否则 5KB SVG 回流 LLM
    是真实的云端多轮 context 暴涨 + 成本事故。

    **本测试的价值**：给未来接入者一个 "if you forget to strip, this test catches"
    的合约守护。当前仓库 TS 端已经 strip，Python 端没消费者——测试定义正确
    行为，不依赖当前实现是否落地。
    """
    from apps.services.tools.domains.common.show_widget import ShowWidgetTool

    tool = ShowWidgetTool()
    heavy_svg = '<svg viewBox="0 0 100 100">' + '<rect/>' * 100 + '</svg>'
    raw_content = tool.run(summary="架构图", format="svg", code=heavy_svg)

    # 未消费前：_block 含 5KB SVG（当前行为——仓库没消费者）
    raw = json.loads(raw_content)
    assert "_block" in raw, "工具自身必须先把 _block 写进 content"
    assert "<svg" in raw["_block"]["code"]
    assert raw.get("__llm_strip__") == ["_block"], (
        "__llm_strip__ 声明必须是顶层 ['_block']，与 TS llmStripKeys 对齐"
    )

    # **合同**：消费层 strip 后 _block 被剥掉
    stripped_content = _strip_llm_keys_from_content(raw_content)
    stripped = json.loads(stripped_content)
    assert "_block" not in stripped, (
        "strip 消费后 _block 必须被剥掉——否则 LLM next-turn history 会被 "
        "5KB SVG 污染"
    )
    # __llm_strip__ 自身也被清（LLM 看到元信息也没意义）
    assert "__llm_strip__" not in stripped

    # 关键业务字段保留：LLM 仍需知道工具调用成功 + widget_id + summary
    assert stripped["success"] is True
    assert stripped["widget_id"].startswith("wgt_")
    assert stripped["summary"] == "架构图"

    # 端到端（反向验证）：strip 后的 content 字符串不应含 SVG markup
    assert "<svg" not in stripped_content
    assert "<rect" not in stripped_content


def test_show_widget_p0_strip_contract_preserves_other_business_fields():
    """合同测试补充：strip helper 不应误删非声明字段。"""
    from apps.services.tools.domains.common.show_widget import ShowWidgetTool

    tool = ShowWidgetTool()
    raw_content = tool.run(summary="测试", format="svg", code="<svg/>")
    stripped_content = _strip_llm_keys_from_content(raw_content)
    stripped = json.loads(stripped_content)

    assert stripped["success"] is True
    assert "widget_id" in stripped
    assert "summary" in stripped
    # baking_error 字段只在烤图失败时出现，本路径 Python 不烤所以不会有
    # 但如果未来有，strip 不应该删（__llm_strip__ 只声明 _block）
    assert "__llm_strip__" not in stripped


def test_show_widget_p0_strip_contract_mermaid_source_code_also_stripped():
    """Mermaid 场景 source_code 通过 _block 间接被 strip（_block 是顶层 strip 目标）。

    前提契约：`_block.source_code` / `_block.mermaid_source` / `_block.rendered_code`
    都是 `_block` 的子字段，而不是顶层独立字段。当前实现确实如此，
    测试守住这条不退化（未来有人把 source_code 误提到顶层，会让 Mermaid 源码
    也回流 LLM history）。
    """
    from apps.services.tools.domains.common.show_widget import ShowWidgetTool

    tool = ShowWidgetTool()
    source = 'graph TD; A[节点A] --> B[节点B]'
    raw_content = tool.run(summary="Mermaid", format="mermaid", code=source)
    raw = json.loads(raw_content)
    # 确认 source_code 是 _block 的子字段（不是顶层）
    assert "source_code" in raw["_block"]
    assert "source_code" not in raw  # 顶层不出现
    assert "mermaid_source" not in raw  # 顶层不出现

    stripped_content = _strip_llm_keys_from_content(raw_content)
    stripped = json.loads(stripped_content)
    # strip _block 后所有 Mermaid 源码字段全消失
    assert "_block" not in stripped
    assert source not in stripped_content  # 源码字符串不在 content 里
