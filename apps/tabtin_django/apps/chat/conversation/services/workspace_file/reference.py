"""会话工作区本地文件引用的写时索引与查询。"""

from __future__ import annotations

import logging
import re
from typing import Any, Iterable, Optional
from urllib.parse import unquote

from django.db import transaction
from django.utils import timezone

from apps.chat.conversation.models import (
    ChatMessage,
    ChatSession,
    SessionWorkspaceFileReference,
)
from apps.chat.conversation.services.workspace_file.path import (
    basename_of,
    canonicalize_artifact_relative_path,
    is_deliverable_relative_path,
)

logger = logging.getLogger(__name__)

# 全量回填缓存：创建共享 / 预览未命中时最多扫一次历史；写时增量索引不受此影响。
_SWFR_INDEXED_CACHE_TTL_SECONDS = 60 * 60 * 24

_FILE_SCHEME_PREFIX = "tabtin://resource/file/"
_MUTATING_TOOLS = frozenset({"write_file", "edit_file", "create_file", "open_file"})
_DELETE_TOOLS = frozenset({"delete_file"})


def _path_key(canonical: str) -> str:
    return canonical.lower()


def extract_local_file_candidates(
    content_blocks: Any,
) -> list[dict[str, Any]]:
    """从 content_blocks_json 抽取可索引的本地文件候选（未净算）。"""
    if not isinstance(content_blocks, list):
        return []

    ops: list[dict[str, Any]] = []
    for index, block in enumerate(content_blocks):
        if not isinstance(block, dict):
            continue
        block_type = block.get("type") or block.get("block_type")

        if block_type == "tabtin_rich_content" and block.get("kind") == "file":
            payload = block.get("payload") or {}
            if not isinstance(payload, dict):
                continue
            if payload.get("artifact_kind") != "local_file":
                continue
            relative = payload.get("relative_path")
            canonical = canonicalize_artifact_relative_path(str(relative or ""))
            if not canonical or not is_deliverable_relative_path(canonical):
                continue
            ops.append(
                {
                    "relative_path": canonical,
                    "deleted": False,
                    "source_kind": "local_file",
                    "source_block_index": index,
                    "filename": str(payload.get("filename") or basename_of(canonical) or ""),
                    "file_type": str(payload.get("file_type") or ""),
                    "mime_type": str(payload.get("mime_type") or ""),
                    "file_size": (
                        int(payload["file_size"])
                        if isinstance(payload.get("file_size"), int)
                        else None
                    ),
                }
            )
            continue

        if block_type == "tool_use":
            name = str(block.get("name") or block.get("tool_name") or "")
            tool_input = block.get("input") or block.get("arguments") or {}
            if not isinstance(tool_input, dict):
                continue
            raw_path = tool_input.get("path") or tool_input.get("file_path")
            if not raw_path:
                continue
            canonical = canonicalize_artifact_relative_path(str(raw_path))
            if not canonical or not is_deliverable_relative_path(canonical):
                continue
            if name in _DELETE_TOOLS:
                ops.append(
                    {
                        "relative_path": canonical,
                        "deleted": True,
                        "source_kind": "tool_mutation",
                        "source_block_index": index,
                        "filename": basename_of(canonical) or "",
                    }
                )
            elif name in _MUTATING_TOOLS:
                ops.append(
                    {
                        "relative_path": canonical,
                        "deleted": False,
                        "source_kind": "tool_mutation",
                        "source_block_index": index,
                        "filename": basename_of(canonical) or "",
                    }
                )
            continue

        if block_type == "tool_result":
            content = block.get("content")
            parsed = _parse_tool_result_json(content)
            if not parsed:
                continue
            history = parsed.get("file_history") or {}
            if not isinstance(history, dict):
                continue
            for field, deleted in (
                ("created_paths", False),
                ("modified_paths", False),
                ("deleted_paths", True),
            ):
                paths = history.get(field) or []
                if not isinstance(paths, list):
                    continue
                for raw_path in paths:
                    canonical = canonicalize_artifact_relative_path(str(raw_path or ""))
                    if not canonical or not is_deliverable_relative_path(canonical):
                        continue
                    ops.append(
                        {
                            "relative_path": canonical,
                            "deleted": deleted,
                            "source_kind": "shell_history",
                            "source_block_index": index,
                            "filename": basename_of(canonical) or "",
                        }
                    )
            continue

        if block_type in {"text", "markdown"} or (
            block_type is None and isinstance(block.get("text"), str)
        ):
            text = block.get("text") or block.get("content") or ""
            if not isinstance(text, str) or _FILE_SCHEME_PREFIX not in text:
                continue
            for match in re.finditer(
                r"tabtin://resource/file/([^?\s\)\"']+)",
                text,
            ):
                raw = unquote(match.group(1))
                canonical = canonicalize_artifact_relative_path(raw)
                if not canonical or not is_deliverable_relative_path(canonical):
                    continue
                ops.append(
                    {
                        "relative_path": canonical,
                        "deleted": False,
                        "source_kind": "resource_link",
                        "source_block_index": index,
                        "filename": basename_of(canonical) or "",
                    }
                )

    return ops


_APPROVAL_NOTE_CLOSE = "</approval_note>"


def strip_approval_note_prefix(content: str) -> str:
    """剥掉审批回执前缀（对齐前端  ``stripApprovalNotePrefix``）。

    runtime 会在 tool_result.content 前插入
    ``<approval_note>...</approval_note>\\n\\n{payload}``。不剥掉则 JSON
    不以 ``{`` 开头，file_history 索引会漏掉 shell 新建文件。
    """
    if not isinstance(content, str):
        return content
    trimmed = content.lstrip()
    if not trimmed.startswith("<approval_note>"):
        return content
    end = trimmed.find(_APPROVAL_NOTE_CLOSE)
    if end < 0:
        return content
    return trimmed[end + len(_APPROVAL_NOTE_CLOSE) :].lstrip()


def _parse_tool_result_json(content: Any) -> Optional[dict]:
    if isinstance(content, dict):
        return content
    if not isinstance(content, str):
        return None
    text = strip_approval_note_prefix(content).strip()
    if not text.startswith("{"):
        # 兼容少数仍包在 markdown fence 里的历史结果
        if text.startswith("```"):
            lines = text.split("\n")
            if lines and lines[0].startswith("```"):
                lines = lines[1:]
            if lines and lines[-1].strip() == "```":
                lines = lines[:-1]
            text = "\n".join(lines).strip()
        if not text.startswith("{"):
            return None
    try:
        import json

        parsed = json.loads(text)
    except (TypeError, ValueError):
        return None
    return parsed if isinstance(parsed, dict) else None


def force_refresh_workspace_file_refs_index(session: ChatSession) -> bool:
    """预览未命中时强制重扫一次（对抗解析修复前的漏索引）。

    60s 内同一 session 最多强制一次，避免对伪造路径反复全表扫描。
    """
    if session is None:
        return False
    from django.core.cache import cache

    guard_key = f"swfr_force_refresh:{session.id}"
    if cache.get(guard_key):
        return False
    cache.delete(f"swfr_indexed:{session.id}")
    backfill_session_workspace_file_refs(session)
    cache.set(
        f"swfr_indexed:{session.id}",
        "1",
        timeout=_SWFR_INDEXED_CACHE_TTL_SECONDS,
    )
    cache.set(guard_key, "1", timeout=60)
    return True


def surviving_file_ops(ops: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    surviving: dict[str, dict[str, Any]] = {}
    for op in ops:
        path = op.get("relative_path")
        if not path:
            continue
        key = _path_key(str(path))
        if op.get("deleted"):
            surviving.pop(key, None)
            continue
        surviving[key] = op
    return list(surviving.values())


def index_message_workspace_file_refs(message: ChatMessage) -> int:
    """对单条消息做增量索引；返回 upsert/deactivate 触碰条数。"""
    if message is None or not message.session_id:
        return 0
    ops = extract_local_file_candidates(message.content_blocks_json)
    if not ops:
        return 0
    survivors = surviving_file_ops(ops)
    survivor_keys = {_path_key(str(op["relative_path"])) for op in survivors}
    deleted_keys: set[str] = set()
    for op in ops:
        if not op.get("deleted"):
            continue
        canonical = canonicalize_artifact_relative_path(str(op.get("relative_path") or ""))
        if not canonical:
            continue
        key = _path_key(canonical)
        # 同消息「先删后建」：路径若仍在 survivors 中，不得再失效。
        if key not in survivor_keys:
            deleted_keys.add(key)

    touched = 0
    with transaction.atomic():
        for op in survivors:
            canonical = str(op["relative_path"])
            key = _path_key(canonical)
            defaults = {
                "relative_path": canonical,
                "filename": str(op.get("filename") or basename_of(canonical) or ""),
                "source_kind": str(op.get("source_kind") or "local_file"),
                "source_message": message,
                "source_block_index": op.get("source_block_index"),
                "file_type": str(op.get("file_type") or ""),
                "mime_type": str(op.get("mime_type") or ""),
                "file_size": op.get("file_size"),
                "is_active": True,
                "deactivated_at": None,
            }
            SessionWorkspaceFileReference.objects.update_or_create(
                session_id=message.session_id,
                path_key=key,
                defaults=defaults,
            )
            touched += 1

        if deleted_keys:
            updated = SessionWorkspaceFileReference.objects.filter(
                session_id=message.session_id,
                path_key__in=deleted_keys,
                is_active=True,
            ).update(is_active=False, deactivated_at=timezone.now())
            touched += updated
    return touched


def backfill_session_workspace_file_refs(session: ChatSession) -> int:
    """扫描会话历史消息回填索引（共享创建 / 预览兜底）。"""
    if session is None:
        return 0
    messages = (
        ChatMessage.objects.filter(session=session)
        .exclude(content_blocks_json=[])
        .only("id", "session_id", "content_blocks_json")
        .order_by("created_at", "id")
    )
    total = 0
    for message in messages.iterator(chunk_size=100):
        try:
            total += index_message_workspace_file_refs(message)
        except Exception:
            logger.exception(
                "[WorkspaceFileRef] backfill failed session=%s message=%s",
                session.id,
                message.id,
            )
    return total


def ensure_workspace_file_refs_indexed(session: ChatSession) -> int:
    """全量回填最多一次（缓存短路）；写时增量索引不受影响。"""
    if session is None:
        return 0
    from django.core.cache import cache

    cache_key = f"swfr_indexed:{session.id}"
    if cache.get(cache_key):
        return 0
    total = backfill_session_workspace_file_refs(session)
    cache.set(cache_key, "1", timeout=_SWFR_INDEXED_CACHE_TTL_SECONDS)
    return total


def get_active_workspace_file_ref(
    *, session_id, relative_path: str,
) -> Optional[SessionWorkspaceFileReference]:
    canonical = canonicalize_artifact_relative_path(relative_path)
    if not canonical:
        return None
    return SessionWorkspaceFileReference.objects.filter(
        session_id=session_id,
        path_key=_path_key(canonical),
        is_active=True,
    ).first()
