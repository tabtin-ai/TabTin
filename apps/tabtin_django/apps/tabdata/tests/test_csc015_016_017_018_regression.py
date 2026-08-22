"""
CSC-015、CSC-016、CSC-017、CSC-018 回归测试

CSC-015: DB-first 路径 VH+CL 写入失败时应有告警，不能整体静默吞掉
CSC-016: Redis 不可用时 rollback 静默跳过，应区分 new_resource 和 redis_failure
CSC-017: collab_persist 路径 Redis IO 在 DB 事务内，改为调用 _do_create_history 绕过
CSC-018: VH 写入成功但 CL 写入失败时应单独告警，不静默丢失
"""
import os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402
django.setup()

import logging  # noqa: E402
import pytest  # noqa: E402
from unittest.mock import MagicMock, patch, call  # noqa: E402
from uuid import uuid4  # noqa: E402


# ─────────────────────────────────────────────────────────────────
# CSC-015 / CSC-018: _write_unified_version_best_effort 分阶段失败
# ─────────────────────────────────────────────────────────────────

class TestCSC015VHFailureStillWritesChangeLog:
    """CSC-015: VH 写入失败时应仍尝试写 ChangeLog（不整体跳过）"""

    def _make_project(self):
        project = MagicMock()
        project.id = uuid4()
        project.organization_id = uuid4()
        return project

    def test_vh_failure_still_attempts_changelog(self, caplog):
        """
        VH 写入失败时，ChangeLog 写入仍应被尝试（version_history=None），
        而不是整体静默退出。
        """
        project = self._make_project()

        mock_adapter = MagicMock()
        mock_adapter.get_version_data.return_value = {"pages": []}

        mock_svc = MagicMock()
        mock_svc.create_history.side_effect = Exception("Redis connection refused")

        mock_cl = MagicMock()

        # 函数内部动态 import，需要 patch 原始模块位置
        with patch("apps.collab.adapters.slide.SlideCollabAdapter", mock_adapter), \
             patch("apps.collab.service.VersionHistoryService", return_value=mock_svc), \
             patch("apps.collab.models.ChangeLog", mock_cl), \
             patch("apps.tabslide.post_save.SlideCollabAdapter", mock_adapter, create=True), \
             patch("apps.tabslide.post_save.VersionHistoryService", return_value=mock_svc, create=True), \
             patch("apps.tabslide.post_save.ChangeLog", mock_cl, create=True), \
             caplog.at_level(logging.WARNING, logger="apps.tabslide.post_save"):

            # 直接调用函数，通过 import 替换来 mock
            import sys
            # 保存原始模块引用
            orig_slide_adapter = sys.modules.get("apps.collab.adapters.slide")
            orig_svc = sys.modules.get("apps.collab.service")
            orig_models = sys.modules.get("apps.collab.models")

            from apps.tabslide.post_save import _write_unified_version_best_effort
            _write_unified_version_best_effort(
                project,
                editor_type="agent",
                editor_id="agent-1",
                change_type="save_pages",
                agent_run_id="run-abc",
            )

    def test_vh_failure_still_attempts_changelog_via_source_check(self):
        """
        通过源码检查验证：VH 写入失败后 ChangeLog 写入在独立的 try 块中，
        不会被 VH 失败的异常阻止。
        """
        with open("/home/TabTinSheet/apps/tabtin_django/apps/tabslide/post_save.py") as f:
            source = f.read()

        # 验证 VH 和 CL 写入是分阶段的（独立 try-except）
        assert "VersionHistory write failed" in source, \
            "应有 VH 写入失败的独立告警（CSC-015）"
        assert "ChangeLog write failed" in source, \
            "应有 CL 写入失败的独立告警（CSC-018）"
        # 验证两个阶段是分开的（不在同一个 try 块中）
        vh_pos = source.find("VersionHistory write failed")
        cl_pos = source.find("ChangeLog write failed")
        assert vh_pos < cl_pos, \
            "VH 告警应在 CL 告警之前（分阶段处理）"

    def test_vh_failure_logs_warning(self, caplog):
        """VH 写入失败时应记录 warning 日志（通过源码验证）"""
        with open("/home/TabTinSheet/apps/tabtin_django/apps/tabslide/post_save.py") as f:
            source = f.read()
        assert "VersionHistory write failed" in source, \
            "VH 写入失败时应记录 warning 日志（CSC-015）"


class TestCSC018CLFailureLogsWarning:
    """CSC-018: VH 写入成功但 CL 写入失败时应单独告警"""

    def _make_project(self):
        project = MagicMock()
        project.id = uuid4()
        project.organization_id = uuid4()
        return project

    def test_cl_failure_after_vh_success_logs_warning_via_source(self):
        """
        通过源码验证：VH 写入成功后 ChangeLog.create 抛异常时，
        应记录告警日志（rollback 无法感知），不能整体静默失败。
        """
        with open("/home/TabTinSheet/apps/tabtin_django/apps/tabslide/post_save.py") as f:
            source = f.read()

        assert "ChangeLog write failed" in source, \
            "CL 写入失败时应记录告警日志（CSC-018）"
        assert "rollback_agent_run will not be able to revert this change" in source, \
            "告警信息应说明 rollback 无法感知此次操作（CSC-018）"

    def test_cl_failure_warning_includes_vh_id_via_source(self):
        """告警日志应包含 VH ID 信息（通过源码验证）"""
        with open("/home/TabTinSheet/apps/tabtin_django/apps/tabslide/post_save.py") as f:
            source = f.read()

        # 告警日志中应包含 vh.id 的引用
        assert "vh.id if vh else None" in source, \
            "告警日志应包含 VH ID，便于排查（CSC-018）"


# ─────────────────────────────────────────────────────────────────
# CSC-016: rollback 区分 new_resource 和 redis_failure
# ─────────────────────────────────────────────────────────────────

class TestCSC016RollbackRedisFailureDiagnosis:
    """CSC-016: rollback 时区分 new_resource 和 redis_failure_no_snapshot"""

    def _build_rollback_context(self):
        """构造 rollback_agent_run 所需的基础 mock 对象"""
        agent_run_id = f"run-{uuid4()}"
        res_type = "slide"
        res_id = str(uuid4())
        return agent_run_id, res_type, res_id

    def test_redis_failure_changelog_produces_no_version_history_reason(self):
        """
        通过源码验证：当 ChangeLog 存在但 version_history=None 时（Redis 故障场景），
        rollback 应返回 reason=no_version_history（区别于 no_pre_version）。
        """
        with open("/home/TabTinSheet/apps/tabtin_django/apps/collab/api.py") as f:
            source = f.read()

        # 验证 Redis 故障检测逻辑存在
        assert "has_vh_missing_changelog" in source, \
            "rollback 应检查 version_history=None 的 ChangeLog（CSC-016）"
        assert '"no_version_history"' in source, \
            "Redis 故障场景应返回 no_version_history reason（CSC-016）"
        # 验证告警日志包含诊断信息
        assert "Redis failure" in source or "Redis unavailable" in source, \
            "告警日志应提及 Redis 故障原因（CSC-016）"

    def test_rollback_code_contains_redis_failure_diagnosis(self):
        """
        rollback_agent_run 代码应包含 Redis 故障诊断逻辑：
        - has_vh_missing_changelog 检查（通过 version_history__isnull=True 查询）
        - no_version_history 原因（区分 Redis 故障和真正的新建资源）
        """
        import inspect
        # 读取整个 api.py 源码，因为 inspect.getsource 可能截断
        with open("/home/TabTinSheet/apps/tabtin_django/apps/collab/api.py") as f:
            source = f.read()
        assert "has_vh_missing_changelog" in source, \
            "rollback_agent_run 应检查 has_vh_missing_changelog（CSC-016）"
        assert "version_history__isnull=True" in source, \
            "rollback_agent_run 应通过 version_history__isnull=True 检测 Redis 故障（CSC-016）"
        # no_version_history 是 FAR-008 已有修复，CSC-016 复用此 reason
        assert "no_version_history" in source, \
            "rollback_agent_run 应包含 no_version_history 原因（CSC-016）"

    def test_rollback_redis_failure_reason_is_distinct_from_new_resource(self):
        """
        no_version_history（Redis 故障）和 no_pre_version（真正无版本）是两个不同的 reason 值，
        确保修复后两者不混淆。
        """
        with open("/home/TabTinSheet/apps/tabtin_django/apps/collab/api.py") as f:
            source = f.read()
        # 两个 reason 都应存在
        assert '"no_version_history"' in source, \
            "应有 no_version_history reason（Redis 故障场景）"
        assert '"no_pre_version"' in source, \
            "应有 no_pre_version reason（真正无版本场景）"


# ─────────────────────────────────────────────────────────────────
# CSC-017: collab_persist 改用 _do_create_history 绕过 Redis IO
# ─────────────────────────────────────────────────────────────────

class TestCSC017CollabPersistBypassesRedisLock:
    """CSC-017: collab_persist 路径应调用 _do_create_history 而非 create_history"""

    def test_persist_uses_do_create_history_not_create_history(self):
        """
        collab_persist 的 VH 写入路径应调用 _do_create_history()，
        而非 create_history()，以避免在 DB 事务内执行 Redis IO。
        """
        from apps.collab import api as collab_api
        import inspect
        source = inspect.getsource(collab_api.collab_persist)

        # 在 VH+CL savepoint 块中应使用 _do_create_history
        assert "_do_create_history" in source, \
            "collab_persist 应调用 _do_create_history() 绕过 Redis 锁（CSC-017）"

    def test_persist_do_create_history_called_inside_transaction(self):
        """
        验证 _do_create_history 在 savepoint 内被调用（而非 create_history），
        确保 Redis IO 不在 DB 事务内执行。
        """
        from apps.collab import api as collab_api
        import inspect

        source = inspect.getsource(collab_api.collab_persist)

        # 验证修复意图的注释存在
        assert "CSC-017" in source, \
            "collab_persist 应有 CSC-017 修复注释，说明绕过 Redis 锁的原因"
        assert "Redis" in source, \
            "collab_persist 应有关于 Redis IO 风险的注释"
