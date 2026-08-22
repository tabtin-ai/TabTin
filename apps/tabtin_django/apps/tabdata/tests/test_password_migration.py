"""
Wave 5 §8 / §H — TableShare.password → password_hash 迁移单测。

settings_share_test 关掉了 ``MIGRATION_MODULES``，无法跑 ``call_command('migrate')``；
这里**直接调用 0036 migration 的 forward 函数**模拟一遍迁移过程。

由于真实生产 migration 跑在"历史 model"上（state_operations 把 password_hash 加到
TableShare 但 password 列仍未删除），我们用一个 ``_HistoricalAppsStub`` 提供一个
带 ``password`` + ``password_hash`` 两列的临时 model，让 forward 函数能像在
staging 那样找到 "旧明文"。

覆盖：
- forward 把 ``password`` 明文 → ``password_hash`` hash
- forward 把已经是合法 hash 的 ``password`` 原样搬到 ``password_hash``
- forward 不动 ``password=''`` 空值
- reverse 抛 RuntimeError
- 迁移完整链路：跑过 forward 后，原始明文仍能通过现行 model.check_password 验证
"""
from __future__ import annotations

import importlib
import uuid

from django.contrib.auth import get_user_model
from django.contrib.auth.hashers import identify_hasher, make_password
from django.test import TestCase

# migration 文件名以数字开头，不是合法 python identifier —— 用 importlib 加载。
migration_0036 = importlib.import_module(
    "apps.tabdata.migrations.0036_tableshare_password_hash",
)
from apps.tabdata.models import Table, TableShare, TableView


User = get_user_model()


class _HistoricalAppsStub:
    """模拟 Django migration 框架传入的 historical ``apps``。

    Django migration 跑 RunPython 时，``apps.get_model("tabdata", "TableShare")``
    返回 *历史模型*：state_operations 之后的快照。0036 把 AddField(password_hash)
    放在 RunPython 之前、RemoveField(password) 放在 RunPython 之后，所以历史
    model 同时有 password + password_hash 字段。

    单元测试里我们用真实 model（已没 password 字段）。本 stub 在内存中模拟一份
    带 password 的 dict 序列，让 forward 拿到 "旧明文"。
    """

    def __init__(self, instances: list[dict]):
        # instances: [{"id": ..., "password": "raw", "password_hash": ""}]
        self._instances = instances

    def get_model(self, app_label: str, model_name: str):
        assert (app_label, model_name) == ("tabdata", "TableShare")
        return _StubManagerOwner(self._instances)


class _StubManagerOwner:
    """模拟 TableShare 类的 ``.objects`` Manager。"""

    def __init__(self, instances: list[dict]):
        self._instances = instances

    @property
    def objects(self):
        return _StubManager(self._instances)


class _StubManager:
    def __init__(self, instances: list[dict]):
        self._instances = instances

    def using(self, alias: str):
        return self

    def all(self):
        return self

    def only(self, *fields):
        return self

    def iterator(self):
        for d in self._instances:
            yield _StubInstance(d)

    def bulk_update(self, items, fields):
        # items 是 _StubInstance list；fields 是 ["password_hash"]
        for it in items:
            self._instances[it._idx]["password_hash"] = it.password_hash


class _StubInstance:
    """模拟 historical TableShare 实例：可读 password + password_hash 字段。"""

    def __init__(self, d: dict):
        # 通过 list 上一对一的索引把 stub 实例和 _instances 中的 dict 对齐
        self._idx = d["__idx"]
        self.password = d["password"]
        self.password_hash = d.get("password_hash", "")


def _make_historical(instances: list[dict]) -> _HistoricalAppsStub:
    """给每条记录注入 __idx 让 bulk_update 能找回原 dict。"""
    for i, d in enumerate(instances):
        d["__idx"] = i
    return _HistoricalAppsStub(instances)


class _FakeSchemaEditor:
    def __init__(self, alias: str):
        class _Conn:
            def __init__(self, a):
                self.alias = a
        self.connection = _Conn(alias)


class PasswordMigrationForwardTests(TestCase):

    def test_plaintext_values_get_hashed(self):
        """旧 password 明文应被 make_password 化写入 password_hash。"""
        records = [
            {"id": uuid.uuid4(), "password": "raw_plain_1", "password_hash": ""},
            {"id": uuid.uuid4(), "password": "another_secret", "password_hash": ""},
            {"id": uuid.uuid4(), "password": "", "password_hash": ""},
        ]
        apps_stub = _make_historical(records)

        migration_0036._forward_hash_passwords(
            apps_stub, _FakeSchemaEditor(alias="postgresql"),
        )

        # 两个明文已经被 hash
        identify_hasher(records[0]["password_hash"])
        identify_hasher(records[1]["password_hash"])
        # 空值保持空
        self.assertEqual(records[2]["password_hash"], "")

        # 用真实 model.check_password 验证 hash 与原始明文匹配
        ts = TableShare()
        ts.password_hash = records[0]["password_hash"]
        self.assertTrue(ts.check_password("raw_plain_1"))
        self.assertFalse(ts.check_password("wrong"))

        ts2 = TableShare()
        ts2.password_hash = records[1]["password_hash"]
        self.assertTrue(ts2.check_password("another_secret"))

    def test_already_hashed_values_passthrough(self):
        """password 字段里若已是合法 hash，原样搬过去（不再二次 hash）。"""
        existing_hash = make_password("preserved")
        records = [
            {"id": uuid.uuid4(), "password": existing_hash, "password_hash": ""},
        ]
        apps_stub = _make_historical(records)

        migration_0036._forward_hash_passwords(
            apps_stub, _FakeSchemaEditor(alias="postgresql"),
        )

        self.assertEqual(records[0]["password_hash"], existing_hash)

        ts = TableShare()
        ts.password_hash = records[0]["password_hash"]
        self.assertTrue(ts.check_password("preserved"))


class PasswordMigrationReverseTests(TestCase):

    def test_reverse_raises_runtime_error(self):
        reverse = migration_0036._reverse_non_reversible
        with self.assertRaises(RuntimeError) as cm:
            reverse(None, _FakeSchemaEditor(alias="postgresql"))
        self.assertIn("non-reversible", str(cm.exception))


class TableShareModelHashContractTests(TestCase):
    """字段重命名后 model 的 set_password / check_password / has_password 契约。"""

    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from django.db.models.signals import post_save
        from apps.tabtinspace.signals import create_default_organization
        post_save.disconnect(create_default_organization, sender=User)
        cls._disconnected_signal = (post_save, create_default_organization)

    @classmethod
    def tearDownClass(cls):
        sig, fn = cls._disconnected_signal
        sig.connect(fn, sender=User)
        super().tearDownClass()

    def setUp(self):
        self.user = User.objects.create_user(
            username="pmctuser", email="pmct@example.com", password="x",
        )
        self.table = Table.objects.using("postgresql").create(
            name="pmct_table",
            organization_id=uuid.uuid4(),
            space_id=uuid.uuid4(),
            owner_id=self.user.id,
        )
        self.view = TableView.objects.using("postgresql").create(
            table=self.table, name="form_view", view_type="form",
        )

    def test_set_password_writes_password_hash(self):
        share = TableShare.objects.using("postgresql").create(
            table=self.table, view=self.view,
            share_id=uuid.uuid4().hex[:16],
            created_by=self.user,
        )
        share.set_password("secret")
        share.save(using="postgresql", update_fields=["password_hash"])
        share.refresh_from_db()
        self.assertNotEqual(share.password_hash, "")
        self.assertTrue(share.check_password("secret"))
        self.assertFalse(share.check_password("nope"))

    def test_set_password_empty_clears_password_hash(self):
        share = TableShare.objects.using("postgresql").create(
            table=self.table, view=self.view,
            share_id=uuid.uuid4().hex[:16],
            created_by=self.user,
        )
        share.set_password("abc")
        share.save(using="postgresql", update_fields=["password_hash"])
        share.set_password("")
        self.assertEqual(share.password_hash, "")

    def test_has_password_property(self):
        share = TableShare.objects.using("postgresql").create(
            table=self.table, view=self.view,
            share_id=uuid.uuid4().hex[:16],
            created_by=self.user,
        )
        self.assertFalse(share.has_password)
        share.set_password("abc")
        share.save(using="postgresql", update_fields=["password_hash"])
        self.assertTrue(share.has_password)
