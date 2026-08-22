"""
PDF 解析器 (v0.2)

策略：
1. 用 PyMuPDF (fitz) 打开 PDF，检测每页是否有文本层
2. 有文本层 →
   a. 先用 pdfplumber 定位表格区域 bbox
   b. fitz.get_text("dict") 提取 blocks，**跳过**落在表格区域内的文本 blocks（去重）
   c. pdfplumber 表格转 markdown，按 y 坐标插回正确位置
   d. 相邻同样式 block 合并（减少碎片）
3. 无文本层（扫描件）→ 渲染为图片，交给 VisionParser
"""

from __future__ import annotations

import logging
import os
import re
import base64
import hashlib
import unicodedata
from collections import Counter
from dataclasses import dataclass
from difflib import SequenceMatcher

import fitz  # PyMuPDF
import pdfplumber

from .base import BaseDocumentParser, ChunkResult, PageResult, ParseResult
from .registry import register_parser

logger = logging.getLogger(__name__)

TEXT_LAYER_THRESHOLD = 100

_MAX_PAGES = 2000
_MAX_FILE_SIZE_BYTES = int(os.environ.get("DOCPARSE_PDF_MAX_FILE_SIZE_MB", "200")) * 1024 * 1024

# 两个 bbox 的重叠面积占 block 面积的比例阈值
_OVERLAP_RATIO_THRESHOLD = 0.5

# RC-017: heading 识别最小绝对字号差 (pt)，防止相近字号误判
_HEADING_MIN_GAP_PT = 1.5

# EI-020: Vision 渲染的像素上限与 DPI 参数
_MAX_RENDER_PIXELS = 4000 * 4000
_DEFAULT_RENDER_DPI = 200
_MIN_RENDER_DPI = 72

# RC-018: 文本层质量校验用的乱码字符正则
_GARBLED_CHAR_RE = re.compile(r'[\x00-\x08\x0e-\x1f\ufffd\ufffe\uffff]')
_MAX_EMBEDDED_IMAGE_BYTES = 5 * 1024 * 1024
_IMAGE_EXT_TO_CONTENT_TYPE = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "webp": "image/webp",
}


# ======================================================================
# PDF-TWOPASS: 两遍扫描数据结构
# ======================================================================

@dataclass
class DocumentProfile:
    """全文档统计 profile，由第一遍扫描生成。"""
    font_size_histogram: dict[float, int]
    body_size: float
    bold_ratio: float
    median_page_width: float
    median_page_height: float
    visible_char_count: int
    total_pages: int
    doc_type: str  # "academic" | "business" | "scan" | "mixed"


@dataclass
class PageProfile:
    """单页轻量复杂度 profile，避免默认构造超大 dict/rawdict。"""

    visible_chars: int
    text_block_count: int
    image_count: int
    drawing_count: int
    has_table_signal: bool

    @property
    def is_complex(self) -> bool:
        return (
            self.image_count > 20
            or self.drawing_count > 2000
            or self.text_block_count > 800
        )


@dataclass
class AdaptiveThresholds:
    """根据 DocumentProfile 派发的自适应阈值。"""
    text_layer_threshold: int
    heading_ratios: tuple[float, float, float]  # h1, h2, h3
    heading_min_gap_pt: float

    @classmethod
    def default(cls) -> AdaptiveThresholds:
        return cls(
            text_layer_threshold=TEXT_LAYER_THRESHOLD,
            heading_ratios=(1.5, 1.25, 1.1),
            heading_min_gap_pt=_HEADING_MIN_GAP_PT,
        )


@register_parser
class PDFParser(BaseDocumentParser):

    def supported_mimes(self) -> list[str]:
        return ["application/pdf"]

    def parse(self, file_path: str, **kwargs) -> ParseResult:
        vision_model: str = kwargs.get("vision_model", "")
        from apps.services.docparse.model_selection import normalize_selected_model_id

        self._selected_model_id = normalize_selected_model_id(
            kwargs.get("selected_model_id"),
        )
        self._billing_user_id = kwargs.get("user_id", "")
        self._billing_organization_id = kwargs.get("organization_id", "")

        doc: fitz.Document | None = None
        plumber_pdf = None
        try:
            file_size = os.path.getsize(file_path)
            if file_size > _MAX_FILE_SIZE_BYTES:
                raise ValueError(
                    f"PDF 文件过大: {file_size} bytes > {_MAX_FILE_SIZE_BYTES} bytes",
                )
            doc = fitz.open(file_path)
            if getattr(doc, "is_encrypted", False):
                raise ValueError("暂不支持解析加密 PDF")
            plumber_pdf = pdfplumber.open(file_path)
            pages: list[PageResult] = []

            total_pages = len(doc)
            if total_pages > _MAX_PAGES:
                logger.warning(
                    "PDF 页数 (%d) 超过上限 (%d)，仅处理前 %d 页: %s",
                    total_pages, _MAX_PAGES, _MAX_PAGES, file_path,
                )
            process_count = min(total_pages, _MAX_PAGES)

            # PDF-TWOPASS: 第一遍扫描——收集全文档统计
            profile = _build_document_profile(doc)
            thresholds = _compute_adaptive_thresholds(profile)
            logger.debug(
                "PDF profile: doc_type=%s, body_size=%.1f, bold_ratio=%.2f, "
                "thresholds=(tlt=%d, h_ratios=%s, gap=%.1f)",
                profile.doc_type, profile.body_size, profile.bold_ratio,
                thresholds.text_layer_threshold, thresholds.heading_ratios,
                thresholds.heading_min_gap_pt,
            )

            # 第二遍：使用自适应阈值逐页解析
            for page_idx in range(process_count):
                fitz_page = doc[page_idx]
                plumber_page = (
                    plumber_pdf.pages[page_idx]
                    if page_idx < len(plumber_pdf.pages)
                    else None
                )

                width = fitz_page.rect.width
                height = fitz_page.rect.height

                visible_chars = _count_visible_chars(fitz_page)
                if visible_chars >= thresholds.text_layer_threshold:
                    chunks = self._extract_text_layer(
                        fitz_page, plumber_page, thresholds=thresholds,
                    )
                    text_content_check = "\n".join(
                        c.content for c in chunks if c.content
                    )
                    if not _is_text_layer_reliable(text_content_check):
                        logger.info(
                            "文本层质量校验失败 (第 %d 页)，降级到 Vision",
                            page_idx + 1,
                        )
                        chunks = self._extract_via_vision(
                            fitz_page, page_idx, vision_model,
                        )
                elif _is_blank_page(fitz_page):
                    chunks = []
                else:
                    chunks = self._extract_via_vision(fitz_page, page_idx, vision_model)

                text_content = "\n".join(c.content for c in chunks if c.content)
                pages.append(PageResult(
                    page_number=page_idx + 1,
                    width=width,
                    height=height,
                    chunks=chunks,
                    text_content=text_content,
                ))
        finally:
            if plumber_pdf is not None:
                plumber_pdf.close()
            if doc is not None:
                doc.close()

        overall_method = self._determine_method(pages)
        title = self._guess_title(pages)

        return ParseResult(pages=pages, title=title, parse_method=overall_method)

    # ------------------------------------------------------------------
    # 单页解析（供流式调用）
    # ------------------------------------------------------------------

    def parse_page(
        self,
        fitz_page: fitz.Page,
        plumber_page,
        page_idx: int,
        vision_model: str = "",
        profile: DocumentProfile | None = None,
    ) -> list[ChunkResult]:
        """解析单页并返回 ChunkResult 列表。供 service 层流式调用。

        profile 为可选的全文档统计；提供时使用自适应阈值，否则使用默认值。
        """
        thresholds = (
            _compute_adaptive_thresholds(profile)
            if profile is not None
            else AdaptiveThresholds.default()
        )
        visible_chars = _count_visible_chars(fitz_page)
        if visible_chars >= thresholds.text_layer_threshold:
            page_profile = _build_page_profile(fitz_page)
            if page_profile.is_complex:
                logger.info(
                    "PDF 第 %d 页复杂度过高，降级 text-only: blocks=%d images=%d drawings=%d",
                    page_idx + 1,
                    page_profile.text_block_count,
                    page_profile.image_count,
                    page_profile.drawing_count,
                )
                chunks = self._extract_text_only(fitz_page, page_idx)
            elif page_profile.has_table_signal:
                chunks = self._extract_text_layer(
                    fitz_page, plumber_page, thresholds=thresholds,
                )
            else:
                chunks = self._extract_text_layer(
                    fitz_page, plumber_page, thresholds=thresholds,
                )
            text_content_check = "\n".join(
                c.content for c in chunks if c.content
            )
            if not _is_text_layer_reliable(text_content_check):
                logger.info(
                    "文本层质量校验失败 (第 %d 页)，降级到 Vision",
                    page_idx + 1,
                )
                return self._extract_via_vision(fitz_page, page_idx, vision_model)
            return chunks
        if _is_blank_page(fitz_page):
            return []
        return self._extract_via_vision(fitz_page, page_idx, vision_model)

    def _extract_text_blocks(self, fitz_page: fitz.Page) -> list[ChunkResult]:
        blocks = fitz_page.get_text("blocks")
        if not isinstance(blocks, list):
            return self._extract_text_only(fitz_page, 0)

        chunks: list[ChunkResult] = []
        for seq, block in enumerate(blocks, 1):
            if not isinstance(block, (list, tuple)) or len(block) < 5:
                continue
            text = str(block[4] or "").strip()
            if not text:
                continue
            block_type = block[6] if len(block) > 6 else 0
            if block_type != 0:
                continue
            chunks.append(ChunkResult(
                chunk_type="paragraph",
                content=text,
                sequence=len(chunks) + 1,
                bbox=(block[0], block[1], block[2], block[3]),
                metadata={"source": "text_layer", "quality": "high", "parser_mode": "blocks"},
            ))
        if chunks:
            return chunks
        return self._extract_text_only(fitz_page, 0)

    def _extract_text_only(self, fitz_page: fitz.Page, page_idx: int) -> list[ChunkResult]:
        text = str(fitz_page.get_text("text") or "").strip()
        if not text:
            return [ChunkResult(
                chunk_type="paragraph",
                content="[页面文本层为空，已跳过结构化提取]",
                sequence=1,
                metadata={"source": "text_only", "quality": "low", "parser_mode": "text_only_empty"},
            )]
        return [ChunkResult(
            chunk_type="paragraph",
            content=text,
            sequence=1,
            metadata={"source": "text_layer", "quality": "medium", "parser_mode": "text_only"},
        )]

    # ------------------------------------------------------------------
    # 文本层提取（v0.2: 表格去重 + block 合并）
    # ------------------------------------------------------------------

    def _extract_text_layer(
        self,
        fitz_page: fitz.Page,
        plumber_page,
        *,
        thresholds: AdaptiveThresholds | None = None,
    ) -> list[ChunkResult]:
        if thresholds is None:
            thresholds = AdaptiveThresholds.default()

        # ① 先用 pdfplumber 拿到表格区域和内容
        table_regions, table_chunks_raw = self._extract_tables(plumber_page)

        # ② 提取 fitz text blocks，跳过表格区域内的
        text_dict = fitz_page.get_text("dict", flags=fitz.TEXT_PRESERVE_WHITESPACE)
        body_size = self._calc_body_size(text_dict)

        raw_chunks: list[_RawChunk] = []
        image_bboxes: list[tuple] = []

        for block in text_dict.get("blocks", []):
            bbox = tuple(block["bbox"])

            if block["type"] == 1:
                raw_chunks.append(_image_block_to_raw_chunk(block, bbox))
                image_bboxes.append(bbox)
                continue

            if block["type"] != 0:
                continue

            if _is_inside_any_table(bbox, table_regions):
                continue

            lines_text, max_font_size, dominant_font_size, is_bold = (
                _extract_block_text(block)
            )
            content = "\n".join(lines_text).strip()
            if not content:
                continue

            chunk_type, heading_level = _classify_block(
                content, max_font_size, dominant_font_size, body_size, is_bold,
                thresholds=thresholds,
            )
            raw_chunks.append(_RawChunk(
                chunk_type=chunk_type,
                content=content,
                bbox=bbox,
                font_size=max_font_size,
                is_bold=is_bold,
                heading_level=heading_level,
            ))

        # PyMuPDF drops image blocks when TEXT_PRESERVE_WHITESPACE is enabled in
        # some PDFs, so recover images from the default dict extraction path.
        for block in fitz_page.get_text("dict").get("blocks", []):
            if block.get("type") != 1:
                continue
            bbox = tuple(block["bbox"])
            if any(_same_bbox(bbox, existing) for existing in image_bboxes):
                continue
            raw_chunks.append(_image_block_to_raw_chunk(block, bbox))
            image_bboxes.append(bbox)

        # ③ 将表格 chunks 合入，然后按阅读顺序排列（含多栏检测）
        for tc in table_chunks_raw:
            raw_chunks.append(tc)
        before_dedup = len(raw_chunks)
        raw_chunks = _deduplicate_overlapping_chunks(raw_chunks)
        if len(raw_chunks) != before_dedup:
            logger.debug(
                "PDF 文本层重叠去重: removed=%d remaining=%d",
                before_dedup - len(raw_chunks),
                len(raw_chunks),
            )
        raw_chunks = _sort_reading_order(raw_chunks, fitz_page.rect.width)

        # ④ 合并相邻同样式 paragraph blocks
        merged = _merge_adjacent_paragraphs(raw_chunks, body_size)

        # ⑤ 编号
        result: list[ChunkResult] = []
        for seq, rc in enumerate(merged, 1):
            result.append(ChunkResult(
                chunk_type=rc.chunk_type,
                content=rc.content,
                sequence=seq,
                bbox=rc.bbox,
                heading_level=rc.heading_level,
                metadata={
                    "font_size": round(rc.font_size, 1) if rc.font_size else None,
                    "bold": rc.is_bold,
                    "source": "text_layer",
                    "quality": "high",
                    **(rc.metadata_extra or {}),
                },
            ))

        return result

    # ------------------------------------------------------------------
    # pdfplumber 表格提取（返回区域 + chunks，不再直接追加）
    # ------------------------------------------------------------------

    def _extract_tables(
        self, plumber_page,
    ) -> tuple[list[tuple], list[_RawChunk]]:
        """返回 (table_bboxes, table_raw_chunks)"""
        if plumber_page is None:
            return [], []

        regions: list[tuple] = []
        chunks: list[_RawChunk] = []

        try:
            tables = plumber_page.find_tables()
        except Exception as exc:
            logger.debug("pdfplumber 表格提取失败: %s", exc)
            return [], []

        for table in tables:
            try:
                rows = table.extract()
            except Exception:
                continue
            if not rows:
                continue

            md_lines = _rows_to_markdown(rows)
            if not md_lines:
                continue

            tb = table.bbox
            bbox = (tb[0], tb[1], tb[2], tb[3]) if tb else None
            if bbox:
                regions.append(bbox)

            chunks.append(_RawChunk(
                chunk_type="table",
                content="\n".join(md_lines),
                bbox=bbox,
                font_size=0,
                is_bold=False,
                heading_level=None,
                metadata_extra={"rows": len(rows)},
            ))

        return regions, chunks

    # ------------------------------------------------------------------
    # Vision 回退（不变）
    # ------------------------------------------------------------------

    def _extract_via_vision(
        self, fitz_page: fitz.Page, page_idx: int, vision_model: str,
    ) -> list[ChunkResult]:
        if not vision_model:
            return [ChunkResult(
                chunk_type="paragraph",
                content="[扫描件页面，未配置 Vision 模型，无法提取内容]",
                sequence=1,
                metadata={"source": "skipped_scan", "quality": "skipped"},
            )]

        try:
            from .vision_parser import VisionParser

            dpi = _DEFAULT_RENDER_DPI
            width_pt = fitz_page.rect.width
            height_pt = fitz_page.rect.height
            width_px = width_pt * dpi / 72
            height_px = height_pt * dpi / 72
            total_pixels = width_px * height_px
            if total_pixels > _MAX_RENDER_PIXELS:
                scale = (_MAX_RENDER_PIXELS / total_pixels) ** 0.5
                dpi = max(_MIN_RENDER_DPI, int(dpi * scale))
                logger.info(
                    "超大页面 (%.0f×%.0fpt)，DPI 从 %d 降至 %d (第 %d 页)",
                    width_pt, height_pt, _DEFAULT_RENDER_DPI, dpi, page_idx + 1,
                )

            pix = fitz_page.get_pixmap(dpi=dpi)
            img_bytes = pix.tobytes("png")
            del pix

            parser = VisionParser(
                model=vision_model,
                user_id=getattr(self, "_billing_user_id", ""),
                organization_id=getattr(self, "_billing_organization_id", ""),
                selected_model_id=getattr(self, "_selected_model_id", None),
            )
            return parser.parse_image_bytes(
                img_bytes,
                page_number=page_idx + 1,
                page_width=fitz_page.rect.width,
                page_height=fitz_page.rect.height,
            )
        except Exception as exc:
            logger.error("Vision 解析第 %d 页失败: %s", page_idx + 1, exc)
            return [ChunkResult(
                chunk_type="paragraph",
                content="[Vision 解析失败，请重试或联系支持]",
                sequence=1,
                metadata={
                    "source": "vision",
                    "is_error": True,
                    "error_detail": str(exc),
                    "quality": "low",
                },
            )]

    # ------------------------------------------------------------------
    # 辅助
    # ------------------------------------------------------------------

    @staticmethod
    def _calc_body_size(text_dict: dict) -> float:
        sizes: list[float] = []
        for block in text_dict.get("blocks", []):
            if block["type"] != 0:
                continue
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    if span.get("text", "").strip():
                        sizes.append(span["size"])
        return _median(sizes) if sizes else 12.0

    @staticmethod
    def _guess_title(pages: list[PageResult]) -> str:
        if not pages or not pages[0].chunks:
            return ""
        first = pages[0].chunks[0]
        if first.chunk_type == "heading":
            return first.content[:200]
        return ""

    @staticmethod
    def _determine_method(pages: list[PageResult]) -> str:
        has_vision = False
        has_text = False
        has_skipped_scan = False
        for p in pages:
            for c in p.chunks:
                src = c.metadata.get("source", "")
                if src == "vision":
                    has_vision = True
                elif src == "text_layer":
                    has_text = True
                elif src == "skipped_scan":
                    has_skipped_scan = True
        if has_vision and has_text:
            return "hybrid"
        if has_vision:
            return "vision"
        if has_skipped_scan and has_text:
            return "hybrid"
        if has_skipped_scan:
            return "vision"
        return "text_layer"


# ======================================================================
# 内部数据结构
# ======================================================================

@dataclass
class _RawChunk:
    """合并/排序阶段用的中间结构"""
    chunk_type: str
    content: str
    bbox: tuple | None
    font_size: float
    is_bold: bool
    heading_level: int | None = None
    metadata_extra: dict | None = None


# ======================================================================
# 模块级辅助函数
# ======================================================================

def _normalize_pdf_text_for_dedup(text: str) -> str:
    return re.sub(
        r"\s+",
        " ",
        unicodedata.normalize("NFKC", text)
        .lower()
        .replace("’", "'")
        .replace("‘", "'")
        .replace("“", '"')
        .replace("”", '"'),
    ).strip()


def _bbox_overlap_ratio(a: tuple, b: tuple) -> float:
    ax0, ay0, ax1, ay1 = (float(v) for v in a[:4])
    bx0, by0, bx1, by1 = (float(v) for v in b[:4])
    overlap_width = max(0.0, min(ax1, bx1) - max(ax0, bx0))
    overlap_height = max(0.0, min(ay1, by1) - max(ay0, by0))
    overlap_area = overlap_width * overlap_height
    smaller_area = max(
        1.0,
        min(max(0.0, ax1 - ax0) * max(0.0, ay1 - ay0),
            max(0.0, bx1 - bx0) * max(0.0, by1 - by0)),
    )
    return overlap_area / smaller_area


def _pdf_texts_nearly_equal(a: str, b: str) -> bool:
    if a == b or a in b or b in a:
        return True
    if SequenceMatcher(None, a, b, autojunk=False).ratio() >= 0.82:
        return True

    a_tokens = re.findall(r"\w+", a)
    b_tokens = re.findall(r"\w+", b)
    shorter, longer = (
        (a_tokens, b_tokens)
        if len(a_tokens) <= len(b_tokens)
        else (b_tokens, a_tokens)
    )
    if len(shorter) < 8:
        return False
    matched = sum((Counter(shorter) & Counter(longer)).values())
    return matched / len(shorter) >= 0.9


def _deduplicate_overlapping_chunks(chunks: list[_RawChunk]) -> list[_RawChunk]:
    """移除同一位置的原始文本层/OCR 文本层副本，保留覆盖更完整的一份。"""
    indexed = list(enumerate(chunks))

    def bbox_area(entry: tuple[int, _RawChunk]) -> float:
        bbox = entry[1].bbox
        if not bbox:
            return 0.0
        return max(0.0, float(bbox[2]) - float(bbox[0])) * max(
            0.0, float(bbox[3]) - float(bbox[1]),
        )

    kept: list[tuple[int, _RawChunk, str]] = []
    for index, chunk in sorted(indexed, key=bbox_area, reverse=True):
        normalized = _normalize_pdf_text_for_dedup(chunk.content)
        if chunk.chunk_type not in {"heading", "paragraph", "list", "note"} or not chunk.bbox or not normalized:
            kept.append((index, chunk, normalized))
            continue

        duplicate = False
        for _, existing, existing_normalized in kept:
            if existing.chunk_type not in {"heading", "paragraph", "list", "note"} or not existing.bbox:
                continue
            if _bbox_overlap_ratio(chunk.bbox, existing.bbox) < 0.65:
                continue
            if _pdf_texts_nearly_equal(normalized, existing_normalized):
                duplicate = True
                break
        if not duplicate:
            kept.append((index, chunk, normalized))

    return [chunk for _, chunk, _ in sorted(kept, key=lambda entry: entry[0])]

def _extract_block_text(block: dict) -> tuple[list[str], float, float, bool]:
    """从 fitz text block 提取 (lines_text, max_font_size, dominant_font_size, is_bold)

    dominant_font_size 是 block 中按字符数加权占比最大的字号，用于 heading
    阈值比较，避免少量 superscript/annotation span 的 max 值导致误判。
    """
    lines_text: list[str] = []
    max_font_size = 0.0
    is_bold = False
    size_char_counts: dict[float, int] = {}
    for line in block.get("lines", []):
        spans_text = []
        for span in line.get("spans", []):
            text = span.get("text", "")
            spans_text.append(text)
            size = span["size"]
            char_count = len(text.strip())
            if char_count > 0:
                rounded = round(size, 1)
                size_char_counts[rounded] = size_char_counts.get(rounded, 0) + char_count
            if size > max_font_size:
                max_font_size = size
            if "bold" in span.get("font", "").lower():
                is_bold = True
        lines_text.append("".join(spans_text))

    dominant_font_size = max_font_size
    if size_char_counts:
        dominant_font_size = max(size_char_counts, key=size_char_counts.get)

    return lines_text, max_font_size, dominant_font_size, is_bold


def _pdf_image_block_metadata(block: dict) -> dict:
    metadata: dict[str, object] = {
        "alt": "[嵌入图片]",
        "source": "text_layer",
    }
    image_bytes = block.get("image")
    ext = str(block.get("ext") or "").lower()
    content_type = _IMAGE_EXT_TO_CONTENT_TYPE.get(ext)
    if not isinstance(image_bytes, (bytes, bytearray)) or not image_bytes:
        metadata["image_error"] = "missing_pdf_image_bytes"
        return metadata
    if not content_type:
        metadata["image_error"] = "unsupported_pdf_image_format"
        metadata["image_ext"] = ext
        return metadata
    if len(image_bytes) > _MAX_EMBEDDED_IMAGE_BYTES:
        metadata["image_error"] = "embedded_image_too_large"
        metadata["size_bytes"] = len(image_bytes)
        return metadata

    bbox = block.get("bbox")
    if isinstance(bbox, (list, tuple)) and len(bbox) >= 4:
        display_width = max(1, int(round(float(bbox[2]) - float(bbox[0]))))
        display_height = max(1, int(round(float(bbox[3]) - float(bbox[1]))))
        metadata["width"] = display_width
        metadata["height"] = display_height
    if isinstance(block.get("width"), (int, float)):
        metadata["intrinsic_width"] = int(block["width"])
    if isinstance(block.get("height"), (int, float)):
        metadata["intrinsic_height"] = int(block["height"])
    metadata.update({
        "image_b64": base64.b64encode(bytes(image_bytes)).decode("ascii"),
        "content_type": content_type,
        "image_hash": hashlib.sha256(bytes(image_bytes)).hexdigest()[:24],
        "size_bytes": len(image_bytes),
    })
    return metadata


def _image_block_to_raw_chunk(block: dict, bbox: tuple) -> _RawChunk:
    metadata = _pdf_image_block_metadata(block)
    return _RawChunk(
        chunk_type="image",
        content=str(metadata.get("alt") or "[嵌入图片]"),
        bbox=bbox,
        font_size=0,
        is_bold=False,
        heading_level=None,
        metadata_extra=metadata,
    )


def _same_bbox(a: tuple, b: tuple, *, tolerance: float = 0.5) -> bool:
    if len(a) < 4 or len(b) < 4:
        return False
    return all(abs(float(a[i]) - float(b[i])) <= tolerance for i in range(4))


def _is_inside_any_table(
    block_bbox: tuple, table_regions: list[tuple],
) -> bool:
    """判断一个 block 是否（大部分面积）落在任意表格区域内"""
    if not table_regions:
        return False
    bx0, by0, bx1, by1 = block_bbox
    block_area = max((bx1 - bx0) * (by1 - by0), 1e-6)

    for tx0, ty0, tx1, ty1 in table_regions:
        ox0 = max(bx0, tx0)
        oy0 = max(by0, ty0)
        ox1 = min(bx1, tx1)
        oy1 = min(by1, ty1)
        if ox0 < ox1 and oy0 < oy1:
            overlap = (ox1 - ox0) * (oy1 - oy0)
            if overlap / block_area >= _OVERLAP_RATIO_THRESHOLD:
                return True
    return False


def _merge_adjacent_paragraphs(
    chunks: list[_RawChunk], body_size: float,
) -> list[_RawChunk]:
    """
    合并相邻的同样式 paragraph blocks。
    条件：chunk_type 都是 paragraph、字号差 ≤ 1pt、bold 一致、y 间距 < 行高 * 1.5。
    """
    if not chunks:
        return []

    result: list[_RawChunk] = [chunks[0]]

    for cur in chunks[1:]:
        prev = result[-1]

        if (
            prev.chunk_type == "paragraph"
            and cur.chunk_type == "paragraph"
            and abs(prev.font_size - cur.font_size) <= 1.0
            and prev.is_bold == cur.is_bold
            and prev.bbox and cur.bbox
            and _vertical_gap(prev.bbox, cur.bbox) < body_size * 1.8
        ):
            merged_bbox = (
                min(prev.bbox[0], cur.bbox[0]),
                min(prev.bbox[1], cur.bbox[1]),
                max(prev.bbox[2], cur.bbox[2]),
                max(prev.bbox[3], cur.bbox[3]),
            )
            result[-1] = _RawChunk(
                chunk_type="paragraph",
                content=prev.content + "\n" + cur.content,
                bbox=merged_bbox,
                font_size=max(prev.font_size, cur.font_size),
                is_bold=prev.is_bold,
                heading_level=None,
            )
        else:
            result.append(cur)

    return result


def _vertical_gap(bbox_a: tuple, bbox_b: tuple) -> float:
    """两个 bbox 的垂直间距（b 的顶部 - a 的底部）"""
    return bbox_b[1] - bbox_a[3]


def _median(values: list[float]) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    n = len(s)
    if n % 2 == 1:
        return s[n // 2]
    return (s[n // 2 - 1] + s[n // 2]) / 2


def _weighted_median(histogram: dict[float, int]) -> float:
    """按字符数加权的中位字号。"""
    if not histogram:
        return 0.0
    entries = sorted(histogram.items())
    total = sum(count for _, count in entries)
    if total == 0:
        return 0.0
    half = total / 2
    cumulative = 0
    for size, count in entries:
        cumulative += count
        if cumulative >= half:
            return size
    return entries[-1][0]


# ======================================================================
# PDF-TWOPASS: 全文档统计 + 自适应阈值
# ======================================================================

def _build_document_profile(doc) -> DocumentProfile:
    """第一遍轻量扫描：不默认构造 PyMuPDF dict/rawdict。"""
    font_size_histogram: dict[float, int] = {}
    total_bold_chars = 0
    total_chars = 0
    page_widths: list[float] = []
    page_heights: list[float] = []
    visible_char_count = 0

    for page_idx in range(len(doc)):
        page = doc[page_idx]
        page_widths.append(page.rect.width)
        page_heights.append(page.rect.height)

        blocks = page.get_text("blocks")
        if not isinstance(blocks, list):
            text = str(page.get_text("text") or "").strip()
            char_count = len(text)
            total_chars += char_count
            visible_char_count += char_count
            continue
        for block in blocks:
            if not isinstance(block, (list, tuple)) or len(block) < 5:
                continue
            block_type = block[6] if len(block) > 6 else 0
            if block_type != 0:
                continue
            text = str(block[4] or "").strip()
            char_count = len(text)
            if char_count == 0:
                continue
            total_chars += char_count
            visible_char_count += char_count

    body_size = _weighted_median(font_size_histogram) if font_size_histogram else 12.0
    bold_ratio = total_bold_chars / total_chars if total_chars > 0 else 0.0
    median_pw = _median(page_widths) if page_widths else 612.0
    median_ph = _median(page_heights) if page_heights else 792.0
    total_pages = len(doc)

    chars_per_page = visible_char_count / total_pages if total_pages > 0 else 0
    if chars_per_page < 100:
        doc_type = "scan"
    elif body_size < 11.0 and bold_ratio < 0.3:
        doc_type = "academic"
    elif body_size >= 11.0 and bold_ratio > 0.3:
        doc_type = "business"
    else:
        doc_type = "mixed"

    return DocumentProfile(
        font_size_histogram=font_size_histogram,
        body_size=body_size,
        bold_ratio=bold_ratio,
        median_page_width=median_pw,
        median_page_height=median_ph,
        visible_char_count=visible_char_count,
        total_pages=total_pages,
        doc_type=doc_type,
    )


def _compute_adaptive_thresholds(profile: DocumentProfile) -> AdaptiveThresholds:
    """根据 DocumentProfile 派发自适应阈值。"""
    if profile.doc_type == "academic":
        return AdaptiveThresholds(
            text_layer_threshold=100,
            heading_ratios=(1.5, 1.25, 1.1),
            heading_min_gap_pt=1.5,
        )
    if profile.doc_type == "business":
        return AdaptiveThresholds(
            text_layer_threshold=80,
            heading_ratios=(1.3, 1.15, 1.05),
            heading_min_gap_pt=2.0,
        )
    if profile.doc_type == "scan":
        return AdaptiveThresholds(
            text_layer_threshold=50,
            heading_ratios=(1.5, 1.25, 1.1),
            heading_min_gap_pt=1.5,
        )
    # mixed — 使用原始默认值
    return AdaptiveThresholds.default()


# 有序列表模式: 1. / 1) / (1) / a. / a) / (a) / i. / ① 等
_ORDERED_LIST_RE = re.compile(
    r"^(?:"
    r"\d+[.)]\s"            # 1. / 1)
    r"|\(\d+\)\s"           # (1)
    r"|[a-zA-Z][.)]\s"      # a. / a)
    r"|\([a-zA-Z]\)\s"      # (a)
    r"|[ivxIVX]+[.)]\s"     # i. / ii)
    r"|[①②③④⑤⑥⑦⑧⑨⑩]"     # 带圈数字
    r"|[一二三四五六七八九十]+[、.]\s?"  # 中文序号
    r")"
)

_BULLET_PREFIXES = ("•", "-", "–", "—", "·", "※", "◆", "◇", "▪", "▫", "►", "★")


def _classify_block(
    content: str,
    max_font_size: float,
    dominant_font_size: float,
    body_size: float,
    is_bold: bool,
    *,
    thresholds: AdaptiveThresholds | None = None,
) -> tuple[str, int | None]:
    """根据字号、样式、内容模式推断 chunk_type + heading_level

    使用 dominant_font_size（block 中字符数占比最大的字号）进行阈值比较，
    同时要求绝对字号差 >= heading_min_gap_pt 防止相近字号体系下的误判。
    thresholds 为 None 时使用默认值（向后兼容）。
    """
    if thresholds is None:
        thresholds = AdaptiveThresholds.default()

    h1_ratio, h2_ratio, h3_ratio = thresholds.heading_ratios
    min_gap = thresholds.heading_min_gap_pt

    size_ratio = dominant_font_size / body_size if body_size > 0 else 1.0
    size_gap = dominant_font_size - body_size

    if size_ratio > h1_ratio and size_gap >= min_gap:
        return "heading", 1
    if size_ratio > h2_ratio and size_gap >= min_gap:
        return "heading", 2
    if size_ratio > h3_ratio and size_gap >= min_gap and is_bold:
        return "heading", 3

    lines = [line for line in content.split("\n") if line.strip()]

    # bullet 无序列表
    if lines and all(line.strip()[:1] in _BULLET_PREFIXES for line in lines):
        return "list", None

    # 有序列表
    if lines and all(_ORDERED_LIST_RE.match(line.strip()) for line in lines):
        return "list", None

    # 加粗短句 h4：要求字号 ≥ 正文且不像图注/关键词等标签
    if (
        is_bold
        and len(content) < 60
        and "\n" not in content.strip()
        and dominant_font_size >= body_size - 0.5
        and not _looks_like_caption(content)
    ):
        return "heading", 4

    return "paragraph", None


_CAPTION_RE = re.compile(
    r'^(图|表|Figure|Table|Fig\.?|Tab\.?)\s*[\d.]+', re.IGNORECASE,
)
_LABEL_RE = re.compile(
    r'^(关键词|摘要|Abstract|Keywords|Note|注|备注|来源|出处|Source|Ref)\s*[:：]',
    re.IGNORECASE,
)


def _looks_like_caption(text: str) -> bool:
    """判断文本是否更像图注、表注、关键词等非标题内容"""
    stripped = text.strip()
    if _CAPTION_RE.match(stripped):
        return True
    if (stripped.startswith('(') and stripped.endswith(')')) or \
       (stripped.startswith('（') and stripped.endswith('）')):
        return True
    if _LABEL_RE.match(stripped):
        return True
    return False


def _rows_to_markdown(rows: list[list]) -> list[str]:
    if not rows:
        return []

    def _cell(v):
        return str(v).replace("|", "\\|").replace("\n", " ").strip() if v else ""

    header = rows[0]
    if not any(_cell(c) for c in header):
        return []

    lines = ["| " + " | ".join(_cell(c) for c in header) + " |"]
    lines.append("| " + " | ".join("---" for _ in header) + " |")
    for row in rows[1:]:
        padded = list(row) + [""] * (len(header) - len(row))
        lines.append("| " + " | ".join(_cell(c) for c in padded[:len(header)]) + " |")
    return lines


# ======================================================================
# 多栏检测与阅读顺序修正
# ======================================================================

_MIN_COLUMN_GAP = 20  # pt，两栏之间最小间距
_MIN_BLOCKS_FOR_DETECTION = 6  # 至少需要这么多 block 才尝试检测多栏


def _sort_reading_order(
    chunks: list[_RawChunk], page_width: float,
) -> list[_RawChunk]:
    """
    检测多栏布局并按正确阅读顺序排序。

    算法：
    1. 收集所有 text block 的中心 x 坐标
    2. 尝试在页面中部附近寻找 x 坐标的"间隙"（gap）
    3. 如果间隙两侧各有足够多的 block，判定为双栏
    4. 双栏时：按 spanning block 的 y 坐标将内容分段，
       每段内先输出左栏再输出右栏，段间插入 spanning block
    """
    if len(chunks) < _MIN_BLOCKS_FOR_DETECTION:
        chunks.sort(key=lambda c: (c.bbox[1] if c.bbox else 0, c.bbox[0] if c.bbox else 0))
        return chunks

    bboxed = [(i, c) for i, c in enumerate(chunks) if c.bbox]
    if len(bboxed) < _MIN_BLOCKS_FOR_DETECTION:
        chunks.sort(key=lambda c: (c.bbox[1] if c.bbox else 0, c.bbox[0] if c.bbox else 0))
        return chunks

    split_x = _detect_column_split(bboxed, page_width)

    if split_x is None:
        chunks.sort(key=lambda c: (c.bbox[1] if c.bbox else 0, c.bbox[0] if c.bbox else 0))
        return chunks

    wide_threshold = page_width * 0.55

    left_col: list[_RawChunk] = []
    right_col: list[_RawChunk] = []
    spanning: list[tuple[float, _RawChunk]] = []

    for c in chunks:
        if not c.bbox:
            left_col.append(c)
            continue

        block_width = c.bbox[2] - c.bbox[0]
        center_x = (c.bbox[0] + c.bbox[2]) / 2

        if block_width > wide_threshold:
            spanning.append((c.bbox[1], c))
        elif center_x < split_x:
            left_col.append(c)
        else:
            right_col.append(c)

    left_col.sort(key=lambda c: (c.bbox[1] if c.bbox else 0))
    right_col.sort(key=lambda c: (c.bbox[1] if c.bbox else 0))
    spanning.sort(key=lambda t: t[0])

    # RC-014: 按 spanning block 的 y 坐标分段，每段内 left→right
    result: list[_RawChunk] = []
    left_start = 0
    right_start = 0

    for span_y, span_chunk in spanning:
        while left_start < len(left_col):
            c = left_col[left_start]
            if c.bbox and c.bbox[1] >= span_y:
                break
            result.append(c)
            left_start += 1
        while right_start < len(right_col):
            c = right_col[right_start]
            if c.bbox and c.bbox[1] >= span_y:
                break
            result.append(c)
            right_start += 1
        result.append(span_chunk)

    result.extend(left_col[left_start:])
    result.extend(right_col[right_start:])

    return result


def _detect_column_split(
    bboxed: list[tuple[int, _RawChunk]], page_width: float,
) -> float | None:
    """
    检测双栏分割线的 x 坐标。

    方法：对所有 block 的 x 范围建立"覆盖直方图"，
    在页面中部（25%-75%）寻找覆盖最少的间隙区。
    跨栏宽块（宽度 > 55% 页宽）不参与直方图计算，
    避免标题/页眉干扰间隙检测。
    """
    resolution = 100
    histogram = [0] * resolution
    wide_threshold = page_width * 0.55

    for _, c in bboxed:
        block_width = c.bbox[2] - c.bbox[0]
        if block_width > wide_threshold:
            continue
        x0_bin = int(c.bbox[0] / page_width * resolution)
        x1_bin = int(c.bbox[2] / page_width * resolution)
        x0_bin = max(0, min(x0_bin, resolution - 1))
        x1_bin = max(0, min(x1_bin, resolution - 1))
        for b in range(x0_bin, x1_bin + 1):
            histogram[b] += 1

    search_start = int(resolution * 0.25)
    search_end = int(resolution * 0.75)

    min_count = float("inf")
    min_bin = -1
    for b in range(search_start, search_end):
        if histogram[b] < min_count:
            min_count = histogram[b]
            min_bin = b

    if min_count > 1:
        return None

    gap_start = min_bin
    gap_end = min_bin
    while gap_start > search_start and histogram[gap_start - 1] <= min_count:
        gap_start -= 1
    while gap_end < search_end - 1 and histogram[gap_end + 1] <= min_count:
        gap_end += 1

    gap_width_pt = (gap_end - gap_start + 1) / resolution * page_width
    if gap_width_pt < _MIN_COLUMN_GAP:
        return None

    split_x = (gap_start + gap_end + 1) / 2 / resolution * page_width

    left_count = sum(1 for _, c in bboxed if c.bbox and (c.bbox[0] + c.bbox[2]) / 2 < split_x)
    right_count = len(bboxed) - left_count

    if left_count < 3 or right_count < 3:
        return None

    logger.debug(
        "检测到双栏布局: split_x=%.1f, left=%d, right=%d, gap=%.1fpt",
        split_x, left_count, right_count, gap_width_pt,
    )
    return split_x


# ======================================================================
# 文本层质量校验（RC-001 / RC-018 / EI-021）
# ======================================================================

def _count_visible_chars(fitz_page) -> int:
    """轻量统计页面文本字符数，不默认构造 PyMuPDF dict/rawdict。"""
    text = str(fitz_page.get_text("text") or "")
    return len(text.strip())


def _build_page_profile(fitz_page) -> PageProfile:
    blocks = fitz_page.get_text("blocks")
    if not isinstance(blocks, list):
        blocks = []
    text_block_count = 0
    has_table_signal = False
    visible_chars = 0
    for block in blocks:
        if not isinstance(block, (list, tuple)) or len(block) < 5:
            continue
        block_type = block[6] if len(block) > 6 else 0
        if block_type != 0:
            continue
        text = str(block[4] or "")
        stripped = text.strip()
        if not stripped:
            continue
        text_block_count += 1
        visible_chars += len(stripped)
        if "\t" in text or "|" in text or re.search(r"\s{4,}", text):
            has_table_signal = True

    try:
        image_count = len(fitz_page.get_images(full=True))
    except Exception:
        image_count = 0
    try:
        drawing_count = len(fitz_page.get_drawings())
    except Exception:
        drawing_count = 0
    return PageProfile(
        visible_chars=visible_chars,
        text_block_count=text_block_count,
        image_count=image_count,
        drawing_count=drawing_count,
        has_table_signal=has_table_signal,
    )


def _is_blank_page(fitz_page) -> bool:
    profile = _build_page_profile(fitz_page)
    if profile.visible_chars != 0 or profile.image_count != 0:
        return False
    if profile.drawing_count == 0:
        return True
    try:
        drawings = fitz_page.get_drawings()
    except Exception:
        return False
    return bool(drawings) and all(_is_blank_background_drawing(d) for d in drawings)


def _is_blank_background_drawing(drawing: dict) -> bool:
    if drawing.get("type") != "f":
        return False
    if drawing.get("color") is not None:
        return False
    fill = drawing.get("fill")
    if not _is_nearly_white(fill):
        return False
    if float(drawing.get("fill_opacity") or 0) < 0.99:
        return False
    items = drawing.get("items") or []
    return bool(items) and all(
        isinstance(item, (list, tuple)) and item and item[0] == "re"
        for item in items
    )


def _is_nearly_white(color) -> bool:
    if not isinstance(color, (list, tuple)) or len(color) < 3:
        return False
    try:
        return all(float(channel) >= 0.98 for channel in color[:3])
    except (TypeError, ValueError):
        return False


def _is_text_layer_reliable(text: str) -> bool:
    """校验提取的文本层内容质量，检测乱码 OCR 层。

    检查三个维度：
    1. 有意义字符（字母数字 + CJK + 常见标点）占比 >= 30%
    2. 乱码控制字符占比 < 10%
    3. 无单字符过度重复（排除 OCR 残影）
    """
    if not text or len(text.strip()) < 20:
        return False

    cleaned = text.replace(" ", "").replace("\n", "").replace("\r", "").replace("\t", "")
    total = len(cleaned)
    if total == 0:
        return False

    meaningful = 0
    for c in cleaned:
        if c.isalnum():
            meaningful += 1
        elif "\u4e00" <= c <= "\u9fff":
            meaningful += 1
        elif "\u3040" <= c <= "\u30ff":
            meaningful += 1
        elif "\uac00" <= c <= "\ud7af":
            meaningful += 1
        elif c in ".,;:!?'\"()-/\\@#$%&*+=[]{}|<>~`^_":
            meaningful += 1

    if meaningful / total < 0.3:
        return False

    garbled = len(_GARBLED_CHAR_RE.findall(cleaned))
    if garbled / total > 0.1:
        return False

    if total > 30:
        from collections import Counter
        char_freq = Counter(cleaned)
        top_char, top_count = char_freq.most_common(1)[0]
        if top_count / total > 0.4 and not top_char.isspace():
            return False

    normalized_lines = [
        _normalize_pdf_text_for_dedup(line)
        for line in text.splitlines()
        if len(_normalize_pdf_text_for_dedup(line)) >= 20
    ]
    if len(normalized_lines) > 1:
        seen: set[str] = set()
        duplicate_chars = 0
        total_line_chars = 0
        for line in normalized_lines:
            total_line_chars += len(line)
            if line in seen:
                duplicate_chars += len(line)
            else:
                seen.add(line)
        if total_line_chars and duplicate_chars / total_line_chars > 0.35:
            return False

    long_runs = re.findall(r"[^\W_]{80,}", text, flags=re.UNICODE)
    if sum(len(run) for run in long_runs) / total > 0.25:
        return False

    return True
