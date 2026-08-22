"""会话工作区本地文件：写时索引 + SessionShare 窄预览。

对外从此包导入：``from apps.chat.conversation.services.workspace_file import ...``
"""

from apps.chat.conversation.services.workspace_file.constants import (
    MAX_MATERIALIZE_BYTES,
    SIGNED_URL_TTL_SECONDS,
    SNAPSHOT_TTL,
)
from apps.chat.conversation.services.workspace_file.path import (
    basename_of,
    canonicalize_artifact_relative_path,
    is_deliverable_relative_path,
)
from apps.chat.conversation.services.workspace_file.preview import (
    WorkspaceFilePreviewService,
    guess_preview_kind,
    prefers_inline_preview,
    revoke_session_workspace_file_snapshots,
)
from apps.chat.conversation.services.workspace_file.reference import (
    backfill_session_workspace_file_refs,
    ensure_workspace_file_refs_indexed,
    extract_local_file_candidates,
    force_refresh_workspace_file_refs_index,
    get_active_workspace_file_ref,
    index_message_workspace_file_refs,
    strip_approval_note_prefix,
    surviving_file_ops,
)

__all__ = [
    "MAX_MATERIALIZE_BYTES",
    "SIGNED_URL_TTL_SECONDS",
    "SNAPSHOT_TTL",
    "basename_of",
    "canonicalize_artifact_relative_path",
    "is_deliverable_relative_path",
    "WorkspaceFilePreviewService",
    "guess_preview_kind",
    "prefers_inline_preview",
    "revoke_session_workspace_file_snapshots",
    "backfill_session_workspace_file_refs",
    "ensure_workspace_file_refs_indexed",
    "extract_local_file_candidates",
    "force_refresh_workspace_file_refs_index",
    "get_active_workspace_file_ref",
    "index_message_workspace_file_refs",
    "strip_approval_note_prefix",
    "surviving_file_ops",
]
