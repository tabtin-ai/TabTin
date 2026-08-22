"""
Wave 2 P1 回归测试 — DP-011 / DP-012 / DP-014 / DP-017
"""
import os
import tempfile
import zipfile
from unittest.mock import MagicMock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402
django.setup()

from django.test import TestCase  # noqa: E402


def _read_source(relpath: str) -> str:
    base = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(base, relpath)) as f:
        return f.read()


# ======================================================================
# DP-011: _stream_parse_pdf finally 块 NameError 防护
# ======================================================================

class DP011FitzOpenFailureSafetyTest(TestCase):
    """fitz.open 或 pdfplumber.open 失败时 finally 块不应抛 NameError。"""

    databases = []

    def test_finally_uses_safe_none_check(self):
        source = _read_source("service.py")
        self.assertIn("doc = None", source)
        self.assertIn("plumber_pdf = None", source)
        self.assertIn("if plumber_pdf is not None", source)
        self.assertIn("if doc is not None", source)

    @patch("apps.services.docparse.service._resolve_billing_context", return_value=("", ""))
    def test_fitz_open_failure_no_nameerror(self, _mock_billing):
        from apps.services.docparse.service import _stream_parse_pdf

        mock_parsed_doc = MagicMock()
        mock_parsed_doc.file_record_id = "test-id"

        mock_fitz = MagicMock()
        mock_fitz.open.side_effect = RuntimeError("corrupted PDF")
        mock_plumber = MagicMock()

        with patch.dict("sys.modules", {"fitz": mock_fitz, "pdfplumber": mock_plumber}):
            with patch(
                "apps.services.docparse.parsers.pdf_parser.PDFParser",
                return_value=MagicMock(),
            ):
                with self.assertRaises(RuntimeError) as ctx:
                    _stream_parse_pdf(mock_parsed_doc, "/nonexistent.pdf", "model", 0)
                self.assertIn("corrupted PDF", str(ctx.exception))

    @patch("apps.services.docparse.service._resolve_billing_context", return_value=("", ""))
    def test_pdfplumber_open_failure_closes_fitz_doc(self, _mock_billing):
        from apps.services.docparse.service import _stream_parse_pdf

        mock_parsed_doc = MagicMock()
        mock_parsed_doc.file_record_id = "test-id"

        mock_fitz_module = MagicMock()
        mock_doc = MagicMock()
        mock_fitz_module.open.return_value = mock_doc

        mock_plumber_module = MagicMock()
        mock_plumber_module.open.side_effect = RuntimeError("plumber fail")

        with patch.dict("sys.modules", {"fitz": mock_fitz_module, "pdfplumber": mock_plumber_module}):
            with patch(
                "apps.services.docparse.parsers.pdf_parser.PDFParser",
                return_value=MagicMock(),
            ):
                with self.assertRaises(RuntimeError):
                    _stream_parse_pdf(mock_parsed_doc, "/nonexistent.pdf", "model", 0)
                mock_doc.close.assert_called_once()


# ======================================================================
# DP-012: parse_async cache.add 原子 dedup（先 cache 后 DB）
# ======================================================================

class DP012AtomicDedupTest(TestCase):
    """cache.add 应为 dedup 第一道门控，先于 DB 状态检查。"""

    databases = []

    def test_cache_add_precedes_db_check(self):
        source = _read_source("service.py")
        cache_add_pos = source.index("cache.add(dedup_key")
        db_check_pos = source.index(
            "existing in (ParsedDocument.Status.READY, ParsedDocument.Status.PARSING)"
        )
        self.assertLess(
            cache_add_pos, db_check_pos,
            "cache.add 必须先于 DB 状态检查执行",
        )

    def test_clears_dedup_key_when_status_ready(self):
        source = _read_source("service.py")
        lines = source.split("\n")
        in_parse_async = False
        found_clear_after_status_check = False
        for line in lines:
            if "def parse_async" in line:
                in_parse_async = True
            elif in_parse_async and "_clear_async_dedup" in line:
                found_clear_after_status_check = True
                break
            elif in_parse_async and line.strip().startswith("def ") and "parse_async" not in line:
                break
        self.assertTrue(
            found_clear_after_status_check,
            "当状态为 READY/PARSING 时应清除 dedup key",
        )


# ======================================================================
# DP-014: SoftTimeLimitExceeded 处理中同步更新 updated_at
# ======================================================================

class DP014SoftTimeoutUpdatedAtTest(TestCase):
    """SoftTimeLimitExceeded handler 必须显式更新 updated_at。"""

    databases = []

    def test_timeout_handler_sets_updated_at(self):
        source = _read_source("tasks.py")
        lines = source.split("\n")
        in_timeout_block = False
        found_updated_at = False
        for line in lines:
            if "except SoftTimeLimitExceeded" in line:
                in_timeout_block = True
            elif in_timeout_block and "updated_at=" in line:
                found_updated_at = True
                break
            elif in_timeout_block and line.strip().startswith("except "):
                break
        self.assertTrue(
            found_updated_at,
            "SoftTimeLimitExceeded 处理中必须显式设置 updated_at",
        )

    def test_timeout_handler_uses_timezone_now(self):
        source = _read_source("tasks.py")
        lines = source.split("\n")
        in_timeout_block = False
        for line in lines:
            if "except SoftTimeLimitExceeded" in line:
                in_timeout_block = True
            elif in_timeout_block and "updated_at=" in line:
                self.assertIn("now()", line)
                return
            elif in_timeout_block and line.strip().startswith("except "):
                break
        self.fail("未找到 updated_at=...now() 语句")


# ======================================================================
# DP-017: Office 格式 zip bomb 防护
# ======================================================================

class DP017ZipBombProtectionTest(TestCase):
    """zip bomb 检测和文件大小限制。"""

    databases = []

    def test_max_file_size_constant_exists(self):
        from apps.services.docparse.service import MAX_FILE_SIZE
        self.assertIsInstance(MAX_FILE_SIZE, int)
        self.assertGreater(MAX_FILE_SIZE, 0)

    def test_max_file_size_default_100mb(self):
        from apps.services.docparse.service import MAX_FILE_SIZE
        self.assertEqual(MAX_FILE_SIZE, 100 * 1024 * 1024)

    def test_zip_bomb_ratio_constant_exists(self):
        from apps.services.docparse import service
        self.assertTrue(hasattr(service, "_ZIP_BOMB_RATIO"))
        self.assertGreater(service._ZIP_BOMB_RATIO, 0)

    def test_detect_zip_subtype_rejects_high_ratio_bomb(self):
        """构造一个压缩比极高的 ZIP 来触发 zip bomb 检测。"""
        from apps.services.docparse.service import (
            _detect_zip_subtype,
            _ZIP_BOMB_RATIO,
        )

        bomb_path = None
        try:
            with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as tmp:
                bomb_path = tmp.name

            with zipfile.ZipFile(bomb_path, "w", zipfile.ZIP_DEFLATED) as zf:
                # \x00 bytes compress extremely well, creating high ratio
                huge_data = b"\x00" * (200 * 1024 * 1024)
                zf.writestr("word/document.xml", huge_data)

            with self.assertRaises(ValueError) as ctx:
                _detect_zip_subtype(bomb_path)
            error_msg = str(ctx.exception)
            self.assertTrue(
                "zip bomb" in error_msg or "超过上限" in error_msg,
                f"Expected zip bomb / size limit error, got: {error_msg}",
            )
        finally:
            if bomb_path and os.path.exists(bomb_path):
                os.unlink(bomb_path)

    def test_detect_zip_subtype_normal_docx_passes(self):
        from apps.services.docparse.service import _detect_zip_subtype

        docx_path = None
        try:
            with tempfile.NamedTemporaryFile(suffix=".docx", delete=False) as tmp:
                docx_path = tmp.name
            with zipfile.ZipFile(docx_path, "w", zipfile.ZIP_DEFLATED) as zf:
                zf.writestr("word/document.xml", "<w:document/>")
                zf.writestr("[Content_Types].xml", "<Types/>")

            result = _detect_zip_subtype(docx_path)
            self.assertEqual(
                result,
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            )
        finally:
            if docx_path and os.path.exists(docx_path):
                os.unlink(docx_path)

    def test_parse_entry_rejects_oversized_file(self):
        source = _read_source("service.py")
        self.assertIn("file_size > MAX_FILE_SIZE", source)
        self.assertIn("文件过大", source)
