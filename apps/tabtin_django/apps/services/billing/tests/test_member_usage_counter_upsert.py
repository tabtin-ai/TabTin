"""#723 回归守卫：成员用量计数器 upsert 必须用 PostgreSQL 可移植的
``ON CONFLICT ... DO UPDATE``，不能再退回 MySQL 方言。

历史 bug：原 SQL 使用 ``ON DUPLICATE KEY UPDATE`` + ``VALUES()``，在
PostgreSQL（本项目唯一业务库）上每次执行都抛
``syntax error at or near "DUPLICATE"``，被外层 try/except 吞成 warning，
导致月度/日度计数器从未成功递增、日志被刷屏。

为何是静态文本断言而非功能用例：函数位于 ``apps.services.llm``，而 billing
回归基座（``settings_billing_test``，SQLite）刻意不安装 llm app，无法 import
该模块。功能层面的「在真实 PostgreSQL 上 upsert+递增正确」由 live 探针验证
（见 PR 描述自验段），此处用导入无关的源码守卫防止方言回退。
"""

from pathlib import Path

from django.test import SimpleTestCase

_BILLING_PY = (
    Path(__file__).resolve().parents[2]
    / "llm" / "services" / "billing.py"
)


class MemberUsageCounterUpsertDialectGuard(SimpleTestCase):
    def setUp(self):
        self.source = _BILLING_PY.read_text(encoding="utf-8")
        self.assertTrue(
            "_increment_member_usage_counter" in self.source,
            "未找到成员用量计数器函数，路径可能已变动",
        )

    def test_uses_postgres_on_conflict(self):
        self.assertIn("ON CONFLICT (organization_id, user_id, cycle_date, cycle_type)", self.source)
        self.assertIn("EXCLUDED.consumed_credits", self.source)

    def test_no_mysql_dialect(self):
        self.assertNotIn("ON DUPLICATE", self.source)
        self.assertNotIn("VALUES(consumed_credits)", self.source)
