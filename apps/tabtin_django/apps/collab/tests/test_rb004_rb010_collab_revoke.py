"""
RB-004 / RB-010 回归测试

RB-004: Django 权限变更后通知 collab-live 撤销协作连接
RB-010: 成员角色降权后通知 collab-live 重验证
"""
import os
import uuid
from unittest.mock import MagicMock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402
django.setup()

import pytest  # noqa: E402


class TestRevokeUserCollabAccess:
    """RB-004: revoke_user_collab_access 通过批量端点撤销用户协作连接。"""

    @patch("apps.services.common.live_api.call_live_api_safe")
    def test_calls_revoke_user_access_endpoint(self, mock_call_live):
        from apps.collab.api import revoke_user_collab_access

        user_id = str(uuid.uuid4())
        ws_id = str(uuid.uuid4())
        mock_call_live.return_value = {"connections_closed": 3}

        result = revoke_user_collab_access(user_id, ws_id)

        assert result["revoked"] is True
        assert result["connections_closed"] == 3
        mock_call_live.assert_called_once()
        args = mock_call_live.call_args
        assert args[0][0] == "/internal/revoke-user-access"
        assert args[0][1] == {"user_id": user_id}

    @patch("apps.services.common.live_api.call_live_api_safe")
    def test_returns_error_on_failure(self, mock_call_live):
        from apps.collab.api import revoke_user_collab_access

        mock_call_live.return_value = {"error": "collab-live 服务不可用"}

        result = revoke_user_collab_access("u1", "ws1")

        assert result["revoked"] is False
        assert "error" in result

    @patch("apps.services.common.live_api.call_live_api_safe")
    def test_zero_connections_still_success(self, mock_call_live):
        from apps.collab.api import revoke_user_collab_access

        mock_call_live.return_value = {"connections_closed": 0}

        result = revoke_user_collab_access("u1", "ws1")

        assert result["revoked"] is True
        assert result["connections_closed"] == 0


class TestAsyncRevokeCollabAccessTask:
    """RB-004: Celery 任务包装器正确委托给 revoke_user_collab_access。"""

    def test_task_registered(self):
        from apps.collab.tasks import async_revoke_collab_access
        assert async_revoke_collab_access.name == "collab.revoke_user_collab_access"

    def test_task_has_time_limits(self):
        from apps.collab.tasks import async_revoke_collab_access
        assert async_revoke_collab_access.time_limit is not None
        assert async_revoke_collab_access.soft_time_limit is not None

    @patch("apps.collab.api.revoke_user_collab_access")
    def test_task_calls_utility(self, mock_revoke):
        from apps.collab.tasks import async_revoke_collab_access

        mock_revoke.return_value = {"revoked": 5, "errors": 0, "total": 5}

        result = async_revoke_collab_access("user-x", "ws-y")

        mock_revoke.assert_called_once_with("user-x", "ws-y")
        assert result["revoked"] == 5

    @patch("apps.collab.api.revoke_user_collab_access")
    def test_task_retries_on_exception(self, mock_revoke):
        """DS-025: 异常触发 self.retry() 而非静默吞掉。

        直接调用模式下 self.retry(exc=exc) 重新抛出 exc 本身。
        """
        from apps.collab.tasks import async_revoke_collab_access

        mock_revoke.side_effect = RuntimeError("boom")

        with pytest.raises(RuntimeError, match="boom"):
            async_revoke_collab_access("user-x", "ws-y")


class TestRB004LeaveOrganizationNotifiesCollab:
    """RB-004: leave_organization 在事务提交后调度 collab 撤销。"""

    def test_leave_organization_schedules_collab_revoke(self):
        """leave_organization 方法包含 _schedule_collab_revoke 调用。"""
        import inspect
        from apps.tabtinspace.services.organization_service import OrganizationService
        source = inspect.getsource(OrganizationService.leave_organization)
        assert "_schedule_collab_revoke" in source


class TestRB004RemoveMemberNotifiesCollab:
    """RB-004: remove_member 在事务提交后调度 collab 撤销。RV-014: 改用同步撤销。"""

    def test_remove_member_schedules_collab_revoke(self):
        """remove_member 方法包含 _sync_collab_revoke 调用（RV-014 高危操作同步撤销）。"""
        import inspect
        from apps.tabtinspace.services.organization_service import OrganizationService
        source = inspect.getsource(OrganizationService.remove_member)
        assert "_sync_collab_revoke" in source


class TestRB010UpdateMemberRoleNotifiesCollab:
    """RB-010: update_member_role 从可编辑角色降为 viewer 时通知 collab-live。RV-013: 改用降级为只读。"""

    def test_update_member_role_has_collab_revoke_on_downgrade(self):
        """update_member_role 方法包含降权时的 collab 降级逻辑（RV-013 _schedule_collab_downgrade）。"""
        import inspect
        from apps.tabtinspace.services.organization_service import OrganizationService
        source = inspect.getsource(OrganizationService.update_member_role)
        assert "_schedule_collab_downgrade" in source
        assert "old_role" in source
        assert "ROLE_LEVELS" in source

    def test_schedule_collab_revoke_uses_on_commit(self):
        """_schedule_collab_revoke 通过 transaction.on_commit 调度。"""
        import inspect
        from apps.tabtinspace.services.organization_service import OrganizationService
        source = inspect.getsource(OrganizationService._schedule_collab_revoke)
        assert "on_commit" in source
        assert "async_revoke_collab_access" in source

    def test_revoke_utility_is_importable(self):
        """revoke_user_collab_access 可正常导入。"""
        from apps.collab.api import revoke_user_collab_access
        assert callable(revoke_user_collab_access)
