"""
E2E-019 / E2E-020 / E2E-022 / E2E-037 回归测试

E2E-019: SlideCollabAdapter.persist_changes 使用 transaction.on_commit 延迟 post_save_hooks
E2E-020: collab_persist VH 写入失败时 persist 仍提交（savepoint 隔离）
E2E-022: record_change notify_collab 参数 — invalidate-version（方案 A）及降级 force_close（方案 B）
E2E-037: 幂等缓存 cache.set 失败不影响 persist 响应
"""
import os
import uuid
from unittest.mock import MagicMock, patch, call

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402
django.setup()

import pytest  # noqa: E402


# ══════════════════════════════════════════════════════════
# E2E-019: SlideCollabAdapter post_save_hooks 延迟执行
# ══════════════════════════════════════════════════════════

class TestE2E019SlidePostSaveHooksDeferred:
    """验证 persist_changes 使用 transaction.on_commit 延迟 hooks。"""

    @patch("apps.tabslide.services.slide_service.SlideService")
    @patch("apps.tabslide.post_save.run_post_save_hooks")
    @patch("apps.tabslide.field_mapping.frontend_page_to_full_defaults")
    @patch("apps.tabslide.field_mapping.frontend_page_to_defaults")
    @patch("apps.tabslide.models.SlidePage")
    @patch("apps.tabslide.models.SlideProject")
    @patch("django.db.transaction.on_commit")
    @patch("django.db.transaction.atomic")
    def test_post_save_hooks_uses_on_commit(
        self, mock_atomic, mock_on_commit, MockProject, MockPage,
        mock_defaults, _mock_full_defaults, mock_hooks, _mock_svc,
    ):
        """post_save_hooks 不应在 persist_changes 内同步调用，
        而是通过 transaction.on_commit 注册延迟回调。"""
        from apps.collab.adapters.slide import SlideCollabAdapter

        adapter = SlideCollabAdapter()

        resource = MagicMock()
        resource.id = uuid.uuid4()
        resource.latest_version = 1

        mock_project = MagicMock()
        mock_project.id = resource.id
        mock_project.latest_version = 2

        qs = MagicMock()
        qs.using.return_value = qs
        qs.select_for_update.return_value = qs
        qs.filter.return_value = qs
        qs.first.return_value = mock_project
        MockProject.objects = qs

        page_qs = MagicMock()
        page_qs.using.return_value = page_qs
        page_qs.filter.return_value = page_qs
        page_qs.only.return_value = page_qs
        page_qs.__iter__ = MagicMock(return_value=iter([]))
        MockPage.objects = page_qs

        mock_defaults.return_value = {"version": 2}

        changes = {
            "changed_pages": {"p1": {"elements": []}},
            "new_pages": {},
            "deleted_page_ids": [],
        }
        editor_info = {"editor_type": "user", "editor_id": "u1"}

        adapter.persist_changes(resource, changes, editor_info)

        mock_on_commit.assert_called_once()
        mock_hooks.assert_not_called()


# ══════════════════════════════════════════════════════════
# E2E-020: VH 写入失败时 persist 仍提交
# ══════════════════════════════════════════════════════════

class TestE2E020PersistVHIsolation:
    """验证 VH 写入失败不会回滚 persist 数据。"""

    @patch("apps.collab.api._cached_is_debug", return_value=True)
    @patch("apps.collab.api._get_live_secret", return_value="collab-live-dev-secret")
    @patch("apps.collab.api.VersionHistoryService")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.cache")
    def test_vh_failure_sets_version_history_error_flag(
        self, mock_cache, mock_get_adapter, mock_vh_cls, _, __
    ):
        """VH 写入失败时响应应包含 version_history_error=True。"""
        from apps.collab.api import collab_persist

        mock_cache.get.return_value = None

        adapter = MagicMock()
        mock_resource = MagicMock(id="res-1")
        adapter.persist_changes.return_value = {"version": 2}
        adapter.get_resource.return_value = mock_resource
        adapter.get_version_data.return_value = {"nodes": []}
        mock_get_adapter.return_value = adapter

        mock_vh_svc = MagicMock()
        mock_vh_svc.create_history.side_effect = RuntimeError("DB write failed")
        mock_vh_cls.return_value = mock_vh_svc

        req = MagicMock()
        req.headers = {"X-Live-Secret": "collab-live-dev-secret"}
        body = MagicMock()
        body.op_id = ""
        body.changes = {"nodes_data": []}
        body.editor_type = "system"
        body.editor_id = ""
        body.editor_name = ""
        body.agent_run_id = ""
        body.system_policy = "trusted_internal"

        resource_id = uuid.uuid4()

        with patch("django.db.transaction.atomic") as mock_atomic:
            mock_atomic.return_value.__enter__ = MagicMock(return_value=None)
            mock_atomic.return_value.__exit__ = MagicMock(return_value=False)

            result = collab_persist(req, "slide", resource_id, body)

        if isinstance(result, tuple):
            status_code, data = result
            assert status_code != 500, "persist 应成功而非返回 500"
        else:
            data = result

        assert data.get("data", data).get("version_history_error") is True

    @patch("apps.collab.api._cached_is_debug", return_value=True)
    @patch("apps.collab.api._get_live_secret", return_value="collab-live-dev-secret")
    @patch("apps.collab.api.VersionHistoryService")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.cache")
    def test_vh_success_no_error_flag(
        self, mock_cache, mock_get_adapter, mock_vh_cls, _, __
    ):
        """VH 写入成功时响应不应包含 version_history_error。"""
        from apps.collab.api import collab_persist

        mock_cache.get.return_value = None

        adapter = MagicMock()
        mock_resource = MagicMock(id="res-1")
        adapter.persist_changes.return_value = {"version": 2}
        adapter.get_resource.return_value = mock_resource
        adapter.get_version_data.return_value = {"nodes": []}
        mock_get_adapter.return_value = adapter

        mock_vh_svc = MagicMock()
        mock_vh = MagicMock()
        mock_vh_svc.create_history.return_value = mock_vh
        mock_vh_cls.return_value = mock_vh_svc

        req = MagicMock()
        req.headers = {"X-Live-Secret": "collab-live-dev-secret"}
        body = MagicMock()
        body.op_id = ""
        body.changes = {"nodes_data": []}
        body.editor_type = "system"
        body.editor_id = ""
        body.editor_name = ""
        body.agent_run_id = ""
        body.system_policy = "trusted_internal"

        resource_id = uuid.uuid4()

        with patch("django.db.transaction.atomic") as mock_atomic, \
             patch("apps.collab.models.ChangeLog") as mock_cl:
            mock_atomic.return_value.__enter__ = MagicMock(return_value=None)
            mock_atomic.return_value.__exit__ = MagicMock(return_value=False)
            mock_cl.objects.using.return_value.create.return_value = MagicMock()

            result = collab_persist(req, "slide", resource_id, body)

        if isinstance(result, tuple):
            _, data = result
        else:
            data = result

        result_data = data.get("data", data)
        assert result_data.get("version_history_error") is not True


# ══════════════════════════════════════════════════════════
# E2E-022: record_change notify_collab
# ══════════════════════════════════════════════════════════

class TestE2E022RecordChangeNotifyCollab:
    """验证 record_change 的 notify_collab 参数。"""

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.models.ChangeLog")
    def test_notify_collab_true_calls_force_close(self, mock_cl_class, mock_force_close):
        """notify_collab=True 时应调用 _force_close_collab_document。"""
        from apps.collab.api import record_change

        mock_cl_class.objects.using.return_value.create.return_value = MagicMock()
        mock_force_close.return_value = {"success": True, "loaded": True, "connections_closed": 1}

        with patch("apps.services.common.platform_context.get_current_run_id", return_value=""):
            record_change(
                "slide",
                uuid.uuid4(),
                "update",
                editor_type="agent",
                editor_id="a1",
                notify_collab=True,
            )

        mock_force_close.assert_called_once()

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.models.ChangeLog")
    def test_notify_collab_false_skips_force_close(self, mock_cl_class, mock_force_close):
        """notify_collab=False（默认）时不应调用 _force_close_collab_document。"""
        from apps.collab.api import record_change

        mock_cl_class.objects.using.return_value.create.return_value = MagicMock()

        with patch("apps.services.common.platform_context.get_current_run_id", return_value=""):
            record_change(
                "slide",
                uuid.uuid4(),
                "update",
                editor_type="agent",
                editor_id="a1",
            )

        mock_force_close.assert_not_called()

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.models.ChangeLog")
    def test_notify_collab_force_close_failure_does_not_raise(self, mock_cl_class, mock_force_close):
        """force_close 失败不应传播异常。"""
        from apps.collab.api import record_change

        mock_cl_class.objects.using.return_value.create.return_value = MagicMock()
        mock_force_close.side_effect = ConnectionError("collab-live unreachable")

        with patch("apps.services.common.platform_context.get_current_run_id", return_value=""):
            cl = record_change(
                "slide",
                uuid.uuid4(),
                "update",
                editor_type="agent",
                editor_id="a1",
                notify_collab=True,
            )

        assert cl is not None

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api._invalidate_collab_version")
    @patch("apps.collab.models.ChangeLog")
    def test_notify_collab_with_version_calls_invalidate(
        self, mock_cl_class, mock_invalidate, mock_force_close
    ):
        """E2E-022 方案 A: notify_collab=True + notify_collab_version 时调用 invalidate-version，
        不调用 force_close。"""
        from apps.collab.api import record_change

        mock_cl_class.objects.using.return_value.create.return_value = MagicMock()
        mock_invalidate.return_value = {"success": True, "updated": True}

        resource_id = uuid.uuid4()
        with patch("apps.services.common.platform_context.get_current_run_id", return_value=""):
            cl = record_change(
                "slide",
                resource_id,
                "update",
                editor_type="agent",
                editor_id="a1",
                notify_collab=True,
                notify_collab_version=42,
            )

        mock_invalidate.assert_called_once_with("slide", str(resource_id), 42)
        mock_force_close.assert_not_called()
        assert cl is not None

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api._invalidate_collab_version")
    @patch("apps.collab.models.ChangeLog")
    def test_notify_collab_with_version_fallback_on_invalidate_failure(
        self, mock_cl_class, mock_invalidate, mock_force_close
    ):
        """E2E-022: invalidate-version 失败时降级为 force_close。"""
        from apps.collab.api import record_change

        mock_cl_class.objects.using.return_value.create.return_value = MagicMock()
        mock_invalidate.return_value = {"success": False, "updated": False}
        mock_force_close.return_value = {"success": True, "loaded": True, "connections_closed": 1}

        resource_id = uuid.uuid4()
        with patch("apps.services.common.platform_context.get_current_run_id", return_value=""):
            cl = record_change(
                "docs",
                resource_id,
                "update",
                editor_type="agent",
                editor_id="a1",
                notify_collab=True,
                notify_collab_version=10,
            )

        mock_invalidate.assert_called_once_with("docs", str(resource_id), 10)
        mock_force_close.assert_called_once()
        assert cl is not None

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api._invalidate_collab_version")
    @patch("apps.collab.models.ChangeLog")
    def test_notify_collab_without_version_uses_force_close(
        self, mock_cl_class, mock_invalidate, mock_force_close
    ):
        """E2E-022 降级路径: notify_collab=True 但未提供 version 时使用 force_close。"""
        from apps.collab.api import record_change

        mock_cl_class.objects.using.return_value.create.return_value = MagicMock()
        mock_force_close.return_value = {"success": True, "loaded": True, "connections_closed": 1}

        with patch("apps.services.common.platform_context.get_current_run_id", return_value=""):
            record_change(
                "slide",
                uuid.uuid4(),
                "update",
                editor_type="agent",
                editor_id="a1",
                notify_collab=True,
            )

        mock_invalidate.assert_not_called()
        mock_force_close.assert_called_once()

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api._invalidate_collab_version")
    @patch("apps.collab.models.ChangeLog")
    def test_notify_collab_invalidate_exception_does_not_raise(
        self, mock_cl_class, mock_invalidate, mock_force_close
    ):
        """E2E-022: invalidate-version 抛出异常时不传播，ChangeLog 仍正常返回。"""
        from apps.collab.api import record_change

        mock_cl_class.objects.using.return_value.create.return_value = MagicMock()
        mock_invalidate.side_effect = ConnectionError("collab-live unreachable")

        with patch("apps.services.common.platform_context.get_current_run_id", return_value=""):
            cl = record_change(
                "slide",
                uuid.uuid4(),
                "update",
                editor_type="agent",
                editor_id="a1",
                notify_collab=True,
                notify_collab_version=5,
            )

        assert cl is not None


# ══════════════════════════════════════════════════════════
# E2E-037: 幂等缓存 cache.set 容错
# ══════════════════════════════════════════════════════════

class TestE2E037IdempotencyCacheFaultTolerance:
    """验证 cache.set 失败不影响 persist 响应。"""

    @patch("apps.collab.api._cached_is_debug", return_value=True)
    @patch("apps.collab.api._get_live_secret", return_value="collab-live-dev-secret")
    @patch("apps.collab.api.VersionHistoryService")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.cache")
    def test_cache_set_failure_still_returns_200(
        self, mock_cache, mock_get_adapter, mock_vh_cls, _, __
    ):
        """cache.set 抛异常时，persist 成功的响应仍应返回。"""
        from apps.collab.api import collab_persist

        mock_cache.get.return_value = None
        mock_cache.set.side_effect = ConnectionError("Redis unavailable")

        adapter = MagicMock()
        adapter.persist_changes.return_value = {"version": 2, "skipped": True}
        adapter.get_resource.return_value = MagicMock(id="res-1")
        mock_get_adapter.return_value = adapter

        req = MagicMock()
        req.headers = {"X-Live-Secret": "collab-live-dev-secret"}
        body = MagicMock()
        body.op_id = "test-op-123"
        body.changes = {"nodes_data": []}
        body.editor_type = "system"
        body.editor_id = ""
        body.editor_name = ""
        body.agent_run_id = ""
        body.system_policy = "trusted_internal"

        resource_id = uuid.uuid4()

        with patch("django.db.transaction.atomic") as mock_atomic:
            mock_atomic.return_value.__enter__ = MagicMock(return_value=None)
            mock_atomic.return_value.__exit__ = MagicMock(return_value=False)

            result = collab_persist(req, "slide", resource_id, body)

        if isinstance(result, tuple):
            status_code, _ = result
            assert status_code != 500
        else:
            assert result["status"] == "ok"


# ══════════════════════════════════════════════════════════
# E2E-022: 各模块 DB-first 写入后调用 _invalidate_collab_version
# ══════════════════════════════════════════════════════════

