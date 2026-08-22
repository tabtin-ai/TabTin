"""
CC-024 回归测试

CC-024: rollback_agent_run 的 pre_change_version 查询未限定 organization_id，
        跨团队数据隔离不完整。

修复：从 resource 对象获取 organization_id，在 VersionHistory 查询中加入
     organization_id 过滤条件，防止跨团队版本历史泄漏。
"""
import os
import uuid
from unittest.mock import MagicMock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402
django.setup()

import pytest  # noqa: E402
from django.utils import timezone  # noqa: E402


def _make_request(user_id="u-test"):
    req = MagicMock()
    req.auth = MagicMock()
    req.auth.id = user_id
    req.auth.nickname = "tester"
    return req


def _make_resource(organization_id=None, team_id=None, name="test-resource"):
    resource = MagicMock()
    resource.organization_id = organization_id
    resource.team_id = team_id
    resource.name = name
    return resource


def _make_changelog(resource_type, resource_id, agent_run_id):
    cl = MagicMock()
    cl.resource_type = resource_type
    cl.resource_id = uuid.UUID(resource_id) if isinstance(resource_id, str) else resource_id
    cl.agent_run_id = agent_run_id
    cl.created_at = timezone.now()
    return cl


class _FakeAtomic:
    def __enter__(self): return self
    def __exit__(self, *a): return False


def _setup_changelog_mock(mock_cl_cls, cl_list):
    """配置 ChangeLog mock，支持 filter/order_by/values_list/exists 链式调用。"""
    mock_cl_qs = MagicMock()
    mock_cl_qs.__iter__ = MagicMock(return_value=iter(cl_list))
    mock_cl_qs.filter.return_value = mock_cl_qs
    mock_cl_qs.order_by.return_value = mock_cl_qs
    mock_cl_qs.values_list.return_value = []
    mock_cl_qs.exists.return_value = False
    mock_cl_cls.objects.using.return_value.filter.return_value = mock_cl_qs
    mock_cl_cls.objects.using.return_value.filter.return_value.order_by.return_value = mock_cl_qs
    return mock_cl_qs


def _setup_vh_mock(mock_vh_cls, first_result=None):
    """配置 VersionHistory mock，返回链式查询对象。"""
    mock_vh_qs = MagicMock()
    mock_vh_qs.filter.return_value = mock_vh_qs
    mock_vh_qs.exclude.return_value = mock_vh_qs
    mock_vh_qs.order_by.return_value = mock_vh_qs
    mock_vh_qs.first.return_value = first_result
    mock_vh_cls.objects.using.return_value = mock_vh_qs
    return mock_vh_qs


class TestCC024OrganizationIdIsolation:
    """CC-024: pre_change_version 查询必须限定 organization_id，防止跨团队泄漏。"""

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api.VersionHistoryService")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.models.ChangeLog")
    @patch("apps.collab.models.VersionHistory")
    @patch("django.db.transaction")
    def test_pre_change_version_query_includes_organization_id(
        self, mock_txn, mock_vh_cls, mock_cl_cls, mock_get_adapter, mock_vh_svc_cls, mock_force_close
    ):
        """当 resource 有 organization_id 时，VersionHistory 查询必须加 organization_id 过滤。"""
        from apps.collab.api import rollback_agent_run

        agent_run_id = "run-cc024-test"
        res_type = "table"
        res_id = uuid.uuid4()
        organization_id = uuid.uuid4()

        resource = _make_resource(organization_id=organization_id)
        adapter = MagicMock()
        adapter.get_resource_for_rollback.return_value = resource
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        cl = _make_changelog(res_type, res_id, agent_run_id)
        _setup_changelog_mock(mock_cl_cls, [cl])
        mock_vh_qs = _setup_vh_mock(mock_vh_cls, first_result=None)
        mock_txn.atomic.return_value = _FakeAtomic()

        req = _make_request()
        rollback_agent_run(req, agent_run_id)

        # 验证 VersionHistory.objects.using().filter() 被调用时包含了 organization_id
        filter_calls = mock_vh_qs.filter.call_args_list
        assert len(filter_calls) > 0, "VersionHistory.filter 应该被调用"

        found_organization_filter = False
        for c in filter_calls:
            kwargs = c[1] if c[1] else {}
            if "resource_type" in kwargs and "resource_id" in kwargs:
                assert "organization_id" in kwargs, (
                    f"CC-024: pre_change_version 查询缺少 organization_id 过滤！实际 kwargs={kwargs}"
                )
                assert kwargs["organization_id"] == organization_id
                found_organization_filter = True

        assert found_organization_filter, "未找到包含 resource_type+resource_id 的 VersionHistory.filter 调用"

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api.VersionHistoryService")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.models.ChangeLog")
    @patch("apps.collab.models.VersionHistory")
    @patch("django.db.transaction")
    def test_pre_change_version_query_without_organization_id_no_filter(
        self, mock_txn, mock_vh_cls, mock_cl_cls, mock_get_adapter, mock_vh_svc_cls, mock_force_close
    ):
        """当 resource 没有 organization_id 时，不加 organization_id 过滤（保持向后兼容）。"""
        from apps.collab.api import rollback_agent_run

        agent_run_id = "run-cc024-no-wt"
        res_type = "docs"
        res_id = uuid.uuid4()

        resource = _make_resource(organization_id=None, team_id=None)
        adapter = MagicMock()
        adapter.get_resource_for_rollback.return_value = resource
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        cl = _make_changelog(res_type, res_id, agent_run_id)
        _setup_changelog_mock(mock_cl_cls, [cl])
        mock_vh_qs = _setup_vh_mock(mock_vh_cls, first_result=None)
        mock_txn.atomic.return_value = _FakeAtomic()

        req = _make_request()
        rollback_agent_run(req, agent_run_id)

        # organization_id 为 None 时，filter 不应包含 organization_id 键
        filter_calls = mock_vh_qs.filter.call_args_list
        for c in filter_calls:
            kwargs = c[1] if c[1] else {}
            if "resource_type" in kwargs and "resource_id" in kwargs:
                assert "organization_id" not in kwargs, (
                    "organization_id 为 None 时不应加入过滤条件（避免过滤 organization_id=NULL 的记录）"
                )

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api.VersionHistoryService")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.models.ChangeLog")
    @patch("apps.collab.models.VersionHistory")
    @patch("django.db.transaction")
    def test_team_id_fallback_used_when_organization_id_absent(
        self, mock_txn, mock_vh_cls, mock_cl_cls, mock_get_adapter, mock_vh_svc_cls, mock_force_close
    ):
        """当 resource 无 organization_id 但有 team_id 时，使用 team_id 作为隔离条件。"""
        from apps.collab.api import rollback_agent_run

        agent_run_id = "run-cc024-team-id"
        res_type = "design"
        res_id = uuid.uuid4()
        team_id = uuid.uuid4()

        resource = MagicMock()
        resource.organization_id = None
        resource.team_id = team_id
        resource.name = "design-resource"

        adapter = MagicMock()
        adapter.get_resource_for_rollback.return_value = resource
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        cl = _make_changelog(res_type, res_id, agent_run_id)
        _setup_changelog_mock(mock_cl_cls, [cl])
        mock_vh_qs = _setup_vh_mock(mock_vh_cls, first_result=None)
        mock_txn.atomic.return_value = _FakeAtomic()

        req = _make_request()
        rollback_agent_run(req, agent_run_id)

        filter_calls = mock_vh_qs.filter.call_args_list
        found = False
        for c in filter_calls:
            kwargs = c[1] if c[1] else {}
            if "resource_type" in kwargs and "resource_id" in kwargs:
                assert "organization_id" in kwargs, "应使用 team_id 作为 organization_id 过滤"
                assert kwargs["organization_id"] == team_id
                found = True
        assert found, "未找到 VersionHistory.filter 调用"

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api.VersionHistoryService")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.models.ChangeLog")
    @patch("apps.collab.models.VersionHistory")
    @patch("django.db.transaction")
    def test_cross_team_version_not_used_as_pre_change(
        self, mock_txn, mock_vh_cls, mock_cl_cls, mock_get_adapter, mock_vh_svc_cls, mock_force_close
    ):
        """
        模拟跨团队场景：resource 属于 team_A，VersionHistory 查询应仅限 team_A。
        修复后，查询参数中必须包含 organization_id=team_a_id。
        """
        from apps.collab.api import rollback_agent_run

        agent_run_id = "run-cc024-cross-team"
        res_type = "slide"
        res_id = uuid.uuid4()
        team_a_id = uuid.uuid4()

        resource = _make_resource(organization_id=team_a_id)
        adapter = MagicMock()
        adapter.get_resource_for_rollback.return_value = resource
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        cl = _make_changelog(res_type, res_id, agent_run_id)
        _setup_changelog_mock(mock_cl_cls, [cl])

        team_a_vh = MagicMock()
        team_a_vh.id = uuid.uuid4()
        team_a_vh.organization_id = team_a_id
        mock_vh_qs = _setup_vh_mock(mock_vh_cls, first_result=team_a_vh)

        mock_svc = MagicMock()
        mock_svc.acquire_restore_lock.return_value = None
        mock_vh_svc_cls.return_value = mock_svc

        mock_txn.atomic.return_value = _FakeAtomic()

        req = _make_request()
        rollback_agent_run(req, agent_run_id)

        filter_calls = mock_vh_qs.filter.call_args_list
        found = False
        for c in filter_calls:
            kwargs = c[1] if c[1] else {}
            if "resource_type" in kwargs and "resource_id" in kwargs:
                assert kwargs.get("organization_id") == team_a_id, (
                    f"应使用 team_A 的 organization_id 过滤，实际: {kwargs}"
                )
                found = True
        assert found
