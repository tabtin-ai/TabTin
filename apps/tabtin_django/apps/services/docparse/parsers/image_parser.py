"""Image parser for single-image TabDoc imports."""

from __future__ import annotations

import base64
import hashlib
import logging
from pathlib import Path

from .base import BaseDocumentParser, ChunkResult, PageResult, ParseResult
from .registry import register_parser

logger = logging.getLogger(__name__)

MAX_IMAGE_IMPORT_BYTES = 5 * 1024 * 1024

_IMAGE_SIGNATURES: tuple[tuple[str, bytes], ...] = (
    ("image/png", b"\x89PNG\r\n\x1a\n"),
    ("image/jpeg", b"\xff\xd8\xff"),
    ("image/gif", b"GIF87a"),
    ("image/gif", b"GIF89a"),
)


def _detect_image_mime(img_bytes: bytes) -> str | None:
    for mime, signature in _IMAGE_SIGNATURES:
        if img_bytes.startswith(signature):
            return mime
    if img_bytes.startswith(b"RIFF") and img_bytes[8:12] == b"WEBP":
        return "image/webp"
    return None


@register_parser
class ImageParser(BaseDocumentParser):
    """Convert a single imported image into an image chunk."""

    def supported_mimes(self) -> list[str]:
        return ["image/png", "image/jpeg", "image/gif", "image/webp"]

    def parse(self, file_path: str, **kwargs) -> ParseResult:
        path = Path(file_path)
        img_bytes = path.read_bytes()
        content_type = _detect_image_mime(img_bytes)
        if not content_type:
            raise ValueError("图片文件格式无效")
        if len(img_bytes) > MAX_IMAGE_IMPORT_BYTES:
            raise ValueError(
                f"图片文件过大 ({len(img_bytes) / 1024 / 1024:.1f}MB)，"
                f"超过限制 ({MAX_IMAGE_IMPORT_BYTES / 1024 / 1024:.0f}MB)"
            )

        image_hash = hashlib.sha256(img_bytes).hexdigest()[:16]
        image_b64 = base64.b64encode(img_bytes).decode("ascii")
        alt = path.stem.strip() or "导入图片"

        chunk = ChunkResult(
            chunk_type="image",
            content=alt,
            sequence=1,
            metadata={
                "source": "image_import",
                "image_b64": image_b64,
                "image_hash": image_hash,
                "content_type": content_type,
                "size_bytes": len(img_bytes),
            },
        )
        logger.info("图片导入解析完成: %s (%s, %d bytes)", path.name, content_type, len(img_bytes))
        return ParseResult(
            pages=[PageResult(
                page_number=1,
                width=0,
                height=0,
                chunks=[chunk],
                text_content=alt,
            )],
            title=alt,
            parse_method="image_import",
        )
