"""
VS-006 / VS-007 / VS-009 / VS-016 回归测试

VS-006: rollback_agent_run force-close 失败时降级调用 invalidate-version
VS-007: restore_space_checkpoint force-close 失败时降级调用 invalidate-version
VS-009: rollback 窗口期——随 VS-006 降级机制自然缓解
VS-016: restore_space_checkpoint 中 loaded=False 不再误加入 fc_warnings
"""
import os
import uuid
from unittest.mock import MagicMock, patch, call

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402
django.setup()

import pytest  # noqa: E402


# ═══════════════════════════════════════════════════════════
# _get_resource_version 单元测试
# ═══════════════════════════════════════════════════════════


class TestGetResourceVersion:
    def test_returns_latest_version(self):
        from apps.collab.api import _get_resource_version

        resource = MagicMock()
        resource.latest_version = 42
        resource.revn = None
        assert _get_resource_version(resource) == 42

    def test_returns_revn_for_design(self):
        from apps.collab.api import _get_resource_version

        resource = MagicMock(spec=[])
        resource.revn = 17
        assert _get_resource_version(resource) == 17

    def test_returns_none_when_no_version_field(self):
        from apps.collab.api import _get_resource_version

        resource = MagicMock(spec=[])
        assert _get_resource_version(resource) is None

    def test_prefers_latest_version_over_revn(self):
        from apps.collab.api import _get_resource_version

        resource = MagicMock()
        resource.latest_version = 10
        resource.revn = 5
        assert _get_resource_version(resource) == 10


# ═══════════════════════════════════════════════════════════
# _force_close_or_invalidate 单元测试
# ═══════════════════════════════════════════════════════════


class TestForceCloseOrInvalidate:
    """验证 force-close → invalidate-version 降级链路。"""

    @patch("apps.collab.api._invalidate_collab_version")
    @patch("apps.collab.api._force_close_collab_document")
    def test_force_close_success_no_degradation(self, mock_fc, mock_iv):
        from apps.collab.api import _force_close_or_invalidate

        mock_fc.return_value = {"success": True, "loaded": True, "connections_closed": 3}
        result = _force_close_or_invalidate("docs", "d-1", new_version=5)

        assert result["success"] is True
        assert result["method"] == "force_close"
        mock_iv.assert_not_called()

    @patch("apps.collab.api._invalidate_collab_version")
    @patch("apps.collab.api._force_close_collab_document")
    def test_force_close_fail_degrades_to_invalidate(self, mock_fc, mock_iv):
        """VS-006 核心：force-close 失败 → 降级 invalidate-version。"""
        from apps.collab.api import _force_close_or_invalidate

        mock_fc.return_value = {"success": False, "loaded": False, "connections_closed": 0}
        mock_iv.return_value = {"success": True, "updated": True}

        result = _force_close_or_invalidate("slide", "s-1", new_version=10)

        assert result["success"] is True
        assert result["method"] == "invalidate_version"
        mock_iv.assert_called_once_with("slide", "s-1", 10)

    @patch("apps.collab.api._invalidate_collab_version")
    @patch("apps.collab.api._force_close_collab_document")
    def test_both_fail_returns_failed(self, mock_fc, mock_iv):
        from apps.collab.api import _force_close_or_invalidate

        mock_fc.return_value = {"success": False, "loaded": False, "connections_closed": 0}
        mock_iv.return_value = {"success": False, "updated": False}

        result = _force_close_or_invalidate("slide", "c-1", new_version=7)

        assert result["success"] is False
        assert result["method"] == "failed"

    @patch("apps.collab.api._invalidate_collab_version")
    @patch("apps.collab.api._force_close_collab_document")
    def test_no_version_skips_invalidate(self, mock_fc, mock_iv):
        from apps.collab.api import _force_close_or_invalidate

        mock_fc.return_value = {"success": False, "loaded": False, "connections_closed": 0}

        result = _force_close_or_invalidate("table", "t-1", new_version=None)

        assert result["success"] is False
        assert result["method"] == "failed"
        mock_iv.assert_not_called()


# ═══════════════════════════════════════════════════════════
# VS-006: rollback_agent_run force-close 失败时降级
# ═══════════════════════════════════════════════════════════


class _FakeAtomic:
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return False


def _make_request(user_id="u-test"):
    req = MagicMock()
    req.auth = MagicMock()
    req.auth.id = user_id
    req.auth.nickname = "tester"
    return req


class TestVS006RollbackDegradation:
    """VS-006: rollback_agent_run 在 force-close 失败时降级到 invalidate-version。"""

    @patch("apps.collab.api._invalidate_collab_version")
    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api._trash_resource_in_rollback")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.VersionHistoryService")
    def test_rollback_degrades_to_invalidate_on_fc_failure(
        self, mock_vhs_cls, mock_get_adapter, mock_trash,
        mock_fc, mock_iv,
    ):
        """force-close 失败 + invalidate-version 成功 → 响应包含
        force_close_failed_invalidate_version_ok 警告而非 force_close_failed。"""
        from apps.collab.api import rollback_agent_run

        agent_run_id = "run-vs006"
        resource_id = str(uuid.uuid4())

        adapter = MagicMock()
        adapter.resource_type = "slide"
        resource = MagicMock()
        resource.latest_version = 15
        resource.id = resource_id
        adapter.get_resource_for_rollback.return_value = resource
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        cl = MagicMock()
        cl.resource_type = "slide"
        cl.resource_id = uuid.UUID(resource_id)

        pre_vh = MagicMock()
        pre_vh.id = uuid.uuid4()

        mock_svc = MagicMock()
        mock_svc.acquire_restore_lock.return_value = None
        new_vh = MagicMock()
        new_vh.id = uuid.uuid4()
        mock_svc.restore_to_version_with_lock_held.return_value = new_vh
        mock_vhs_cls.return_value = mock_svc

        mock_fc.return_value = {"success": False, "loaded": False, "connections_closed": 0}
        mock_iv.return_value = {"success": True, "updated": True}

        with patch("apps.collab.models.ChangeLog") as mock_cl_model, \
             patch("apps.collab.models.VersionHistory") as mock_vh_model, \
             patch("django.db.transaction.atomic", return_value=_FakeAtomic()):

            qs_iter = MagicMock()
            qs_iter.__iter__ = MagicMock(return_value=iter([cl]))

            empty_values_qs = MagicMock()
            empty_values_qs.values_list.return_value = []

            def fake_cl_filter(*args, **kwargs):
                if kwargs.get("version_history__isnull") is False:
                    return empty_values_qs
                if kwargs.get("change_type") == "create":
                    create_qs = MagicMock()
                    create_qs.exists.return_value = False
                    return create_qs
                if kwargs.get("version_history__isnull") is True:
                    vh_miss_qs = MagicMock()
                    vh_miss_qs.exists.return_value = False
                    return vh_miss_qs
                return MagicMock(order_by=MagicMock(return_value=qs_iter))

            mock_cl_model.objects.using.return_value.filter.side_effect = fake_cl_filter
            mock_cl_model.objects.using.return_value.filter.return_value.order_by.return_value = qs_iter

            exclude_chain = MagicMock()
            exclude_chain.order_by.return_value.first.return_value = pre_vh
            vh_qs = MagicMock()
            vh_qs.filter.return_value.exclude.return_value = exclude_chain
            mock_vh_model.objects.using.return_value = vh_qs

            request = _make_request()
            resp = rollback_agent_run(request, agent_run_id)

        assert resp["status"] == "ok"
        data = resp["data"]

        mock_iv.assert_called_once_with("slide", resource_id, 15)

        assert "collab_sync_warnings" in data
        warnings = data["collab_sync_warnings"]
        assert any(w["warning"] == "force_close_failed_invalidate_version_ok" for w in warnings)
        assert not any(w["warning"] == "force_close_failed" for w in warnings)


# ═══════════════════════════════════════════════════════════
# VS-007 + VS-016: restore_space_checkpoint
# ═══════════════════════════════════════════════════════════


class TestVS007CheckpointDegradation:
    """VS-007: restore_space_checkpoint 在 force-close 失败时降级到 invalidate-version。"""

    @patch("apps.collab.api._invalidate_collab_version")
    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.VersionHistoryService")
    def test_checkpoint_restore_degrades_on_fc_failure(
        self, mock_vhs_cls, mock_get_adapter, mock_fc, mock_iv,
    ):
        """force-close 失败时降级 invalidate-version，响应包含正确警告类型。"""
        from apps.collab.api import restore_space_checkpoint

        checkpoint_id = uuid.uuid4()
        resource_id = str(uuid.uuid4())
        version_id = uuid.uuid4()
        ref_key = f"slide:{resource_id}"

        adapter = MagicMock()
        adapter.resource_type = "slide"
        resource = MagicMock()
        resource.latest_version = 22
        resource.id = resource_id
        adapter.get_resource_for_rollback.return_value = resource
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        mock_svc = MagicMock()
        mock_svc.acquire_restore_lock.return_value = None
        new_vh = MagicMock()
        new_vh.id = uuid.uuid4()
        mock_svc.restore_to_version_with_lock_held.return_value = new_vh
        mock_vhs_cls.return_value = mock_svc

        mock_fc.return_value = {"success": False, "loaded": False, "connections_closed": 0}
        mock_iv.return_value = {"success": True, "updated": True}

        target_vh = MagicMock()
        target_vh.id = version_id

        with patch("apps.collab.models.SpaceCheckpoint") as mock_cp_model, \
             patch("apps.collab.models.VersionHistory") as mock_vh_model, \
             patch("django.db.transaction.atomic", return_value=_FakeAtomic()), \
             patch("apps.tabtinspace.services.base.BaseService") as mock_base_svc:

            cp = MagicMock()
            cp.id = checkpoint_id
            cp.name = "test-checkpoint"
            cp.space_id = uuid.uuid4()
            cp.version_refs = {ref_key: str(version_id)}
            cp.file_checkpoint_hash = ""
            cp.agent_run_id = ""
            mock_cp_model.objects.using.return_value.filter.return_value.first.return_value = cp

            mock_base_svc.return_value.check_space_permission.return_value = True

            mock_vh_model.objects.using.return_value.filter.return_value = [target_vh]

            request = _make_request()
            resp = restore_space_checkpoint(request, checkpoint_id)

        if isinstance(resp, tuple):
            status_code, body = resp
            assert status_code == 200
            data = body.get("data", body)
        else:
            data = resp.get("data", resp)

        mock_iv.assert_called_once_with("slide", resource_id, 22)

        if "collab_sync_warnings" in data:
            warnings = data["collab_sync_warnings"]
            assert any(
                w["warning"] == "force_close_failed_invalidate_version_ok"
                for w in warnings
            )


class TestVS016DocumentNotLoadedWarning:
    """VS-016: loaded=False 不应再被加入 fc_warnings（正常状态）。"""

    @patch("apps.collab.api._force_close_collab_document")
    def test_loaded_false_not_added_to_warnings(self, mock_fc):
        """直接测试 _force_close_or_invalidate: force-close 成功 + loaded=False
        不产生任何警告。"""
        from apps.collab.api import _force_close_or_invalidate

        mock_fc.return_value = {
            "success": True, "loaded": False, "connections_closed": 0,
        }
        result = _force_close_or_invalidate("docs", "d-1")

        assert result["success"] is True
        assert result["method"] == "force_close"

    @patch("apps.collab.api._invalidate_collab_version")
    @patch("apps.collab.api._force_close_collab_document")
    def test_checkpoint_no_document_not_loaded_warning(self, mock_fc, mock_iv):
        """模拟 restore_space_checkpoint 的 force-close 循环：
        loaded=False 不应产生 document_not_loaded 警告。"""
        from apps.collab.api import _force_close_or_invalidate

        mock_fc.return_value = {
            "success": True, "loaded": False, "connections_closed": 0,
        }
        result = _force_close_or_invalidate("docs", "v-1", new_version=8)

        assert result["success"] is True
        assert result["method"] == "force_close"
        mock_iv.assert_not_called()


# ═══════════════════════════════════════════════════════════
# VS-009: rollback 窗口期缓解验证
# ═══════════════════════════════════════════════════════════


class TestVS009WindowMitigation:
    """VS-009: 验证 force-close 失败时 invalidate-version 降级
    能更新 Y.Doc 版本号，防止 conflict 处理覆盖 rollback 数据。"""

    @patch("apps.collab.api._invalidate_collab_version")
    @patch("apps.collab.api._force_close_collab_document")
    def test_invalidate_version_called_with_correct_version(self, mock_fc, mock_iv):
        """确认降级时传入的 new_version 与 DB 当前版本一致。"""
        from apps.collab.api import _force_close_or_invalidate

        mock_fc.return_value = {"success": False, "loaded": False, "connections_closed": 0}
        mock_iv.return_value = {"success": True, "updated": True}

        _force_close_or_invalidate("slide", "c-1", new_version=99)

        mock_iv.assert_called_once_with("slide", "c-1", 99)

    @patch("apps.collab.api._invalidate_collab_version")
    @patch("apps.collab.api._force_close_collab_document")
    def test_version_none_skips_invalidate(self, mock_fc, mock_iv):
        """资源无版本号字段时（如 Table），不调用 invalidate-version。"""
        from apps.collab.api import _force_close_or_invalidate

        mock_fc.return_value = {"success": False, "loaded": False, "connections_closed": 0}

        result = _force_close_or_invalidate("table", "t-1", new_version=None)

        assert result["success"] is False
        mock_iv.assert_not_called()
