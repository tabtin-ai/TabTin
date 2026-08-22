"""迁移 ``0054_clear_legacy_suggested_prompts`` 数据转换契约单测（无 DB）。

迁移本身的 schema 一致性由 ``makemigrations --check`` 守护；真迁移在双库的
apply 由受控流程执行。这里用 fake ``apps`` / ``schema_editor`` 直接驱动
``RunPython`` 回调，验证它的数据转换契约：

1. **PG 门闸**：非 ``postgresql`` alias 直接早退，不触碰任何 model；
2. **只清非空**：仅把非空 ``suggested_prompts`` 改成 ``[]``；
3. **幂等**：全空时不发起 ``bulk_update``（无写库）；
4. **批量**：通过 ``bulk_update(..., batch_size=500)`` 落库。
"""

from __future__ import annotations

from importlib import import_module
from types import SimpleNamespace

from django.test import SimpleTestCase


def _load_callable():
    mig = import_module(
        "apps.tabtinspace.migrations.0054_clear_legacy_suggested_prompts"
    )
    return mig.clear_legacy_suggested_prompts


class _FakeAgent:
    def __init__(self, agent_id, suggested_prompts):
        self.id = agent_id
        self.suggested_prompts = suggested_prompts


class _FakeQuerySet:
    def __init__(self, agents, bulk_update_calls):
        self._agents = agents
        self._bulk_update_calls = bulk_update_calls

    def only(self, *fields):
        return self

    def iterator(self):
        return iter(self._agents)

    def bulk_update(self, objs, fields, batch_size=None):
        self._bulk_update_calls.append(
            {"objs": list(objs), "fields": list(fields), "batch_size": batch_size}
        )


class _FakeManager:
    def __init__(self, agents):
        self._agents = agents
        self.bulk_update_calls = []

    def using(self, alias):
        return _FakeQuerySet(self._agents, self.bulk_update_calls)


def _make_apps(agents, get_model_calls=None):
    manager = _FakeManager(agents)
    agent_type = SimpleNamespace(objects=manager)

    def _get_model(app_label, model_name):
        if get_model_calls is not None:
            get_model_calls.append((app_label, model_name))
        return agent_type

    return SimpleNamespace(get_model=_get_model), manager


def _make_schema_editor(alias):
    return SimpleNamespace(connection=SimpleNamespace(alias=alias))


class ClearLegacySuggestedPromptsTests(SimpleTestCase):
    def test_non_postgresql_alias_is_a_noop(self):
        """PG 门闸：MySQL（migrate-all 跑 default 时）alias 直接早退，不取 model。"""
        fn = _load_callable()
        get_model_calls: list = []
        fake_apps, manager = _make_apps(
            [_FakeAgent("a1", ["旧推荐"])], get_model_calls=get_model_calls
        )

        fn(fake_apps, _make_schema_editor("default"))

        self.assertEqual(get_model_calls, [], "非 PG alias 不应触碰任何 model")
        self.assertEqual(manager.bulk_update_calls, [])

    def test_clears_only_non_empty_rows(self):
        """只把非空 suggested_prompts 清成 []，空/None 行保持不动。"""
        fn = _load_callable()
        a_nonempty1 = _FakeAgent("a1", ["问题一", "问题二"])
        a_empty = _FakeAgent("a2", [])
        a_nonempty2 = _FakeAgent("a3", ["问题三"])
        a_none = _FakeAgent("a4", None)
        fake_apps, manager = _make_apps(
            [a_nonempty1, a_empty, a_nonempty2, a_none]
        )

        fn(fake_apps, _make_schema_editor("postgresql"))

        self.assertEqual(len(manager.bulk_update_calls), 1)
        call = manager.bulk_update_calls[0]
        self.assertEqual(call["fields"], ["suggested_prompts"])
        self.assertEqual(call["batch_size"], 500)
        # 仅两条非空行进 update 集，且已被清空
        self.assertEqual(call["objs"], [a_nonempty1, a_nonempty2])
        self.assertEqual(a_nonempty1.suggested_prompts, [])
        self.assertEqual(a_nonempty2.suggested_prompts, [])
        # 空/None 行未被纳入，原值不动
        self.assertEqual(a_empty.suggested_prompts, [])
        self.assertIsNone(a_none.suggested_prompts)

    def test_all_empty_is_idempotent_no_write(self):
        """全空（含 None）→ 不发起 bulk_update，保证可重复执行无副作用。"""
        fn = _load_callable()
        fake_apps, manager = _make_apps([_FakeAgent("a1", []), _FakeAgent("a2", None)])

        fn(fake_apps, _make_schema_editor("postgresql"))

        self.assertEqual(manager.bulk_update_calls, [])
