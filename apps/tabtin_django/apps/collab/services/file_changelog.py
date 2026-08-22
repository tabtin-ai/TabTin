"""
文件级 ChangeLog 批量写入（PRD §4.3.2 / QC-04）。

将 Shadow Git commit 涉及的文件路径批量映射为
``ChangeLog(resource_type='file', resource_id=UUID5(path))``，
使 TabCode vibe coding 场景的代码变更能被 ``conversation-anchors`` API 追溯。

两个入口共用本模块：
- Daemon 路径：``_persist_checkpoint_hash``（后台线程，`changed_files` 由 Daemon 返回）
- Electron 路径：``update_message_checkpoint`` PATCH endpoint（前端驱动，
  `changed_files` 从 ``diff_summary.files[*].file`` 提取）
"""
from __future__ import annotations

import logging
import uuid
from typing import Any, Dict, Iterable, List, Optional
from apps.services.common.db_router import postgres_app_db_alias

logger = logging.getLogger(__name__)

# QC-04 / PRD §4.3.2：文件路径命名空间。
# ⚠️ 与前端 `packages/collab-core/src/version/fileResourceId.ts::FILE_RESOURCE_NAMESPACE`
# 严格保持一致，否则前端 UUID5 查询将永远查不到后端写入的记录。
_FILE_RESOURCE_NAMESPACE = uuid.UUID("33b00000-0000-4000-8000-000000000001")


def file_path_to_resource_id(path: str) -> uuid.UUID:
    """将文件路径稳定映射到 UUID5，供 ChangeLog.resource_id 使用。

    同一仓库内的同一相对路径跨 commit、跨进程都得到同一 UUID，
    `conversation-anchors` 按路径 hash 即可命中所有历史变更。
    """
    return uuid.uuid5(_FILE_RESOURCE_NAMESPACE, (path or "").strip())


def hash_file_path(path: str) -> str:
    """公开 API：返回 UUID 字符串形式，供日志/调试/跨语言使用。"""
    return str(file_path_to_resource_id(path))


def extract_changed_files_from_diff_summary(
    diff_summary: Optional[Dict[str, Any]],
) -> List[str]:
    """从 diff_summary.files[*].file 中提取去重的路径列表。

    Electron 路径下 Daemon 返回的 `changed_files` 通过 HTTP 传进来时不一定
    携带，而 `diff_summary.files` 总是包含精确路径级统计——本函数让
    HTTP 路径能无需额外字段就还原出 `changed_files`。
    """
    if not isinstance(diff_summary, dict):
        return []
    files = diff_summary.get("files") or []
    if not isinstance(files, list):
        return []
    out: List[str] = []
    seen: set[str] = set()
    for entry in files:
        if not isinstance(entry, dict):
            continue
        path = entry.get("file")
        if not isinstance(path, str):
            continue
        path = path.strip()
        if not path or path in seen:
            continue
        seen.add(path)
        out.append(path)
    return out


def record_file_changelogs(
    *,
    changed_files: Iterable[str],
    diff_summary: Optional[Dict[str, Any]],
    commit_hash: str,
    agent_run_id: str,
    session_id: str,
    log_prefix: str = "[FileChangeLog]",
) -> int:
    """对 Shadow Git commit 涉及的文件列表批量写入 file 级 ChangeLog。

    - ``resource_id`` 使用路径的 UUID5（稳定、可跨 commit 查询）
    - 优先从 ``diff_summary.files[*]`` 读取精确的 insertions/deletions 统计
    - ``changes.checkpoint_commit_hash`` 保留 commit 锚点，未来支持按 commit 去重
    - 通过 ``bulk_create(batch_size=200)`` 单次 DB 往返完成批量写入

    Returns:
        实际写入的 ChangeLog 条数（去重后）。空输入 / 异常时返回 0，不抛异常。
    """
    try:
        from apps.collab.models import ChangeLog
    except Exception:
        logger.warning("%s ChangeLog import failed (non-blocking)", log_prefix, exc_info=True)
        return 0

    file_stats_map: Dict[str, Dict[str, Any]] = {}
    if isinstance(diff_summary, dict):
        for entry in (diff_summary.get("files") or []):
            if isinstance(entry, dict) and entry.get("file"):
                file_stats_map[str(entry["file"])] = entry

    entries: list = []
    seen_paths: set[str] = set()
    for raw in changed_files or []:
        if not isinstance(raw, str):
            continue
        path = raw.strip()
        if not path or path in seen_paths:
            continue
        seen_paths.add(path)

        stats = file_stats_map.get(path) or {}
        try:
            insertions = int(stats.get("insertions", 0) or 0)
            deletions = int(stats.get("deletions", 0) or 0)
        except (TypeError, ValueError):
            insertions = 0
            deletions = 0
        binary = bool(stats.get("binary", False))

        entries.append(ChangeLog(
            resource_type="file",
            resource_id=file_path_to_resource_id(path),
            change_type="update",
            summary=path[:500],
            changes={
                "path": path,
                "checkpoint_commit_hash": commit_hash or "",
                "insertions": insertions,
                "deletions": deletions,
                "binary": binary,
            },
            editor_type="agent",
            editor_id="",
            editor_name="",
            agent_run_id=agent_run_id or "",
            session_id=session_id or "",
            version_history=None,
        ))

    if not entries:
        return 0

    try:
        ChangeLog.objects.using(postgres_app_db_alias()).bulk_create(entries, batch_size=200)
    except Exception:
        logger.warning(
            "%s bulk_create failed (non-blocking): count=%d commit=%s",
            log_prefix, len(entries),
            (commit_hash[:8] if commit_hash else "none"),
            exc_info=True,
        )
        return 0

    # Phase C：文件级 ChangeLog 成功写入 → 强证据升格为 code。
    if session_id:
        try:
            from apps.chat.conversation.services.session_surface_policy import (
                promote_session_primary_surface,
            )
            promote_session_primary_surface(session_id, "code")
        except Exception:
            logger.debug(
                "%s primary_surface promote skipped session=%s",
                log_prefix,
                session_id[:8] if session_id else "none",
                exc_info=True,
            )

    logger.info(
        "%s wrote %d file ChangeLogs: commit=%s run=%s session=%s",
        log_prefix, len(entries),
        commit_hash[:8] if commit_hash else "none",
        agent_run_id[:8] if agent_run_id else "none",
        session_id[:8] if session_id else "none",
    )
    return len(entries)
