"""旧版 .doc 转换与 DocxParser 接入测试。"""

from __future__ import annotations

import os
import tempfile
import unittest
import zipfile
from unittest.mock import Mock, patch

from apps.services.docparse.parsers.docx_parser import DocxParser, _validate_docx_safe
from apps.services.docparse.parsers.legacy_doc_convert import (
    LEGACY_DOC_UNSUPPORTED_MSG,
    UNRECOGNIZED_WORD_PAYLOAD_MSG,
    _MSO_AUTOMATION_SECURITY_FORCE_DISABLE,
    _build_word_com_ps_script,
    _convert_with_word_com,
    convert_legacy_doc_to_docx,
    detect_word_payload_kind,
    extract_rtf_plaintext,
    is_legacy_ole_doc,
)


def _write_ole_stub(path: str, extra: bytes = b"\x00" * 64) -> None:
    with open(path, "wb") as handle:
        handle.write(b"\xd0\xcf\x11\xe0" + extra)


def _make_minimal_docx(path: str) -> None:
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            "</Types>",
        )
        zf.writestr(
            "word/document.xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            "<w:body><w:p><w:r><w:t>hello from converted doc</w:t></w:r></w:p></w:body>"
            "</w:document>",
        )


class LegacyDocDetectTests(unittest.TestCase):
    def test_detects_ole_magic(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "a.doc")
            _write_ole_stub(path)
            self.assertTrue(is_legacy_ole_doc(path))

    def test_docx_zip_is_not_legacy(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "a.docx")
            _make_minimal_docx(path)
            self.assertFalse(is_legacy_ole_doc(path))


class LegacyDocConvertFallbackTests(unittest.TestCase):
    @patch("apps.services.docparse.parsers.legacy_doc_convert._resolve_winword", return_value=None)
    @patch("apps.services.docparse.parsers.legacy_doc_convert._resolve_soffice", return_value=None)
    def test_raises_clear_message_when_no_converter(self, _soffice, _word):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "a.doc")
            _write_ole_stub(path)
            with self.assertRaises(ValueError) as ctx:
                convert_legacy_doc_to_docx(path)
            self.assertIn("暂不支持直接解析旧版 Word", str(ctx.exception))
            self.assertIn(LEGACY_DOC_UNSUPPORTED_MSG[:12], str(ctx.exception))


class WordComAutomationSecurityTests(unittest.TestCase):
    """P1：Word COM 打开不可信 .doc 前必须 ForceDisable 宏。"""

    def test_ps_script_force_disables_macros_before_open(self):
        script = _build_word_com_ps_script(r"C:\in\evil.doc", r"C:\out\safe.docx")
        open_idx = script.find("Documents.Open(")
        set_idx = script.find("$word.AutomationSecurity = ")
        self.assertNotEqual(open_idx, -1, "脚本必须调用 Documents.Open")
        self.assertNotEqual(set_idx, -1, "脚本必须设置 AutomationSecurity")
        self.assertLess(
            set_idx,
            open_idx,
            "AutomationSecurity 必须在 Documents.Open 之前设置",
        )
        self.assertIn(
            f"$word.AutomationSecurity = {_MSO_AUTOMATION_SECURITY_FORCE_DISABLE}",
            script,
        )
        self.assertEqual(_MSO_AUTOMATION_SECURITY_FORCE_DISABLE, 3)

    def test_ps_script_restores_automation_security_in_finally(self):
        script = _build_word_com_ps_script(r"C:\in\a.doc", r"C:\out\a.docx")
        self.assertIn("$prevAutomationSecurity = $word.AutomationSecurity", script)
        restore = "$word.AutomationSecurity = $prevAutomationSecurity"
        restore_idx = script.find(restore)
        quit_idx = script.find("$word.Quit(")
        self.assertNotEqual(restore_idx, -1, "finally 必须恢复 AutomationSecurity")
        self.assertNotEqual(quit_idx, -1)
        self.assertLess(restore_idx, quit_idx, "应在 Quit 前恢复原 AutomationSecurity")
        self.assertIn("finally {", script.replace("\r\n", "\n"))

    @patch("apps.services.docparse.parsers.legacy_doc_convert.subprocess.run")
    def test_convert_passes_force_disable_script_to_powershell(self, mock_run):
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "a.doc")
            _write_ole_stub(src)
            out_docx = os.path.join(tmp, "out.docx")
            _make_minimal_docx(out_docx)

            def _fake_run(cmd, **_kwargs):
                # 副作用：写出目标 .docx，模拟 Word 成功
                dest = None
                script = cmd[-1]
                for line in script.splitlines():
                    if line.strip().startswith("$dst = "):
                        dest = line.split("=", 1)[1].strip().strip("'")
                        break
                self.assertIsNotNone(dest)
                self.assertIn(
                    f"$word.AutomationSecurity = {_MSO_AUTOMATION_SECURITY_FORCE_DISABLE}",
                    script,
                )
                self.assertLess(
                    script.find("$word.AutomationSecurity = "),
                    script.find("Documents.Open("),
                )
                import shutil

                shutil.copyfile(out_docx, dest)
                completed = Mock()
                completed.returncode = 0
                completed.stderr = ""
                completed.stdout = ""
                return completed

            mock_run.side_effect = _fake_run
            produced = _convert_with_word_com(src)
            try:
                self.assertTrue(os.path.isfile(produced))
                self.assertGreater(os.path.getsize(produced), 0)
            finally:
                os.unlink(produced)
            mock_run.assert_called_once()
            cmd = mock_run.call_args[0][0]
            self.assertEqual(cmd[0], "powershell")
            self.assertIn("-Command", cmd)


class WordPayloadDetectTests(unittest.TestCase):
    def test_detects_rtf_disguised_as_doc(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "notes.doc")
            with open(path, "wb") as handle:
                handle.write(br"{\rtf1\ansi Hello from RTF}")
            self.assertEqual(detect_word_payload_kind(path), "rtf")

    def test_detects_html_disguised_as_doc(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "notes.doc")
            with open(path, "wb") as handle:
                handle.write(b"<!DOCTYPE html><html><body><p>hi</p></body></html>")
            self.assertEqual(detect_word_payload_kind(path), "html")

    def test_extract_rtf_plaintext(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "notes.doc")
            with open(path, "wb") as handle:
                handle.write(br"{\rtf1\ansi\pard Hello from RTF\par}")
            self.assertIn("Hello from RTF", extract_rtf_plaintext(path))


class DocxParserLegacyDocTests(unittest.TestCase):
    def test_parse_converts_ole_doc_before_zip_check(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "legacy.doc")
            converted = os.path.join(tmp, "converted.docx")
            _write_ole_stub(src)
            # 用 python-docx 生成合法 OOXML，避免手工 ZIP 缺 relationship
            from docx import Document as DocxDocument
            doc = DocxDocument()
            doc.add_paragraph("hello from converted doc")
            doc.save(converted)

            parser = DocxParser()
            with patch(
                "apps.services.docparse.parsers.docx_parser.convert_word_payload_to_docx",
                return_value=converted,
            ) as convert_mock:
                result = parser.parse(src)

            convert_mock.assert_called_once_with(src)
            self.assertTrue(
                any("hello from converted doc" in (c.content or "") for p in result.pages for c in p.chunks)
            )
            # 转换产物应由 parser 清理
            self.assertFalse(os.path.exists(converted))

    def test_parse_rtf_doc_falls_back_to_plaintext_without_converter(self):
        """复现用户报错：RTF 冒充 .doc 时不得再抛 DOCX/ZIP。"""
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "import-test.doc")
            with open(src, "wb") as handle:
                handle.write(br"{\rtf1\ansi\pard Hello from RTF\par}")

            parser = DocxParser()
            with patch(
                "apps.services.docparse.parsers.docx_parser.convert_word_payload_to_docx",
                side_effect=ValueError("LibreOffice: 未找到 soffice"),
            ):
                result = parser.parse(src)

            self.assertEqual(result.parse_method, "rtf_text_fallback")
            self.assertTrue(
                any("Hello from RTF" in (c.content or "") for p in result.pages for c in p.chunks)
            )

    def test_parse_html_doc_falls_back_to_plaintext_without_converter(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "import-test.doc")
            with open(src, "wb") as handle:
                handle.write(b"<!DOCTYPE html><html><body><h1>HTML Doc</h1><p>body</p></body></html>")

            parser = DocxParser()
            with patch(
                "apps.services.docparse.parsers.docx_parser.convert_word_payload_to_docx",
                side_effect=ValueError("LibreOffice: 未找到 soffice"),
            ):
                result = parser.parse(src)

            text = result.pages[0].text_content
            self.assertIn("HTML Doc", text)
            self.assertIn("body", text)

    def test_parse_unknown_payload_has_clear_message(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "broken.doc")
            with open(src, "wb") as handle:
                handle.write(b"not-a-word-file")

            with self.assertRaises(ValueError) as ctx:
                DocxParser().parse(src)
            self.assertIn("无法识别", str(ctx.exception))
            self.assertNotIn("DOCX/ZIP", str(ctx.exception))
            self.assertIn(UNRECOGNIZED_WORD_PAYLOAD_MSG[:8], str(ctx.exception))

    def test_validate_docx_safe_ole_message(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "legacy.doc")
            _write_ole_stub(path)
            with self.assertRaises(ValueError) as ctx:
                _validate_docx_safe(path)
            self.assertIn("旧版 Word", str(ctx.exception))
            self.assertNotIn("DOCX/ZIP", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
