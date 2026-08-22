"""D11 Skill 内容 hash 算法（PRD V3.3 / W0 决策 4 V2）。

算法定义：

1. 扫描 skill 目录，递归收集所有非 ignore 文件
2. 对每个文件按规范化内容算 SHA-256
3. 用 PR ``compute_bundle_sha256`` 算法计算 Merkle root：把
   ``[(relpath, sha256), ...]`` 按 path 排序后整体 SHA-256

规范化内容（W0 决策 4 V2）：
- 行尾统一为 LF（剥离 CRLF / CR）
- 剥离 UTF-8 BOM
- 文件路径用 POSIX 分隔符（避免 Windows 反斜杠）

Ignore 列表（W0 决策 4 V2 = PR client + user 场景扩充 11 项）：
- 复用 PR：__pycache__ / .git / node_modules / .tox / .mypy_cache /
  .pytest_cache / .eggs / dist / build / .DS_Store / Thumbs.db / .gitkeep /
  .pyc / .pyo / .egg-info / .so / .dylib
- user 场景扩充：.idea / .vscode / .cursor / .history / .fseventsd /
  .Spotlight-V100 / .Trashes / .Trash / desktop.ini / Icon\\r /
  .swp / .swo / .swn / ~（emacs backup） / #*# pattern

TS 端镜像实现见 ``packages/terminal-core/src/skill-content-hash.ts``，必须字面对齐。
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import Iterable, Optional, Tuple


_IGNORED_DIRS = frozenset({
    "__pycache__", ".git", "node_modules", ".tox", ".mypy_cache",
    ".pytest_cache", ".eggs", "dist", "build",
    ".idea", ".vscode", ".cursor", ".history",
    ".fseventsd", ".Spotlight-V100", ".Trashes", ".Trash",
})

_IGNORED_FILES = frozenset({
    ".DS_Store", "Thumbs.db", ".gitkeep",
    "desktop.ini", "Icon\r",
})

_IGNORED_SUFFIXES = (
    ".pyc", ".pyo", ".egg-info", ".so", ".dylib",
    ".swp", ".swo", ".swn",
    "~",
)

# 注意：emacs autosave 形如 #FILE# — 不能用 endswith(~) 兜，需要单独判断。


def _is_ignored_filename(name: str) -> bool:
    """判断单个文件名是否应被 ignore。"""
    if name in _IGNORED_FILES:
        return True
    if name.startswith("#") and name.endswith("#") and len(name) > 2:
        # emacs autosave: #FILE#
        return True
    for suffix in _IGNORED_SUFFIXES:
        if name.endswith(suffix):
            return True
    return False


def _normalize_content(raw: bytes) -> bytes:
    """规范化文件内容（D11 软保护准确性必需）。

    - 剥离 UTF-8 BOM（首 3 字节 \\xef\\xbb\\xbf）
    - 行尾统一为 LF（CRLF → LF，单 CR → LF）

    二进制文件：BOM 检查无害；行尾归一化对二进制可能造成 hash 不稳定，
    但 skill 目录里的二进制（图片 / 音频）通常不含 \\r\\n 序列，影响可忽略。
    """
    # 剥 BOM
    if raw.startswith(b"\xef\xbb\xbf"):
        raw = raw[3:]
    # CRLF → LF；剩余的孤立 CR → LF
    raw = raw.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    return raw


def _hash_file(path: Path) -> str:
    """计算单个文件的规范化 SHA-256（hex）。"""
    raw = path.read_bytes()
    return hashlib.sha256(_normalize_content(raw)).hexdigest()


def iter_skill_files(skill_dir: Path) -> Iterable[Tuple[str, Path]]:
    """递归遍历 skill 目录，返回 [(posix_relpath, abs_path), ...]，过滤 ignore 项。"""
    if not skill_dir.is_dir():
        return
    for root, dirs, files in os.walk(skill_dir):
        # 原地裁剪 dirs 阻止下钻 ignore 目录
        dirs[:] = [d for d in dirs if d not in _IGNORED_DIRS]
        root_path = Path(root)
        for fname in files:
            if _is_ignored_filename(fname):
                continue
            fpath = root_path / fname
            try:
                rel = fpath.relative_to(skill_dir)
            except ValueError:
                continue
            posix_rel = "/".join(rel.parts)
            yield posix_rel, fpath


def compute_skill_content_hash(skill_dir: Path | str) -> str:
    """计算 skill 目录的内容 hash。

    返回 hex SHA-256 字符串（与 PR ``compute_bundle_sha256`` 字面对齐）。
    """
    p = Path(skill_dir)
    entries: list[Tuple[str, str]] = []
    for posix_rel, fpath in iter_skill_files(p):
        try:
            file_sha = _hash_file(fpath)
        except OSError:
            # 不可读文件忽略（如临时锁文件）— 与 ignore 列表语义一致
            continue
        entries.append((posix_rel, file_sha))

    return _merkle_root(entries)


def _merkle_root(entries: list[Tuple[str, str]]) -> str:
    """Merkle root 第二层 SHA-256（与 PR ``compute_bundle_sha256`` 完全对齐）。"""
    sorted_entries = sorted(entries, key=lambda x: x[0])
    hasher = hashlib.sha256()
    for path, sha256 in sorted_entries:
        hasher.update(f"{path}:{sha256}".encode())
    return hasher.hexdigest()


__all__ = [
    "compute_skill_content_hash",
    "iter_skill_files",
]
