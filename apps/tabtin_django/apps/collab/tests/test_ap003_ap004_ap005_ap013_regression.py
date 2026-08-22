"""
AP-003 / AP-004 / AP-005 / AP-013 回归测试

AP-003: record_change() 工具函数正确创建 ChangeLog，供 DB-first 路径使用
AP-004: record_change() 支持 canvas 等任意资源类型
AP-005: rollback_agent_run 新建资源（无 pre_change_version）跳过而非 atomic 整体失败
AP-013: rollback_agent_run / get_agent_run_changes 拦截空 agent_run_id
"""
import os
import uuid
from unittest.mock import MagicMock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402

django.setup()

import pytest  # noqa: E402


class _FakeAtomic:
    """用于 mock db_transaction.atomic 的上下文管理器。"""
    def __enter__(self): return self
    def __exit__(self, *a): return False


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


# ═══════════════════════════════════════════════════════════
# AP-013: 空 agent_run_id 校验
# ═══════════════════════════════════════════════════════════


class TestAP013EmptyExecutionRunIdValidation:
    """AP-013: 空字符串 agent_run_id 必须被拦截，返回 400。"""

    def test_rollback_rejects_empty_string(self):
        from apps.collab.api import rollback_agent_run

        req = _make_request()
        status, result = rollback_agent_run(req, "")

        assert status == 400
        assert result["status"] == "error"

    def test_rollback_rejects_whitespace_only(self):
        from apps.collab.api import rollback_agent_run

        req = _make_request()
        status, result = rollback_agent_run(req, "   ")

        assert status == 400
        assert result["status"] == "error"

    def test_get_changes_rejects_empty_string(self):
        from apps.collab.api import get_agent_run_changes

        req = _make_request()
        result = get_agent_run_changes(req, "")

        assert isinstance(result, tuple)
        status, body = result
        assert status == 400
        assert body["status"] == "error"

    def test_get_changes_rejects_whitespace_only(self):
        from apps.collab.api import get_agent_run_changes

        req = _make_request()
        result = get_agent_run_changes(req, "  \t ")

        assert isinstance(result, tuple)
        status, body = result
        assert status == 400

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.VersionHistoryService")
    @patch("django.db.transaction")
    def test_rollback_accepts_valid_agent_run_id(
        self, mock_txn, mock_vh_svc_cls, mock_get_adapter, mock_force_close
    ):
        """非空 agent_run_id 应正常处理（不被拦截）。"""
        from apps.collab.api import rollback_agent_run
        mock_txn.atomic.return_value = _FakeAtomic()

        res_id = str(uuid.uuid4())
        changelogs = [_make_changelog("docs", res_id, "valid-run-123")]

        resource = MagicMock()
        resource.name = "测试文档"
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
            qs = MagicMock()
            qs.__iter__ = MagicMock(return_value=iter(changelogs))

            empty_values_qs = MagicMock()
            empty_values_qs.values_list.return_value = []

            def fake_cl_filter_valid(*args, **kwargs):
                if kwargs.get("version_history__isnull") is False:
                    return empty_values_qs
                return MagicMock(order_by=MagicMock(return_value=qs))

            mock_cl_model.objects.using.return_value.filter.side_effect = fake_cl_filter_valid
            mock_cl_model.objects.using.return_value.filter.return_value.order_by.return_value = qs

            vh_qs = MagicMock()
            vh_qs.filter.return_value.exclude.return_value.order_by.return_value.first.return_value = pre_version
            mock_vh_model.objects.using.return_value = vh_qs

            req = _make_request()
            result = rollback_agent_run(req, "valid-run-123")

        assert result["status"] == "ok"

    @patch("apps.collab.api.get_adapter_or_raise", side_effect=ValueError("virtual resource"))
    def test_rollback_virtual_file_only_returns_all_skipped(self, _mock_get_adapter):
        """仅有 file 虚拟资源时不能误报 resource_not_found。"""
        from apps.collab.api import rollback_agent_run

        agent_run_id = "54fcd8f7-9809-43b7-9941-8540120ef521"
        changelog = _make_changelog(
            "file",
            str(uuid.uuid4()),
            agent_run_id,
        )
        changelog.summary = "notes.md"

        with patch("apps.collab.api._resolve_cascading_run_ids", return_value=[agent_run_id]), \
             patch("apps.collab.models.ChangeLog") as mock_cl_model:
            qs = MagicMock()
            qs.__iter__ = MagicMock(return_value=iter([changelog]))
            mock_cl_model.objects.using.return_value.filter.return_value.order_by.return_value = qs

            result = rollback_agent_run(_make_request(), agent_run_id)

        assert result["status"] == "ok"
        assert result["data"]["all_skipped"] is True
        assert result["data"]["rollback_results"] == [{
            "resource_type": "file",
            "resource_id": str(changelog.resource_id),
            "resource_name": "notes.md",
            "status": "skipped",
            "reason": "unsupported_resource_type",
        }]

    def test_rollback_virtual_and_inaccessible_real_resource_keeps_generic_404(self):
        """虚拟资源不能掩盖真实资源不存在/无权限，避免改变原安全语义。"""
        from apps.collab.api import rollback_agent_run

        agent_run_id = "715f6597-c806-4a2c-ad5d-8af8b299a360"
        file_change = _make_changelog("file", str(uuid.uuid4()), agent_run_id)
        doc_change = _make_changelog("docs", str(uuid.uuid4()), agent_run_id)
        adapter = MagicMock()
        adapter.get_resource_for_rollback.return_value = None

        with patch("apps.collab.api._resolve_cascading_run_ids", return_value=[agent_run_id]), \
             patch("apps.collab.api.get_adapter_or_raise", side_effect=[ValueError("virtual"), adapter]), \
             patch("apps.collab.models.ChangeLog") as mock_cl_model:
            qs = MagicMock()
            qs.__iter__ = MagicMock(return_value=iter([file_change, doc_change]))
            mock_cl_model.objects.using.return_value.filter.return_value.order_by.return_value = qs

            status_code, body = rollback_agent_run(_make_request(), agent_run_id)

        assert status_code == 404
        assert body["status"] == "error"


# ═══════════════════════════════════════════════════════════
# AP-005: 新建资源跳过而非整体失败
# ═══════════════════════════════════════════════════════════


class TestAP005SkipNewResourcesInRollback:
    """AP-005: pre_change_version 为 None 时应跳过资源，不中断整批回滚。"""

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.VersionHistoryService")
    @patch("django.db.transaction")
    def test_new_resource_skipped_others_restored(
        self, mock_txn, mock_vh_svc_cls, mock_get_adapter, mock_force_close
    ):
        """一个资源无 pre_change_version（新建），另一个有 → 新建的跳过，旧的恢复成功。"""
        from apps.collab.api import rollback_agent_run
        mock_txn.atomic.return_value = _FakeAtomic()

        res_existing = str(uuid.uuid4())
        res_new = str(uuid.uuid4())
        changelogs = [
            _make_changelog("docs", res_existing, "run-mixed"),
            _make_changelog("table", res_new, "run-mixed"),
        ]

        resource_existing = MagicMock()
        resource_existing.name = "已有文档"
        resource_new = MagicMock()
        resource_new.name = "新建表格"

        def fake_get_resource_for_rollback(res_id):
            if res_id == res_existing:
                return resource_existing
            return resource_new

        adapter = MagicMock()
        adapter.get_resource_for_rollback.side_effect = fake_get_resource_for_rollback
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        pre_version = MagicMock()
        pre_version.id = uuid.uuid4()

        restored_vh = MagicMock()
        restored_vh.id = uuid.uuid4()
        mock_svc = MagicMock()
        mock_svc.restore_to_version_with_lock_held.return_value = restored_vh
        mock_svc.acquire_restore_lock.return_value = None
        mock_vh_svc_cls.return_value = mock_svc

        mock_force_close.return_value = {"success": True, "loaded": True, "connections_closed": 0}

        with patch("apps.collab.models.ChangeLog") as mock_cl_model, \
             patch("apps.collab.models.VersionHistory") as mock_vh_model:
            qs = MagicMock()
            qs.__iter__ = MagicMock(return_value=iter(changelogs))

            # ChangeLog 查询：
            # - version_history__isnull=False（run_vh_ids）→ 返回空列表
            # - change_type=create → 返回 False（res_new 无 create 记录）
            # - version_history__isnull=True（has_vh_missing）→ 返回 False
            false_exists_qs = MagicMock()
            false_exists_qs.exists.return_value = False
            empty_values_qs = MagicMock()
            empty_values_qs.values_list.return_value = []

            def fake_cl_filter(*args, **kwargs):
                if kwargs.get("version_history__isnull") is False:
                    return empty_values_qs
                if kwargs.get("change_type") == "create":
                    return false_exists_qs
                if kwargs.get("version_history__isnull") is True:
                    return false_exists_qs
                return MagicMock(order_by=MagicMock(return_value=qs))

            mock_cl_model.objects.using.return_value.filter.side_effect = fake_cl_filter
            mock_cl_model.objects.using.return_value.filter.return_value.order_by.return_value = qs

            # VersionHistory 查询：res_existing 有 pre_change_version，res_new 没有
            call_count = [0]

            def fake_vh_filter(*args, **kwargs):
                mock_chain = MagicMock()
                call_count[0] += 1
                if call_count[0] <= 1:
                    # res_existing：filter().exclude().order_by().first() = pre_version
                    exclude_chain = MagicMock()
                    exclude_chain.order_by.return_value.first.return_value = pre_version
                    mock_chain.exclude.return_value = exclude_chain
                else:
                    # res_new：filter().exclude().order_by().first() = None
                    exclude_chain = MagicMock()
                    exclude_chain.order_by.return_value.first.return_value = None
                    mock_chain.exclude.return_value = exclude_chain
                return mock_chain

            vh_qs = MagicMock()
            vh_qs.filter.side_effect = fake_vh_filter
            mock_vh_model.objects.using.return_value = vh_qs

            req = _make_request()
            result = rollback_agent_run(req, "run-mixed")

        assert result["status"] == "ok", "应返回 200 而非 400"
        rollback_results = result["data"]["rollback_results"]
        assert len(rollback_results) == 2

        restored_items = [r for r in rollback_results if r.get("status") == "restored"]
        skipped_items = [r for r in rollback_results if r.get("status") == "skipped"]
        assert len(restored_items) == 1, "有 pre_change_version 的资源应被恢复"
        assert len(skipped_items) == 1, "无 pre_change_version 且无 create 记录的资源应被跳过"
        assert skipped_items[0]["reason"] == "no_pre_version"

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.VersionHistoryService")
    @patch("django.db.transaction")
    def test_all_resources_new_returns_ok_with_all_skipped(
        self, mock_txn, mock_vh_svc_cls, mock_get_adapter, mock_force_close
    ):
        """所有资源都是新建（无 pre_change_version）时，返回 200 全部跳过。"""
        from apps.collab.api import rollback_agent_run
        mock_txn.atomic.return_value = _FakeAtomic()

        res_a = str(uuid.uuid4())
        changelogs = [_make_changelog("docs", res_a, "run-all-new")]

        adapter = MagicMock()
        adapter.get_resource_for_rollback.return_value = MagicMock()
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        with patch("apps.collab.models.ChangeLog") as mock_cl_model, \
             patch("apps.collab.models.VersionHistory") as mock_vh_model:
            qs = MagicMock()
            qs.__iter__ = MagicMock(return_value=iter(changelogs))

            false_exists_qs = MagicMock()
            false_exists_qs.exists.return_value = False
            empty_values_qs = MagicMock()
            empty_values_qs.values_list.return_value = []

            def fake_cl_filter_all_new(*args, **kwargs):
                if kwargs.get("version_history__isnull") is False:
                    return empty_values_qs
                if kwargs.get("change_type") == "create":
                    return false_exists_qs
                if kwargs.get("version_history__isnull") is True:
                    return false_exists_qs
                return MagicMock(order_by=MagicMock(return_value=qs))

            mock_cl_model.objects.using.return_value.filter.side_effect = fake_cl_filter_all_new
            mock_cl_model.objects.using.return_value.filter.return_value.order_by.return_value = qs

            # VersionHistory 查询：filter().exclude().order_by().first() = None
            exclude_chain = MagicMock()
            exclude_chain.order_by.return_value.first.return_value = None
            vh_qs = MagicMock()
            vh_qs.filter.return_value.exclude.return_value = exclude_chain
            mock_vh_model.objects.using.return_value = vh_qs

            req = _make_request()
            result = rollback_agent_run(req, "run-all-new")

        assert result["status"] == "ok"
        rollback_results = result["data"]["rollback_results"]
        assert len(rollback_results) == 1
        assert rollback_results[0]["status"] == "skipped"
        assert rollback_results[0]["reason"] == "no_pre_version"
        mock_force_close.assert_not_called()

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.VersionHistoryService")
    @patch("django.db.transaction")
    def test_skipped_resource_not_force_closed(
        self, mock_txn, mock_vh_svc_cls, mock_get_adapter, mock_force_close
    ):
        """跳过的资源不应触发 force_close_collab_document。"""
        from apps.collab.api import rollback_agent_run
        mock_txn.atomic.return_value = _FakeAtomic()

        res_existing = str(uuid.uuid4())
        res_new = str(uuid.uuid4())
        changelogs = [
            _make_changelog("docs", res_existing, "run-fc-test"),
            _make_changelog("table", res_new, "run-fc-test"),
        ]

        resource_existing = MagicMock()
        resource_existing.name = "已有文档"
        resource_new = MagicMock()
        resource_new.name = "新建表格"

        def fake_get_resource_fc(res_id):
            if res_id == res_existing:
                return resource_existing
            return resource_new

        adapter = MagicMock()
        adapter.get_resource_for_rollback.side_effect = fake_get_resource_fc
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        pre_version = MagicMock()
        pre_version.id = uuid.uuid4()

        restored_vh = MagicMock()
        restored_vh.id = uuid.uuid4()
        mock_svc = MagicMock()
        mock_svc.restore_to_version_with_lock_held.return_value = restored_vh
        mock_svc.acquire_restore_lock.return_value = None
        mock_vh_svc_cls.return_value = mock_svc

        mock_force_close.return_value = {"success": True, "loaded": True, "connections_closed": 0}

        with patch("apps.collab.models.ChangeLog") as mock_cl_model, \
             patch("apps.collab.models.VersionHistory") as mock_vh_model:
            qs = MagicMock()
            qs.__iter__ = MagicMock(return_value=iter(changelogs))

            false_exists_qs = MagicMock()
            false_exists_qs.exists.return_value = False
            empty_values_qs = MagicMock()
            empty_values_qs.values_list.return_value = []

            def fake_cl_filter_fc(*args, **kwargs):
                if kwargs.get("version_history__isnull") is False:
                    return empty_values_qs
                if kwargs.get("change_type") == "create":
                    return false_exists_qs
                if kwargs.get("version_history__isnull") is True:
                    return false_exists_qs
                return MagicMock(order_by=MagicMock(return_value=qs))

            mock_cl_model.objects.using.return_value.filter.side_effect = fake_cl_filter_fc
            mock_cl_model.objects.using.return_value.filter.return_value.order_by.return_value = qs

            call_count = [0]

            def fake_vh_filter_fc(*args, **kwargs):
                mock_chain = MagicMock()
                call_count[0] += 1
                if call_count[0] <= 1:
                    exclude_chain = MagicMock()
                    exclude_chain.order_by.return_value.first.return_value = pre_version
                    mock_chain.exclude.return_value = exclude_chain
                else:
                    exclude_chain = MagicMock()
                    exclude_chain.order_by.return_value.first.return_value = None
                    mock_chain.exclude.return_value = exclude_chain
                return mock_chain

            vh_qs = MagicMock()
            vh_qs.filter.side_effect = fake_vh_filter_fc
            mock_vh_model.objects.using.return_value = vh_qs

            req = _make_request()
            rollback_agent_run(req, "run-fc-test")

        assert mock_force_close.call_count == 1, "只有 restored 的资源才触发 force_close"


# ═══════════════════════════════════════════════════════════
# AP-003 / AP-004: record_change() 工具函数
# ═══════════════════════════════════════════════════════════


class TestAP003AP004RecordChange:
    """AP-003/AP-004: record_change() 正确创建 ChangeLog 条目。"""

    @patch("apps.collab.models.ChangeLog")
    def test_record_change_creates_changelog_with_explicit_run_id(self, mock_cl_model):
        """提供 agent_run_id 时直接使用，不尝试从 ContextVar 获取。"""
        from apps.collab.api import record_change

        mock_create = MagicMock()
        mock_cl_model.objects.using.return_value.create = mock_create

        res_id = uuid.uuid4()
        record_change(
            resource_type="docs",
            resource_id=res_id,
            change_type="update",
            agent_run_id="run-abc-123",
            editor_type="agent",
            editor_id="agent-1",
            summary="Agent saved document",
        )

        mock_create.assert_called_once()
        call_kwargs = mock_create.call_args[1]
        assert call_kwargs["resource_type"] == "docs"
        assert call_kwargs["resource_id"] == res_id
        assert call_kwargs["agent_run_id"] == "run-abc-123"
        assert call_kwargs["change_type"] == "update"
        assert call_kwargs["editor_type"] == "agent"

    @patch("apps.services.common.platform_context.get_current_run_id", return_value="ctx-run-456")
    @patch("apps.collab.models.ChangeLog")
    def test_record_change_fallback_to_context_run_id(
        self, mock_cl_model, mock_get_run_id
    ):
        """未提供 agent_run_id 时，从 ContextVar 获取。"""
        from apps.collab.api import record_change

        mock_create = MagicMock()
        mock_cl_model.objects.using.return_value.create = mock_create

        record_change(
            resource_type="docs",
            resource_id=uuid.uuid4(),
            change_type="update",
        )

        call_kwargs = mock_create.call_args[1]
        assert call_kwargs["agent_run_id"] == "ctx-run-456"

    @patch("apps.collab.models.ChangeLog")
    def test_record_change_with_version_history(self, mock_cl_model):
        """可选关联 VersionHistory FK。"""
        from apps.collab.api import record_change

        mock_create = MagicMock()
        mock_cl_model.objects.using.return_value.create = mock_create

        fake_vh = MagicMock()
        fake_vh.id = uuid.uuid4()

        record_change(
            resource_type="docs",
            resource_id=uuid.uuid4(),
            agent_run_id="run-with-vh",
            version_history=fake_vh,
        )

        call_kwargs = mock_create.call_args[1]
        assert call_kwargs["version_history"] is fake_vh

    @patch("apps.collab.models.ChangeLog")
    def test_record_change_defaults(self, mock_cl_model):
        """默认值：change_type=update, editor_type=agent, changes={}。"""
        from apps.collab.api import record_change

        mock_create = MagicMock()
        mock_cl_model.objects.using.return_value.create = mock_create

        record_change(
            resource_type="table",
            resource_id=uuid.uuid4(),
            agent_run_id="run-defaults",
        )

        call_kwargs = mock_create.call_args[1]
        assert call_kwargs["change_type"] == "update"
        assert call_kwargs["editor_type"] == "agent"
        assert call_kwargs["changes"] == {}
        assert call_kwargs["summary"] == ""

    @patch("apps.services.common.platform_context.get_current_run_id", side_effect=RuntimeError("ContextVar corrupted"))
    @patch("apps.collab.models.ChangeLog")
    def test_record_change_survives_contextvar_runtime_error(
        self, mock_cl_model, mock_get_run_id
    ):
        """ContextVar 查找抛出非 ImportError 时，record_change 不应崩溃，agent_run_id 回退为空。"""
        from apps.collab.api import record_change

        mock_create = MagicMock()
        mock_cl_model.objects.using.return_value.create = mock_create

        record_change(
            resource_type="docs",
            resource_id=uuid.uuid4(),
            change_type="update",
        )

        mock_create.assert_called_once()
        call_kwargs = mock_create.call_args[1]
        assert call_kwargs["agent_run_id"] == "", "ContextVar 查找失败时 agent_run_id 应为空字符串"

    @patch("apps.collab.models.ChangeLog")
    def test_record_change_accepts_string_resource_id(self, mock_cl_model):
        """resource_id 可以是字符串（UUID 格式），Django UUIDField 自动转换。"""
        from apps.collab.api import record_change

        mock_create = MagicMock()
        mock_cl_model.objects.using.return_value.create = mock_create

        str_id = str(uuid.uuid4())
        record_change(
            resource_type="table",
            resource_id=str_id,
            agent_run_id="run-str-id",
        )

        call_kwargs = mock_create.call_args[1]
        assert call_kwargs["resource_id"] == str_id


# ═══════════════════════════════════════════════════════════
# AP-013 扩展：rollback 有效 run_id 但无匹配 ChangeLog
# ═══════════════════════════════════════════════════════════


class TestAP013NoMatchingChangeLogs:
    """有效 agent_run_id 但无匹配 ChangeLog 记录时应返回 200 + all_skipped。"""

    def test_rollback_no_changelogs_returns_all_skipped(self):
        from apps.collab.api import rollback_agent_run

        with patch("apps.collab.models.ChangeLog") as mock_cl_model:
            qs = MagicMock()
            qs.__iter__ = MagicMock(return_value=iter([]))
            mock_cl_model.objects.using.return_value.filter.return_value.order_by.return_value = qs

            req = _make_request()
            result = rollback_agent_run(req, "run-that-does-not-exist")

        assert result["status"] == "ok"
        assert result["data"]["all_skipped"] is True
        assert result["data"]["rollback_results"] == []


# ═══════════════════════════════════════════════════════════
# AP-005 扩展：非新建资源恢复失败应中断整批回滚
# ═══════════════════════════════════════════════════════════


class TestAP005RestoreFailureAbortsTransaction:
    """非新建资源恢复失败（restore_to_version 返回 None）应触发 RuntimeError 回滚整批。"""

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.VersionHistoryService")
    @patch("django.db.transaction")
    def test_restore_failure_returns_400_with_detail(
        self, mock_txn, mock_vh_svc_cls, mock_get_adapter, mock_force_close
    ):
        from apps.collab.api import rollback_agent_run
        mock_txn.atomic.return_value = _FakeAtomic()

        res_id = str(uuid.uuid4())
        changelogs = [_make_changelog("docs", res_id, "run-fail")]

        resource = MagicMock()
        resource.name = "测试文档"
        adapter = MagicMock()
        adapter.get_resource_for_rollback.return_value = resource
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        pre_version = MagicMock()
        pre_version.id = uuid.uuid4()

        mock_svc = MagicMock()
        mock_svc.restore_to_version_with_lock_held.return_value = None
        mock_svc.acquire_restore_lock.return_value = None
        mock_vh_svc_cls.return_value = mock_svc

        with patch("apps.collab.models.ChangeLog") as mock_cl_model, \
             patch("apps.collab.models.VersionHistory") as mock_vh_model:
            qs = MagicMock()
            qs.__iter__ = MagicMock(return_value=iter(changelogs))

            empty_values_qs = MagicMock()
            empty_values_qs.values_list.return_value = []

            def fake_cl_filter_fail(*args, **kwargs):
                if kwargs.get("version_history__isnull") is False:
                    return empty_values_qs
                return MagicMock(order_by=MagicMock(return_value=qs))

            mock_cl_model.objects.using.return_value.filter.side_effect = fake_cl_filter_fail
            mock_cl_model.objects.using.return_value.filter.return_value.order_by.return_value = qs

            exclude_chain = MagicMock()
            exclude_chain.order_by.return_value.first.return_value = pre_version
            vh_qs = MagicMock()
            vh_qs.filter.return_value.exclude.return_value = exclude_chain
            mock_vh_model.objects.using.return_value = vh_qs

            req = _make_request()
            status, result = rollback_agent_run(req, "run-fail")

        assert status == 400, "恢复失败应返回 400"
        assert result["status"] == "error"
        assert "detail" in result, "AP-014: 错误响应应包含 detail 字段"
        assert "rollback_results" in result, "E2E-025: 错误响应应包含 rollback_results 字段（统一字段名）"


# ═══════════════════════════════════════════════════════════
# FAR-008: skip reason 区分 — 新建资源 vs VH 写入失败
# E2E-035: skip/trashed/restored 响应包含 resource_name 字段
# ═══════════════════════════════════════════════════════════


def _make_changelog_with_change_type(resource_type, resource_id, agent_run_id, change_type="update"):
    from django.utils import timezone

    cl = MagicMock()
    cl.resource_type = resource_type
    cl.resource_id = uuid.UUID(resource_id) if isinstance(resource_id, str) else resource_id
    cl.agent_run_id = agent_run_id
    cl.change_type = change_type
    cl.created_at = timezone.now()
    return cl


class TestFAR008SkipReasonDistinction:
    """FAR-008: rollback_agent_run 对两种 skip 场景应返回不同的 reason。"""

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api._trash_resource_in_rollback")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.VersionHistoryService")
    @patch("django.db.transaction")
    def test_has_create_changelog_returns_new_resource_trashed(
        self, mock_txn, mock_vh_svc_cls, mock_get_adapter, mock_trash, mock_force_close
    ):
        """有 change_type=create 的 ChangeLog 时，资源应被移入回收站，reason=new_resource_trashed。"""
        from apps.collab.api import rollback_agent_run
        mock_txn.atomic.return_value = _FakeAtomic()

        res_id = str(uuid.uuid4())
        changelogs = [_make_changelog_with_change_type("slide", res_id, "run-create", "create")]

        resource = MagicMock()
        resource.name = "我的演示文稿"
        adapter = MagicMock()
        adapter.get_resource_for_rollback.return_value = resource
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter
        mock_trash.return_value = True
        mock_force_close.return_value = {"success": True, "loaded": True, "connections_closed": 0}

        with patch("apps.collab.models.ChangeLog") as mock_cl_model, \
             patch("apps.collab.models.VersionHistory") as mock_vh_model:
            qs = MagicMock()
            qs.__iter__ = MagicMock(return_value=iter(changelogs))

            empty_values_qs = MagicMock()
            empty_values_qs.values_list.return_value = []
            create_qs = MagicMock()
            create_qs.exists.return_value = True

            def fake_cl_filter_create(*args, **kwargs):
                if kwargs.get("version_history__isnull") is False:
                    return empty_values_qs
                if kwargs.get("change_type") == "create":
                    return create_qs
                return MagicMock(order_by=MagicMock(return_value=qs))

            mock_cl_model.objects.using.return_value.filter.side_effect = fake_cl_filter_create
            mock_cl_model.objects.using.return_value.filter.return_value.order_by.return_value = qs

            exclude_chain = MagicMock()
            exclude_chain.order_by.return_value.first.return_value = None
            vh_qs = MagicMock()
            vh_qs.filter.return_value.exclude.return_value = exclude_chain
            mock_vh_model.objects.using.return_value = vh_qs

            req = _make_request()
            result = rollback_agent_run(req, "run-create")

        assert result["status"] == "ok"
        items = result["data"]["rollback_results"]
        assert len(items) == 1
        assert items[0]["status"] == "trashed"
        assert items[0]["reason"] == "new_resource_trashed"

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.VersionHistoryService")
    @patch("django.db.transaction")
    def test_no_create_changelog_with_vh_missing_returns_no_version_history(
        self, mock_txn, mock_vh_svc_cls, mock_get_adapter, mock_force_close
    ):
        """无 create ChangeLog 但有 version_history=None 的 ChangeLog 时，reason=no_version_history。"""
        from apps.collab.api import rollback_agent_run
        mock_txn.atomic.return_value = _FakeAtomic()

        res_id = str(uuid.uuid4())
        changelogs = [_make_changelog_with_change_type("table", res_id, "run-redis-fail", "update")]

        resource = MagicMock()
        resource.name = "数据表"
        adapter = MagicMock()
        adapter.get_resource_for_rollback.return_value = resource
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        with patch("apps.collab.models.ChangeLog") as mock_cl_model, \
             patch("apps.collab.models.VersionHistory") as mock_vh_model:
            qs = MagicMock()
            qs.__iter__ = MagicMock(return_value=iter(changelogs))

            empty_values_qs = MagicMock()
            empty_values_qs.values_list.return_value = []
            create_qs = MagicMock()
            create_qs.exists.return_value = False
            vh_missing_qs = MagicMock()
            vh_missing_qs.exists.return_value = True

            def fake_cl_filter_redis(*args, **kwargs):
                if kwargs.get("version_history__isnull") is False:
                    return empty_values_qs
                if kwargs.get("change_type") == "create":
                    return create_qs
                if kwargs.get("version_history__isnull") is True:
                    return vh_missing_qs
                return MagicMock(order_by=MagicMock(return_value=qs))

            mock_cl_model.objects.using.return_value.filter.side_effect = fake_cl_filter_redis
            mock_cl_model.objects.using.return_value.filter.return_value.order_by.return_value = qs

            exclude_chain = MagicMock()
            exclude_chain.order_by.return_value.first.return_value = None
            vh_qs = MagicMock()
            vh_qs.filter.return_value.exclude.return_value = exclude_chain
            mock_vh_model.objects.using.return_value = vh_qs

            req = _make_request()
            result = rollback_agent_run(req, "run-redis-fail")

        assert result["status"] == "ok"
        items = result["data"]["rollback_results"]
        assert len(items) == 1
        # FAR-008: reason 应为 no_version_history，不是 new_resource
        assert items[0]["status"] == "skipped"
        assert items[0]["reason"] == "no_version_history", (
            "FAR-008: Redis 故障导致 VH 缺失时，reason 应为 no_version_history 而非 new_resource"
        )
        assert "detail" in items[0], "no_version_history 场景应包含 detail 字段"

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.VersionHistoryService")
    @patch("django.db.transaction")
    def test_no_create_no_vh_missing_returns_no_pre_version(
        self, mock_txn, mock_vh_svc_cls, mock_get_adapter, mock_force_close
    ):
        """无 create ChangeLog 且无 version_history=None 的 ChangeLog 时，reason=no_pre_version。"""
        from apps.collab.api import rollback_agent_run
        mock_txn.atomic.return_value = _FakeAtomic()

        res_id = str(uuid.uuid4())
        changelogs = [_make_changelog_with_change_type("docs", res_id, "run-unknown", "update")]

        resource = MagicMock()
        resource.name = "未知文档"
        adapter = MagicMock()
        adapter.get_resource_for_rollback.return_value = resource
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        with patch("apps.collab.models.ChangeLog") as mock_cl_model, \
             patch("apps.collab.models.VersionHistory") as mock_vh_model:
            qs = MagicMock()
            qs.__iter__ = MagicMock(return_value=iter(changelogs))

            empty_values_qs = MagicMock()
            empty_values_qs.values_list.return_value = []
            create_qs = MagicMock()
            create_qs.exists.return_value = False
            vh_missing_qs = MagicMock()
            vh_missing_qs.exists.return_value = False

            def fake_cl_filter_unknown(*args, **kwargs):
                if kwargs.get("version_history__isnull") is False:
                    return empty_values_qs
                if kwargs.get("change_type") == "create":
                    return create_qs
                if kwargs.get("version_history__isnull") is True:
                    return vh_missing_qs
                return MagicMock(order_by=MagicMock(return_value=qs))

            mock_cl_model.objects.using.return_value.filter.side_effect = fake_cl_filter_unknown
            mock_cl_model.objects.using.return_value.filter.return_value.order_by.return_value = qs

            exclude_chain = MagicMock()
            exclude_chain.order_by.return_value.first.return_value = None
            vh_qs = MagicMock()
            vh_qs.filter.return_value.exclude.return_value = exclude_chain
            mock_vh_model.objects.using.return_value = vh_qs

            req = _make_request()
            result = rollback_agent_run(req, "run-unknown")

        assert result["status"] == "ok"
        items = result["data"]["rollback_results"]
        assert items[0]["status"] == "skipped"
        assert items[0]["reason"] == "no_pre_version"


class TestE2E035ResourceNameInRollbackResponse:
    """E2E-035: rollback_agent_run 的所有结果条目应包含 resource_name 字段。"""

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api.VersionHistoryService")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("django.db.transaction")
    def test_restored_result_includes_resource_name(
        self, mock_txn, mock_get_adapter, mock_vh_svc_cls, mock_force_close
    ):
        """成功恢复的资源结果中应包含 resource_name。"""
        from apps.collab.api import rollback_agent_run
        mock_txn.atomic.return_value = _FakeAtomic()

        res_id = str(uuid.uuid4())
        changelogs = [_make_changelog_with_change_type("slide", res_id, "run-name-test")]

        resource = MagicMock()
        resource.name = "季度汇报"
        resource.title = None
        adapter = MagicMock()
        adapter.get_resource_for_rollback.return_value = resource
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        pre_version = MagicMock()
        pre_version.id = uuid.uuid4()
        restored_vh = MagicMock()
        restored_vh.id = uuid.uuid4()
        mock_svc = MagicMock()
        mock_svc.restore_to_version_with_lock_held.return_value = restored_vh
        mock_svc.acquire_restore_lock.return_value = None
        mock_vh_svc_cls.return_value = mock_svc
        mock_force_close.return_value = {"success": True, "loaded": True, "connections_closed": 0}

        with patch("apps.collab.models.ChangeLog") as mock_cl_model, \
             patch("apps.collab.models.VersionHistory") as mock_vh_model:
            qs = MagicMock()
            qs.__iter__ = MagicMock(return_value=iter(changelogs))

            empty_values_qs = MagicMock()
            empty_values_qs.values_list.return_value = []

            def fake_cl_filter_name(*args, **kwargs):
                if kwargs.get("version_history__isnull") is False:
                    return empty_values_qs
                return MagicMock(order_by=MagicMock(return_value=qs))

            mock_cl_model.objects.using.return_value.filter.side_effect = fake_cl_filter_name
            mock_cl_model.objects.using.return_value.filter.return_value.order_by.return_value = qs

            exclude_chain = MagicMock()
            exclude_chain.order_by.return_value.first.return_value = pre_version
            vh_qs = MagicMock()
            vh_qs.filter.return_value.exclude.return_value = exclude_chain
            mock_vh_model.objects.using.return_value = vh_qs

            req = _make_request()
            result = rollback_agent_run(req, "run-name-test")

        assert result["status"] == "ok"
        items = result["data"]["rollback_results"]
        assert len(items) == 1
        assert items[0]["status"] == "restored"
        assert items[0]["resource_name"] == "季度汇报", (
            "E2E-035: restored 结果应包含 resource_name"
        )

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.VersionHistoryService")
    @patch("django.db.transaction")
    def test_skipped_result_includes_resource_name_from_title(
        self, mock_txn, mock_vh_svc_cls, mock_get_adapter, mock_force_close
    ):
        """使用 title 属性的资源（如 Document）的 resource_name 应从 title 获取。"""
        from apps.collab.api import rollback_agent_run
        mock_txn.atomic.return_value = _FakeAtomic()

        res_id = str(uuid.uuid4())
        changelogs = [_make_changelog_with_change_type("docs", res_id, "run-title-test")]

        resource = MagicMock()
        resource.name = None
        resource.title = "项目需求文档"
        adapter = MagicMock()
        adapter.get_resource_for_rollback.return_value = resource
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        with patch("apps.collab.models.ChangeLog") as mock_cl_model, \
             patch("apps.collab.models.VersionHistory") as mock_vh_model:
            qs = MagicMock()
            qs.__iter__ = MagicMock(return_value=iter(changelogs))

            empty_values_qs = MagicMock()
            empty_values_qs.values_list.return_value = []
            create_qs = MagicMock()
            create_qs.exists.return_value = False
            vh_missing_qs = MagicMock()
            vh_missing_qs.exists.return_value = False

            def fake_cl_filter_title(*args, **kwargs):
                if kwargs.get("version_history__isnull") is False:
                    return empty_values_qs
                if kwargs.get("change_type") == "create":
                    return create_qs
                if kwargs.get("version_history__isnull") is True:
                    return vh_missing_qs
                return MagicMock(order_by=MagicMock(return_value=qs))

            mock_cl_model.objects.using.return_value.filter.side_effect = fake_cl_filter_title
            mock_cl_model.objects.using.return_value.filter.return_value.order_by.return_value = qs

            exclude_chain = MagicMock()
            exclude_chain.order_by.return_value.first.return_value = None
            vh_qs = MagicMock()
            vh_qs.filter.return_value.exclude.return_value = exclude_chain
            mock_vh_model.objects.using.return_value = vh_qs

            req = _make_request()
            result = rollback_agent_run(req, "run-title-test")

        assert result["status"] == "ok"
        items = result["data"]["rollback_results"]
        assert items[0]["resource_name"] == "项目需求文档", (
            "E2E-035: Document 资源应从 title 字段获取 resource_name"
        )
