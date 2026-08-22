"""把模型原生 PDF 附件交给 DocParse 文本层解析器。

Kimi Files API 的 extract 结果可能同时包含原始文本层与 OCR 文本层。这里复用
DocParse 的几何去重和阅读顺序重建，确保模型原生附件与 parse_document 同源。
"""

from __future__ import annotations

import json
import os
import tempfile
from typing import Optional

from apps.services.docparse.parsers.pdf_parser import PDFParser


def _sample_page_indexes(page_count: int, max_pages: int = 40) -> list[int]:
    if page_count <= max_pages:
        return list(range(page_count))
    last_index = page_count - 1
    return sorted({
        round(position * last_index / (max_pages - 1))
        for position in range(max_pages)
    })


def extract_pdf_text_for_model(
    content: bytes,
    *,
    filename: str,
    max_chars: Optional[int] = 200_000,
) -> str:
    """解析 PDF 并返回带真实页数、页码边界的模型上下文。"""
    suffix = ".pdf"
    temp_path = ""
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as temp_file:
            temp_file.write(content)
            temp_path = temp_file.name
        result = PDFParser().parse(temp_path)
    finally:
        if temp_path:
            try:
                os.unlink(temp_path)
            except FileNotFoundError:
                pass

    pages = [
        (page.page_number, (page.text_content or "").strip())
        for page in result.pages
        if (page.text_content or "").strip()
    ]
    if not pages:
        raise ValueError("PDF parser returned no readable text")

    total_pages = len(result.pages)
    safe_filename = " ".join((filename or "document.pdf").split())

    def render(selected_pages: list[tuple[int, str]], coverage_pages: list[int]) -> str:
        metadata = json.dumps(
            {
                "filename": safe_filename,
                "total_pages": total_pages,
                "coverage_pages": coverage_pages,
                "source": "tabtin_docparse",
            },
            ensure_ascii=False,
        )
        sections = [f"[PDF 文档元数据] {metadata}"]
        sections.extend(
            f"--- Page {page_number} ---\n{text}"
            for page_number, text in selected_pages
        )
        return "\n\n".join(sections)

    full_text = render(pages, [page_number for page_number, _ in pages])
    if max_chars is None or max_chars <= 0 or len(full_text) <= max_chars:
        return full_text

    sampled_indexes = _sample_page_indexes(len(pages))
    sampled_pages = [pages[index] for index in sampled_indexes]
    per_page_budget = max(200, max_chars // max(1, len(sampled_pages)) - 40)
    clipped_pages = [
        (page_number, text[:per_page_budget])
        for page_number, text in sampled_pages
    ]
    return render(
        clipped_pages,
        [page_number for page_number, _ in clipped_pages],
    )[:max_chars]
