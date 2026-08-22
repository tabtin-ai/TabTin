"""
CL-016 回归测试

验证 SlideService.restore_history_data 在 diff 链断裂时不再静默返回
legacy 解码的数据，而是抛出 LegacyFallbackUsed 异常，携带 pages、
page_meta、reason 等上下文信息，让调用方显式感知降级路径。
"""
from __future__ import annotations

import json
import os
import uuid
import zlib
from unittest.mock import MagicMock, patch, PropertyMock

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402
django.setup()

import pytest  # noqa: E402

from apps.tabslide.services.slide_service import (  # noqa: E402
    LegacyFallbackUsed,
    SlideService,
)


class TestLegacyFallbackUsedException:
    """LegacyFallbackUsed 异常类基本行为。"""

    def test_attributes_accessible(self):
        pages = [{"id": "p1"}]
        exc = LegacyFallbackUsed(
            pages=pages, page_meta=None,
            reason="chain_broken", history_id="h1",
            detail="missing base_history xyz",
        )
        assert exc.pages == pages
        assert exc.page_meta is None
        assert exc.reason == "chain_broken"
        assert exc.history_id == "h1"
        assert "chain_broken" in str(exc)
        assert "legacy fallback" in str(exc)

    def test_detail_optional(self):
        exc = LegacyFallbackUsed(
            pages=[], page_meta=None,
            reason="no_anchor", history_id="h2",
        )
        assert exc.detail == ""


class TestCL016BrokenChainLegacyFallback:
    """CL-016: diff 链断裂时的 legacy fallback 行为。"""

    def test_broken_chain_with_legacy_blob_raises_fallback(self):
        """diff 链断裂 + blob 可解码为 legacy pages → 抛出 LegacyFallbackUsed。"""
        from apps.tabslide.models import SlideHistory

        legacy_pages = [{"id": "p1", "elements": []}]
        legacy_blob = zlib.compress(json.dumps(legacy_pages).encode())

        missing_base_id = uuid.uuid4()

        history = MagicMock(spec=SlideHistory)
        history.id = uuid.uuid4()
        history.project_id = uuid.uuid4()
        history.is_snapshot = False
        history.base_history_id = missing_base_id
        history.blob = legacy_blob
        history.page_meta_snapshot = None

        with patch.object(
            SlideHistory.objects, "using"
        ) as mock_using:
            mock_qs = MagicMock()
            mock_qs.get.side_effect = SlideHistory.DoesNotExist()
            mock_using.return_value = mock_qs

            with pytest.raises(LegacyFallbackUsed) as exc_info:
                SlideService.restore_history_data(history)

        exc = exc_info.value
        assert exc.reason == "chain_broken"
        assert exc.pages == legacy_pages
        assert len(exc.pages) == 1
        assert exc.history_id == history.id
        assert "missing base_history" in exc.detail

    def test_broken_chain_non_legacy_blob_raises_valueerror(self):
        """diff 链断裂 + blob 是 dict（diff 结构）→ 抛出 ValueError。"""
        from apps.tabslide.models import SlideHistory

        diff_data = {"added": [], "removed": [], "changed": []}
        diff_blob = zlib.compress(json.dumps(diff_data).encode())

        missing_base_id = uuid.uuid4()

        history = MagicMock(spec=SlideHistory)
        history.id = uuid.uuid4()
        history.project_id = uuid.uuid4()
        history.is_snapshot = False
        history.base_history_id = missing_base_id
        history.blob = diff_blob
        history.page_meta_snapshot = None

        with patch.object(
            SlideHistory.objects, "using"
        ) as mock_using:
            mock_qs = MagicMock()
            mock_qs.get.side_effect = SlideHistory.DoesNotExist()
            mock_using.return_value = mock_qs

            with pytest.raises(ValueError):
                SlideService.restore_history_data(history)

    def test_no_anchor_with_legacy_blob_raises_fallback(self):
        """diff 链无全量锚点 + blob 可解码为 legacy pages → LegacyFallbackUsed(no_anchor)。"""
        from apps.tabslide.models import SlideHistory

        legacy_pages = [{"id": "p1"}, {"id": "p2"}]
        legacy_blob = zlib.compress(json.dumps(legacy_pages).encode())

        mid_id = uuid.uuid4()

        mid_history = MagicMock(spec=SlideHistory)
        mid_history.id = mid_id
        mid_history.is_snapshot = False
        mid_history.base_history_id = None

        history = MagicMock(spec=SlideHistory)
        history.id = uuid.uuid4()
        history.project_id = uuid.uuid4()
        history.is_snapshot = False
        history.base_history_id = mid_id
        history.blob = legacy_blob
        history.page_meta_snapshot = None

        with patch.object(
            SlideHistory.objects, "using"
        ) as mock_using:
            mock_qs = MagicMock()
            mock_qs.get.return_value = mid_history
            mock_using.return_value = mock_qs

            with pytest.raises(LegacyFallbackUsed) as exc_info:
                SlideService.restore_history_data(history)

        exc = exc_info.value
        assert exc.reason == "no_anchor"
        assert len(exc.pages) == 2

    def test_normal_snapshot_not_affected(self):
        """全量快照正常恢复不受影响。"""
        from apps.tabslide.models import SlideHistory

        pages = [{"id": "p1", "elements": [{"type": "text"}]}]
        blob = zlib.compress(json.dumps(pages).encode())

        history = MagicMock(spec=SlideHistory)
        history.id = uuid.uuid4()
        history.is_snapshot = True
        history.blob = blob
        history.page_meta_snapshot = None

        result_pages, meta = SlideService.restore_history_data(history)
        assert result_pages == pages


class TestRestoreHistoryCatchesFallback:
    """CL-016: restore_history 调用方正确处理 LegacyFallbackUsed。"""

    def test_restore_history_accepts_legacy_fallback(self):
        """restore_history catch LegacyFallbackUsed 并使用降级数据继续恢复。"""
        legacy_pages = [{"id": "p1", "elements": []}]

        with patch.object(
            SlideService, "restore_history_data",
            side_effect=LegacyFallbackUsed(
                pages=legacy_pages, page_meta=None,
                reason="chain_broken", history_id=uuid.uuid4(),
            ),
        ), \
             patch.object(SlideService, "_get_project") as mock_get_proj, \
             patch.object(SlideService, "_cas_save_pages", return_value=2), \
             patch.object(SlideService, "_editor_info", return_value=("user", "u1")), \
             patch("apps.tabslide.post_save.run_post_save_hooks"), \
             patch.object(SlideService, "_push_pages_to_ydoc"):

            mock_project = MagicMock()
            mock_project.id = uuid.uuid4()
            mock_get_proj.return_value = mock_project

            mock_history = MagicMock()
            mock_history.id = uuid.uuid4()
            mock_history.version = 1
            mock_history.name = ""

            from apps.tabslide.models import SlideHistory
            with patch.object(
                SlideHistory.objects, "using"
            ) as mock_using:
                mock_qs = MagicMock()
                mock_qs.get.return_value = mock_history
                mock_using.return_value = mock_qs

                svc = SlideService.__new__(SlideService)
                project, pages = svc.restore_history(
                    str(mock_project.id), str(mock_history.id),
                )

        assert pages == legacy_pages
