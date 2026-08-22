"""
Wave 4 回归测试 — 数据基座修复 DF-14 / DF-15

DF-14: SlideHistory.save() 自动填充 blob_size
DF-15: SlidePage.content_format 具有 DB 层 choices 约束
"""

from __future__ import annotations

import zlib
from unittest import TestCase
from unittest.mock import patch


# ══════════════════════════════════════════════════════════════════════════
# DF-14: SlideHistory.blob_size 自动填充
# ══════════════════════════════════════════════════════════════════════════

class TestSlideHistoryBlobSizeAutoFill(TestCase):
    """验证 SlideHistory.save() 在 blob 为 bytes/memoryview 时自动计算 blob_size。"""

    @patch("django.db.models.Model.save")
    def test_bytes_blob_auto_fills_size(self, mock_super_save):
        from apps.tabslide.models import SlideHistory

        blob_data = zlib.compress(b'{"pages": []}')
        h = SlideHistory(blob=blob_data, blob_size=0, version=1)
        h.save()

        self.assertEqual(h.blob_size, len(blob_data))
        mock_super_save.assert_called_once()

    @patch("django.db.models.Model.save")
    def test_memoryview_blob_auto_fills_size(self, mock_super_save):
        from apps.tabslide.models import SlideHistory

        raw = zlib.compress(b'[{"id":"p1","elements":[]}]')
        mv = memoryview(raw)
        h = SlideHistory(blob=mv, blob_size=0, version=1)
        h.save()

        self.assertEqual(h.blob_size, len(raw))
        mock_super_save.assert_called_once()

    @patch("django.db.models.Model.save")
    def test_none_blob_keeps_zero(self, mock_super_save):
        from apps.tabslide.models import SlideHistory

        h = SlideHistory(blob=None, blob_size=0, version=1)
        h.save()

        self.assertEqual(h.blob_size, 0)
        mock_super_save.assert_called_once()

    @patch("django.db.models.Model.save")
    def test_caller_provided_size_gets_overwritten(self, mock_super_save):
        """即使调用方手动传了 blob_size=999，save() 仍根据实际 blob 覆盖。"""
        from apps.tabslide.models import SlideHistory

        blob_data = b"short"
        h = SlideHistory(blob=blob_data, blob_size=999, version=1)
        h.save()

        self.assertEqual(h.blob_size, len(blob_data))


# ══════════════════════════════════════════════════════════════════════════
# DF-15: SlidePage.content_format choices 约束
# ══════════════════════════════════════════════════════════════════════════

class TestSlidePageContentFormatChoices(TestCase):
    """验证 SlidePage.content_format 字段具有 choices 约束。"""

    def test_content_format_has_choices(self):
        from apps.tabslide.models import SlidePage

        field = SlidePage._meta.get_field("content_format")
        self.assertIsNotNone(field.choices, "content_format 应有 choices 约束")
        choice_values = {c[0] for c in field.choices}
        self.assertIn("json", choice_values)
        self.assertIn("html", choice_values)

    def test_choices_only_contain_expected_values(self):
        from apps.tabslide.models import SlidePage

        field = SlidePage._meta.get_field("content_format")
        choice_values = {c[0] for c in field.choices}
        self.assertEqual(choice_values, {"json", "html"})

    def test_default_is_json(self):
        from apps.tabslide.models import SlidePage

        field = SlidePage._meta.get_field("content_format")
        self.assertEqual(field.default, "json")
