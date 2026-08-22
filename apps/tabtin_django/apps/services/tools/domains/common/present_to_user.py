"""
present_to_user — 向用户展示富内容（图片、表格、平台资源引用、文件等）。

Agent 在需要向用户呈现操作结果、数据可视化或平台资源时调用此工具。
工具正常执行（不走 HITL 中断），通过 side_effects 将展示内容注入到
assistant 消息的 blocks_json 中，前端以 rich_content block 渲染。

与 ask 工具（ask_user / ask_form）的关系：
- ask_*：用户 → Agent（收集信息，HITL 中断）
- present_to_user：Agent → 用户（展示内容，不阻塞）

支持的内容类型（kind）：
- image：图片展示（需 https URL，本地文件先通过 tabtin oss upload 上传）
- table_preview：结构化表格预览（columns + rows，上限 200 行）
- resource_ref：平台资源引用卡片（table / doc / slide / video / site）
- file：文件下载卡片（需 https URL）
"""

import json
import logging
from typing import Any, List, Optional

from pydantic import BaseModel, Field, model_validator

from apps.services.tools import BaseTool
from apps.services.common.manifest_opens import get_supported_resource_types
from apps.services.tools.error_envelope import json_tool_error

logger = logging.getLogger(__name__)

PRESENT_TO_USER_TOOL_NAME = "present_to_user"

_MAX_TABLE_ROWS = 200
# Widget Wave 2（widget RFC §三 3.1 + §11.3 双协议）：
# `widget` kind 由 `show_widget` 工具 emit。这里加进来是为了：
#   1. 让前端通用 RichContentRenderer 路由层（switch by `kind`）能识别同一
#      kind 集合，不会在 widget 未来某天被人塞进 present_to_user.items 时
#      被这层 validator 拒绝（RFC §决策 1：show_widget 是主入口，但 kind
#      集合应当统一在两个工具间共享，避免心智割裂）。
#   2. blocks_json 入库 / 历史回放路径上若有人用 present_to_user 转发别处
#      生成的 widget block，至少不会被这层"假"地识别成不支持。
# 真正的 widget 输入 schema / 字段验证在 `show_widget.py::ShowWidgetInput`，
# 本工具不重复定义 widget 字段——和 image 字段验证一样按需补即可。
_SUPPORTED_KINDS = frozenset({"image", "table_preview", "resource_ref", "file", "widget"})
# 「Agent 产物在 Space 内的打开」W2 / W6 L08：删硬编码 _SUPPORTED_RESOURCE_TYPES
# frozenset，改用 manifest_opens.get_supported_resource_types() 动态聚合
# packages/apps/*/app.json 的 opens.types。D1 manifest 驱动哲学 — 任何
# resource type 由 App 自己声明，Python 不维护并行清单。


def _read_string(value: Any) -> Optional[str]:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _normalize_resource_ref_item(item: dict) -> dict:
    metadata = item.get("metadata")
    if not isinstance(metadata, dict):
        metadata = {}

    resource_type = (
        _read_string(item.get("resource_type"))
        or _read_string(metadata.get("resource_type"))
        or _read_string(metadata.get("type"))
    )
    resource_id = _read_string(item.get("resource_id")) or _read_string(item.get("ref"))

    normalized = dict(item)
    if resource_type:
        normalized["resource_type"] = resource_type
    if resource_id:
        normalized["resource_id"] = resource_id
    return normalized


class PresentToUserInput(BaseModel):
    """向用户展示富内容。"""

    items: List[dict] = Field(
        description=(
            "Content items to present. Each item must have 'kind' and 'summary' fields.\n"
            "Supported kinds:\n"
            "- 'image': url (https), summary, caption?, width?, height?, alt_text?\n"
            "- 'table_preview': columns ([{key, label}]), rows ([{col_key: value}]), "
            "summary, title?, total_rows?\n"
            "- 'resource_ref': resource_type (see manifest opens.types — table/doc/slide/"
            "video/site/file/email_thread/webpage/folder/memo/whiteboard/code_file/agenda_event...), "
            "resource_id, summary, resource_name?, open_label?, space_id?, "
            "hint_carrier_app_id? (Agent's suggested carrier appId — user preference always wins). "
            "Example: {kind: 'resource_ref', resource_type: 'table', resource_id: '<tableId>', "
            "summary: 'Imported table'}. Common alias {ref: '<id>', metadata: {type: 'table'}} "
            "is normalized.\n"
            "- 'file': url (https), filename, summary, mime_type?, file_size?\n"
        ),
    )
    title: Optional[str] = Field(None, description="Optional title for the presentation group")
    summary: str = Field(
        description="Overall human-readable description of what is being presented",
    )

    @model_validator(mode="after")
    def _check_items(self) -> "PresentToUserInput":
        if not self.items:
            raise ValueError("items must contain at least one item")
        return self


def _validate_item(idx: int, item: dict) -> Optional[str]:
    """Validate a single presentation item; return error string or None."""
    kind = item.get("kind")
    if not item.get("summary"):
        return f"items[{idx}]: 'summary' is required for every item"
    if kind not in _SUPPORTED_KINDS:
        return f"items[{idx}]: unsupported kind '{kind}'. Supported: {', '.join(sorted(_SUPPORTED_KINDS))}"

    if kind == "image":
        url = item.get("url", "")
        if not url.startswith("https://"):
            return (
                f"items[{idx}]: image url must start with https://. "
                "Upload local files first with: tabtin oss upload <path>"
            )
    elif kind == "table_preview":
        if not item.get("columns"):
            # run_terminal_command_后台执行重构_2026-05-18 §5.4：
            # dogfood 2026-05-18 Agent 把 columns / rows 塞进 item.data.columns
            # 而非顶层，验证器报错只说 "requires columns" Agent 看不懂怎么改。
            # 检测常见错位形态给出精确指引，让 Agent 一次改对。
            data = item.get("data")
            if isinstance(data, dict) and data.get("columns"):
                return (
                    f"items[{idx}]: table_preview requires top-level 'columns' "
                    f"array (you put it inside 'data.columns'). "
                    f"Move 'columns' and 'rows' to top level: "
                    f"{{ kind: 'table_preview', summary, title, columns, rows }}."
                )
            return (
                f"items[{idx}]: table_preview requires 'columns' "
                f"([{{key, label}}]) at top level (NOT inside 'data')"
            )
        rows = item.get("rows", [])
        if len(rows) > _MAX_TABLE_ROWS:
            return (
                f"items[{idx}]: table_preview supports max {_MAX_TABLE_ROWS} rows, "
                f"got {len(rows)}. Truncate and set total_rows for the full count."
            )
    elif kind == "resource_ref":
        rtype = item.get("resource_type", "")
        supported_types = get_supported_resource_types()
        if rtype not in supported_types:
            return (
                f"items[{idx}]: resource_ref resource_type must be one of "
                f"{', '.join(sorted(supported_types))}, got '{rtype}'. "
                "Example: {kind: 'resource_ref', resource_type: 'table', "
                "resource_id: '<tableId>', summary: 'Imported table'}. "
                "If you already have {ref, metadata: {type}}, pass it and it will be normalized."
            )
        if not item.get("resource_id"):
            return (
                f"items[{idx}]: resource_ref requires 'resource_id' (or alias 'ref'). "
                "Example: {kind: 'resource_ref', resource_type: 'table', "
                "resource_id: '<tableId>', summary: 'Imported table'}"
            )
        # 「Agent 产物在 Space 内的打开」机制 B：resource_ref 可选字段
        # - hint_carrier_app_id: D2 第 3 层 Agent hint（建议 carrier appId）
        # - space_id: 资源所属 Space（前端 fallback 当前 selectedSpaceId）
        # - resource_name / open_label: 卡片显示名 / 按钮文案
        # 这些字段不强校验，前端透传到 RichResourceRef
    elif kind == "file":
        url = item.get("url", "")
        if not url.startswith("https://"):
            return (
                f"items[{idx}]: file url must start with https://. "
                "Upload local files first with: tabtin oss upload <path>"
            )
        if not item.get("filename"):
            return f"items[{idx}]: file requires 'filename'"
    elif kind == "widget":
        # Widget Wave 2：Agent 通常通过 `show_widget` 工具直接 emit widget。
        # 但若 caller 把 widget block 通过 present_to_user.items 转发（少见
        # 但合法），至少要求最小字段：summary（已在前面校验）+ code 或 image_url
        # 二选一。code 优先，给桌面端流式渲染；image_url 给移动端 fallback。
        # 严格的字段验证（format 白名单 / code 大小上限）由 `show_widget.py`
        # 主入口承担，本路径只做最小护栏。
        if not item.get("code") and not item.get("url") and not item.get("image_url"):
            return (
                f"items[{idx}]: widget requires either 'code' (SVG markup) or "
                "'image_url' (rendered URL fallback). Prefer the dedicated "
                "show_widget tool — present_to_user is not the primary entry."
            )
    return None


class PresentToUserTool(BaseTool):
    name: str = PRESENT_TO_USER_TOOL_NAME
    description: str = (
        "Present rich content to the user: images, data tables, platform resource "
        "references, or file downloads. Use this after completing work to show "
        "results in a user-friendly way.\n\n"
        "For local files (screenshots, generated charts, etc.), first upload via "
        "run_terminal_command(command=\"tabtin oss upload <path>\") to get an https URL, "
        "then present the URL here.\n\n"
        "Every item requires a 'summary' field — a human-readable description "
        "used as fallback text on mobile and for accessibility."
    )
    execution_mode: str = "server"
    risk_level: str = "safe"
    required_permissions: list[str] = []
    timeout: int = 30
    args_schema: type[PresentToUserInput] = PresentToUserInput

    def run(self, **kwargs: Any) -> str:
        items: list = kwargs.get("items", [])
        title: Optional[str] = kwargs.get("title")
        summary: str = kwargs.get("summary", "")

        validated: List[dict] = []
        errors: List[str] = []
        for i, item in enumerate(items):
            if item.get("kind") == "resource_ref":
                item = _normalize_resource_ref_item(item)
            err = _validate_item(i, item)
            if err:
                errors.append(err)
            else:
                validated.append(item)

        if not validated:
            detail_errors = errors or ["no valid items"]
            preview = "; ".join(detail_errors[:3])
            if len(detail_errors) > 3:
                preview = f"{preview}; (+{len(detail_errors) - 3} more)"
            return json_tool_error(
                f"All {len(items)} item(s) failed validation: {preview}",
                error_kind="invalid_param_format",
                hint=(
                    "Fix each item to use a supported kind and required fields, "
                    "or use show_widget for free-form visual content."
                ),
                retryable=False,
                context={"errors": detail_errors},
            )

        result: dict = {
            "success": True,
            "accepted": len(validated),
            "summary": summary,
            "_blocks": validated,
            "_title": title,
            "__llm_strip__": ["_blocks", "_title"],
        }
        if errors:
            # Partial success warning: keep human-readable item issues for LLM/UI,
            # without inventing a second failure envelope on a successful present.
            result["partial_errors"] = errors
            result["llm_message"] = (
                f"Presented {len(validated)} rich content block(s) to the user. "
                f"Some items were not presented: {'; '.join(errors[:3])}"
                f"{'; (+' + str(len(errors) - 3) + ' more)' if len(errors) > 3 else ''}. "
                "Continue with the accepted content and fix invalid items only if needed."
            )

        return json.dumps(result, ensure_ascii=False)


__all__ = ["PresentToUserTool", "PRESENT_TO_USER_TOOL_NAME"]
