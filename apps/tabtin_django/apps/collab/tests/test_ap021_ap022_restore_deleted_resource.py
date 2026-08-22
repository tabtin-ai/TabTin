"""
AP-021 / AP-022 回归测试

AP-021: SlideCollabAdapter.restore() 不过滤 status，允许恢复已删除 SlideProject
AP-022: VideoCollabAdapter.restore() 不过滤 status，允许恢复已删除 VideoProject；
        同时验证 restore() 使用 transaction.atomic + select_for_update 保证并发安全
"""
import inspect
import os
import uuid
from unittest.mock import MagicMock, patch, call

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402
django.setup()

import pytest  # noqa: E402


# ═══════════════════════════════════════════════════════
# AP-021: SlideCollabAdapter.restore() 不过滤 status
# ═══════════════════════════════════════════════════════

class TestAP021SlideRestoreDeletedResource:
    """AP-021: SlideCollabAdapter.restore() 对已删除资源也能正常恢复。"""

    def test_restore_delegates_to_slide_service_without_status_filter(self):
        """restore() 委托给 SlideService，不在 adapter 层过滤 status。"""
        from apps.collab.adapters.slide import SlideCollabAdapter

        source = inspect.getsource(SlideCollabAdapter.restore)
        assert 'status="active"' not in source, (
            "SlideCollabAdapter.restore() must not filter status='active' "
            "(AP-021: deleted resources must be restorable)"
        )
        assert "status" not in source or "AP-021" in source, (
            "SlideCollabAdapter.restore() must not filter by status "
            "(AP-021: deleted resources must be restorable)"
        )

    def test_restore_has_ap021_comment(self):
        """restore() 源码应包含 AP-021 注释，说明不过滤 status 是有意为之。"""
        from apps.collab.adapters.slide import SlideCollabAdapter

        source = inspect.getsource(SlideCollabAdapter.restore)
        assert "AP-021" in source, (
            "SlideCollabAdapter.restore() must have AP-021 comment explaining "
            "why status is not filtered"
        )

    def test_restore_calls_slide_service(self):
        """restore() 必须调用 SlideService.restore_pages_from_snapshot。"""
        from apps.collab.adapters.slide import SlideCollabAdapter

        source = inspect.getsource(SlideCollabAdapter.restore)
        assert "restore_pages_from_snapshot" in source, (
            "SlideCollabAdapter.restore() must delegate to restore_pages_from_snapshot"
        )

    @patch("apps.tabslide.services.slide_service.SlideService.restore_pages_from_snapshot")
    def test_restore_deleted_slide_calls_service(self, mock_restore):
        """restore() 对 status='deleted' 的资源也应调用 SlideService。"""
        from apps.collab.adapters.slide import SlideCollabAdapter

        adapter = SlideCollabAdapter()

        deleted_project = MagicMock()
        deleted_project.id = uuid.uuid4()
        deleted_project.status = "deleted"
        deleted_project.latest_version = 5

        mock_restore.return_value = deleted_project

        data = {
            "pages": [{"id": "p1", "elements": []}],
            "theme": {"color": "#fff"},
        }

        adapter.restore(deleted_project, data)

        mock_restore.assert_called_once()
        call_args = mock_restore.call_args
        assert call_args[0][0] is deleted_project, (
            "restore_pages_from_snapshot must receive the deleted resource"
        )

    @patch("apps.tabslide.services.slide_service.SlideService.restore_pages_from_snapshot")
    def test_restore_dict_format_extracts_theme(self, mock_restore):
        """dict 格式数据中的 theme 应被提取并传入 extra_fields。"""
        from apps.collab.adapters.slide import SlideCollabAdapter

        adapter = SlideCollabAdapter()
        resource = MagicMock()
        resource.id = uuid.uuid4()
        resource.latest_version = 3

        mock_restore.return_value = resource

        data = {
            "pages": [{"id": "p1"}],
            "theme": {"primary": "#000"},
            "font_meta": {"family": "Arial"},
        }

        adapter.restore(resource, data)

        mock_restore.assert_called_once()
        _, kwargs = mock_restore.call_args
        assert kwargs.get("extra_fields") == {
            "theme": {"primary": "#000"},
            "font_meta": {"family": "Arial"},
        }, "theme and font_meta must be passed as extra_fields"

    @patch("apps.tabslide.services.slide_service.SlideService.restore_pages_from_snapshot")
    def test_restore_list_format_no_extra_fields(self, mock_restore):
        """旧格式 list 数据不应传入 extra_fields（避免清空 theme）。"""
        from apps.collab.adapters.slide import SlideCollabAdapter

        adapter = SlideCollabAdapter()
        resource = MagicMock()
        resource.id = uuid.uuid4()
        resource.latest_version = 2

        mock_restore.return_value = resource

        data = [{"id": "p1"}, {"id": "p2"}]

        adapter.restore(resource, data)

        mock_restore.assert_called_once()
        _, kwargs = mock_restore.call_args
        assert kwargs.get("extra_fields") is None, (
            "list format must not pass extra_fields"
        )


# ═══════════════════════════════════════════════════════
# AP-022: VideoCollabAdapter.restore() 不过滤 status + 并发安全
# ═══════════════════════════════════════════════════════

