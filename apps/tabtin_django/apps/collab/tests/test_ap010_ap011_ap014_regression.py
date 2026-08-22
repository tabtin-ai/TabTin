"""
AP-010 / AP-011 / AP-014 回归测试

AP-010: rollback_agent_run 必须包含已删除/归档资源，而非静默跳过
AP-011: DocsCollabAdapter.restore 的 HTTP IO 必须在 DB 事务外执行
AP-014: rollback_agent_run 异常时响应必须携带失败详情和已完成部分
"""
import os
import uuid
from unittest.mock import MagicMock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402
django.setup()

import pytest  # noqa: E402


def _make_request(user_id="u-caller"):
    req = MagicMock()
    req.auth = MagicMock()
    req.auth.id = user_id
    req.auth.nickname = "caller"
    return req


def _make_changelog(resource_type, resource_id, agent_run_id, created_at=None):
    from django.utils import timezone
    cl = MagicMock()
    cl.resource_type = resource_type
    cl.resource_id = uuid.UUID(resource_id) if isinstance(resource_id, str) else resource_id
    cl.agent_run_id = agent_run_id
    cl.created_at = created_at or timezone.now()
    return cl


# ═══════════════════════════════════════════════════════
# AP-010: 已删除资源的 rollback 处理
# ═══════════════════════════════════════════════════════


class TestAP010DeletedResourceRollback:
    """AP-010: rollback_agent_run 使用 get_resource_for_rollback 包含已删除资源。"""

    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.VersionHistoryService")
    def test_rollback_uses_get_resource_for_rollback(
        self, mock_vh_svc_cls, mock_get_adapter
    ):
        """rollback 调用 get_resource_for_rollback 而非 get_resource。"""
        from apps.collab.api import rollback_agent_run

        res_id = str(uuid.uuid4())
        changelogs = [_make_changelog("docs", res_id, "run-1")]

        deleted_doc = MagicMock()
        deleted_doc.status = "deleted"

        adapter = MagicMock()
        adapter.get_resource.return_value = None
        adapter.get_resource_for_rollback.return_value = deleted_doc
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        mock_vh = MagicMock()
        mock_pre_version = MagicMock()
        mock_pre_version.id = uuid.uuid4()
        mock_vh_svc_cls.return_value = mock_vh
        mock_vh.restore_to_version.return_value = MagicMock(id=uuid.uuid4())

        with patch("apps.collab.models.ChangeLog") as mock_cl_model, \
             patch("apps.collab.models.VersionHistory") as mock_vh_model, \
             patch("django.db.transaction") as mock_tx, \
             patch("apps.collab.api._force_close_collab_document"):

            qs = MagicMock()
            qs.__iter__ = MagicMock(return_value=iter(changelogs))
            mock_cl_model.objects.using.return_value.filter.return_value.order_by.return_value = qs

            mock_vh_model.objects.using.return_value.filter.return_value.order_by.return_value.first.return_value = mock_pre_version
            mock_tx.atomic.return_value.__enter__ = MagicMock()
            mock_tx.atomic.return_value.__exit__ = MagicMock(return_value=False)

            req = _make_request()
            result = rollback_agent_run(req, "run-1")

        adapter.get_resource_for_rollback.assert_called_once_with(res_id)
        adapter.get_resource.assert_not_called()

    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.VersionHistoryService")
    def test_deleted_resource_not_silently_skipped(
        self, mock_vh_svc_cls, mock_get_adapter
    ):
        """Agent 删除的资源不应被静默跳过（否则该资源的变更无法回滚）。"""
        from apps.collab.api import rollback_agent_run

        res_id = str(uuid.uuid4())
        changelogs = [_make_changelog("docs", res_id, "run-1")]

        adapter = MagicMock()
        adapter.get_resource.return_value = None
        adapter.get_resource_for_rollback.return_value = MagicMock()
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        mock_pre_version = MagicMock()
        mock_pre_version.id = uuid.uuid4()

        mock_svc = MagicMock()
        mock_svc.restore_to_version.return_value = MagicMock(id=uuid.uuid4())
        mock_vh_svc_cls.return_value = mock_svc

        with patch("apps.collab.models.ChangeLog") as mock_cl_model, \
             patch("apps.collab.models.VersionHistory") as mock_vh_model, \
             patch("django.db.transaction") as mock_tx, \
             patch("apps.collab.api._force_close_collab_document"):

            qs = MagicMock()
            qs.__iter__ = MagicMock(return_value=iter(changelogs))
            mock_cl_model.objects.using.return_value.filter.return_value.order_by.return_value = qs

            mock_vh_model.objects.using.return_value.filter.return_value.order_by.return_value.first.return_value = mock_pre_version
            mock_tx.atomic.return_value.__enter__ = MagicMock()
            mock_tx.atomic.return_value.__exit__ = MagicMock(return_value=False)

            req = _make_request()
            result = rollback_agent_run(req, "run-1")

        if isinstance(result, tuple):
            status, body = result
            assert status != 404 or "not_found" not in body.get("message", ""), \
                "已删除资源不应导致 404，应被纳入回滚范围"


class TestAP010AdapterGetResourceForRollback:
    """AP-010: 各 adapter 的 get_resource_for_rollback 必须不过滤状态。"""

    def test_base_adapter_fallback(self):
        from apps.collab.adapters.base import CollabAdapter

        class TestAdapter(CollabAdapter):
            resource_type = "test"
            def serialize_snapshot(self, data): return b""
            def deserialize_snapshot(self, blob): return None
            def compute_diff(self, base, cur): return None
            def apply_diff(self, base, diff): return base
            def get_resource(self, rid): return "found"
            def check_permission(self, user, resource, action="edit"): return True
            def build_snapshot(self, resource): return {}
            def persist_changes(self, resource, changes, editor_info): return {}
            def restore(self, resource, data, *, prepared=None, user=None): pass

        adapter = TestAdapter()
        assert adapter.get_resource_for_rollback("test-id") == "found", \
            "基类 get_resource_for_rollback 应回退到 get_resource"

    def test_docs_adapter_includes_deleted(self):
        """DocsCollabAdapter.get_resource_for_rollback 不过滤 status/trashed。"""
        from apps.collab.adapters.docs import DocsCollabAdapter

        adapter = DocsCollabAdapter()
        fake_id = str(uuid.uuid4())
        with patch("apps.tabdoc.models.Document") as MockDoc:
            MockDoc.objects.using.return_value.get.return_value = MagicMock(status="deleted")
            result = adapter.get_resource_for_rollback(fake_id)
            MockDoc.objects.using.return_value.get.assert_called_once_with(id=fake_id)
            assert result is not None

    def test_table_adapter_includes_archived(self):
        """TableCollabAdapter.get_resource_for_rollback 不过滤 is_archived。"""
        from apps.collab.adapters.table import TableCollabAdapter

        adapter = TableCollabAdapter()
        fake_id = str(uuid.uuid4())
        with patch("apps.tabdata.models.Table") as MockTable:
            MockTable.objects.using.return_value.get.return_value = MagicMock(is_archived=True)
            result = adapter.get_resource_for_rollback(fake_id)
            MockTable.objects.using.return_value.get.assert_called_once_with(id=fake_id)
            assert result is not None

    def test_slide_adapter_includes_deleted(self):
        """SlideCollabAdapter.get_resource_for_rollback 不过滤 status。"""
        from apps.collab.adapters.slide import SlideCollabAdapter

        adapter = SlideCollabAdapter()
        fake_id = str(uuid.uuid4())
        with patch("apps.tabslide.models.SlideProject") as MockSlide:
            MockSlide.objects.using.return_value.get.return_value = MagicMock(status="deleted")
            result = adapter.get_resource_for_rollback(fake_id)
            MockSlide.objects.using.return_value.get.assert_called_once_with(id=fake_id)
            assert result is not None


# ═══════════════════════════════════════════════════════
# AP-011: HTTP IO 移出 DB 事务
# ═══════════════════════════════════════════════════════


class TestAP011HttpOutsideTransaction:
    """AP-011: restore 的 HTTP IO 必须在 DB 事务外执行。"""

    def test_docs_prepare_restore_calls_http(self):
        """DocsCollabAdapter.prepare_restore 在事务外调用 HTTP API。"""
        from apps.collab.adapters.docs import DocsCollabAdapter

        adapter = DocsCollabAdapter()
        binary_data = b"fake-yjs-binary"
        mock_result = {"json": {}, "markdown": "text", "plaintext": "text"}

        with patch("apps.services.common.live_api.call_live_api", return_value=mock_result) as mock_api:
            result = adapter.prepare_restore(MagicMock(), binary_data)

        mock_api.assert_called_once()
        assert result == mock_result

    def test_docs_prepare_restore_returns_none_for_dict(self):
        """JSON snapshot 数据不需要 HTTP 预处理。"""
        from apps.collab.adapters.docs import DocsCollabAdapter

        adapter = DocsCollabAdapter()
        json_data = {"format": "json_snapshot", "description_json": {}}

        result = adapter.prepare_restore(MagicMock(), json_data)
        assert result is None

    def test_docs_prepare_restore_handles_http_error_gracefully(self):
        """HTTP 调用失败时 prepare_restore 返回 None 而非抛异常。"""
        from apps.collab.adapters.docs import DocsCollabAdapter

        adapter = DocsCollabAdapter()

        with patch("apps.services.common.live_api.call_live_api", side_effect=ConnectionError("timeout")):
            result = adapter.prepare_restore(MagicMock(), b"binary")

        assert result is None

    def test_docs_restore_uses_prepared_data(self):
        """DocsCollabAdapter.restore 使用 prepared 数据而非重新调用 HTTP。"""
        from apps.collab.adapters.docs import DocsCollabAdapter

        adapter = DocsCollabAdapter()
        resource = MagicMock()
        resource.id = uuid.uuid4()
        binary_data = b"fake-binary"
        prepared = {"json": {"content": "restored"}, "markdown": "md", "plaintext": "pt"}

        with patch("apps.tabdoc.services.document_service.DocumentService") as MockSvc, \
             patch("apps.tabdoc.models.Document") as MockDoc, \
             patch("apps.tabdoc.services.document_service.normalize_tabdata_snapshot",
                   return_value=({"content": "restored"}, "md")) as mock_normalize, \
             patch("apps.services.common.live_api.call_live_api") as mock_api:

            mock_svc = MagicMock(unsafe=True)
            mock_svc.assert_document_content_editable = MagicMock()
            MockSvc.return_value = mock_svc
            MockDoc.objects.using.return_value.filter.return_value.update.return_value = 1

            adapter.restore(resource, binary_data, prepared=prepared)

            mock_api.assert_not_called()
            mock_normalize.assert_called_once()

    def test_service_do_restore_calls_prepare_before_transaction(self):
        """VersionHistoryService._do_restore 在事务外调用 prepare_restore。"""
        from apps.collab.service import VersionHistoryService

        adapter = MagicMock()
        adapter.resource_type = "docs"
        adapter.prepare_restore.return_value = {"json": {}}
        adapter.get_resource.return_value = MagicMock()

        svc = VersionHistoryService(adapter)
        version_id = uuid.uuid4()
        resource_id = uuid.uuid4()

        mock_target = MagicMock()
        mock_target.is_snapshot = True
        mock_target.blob = b"data"
        mock_target.id = version_id
        mock_target.resource_id = resource_id

        with patch.object(svc, "get_version", return_value=mock_target), \
             patch.object(svc, "rebuild_data", return_value=b"rebuilt-data"), \
             patch.object(svc, "_do_create_history", return_value=MagicMock(id=uuid.uuid4())), \
             patch("apps.collab.service.transaction") as mock_tx, \
             patch("apps.collab.service.ChangeLog"):

            mock_tx.atomic.return_value.__enter__ = MagicMock()
            mock_tx.atomic.return_value.__exit__ = MagicMock(return_value=False)

            svc._do_restore(
                resource_id, version_id,
                {"editor_type": "user", "editor_id": "u1", "editor_name": "test"},
                resource=MagicMock(),
            )

        adapter.prepare_restore.assert_called_once()
        adapter.restore.assert_called_once()
        _, kwargs = adapter.restore.call_args
        prepared = kwargs.get("prepared")
        assert prepared is not None
        assert prepared["json"] == {}
        assert "_vh_created_at" in prepared

    def test_non_docs_adapters_default_prepare_restore_returns_none(self):
        """非 docs adapter 的默认 prepare_restore 返回 None（无需 HTTP 预处理）。"""
        from apps.collab.adapters.table import TableCollabAdapter
        from apps.collab.adapters.slide import SlideCollabAdapter

        for AdapterCls in [TableCollabAdapter, SlideCollabAdapter]:
            adapter = AdapterCls()
            result = adapter.prepare_restore(MagicMock(), {"some": "data"})
            assert result is None, \
                f"{AdapterCls.__name__}.prepare_restore 应返回 None"

    def test_prepare_restore_called_before_atomic_block(self):
        """验证 prepare_restore 在 transaction.atomic 之前被调用（通过调用顺序追踪）。"""
        from apps.collab.service import VersionHistoryService

        call_order = []

        adapter = MagicMock()
        adapter.resource_type = "test"
        adapter.prepare_restore.side_effect = lambda r, d: (call_order.append("prepare_restore"), {"ready": True})[1]
        adapter.restore.side_effect = lambda r, d, *, prepared=None, user=None: call_order.append("restore")
        adapter.get_resource.return_value = MagicMock()

        svc = VersionHistoryService(adapter)
        version_id = uuid.uuid4()
        resource_id = uuid.uuid4()

        mock_target = MagicMock()
        mock_target.is_snapshot = True
        mock_target.blob = b"data"
        mock_target.id = version_id

        with patch.object(svc, "get_version", return_value=mock_target), \
             patch.object(svc, "rebuild_data", return_value={"data": True}), \
             patch.object(svc, "_do_create_history", return_value=MagicMock(id=uuid.uuid4())), \
             patch("apps.collab.service.transaction") as mock_tx, \
             patch("apps.collab.service.ChangeLog"):

            real_atomic = mock_tx.atomic.return_value
            real_atomic.__enter__ = MagicMock(side_effect=lambda: call_order.append("atomic_enter"))
            real_atomic.__exit__ = MagicMock(return_value=False)

            svc._do_restore(
                resource_id, version_id,
                {"editor_type": "user", "editor_id": "u1", "editor_name": "test"},
                resource=MagicMock(),
            )

        assert call_order.index("prepare_restore") < call_order.index("atomic_enter"), \
            f"prepare_restore 必须在 atomic 块之前调用，实际顺序: {call_order}"
        assert call_order.index("restore") > call_order.index("atomic_enter"), \
            f"restore 必须在 atomic 块之内调用，实际顺序: {call_order}"


# ═══════════════════════════════════════════════════════
# AP-014: 错误响应携带失败详情
# ═══════════════════════════════════════════════════════


class TestAP014ErrorResponseDetail:
    """AP-014: rollback_agent_run 失败时返回 detail 和 partial_results。"""

    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.VersionHistoryService")
    def test_error_response_includes_detail_and_partial_results(
        self, mock_vh_svc_cls, mock_get_adapter
    ):
        """restore 失败时响应包含 detail（错误原因）和 partial_results（已完成部分）。"""
        from apps.collab.api import rollback_agent_run

        res_id = str(uuid.uuid4())
        changelogs = [_make_changelog("docs", res_id, "run-fail")]

        adapter = MagicMock()
        adapter.get_resource_for_rollback.return_value = MagicMock()
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        mock_pre_version = MagicMock()
        mock_pre_version.id = uuid.uuid4()

        mock_svc = MagicMock()
        mock_svc.restore_to_version_with_lock_held.return_value = None
        mock_vh_svc_cls.return_value = mock_svc

        with patch("apps.collab.models.ChangeLog") as mock_cl_model, \
             patch("apps.collab.models.VersionHistory") as mock_vh_model, \
             patch("django.db.transaction") as mock_tx:

            qs = MagicMock()
            qs.__iter__ = MagicMock(return_value=iter(changelogs))
            mock_cl_model.objects.using.return_value.filter.return_value.order_by.return_value = qs

            mock_vh_model.objects.using.return_value.filter.return_value.exclude.return_value.order_by.return_value.first.return_value = mock_pre_version

            mock_tx.atomic.return_value.__enter__ = MagicMock()
            mock_tx.atomic.return_value.__exit__ = MagicMock(return_value=False)

            req = _make_request()
            status, body = rollback_agent_run(req, "run-fail")

        assert status == 400
        assert "detail" in body, "错误响应必须包含 detail 字段"
        assert "rollback_results" in body, "错误响应必须包含 rollback_results 字段"
        assert isinstance(body["rollback_results"], list)

    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.VersionHistoryService")
    def test_error_detail_contains_meaningful_message(
        self, mock_vh_svc_cls, mock_get_adapter
    ):
        """detail 字段包含有意义的错误信息（如资源 ID 和类型）。"""
        from apps.collab.api import rollback_agent_run

        res_id = str(uuid.uuid4())
        changelogs = [_make_changelog("docs", res_id, "run-fail")]

        adapter = MagicMock()
        adapter.get_resource_for_rollback.return_value = MagicMock()
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        mock_pre_version = MagicMock()
        mock_pre_version.id = uuid.uuid4()

        mock_svc = MagicMock()
        mock_svc.restore_to_version_with_lock_held.return_value = None
        mock_vh_svc_cls.return_value = mock_svc

        with patch("apps.collab.models.ChangeLog") as mock_cl_model, \
             patch("apps.collab.models.VersionHistory") as mock_vh_model, \
             patch("django.db.transaction") as mock_tx:

            qs = MagicMock()
            qs.__iter__ = MagicMock(return_value=iter(changelogs))
            mock_cl_model.objects.using.return_value.filter.return_value.order_by.return_value = qs

            mock_vh_model.objects.using.return_value.filter.return_value.exclude.return_value.order_by.return_value.first.return_value = mock_pre_version

            mock_tx.atomic.return_value.__enter__ = MagicMock()
            mock_tx.atomic.return_value.__exit__ = MagicMock(return_value=False)

            req = _make_request()
            status, body = rollback_agent_run(req, "run-fail")

        assert status == 400
        detail = body.get("detail", "")
        assert "docs" in detail or res_id in detail, \
            f"detail 应包含资源类型或 ID 帮助调试，实际: {detail}"

    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.VersionHistoryService")
    def test_partial_results_reflect_completed_restores(
        self, mock_vh_svc_cls, mock_get_adapter
    ):
        """多资源回滚中第二个资源失败时，partial_results 包含第一个成功的恢复。"""
        from apps.collab.api import rollback_agent_run
        from apps.collab.service import RestoreError

        res_id_1 = str(uuid.uuid4())
        res_id_2 = str(uuid.uuid4())
        changelogs = [
            _make_changelog("docs", res_id_1, "run-partial"),
            _make_changelog("table", res_id_2, "run-partial"),
        ]

        adapter = MagicMock()
        adapter.get_resource_for_rollback.return_value = MagicMock()
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        mock_pre_1 = MagicMock()
        mock_pre_1.id = uuid.uuid4()
        mock_pre_2 = MagicMock()
        mock_pre_2.id = uuid.uuid4()

        call_count = [0]
        restored_vh = MagicMock(id=uuid.uuid4())

        def mock_restore(*args, **kwargs):
            call_count[0] += 1
            if call_count[0] == 1:
                return restored_vh
            raise RestoreError(
                RestoreError.REBUILD_FAILED,
                f"Rebuild failed for table:{res_id_2}",
            )

        mock_svc = MagicMock()
        mock_svc.restore_to_version_with_lock_held.side_effect = mock_restore
        mock_vh_svc_cls.return_value = mock_svc

        with patch("apps.collab.models.ChangeLog") as mock_cl_model, \
             patch("apps.collab.models.VersionHistory") as mock_vh_model, \
             patch("django.db.transaction") as mock_tx:

            qs = MagicMock()
            qs.__iter__ = MagicMock(return_value=iter(changelogs))
            mock_cl_model.objects.using.return_value.filter.return_value.order_by.return_value = qs

            mock_vh_model.objects.using.return_value.filter.return_value.exclude.return_value.order_by.return_value.first.side_effect = [mock_pre_1, mock_pre_2]

            mock_tx.atomic.return_value.__enter__ = MagicMock()
            mock_tx.atomic.return_value.__exit__ = MagicMock(return_value=False)

            req = _make_request()
            status, body = rollback_agent_run(req, "run-partial")

        assert status == 400
        partial = body.get("rollback_results", [])
        assert len(partial) >= 1, \
            "rollback_results 应包含第一个资源的成功恢复结果"
        assert any(r.get("status") == "restored" for r in partial), \
            "rollback_results 中应有 status=restored 的条目"
