"""
PPTX-ZIPBOMB 测试：PPTX 导入 zip-bomb 防护 + 文件大小限制 + 条目数限制

覆盖:
- 超大文件拒绝（>200 MB）
- zip-bomb 检测（解压比 >100:1）
- ZIP 条目数超限（>10000）
- 非法 ZIP 格式拒绝
- 正常 PPTX 正常通过
"""
from __future__ import annotations

import os
import tempfile
import unittest
import zipfile

from apps.services.docparse.parsers.pptx_parser import (
    MAX_PPTX_COMPRESSION_RATIO,
    MAX_PPTX_FILE_SIZE,
    MAX_PPTX_UNCOMPRESSED_SIZE,
    MAX_PPTX_ZIP_ENTRIES,
    _validate_pptx_safe,
)


def _make_minimal_pptx(tmp_dir: str, filename: str = "test.pptx") -> str:
    """构造一个最简 PPTX（合法 ZIP，含 [Content_Types].xml）用于测试。"""
    path = os.path.join(tmp_dir, filename)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            "</Types>",
        )
    return path


class ValidatePptxSafeTests(unittest.TestCase):
    """_validate_pptx_safe 安全校验单元测试"""

    def test_normal_pptx_passes(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = _make_minimal_pptx(tmp)
            _validate_pptx_safe(path)

    def test_file_too_large(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = _make_minimal_pptx(tmp, "big.pptx")
            with open(path, "r+b") as f:
                f.seek(MAX_PPTX_FILE_SIZE + 1)
                f.write(b"\x00")
            self.assertGreater(os.path.getsize(path), MAX_PPTX_FILE_SIZE)
            with self.assertRaises(ValueError) as ctx:
                _validate_pptx_safe(path)
            self.assertIn("文件过大", str(ctx.exception))

    def test_not_a_zip(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "fake.pptx")
            with open(path, "wb") as f:
                f.write(b"This is not a ZIP file at all")
            with self.assertRaises(ValueError) as ctx:
                _validate_pptx_safe(path)
            self.assertIn("不是有效的 PPTX/ZIP 格式", str(ctx.exception))

    def test_zip_bomb_high_ratio(self):
        """构造高压缩比 ZIP（大量零字节），触发 ratio 检查。"""
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "bomb.pptx")
            with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
                zf.writestr("[Content_Types].xml", "<Types/>")
                zeros = b"\x00" * (10 * 1024 * 1024)
                zf.writestr("ppt/bomb.xml", zeros.decode("latin-1"))

            file_size = os.path.getsize(path)
            with zipfile.ZipFile(path, "r") as zf:
                total_uncompressed = sum(i.file_size for i in zf.infolist())

            ratio = total_uncompressed / file_size if file_size > 0 else 0
            if ratio <= MAX_PPTX_COMPRESSION_RATIO:
                self.skipTest(
                    f"构造的 ZIP ratio ({ratio:.0f}:1) 未超过阈值，跳过"
                )

            with self.assertRaises(ValueError) as ctx:
                _validate_pptx_safe(path)
            self.assertIn("zip-bomb", str(ctx.exception))

    def test_too_many_zip_entries(self):
        """通过 mock infolist 模拟条目数超限。"""
        from unittest.mock import patch, MagicMock

        with tempfile.TemporaryDirectory() as tmp:
            path = _make_minimal_pptx(tmp, "many_entries.pptx")

            fake_entries = [MagicMock(file_size=100) for _ in range(MAX_PPTX_ZIP_ENTRIES + 1)]

            with patch("zipfile.ZipFile.infolist", return_value=fake_entries):
                with self.assertRaises(ValueError) as ctx:
                    _validate_pptx_safe(path)
                self.assertIn("条目数过多", str(ctx.exception))

    def test_decompressed_size_too_large(self):
        """通过伪造 ZipInfo.file_size 模拟解压体积超限。"""
        from unittest.mock import patch, MagicMock

        with tempfile.TemporaryDirectory() as tmp:
            path = _make_minimal_pptx(tmp, "huge_uncompressed.pptx")

            fake_info = MagicMock()
            fake_info.file_size = MAX_PPTX_UNCOMPRESSED_SIZE + 1

            with patch("zipfile.ZipFile.infolist", return_value=[fake_info]):
                with self.assertRaises(ValueError) as ctx:
                    _validate_pptx_safe(path)
                self.assertIn("解压后体积过大", str(ctx.exception))
