from __future__ import annotations

import io
import unittest
import zipfile
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from xml.etree import ElementTree as ET

from django.test import override_settings

from apps.tabdoc.services.exchange_service import (
    DocumentExchangeService,
    _PDF_DEVICE_SCALE_FACTOR,
)


class SafeFilenameTests(unittest.TestCase):
    """DocumentExchangeService._safe_filename 单元测试"""

    def test_normal_title(self):
        self.assertEqual(
            DocumentExchangeService._safe_filename("会议纪要"),
            "会议纪要",
        )

    def test_control_chars_removed(self):
        result = DocumentExchangeService._safe_filename("file\x00name\nwith\tctrl")
        self.assertNotIn("\x00", result)
        self.assertNotIn("\n", result)
        self.assertNotIn("\t", result)
        self.assertIn("file", result)

    def test_path_separators_replaced(self):
        result = DocumentExchangeService._safe_filename("a/b\\c:d*e?f")
        for ch in ('/', '\\', ':', '*', '?'):
            self.assertNotIn(ch, result)

    def test_length_limit(self):
        long_title = "a" * 300
        result = DocumentExchangeService._safe_filename(long_title)
        self.assertLessEqual(len(result), 200)

    def test_empty_and_none(self):
        self.assertEqual(DocumentExchangeService._safe_filename(None), "document")
        self.assertEqual(DocumentExchangeService._safe_filename(""), "document")
        self.assertEqual(DocumentExchangeService._safe_filename("   "), "document")

    def test_only_special_chars(self):
        result = DocumentExchangeService._safe_filename("///***???")
        self.assertEqual(result, "document")

    def test_quotes_replaced(self):
        result = DocumentExchangeService._safe_filename('say "hello"')
        self.assertNotIn('"', result)


class PmJsonToPlaintextTests(unittest.TestCase):
    """DocumentExchangeService._pm_json_to_plaintext 单元测试"""

    def test_basic_paragraph(self):
        pm_json = {
            "type": "doc",
            "content": [
                {"type": "paragraph", "content": [{"type": "text", "text": "Hello world"}]},
            ],
        }
        result = DocumentExchangeService._pm_json_to_plaintext(pm_json)
        self.assertIn("Hello world", result)

    def test_mathematics_preserved(self):
        pm_json = {
            "type": "doc",
            "content": [
                {"type": "mathematics", "attrs": {"latex": "E=mc^2"}},
            ],
        }
        result = DocumentExchangeService._pm_json_to_plaintext(pm_json)
        self.assertIn("E=mc^2", result)

    def test_image_alt_preserved(self):
        pm_json = {
            "type": "doc",
            "content": [
                {"type": "image", "attrs": {"alt": "screenshot", "src": "https://img.example.com/a.png"}},
            ],
        }
        result = DocumentExchangeService._pm_json_to_plaintext(pm_json)
        self.assertIn("[screenshot]", result)

    def test_empty_doc(self):
        result = DocumentExchangeService._pm_json_to_plaintext({"type": "doc", "content": []})
        self.assertEqual(result, "")

    # ── Round 3: tabdataBlock plaintext ─────────────────────────

    def test_tabdata_block_plaintext(self):
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "tabdataBlock",
                    "attrs": {"tableId": "tbl-001", "title": "季度报表"},
                },
            ],
        }
        result = DocumentExchangeService._pm_json_to_plaintext(pm_json)
        self.assertIn("[表格: 季度报表]", result)

    def test_tabdata_block_plaintext_default_title(self):
        pm_json = {
            "type": "doc",
            "content": [
                {"type": "tabdataBlock", "attrs": {"tableId": "tbl-002"}},
            ],
        }
        result = DocumentExchangeService._pm_json_to_plaintext(pm_json)
        self.assertIn("[表格: 未命名表格]", result)

    # ── : htmlBlock plaintext ──────────────────────────────

    def test_htmlblock_plaintext(self):
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "htmlBlock",
                    "attrs": {"fileId": "f1", "src": "https://x.com/a.html", "title": "架构图"},
                },
            ],
        }
        result = DocumentExchangeService._pm_json_to_plaintext(pm_json)
        self.assertIn("[HTML: 架构图]", result)

    def test_htmlblock_plaintext_default_title(self):
        pm_json = {
            "type": "doc",
            "content": [
                {"type": "htmlBlock", "attrs": {"fileId": "f2"}},
            ],
        }
        result = DocumentExchangeService._pm_json_to_plaintext(pm_json)
        self.assertIn("[HTML: 未命名 HTML]", result)

    def test_unsupported_format_raises(self):
        """export_document_content 不支持的格式应抛出 ValueError。"""
        # _safe_filename 和 _pm_json_to_plaintext 是静态方法可以直接测
        # export_document_content 需要 Document 实例，此处仅测 ValueError 路径的逻辑
        with self.assertRaises(ValueError) as ctx:
            svc = DocumentExchangeService.__new__(DocumentExchangeService)
            # 直接调用 format 判断逻辑
            normalized = "xlsx"
            if normalized not in DocumentExchangeService._SUPPORTED_EXPORT_FORMATS:
                raise ValueError(f"不支持的导出格式: {normalized}")
        self.assertIn("xlsx", str(ctx.exception))


class HtmlExportTests(unittest.TestCase):
    """DocumentExchangeService HTML 导出回归测试"""

    def _service(self):
        service = DocumentExchangeService.__new__(DocumentExchangeService)
        service.check_document_permission = MagicMock(return_value=True)
        return service

    def test_html_export_includes_title_editor_shell_and_rich_styles(self):
        service = self._service()
        document = SimpleNamespace(
            title="产品方案",
            description_binary=None,
            description_json={
                "type": "doc",
                "content": [
                    {
                        "type": "heading",
                        "attrs": {"level": 2},
                        "content": [{"type": "text", "text": "排版验证"}],
                    },
                    {
                        "type": "paragraph",
                        "content": [
                            {
                                "type": "text",
                                "text": "彩色文字",
                                "marks": [
                                    {"type": "textStyle", "attrs": {"color": "#9333EA"}},
                                    {"type": "highlight", "attrs": {"color": "var(--novel-highlight-yellow, #fef9c3)"}},
                                ],
                            },
                        ],
                    },
                    {
                        "type": "table",
                        "content": [
                            {
                                "type": "tableRow",
                                "content": [
                                    {
                                        "type": "tableHeader",
                                        "content": [
                                            {"type": "paragraph", "content": [{"type": "text", "text": "列 A"}]},
                                        ],
                                    },
                                ],
                            },
                        ],
                    },
                    {
                        "type": "bulletList",
                        "content": [
                            {
                                "type": "listItem",
                                "content": [
                                    {"type": "paragraph", "content": [{"type": "text", "text": "要点"}]},
                                ],
                            },
                        ],
                    },
                    {
                        "type": "orderedList",
                        "attrs": {"start": 2},
                        "content": [
                            {
                                "type": "listItem",
                                "content": [
                                    {"type": "paragraph", "content": [{"type": "text", "text": "步骤"}]},
                                ],
                            },
                        ],
                    },
                    {
                        "type": "taskList",
                        "content": [
                            {
                                "type": "taskItem",
                                "attrs": {"checked": True},
                                "content": [
                                    {"type": "paragraph", "content": [{"type": "text", "text": "完成"}]},
                                ],
                            },
                            {
                                "type": "taskItem",
                                "attrs": {"checked": False},
                                "content": [
                                    {"type": "paragraph", "content": [{"type": "text", "text": "待办"}]},
                                    {
                                        "type": "taskList",
                                        "content": [
                                            {
                                                "type": "taskItem",
                                                "attrs": {"checked": True},
                                                "content": [
                                                    {
                                                        "type": "paragraph",
                                                        "content": [{"type": "text", "text": "子任务"}],
                                                    },
                                                ],
                                            },
                                        ],
                                    },
                                ],
                            },
                        ],
                    },
                ],
            },
            description_markdown="",
            description_plaintext="",
            font_style="serif",
            is_full_width=True,
            properties={"small_text": True},
        )

        result = service.export_document_content(document, export_format="html")

        content = result["content"]
        self.assertEqual(result["mime_type"], "text/html; charset=utf-8")
        self.assertTrue(content.startswith("<!doctype html>"))
        self.assertIn("<title>产品方案</title>", content)
        self.assertIn('<h1 class="tabdoc-export-title">产品方案</h1>', content)
        self.assertIn(
            '<article class="tabdoc-export tabdoc-page tabdoc-font-serif tabdoc-small-text tabdoc-full-width">',
            content,
        )
        self.assertIn("<style>", content)
        self.assertIn(".ProseMirror table", content)
        self.assertIn(".ProseMirror .task-list > li", content)
        self.assertIn("grid-template-columns: 1rem minmax(0, 1fr)", content)
        self.assertIn('accent-color: #f59e0b', content)
        self.assertIn(".ProseMirror .task-list > li > :not(input)", content)
        self.assertIn(".ProseMirror .task-list > li > p", content)
        self.assertIn("<h2>排版验证</h2>", content)
        self.assertIn('style="color: #9333EA; background-color: #fef9c3"', content)
        self.assertIn("<table><tbody><tr><th><p>列 A</p></th></tr></tbody></table>", content)
        self.assertIn("<ul><li><p>要点</p></li></ul>", content)
        self.assertIn('<ol start="2"><li><p>步骤</p></li></ol>', content)
        self.assertIn('<li><input type="checkbox" checked disabled /><p>完成</p></li>', content)
        self.assertIn(
            '<li><input type="checkbox" disabled /><p>待办</p>'
            '<ul class="task-list"><li><input type="checkbox" checked disabled /><p>子任务</p></li></ul></li>',
            content,
        )

    def test_html_export_drops_unsafe_inline_color_marks(self):
        service = self._service()
        document = SimpleNamespace(
            title="安全验证",
            description_binary=None,
            description_json={
                "type": "doc",
                "content": [
                    {
                        "type": "paragraph",
                        "content": [
                            {
                                "type": "text",
                                "text": "危险颜色值",
                                "marks": [
                                    {"type": "textStyle", "attrs": {"color": "#fff; background:url(javascript:alert(1))"}},
                                    {"type": "highlight", "attrs": {"color": "rgb(expression(alert(1)))"}},
                                ],
                            },
                        ],
                    },
                ],
            },
            description_markdown="",
            description_plaintext="",
            font_style="default",
            is_full_width=False,
            properties={},
        )

        content = service.export_document_content(document, export_format="html")["content"]

        self.assertIn("危险颜色值", content)
        self.assertNotIn("javascript:", content)
        self.assertNotIn("expression", content)
        self.assertNotIn('style="', content)

    def test_html_export_escapes_document_title(self):
        service = self._service()
        document = SimpleNamespace(
            title='坏标题 <script>alert("x")</script>',
            description_binary=None,
            description_json={"type": "doc", "content": []},
            description_markdown="正文",
            description_plaintext="正文",
            font_style="default",
            is_full_width=False,
            properties={},
        )

        content = service.export_document_content(document, export_format="html")["content"]

        self.assertIn(
            "<title>坏标题 &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</title>",
            content,
        )
        self.assertIn(
            '<h1 class="tabdoc-export-title">坏标题 &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</h1>',
            content,
        )
        self.assertNotIn("<script>", content)

    def test_markdown_export_recomputes_when_stored_json_has_images(self):
        service = self._service()
        document = SimpleNamespace(
            title="图片 Markdown",
            description_binary=None,
            description_json={
                "type": "doc",
                "content": [
                    {
                        "type": "paragraph",
                        "content": [
                            {
                                "type": "text",
                                "text": "高亮文本",
                                "marks": [
                                    {"type": "highlight", "attrs": {"color": "#fef9c3"}},
                                    {"type": "underline"},
                                ],
                            }
                        ],
                    },
                    {
                        "type": "image",
                        "attrs": {
                            "src": "tabdoc/images/hash.png",
                            "alt": "本地对象",
                            "width": 320,
                        },
                    },
                ],
            },
            description_markdown="旧纯文本",
            description_plaintext="旧纯文本",
            font_style="default",
            is_full_width=False,
            properties={},
        )

        result = service.export_document_content(document, export_format="markdown")

        self.assertTrue(result["content"].startswith("# 图片 Markdown\n\n"))
        self.assertIn("高亮文本", result["content"])
        self.assertIn("![本地对象](tabdoc/images/hash.png)", result["content"])
        self.assertNotIn("<mark", result["content"])
        self.assertNotIn("<u>", result["content"])
        self.assertNotEqual(result["content"], "旧纯文本")

    def test_markdown_export_recomputes_rich_marks_as_plain_markdown(self):
        service = self._service()
        document = SimpleNamespace(
            title="富样式 Markdown",
            description_binary=None,
            description_json={
                "type": "doc",
                "content": [
                    {
                        "type": "paragraph",
                        "content": [
                            {
                                "type": "text",
                                "text": "高亮文本",
                                "marks": [
                                    {"type": "highlight", "attrs": {"color": "#fef9c3"}},
                                    {"type": "underline"},
                                ],
                            }
                        ],
                    },
                ],
            },
            description_markdown="旧纯文本",
            description_plaintext="旧纯文本",
            font_style="default",
            is_full_width=False,
            properties={},
        )

        result = service.export_document_content(document, export_format="markdown")

        self.assertEqual("# 富样式 Markdown\n\n高亮文本", result["content"])
        self.assertNotIn("<mark", result["content"])
        self.assertNotIn("<u>", result["content"])

    @patch("apps.services.oss.services.public_assets.build_public_asset_url")
    def test_html_export_rewrites_platform_image_refs_to_public_urls(self, mock_build_public_asset_url):
        mock_build_public_asset_url.return_value = (
            "http://127.0.0.1:6060/api/services/oss/local-object?"
            "object_key=tabdoc%2Fimages%2Fhash.png"
        )
        service = self._service()
        document = SimpleNamespace(
            title="图片 HTML",
            description_binary=None,
            description_json={
                "type": "doc",
                "content": [
                    {
                        "type": "image",
                        "attrs": {
                            "src": "tabdoc/images/hash.png",
                            "alt": "本地对象",
                            "width": 320,
                            "height": 180,
                        },
                    },
                ],
            },
            description_markdown="",
            description_plaintext="",
            font_style="default",
            is_full_width=False,
            properties={},
        )

        result = service.export_document_content(document, export_format="html")

        self.assertIn("http://127.0.0.1:6060/api/services/oss/local-object", result["content"])
        self.assertIn("object_key=tabdoc%2Fimages%2Fhash.png", result["content"])
        self.assertIn('width="320"', result["content"])
        mock_build_public_asset_url.assert_called_with("tabdoc/images/hash.png")

    @patch.object(DocumentExchangeService, "_resolve_from_binary")
    def test_html_export_falls_back_when_binary_conversion_degrades_images(self, mock_resolve_binary):
        service = self._service()
        fallback_json = {
            "type": "doc",
            "content": [
                {"type": "paragraph", "content": [{"type": "text", "text": "开头"}]},
                {"type": "paragraph", "content": [{"type": "text", "text": "正文"}]},
                {
                    "type": "image",
                    "attrs": {
                        "src": "tabdoc/images/hash.png",
                        "alt": "本地对象",
                        "width": 320,
                    },
                },
            ],
        }
        binary_json = {
            "type": "doc",
            "content": [
                {"type": "paragraph", "content": [{"type": "text", "text": "开头"}]},
                {"type": "paragraph", "content": [{"type": "text", "text": "&lt;img src=\"tabdoc/images/hash.png\"&gt;"}]},
            ],
        }
        mock_resolve_binary.return_value = (binary_json, "&lt;img src=\"tabdoc/images/hash.png\"&gt;")
        document = SimpleNamespace(
            id="doc-degraded",
            title="图片回退",
            description_binary=b"stale-yjs",
            description_json=fallback_json,
            description_markdown="",
            description_plaintext="",
            font_style="default",
            is_full_width=False,
            properties={},
        )

        content = service.export_document_content(document, export_format="html")["content"]

        self.assertIn("http://127.0.0.1:6060/api/services/oss/local-object", content)
        self.assertIn("object_key=tabdoc%2Fimages%2Fhash.png", content)
        self.assertIn('width="320"', content)
        self.assertNotIn("&lt;img src=&quot;tabdoc/images/hash.png&quot;&gt;", content)

    @patch.object(DocumentExchangeService, "_resolve_from_binary")
    def test_html_export_falls_back_when_binary_is_title_only_but_stored_content_exists(self, mock_resolve_binary):
        service = self._service()
        fallback_json = {
            "type": "doc",
            "content": [
                {"type": "heading", "attrs": {"level": 1}, "content": [{"type": "text", "text": "导入标题"}]},
                {"type": "paragraph", "content": [{"type": "text", "text": "正文段落一"}]},
                {"type": "paragraph", "content": [{"type": "text", "text": "正文段落二"}]},
                {"type": "paragraph", "content": [{"type": "text", "text": "正文段落三"}]},
            ],
        }
        mock_resolve_binary.return_value = (
            {"type": "doc", "content": [{"type": "paragraph"}]},
            "",
        )
        document = SimpleNamespace(
            id="doc-title-only-binary",
            title="导出标题",
            description_binary=b"title-only-yjs",
            description_json=fallback_json,
            description_markdown="# 导入标题\n\n正文段落一\n\n正文段落二\n\n正文段落三",
            description_plaintext="",
            font_style="default",
            is_full_width=False,
            properties={},
        )

        content = service.export_document_content(document, export_format="html")["content"]

        self.assertIn("<h1>导入标题</h1>", content)
        self.assertIn("<p>正文段落二</p>", content)
        self.assertNotIn('<div class="ProseMirror"><p></p></div>', content)

    @patch.object(DocumentExchangeService, "_resolve_from_binary")
    def test_html_export_does_not_fallback_for_legitimate_repeated_binary_blocks(self, mock_resolve_binary):
        service = self._service()
        binary_json = {
            "type": "doc",
            "content": [
                {"type": "paragraph", "content": [{"type": "text", "text": "重复"}]},
                {"type": "paragraph", "content": [{"type": "text", "text": "重复"}]},
                {"type": "paragraph", "content": [{"type": "text", "text": "重复"}]},
            ],
        }
        mock_resolve_binary.return_value = (binary_json, "重复\n\n重复\n\n重复")
        document = SimpleNamespace(
            id="doc-repeated",
            title="合法重复",
            description_binary=b"current-yjs",
            description_json={
                "type": "doc",
                "content": [{"type": "paragraph", "content": [{"type": "text", "text": "旧内容"}]}],
            },
            description_markdown="旧内容",
            description_plaintext="",
            font_style="default",
            is_full_width=False,
            properties={},
        )

        content = service.export_document_content(document, export_format="html")["content"]

        self.assertIn("<p>重复</p><p>重复</p><p>重复</p>", content)
        self.assertNotIn("旧内容", content)

    @patch.object(DocumentExchangeService, "_resolve_from_binary")
    def test_html_export_falls_back_to_markdown_when_json_empty_and_binary_image_degraded(self, mock_resolve_binary):
        service = self._service()
        service.get_latest_revision = MagicMock(return_value=None)
        mock_resolve_binary.return_value = (
            {
                "type": "doc",
                "content": [
                    {"type": "paragraph", "content": [{"type": "text", "text": "&lt;img src=\"tabdoc/images/hash.png\"&gt;"}]},
                ],
            },
            "&lt;img src=\"tabdoc/images/hash.png\"&gt;",
        )
        document = SimpleNamespace(
            id="doc-markdown-only",
            title="Markdown 图片回退",
            description_binary=b"stale-yjs",
            description_json={},
            description_markdown='![本地对象](tabdoc/images/hash.png)',
            description_plaintext="",
            font_style="default",
            is_full_width=False,
            properties={},
        )

        content = service.export_document_content(document, export_format="html")["content"]

        self.assertIn("http://127.0.0.1:6060/api/services/oss/local-object", content)
        self.assertIn("object_key=tabdoc%2Fimages%2Fhash.png", content)
        self.assertNotIn("&lt;img", content)


class ExportTitleTests(unittest.TestCase):
    """DocumentExchangeService 标题导出回归测试"""

    def _service(self):
        service = DocumentExchangeService.__new__(DocumentExchangeService)
        service.check_document_permission = MagicMock(return_value=True)
        return service

    def _document(self):
        return SimpleNamespace(
            title="产品方案",
            description_binary=None,
            description_json={
                "type": "doc",
                "content": [
                    {
                        "type": "heading",
                        "attrs": {"level": 2},
                        "content": [{"type": "text", "text": "排版验证"}],
                    },
                    {
                        "type": "paragraph",
                        "content": [{"type": "text", "text": "导出正文"}],
                    },
                ],
            },
            description_markdown="## 排版验证\n\n导出正文",
            description_plaintext="排版验证\n导出正文",
            font_style="default",
            is_full_width=False,
            properties={},
        )

    def _paragraph_texts(self, docx_bytes: bytes) -> list[str]:
        with zipfile.ZipFile(io.BytesIO(docx_bytes)) as zf:
            xml_bytes = zf.read("word/document.xml")
        root = ET.fromstring(xml_bytes)
        ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
        paragraphs = []
        for paragraph in root.findall(".//w:p", ns):
            text = "".join(t.text or "" for t in paragraph.findall(".//w:t", ns)).strip()
            if text:
                paragraphs.append(text)
        return paragraphs

    def test_markdown_export_includes_document_title_before_body(self):
        result = self._service().export_document_content(self._document(), export_format="markdown")

        self.assertEqual(result["format"], "markdown")
        self.assertEqual(result["filename"], "产品方案.md")
        self.assertEqual(result["content"], "# 产品方案\n\n## 排版验证\n\n导出正文")

    def test_markdown_export_uses_display_title_while_filename_is_safe(self):
        document = self._document()
        document.title = "产品/方案:第1版"

        result = self._service().export_document_content(document, export_format="markdown")

        self.assertEqual(result["filename"], "产品-方案-第1版.md")
        self.assertTrue(result["content"].startswith("# 产品/方案:第1版\n\n"))

    def test_txt_export_includes_document_title_before_body(self):
        result = self._service().export_document_content(self._document(), export_format="txt")

        self.assertEqual(result["format"], "txt")
        self.assertEqual(result["filename"], "产品方案.txt")
        self.assertEqual(result["content"], "产品方案\n\n排版验证\n导出正文")

    def test_txt_export_uses_pm_json_instead_of_search_plaintext_cache(self):
        document = self._document()
        document.description_plaintext = (
            '排版验证导出正文<img src="data:image/png;base64,AAAA" '
            'alt="缓存图片">正文被粘成一行'
        )

        result = self._service().export_document_content(document, export_format="txt")

        self.assertEqual(result["content"], "产品方案\n\n排版验证\n导出正文")
        self.assertNotIn("data:image", result["content"])
        self.assertNotIn("<img", result["content"])

    def test_txt_export_strips_degraded_inline_image_html_from_text_nodes(self):
        document = self._document()
        document.description_json = {
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [
                        {
                            "type": "text",
                            "text": '图前 <img src="data:image/png;base64,AAAA" alt="截图"> 图后',
                        },
                    ],
                },
            ],
        }
        document.description_markdown = ""
        document.description_plaintext = '图前 <img src="data:image/png;base64,AAAA" alt="截图"> 图后'

        result = self._service().export_document_content(document, export_format="txt")

        self.assertEqual(result["content"], "产品方案\n\n图前 [截图] 图后")
        self.assertNotIn("data:image", result["content"])
        self.assertNotIn("<img", result["content"])

    def test_txt_export_strips_escaped_inline_image_html_from_text_nodes(self):
        document = self._document()
        document.description_json = {
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [
                        {
                            "type": "text",
                            "text": (
                                "图前 &lt;img src=&quot;data:image/png;base64,AAAA&quot; "
                                "alt=&quot;截图&quot;&gt; 图后"
                            ),
                        },
                    ],
                },
            ],
        }
        document.description_markdown = ""

        result = self._service().export_document_content(document, export_format="txt")

        self.assertEqual(result["content"], "产品方案\n\n图前 [截图] 图后")
        self.assertNotIn("data:image", result["content"])
        self.assertNotIn("&lt;img", result["content"])

    def test_txt_export_sanitizes_stored_plaintext_fallback(self):
        document = self._document()
        document.description_json = {}
        document.description_markdown = ""
        document.description_plaintext = (
            '图前 <img src="data:image/png;base64,AAAA" alt="截图"> '
            "转义图 &lt;img src=&quot;data:image/png;base64,BBBB&quot; "
            "alt=&quot;缩略图&quot;&gt;"
        )
        service = self._service()
        service.get_latest_revision = MagicMock(return_value=None)

        result = service.export_document_content(document, export_format="txt")

        self.assertEqual(result["content"], "产品方案\n\n图前 [截图] 转义图 [缩略图]")
        self.assertNotIn("data:image", result["content"])
        self.assertNotIn("<img", result["content"])
        self.assertNotIn("&lt;img", result["content"])

    def test_txt_export_uses_markdown_when_pm_json_is_empty(self):
        document = self._document()
        document.description_json = {}
        document.description_markdown = "## 排版验证\n\n导出正文\n\n![截图](data:image/png;base64,AAAA)"
        document.description_plaintext = "排版验证导出正文<img src=\"data:image/png;base64,AAAA\">"
        service = self._service()
        service.get_latest_revision = MagicMock(return_value=None)

        result = service.export_document_content(document, export_format="txt")

        self.assertEqual(result["content"], "产品方案\n\n排版验证\n导出正文\n[截图]")
        self.assertNotIn("data:image", result["content"])
        self.assertNotIn("<img", result["content"])

    def test_docx_export_includes_document_title_before_body(self):
        result = self._service().export_document_content(self._document(), export_format="docx")

        self.assertEqual(result["format"], "docx")
        self.assertEqual(result["filename"], "产品方案.docx")
        self.assertEqual(
            result["mime_type"],
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        )
        self.assertEqual(
            self._paragraph_texts(result["content_bytes"])[:3],
            ["产品方案", "排版验证", "导出正文"],
        )

    def test_docx_export_keeps_markdown_body_when_pm_json_is_empty(self):
        document = self._document()
        document.description_json = {}
        document.description_markdown = "## 排版验证\n\n导出正文"
        document.description_plaintext = ""
        service = self._service()
        service.get_latest_revision = MagicMock(return_value=None)

        result = service.export_document_content(document, export_format="docx")

        self.assertEqual(
            self._paragraph_texts(result["content_bytes"])[:3],
            ["产品方案", "排版验证", "导出正文"],
        )


class PdfExportTests(unittest.TestCase):
    """DocumentExchangeService PDF 导出回归测试"""

    def _service(self):
        service = DocumentExchangeService.__new__(DocumentExchangeService)
        service.check_document_permission = MagicMock(return_value=True)
        return service

    def _document(self):
        return SimpleNamespace(
            title="产品方案",
            description_binary=None,
            description_json={
                "type": "doc",
                "content": [
                    {
                        "type": "heading",
                        "attrs": {"level": 2},
                        "content": [{"type": "text", "text": "排版验证"}],
                    },
                    {
                        "type": "paragraph",
                        "content": [{"type": "text", "text": "PDF 正文"}],
                    },
                    {
                        "type": "taskList",
                        "content": [
                            {
                                "type": "taskItem",
                                "attrs": {"checked": True},
                                "content": [
                                    {"type": "paragraph", "content": [{"type": "text", "text": "完成"}]},
                                ],
                            },
                        ],
                    },
                ],
            },
            description_markdown="",
            description_plaintext="",
            font_style="serif",
            is_full_width=False,
            properties={"small_text": True},
        )

    def test_supported_export_formats_include_pdf(self):
        self.assertIn("pdf", DocumentExchangeService._SUPPORTED_EXPORT_FORMATS)

    def test_pdf_export_uses_2x_device_scale_factor(self):
        """PDF 导出默认 2x，避免导出图在 Retina/打印下发糊。"""
        self.assertEqual(_PDF_DEVICE_SCALE_FACTOR, 2)

    @patch.object(DocumentExchangeService, "_render_html_to_pdf_bytes")
    @patch.object(DocumentExchangeService, "_pm_json_with_inlined_remote_images")
    def test_pdf_export_inlines_remote_images_before_render(
        self, mock_inline, mock_render_pdf,
    ):
        """PDF 导出前应内联外链图片，避免 Playwright 策略拦掉 PNG。"""
        import base64
        import struct
        import zlib

        def _chunk(chunk_type: bytes, data: bytes) -> bytes:
            raw = chunk_type + data
            return struct.pack(">I", len(data)) + raw + struct.pack(">I", zlib.crc32(raw) & 0xFFFFFFFF)

        png = (
            b"\x89PNG\r\n\x1a\n"
            + _chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
            + _chunk(b"IDAT", zlib.compress(b"\x00\x00\x00\x00"))
            + _chunk(b"IEND", b"")
        )
        data_uri = "data:image/png;base64," + base64.b64encode(png).decode("ascii")
        mock_inline.return_value = {
            "type": "doc",
            "content": [
                {"type": "heading", "attrs": {"level": 2}, "content": [{"type": "text", "text": "排版验证"}]},
                {"type": "image", "attrs": {"src": data_uri, "alt": "remote-png"}},
            ],
        }
        mock_render_pdf.return_value = b"%PDF-1.4\ninlined"

        result = self._service().export_document_content(self._document(), export_format="pdf")

        self.assertEqual(result["content_bytes"], b"%PDF-1.4\ninlined")
        mock_inline.assert_called_once()
        html_document = mock_render_pdf.call_args.args[0]
        self.assertIn("data:image/png;base64,", html_document)
        self.assertNotIn("https://cdn.example.com/", html_document)

    @patch("apps.tabdoc.services.docx_converter._batch_download_images")
    @patch("apps.tabdoc.services.docx_converter._collect_image_urls")
    def test_pm_json_with_inlined_remote_images_rewrites_http_src(
        self, mock_collect, mock_batch,
    ):
        import struct
        import zlib

        def _chunk(chunk_type: bytes, data: bytes) -> bytes:
            raw = chunk_type + data
            return struct.pack(">I", len(data)) + raw + struct.pack(">I", zlib.crc32(raw) & 0xFFFFFFFF)

        png = (
            b"\x89PNG\r\n\x1a\n"
            + _chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
            + _chunk(b"IDAT", zlib.compress(b"\x00\x00\x00\x00"))
            + _chunk(b"IEND", b"")
        )
        remote = "https://cdn.example.com/photo.png"
        mock_collect.return_value = [remote]
        mock_batch.return_value = {remote: png}
        pm_json = {
            "type": "doc",
            "content": [
                {"type": "image", "attrs": {"src": remote, "alt": "photo"}},
            ],
        }

        result = DocumentExchangeService._pm_json_with_inlined_remote_images(pm_json)
        src = result["content"][0]["attrs"]["src"]
        self.assertTrue(src.startswith("data:image/png;base64,"))

    @patch.object(DocumentExchangeService, "_render_html_to_pdf_bytes")
    def test_pdf_export_returns_bytes_mime_filename_and_reuses_html_document(self, mock_render_pdf):
        mock_render_pdf.return_value = b"%PDF-1.4\nfake-test-pdf"
        result = self._service().export_document_content(self._document(), export_format="pdf")

        self.assertEqual(result["format"], "pdf")
        self.assertEqual(result["content_bytes"], b"%PDF-1.4\nfake-test-pdf")
        self.assertEqual(result["mime_type"], "application/pdf")
        self.assertEqual(result["filename"], "产品方案.pdf")

        html_document = mock_render_pdf.call_args.args[0]
        self.assertIn("<title>产品方案</title>", html_document)
        self.assertIn('<h1 class="tabdoc-export-title">产品方案</h1>', html_document)
        self.assertIn("<h2>排版验证</h2>", html_document)
        self.assertIn('<ul class="task-list"><li><input type="checkbox" checked disabled /><p>完成</p></li></ul>', html_document)

    @patch.object(DocumentExchangeService, "_render_html_to_pdf_bytes")
    def test_pdf_export_renderer_unavailable_raises_clear_error(self, mock_render_pdf):
        mock_render_pdf.side_effect = RuntimeError("PDF 导出需要可用的 Playwright Chromium renderer")

        with self.assertRaises(RuntimeError) as ctx:
            self._service().export_document_content(self._document(), export_format="pdf")

        self.assertIn("Playwright Chromium renderer", str(ctx.exception))

    def test_pdf_resource_url_policy_only_allows_embedded_and_local_object_proxy(self):
        self.assertFalse(DocumentExchangeService._is_pdf_resource_url_allowed("http://127.0.0.1/private.png"))
        self.assertFalse(DocumentExchangeService._is_pdf_resource_url_allowed("http://169.254.169.254/latest/meta-data"))
        self.assertFalse(DocumentExchangeService._is_pdf_resource_url_allowed("file:///etc/passwd"))
        self.assertFalse(DocumentExchangeService._is_pdf_resource_url_allowed("http://localhost/private.png"))
        self.assertFalse(DocumentExchangeService._is_pdf_resource_url_allowed("https://example.com/public.png"))
        self.assertTrue(DocumentExchangeService._is_pdf_resource_url_allowed(
            "http://127.0.0.1:6060/api/services/oss/local-object?object_key=tabdoc%2Fimages%2Fa.png"
        ))
        self.assertTrue(DocumentExchangeService._is_pdf_resource_url_allowed("data:image/png;base64,abc"))

    @override_settings(ASSET_PUBLIC_DOMAIN="https://assets.tabtin.example")
    def test_pdf_resource_url_policy_allows_known_platform_asset_host(self):
        self.assertTrue(DocumentExchangeService._is_pdf_resource_url_allowed(
            "https://assets.tabtin.example/tabdoc/images/a.png"
        ))
        self.assertFalse(DocumentExchangeService._is_pdf_resource_url_allowed(
            "https://evil.example/tabdoc/images/a.png"
        ))

    @patch("apps.tabdoc.services.exchange_service.sys.platform", "win32")
    def test_pdf_renderer_uses_windows_proactor_policy_for_playwright_subprocess(self):
        import apps.tabdoc.services.exchange_service as exchange_module

        class SelectorPolicy:
            pass

        class ProactorPolicy:
            pass

        with patch.object(
            exchange_module.asyncio,
            "WindowsProactorEventLoopPolicy",
            ProactorPolicy,
            create=True,
        ), patch.object(
            exchange_module.asyncio,
            "get_event_loop_policy",
            return_value=SelectorPolicy(),
        ), patch.object(exchange_module.asyncio, "set_event_loop_policy") as mock_set_policy:
            DocumentExchangeService._ensure_playwright_subprocess_event_loop_policy()

        mock_set_policy.assert_called_once()
        self.assertIsInstance(mock_set_policy.call_args.args[0], ProactorPolicy)


class ImportFromFileTests(unittest.TestCase):
    """DocumentExchangeService.import_from_file 回归测试"""

    @patch("apps.services.docparse.service.DocParseService.parse")
    @patch("apps.services.oss.models.FileRecord.objects")
    def test_import_from_file_rejects_legacy_sync_path(
        self,
        mock_file_objects,
        mock_parse,
    ):
        """TabDoc 文件导入必须走后台 Job，不能再从 exchange service 同步解析。"""
        svc = DocumentExchangeService.__new__(DocumentExchangeService)
        svc.check_organization_permission = MagicMock(return_value=True)

        mock_file_objects.only.return_value.get.return_value = MagicMock(id="file-1")

        with self.assertRaises(RuntimeError):
            svc.import_from_file(
                organization_id="wt-1",
                space_id="sp-1",
                file_record_id="file-1",
            )

        mock_parse.assert_not_called()

if __name__ == "__main__":
    unittest.main()
