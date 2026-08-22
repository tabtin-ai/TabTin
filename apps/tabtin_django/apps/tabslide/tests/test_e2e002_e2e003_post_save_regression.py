"""
E2E-002 / E2E-003 回归测试

E2E-002: _write_unified_version_best_effort 的 VH+CL 事务写入失败必须上报，
         不能整体静默。

E2E-003: Agent 路径（editor_type=="agent"）必须强制 force_snapshot=True，
         不受 HISTORY_MIN_INTERVAL 限制，确保每次 save_pages 都有对应 VH，
         rollback 不会回滚到更早版本。

TSV-006 更新：VH+CL 现在在同一 transaction.atomic 事务中写入，
         不再有"VH 成功但 CL 失败"的不一致状态。
         测试已适配新的 _do_create_history + Redis 锁模式。
"""

from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock, patch, call

import pytest


@contextmanager
def _noop_atomic(**kwargs):
    yield


def _common_patches():
    return (
        patch("apps.collab.adapters.slide.SlideCollabAdapter"),
        patch("apps.collab.service.VersionHistoryService"),
        patch("apps.collab.models.ChangeLog"),
        patch("django.core.cache.cache"),
        patch("django.db.transaction.atomic", side_effect=_noop_atomic),
    )


class TestE2E002ChangeLogFailureReportedSeparately:
    """E2E-002: VH+CL 事务写入失败必须记录 error 日志"""

    def test_vh_failure_triggers_error_log(self):
        """TSV-006: VH 写入失败时，整个事务回滚，error 日志必须记录失败信息。"""
        from apps.tabslide.post_save import _write_unified_version_best_effort

        project = SimpleNamespace(id="proj-e2e002")

        p1, p2, p3, p4, p5 = _common_patches()
        with p1 as adapter_cls, p2 as vh_svc_cls, p3 as changelog_cls, \
             p4 as mock_cache, p5, \
             patch("apps.tabslide.post_save.logger") as mock_logger:

            adapter_inst = MagicMock()
            adapter_inst.get_version_data.return_value = {"pages": []}
            adapter_cls.return_value = adapter_inst

            vh_svc_inst = MagicMock()
            vh_svc_inst._do_create_history.side_effect = RuntimeError("Redis unavailable")
            vh_svc_cls.return_value = vh_svc_inst

            mock_cache.get.return_value = None
            mock_cache.add.return_value = True

            _write_unified_version_best_effort(
                project,
                editor_type="agent",
                editor_id="agent-1",
                change_type="update",
                agent_run_id="run-001",
            )

            assert mock_logger.error.called, (
                "VH+CL 事务失败必须记录 error 日志"
            )
            error_msg = str(mock_logger.error.call_args)
            assert "proj-e2e002" in error_msg, "error 日志必须包含 project_id"

    def test_changelog_failure_logged_as_error(self):
        """ChangeLog 写入失败必须记录 error 级别日志（而非 warning），
        因为这会导致 rollback_agent_run 无法追踪此次变更。"""
        from apps.tabslide.post_save import _write_unified_version_best_effort

        project = SimpleNamespace(id="proj-e2e002b")
        fake_vh = MagicMock()
        fake_vh.id = "vh-001"

        p1, p2, p3, p4, p5 = _common_patches()
        with p1 as adapter_cls, p2 as vh_svc_cls, p3 as changelog_cls, \
             p4 as mock_cache, p5, \
             patch("apps.tabslide.post_save.logger") as mock_logger:

            adapter_inst = MagicMock()
            adapter_inst.get_version_data.return_value = {"pages": []}
            adapter_cls.return_value = adapter_inst

            vh_svc_inst = MagicMock()
            vh_svc_inst._do_create_history.return_value = fake_vh
            vh_svc_cls.return_value = vh_svc_inst

            mock_cache.get.return_value = None
            mock_cache.add.return_value = True

            changelog_cls.objects.using.return_value.create.side_effect = RuntimeError("DB error")

            _write_unified_version_best_effort(
                project,
                editor_type="agent",
                editor_id="agent-1",
                change_type="update",
                agent_run_id="run-002",
            )

            assert mock_logger.error.called, (
                "ChangeLog 写入失败必须记录 error 日志（E2E-002）"
            )


class TestE2E003AgentPathForcesSnapshot:
    """E2E-003: Agent 路径必须强制 force_snapshot=True

    TSV-006 更新：现在使用 _do_create_history 而非 create_history，
    Redis 锁在外部管理。
    """

    def test_agent_editor_type_forces_snapshot(self):
        """editor_type='agent' 时，即使 force=False，也必须强制 force_snapshot=True"""
        from apps.tabslide.post_save import _write_unified_version_best_effort

        project = SimpleNamespace(id="proj-e2e003")
        fake_vh = MagicMock()

        p1, p2, p3, p4, p5 = _common_patches()
        with p1 as adapter_cls, p2 as vh_svc_cls, p3 as changelog_cls, \
             p4 as mock_cache, p5:

            adapter_inst = MagicMock()
            adapter_inst.get_version_data.return_value = {"pages": []}
            adapter_cls.return_value = adapter_inst

            vh_svc_inst = MagicMock()
            vh_svc_inst._do_create_history.return_value = fake_vh
            vh_svc_cls.return_value = vh_svc_inst

            changelog_cls.objects.using.return_value.create.return_value = MagicMock()
            mock_cache.get.return_value = None
            mock_cache.add.return_value = True

            _write_unified_version_best_effort(
                project,
                editor_type="agent",
                editor_id="agent-1",
                change_type="update",
                force=False,
            )

            vh_svc_inst._do_create_history.assert_called_once()
            kwargs = vh_svc_inst._do_create_history.call_args[1]
            assert kwargs.get("force_snapshot") is True, (
                "agent 路径必须强制 force_snapshot=True，不受 force 参数影响（E2E-003）"
            )

    def test_user_editor_type_respects_force_param(self):
        """editor_type='user' 时，force_snapshot 应遵循 force 参数"""
        from apps.tabslide.post_save import _write_unified_version_best_effort

        project = SimpleNamespace(id="proj-e2e003b")
        fake_vh = MagicMock()

        p1, p2, p3, p4, p5 = _common_patches()
        with p1 as adapter_cls, p2 as vh_svc_cls, p3 as changelog_cls, \
             p4 as mock_cache, p5:

            adapter_inst = MagicMock()
            adapter_inst.get_version_data.return_value = {"pages": []}
            adapter_cls.return_value = adapter_inst

            vh_svc_inst = MagicMock()
            vh_svc_inst._do_create_history.return_value = fake_vh
            vh_svc_cls.return_value = vh_svc_inst

            changelog_cls.objects.using.return_value.create.return_value = MagicMock()
            mock_cache.get.return_value = None
            mock_cache.add.return_value = True

            _write_unified_version_best_effort(
                project,
                editor_type="user",
                editor_id="user-1",
                change_type="update",
                force=False,
            )

            kwargs = vh_svc_inst._do_create_history.call_args[1]
            assert kwargs.get("force_snapshot") is False, (
                "user 路径 force=False 时，force_snapshot 不应被强制为 True"
            )

    def test_agent_path_force_true_also_works(self):
        """agent 路径 force=True 时，force_snapshot 也应为 True（两者 OR）"""
        from apps.tabslide.post_save import _write_unified_version_best_effort

        project = SimpleNamespace(id="proj-e2e003c")
        fake_vh = MagicMock()

        p1, p2, p3, p4, p5 = _common_patches()
        with p1 as adapter_cls, p2 as vh_svc_cls, p3 as changelog_cls, \
             p4 as mock_cache, p5:

            adapter_inst = MagicMock()
            adapter_inst.get_version_data.return_value = {"pages": []}
            adapter_cls.return_value = adapter_inst

            vh_svc_inst = MagicMock()
            vh_svc_inst._do_create_history.return_value = fake_vh
            vh_svc_cls.return_value = vh_svc_inst

            changelog_cls.objects.using.return_value.create.return_value = MagicMock()
            mock_cache.get.return_value = None
            mock_cache.add.return_value = True

            _write_unified_version_best_effort(
                project,
                editor_type="agent",
                editor_id="agent-1",
                change_type="update",
                force=True,
            )

            kwargs = vh_svc_inst._do_create_history.call_args[1]
            assert kwargs.get("force_snapshot") is True
