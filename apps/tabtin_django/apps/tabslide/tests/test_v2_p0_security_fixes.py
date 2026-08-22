"""
V2 P0 安全修复回归测试：I4-01 / I4-02 / I4-03 / I5-01

- I4-01: ZIP Slip 路径穿越
- I4-02: Y.js-first 路径 XSS sanitize 绕过（通过 sanitize 函数回归验证）
- I4-03: template_fill XML 注入
- I5-01: preview text content 未转义

使用 importlib 直接加载模块，无需 Django ORM 启动。
"""

from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import types
import zipfile
from pathlib import Path
from unittest import TestCase

_BASE = Path(__file__).resolve().parents[1]


def _load_module(name: str, path: Path) -> types.ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load {path}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


_unpack_mod = _load_module(
    "tabslide_unpack_test", _BASE / "services" / "editing" / "unpack.py"
)
_template_fill_mod = _load_module(
    "tabslide_template_fill_test", _BASE / "services" / "editing" / "template_fill.py"
)
_preview_mod = _load_module(
    "tabslide_preview_test", _BASE / "services" / "preview_service.py"
)


# ============================================================================
# I4-01: ZIP Slip
# ============================================================================


class ZipSlipProtectionTests(TestCase):
    """unpack() 必须拒绝 ZIP 条目中包含路径穿越 (../) 的文件。"""

    unpack = staticmethod(_unpack_mod.unpack)

    def _make_zip_with_entry(self, entry_name: str, content: bytes = b"pwned") -> str:
        tmp = tempfile.NamedTemporaryFile(suffix=".pptx", delete=False)
        with zipfile.ZipFile(tmp, "w") as zf:
            zf.writestr(entry_name, content)
        tmp.close()
        return tmp.name

    def test_reject_dotdot_traversal(self):
        zip_path = self._make_zip_with_entry("../../etc/passwd")
        out_dir = tempfile.mkdtemp()
        try:
            with self.assertRaises(ValueError) as ctx:
                self.unpack(zip_path, out_dir, pretty=False)
            self.assertIn("traversal", str(ctx.exception).lower())
        finally:
            os.unlink(zip_path)
            os.rmdir(out_dir)

    def test_reject_absolute_path(self):
        zip_path = self._make_zip_with_entry("/tmp/evil.txt")
        out_dir = tempfile.mkdtemp()
        try:
            with self.assertRaises(ValueError) as ctx:
                self.unpack(zip_path, out_dir, pretty=False)
            self.assertIn("traversal", str(ctx.exception).lower())
        finally:
            os.unlink(zip_path)
            os.rmdir(out_dir)

    def test_safe_entry_allowed(self):
        zip_path = self._make_zip_with_entry("ppt/slides/slide1.xml", b"<p:sld/>")
        out_dir = tempfile.mkdtemp()
        try:
            result = self.unpack(zip_path, out_dir, pretty=False)
            self.assertEqual(result["total_files"], 1)
            target = os.path.join(out_dir, "ppt", "slides", "slide1.xml")
            self.assertTrue(os.path.exists(target))
        finally:
            os.unlink(zip_path)
            import shutil
            shutil.rmtree(out_dir, ignore_errors=True)

    def test_dotdot_in_middle_blocked(self):
        zip_path = self._make_zip_with_entry("ppt/slides/../../../evil.xml")
        out_dir = tempfile.mkdtemp()
        try:
            with self.assertRaises(ValueError):
                self.unpack(zip_path, out_dir, pretty=False)
        finally:
            os.unlink(zip_path)
            import shutil
            shutil.rmtree(out_dir, ignore_errors=True)

    def test_nested_safe_entry(self):
        zip_path = self._make_zip_with_entry(
            "ppt/slides/sub/slide2.xml", b"<p:sld/>"
        )
        out_dir = tempfile.mkdtemp()
        try:
            result = self.unpack(zip_path, out_dir, pretty=False)
            self.assertEqual(result["total_files"], 1)
        finally:
            os.unlink(zip_path)
            import shutil
            shutil.rmtree(out_dir, ignore_errors=True)


# ============================================================================
# I4-02: sanitize 函数回归（通过 preview 的 _sanitize_rich_html 验证逻辑一致性）
# ============================================================================


class SanitizeRichHtmlTests(TestCase):
    """_sanitize_content_html 必须去除 script/iframe/事件处理器/危险 URI。"""

    sanitize = staticmethod(_preview_mod._sanitize_content_html)

    def test_script_tag_stripped(self):
        result = self.sanitize('<p>Hello</p><script>alert(1)</script>')
        self.assertNotIn("<script>", result)
        self.assertIn("Hello", result)

    def test_multiline_script_stripped(self):
        result = self.sanitize('<script type="text/javascript">\nalert(1);\n</script>')
        self.assertNotIn("<script", result)
        self.assertNotIn("alert", result)

    def test_iframe_stripped(self):
        result = self.sanitize('<iframe src="https://evil.com"></iframe>')
        self.assertNotIn("<iframe", result)

    def test_self_closing_iframe_stripped(self):
        result = self.sanitize('<iframe src="https://evil.com"/>')
        self.assertNotIn("<iframe", result)

    def test_object_embed_stripped(self):
        result = self.sanitize('<object data="evil.swf"></object><embed src="evil.swf"/>')
        self.assertNotIn("<object", result)
        self.assertNotIn("<embed", result)

    def test_event_handler_stripped(self):
        result = self.sanitize('<p onmouseover="alert(1)">X</p>')
        self.assertNotIn("onmouseover", result)
        self.assertIn("X", result)

    def test_onerror_stripped(self):
        result = self.sanitize('<img src=x onerror="alert(1)">')
        self.assertNotIn("onerror", result)

    def test_javascript_uri_double_quote(self):
        result = self.sanitize('<a href="javascript:alert(1)">click</a>')
        self.assertNotIn("javascript:", result)

    def test_javascript_uri_single_quote(self):
        result = self.sanitize("<a href='javascript:alert(1)'>click</a>")
        self.assertNotIn("javascript:", result)

    def test_vbscript_uri_stripped(self):
        result = self.sanitize('<a href="vbscript:MsgBox(1)">click</a>')
        self.assertNotIn("vbscript:", result)

    def test_data_uri_stripped(self):
        result = self.sanitize('<a href="data:text/html,<script>alert(1)</script>">x</a>')
        self.assertNotIn("data:text/html", result)

    def test_safe_html_preserved(self):
        safe = '<p><strong>Bold</strong> and <em>italic</em></p>'
        result = self.sanitize(safe)
        self.assertIn("<strong>Bold</strong>", result)
        self.assertIn("<em>italic</em>", result)

    def test_empty_passthrough(self):
        self.assertEqual(self.sanitize(""), "")
        self.assertEqual(self.sanitize(None), None)

    def test_safe_links_preserved(self):
        result = self.sanitize('<a href="https://example.com">link</a>')
        self.assertIn('href="https://example.com"', result)

    def test_form_tag_stripped(self):
        result = self.sanitize('<form action="/evil"><input type="submit"></form>')
        self.assertNotIn("<form", result)


# ============================================================================
# I4-03: template_fill XML injection
# ============================================================================


class TemplateFillXmlInjectionTests(TestCase):
    """fill_template 替换值必须转义 XML 特殊字符。"""

    fill_template = staticmethod(_template_fill_mod.fill_template)

    def test_angle_brackets_escaped(self):
        with tempfile.TemporaryDirectory() as d:
            slide_dir = os.path.join(d, "ppt", "slides")
            os.makedirs(slide_dir)
            with open(os.path.join(slide_dir, "slide1.xml"), "w") as f:
                f.write('<a:t>{{company}}</a:t>')

            result = self.fill_template(d, {"company": "<script>alert(1)</script>"})
            self.assertEqual(result["total_replacements"], 1)

            with open(os.path.join(slide_dir, "slide1.xml")) as f:
                output = f.read()
            self.assertNotIn("<script>", output)
            self.assertIn("&lt;script&gt;", output)

    def test_ampersand_escaped(self):
        with tempfile.TemporaryDirectory() as d:
            slide_dir = os.path.join(d, "ppt", "slides")
            os.makedirs(slide_dir)
            with open(os.path.join(slide_dir, "slide1.xml"), "w") as f:
                f.write('<a:t>{{name}}</a:t>')

            self.fill_template(d, {"name": "A&B"})

            with open(os.path.join(slide_dir, "slide1.xml")) as f:
                output = f.read()
            self.assertIn("A&amp;B", output)

    def test_quotes_escaped(self):
        with tempfile.TemporaryDirectory() as d:
            slide_dir = os.path.join(d, "ppt", "slides")
            os.makedirs(slide_dir)
            with open(os.path.join(slide_dir, "slide1.xml"), "w") as f:
                f.write('<a:t>{{val}}</a:t>')

            self.fill_template(d, {"val": 'He said "hi" & \'bye\''})

            with open(os.path.join(slide_dir, "slide1.xml")) as f:
                output = f.read()
            self.assertIn("&quot;", output)
            self.assertIn("&apos;", output)

    def test_multiple_placeholders_all_escaped(self):
        with tempfile.TemporaryDirectory() as d:
            slide_dir = os.path.join(d, "ppt", "slides")
            os.makedirs(slide_dir)
            with open(os.path.join(slide_dir, "slide1.xml"), "w") as f:
                f.write('<a:t>{{a}} and {{b}}</a:t>')

            self.fill_template(d, {"a": "<tag>", "b": "B&C"})

            with open(os.path.join(slide_dir, "slide1.xml")) as f:
                output = f.read()
            self.assertIn("&lt;tag&gt;", output)
            self.assertIn("B&amp;C", output)

    def test_normal_text_unchanged(self):
        with tempfile.TemporaryDirectory() as d:
            slide_dir = os.path.join(d, "ppt", "slides")
            os.makedirs(slide_dir)
            with open(os.path.join(slide_dir, "slide1.xml"), "w") as f:
                f.write('<a:t>{{greeting}}</a:t>')

            self.fill_template(d, {"greeting": "Hello World"})

            with open(os.path.join(slide_dir, "slide1.xml")) as f:
                output = f.read()
            self.assertIn("Hello World", output)


# ============================================================================
# I5-01: preview text content XSS
# ============================================================================


class PreviewTextContentSanitizeTests(TestCase):
    """_render_text_element 必须净化 content 中的危险 HTML。"""

    _render = staticmethod(_preview_mod._render_text_element)

    def test_script_tag_stripped(self):
        el = {"type": "text", "content": '<p>Hello</p><script>alert(document.cookie)</script>'}
        html = self._render(el, "left:0;", 'data-element-type="text"')
        self.assertNotIn("<script>", html)
        self.assertIn("Hello", html)

    def test_event_handler_stripped(self):
        el = {"type": "text", "content": '<img src=x onerror="alert(1)">'}
        html = self._render(el, "left:0;", "")
        self.assertNotIn("onerror", html)

    def test_javascript_uri_stripped(self):
        el = {"type": "text", "content": '<a href="javascript:alert(1)">click</a>'}
        html = self._render(el, "left:0;", "")
        self.assertNotIn("javascript:", html)

    def test_iframe_stripped(self):
        el = {"type": "text", "content": '<iframe src="https://evil.com"></iframe>'}
        html = self._render(el, "left:0;", "")
        self.assertNotIn("<iframe", html)

    def test_safe_rich_text_preserved(self):
        el = {"type": "text", "content": '<p><strong>Bold</strong> and <em>italic</em></p>'}
        html = self._render(el, "left:0;", "")
        self.assertIn("<strong>Bold</strong>", html)
        self.assertIn("<em>italic</em>", html)

    def test_vbscript_uri_stripped(self):
        el = {"type": "text", "content": '<a href="vbscript:MsgBox(1)">click</a>'}
        html = self._render(el, "left:0;", "")
        self.assertNotIn("vbscript:", html)

    def test_data_uri_script_stripped(self):
        el = {"type": "text", "content": '<a href="data:text/html,<script>alert(1)</script>">click</a>'}
        html = self._render(el, "left:0;", "")
        self.assertNotIn("data:text/html", html)

    def test_empty_content_safe(self):
        el = {"type": "text", "content": ""}
        html = self._render(el, "left:0;", "")
        self.assertIn('class="element"', html)

    def test_plain_text_preserved(self):
        el = {"type": "text", "content": "Hello World 你好世界"}
        html = self._render(el, "left:0;", "")
        self.assertIn("Hello World 你好世界", html)
