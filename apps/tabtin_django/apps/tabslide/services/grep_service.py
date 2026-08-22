"""
TabSlide 全文本搜索 —— 跨页元素内容子串匹配。

设计理念：
  - Agent 想"找到包含某段文字的元素"时，比 outline + 逐页 page 调用快上 10x
  - 大小写不敏感、纯子串（不支持正则 / 模糊），保持简单可预期
  - 返回元素的 page_id + element_id，方便立即用 `slide update` 改

文本来源（element_type → 提取规则）：
  - text:  props.content（HTML 富文本，剥离标签后匹配）
  - shape: props.text.content（嵌套 dict，剥离标签）

输出：matches: [{page_id, page_index, element_id, element_type, content_excerpt}]
  - content_excerpt：匹配位置前后各 40 字符，含 `…` 截断标记
"""

from __future__ import annotations

import re
from typing import Any, Iterable, Optional

_HTML_TAG_RE = re.compile(r"<[^>]+>")
_EXCERPT_RADIUS = 40

DEFAULT_ELEMENT_TYPES = ("text", "shape")


def _strip_html(s: str) -> str:
    """剥离 HTML 标签，保留纯文本。NBSP 等空白不归一化（让用户原样搜索）。"""
    if not s:
        return ""
    return _HTML_TAG_RE.sub("", s)


def _extract_element_text(el: dict) -> str:
    """从元素 dict 中提取可搜索的纯文本。

    - text:  props.content（必为 str）
    - shape: props.text.content（dict 嵌套）
    其他类型返回 ""。
    """
    if not isinstance(el, dict):
        return ""
    etype = el.get("type", "")
    props = el.get("props") if isinstance(el.get("props"), dict) else {}

    if etype == "text":
        content = props.get("content") if props else None
        if isinstance(content, str):
            return _strip_html(content)
        return ""

    if etype == "shape":
        text_block = props.get("text") if props else None
        if isinstance(text_block, dict):
            content = text_block.get("content")
            if isinstance(content, str):
                return _strip_html(content)
    return ""


def _build_excerpt(content: str, pos: int, qlen: int) -> str:
    """构造匹配位置前后各 _EXCERPT_RADIUS 字符的摘要。"""
    if pos < 0:
        return ""
    start = max(0, pos - _EXCERPT_RADIUS)
    end = min(len(content), pos + qlen + _EXCERPT_RADIUS)
    excerpt = content[start:end]
    if start > 0:
        excerpt = "…" + excerpt
    if end < len(content):
        excerpt = excerpt + "…"
    return excerpt


def grep_pages(
    pages: Iterable[dict],
    query: str,
    *,
    element_types: Optional[list[str]] = None,
    max_results: int = 50,
) -> dict[str, Any]:
    """对 pages 列表执行全文搜索。

    参数：
      pages: 有序的 page dict 列表，每项形如
             {"page_id": str, "elements_data": list, "order": float}
             page_index 由列表顺序决定（0-based）
      query: 要搜的子串（空串直接返回空结果）
      element_types: 要搜的元素 type 列表，默认 ["text", "shape"]
      max_results: 最多返回多少条 match（达上限后停止扫描）

    返回：{"matches": [...], "total_matches": N}
      total_matches 跟 len(matches) 相等（达 max_results 时即停止累加），
      让 Agent 一眼看到结果完整性而不会被"还有更多没显示"误导。
    """
    if not isinstance(query, str) or not query:
        return {"matches": [], "total_matches": 0}

    types = element_types or list(DEFAULT_ELEMENT_TYPES)
    types_set = set(types)
    qlen = len(query)
    query_lower = query.lower()

    matches: list[dict[str, Any]] = []
    for page_index, page in enumerate(pages):
        if not isinstance(page, dict):
            continue
        elements = page.get("elements_data") or []
        if not isinstance(elements, list):
            continue
        page_id = page.get("page_id") or ""

        for el in elements:
            if not isinstance(el, dict):
                continue
            etype = el.get("type", "")
            if etype not in types_set:
                continue

            content = _extract_element_text(el)
            if not content:
                continue

            pos = content.lower().find(query_lower)
            if pos < 0:
                continue

            matches.append({
                "page_id": page_id,
                "page_index": page_index,
                "element_id": el.get("id", ""),
                "element_type": etype,
                "content_excerpt": _build_excerpt(content, pos, qlen),
            })
            if len(matches) >= max_results:
                return {"matches": matches, "total_matches": len(matches)}

    return {"matches": matches, "total_matches": len(matches)}
