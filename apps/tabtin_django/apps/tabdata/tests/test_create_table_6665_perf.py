"""#6665：建表关键路径的源码契约（不依赖完整 migrate）。"""

from pathlib import Path

from django.test import SimpleTestCase


class CreateTable6665PerfContractTests(SimpleTestCase):
    def test_resource_bridge_on_create_uses_on_commit(self):
        src = Path(__file__).resolve().parents[1] / "services" / "table_service.py"
        text = src.read_text(encoding="utf-8")
        create_fn = text.split("def create_table(", 1)[1].split("\n    def ", 1)[0]
        self.assertIn("transaction.on_commit(", create_fn)
        self.assertIn("ResourceBridge.on_create(", create_fn)
        self.assertIn("using=TABDATA_DB_ALIAS", create_fn)
        # 不得再在事务内同步调用（旧路径会拉长 Organization 行锁）
        sync_call = "ResourceBridge.on_create(table, user=self.user, collection_id=collection_uuid)"
        self.assertNotIn(sync_call, create_fn)

    def test_native_ensure_batches_extra_fields_into_create_table(self):
        src = Path(__file__).resolve().parents[1] / "services" / "table_service.py"
        text = src.read_text(encoding="utf-8")
        ensure_fn = text.split("def _native_ensure_table(", 1)[1].split("\n    def ", 1)[0]
        self.assertIn("extra_fields=user_fields", ensure_fn)
        self.assertNotIn("ddl.add_column(", ensure_fn)

    def test_ddl_manager_caches_ensured_schemas(self):
        src = Path(__file__).resolve().parents[1] / "native" / "ddl_manager.py"
        text = src.read_text(encoding="utf-8")
        self.assertIn("_ENSURED_SCHEMAS", text)
        self.assertIn("if schema in _ENSURED_SCHEMAS:", text)
        self.assertIn("_ENSURED_SCHEMAS.discard(schema)", text)
