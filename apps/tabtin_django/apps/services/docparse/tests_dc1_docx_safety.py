"""
DC-1 测试：DOCX 导入 zip-bomb 防护 + 文件大小限制

覆盖:
- 超大文件拒绝（>50 MB）
- zip-bomb 检测（解压比 >50:1）
- 解压后总体积超限（>200 MB）
- 非法 ZIP 格式拒绝
- 正常 DOCX 正常通过
"""
from __future__ import annotations

import os
import tempfile
import unittest
import zipfile

from apps.services.docparse.parsers.docx_parser import (
    MAX_DOCX_COMPRESSION_RATIO,
    MAX_DOCX_FILE_SIZE,
    MAX_DOCX_UNCOMPRESSED_SIZE,
    _validate_docx_safe,
)


def _make_minimal_docx(tmp_dir: str, filename: str = "test.docx") -> str:
    """构造一个最简 DOCX（合法 ZIP，含 [Content_Types].xml）用于测试。"""
    path = os.path.join(tmp_dir, filename)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            "</Types>",
        )
    return path


class ValidateDocxSafeTests(unittest.TestCase):
    """_validate_docx_safe 安全校验单元测试"""

    def test_normal_docx_passes(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = _make_minimal_docx(tmp)
            _validate_docx_safe(path)

    def test_file_too_large(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = _make_minimal_docx(tmp, "big.docx")
            with open(path, "r+b") as f:
                f.seek(MAX_DOCX_FILE_SIZE + 1)
                f.write(b"\x00")
            self.assertGreater(os.path.getsize(path), MAX_DOCX_FILE_SIZE)
            with self.assertRaises(ValueError) as ctx:
                _validate_docx_safe(path)
            self.assertIn("文件过大", str(ctx.exception))

    def test_not_a_zip(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "fake.docx")
            with open(path, "wb") as f:
                f.write(b"This is not a ZIP file at all")
            with self.assertRaises(ValueError) as ctx:
                _validate_docx_safe(path)
            message = str(ctx.exception)
            self.assertTrue(
                "无法识别" in message or "不是有效的 DOCX/ZIP" in message,
                msg=message,
            )

    def test_zip_bomb_high_ratio(self):
        """构造高压缩比 ZIP（大量零字节），触发 ratio 检查。"""
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "bomb.docx")
            with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
                zf.writestr("[Content_Types].xml", "<Types/>")
                zeros = b"\x00" * (5 * 1024 * 1024)
                zf.writestr("word/bomb.xml", zeros.decode("latin-1"))

            file_size = os.path.getsize(path)
            with zipfile.ZipFile(path, "r") as zf:
                total_uncompressed = sum(i.file_size for i in zf.infolist())

            ratio = total_uncompressed / file_size if file_size > 0 else 0
            if ratio <= MAX_DOCX_COMPRESSION_RATIO:
                self.skipTest(
                    f"构造的 ZIP ratio ({ratio:.0f}:1) 未超过阈值，跳过"
                )

            with self.assertRaises(ValueError) as ctx:
                _validate_docx_safe(path)
            self.assertIn("zip-bomb", str(ctx.exception))

    def test_decompressed_size_too_large(self):
        """通过伪造 ZipInfo.file_size 模拟解压体积超限。"""
        from unittest.mock import patch, MagicMock

        with tempfile.TemporaryDirectory() as tmp:
            path = _make_minimal_docx(tmp, "huge_uncompressed.docx")

            fake_info = MagicMock()
            fake_info.file_size = MAX_DOCX_UNCOMPRESSED_SIZE + 1

            with patch("zipfile.ZipFile.infolist", return_value=[fake_info]):
                with self.assertRaises(ValueError) as ctx:
                    _validate_docx_safe(path)
                self.assertIn("解压后体积过大", str(ctx.exception))
