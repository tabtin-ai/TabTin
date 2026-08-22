"""
回归测试 — TSV-002 ~ TSV-008 版本历史双轨断裂修复

验证 DB-first 路径（save_pages、create_slides、import_pptx、batch_update_elements）
正确写入统一 VersionHistory + ChangeLog，使前端版本历史 UI、空间检查点和 Agent 回滚可见。
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock, call, patch


# ──────────────────────────────────────────────────────────────
# post_save.py 层面的回归测试
# ──────────────────────────────────────────────────────────────

class TestUnifiedVersionHistoryWriteTSV002(TestCase):
    """TSV-002/TSV-004/TSV-005: DB-first 路径必须写入 VersionHistory + ChangeLog"""

    @patch("apps.tabslide.post_save._bridge_to_event_bus")
    @patch("apps.tabslide.post_save._push_ws_change_notification")
    @patch("apps.tabslide.post_save._write_unified_version_best_effort")
    @patch("apps.tabslide.post_save._create_history_best_effort")
    @patch("apps.tabslide.post_save._sync_page_count")
    @patch("apps.tabslide.services.pptx_cache.mark_pages_dirty")
    @patch("apps.tabslide.models.SlideChange")
    def test_create_history_true_triggers_unified_write(
        self,
        slide_change_mock,
        mark_dirty_mock,
        sync_mock,
        create_hist_mock,
        write_unified_mock,
        ws_mock,
        eb_mock,
    ):
        """create_history=True 时必须调用 _write_unified_version_best_effort"""
        from apps.tabslide.post_save import run_post_save_hooks

        project = SimpleNamespace(id="proj-1", organization_id="wt-1")
        run_post_save_hooks(
            project,
            version=5,
            pages_affected=["p-1"],
            change_type="save_pages",
            summary="保存 1 页",
            editor_type="user",
            editor_id="u-1",
            create_history=True,
        )

        write_unified_mock.assert_called_once_with(
            project,
            editor_type="user",
            editor_id="u-1",
            change_type="save_pages",
            summary="保存 1 页",
            agent_run_id="",
            force=False,
        )

    @patch("apps.tabslide.post_save._bridge_to_event_bus")
    @patch("apps.tabslide.post_save._push_ws_change_notification")
    @patch("apps.tabslide.post_save._write_unified_version_best_effort")
    @patch("apps.tabslide.post_save._create_history_best_effort")
    @patch("apps.tabslide.post_save._sync_page_count")
    @patch("apps.tabslide.services.pptx_cache.mark_pages_dirty")
    @patch("apps.tabslide.models.SlideChange")
    def test_create_history_false_skips_unified_write(
        self,
        slide_change_mock,
        mark_dirty_mock,
        sync_mock,
        create_hist_mock,
        write_unified_mock,
        ws_mock,
        eb_mock,
    ):
        """create_history=False 时不应调用 _write_unified_version_best_effort（collab persist 路径自行处理）"""
        from apps.tabslide.post_save import run_post_save_hooks

        project = SimpleNamespace(id="proj-2")
        run_post_save_hooks(
            project,
            version=3,
            change_type="collab_persist",
            create_history=False,
        )

        write_unified_mock.assert_not_called()


class TestUnifiedVersionSkipsRestoreTSV004(TestCase):
    """TSV-004: restore 路径由 VersionHistoryService 负责写入，post_save 不应重复写"""

    @patch("apps.tabslide.post_save._bridge_to_event_bus")
    @patch("apps.tabslide.post_save._push_ws_change_notification")
    @patch("apps.tabslide.post_save._write_unified_version_best_effort")
    @patch("apps.tabslide.post_save._create_history_best_effort")
    @patch("apps.tabslide.post_save._sync_page_count")
    @patch("apps.tabslide.models.SlideChange")
    def test_restore_change_types_skip_unified_write(
        self,
        slide_change_mock,
        sync_mock,
        create_hist_mock,
        write_unified_mock,
        ws_mock,
        eb_mock,
    ):
        from apps.tabslide.post_save import run_post_save_hooks

        project = SimpleNamespace(id="proj-3")
        for ct in ("undo_agent_edit", "restore_history"):
            write_unified_mock.reset_mock()
            run_post_save_hooks(
                project,
                version=10,
                change_type=ct,
                create_history=True,
                force_history=True,
            )
            write_unified_mock.assert_not_called(), f"change_type={ct} 不应触发 _write_unified_version_best_effort"


class TestChangeLogExecutionRunIdTSV006(TestCase):
    """TSV-006: agent_run_id 必须通过 run_post_save_hooks → _write_unified_version_best_effort → ChangeLog"""

    @patch("apps.tabslide.post_save._bridge_to_event_bus")
    @patch("apps.tabslide.post_save._push_ws_change_notification")
    @patch("apps.tabslide.post_save._write_unified_version_best_effort")
    @patch("apps.tabslide.post_save._create_history_best_effort")
    @patch("apps.tabslide.post_save._sync_page_count")
    @patch("apps.tabslide.models.SlideChange")
    def test_agent_run_id_passed_through(
        self,
        slide_change_mock,
        sync_mock,
        create_hist_mock,
        write_unified_mock,
        ws_mock,
        eb_mock,
    ):
        from apps.tabslide.post_save import run_post_save_hooks

        project = SimpleNamespace(id="proj-4")
        run_post_save_hooks(
            project,
            version=7,
            pages_affected=["p-1"],
            change_type="update_element",
            editor_type="agent",
            editor_id="agent-1",
            create_history=True,
            agent_run_id="run-abc-123",
        )

        write_unified_mock.assert_called_once()
        _, kwargs = write_unified_mock.call_args
        assert kwargs["agent_run_id"] == "run-abc-123"


class TestWriteUnifiedVersionBestEffortIntegration(TestCase):
    """TSV-002/TSV-005/TSV-006: _write_unified_version_best_effort 内部行为"""

    @patch("apps.collab.models.ChangeLog")
    @patch("apps.collab.service.VersionHistoryService")
    @patch("apps.collab.adapters.slide.SlideCollabAdapter")
    def test_writes_version_history_and_changelog(
        self,
        adapter_cls_mock,
        vh_svc_cls_mock,
        changelog_cls_mock,
    ):
        from apps.tabslide.post_save import _write_unified_version_best_effort

        adapter_inst = MagicMock()
        adapter_inst.get_version_data.return_value = [{"id": "p-1", "elements": []}]
        adapter_cls_mock.return_value = adapter_inst

        fake_vh = MagicMock()
        svc_inst = MagicMock()
        svc_inst.create_history.return_value = fake_vh
        vh_svc_cls_mock.return_value = svc_inst

        project = SimpleNamespace(id="proj-5", organization_id="wt-1")
        _write_unified_version_best_effort(
            project,
            editor_type="agent",
            editor_id="agent-1",
            change_type="update_element",
            summary="batch 3 elements",
            agent_run_id="run-xyz",
            force=True,
        )

        svc_inst.create_history.assert_called_once()
        _, vh_kwargs = svc_inst.create_history.call_args
        assert vh_kwargs["force_snapshot"] is True

        changelog_cls_mock.objects.using.return_value.create.assert_called_once()
        cl_kwargs = changelog_cls_mock.objects.using.return_value.create.call_args[1]
        assert cl_kwargs["resource_type"] == "slide"
        assert cl_kwargs["resource_id"] == "proj-5"
        assert cl_kwargs["agent_run_id"] == "run-xyz"
        assert cl_kwargs["change_type"] == "update_element"
        assert cl_kwargs["version_history"] == fake_vh

    @patch("apps.collab.models.ChangeLog")
    @patch("apps.collab.service.VersionHistoryService")
    @patch("apps.collab.adapters.slide.SlideCollabAdapter")
    def test_writes_changelog_even_when_vh_skipped(
        self,
        adapter_cls_mock,
        vh_svc_cls_mock,
        changelog_cls_mock,
    ):
        """VersionHistory 因时间间隔跳过时，ChangeLog 仍应写入（version_history=None）"""
        from apps.tabslide.post_save import _write_unified_version_best_effort

        adapter_inst = MagicMock()
        adapter_inst.get_version_data.return_value = [{"id": "p-1"}]
        adapter_cls_mock.return_value = adapter_inst

        svc_inst = MagicMock()
        svc_inst.create_history.return_value = None
        vh_svc_cls_mock.return_value = svc_inst

        project = SimpleNamespace(id="proj-6", organization_id="wt-2")
        _write_unified_version_best_effort(
            project,
            editor_type="user",
            editor_id="u-1",
            change_type="save_pages",
        )

        changelog_cls_mock.objects.using.return_value.create.assert_called_once()
        cl_kwargs = changelog_cls_mock.objects.using.return_value.create.call_args[1]
        assert cl_kwargs["version_history"] is None

    @patch("apps.collab.models.ChangeLog")
    @patch("apps.collab.service.VersionHistoryService")
    @patch("apps.collab.adapters.slide.SlideCollabAdapter")
    @patch("apps.services.common.platform_context.get_current_run_id", return_value="ctx-run-001")
    def test_agent_run_id_fallback_from_context(
        self,
        get_run_id_mock,
        adapter_cls_mock,
        vh_svc_cls_mock,
        changelog_cls_mock,
    ):
        """当 agent_run_id 未显式传入时，从线程上下文自动获取"""
        from apps.tabslide.post_save import _write_unified_version_best_effort

        adapter_inst = MagicMock()
        adapter_inst.get_version_data.return_value = [{"id": "p-1"}]
        adapter_cls_mock.return_value = adapter_inst

        svc_inst = MagicMock()
        svc_inst.create_history.return_value = None
        vh_svc_cls_mock.return_value = svc_inst

        project = SimpleNamespace(id="proj-7", organization_id="wt-3")
        _write_unified_version_best_effort(
            project,
            editor_type="agent",
            editor_id="agent-2",
            change_type="update_element",
        )

        cl_kwargs = changelog_cls_mock.objects.using.return_value.create.call_args[1]
        assert cl_kwargs["agent_run_id"] == "ctx-run-001"


# ──────────────────────────────────────────────────────────────
# slide_service.py 层面的回归测试
# ──────────────────────────────────────────────────────────────

class TestBatchUpdateElementsHistoryTSV003(TestCase):
    """TSV-003: batch_update_elements 必须写版本历史（create_history=True）"""

    @patch("apps.tabslide.post_save.run_post_save_hooks")
    @patch("apps.tabslide.services.slide_service.SlideService._record_element_change")
    @patch("apps.tabslide.services.slide_service.SlideService._get_project")
    @patch("apps.tabslide.services.slide_service.SlideService._editor_info", return_value=("agent", "a-1"))
    def test_batch_update_calls_post_save_with_create_history_true(
        self,
        editor_info_mock,
        get_project_mock,
        record_elem_mock,
        post_save_mock,
    ):
        from apps.tabslide.services.slide_service import SlideService

        project = MagicMock()
        project.id = "proj-8"
        project.latest_version = 5
        get_project_mock.return_value = project

        project_row = MagicMock()
        project_row.latest_version = 5

        page_mock = MagicMock()
        page_mock.content_format = "json"
        page_mock.elements_data = [{"id": "el-1", "text": "old"}]

        def _refresh_side_effect(*args, **kwargs):
            project.latest_version = 6

        with patch("apps.tabslide.services.slide_service.SlideProject") as sp_mock, \
             patch("apps.tabslide.services.slide_service.SlidePage") as spage_mock, \
             patch("apps.tabslide.services.slide_service.transaction"), \
             patch("apps.tabslide.services.pptx_cache.mark_pages_dirty"), \
             patch("apps.tabslide.services.slide_service._sanitize_elements_data"):

            sp_mock.objects.using.return_value.select_for_update.return_value.get.return_value = project_row
            sp_mock.objects.using.return_value.filter.return_value.update.return_value = 1
            sp_mock.DoesNotExist = Exception
            spage_mock.objects.using.return_value.select_for_update.return_value.get.return_value = page_mock

            project.refresh_from_db = MagicMock(side_effect=_refresh_side_effect)

            svc = SlideService(user=None)
            svc.batch_update_elements(
                "proj-8",
                [{"page_id": "p-1", "element_id": "el-1", "patch": {"text": "new"}}],
                agent_run_id="run-batch-1",
            )

            post_save_mock.assert_called_once()
            _, kwargs = post_save_mock.call_args
            assert kwargs["create_history"] is True, "TSV-003: create_history 必须为 True"
            assert kwargs["agent_run_id"] == "run-batch-1", "TSV-006: agent_run_id 必须透传"


class TestCreateSlidesUsesPostSaveHooksTSV007(TestCase):
    """TSV-007/TSV-008: create_slides 必须使用 run_post_save_hooks 而非直接调用私有方法"""

    @patch("apps.tabslide.post_save.run_post_save_hooks")
    def test_create_slides_calls_run_post_save_hooks(self, post_save_mock):
        from apps.tabslide.services.slide_service import SlideService

        svc = SlideService(user=None)
        fake_pages = [{"id": "p-1", "elements": [{"id": "e-1"}]}]

        with patch.object(svc, "_get_project") as get_proj, \
             patch.object(svc, "_editor_info", return_value=("agent", "a-1")), \
             patch.object(svc, "_cas_save_pages", return_value=2), \
             patch.object(svc, "_push_pages_to_ydoc"), \
             patch.object(svc, "_extract_html_sources_by_slide", return_value=[]), \
             patch("apps.tabslide.services.slide_service._sanitize_elements_data"), \
             patch("apps.tabslide.services.slide_service._sanitize_slide_html", side_effect=lambda x: x), \
             patch("apps.tabslide.services.slide_service.SlideProject"), \
             patch("apps.tabslide.services.slide_service.build_oss_image_handler"), \
             patch("apps.tabslide.services.dom_extractor.extract_elements_from_html", return_value=fake_pages):

            project = MagicMock()
            project.id = "proj-9"
            project.latest_version = 2
            project.canvas_width = 1920
            project.canvas_height = 1080
            project.organization_id = "wt-1"
            get_proj.return_value = project

            svc.create_slides("proj-9", html='<div class="ppt-slide">test</div>', mode="direct")

            post_save_mock.assert_called_once()
            _, kwargs = post_save_mock.call_args
            assert kwargs["change_type"] == "create_slides"
            assert kwargs["create_history"] is True, "TSV-007: 必须通过 run_post_save_hooks 创建历史"
            assert kwargs["force_history"] is True, "TSV-008: 必须 force 以确保使用正确 TTL"
            assert "p-1" in kwargs["pages_affected"], "TSV-007: 页面 ID 必须传递"

    @patch("apps.tabslide.post_save.run_post_save_hooks")
    @patch("apps.tabslide.services.slide_service.SlideService.create_history_snapshot")
    @patch("apps.tabslide.services.slide_service.SlideService._record_change")
    def test_create_slides_no_longer_calls_private_methods(
        self,
        record_change_mock,
        create_hist_mock,
        post_save_mock,
    ):
        """确认 create_slides 不再直接调用 _record_change / create_history_snapshot"""
        from apps.tabslide.services.slide_service import SlideService

        svc = SlideService(user=None)
        fake_pages = [{"id": "p-1", "elements": []}]

        with patch.object(svc, "_get_project") as get_proj, \
             patch.object(svc, "_editor_info", return_value=("agent", "a-1")), \
             patch.object(svc, "_cas_save_pages", return_value=2), \
             patch.object(svc, "_push_pages_to_ydoc"), \
             patch.object(svc, "_extract_html_sources_by_slide", return_value=[]), \
             patch("apps.tabslide.services.slide_service._sanitize_elements_data"), \
             patch("apps.tabslide.services.slide_service._sanitize_slide_html", side_effect=lambda x: x), \
             patch("apps.tabslide.services.slide_service.SlideProject"), \
             patch("apps.tabslide.services.slide_service.build_oss_image_handler"), \
             patch("apps.tabslide.services.dom_extractor.extract_elements_from_html", return_value=fake_pages):

            project = MagicMock()
            project.id = "proj-10"
            project.latest_version = 2
            project.canvas_width = 1920
            project.canvas_height = 1080
            project.organization_id = "wt-1"
            get_proj.return_value = project

            svc.create_slides("proj-10", html='<div class="ppt-slide">test</div>', mode="direct")

            record_change_mock.assert_not_called(), "TSV-007: 不应直接调用 _record_change"
            create_hist_mock.assert_not_called(), "TSV-007: 不应直接调用 create_history_snapshot"


class TestForceHistoryPassesForceFlagTSV008(TestCase):
    """TSV-008: force_history=True 映射到 _write_unified_version_best_effort(force=True)"""

    @patch("apps.tabslide.post_save._bridge_to_event_bus")
    @patch("apps.tabslide.post_save._push_ws_change_notification")
    @patch("apps.tabslide.post_save._write_unified_version_best_effort")
    @patch("apps.tabslide.post_save._create_history_best_effort")
    @patch("apps.tabslide.post_save._sync_page_count")
    @patch("apps.tabslide.models.SlideChange")
    def test_force_history_propagates_to_unified_write(
        self,
        slide_change_mock,
        sync_mock,
        create_hist_mock,
        write_unified_mock,
        ws_mock,
        eb_mock,
    ):
        from apps.tabslide.post_save import run_post_save_hooks

        project = SimpleNamespace(id="proj-11")
        run_post_save_hooks(
            project,
            version=1,
            change_type="import_pptx",
            create_history=True,
            force_history=True,
            editor_type="user",
            editor_id="u-1",
        )

        write_unified_mock.assert_called_once()
        _, kwargs = write_unified_mock.call_args
        assert kwargs["force"] is True, "TSV-008: force_history 必须映射到 force=True"


# ──────────────────────────────────────────────────────────────
# collab adapter 层面的回归测试
# ──────────────────────────────────────────────────────────────

class TestGetVersionDataReturnsDictTSV004(TestCase):
    """TSV-004/TSV-005: get_version_data 必须返回含 theme/font_meta 的 dict，确保 restore 数据完整"""

    def test_returns_dict_with_theme_and_font_meta(self):
        from apps.collab.adapters.slide import SlideCollabAdapter

        adapter = SlideCollabAdapter()
        resource = SimpleNamespace(
            id="proj-12",
            theme={"primary": "#ff0000", "background": "#ffffff"},
            font_meta={"embedded_fonts": [{"name": "CustomFont"}]},
        )

        with patch.object(adapter, "get_pages_data", return_value=[
            {"id": "p-1", "elements": [{"id": "e-1"}]},
        ]):
            result = adapter.get_version_data(resource)

        assert isinstance(result, dict), "TSV-004: get_version_data 必须返回 dict"
        assert "pages" in result, "TSV-004: 必须含 pages"
        assert "theme" in result, "TSV-004: 必须含 theme"
        assert "font_meta" in result, "TSV-004: 必须含 font_meta"
        assert result["theme"] == {"primary": "#ff0000", "background": "#ffffff"}
        assert result["font_meta"] == {"embedded_fonts": [{"name": "CustomFont"}]}
        assert len(result["pages"]) == 1

    def test_returns_none_fields_gracefully(self):
        from apps.collab.adapters.slide import SlideCollabAdapter

        adapter = SlideCollabAdapter()
        resource = SimpleNamespace(id="proj-13", theme=None, font_meta=None)

        with patch.object(adapter, "get_pages_data", return_value=[]):
            result = adapter.get_version_data(resource)

        assert isinstance(result, dict)
        assert result["theme"] is None
        assert result["font_meta"] is None


class TestRestorePassesCorrectFlagsTSV004(TestCase):
    """TSV-004: restore() 传递 create_history=False 和 editor_type='system'"""

    @patch("apps.tabslide.services.slide_service.SlideService.restore_pages_from_snapshot")
    @patch("apps.tabslide.services.slide_service.SlideService.__init__", return_value=None)
    def test_restore_calls_restore_pages_with_correct_flags(self, init_mock, restore_mock):
        from apps.collab.adapters.slide import SlideCollabAdapter

        adapter = SlideCollabAdapter()
        resource = SimpleNamespace(id="proj-14")
        data = {
            "pages": [{"id": "p-1", "elements": []}],
            "theme": {"primary": "#000"},
            "font_meta": {"embedded_fonts": []},
        }

        adapter.restore(resource, data)

        restore_mock.assert_called_once()
        _, kwargs = restore_mock.call_args
        assert kwargs["create_history"] is False, "TSV-011/TSV-004: restore 不应触发 SlideHistory 写入"
        assert kwargs["editor_type"] == "system", "TSV-012: restore 应标记为 system"
        assert kwargs["extra_fields"]["theme"] == {"primary": "#000"}, "TSV-004: theme 必须传递"
        assert kwargs["extra_fields"]["font_meta"] == {"embedded_fonts": []}, "TSV-004: font_meta 必须传递"

    @patch("apps.tabslide.services.slide_service.SlideService.restore_pages_from_snapshot")
    @patch("apps.tabslide.services.slide_service.SlideService.__init__", return_value=None)
    def test_restore_handles_legacy_list_data(self, init_mock, restore_mock):
        """旧格式 list 数据应能正常处理"""
        from apps.collab.adapters.slide import SlideCollabAdapter

        adapter = SlideCollabAdapter()
        resource = SimpleNamespace(id="proj-15")
        data = [{"id": "p-1", "elements": []}]

        adapter.restore(resource, data)

        restore_mock.assert_called_once()
        args, kwargs = restore_mock.call_args
        assert kwargs.get("extra_fields") is None, "旧格式不含 extra_fields"


class TestSavePagesCallsPostSaveHooksTSV002(TestCase):
    """TSV-002: save_pages 必须通过 run_post_save_hooks(create_history=True) 写入版本历史"""

    @patch("apps.tabslide.post_save.run_post_save_hooks")
    def test_save_pages_triggers_create_history(self, post_save_mock):
        from apps.tabslide.services.slide_service import SlideService

        svc = SlideService(user=None)
        pages = [{"id": "p-1", "elements": [], "html": ""}]

        with patch.object(svc, "_get_project") as get_proj, \
             patch.object(svc, "_editor_info", return_value=("user", "u-1")), \
             patch.object(svc, "_cas_save_pages", return_value=3), \
             patch.object(svc, "_push_pages_to_ydoc"), \
             patch("apps.tabslide.services.slide_service.SlidePage") as spage_mock, \
             patch("apps.tabslide.services.slide_service._sanitize_slide_html", side_effect=lambda x: x), \
             patch("apps.tabslide.services.slide_service._sanitize_elements_data"), \
             patch("apps.tabslide.services.slide_service.transaction"):

            project = MagicMock()
            project.id = "proj-16"
            project.latest_version = 2
            get_proj.return_value = project

            spage_mock.objects.using.return_value.select_for_update.return_value.filter.return_value.only.return_value = []

            svc.save_pages("proj-16", pages)

            post_save_mock.assert_called_once()
            _, kwargs = post_save_mock.call_args
            assert kwargs["change_type"] == "save_pages"
            assert kwargs["create_history"] is True, "TSV-002: save_pages 必须 create_history=True"
