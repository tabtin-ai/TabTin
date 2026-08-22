"""
RB-006 / RB-008 回归测试

RB-006: collab_persist 中 editor_type=agent 分支必须校验 agent owner 的资源权限
RB-008: _is_live_request 在非 DEBUG 环境使用默认 LIVE_SECRET 时必须拒绝并记录日志
"""
import os
import uuid
from unittest.mock import MagicMock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402
django.setup()

import pytest  # noqa: E402


# ══════════════════════════════════════════════════════════
# RB-006: agent 级持久化权限校验
# ══════════════════════════════════════════════════════════

class TestAgentPersistPermissionCheck:
    """验证 collab_persist 的 editor_type=agent 分支进行权限重校验。"""

    def _make_live_request(self):
        req = MagicMock()
        req.headers = {"X-Live-Secret": "collab-live-dev-secret"}
        return req

    def _make_body(self, editor_type="agent", editor_id="agent-1",
                   agent_run_id="run-1"):
        body = MagicMock()
        body.op_id = ""
        body.changes = {"data": {}}
        body.editor_type = editor_type
        body.editor_id = editor_id
        body.editor_name = "test-agent"
        body.agent_run_id = agent_run_id
        return body

    @patch("apps.collab.api._get_live_secret", return_value="collab-live-dev-secret")
    @patch("apps.collab.api._cached_is_debug", return_value=True)
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api._resolve_agent_owner")
    def test_agent_persist_denied_when_owner_has_no_permission(
        self, mock_resolve, mock_get_adapter, _debug, _secret
    ):
        """agent owner 无资源编辑权限时应返回 403。"""
        from apps.collab.api import collab_persist

        adapter = MagicMock()
        adapter.get_resource.return_value = MagicMock(id="res-1")
        adapter.check_permission.return_value = False
        mock_get_adapter.return_value = adapter

        owner_user = MagicMock()
        owner_user.id = "user-owner-1"
        mock_resolve.return_value = owner_user

        req = self._make_live_request()
        body = self._make_body()
        rid = uuid.uuid4()

        status, result = collab_persist(req, "docs", rid, body)

        assert status == 403
        adapter.check_permission.assert_called_once_with(owner_user, adapter.get_resource.return_value, "edit")

    @patch("apps.collab.api._get_live_secret", return_value="collab-live-dev-secret")
    @patch("apps.collab.api._cached_is_debug", return_value=True)
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api._resolve_agent_owner")
    def test_agent_persist_denied_when_owner_unresolvable(
        self, mock_resolve, mock_get_adapter, _debug, _secret
    ):
        """无法通过 agent_run_id 或 editor_id 解析出 owner 时应返回 403。"""
        from apps.collab.api import collab_persist

        adapter = MagicMock()
        adapter.get_resource.return_value = MagicMock(id="res-1")
        mock_get_adapter.return_value = adapter

        mock_resolve.return_value = None

        req = self._make_live_request()
        body = self._make_body(agent_run_id="", editor_id="")
        rid = uuid.uuid4()

        status, result = collab_persist(req, "docs", rid, body)

        assert status == 403

    @patch("apps.collab.api._get_live_secret", return_value="collab-live-dev-secret")
    @patch("apps.collab.api._cached_is_debug", return_value=True)
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api._resolve_agent_owner")
    @patch("django.db.transaction.atomic")
    def test_agent_persist_allowed_when_owner_has_permission(
        self, mock_atomic, mock_resolve, mock_get_adapter, _debug, _secret
    ):
        """agent owner 有资源编辑权限时应允许持久化。"""
        from apps.collab.api import collab_persist

        mock_ctx = MagicMock()
        mock_atomic.return_value = mock_ctx
        mock_ctx.__enter__ = MagicMock(return_value=None)
        mock_ctx.__exit__ = MagicMock(return_value=False)

        adapter = MagicMock()
        adapter.get_resource.return_value = MagicMock(id="res-1")
        adapter.check_permission.return_value = True
        adapter.persist_changes.return_value = {"version": 2}
        mock_get_adapter.return_value = adapter

        owner_user = MagicMock()
        owner_user.id = "user-owner-1"
        mock_resolve.return_value = owner_user

        req = self._make_live_request()
        body = self._make_body()
        rid = uuid.uuid4()

        result = collab_persist(req, "docs", rid, body)

        assert result["status"] == "ok"
        adapter.check_permission.assert_called_once_with(owner_user, adapter.get_resource.return_value, "edit")


# ══════════════════════════════════════════════════════════
# RB-006: _resolve_agent_owner 单元测试
# ══════════════════════════════════════════════════════════

class TestResolveAgentOwner:
    """验证 _resolve_agent_owner 辅助函数的行为。"""

    @patch("apps.collab.api.logger")
    def test_returns_none_when_both_empty(self, _logger):
        from apps.collab.api import _resolve_agent_owner
        assert _resolve_agent_owner("", "") is None

    @patch("django.contrib.auth.get_user_model")
    def test_uses_editor_id_as_fallback(self, mock_get_user_model):
        from apps.collab.api import _resolve_agent_owner

        mock_user = MagicMock()
        mock_model = MagicMock()
        mock_model.objects.filter.return_value.first.return_value = mock_user
        mock_get_user_model.return_value = mock_model

        result = _resolve_agent_owner("", "user-123")

        assert result == mock_user
        mock_model.objects.filter.assert_called_once_with(id="user-123")

    @patch("django.contrib.auth.get_user_model")
    @patch("apps.services.agent_engine.models.ExecutionRun")
    def test_resolves_user_via_agent_run(self, mock_agent_run, mock_get_user_model):
        from apps.collab.api import _resolve_agent_owner

        mock_agent_run.objects.filter.return_value.values_list.return_value.first.return_value = "owner-user-id"

        mock_user = MagicMock()
        mock_model = MagicMock()
        mock_model.objects.filter.return_value.first.return_value = mock_user
        mock_get_user_model.return_value = mock_model

        result = _resolve_agent_owner("run-abc", "fallback-id")

        assert result == mock_user
        mock_model.objects.filter.assert_called_once_with(id="owner-user-id")

    @patch("django.contrib.auth.get_user_model")
    @patch("apps.services.agent_engine.models.ExecutionRun")
    def test_falls_back_to_editor_id_when_agent_run_not_found(
        self, mock_agent_run, mock_get_user_model
    ):
        from apps.collab.api import _resolve_agent_owner

        mock_agent_run.objects.filter.return_value.values_list.return_value.first.return_value = None

        mock_user = MagicMock()
        mock_model = MagicMock()
        mock_model.objects.filter.return_value.first.return_value = mock_user
        mock_get_user_model.return_value = mock_model

        result = _resolve_agent_owner("nonexistent-run", "fallback-user-id")

        assert result == mock_user
        mock_model.objects.filter.assert_called_once_with(id="fallback-user-id")


# ══════════════════════════════════════════════════════════
# RB-008: _is_live_request 默认密钥保护
# ══════════════════════════════════════════════════════════

class TestIsLiveRequestDefaultSecretProtection:
    """验证 _is_live_request 在非 DEBUG 环境拒绝默认密钥。"""

    @patch("apps.collab.api._get_live_secret", return_value="collab-live-dev-secret")
    @patch("apps.collab.api._cached_is_debug", return_value=False)
    def test_rejects_default_secret_in_production(self, _debug, _secret):
        from apps.collab.api import _is_live_request

        req = MagicMock()
        req.headers = {"X-Live-Secret": "collab-live-dev-secret"}

        assert _is_live_request(req) is False

    @patch("apps.collab.api._get_live_secret", return_value="collab-live-dev-secret")
    @patch("apps.collab.api._cached_is_debug", return_value=True)
    def test_accepts_default_secret_in_debug(self, _debug, _secret):
        from apps.collab.api import _is_live_request

        req = MagicMock()
        req.headers = {"X-Live-Secret": "collab-live-dev-secret"}

        assert _is_live_request(req) is True

    @patch("apps.collab.api._get_live_secret", return_value="")
    def test_rejects_when_secret_not_configured(self, _secret):
        from apps.collab.api import _is_live_request

        req = MagicMock()
        req.headers = {"X-Live-Secret": "anything"}

        assert _is_live_request(req) is False

    @patch("apps.collab.api._get_live_secret", return_value="secure-random-secret")
    @patch("apps.collab.api._cached_is_debug", return_value=False)
    def test_accepts_proper_secret_in_production(self, _debug, _secret):
        from apps.collab.api import _is_live_request

        req = MagicMock()
        req.headers = {"X-Live-Secret": "secure-random-secret"}

        assert _is_live_request(req) is True

    @patch("apps.collab.api._get_live_secret", return_value="secure-random-secret")
    @patch("apps.collab.api._cached_is_debug", return_value=False)
    def test_rejects_wrong_secret(self, _debug, _secret):
        from apps.collab.api import _is_live_request

        req = MagicMock()
        req.headers = {"X-Live-Secret": "wrong-secret"}

        assert _is_live_request(req) is False
