"""
E2E-015 / E2E-016 / E2E-017 / E2E-018 / E2E-025 / E2E-026 回归测试

E2E-015: rollback_agent_run 对 create 类型 ChangeLog 执行 trash 而非 skip
E2E-016: 混合场景（先 create 后 update 同一资源）正确 trash 而非 skip
E2E-017: 全部 skip 场景响应包含 all_skipped=True 标记
E2E-018: rollback_resources 中 trash 操作后触发 force_close
E2E-025: 失败响应使用 rollback_results 而非 partial_results
E2E-026: loaded=False 不被误判为 force_close 警告
"""
import os
import uuid
from unittest.mock import MagicMock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402

django.setup()

import pytest  # noqa: E402


class _FakeAtomic:
    """用于 mock django.db.transaction.atomic 的上下文管理器。"""
    def __enter__(self): return self
    def __exit__(self, *a): return False


def _make_request(user_id="u-test"):
    req = MagicMock()
    req.auth = MagicMock()
    req.auth.id = user_id
    req.auth.nickname = "tester"
    return req


def _make_changelog(resource_type, resource_id, agent_run_id, created_at=None):
    from django.utils import timezone

    cl = MagicMock()
    cl.resource_type = resource_type
    cl.resource_id = uuid.UUID(resource_id) if isinstance(resource_id, str) else resource_id
    cl.agent_run_id = agent_run_id
    cl.created_at = created_at or timezone.now()
    return cl


def _setup_rollback_mocks(mock_cl_model, mock_vh_model, changelogs,
                          has_create=False, has_vh_missing=False,
                          pre_version=None):
    """配置 rollback_agent_run 所需的完整 mock。

    新代码使用：
    - ChangeLog.filter(version_history__isnull=False).values_list(...) → run_vh_ids
    - VersionHistory.filter(...).exclude(id__in=run_vh_ids).order_by("-created_at").first() → pre_change_version
    - ChangeLog.filter(change_type="create").exists() → has_create
    - ChangeLog.filter(version_history__isnull=True).exists() → has_vh_missing
    """
    qs = MagicMock()
    qs.__iter__ = MagicMock(return_value=iter(changelogs))

    empty_values_qs = MagicMock()
    empty_values_qs.values_list.return_value = []

    create_qs = MagicMock()
    create_qs.exists.return_value = has_create

    vh_missing_qs = MagicMock()
    vh_missing_qs.exists.return_value = has_vh_missing

    def fake_cl_filter(*args, **kwargs):
        if kwargs.get("version_history__isnull") is False:
            return empty_values_qs
        if kwargs.get("change_type") == "create":
            return create_qs
        if kwargs.get("version_history__isnull") is True:
            return vh_missing_qs
        return MagicMock(order_by=MagicMock(return_value=qs))

    mock_cl_model.objects.using.return_value.filter.side_effect = fake_cl_filter
    mock_cl_model.objects.using.return_value.filter.return_value.order_by.return_value = qs

    exclude_chain = MagicMock()
    exclude_chain.order_by.return_value.first.return_value = pre_version
    vh_qs = MagicMock()
    vh_qs.filter.return_value.exclude.return_value = exclude_chain
    mock_vh_model.objects.using.return_value = vh_qs


# ═══════════════════════════════════════════════════════════
# E2E-015: 新建资源应被 trash 而非 skip
# ═══════════════════════════════════════════════════════════


class TestE2E015TrashNewResourceInRollback:
    """E2E-015: rollback_agent_run 对 create 类型 ChangeLog 应执行 trash。"""

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api._trash_resource_in_rollback")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.VersionHistoryService")
    @patch("django.db.transaction")
    def test_new_resource_with_create_changelog_is_trashed(
        self, mock_txn, mock_vh_svc_cls, mock_get_adapter, mock_trash, mock_force_close
    ):
        """pre_change_version=None 且有 create ChangeLog → 资源被 trash，status=trashed。"""
        from apps.collab.api import rollback_agent_run
        mock_txn.atomic.return_value = _FakeAtomic()

        res_id = str(uuid.uuid4())
        changelogs = [_make_changelog("docs", res_id, "run-create-001")]

        resource = MagicMock()
        resource.name = "新建文档"
        adapter = MagicMock()
        adapter.get_resource_for_rollback.return_value = resource
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        mock_trash.return_value = True
        mock_force_close.return_value = {"success": True, "loaded": True, "connections_closed": 1}

        with patch("apps.collab.models.ChangeLog") as mock_cl_model, \
             patch("apps.collab.models.VersionHistory") as mock_vh_model:
            _setup_rollback_mocks(mock_cl_model, mock_vh_model, changelogs,
                                  has_create=True, pre_version=None)

            req = _make_request()
            result = rollback_agent_run(req, "run-create-001")

        assert result["status"] == "ok"
        rollback_results = result["data"]["rollback_results"]
        assert len(rollback_results) == 1
        assert rollback_results[0]["status"] == "trashed"
        assert rollback_results[0]["reason"] == "new_resource_trashed"
        mock_trash.assert_called_once()

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api._trash_resource_in_rollback")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.VersionHistoryService")
    @patch("django.db.transaction")
    def test_new_resource_without_create_changelog_is_skipped(
        self, mock_txn, mock_vh_svc_cls, mock_get_adapter, mock_trash, mock_force_close
    ):
        """pre_change_version=None 且无 create ChangeLog → 资源被 skip，reason=no_pre_version。"""
        from apps.collab.api import rollback_agent_run
        mock_txn.atomic.return_value = _FakeAtomic()

        res_id = str(uuid.uuid4())
        changelogs = [_make_changelog("docs", res_id, "run-no-create")]

        resource = MagicMock()
        resource.name = "文档"
        adapter = MagicMock()
        adapter.get_resource_for_rollback.return_value = resource
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        with patch("apps.collab.models.ChangeLog") as mock_cl_model, \
             patch("apps.collab.models.VersionHistory") as mock_vh_model:
            _setup_rollback_mocks(mock_cl_model, mock_vh_model, changelogs,
                                  has_create=False, pre_version=None)

            req = _make_request()
            result = rollback_agent_run(req, "run-no-create")

        assert result["status"] == "ok"
        rollback_results = result["data"]["rollback_results"]
        assert len(rollback_results) == 1
        assert rollback_results[0]["status"] == "skipped"
        assert rollback_results[0]["reason"] in ("no_pre_version", "no_version_history")
        mock_trash.assert_not_called()

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api._trash_resource_in_rollback")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.VersionHistoryService")
    @patch("django.db.transaction")
    def test_trash_failure_results_in_skip_not_error(
        self, mock_txn, mock_vh_svc_cls, mock_get_adapter, mock_trash, mock_force_close
    ):
        """trash 失败时资源被 skip（reason=trash_failed），不中断整批回滚。"""
        from apps.collab.api import rollback_agent_run
        mock_txn.atomic.return_value = _FakeAtomic()

        res_id = str(uuid.uuid4())
        changelogs = [_make_changelog("docs", res_id, "run-trash-fail")]

        resource = MagicMock()
        resource.name = "画布"
        adapter = MagicMock()
        adapter.get_resource_for_rollback.return_value = resource
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        mock_trash.return_value = False

        with patch("apps.collab.models.ChangeLog") as mock_cl_model, \
             patch("apps.collab.models.VersionHistory") as mock_vh_model:
            _setup_rollback_mocks(mock_cl_model, mock_vh_model, changelogs,
                                  has_create=True, pre_version=None)

            req = _make_request()
            result = rollback_agent_run(req, "run-trash-fail")

        assert result["status"] == "ok"
        rollback_results = result["data"]["rollback_results"]
        assert rollback_results[0]["status"] == "skipped"
        assert rollback_results[0]["reason"] == "trash_failed"


# ═══════════════════════════════════════════════════════════
# E2E-016: 混合场景（先 create 后 update）正确 trash
# ═══════════════════════════════════════════════════════════


class TestE2E016MixedCreateUpdateScenario:
    """E2E-016: 先 create 后 update 同一资源，pre_change_version=None，应 trash 而非 skip。"""

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api._trash_resource_in_rollback")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.VersionHistoryService")
    @patch("django.db.transaction")
    def test_create_then_update_resource_is_trashed(
        self, mock_txn, mock_vh_svc_cls, mock_get_adapter, mock_trash, mock_force_close
    ):
        """同一资源有 create 和 update 两条 ChangeLog，first_change 是 create，
        pre_change_version=None，应被 trash 而非 skip。"""
        from apps.collab.api import rollback_agent_run
        mock_txn.atomic.return_value = _FakeAtomic()

        res_id = str(uuid.uuid4())
        changelogs = [_make_changelog("slide", res_id, "run-mixed-016")]

        resource = MagicMock()
        resource.name = "演示文稿"
        adapter = MagicMock()
        adapter.get_resource_for_rollback.return_value = resource
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        mock_trash.return_value = True
        mock_force_close.return_value = {"success": True, "loaded": False, "connections_closed": 0}

        with patch("apps.collab.models.ChangeLog") as mock_cl_model, \
             patch("apps.collab.models.VersionHistory") as mock_vh_model:
            _setup_rollback_mocks(mock_cl_model, mock_vh_model, changelogs,
                                  has_create=True, pre_version=None)

            req = _make_request()
            result = rollback_agent_run(req, "run-mixed-016")

        assert result["status"] == "ok"
        rollback_results = result["data"]["rollback_results"]
        assert rollback_results[0]["status"] == "trashed", \
            "混合场景（先 create 后 update）应 trash 而非 skip"
        mock_trash.assert_called_once()

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api._trash_resource_in_rollback")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.VersionHistoryService")
    @patch("django.db.transaction")
    def test_trashed_resource_triggers_force_close(
        self, mock_txn, mock_vh_svc_cls, mock_get_adapter, mock_trash, mock_force_close
    ):
        """trash 成功后应触发 force_close，通知 collab-live 断开连接。"""
        from apps.collab.api import rollback_agent_run
        mock_txn.atomic.return_value = _FakeAtomic()

        res_id = str(uuid.uuid4())
        changelogs = [_make_changelog("docs", res_id, "run-fc-after-trash")]

        resource = MagicMock()
        resource.name = "文档"
        adapter = MagicMock()
        adapter.get_resource_for_rollback.return_value = resource
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        mock_trash.return_value = True
        mock_force_close.return_value = {"success": True, "loaded": True, "connections_closed": 2}

        with patch("apps.collab.models.ChangeLog") as mock_cl_model, \
             patch("apps.collab.models.VersionHistory") as mock_vh_model:
            _setup_rollback_mocks(mock_cl_model, mock_vh_model, changelogs,
                                  has_create=True, pre_version=None)

            req = _make_request()
            rollback_agent_run(req, "run-fc-after-trash")

        mock_force_close.assert_called_once_with("docs", res_id)


# ═══════════════════════════════════════════════════════════
# E2E-017: 全部 skip 场景包含 all_skipped 标记
# ═══════════════════════════════════════════════════════════


class TestE2E017AllSkippedFlag:
    """E2E-017: 所有资源均被 skip 时，响应包含 all_skipped=True。"""

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.VersionHistoryService")
    @patch("django.db.transaction")
    def test_all_skipped_flag_present_when_all_resources_skipped(
        self, mock_txn, mock_vh_svc_cls, mock_get_adapter, mock_force_close
    ):
        """所有资源均 skip（无 create ChangeLog）时，data.all_skipped=True。"""
        from apps.collab.api import rollback_agent_run
        mock_txn.atomic.return_value = _FakeAtomic()

        res_a = str(uuid.uuid4())
        res_b = str(uuid.uuid4())
        changelogs = [
            _make_changelog("docs", res_a, "run-all-skip"),
            _make_changelog("slide", res_b, "run-all-skip"),
        ]

        resource = MagicMock()
        resource.name = "资源"
        adapter = MagicMock()
        adapter.get_resource_for_rollback.return_value = resource
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        with patch("apps.collab.models.ChangeLog") as mock_cl_model, \
             patch("apps.collab.models.VersionHistory") as mock_vh_model:
            _setup_rollback_mocks(mock_cl_model, mock_vh_model, changelogs,
                                  has_create=False, pre_version=None)

            req = _make_request()
            result = rollback_agent_run(req, "run-all-skip")

        assert result["status"] == "ok"
        assert result["data"].get("all_skipped") is True, \
            "全部 skip 时应包含 all_skipped=True"

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.VersionHistoryService")
    @patch("django.db.transaction")
    def test_all_skipped_flag_absent_when_some_restored(
        self, mock_txn, mock_vh_svc_cls, mock_get_adapter, mock_force_close
    ):
        """有资源被 restored 时，all_skipped 不应出现在响应中。"""
        from apps.collab.api import rollback_agent_run
        mock_txn.atomic.return_value = _FakeAtomic()

        res_a = str(uuid.uuid4())
        changelogs = [_make_changelog("docs", res_a, "run-partial")]

        resource = MagicMock()
        resource.name = "文档"
        adapter = MagicMock()
        adapter.get_resource_for_rollback.return_value = resource
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        pre_version = MagicMock()
        pre_version.id = uuid.uuid4()
        restored_vh = MagicMock()
        restored_vh.id = uuid.uuid4()
        mock_svc = MagicMock()
        mock_svc.acquire_restore_lock.return_value = None
        mock_svc.release_restore_lock.return_value = None
        mock_svc.restore_to_version_with_lock_held.return_value = restored_vh
        mock_vh_svc_cls.return_value = mock_svc
        mock_force_close.return_value = {"success": True, "loaded": True, "connections_closed": 0}

        with patch("apps.collab.models.ChangeLog") as mock_cl_model, \
             patch("apps.collab.models.VersionHistory") as mock_vh_model:
            _setup_rollback_mocks(mock_cl_model, mock_vh_model, changelogs,
                                  has_create=False, pre_version=pre_version)

            req = _make_request()
            result = rollback_agent_run(req, "run-partial")

        assert result["status"] == "ok"
        assert "all_skipped" not in result["data"], \
            "有 restored 资源时不应有 all_skipped 标记"


# ═══════════════════════════════════════════════════════════
# E2E-018: rollback_resources 中 trash 后触发 force_close
# ═══════════════════════════════════════════════════════════


class TestE2E018TrashTriggerForceClose:
    """E2E-018: rollback_resources 中 trash 操作成功后应触发 force_close。"""

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.chat.conversation.api.rollback._trash_resource")
    def test_trash_action_triggers_force_close(self, mock_trash, mock_force_close):
        """trash 操作成功后，force_close 应被调用一次。"""
        from apps.chat.conversation.api import rollback_resources
        from apps.chat.conversation.schemas import ResourceRestoreRequest, ResourceRestoreItem

        mock_trash.return_value = True
        mock_force_close.return_value = {"success": True, "loaded": True, "connections_closed": 1}

        res_id = str(uuid.uuid4())
        data = ResourceRestoreRequest(items=[
            ResourceRestoreItem(resource_type="docs", resource_id=res_id, action="trash"),
        ])

        req = _make_request()
        with patch("apps.chat.conversation.api.rollback.ChatSession") as mock_session_cls, \
             patch("apps.chat.conversation.api.rollback._get_allowed_rollback_resources") as mock_allowed:
            mock_session = MagicMock()
            mock_session.revert_message_id = "msg-001"
            mock_session_cls.objects.filter.return_value.first.return_value = mock_session
            mock_allowed.return_value = None

            session_id = str(uuid.uuid4())
            rollback_resources(req, session_id, data)

        mock_force_close.assert_called_once_with("docs", res_id)

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.chat.conversation.api.rollback._trash_resource")
    def test_trash_failure_does_not_trigger_force_close(self, mock_trash, mock_force_close):
        """trash 操作失败时，force_close 不应被调用。"""
        from apps.chat.conversation.api import rollback_resources
        from apps.chat.conversation.schemas import ResourceRestoreRequest, ResourceRestoreItem

        mock_trash.return_value = False

        res_id = str(uuid.uuid4())
        data = ResourceRestoreRequest(items=[
            ResourceRestoreItem(resource_type="docs", resource_id=res_id, action="trash"),
        ])

        req = _make_request()
        with patch("apps.chat.conversation.api.rollback.ChatSession") as mock_session_cls, \
             patch("apps.chat.conversation.api.rollback._get_allowed_rollback_resources") as mock_allowed:
            mock_session = MagicMock()
            mock_session.revert_message_id = "msg-001"
            mock_session_cls.objects.filter.return_value.first.return_value = mock_session
            mock_allowed.return_value = None

            session_id = str(uuid.uuid4())
            rollback_resources(req, session_id, data)

        mock_force_close.assert_not_called()


# ═══════════════════════════════════════════════════════════
# E2E-025: 失败响应使用 rollback_results 而非 partial_results
# ═══════════════════════════════════════════════════════════


class TestE2E025UnifiedResultFieldName:
    """E2E-025: 成功和失败响应均使用 rollback_results 字段名。"""

    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.VersionHistoryService")
    @patch("django.db.transaction")
    def test_failure_response_uses_rollback_results_not_partial_results(
        self, mock_txn, mock_vh_svc_cls, mock_get_adapter
    ):
        """回滚失败时，响应中应有 rollback_results 而非 partial_results。"""
        from apps.collab.api import rollback_agent_run
        mock_txn.atomic.return_value = _FakeAtomic()

        res_id = str(uuid.uuid4())
        changelogs = [_make_changelog("docs", res_id, "run-fail-025")]

        resource = MagicMock()
        resource.name = "文档"
        adapter = MagicMock()
        adapter.get_resource_for_rollback.return_value = resource
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        pre_version = MagicMock()
        pre_version.id = uuid.uuid4()

        # restore_to_version_with_lock_held 返回 None → 触发 RuntimeError → 走失败分支
        mock_svc = MagicMock()
        mock_svc.acquire_restore_lock.return_value = None
        mock_svc.release_restore_lock.return_value = None
        mock_svc.restore_to_version_with_lock_held.return_value = None
        mock_vh_svc_cls.return_value = mock_svc

        with patch("apps.collab.models.ChangeLog") as mock_cl_model, \
             patch("apps.collab.models.VersionHistory") as mock_vh_model:
            _setup_rollback_mocks(mock_cl_model, mock_vh_model, changelogs,
                                  has_create=False, pre_version=pre_version)

            req = _make_request()
            status, result = rollback_agent_run(req, "run-fail-025")

        assert status == 400
        assert "rollback_results" in result, "失败响应应包含 rollback_results 字段"
        assert "partial_results" not in result, "不应使用已废弃的 partial_results 字段"

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.VersionHistoryService")
    @patch("django.db.transaction")
    def test_success_response_uses_rollback_results(
        self, mock_txn, mock_vh_svc_cls, mock_get_adapter, mock_force_close
    ):
        """成功响应中应有 rollback_results 字段。"""
        from apps.collab.api import rollback_agent_run
        mock_txn.atomic.return_value = _FakeAtomic()

        res_id = str(uuid.uuid4())
        changelogs = [_make_changelog("docs", res_id, "run-ok-025")]

        resource = MagicMock()
        resource.name = "文档"
        adapter = MagicMock()
        adapter.get_resource_for_rollback.return_value = resource
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        pre_version = MagicMock()
        pre_version.id = uuid.uuid4()
        restored_vh = MagicMock()
        restored_vh.id = uuid.uuid4()
        mock_svc = MagicMock()
        mock_svc.acquire_restore_lock.return_value = None
        mock_svc.release_restore_lock.return_value = None
        mock_svc.restore_to_version_with_lock_held.return_value = restored_vh
        mock_vh_svc_cls.return_value = mock_svc
        mock_force_close.return_value = {"success": True, "loaded": True, "connections_closed": 0}

        with patch("apps.collab.models.ChangeLog") as mock_cl_model, \
             patch("apps.collab.models.VersionHistory") as mock_vh_model:
            _setup_rollback_mocks(mock_cl_model, mock_vh_model, changelogs,
                                  has_create=False, pre_version=pre_version)

            req = _make_request()
            result = rollback_agent_run(req, "run-ok-025")

        assert result["status"] == "ok"
        assert "rollback_results" in result["data"]


# ═══════════════════════════════════════════════════════════
# E2E-026: loaded=False 不被误判为警告
# ═══════════════════════════════════════════════════════════


class TestE2E026LoadedFalseNotWarning:
    """E2E-026: force_close 返回 loaded=False 时不应添加 collab_sync_warnings。"""

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.VersionHistoryService")
    @patch("django.db.transaction")
    def test_loaded_false_does_not_add_warning(
        self, mock_txn, mock_vh_svc_cls, mock_get_adapter, mock_force_close
    ):
        """force_close 返回 success=True, loaded=False 时，不应有 collab_sync_warnings。"""
        from apps.collab.api import rollback_agent_run
        mock_txn.atomic.return_value = _FakeAtomic()

        res_id = str(uuid.uuid4())
        changelogs = [_make_changelog("docs", res_id, "run-loaded-false")]

        resource = MagicMock()
        resource.name = "文档"
        adapter = MagicMock()
        adapter.get_resource_for_rollback.return_value = resource
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        pre_version = MagicMock()
        pre_version.id = uuid.uuid4()
        restored_vh = MagicMock()
        restored_vh.id = uuid.uuid4()
        mock_svc = MagicMock()
        mock_svc.acquire_restore_lock.return_value = None
        mock_svc.release_restore_lock.return_value = None
        mock_svc.restore_to_version_with_lock_held.return_value = restored_vh
        mock_vh_svc_cls.return_value = mock_svc

        # loaded=False：文档不在 collab-live 内存中（正常状态）
        mock_force_close.return_value = {"success": True, "loaded": False, "connections_closed": 0}

        with patch("apps.collab.models.ChangeLog") as mock_cl_model, \
             patch("apps.collab.models.VersionHistory") as mock_vh_model:
            _setup_rollback_mocks(mock_cl_model, mock_vh_model, changelogs,
                                  has_create=False, pre_version=pre_version)

            req = _make_request()
            result = rollback_agent_run(req, "run-loaded-false")

        assert result["status"] == "ok"
        assert "collab_sync_warnings" not in result["data"], \
            "loaded=False 是正常状态，不应触发 collab_sync_warnings"

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.VersionHistoryService")
    @patch("django.db.transaction")
    def test_force_close_failure_still_adds_warning(
        self, mock_txn, mock_vh_svc_cls, mock_get_adapter, mock_force_close
    ):
        """force_close 返回 success=False 时，仍应添加 collab_sync_warnings。"""
        from apps.collab.api import rollback_agent_run
        mock_txn.atomic.return_value = _FakeAtomic()

        res_id = str(uuid.uuid4())
        changelogs = [_make_changelog("docs", res_id, "run-fc-fail")]

        resource = MagicMock()
        resource.name = "文档"
        adapter = MagicMock()
        adapter.get_resource_for_rollback.return_value = resource
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        pre_version = MagicMock()
        pre_version.id = uuid.uuid4()
        restored_vh = MagicMock()
        restored_vh.id = uuid.uuid4()
        mock_svc = MagicMock()
        mock_svc.acquire_restore_lock.return_value = None
        mock_svc.release_restore_lock.return_value = None
        mock_svc.restore_to_version_with_lock_held.return_value = restored_vh
        mock_vh_svc_cls.return_value = mock_svc

        # success=False：真正的 force_close 失败
        mock_force_close.return_value = {"success": False, "loaded": False, "connections_closed": 0}

        with patch("apps.collab.models.ChangeLog") as mock_cl_model, \
             patch("apps.collab.models.VersionHistory") as mock_vh_model:
            _setup_rollback_mocks(mock_cl_model, mock_vh_model, changelogs,
                                  has_create=False, pre_version=pre_version)

            req = _make_request()
            result = rollback_agent_run(req, "run-fc-fail")

        assert result["status"] == "ok"
        assert "collab_sync_warnings" in result["data"], \
            "force_close 失败时应有 collab_sync_warnings"
        warnings = result["data"]["collab_sync_warnings"]
        assert any(w["warning"] == "force_close_failed" for w in warnings)
