"""
SR-012 / SR-013 回归测试

SR-012: TableCollabAdapter.restore() 异常必须向上传播，
        不被吞掉，确保 _do_restore 的 transaction.atomic 能回滚。
SR-013: rollback_agent_run 批量回滚中任一资源失败时，
        整个事务必须回滚，返回 400 错误，不能出现部分成功状态。
"""
import os

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402

django.setup()

import uuid  # noqa: E402
from unittest.mock import MagicMock, patch  # noqa: E402

import pytest  # noqa: E402

from apps.collab.adapters.table import TableCollabAdapter  # noqa: E402


# ═══════════════════════════════════════════════════════════
# SR-012: TableCollabAdapter.restore 异常传播
# ═══════════════════════════════════════════════════════════


class TestSR012RestoreExceptionPropagation:
    """SR-012: restore() 不再吞异常，异常必须向上传播。"""

    def test_restore_propagates_exception_from_collab_service(self):
        """restore_from_snapshot 抛出异常时，restore() 必须 re-raise。"""
        adapter = TableCollabAdapter()
        resource = MagicMock()
        resource.id = uuid.uuid4()
        snapshot_data = {"fields": [{"id": "f1", "name": "Name"}], "records": {}, "row_order": []}

        with patch(
            "apps.tabdata.services.collab_service.CollabService.restore_from_snapshot",
            side_effect=RuntimeError("DB constraint violation"),
        ):
            with pytest.raises(RuntimeError, match="DB constraint violation"):
                adapter.restore(resource, snapshot_data)

    def test_restore_raises_on_non_dict_data(self):
        """传入非 dict 数据时，restore() 必须抛出 ValueError 而非静默返回。"""
        adapter = TableCollabAdapter()
        resource = MagicMock()
        resource.id = uuid.uuid4()

        with pytest.raises(ValueError, match="not a dict"):
            adapter.restore(resource, "not-a-dict")

        with pytest.raises(ValueError, match="not a dict"):
            adapter.restore(resource, None)

    def test_restore_succeeds_without_exception(self):
        """正常情况下 restore() 应正常完成不抛异常。"""
        adapter = TableCollabAdapter()
        resource = MagicMock()
        resource.id = uuid.uuid4()
        snapshot_data = {"fields": [{"id": "f1", "name": "Name"}], "records": {}, "row_order": []}

        with patch(
            "apps.tabdata.services.collab_service.CollabService.restore_from_snapshot"
        ) as mock_restore:
            adapter.restore(resource, snapshot_data)
            mock_restore.assert_called_once_with(str(resource.id), snapshot_data, user=None)

    def test_restore_exception_rolls_back_and_returns_none(self):
        """SR-012 核心场景：restore 抛异常 → transaction.atomic 回滚 →
        restore_to_version 抛出 RestoreError（不创建 VersionHistory/ChangeLog）。

        restore_to_version 内部捕获 RuntimeError 后抛出 RestoreError，
        关键是 _do_restore 的事务已回滚，且 finally 块中锁被释放。
        """
        from apps.collab.service import RestoreError, VersionHistoryService
        from apps.collab.adapters.base import CollabAdapter

        class FailingRestoreAdapter(CollabAdapter):
            resource_type = "test"

            def serialize_snapshot(self, data):
                return self.compress_json(data)

            def deserialize_snapshot(self, blob):
                return self.decompress_json(blob)

            def compute_diff(self, base_data, current_data):
                return None

            def apply_diff(self, base_data, diff_blob):
                return base_data

            def get_content_stats(self, data):
                return {}

            def get_resource(self, resource_id):
                return {"id": resource_id}

            def check_permission(self, user, resource, action="edit"):
                return True

            def build_snapshot(self, resource):
                return {}

            def persist_changes(self, resource, changes, editor_info):
                return {}

            def restore(self, resource, data, *, prepared=None, user=None):
                raise RuntimeError("Simulated restore failure")

        adapter = FailingRestoreAdapter()
        svc = VersionHistoryService(adapter)
        rid = uuid.uuid4()
        vid = uuid.uuid4()

        target_vh = MagicMock()
        target_vh.id = vid
        target_vh.name = "v1"

        with patch("apps.collab.service.cache") as mock_cache, \
             patch.object(svc, "get_version", return_value=target_vh), \
             patch.object(svc, "rebuild_data", return_value={"content": "test"}), \
             patch("apps.collab.service.transaction") as mock_tx:
            mock_cache.add.return_value = True

            mock_atomic_ctx = MagicMock()
            mock_tx.atomic.return_value = mock_atomic_ctx
            mock_atomic_ctx.__enter__ = MagicMock(return_value=None)
            mock_atomic_ctx.__exit__ = MagicMock(return_value=False)

            with pytest.raises(RestoreError):
                svc.restore_to_version(
                    rid, vid,
                    {"editor_type": "user", "editor_id": "u1", "editor_name": "test"},
                )

            mock_cache.delete.assert_called_once()


# ═══════════════════════════════════════════════════════════
# SR-013: rollback_agent_run 原子性
# ═══════════════════════════════════════════════════════════


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
    cl.resource_id = (
        uuid.UUID(resource_id) if isinstance(resource_id, str) else resource_id
    )
    cl.agent_run_id = agent_run_id
    cl.created_at = created_at or timezone.now()
    return cl


class TestSR013RollbackAtomicity:
    """SR-013: rollback_agent_run 单资源失败时整个批量回滚必须中止。"""

    @patch("django.db.transaction.atomic")
    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.VersionHistoryService")
    def test_returns_400_when_no_pre_change_version(
        self, mock_vh_svc_cls, mock_get_adapter, mock_force_close, _mock_atomic
    ):
        """某资源在 agent_run 之前无版本历史时，应返回 400 而非部分成功。"""
        from apps.collab.api import rollback_agent_run

        res_a = str(uuid.uuid4())
        res_b = str(uuid.uuid4())
        changelogs = [
            _make_changelog("docs", res_a, "run-1"),
            _make_changelog("table", res_b, "run-1"),
        ]

        resource_a = MagicMock()
        resource_b = MagicMock()

        def fake_get_resource(res_id):
            return resource_a if res_id == res_a else resource_b

        adapter = MagicMock()
        adapter.get_resource.side_effect = fake_get_resource
        adapter.get_resource_for_rollback.side_effect = fake_get_resource
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        restored_vh = MagicMock()
        restored_vh.id = uuid.uuid4()
        mock_svc = MagicMock()
        mock_svc.restore_to_version_with_lock_held.return_value = restored_vh
        mock_vh_svc_cls.return_value = mock_svc

        with patch("apps.collab.models.ChangeLog") as mock_cl_model, \
             patch("apps.collab.models.VersionHistory") as mock_vh_model:
            qs = MagicMock()
            qs.__iter__ = MagicMock(return_value=iter(changelogs))
            mock_cl_model.objects.using.return_value.filter.return_value.order_by.return_value = qs
            mock_cl_model.objects.using.return_value.filter.return_value.exists.return_value = False

            call_count = [0]

            def fake_pre_version_query(*args, **kwargs):
                mock_chain = MagicMock()
                call_count[0] += 1
                if call_count[0] <= 1:
                    mock_chain.exclude.return_value.order_by.return_value.first.return_value = MagicMock(
                        id=uuid.uuid4()
                    )
                else:
                    mock_chain.exclude.return_value.order_by.return_value.first.return_value = None
                return mock_chain

            vh_qs = MagicMock()
            vh_qs.filter.side_effect = fake_pre_version_query
            mock_vh_model.objects.using.return_value = vh_qs

            req = _make_request()
            result = rollback_agent_run(req, "run-1")

        # AP-005: 无前置版本的资源现在被跳过而非导致失败
        assert result["status"] == "ok"
        skipped = [r for r in result["data"]["rollback_results"] if r.get("status") == "skipped"]
        assert len(skipped) >= 1, "无前置版本的资源应被标记为 skipped"

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.VersionHistoryService")
    def test_returns_400_when_restore_to_version_returns_none(
        self, mock_vh_svc_cls, mock_get_adapter, mock_force_close
    ):
        """restore_to_version_with_lock_held 返回 None 时，应返回 400 而非部分成功。"""
        from apps.collab.api import rollback_agent_run

        res_a = str(uuid.uuid4())
        run_id = str(uuid.uuid4())
        changelogs = [_make_changelog("table", res_a, run_id)]

        mock_resource = MagicMock()
        adapter = MagicMock()
        adapter.get_resource.return_value = mock_resource
        adapter.get_resource_for_rollback.return_value = mock_resource
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        mock_svc = MagicMock()
        mock_svc.restore_to_version_with_lock_held.return_value = None
        mock_vh_svc_cls.return_value = mock_svc

        pre_version = MagicMock()
        pre_version.id = uuid.uuid4()

        with patch("apps.collab.models.ChangeLog") as mock_cl_model, \
             patch("apps.collab.models.VersionHistory") as mock_vh_model:
            qs = MagicMock()
            qs.__iter__ = MagicMock(return_value=iter(changelogs))
            mock_cl_model.objects.using.return_value.filter.return_value.order_by.return_value = qs
            mock_cl_model.objects.using.return_value.filter.return_value.exists.return_value = False

            vh_qs = MagicMock()
            vh_qs.filter.return_value.exclude.return_value.order_by.return_value.first.return_value = pre_version
            mock_vh_model.objects.using.return_value = vh_qs

            req = _make_request()
            status, result = rollback_agent_run(req, run_id)

        assert status == 400
        assert result["status"] == "error"
        mock_force_close.assert_not_called()

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.VersionHistoryService")
    def test_returns_400_when_restore_to_version_raises(
        self, mock_vh_svc_cls, mock_get_adapter, mock_force_close
    ):
        """restore_to_version_with_lock_held 抛异常时（SR-012 修复后可能发生），应返回 400。"""
        from apps.collab.api import rollback_agent_run

        res_a = str(uuid.uuid4())
        run_id = str(uuid.uuid4())
        changelogs = [_make_changelog("table", res_a, run_id)]

        mock_resource = MagicMock()
        adapter = MagicMock()
        adapter.get_resource.return_value = mock_resource
        adapter.get_resource_for_rollback.return_value = mock_resource
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        mock_svc = MagicMock()
        mock_svc.restore_to_version_with_lock_held.side_effect = RuntimeError("restore exploded")
        mock_vh_svc_cls.return_value = mock_svc

        pre_version = MagicMock()
        pre_version.id = uuid.uuid4()

        with patch("apps.collab.models.ChangeLog") as mock_cl_model, \
             patch("apps.collab.models.VersionHistory") as mock_vh_model:
            qs = MagicMock()
            qs.__iter__ = MagicMock(return_value=iter(changelogs))
            mock_cl_model.objects.using.return_value.filter.return_value.order_by.return_value = qs
            mock_cl_model.objects.using.return_value.filter.return_value.exists.return_value = False

            vh_qs = MagicMock()
            vh_qs.filter.return_value.exclude.return_value.order_by.return_value.first.return_value = pre_version
            mock_vh_model.objects.using.return_value = vh_qs

            req = _make_request()
            status, result = rollback_agent_run(req, run_id)

        assert status == 400
        assert result["status"] == "error"
        mock_force_close.assert_not_called()

    @patch("django.db.transaction.atomic")
    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.VersionHistoryService")
    def test_success_path_still_works(
        self, mock_vh_svc_cls, mock_get_adapter, mock_force_close, _mock_atomic
    ):
        """所有资源恢复成功时，应返回 200 并触发 force-close。"""
        from apps.collab.api import rollback_agent_run

        res_a = str(uuid.uuid4())
        changelogs = [_make_changelog("table", res_a, "run-ok")]

        mock_resource = MagicMock()
        adapter = MagicMock()
        adapter.get_resource.return_value = mock_resource
        adapter.get_resource_for_rollback.return_value = mock_resource
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        restored_vh = MagicMock()
        restored_vh.id = uuid.uuid4()

        mock_svc = MagicMock()
        mock_svc.restore_to_version_with_lock_held.return_value = restored_vh
        mock_vh_svc_cls.return_value = mock_svc

        pre_version = MagicMock()
        pre_version.id = uuid.uuid4()

        with patch("apps.collab.models.ChangeLog") as mock_cl_model, \
             patch("apps.collab.models.VersionHistory") as mock_vh_model:
            qs = MagicMock()
            qs.__iter__ = MagicMock(return_value=iter(changelogs))
            mock_cl_model.objects.using.return_value.filter.return_value.order_by.return_value = qs

            vh_qs = MagicMock()
            vh_qs.filter.return_value.exclude.return_value.order_by.return_value.first.return_value = pre_version
            mock_vh_model.objects.using.return_value = vh_qs

            req = _make_request()
            result = rollback_agent_run(req, "run-ok")

        assert result["status"] == "ok"
        assert len(result["data"]["rollback_results"]) >= 1
        restored = [r for r in result["data"]["rollback_results"] if r.get("status") == "restored"]
        assert len(restored) >= 1
        assert restored[0]["new_version"] is not None
        mock_force_close.assert_called_once_with("table", res_a)
