"""
纯文本 / CSV / Markdown / JSON / HTML 解析器

将文本类文件解析为结构化 chunks：
- TXT / Markdown：按固定行数分页，每页一个 paragraph chunk
- CSV：转 Markdown 表格（整体为一页）
- JSON：格式化输出（整体为一页）
- HTML：提取安全文本结构并转为 Markdown 风格块（整体为一页）
"""

from __future__ import annotations

import base64
import csv
import hashlib
import io
import json
import logging
import re

from .base import BaseDocumentParser, ChunkResult, PageResult, ParseResult
from .registry import register_parser

logger = logging.getLogger(__name__)

_LINES_PER_PAGE = 100
_MAX_TOTAL_CHARS = 500_000
_MAX_CSV_ROWS = 5000
_MAX_CSV_COLS = 100
_MAX_EMBEDDED_IMAGE_BYTES = 5 * 1024 * 1024
_MAX_HTML_SRCDOC_DEPTH = 3
_MAX_HTML_SRCDOC_CHARS = _MAX_TOTAL_CHARS

_ENCODINGS = ("utf-8", "gbk", "gb2312", "big5", "latin-1")
_DATA_IMAGE_RE = re.compile(
    r"^data:(image/(?:png|jpeg|jpg|gif|webp));base64,(?P<payload>.+)$",
    re.IGNORECASE | re.DOTALL,
)


@register_parser
class PlaintextParser(BaseDocumentParser):

    def supported_mimes(self) -> list[str]:
        return [
            "text/plain",
            "text/csv",
            "text/markdown",
            "text/x-markdown",
            "application/json",
            "text/html",
            "application/xhtml+xml",
        ]

    def parse(self, file_path: str, **kwargs) -> ParseResult:
        text = _read_text(file_path)
        subtype = _detect_subtype(file_path, text)

        if subtype == "csv":
            pages = [_parse_csv(text)]
            title = ""
        elif subtype == "json":
            pages = [_parse_json(text)]
            title = ""
        elif subtype == "html":
            pages = [_parse_html(text)]
            title = _extract_html_title(text)
        else:
            pages = _parse_lines(text)
            first_line = text.split("\n", 1)[0].strip()
            title = first_line.lstrip("# ").strip()[:200] if first_line.startswith("#") else ""

        return ParseResult(
            pages=pages,
            title=title,
            parse_method="text_read",
        )


# ------------------------------------------------------------------
# 辅助函数
# ------------------------------------------------------------------


def _read_text(file_path: str) -> str:
    """尝试多种编码读取文本文件，截断超大文件。"""
    max_bytes = _MAX_TOTAL_CHARS * 4  # UTF-8 最多 4 字节/字符
    with open(file_path, "rb") as f:
        raw = f.read(max_bytes)

    for enc in _ENCODINGS:
        try:
            text = raw.decode(enc)
            break
        except (UnicodeDecodeError, LookupError):
            continue
    else:
        text = raw.decode("utf-8", errors="replace")

    if len(text) > _MAX_TOTAL_CHARS:
        text = text[:_MAX_TOTAL_CHARS]
        logger.info("文本文件超过 %d 字符，已截断", _MAX_TOTAL_CHARS)

    return text


def _detect_subtype(file_path: str, text: str) -> str:
    """根据文件后缀和内容推断子类型。"""
    lower = file_path.lower()
    if lower.endswith(".csv"):
        return "csv"
    if lower.endswith(".json") or lower.endswith(".jsonl"):
        return "json"
    if lower.endswith(".html") or lower.endswith(".htm") or lower.endswith(".xhtml"):
        return "html"
    if lower.endswith(".md") or lower.endswith(".markdown") or lower.endswith(".mark"):
        return "markdown"
    stripped = text.lstrip()[:200].lower()
    if stripped.startswith("<!doctype html") or stripped.startswith("<html"):
        return "html"
    if text.lstrip().startswith(("{", "[")):
        try:
            json.loads(text)
            return "json"
        except (json.JSONDecodeError, ValueError, RecursionError):
            pass
    return "text"


def _parse_csv(text: str) -> PageResult:
    """CSV → Markdown 表格页。"""
    try:
        reader = csv.reader(io.StringIO(text))
        rows: list[list[str]] = []
        for i, row in enumerate(reader):
            if i >= _MAX_CSV_ROWS:
                logger.info("CSV 行数超过 %d，截断", _MAX_CSV_ROWS)
                break
            cells = [
                str(c).replace("|", "\\|").replace("\n", " ").strip()
                for c in row[:_MAX_CSV_COLS]
            ]
            rows.append(cells)
    except csv.Error as exc:
        logger.warning("CSV 解析异常，降级为纯文本: %s", exc)
        content = text[:_MAX_TOTAL_CHARS]
        return PageResult(
            page_number=1, width=0, height=0,
            chunks=[ChunkResult(
                chunk_type="paragraph", content=content, sequence=1,
                metadata={"source": "text_read", "csv_error": str(exc)},
            )],
            text_content=content,
        )

    if not rows:
        return PageResult(
            page_number=1, width=0, height=0,
            chunks=[ChunkResult(chunk_type="paragraph", content="(空 CSV 文件)", sequence=1,
                                metadata={"source": "text_read"})],
            text_content="(空 CSV 文件)",
        )

    max_cols = max(len(r) for r in rows)

    def pad(r: list[str]) -> list[str]:
        return r + [""] * (max_cols - len(r))

    header = pad(rows[0])
    lines = ["| " + " | ".join(header) + " |"]
    lines.append("| " + " | ".join("---" for _ in header) + " |")
    for row in rows[1:]:
        lines.append("| " + " | ".join(pad(row)) + " |")
    md = "\n".join(lines)

    return PageResult(
        page_number=1, width=0, height=0,
        chunks=[ChunkResult(
            chunk_type="table", content=md, sequence=1,
            metadata={"source": "text_read", "rows": len(rows), "cols": max_cols},
        )],
        text_content=md,
    )


def _parse_json(text: str) -> PageResult:
    """JSON → 格式化输出页。"""
    try:
        obj = json.loads(text)
        formatted = json.dumps(obj, indent=2, ensure_ascii=False)
    except (json.JSONDecodeError, ValueError, RecursionError):
        formatted = text

    if not formatted.strip():
        formatted = "(空 JSON 文件)"

    if len(formatted) > _MAX_TOTAL_CHARS:
        formatted = formatted[:_MAX_TOTAL_CHARS] + "\n... (已截断)"

    return PageResult(
        page_number=1, width=0, height=0,
        chunks=[ChunkResult(
            chunk_type="paragraph", content=formatted, sequence=1,
            metadata={"source": "text_read", "format": "json"},
        )],
        text_content=formatted,
    )


def _extract_html_title(text: str) -> str:
    try:
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(text, "html.parser")
        title = soup.title.get_text(" ", strip=True) if soup.title else ""
        return title[:200]
    except Exception:
        return ""


def _parse_html(text: str) -> PageResult:
    """HTML → Markdown 风格页。只输出文本结构，不保留可执行 HTML。"""
    try:
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(text, "html.parser")
    except Exception as exc:
        logger.warning("HTML 解析异常，降级为纯文本: %s", exc)
        return _parse_lines(text)[0]

    blocks = _extract_html_blocks(
        soup,
        depth=0,
        srcdoc_budget=[_MAX_HTML_SRCDOC_CHARS],
    )

    chunks: list[ChunkResult] = []
    markdown_lines: list[str] = []
    for idx, (chunk_type, content, heading_level, metadata) in enumerate(blocks, start=1):
        chunks.append(ChunkResult(
            chunk_type=chunk_type,
            content=content,
            sequence=idx,
            heading_level=heading_level,
            metadata=metadata,
        ))
        if chunk_type == "heading" and heading_level:
            markdown_lines.append("#" * heading_level + " " + content)
        elif chunk_type == "codeBlock":
            markdown_lines.append(f"```\n{content}\n```")
        else:
            markdown_lines.append(content)

    markdown_text = "\n\n".join(markdown_lines)
    if len(markdown_text) > _MAX_TOTAL_CHARS:
        markdown_text = markdown_text[:_MAX_TOTAL_CHARS] + "\n... (已截断)"

    return PageResult(
        page_number=1,
        width=0,
        height=0,
        chunks=chunks,
        text_content=markdown_text,
    )


def _extract_html_blocks(soup, *, depth: int, srcdoc_budget: list[int]) -> list[tuple]:
    for tag in soup(["script", "style", "noscript", "template"]):
        tag.decompose()

    root = soup.body or soup
    blocks: list[tuple[str, str, int | None, dict]] = []
    handled_node_ids: set[int] = set()

    # iframe children are browser fallback content, not part of srcdoc.
    for iframe in root.find_all("iframe"):
        iframe.clear()

    for node in root.find_all([
        "h1", "h2", "h3", "h4", "h5", "h6",
        "p", "li", "pre", "table", "img", "iframe",
    ]):
        if id(node) in handled_node_ids:
            continue
        # Children inside iframe are browser fallback content. Parsing them as well as
        # srcdoc would duplicate the embedded document.
        if node.find_parent("iframe"):
            continue
        if node.name == "iframe":
            blocks.extend(_extract_iframe_srcdoc_blocks(
                node,
                depth=depth,
                srcdoc_budget=srcdoc_budget,
            ))
            # BeautifulSoup never fetches iframe[src]; no external document is imported.
            continue
        if node.name != "table" and node.find("iframe"):
            inline_blocks = _extract_inline_iframe_blocks(
                node,
                depth=depth,
                srcdoc_budget=srcdoc_budget,
            )
            blocks.extend(inline_blocks)
            handled_node_ids.update(id(descendant) for descendant in node.find_all([
                "h1", "h2", "h3", "h4", "h5", "h6",
                "p", "li", "pre", "img", "iframe",
            ]))
            continue
        if node.name == "img":
            if node.find_parent(["h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "pre", "table"]):
                continue
            content, metadata = _html_image_chunk_payload(node)
            blocks.append(("image", content, None, metadata))
            continue

        if node.find_parent(["pre", "table"]) and node.name not in {"pre", "table"}:
            continue
        content = node.get_text(" ", strip=True)
        if content:
            if node.name == "table":
                table_md = _html_table_to_markdown(node)
                if table_md:
                    blocks.append(("table", table_md, None, {"source": "html_read"}))
            else:
                _append_html_text_block(blocks, node.name, content)

        if node.name in {"p", "li"}:
            for img in node.find_all("img"):
                image_content, image_metadata = _html_image_chunk_payload(img)
                blocks.append(("image", image_content, None, image_metadata))

    # Exclude both external iframe URLs and fallback children from plain-text fallback.
    for iframe in root.find_all("iframe"):
        iframe.decompose()

    if not blocks:
        fallback = root.get_text("\n", strip=True)
        if fallback:
            blocks = [("paragraph", fallback, None, {"source": "html_read"})]
        elif depth == 0:
            blocks = [("paragraph", "(空 HTML 文件)", None, {"source": "html_read"})]

    return blocks


def _extract_iframe_srcdoc_blocks(iframe, *, depth: int, srcdoc_budget: list[int]) -> list[tuple]:
    srcdoc = iframe.get("srcdoc")
    if (
        not isinstance(srcdoc, str)
        or not srcdoc
        or depth >= _MAX_HTML_SRCDOC_DEPTH
        or srcdoc_budget[0] <= 0
    ):
        return []

    from bs4 import BeautifulSoup
    accepted = srcdoc[:srcdoc_budget[0]]
    srcdoc_budget[0] -= len(accepted)
    return _extract_html_blocks(
        BeautifulSoup(accepted, "html.parser"),
        depth=depth + 1,
        srcdoc_budget=srcdoc_budget,
    )


def _extract_inline_iframe_blocks(node, *, depth: int, srcdoc_budget: list[int]) -> list[tuple]:
    blocks: list[tuple] = []
    text_parts: list[str] = []

    def flush_text() -> None:
        content = re.sub(r"\s+", " ", "".join(text_parts)).strip()
        text_parts.clear()
        if content:
            _append_html_text_block(blocks, node.name, content)

    def visit(child) -> None:
        child_name = getattr(child, "name", None)
        if child_name == "iframe":
            flush_text()
            blocks.extend(_extract_iframe_srcdoc_blocks(
                child,
                depth=depth,
                srcdoc_budget=srcdoc_budget,
            ))
            return
        if child_name == "img":
            flush_text()
            content, metadata = _html_image_chunk_payload(child)
            blocks.append(("image", content, None, metadata))
            return
        if child_name is not None and (child.find("iframe") or child.find("img")):
            for nested_child in child.children:
                visit(nested_child)
            return
        if getattr(child, "get_text", None):
            text_parts.append(child.get_text(" ", strip=False))
        else:
            text_parts.append(str(child))

    for child in node.children:
        visit(child)
    flush_text()
    return blocks


def _append_html_text_block(blocks: list[tuple], node_name: str, content: str) -> None:
    if node_name.startswith("h") and len(node_name) == 2:
        blocks.append(("heading", content, int(node_name[1]), {"source": "html_read"}))
    elif node_name == "li":
        blocks.append(("list", f"- {content}", None, {"source": "html_read"}))
    elif node_name == "pre":
        blocks.append(("codeBlock", content, None, {"source": "html_read"}))
    else:
        blocks.append(("paragraph", content, None, {"source": "html_read"}))


def _html_image_chunk_payload(img) -> tuple[str, dict]:
    alt = (img.get("alt") or img.get("title") or "嵌入图片").strip() or "嵌入图片"
    src = (img.get("src") or "").strip()
    metadata = {"source": "html_read"}
    data_match = _DATA_IMAGE_RE.match(src)
    if data_match:
        image_b64 = "".join(data_match.group("payload").split())
        try:
            image_bytes = base64.b64decode(image_b64, validate=True)
        except Exception:
            metadata["image_error"] = "invalid_data_uri"
            return alt, metadata
        if len(image_bytes) > _MAX_EMBEDDED_IMAGE_BYTES:
            metadata["image_error"] = "embedded_image_too_large"
            metadata["size_bytes"] = len(image_bytes)
            return alt, metadata
        metadata.update({
            "image_b64": image_b64,
            "content_type": _normalize_data_image_content_type(data_match.group(1)),
            "image_hash": hashlib.sha256(image_bytes).hexdigest()[:16],
            "size_bytes": len(image_bytes),
        })
        return alt, metadata

    if _is_displayable_remote_image_src(src):
        return f"![{_sanitize_markdown_image_alt(alt)}]({src})", metadata
    if src:
        metadata["image_error"] = "unsupported_image_src"
    return alt, metadata


def _is_displayable_remote_image_src(src: str) -> bool:
    lower = src.lower()
    if not lower.startswith(("https://", "http://")):
        return False
    return not any(ch in src for ch in "\r\n\t <>\"'")


def _sanitize_markdown_image_alt(alt: str) -> str:
    return alt.replace("[", "(").replace("]", ")")


def _normalize_data_image_content_type(content_type: str) -> str:
    normalized = content_type.lower()
    return "image/jpeg" if normalized == "image/jpg" else normalized


def _html_table_to_markdown(table) -> str:
    rows: list[list[str]] = []
    for tr in table.find_all("tr"):
        cells = [
            cell.get_text(" ", strip=True).replace("|", "\\|")
            for cell in tr.find_all(["th", "td"])
        ]
        if cells:
            rows.append(cells[:_MAX_CSV_COLS])
        if len(rows) >= _MAX_CSV_ROWS:
            break
    if not rows:
        return ""

    max_cols = max(len(row) for row in rows)
    padded = [row + [""] * (max_cols - len(row)) for row in rows]
    header = padded[0]
    lines = ["| " + " | ".join(header) + " |"]
    lines.append("| " + " | ".join("---" for _ in header) + " |")
    for row in padded[1:]:
        lines.append("| " + " | ".join(row) + " |")
    return "\n".join(lines)


def _parse_lines(text: str) -> list[PageResult]:
    """TXT / Markdown → 按固定行数分页。"""
    lines = text.splitlines()
    if not lines:
        return [PageResult(
            page_number=1, width=0, height=0,
            chunks=[ChunkResult(chunk_type="paragraph", content="(空文件)", sequence=1,
                                metadata={"source": "text_read"})],
            text_content="(空文件)",
        )]

    pages: list[PageResult] = []
    for page_idx in range(0, len(lines), _LINES_PER_PAGE):
        page_lines = lines[page_idx: page_idx + _LINES_PER_PAGE]
        page_text = "\n".join(page_lines)
        page_num = page_idx // _LINES_PER_PAGE + 1

        chunks: list[ChunkResult] = []
        seq = 0

        current_block: list[str] = []
        current_type = "paragraph"

        for line in page_lines:
            stripped = line.strip()
            if stripped.startswith("#"):
                if current_block:
                    seq += 1
                    chunks.append(ChunkResult(
                        chunk_type=current_type,
                        content="\n".join(current_block),
                        sequence=seq,
                        metadata={"source": "text_read"},
                    ))
                    current_block = []
                level = min(len(stripped) - len(stripped.lstrip("#")), 6)
                seq += 1
                chunks.append(ChunkResult(
                    chunk_type="heading",
                    content=stripped.lstrip("# ").strip(),
                    sequence=seq,
                    heading_level=level,
                    metadata={"source": "text_read"},
                ))
                current_type = "paragraph"
            else:
                current_block.append(line)

        if current_block:
            seq += 1
            chunks.append(ChunkResult(
                chunk_type=current_type,
                content="\n".join(current_block),
                sequence=seq,
                metadata={"source": "text_read"},
            ))

        if not chunks:
            chunks.append(ChunkResult(
                chunk_type="paragraph", content=page_text, sequence=1,
                metadata={"source": "text_read"},
            ))

        pages.append(PageResult(
            page_number=page_num, width=0, height=0,
            chunks=chunks, text_content=page_text,
        ))

    return pages
