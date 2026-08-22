"""
VS-002 / VS-011 / VS-013 / VID-007 / CVS-004 回归测试

VS-002: invalidate-version 失败时各模块应降级 force-close（统一降级函数）
VS-011: invalidate-version 返回 updated=false 时也应降级为 force-close
VS-013: _force_close_collab_document 的 reason 应支持自定义语义
VID-007: video_service.save_timeline 使用统一降级函数
CVS-004: canvas_service._cas_save_graph 使用统一降级函数
"""
import os
import uuid
from unittest.mock import MagicMock, patch, call

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402
django.setup()

import pytest  # noqa: E402


# ══════════════════════════════════════════════════════════
# VS-013: _force_close_collab_document reason 参数化
# ══════════════════════════════════════════════════════════

class TestVS013ForceCloseReasonParam:
    """VS-013: _force_close_collab_document 支持自定义 reason。"""

    @patch("apps.services.common.live_api.call_live_api_safe")
    def test_default_reason_is_document_restored(self, mock_call):
        """默认 reason 应为 document_restored（向后兼容）。"""
        from apps.collab.api import _force_close_collab_document

        mock_call.return_value = {"loaded": True, "connections_closed": 2}

        _force_close_collab_document("docs", "abc-123")

        mock_call.assert_called_once()
        payload = mock_call.call_args[0][1]
        assert payload["reason"] == "document_restored"

    @patch("apps.services.common.live_api.call_live_api_safe")
    def test_custom_reason_passed_through(self, mock_call):
        """自定义 reason 应正确传递给 collab-live。"""
        from apps.collab.api import _force_close_collab_document

        mock_call.return_value = {"loaded": True, "connections_closed": 1}

        _force_close_collab_document("slide", "xyz", reason="version_sync_fallback")

        payload = mock_call.call_args[0][1]
        assert payload["reason"] == "version_sync_fallback"

    @patch("apps.services.common.live_api.call_live_api_safe")
    def test_reason_in_error_path(self, mock_call):
        """即使 API 返回错误，reason 也应被传递。"""
        from apps.collab.api import _force_close_collab_document

        mock_call.return_value = {"error": "timeout"}

        result = _force_close_collab_document("docs", "v1", reason="version_sync_fallback")

        payload = mock_call.call_args[0][1]
        assert payload["reason"] == "version_sync_fallback"
        assert result["success"] is False


# ══════════════════════════════════════════════════════════
# VS-002 + VS-011: _invalidate_or_force_close 统一降级函数
# ══════════════════════════════════════════════════════════

class TestVS002InvalidateOrForceClose:
    """VS-002: 统一降级函数 invalidate → force-close 链路。"""

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api._invalidate_collab_version")
    def test_invalidate_success_updated_true_no_force_close(
        self, mock_invalidate, mock_force_close
    ):
        """invalidate 成功且 updated=True 时不应调用 force-close。"""
        from apps.collab.api import _invalidate_or_force_close

        mock_invalidate.return_value = {"success": True, "updated": True}

        result = _invalidate_or_force_close("slide", "c1", 10)

        mock_invalidate.assert_called_once_with("slide", "c1", 10)
        mock_force_close.assert_not_called()
        assert result["invalidated"] is True
        assert result["force_closed"] is False

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api._invalidate_collab_version")
    def test_invalidate_failure_triggers_force_close(
        self, mock_invalidate, mock_force_close
    ):
        """VS-002 核心：invalidate 失败时应降级为 force-close。"""
        from apps.collab.api import _invalidate_or_force_close

        mock_invalidate.return_value = {"success": False, "updated": False}
        mock_force_close.return_value = {"success": True, "loaded": True, "connections_closed": 3}

        result = _invalidate_or_force_close("docs", "v1", 5)

        mock_invalidate.assert_called_once_with("docs", "v1", 5)
        mock_force_close.assert_called_once_with(
            "docs", "v1", reason="version_sync_fallback"
        )
        assert result["invalidated"] is False
        assert result["force_closed"] is True

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api._invalidate_collab_version")
    def test_invalidate_updated_false_triggers_force_close(
        self, mock_invalidate, mock_force_close
    ):
        """VS-011 核心：updated=False 时也应降级为 force-close。"""
        from apps.collab.api import _invalidate_or_force_close

        mock_invalidate.return_value = {"success": True, "updated": False}
        mock_force_close.return_value = {"success": True, "loaded": False, "connections_closed": 0}

        result = _invalidate_or_force_close("slide", "s1", 20)

        mock_invalidate.assert_called_once_with("slide", "s1", 20)
        mock_force_close.assert_called_once_with(
            "slide", "s1", reason="version_sync_fallback"
        )
        assert result["invalidated"] is False
        assert result["force_closed"] is True

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api._invalidate_collab_version")
    def test_invalidate_exception_triggers_force_close(
        self, mock_invalidate, mock_force_close
    ):
        """invalidate 抛异常时应降级为 force-close 而非传播异常。"""
        from apps.collab.api import _invalidate_or_force_close

        mock_invalidate.side_effect = ConnectionError("collab-live unreachable")
        mock_force_close.return_value = {"success": True, "loaded": True, "connections_closed": 1}

        result = _invalidate_or_force_close("docs", "d1", 8)

        mock_force_close.assert_called_once_with(
            "docs", "d1", reason="version_sync_fallback"
        )
        assert result["invalidated"] is False
        assert result["force_closed"] is True

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api._invalidate_collab_version")
    def test_both_invalidate_and_force_close_fail(
        self, mock_invalidate, mock_force_close
    ):
        """invalidate 和 force-close 都失败时返回双 False，不抛异常。"""
        from apps.collab.api import _invalidate_or_force_close

        mock_invalidate.return_value = {"success": False, "updated": False}
        mock_force_close.return_value = {"success": False, "loaded": False, "connections_closed": 0}

        result = _invalidate_or_force_close("design", "des1", 15)

        assert result["invalidated"] is False
        assert result["force_closed"] is False

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api._invalidate_collab_version")
    def test_force_close_exception_does_not_propagate(
        self, mock_invalidate, mock_force_close
    ):
        """force-close 抛异常时也不应传播。"""
        from apps.collab.api import _invalidate_or_force_close

        mock_invalidate.return_value = {"success": False, "updated": False}
        mock_force_close.side_effect = RuntimeError("unexpected")

        result = _invalidate_or_force_close("slide", "c2", 3)

        assert result["invalidated"] is False
        assert result["force_closed"] is False

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api._invalidate_collab_version")
    def test_force_close_uses_version_sync_fallback_reason(
        self, mock_invalidate, mock_force_close
    ):
        """VS-013 集成：降级 force-close 使用 version_sync_fallback reason，
        而非 document_restored，避免客户端误清空本地编辑。"""
        from apps.collab.api import _invalidate_or_force_close

        mock_invalidate.return_value = {"success": False, "updated": False}
        mock_force_close.return_value = {"success": True, "loaded": True, "connections_closed": 1}

        _invalidate_or_force_close("docs", "d1", 10)

        _, kwargs = mock_force_close.call_args
        assert kwargs.get("reason") == "version_sync_fallback"


# ══════════════════════════════════════════════════════════
# VID-007 + CVS-004: 各模块调用统一降级函数
# ══════════════════════════════════════════════════════════

class _FakeAtomic:
    """模拟 transaction.atomic 上下文管理器，不需要真实 DB 连接。"""
    def __init__(self, *args, **kwargs):
        pass
    def __enter__(self):
        return self
    def __exit__(self, *args):
        return False


