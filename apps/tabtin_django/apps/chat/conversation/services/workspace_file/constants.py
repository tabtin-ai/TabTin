"""共享会话本地文件预览契约常量。

跨端对齐约定（改数值前先改这里，再同步 Electron）：
- Electron: ``apps/tabtin-electron/src/shared/session-share-preview-contract.ts``
- 路径规范化：本包 ``path.py`` ↔ 前端 ``turnArtifactPathOps.ts``
"""

from __future__ import annotations

from datetime import timedelta

# 物化硬顶：Django / Electron main / Dialog 必须一致。
MAX_MATERIALIZE_BYTES = 50 * 1024 * 1024
# OSS GET/PUT signed URL 有效期（秒）。
SIGNED_URL_TTL_SECONDS = 15 * 60
# 服务端快照记录可复用窗口。
SNAPSHOT_TTL = timedelta(minutes=30)

SHARED_PREVIEW_DENIED = "共享会话不存在或无权查看"
# 有 share / owner 权限，但路径未进入写时索引（与「无权」区分，避免误导）。
SHARED_PREVIEW_NOT_INDEXED = "该文件未纳入共享预览索引，无法预览"
SHARED_PREVIEW_INVALID_PATH = "文件路径无效，无法预览"
SHARED_PREVIEW_TOO_LARGE = (
    f"文件过大，超过预览上限 {MAX_MATERIALIZE_BYTES // (1024 * 1024)}MB"
)

# preview_kind 枚举（API / Dialog / materialize 共用字符串）。
PREVIEW_KIND_TEXT = "text"
PREVIEW_KIND_IMAGE = "image"
PREVIEW_KIND_PDF = "pdf"
PREVIEW_KIND_VIDEO = "video"
PREVIEW_KIND_AUDIO = "audio"
PREVIEW_KIND_BINARY = "binary"
PREVIEW_KIND_DOC = "doc"
PREVIEW_KIND_DOCX = "docx"
PREVIEW_KIND_XLSX = "xlsx"
PREVIEW_KIND_PPTX = "pptx"

INLINE_PREVIEW_KINDS = frozenset({PREVIEW_KIND_TEXT, PREVIEW_KIND_IMAGE})

INLINE_IMAGE_EXTENSIONS = frozenset({
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg",
})
TEXT_EXTENSIONS = frozenset({
    ".txt", ".md", ".markdown", ".json", ".jsonl", ".yaml", ".yml",
    ".toml", ".ini", ".cfg", ".conf", ".env", ".xml", ".html", ".htm",
    ".css", ".scss", ".less", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
    ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift", ".c", ".cc",
    ".cpp", ".h", ".hpp", ".cs", ".php", ".sh", ".bash", ".zsh", ".sql",
    ".csv", ".tsv", ".log",
})
OFFICE_EXTENSIONS = {
    ".doc": PREVIEW_KIND_DOC,
    ".docx": PREVIEW_KIND_DOCX,
    ".xlsx": PREVIEW_KIND_XLSX,
    ".pptx": PREVIEW_KIND_PPTX,
}
VIDEO_EXTENSIONS = frozenset({".mp4", ".webm", ".mkv", ".avi", ".mov"})
AUDIO_EXTENSIONS = frozenset({".mp3", ".wav", ".ogg", ".flac", ".aac", ".m4a"})

DEVICE_HARD_ERROR_CODES = frozenset({
    "DEVICE_RUNTIME_OFFLINE",
    "DEVICE_RUNTIME_UNAVAILABLE",
    "TASK_TIMEOUT",
    "DEVICE_ACTION_DELIVERY_FAILED",
    "WORKING_DIR_NOT_SET",
    # 设备侧路径/IO 错误：再走物化只会换错误码并多两次往返。
    "PATH_DENIED",
    "EISDIR",
    "FS_ERROR",
    "INVALID_REQUEST",
})
