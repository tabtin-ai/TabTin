"""
F15 测试 — docparse 异常信息泄露修复 (DP-015 / DP-016)

验证：
1. VisionParser._fallback_error 的 content 不含原始异常详情
2. VisionParser._fallback_error 的 metadata 包含 is_error=True + error_detail
3. PDFParser._extract_via_vision 异常时 content 不含原始异常详情
4. PDFParser._extract_via_vision 异常时 metadata 包含 is_error=True + error_detail
5. 正常 Vision 解析结果不受影响（无 is_error 标记）
"""

import os
import re
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

SRC_DIR = os.path.dirname(os.path.abspath(__file__))


def _read_source(relpath: str) -> str:
    with open(os.path.join(SRC_DIR, relpath)) as f:
        return f.read()


# ------------------------------------------------------------------
# 源码静态检查
# ------------------------------------------------------------------

class TestDP015SourceSanitization:
    """DP-015: 确认错误 chunk 不含原始异常字符串"""

    def test_vision_fallback_no_raw_error_in_content(self):
        src = _read_source("parsers/vision_parser.py")
        lines = src.split("\n")
        in_fallback = False
        for line in lines:
            if "def _fallback_error" in line:
                in_fallback = True
            if in_fallback and "content=" in line:
                assert "{error}" not in line, (
                    "_fallback_error 的 content 不应包含 {error} 插值"
                )
                break

    def test_pdf_vision_fallback_no_raw_error_in_content(self):
        src = _read_source("parsers/pdf_parser.py")
        lines = src.split("\n")
        in_except = False
        for line in lines:
            if "except Exception as exc:" in line and "Vision" in src[src.index(line) - 200:src.index(line)]:
                in_except = True
            if in_except and "content=" in line:
                assert "{exc}" not in line, (
                    "_extract_via_vision 的 except 块 content 不应包含 {exc} 插值"
                )
                break


class TestDP016ErrorMetadata:
    """DP-016: 错误 chunk 必须带 is_error=True 标记"""

    def test_vision_fallback_has_is_error(self):
        src = _read_source("parsers/vision_parser.py")
        assert '"is_error": True' in src or "'is_error': True" in src

    def test_pdf_vision_fallback_has_is_error(self):
        src = _read_source("parsers/pdf_parser.py")
        assert '"is_error": True' in src or "'is_error': True" in src

    def test_vision_fallback_has_error_detail(self):
        src = _read_source("parsers/vision_parser.py")
        assert "error_detail" in src

    def test_pdf_vision_fallback_has_error_detail(self):
        src = _read_source("parsers/pdf_parser.py")
        assert "error_detail" in src


# ------------------------------------------------------------------
# VisionParser._fallback_error 行为测试
# ------------------------------------------------------------------

class TestVisionFallbackError:
    """DP-015: VisionParser._fallback_error 不泄露异常详情到 content"""

    def test_content_is_generic_message(self):
        from apps.services.docparse.parsers.vision_parser import VisionParser

        sensitive_error = "AuthenticationError: Invalid API key sk-proj-abc123xyz"
        chunks = VisionParser._fallback_error(sensitive_error)

        assert len(chunks) == 1
        chunk = chunks[0]
        assert "sk-proj" not in chunk.content
        assert "API key" not in chunk.content
        assert "AuthenticationError" not in chunk.content
        assert "abc123xyz" not in chunk.content

    def test_metadata_contains_is_error(self):
        from apps.services.docparse.parsers.vision_parser import VisionParser

        chunks = VisionParser._fallback_error("some error")
        chunk = chunks[0]
        assert chunk.metadata.get("is_error") is True

    def test_metadata_contains_error_detail(self):
        from apps.services.docparse.parsers.vision_parser import VisionParser

        error_msg = "TimeoutError: VLM API 超时"
        chunks = VisionParser._fallback_error(error_msg)
        chunk = chunks[0]
        assert chunk.metadata.get("error_detail") == error_msg

    def test_content_is_user_friendly(self):
        from apps.services.docparse.parsers.vision_parser import VisionParser

        chunks = VisionParser._fallback_error("内部错误")
        chunk = chunks[0]
        assert "请重试" in chunk.content or "联系支持" in chunk.content


# ------------------------------------------------------------------
# PDFParser._extract_via_vision 行为测试
# ------------------------------------------------------------------

class TestPDFVisionFallbackError:
    """DP-015: PDFParser._extract_via_vision 异常时不泄露异常详情到 content"""

    def _make_fitz_page(self):
        page = MagicMock()
        page.rect = SimpleNamespace(width=612.0, height=792.0)
        page.get_pixmap.side_effect = RuntimeError(
            "API Error: invalid key sk-live-secret123"
        )
        return page

    def test_content_no_api_key_leak(self):
        from apps.services.docparse.parsers.pdf_parser import PDFParser

        parser = PDFParser()
        parser._billing_user_id = "test-user"
        parser._billing_organization_id = "test-ws"
        page = self._make_fitz_page()

        chunks = parser._extract_via_vision(page, 0, "test-model")

        assert len(chunks) == 1
        chunk = chunks[0]
        assert "sk-live-secret123" not in chunk.content
        assert "invalid key" not in chunk.content
        assert "API Error" not in chunk.content

    def test_metadata_has_is_error_flag(self):
        from apps.services.docparse.parsers.pdf_parser import PDFParser

        parser = PDFParser()
        page = self._make_fitz_page()

        chunks = parser._extract_via_vision(page, 0, "test-model")
        chunk = chunks[0]
        assert chunk.metadata.get("is_error") is True

    def test_metadata_has_error_detail(self):
        from apps.services.docparse.parsers.pdf_parser import PDFParser

        parser = PDFParser()
        page = self._make_fitz_page()

        chunks = parser._extract_via_vision(page, 0, "test-model")
        chunk = chunks[0]
        assert "sk-live-secret123" in chunk.metadata.get("error_detail", "")

    def test_content_is_user_friendly(self):
        from apps.services.docparse.parsers.pdf_parser import PDFParser

        parser = PDFParser()
        page = self._make_fitz_page()

        chunks = parser._extract_via_vision(page, 0, "test-model")
        chunk = chunks[0]
        assert "请重试" in chunk.content or "联系支持" in chunk.content


# ------------------------------------------------------------------
# 正常路径回归测试：正常 chunk 不受影响
# ------------------------------------------------------------------

class TestNormalChunksUnaffected:
    """回归：正常 Vision 输出的 chunk 不应有 is_error 标记"""

    def test_successful_parse_no_is_error(self):
        from apps.services.docparse.parsers.vision_parser import VisionParser

        parser = VisionParser(model="test-model")
        raw_json = '{"blocks": [{"type": "paragraph", "content": "Hello world", "bbox": [0, 0, 500, 100]}]}'
        chunks = parser._parse_response(raw_json, 1, 612, 792, "test-model")

        assert len(chunks) >= 1
        for chunk in chunks:
            assert chunk.metadata.get("is_error") is not True
            assert "error_detail" not in chunk.metadata

    def test_raw_text_fallback_no_is_error(self):
        from apps.services.docparse.parsers.vision_parser import VisionParser

        parser = VisionParser(model="test-model")
        chunks = parser._parse_response("这是纯文本，不是 JSON", 1, 612, 792, "test-model")

        assert len(chunks) == 1
        assert chunks[0].metadata.get("is_error") is not True
