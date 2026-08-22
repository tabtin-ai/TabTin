"""
V2 特殊元素模块 P0 回归测试：M02 — _read_binary_source_for_write 本地文件读取防御

使用源码提取方式测试，无需 Django ORM 启动。
"""

from __future__ import annotations

import base64
import os
import re
import tempfile
from pathlib import Path
from unittest import TestCase

_BASE = Path(__file__).resolve().parents[1]
_PPTX_IO_PATH = _BASE / "services" / "pptx_io.py"


def _extract_read_binary_fn():
    """从 pptx_io.py 提取 _read_binary_source_for_write 函数，构造独立可执行环境。"""
    source = _PPTX_IO_PATH.read_text(encoding="utf-8")

    lines = source.splitlines()
    func_lines: list[str] = []
    in_func = False
    for line in lines:
        if line.startswith("def _read_binary_source_for_write("):
            in_func = True
        elif in_func and line and not line[0].isspace() and not line.startswith("#"):
            break
        if in_func:
            func_lines.append(line)

    consts: list[str] = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("MAX_EXPORT_IMAGE_BYTES"):
            consts.append(line)
            break

    stub = (
        "import logging\n"
        "from typing import Optional, Tuple\n"
        "from pathlib import Path\n"
        "logger = logging.getLogger('test')\n"
    )

    env_src = stub + "\n" + "\n".join(consts) + "\n\n" + "\n".join(func_lines)

    ns: dict = {}
    exec(compile(env_src, "<test_m02>", "exec"), ns)
    return ns["_read_binary_source_for_write"]


_read_fn = _extract_read_binary_fn()


class ReadBinarySourceSecurityTests(TestCase):
    """M02: _read_binary_source_for_write 不允许读取本地文件路径。"""

    def test_rejects_absolute_path(self):
        result = _read_fn("/etc/passwd")
        self.assertIsNone(result, "Must reject absolute file paths")

    def test_rejects_relative_path(self):
        result = _read_fn("../../etc/shadow")
        self.assertIsNone(result, "Must reject relative file paths")

    def test_rejects_existing_local_file(self):
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".mp4")
        tmp.write(b"fake video content")
        tmp.close()
        try:
            result = _read_fn(tmp.name)
            self.assertIsNone(result, "Must reject local file paths even if they exist")
        finally:
            os.unlink(tmp.name)

    def test_accepts_data_url(self):
        content = b"test binary data"
        b64 = base64.b64encode(content).decode()
        data_url = f"data:video/mp4;base64,{b64}"
        result = _read_fn(data_url)
        self.assertIsNotNone(result, "Must accept data URLs")
        self.assertEqual(result[0], content)
        self.assertEqual(result[1], "video/mp4")

    def test_rejects_empty_string(self):
        self.assertIsNone(_read_fn(""))

    def test_rejects_non_string(self):
        self.assertIsNone(_read_fn(123))

    def test_rejects_whitespace_only(self):
        self.assertIsNone(_read_fn("   "))

    def test_rejects_windows_path(self):
        result = _read_fn("C:\\Windows\\System32\\config\\sam")
        self.assertIsNone(result, "Must reject Windows-style paths")

    def test_rejects_file_uri(self):
        result = _read_fn("file:///etc/passwd")
        self.assertIsNone(result, "Must reject file:// URIs")

    def test_rejects_home_relative_path(self):
        result = _read_fn("~/secret.key")
        self.assertIsNone(result, "Must reject home-relative paths")

    def test_rejects_dot_path(self):
        result = _read_fn("./local_file.txt")
        self.assertIsNone(result, "Must reject dot-relative paths")


class DocstringSecurityTests(TestCase):
    """验证 _read_binary_source_for_write 的文档注释已更新。"""

    def test_docstring_mentions_security(self):
        doc = _read_fn.__doc__ or ""
        self.assertIn("不允许本地文件路径", doc, "Docstring must mention local path restriction")
