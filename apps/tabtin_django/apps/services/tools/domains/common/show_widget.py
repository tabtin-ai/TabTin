"""
show_widget — Widget Wave 2 工具（widget RFC §三 3.1 / §四 4.1）的 Python 镜像。

业务目标：让云端 Agent 在对话里 emit "可视化 widget"，桌面端 chat 流里逐
token 流式渲染 SVG（与本地 Electron 端 packages/agent-runtime/src/tools/
show-widget.ts 行为对齐）。

与 `present_to_user.py` 互补关系：
  - present_to_user：4 类预定义 kind（image / table_preview / resource_ref /
    file），受限 schema
  - show_widget：自由 SVG / HTML 代码，最终落 `RichContentBlock { kind: 'widget' }`

Wave 6 范围：
  - 接受 `format='svg' | 'html' | 'mermaid'`
  - HTML 是 no-script 静态 UI；Mermaid 在 TS runtime 编译时转 SVG，Python 镜像保留 source 字段
  - 移动端优先看 image_url；缺失时显示 summary fallback

关键防线（widget RFC §七 🔴 高严重度）：
  - **execution_mode + risk_level 隐含的 isReadOnly = False 语义**：本仓库
    Python 工具没有显式 `is_read_only` 字段，但 BaseTool 的 `risk_level` 用法
    与 TS Tool.isReadOnly 不完全对应。`risk_level: 'medium'`（不是 'safe'）
    隐含告诉 orchestration 这是个有副作用的工具，不能进 preStartedTools 池。
    真正守 preStart 的判断在 TS 端
    `packages/agent-runtime/src/engine/query.ts:2628`：
    `if (preStartCandidate?.isReadOnly && !preStartCandidate.highRisk)`。
    `risk_level='safe'` 会被 `action_tools_adapter` 映射成 TS Tool.isReadOnly=true
    让 widget 工具在 LLM 流式期间被提前 execute 烤到半截 SVG——必须保持 'medium'。
    本工具配套测试断言 risk_level != 'safe' 防回归。
  - **`__llm_strip__`**：与 `present_to_user.py` 一致，巨型 SVG 回流到
    LLM next-turn history 浪费 context；strip 整个 `_block`（顶层 key），
    让模型只看到 success + widget_id + summary。
    **历史教训**：v1 用 dotted path `['_block.code', '_block.image_url']`，
    跟 TS 的 `stripKeysFromResult` 实现一样只支持顶层 key——dotted path
    默默 no-op。修法：strip 整个 `_block`（与 `present_to_user.py` 的
    `['_blocks', '_title']` 顶层路径一致）。

  - **Python `__llm_strip__` 消费者状态**（已知遗留项，与 `present_to_user.py`
    同病）：本仓库后端目前**没有任何代码**消费 `__llm_strip__` magic key
    把它从 tool result content 里剥掉。此字段当前只是"自描述意图"，下游
    若想真正剥离需要在 LLM history builder 加消费层。Wave 2 不修这个长期债
    （与 present_to_user 的边界一致），但保留字段为 Wave 4+ 接消费者打基础。

Wave 4 新增字段（与 TS 端 packages/agent-runtime/src/tools/show-widget/
tool-call-id-finder.ts 语义对齐）：

  - **`_block.tool_call_id`**：本轮 tool_use 的 id，让前端
    `upsertRichContentBlocksByToolCallId` 按 tool_call_id 精确替换
    placeholder（不再依赖 FIFO 兜底）——修复云端 Agent 同 turn 调多张
    widget 时前端 placeholder 错对的问题。

    Python 侧注入方式（**只依赖 LangChain 标准路径，不改 BaseTool 接口**）：
    上游以 ToolCall dict 格式 invoke（`{"id": "...", "name": "show_widget",
    "args": {...}, "type": "tool_call"}`）时，`langchain_core.tools.base
    ._prep_run_args` 从 ToolCall["id"] 把 `tool_call_id` 放进 run_kwargs，
    层层流到 `run(**kwargs)`，这里直接 `kwargs.get("tool_call_id")`。
    上游走 plain dict / string input 时拿不到，此字段留空，前端退回到
    FIFO 兜底——行为等价于 TS 端 `findToolCallIdHeuristically` 返回
    `undefined` 的降级路径。

    **为什么不走 `args_schema + InjectedToolCallId`**：会让字段出现在
    LLM 看到的 JSON schema 里（本仓库的 schema 精简层处理了 InjectedState，
    未显式处理 InjectedToolCallId，加字段有泄漏风险）。走 `run()` kwargs
    通道既能拿到值，又不碰 schema 的 LLM 可见面。

  - **`_block.rendered_code`**（Mermaid 场景）：与 TS 端字段契约对齐。
    TS runtime 在 execute() 阶段用 mermaid + jsdom 把 source 编译成 SVG
    并写入 rendered_code；Python 镜像不承载 mermaid Node 编译（无需拉
    mermaid-py 依赖），rendered_code 留空字符串——前端拿到 block 时字段
    齐全，如果 rendered_code 为空则回退到显示 source_code + loading 样式
    （与 TS runtime 流式期间行为一致）。
"""

import json
import logging
from typing import Annotated, Any, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

from apps.services.tools import BaseTool

# Wave 4：InjectedToolCallId 让 LangChain `_parse_input` 在 args_schema 校验
# 阶段把上游 ToolCall dict["id"] 注入到 tool_input["tool_call_id"]，再经
# `_to_args_and_kwargs` 流到 `_run(**kwargs)` → `run(**kwargs)`。此字段标
# 注后 `tool_call_schema` / `_filter_injected_args` 都会自动过滤（LLM 看到
# 的 JSON schema 不含它），langchain_core 已处理好可见性。
try:
    from langchain_core.tools.base import InjectedToolCallId
except Exception:  # pragma: no cover - 极老 langchain_core 兜底，让模块可 import
    class InjectedToolCallId:  # type: ignore[no-redef]
        pass

logger = logging.getLogger(__name__)

SHOW_WIDGET_TOOL_NAME = "show_widget"

# Widget Wave 6：TS / Python schema 同步接受三种格式。
_SUPPORTED_FORMATS = frozenset({"svg", "html", "mermaid"})

# 单条 widget code 上限（与 RFC §七 "超长 widget code 拒绝（限制 8KB）" 对齐）。
_MAX_CODE_BYTES = 8 * 1024


class ShowWidgetInput(BaseModel):
    """Render an inline visual widget (SVG / HTML no-script / Mermaid) in chat.

    **字段顺序很重要**（Wave 2.5 自修复：产品 Review P1-4）：
      - LLM 倾向按字段声明顺序输出 tool_use args
      - ``loading_message`` 必须在 ``code`` **之前** —— LLM 流式吐 args 时先吐
        loading_message，RichWidget 在 partial 期间从 buffer 提取并显示给用户；
        待 ``code`` 流入时再切到 SVG iframe 渲染
      - 旧顺序（loading_message 在 code 之后）让 Agent 自定义 loading_message
        永远被 SVG iframe 显示覆盖，"自定义文案"功能事实上失效
    """

    title: Optional[str] = Field(None, description="Optional widget title.")
    summary: str = Field(
        ...,
        description=(
            "REQUIRED. Human-readable description used as mobile fallback + "
            "accessibility label."
        ),
    )
    format: str = Field(
        ...,
        description=(
            'Widget format: "svg", "html" (static no-script), or "mermaid".'
        ),
    )
    loading_message: Optional[str] = Field(
        None,
        description=(
            "Optional placeholder text shown while LLM is still streaming the code. "
            "IMPORTANT: must be emitted **before** `code` so the user sees the "
            "message during the streaming window before the SVG iframe takes over."
        ),
    )
    code: str = Field(
        ...,
        description=(
            "Widget source code. SVG uses complete `<svg>`, HTML is static no-script, "
            "Mermaid is source text compiled by the TS runtime when available."
        ),
    )
    group_id: Optional[str] = Field(
        None, description="Optional group id to bundle multiple widgets."
    )
    group_title: Optional[str] = Field(None, description="Optional group title.")
    # Wave 4：InjectedToolCallId 让 LangChain 从 ToolCall dict["id"] 自动
    # 注入；LLM 看到的 schema 不含本字段（`tool_call_schema` filter 掉），
    # 单测 / 上游走 plain dict invoke 时留空，run() 里 `kwargs.get` 会得到
    # None，降级到"前端 FIFO 兜底"（与 TS finder 返回 undefined 同语义）。
    #
    # **注意用"实例"而非"类"**（`InjectedToolCallId()` 带括号）——与仓库
    # 其他 `Annotated[..., InjectedState("key")]` 风格对齐，也让 `base.py
    # _get_injected_state_keys` 基于 `type(meta).__name__` 的识别逻辑正确
    # 命中（类写法下 `type(cls).__name__ == "type"`，会漏识别，虽然本工具
    # `run(**kwargs)` 带 VAR_KEYWORD 不受影响，但若后续 run 签名改成显式
    # 参数，会瞬间失效）。
    tool_call_id: Annotated[Optional[str], InjectedToolCallId()] = Field(
        default=None,
        description=(
            "Injected at runtime by LangChain from the ToolCall envelope. "
            "Not exposed to the LLM."
        ),
    )

    @field_validator("format")
    @classmethod
    def _validate_format(cls, v: str) -> str:
        if v not in _SUPPORTED_FORMATS:
            raise ValueError(
                f'unsupported format "{v}". Supported formats: '
                f'{", ".join(sorted(_SUPPORTED_FORMATS))}.'
            )
        return v

    @model_validator(mode="after")
    def _check_code_size(self) -> "ShowWidgetInput":
        if not self.code:
            raise ValueError("code is required (the SVG markup)")
        # 用 utf-8 编码字节数判断上限——SVG 中的中文 / emoji 一字符占多字节，
        # 不能用 len(code) 否则会让中文 SVG 假性放过。
        code_bytes = len(self.code.encode("utf-8"))
        if code_bytes > _MAX_CODE_BYTES:
            raise ValueError(
                f"widget code too large: {code_bytes} bytes > {_MAX_CODE_BYTES} bytes "
                "(8KB cap). Split into multiple widgets or simplify the SVG."
            )
        if not self.summary or not self.summary.strip():
            raise ValueError(
                "summary is required (used as mobile fallback + accessibility label)"
            )
        unsafe = _unsafe_widget_source_reason(self.format, self.code)
        if unsafe:
            raise ValueError(unsafe)
        return self


def _unsafe_widget_source_reason(fmt: str, code: str) -> Optional[str]:
    import re

    event_attr = re.compile(r"\s(on[a-z]+)\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)", re.IGNORECASE)

    def _strip_quotes(value: str) -> str:
        value = value.strip()
        if (value.startswith('"') and value.endswith('"')) or (
            value.startswith("'") and value.endswith("'")
        ):
            return value[1:-1]
        return value

    def _is_safe_send_prompt_handler(name: str, value: str) -> bool:
        if name.lower() != "onclick":
            return False
        handler = _strip_quotes(value)
        if not re.match(r"^sendPrompt\s*\(", handler):
            return False
        if re.search(r"[;\n\r]", re.sub(r";\s*$", "", handler)):
            return False
        return bool(
            re.match(
                r"^sendPrompt\s*\(\s*(?:\"[^\"]{1,1000}\"|'[^']{1,1000}')"
                r"(?:\s*,[\s\S]{1,4096})?\)\s*;?\s*$",
                handler,
            )
        )

    def _unsafe_event_handler_name() -> Optional[str]:
        for match in event_attr.finditer(code):
            if not _is_safe_send_prompt_handler(match.group(1), match.group(2)):
                return match.group(1)
        return None

    if fmt == "html":
        checks = [
            (r"<\s*script\b", "HTML widgets are no-script: <script> is not allowed"),
            (r"\bjavascript\s*:", "HTML widgets cannot contain javascript: URLs"),
            (r"<\s*(iframe|object|embed)\b", "HTML widgets cannot embed iframe/object/embed content"),
            (r"<\s*form\b", "HTML widgets cannot submit forms"),
        ]
    elif fmt == "mermaid":
        checks = [
            (r"\bclick\b", "Mermaid click directives are disabled for no-script widgets"),
            (r"\bjavascript\s*:", "Mermaid widgets cannot contain javascript: URLs"),
            (r"\son[a-z]+\s*=", "Mermaid widgets cannot contain inline event handlers"),
        ]
    else:
        return None

    for pattern, message in checks:
        if re.search(pattern, code, flags=re.IGNORECASE):
            return message
    if fmt == "html":
        unsafe_handler = _unsafe_event_handler_name()
        if unsafe_handler:
            return (
                'HTML widgets can only use onclick="sendPrompt(...)" handlers; '
                f"found {unsafe_handler}"
            )
    return None


def _scrub_svg(svg: str) -> str:
    import re

    event_attr = re.compile(r"\s(on[a-z]+)\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)", re.IGNORECASE)

    def _strip_quotes(value: str) -> str:
        value = value.strip()
        if (value.startswith('"') and value.endswith('"')) or (
            value.startswith("'") and value.endswith("'")
        ):
            return value[1:-1]
        return value

    def _is_safe_send_prompt_handler(name: str, value: str) -> bool:
        if name.lower() != "onclick":
            return False
        handler = _strip_quotes(value)
        if not re.match(r"^sendPrompt\s*\(", handler):
            return False
        if re.search(r"[;\n\r]", re.sub(r";\s*$", "", handler)):
            return False
        return bool(
            re.match(
                r"^sendPrompt\s*\(\s*(?:\"[^\"]{1,1000}\"|'[^']{1,1000}')"
                r"(?:\s*,[\s\S]{1,4096})?\)\s*;?\s*$",
                handler,
            )
        )

    # P0-1 第一层修复（与 TS sanitizer.ts `scrubSvg` 字面对齐）：
    #   旧实现只清成对 `<script>...</script>`，attack payload
    #   `<svg><script>parent.postMessage(...` (不闭合) 绕过。
    #   修法：成对正则先跑（处理正常情况），再跑独立 `<script` 开标签正则
    #   把所有剩余开标签 / 自闭合标签全清掉。
    svg = re.sub(r"<\s*script\b[^>]*>[\s\S]*?<\s*/\s*script\s*>", "", svg, flags=re.IGNORECASE)
    svg = re.sub(r"<\s*script\b[^>]*/?\s*>", "", svg, flags=re.IGNORECASE)
    # **安全 Review 自修（与 TS sanitizer 字面对齐）**：一律清
    # `<iframe>/<object>/<embed>` 开标签——defense in depth 防未来新攻击面。
    svg = re.sub(r"<\s*(iframe|object|embed)\b[^>]*/?\s*>", "", svg, flags=re.IGNORECASE)
    svg = re.sub(r"<\s*/\s*(iframe|object|embed)\s*>", "", svg, flags=re.IGNORECASE)
    # Python 镜像目前不做 Mermaid 编译（见模块 docstring），所以不暴露
    # trustedOrigin 参数——默认一律清 foreignObject。若未来 Python 端接入
    # Mermaid 编译，参考 TS sanitizer.ts 加同样的信任边界分层。
    svg = re.sub(r"<\s*foreignObject\b[^>]*>[\s\S]*?<\s*/\s*foreignObject\s*>", "", svg, flags=re.IGNORECASE)
    svg = event_attr.sub(
        lambda match: match.group(0)
        if _is_safe_send_prompt_handler(match.group(1), match.group(2))
        else "",
        svg,
    )
    svg = re.sub(r"\s(?:href|xlink:href)\s*=(['\"])\s*javascript:[\s\S]*?\1", "", svg, flags=re.IGNORECASE)
    svg = re.sub(r"\bjavascript\s*:", "", svg, flags=re.IGNORECASE)
    return svg


def _generate_widget_id() -> str:
    """deterministic-enough widget id：与 TS 端格式对齐。"""
    import secrets
    import time

    ts = format(int(time.time() * 1000), "x")  # base16 timestamp
    rand = secrets.token_hex(3)
    return f"wgt_{ts}_{rand}"


class ShowWidgetTool(BaseTool):
    name: str = SHOW_WIDGET_TOOL_NAME
    description: str = (
        "Render an inline visual widget in chat (architecture diagrams, "
        "flowcharts, state cards, comparison views). The widget streams from "
        "LLM tokens so the user sees it being generated live.\n\n"
        "Use show_widget when:\n"
        "  - You need free-form visualisation (SVG, layouts, diagrams)\n"
        "  - The content is best understood spatially\n\n"
        "Use present_to_user instead when:\n"
        "  - The content fits one of the 4 predefined kinds (image / table_preview / "
        "resource_ref / file)\n\n"
        "Required: `summary` (mobile fallback / a11y), "
        "`format: \"svg\" | \"html\" | \"mermaid\"`, `code`."
    )
    execution_mode: str = "server"
    # Widget Wave 2 — RFC §七 🔴 高严重度防线。
    #
    # **必须保持 'medium'，不能改成 'safe'**：本仓库 `apps/services/tools/
    # action_tools_adapter.ts` 把 `risk_level === 'safe'` 映射成 TS Tool 的
    # `isReadOnly: true`（见 packages/agent-runtime/src/engine/action-tools-
    # adapter.ts:39）。TS 端的 preStartedTools 守卫在
    # `packages/agent-runtime/src/engine/query.ts:2628`：
    # `if (preStartCandidate?.isReadOnly && !preStartCandidate.highRisk)`——
    # isReadOnly=true 会让工具在 LLM 流式期间被提前 execute，烤到半截 SVG。
    #
    # 配套测试 test_show_widget.py::test_risk_level_is_not_safe 断言这个
    # 字段不会被人随手改成 'safe' 触发回归。
    risk_level: str = "medium"
    required_permissions: list[str] = []
    timeout: int = 30
    args_schema: type[ShowWidgetInput] = ShowWidgetInput

    def run(self, **kwargs: Any) -> str:
        # pydantic args_schema 已在调用处验证 input；这里 kwargs 拿到的是
        # 验证后的 dict（与 PresentToUserTool 一致）。
        summary: str = kwargs.get("summary", "")
        fmt: str = kwargs.get("format", "")
        code: str = kwargs.get("code", "")
        render_code = _scrub_svg(code) if fmt == "svg" else code
        title: Optional[str] = kwargs.get("title")
        loading_message: Optional[str] = kwargs.get("loading_message")
        group_id: Optional[str] = kwargs.get("group_id")
        group_title: Optional[str] = kwargs.get("group_title")

        # Wave 4：LangChain `_prep_run_args` 从 ToolCall dict["id"] 注入；
        # 上游走 plain dict 时本字段 None，前端回退到 FIFO 兜底。
        tool_call_id = kwargs.get("tool_call_id")

        widget_id = _generate_widget_id()

        # _block 走 __llm_strip__ 不回流给 LLM，只供前端 BlocksCollector / 持久化
        # 通道使用。结构与 TS show-widget.ts 字面对齐，前端不需要分两端 schema。
        # 注意：Python 镜像不承载 Mermaid Node 编译；TS runtime 会把 Mermaid
        # source 编译成 SVG 并写 rendered_code/code。Python 端保留 source 字段，
        # 旧客户端不会加载 mermaid runtime。
        block: dict = {
            "type": "rich_content",
            "kind": "widget",
            "widget_id": widget_id,
            "format": fmt,
            "code": render_code,
            "summary": summary,
        }
        if title:
            block["title"] = title
        if loading_message:
            block["loading_message"] = loading_message
        if group_id:
            block["group_id"] = group_id
        if group_title:
            block["group_title"] = group_title
        if fmt == "mermaid":
            # source_code + mermaid_source 保留原文。rendered_code 为空字符串表示
            # "Python 端不做 Node 编译"——与 TS runtime 流式期间 rendered_code
            # 未就绪的语义一致，前端 RichWidget 会回退到显示 source_code + loading
            # 占位（详见 richContent/widget/RichWidget.tsx 的 mermaid 分支）。
            block["source_code"] = code
            block["mermaid_source"] = code
            block["rendered_code"] = ""

        # tool_call_id 非空时才写字段——避免把 None 序列化进 JSON 让前端
        # type guard 意外 truthy。与 TS show-widget/index.ts emit RICH_CONTENT
        # 时 `...(toolCallId ? { tool_call_id: toolCallId } : {})` 同等行为。
        if tool_call_id:
            block["tool_call_id"] = tool_call_id

        result: dict = {
            "success": True,
            "widget_id": widget_id,
            "summary": summary,
            "_block": block,
            # __llm_strip__：strip 整个 `_block`（顶层 key）让 LLM next-turn
            # history 干净。与 present_to_user.py `["_blocks", "_title"]` 同等
            # 用法。**注意**：必须用顶层 key——dotted path 在 TS / Python 两端
            # 的 strip 实现里都默默 no-op，会让 5KB SVG 全部回流 LLM history。
            "__llm_strip__": ["_block"],
        }

        return json.dumps(result, ensure_ascii=False)


__all__ = ["ShowWidgetTool", "SHOW_WIDGET_TOOL_NAME"]
