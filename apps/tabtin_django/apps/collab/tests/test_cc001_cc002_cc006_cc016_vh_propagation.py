"""
CC-001 / CC-002 / CC-006 / CC-016 回归测试

验证 VH 异常传播链路的修复：
- CC-001: VH 写入异常被 catch 后标记 version_history_error，persist 数据不丢失
- CC-002: VH 失败时结果标记 version_history_error，collab-live 可感知
- CC-006: 幂等缓存在 persist 成功后写入（VH 失败不影响 persist 已提交的数据）
- CC-016: _do_create_history 返回 None 时跳过 ChangeLog，避免孤立记录
"""
import os
import uuid
from unittest.mock import MagicMock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402
django.setup()

import pytest  # noqa: E402

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


class _PersistTestBase:

    def setup_method(self):
        _apply_live_patches()
        self._tx_patcher = patch("django.db.transaction.atomic")
        mock_atomic = self._tx_patcher.start()
        mock_atomic.return_value.__enter__ = MagicMock(return_value=None)
        mock_atomic.return_value.__exit__ = MagicMock(return_value=False)

    def teardown_method(self):
        self._tx_patcher.stop()
        _stop_live_patches()

    @staticmethod
    def _make_request():
        req = MagicMock()
        req.headers = {"X-Live-Secret": "collab-live-dev-secret"}
        return req

    @staticmethod
    def _make_body(op_id="test-op", editor_type="system"):
        body = MagicMock()
        body.op_id = op_id
        body.changes = {"changed_records": {}}
        body.editor_type = editor_type
        body.editor_id = ""
        body.editor_name = ""
        body.agent_run_id = ""
        body.system_policy = "trusted_internal"
        return body

    @staticmethod
    def _is_error_response(result, expected_status=500):
        """TCV-017 结构下，异常返回格式为 (status_code, body_dict)。"""
        return (
            isinstance(result, tuple)
            and len(result) == 2
            and result[0] == expected_status
        )

    @staticmethod
    def _is_ok_response(result):
        """正常返回格式为 {"status": "ok", "data": ...}。"""
        return isinstance(result, dict) and result.get("status") == "ok"

    @staticmethod
    def _has_vh_error(result):
        """persist 成功但 VH/CL 写入失败时 data 中携带 version_history_error。"""
        return (
            isinstance(result, dict)
            and result.get("status") == "ok"
            and result.get("data", {}).get("version_history_error") is True
        )


class TestCC001_VHExceptionRollsBackTransaction(_PersistTestBase):
    """CC-001: VH 写入异常 → persist 已提交 → result 标记 version_history_error。"""

    @patch("apps.collab.models.ChangeLog")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.cache")
    @patch("apps.collab.api.VersionHistoryService")
    def test_vh_exception_marks_error_and_no_changelog(
        self, MockVHS, mock_cache, mock_get_adapter, MockCL
    ):
        """VH 抛异常 → persist 数据不丢失，标记 version_history_error，ChangeLog 不写入。"""
        from apps.collab.api import collab_persist

        mock_cache.get.return_value = None

        adapter = MagicMock()
        adapter.persist_changes.return_value = {"version": 1}
        mock_resource = MagicMock(id=uuid.uuid4(), organization_id=uuid.uuid4())
        adapter.get_resource.return_value = mock_resource
        adapter.get_version_data.return_value = {"records": {}}
        mock_get_adapter.return_value = adapter

        mock_svc = MagicMock()
        mock_svc._do_create_history.side_effect = RuntimeError("DB connection lost")
        MockVHS.return_value = mock_svc

        req = self._make_request()
        body = self._make_body(op_id="op-cc001")
        rid = uuid.uuid4()

        result = collab_persist(req, "table", rid, body)

        assert self._has_vh_error(result), (
            f"CC-001: VH 异常后应标记 version_history_error，实际: {result}"
        )
        cl_create = MockCL.objects.using.return_value.create
        cl_create.assert_not_called()

    @patch("apps.collab.models.ChangeLog")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.cache")
    @patch("apps.collab.api.VersionHistoryService")
    def test_get_version_data_exception_propagates(
        self, MockVHS, mock_cache, mock_get_adapter, MockCL
    ):
        """get_version_data 抛异常 → 异常向上传播（框架层返回 500）→ ChangeLog 不写入。"""
        from apps.collab.api import collab_persist

        mock_cache.get.return_value = None

        adapter = MagicMock()
        adapter.persist_changes.return_value = {"version": 1}
        mock_resource = MagicMock(id=uuid.uuid4(), organization_id=uuid.uuid4())
        adapter.get_resource.return_value = mock_resource
        adapter.get_version_data.side_effect = RuntimeError("snapshot build failed")
        mock_get_adapter.return_value = adapter

        req = self._make_request()
        body = self._make_body(op_id="op-cc001-vd")
        rid = uuid.uuid4()

        with pytest.raises(RuntimeError, match="snapshot build failed"):
            collab_persist(req, "table", rid, body)

        cl_create = MockCL.objects.using.return_value.create
        cl_create.assert_not_called()


class TestCC002_VHFailureRetryable(_PersistTestBase):
    """CC-002: VH 失败 → version_history_error 标记 → collab-live 可感知。"""

    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.cache")
    @patch("apps.collab.api.VersionHistoryService")
    def test_vh_failure_marks_version_history_error(
        self, MockVHS, mock_cache, mock_get_adapter
    ):
        """VH 失败时 result.data 应包含 version_history_error=True。"""
        from apps.collab.api import collab_persist

        mock_cache.get.return_value = None

        adapter = MagicMock()
        adapter.persist_changes.return_value = {"version": 1}
        mock_resource = MagicMock(id=uuid.uuid4(), organization_id=uuid.uuid4())
        adapter.get_resource.return_value = mock_resource
        adapter.get_version_data.return_value = {"records": {}}
        mock_get_adapter.return_value = adapter

        mock_svc = MagicMock()
        mock_svc._do_create_history.side_effect = Exception("VH write failed")
        MockVHS.return_value = mock_svc

        req = self._make_request()
        body = self._make_body(op_id="op-cc002")
        rid = uuid.uuid4()

        result = collab_persist(req, "table", rid, body)

        assert self._has_vh_error(result), (
            f"CC-002: VH 失败应标记 version_history_error，实际: {result}"
        )

    @patch("apps.collab.models.ChangeLog")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.cache")
    @patch("apps.collab.api.VersionHistoryService")
    def test_successful_vh_returns_200(
        self, MockVHS, mock_cache, mock_get_adapter, MockCL
    ):
        """VH 成功 → 正常 200 响应。"""
        from apps.collab.api import collab_persist

        mock_cache.get.return_value = None

        adapter = MagicMock()
        adapter.persist_changes.return_value = {"version": 2}
        mock_resource = MagicMock(id=uuid.uuid4(), organization_id=uuid.uuid4())
        adapter.get_resource.return_value = mock_resource
        adapter.get_version_data.return_value = {"records": {}}
        mock_get_adapter.return_value = adapter

        mock_vh = MagicMock(id=uuid.uuid4())
        mock_svc = MagicMock()
        mock_svc._do_create_history.return_value = mock_vh
        MockVHS.return_value = mock_svc

        req = self._make_request()
        body = self._make_body(op_id="op-cc002-ok")
        rid = uuid.uuid4()

        result = collab_persist(req, "table", rid, body)

        assert self._is_ok_response(result), (
            f"VH 成功应返回 200，实际: {result}"
        )
        assert "version_history_error" not in result.get("data", {})


class TestCC006_IdempotencyCacheAfterSuccess(_PersistTestBase):
    """CC-006: 幂等缓存在 persist 成功后设置（VH 失败不阻止 cache 写入）。"""

    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.cache")
    @patch("apps.collab.api.VersionHistoryService")
    def test_cache_set_even_when_vh_fails(
        self, MockVHS, mock_cache, mock_get_adapter
    ):
        """VH 失败但 persist 成功 → 幂等缓存仍应设置（persist 数据已提交）。"""
        from apps.collab.api import collab_persist

        mock_cache.get.return_value = None

        adapter = MagicMock()
        adapter.persist_changes.return_value = {"version": 1}
        mock_resource = MagicMock(id=uuid.uuid4(), organization_id=uuid.uuid4())
        adapter.get_resource.return_value = mock_resource
        adapter.get_version_data.return_value = {"data": "val"}
        mock_get_adapter.return_value = adapter

        mock_svc = MagicMock()
        mock_svc._do_create_history.side_effect = RuntimeError("VH crash")
        MockVHS.return_value = mock_svc

        req = self._make_request()
        body = self._make_body(op_id="op-cc006-fail")
        rid = uuid.uuid4()

        result = collab_persist(req, "table", rid, body)

        assert self._has_vh_error(result)
        cache_set_calls = [
            c for c in mock_cache.set.call_args_list
            if "collab:persist:" in str(c)
        ]
        assert len(cache_set_calls) == 1, (
            "CC-006: persist 成功后应设置幂等缓存（即使 VH 失败），"
            f"实际 cache.set 调用: {mock_cache.set.call_args_list}"
        )

    @patch("apps.collab.models.ChangeLog")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.cache")
    @patch("apps.collab.api.VersionHistoryService")
    def test_cache_set_when_vh_succeeds(
        self, MockVHS, mock_cache, mock_get_adapter, MockCL
    ):
        """VH+CL 成功 → 幂等缓存正常设置。"""
        from apps.collab.api import collab_persist

        mock_cache.get.return_value = None

        adapter = MagicMock()
        adapter.persist_changes.return_value = {"version": 2}
        mock_resource = MagicMock(id=uuid.uuid4(), organization_id=uuid.uuid4())
        adapter.get_resource.return_value = mock_resource
        adapter.get_version_data.return_value = {"data": "val"}
        mock_get_adapter.return_value = adapter

        mock_vh = MagicMock(id=uuid.uuid4())
        mock_svc = MagicMock()
        mock_svc._do_create_history.return_value = mock_vh
        MockVHS.return_value = mock_svc

        req = self._make_request()
        body = self._make_body(op_id="op-cc006-ok")
        rid = uuid.uuid4()

        collab_persist(req, "table", rid, body)

        cache_set_calls = [
            c for c in mock_cache.set.call_args_list
            if "collab:persist:" in str(c)
        ]
        assert len(cache_set_calls) == 1, (
            "CC-006: VH 成功后应设置幂等缓存，"
            f"实际 cache.set 调用: {mock_cache.set.call_args_list}"
        )

    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.cache")
    @patch("apps.collab.api.VersionHistoryService")
    def test_retry_works_after_vh_failure(
        self, MockVHS, mock_cache, mock_get_adapter
    ):
        """VH 失败后重试时 persist 正常执行（不被误判为重复请求）。"""
        from apps.collab.api import collab_persist

        mock_cache.get.return_value = None

        adapter = MagicMock()
        adapter.persist_changes.return_value = {"version": 1}
        mock_resource = MagicMock(id=uuid.uuid4(), organization_id=uuid.uuid4())
        adapter.get_resource.return_value = mock_resource
        adapter.get_version_data.return_value = {"data": "val"}
        mock_get_adapter.return_value = adapter

        mock_svc = MagicMock()
        mock_svc._do_create_history.side_effect = RuntimeError("VH crash")
        MockVHS.return_value = mock_svc

        req = self._make_request()
        body = self._make_body(op_id="op-cc006-retry")
        rid = uuid.uuid4()

        result1 = collab_persist(req, "table", rid, body)
        assert self._has_vh_error(result1)

        result2 = collab_persist(req, "table", rid, body)
        assert self._has_vh_error(result2)
        assert adapter.persist_changes.call_count == 2, (
            "CC-006: VH 失败后重试应正常执行 persist"
        )


class TestCC016_SkipChangeLogWhenVHNone(_PersistTestBase):
    """CC-016: _do_create_history 返回 None 时不写入 ChangeLog。"""

    @patch("apps.collab.models.ChangeLog")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.cache")
    @patch("apps.collab.api.VersionHistoryService")
    def test_vh_none_skips_changelog(
        self, MockVHS, mock_cache, mock_get_adapter, MockCL
    ):
        """_do_create_history 返回 None → ChangeLog 不应被创建。"""
        from apps.collab.api import collab_persist

        mock_cache.get.return_value = None

        adapter = MagicMock()
        adapter.persist_changes.return_value = {"version": 1}
        mock_resource = MagicMock(id=uuid.uuid4(), organization_id=uuid.uuid4())
        adapter.get_resource.return_value = mock_resource
        adapter.get_version_data.return_value = {"records": {}}
        mock_get_adapter.return_value = adapter

        mock_svc = MagicMock()
        mock_svc._do_create_history.return_value = None
        MockVHS.return_value = mock_svc

        req = self._make_request()
        body = self._make_body(op_id="op-cc016")
        rid = uuid.uuid4()

        result = collab_persist(req, "table", rid, body)

        cl_create = MockCL.objects.using.return_value.create
        cl_create.assert_not_called()
        assert self._is_ok_response(result)

    @patch("apps.collab.models.ChangeLog")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.cache")
    @patch("apps.collab.api.VersionHistoryService")
    def test_vh_created_writes_changelog(
        self, MockVHS, mock_cache, mock_get_adapter, MockCL
    ):
        """_do_create_history 返回有效 VH → ChangeLog 正常写入。"""
        from apps.collab.api import collab_persist

        mock_cache.get.return_value = None

        adapter = MagicMock()
        adapter.persist_changes.return_value = {"version": 2}
        mock_resource = MagicMock(id=uuid.uuid4(), organization_id=uuid.uuid4())
        adapter.get_resource.return_value = mock_resource
        adapter.get_version_data.return_value = {"records": {}}
        mock_get_adapter.return_value = adapter

        mock_vh = MagicMock(id=uuid.uuid4())
        mock_svc = MagicMock()
        mock_svc._do_create_history.return_value = mock_vh
        MockVHS.return_value = mock_svc

        req = self._make_request()
        body = self._make_body(op_id="op-cc016-ok")
        rid = uuid.uuid4()

        result = collab_persist(req, "table", rid, body)

        cl_create = MockCL.objects.using.return_value.create
        cl_create.assert_called_once()
        _, kwargs = cl_create.call_args
        assert kwargs.get("version_history") == mock_vh
        assert self._is_ok_response(result)

    @patch("apps.collab.models.ChangeLog")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.cache")
    def test_version_data_none_skips_vh_and_changelog(
        self, mock_cache, mock_get_adapter, MockCL
    ):
        """version_data 为 None → 无 VH 可创建 → ChangeLog 也跳过。"""
        from apps.collab.api import collab_persist

        mock_cache.get.return_value = None

        adapter = MagicMock()
        adapter.persist_changes.return_value = {"version": 3}
        mock_resource = MagicMock(id=uuid.uuid4(), organization_id=uuid.uuid4())
        adapter.get_resource.return_value = mock_resource
        adapter.get_version_data.return_value = None
        mock_get_adapter.return_value = adapter

        req = self._make_request()
        body = self._make_body(op_id="op-cc016-vd-none")
        rid = uuid.uuid4()

        result = collab_persist(req, "table", rid, body)

        cl_create = MockCL.objects.using.return_value.create
        cl_create.assert_not_called()
        assert self._is_ok_response(result)
