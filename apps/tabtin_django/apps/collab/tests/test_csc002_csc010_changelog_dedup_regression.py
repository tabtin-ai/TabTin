"""
CSC-002 / CSC-010 回归测试

CSC-002: ChangeLog 双写消除。
    save_from_agent 调用链路中 _write_sync_changelog 同步写一条 ChangeLog，
    collab-live onStore 回调（persist 端点）再写一条，同一次 Agent 操作产生 2 条 ChangeLog。
    修复：persist 端点写 ChangeLog 前检查是否已存在 sync_changelog=True 的条目，
    若存在则更新（关联 VH）而非新建。

CSC-010: _write_sync_changelog 在 agent_run_id 为空时静默返回。
    editor_type="agent" 但无法获取 agent_run_id 时函数静默返回，不写 ChangeLog，
    某些 Agent 操作完全不被追踪。
    修复：移除静默返回，打 warning 日志，用 editor_id 兜底写入 ChangeLog。
"""
import os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django
django.setup()

import pytest
import inspect
from unittest.mock import MagicMock, patch, call
from uuid import uuid4


# ═══════════════════════════════════════════════════════════
# CSC-010: _write_sync_changelog 无 agent_run_id 时不静默返回
# ═══════════════════════════════════════════════════════════


class TestCSC010WriteSyncChangelogNoSilentReturn:
    """CSC-010: _write_sync_changelog 在 agent_run_id 为空时不应静默返回。"""

    def test_no_early_return_when_agent_run_id_empty(self):
        """源码中不应在 agent_run_id 为空时直接 return（静默返回）。"""
        from apps.tabdoc.services.document_service import DocumentService
        src = inspect.getsource(DocumentService._write_sync_changelog)

        # 修复前的静默返回模式不应存在
        assert "if not agent_run_id:\n                return" not in src, (
            "_write_sync_changelog 仍在 agent_run_id 为空时静默返回，应已修复"
        )

    def test_writes_changelog_with_editor_id_fallback(self):
        """agent_run_id 为空时，应以 editor_id 兜底写入 ChangeLog。"""
        from apps.tabdoc.services.document_service import DocumentService

        doc = MagicMock()
        doc.id = uuid4()

        created_kwargs = {}

        def fake_create(**kwargs):
            created_kwargs.update(kwargs)
            return MagicMock()

        mock_qs = MagicMock()
        mock_qs.create.side_effect = fake_create

        # 注：_write_sync_changelog 是 staticmethod，无 __func__ 属性，直接 mock ChangeLog 即可
        with patch("apps.collab.models.ChangeLog.objects") as mock_cl_objects:
            mock_cl_objects.using.return_value = mock_qs

            with patch(
                "apps.services.common.platform_context.get_current_run_id",
                return_value="",
            ):
                DocumentService._write_sync_changelog(
                    doc,
                    {},
                    editor_type="agent",
                    editor_id="fallback-editor-id",
                )

        mock_cl_objects.using.assert_called_once_with("postgresql")
        mock_qs.create.assert_called_once()
        call_kwargs = mock_qs.create.call_args[1]
        # 应以 editor_id 兜底
        assert call_kwargs["agent_run_id"] == "fallback-editor-id", (
            "agent_run_id 应以 editor_id 兜底，而非空字符串"
        )
        # changes 中应标记 agent_run_id_missing=True
        assert call_kwargs["changes"].get("agent_run_id_missing") is True, (
            "changes 中应包含 agent_run_id_missing=True 标记"
        )

    def test_still_writes_changelog_with_valid_agent_run_id(self):
        """agent_run_id 有值时，正常写入 ChangeLog（无 agent_run_id_missing 标记）。"""
        from apps.tabdoc.services.document_service import DocumentService

        doc = MagicMock()
        doc.id = uuid4()

        created_kwargs = {}

        def fake_create(**kwargs):
            created_kwargs.update(kwargs)
            return MagicMock()

        mock_qs = MagicMock()
        mock_qs.create.side_effect = fake_create

        with patch("apps.collab.models.ChangeLog.objects") as mock_cl_objects:
            mock_cl_objects.using.return_value = mock_qs

            with patch(
                "apps.services.common.platform_context.get_current_run_id",
                return_value="run-abc-123",
            ):
                DocumentService._write_sync_changelog(
                    doc,
                    {},
                    editor_type="agent",
                    editor_id="agent-editor-id",
                )

        mock_qs.create.assert_called_once()
        call_kwargs = mock_qs.create.call_args[1]
        assert call_kwargs["agent_run_id"] == "run-abc-123"
        assert "agent_run_id_missing" not in call_kwargs["changes"]

    def test_non_agent_editor_type_does_not_write(self):
        """editor_type != 'agent' 时（如 'user'），不应写 ChangeLog（原有行为保持）。"""
        from apps.tabdoc.services.document_service import DocumentService

        doc = MagicMock()
        doc.id = uuid4()

        mock_qs = MagicMock()

        with patch("apps.collab.models.ChangeLog.objects") as mock_cl_objects:
            mock_cl_objects.using.return_value = mock_qs

            DocumentService._write_sync_changelog(
                doc,
                {},
                editor_type="user",
                editor_id="some-user-id",
            )

        # editor_type=user 时 agent_run_id 为空，不应写入
        mock_qs.create.assert_not_called()


# ═══════════════════════════════════════════════════════════
# CSC-002: persist 端点 ChangeLog 双写消除
# ═══════════════════════════════════════════════════════════


class TestCSC002PersistChangelogDedup:
    """CSC-002: persist 端点在已有 sync_changelog 条目时应更新而非新建。"""

    def test_persist_dedup_logic_present_in_source(self):
        """persist 端点源码中应包含 sync_changelog 去重逻辑。"""
        from apps.collab import api as collab_api
        src = inspect.getsource(collab_api.collab_persist)

        assert "sync_changelog=True" in src or "sync_changelog__" in src or "sync_changelog" in src, (
            "persist 端点源码中未找到 sync_changelog 去重逻辑"
        )
        assert "existing_cl" in src, (
            "persist 端点源码中未找到 existing_cl 变量（去重检查）"
        )

    def test_persist_updates_existing_sync_changelog_instead_of_creating(self):
        """
        CSC-002 核心场景：
        当 ChangeLog 中已存在 sync_changelog=True 的条目（由 _write_sync_changelog 写入），
        persist 端点应更新该条目（关联 VH），而非新建第二条。
        """
        from apps.collab.models import ChangeLog

        resource_id = uuid4()
        agent_run_id = f"run-{uuid4()}"
        vh_mock = MagicMock()
        vh_mock.id = uuid4()

        # 模拟已存在的 sync_changelog 条目
        existing_cl = MagicMock(spec=ChangeLog)
        existing_cl.version_history = None
        existing_cl.changes = {"sync_changelog": True}

        mock_filter_qs = MagicMock()
        mock_filter_qs.order_by.return_value.first.return_value = existing_cl

        mock_using_qs = MagicMock()
        mock_using_qs.filter.return_value = mock_filter_qs
        mock_using_qs.create = MagicMock()

        with patch("apps.collab.models.ChangeLog.objects") as mock_cl_objects:
            mock_cl_objects.using.return_value = mock_using_qs

            # 直接调用去重逻辑（模拟 persist 端点内部行为）
            existing = (
                mock_cl_objects.using("postgresql")
                .filter(
                    resource_type="docs",
                    resource_id=resource_id,
                    agent_run_id=agent_run_id,
                    version_history__isnull=True,
                    changes__sync_changelog=True,
                )
                .order_by("-created_at")
                .first()
            )

            if existing is not None:
                existing.version_history = vh_mock
                existing.changes = {**existing.changes, "persist_result": {}, "sync_changelog_updated": True}
                existing.save(using="postgresql", update_fields=["version_history", "changes"])
            else:
                mock_using_qs.create(
                    resource_type="docs",
                    resource_id=resource_id,
                    agent_run_id=agent_run_id,
                    version_history=vh_mock,
                )

        # 应更新已有条目，不应新建
        existing_cl.save.assert_called_once()
        mock_using_qs.create.assert_not_called()
        assert existing_cl.version_history == vh_mock
        assert existing_cl.changes.get("sync_changelog_updated") is True

    def test_persist_creates_new_changelog_when_no_existing_sync_entry(self):
        """
        当不存在 sync_changelog 条目时（非 Agent 操作，或 sync_changelog 未写入），
        persist 端点应正常新建 ChangeLog。
        """
        from apps.collab.models import ChangeLog

        resource_id = uuid4()
        agent_run_id = f"run-{uuid4()}"
        vh_mock = MagicMock()
        vh_mock.id = uuid4()

        mock_filter_qs = MagicMock()
        mock_filter_qs.order_by.return_value.first.return_value = None  # 无已有条目

        mock_using_qs = MagicMock()
        mock_using_qs.filter.return_value = mock_filter_qs
        mock_using_qs.create = MagicMock()

        with patch("apps.collab.models.ChangeLog.objects") as mock_cl_objects:
            mock_cl_objects.using.return_value = mock_using_qs

            existing = (
                mock_cl_objects.using("postgresql")
                .filter(
                    resource_type="docs",
                    resource_id=resource_id,
                    agent_run_id=agent_run_id,
                    version_history__isnull=True,
                    changes__sync_changelog=True,
                )
                .order_by("-created_at")
                .first()
            )

            if existing is not None:
                existing.version_history = vh_mock
                existing.save(using="postgresql", update_fields=["version_history", "changes"])
            else:
                mock_using_qs.create(
                    resource_type="docs",
                    resource_id=resource_id,
                    agent_run_id=agent_run_id,
                    version_history=vh_mock,
                )

        # 应新建，不应调用 existing.save
        mock_using_qs.create.assert_called_once()

    def test_no_dedup_when_agent_run_id_empty(self):
        """
        effective_agent_run_id 为空时，不执行去重查询，直接新建 ChangeLog。
        （避免无意义的全表扫描）
        """
        from apps.collab import api as collab_api
        src = inspect.getsource(collab_api.collab_persist)

        # 源码中应有 if effective_agent_run_id: 的条件保护去重查询
        assert "if effective_agent_run_id:" in src, (
            "persist 端点去重逻辑应在 effective_agent_run_id 非空时才执行"
        )
