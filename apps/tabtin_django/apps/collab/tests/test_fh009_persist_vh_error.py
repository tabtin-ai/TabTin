"""
FH-009 回归测试

验证 collab_persist 的 VersionHistory 写入失败处理：
- VH/CL 写入失败时标记 version_history_error，persist 数据不丢失
- 日志应记录 ERROR 级别
"""
import os
import uuid
from contextlib import contextmanager
from unittest.mock import MagicMock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402
django.setup()

import pytest  # noqa: E402

@contextmanager
def _noop_atomic(*args, **kwargs):
    yield


_LIVE_PATCHES = [
    patch("apps.collab.api._get_live_secret", return_value="collab-live-dev-secret"),
    patch("apps.collab.api._cached_is_debug", return_value=True),
]


def _apply_live_patches():
    mocks = [p.start() for p in _LIVE_PATCHES]
    return mocks


def _stop_live_patches():
    for p in _LIVE_PATCHES:
        p.stop()


class TestCollabPersistVersionHistoryError:
    """验证 VersionHistory 写入失败时客户端能感知。"""

    def setup_method(self):
        _apply_live_patches()

    def teardown_method(self):
        _stop_live_patches()

    def _make_request(self):
        req = MagicMock()
        req.headers = {"X-Live-Secret": "collab-live-dev-secret"}
        return req

    def _make_body(self, op_id="test-op"):
        body = MagicMock()
        body.op_id = op_id
        body.changes = {"changed_records": {}}
        body.editor_type = "system"
        body.editor_id = ""
        body.editor_name = ""
        body.agent_run_id = ""
        body.system_policy = "trusted_internal"
        return body

    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.cache")
    @patch("apps.collab.api.VersionHistoryService")
    @patch("django.db.transaction.atomic", side_effect=lambda *a, **kw: _noop_atomic())
    def test_vh_write_failure_marks_error(
        self, mock_atomic, MockVHS, mock_cache, mock_get_adapter
    ):
        """VH 写入失败时 result 应携带 version_history_error 标记。"""
        from apps.collab.api import collab_persist

        mock_cache.get.return_value = None

        adapter = MagicMock()
        adapter.persist_changes.return_value = {"version": 1}
        mock_resource = MagicMock(id=uuid.uuid4(), organization_id=uuid.uuid4())
        adapter.get_resource.return_value = mock_resource
        adapter.get_version_data.return_value = {"records": {}}
        mock_get_adapter.return_value = adapter

        mock_svc = MagicMock()
        mock_svc._do_create_history.side_effect = RuntimeError("snapshot build failed")
        MockVHS.return_value = mock_svc

        req = self._make_request()
        body = self._make_body(op_id="op-vh-fail")
        rid = uuid.uuid4()

        result = collab_persist(req, "table", rid, body)

        assert isinstance(result, dict), f"Expected dict, got {type(result)}: {result}"
        assert result["status"] == "ok"
        assert result["data"].get("version_history_error") is True

    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.cache")
    @patch("apps.collab.api.VersionHistoryService")
    @patch("django.db.transaction.atomic", side_effect=lambda *a, **kw: _noop_atomic())
    def test_changelog_write_failure_marks_error(
        self, mock_atomic, MockVHS, mock_cache, mock_get_adapter
    ):
        """ChangeLog 写入失败时 result 应携带 version_history_error 标记。"""
        from apps.collab.api import collab_persist

        mock_cache.get.return_value = None

        adapter = MagicMock()
        adapter.persist_changes.return_value = {"version": 2}
        mock_resource = MagicMock(id=uuid.uuid4(), organization_id=uuid.uuid4())
        adapter.get_resource.return_value = mock_resource
        adapter.get_version_data.return_value = {"records": {}}
        mock_get_adapter.return_value = adapter

        mock_svc = MagicMock()
        mock_svc._do_create_history.return_value = MagicMock(id=uuid.uuid4())
        MockVHS.return_value = mock_svc

        req = self._make_request()
        body = self._make_body(op_id="op-cl-fail")
        rid = uuid.uuid4()

        with patch("apps.collab.models.ChangeLog") as MockCL:
            MockCL.objects.using.return_value.create.side_effect = RuntimeError("DB down")
            MockCL.objects.using.return_value.filter.return_value.order_by.return_value.first.return_value = None
            result = collab_persist(req, "table", rid, body)

        assert isinstance(result, dict), f"Expected dict, got {type(result)}: {result}"
        assert result["status"] == "ok"
        assert result["data"].get("version_history_error") is True

    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.cache")
    @patch("django.db.transaction.atomic", side_effect=lambda *a, **kw: _noop_atomic())
    def test_successful_persist_no_error_flag(self, mock_atomic, mock_cache, mock_get_adapter):
        """正常成功（skipped=True）时响应 data 不应包含 version_history_error。"""
        from apps.collab.api import collab_persist

        mock_cache.get.return_value = None

        adapter = MagicMock()
        adapter.persist_changes.return_value = {"version": 3, "skipped": True}
        adapter.get_resource.return_value = MagicMock(id=uuid.uuid4())
        mock_get_adapter.return_value = adapter

        req = self._make_request()
        body = self._make_body(op_id="op-ok")
        rid = uuid.uuid4()

        result = collab_persist(req, "table", rid, body)

        assert isinstance(result, dict), f"Expected dict, got {type(result)}: {result}"
        assert result["status"] == "ok"
        assert "version_history_error" not in result.get("data", {})

    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.cache")
    @patch("apps.collab.api.VersionHistoryService")
    @patch("django.db.transaction.atomic", side_effect=lambda *a, **kw: _noop_atomic())
    def test_vh_failure_logged_at_error_level(
        self, mock_atomic, MockVHS, mock_cache, mock_get_adapter
    ):
        """VersionHistory 写入失败时应记录 ERROR 级别日志。"""
        from apps.collab.api import collab_persist

        mock_cache.get.return_value = None

        adapter = MagicMock()
        adapter.persist_changes.return_value = {"version": 1}
        mock_resource = MagicMock(id=uuid.uuid4(), organization_id=uuid.uuid4())
        adapter.get_resource.return_value = mock_resource
        adapter.get_version_data.return_value = {"records": {}}
        mock_get_adapter.return_value = adapter

        mock_svc = MagicMock()
        mock_svc._do_create_history.side_effect = RuntimeError("VH crash")
        MockVHS.return_value = mock_svc

        req = self._make_request()
        body = self._make_body(op_id="op-log-check")
        rid = uuid.uuid4()

        with patch("apps.collab.api.logger") as mock_logger:
            collab_persist(req, "table", rid, body)

            exception_calls = mock_logger.exception.call_args_list
            assert len(exception_calls) >= 1, (
                "VH 写入失败应记录 ERROR/EXCEPTION 级别日志，"
                f"实际 exception 调用: {exception_calls}"
            )
