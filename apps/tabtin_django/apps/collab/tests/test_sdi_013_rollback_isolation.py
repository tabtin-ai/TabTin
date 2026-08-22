"""
SDI-013 回归测试

验证 rollback_agent_run 端点的用户隔离：
  1. 无权限资源的 agent_run_id 应返回 404（防止存在性枚举）
  2. 仅处理调用者有 edit 权限的资源
  3. 不泄漏其他用户资源的类型和 ID
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


class TestRollbackExecutionRunUserIsolation:
    """SDI-013: rollback_agent_run 必须按用户权限过滤资源，防止存在性泄漏。"""

    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.VersionHistoryService")
    def test_returns_404_when_user_has_no_access_to_any_resource(
        self, mock_vh_svc_cls, mock_get_adapter
    ):
        """攻击者猜测他人的 agent_run_id 时，应返回 404 而非 403。"""
        from apps.collab.api import rollback_agent_run

        other_res_id = str(uuid.uuid4())
        changelogs = [_make_changelog("docs", other_res_id, "run-other-user")]

        adapter = MagicMock()
        adapter.get_resource.return_value = MagicMock()
        adapter.check_permission.return_value = False
        mock_get_adapter.return_value = adapter

        with patch("apps.collab.models.ChangeLog") as mock_cl_model:
            qs = MagicMock()
            qs.__iter__ = MagicMock(return_value=iter(changelogs))
            mock_cl_model.objects.using.return_value.filter.return_value.order_by.return_value = qs

            req = _make_request()
            status, result = rollback_agent_run(req, "run-other-user")

        assert status == 404, "应返回 404 防止存在性枚举"
        assert "not_found" in result["message"] or "error" in result["status"]

    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.VersionHistoryService")
    def test_returns_all_skipped_when_no_changelogs_exist(
        self, mock_vh_svc_cls, mock_get_adapter
    ):
        """不存在的 agent_run_id 应返回 200 + all_skipped。"""
        from apps.collab.api import rollback_agent_run

        with patch("apps.collab.models.ChangeLog") as mock_cl_model:
            qs = MagicMock()
            qs.__iter__ = MagicMock(return_value=iter([]))
            mock_cl_model.objects.using.return_value.filter.return_value.order_by.return_value = qs

            req = _make_request()
            result = rollback_agent_run(req, "nonexistent-run")

        assert result["status"] == "ok"
        assert result["data"]["all_skipped"] is True

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.VersionHistoryService")
    def test_only_processes_permitted_resources(
        self, mock_vh_svc_cls, mock_get_adapter, mock_force_close
    ):
        """跨用户 agent_run 中，仅回滚调用者有权限的资源。"""
        from apps.collab.api import rollback_agent_run

        res_owned = str(uuid.uuid4())
        res_foreign = str(uuid.uuid4())
        changelogs = [
            _make_changelog("docs", res_owned, "run-mixed"),
            _make_changelog("table", res_foreign, "run-mixed"),
        ]

        resource_owned = MagicMock()
        resource_foreign = MagicMock()

        def fake_get_resource(res_id):
            if res_id == res_owned:
                return resource_owned
            return resource_foreign

        def fake_check_permission(user, resource, action):
            return resource is resource_owned

        adapter = MagicMock()
        adapter.get_resource.side_effect = fake_get_resource
        adapter.get_resource_for_rollback.side_effect = fake_get_resource
        adapter.check_permission.side_effect = fake_check_permission
        mock_get_adapter.return_value = adapter

        pre_version = MagicMock()
        pre_version.id = uuid.uuid4()
        pre_version.created_at = changelogs[0].created_at

        restored_vh = MagicMock()
        restored_vh.id = uuid.uuid4()

        mock_vh_svc = MagicMock()
        mock_vh_svc.restore_to_version.return_value = restored_vh
        mock_vh_svc_cls.return_value = mock_vh_svc

        class _FakeAtomic:
            def __enter__(self):
                return self
            def __exit__(self, *args):
                return False

        with patch("apps.collab.models.ChangeLog") as mock_cl_model, \
             patch("apps.collab.models.VersionHistory") as mock_vh_model, \
             patch("django.db.transaction.atomic", return_value=_FakeAtomic()):
            qs = MagicMock()
            qs.__iter__ = MagicMock(return_value=iter(changelogs))
            mock_cl_model.objects.using.return_value.filter.return_value.order_by.return_value = qs

            vh_qs = MagicMock()
            vh_qs.filter.return_value.order_by.return_value.first.return_value = pre_version
            mock_vh_model.objects.using.return_value = vh_qs

            req = _make_request()
            result = rollback_agent_run(req, "run-mixed")

        if isinstance(result, tuple):
            _, result = result
        assert result["status"] == "ok"
        rollback_results = result["data"]["rollback_results"]
        processed_res_ids = [r["resource_id"] for r in rollback_results]

        assert res_owned in processed_res_ids, "有权限的资源应被回滚"
        assert res_foreign not in processed_res_ids, "无权限的资源不应出现在结果中"

    @patch("apps.collab.api.get_adapter_or_raise")
    def test_no_resource_type_leak_for_unauthorized(self, mock_get_adapter):
        """无权限时，响应不应包含任何资源类型或 ID 信息。"""
        from apps.collab.api import rollback_agent_run

        secret_res_id = str(uuid.uuid4())
        changelogs = [
            _make_changelog("secret_module", secret_res_id, "run-secret"),
        ]

        adapter = MagicMock()
        adapter.get_resource.return_value = MagicMock()
        adapter.check_permission.return_value = False
        mock_get_adapter.return_value = adapter

        with patch("apps.collab.models.ChangeLog") as mock_cl_model:
            qs = MagicMock()
            qs.__iter__ = MagicMock(return_value=iter(changelogs))
            mock_cl_model.objects.using.return_value.filter.return_value.order_by.return_value = qs

            req = _make_request()
            status, result = rollback_agent_run(req, "run-secret")

        assert status == 404
        response_str = str(result)
        assert "secret_module" not in response_str, "不应泄漏资源类型"
        assert secret_res_id not in response_str, "不应泄漏资源 ID"
