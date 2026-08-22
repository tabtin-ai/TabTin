from __future__ import annotations

import base64
import html
import os
import tempfile
from unittest.mock import patch
from django.test import SimpleTestCase

from apps.services.docparse.parsers.image_parser import (
    ImageParser,
    MAX_IMAGE_IMPORT_BYTES,
)
from apps.services.docparse.parsers.plaintext_parser import PlaintextParser, _detect_subtype
from apps.services.docparse.parsers.registry import get_parser_for_mime
from apps.services.docparse.service import _detect_mime


class PlaintextHtmlParserTests(SimpleTestCase):
    def test_mark_extension_detected_as_markdown_subtype(self):
        self.assertEqual(_detect_subtype("notes.mark", "# 标题"), "markdown")
        self.assertEqual(_detect_subtype("notes.markdown", "# 标题"), "markdown")
        self.assertEqual(_detect_subtype("notes.md", "# 标题"), "markdown")

    def test_html_import_extracts_safe_structured_text(self):
        html = """
        <!doctype html>
        <html>
          <head><title>产品说明</title><script>alert("x")</script></head>
          <body>
            <h1>标题</h1>
            <p>第一段 <strong>内容</strong></p>
            <ul><li>事项 A</li></ul>
            <pre>print("ok")</pre>
          </body>
        </html>
        """
        with tempfile.NamedTemporaryFile("w", suffix=".html", encoding="utf-8", delete=False) as fp:
            fp.write(html)
            path = fp.name
        try:
            result = PlaintextParser().parse(path)
        finally:
            os.unlink(path)

        chunks = result.pages[0].chunks
        self.assertEqual(result.title, "产品说明")
        self.assertEqual(chunks[0].chunk_type, "heading")
        self.assertEqual(chunks[0].heading_level, 1)
        self.assertIn("第一段 内容", result.pages[0].text_content)
        self.assertIn("- 事项 A", result.pages[0].text_content)
        self.assertIn('print("ok")', result.pages[0].text_content)
        self.assertNotIn("alert", result.pages[0].text_content)

    def test_html_import_extracts_sandboxed_iframe_srcdoc_without_duplicate_fallback(self):
        embedded = """
        <!doctype html>
        <html><body>
          <h1>发布提交地图</h1>
          <p>状态实时刷新</p>
          <p>TabData 导入失败保留结构化错误</p>
          <p>拆分原则</p>
          <p><code>bb0a6ed364</code></p>
          <script>window.evil = "不得执行或导入"</script>
          <iframe src="https://evil.example/private">外部 iframe fallback</iframe>
        </body></html>
        """
        wrapper = f"""
        <!doctype html>
        <html><body>
          <p>外层前文</p>
          <iframe sandbox="allow-scripts" srcdoc="{html.escape(embedded, quote=True)}">
            <p>状态实时刷新</p>
          </iframe>
          <p>外层后文</p>
        </body></html>
        """

        result = self._parse_html(wrapper)
        text = result.pages[0].text_content

        for marker in [
            "状态实时刷新",
            "TabData 导入失败保留结构化错误",
            "拆分原则",
            "bb0a6ed364",
        ]:
            self.assertIn(marker, text)
        self.assertEqual(text.count("状态实时刷新"), 1)
        self.assertNotIn("不得执行或导入", text)
        self.assertNotIn("evil.example", text)
        self.assertNotIn("外部 iframe fallback", text)
        self.assertLess(text.index("外层前文"), text.index("状态实时刷新"))
        self.assertLess(text.index("状态实时刷新"), text.index("外层后文"))

    def test_html_import_limits_srcdoc_recursion_depth(self):
        nested = "<p>最深层不应导入</p>"
        for _ in range(4):
            nested = f'<iframe srcdoc="{html.escape(nested, quote=True)}"></iframe>'

        result = self._parse_html(f"<html><body>{nested}</body></html>")

        self.assertNotIn("最深层不应导入", result.pages[0].text_content)

    def test_html_import_expands_inline_srcdoc_without_iframe_fallback(self):
        embedded = html.escape("<p>内联正文</p>", quote=True)
        image_b64 = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x01" * 8).decode("ascii")
        wrapper = (
            f'<html><body><p>内联前文<img src="data:image/png;base64,{image_b64}" alt="内联图片">'
            f'<iframe srcdoc="{embedded}">不应导入的 fallback</iframe>'
            "内联后文</p></body></html>"
        )

        result = self._parse_html(wrapper)
        text = result.pages[0].text_content

        self.assertNotIn("不应导入的 fallback", text)
        self.assertLess(text.index("内联前文"), text.index("内联正文"))
        self.assertLess(text.index("内联正文"), text.index("内联后文"))
        self.assertEqual(
            [chunk.content for chunk in result.pages[0].chunks if chunk.chunk_type == "image"],
            ["内联图片"],
        )

    def test_html_import_expands_nested_structural_srcdoc_once(self):
        embedded = html.escape("<p>嵌套正文</p>", quote=True)
        wrapper = (
            "<html><body><ul><li><p>嵌套前文"
            f'<iframe srcdoc="{embedded}"></iframe>'
            "嵌套后文</p></li></ul></body></html>"
        )

        result = self._parse_html(wrapper)
        text = result.pages[0].text_content

        self.assertEqual(text.count("嵌套前文"), 1)
        self.assertEqual(text.count("嵌套正文"), 1)
        self.assertEqual(text.count("嵌套后文"), 1)

    def test_html_import_limits_total_srcdoc_characters(self):
        first = "<p>第一段保留</p>"
        second = "<p>第二段超过总预算不应导入</p>"
        wrapper = (
            f'<iframe srcdoc="{html.escape(first, quote=True)}"></iframe>'
            f'<iframe srcdoc="{html.escape(second, quote=True)}"></iframe>'
        )

        with patch(
            "apps.services.docparse.parsers.plaintext_parser._MAX_HTML_SRCDOC_CHARS",
            len(first),
        ):
            result = self._parse_html(f"<html><body>{wrapper}</body></html>")

        self.assertIn("第一段保留", result.pages[0].text_content)
        self.assertNotIn("第二段超过总预算不应导入", result.pages[0].text_content)

    def test_html_import_preserves_recoverable_images_and_skips_local_refs(self):
        png_bytes = b"\x89PNG\r\n\x1a\n" + b"\x01" * 32
        png_b64 = base64.b64encode(png_bytes).decode("ascii")
        html = f"""
        <!doctype html>
        <html>
          <body>
            <p>Inline image before <img src="data:image/png;base64,{png_b64}" alt="Inline probe"> after.</p>
            <p>JPG alias <img src="data:image/jpg;base64,{png_b64}" alt="JPG alias probe"></p>
            <p>Local image <img src="./images/local.png" alt="Local probe"></p>
          </body>
        </html>
        """
        with tempfile.NamedTemporaryFile("w", suffix=".html", encoding="utf-8", delete=False) as fp:
            fp.write(html)
            path = fp.name
        try:
            result = PlaintextParser().parse(path)
        finally:
            os.unlink(path)

        image_chunks = [
            chunk for chunk in result.pages[0].chunks
            if chunk.chunk_type == "image"
        ]
        self.assertEqual(len(image_chunks), 3)
        self.assertEqual(image_chunks[0].content, "Inline probe")
        self.assertEqual(image_chunks[0].metadata["content_type"], "image/png")
        self.assertEqual(base64.b64decode(image_chunks[0].metadata["image_b64"]), png_bytes)
        self.assertEqual(image_chunks[1].content, "JPG alias probe")
        self.assertEqual(image_chunks[1].metadata["content_type"], "image/jpeg")
        self.assertEqual(image_chunks[2].content, "Local probe")
        self.assertNotIn("image_b64", image_chunks[2].metadata)
        self.assertEqual(image_chunks[2].metadata["image_error"], "unsupported_image_src")

    @staticmethod
    def _parse_html(content):
        with tempfile.NamedTemporaryFile("w", suffix=".html", encoding="utf-8", delete=False) as fp:
            fp.write(content)
            path = fp.name
        try:
            return PlaintextParser().parse(path)
        finally:
            os.unlink(path)


class ImageParserTests(SimpleTestCase):
    def test_png_import_returns_image_chunk_with_base64_payload(self):
        png_bytes = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
        with tempfile.NamedTemporaryFile("wb", suffix=".png", delete=False) as fp:
            fp.write(png_bytes)
            path = fp.name
        try:
            result = ImageParser().parse(path)
        finally:
            os.unlink(path)

        chunk = result.pages[0].chunks[0]
        self.assertEqual(chunk.chunk_type, "image")
        self.assertEqual(chunk.metadata["content_type"], "image/png")
        self.assertEqual(base64.b64decode(chunk.metadata["image_b64"]), png_bytes)
        self.assertLessEqual(chunk.metadata["size_bytes"], MAX_IMAGE_IMPORT_BYTES)

    def test_jpeg_bytes_with_png_filename_are_imported_as_jpeg(self):
        jpeg_bytes = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00" + b"\x00" * 32
        with tempfile.NamedTemporaryFile("wb", suffix=".png", delete=False) as fp:
            fp.write(jpeg_bytes)
            path = fp.name
        try:
            result = ImageParser().parse(path)
        finally:
            os.unlink(path)

        chunk = result.pages[0].chunks[0]
        self.assertEqual(chunk.chunk_type, "image")
        self.assertEqual(chunk.metadata["content_type"], "image/jpeg")
        self.assertEqual(base64.b64decode(chunk.metadata["image_b64"]), jpeg_bytes)

    def test_image_parser_is_registered_for_common_image_mimes(self):
        self.assertIs(get_parser_for_mime("image/png"), ImageParser)
        self.assertIs(get_parser_for_mime("image/jpeg"), ImageParser)
        self.assertIs(get_parser_for_mime("image/gif"), ImageParser)
        self.assertIs(get_parser_for_mime("image/webp"), ImageParser)

    def test_invalid_png_header_is_rejected(self):
        with tempfile.NamedTemporaryFile("wb", suffix=".png", delete=False) as fp:
            fp.write(b"not a png")
            path = fp.name
        try:
            with self.assertRaises(ValueError):
                ImageParser().parse(path)
        finally:
            os.unlink(path)


class DocParseMimeDetectionTests(SimpleTestCase):
    def test_detect_mime_uses_png_magic_bytes(self):
        with tempfile.NamedTemporaryFile("wb", suffix=".bin", delete=False) as fp:
            fp.write(b"\x89PNG\r\n\x1a\n" + b"\x00")
            path = fp.name
        try:
            self.assertEqual(_detect_mime(path, "application/octet-stream"), "image/png")
        finally:
            os.unlink(path)

    def test_detect_mime_uses_jpeg_magic_bytes(self):
        with tempfile.NamedTemporaryFile("wb", suffix=".png", delete=False) as fp:
            fp.write(b"\xff\xd8\xff\xe0\x00\x10JFIF\x00")
            path = fp.name
        try:
            self.assertEqual(_detect_mime(path, "image/png"), "image/jpeg")
        finally:
            os.unlink(path)

    def test_detect_mime_falls_back_to_extension_when_declared_mime_is_generic(self):
        with tempfile.NamedTemporaryFile("w", suffix=".html", encoding="utf-8", delete=False) as fp:
            fp.write("<html><body>hello</body></html>")
            path = fp.name
        try:
            self.assertEqual(_detect_mime(path, "application/octet-stream"), "text/html")
        finally:
            os.unlink(path)
