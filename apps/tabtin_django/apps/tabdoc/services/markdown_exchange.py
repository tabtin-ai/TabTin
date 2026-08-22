from __future__ import annotations

import html
import math
import logging
import re
import unicodedata
from typing import Any
from uuid import UUID, uuid4

logger = logging.getLogger(__name__)


def ensure_top_level_block_ids(pm_json: dict[str, Any]) -> dict[str, Any]:
    """给所有缺失 blockId 的顶层 block 补一个稳定 UUID（原地修改并返回）。

    blockId 是顶层 block 的稳定锚点（list-blocks / read / update / insert / delete
    都按它定位）。落库前统一补齐，list-blocks 才不会退回到 `auto_{index}` 位置别名——
    位置别名会随并发编辑 / 分段变化漂移，导致 block 操作指错块。
    """
    if not isinstance(pm_json, dict):
        return pm_json
    content = pm_json.get("content")
    if not isinstance(content, list):
        return pm_json
    for node in content:
        if not isinstance(node, dict):
            continue
        attrs = node.setdefault("attrs", {})
        if isinstance(attrs, dict) and not attrs.get("blockId"):
            attrs["blockId"] = str(uuid4())
    return pm_json


def _stable_html_block_id(value: Any) -> str:
    block_id = str(value or "").strip()
    if not block_id or block_id.startswith("auto_"):
        return ""
    return block_id


def _unique_stable_html_file_to_block(pm_json: Any) -> dict[str, str]:
    """Map fileId → stable blockId only when both sides are unique in the doc."""
    if not isinstance(pm_json, dict):
        return {}
    content = pm_json.get("content")
    if not isinstance(content, list):
        return {}

    file_to_blocks: dict[str, list[str]] = {}
    block_counts: dict[str, int] = {}
    for node in content:
        if not isinstance(node, dict) or node.get("type") != "htmlBlock":
            continue
        attrs = node.get("attrs") if isinstance(node.get("attrs"), dict) else {}
        block_id = _stable_html_block_id(attrs.get("blockId"))
        file_id = str(attrs.get("fileId") or "").strip()
        if not block_id or not file_id:
            continue
        file_to_blocks.setdefault(file_id, []).append(block_id)
        block_counts[block_id] = block_counts.get(block_id, 0) + 1

    unique: dict[str, str] = {}
    for file_id, block_ids in file_to_blocks.items():
        if len(block_ids) != 1:
            continue
        block_id = block_ids[0]
        if block_counts.get(block_id, 0) != 1:
            continue
        unique[file_id] = block_id
    return unique


def preserve_stable_html_block_ids(
    incoming_pm_json: dict[str, Any] | None,
    existing_pm_json: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """Restore unambiguous stable htmlBlock ids that a stale collab snapshot dropped.

    Only fills missing / ``auto_*`` ids on the incoming snapshot when the same
    ``fileId`` maps to exactly one stable blockId in *both* snapshots' source
    documents (existing already has it; incoming is missing it). Never guesses
    across duplicate fileIds, duplicate blockIds, or conflicting explicit ids.
    """
    if not isinstance(incoming_pm_json, dict):
        return incoming_pm_json
    content = incoming_pm_json.get("content")
    if not isinstance(content, list):
        return incoming_pm_json

    existing_unique = _unique_stable_html_file_to_block(existing_pm_json)
    if not existing_unique:
        return incoming_pm_json

    # Incoming fileIds that already carry a stable id (or appear more than once)
    # must not be overwritten / claimed. Also refuse to restore a blockId that is
    # already occupied elsewhere in the incoming snapshot.
    incoming_file_counts: dict[str, int] = {}
    occupied_block_ids: set[str] = set()
    for node in content:
        if not isinstance(node, dict) or node.get("type") != "htmlBlock":
            continue
        attrs = node.get("attrs") if isinstance(node.get("attrs"), dict) else {}
        file_id = str(attrs.get("fileId") or "").strip()
        if file_id:
            incoming_file_counts[file_id] = incoming_file_counts.get(file_id, 0) + 1
        occupied = _stable_html_block_id(attrs.get("blockId"))
        if occupied:
            occupied_block_ids.add(occupied)

    changed = False
    new_content: list[Any] = []
    for node in content:
        if not isinstance(node, dict) or node.get("type") != "htmlBlock":
            new_content.append(node)
            continue
        attrs = dict(node.get("attrs") if isinstance(node.get("attrs"), dict) else {})
        file_id = str(attrs.get("fileId") or "").strip()
        current_id = _stable_html_block_id(attrs.get("blockId"))
        candidate_id = existing_unique.get(file_id, "")
        if (
            not current_id
            and file_id
            and incoming_file_counts.get(file_id, 0) == 1
            and candidate_id
            and candidate_id not in occupied_block_ids
        ):
            attrs["blockId"] = candidate_id
            occupied_block_ids.add(candidate_id)
            changed = True
            new_content.append({**node, "attrs": attrs})
        else:
            new_content.append(node)

    if not changed:
        return incoming_pm_json
    return {**incoming_pm_json, "content": new_content}


_HTMLBLOCK_LEAK_IN_TEXT_RE = re.compile(r":::htmlblock\{")
_HTMLBLOCK_OPEN_LINE_RE = re.compile(r"^:::htmlblock\{(.+)\}\s*$")
_HTMLBLOCK_CLOSE_LINE_RE = re.compile(r"^:::\s*$")


def _extract_paragraph_text(node: dict[str, Any]) -> str:
    children = node.get("content")
    if not isinstance(children, list):
        return ""
    parts: list[str] = []
    for child in children:
        if isinstance(child, dict) and child.get("type") == "text":
            text = child.get("text")
            if isinstance(text, str):
                parts.append(text)
    return "".join(parts)


def normalize_leaked_htmlblock_markdown(text: str) -> str:
    """tiptap-markdown 段落泄漏形态 → 标准 :::htmlblock markdown（两行闭合）。"""
    normalized = text.strip().replace("\\_", "_")
    if not _HTMLBLOCK_LEAK_IN_TEXT_RE.search(normalized):
        return normalized
    if not normalized.startswith(":::htmlblock{"):
        idx = normalized.find(":::htmlblock{")
        if idx >= 0:
            normalized = normalized[idx:]
    normalized = re.sub(r"\}\s+:::\s*$", "}\n:::", normalized)
    last_line = normalized.rsplit("\n", 1)[-1].strip() if normalized else ""
    if not _HTMLBLOCK_CLOSE_LINE_RE.match(last_line):
        normalized = f"{normalized.rstrip()}\n:::"
    return normalized


def repair_leaked_htmlblock_in_pm_json(pm_json: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    """把段落里泄漏的 :::htmlblock{...} 修回 htmlBlock 节点。"""
    if not isinstance(pm_json, dict):
        return pm_json, False
    content = pm_json.get("content")
    if not isinstance(content, list) or not content:
        return pm_json, False

    next_content: list[Any] = []
    repaired = False
    index = 0
    while index < len(content):
        node = content[index]
        if not isinstance(node, dict) or node.get("type") != "paragraph":
            next_content.append(node)
            index += 1
            continue

        text = _extract_paragraph_text(node)
        next_node = content[index + 1] if index + 1 < len(content) else None
        next_text = (
            _extract_paragraph_text(next_node)
            if isinstance(next_node, dict) and next_node.get("type") == "paragraph"
            else ""
        )

        if _HTMLBLOCK_OPEN_LINE_RE.match(text.strip()) and _HTMLBLOCK_CLOSE_LINE_RE.match(next_text.strip()):
            try:
                parsed = markdown_to_pm_json(f"{text.strip()}\n:::")
                block = (parsed.get("content") or [None])[0]
                if isinstance(block, dict) and block.get("type") == "htmlBlock":
                    source_attrs = node.get("attrs") if isinstance(node.get("attrs"), dict) else {}
                    block_id = source_attrs.get("blockId")
                    if block_id:
                        block.setdefault("attrs", {})["blockId"] = block_id
                    next_content.append(block)
                    repaired = True
                    index += 2
                    continue
            except ValueError:
                pass

        if _HTMLBLOCK_LEAK_IN_TEXT_RE.search(text):
            try:
                parsed = markdown_to_pm_json(normalize_leaked_htmlblock_markdown(text))
                block = next(
                    (item for item in (parsed.get("content") or []) if isinstance(item, dict) and item.get("type") == "htmlBlock"),
                    None,
                )
                if isinstance(block, dict):
                    source_attrs = node.get("attrs") if isinstance(node.get("attrs"), dict) else {}
                    block_id = source_attrs.get("blockId")
                    if block_id:
                        block.setdefault("attrs", {})["blockId"] = block_id
                    next_content.append(block)
                    repaired = True
                    index += 1
                    continue
            except ValueError:
                pass

        next_content.append(node)
        index += 1

    if not repaired:
        return pm_json, False
    return {**pm_json, "content": next_content}, True


_SAFE_URL_SCHEMES = ("http://", "https://", "mailto:", "tel:")

_SAFE_DATA_IMAGE_RE = re.compile(
    r"^data:image/(?:png|jpeg|jpg|gif|webp|bmp|ico|avif);base64,",
    re.IGNORECASE,
)
_IMAGE_DIMENSION_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$", re.IGNORECASE)
_HTML_IMG_STANDALONE_RE = re.compile(r"^<img\b(?P<attrs>[^>]*)/?>$", re.IGNORECASE | re.DOTALL)
_HTML_ATTR_RE = re.compile(
    r"(?P<name>[a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?P<quote>['\"])(?P<value>.*?)(?P=quote)",
    re.DOTALL,
)
_MAX_IMAGE_DIMENSION = 10000
_UNSAFE_URL_SCHEME_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*:")
_UNSAFE_RELATIVE_URL_CHARS_RE = re.compile(r"[\s<>'\"]")


_MAX_QUOTE_DEPTH = 20
_MAX_INLINE_DEPTH = 20


_ZERO_WIDTH_CHARS = frozenset('\u200b\u200c\u200d\u2060\ufeff')


def _is_unicode_word_char(ch: str) -> bool:
    """Unicode letter or digit (covers CJK, Latin, etc.) for flanking checks."""
    if not ch:
        return False
    cat = unicodedata.category(ch)
    return cat[0] in ('L', 'N')


def _flanking_char_before(text: str, pos: int) -> str:
    """Get the effective character before *pos*, skipping zero-width chars."""
    i = pos - 1
    while i >= 0 and text[i] in _ZERO_WIDTH_CHARS:
        i -= 1
    return text[i] if i >= 0 else ""


def _flanking_char_after(text: str, pos: int) -> str:
    """Get the effective character at/after *pos*, skipping zero-width chars."""
    i = pos
    while i < len(text) and text[i] in _ZERO_WIDTH_CHARS:
        i += 1
    return text[i] if i < len(text) else ""


def _is_safe_url(url: str) -> bool:
    """仅允许安全的 URL scheme，防止 javascript:/data: 等注入。

    允许的模式（与前端 SAFE_URL_RE 对齐，PAR-016）：
    - 绝对 URL：http://, https://, mailto:, tel:
    - data URI：仅 base64 编码的光栅图片（排除 svg+xml 避免嵌入脚本）
    - 相对路径：以 / 开头但非 //（协议相对 URL 已在 PAR-052 中禁止）
    - 页内锚点：以 # 开头
    """
    normalized = (url or "").strip()
    if not normalized:
        return False
    lower = normalized.lower()
    if any(lower.startswith(s) for s in _SAFE_URL_SCHEMES):
        return True
    if _SAFE_DATA_IMAGE_RE.match(normalized):
        return True
    if normalized.startswith("/") and not normalized.startswith("//"):
        return True
    if normalized.startswith("#"):
        return True
    if (
        not normalized.startswith("//")
        and not _UNSAFE_URL_SCHEME_RE.match(normalized)
        and not _UNSAFE_RELATIVE_URL_CHARS_RE.search(normalized)
    ):
        return True
    return False


def _coerce_image_dimension(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        numeric = float(value)
    else:
        match = _IMAGE_DIMENSION_RE.match(str(value))
        if not match:
            return None
        numeric = float(match.group(1))
    if not math.isfinite(numeric) or numeric <= 0:
        return None
    return min(_MAX_IMAGE_DIMENSION, max(1, int(round(numeric))))


def _render_image_dimension_attrs(attrs: dict[str, Any], *, include_style: bool) -> str:
    width = _coerce_image_dimension(attrs.get("width"))
    height = _coerce_image_dimension(attrs.get("height"))
    parts: list[str] = []
    style_parts: list[str] = []
    if width is not None:
        parts.append(f'width="{width}"')
        style_parts.append(f"width: {width}px")
    if height is not None:
        parts.append(f'height="{height}"')
        style_parts.append(f"height: {height}px")
    if include_style and style_parts:
        parts.append(f'style="{html.escape("; ".join(style_parts), quote=True)}"')
    return "".join(f" {part}" for part in parts)


def _normalize_markdown(markdown: str) -> str:
    return (markdown or "").replace("\r\n", "\n").replace("\r", "\n")


def _build_text_node(text: str, marks: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    node: dict[str, Any] = {"type": "text", "text": text}
    if marks:
        node["marks"] = marks
    return node


def _find_matching_bracket(text: str, open_idx: int, open_ch: str, close_ch: str) -> int:
    """找到匹配的右括号，支持嵌套深度追踪。返回 -1 表示未找到。"""
    if open_idx >= len(text) or text[open_idx] != open_ch:
        return -1
    depth = 1
    i = open_idx + 1
    while i < len(text):
        ch = text[i]
        if ch == "\\" and i + 1 < len(text):
            i += 2
            continue
        if ch == open_ch:
            depth += 1
        elif ch == close_ch:
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return -1


def _find_closing_delimiter(text: str, start: int, delimiter: str) -> int:
    """查找闭合定界符位置，跳过反斜杠转义。"""
    pos = start
    while pos < len(text):
        idx = text.find(delimiter, pos)
        if idx == -1:
            return -1
        if idx > 0 and text[idx - 1] == "\\":
            pos = idx + 1
            continue
        return idx
    return -1


def _find_closing_underscore(text: str, start: int, delimiter: str) -> int:
    """Find closing underscore delimiter respecting CommonMark flanking rules.

    Closing ``_`` must not be immediately followed by a Unicode word character.
    """
    pos = start
    dlen = len(delimiter)
    while pos < len(text):
        idx = text.find(delimiter, pos)
        if idx == -1:
            return -1
        if idx > 0 and text[idx - 1] == "\\":
            pos = idx + 1
            continue
        char_after = _flanking_char_after(text, idx + dlen)
        if _is_unicode_word_char(char_after):
            pos = idx + 1
            continue
        return idx
    return -1


def _build_image_node(
    src: str, alt: str, marks: list[dict[str, Any]] | None = None
) -> dict[str, Any]:
    attrs: dict[str, Any] = {"src": src, "alt": alt or None, "title": None}
    if src.startswith("tabtin-file://asset/"):
        try:
            attrs["fileId"] = str(UUID(src.removeprefix("tabtin-file://asset/")))
            attrs["src"] = ""
        except ValueError:
            pass
    node: dict[str, Any] = {"type": "image", "attrs": attrs}
    if marks:
        node["marks"] = marks
    return node


def _parse_html_attrs(attrs_text: str) -> dict[str, str]:
    attrs: dict[str, str] = {}
    for match in _HTML_ATTR_RE.finditer(attrs_text or ""):
        attrs[match.group("name").lower()] = html.unescape(match.group("value")).strip()
    return attrs


def _build_standalone_html_image_paragraph(line: str) -> dict[str, Any] | None:
    match = _HTML_IMG_STANDALONE_RE.match(line.strip())
    if not match:
        return None
    attrs = _parse_html_attrs(match.group("attrs"))
    src = attrs.get("src", "")
    stable_file_ref = bool(
        re.fullmatch(r"tabtin-file://asset/[0-9a-fA-F-]{36}", src)
    )
    if not _is_safe_url(src) and not stable_file_ref:
        return None

    image_node = _build_image_node(src, attrs.get("alt") or "")
    image_attrs = image_node["attrs"]
    image_attrs["title"] = attrs.get("title") or None
    for name in ("width", "height"):
        dimension = _coerce_image_dimension(attrs.get(name))
        if dimension is not None:
            image_attrs[name] = dimension

    return {
        "type": "paragraph",
        "content": [image_node],
    }


def _tokenize_inline(text: str, *, _depth: int = 0) -> list[dict[str, Any]]:
    """
    扫描式内联解析器，支持嵌套结构。

    与前端 tokenizeInline 对齐的解析策略：
    1. 行内代码 `...`
    2. 图片 ![alt](url)
    3. 链接 [text](url) — 递归解析 linkText，支持 image-in-link
    4. 粗斜体 ***...***
    5. 粗体 **...**
    6. 斜体 *...*
    7. 删除线 ~~...~~
    """
    if not text:
        return []
    if _depth >= _MAX_INLINE_DEPTH:
        return [_build_text_node(text)]

    nodes: list[dict[str, Any]] = []
    pos = 0
    plain_buf: list[str] = []

    def flush_plain() -> None:
        if plain_buf:
            nodes.append(_build_text_node("".join(plain_buf)))
            plain_buf.clear()

    def push_with_marks(
        inner_nodes: list[dict[str, Any]],
        outer_marks: list[dict[str, Any]],
    ) -> None:
        for n in inner_nodes:
            merged = list(outer_marks)
            merged.extend(n.get("marks") or [])
            if merged:
                nodes.append({**n, "marks": merged})
            else:
                nodes.append(n)

    while pos < len(text):
        matched = False

        # 1. 行内代码
        if text[pos] == "`":
            end = text.find("`", pos + 1)
            if end != -1:
                flush_plain()
                nodes.append(_build_text_node(text[pos + 1 : end], [{"type": "code"}]))
                pos = end + 1
                matched = True

        # 2. 图片: ![alt](url)
        if not matched and pos + 1 < len(text) and text[pos] == "!" and text[pos + 1] == "[":
            alt_end = _find_matching_bracket(text, pos + 1, "[", "]")
            if alt_end != -1 and alt_end + 1 < len(text) and text[alt_end + 1] == "(":
                url_end = _find_matching_bracket(text, alt_end + 1, "(", ")")
                if url_end != -1:
                    flush_plain()
                    alt = text[pos + 2 : alt_end]
                    src = text[alt_end + 2 : url_end]
                    nodes.append(_build_image_node(src, alt))
                    pos = url_end + 1
                    matched = True

        # 3. 链接: [text](url) — 递归解析 linkText
        if not matched and text[pos] == "[":
            text_end = _find_matching_bracket(text, pos, "[", "]")
            if text_end != -1 and text_end + 1 < len(text) and text[text_end + 1] == "(":
                url_end = _find_matching_bracket(text, text_end + 1, "(", ")")
                if url_end != -1:
                    flush_plain()
                    link_text = text[pos + 1 : text_end]
                    href = text[text_end + 2 : url_end]
                    link_mark = {"type": "link", "attrs": {"href": href, "target": "_blank"}}
                    inner_nodes = _tokenize_inline(link_text, _depth=_depth + 1)
                    push_with_marks(inner_nodes, [link_mark])
                    pos = url_end + 1
                    matched = True

        # 4. 行内数学: $...$ (非 $$)
        if not matched and text[pos] == "$" and (pos + 1 >= len(text) or text[pos + 1] != "$"):
            search_pos = pos + 1
            end = -1
            while search_pos < len(text):
                idx = text.find("$", search_pos)
                if idx == -1:
                    break
                if idx > 0 and text[idx - 1] == "\\":
                    search_pos = idx + 1
                    continue
                end = idx
                break
            if end != -1 and end > pos + 1:
                flush_plain()
                latex = text[pos + 1 : end].replace("\\$", "$")
                nodes.append({"type": "mathematics", "attrs": {"latex": latex, "display": False}})
                pos = end + 1
                matched = True

        # 5. 粗斜体: ***...*** 或 ___...___
        if not matched and text[pos : pos + 3] == "***":
            closer = _find_closing_delimiter(text, pos + 3, "***")
            if closer != -1:
                flush_plain()
                content = text[pos + 3 : closer]
                inner_nodes = _tokenize_inline(content, _depth=_depth + 1)
                push_with_marks(inner_nodes, [{"type": "bold"}, {"type": "italic"}])
                pos = closer + 3
                matched = True

        # 6. 粗体: **...** 或 __...__
        if not matched and text[pos : pos + 2] == "**":
            closer = _find_closing_delimiter(text, pos + 2, "**")
            if closer != -1:
                flush_plain()
                content = text[pos + 2 : closer]
                inner_nodes = _tokenize_inline(content, _depth=_depth + 1)
                push_with_marks(inner_nodes, [{"type": "bold"}])
                pos = closer + 2
                matched = True

        # 7. 斜体: *...* 或 _..._
        if not matched and text[pos] == "*":
            closer = _find_closing_delimiter(text, pos + 1, "*")
            if closer != -1:
                flush_plain()
                content = text[pos + 1 : closer]
                inner_nodes = _tokenize_inline(content, _depth=_depth + 1)
                push_with_marks(inner_nodes, [{"type": "italic"}])
                pos = closer + 1
                matched = True

        # 8. 删除线: ~~...~~
        if not matched and text[pos : pos + 2] == "~~":
            closer = _find_closing_delimiter(text, pos + 2, "~~")
            if closer != -1:
                flush_plain()
                content = text[pos + 2 : closer]
                inner_nodes = _tokenize_inline(content, _depth=_depth + 1)
                push_with_marks(inner_nodes, [{"type": "strike"}])
                pos = closer + 2
                matched = True

        # 9. 下划线语法: ___...___ / __...__ / _..._
        #    CommonMark flanking: opening _ must not be preceded by word char;
        #    closing _ must not be followed by word char (handled by _find_closing_underscore).
        if not matched and text[pos] == "_":
            char_before = _flanking_char_before(text, pos)
            if not _is_unicode_word_char(char_before):
                under_count = 0
                while pos + under_count < len(text) and text[pos + under_count] == "_":
                    under_count += 1

                if under_count >= 3:
                    closer = _find_closing_underscore(text, pos + 3, "___")
                    if closer != -1:
                        flush_plain()
                        content = text[pos + 3 : closer]
                        inner_nodes = _tokenize_inline(content, _depth=_depth + 1)
                        push_with_marks(inner_nodes, [{"type": "bold"}, {"type": "italic"}])
                        pos = closer + 3
                        matched = True

                if not matched and under_count >= 2:
                    closer = _find_closing_underscore(text, pos + 2, "__")
                    if closer != -1:
                        flush_plain()
                        content = text[pos + 2 : closer]
                        inner_nodes = _tokenize_inline(content, _depth=_depth + 1)
                        push_with_marks(inner_nodes, [{"type": "bold"}])
                        pos = closer + 2
                        matched = True

                if not matched and under_count >= 1:
                    closer = _find_closing_underscore(text, pos + 1, "_")
                    if closer != -1:
                        flush_plain()
                        content = text[pos + 1 : closer]
                        inner_nodes = _tokenize_inline(content, _depth=_depth + 1)
                        push_with_marks(inner_nodes, [{"type": "italic"}])
                        pos = closer + 1
                        matched = True

        # 10. Hard break: two+ trailing spaces followed by \n
        if not matched and text[pos] == ' ':
            sp_end = pos
            while sp_end < len(text) and text[sp_end] == ' ':
                sp_end += 1
            if sp_end - pos >= 2 and sp_end < len(text) and text[sp_end] == '\n':
                flush_plain()
                nodes.append({"type": "hardBreak"})
                pos = sp_end + 1
                matched = True

        if not matched:
            plain_buf.append(text[pos])
            pos += 1

    flush_plain()
    return nodes if nodes else [_build_text_node(text)]


def _parse_inline_text(text: str) -> list[dict[str, Any]]:
    """将 Markdown 内联文本解析为带 marks 的 ProseMirror 节点列表"""
    if not text:
        return []
    return _tokenize_inline(text)


def _build_paragraph_node(text: str) -> dict[str, Any]:
    cleaned = (text or "").strip()
    return {
        "type": "paragraph",
        "content": _parse_inline_text(cleaned) if cleaned else [],
    }


_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+)$")
_TASK_RE = re.compile(r"^[-*]\s+\[( |x|X)\]\s+(.+)$")
_BULLET_RE = re.compile(r"^[-*]\s+(.+)$")
_ORDERED_RE = re.compile(r"^(\d+)\.\s+(.+)$")


def _measure_indent(line: str) -> int:
    """Count leading whitespace (tab → 4 spaces)."""
    count = 0
    for ch in line:
        if ch == " ":
            count += 1
        elif ch == "\t":
            count += 4
        else:
            break
    return count


def _parse_list_block(
    lines: list[str], start: int,
) -> tuple[dict[str, Any] | None, int]:
    """Recursively parse a list block (task / bullet / ordered), preserving nesting.

    Returns ``(list_node, next_index)``.  ``(None, start)`` when the line at
    *start* is not a recognised list item.
    """
    if start >= len(lines):
        return None, start

    first_line = lines[start]
    base_indent = _measure_indent(first_line)
    first_stripped = first_line.strip()

    task_m = _TASK_RE.match(first_stripped)
    bullet_m = None if task_m else _BULLET_RE.match(first_stripped)
    ordered_m = None if (task_m or bullet_m) else _ORDERED_RE.match(first_stripped)

    if task_m:
        list_type = "task"
    elif bullet_m:
        list_type = "bullet"
    elif ordered_m:
        list_type = "ordered"
    else:
        return None, start

    order_start = int(ordered_m.group(1)) if ordered_m else 1
    items: list[dict[str, Any]] = []
    index = start

    while index < len(lines):
        cur_line = lines[index]
        cur_stripped = cur_line.strip()

        if not cur_stripped:
            peek = index + 1
            while peek < len(lines) and not lines[peek].strip():
                peek += 1
            if peek < len(lines):
                peek_line = lines[peek]
                peek_indent = _measure_indent(peek_line)
                peek_stripped = peek_line.strip()
                if peek_indent > base_indent:
                    index = peek
                    continue
                if peek_indent == base_indent:
                    is_continuation = (
                        (list_type == "task" and _TASK_RE.match(peek_stripped))
                        or (list_type == "bullet" and _BULLET_RE.match(peek_stripped))
                        or (list_type == "ordered" and _ORDERED_RE.match(peek_stripped))
                    )
                    if is_continuation:
                        index = peek
                        continue
            break

        indent = _measure_indent(cur_line)

        if indent < base_indent:
            break

        if indent > base_indent:
            nested_node, index = _parse_list_block(lines, index)
            if nested_node and items:
                items[-1]["content"].append(nested_node)
            elif not nested_node:
                break
            continue

        tm = _TASK_RE.match(cur_stripped)
        bm = None if tm else _BULLET_RE.match(cur_stripped)
        om = None if (tm or bm) else _ORDERED_RE.match(cur_stripped)

        if list_type == "task" and tm:
            checked = tm.group(1).lower() == "x"
            text = tm.group(2).strip()
            items.append({
                "type": "taskItem",
                "attrs": {"checked": checked},
                "content": [_build_paragraph_node(text)],
            })
            index += 1
        elif list_type == "bullet" and bm:
            text = bm.group(1).strip()
            items.append({
                "type": "listItem",
                "content": [_build_paragraph_node(text)],
            })
            index += 1
        elif list_type == "ordered" and om:
            text = om.group(2).strip()
            items.append({
                "type": "listItem",
                "content": [_build_paragraph_node(text)],
            })
            index += 1
        else:
            break

    if not items:
        return None, start

    if list_type == "task":
        return {"type": "taskList", "content": items}, index
    if list_type == "ordered":
        return {"type": "orderedList", "attrs": {"start": order_start}, "content": items}, index
    return {"type": "bulletList", "content": items}, index
# CommonMark allows arbitrary non-backtick text after an opening backtick fence.
# Feishu uses human-readable labels such as ``Plain Text`` here.
_CODE_FENCE_RE = re.compile(r"^(`{3,})([^`]*)$")
_TABLE_DIVIDER_RE = re.compile(r"^\s*\|?[\s:-]+\|[\s|:-]*\|?\s*$")
_APP_BLOCK_CLOSE_RE = re.compile(r"^:::\s*$")
_TABDATA_OPEN_RE = re.compile(r"^:::tabdata\{(.*)\}\s*$")
_TABWHITEBOARD_OPEN_RE = re.compile(r"^:::tabwhiteboard\{(.+)\}\s*$")
_HTMLBLOCK_OPEN_RE = re.compile(r"^:::htmlblock\{(.+)\}\s*$")
_HR_RE = re.compile(r"^(-{3,}|\*{3,}|_{3,})\s*$")
_SETEXT_H1_RE = re.compile(r"^=+\s*$")
_SETEXT_H2_RE = re.compile(r"^-+\s*$")
_BLOCK_MATH_OPEN_RE = re.compile(r"^\$\$\s*$")


def _parse_table_row(line: str) -> list[str]:
    """Split a Markdown table row into cell texts, respecting ``\\|`` escapes."""
    content = line.strip()
    if content.startswith("|"):
        content = content[1:]
    if content.endswith("|"):
        content = content[:-1]
    cells: list[str] = []
    buf: list[str] = []
    i = 0
    while i < len(content):
        if content[i] == "\\" and i + 1 < len(content):
            if content[i + 1] == "|":
                buf.append("|")
                i += 2
                continue
            if content[i + 1] == "\\":
                buf.append("\\")
                i += 2
                continue
        if content[i] == "|":
            cells.append("".join(buf).strip())
            buf = []
            i += 1
            continue
        buf.append(content[i])
        i += 1
    cells.append("".join(buf).strip())
    return cells


def _build_table_node(rows: list[list[str]]) -> dict[str, Any]:
    table_rows: list[dict[str, Any]] = []
    for row_index, row in enumerate(rows):
        cells: list[dict[str, Any]] = []
        for cell_text in row:
            node_type = "tableHeader" if row_index == 0 else "tableCell"
            cells.append(
                {
                    "type": node_type,
                    "content": [_build_paragraph_node(cell_text)],
                }
            )
        table_rows.append(
            {
                "type": "tableRow",
                "content": cells,
            }
        )
    return {
        "type": "table",
        "content": table_rows,
    }


_HTML_TABLE_OPEN_RE = re.compile(r"^<table[\s>]", re.IGNORECASE)
_HTML_TABLE_CLOSE_RE = re.compile(r"</table\s*>", re.IGNORECASE)
_HTML_TR_RE = re.compile(r"<tr[^>]*>([\s\S]*?)</tr>", re.IGNORECASE)
_HTML_CELL_RE = re.compile(r"<(th|td)([^>]*)>([\s\S]*?)</\1>", re.IGNORECASE)
_HTML_BR_RE = re.compile(r"<br\s*/?>", re.IGNORECASE)
_HTML_STRONG_RE = re.compile(r"<(strong|b)(?:\s[^>]*)?>([\s\S]*?)</\1>", re.IGNORECASE)
_HTML_EM_RE = re.compile(r"<(em|i)(?:\s[^>]*)?>([\s\S]*?)</\1>", re.IGNORECASE)
_HTML_TAG_RE = re.compile(r"<[^>]+>")


def _html_cell_inner_to_text(raw: str) -> str:
    """HTML 单元格 → 可供内联 Markdown 解析的纯文本（剥标签、保留 ** / *）。"""
    text = raw or ""
    text = _HTML_BR_RE.sub("\n", text)
    text = _HTML_STRONG_RE.sub(r"**\2**", text)
    text = _HTML_EM_RE.sub(r"*\2*", text)
    text = _HTML_TAG_RE.sub("", text)
    return html.unescape(text).strip()


def _parse_html_table_block(html_text: str) -> dict[str, Any]:
    """解析 HTML ``<table>``（对齐前端 parseHtmlTableBlock，含 colspan/rowspan）。"""
    rows: list[dict[str, Any]] = []
    for tr_match in _HTML_TR_RE.finditer(html_text or ""):
        cells: list[dict[str, Any]] = []
        for cell_match in _HTML_CELL_RE.finditer(tr_match.group(1) or ""):
            cell_tag = cell_match.group(1).lower()
            attrs_str = cell_match.group(2) or ""
            cell_text = _html_cell_inner_to_text(cell_match.group(3) or "")
            colspan_match = re.search(r'colspan\s*=\s*["\']?(\d+)', attrs_str, re.I)
            rowspan_match = re.search(r'rowspan\s*=\s*["\']?(\d+)', attrs_str, re.I)
            colspan = int(colspan_match.group(1)) if colspan_match else 1
            rowspan = int(rowspan_match.group(1)) if rowspan_match else 1
            cell_node: dict[str, Any] = {
                "type": "tableHeader" if cell_tag == "th" else "tableCell",
                "content": [_build_paragraph_node(cell_text)],
            }
            if colspan > 1 or rowspan > 1:
                cell_attrs: dict[str, Any] = {}
                if colspan > 1:
                    cell_attrs["colspan"] = colspan
                if rowspan > 1:
                    cell_attrs["rowspan"] = rowspan
                cell_node["attrs"] = cell_attrs
            cells.append(cell_node)
        if cells:
            rows.append({"type": "tableRow", "content": cells})
    if not rows:
        rows = [
            {
                "type": "tableRow",
                "content": [
                    {
                        "type": "tableCell",
                        "content": [_build_paragraph_node("")],
                    }
                ],
            }
        ]
    return {"type": "table", "content": rows}


def _parse_directive_attrs(attrs_str: str) -> dict[str, list[str]]:
    """解析空白分隔的 ``name="value"`` 属性，保留重复项供调用方判歧义。"""
    parsed: dict[str, list[str]] = {}
    index = 0
    length = len(attrs_str)
    while index < length:
        while index < length and attrs_str[index] in " \t\r\n":
            index += 1
        if index >= length:
            break

        name_start = index
        while index < length and (
            ("a" <= attrs_str[index] <= "z")
            or ("A" <= attrs_str[index] <= "Z")
            or ("0" <= attrs_str[index] <= "9")
            or attrs_str[index] in "_-"
        ):
            index += 1
        if name_start == index or index >= length or attrs_str[index] != "=":
            raise ValueError(":::tabdata 属性名后必须紧跟 =")
        name = attrs_str[name_start:index]
        index += 1
        if index >= length or attrs_str[index] != '"':
            raise ValueError(f":::tabdata 的 {name} 必须使用双引号值")
        index += 1

        value: list[str] = []
        closed = False
        while index < length:
            char = attrs_str[index]
            if char == "\\":
                if index + 1 >= length:
                    raise ValueError(f":::tabdata 的 {name} 转义不完整")
                index += 1
                value.append(attrs_str[index])
                index += 1
                continue
            if char == '"':
                index += 1
                closed = True
                break
            value.append(char)
            index += 1
        if not closed:
            raise ValueError(f":::tabdata 的 {name} 双引号未闭合")
        if index < length and attrs_str[index] not in " \t\r\n":
            raise ValueError(f":::tabdata 的 {name} 后必须是空白或属性结尾")
        parsed.setdefault(name, []).append("".join(value))
    return parsed


def _parse_quoted_attr(attrs_str: str, name: str) -> str | None:
    # 属性值用单反斜杠转义（`_esc_attr`: \\→\\\\, "→\\"），因此提取正则的转义分支必须
    # 是「一个反斜杠 + 任意字符」(\\.)，与 `_unescape_attr_value` 的 r"\\(.)" 对齐。
    match = re.search(
        rf'(?:^|\s){re.escape(name)}="((?:[^"\\]|\\.)*)"',
        attrs_str,
    )
    if not match:
        return None
    return re.sub(r"\\(.)", r"\1", match.group(1))


def _parse_tabdata_block_attrs(attrs_str: str) -> dict[str, Any]:
    # ：只认双引号 tableId；无引号/空值曾静默落成空字符串，
    # Electron 显示「未关联表格」，API 仍 200。这里硬失败，逼 Agent 改写法。
    parsed = _parse_directive_attrs(attrs_str)
    table_ids = parsed.get("tableId", [])
    if not table_ids:
        raise ValueError(
            ':::tabdata 缺少必填属性 tableId="..."。'
            "普通 markdown 管道表只生成 table block，不等于多维表 tabdataBlock。"
            "推荐：tabtin doc embed-table <doc-id> --table-id <table-id>"
        )
    if len(table_ids) > 1:
        raise ValueError(
            ":::tabdata 的 tableId 不能重复。"
            "请只保留一个明确的 tableId；推荐使用 tabtin doc embed-table。"
        )
    table_id = table_ids[0]
    if not str(table_id).strip():
        raise ValueError(
            ':::tabdata 的 tableId 不能为空。'
            "请传入真实 TabData id，或使用 tabtin doc embed-table。"
        )
    view_values = parsed.get("viewId", [])
    title_values = parsed.get("title", [])
    max_height_values = parsed.get("maxHeight", [])
    view_id = view_values[0] if view_values else None
    title = (title_values[0] if title_values else None) or "未命名表格"
    max_height_raw = max_height_values[0] if max_height_values else None
    try:
        max_height = int(max_height_raw) if max_height_raw else 400
    except (TypeError, ValueError, OverflowError):
        max_height = 400
    return {
        "tableId": table_id,
        "viewId": view_id or None,
        "title": title,
        "maxHeight": max_height if max_height > 0 else 400,
    }


def _parse_htmlblock_attrs(attrs_str: str) -> dict[str, Any]:
    file_id = _parse_quoted_attr(attrs_str, "fileId") or ""
    src = _parse_quoted_attr(attrs_str, "src") or ""
    title = _parse_quoted_attr(attrs_str, "title") or "未命名 HTML"
    height_raw = _parse_quoted_attr(attrs_str, "height")
    try:
        height = int(height_raw) if height_raw else 480
    except (TypeError, ValueError, OverflowError):
        height = 480
    return {
        "fileId": file_id,
        "src": src,
        "title": title,
        "height": height if height > 0 else 480,
    }


def _coerce_max_height(attrs: dict[str, Any]) -> int | None:
    raw_max_height = attrs.get("maxHeight")
    try:
        max_height = int(raw_max_height)
    except (TypeError, ValueError, OverflowError):
        return None
    return max_height if max_height > 0 else None


# htmlBlock iframe src 只允许绝对 http/https（与 TS 侧 HTML_BLOCK_SRC_RE 一致）。
# 比 _is_safe_url 更严：iframe src 语义只应加载可导航网页，相对路径 / mailto / tel /
# data: 一律不输出活跃 src（nh3 的 url_schemes 是第二道闸，这里是第一道）。
_HTMLBLOCK_IFRAME_SRC_RE = re.compile(r"^https?://", re.IGNORECASE)


def _is_safe_htmlblock_iframe_src(url: str) -> bool:
    return bool(_HTMLBLOCK_IFRAME_SRC_RE.match((url or "").strip()))


def _coerce_html_height(attrs: dict[str, Any]) -> int:
    """htmlBlock height 强制转 int，非法/缺省回退 480（序列化时始终全量输出）。"""
    raw_height = attrs.get("height")
    try:
        height = int(raw_height)
    except (TypeError, ValueError, OverflowError):
        return 480
    return height if height > 0 else 480


_MAX_MARKDOWN_SIZE = 5 * 1024 * 1024  # 5 MB
_MAX_MARKDOWN_LINES = 200_000


def markdown_to_pm_json(markdown: str, *, _depth: int = 0) -> dict[str, Any]:
    normalized = _normalize_markdown(markdown)
    if len(normalized) > _MAX_MARKDOWN_SIZE:
        raise ValueError(
            f"Markdown 内容超过大小限制（{_MAX_MARKDOWN_SIZE // 1024 // 1024}MB），"
            "请拆分后重试"
        )
    lines = normalized.split("\n")
    if len(lines) > _MAX_MARKDOWN_LINES:
        raise ValueError(
            f"Markdown 内容超过行数限制（{_MAX_MARKDOWN_LINES} 行），"
            "请拆分后重试"
        )
    content: list[dict[str, Any]] = []
    paragraph_buffer: list[str] = []
    paragraph_trailing_breaks: list[bool] = []
    index = 0

    def flush_paragraph() -> None:
        nonlocal paragraph_buffer, paragraph_trailing_breaks
        if not paragraph_buffer:
            paragraph_buffer = []
            paragraph_trailing_breaks = []
            return
        parts: list[str] = []
        for i, line_text in enumerate(paragraph_buffer):
            parts.append(line_text)
            if i < len(paragraph_buffer) - 1:
                if i < len(paragraph_trailing_breaks) and paragraph_trailing_breaks[i]:
                    parts.append("  \n")
                else:
                    parts.append(" ")
        text = "".join(parts).strip()
        paragraph_buffer = []
        paragraph_trailing_breaks = []
        if text:
            content.append(_build_paragraph_node(text))

    while index < len(lines):
        raw_line = lines[index]
        line = raw_line.rstrip()
        stripped = line.strip()

        if not stripped:
            flush_paragraph()
            index += 1
            continue

        # XP-10: Setext headings — === → H1, --- → H2 (must precede HR check)
        if paragraph_buffer and _SETEXT_H1_RE.match(stripped):
            heading_text = " ".join(paragraph_buffer).strip()
            paragraph_buffer = []
            paragraph_trailing_breaks = []
            if heading_text:
                content.append({
                    "type": "heading",
                    "attrs": {"level": 1},
                    "content": _parse_inline_text(heading_text) if heading_text else [],
                })
            index += 1
            continue

        if paragraph_buffer and _SETEXT_H2_RE.match(stripped):
            heading_text = " ".join(paragraph_buffer).strip()
            paragraph_buffer = []
            paragraph_trailing_breaks = []
            if heading_text:
                content.append({
                    "type": "heading",
                    "attrs": {"level": 2},
                    "content": _parse_inline_text(heading_text) if heading_text else [],
                })
            index += 1
            continue

        # PAR-017: horizontalRule 解析
        if _HR_RE.match(stripped):
            flush_paragraph()
            content.append({"type": "horizontalRule"})
            index += 1
            continue

        # PAR-050: 块级数学公式 $$...$$ 解析
        if _BLOCK_MATH_OPEN_RE.match(stripped):
            flush_paragraph()
            index += 1
            math_lines: list[str] = []
            while index < len(lines):
                math_line = lines[index].rstrip()
                if math_line.strip() == "$$":
                    break
                math_lines.append(math_line)
                index += 1
            latex = "\n".join(math_lines)
            content.append({
                "type": "mathematicsBlock",
                "attrs": {"latex": latex},
            })
            if index < len(lines):
                index += 1
            continue

        html_image_paragraph = _build_standalone_html_image_paragraph(stripped)
        if html_image_paragraph:
            flush_paragraph()
            content.append(html_image_paragraph)
            index += 1
            continue

        tabdata_match = _TABDATA_OPEN_RE.match(stripped)
        if stripped.startswith(":::tabdata{") and not tabdata_match:
            raise ValueError(
                ':::tabdata directive 格式非法；请使用 '
                ':::tabdata{tableId="tbl-xxx"} 并闭合属性花括号。'
            )
        if tabdata_match:
            flush_paragraph()
            attrs = _parse_tabdata_block_attrs(tabdata_match.group(1))
            index += 1
            close_lookahead = 0
            while close_lookahead < 50 and (index + close_lookahead) < len(lines):
                candidate = lines[index + close_lookahead].strip()
                if _APP_BLOCK_CLOSE_RE.match(candidate):
                    index += close_lookahead + 1
                    break
                if candidate:
                    break
                close_lookahead += 1
            content.append(
                {
                    "type": "tabdataBlock",
                    "attrs": attrs,
                }
            )
            continue

        tabwhiteboard_match = _TABWHITEBOARD_OPEN_RE.match(stripped)
        if tabwhiteboard_match:
            flush_paragraph()
            canvas_id = _parse_quoted_attr(tabwhiteboard_match.group(1), "canvasId") or ""
            index += 1
            close_lookahead = 0
            while close_lookahead < 50 and (index + close_lookahead) < len(lines):
                candidate = lines[index + close_lookahead].strip()
                if _APP_BLOCK_CLOSE_RE.match(candidate):
                    index += close_lookahead + 1
                    break
                if candidate:
                    break
                close_lookahead += 1
            content.append(
                {
                    "type": "tabwhiteboard",
                    "attrs": {"canvasId": canvas_id},
                }
            )
            continue

        htmlblock_match = _HTMLBLOCK_OPEN_RE.match(stripped)
        if htmlblock_match:
            flush_paragraph()
            attrs = _parse_htmlblock_attrs(htmlblock_match.group(1))
            index += 1
            close_lookahead = 0
            while close_lookahead < 50 and (index + close_lookahead) < len(lines):
                candidate = lines[index + close_lookahead].strip()
                if _APP_BLOCK_CLOSE_RE.match(candidate):
                    index += close_lookahead + 1
                    break
                if candidate:
                    break
                close_lookahead += 1
            content.append(
                {
                    "type": "htmlBlock",
                    "attrs": attrs,
                }
            )
            continue

        code_match = _CODE_FENCE_RE.match(stripped)
        if code_match:
            flush_paragraph()
            open_fence_len = len(code_match.group(1))
            language = (code_match.group(2) or "").strip()
            index += 1
            code_lines: list[str] = []
            _close_fence_re = re.compile(r"^(`{" + str(open_fence_len) + r",})\s*$")
            found_close = False
            while index < len(lines):
                candidate = lines[index]
                if _close_fence_re.match(candidate.strip()):
                    found_close = True
                    break
                code_lines.append(candidate)
                index += 1
            if not found_close:
                logger.warning(
                    "Unclosed code fence at line %d, treating remaining %d lines as code block content",
                    index - len(code_lines),
                    len(code_lines),
                )
            code_text = "\n".join(code_lines)
            content.append(
                {
                    "type": "codeBlock",
                    "attrs": {"language": language or None},
                    "content": [_build_text_node(code_text)] if code_text else [],
                }
            )
            if index < len(lines):
                index += 1
            continue

        heading_match = _HEADING_RE.match(stripped)
        if heading_match:
            flush_paragraph()
            level = len(heading_match.group(1))
            title = heading_match.group(2).strip()
            content.append(
                {
                    "type": "heading",
                    "attrs": {"level": level},
                    "content": _parse_inline_text(title) if title else [],
                }
            )
            index += 1
            continue

        if stripped.startswith(">"):
            flush_paragraph()
            quote_lines: list[str] = []
            while index < len(lines):
                maybe_quote = lines[index].strip()
                if not maybe_quote.startswith(">"):
                    break
                quote_lines.append(maybe_quote[1:].lstrip())
                index += 1
            inner_markdown = "\n".join(quote_lines)
            if _depth < _MAX_QUOTE_DEPTH:
                inner_doc = markdown_to_pm_json(inner_markdown, _depth=_depth + 1)
            else:
                inner_doc = {"content": [_build_paragraph_node(inner_markdown)]}
            inner_content = inner_doc.get("content", [])
            if not isinstance(inner_content, list) or not inner_content:
                inner_content = [_build_paragraph_node("")]
            content.append(
                {
                    "type": "blockquote",
                    "content": inner_content,
                }
            )
            continue

        # HTML <table>…</table>（飞书导出 / 合并单元格序列化）；须在管道表之前
        if _HTML_TABLE_OPEN_RE.match(stripped):
            flush_paragraph()
            table_lines: list[str] = []
            while index < len(lines):
                table_lines.append(lines[index])
                index += 1
                if _HTML_TABLE_CLOSE_RE.search(table_lines[-1]):
                    break
            content.append(_parse_html_table_block("\n".join(table_lines)))
            continue

        if "|" in stripped and index + 1 < len(lines) and _TABLE_DIVIDER_RE.match(lines[index + 1].strip()):
            flush_paragraph()
            table_rows: list[list[str]] = [_parse_table_row(lines[index])]
            index += 2
            while index < len(lines):
                table_line = lines[index].strip()
                if not table_line or "|" not in table_line:
                    break
                table_rows.append(_parse_table_row(lines[index]))
                index += 1
            if table_rows:
                content.append(_build_table_node(table_rows))
            continue

        if _TASK_RE.match(stripped) or _BULLET_RE.match(stripped) or _ORDERED_RE.match(stripped):
            flush_paragraph()
            list_node, index = _parse_list_block(lines, index)
            if list_node:
                content.append(list_node)
            continue

        trailing_space_count = len(raw_line) - len(raw_line.rstrip(' '))
        paragraph_buffer.append(stripped)
        paragraph_trailing_breaks.append(trailing_space_count >= 2)
        index += 1

    flush_paragraph()
    return {
        "type": "doc",
        "content": content,
    }


def _get_mark_map(node: dict[str, Any]) -> dict[str, dict[str, Any]]:
    marks = node.get("marks", []) if isinstance(node, dict) else []
    if not isinstance(marks, list):
        return {}
    result: dict[str, dict[str, Any]] = {}
    for item in marks:
        if isinstance(item, dict) and isinstance(item.get("type"), str):
            result[item["type"]] = item
    return result


_MAX_PM_PROJECTION_DEPTH = 100


def _safe_pm_attrs(node: dict[str, Any]) -> dict[str, Any]:
    attrs = node.get("attrs") if isinstance(node, dict) else None
    return attrs if isinstance(attrs, dict) else {}


def _safe_pm_string(value: Any) -> str:
    """只投影 PM 中明确的字符串，避免把结构化内部数据 stringify 到正文。"""
    return value if isinstance(value, str) else ""


def _safe_pm_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return None


_SAFE_HEX_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?(?:[0-9a-fA-F]{2})?$")
_SAFE_RGB_COLOR_RE = re.compile(
    r"^rgba?\(\s*\d{1,3}%?\s*,\s*\d{1,3}%?\s*,\s*\d{1,3}%?"
    r"(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$",
    re.IGNORECASE,
)
_SAFE_HSL_COLOR_RE = re.compile(
    r"^hsla?\(\s*\d{1,3}(?:deg)?\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%"
    r"(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$",
    re.IGNORECASE,
)
_SAFE_VAR_COLOR_RE = re.compile(
    r"^var\(--novel-[a-z0-9-]+,\s*(#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?|transparent)\)$",
    re.IGNORECASE,
)
_SAFE_NAMED_COLORS = frozenset(
    {
        "black", "silver", "gray", "white", "maroon", "red", "purple", "fuchsia",
        "green", "lime", "olive", "yellow", "navy", "blue", "teal", "aqua",
        "orange", "transparent", "currentcolor",
    }
)


def _safe_css_color(value: Any) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    if _SAFE_HEX_COLOR_RE.match(raw):
        return raw
    if _SAFE_RGB_COLOR_RE.match(raw) or _SAFE_HSL_COLOR_RE.match(raw):
        return raw
    var_match = _SAFE_VAR_COLOR_RE.match(raw)
    if var_match:
        return var_match.group(1)
    if raw.lower() in _SAFE_NAMED_COLORS:
        return raw
    return ""


def _style_attr_from_marks(marks: dict[str, dict[str, Any]]) -> str:
    styles: list[str] = []

    text_style = marks.get("textStyle")
    if text_style:
        attrs = text_style.get("attrs", {})
        color = _safe_css_color(attrs.get("color") if isinstance(attrs, dict) else "")
        if color:
            styles.append(f"color: {color}")

    highlight = marks.get("highlight")
    if highlight:
        attrs = highlight.get("attrs", {})
        color = _safe_css_color(attrs.get("color") if isinstance(attrs, dict) else "")
        if color and color != "transparent":
            styles.append(f"background-color: {color}")

    if "underline" in marks:
        styles.append("text-decoration: underline")

    return "; ".join(styles)


def _render_text_with_marks(node: dict[str, Any]) -> str:
    text = str(node.get("text") or "")
    marks = _get_mark_map(node)
    escaped = html.escape(text, quote=True)

    if "code" in marks:
        escaped = f"<code>{escaped}</code>"
    if "strong" in marks or "bold" in marks:
        escaped = f"<strong>{escaped}</strong>"
    if "em" in marks or "italic" in marks:
        escaped = f"<em>{escaped}</em>"
    if "strike" in marks:
        escaped = f"<del>{escaped}</del>"

    style_attr = _style_attr_from_marks(marks)
    if style_attr:
        escaped_style = html.escape(style_attr, quote=True)
        escaped = f'<span style="{escaped_style}">{escaped}</span>'

    link_mark = marks.get("link")
    href_value = ""
    if link_mark:
        attrs = link_mark.get("attrs", {})
        if isinstance(attrs, dict):
            href_value = str(attrs.get("href") or "")

    if href_value:
        if _is_safe_url(href_value):
            escaped_href = html.escape(href_value, quote=True)
            escaped = f'<a href="{escaped_href}">{escaped}</a>'
        else:
            escaped = f'<a href="#">{escaped}</a>'

    return escaped


def _render_inline_nodes(nodes: list[dict[str, Any]]) -> str:
    chunks: list[str] = []
    for node in nodes:
        node_type = node.get("type")
        if node_type == "text":
            chunks.append(_render_text_with_marks(node))
        elif node_type == "hardBreak":
            chunks.append("<br />")
        elif node_type == "image":
            attrs = node.get("attrs") or {}
            raw_src = str(attrs.get("src") or "")
            alt_text = html.escape(str(attrs.get("alt") or ""), quote=True)
            if raw_src and _is_safe_url(raw_src):
                src = html.escape(raw_src, quote=True)
                dimension_attrs = _render_image_dimension_attrs(attrs, include_style=True)
                img_html = f'<img src="{src}" alt="{alt_text}"{dimension_attrs} />'
                marks = _get_mark_map(node)
                link_mark = marks.get("link")
                if link_mark:
                    link_attrs = link_mark.get("attrs", {})
                    href_value = str(link_attrs.get("href") or "") if isinstance(link_attrs, dict) else ""
                    if href_value and _is_safe_url(href_value):
                        escaped_href = html.escape(href_value, quote=True)
                        img_html = f'<a href="{escaped_href}">{img_html}</a>'
                chunks.append(img_html)
        elif node_type in ("mathematics", "math"):
            attrs = node.get("attrs") or {}
            latex = html.escape(str(attrs.get("latex") or attrs.get("value") or ""), quote=True)
            if latex:
                chunks.append(f'<span class="math">${latex}$</span>')
        else:
            child_nodes = node.get("content", [])
            if isinstance(child_nodes, list):
                chunks.append(_render_inline_nodes([item for item in child_nodes if isinstance(item, dict)]))
    return "".join(chunks)


def _extract_plain_text(node: dict[str, Any], depth: int = 0) -> str:
    if depth >= _MAX_PM_PROJECTION_DEPTH:
        return ""
    if node.get("type") == "text":
        return _safe_pm_string(node.get("text"))
    child_nodes = node.get("content", [])
    if not isinstance(child_nodes, list):
        return ""
    return "".join(
        _extract_plain_text(item, depth + 1)
        for item in child_nodes
        if isinstance(item, dict)
    )


_MD_ESCAPE_RE = re.compile(r"([*_~`\[\]\\<>])")
_MD_URL_SCHEME_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*:")
_MD_UNSAFE_IMAGE_SCHEMES = ("javascript:", "vbscript:", "file:", "blob:")
_MD_CONTROL_CHAR_RE = re.compile(r"[\x00-\x1f\x7f]")


def _escape_md_chars(text: str) -> str:
    """转义 Markdown 元字符，防止文本内容被误解析"""
    return _MD_ESCAPE_RE.sub(r"\\\1", text)


def _is_safe_markdown_image_src(src: str) -> bool:
    """Markdown image destinations allow platform object keys as relative refs."""
    normalized = (src or "").strip()
    if not normalized:
        return False
    if re.fullmatch(r"tabtin-file://asset/[0-9a-fA-F-]{36}", normalized):
        return True
    if _MD_CONTROL_CHAR_RE.search(normalized) or normalized.startswith("//"):
        return False
    if _is_safe_url(normalized):
        return True

    lower = normalized.lower()
    if lower.startswith(_MD_UNSAFE_IMAGE_SCHEMES):
        return False
    if _MD_URL_SCHEME_RE.match(normalized):
        return False
    if any(ch in normalized for ch in "<>"):
        return False
    return True


def _render_text_with_md_marks(node: dict[str, Any]) -> str:
    """将带 marks 的 text 节点渲染为 Markdown 内联格式"""
    text = _safe_pm_string(node.get("text"))
    if not text:
        return ""
    marks = _get_mark_map(node)

    if not marks:
        return _escape_md_chars(text)

    if "code" in marks:
        return f"`{text}`"

    result = _escape_md_chars(text)

    if "strong" in marks or "bold" in marks:
        result = f"**{result}**"
    if "em" in marks or "italic" in marks:
        result = f"*{result}*"
    if "strike" in marks:
        result = f"~~{result}~~"

    link_mark = marks.get("link")
    if link_mark:
        attrs = link_mark.get("attrs", {})
        href = str(attrs.get("href") or "") if isinstance(attrs, dict) else ""
        if href and _is_safe_url(href):
            result = f"[{result}]({href})"

    return result


def _mark_attrs(mark: dict[str, Any] | None) -> dict[str, Any]:
    attrs = mark.get("attrs", {}) if isinstance(mark, dict) else {}
    return attrs if isinstance(attrs, dict) else {}


def _render_image_markdown(attrs: dict[str, Any], marks: dict[str, dict[str, Any]] | None = None) -> str:
    src = _safe_pm_string(attrs.get("src")).strip()
    file_id = _safe_pm_string(attrs.get("fileId")).strip()
    if not src and file_id:
        try:
            src = f"tabtin-file://asset/{UUID(file_id)}"
        except ValueError:
            src = ""
    if not src or not _is_safe_markdown_image_src(src):
        return ""

    alt = _safe_pm_string(attrs.get("alt"))
    title = _safe_pm_string(attrs.get("title"))
    escaped_title = title.replace('"', '\\"')
    title_part = f' "{escaped_title}"' if title else ""
    output = f"![{_escape_md_chars(alt)}]({src}{title_part})"

    link = (marks or {}).get("link")
    href = str(_mark_attrs(link).get("href") or "") if link else ""
    if href and _is_safe_url(href):
        return f"[{output}]({href})"
    return output


def _render_inline_markdown(nodes: list[dict[str, Any]], depth: int = 0) -> str:
    """将 inline 节点列表渲染为 Markdown 文本（保留 bold/italic/link/code 等）"""
    if depth >= _MAX_PM_PROJECTION_DEPTH:
        return ""
    chunks: list[str] = []
    for node in nodes:
        node_type = node.get("type")
        if node_type == "text":
            chunks.append(_render_text_with_md_marks(node))
        elif node_type == "hardBreak":
            chunks.append("  \n")
        elif node_type == "image":
            img_md = _render_image_markdown(_safe_pm_attrs(node), _get_mark_map(node))
            if img_md:
                chunks.append(img_md)
        elif node_type in ("mathematics", "math"):
            attrs = _safe_pm_attrs(node)
            latex = _safe_pm_string(attrs.get("latex") or attrs.get("value"))
            if latex:
                escaped_latex = latex.replace("$", "\\$")
                chunks.append(f"${escaped_latex}$")
        else:
            child_nodes = node.get("content", [])
            if isinstance(child_nodes, list):
                chunks.append(_render_inline_markdown(
                    [item for item in child_nodes if isinstance(item, dict)],
                    depth + 1,
                ))
    return "".join(chunks)


def _get_inline_text(node: dict[str, Any]) -> str:
    """从 block 节点提取 inline Markdown 文本"""
    children = node.get("content", [])
    if not isinstance(children, list):
        return ""
    return _render_inline_markdown(
        [item for item in children if isinstance(item, dict)]
    )


def _render_list_item(
    item: dict[str, Any],
    list_depth: int,
    recursion_depth: int,
) -> list[str]:
    """渲染 listItem/taskItem 的 content，区分首个 paragraph（取 inline text）和嵌套子列表（递归）。"""
    if recursion_depth >= _MAX_PM_PROJECTION_DEPTH:
        return []
    item_content = item.get("content", [])
    if not isinstance(item_content, list):
        return []
    result: list[str] = []
    for child in item_content:
        if not isinstance(child, dict):
            continue
        child_type = child.get("type", "")
        if child_type == "paragraph":
            result.append(_get_inline_text(child).strip())
        elif child_type in ("bulletList", "orderedList", "taskList"):
            nested = _pm_nodes_to_markdown(
                [child],
                list_depth=list_depth + 1,
                recursion_depth=recursion_depth + 1,
            )
            result.extend(nested)
        else:
            nested = _pm_nodes_to_markdown(
                [child],
                list_depth=list_depth,
                recursion_depth=recursion_depth + 1,
            )
            result.extend(nested)
    return result


def _pm_nodes_to_markdown(
    nodes: list[dict[str, Any]],
    list_depth: int = 0,
    recursion_depth: int = 0,
) -> list[str]:
    if recursion_depth >= _MAX_PM_PROJECTION_DEPTH:
        return []
    blocks: list[str] = []
    for node in nodes:
        node_type = node.get("type")
        children = node.get("content", [])
        child_nodes = [item for item in children if isinstance(item, dict)] if isinstance(children, list) else []

        if node_type == "paragraph":
            blocks.append(_get_inline_text(node).strip())
        elif node_type == "heading":
            attrs = _safe_pm_attrs(node)
            level = _safe_pm_int(attrs.get("level"))
            inline_text = _get_inline_text(node).strip()
            if level is None or not 1 <= level <= 6:
                blocks.append(inline_text)
            else:
                blocks.append(f"{'#' * level} {inline_text}".strip())
        elif node_type == "blockquote":
            quote_lines = "\n\n".join(_pm_nodes_to_markdown(
                child_nodes,
                list_depth=list_depth,
                recursion_depth=recursion_depth + 1,
            ))
            blocks.append("\n".join(f"> {line}" if line else ">" for line in quote_lines.split("\n")))
        elif node_type == "codeBlock":
            attrs = _safe_pm_attrs(node)
            language = _safe_pm_string(attrs.get("language"))
            code_text = _extract_plain_text(node)
            fence_len = 3
            for run in re.findall(r"`{3,}", code_text):
                fence_len = max(fence_len, len(run) + 1)
            fence = "`" * fence_len
            blocks.append(f"{fence}{language}\n{code_text}\n{fence}")
        elif node_type == "bulletList":
            list_lines: list[str] = []
            for item in child_nodes:
                item_blocks = _render_list_item(item, list_depth, recursion_depth + 1)
                if item_blocks:
                    first_line = item_blocks[0]
                    list_lines.append(f"{'  ' * list_depth}- {first_line}".rstrip())
                    list_lines.extend(item_blocks[1:])
                else:
                    list_lines.append(f"{'  ' * list_depth}-")
            if list_lines:
                blocks.append("\n".join(list_lines))
        elif node_type == "orderedList":
            attrs = _safe_pm_attrs(node)
            start = _safe_pm_int(attrs.get("start", 1))
            if not isinstance(node.get("attrs"), (dict, type(None))) or start is None:
                blocks.extend(_pm_nodes_to_markdown(
                    child_nodes,
                    list_depth=list_depth,
                    recursion_depth=recursion_depth + 1,
                ))
                continue
            list_lines: list[str] = []
            for idx, item in enumerate(child_nodes, start=start):
                item_blocks = _render_list_item(item, list_depth, recursion_depth + 1)
                if item_blocks:
                    first_line = item_blocks[0]
                    list_lines.append(f"{'  ' * list_depth}{idx}. {first_line}".rstrip())
                    list_lines.extend(item_blocks[1:])
                else:
                    list_lines.append(f"{'  ' * list_depth}{idx}.")
            if list_lines:
                blocks.append("\n".join(list_lines))
        elif node_type == "taskList":
            list_lines: list[str] = []
            for item in child_nodes:
                checked = bool(_safe_pm_attrs(item).get("checked"))
                mark = "x" if checked else " "
                item_blocks = _render_list_item(item, list_depth, recursion_depth + 1)
                if item_blocks:
                    first_line = item_blocks[0]
                    list_lines.append(f"{'  ' * list_depth}- [{mark}] {first_line}".rstrip())
                    list_lines.extend(item_blocks[1:])
                else:
                    list_lines.append(f"{'  ' * list_depth}- [{mark}]")
            if list_lines:
                blocks.append("\n".join(list_lines))
        elif node_type == "table":
            rows: list[list[str]] = []
            for row_node in child_nodes:
                row_cells: list[str] = []
                row_children = row_node.get("content", [])
                if not isinstance(row_children, list):
                    continue
                for cell_node in row_children:
                    if not isinstance(cell_node, dict):
                        continue
                    row_cells.append(_get_inline_text(cell_node).replace("|", "\\|").strip())
                rows.append(row_cells)

            if rows:
                header = rows[0]
                divider = ["---"] * len(header)
                table_lines: list[str] = [
                    f"| {' | '.join(header)} |",
                    f"| {' | '.join(divider)} |",
                ]
                for row in rows[1:]:
                    normalized = row + [""] * (len(header) - len(row))
                    table_lines.append(f"| {' | '.join(normalized[:len(header)])} |")
                blocks.append("\n".join(table_lines))
        elif node_type == "horizontalRule":
            blocks.append("---")
        elif node_type == "image":
            image_md = _render_image_markdown(_safe_pm_attrs(node), _get_mark_map(node))
            if image_md:
                blocks.append(image_md)
        elif node_type in ("mathematics", "math"):
            attrs = _safe_pm_attrs(node)
            latex = _safe_pm_string(attrs.get("latex") or attrs.get("value"))
            is_display = attrs.get("display", False)
            if latex:
                if is_display:
                    blocks.append(f"$$\n{latex}\n$$")
                else:
                    escaped_latex = latex.replace("$", "\\$")
                    blocks.append(f"${escaped_latex}$")
        elif node_type == "mathematicsBlock":
            attrs = _safe_pm_attrs(node)
            latex = _safe_pm_string(attrs.get("latex") or attrs.get("value"))
            if latex:
                blocks.append(f"$$\n{latex}\n$$")
        elif node_type == "youtube":
            attrs = _safe_pm_attrs(node)
            src = _safe_pm_string(attrs.get("src"))
            if src and _is_safe_url(src):
                blocks.append(f"[YouTube]({src})")
        elif node_type == "tabdataBlock":
            attrs = _safe_pm_attrs(node)
            table_id = _safe_pm_string(attrs.get("tableId"))
            if table_id:
                def _esc_attr(v: str) -> str:
                    return v.replace("\\", "\\\\").replace('"', '\\"')
                view_id = _safe_pm_string(attrs.get("viewId"))
                max_height = _coerce_max_height(attrs)
                title = _esc_attr(_safe_pm_string(attrs.get("title")) or "未命名表格")
                view_part = f' viewId="{_esc_attr(view_id)}"' if view_id else ""
                height_part = f' maxHeight="{max_height}"' if max_height and max_height != 400 else ""
                blocks.append(f':::tabdata{{tableId="{_esc_attr(table_id)}"{view_part}{height_part} title="{title}"}}\n:::')
            else:
                title = _safe_pm_string(attrs.get("title")) or "未命名表格"
                blocks.append(f"[表格: {title}]")
        elif node_type == "tabwhiteboard":
            attrs = _safe_pm_attrs(node)
            canvas_id = _safe_pm_string(attrs.get("canvasId"))
            if canvas_id:
                escaped_id = canvas_id.replace("\\", "\\\\").replace('"', '\\"')
                blocks.append(f':::tabwhiteboard{{canvasId="{escaped_id}"}}\n:::')
        elif node_type == "htmlBlock":
            attrs = _safe_pm_attrs(node)
            def _esc_attr(v: str) -> str:
                return v.replace("\\", "\\\\").replace('"', '\\"')
            file_id = _safe_pm_string(attrs.get("fileId"))
            src = _safe_pm_string(attrs.get("src"))
            # 与 TS 版往返一致：fileId/src/title/height 四个属性始终全量输出（顺序固定）。
            if file_id or src:
                title = _esc_attr(_safe_pm_string(attrs.get("title")) or "未命名 HTML")
                height = _coerce_html_height(attrs)
                blocks.append(
                    f':::htmlblock{{fileId="{_esc_attr(file_id)}" src="{_esc_attr(src)}"'
                    f' title="{title}" height="{height}"}}\n:::'
                )
            else:
                title = _safe_pm_string(attrs.get("title")) or "未命名 HTML"
                blocks.append(f"[HTML: {title}]")
        else:
            nested = _pm_nodes_to_markdown(
                child_nodes,
                list_depth=list_depth,
                recursion_depth=recursion_depth + 1,
            )
            blocks.extend(nested)

    return [item for item in blocks if item is not None and item != ""]


def pm_json_to_markdown(pm_json: dict[str, Any] | None) -> str:
    if not isinstance(pm_json, dict):
        return ""
    content = pm_json.get("content", [])
    if not isinstance(content, list):
        return ""
    lines = _pm_nodes_to_markdown([item for item in content if isinstance(item, dict)], 0)
    return "\n\n".join(lines).strip()


def pm_json_to_plaintext(pm_json: dict[str, Any] | None) -> str:
    """从完整 ProseMirror 真源提取可搜索的可见语义。

    纯文本投影不得依赖客户端各自的渲染模型，也不得泄露 ``tableId``、
    ``fileId`` 或未知节点 type。嵌入块只投影用户可见标题；未知容器递归保留
    其可见子文本。
    """
    if not isinstance(pm_json, dict):
        return ""
    content = pm_json.get("content", [])
    if not isinstance(content, list):
        return ""
    return _join_plaintext_parts(
        [_pm_node_to_plaintext(item) for item in content if isinstance(item, dict)],
        separator="\n",
    )


def _pm_node_to_plaintext(node: dict[str, Any], depth: int = 0) -> str:
    if depth >= _MAX_PM_PROJECTION_DEPTH:
        return ""
    node_type = _safe_pm_string(node.get("type"))
    attrs = _safe_pm_attrs(node)
    children = node.get("content", [])
    child_nodes = (
        [item for item in children if isinstance(item, dict)]
        if isinstance(children, list)
        else []
    )

    if node_type == "text":
        return _safe_pm_string(node.get("text"))
    if node_type == "hardBreak":
        return "\n"
    if node_type in ("mathematics", "math", "mathematicsBlock"):
        return _safe_pm_string(attrs.get("latex") or attrs.get("value") or attrs.get("text"))
    if node_type == "image":
        return _safe_pm_string(attrs.get("alt") or attrs.get("title"))
    if node_type in ("tabdataBlock", "tabwhiteboard", "htmlBlock", "youtube"):
        return _safe_pm_string(attrs.get("title"))

    child_text = [_pm_node_to_plaintext(child, depth + 1) for child in child_nodes]
    if node_type in ("paragraph", "heading", "codeBlock", "tableCell", "tableHeader"):
        return "".join(child_text).strip()
    if node_type == "tableRow":
        return _join_plaintext_parts(child_text, separator="\t")
    if node_type in (
        "doc",
        "blockquote",
        "bulletList",
        "orderedList",
        "taskList",
        "listItem",
        "taskItem",
        "table",
    ):
        return _join_plaintext_parts(child_text, separator="\n")

    # 未知 wrapper 只递归其可见子内容，绝不投影实现 type 或 attrs。
    return _join_plaintext_parts(child_text, separator="\n")


def _join_plaintext_parts(parts: list[str], *, separator: str) -> str:
    normalized = [part.strip() for part in parts if part and part.strip()]
    return separator.join(normalized)


def _pm_nodes_to_html(nodes: list[dict[str, Any]]) -> str:
    chunks: list[str] = []
    for node in nodes:
        node_type = node.get("type")
        children = node.get("content", [])
        child_nodes = [item for item in children if isinstance(item, dict)] if isinstance(children, list) else []

        if node_type == "paragraph":
            chunks.append(f"<p>{_render_inline_nodes(child_nodes)}</p>")
        elif node_type == "heading":
            level = int((node.get("attrs") or {}).get("level", 1))
            level = max(1, min(6, level))
            chunks.append(f"<h{level}>{_render_inline_nodes(child_nodes)}</h{level}>")
        elif node_type == "blockquote":
            chunks.append(f"<blockquote>{_pm_nodes_to_html(child_nodes)}</blockquote>")
        elif node_type == "codeBlock":
            attrs = node.get("attrs") or {}
            language = str(attrs.get("language") or "").strip()
            class_attr = f' class="language-{html.escape(language, quote=True)}"' if language else ""
            code_text = html.escape(_extract_plain_text(node), quote=False)
            chunks.append(f"<pre><code{class_attr}>{code_text}</code></pre>")
        elif node_type == "bulletList":
            items = []
            for item in child_nodes:
                item_children = item.get("content", [])
                item_nodes = [c for c in item_children if isinstance(c, dict)] if isinstance(item_children, list) else []
                items.append(f"<li>{_pm_nodes_to_html(item_nodes)}</li>")
            chunks.append(f"<ul>{''.join(items)}</ul>")
        elif node_type == "orderedList":
            start = int((node.get("attrs") or {}).get("start", 1))
            start_attr = f' start="{start}"' if start > 1 else ""
            items = []
            for item in child_nodes:
                item_children = item.get("content", [])
                item_nodes = [c for c in item_children if isinstance(c, dict)] if isinstance(item_children, list) else []
                items.append(f"<li>{_pm_nodes_to_html(item_nodes)}</li>")
            chunks.append(f"<ol{start_attr}>{''.join(items)}</ol>")
        elif node_type == "taskList":
            items = []
            for item in child_nodes:
                checked = bool((item.get("attrs") or {}).get("checked"))
                item_children = item.get("content", [])
                item_nodes = [c for c in item_children if isinstance(c, dict)] if isinstance(item_children, list) else []
                checkbox = '<input type="checkbox" checked disabled />' if checked else '<input type="checkbox" disabled />'
                items.append(f"<li>{checkbox}{_pm_nodes_to_html(item_nodes)}</li>")
            chunks.append(f'<ul class="task-list">{ "".join(items) }</ul>')
        elif node_type == "table":
            rows: list[str] = []
            for row in child_nodes:
                row_children = row.get("content", [])
                if not isinstance(row_children, list):
                    continue
                cells: list[str] = []
                for cell in row_children:
                    if not isinstance(cell, dict):
                        continue
                    tag = "th" if cell.get("type") == "tableHeader" else "td"
                    cell_children = cell.get("content", [])
                    cell_nodes = [c for c in cell_children if isinstance(c, dict)] if isinstance(cell_children, list) else []
                    cells.append(f"<{tag}>{_pm_nodes_to_html(cell_nodes)}</{tag}>")
                rows.append(f"<tr>{''.join(cells)}</tr>")
            chunks.append(f"<table><tbody>{''.join(rows)}</tbody></table>")
        elif node_type == "horizontalRule":
            chunks.append("<hr />")
        elif node_type == "image":
            attrs = node.get("attrs") or {}
            raw_src = str(attrs.get("src") or "")
            alt_text = html.escape(str(attrs.get("alt") or ""), quote=True)
            title_text = html.escape(str(attrs.get("title") or ""), quote=True)
            title_attr = f' title="{title_text}"' if title_text else ""
            if raw_src and _is_safe_url(raw_src):
                src = html.escape(raw_src, quote=True)
                dimension_attrs = _render_image_dimension_attrs(attrs, include_style=True)
                chunks.append(f'<img src="{src}" alt="{alt_text}"{title_attr}{dimension_attrs} />')
        elif node_type in ("mathematics", "math"):
            attrs = node.get("attrs") or {}
            latex = html.escape(str(attrs.get("latex") or attrs.get("value") or ""), quote=True)
            is_display = attrs.get("display", False)
            if latex:
                tag = "div" if is_display else "span"
                delimiter = "$$" if is_display else "$"
                chunks.append(f'<{tag} class="math">{delimiter}{latex}{delimiter}</{tag}>')
        elif node_type == "mathematicsBlock":
            attrs = node.get("attrs") or {}
            latex = html.escape(str(attrs.get("latex") or attrs.get("value") or ""), quote=True)
            if latex:
                chunks.append(f'<div class="math">$${latex}$$</div>')
        elif node_type == "youtube":
            attrs = node.get("attrs") or {}
            raw_src = str(attrs.get("src") or "")
            if raw_src and _is_safe_url(raw_src):
                src = html.escape(raw_src, quote=True)
                chunks.append(
                    f'<a href="{src}" target="_blank" rel="noopener">'
                    f'[YouTube: {src}]</a>'
                )
        elif node_type == "tabdataBlock":
            attrs = node.get("attrs") or {}
            table_id = str(attrs.get("tableId") or "")
            title = html.escape(str(attrs.get("title") or "未命名表格"), quote=True)
            if table_id:
                escaped_id = html.escape(table_id, quote=True)
                view_id = attrs.get("viewId")
                view_attr = f' data-view-id="{html.escape(str(view_id), quote=True)}"' if view_id else ""
                max_height = _coerce_max_height(attrs)
                height_attr = f' data-max-height="{max_height}"' if max_height else ""
                chunks.append(
                    f'<div data-type="tabdata-block" data-table-id="{escaped_id}"'
                    f' data-table-title="{title}"{view_attr}{height_attr}'
                    f' class="tabdata-block"><p>{title}</p></div>'
                )
            else:
                chunks.append(f'<p><em>[表格: {title}]</em></p>')
        elif node_type == "tabwhiteboard":
            attrs = node.get("attrs") or {}
            canvas_id = str(attrs.get("canvasId") or "")
            if canvas_id:
                escaped_id = html.escape(canvas_id, quote=True)
                chunks.append(
                    f'<div data-type="tabwhiteboard-block" data-canvas-id="{escaped_id}"'
                    f' class="tabwhiteboard-block"><p>[Canvas: {escaped_id}]</p></div>'
                )
        elif node_type == "htmlBlock":
            attrs = node.get("attrs") or {}
            file_id = html.escape(str(attrs.get("fileId") or ""), quote=True)
            raw_src = str(attrs.get("src") or "")
            title = html.escape(str(attrs.get("title") or "未命名 HTML"), quote=True)
            height = _coerce_html_height(attrs)
            escaped_src = html.escape(raw_src, quote=True)
            div_open = (
                f'<div data-type="html-block" data-file-id="{file_id}"'
                f' data-src="{escaped_src}" data-title="{title}"'
                f' data-height="{height}" class="html-block">'
            )
            # 安全红线：sandbox 绝不含 allow-same-origin；仅绝对 http/https 才输出活跃
            # iframe src；不安全时只留占位 div（data-src 仍为转义后的静态文本，不可执行）。
            if _is_safe_htmlblock_iframe_src(raw_src):
                chunks.append(
                    f'{div_open}<iframe src="{escaped_src}"'
                    f' sandbox="allow-scripts allow-popups" loading="lazy"></iframe></div>'
                )
            else:
                chunks.append(f'{div_open}</div>')
        else:
            chunks.append(_pm_nodes_to_html(child_nodes))

    return "".join(chunks)


def pm_json_to_html(pm_json: dict[str, Any] | None) -> str:
    if not isinstance(pm_json, dict):
        return ""
    content = pm_json.get("content", [])
    if not isinstance(content, list):
        return ""
    nodes = [item for item in content if isinstance(item, dict)]
    return _pm_nodes_to_html(nodes)


_BLEACH_ALLOWED_TAGS = [
    "p", "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li", "blockquote", "pre", "code",
    "strong", "em", "del", "a",
    "table", "tbody", "thead", "tr", "th", "td",
    "hr", "br", "input", "img",
    "div", "span", "iframe",
]

_BLEACH_ALLOWED_ATTRS = {
    "a": ["href", "title", "target", "rel"],
    "img": ["src", "alt", "width", "height"],
    "input": ["type", "checked", "disabled"],
    "code": ["class"],
    "pre": ["class"],
    "ol": ["start"],
    "td": ["colspan", "rowspan"],
    "th": ["colspan", "rowspan"],
    "div": ["class", "data-type", "data-table-id", "data-table-title", "data-view-id", "data-max-height", "data-canvas-id", "data-file-id", "data-src", "data-title", "data-height"],
    "span": ["class"],
    "ul": ["class"],
    # htmlBlock 沙箱 iframe：src 受全局 url_schemes(http/https) 限制；sandbox/loading
    # 只由 pm_json_to_html 生产（sandbox 恒不含 allow-same-origin）。tabdoc 的 sanitize
    # 只处理 pm_json_to_html 的输出，markdown_to_pm_json 不解析裸 HTML，用户无法注入 iframe。
    "iframe": ["src", "sandbox", "loading"],
}


def sanitize_html(html_text: str) -> str:
    """HTML 消毒：优先使用 nh3（Rust 实现，高性能），回退到 bleach（<7.0）。"""
    raw = html_text or ""
    try:
        import nh3
        nh3_attrs = {}
        for k, v in _BLEACH_ALLOWED_ATTRS.items():
            filtered = [attr for attr in v if attr != "rel"]
            if filtered:
                nh3_attrs[k] = set(filtered)
        return nh3.clean(
            raw,
            tags=set(_BLEACH_ALLOWED_TAGS),
            attributes=nh3_attrs,
            url_schemes={"http", "https", "mailto", "tel"},
            link_rel="noopener noreferrer",
            strip_comments=True,
        )
    except ImportError:
        pass
    try:
        import bleach  # type: ignore[import-untyped]
        return bleach.clean(
            raw,
            tags=_BLEACH_ALLOWED_TAGS,
            attributes=_BLEACH_ALLOWED_ATTRS,
            strip=True,
        )
    except (ImportError, AttributeError) as exc:
        logger.error("Neither nh3 nor bleach available for HTML sanitization: %s", exc)
        raise ImportError(
            "HTML sanitization requires either 'nh3' (recommended) or 'bleach<7.0'. "
            "Install one of them: pip install nh3"
        ) from exc


def markdown_to_html(markdown: str) -> str:
    pm_json = markdown_to_pm_json(markdown)
    return pm_json_to_html(pm_json)


def render_markdown_html(markdown: str) -> str:
    return sanitize_html(markdown_to_html(markdown))
