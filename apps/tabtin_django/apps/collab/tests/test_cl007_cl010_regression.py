"""
CL-007 / CL-010 回归测试

CL-007: DocsCollabAdapter.restore 必须将 HTTP IO（push_and_update_binary、
        binary-to-formats 转换）延迟到事务提交后执行（transaction.on_commit），
        而非在 _do_restore 的 transaction.atomic 持锁期间进行。

CL-010: cleanup_expired_versions 和 downsample_versions 必须使用独立锁 key，
        确保每小时两者均能独立执行，互不阻塞。
"""
import os
import uuid
from unittest.mock import MagicMock, patch, call

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402
django.setup()

import pytest  # noqa: E402

from apps.collab.adapters.docs import DocsCollabAdapter  # noqa: E402


# ================================================================
# CL-007: restore 的 HTTP IO 必须在事务外执行
# ================================================================

def _make_doc_service_mock():
    """创建 DocumentService mock，处理 assert_ 前缀方法的 MagicMock 限制。"""
    mock_svc = MagicMock()
    mock_svc.assert_document_content_editable = MagicMock(return_value=None)
    return mock_svc


class TestCL007RestoreNoHTTPInTransaction:
    """CL-007: restore() 不得在 transaction.atomic 持锁期间进行 HTTP 调用。"""

    def setup_method(self):
        self.adapter = DocsCollabAdapter()

    @patch("apps.tabdoc.services.document_service.DocumentService")
    @patch("apps.tabdoc.services.document_service.normalize_tabdata_snapshot")
    @patch("apps.tabdoc.models.Document")
    @patch("django.db.transaction")
    def test_json_snapshot_push_binary_uses_on_commit(
        self, mock_tx, MockDocument, mock_normalize, MockDocService,
    ):
        """JSON snapshot 路径的 push_and_update_binary 应通过 on_commit 延迟执行。"""
        mock_normalize.return_value = ({"type": "doc"}, "# hello")
        MockDocService.return_value = _make_doc_service_mock()

        mock_qs = MagicMock()
        MockDocument.objects.using.return_value = mock_qs

        on_commit_callbacks = []
        mock_tx.on_commit = lambda fn, using=None: on_commit_callbacks.append(fn)

        resource = MagicMock()
        resource.id = uuid.uuid4()
        data = {
            "format": "json_snapshot",
            "description_json": {"type": "doc", "content": []},
            "description_markdown": "# hello",
            "description_plaintext": "hello",
        }

        self.adapter.restore(resource, data)

        mock_qs.filter.return_value.update.assert_called_once()
        update_kwargs = mock_qs.filter.return_value.update.call_args.kwargs
        assert update_kwargs["description_binary"] is None
        assert "description_json" in update_kwargs

        assert len(on_commit_callbacks) == 1, (
            "push_and_update_binary must be deferred via on_commit"
        )

        MockDocService.push_and_update_binary.assert_not_called()

    @patch("apps.tabdoc.services.document_service.DocumentService")
    @patch("apps.tabdoc.services.document_service.normalize_tabdata_snapshot")
    @patch("apps.tabdoc.models.Document")
    @patch("django.db.transaction")
    def test_json_snapshot_on_commit_callback_calls_push_binary(
        self, mock_tx, MockDocument, mock_normalize, MockDocService,
    ):
        """on_commit 回调触发后应调用 push_and_update_binary。"""
        mock_normalize.return_value = ({"type": "doc"}, "# hello")
        MockDocService.return_value = _make_doc_service_mock()

        mock_qs = MagicMock()
        mock_fresh = MagicMock()
        mock_qs.get.return_value = mock_fresh
        mock_qs.filter.return_value = mock_qs
        MockDocument.objects.using.return_value = mock_qs

        on_commit_callbacks = []
        mock_tx.on_commit = lambda fn, using=None: on_commit_callbacks.append(fn)

        resource = MagicMock()
        resource.id = uuid.uuid4()
        data = {
            "format": "json_snapshot",
            "description_json": {"type": "doc"},
            "description_markdown": "# hello",
        }

        self.adapter.restore(resource, data)

        assert len(on_commit_callbacks) == 1
        on_commit_callbacks[0]()

        MockDocService.push_and_update_binary.assert_called_once()
        call_args = MockDocService.push_and_update_binary.call_args
        assert call_args.args[0] is mock_fresh
        assert call_args.kwargs.get("agent_id") == "system:collab_restore"

    @patch("apps.tabdoc.services.document_service.DocumentService")
    @patch("apps.tabdoc.models.Document")
    @patch("django.db.transaction")
    def test_bytes_no_prepared_uses_on_commit_for_format_conversion(
        self, mock_tx, MockDocument, MockDocService,
    ):
        """bytes 路径无 prepared 时，binary→formats 转换应通过 on_commit 延迟。"""
        MockDocService.return_value = _make_doc_service_mock()

        mock_qs = MagicMock()
        MockDocument.objects.using.return_value = mock_qs

        on_commit_callbacks = []
        mock_tx.on_commit = lambda fn, using=None: on_commit_callbacks.append(fn)

        resource = MagicMock()
        resource.id = uuid.uuid4()
        binary_data = b"fake-yjs-binary"

        self.adapter.restore(resource, binary_data)

        mock_qs.filter.return_value.update.assert_called_once()
        update_kwargs = mock_qs.filter.return_value.update.call_args.kwargs
        assert update_kwargs["description_binary"] == binary_data

        assert len(on_commit_callbacks) == 1, (
            "binary-to-formats conversion must be deferred via on_commit"
        )

    @patch("apps.tabdoc.services.document_service.DocumentService")
    @patch("apps.tabdoc.services.document_service.normalize_tabdata_snapshot")
    @patch("apps.tabdoc.models.Document")
    @patch("django.db.transaction")
    def test_bytes_with_prepared_no_on_commit(
        self, mock_tx, MockDocument, mock_normalize, MockDocService,
    ):
        """bytes 路径有 prepared 时，格式已预转换，不需要 on_commit 回调。"""
        mock_normalize.return_value = ({"type": "doc"}, "# prepared")
        MockDocService.return_value = _make_doc_service_mock()

        mock_qs = MagicMock()
        MockDocument.objects.using.return_value = mock_qs

        on_commit_callbacks = []
        mock_tx.on_commit = lambda fn, using=None: on_commit_callbacks.append(fn)

        resource = MagicMock()
        resource.id = uuid.uuid4()
        binary_data = b"fake-yjs-binary"
        prepared = {"json": {"type": "doc"}, "markdown": "# prepared", "plaintext": "prepared"}

        self.adapter.restore(resource, binary_data, prepared=prepared)

        update_kwargs = mock_qs.filter.return_value.update.call_args.kwargs
        assert update_kwargs["description_binary"] == binary_data
        assert update_kwargs["description_markdown"] == "# prepared"

        assert len(on_commit_callbacks) == 0, (
            "No on_commit needed when prepared formats are available"
        )

    @patch("apps.tabdoc.services.document_service.DocumentService")
    @patch("apps.tabdoc.services.document_service.normalize_tabdata_snapshot")
    @patch("apps.tabdoc.models.Document")
    @patch("django.db.transaction")
    def test_no_transaction_atomic_wrapping_update(
        self, mock_tx, MockDocument, mock_normalize, MockDocService,
    ):
        """restore 内部不应有自己的 transaction.atomic 包裹（依赖外层 _do_restore 事务）。"""
        mock_normalize.return_value = ({"type": "doc"}, "# hello")
        MockDocService.return_value = _make_doc_service_mock()

        mock_qs = MagicMock()
        MockDocument.objects.using.return_value = mock_qs

        mock_tx.on_commit = lambda fn, using=None: None

        resource = MagicMock()
        resource.id = uuid.uuid4()
        data = {
            "format": "json_snapshot",
            "description_json": {"type": "doc"},
            "description_markdown": "# hello",
        }

        self.adapter.restore(resource, data)

        mock_tx.atomic.assert_not_called()


# ================================================================
# CL-010: cleanup 和 downsample 必须使用独立锁 key
# ================================================================

class TestCL010IndependentLockKeys:
    """CL-010: cleanup_expired 和 downsample_versions 使用独立锁，互不阻塞。"""

    def test_lock_keys_are_distinct(self):
        """两个任务的锁 key 必须不同。"""
        from apps.collab.tasks import CLEANUP_LOCK_KEY, DOWNSAMPLE_LOCK_KEY
        assert CLEANUP_LOCK_KEY != DOWNSAMPLE_LOCK_KEY

    def test_cleanup_uses_cleanup_lock(self):
        """cleanup_expired_versions 使用 CLEANUP_LOCK_KEY。"""
        from apps.collab.tasks import cleanup_expired_versions, CLEANUP_LOCK_KEY

        with patch("apps.collab.tasks.cache") as mock_cache:
            mock_cache.add.return_value = False
            cleanup_expired_versions()
            mock_cache.add.assert_called_once_with(
                CLEANUP_LOCK_KEY, "cleanup", pytest.approx(660, abs=60),
            )

    def test_downsample_uses_downsample_lock(self):
        """downsample_versions 使用 DOWNSAMPLE_LOCK_KEY。"""
        from apps.collab.tasks import downsample_versions, DOWNSAMPLE_LOCK_KEY

        with patch("apps.collab.tasks.cache") as mock_cache:
            mock_cache.add.return_value = False
            downsample_versions()
            mock_cache.add.assert_called_once_with(
                DOWNSAMPLE_LOCK_KEY, "downsample", pytest.approx(660, abs=60),
            )

    def test_both_tasks_can_run_concurrently(self):
        """两个任务可以同时获取各自的锁，不互相阻塞。"""
        from apps.collab.tasks import (
            cleanup_expired_versions,
            downsample_versions,
            CLEANUP_LOCK_KEY,
            DOWNSAMPLE_LOCK_KEY,
        )

        acquired_locks = set()

        def mock_cache_add(key, value, ttl):
            if key in acquired_locks:
                return False
            acquired_locks.add(key)
            return True

        with patch("apps.collab.tasks.cache") as mock_cache, \
             patch("apps.collab.tasks.VersionHistoryService") as MockSvc:
            mock_cache.add.side_effect = mock_cache_add
            mock_cache.delete = lambda k: acquired_locks.discard(k)
            mock_svc_inst = MagicMock()
            mock_svc_inst.cleanup_expired_versions.return_value = 0
            mock_svc_inst.downsample_versions.return_value = 0
            MockSvc.return_value = mock_svc_inst

            cleanup_expired_versions()
            assert CLEANUP_LOCK_KEY not in acquired_locks

            acquired_locks.add(DOWNSAMPLE_LOCK_KEY)
            result = cleanup_expired_versions()
            assert CLEANUP_LOCK_KEY not in acquired_locks
            assert result == 0

    def test_old_maintenance_lock_key_not_used_by_tasks(self):
        """旧的 MAINTENANCE_LOCK_KEY 不应被任何任务函数使用。"""
        import inspect
        from apps.collab.tasks import (
            cleanup_expired_versions,
            downsample_versions,
            MAINTENANCE_LOCK_KEY,
        )
        cleanup_src = inspect.getsource(cleanup_expired_versions)
        downsample_src = inspect.getsource(downsample_versions)
        assert "MAINTENANCE_LOCK_KEY" not in cleanup_src
        assert "MAINTENANCE_LOCK_KEY" not in downsample_src

    def test_cleanup_releases_lock_on_service_exception(self):
        """cleanup 任务在 service 抛异常时仍必须释放锁。"""
        from apps.collab.tasks import cleanup_expired_versions, CLEANUP_LOCK_KEY

        with patch("apps.collab.tasks.cache") as mock_cache, \
             patch("apps.collab.tasks.VersionHistoryService") as MockSvc:
            mock_cache.add.return_value = True
            MockSvc.return_value.cleanup_expired_versions.side_effect = RuntimeError("db down")

            with pytest.raises(RuntimeError):
                cleanup_expired_versions()

            mock_cache.delete.assert_called_once_with(CLEANUP_LOCK_KEY)

    def test_downsample_releases_lock_on_service_exception(self):
        """downsample 任务在 service 抛异常时仍必须释放锁。"""
        from apps.collab.tasks import downsample_versions, DOWNSAMPLE_LOCK_KEY

        with patch("apps.collab.tasks.cache") as mock_cache, \
             patch("apps.collab.tasks.VersionHistoryService") as MockSvc:
            mock_cache.add.return_value = True
            MockSvc.return_value.downsample_versions.side_effect = RuntimeError("db down")

            with pytest.raises(RuntimeError):
                downsample_versions()

            mock_cache.delete.assert_called_once_with(DOWNSAMPLE_LOCK_KEY)


# ================================================================
# CL-007 补充：prepare_restore 和 on_commit 错误容错
# ================================================================

class TestCL007PrepareRestoreAndErrorResilience:
    """CL-007 补充：prepare_restore 在事务外运行，on_commit 回调错误不传播。"""

    def setup_method(self):
        self.adapter = DocsCollabAdapter()

    @patch("apps.services.common.live_api.call_live_api")
    def test_prepare_restore_calls_live_api_for_binary(self, mock_call):
        """prepare_restore 对 bytes 数据调用 call_live_api 进行格式转换。"""
        mock_call.return_value = {"json": {}, "markdown": "# md", "plaintext": "text"}
        resource = MagicMock()

        result = self.adapter.prepare_restore(resource, b"fake-binary")

        mock_call.assert_called_once()
        assert result["markdown"] == "# md"

    def test_prepare_restore_returns_none_for_non_binary(self):
        """prepare_restore 对非 bytes 数据直接返回 None（无需 HTTP 调用）。"""
        resource = MagicMock()
        assert self.adapter.prepare_restore(resource, {"format": "json_snapshot"}) is None
        assert self.adapter.prepare_restore(resource, "string") is None

    @patch("apps.services.common.live_api.call_live_api")
    def test_prepare_restore_returns_none_on_api_failure(self, mock_call):
        """prepare_restore API 失败时返回 None，不抛异常。"""
        mock_call.side_effect = ConnectionError("collab-live unreachable")
        resource = MagicMock()

        result = self.adapter.prepare_restore(resource, b"fake-binary")
        assert result is None

    @patch("apps.tabdoc.services.document_service.DocumentService")
    @patch("apps.tabdoc.models.Document")
    @patch("django.db.transaction")
    def test_on_commit_callback_error_is_logged_not_raised(
        self, mock_tx, MockDocument, MockDocService,
    ):
        """on_commit 回调内的异常应被 logger.exception 捕获，不传播到调用方。"""
        MockDocService.return_value = _make_doc_service_mock()

        mock_qs = MagicMock()
        mock_qs.get.side_effect = Exception("Document vanished")
        mock_qs.filter.return_value = mock_qs
        MockDocument.objects.using.return_value = mock_qs

        on_commit_callbacks = []
        mock_tx.on_commit = lambda fn, using=None: on_commit_callbacks.append(fn)

        resource = MagicMock()
        resource.id = uuid.uuid4()
        data = {
            "format": "json_snapshot",
            "description_json": {"type": "doc"},
            "description_markdown": "# hello",
        }

        self.adapter.restore(resource, data)
        assert len(on_commit_callbacks) == 1

        on_commit_callbacks[0]()  # should not raise
