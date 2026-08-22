"""
PRD 05 v0.4 §7.7 — PermissionAudit model 单元测试。

W2-轮 1：覆盖 AdminDash 回放主路径与
"按 batch_id 聚合 / 按 agent_id 时序 / 按 thread_id 单会话 / 按 decision 统计"
等 5 个核心索引的真实查询场景。

`PermissionAudit` 表归属 PostgreSQL（agent_engine app_label，
``DefaultDatabaseRouter._pg_app_labels`` 路由）；走 ``--database=postgresql``
运行测试。
"""

from __future__ import annotations

import os
import sys
import unittest
import uuid

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings_permission_audit_test")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402

if not getattr(django.apps, "apps_ready", False):
    django.setup()

from django.conf import settings as _dj_settings  # noqa: E402
from django.db import connection, connections  # noqa: E402
from django.test import SimpleTestCase, TestCase  # noqa: E402

from apps.services.agent_engine.models import PermissionAudit  # noqa: E402

# DB 路径测试需要禁 migration 的 in-memory SQLite 隔离 settings；主 ``tabtin.settings``
# 即便切到 SQLite，也会跑到 ``services/billing/0024_fix_collation_utf8mb4_unicode_ci``
# 的 MySQL 专用 ``CONVERT TO CHARACTER SET`` DDL，撞 SQLite 语法错。
#
# 主防护：root conftest 的 ``_ISOLATED_TEST_FILES`` 在主 settings 下把本文件
# 整个排除出 collection，避免 ``django_db_setup`` 看到 ``databases = {...}``
# 后跑 setup_databases 撞 migration 错。
#
# 二级防护：本类级 skipIf 兜住"有人手工 import 本模块 / 用奇特 ``--ds`` 组合
# 绕过 collect_ignore"的边缘场景，给清晰的提示而不是直接 ERROR。
_NEEDS_ISOLATED_SETTINGS = (
    _dj_settings.SETTINGS_MODULE != "tabtin.settings_permission_audit_test"
)
_ISOLATED_SETTINGS_HINT = (
    "PermissionAudit DB tests need migration-disabled in-memory SQLite settings; "
    "run with: `pytest --ds=tabtin.settings_permission_audit_test "
    "apps/services/agent_engine/tests/test_permission_audit_model.py` "
    "(or just `pytest <that path>` — root conftest auto-routes single-file "
    "invocations to the isolated settings)."
)


class PermissionAuditMetaTests(SimpleTestCase):
    """纯 model 元数据校验，不碰 DB。

    部署主路径下保证 ``python -c "from ... import PermissionAudit;
    print(PermissionAudit._meta.get_fields())"`` 也能跑通（W2-轮 1 北极星 §2 命令）。
    """

    def test_schema_required_fields_present(self):
        """所有 PRD §7.7 字段必须存在；删字段会破坏 AdminDash 查询契约。"""
        names = {f.name for f in PermissionAudit._meta.get_fields()}
        required = {
            "id", "organization_id", "agent_id", "thread_id", "session_id",
            "batch_id", "request_id", "tool_call_id",
            "tool_name", "tool_namespace", "tool_input_preview",
            "decision", "source", "reason", "scope",
            "approver_user_id", "approver_client_info",
            "runtime_mode", "skill_context", "rejection_message",
            "created_at",
        }
        missing = required - names
        self.assertFalse(
            missing,
            f"PermissionAudit 缺少 PRD §7.7 字段: {missing}",
        )
        self.assertGreaterEqual(
            len(names), 18,
            f"PRD §7.7 要求 18+ 字段，实际 {len(names)}",
        )

    def test_indexes_match_admindash_query_paths(self):
        """5 个 AdminDash 查询索引必须存在（北极星 §1.3 主路径）。"""
        index_names = {idx.name for idx in PermissionAudit._meta.indexes}
        expected = {
            "idx_permaudit_agent_time",
            "idx_permaudit_thread_time",
            "idx_permaudit_batch",
            "idx_permaudit_organization_ts",
            "idx_permaudit_decision_time",
        }
        missing = expected - index_names
        self.assertFalse(
            missing,
            f"PermissionAudit 缺少索引: {missing}",
        )

    def test_meta_db_table_and_app_label(self):
        """db_table 和 app_label 锚定，重命名会破坏 PG 路由 + 历史 migration 兼容。"""
        self.assertEqual(
            PermissionAudit._meta.db_table, "agent_engine_permission_audit",
        )
        self.assertEqual(
            PermissionAudit._meta.app_label, "agent_engine",
        )


@unittest.skipIf(_NEEDS_ISOLATED_SETTINGS, _ISOLATED_SETTINGS_HINT)
class PermissionAuditModelTests(TestCase):
    """需要真实 DB 的查询路径验收。

    用 ``settings_permission_audit_test.py`` 的 in-memory SQLite 跑（绕开本地
    MySQL FULLTEXT / PG GIN 等迁移依赖问题）。真实 PG 索引存在性由
    ``bash scripts/backend/migrate-all.sh`` + ``migrate-check.sh`` 双库迁移保证。
    """

    databases = {"default", "postgresql"}

    def setUp(self):
        self.organization_id = uuid.uuid4()
        self.agent_id = uuid.uuid4()
        self.session_id = uuid.uuid4()
        self.thread_id = f"chat-session-{self.session_id}"

    @unittest.skipUnless(
        connection.vendor == "postgresql",
        "pg_indexes 视图是 PG 专有；SQLite 测试环境跳过（migrate-all 已保证 PG 真建）",
    )
    def test_indexes_present_in_pg(self):
        """PG 实表上索引真存在（migrate 真跑过 PG 而不是只写 Django 影子记录）。"""
        with connections["postgresql"].cursor() as cursor:
            cursor.execute(
                "SELECT indexname FROM pg_indexes WHERE tablename = %s",
                ["agent_engine_permission_audit"],
            )
            real = {row[0] for row in cursor.fetchall()}
        expected = {
            "idx_permaudit_agent_time",
            "idx_permaudit_thread_time",
            "idx_permaudit_batch",
            "idx_permaudit_organization_ts",
            "idx_permaudit_decision_time",
        }
        missing = expected - real
        self.assertFalse(
            missing,
            f"PG 实表缺索引: {missing}（裸 `manage.py migrate` 不带 "
            f"--database=postgresql 不会真建索引；务必走 migrate-all.sh）",
        )

    # ── 查询场景：AdminDash 单 Agent 时序回放 ─────────────────────────

    def test_query_by_agent_id_orders_by_created_at(self):
        """单 Agent 回放：按 agent_id 查 + created_at 倒排。"""
        for tool in ["read_file", "list_directory", "bash"]:
            self._make_audit(tool_name=tool, decision="allow")

        rows = list(
            PermissionAudit.objects.using("postgresql")
            .filter(agent_id=self.agent_id)
            .order_by("-created_at")
        )
        self.assertEqual(len(rows), 3)
        self.assertEqual(
            [r.tool_name for r in rows],
            ["bash", "list_directory", "read_file"],
            "按 created_at 倒排：最近的在前",
        )

    # ── 查询场景：单会话回放 + decision 统计 ───────────────────────────

    def test_query_by_thread_id_and_decision_aggregation(self):
        """单会话 thread_id 回放 + 按 outcome 分组统计（"昨晚 23 次 / 18 allow / 5 deny"）。"""
        self._make_audit(tool_name="t1", decision="allow")
        self._make_audit(tool_name="t2", decision="allow")
        self._make_audit(tool_name="t3", decision="deny")

        thread_rows = (
            PermissionAudit.objects.using("postgresql")
            .filter(thread_id=self.thread_id)
        )
        self.assertEqual(thread_rows.count(), 3)

        from django.db.models import Count
        stats = {
            row["decision"]: row["c"]
            for row in (
                thread_rows.values("decision").annotate(c=Count("id"))
            )
        }
        self.assertEqual(stats.get("allow"), 2)
        self.assertEqual(stats.get("deny"), 1)

    # ── 查询场景：按 batch_id 聚合 ────────────────────────────────────

    def test_query_by_batch_id_returns_all_rows(self):
        """同 batch 内 N 条 ActionRequest 共享 batch_id；按 batch 聚合返回 N 行。"""
        batch_id = uuid.uuid4()
        for tool in ["list_directory", "read_file"]:
            self._make_audit(
                tool_name=tool, decision="allow", batch_id=batch_id,
            )

        batch_rows = list(
            PermissionAudit.objects.using("postgresql").filter(batch_id=batch_id)
        )
        self.assertEqual(len(batch_rows), 2, "同批 N=2 行返回 2 条")
        self.assertEqual(
            sorted(r.tool_name for r in batch_rows),
            ["list_directory", "read_file"],
        )

    def test_batch_id_null_path_for_single_tool(self):
        """单工具 N=1 退化形态可写 batch_id=None（rollback / 后台清理也走此路径）。"""
        self._make_audit(
            tool_name="t-single",
            decision="cancelled_by_rollback",
            source="rollback",
            batch_id=None,
        )
        rows = list(
            PermissionAudit.objects.using("postgresql")
            .filter(agent_id=self.agent_id, batch_id__isnull=True)
        )
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].decision, "cancelled_by_rollback")

    # ── 字段语义：DecisionReason JSON / scope blank ──────────────────

    def test_reason_jsonfield_round_trip(self):
        """reason JSON 字段可写复杂结构（DecisionReason discriminated union）。"""
        reason = {
            "type": "memoized_always",
            "previous_reason": {
                "type": "user_interactive",
                "scope": "always",
            },
        }
        self._make_audit(
            tool_name="bash",
            decision="allow",
            source="memoization",
            reason=reason,
        )
        row = (
            PermissionAudit.objects.using("postgresql")
            .filter(agent_id=self.agent_id, source="memoization")
            .first()
        )
        self.assertEqual(row.reason["type"], "memoized_always")
        self.assertEqual(row.reason["previous_reason"]["scope"], "always")

    def test_scope_blank_default_for_non_user_interactive(self):
        """非 user_interactive 的 source 写空字符串而非 None / 'once' 默认值。"""
        self._make_audit(
            tool_name="rm",
            decision="deny",
            source="hardline",
            scope="",
        )
        row = (
            PermissionAudit.objects.using("postgresql")
            .filter(agent_id=self.agent_id, source="hardline")
            .first()
        )
        self.assertEqual(row.scope, "", "scope 留空字符串而不是 NULL")

    # ── helper ──────────────────────────────────────────────────────

    def _make_audit(
        self,
        *,
        tool_name: str,
        decision: str,
        source: str = "user_interactive",
        scope: str = "once",
        batch_id=...,
        reason=None,
    ) -> PermissionAudit:
        """构造一行 PermissionAudit，默认填齐必填字段。"""
        if batch_id is ...:
            batch_id = uuid.uuid4()
        if reason is None:
            reason = {"type": "user_interactive", "scope": scope}
        return PermissionAudit.objects.using("postgresql").create(
            organization_id=self.organization_id,
            agent_id=self.agent_id,
            thread_id=self.thread_id,
            session_id=self.session_id,
            batch_id=batch_id,
            request_id=uuid.uuid4(),
            tool_call_id=f"call-{uuid.uuid4()}",
            tool_name=tool_name,
            tool_namespace="",
            tool_input_preview=f"{{tool: {tool_name}}}",
            decision=decision,
            source=source,
            reason=reason,
            scope=scope,
            runtime_mode="interactive",
        )
