""": 导出 Content-Disposition 文件名链路

DOCX 导出仅使用 RFC 5987 ``filename*=UTF-8''``（百分号编码），不设置
``filename=`` 或自定义响应头。
"""
import os
import sys
import unittest

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402

django.setup()

from apps.tabdoc.api import _build_attachment_disposition  # noqa: E402


class BuildAttachmentDispositionTests(unittest.TestCase):
    def test_ascii_title_via_filename_star(self):
        from urllib.parse import quote

        value = _build_attachment_disposition("Report.docx")
        self.assertNotIn('filename="', value)
        self.assertEqual(value, f"attachment; filename*=UTF-8''{quote('Report.docx')}")

    def test_cjk_title_not_mime_wrapped(self):
        value = _build_attachment_disposition("探索页面.docx")
        value.encode("latin-1")

    def test_cjk_title_only_filename_star(self):
        from urllib.parse import quote

        value = _build_attachment_disposition("探索页面.docx")
        self.assertEqual(
            value,
            f"attachment; filename*=UTF-8''{quote('探索页面.docx')}",
        )

    def test_special_chars_percent_encoded(self):
        from urllib.parse import quote

        name = 'a"b.docx'
        value = _build_attachment_disposition(name)
        self.assertEqual(value, f"attachment; filename*=UTF-8''{quote(name, safe='')}")


if __name__ == "__main__":
    unittest.main()
