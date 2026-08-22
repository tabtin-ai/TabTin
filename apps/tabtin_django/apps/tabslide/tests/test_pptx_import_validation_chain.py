"""
IE-011 / IE-012 / IE-013 回归测试

- IE-011: validate_pptx_file 校验 ZIP magic bytes + [Content_Types].xml
- IE-012: 导入页面 ID 为 UUID 格式，不同导入不冲突
- IE-013: read_all 单次 Presentation 初始化，输出等价于 read + theme 系列
"""

import importlib.util
import os
import re
import tempfile
from pathlib import Path
from unittest import TestCase

_MODULE_PATH = Path(__file__).resolve().parents[1] / "services" / "pptx_io.py"
_SPEC = importlib.util.spec_from_file_location("tabslide_pptx_io_import_validation", _MODULE_PATH)
if _SPEC is None or _SPEC.loader is None:
    raise RuntimeError(f"Failed to load module spec from {_MODULE_PATH}")
_PPTX_IO = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_PPTX_IO)

validate_pptx_file = _PPTX_IO.validate_pptx_file
InvalidPptxError = _PPTX_IO.InvalidPptxError
read = _PPTX_IO.read
read_all = _PPTX_IO.read_all
write = _PPTX_IO.write


def _make_valid_pptx(num_slides: int = 2) -> str:
    """构造一个包含指定页数的合法 PPTX 临时文件。"""
    pages = []
    for i in range(num_slides):
        pages.append({
            "id": f"tmp-{i}",
            "elements": [{
                "id": f"el-{i}",
                "type": "text",
                "x": 100,
                "y": 100,
                "width": 400,
                "height": 200,
                "zIndex": 0,
                "props": {"content": f"<p>Slide {i + 1}</p>"},
            }],
            "background": {"type": "color", "value": "#ffffff"},
        })
    fd, path = tempfile.mkstemp(suffix=".pptx")
    os.close(fd)
    write(pages=pages, output_path=path, canvas_width=1920, canvas_height=1080)
    return path


class TestValidatePptxFile(TestCase):
    """IE-011: PPTX 文件格式校验。"""

    def test_valid_pptx_passes(self):
        path = _make_valid_pptx()
        try:
            validate_pptx_file(path)
        finally:
            os.unlink(path)

    def test_random_bytes_rejected(self):
        fd, path = tempfile.mkstemp(suffix=".pptx")
        os.write(fd, b"this is not a zip file at all")
        os.close(fd)
        try:
            with self.assertRaises(InvalidPptxError) as ctx:
                validate_pptx_file(path)
            self.assertIn("ZIP", str(ctx.exception))
        finally:
            os.unlink(path)

    def test_zip_without_content_types_rejected(self):
        import zipfile
        fd, path = tempfile.mkstemp(suffix=".pptx")
        os.close(fd)
        try:
            with zipfile.ZipFile(path, "w") as zf:
                zf.writestr("dummy.txt", "hello")
            with self.assertRaises(InvalidPptxError) as ctx:
                validate_pptx_file(path)
            self.assertIn("Content_Types", str(ctx.exception))
        finally:
            os.unlink(path)

    def test_empty_file_rejected(self):
        fd, path = tempfile.mkstemp(suffix=".pptx")
        os.close(fd)
        try:
            with self.assertRaises(InvalidPptxError):
                validate_pptx_file(path)
        finally:
            os.unlink(path)


_PAGE_ID_RE = re.compile(r"^page-[0-9a-f]{12}$")


class TestPageIdUuid(TestCase):
    """IE-012: 导入页面 ID 使用 UUID 格式。"""

    def test_page_ids_are_uuid_format(self):
        path = _make_valid_pptx(num_slides=3)
        try:
            pages = read(path)
            for page in pages:
                self.assertRegex(
                    page["id"],
                    _PAGE_ID_RE,
                    f"Page ID '{page['id']}' 不符合 UUID 格式 page-{{hex12}}",
                )
        finally:
            os.unlink(path)

    def test_page_ids_unique_across_imports(self):
        path = _make_valid_pptx(num_slides=2)
        try:
            pages_a = read(path)
            pages_b = read(path)
            ids_a = {p["id"] for p in pages_a}
            ids_b = {p["id"] for p in pages_b}
            self.assertTrue(
                ids_a.isdisjoint(ids_b),
                f"两次导入产生了相同的 page ID: {ids_a & ids_b}",
            )
        finally:
            os.unlink(path)


class TestReadAll(TestCase):
    """IE-013: read_all 单次初始化，输出等价于分开调用。"""

    def test_read_all_returns_pages_and_theme(self):
        path = _make_valid_pptx(num_slides=2)
        try:
            result = read_all(path)
            self.assertIn("pages", result)
            self.assertIn("theme_fonts", result)
            self.assertIn("theme_payload", result)
            self.assertEqual(len(result["pages"]), 2)
            self.assertIsInstance(result["theme_fonts"], dict)
            self.assertIsInstance(result["theme_payload"], dict)
        finally:
            os.unlink(path)

    def test_read_all_page_count_matches_read(self):
        path = _make_valid_pptx(num_slides=3)
        try:
            pages_separate = read(path)
            result_all = read_all(path)
            self.assertEqual(len(pages_separate), len(result_all["pages"]))
        finally:
            os.unlink(path)

    def test_read_all_elements_preserved(self):
        path = _make_valid_pptx(num_slides=1)
        try:
            result = read_all(path)
            page = result["pages"][0]
            self.assertTrue(len(page["elements"]) > 0, "read_all 应保留元素")
        finally:
            os.unlink(path)
