"""Package Registry 公共工具函数。

W4-修3:``CONTENT_TYPE_MAP`` 抽到模块级常量,作为 single source of truth。
后端 / Python CLI / Go CLI 都通过此映射(Go CLI 通过 ``/utils/content-types``
端点拉取)推断 MIME。新增扩展只改这里。
"""

from __future__ import annotations

from pathlib import Path


# Single source of truth — 服务端 + 客户端共用这一份映射。
# 新增扩展请在此处添加,Go CLI / Python CLI 自动同步。
CONTENT_TYPE_MAP: dict[str, str] = {
    ".py": "text/x-python",
    ".js": "application/javascript",
    ".mjs": "application/javascript",
    ".ts": "application/typescript",
    ".json": "application/json",
    ".md": "text/markdown",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
    ".txt": "text/plain",
    ".html": "text/html",
    ".css": "text/css",
    ".toml": "application/toml",
    ".sh": "application/x-sh",
    ".csv": "text/csv",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".zip": "application/zip",
}

CONTENT_TYPE_DEFAULT = "application/octet-stream"


def guess_content_type(filename: str) -> str:
    """根据文件扩展名推断 MIME content-type（统一映射表）。"""
    ext = Path(filename).suffix.lower()
    return CONTENT_TYPE_MAP.get(ext, CONTENT_TYPE_DEFAULT)
