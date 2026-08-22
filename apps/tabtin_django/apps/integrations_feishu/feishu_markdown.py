"""飞书 Docx Markdown 导出 → TabDoc 可解析形态。"""

from __future__ import annotations

from collections import Counter
import re
from typing import Any, Dict, List, Sequence, Tuple
from urllib.parse import unquote

# 飞书 docs/v1/content?content_type=markdown 会把 HTML 写成 \<tag\>，
# 内联解析后变成可见的 <tag> 文本。导入前先还原，再交给 markdown_to_pm_json。
_ESCAPED_ANGLE_RE = re.compile(r"\\([<>])")
_CALLOUT_DIV_RE = re.compile(
    r'<div\s+class="callout"\s*>\s*([\s\S]*?)\s*</div>',
    re.IGNORECASE,
)
_EMPTY_DESTINATION_LINK_RE = re.compile(
    r"^[ \t]*\[((?:\\.|[^\]\\\n])+)\]\([ \t]*\)[ \t]*$",
)
_MARKDOWN_ESCAPE_RE = re.compile(r"\\([\\`*{}\[\]()#+\-.!_>])")
_CODE_FENCE_OPEN_RE = re.compile(r"^(`{3,})([^`]*)$")

_TEXT_BLOCK_FIELDS = {
    2: "text",
    3: "heading1",
    4: "heading2",
    5: "heading3",
    6: "heading4",
    7: "heading5",
    8: "heading6",
    9: "heading7",
    10: "heading8",
    11: "heading9",
    12: "bullet",
    13: "ordered",
    15: "quote",
    17: "todo",
}

# TabDoc can preserve these blocks without semantic loss through Markdown/HTML.
_SUPPORTED_BLOCK_TYPES = frozenset({
    1,  # page
    2,  # text
    3, 4, 5, 6, 7, 8, 9, 10, 11,  # headings
    12, 13,  # lists
    14, 15, 17,  # code, quote, todo
    22,  # divider
    27,  # image (uploaded separately)
    31, 32,  # table / table cell
})

# These containers remain readable, but lose vendor-specific structure or live
# behavior and become static child content in the official Markdown export.
_DEGRADED_BLOCK_TYPES = frozenset({
    19,  # callout
    24, 25,  # grid / grid column
    34,  # quote container
    43,  # board / whiteboard (rendered as a static flow hierarchy)
    44, 45, 46, 47,  # agenda hierarchy
    48,  # link preview
    49, 50,  # source/reference synced blocks
})


def normalize_feishu_docx_markdown(markdown: str) -> str:
    """反转义 Feishu HTML，并拆掉高亮块外壳，便于后端识别表格。"""
    text = (markdown or "").replace("\r\n", "\n").replace("\r", "\n")
    if not text:
        return ""
    text = _ESCAPED_ANGLE_RE.sub(r"\1", text)
    # 高亮块：保留内部文案，避免 \<div class="callout"\> 落成裸标签
    prev = None
    while prev != text:
        prev = text
        text = _CALLOUT_DIV_RE.sub(lambda m: (m.group(1) or "").strip(), text)
    return text


def classify_feishu_docx_blocks(
    blocks: Sequence[Dict[str, Any]],
) -> Dict[str, int]:
    """按 TabDoc 导入保真度统计飞书块；未知新类型默认隐藏。"""
    summary = {"supported": 0, "degraded": 0, "hidden": 0}
    for block in blocks or []:
        block_type = _safe_block_type(block)
        if block_type in _SUPPORTED_BLOCK_TYPES:
            summary["supported"] += 1
        elif block_type in _DEGRADED_BLOCK_TYPES:
            summary["degraded"] += 1
        else:
            summary["hidden"] += 1
    return summary


def sanitize_feishu_docx_markdown_artifacts(
    markdown: str,
    blocks: Sequence[Dict[str, Any]],
) -> Tuple[str, int]:
    """移除官方 Markdown 对不可表示块产生的孤立导出残片。

    候选必须与源块中的文件名、数量和阅读顺序精确匹配；普通正文即使
    与 File/Iframe Block 同名也会保留。若官方导出缺少候选、无法精确
    对齐，则不做删除；代码围栏内的内容一律不参与残片过滤。
    """
    source_occurrences: Counter[Tuple[str, str]] = Counter()
    removal_positions: Dict[Tuple[str, str], set[int]] = {}
    for block in _feishu_docx_blocks_in_reading_order(blocks):
        block_type = _safe_block_type(block)
        if block_type == 23:
            file_data = block.get("file")
            if not isinstance(file_data, dict):
                continue
            name = str(file_data.get("name") or "").strip()
            if name:
                key = ("file", name)
                removal_positions.setdefault(key, set()).add(source_occurrences[key])
                source_occurrences[key] += 1
        elif block_type == 26:
            iframe = block.get("iframe")
            component = iframe.get("component") if isinstance(iframe, dict) else None
            encoded_url = component.get("url") if isinstance(component, dict) else None
            url = unquote(str(encoded_url or "")).strip()
            if url:
                key = ("iframe", url)
                removal_positions.setdefault(key, set()).add(source_occurrences[key])
                source_occurrences[key] += 1
        elif block_type in _TEXT_BLOCK_FIELDS:
            authored_key = _artifact_candidate_key(_feishu_text_block_text(block))
            if authored_key is not None:
                source_occurrences[authored_key] += 1

    removed = 0
    kept_lines: list[str] = []
    lines = (markdown or "").split("\n")
    candidate_keys = _markdown_artifact_candidate_keys(lines)
    markdown_totals = Counter(
        key for key in candidate_keys if key is not None
    )
    markdown_occurrences: Counter[Tuple[str, str]] = Counter()
    for line, candidate_key in zip(lines, candidate_keys):
        if candidate_key is not None:
            position = markdown_occurrences[candidate_key]
            markdown_occurrences[candidate_key] += 1
            source_total = source_occurrences[candidate_key]
            if (
                markdown_totals[candidate_key] == source_total
                and position in removal_positions.get(candidate_key, set())
            ):
                removed += 1
                continue

        kept_lines.append(line)

    return "\n".join(kept_lines), removed


def _artifact_candidate_key(text: str) -> Tuple[str, str] | None:
    """把单行候选归一化成与源 File/Iframe Block 可比的键。"""
    empty_link_match = _EMPTY_DESTINATION_LINK_RE.fullmatch(text or "")
    if empty_link_match:
        label = _MARKDOWN_ESCAPE_RE.sub(r"\1", empty_link_match.group(1)).strip()
        return ("iframe", label) if label else None

    visible = _MARKDOWN_ESCAPE_RE.sub(r"\1", (text or "").strip())
    if visible.startswith("[") and visible.endswith("]"):
        name = visible[1:-1].strip()
        return ("file", name) if name else None
    return None


def _markdown_artifact_candidate_keys(
    lines: Sequence[str],
) -> List[Tuple[str, str] | None]:
    """逐行返回围栏外的残片候选键，保持与原 Markdown 行号对齐。"""
    keys: List[Tuple[str, str] | None] = []
    open_fence_len = 0
    for line in lines:
        stripped = line.strip()
        if open_fence_len:
            keys.append(None)
            if re.fullmatch(r"`{" + str(open_fence_len) + r",}", stripped):
                open_fence_len = 0
            continue

        fence_match = _CODE_FENCE_OPEN_RE.fullmatch(stripped)
        if fence_match:
            open_fence_len = len(fence_match.group(1))
            keys.append(None)
            continue

        keys.append(_artifact_candidate_key(line))
    return keys


def _feishu_text_block_text(block: Dict[str, Any]) -> str:
    field = _TEXT_BLOCK_FIELDS.get(_safe_block_type(block))
    payload = block.get(field) if field and isinstance(block.get(field), dict) else {}
    chunks: List[str] = []
    for element in payload.get("elements") or []:
        if not isinstance(element, dict):
            continue
        text_run = element.get("text_run")
        if isinstance(text_run, dict):
            chunks.append(str(text_run.get("content") or ""))
    return "".join(chunks).strip()


def find_feishu_docx_structure_issues(
    markdown: str,
    blocks: Sequence[Dict[str, Any]],
) -> List[str]:
    """对比源 Code Block 与导入预检结果，发现强确定性的吞文异常。"""
    source_code = [
        _feishu_code_block_text(block)
        for block in _feishu_docx_blocks_in_reading_order(blocks)
        if _safe_block_type(block) == 14
    ]
    if not source_code:
        return []

    from apps.tabdoc.services.markdown_exchange import markdown_to_pm_json

    parsed = markdown_to_pm_json(markdown or "")
    imported_code = [
        _pm_plain_text(node)
        for node in _pm_nodes_by_type(parsed, "codeBlock")
    ]
    issues: List[str] = []
    if len(imported_code) != len(source_code):
        issues.append(
            "代码块数量与飞书源结构不一致："
            f"源 {len(source_code)} 个，预检得到 {len(imported_code)} 个"
        )

    for index, (source_text, imported_text) in enumerate(
        zip(source_code, imported_code),
        start=1,
    ):
        if not source_text.strip() and imported_text:
            issues.append(
                f"第 {index} 个源空代码块在导入预检中吞入了 "
                f"{len(imported_text)} 个字符"
            )
    return issues


def _feishu_docx_blocks_in_reading_order(
    blocks: Sequence[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """按 page/children 树返回阅读顺序；孤立或无 ID block 稳定追加。"""
    rows = [block for block in (blocks or []) if isinstance(block, dict)]
    by_id = {
        str(block.get("block_id")): block
        for block in rows
        if block.get("block_id")
    }
    roots = [
        str(block.get("block_id"))
        for block in rows
        if block.get("block_id") and _safe_block_type(block) == 1
    ]
    ordered: List[Dict[str, Any]] = []
    visited: set[str] = set()

    def visit(block_id: str) -> None:
        if block_id in visited:
            return
        block = by_id.get(block_id)
        if block is None:
            return
        visited.add(block_id)
        ordered.append(block)
        for child_id in block.get("children") or []:
            visit(str(child_id))

    for root_id in roots:
        visit(root_id)
    for block in rows:
        block_id = str(block.get("block_id") or "")
        if block_id:
            visit(block_id)
        else:
            ordered.append(block)
    return ordered


def _safe_block_type(block: Dict[str, Any]) -> int:
    try:
        return int(block.get("block_type") or 0)
    except (AttributeError, TypeError, ValueError):
        return 0


def _feishu_code_block_text(block: Dict[str, Any]) -> str:
    code = block.get("code")
    if not isinstance(code, dict):
        return ""
    chunks: List[str] = []
    for element in code.get("elements") or []:
        if not isinstance(element, dict):
            continue
        for field in ("text_run", "equation"):
            payload = element.get(field)
            if isinstance(payload, dict):
                chunks.append(str(payload.get("content") or ""))
                break
    return "".join(chunks)


def _pm_plain_text(node: Dict[str, Any]) -> str:
    if node.get("type") == "text":
        return str(node.get("text") or "")
    return "".join(
        _pm_plain_text(child)
        for child in (node.get("content") or [])
        if isinstance(child, dict)
    )


def _pm_nodes_by_type(
    node: Dict[str, Any],
    node_type: str,
) -> List[Dict[str, Any]]:
    matches = [node] if node.get("type") == node_type else []
    for child in node.get("content") or []:
        if isinstance(child, dict):
            matches.extend(_pm_nodes_by_type(child, node_type))
    return matches
