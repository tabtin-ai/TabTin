"""D11 内容 hash 算法测试（PRD V3.3 / W0 决策 4 V2）。

覆盖：
- 行尾归一化（CRLF / 单 CR → LF）
- UTF-8 BOM 剥离
- POSIX 路径分隔符
- ignore 列表（PR ignore + user 场景扩充 11 项）
- Merkle root 跟 PR ``compute_bundle_sha256`` 字面对齐
- 多文件目录确定性（顺序无关）
"""
from __future__ import annotations

import hashlib
import os
import tempfile
from pathlib import Path

import pytest

from apps.skills.services.content_hash import (
    compute_skill_content_hash,
    iter_skill_files,
    _IGNORED_DIRS,
    _IGNORED_FILES,
    _IGNORED_SUFFIXES,
    _is_ignored_filename,
    _normalize_content,
)
from apps.services.package_registry.services import compute_bundle_sha256


class TestNormalize:
    def test_crlf_to_lf(self):
        assert _normalize_content(b"a\r\nb\r\nc") == b"a\nb\nc"

    def test_lone_cr_to_lf(self):
        assert _normalize_content(b"a\rb\rc") == b"a\nb\nc"

    def test_strip_bom(self):
        assert _normalize_content(b"\xef\xbb\xbfhello") == b"hello"

    def test_no_change_pure_lf(self):
        assert _normalize_content(b"a\nb\nc") == b"a\nb\nc"


class TestIgnoredFilename:
    def test_dot_ds_store(self):
        assert _is_ignored_filename(".DS_Store") is True

    def test_vim_swap(self):
        assert _is_ignored_filename(".SKILL.md.swp") is True
        assert _is_ignored_filename(".SKILL.md.swo") is True

    def test_emacs_backup(self):
        assert _is_ignored_filename("SKILL.md~") is True

    def test_emacs_autosave(self):
        assert _is_ignored_filename("#SKILL.md#") is True

    def test_pyc(self):
        assert _is_ignored_filename("foo.pyc") is True

    def test_normal_file_not_ignored(self):
        assert _is_ignored_filename("SKILL.md") is False
        assert _is_ignored_filename("main.py") is False


class TestComputeSkillContentHash:
    def test_empty_dir_stable_hash(self, tmp_path):
        hash1 = compute_skill_content_hash(tmp_path)
        hash2 = compute_skill_content_hash(tmp_path)
        assert hash1 == hash2

    def test_single_file_hash(self, tmp_path):
        (tmp_path / "SKILL.md").write_text("hello\n")
        h = compute_skill_content_hash(tmp_path)
        # 与手算的 Merkle root 对比
        sha = hashlib.sha256(b"hello\n").hexdigest()
        expected = compute_bundle_sha256([("SKILL.md", sha)])
        assert h == expected

    def test_crlf_normalized_same_hash(self, tmp_path):
        (tmp_path / "SKILL.md").write_bytes(b"hello\r\nworld\r\n")
        h1 = compute_skill_content_hash(tmp_path)
        # 不同文件 但内容归一化后相同
        (tmp_path / "SKILL.md").write_bytes(b"hello\nworld\n")
        h2 = compute_skill_content_hash(tmp_path)
        assert h1 == h2

    def test_bom_stripped(self, tmp_path):
        (tmp_path / "SKILL.md").write_bytes(b"\xef\xbb\xbfhello\n")
        h1 = compute_skill_content_hash(tmp_path)
        (tmp_path / "SKILL.md").write_bytes(b"hello\n")
        h2 = compute_skill_content_hash(tmp_path)
        assert h1 == h2

    def test_ignore_swap_files(self, tmp_path):
        (tmp_path / "SKILL.md").write_text("hello\n")
        (tmp_path / ".SKILL.md.swp").write_bytes(b"vim swap")
        (tmp_path / "SKILL.md~").write_bytes(b"emacs backup")
        h_with_garbage = compute_skill_content_hash(tmp_path)

        # 移除垃圾文件后 hash 不变
        (tmp_path / ".SKILL.md.swp").unlink()
        (tmp_path / "SKILL.md~").unlink()
        h_clean = compute_skill_content_hash(tmp_path)
        assert h_with_garbage == h_clean

    def test_ignore_dirs(self, tmp_path):
        (tmp_path / "SKILL.md").write_text("hello\n")
        (tmp_path / ".git").mkdir()
        (tmp_path / ".git" / "HEAD").write_text("ref: refs/heads/main\n")
        (tmp_path / ".vscode").mkdir()
        (tmp_path / ".vscode" / "settings.json").write_text("{}\n")
        h_with_dirs = compute_skill_content_hash(tmp_path)

        # 删掉 ignore 目录后 hash 不变
        import shutil
        shutil.rmtree(tmp_path / ".git")
        shutil.rmtree(tmp_path / ".vscode")
        h_clean = compute_skill_content_hash(tmp_path)
        assert h_with_dirs == h_clean

    def test_path_order_independent(self, tmp_path):
        """文件创建顺序不应影响 hash（按 path 排序后 Merkle）。"""
        (tmp_path / "z.md").write_text("z\n")
        (tmp_path / "a.md").write_text("a\n")
        (tmp_path / "m.md").write_text("m\n")
        h1 = compute_skill_content_hash(tmp_path)

        # 重新创建顺序不同
        import shutil
        shutil.rmtree(tmp_path)
        tmp_path.mkdir()
        (tmp_path / "a.md").write_text("a\n")
        (tmp_path / "m.md").write_text("m\n")
        (tmp_path / "z.md").write_text("z\n")
        h2 = compute_skill_content_hash(tmp_path)
        assert h1 == h2

    def test_subdir_preserved_with_posix_separator(self, tmp_path):
        (tmp_path / "SKILL.md").write_text("hello\n")
        (tmp_path / "scripts").mkdir()
        (tmp_path / "scripts" / "main.py").write_text("print('hi')\n")
        h = compute_skill_content_hash(tmp_path)
        # 期望路径用 POSIX `/` 分隔
        sha_skill = hashlib.sha256(b"hello\n").hexdigest()
        sha_main = hashlib.sha256(b"print('hi')\n").hexdigest()
        expected = compute_bundle_sha256([
            ("SKILL.md", sha_skill),
            ("scripts/main.py", sha_main),
        ])
        assert h == expected
