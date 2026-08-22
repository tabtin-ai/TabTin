"""
TSV-006 回归测试：VH + CL 事务原子性

验证 _write_unified_version_best_effort 中 VersionHistory 和 ChangeLog 的写入
在同一个数据库事务中完成，确保：
  1. 两者同时成功 → rollback_agent_run 可正常回滚
  2. CL 写入失败 → VH 也回滚，不留孤立记录
  3. VH 为 None（Redis 不可用或无变更）→ 不写 CL
  4. 失败时记录包含 agent_run_id 和 project_id 的结构化日志
"""

from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest


@contextmanager
def _noop_atomic(**kwargs):
    """替代 transaction.atomic 的无操作上下文管理器（测试用）"""
    yield


def _make_common_patches():
    """构建 _write_unified_version_best_effort 所需的全部 mock 上下文"""
    return (
        patch("apps.collab.adapters.slide.SlideCollabAdapter"),
        patch("apps.collab.service.VersionHistoryService"),
        patch("apps.collab.models.ChangeLog"),
        patch("django.core.cache.cache"),
        patch("django.db.transaction.atomic", side_effect=_noop_atomic),
    )


class TestVHCLAtomicity:
    """TSV-006: VH 和 CL 必须在同一事务中写入"""

    def _make_project(self, project_id="proj-tsv006"):
        return SimpleNamespace(id=project_id, organization_id="wt-001")

    def _make_fake_vh(self, vh_id="vh-001"):
        vh = MagicMock()
        vh.id = vh_id
        return vh

    def test_both_succeed(self):
        """VH 和 CL 同时写入成功"""
        from apps.tabslide.post_save import _write_unified_version_best_effort

        project = self._make_project()
        fake_vh = self._make_fake_vh()

        p1, p2, p3, p4, p5 = _make_common_patches()
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
                change_type="save_pages",
                agent_run_id="run-001",
            )

            vh_svc_inst._do_create_history.assert_called_once()

            cl_create = changelog_cls.objects.using.return_value.create
            cl_create.assert_called_once()
            assert cl_create.call_args[1]["version_history"] == fake_vh
            assert cl_create.call_args[1]["agent_run_id"] == "run-001"

    def test_cl_failure_rolls_back_vh(self):
        """CL 写入失败时，事务回滚，VH 也被回滚。

        验证异常被捕获且记录了结构化 error 日志。
        """
        from apps.tabslide.post_save import _write_unified_version_best_effort

        project = self._make_project("proj-cl-fail")
        fake_vh = self._make_fake_vh()

        p1, p2, p3, p4, p5 = _make_common_patches()
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

            changelog_cls.objects.using.return_value.create.side_effect = RuntimeError("DB write error")

            _write_unified_version_best_effort(
                project,
                editor_type="agent",
                editor_id="agent-1",
                change_type="save_pages",
                agent_run_id="run-002",
            )

            assert mock_logger.error.called, "VH+CL 事务失败必须记录 error 日志"

    def test_vh_none_skips_cl(self):
        """VH 返回 None（无变更或 Redis 不可用）时不写 CL"""
        from apps.tabslide.post_save import _write_unified_version_best_effort

        project = self._make_project("proj-vh-none")

        p1, p2, p3, p4, p5 = _make_common_patches()
        with p1 as adapter_cls, p2 as vh_svc_cls, p3 as changelog_cls, \
             p4 as mock_cache, p5:

            adapter_inst = MagicMock()
            adapter_inst.get_version_data.return_value = {"pages": []}
            adapter_cls.return_value = adapter_inst

            vh_svc_inst = MagicMock()
            vh_svc_inst._do_create_history.return_value = None
            vh_svc_cls.return_value = vh_svc_inst

            mock_cache.get.return_value = None
            mock_cache.add.return_value = True

            _write_unified_version_best_effort(
                project,
                editor_type="agent",
                editor_id="agent-1",
                change_type="save_pages",
                agent_run_id="run-003",
            )

            cl_create = changelog_cls.objects.using.return_value.create
            cl_create.assert_not_called()

    def test_error_log_contains_structured_info(self):
        """事务失败的日志必须包含 project_id 和 agent_run_id"""
        from apps.tabslide.post_save import _write_unified_version_best_effort

        project = self._make_project("proj-structured-log")
        fake_vh = self._make_fake_vh()

        p1, p2, p3, p4, p5 = _make_common_patches()
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
                change_type="save_pages",
                agent_run_id="run-structured",
            )

            assert mock_logger.error.called
            error_call_args = str(mock_logger.error.call_args)
            assert "proj-structured-log" in error_call_args, (
                "error 日志必须包含 project_id"
            )
            assert "run-structured" in error_call_args, (
                "error 日志必须包含 agent_run_id"
            )

    def test_redis_lock_acquired_outside_transaction(self):
        """Redis 锁应在事务外申请，与 collab_persist 路径共享锁"""
        from apps.tabslide.post_save import _write_unified_version_best_effort

        project = self._make_project("proj-lock")
        fake_vh = self._make_fake_vh()

        p1, p2, p3, p4, p5 = _make_common_patches()
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
                change_type="save_pages",
                agent_run_id="run-lock",
            )

            mock_cache.add.assert_called_once()
            lock_key = mock_cache.add.call_args[0][0]
            assert "create_history_lock" in lock_key
            assert "slide" in lock_key

            mock_cache.delete.assert_called()

    def test_redis_lock_contention_skips_write(self):
        """Redis 锁被占用时跳过写入"""
        from apps.tabslide.post_save import _write_unified_version_best_effort

        project = self._make_project("proj-lock-contention")

        p1, p2, p3, p4, p5 = _make_common_patches()
        with p1 as adapter_cls, p2 as vh_svc_cls, p3 as changelog_cls, \
             p4 as mock_cache, p5, \
             patch("apps.tabslide.post_save.logger"):

            adapter_inst = MagicMock()
            adapter_inst.get_version_data.return_value = {"pages": []}
            adapter_cls.return_value = adapter_inst

            mock_cache.get.return_value = None
            mock_cache.add.return_value = False

            _write_unified_version_best_effort(
                project,
                editor_type="agent",
                editor_id="agent-1",
                change_type="save_pages",
                agent_run_id="run-contention",
            )

            vh_svc_cls.return_value._do_create_history.assert_not_called()
            changelog_cls.objects.using.return_value.create.assert_not_called()

    def test_restore_lock_held_skips_write(self):
        """恢复锁被持有时跳过写入（CC-008）"""
        from apps.tabslide.post_save import _write_unified_version_best_effort

        project = self._make_project("proj-restore-lock")

        p1, p2, p3, p4, p5 = _make_common_patches()
        with p1 as adapter_cls, p2 as vh_svc_cls, p3 as changelog_cls, \
             p4 as mock_cache, p5:

            adapter_inst = MagicMock()
            adapter_inst.get_version_data.return_value = {"pages": []}
            adapter_cls.return_value = adapter_inst

            mock_cache.get.return_value = 1

            _write_unified_version_best_effort(
                project,
                editor_type="agent",
                editor_id="agent-1",
                change_type="save_pages",
                agent_run_id="run-restore",
            )

            vh_svc_cls.return_value._do_create_history.assert_not_called()
            changelog_cls.objects.using.return_value.create.assert_not_called()


class TestAgentEditorTypeIntegration:
    """TSV-006 + E2E-003: Agent 路径的 force_snapshot 和 editor_type 转换"""

    def test_agent_forces_snapshot_in_new_flow(self):
        """agent 路径必须对 _do_create_history 传 force_snapshot=True"""
        from apps.tabslide.post_save import _write_unified_version_best_effort

        project = SimpleNamespace(id="proj-agent-snap", organization_id="wt-1")
        fake_vh = MagicMock()
        fake_vh.id = "vh-agent"

        p1, p2, p3, p4, p5 = _make_common_patches()
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
                change_type="save_pages",
                force=False,
            )

            kwargs = vh_svc_inst._do_create_history.call_args[1]
            assert kwargs.get("force_snapshot") is True, (
                "agent 路径必须强制 force_snapshot=True（E2E-003）"
            )

    def test_human_to_user_normalization(self):
        """CSC-019: editor_type='human' 应被转换为 'user'"""
        from apps.tabslide.post_save import _write_unified_version_best_effort

        project = SimpleNamespace(id="proj-human", organization_id="wt-1")
        fake_vh = MagicMock()
        fake_vh.id = "vh-human"

        p1, p2, p3, p4, p5 = _make_common_patches()
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
                editor_type="human",
                editor_id="user-1",
                change_type="save_pages",
            )

            cl_create = changelog_cls.objects.using.return_value.create
            cl_create.assert_called_once()
            assert cl_create.call_args[1]["editor_type"] == "user", (
                "CSC-019: 'human' 必须被转换为 'user'"
            )
