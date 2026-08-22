"""Pure projection rules shared by user-message persistence and Agent forwarding."""

from typing import Any, Dict, List, Optional


ATTACHMENT_BLOCK_TYPES = frozenset({"image", "file", "video"})


def _attachment_key(item: Dict[str, Any]) -> tuple:
    """Stable identity across mobile ``blocks`` and legacy ``attachments``."""
    return (
        item.get("type"),
        item.get("file_id") or item.get("fileId"),
        item.get("url") or item.get("remote_url") or item.get("remoteUrl"),
        item.get("filename") or item.get("name"),
        item.get("mime_type") or item.get("mimeType"),
        item.get("size"),
    )


def merge_user_text_into_blocks(text: str, blocks: Optional[list]) -> List[dict]:
    """Keep the visible caption in the canonical content-block timeline."""
    normalized = [dict(block) for block in (blocks or []) if isinstance(block, dict)]
    visible_text = (text or "").strip()
    has_same_text = any(
        block.get("type") == "text"
        and str(block.get("text") or block.get("content") or "").strip() == visible_text
        for block in normalized
    )
    if visible_text and not has_same_text:
        normalized.insert(0, {"type": "text", "text": text})
    return normalized


def merge_attachment_blocks(
    attachments: Optional[list],
    blocks: Optional[list],
) -> List[Dict[str, Any]]:
    """Project v2 image/file blocks onto the runtime attachment channel."""
    result = [dict(item) for item in (attachments or []) if isinstance(item, dict)]
    seen = {_attachment_key(item) for item in result}
    for block in blocks or []:
        if not isinstance(block, dict) or block.get("type") not in ATTACHMENT_BLOCK_TYPES:
            continue
        key = _attachment_key(block)
        if key in seen:
            continue
        result.append(dict(block))
        seen.add(key)
    return result


def canonical_user_blocks(
    text: str,
    blocks: Optional[list],
    attachments: Optional[list],
) -> List[dict]:
    """Normalize every client generation into the persisted ContentBlock timeline.

    Mobile clients send attachments in ``blocks`` while older clients may use the
    top-level ``attachments`` channel.  Persistence must not depend on which
    transport generation produced the message.
    """
    normalized = merge_user_text_into_blocks(text, blocks)
    existing_attachments = merge_attachment_blocks(None, normalized)
    existing_keys = {_attachment_key(item) for item in existing_attachments}
    for attachment in merge_attachment_blocks(attachments, None):
        key = _attachment_key(attachment)
        if key in existing_keys:
            continue
        normalized.append(attachment)
        existing_keys.add(key)
    return normalized
