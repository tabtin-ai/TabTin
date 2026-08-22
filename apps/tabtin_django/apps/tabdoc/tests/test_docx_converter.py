from __future__ import annotations

import io
import unittest
import zipfile
from unittest.mock import patch, MagicMock
from xml.etree import ElementTree as ET

from apps.tabdoc.services.docx_converter import (
    _DOCX_SVG_SUPERSAMPLE,
    _normalize_image_bytes_for_docx,
    _pinned_get,
    image_bytes_to_data_uri,
    pm_json_to_docx_bytes,
)


class DocxConverterTests(unittest.TestCase):
    """docx_converter.py 单元测试"""

    def _get_document_xml(self, docx_bytes: bytes) -> ET.Element:
        """从 DOCX bytes 中提取 word/document.xml 并解析为 ElementTree。"""
        with zipfile.ZipFile(io.BytesIO(docx_bytes)) as zf:
            xml_bytes = zf.read("word/document.xml")
        return ET.fromstring(xml_bytes)

    def _get_all_text(self, root: ET.Element) -> str:
        ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
        texts = root.findall(".//w:t", ns)
        return "".join(t.text or "" for t in texts)

    # ── 基础渲染 ──────────────────────────────────────────────────

    def test_pm_json_to_docx_bytes_basic(self):
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "heading",
                    "attrs": {"level": 1},
                    "content": [{"type": "text", "text": "标题一"}],
                },
                {
                    "type": "paragraph",
                    "content": [
                        {"type": "text", "text": "普通文本 "},
                        {"type": "text", "text": "加粗", "marks": [{"type": "bold"}]},
                    ],
                },
            ],
        }
        result = pm_json_to_docx_bytes(pm_json)
        self.assertIsInstance(result, bytes)
        self.assertTrue(result[:2] == b"PK", "DOCX should be a valid ZIP (PK header)")

        all_text = self._get_all_text(self._get_document_xml(result))
        self.assertIn("标题一", all_text)
        self.assertIn("普通文本", all_text)
        self.assertIn("加粗", all_text)

    def test_pm_json_to_docx_bytes_empty(self):
        pm_json = {"type": "doc", "content": []}
        result = pm_json_to_docx_bytes(pm_json, markdown_fallback="# fallback content")
        self.assertTrue(result[:2] == b"PK")
        all_text = self._get_all_text(self._get_document_xml(result))
        self.assertIn("fallback content", all_text)

    # ── 表格 ──────────────────────────────────────────────────────

    def test_pm_json_to_docx_bytes_table(self):
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "table",
                    "content": [
                        {
                            "type": "tableRow",
                            "content": [
                                {
                                    "type": "tableHeader",
                                    "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Col A"}]}],
                                },
                                {
                                    "type": "tableHeader",
                                    "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Col B"}]}],
                                },
                            ],
                        },
                        {
                            "type": "tableRow",
                            "content": [
                                {
                                    "type": "tableCell",
                                    "content": [{"type": "paragraph", "content": [{"type": "text", "text": "R1C1"}]}],
                                },
                                {
                                    "type": "tableCell",
                                    "content": [{"type": "paragraph", "content": [{"type": "text", "text": "R1C2"}]}],
                                },
                            ],
                        },
                    ],
                }
            ],
        }
        result = pm_json_to_docx_bytes(pm_json)
        root = self._get_document_xml(result)
        ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
        tables = root.findall(".//w:tbl", ns)
        self.assertGreaterEqual(len(tables), 1, "Should contain at least one table")

        all_text = self._get_all_text(root)
        self.assertIn("Col A", all_text)
        self.assertIn("R1C2", all_text)

    # ── 超链接 ────────────────────────────────────────────────────

    def test_pm_json_to_docx_bytes_hyperlink(self):
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [
                        {
                            "type": "text",
                            "text": "Click here",
                            "marks": [{"type": "link", "attrs": {"href": "https://example.com"}}],
                        },
                    ],
                }
            ],
        }
        result = pm_json_to_docx_bytes(pm_json)
        root = self._get_document_xml(result)
        ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
        hyperlinks = root.findall(".//w:hyperlink", ns)
        self.assertGreaterEqual(len(hyperlinks), 1, "Should contain a w:hyperlink element")

        all_text = self._get_all_text(root)
        self.assertIn("Click here", all_text)

    # ── 数学公式 ──────────────────────────────────────────────────

    def test_pm_json_to_docx_bytes_mathematics(self):
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "mathematics",
                    "attrs": {"latex": "E=mc^2", "display": True},
                },
                {
                    "type": "mathematics",
                    "attrs": {"latex": "x^2", "display": False},
                },
            ],
        }
        result = pm_json_to_docx_bytes(pm_json)
        all_text = self._get_all_text(self._get_document_xml(result))
        self.assertIn("E=mc^2", all_text)
        self.assertIn("x^2", all_text)

    # ── 列表 ─────────────────────────────────────────────────────

    def test_pm_json_to_docx_bytes_lists(self):
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "bulletList",
                    "content": [
                        {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "bullet item"}]}]},
                    ],
                },
                {
                    "type": "taskList",
                    "content": [
                        {"type": "taskItem", "attrs": {"checked": True}, "content": [{"type": "paragraph", "content": [{"type": "text", "text": "done"}]}]},
                        {"type": "taskItem", "attrs": {"checked": False}, "content": [{"type": "paragraph", "content": [{"type": "text", "text": "pending"}]}]},
                    ],
                },
            ],
        }
        result = pm_json_to_docx_bytes(pm_json)
        all_text = self._get_all_text(self._get_document_xml(result))
        self.assertIn("bullet item", all_text)
        self.assertIn("done", all_text)
        self.assertIn("☑", all_text)
        self.assertIn("☐", all_text)

    # ── 代码块 ────────────────────────────────────────────────────

    def test_pm_json_to_docx_bytes_code_block(self):
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "codeBlock",
                    "attrs": {"language": "python"},
                    "content": [{"type": "text", "text": "print('hello')"}],
                }
            ],
        }
        result = pm_json_to_docx_bytes(pm_json)
        all_text = self._get_all_text(self._get_document_xml(result))
        self.assertIn("print('hello')", all_text)
        self.assertIn("[python]", all_text)


    # ── 图片嵌入 ──────────────────────────────────────────────────

    def _make_1x1_png(self) -> bytes:
        """生成一个 1x1 透明 PNG 用于测试。"""
        import struct
        import zlib

        def _chunk(chunk_type: bytes, data: bytes) -> bytes:
            raw = chunk_type + data
            return struct.pack(">I", len(data)) + raw + struct.pack(">I", zlib.crc32(raw) & 0xFFFFFFFF)

        sig = b"\x89PNG\r\n\x1a\n"
        ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
        idat = zlib.compress(b"\x00\x00\x00\x00")
        return sig + _chunk(b"IHDR", ihdr) + _chunk(b"IDAT", idat) + _chunk(b"IEND", b"")

    @patch("apps.tabdoc.services.docx_converter._pinned_get")
    @patch("apps.tabdoc.services.docx_converter._resolve_and_validate_ip", return_value="93.184.216.34")
    def test_image_embed_success(self, _mock_ip, mock_pinned_get):
        png_bytes = self._make_1x1_png()
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.headers = {"Content-Type": "image/png", "Content-Length": str(len(png_bytes))}
        mock_resp.iter_content = MagicMock(return_value=iter([png_bytes]))
        mock_resp.close = MagicMock()
        mock_pinned_get.return_value = mock_resp

        pm_json = {
            "type": "doc",
            "content": [
                {"type": "image", "attrs": {"src": "https://img.example.com/test.png", "alt": "test image"}},
            ],
        }
        result = pm_json_to_docx_bytes(pm_json)
        self.assertTrue(result[:2] == b"PK")

        with zipfile.ZipFile(io.BytesIO(result)) as zf:
            media_files = [n for n in zf.namelist() if n.startswith("word/media/")]
            self.assertGreaterEqual(len(media_files), 1, "Should have embedded image in word/media/")

    @patch("apps.tabdoc.services.docx_converter._pinned_get")
    @patch("apps.tabdoc.services.docx_converter._resolve_and_validate_ip", return_value="93.184.216.34")
    def test_inline_image_embed_success(self, _mock_ip, mock_pinned_get):
        png_bytes = self._make_1x1_png()
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.headers = {"Content-Type": "image/png", "Content-Length": str(len(png_bytes))}
        mock_resp.iter_content = MagicMock(return_value=iter([png_bytes]))
        mock_resp.close = MagicMock()
        mock_pinned_get.return_value = mock_resp

        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [
                        {"type": "text", "text": "before "},
                        {"type": "image", "attrs": {"src": "https://img.example.com/inline.png", "alt": "inline image"}},
                        {"type": "text", "text": " after"},
                    ],
                },
            ],
        }
        result = pm_json_to_docx_bytes(pm_json)
        self.assertTrue(result[:2] == b"PK")

        with zipfile.ZipFile(io.BytesIO(result)) as zf:
            media_files = [n for n in zf.namelist() if n.startswith("word/media/")]
            self.assertGreaterEqual(len(media_files), 1, "Inline image should be embedded in word/media/")

        all_text = self._get_all_text(self._get_document_xml(result))
        self.assertIn("before", all_text)
        self.assertIn("after", all_text)

    @patch("apps.services.oss.services.factory.get_oss_service")
    @patch("apps.services.oss.services.public_assets.public_asset_object_key_from_ref", return_value="tabdoc/images/local.png")
    def test_local_object_image_embed_via_platform_asset_download(self, _mock_object_key, mock_get_oss_service):
        png_bytes = self._make_1x1_png()
        oss_service = MagicMock()
        oss_service.download_file.return_value = {
            "success": True,
            "data": {
                "content": png_bytes,
                "content_type": "image/png",
            },
        }
        mock_get_oss_service.return_value = oss_service

        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "image",
                    "attrs": {
                        "src": "http://127.0.0.1:6060/api/services/oss/local-object?object_key=tabdoc%2Fimages%2Flocal.png",
                        "alt": "local object",
                    },
                },
            ],
        }
        result = pm_json_to_docx_bytes(pm_json)
        self.assertTrue(result[:2] == b"PK")

        with zipfile.ZipFile(io.BytesIO(result)) as zf:
            media_files = [n for n in zf.namelist() if n.startswith("word/media/")]
            self.assertGreaterEqual(len(media_files), 1, "local-object image should be embedded")

        oss_service.download_file.assert_called_once_with("tabdoc/images/local.png")

    @patch("apps.tabdoc.services.docx_converter._pinned_get")
    @patch("apps.tabdoc.services.docx_converter._resolve_and_validate_ip", return_value="93.184.216.34")
    def test_image_embed_timeout_fallback(self, _mock_ip, mock_pinned_get):
        import requests as real_requests
        mock_pinned_get.side_effect = real_requests.exceptions.Timeout("timed out")

        pm_json = {
            "type": "doc",
            "content": [
                {"type": "image", "attrs": {"src": "https://img.example.com/slow.png", "alt": "slow image"}},
            ],
        }
        result = pm_json_to_docx_bytes(pm_json)
        self.assertTrue(result[:2] == b"PK")
        all_text = self._get_all_text(self._get_document_xml(result))
        self.assertIn("[图片: slow image]", all_text)
        self.assertIn("https://img.example.com/slow.png", all_text)

    def test_image_data_uri_embed(self):
        """data:image/png;base64,... should be embedded directly without HTTP."""
        import base64
        png_bytes = self._make_1x1_png()
        b64 = base64.b64encode(png_bytes).decode()
        pm_json = {
            "type": "doc",
            "content": [
                {"type": "image", "attrs": {"src": f"data:image/png;base64,{b64}", "alt": "inline img"}},
            ],
        }
        result = pm_json_to_docx_bytes(pm_json)
        self.assertTrue(result[:2] == b"PK")
        with zipfile.ZipFile(io.BytesIO(result)) as zf:
            media_files = [n for n in zf.namelist() if n.startswith("word/media/")]
            self.assertGreaterEqual(len(media_files), 1, "Data URI image should be embedded in DOCX")

    @patch("apps.services.common.url_security.ssrf_safe_request")
    def test_pinned_get_uses_ssrf_safe_request_with_sni(self, mock_ssrf):
        """外链下载必须走 ssrf_safe_request，避免 IP 钉扎导致 TLS 证书校验失败。"""
        mock_resp = MagicMock()
        mock_ssrf.return_value = mock_resp
        result = _pinned_get(
            "https://cdn.example.com/a.png",
            "93.184.216.34",
            "cdn.example.com",
            timeout=10,
            stream=True,
            allow_redirects=False,
        )
        self.assertIs(result, mock_resp)
        mock_ssrf.assert_called_once_with(
            "GET",
            "https://cdn.example.com/a.png",
            allow_redirects=False,
            timeout=10,
            stream=True,
        )

    def test_image_bytes_to_data_uri_detects_png(self):
        png = self._make_1x1_png()
        uri = image_bytes_to_data_uri(png)
        self.assertTrue(uri.startswith("data:image/png;base64,"))

    def test_normalize_image_bytes_for_docx_passes_2x_supersample(self):
        """DOCX SVG 栅格化应对齐 TabSlide，默认 2x 超采样。"""
        svg = b'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>'
        png = self._make_1x1_png()
        with patch(
            "apps.tabslide.services.pptx_io._normalize_image_bytes_for_pptx",
            return_value=png,
        ) as mock_pptx:
            result = _normalize_image_bytes_for_docx(
                svg,
                src_hint="diagram.svg",
                target_width_px=320,
                target_height_px=160,
            )
        self.assertEqual(result, png)
        self.assertEqual(_DOCX_SVG_SUPERSAMPLE, 2.0)
        mock_pptx.assert_called_once_with(
            svg,
            src_hint="diagram.svg",
            target_width_px=320.0,
            target_height_px=160.0,
            supersample=2.0,
        )

    def test_image_data_uri_svg_rasterized_and_embedded(self):
        """SVG data URI（含 charset=utf-8，对话拖入常见形态）应栅格化为 PNG 后嵌入。"""
        import base64
        from urllib.parse import quote

        png_bytes = self._make_1x1_png()
        svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>'
        charset_src = f"data:image/svg+xml;charset=utf-8,{quote(svg)}"
        b64_src = "data:image/svg+xml;base64," + base64.b64encode(svg.encode("utf-8")).decode("ascii")

        with patch(
            "apps.tabdoc.services.docx_converter._normalize_image_bytes_for_docx",
            return_value=png_bytes,
        ) as mock_normalize:
            for src, alt in ((charset_src, "svg-charset"), (b64_src, "svg-b64")):
                with self.subTest(alt=alt):
                    pm_json = {
                        "type": "doc",
                        "content": [
                            {"type": "image", "attrs": {"src": src, "alt": alt}},
                        ],
                    }
                    result = pm_json_to_docx_bytes(pm_json)
                    self.assertTrue(result[:2] == b"PK")
                    with zipfile.ZipFile(io.BytesIO(result)) as zf:
                        media_files = [n for n in zf.namelist() if n.startswith("word/media/")]
                        self.assertGreaterEqual(len(media_files), 1, f"{alt} should embed after rasterize")
                    all_text = self._get_all_text(self._get_document_xml(result))
                    self.assertNotIn(f"[图片: {alt}]", all_text)

        self.assertGreaterEqual(mock_normalize.call_count, 2)

    def test_image_data_uri_svg_stays_placeholder_when_rasterize_fails(self):
        """栅格化失败时仍降级为占位文字，不把原始 SVG 塞进 python-docx。"""
        from urllib.parse import quote

        svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
        src = f"data:image/svg+xml;charset=utf-8,{quote(svg)}"
        with patch(
            "apps.tabdoc.services.docx_converter._normalize_image_bytes_for_docx",
            return_value=svg.encode("utf-8"),
        ):
            pm_json = {
                "type": "doc",
                "content": [
                    {"type": "image", "attrs": {"src": src, "alt": "svg"}},
                ],
            }
            result = pm_json_to_docx_bytes(pm_json)
            all_text = self._get_all_text(self._get_document_xml(result))
            self.assertIn("[图片: svg]", all_text)

    @patch("apps.tabdoc.services.docx_converter._pinned_get")
    @patch("apps.tabdoc.services.docx_converter._resolve_and_validate_ip", return_value="93.184.216.34")
    def test_remote_svg_rasterized_and_embedded(self, _mock_ip, mock_pinned_get):
        """远程/OSS SVG（content-type=image/svg+xml）下载后应栅格化再嵌入。"""
        svg = b'<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><circle r="4" fill="blue"/></svg>'
        png_bytes = self._make_1x1_png()
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.headers = {"Content-Type": "image/svg+xml", "Content-Length": str(len(svg))}
        mock_resp.iter_content = MagicMock(return_value=iter([svg]))
        mock_resp.close = MagicMock()
        mock_pinned_get.return_value = mock_resp

        with patch(
            "apps.tabdoc.services.docx_converter._normalize_image_bytes_for_docx",
            return_value=png_bytes,
        ) as mock_normalize:
            pm_json = {
                "type": "doc",
                "content": [
                    {"type": "image", "attrs": {"src": "https://img.example.com/diagram.svg", "alt": "remote-svg"}},
                ],
            }
            result = pm_json_to_docx_bytes(pm_json)
            self.assertTrue(result[:2] == b"PK")
            with zipfile.ZipFile(io.BytesIO(result)) as zf:
                media_files = [n for n in zf.namelist() if n.startswith("word/media/")]
                self.assertGreaterEqual(len(media_files), 1)
            all_text = self._get_all_text(self._get_document_xml(result))
            self.assertNotIn("[图片: remote-svg]", all_text)
            mock_normalize.assert_called()
            self.assertTrue(mock_normalize.call_args.args[0].startswith(b"<svg"))

    @patch("apps.tabdoc.services.docx_converter._resolve_and_validate_ip", return_value=None)
    def test_image_private_ip_blocked(self, _mock_ip):
        pm_json = {
            "type": "doc",
            "content": [
                {"type": "image", "attrs": {"src": "http://169.254.169.254/metadata", "alt": ""}},
            ],
        }
        result = pm_json_to_docx_bytes(pm_json)
        self.assertTrue(result[:2] == b"PK")
        all_text = self._get_all_text(self._get_document_xml(result))
        self.assertIn("[图片]", all_text)


    # ── Round 3: tabdataBlock ─────────────────────────────────────

    def test_pm_json_to_docx_tabdata_block(self):
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "tabdataBlock",
                    "attrs": {"tableId": "tbl-001", "title": "销售数据"},
                },
            ],
        }
        result = pm_json_to_docx_bytes(pm_json)
        self.assertTrue(result[:2] == b"PK")
        all_text = self._get_all_text(self._get_document_xml(result))
        self.assertIn("[表格: 销售数据]", all_text)

    def test_pm_json_to_docx_tabdata_block_default_title(self):
        pm_json = {
            "type": "doc",
            "content": [
                {"type": "tabdataBlock", "attrs": {"tableId": "tbl-002"}},
            ],
        }
        result = pm_json_to_docx_bytes(pm_json)
        all_text = self._get_all_text(self._get_document_xml(result))
        self.assertIn("[表格: 未命名表格]", all_text)

    # ── : htmlBlock docx 占位 ────────────────────────────────

    def test_pm_json_to_docx_htmlblock(self):
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "htmlBlock",
                    "attrs": {"fileId": "f1", "src": "https://x.com/a.html", "title": "架构图"},
                },
            ],
        }
        result = pm_json_to_docx_bytes(pm_json)
        self.assertTrue(result[:2] == b"PK")
        all_text = self._get_all_text(self._get_document_xml(result))
        self.assertIn("[HTML: 架构图]", all_text)

    def test_pm_json_to_docx_htmlblock_default_title(self):
        pm_json = {
            "type": "doc",
            "content": [
                {"type": "htmlBlock", "attrs": {"fileId": "f2"}},
            ],
        }
        result = pm_json_to_docx_bytes(pm_json)
        all_text = self._get_all_text(self._get_document_xml(result))
        self.assertIn("[HTML: 未命名 HTML]", all_text)

    # ── Round 3: 重定向 SSRF 防护 ────────────────────────────────

    @patch("apps.tabdoc.services.docx_converter._pinned_get")
    @patch("apps.tabdoc.services.docx_converter._resolve_and_validate_ip", return_value="93.184.216.34")
    def test_image_redirect_blocked(self, _mock_ip, mock_pinned_get):
        mock_resp = MagicMock()
        mock_resp.status_code = 302
        mock_resp.headers = {"Location": "http://192.168.1.1/secret"}
        mock_resp.close = MagicMock()
        mock_pinned_get.return_value = mock_resp

        pm_json = {
            "type": "doc",
            "content": [
                {"type": "image", "attrs": {"src": "https://evil.com/redirect.png", "alt": "redir"}},
            ],
        }
        result = pm_json_to_docx_bytes(pm_json)
        self.assertTrue(result[:2] == b"PK")
        all_text = self._get_all_text(self._get_document_xml(result))
        self.assertIn("[图片: redir]", all_text)

    # ── Round 3: bold/italic mark 兼容 ───────────────────────────

    def test_pm_json_to_docx_bold_italic_compat(self):
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [
                        {"type": "text", "text": "bold", "marks": [{"type": "bold"}]},
                        {"type": "text", "text": " and "},
                        {"type": "text", "text": "italic", "marks": [{"type": "italic"}]},
                    ],
                }
            ],
        }
        result = pm_json_to_docx_bytes(pm_json)
        all_text = self._get_all_text(self._get_document_xml(result))
        self.assertIn("bold", all_text)
        self.assertIn("italic", all_text)


    # ── DC-2: base64 内存 DoS 防护 ──────────────────────────────

    def test_data_uri_oversized_base64_rejected_before_decode(self):
        """DC-2: 超大 base64 字符串应在 decode 前被估算大小拒绝。"""
        from apps.tabdoc.services.docx_converter import _MAX_IMAGE_BYTES

        safe_b64_char_count = (_MAX_IMAGE_BYTES + 1) * 4 // 3 + 4
        huge_b64 = "A" * safe_b64_char_count
        data_uri = f"data:image/png;base64,{huge_b64}"

        pm_json = {
            "type": "doc",
            "content": [
                {"type": "image", "attrs": {"src": data_uri, "alt": "bomb"}},
            ],
        }
        result = pm_json_to_docx_bytes(pm_json)
        self.assertTrue(result[:2] == b"PK")
        all_text = self._get_all_text(self._get_document_xml(result))
        self.assertIn("[图片: bomb]", all_text)

    def test_data_uri_small_base64_still_works(self):
        """DC-2: 合法小体积 base64 仍可正常嵌入。"""
        import base64
        png_bytes = self._make_1x1_png()
        b64 = base64.b64encode(png_bytes).decode()
        pm_json = {
            "type": "doc",
            "content": [
                {"type": "image", "attrs": {"src": f"data:image/png;base64,{b64}", "alt": "tiny"}},
            ],
        }
        result = pm_json_to_docx_bytes(pm_json)
        self.assertTrue(result[:2] == b"PK")
        with zipfile.ZipFile(io.BytesIO(result)) as zf:
            media_files = [n for n in zf.namelist() if n.startswith("word/media/")]
            self.assertGreaterEqual(len(media_files), 1)


    # ── DC-4: 表格单元格内图片嵌入 ──────────────────────────────

    @patch("apps.tabdoc.services.docx_converter._pinned_get")
    @patch("apps.tabdoc.services.docx_converter._resolve_and_validate_ip", return_value="93.184.216.34")
    def test_dc4_table_cell_image_embed(self, _mock_ip, mock_pinned_get):
        """DC-4: 表格单元格内的图片应嵌入而非降级为占位符。"""
        png_bytes = self._make_1x1_png()
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.headers = {"Content-Type": "image/png", "Content-Length": str(len(png_bytes))}
        mock_resp.iter_content = MagicMock(return_value=iter([png_bytes]))
        mock_resp.close = MagicMock()
        mock_pinned_get.return_value = mock_resp

        pm_json = {
            "type": "doc",
            "content": [{
                "type": "table",
                "content": [{
                    "type": "tableRow",
                    "content": [{
                        "type": "tableCell",
                        "content": [
                            {"type": "image", "attrs": {"src": "https://img.example.com/cell.png", "alt": "cell img"}},
                        ],
                    }],
                }],
            }],
        }
        result = pm_json_to_docx_bytes(pm_json)
        self.assertTrue(result[:2] == b"PK")

        with zipfile.ZipFile(io.BytesIO(result)) as zf:
            media_files = [n for n in zf.namelist() if n.startswith("word/media/")]
            self.assertGreaterEqual(len(media_files), 1, "Cell image should be embedded in word/media/")

        all_text = self._get_all_text(self._get_document_xml(result))
        self.assertNotIn("[图片: cell img]", all_text, "Should NOT fall back to placeholder text")

    def test_dc4_table_cell_image_fallback(self):
        """DC-4: 无法下载时仍正常 fallback 到占位符。"""
        pm_json = {
            "type": "doc",
            "content": [{
                "type": "table",
                "content": [{
                    "type": "tableRow",
                    "content": [{
                        "type": "tableCell",
                        "content": [
                            {"type": "image", "attrs": {"src": "", "alt": "missing"}},
                        ],
                    }],
                }],
            }],
        }
        result = pm_json_to_docx_bytes(pm_json)
        all_text = self._get_all_text(self._get_document_xml(result))
        self.assertIn("[图片: missing]", all_text)

    # ── DC-5: 表格合并单元格 ──────────────────────────────────────

    def test_dc5_table_colspan(self):
        """DC-5: colspan=2 的单元格应在 DOCX 中生成合并单元格。"""
        pm_json = {
            "type": "doc",
            "content": [{
                "type": "table",
                "content": [
                    {
                        "type": "tableRow",
                        "content": [{
                            "type": "tableHeader",
                            "attrs": {"colspan": 2, "rowspan": 1},
                            "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Merged Header"}]}],
                        }],
                    },
                    {
                        "type": "tableRow",
                        "content": [
                            {"type": "tableCell", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "A"}]}]},
                            {"type": "tableCell", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "B"}]}]},
                        ],
                    },
                ],
            }],
        }
        result = pm_json_to_docx_bytes(pm_json)
        root = self._get_document_xml(result)
        ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}

        all_text = self._get_all_text(root)
        self.assertIn("Merged Header", all_text)
        self.assertIn("A", all_text)
        self.assertIn("B", all_text)

        grid_spans = root.findall(".//w:tcPr/w:gridSpan", ns)
        span_values = [gs.get(f"{{{ns['w']}}}val") for gs in grid_spans]
        self.assertTrue(
            any(v == "2" for v in span_values),
            f"Should contain gridSpan=2 for colspan, found: {span_values}",
        )

    def test_dc5_table_rowspan(self):
        """DC-5: rowspan=2 的单元格应产生 vMerge 合并。"""
        pm_json = {
            "type": "doc",
            "content": [{
                "type": "table",
                "content": [
                    {
                        "type": "tableRow",
                        "content": [
                            {"type": "tableCell", "attrs": {"colspan": 1, "rowspan": 2},
                             "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Span"}]}]},
                            {"type": "tableCell", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "R1C2"}]}]},
                        ],
                    },
                    {
                        "type": "tableRow",
                        "content": [
                            {"type": "tableCell", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "R2C2"}]}]},
                        ],
                    },
                ],
            }],
        }
        result = pm_json_to_docx_bytes(pm_json)
        root = self._get_document_xml(result)
        ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}

        all_text = self._get_all_text(root)
        self.assertIn("Span", all_text)
        self.assertIn("R1C2", all_text)
        self.assertIn("R2C2", all_text)

        v_merges = root.findall(".//w:tcPr/w:vMerge", ns)
        self.assertGreaterEqual(len(v_merges), 1, "Should contain vMerge elements for rowspan")

    # ── DC-6: 超链接 marks 完整应用 ──────────────────────────────

    def test_dc6_hyperlink_strike_mark(self):
        """DC-6: 超链接文字带 strike mark 时应在 DOCX 中包含删除线。"""
        pm_json = {
            "type": "doc",
            "content": [{
                "type": "paragraph",
                "content": [{
                    "type": "text",
                    "text": "stricken link",
                    "marks": [
                        {"type": "link", "attrs": {"href": "https://example.com"}},
                        {"type": "strike"},
                    ],
                }],
            }],
        }
        result = pm_json_to_docx_bytes(pm_json)
        root = self._get_document_xml(result)
        ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}

        all_text = self._get_all_text(root)
        self.assertIn("stricken link", all_text)

        hyperlinks = root.findall(".//w:hyperlink", ns)
        self.assertGreaterEqual(len(hyperlinks), 1)
        strike_elems = root.findall(".//w:hyperlink//w:rPr/w:strike", ns)
        self.assertGreaterEqual(len(strike_elems), 1, "Hyperlink run should have w:strike element")

    def test_dc6_hyperlink_code_mark(self):
        """DC-6: 超链接文字带 code mark 时应设置 Courier New 字体。"""
        pm_json = {
            "type": "doc",
            "content": [{
                "type": "paragraph",
                "content": [{
                    "type": "text",
                    "text": "code_link",
                    "marks": [
                        {"type": "link", "attrs": {"href": "https://example.com"}},
                        {"type": "code"},
                    ],
                }],
            }],
        }
        result = pm_json_to_docx_bytes(pm_json)
        root = self._get_document_xml(result)
        ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}

        all_text = self._get_all_text(root)
        self.assertIn("code_link", all_text)

        rfonts = root.findall(".//w:hyperlink//w:rPr/w:rFonts", ns)
        font_names = [rf.get(f"{{{ns['w']}}}ascii", "") for rf in rfonts]
        self.assertTrue(
            any("Courier" in fn for fn in font_names),
            f"Hyperlink with code mark should use Courier font, found: {font_names}",
        )

    def test_dc6_hyperlink_bold_italic_still_works(self):
        """DC-6: 重构后 bold+italic 仍然正常工作。"""
        pm_json = {
            "type": "doc",
            "content": [{
                "type": "paragraph",
                "content": [{
                    "type": "text",
                    "text": "bold italic link",
                    "marks": [
                        {"type": "link", "attrs": {"href": "https://example.com"}},
                        {"type": "bold"},
                        {"type": "italic"},
                    ],
                }],
            }],
        }
        result = pm_json_to_docx_bytes(pm_json)
        root = self._get_document_xml(result)
        ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}

        b_elems = root.findall(".//w:hyperlink//w:rPr/w:b", ns)
        i_elems = root.findall(".//w:hyperlink//w:rPr/w:i", ns)
        self.assertGreaterEqual(len(b_elems), 1, "Bold should still work on hyperlinks")
        self.assertGreaterEqual(len(i_elems), 1, "Italic should still work on hyperlinks")


if __name__ == "__main__":
    unittest.main()
