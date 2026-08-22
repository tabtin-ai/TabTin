"""`apps.fts.models` Outbox 双栈 + Router 测试。

设计说明：
    - 本文件只做**纯逻辑**验证：Router 分发、Model Meta 结构、
      Migration 存在性。pytest 下不访问真实数据库。
    - **真实 ORM 写入**（验收命令 7）由集成脚本
      `apps/fts/tests/integration/verify_outbox_migration.py` 覆盖，
      需要连接真实 MySQL + PG 执行；参见该脚本注释。

原因：TabTin 历史上用 `SimpleTestCase + mock` 跑所有单元测试
（见 `apps/tabmemo/tests/test_memo_service.py` 注释），
pytest 下无法创建完整的 SQLite 测试库——
其他 app 的 PG-specific migrations（GIN / tsvector）在 SQLite 上
直接 DDL 语法错。fts 遵循同一套约定，避免引入跨 app 副作用。
"""

from __future__ import annotations

from django.test import SimpleTestCase

from apps.fts.db_router import FtsRouter
from apps.fts.models import FtsOutbox, FtsOutboxPg


# ── 1. Router 纯逻辑测试 ────────────────────────────────────────
class FtsRouterUnitTests(SimpleTestCase):
    """基于真实 Django Model 元信息验证 Router 分发。"""

    def setUp(self) -> None:
        super().setUp()
        self.router = FtsRouter()

    def test_db_for_write_routes_mysql_model(self) -> None:
        self.assertEqual(self.router.db_for_write(FtsOutbox), "default")

    def test_db_for_write_routes_pg_model(self) -> None:
        self.assertEqual(self.router.db_for_write(FtsOutboxPg), "postgresql")

    def test_db_for_read_routes_mysql_model(self) -> None:
        self.assertEqual(self.router.db_for_read(FtsOutbox), "default")

    def test_db_for_read_routes_pg_model(self) -> None:
        self.assertEqual(self.router.db_for_read(FtsOutboxPg), "postgresql")

    def test_allow_migrate_mysql_only_on_default(self) -> None:
        self.assertTrue(self.router.allow_migrate("default", "fts", "ftsoutbox"))
        self.assertFalse(self.router.allow_migrate("postgresql", "fts", "ftsoutbox"))

    def test_allow_migrate_pg_only_on_postgresql(self) -> None:
        self.assertTrue(self.router.allow_migrate("postgresql", "fts", "ftsoutboxpg"))
        self.assertFalse(self.router.allow_migrate("default", "fts", "ftsoutboxpg"))

    def test_allow_migrate_unknown_model_name_returns_none(self) -> None:
        """未知 model_name（非 fts 双表之一）交给后续路由器。"""
        self.assertIsNone(
            self.router.allow_migrate("default", "fts", "somefuturemodel"),
        )

    def test_allow_migrate_none_model_name_returns_none(self) -> None:
        """makemigrations state 检查场景 model_name=None。"""
        self.assertIsNone(self.router.allow_migrate("default", "fts"))

    def test_allow_migrate_non_fts_app_passes_through(self) -> None:
        self.assertIsNone(self.router.allow_migrate("default", "otherapp", "foo"))
        self.assertIsNone(self.router.allow_migrate("postgresql", "otherapp", "foo"))

    def test_allow_relation_returns_none(self) -> None:
        """Outbox 不声明跨库关系，交给后续路由器决定。"""
        self.assertIsNone(
            self.router.allow_relation(
                FtsOutbox(index_name="x", doc_id="y", action="upsert"),
                FtsOutboxPg(index_name="x", doc_id="y", action="upsert"),
            ),
        )

    def test_unrelated_model_returns_none(self) -> None:
        """非 fts app 的模型必须返回 None，让其他 Router 处理。"""
        class _OtherMeta:
            app_label = "someotherapp"
            model_name = "whatever"

        class _OtherModel:
            _meta = _OtherMeta

        self.assertIsNone(self.router.db_for_write(_OtherModel))
        self.assertIsNone(self.router.db_for_read(_OtherModel))

    def test_unregistered_fts_model_raises_improperly_configured(self) -> None:
        """fts app 下的未登记模型必须抛 ImproperlyConfigured（Review A6）。

        这是 fail-fast 设计：新模型漏登记不应默默落到 default 库，
        避免数据静默落错库的生产事故。
        """
        from django.core.exceptions import ImproperlyConfigured

        class _FutureMeta:
            app_label = "fts"
            model_name = "somenewmodel"

        class _FutureModel:
            _meta = _FutureMeta

        with self.assertRaises(ImproperlyConfigured):
            self.router.db_for_write(_FutureModel)
        with self.assertRaises(ImproperlyConfigured):
            self.router.db_for_read(_FutureModel)


# ── 2. Model Meta 结构测试 ──────────────────────────────────────
class FtsOutboxMetaTests(SimpleTestCase):
    """模型表名、字段、索引配置要符合 PRD 4.3.B。"""

    def test_mysql_outbox_table_name(self) -> None:
        self.assertEqual(FtsOutbox._meta.db_table, "fts_outbox")
        self.assertEqual(FtsOutbox._meta.app_label, "fts")

    def test_pg_outbox_table_name(self) -> None:
        self.assertEqual(FtsOutboxPg._meta.db_table, "fts_outbox_pg")
        self.assertEqual(FtsOutboxPg._meta.app_label, "fts")

    def test_required_fields_present(self) -> None:
        for model in (FtsOutbox, FtsOutboxPg):
            with self.subTest(model=model.__name__):
                fields = {f.name for f in model._meta.get_fields()}
                required = {
                    "id",
                    "index_name",
                    "doc_id",
                    "action",
                    "organization_id",
                    "created_at",
                    "processed_at",
                    "retry_count",
                    "last_error",
                }
                self.assertTrue(
                    required.issubset(fields),
                    msg=f"{model.__name__} 缺失字段: {required - fields}",
                )

    def test_organization_id_allows_null(self) -> None:
        """organization_id 必须 null=True（Review A7）。"""
        for model in (FtsOutbox, FtsOutboxPg):
            with self.subTest(model=model.__name__):
                f = model._meta.get_field("organization_id")
                self.assertTrue(f.null, f"{model.__name__}.organization_id 应 null=True")

    def test_action_choices_enum(self) -> None:
        from apps.fts.models import FtsOutboxBase

        self.assertEqual(FtsOutboxBase.Action.UPSERT, "upsert")
        self.assertEqual(FtsOutboxBase.Action.DELETE, "delete")

        # action 字段已绑定 choices
        f = FtsOutbox._meta.get_field("action")
        self.assertEqual(
            [c[0] for c in f.choices],
            ["upsert", "delete"],
        )

    def test_mysql_indexes_are_plain(self) -> None:
        indexes = FtsOutbox._meta.indexes
        self.assertEqual(len(indexes), 3)  # pending + idx_doc + wt_proc
        for idx in indexes:
            # MySQL 端不能有 partial index，condition 必须为 None/空
            condition = getattr(idx, "condition", None)
            self.assertIsNone(
                condition,
                msg=f"MySQL 索引不应带 condition: {idx.name} -> {condition}",
            )
        names = {idx.name for idx in indexes}
        self.assertIn("fts_outbox_wt_proc_idx", names)

    def test_pg_outbox_has_partial_pending_index(self) -> None:
        """PG 端 pending 索引必须是 partial（PRD 4.3.B），仅覆盖待处理行。"""
        indexes = FtsOutboxPg._meta.indexes
        self.assertEqual(len(indexes), 3)  # pending + idx_doc + wt_pending
        pending = next(
            (idx for idx in indexes if idx.name == "fts_outbox_pg_pending_idx"),
            None,
        )
        self.assertIsNotNone(pending, msg="未找到 fts_outbox_pg_pending_idx")
        condition = getattr(pending, "condition", None)
        self.assertIsNotNone(condition)
        # Django Q 对象 repr 包含 processed_at__isnull=True
        self.assertIn("processed_at__isnull", str(condition))

        wt_pending = next(
            (idx for idx in indexes if idx.name == "fts_outbox_pg_wt_pending_idx"),
            None,
        )
        self.assertIsNotNone(wt_pending, msg="未找到 fts_outbox_pg_wt_pending_idx（租户切片）")
        self.assertIn("processed_at__isnull", str(wt_pending.condition))


# ── 3. Migration 存在性测试 ────────────────────────────────────
class MigrationsExistTests(SimpleTestCase):
    """验证 migration 文件已落盘（避免 apps.py 默认迁移被误删）。"""

    def test_initial_migration_file_present(self) -> None:
        from pathlib import Path
        from apps import fts as fts_pkg

        migrations_dir = Path(fts_pkg.__file__).resolve().parent / "migrations"
        initial = migrations_dir / "0001_initial.py"
        self.assertTrue(initial.is_file(), msg=f"缺失 {initial}")
