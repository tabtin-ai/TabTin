"""
Wave 5 B2-03 回归测试:
验证 PPTX 导出时 HTTP 图片下载的大小上限常量已定义，
且 _write_image_element / _download_resource_content /
_apply_pattern_fill_image / _write_slide_background_image
使用 MAX_EXPORT_IMAGE_BYTES 限制 resp.read() 大小。
"""

import ast
import inspect
import textwrap
from pathlib import Path
from unittest import TestCase


def _get_source() -> str:
    """读取 pptx_io.py 全文（源码级检查）。"""
    p = Path(__file__).resolve().parent.parent / "services" / "pptx_io.py"
    return p.read_text(encoding="utf-8")


class TestMaxExportImageBytesConstant(TestCase):
    """MAX_EXPORT_IMAGE_BYTES 常量存在且合理。"""

    def test_constant_defined(self):
        src = _get_source()
        self.assertIn("MAX_EXPORT_IMAGE_BYTES", src)

    def test_constant_value_is_positive(self):
        src = _get_source()
        # 源码中应有 "MAX_EXPORT_IMAGE_BYTES = 50 * 1024 * 1024" 或类似
        self.assertRegex(src, r"MAX_EXPORT_IMAGE_BYTES\s*=\s*\d+")


class TestRespReadUsesLimit(TestCase):
    """所有 HTTP 图片下载的 resp.read() 都使用 MAX_EXPORT_IMAGE_BYTES 限制。"""

    def setUp(self):
        self.src = _get_source()

    def _count_unlimited_resp_read(self) -> int:
        """统计 resp.read() 中 **不** 带 MAX_EXPORT_IMAGE_BYTES 参数的调用数量。
        排除字体下载（font 部分没有 OOM 风险因为字体文件通常很小）。"""
        count = 0
        lines = self.src.split("\n")
        for i, line in enumerate(lines):
            stripped = line.strip()
            if "resp.read()" in stripped and "MAX_EXPORT_IMAGE_BYTES" not in stripped:
                # 排除字体下载函数（允许无限制读取）
                context = "\n".join(lines[max(0, i - 30):i + 1])
                if "download font" in context.lower() or "font" in context.lower():
                    continue
                count += 1
        return count

    def test_no_unlimited_resp_read_for_images(self):
        """图片相关的 resp.read() 必须都带 MAX_EXPORT_IMAGE_BYTES 限制。"""
        unlimited = self._count_unlimited_resp_read()
        self.assertEqual(
            unlimited,
            0,
            f"Found {unlimited} unlimited resp.read() calls for image downloads. "
            "All should use resp.read(MAX_EXPORT_IMAGE_BYTES + 1).",
        )

    def test_write_image_element_has_size_check(self):
        """_write_image_element 中的 HTTP 下载路径带有大小校验。"""
        # 找到函数定义到下一个同级 def 之间的范围
        func_start = self.src.find("def _write_image_element(")
        self.assertNotEqual(func_start, -1)
        func_body = self.src[func_start:func_start + 3000]
        self.assertIn("MAX_EXPORT_IMAGE_BYTES", func_body)

    def test_set_slide_background_image_has_size_check(self):
        """_set_slide_background_image 中的 HTTP 下载路径带有大小校验。"""
        func_start = self.src.find("def _set_slide_background_image(")
        self.assertNotEqual(func_start, -1)
        func_body = self.src[func_start:func_start + 3000]
        self.assertIn("MAX_EXPORT_IMAGE_BYTES", func_body)
