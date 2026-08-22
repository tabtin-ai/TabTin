"""
document_ref block 构建器

将 DocumentChunk 转换为前端 document_ref 格式的消息块，
用于在 Chat 回复中附带文档引用 + bbox 高亮信息。

前端 document_ref 格式：
{
    "type": "document_ref",
    "file_id": "...",
    "page_number": 1,
    "bbox": [x0, y0, x1, y1],
    "ref_text": "引用文本片段",
    "label": "来源标签",
}
"""
from __future__ import annotations

from typing import Any

from apps.services.docparse.models import DocumentChunk


def chunk_to_ref_block(
    chunk: DocumentChunk,
    *,
    file_id: str = "",
) -> dict[str, Any]:
    """将单个 DocumentChunk 转换为 document_ref 消息块。"""
    block: dict[str, Any] = {
        "type": "document_ref",
        "ref_text": (chunk.content or "")[:200],
    }

    if file_id:
        block["file_id"] = file_id

    page = getattr(chunk, "page", None)
    if page is not None:
        block["page_number"] = page.page_number

    if chunk.bbox_x0 is not None:
        block["bbox"] = [chunk.bbox_x0, chunk.bbox_y0, chunk.bbox_x1, chunk.bbox_y1]

    label_parts = []
    if chunk.chunk_type == "heading" and chunk.heading_level:
        label_parts.append(f"H{chunk.heading_level}")
    elif chunk.chunk_type:
        label_parts.append(chunk.chunk_type)
    if page is not None:
        label_parts.append(f"p{page.page_number}")
    if label_parts:
        block["label"] = " · ".join(label_parts)

    return block


def chunks_to_ref_blocks(
    chunks: list[DocumentChunk],
    *,
    file_id: str = "",
    max_refs: int = 20,
) -> list[dict[str, Any]]:
    """批量转换 chunks 为 document_ref 块列表（去重、限数量）。"""
    seen: set[str] = set()
    refs: list[dict[str, Any]] = []

    for chunk in chunks:
        if len(refs) >= max_refs:
            break

        dedup_key = f"{getattr(chunk.page, 'page_number', 0)}:{chunk.sequence}"
        if dedup_key in seen:
            continue
        seen.add(dedup_key)

        refs.append(chunk_to_ref_block(chunk, file_id=file_id))

    return refs
