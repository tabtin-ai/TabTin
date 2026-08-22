"""TabDoc Block 级编辑服务层（TD-3）。

唯一来源：Agent / CLI / REST 对单个顶层 block 的读 / 改 / 插 / 删都收敛到这里。
算法迁移自已废弃的 FC 工具（`apps/services/tools/domains/tabdoc/document_tools.py`），
但本服务**只 import 调用 `DocumentService`**，写操作末尾统一走
`DocumentService.save_content(...)`（带 base_version CAS）——从而自动继承
TD-1 的同步 VH + agent 归因、TD-2 的 replace 语义，不重复造写入旁路。

粒度：只支持 PM JSON 顶层 `content` 数组里的 block（`attrs.blockId` 定位，缺失时
回退 `auto_{index}`，与 `DocumentService.list_outline_blocks` 的口径一致）。嵌套 /
子块不在范围内。
"""
from __future__ import annotations

import copy
import logging
from typing import Any, Optional

from apps.tabdoc.services.document_service import DocumentService
from apps.tabdoc.services.markdown_exchange import (
    ensure_top_level_block_ids as _ensure_top_level_block_ids,
    markdown_to_pm_json,
    pm_json_to_markdown,
)

logger = logging.getLogger(__name__)

BLOCK_SEARCH_DEFAULT_LIMIT = 20
BLOCK_SEARCH_MAX_LIMIT = 50
BLOCK_SEARCH_SNIPPET_BEFORE = 32
BLOCK_SEARCH_SNIPPET_AFTER = 96
BLOCK_SEARCH_PREVIEW_LENGTH = 80

SECTION_FORMAT_MARKDOWN = "markdown"
SECTION_FORMAT_OUTLINE = "outline"
SECTION_FORMATS = (SECTION_FORMAT_MARKDOWN, SECTION_FORMAT_OUTLINE)
HEADING_NODE_TYPE = "heading"
# heading 缺失 level 时的兜底层级（markdown_to_pm_json 总会写 level，仅作防御）。
DEFAULT_HEADING_LEVEL = 1

# 与 TabDoc 编辑器 ColorSelector 的调色板一致。CLI/Agent 使用语义色名，不能把
# 任意 CSS/HTML 注入 Markdown 写入链路；实际写入始终是 ProseMirror 原生 marks。
TEXT_COLORS = {
    "purple": "#9333EA",
    "red": "#E00000",
    "yellow": "#EAB308",
    "blue": "#2563EB",
    "green": "#008A00",
    "orange": "#FFA500",
    "pink": "#BA4081",
    "gray": "#A8A29E",
}
BACKGROUND_COLORS = {
    "yellow": "#fef9c3",
    "purple": "#f3e8ff",
    "red": "#fee2e2",
    "blue": "#dbeafe",
    "green": "#dcfce7",
    "orange": "#ffedd5",
    "pink": "#fce7f3",
    "gray": "#f3f4f6",
}
# 兼容首个上线的 highlight endpoint；新代码应使用 BACKGROUND_COLORS / format_text。
HIGHLIGHT_COLORS = BACKGROUND_COLORS

_INLINE_MARK_TYPES = {
    "bold": ("bold", "strong"),
    "italic": ("italic", "em"),
    "underline": ("underline",),
    "strike": ("strike",),
    "code": ("code",),
}


class BlockNotFoundError(Exception):
    """目标 block 不存在 —— REST 层映射为 404。"""

    def __init__(self, block_id: str):
        self.block_id = block_id
        super().__init__(f"未找到 blockId={block_id} 的顶层 block")


class SectionAnchorNotHeadingError(Exception):
    """read-section 的锚点 block 不是 heading —— REST 层映射为 400。

    章节按「标题 + 其后正文，直到下一个同级/更高级标题」界定，锚点必须是 heading；
    非 heading 锚点明确报错，不静默退化成 read-block。
    """

    def __init__(self, block_id: str, block_type: str):
        self.block_id = block_id
        self.block_type = block_type
        super().__init__(
            f"blockId={block_id} 的 block 类型为 {block_type}，不是 heading，"
            f"无法作为章节锚点（read-section 仅接受 heading 锚点）"
        )


# ── 内部辅助（迁移自 FC document_tools.py，仅本模块使用）──


def _normalize_text(value: Optional[str]) -> str:
    return (value or "").replace("\r\n", "\n").replace("\r", "\n")


def _document_base_updated_at(document) -> Optional[str]:
    updated_at = getattr(document, "updated_at", None)
    return updated_at.isoformat() if updated_at else None


def _resolved_block_id(node: dict[str, Any], index: int) -> str:
    """顶层 block 的稳定标识：优先 attrs.blockId，缺失回退 auto_{index}。

    与 `DocumentService.list_outline_blocks` 完全同口径，保证 list-blocks 返回的 id
    可以被 read/update/delete 精准定位。
    """
    attrs = node.get("attrs") if isinstance(node, dict) else None
    attrs = attrs if isinstance(attrs, dict) else {}
    return attrs.get("blockId") or f"auto_{index}"


def _extract_node_text(node: dict) -> str:
    parts: list[str] = []
    if "text" in node:
        parts.append(node["text"])
    for child in node.get("content", []):
        parts.append(_extract_node_text(child))
    return " ".join(parts).strip()


def _extract_doc_plaintext(pm_json: dict) -> str:
    parts: list[str] = []
    for node in pm_json.get("content", []):
        text = _extract_node_text(node)
        if text:
            parts.append(text)
    return "\n".join(parts)


def _normalize_search_keyword(value: str) -> str:
    keyword = (value or "").strip()
    if not keyword:
        raise ValueError("q 不能为空")
    return keyword


def _inline_text_scopes(node: dict[str, Any]) -> list[list[dict[str, Any]]]:
    """Return independent inline runs so a match never crosses block boundaries."""
    scopes: list[list[dict[str, Any]]] = []
    children = node.get("content")
    if not isinstance(children, list):
        return scopes
    text_nodes = [child for child in children if isinstance(child, dict) and child.get("type") == "text"]
    if text_nodes:
        scopes.append(children)
        return scopes
    for child in children:
        if isinstance(child, dict):
            scopes.extend(_inline_text_scopes(child))
    return scopes


def _scope_text(scope: list[dict[str, Any]]) -> str:
    return "".join(
        str(node.get("text", ""))
        for node in scope
        if isinstance(node, dict) and node.get("type") == "text"
    )


def _replace_mark(
    node: dict[str, Any],
    mark_types: tuple[str, ...],
    replacement: Optional[dict[str, Any]],
) -> None:
    marks = node.get("marks") if isinstance(node.get("marks"), list) else []
    node["marks"] = [
        mark for mark in marks
        if not (isinstance(mark, dict) and mark.get("type") in mark_types)
    ]
    if replacement is not None:
        node["marks"].append(replacement)


def _apply_inline_format(
    node: dict[str, Any],
    *,
    bold: Optional[bool] = None,
    italic: Optional[bool] = None,
    underline: Optional[bool] = None,
    strike: Optional[bool] = None,
    code: Optional[bool] = None,
    text_color: Optional[str] = None,
    clear_text_color: bool = False,
    background_color: Optional[str] = None,
    clear_background_color: bool = False,
    link_url: Optional[str] = None,
    remove_link: bool = False,
) -> dict[str, Any]:
    """Apply a partial UI-equivalent text configuration to one PM text node."""
    formatted = copy.deepcopy(node)
    for option, enabled in {
        "bold": bold,
        "italic": italic,
        "underline": underline,
        "strike": strike,
        "code": code,
    }.items():
        if enabled is not None:
            _replace_mark(
                formatted,
                _INLINE_MARK_TYPES[option],
                {"type": option} if enabled else None,
            )
    if text_color is not None or clear_text_color:
        _replace_mark(
            formatted,
            ("textStyle",),
            {"type": "textStyle", "attrs": {"color": text_color}} if text_color else None,
        )
    if background_color is not None or clear_background_color:
        _replace_mark(
            formatted,
            ("highlight",),
            {"type": "highlight", "attrs": {"color": background_color}} if background_color else None,
        )
    if link_url is not None or remove_link:
        _replace_mark(
            formatted,
            ("link",),
            {"type": "link", "attrs": {"href": link_url}} if link_url else None,
        )
    return formatted


def _apply_text_format_to_scope(
    scope: list[dict[str, Any]],
    start: int,
    end: int,
    **format_options: Any,
) -> None:
    """Split only the matched text nodes and apply native ProseMirror marks."""
    rebuilt: list[dict[str, Any]] = []
    cursor = 0
    for node in scope:
        if not isinstance(node, dict) or node.get("type") != "text":
            rebuilt.append(node)
            continue
        text = str(node.get("text", ""))
        node_start, node_end = cursor, cursor + len(text)
        cursor = node_end
        overlap_start, overlap_end = max(start, node_start), min(end, node_end)
        if overlap_start >= overlap_end:
            rebuilt.append(node)
            continue
        local_start, local_end = overlap_start - node_start, overlap_end - node_start
        if local_start:
            before = copy.deepcopy(node)
            before["text"] = text[:local_start]
            rebuilt.append(before)
        selected = _apply_inline_format(node, **format_options)
        selected["text"] = text[local_start:local_end]
        rebuilt.append(selected)
        if local_end < len(text):
            after = copy.deepcopy(node)
            after["text"] = text[local_end:]
            rebuilt.append(after)
    scope[:] = rebuilt


def _normalize_search_limit(value: Optional[int]) -> int:
    if value is None:
        return BLOCK_SEARCH_DEFAULT_LIMIT
    try:
        limit = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("limit 必须为正整数") from exc
    if limit <= 0:
        raise ValueError("limit 必须为正整数")
    return min(limit, BLOCK_SEARCH_MAX_LIMIT)


def _count_keyword_occurrences(text: str, keyword: str) -> int:
    lower_text = text.lower()
    lower_keyword = keyword.lower()
    count = lower_text.count(lower_keyword)
    return count if count > 0 else 0


def _build_block_snippet(text: str, keyword: str) -> str:
    source = (text or "").strip()
    if not source:
        return ""
    lower_source = source.lower()
    lower_keyword = keyword.lower()
    match_index = lower_source.find(lower_keyword)
    if match_index < 0:
        return source[:BLOCK_SEARCH_SNIPPET_AFTER]

    start = max(0, match_index - BLOCK_SEARCH_SNIPPET_BEFORE)
    end = min(len(source), match_index + len(keyword) + BLOCK_SEARCH_SNIPPET_AFTER)
    snippet = source[start:end]
    snippet = " ".join(snippet.split()).strip()
    if start > 0:
        snippet = f"...{snippet}"
    if end < len(source):
        snippet = f"{snippet}..."
    return snippet


def _resolve_pm_json(
    service: DocumentService,
    document,
    *,
    allow_v1_fallback: bool = True,
) -> dict[str, Any]:
    """block 操作用的 PM JSON 解析链：description_json → markdown → V1 Revision。

    读操作允许 V1 Revision fallback；写操作（allow_v1_fallback=False）下若只能回退到
    V1 Revision，则抛 ValueError 拒绝——避免用过期旧数据覆盖 V3 内容（DV-011 回归）。
    """
    pm_json = document.description_json or {}
    if isinstance(pm_json, dict) and pm_json.get("content"):
        return pm_json

    markdown = (getattr(document, "description_markdown", "") or "").strip()
    if markdown:
        try:
            return markdown_to_pm_json(markdown)
        except Exception:
            logger.warning(
                "[BlockService] markdown→PM JSON 转换失败: doc=%s",
                document.id,
                exc_info=True,
            )

    revision = service.get_latest_revision(document)
    if revision and isinstance(revision.content_pm_json, dict) and revision.content_pm_json.get("content"):
        if not allow_v1_fallback:
            logger.error(
                "[BlockService] 写模式禁止 V1 Revision fallback: doc=%s rev_version=%s",
                document.id,
                getattr(revision, "version", None),
            )
            raise ValueError(
                "文档内容获取失败，V1 Revision 数据可能已过期，无法安全执行 block 写操作。"
                "请先通过整篇 save-content 写入完整内容后重试。"
            )
        logger.warning(
            "[BlockService] V1 Revision fallback 触发: doc=%s rev_version=%s",
            document.id,
            getattr(revision, "version", None),
        )
        return revision.content_pm_json

    return pm_json if isinstance(pm_json, dict) else {}


class BlockService:
    """对单个顶层 block 的读 / 改 / 插 / 删。

    构造时注入一个已带用户上下文的 `DocumentService`（权限 / get_document /
    save_content 都复用它）。REST 端点负责先 `get_document(required_role=...)` 拿到
    `document` 再调本服务，方法签名因此只收 `document`，不再重复鉴权。
    """

    def __init__(self, service: DocumentService):
        self._service = service

    # ── 读 ──

    def read_block(self, document, block_id: str) -> dict[str, Any]:
        """读取单个 block，返回 {block_id, block_type, markdown}。"""
        pm_json = _resolve_pm_json(self._service, document, allow_v1_fallback=True)

        target_node = None
        for i, node in enumerate(pm_json.get("content", []) or []):
            if _resolved_block_id(node, i) == block_id:
                target_node = node
                break

        if target_node is None:
            raise BlockNotFoundError(block_id)

        single_doc = {"type": "doc", "content": [target_node]}
        try:
            block_markdown = pm_json_to_markdown(single_doc)
        except Exception:
            block_markdown = _extract_node_text(target_node)

        return {
            "block_id": block_id,
            "block_type": target_node.get("type", "unknown"),
            "markdown": block_markdown,
        }

    def read_section(
        self,
        document,
        heading_block_id: str,
        *,
        fmt: str = SECTION_FORMAT_MARKDOWN,
        max_depth: Optional[int] = None,
    ) -> dict[str, Any]:
        """读取一个 heading 锚点起、到下一个同级/更高级 heading 前的完整章节（只读）。

        章节 = 锚点标题本身 + 其后所有顶层 block，直到遇到下一个 `level <= L` 的 heading
        为止（L 为锚点标题层级）。H2 不会吞下一个 H2/H1；H1 自然含其下 H2/H3；末节收到文末。

        - `fmt`：``markdown`` 返回整段 Markdown；``outline`` 返回逐块明细。
        - `max_depth`：可选正整数，只收集到 `level <= L + max_depth` 的子标题；更深的子节
          （及其正文）跳过。缺省收全章节。
        - 锚点不存在 → BlockNotFoundError（404）；锚点非 heading → SectionAnchorNotHeadingError（400）。
        """
        normalized_fmt = (fmt or SECTION_FORMAT_MARKDOWN).strip().lower()
        if normalized_fmt not in SECTION_FORMATS:
            raise ValueError(f"format 仅支持 {SECTION_FORMATS}，收到 {fmt!r}")
        normalized_max_depth = self._normalize_section_max_depth(max_depth)

        pm_json = _resolve_pm_json(self._service, document, allow_v1_fallback=True)
        content = pm_json.get("content", []) or []

        start_index = None
        heading_node = None
        for i, node in enumerate(content):
            if not isinstance(node, dict):
                continue
            if _resolved_block_id(node, i) == heading_block_id:
                start_index = i
                heading_node = node
                break

        if start_index is None or heading_node is None:
            raise BlockNotFoundError(heading_block_id)

        if heading_node.get("type") != HEADING_NODE_TYPE:
            raise SectionAnchorNotHeadingError(
                heading_block_id, heading_node.get("type", "unknown")
            )

        heading_level = self._node_heading_level(heading_node)
        max_included_level = (
            heading_level + normalized_max_depth if normalized_max_depth is not None else None
        )

        section_nodes: list[tuple[str, dict[str, Any]]] = [(heading_block_id, heading_node)]
        # 进入「过深子节」后，跳过其正文与更深标题，直到回到允许层级或章节边界。
        skipping_deep_subsection = False
        for j in range(start_index + 1, len(content)):
            node = content[j]
            if not isinstance(node, dict):
                continue
            if node.get("type") == HEADING_NODE_TYPE:
                level = self._node_heading_level(node)
                if level <= heading_level:
                    break  # 下一个同级/更高级标题 —— 章节结束
                if max_included_level is not None and level > max_included_level:
                    skipping_deep_subsection = True
                    continue
                skipping_deep_subsection = False
                section_nodes.append((_resolved_block_id(node, j), node))
            else:
                if skipping_deep_subsection:
                    continue
                section_nodes.append((_resolved_block_id(node, j), node))

        block_ids = [bid for bid, _ in section_nodes]
        result: dict[str, Any] = {
            "heading_block_id": heading_block_id,
            "heading_level": heading_level,
            "block_ids": block_ids,
            "block_count": len(section_nodes),
            "format": normalized_fmt,
            "base_version": getattr(document, "latest_version", None),
            "base_updated_at": _document_base_updated_at(document),
        }

        if normalized_fmt == SECTION_FORMAT_OUTLINE:
            result["blocks"] = [
                {
                    "block_id": bid,
                    "block_type": node.get("type", "unknown"),
                    "level": self._node_attr_level(node),
                    "markdown": self._render_nodes_markdown([node]),
                }
                for bid, node in section_nodes
            ]
        else:
            result["markdown"] = self._render_nodes_markdown(
                [node for _, node in section_nodes]
            )
        return result

    @staticmethod
    def _normalize_section_max_depth(value: Optional[int]) -> Optional[int]:
        if value is None:
            return None
        try:
            depth = int(value)
        except (TypeError, ValueError) as exc:
            raise ValueError("max_depth 必须为正整数") from exc
        if depth < 1:
            raise ValueError("max_depth 必须为正整数")
        return depth

    @staticmethod
    def _node_attr_level(node: dict[str, Any]) -> Optional[int]:
        attrs = node.get("attrs") if isinstance(node, dict) else None
        return attrs.get("level") if isinstance(attrs, dict) else None

    @classmethod
    def _node_heading_level(cls, node: dict[str, Any]) -> int:
        level = cls._node_attr_level(node)
        try:
            return int(level)
        except (TypeError, ValueError):
            return DEFAULT_HEADING_LEVEL

    @staticmethod
    def _render_nodes_markdown(nodes: list[dict[str, Any]]) -> str:
        single_doc = {"type": "doc", "content": nodes}
        try:
            return pm_json_to_markdown(single_doc)
        except Exception:
            return "\n\n".join(_extract_node_text(n) for n in nodes if isinstance(n, dict))

    def search_blocks(self, document, keyword: str, *, limit: Optional[int] = None) -> dict[str, Any]:
        """在单篇文档的顶层 block 内做关键词定位，返回可直接用于 read/update-block 的锚点。"""
        normalized_keyword = _normalize_search_keyword(keyword)
        normalized_limit = _normalize_search_limit(limit)
        pm_json = _resolve_pm_json(self._service, document, allow_v1_fallback=True)

        hits: list[dict[str, Any]] = []
        total_matches = 0
        for index, node in enumerate(pm_json.get("content", []) or []):
            if not isinstance(node, dict):
                continue
            text = _extract_node_text(node)
            occurrence_count = _count_keyword_occurrences(text, normalized_keyword)
            if occurrence_count == 0:
                continue
            total_matches += 1
            if len(hits) >= normalized_limit:
                continue

            attrs = node.get("attrs") or {}
            attrs_dict = attrs if isinstance(attrs, dict) else {}
            block_id = _resolved_block_id(node, index)
            hits.append(
                {
                    "block_id": block_id,
                    "block_type": node.get("type", "unknown"),
                    "level": attrs_dict.get("level"),
                    "index": index,
                    "snippet": _build_block_snippet(text, normalized_keyword),
                    "preview": text[:BLOCK_SEARCH_PREVIEW_LENGTH],
                    "relevance_score": float(occurrence_count),
                }
            )

        return {
            "items": hits,
            "total": total_matches,
            "query": normalized_keyword,
            "limit": normalized_limit,
        }

    # ── 改 ──

    def update_block(
        self,
        document,
        block_id: str,
        markdown: str,
        *,
        base_version: Optional[int] = None,
        base_updated_at: Optional[str] = None,
    ) -> dict[str, Any]:
        """用一段 markdown 替换某个 block（仅支持替换为单个顶层 block）。"""
        pm_json = _resolve_pm_json(self._service, document, allow_v1_fallback=False)
        content_list = pm_json.get("content", [])

        target_index = None
        for i, node in enumerate(content_list):
            if _resolved_block_id(node, i) == block_id:
                target_index = i
                break

        if target_index is None:
            raise BlockNotFoundError(block_id)

        new_nodes = (markdown_to_pm_json(_normalize_text(markdown)) or {}).get("content", [])
        if not new_nodes:
            raise ValueError("markdown 转换结果为空，无法替换 block。")
        if len(new_nodes) != 1:
            raise ValueError("update_block 仅支持替换为单个顶层 block。")

        # 保留原 block 的 blockId，让前端/协作端把这次改动认成"同一个块的内容变化"。
        node = new_nodes[0]
        node.setdefault("attrs", {})
        node["attrs"]["blockId"] = block_id

        content_list[target_index:target_index + 1] = new_nodes
        pm_json["content"] = content_list
        pm_json = _ensure_top_level_block_ids(pm_json)

        saved = self._save(document, pm_json, base_version=base_version, base_updated_at=base_updated_at)
        return {"document": saved, "block_id": block_id, "updated_blocks": 1}

    def format_text(
        self,
        document,
        block_id: str,
        text: str,
        *,
        bold: Optional[bool] = None,
        italic: Optional[bool] = None,
        underline: Optional[bool] = None,
        strike: Optional[bool] = None,
        code: Optional[bool] = None,
        text_color: Optional[str] = None,
        clear_text_color: bool = False,
        background_color: Optional[str] = None,
        clear_background_color: bool = False,
        link_url: Optional[str] = None,
        remove_link: bool = False,
        base_version: Optional[int] = None,
        base_updated_at: Optional[str] = None,
    ) -> dict[str, Any]:
        """Apply TabDoc's native inline text configuration to one exact range.

        This is deliberately a partial patch: omitted options keep their existing
        marks, while a supplied false/default value removes only that one format.
        """
        target = text or ""
        if not target:
            raise ValueError("text 不能为空")
        pm_json = _resolve_pm_json(self._service, document, allow_v1_fallback=False)
        content_list = pm_json.get("content", [])

        target_node = None
        for index, node in enumerate(content_list):
            if _resolved_block_id(node, index) == block_id:
                target_node = node
                break
        if target_node is None:
            raise BlockNotFoundError(block_id)

        matches: list[tuple[list[dict[str, Any]], int]] = []
        for scope in _inline_text_scopes(target_node):
            source = _scope_text(scope)
            offset = source.find(target)
            while offset >= 0:
                matches.append((scope, offset))
                offset = source.find(target, offset + len(target))
        if not matches:
            raise ValueError("在指定 block 中未找到需要高亮的原文")
        if len(matches) > 1:
            raise ValueError("指定 block 中有多个匹配，请提供更完整的原文以精确定位")

        scope, start = matches[0]
        _apply_text_format_to_scope(
            scope,
            start,
            start + len(target),
            bold=bold,
            italic=italic,
            underline=underline,
            strike=strike,
            code=code,
            text_color=text_color,
            clear_text_color=clear_text_color,
            background_color=background_color,
            clear_background_color=clear_background_color,
            link_url=link_url,
            remove_link=remove_link,
        )
        pm_json = _ensure_top_level_block_ids(pm_json)
        saved = self._save(document, pm_json, base_version=base_version, base_updated_at=base_updated_at)
        return {
            "document": saved,
            "block_id": block_id,
            "matched_text": target,
            "matched_occurrences": 1,
            "applied": {
                key: value
                for key, value in {
                    "bold": bold,
                    "italic": italic,
                    "underline": underline,
                    "strike": strike,
                    "code": code,
                    "text_color": text_color if text_color is not None else ("default" if clear_text_color else None),
                    "background_color": background_color if background_color is not None else ("default" if clear_background_color else None),
                    "link_url": link_url,
                    "remove_link": True if remove_link else None,
                }.items()
                if value is not None
            },
        }

    def highlight_text(
        self,
        document,
        block_id: str,
        text: str,
        *,
        color: str = HIGHLIGHT_COLORS["yellow"],
        base_version: Optional[int] = None,
        base_updated_at: Optional[str] = None,
    ) -> dict[str, Any]:
        """Backward-compatible shortcut for clients using the old highlight route."""
        result = self.format_text(
            document,
            block_id,
            text,
            background_color=color,
            base_version=base_version,
            base_updated_at=base_updated_at,
        )
        result["color"] = color
        return result

    # ── 插 ──

    def insert_block(
        self,
        document,
        markdown: str,
        *,
        after_block_id: Optional[str] = None,
        at_start: bool = False,
        image_file_id: Optional[UUID] = None,
        base_version: Optional[int] = None,
        base_updated_at: Optional[str] = None,
    ) -> dict[str, Any]:
        """插入一段 markdown；可插到某块之后或文档顶部，缺省追加末尾。"""
        if at_start and after_block_id:
            raise ValueError("at_start 与 after_block_id 不能同时使用。")

        pm_json = _resolve_pm_json(self._service, document, allow_v1_fallback=False)
        content_list = pm_json.get("content", [])

        new_nodes = (markdown_to_pm_json(_normalize_text(markdown)) or {}).get("content", [])
        if not new_nodes:
            raise ValueError("markdown 转换结果为空，无法插入 block。")
        if image_file_id:
            from apps.tabdoc.services.image_asset_service import _load_bound_image

            _load_bound_image(document, image_file_id)
            image_nodes: list[dict[str, Any]] = []

            def collect_images(value):
                if isinstance(value, dict):
                    if value.get("type") == "image":
                        image_nodes.append(value)
                    for child in value.get("content", []) or []:
                        collect_images(child)
                elif isinstance(value, list):
                    for child in value:
                        collect_images(child)

            collect_images(new_nodes)
            if len(image_nodes) != 1:
                raise ValueError("image_file_id 仅支持绑定一张图片的 block。")
            image_nodes[0].setdefault("attrs", {})
            image_nodes[0]["attrs"].update({
                "fileId": str(image_file_id),
                "src": "",
            })

        insert_index = 0 if at_start else len(content_list)
        if after_block_id:
            for i, node in enumerate(content_list):
                if _resolved_block_id(node, i) == after_block_id:
                    insert_index = i + 1
                    break
            else:
                raise BlockNotFoundError(after_block_id)

        start_index = insert_index
        for offset, node in enumerate(new_nodes):
            content_list.insert(insert_index + offset, node)
        pm_json["content"] = content_list
        pm_json = _ensure_top_level_block_ids(pm_json)

        inserted_ids = [
            content_list[i].get("attrs", {}).get("blockId")
            for i in range(start_index, start_index + len(new_nodes))
        ]

        saved = self._save(document, pm_json, base_version=base_version, base_updated_at=base_updated_at)
        return {
            "document": saved,
            "inserted_block_ids": inserted_ids,
            "after_block_id": after_block_id,
            "at_start": at_start,
        }

    # ── 删 ──

    def delete_block(
        self,
        document,
        block_id: str,
        *,
        base_version: Optional[int] = None,
        base_updated_at: Optional[str] = None,
    ) -> dict[str, Any]:
        """删除某个 block。"""
        pm_json = _resolve_pm_json(self._service, document, allow_v1_fallback=False)
        content_list = pm_json.get("content", [])
        original_len = len(content_list)

        content_list = [
            node
            for i, node in enumerate(content_list)
            if _resolved_block_id(node, i) != block_id
        ]

        if len(content_list) == original_len:
            raise BlockNotFoundError(block_id)

        pm_json["content"] = content_list
        pm_json = _ensure_top_level_block_ids(pm_json)

        saved = self._save(document, pm_json, base_version=base_version, base_updated_at=base_updated_at)
        return {"document": saved, "deleted_block_id": block_id}

    # ── 内部 ──

    def _save(
        self,
        document,
        pm_json: dict[str, Any],
        *,
        base_version: Optional[int],
        base_updated_at: Optional[str],
    ):
        """统一经 DocumentService.save_content 落库（带 base_version CAS）。

        base_version / base_updated_at 缺省时回退到文档当前基线——继承 TD-1 VH +
        agent 归因、TD-2 replace，不绕过写入链。
        """
        markdown = pm_json_to_markdown(pm_json)
        plaintext = _extract_doc_plaintext(pm_json)
        return self._service.save_content(
            document,
            base_version=base_version if base_version is not None else document.latest_version,
            base_updated_at=base_updated_at or _document_base_updated_at(document),
            title=None,
            content_pm_json=pm_json,
            content_markdown=markdown,
            content_plaintext=plaintext,
        )


__all__ = ["BlockService", "BlockNotFoundError", "SectionAnchorNotHeadingError"]
