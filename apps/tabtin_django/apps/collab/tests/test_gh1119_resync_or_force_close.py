"""
 回归测试：版本还原优先走 Yjs 增量重同步（resync），失败回退 force-close。

覆盖 _resync_collab_document 的响应解析，以及 _resync_or_force_close 的优先级与
回退语义（含沿用 collab_sync_warning 的 fc 结果透传）。纯 mock，无 DB 依赖。
"""
import os
from unittest.mock import patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402
django.setup()


class TestResyncCollabDocument:
    """_resync_collab_document 解析 collab-live /admin/resync-document 响应。"""

    @patch("apps.services.common.live_api.call_live_api_safe")
    def test_resynced_true(self, mock_call):
        from apps.collab.api import _resync_collab_document
        mock_call.return_value = {"data": {"document_id": "table:t1", "resynced": True}}
        result = _resync_collab_document("table", "t1")
        assert result == {"success": True, "resynced": True}
        # 文档名应带前缀
        args, kwargs = mock_call.call_args
        assert args[0] == "/admin/resync-document"
        assert args[1]["document_id"] == "table:t1"

    @patch("apps.services.common.live_api.call_live_api_safe")
    def test_resynced_false_when_not_loaded(self, mock_call):
        from apps.collab.api import _resync_collab_document
        mock_call.return_value = {"data": {"document_id": "docs:d1", "resynced": False}}
        result = _resync_collab_document("docs", "d1")
        assert result == {"success": True, "resynced": False}

    @patch("apps.services.common.live_api.call_live_api_safe")
    def test_http_error_returns_not_resynced(self, mock_call):
        from apps.collab.api import _resync_collab_document
        mock_call.return_value = {"error": "connection refused"}
        result = _resync_collab_document("table", "t1")
        assert result == {"success": False, "resynced": False}


class TestResyncOrForceClose:
    """_resync_or_force_close 的优先级、回退与 fc 透传语义。"""

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api._resync_collab_document")
    def test_resync_success_skips_force_close(self, mock_resync, mock_fc):
        from apps.collab.api import _resync_or_force_close
        mock_resync.return_value = {"success": True, "resynced": True}
        result = _resync_or_force_close("table", "t1")
        assert result["sync_mode"] == "resync"
        assert result["success"] is True
        assert result["fc"] is None
        mock_fc.assert_not_called()

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api._resync_collab_document")
    def test_not_loaded_falls_back_to_force_close(self, mock_resync, mock_fc):
        from apps.collab.api import _resync_or_force_close
        mock_resync.return_value = {"success": True, "resynced": False}
        mock_fc.return_value = {"success": True, "loaded": True, "connections_closed": 2}
        result = _resync_or_force_close("docs", "d1")
        assert result["sync_mode"] == "force_close"
        assert result["success"] is True
        assert result["fc"]["loaded"] is True
        mock_fc.assert_called_once_with("docs", "d1")

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api._resync_collab_document")
    def test_resync_raises_falls_back_to_force_close(self, mock_resync, mock_fc):
        from apps.collab.api import _resync_or_force_close
        mock_resync.side_effect = RuntimeError("boom")
        mock_fc.return_value = {"success": True, "loaded": False, "connections_closed": 0}
        result = _resync_or_force_close("table", "t1")
        assert result["sync_mode"] == "force_close"
        assert result["fc"]["loaded"] is False
        mock_fc.assert_called_once_with("table", "t1")

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api._resync_collab_document")
    def test_both_fail_returns_failed(self, mock_resync, mock_fc):
        from apps.collab.api import _resync_or_force_close
        mock_resync.return_value = {"success": False, "resynced": False}
        mock_fc.return_value = {"success": False, "loaded": False, "connections_closed": 0}
        result = _resync_or_force_close("table", "t1")
        assert result["sync_mode"] == "failed"
        assert result["success"] is False

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api._resync_collab_document")
    def test_non_resync_type_skips_resync(self, mock_resync, mock_fc):
        """slide/canvas/video 未启用 resync：直接走 force-close，不尝试 resync。"""
        from apps.collab.api import _resync_or_force_close
        mock_fc.return_value = {"success": True, "loaded": True, "connections_closed": 1}
        for rtype in ("slide",):
            result = _resync_or_force_close(rtype, "r1")
            assert result["sync_mode"] == "force_close"
        mock_resync.assert_not_called()
