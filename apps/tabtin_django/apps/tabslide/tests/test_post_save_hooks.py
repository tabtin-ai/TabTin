from __future__ import annotations

from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from apps.tabslide.post_save import run_post_save_hooks


class TabSlidePostSaveHookTests(TestCase):
    @patch("apps.tabslide.post_save._sync_page_count")
    @patch("apps.tabslide.post_save._create_history_best_effort")
    @patch("apps.tabslide.post_save._pregenerate_pptx_best_effort")
    @patch("apps.tabslide.services.pptx_cache.mark_pages_dirty")
    @patch("apps.tabslide.models.SlideChange")
    def test_run_post_save_triggers_pregenerate_for_page_changes(
        self,
        slide_change_mock,
        mark_pages_dirty_mock,
        pregenerate_mock,
        create_history_mock,
        sync_page_count_mock,
    ):
        project = SimpleNamespace(id="project-1")

        run_post_save_hooks(
            project,
            version=12,
            pages_affected=["p-1", "p-2"],
            change_type="save_pages",
            summary="save",
            editor_type="user",
            editor_id="u-1",
            create_history=True,
        )

        mark_pages_dirty_mock.assert_called_once_with("project-1", ["p-1", "p-2"])
        pregenerate_mock.assert_called_once_with(project)
        create_history_mock.assert_called_once()
        sync_page_count_mock.assert_called_once_with(project)
        slide_change_mock.objects.using.return_value.create.assert_called_once()

    @patch("apps.tabslide.post_save._sync_page_count")
    @patch("apps.tabslide.post_save._create_history_best_effort")
    @patch("apps.tabslide.post_save._pregenerate_pptx_best_effort")
    @patch("apps.tabslide.services.pptx_cache.mark_pages_dirty")
    @patch("apps.tabslide.models.SlideChange")
    def test_run_post_save_skips_pregenerate_without_page_changes(
        self,
        slide_change_mock,
        mark_pages_dirty_mock,
        pregenerate_mock,
        create_history_mock,
        sync_page_count_mock,
    ):
        project = SimpleNamespace(id="project-2")

        run_post_save_hooks(
            project,
            version=5,
            pages_affected=None,
            change_type="update_meta",
            summary="meta-only",
            editor_type="user",
            editor_id="u-2",
            create_history=False,
        )

        mark_pages_dirty_mock.assert_not_called()
        pregenerate_mock.assert_not_called()
        create_history_mock.assert_not_called()
        sync_page_count_mock.assert_called_once_with(project)
        slide_change_mock.objects.using.return_value.create.assert_called_once()
