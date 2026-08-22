"""PDF generator (reportlab Platypus).

CJK support prefers an embeddable system font so the generated PDF renders the
same in Android PdfRenderer, iOS PDFKit and desktop viewers. ReportLab's built-in
``STSong-Light`` CID font remains the compatibility fallback when no local CJK
font is available.

Shares the block document model with the DOCX generator.
"""

from __future__ import annotations

import functools
import hashlib
import html
import logging
import os
from typing import Any, Dict, List

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import cm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    ListFlowable,
    ListItem,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

from tabtin_filegen.errors import SpecError
from tabtin_filegen.validate import as_text, optional_text, require_list, require_mapping

_SPEC_HELP = """pdf spec (shared block model with docx):
{
  "title": "Document title",            // optional, rendered as a title
  "blocks": [
    {"type": "heading", "level": 1, "text": "Heading"},
    {"type": "paragraph", "text": "Body text..."},
    {"type": "list", "ordered": false, "items": ["a", "b"]},
    {"type": "table", "header": ["c1", "c2"], "rows": [["x", "y"]]}
  ]
}"""

logger = logging.getLogger(__name__)

_CJK_CID_FONT_NAME = "STSong-Light"
_EMBEDDED_CJK_FONT_PREFIX = "TabTinCJK"
_CJK_PROBE_CODEPOINTS = tuple(map(ord, "中文测试"))
_SYSTEM_CJK_FONT_PATHS = (
    # Linux distributions commonly used by local/remote Agent runtimes.
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/OTF/NotoSansCJK-Regular.ttc",
    # macOS ships at least one of these with Simplified Chinese glyphs.
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
)
_WINDOWS_CJK_FONT_NAMES = (
    "msyh.ttc",
    "msyh.ttf",
    "simhei.ttf",
    "simsun.ttc",
    "Deng.ttf",
)
_MAX_HEADING_LEVEL = 4


def _cjk_font_path_candidates() -> List[str]:
    candidates: List[str] = []
    configured = os.environ.get("TABTIN_CJK_FONT_PATH", "").strip()
    if configured:
        candidates.append(os.path.expanduser(configured))
    candidates.extend(_SYSTEM_CJK_FONT_PATHS)

    windows_dir = os.environ.get("WINDIR", "").strip()
    if windows_dir:
        candidates.extend(
            os.path.join(windows_dir, "Fonts", name) for name in _WINDOWS_CJK_FONT_NAMES
        )

    # Keep the first occurrence so an explicit operator override wins.
    return list(dict.fromkeys(candidates))


@functools.lru_cache(maxsize=1)
def _ensure_cjk_font() -> str:
    for font_path in _cjk_font_path_candidates():
        if not os.path.isfile(font_path):
            continue
        try:
            path_fingerprint = hashlib.sha256(font_path.encode("utf-8")).hexdigest()[:12]
            registered_name = f"{_EMBEDDED_CJK_FONT_PREFIX}_{path_fingerprint}"
            font = TTFont(registered_name, font_path)
            if not all(codepoint in font.face.charToGlyph for codepoint in _CJK_PROBE_CODEPOINTS):
                logger.debug("Configured font has no CJK glyph coverage: %s", font_path)
                continue
            pdfmetrics.registerFont(font)
            return registered_name
        except Exception:
            logger.debug("Unable to register embeddable CJK font %s", font_path, exc_info=True)

    # Compatibility for hosts without a discoverable font. CID references are
    # compact, but some Android vendor PDF renderers cannot substitute them.
    pdfmetrics.registerFont(UnicodeCIDFont(_CJK_CID_FONT_NAME))
    return _CJK_CID_FONT_NAME


def _build_styles(font_name: str) -> Dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    styles: Dict[str, ParagraphStyle] = {}
    styles["title"] = ParagraphStyle(
        "FilegenTitle",
        parent=base["Title"],
        fontName=font_name,
    )
    styles["body"] = ParagraphStyle(
        "FilegenBody",
        parent=base["BodyText"],
        fontName=font_name,
        alignment=TA_LEFT,
        leading=16,
    )
    for level in range(1, _MAX_HEADING_LEVEL + 1):
        styles[f"heading{level}"] = ParagraphStyle(
            f"FilegenHeading{level}",
            parent=base[f"Heading{level}"],
            fontName=font_name,
        )
    return styles


class PdfGenerator:
    file_type = "pdf"
    extensions = (".pdf",)

    def spec_help(self) -> str:
        return _SPEC_HELP

    def generate(self, spec: Dict[str, Any], out_path: str) -> None:
        styles = _build_styles(_ensure_cjk_font())

        document = SimpleDocTemplate(
            out_path,
            pagesize=A4,
            leftMargin=2 * cm,
            rightMargin=2 * cm,
            topMargin=2 * cm,
            bottomMargin=2 * cm,
        )

        story: List[Any] = []
        title = optional_text(spec, "title")
        if title:
            story.append(Paragraph(_escape(title), styles["title"]))
            story.append(Spacer(1, 0.4 * cm))

        blocks = require_list(spec.get("blocks", []), "blocks")
        for index, raw_block in enumerate(blocks):
            block = require_mapping(raw_block, f"blocks[{index}]")
            story.extend(self._render_block(block, index, styles))

        if not story:
            # SimpleDocTemplate refuses to build an empty story.
            story.append(Spacer(1, 0.1 * cm))

        document.build(story)

    def _render_block(
        self, block: Dict[str, Any], index: int, styles: Dict[str, ParagraphStyle]
    ) -> List[Any]:
        block_type = block.get("type")
        if block_type == "heading":
            level = _clamp_level(block.get("level", 1))
            return [
                Paragraph(_escape(optional_text(block, "text")), styles[f"heading{level}"]),
                Spacer(1, 0.2 * cm),
            ]
        if block_type == "paragraph":
            return [
                Paragraph(_escape(optional_text(block, "text")), styles["body"]),
                Spacer(1, 0.2 * cm),
            ]
        if block_type == "list":
            return self._render_list(block, index, styles)
        if block_type == "table":
            return self._render_table(block, index, styles)
        raise SpecError(f"blocks[{index}].type unsupported: {block_type!r}")

    def _render_list(
        self, block: Dict[str, Any], index: int, styles: Dict[str, ParagraphStyle]
    ) -> List[Any]:
        ordered = bool(block.get("ordered", False))
        items = require_list(block.get("items", []), f"blocks[{index}].items")
        flow_items = [
            ListItem(Paragraph(_escape(as_text(item)), styles["body"])) for item in items
        ]
        if not flow_items:
            return []
        bullet_type = "1" if ordered else "bullet"
        return [
            ListFlowable(flow_items, bulletType=bullet_type, leftIndent=0.8 * cm),
            Spacer(1, 0.2 * cm),
        ]

    def _render_table(
        self, block: Dict[str, Any], index: int, styles: Dict[str, ParagraphStyle]
    ) -> List[Any]:
        header = block.get("header")
        rows = require_list(block.get("rows", []), f"blocks[{index}].rows")
        header_cells = (
            require_list(header, f"blocks[{index}].header") if header is not None else None
        )

        column_count = len(header_cells) if header_cells else _max_row_len(rows)
        if column_count == 0:
            raise SpecError(f"blocks[{index}] table has no columns")

        data: List[List[Any]] = []
        if header_cells:
            data.append([
                Paragraph(_escape(as_text(c)), styles["body"]) for c in header_cells
            ])
        for row_index, raw_row in enumerate(rows):
            row = require_list(raw_row, f"blocks[{index}].rows[{row_index}]")
            padded = [row[c] if c < len(row) else "" for c in range(column_count)]
            data.append([Paragraph(_escape(as_text(c)), styles["body"]) for c in padded])

        table = Table(data, repeatRows=1 if header_cells else 0)
        style_commands = [
            ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ]
        if header_cells:
            style_commands.append(("BACKGROUND", (0, 0), (-1, 0), colors.whitesmoke))
        table.setStyle(TableStyle(style_commands))
        return [table, Spacer(1, 0.2 * cm)]


_READ_HELP = """pdf read 输出：
{
  "file_type": "pdf",
  "pages": [{"text": "该页抽取文本"}],
  "text": "所有页用空行拼接"
}"""


class PdfReader:
    file_type = "pdf"
    extensions = (".pdf",)

    def read_help(self) -> str:
        return _READ_HELP

    def read(self, path: str) -> Dict[str, Any]:
        # pypdf 仅在读取时按需加载，避免生成路径强依赖。
        from pypdf import PdfReader as _PypdfReader

        reader = _PypdfReader(path)
        pages = [{"text": (page.extract_text() or "")} for page in reader.pages]
        return {
            "file_type": "pdf",
            "pages": pages,
            "text": "\n\n".join(page["text"] for page in pages),
        }


def _escape(text: str) -> str:
    """Escape for reportlab's mini-HTML paragraph markup."""
    return html.escape(text).replace("\n", "<br/>")


def _clamp_level(value: Any) -> int:
    try:
        level = int(value)
    except (TypeError, ValueError):
        return 1
    return max(1, min(_MAX_HEADING_LEVEL, level))


def _max_row_len(rows: list) -> int:
    return max((len(r) for r in rows if isinstance(r, list)), default=0)
