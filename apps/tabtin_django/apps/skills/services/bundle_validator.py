"""
Skill 包校验器

从 zip 字节流中安全提取文件，校验：
- zip bomb（压缩比限制）
- 路径穿越（禁止 .. 和绝对路径）
- 文件数量和大小限制
- 文件类型白名单
- 必须包含 SKILL.md
"""

from __future__ import annotations

import io
import logging
import zipfile
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import List

logger = logging.getLogger("skills.bundle_validator")

MAX_FILE_COUNT = 100
MAX_SINGLE_FILE_SIZE = 5 * 1024 * 1024      # 5 MB
MAX_TOTAL_SIZE = 50 * 1024 * 1024            # 50 MB
MAX_COMPRESSION_RATIO = 50                    # 压缩比 > 50 视为 zip bomb

ALLOWED_EXTENSIONS = frozenset({
    ".md", ".py", ".sh", ".js", ".ts", ".json",
    ".yaml", ".yml", ".txt", ".csv", ".html", ".css",
    ".toml", ".cfg", ".ini", ".env.example",
    # Skill 是目录包，assets/ 可携带图标、图片、字体、模板等非文本资源。
    ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico",
    ".ttf", ".otf", ".woff", ".woff2",
    ".pdf", ".docx", ".pptx", ".xlsx",
})

# 非隐藏脏目录；凡路径段以 ``.`` 开头一律跳过（与 Electron ``shouldIgnoreSkillEntryName`` 对齐）。
IGNORED_ENTRY_NAMES = frozenset({
    "node_modules",
    "__pycache__",
})

SKILL_DOC_FILENAME = "SKILL.md"


class BundleValidationError(Exception):
    """Skill 包校验失败"""


@dataclass
class PackageEntry:
    """解压后的单个文件"""
    file_path: str
    content: bytes
    size: int


class SkillBundleValidator:
    """Skill zip 包安全校验与解压"""

    @classmethod
    def validate_and_extract(cls, zip_bytes: bytes) -> List[PackageEntry]:
        """解压 zip，执行全部安全校验，返回文件列表。

        Raises:
            BundleValidationError: 校验不通过
        """
        if not zip_bytes:
            raise BundleValidationError("空文件")

        compressed_size = len(zip_bytes)

        try:
            zf = zipfile.ZipFile(io.BytesIO(zip_bytes))
        except zipfile.BadZipFile:
            raise BundleValidationError("无效的 zip 文件")

        infos = [i for i in zf.infolist() if not i.is_dir()]

        if len(infos) == 0:
            raise BundleValidationError("zip 中没有文件")
        if len(infos) > MAX_FILE_COUNT:
            raise BundleValidationError(
                f"文件数量超限：{len(infos)} > {MAX_FILE_COUNT}"
            )

        # zip bomb 检测：先用 header 中声明的大小快速判断
        declared_total = sum(i.file_size for i in infos)
        if compressed_size > 0 and declared_total / compressed_size > MAX_COMPRESSION_RATIO:
            raise BundleValidationError(
                f"疑似 zip bomb（压缩比 {declared_total / compressed_size:.0f}）"
            )

        entries: List[PackageEntry] = []
        total_size = 0
        has_skill_md = False

        for info in infos:
            path = cls._sanitize_path(info.filename)

            if cls.should_skip_entry(path):
                logger.info("bundle_validator.skip_ignored path=%s", path)
                continue

            cls._check_extension(path)

            if info.file_size > MAX_SINGLE_FILE_SIZE:
                raise BundleValidationError(
                    f"文件 {path} 过大：{info.file_size} > {MAX_SINGLE_FILE_SIZE}"
                )

            data = zf.read(info.filename)
            actual_size = len(data)

            if actual_size > MAX_SINGLE_FILE_SIZE:
                raise BundleValidationError(
                    f"文件 {path} 实际解压大小过大：{actual_size}"
                )

            total_size += actual_size
            if total_size > MAX_TOTAL_SIZE:
                raise BundleValidationError(
                    f"总大小超限：{total_size} > {MAX_TOTAL_SIZE}"
                )

            if PurePosixPath(path).name == SKILL_DOC_FILENAME:
                has_skill_md = True

            entries.append(PackageEntry(
                file_path=path,
                content=data,
                size=actual_size,
            ))

        if not has_skill_md:
            raise BundleValidationError("缺少 SKILL.md 文件")

        logger.info(
            "bundle_validator.ok files=%d total_size=%d",
            len(entries), total_size,
        )
        return entries

    @staticmethod
    def _sanitize_path(raw_path: str) -> str:
        """规范化路径并检查穿越攻击"""
        normalized = PurePosixPath(raw_path)

        if normalized.is_absolute():
            raise BundleValidationError(f"禁止绝对路径：{raw_path}")

        parts = normalized.parts
        if ".." in parts:
            raise BundleValidationError(f"禁止路径穿越：{raw_path}")

        # 去掉可能的单层根目录包装（如 my-skill/SKILL.md → SKILL.md）
        if len(parts) > 1:
            first_part_looks_like_root = all(
                PurePosixPath(p).parts[0] == parts[0]
                for p in [raw_path]
            )
            if first_part_looks_like_root:
                pass  # 保留原始结构，不自动剥离

        return str(normalized)

    @staticmethod
    def should_skip_entry(path: str) -> bool:
        """跳过隐藏路径段（``.*``）以及依赖/缓存目录。

        任一段以 ``.`` 开头即跳过，避免 ``.gitignore`` / ``.eslintrc.js`` 等
        误触扩展名白名单导致整包失败。publish files 入口与 zip 校验共用此规则。
        """
        parts = PurePosixPath(path).parts
        return any(
            part.startswith(".") or part in IGNORED_ENTRY_NAMES
            for part in parts
        )

    @staticmethod
    def _check_extension(path: str) -> None:
        """检查文件扩展名是否在白名单中"""
        p = PurePosixPath(path)
        name = p.name

        # 无扩展名的特殊文件（Makefile, Dockerfile 等）
        if "." not in name:
            return

        suffix = p.suffix.lower()
        if suffix not in ALLOWED_EXTENSIONS:
            raise BundleValidationError(
                f"不允许的文件类型 {suffix}：{path}"
            )


__all__ = [
    "SkillBundleValidator",
    "BundleValidationError",
    "PackageEntry",
    "IGNORED_ENTRY_NAMES",
]
