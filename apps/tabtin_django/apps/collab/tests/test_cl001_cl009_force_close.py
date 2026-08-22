"""
CL-001 / CL-009 回归测试 — Force-Close 可靠性

CL-001: _force_close_collab_document 失败时不再静默吞错，
        返回结构化结果，调用方在 API 响应中附带 collab_sync_warning。
CL-009: collab-live 端文档不在内存时返回 loaded=false（TypeScript 侧已修复），
        Django 侧正确解读该字段并传递给前端。
"""
import os
import uuid
from unittest.mock import MagicMock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402
django.setup()

import pytest  # noqa: E402


class TestForceCloseCollabDocument:
    """验证 _force_close_collab_document 的返回值语义。"""

    @patch("apps.services.common.live_api.call_live_api_safe")
    def test_returns_success_with_loaded_true(self, mock_call):
        """collab-live 返回正常（文档在内存中）→ success=True, loaded=True。"""
        from apps.collab.api import _force_close_collab_document

        mock_call.return_value = {
            "document_id": "slide:abc",
            "reason": "document_restored",
            "loaded": True,
            "connections_closed": 5,
        }

        result = _force_close_collab_document("slide", "abc")
        assert result["success"] is True
        assert result["loaded"] is True
        assert result["connections_closed"] == 5

    @patch("apps.services.common.live_api.call_live_api_safe")
    def test_returns_success_with_loaded_false(self, mock_call):
        """collab-live 返回 loaded=false（文档不在内存，CL-009 场景）→
        success=True, loaded=False。"""
        from apps.collab.api import _force_close_collab_document

        mock_call.return_value = {
            "document_id": "doc:xyz",
            "reason": "document_restored",
            "loaded": False,
            "connections_closed": 0,
        }

        result = _force_close_collab_document("doc", "xyz")
        assert result["success"] is True
        assert result["loaded"] is False
        assert result["connections_closed"] == 0

    @patch("apps.services.common.live_api.call_live_api_safe")
    def test_returns_failure_on_error(self, mock_call):
        """call_live_api_safe 返回 error → success=False。"""
        from apps.collab.api import _force_close_collab_document

        mock_call.return_value = {"error": "collab-live 服务不可用"}

        result = _force_close_collab_document("table", "t-123")
        assert result["success"] is False
        assert result["loaded"] is False

    @patch("apps.services.common.live_api.call_live_api_safe")
    def test_max_retries_is_3(self, mock_call):
        """验证 max_retries 已从 1 提升到 3。"""
        from apps.collab.api import _force_close_collab_document

        mock_call.return_value = {"loaded": True, "connections_closed": 0}
        _force_close_collab_document("slide", "s-1")

        _, kwargs = mock_call.call_args
        assert kwargs.get("max_retries", mock_call.call_args) == 3

    @patch("apps.services.common.live_api.call_live_api_safe")
    def test_backward_compat_no_loaded_field(self, mock_call):
        """旧版 collab-live 不返回 loaded 字段时，默认视为 loaded=True。"""
        from apps.collab.api import _force_close_collab_document

        mock_call.return_value = {"document_id": "doc:old", "reason": "document_restored"}

        result = _force_close_collab_document("doc", "old")
        assert result["success"] is True
        assert result["loaded"] is True


class TestForceCloseCallArguments:
    """验证 _force_close_collab_document 向 call_live_api_safe 传递的参数正确性。"""

    @patch("apps.services.common.live_api.call_live_api_safe")
    def test_document_id_format_is_type_colon_id(self, mock_call):
        """document_id 格式为 '{resource_type}:{resource_id}'。"""
        from apps.collab.api import _force_close_collab_document

        mock_call.return_value = {"loaded": True, "connections_closed": 0}
        _force_close_collab_document("design", "d-abc-123")

        args, kwargs = mock_call.call_args
        assert args[0] == "/admin/force-close"
        body = args[1]
        assert body["document_id"] == "design:d-abc-123"
        assert body["reason"] == "document_restored"

    @patch("apps.services.common.live_api.call_live_api_safe")
    def test_timeout_and_source_are_set(self, mock_call):
        """验证 timeout=5 和 source 标识。"""
        from apps.collab.api import _force_close_collab_document

        mock_call.return_value = {"loaded": True, "connections_closed": 0}
        _force_close_collab_document("table", "t-1")

        _, kwargs = mock_call.call_args
        assert kwargs["timeout"] == 5
        assert kwargs["source"] == "collab.restore"


class TestRestoreVersionCollabSyncWarning:
    """验证 restore_version API 在 force-close 异常时附带 collab_sync_warning。"""

    def _make_request(self, user_id="u-test"):
        req = MagicMock()
        req.auth = MagicMock()
        req.auth.id = user_id
        req.auth.nickname = "tester"
        return req

    def _make_body(self, version_id=None):
        body = MagicMock()
        body.version_id = version_id or uuid.uuid4()
        return body

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api.VersionHistoryService")
    @patch("apps.collab.api.get_adapter_or_raise")
    def test_collab_sync_warning_on_force_close_failure(
        self, mock_get_adapter, mock_vh_svc_cls, mock_fc
    ):
        """force-close 失败 → 响应中包含 collab_sync_warning=force_close_failed。"""
        from apps.collab.api import restore_version

        adapter = MagicMock()
        adapter.get_resource.return_value = MagicMock()
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        vh = MagicMock()
        vh.id = uuid.uuid4()
        mock_svc = MagicMock()
        mock_svc.restore_to_version.return_value = vh
        mock_vh_svc_cls.return_value = mock_svc

        mock_fc.return_value = {"success": False, "loaded": False, "connections_closed": 0}

        req = self._make_request()
        body = self._make_body()
        resp = restore_version(req, "slide", uuid.uuid4(), body)

        assert resp["status"] == "ok"
        assert resp["data"]["collab_sync_warning"] == "force_close_failed"

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api.VersionHistoryService")
    @patch("apps.collab.api.get_adapter_or_raise")
    def test_collab_sync_warning_on_not_loaded(
        self, mock_get_adapter, mock_vh_svc_cls, mock_fc
    ):
        """文档不在内存 → collab_sync_warning=document_not_loaded。"""
        from apps.collab.api import restore_version

        adapter = MagicMock()
        adapter.get_resource.return_value = MagicMock()
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        vh = MagicMock()
        vh.id = uuid.uuid4()
        mock_svc = MagicMock()
        mock_svc.restore_to_version.return_value = vh
        mock_vh_svc_cls.return_value = mock_svc

        mock_fc.return_value = {"success": True, "loaded": False, "connections_closed": 0}

        req = self._make_request()
        body = self._make_body()
        resp = restore_version(req, "slide", uuid.uuid4(), body)

        assert resp["status"] == "ok"
        assert resp["data"]["collab_sync_warning"] == "document_not_loaded"

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api.VersionHistoryService")
    @patch("apps.collab.api.get_adapter_or_raise")
    def test_no_warning_on_success(
        self, mock_get_adapter, mock_vh_svc_cls, mock_fc
    ):
        """force-close 成功且文档在内存 → 无 collab_sync_warning。"""
        from apps.collab.api import restore_version

        adapter = MagicMock()
        adapter.get_resource.return_value = MagicMock()
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        vh = MagicMock()
        vh.id = uuid.uuid4()
        mock_svc = MagicMock()
        mock_svc.restore_to_version.return_value = vh
        mock_vh_svc_cls.return_value = mock_svc

        mock_fc.return_value = {"success": True, "loaded": True, "connections_closed": 3}

        req = self._make_request()
        body = self._make_body()
        resp = restore_version(req, "slide", uuid.uuid4(), body)

        assert resp["status"] == "ok"
        assert "collab_sync_warning" not in resp["data"]
