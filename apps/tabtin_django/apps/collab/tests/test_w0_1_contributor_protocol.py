"""W0-1 Charter CC-1 / CC-2 / CC-3 单元测试。

覆盖 :class:`apps.collab.adapters.base.CollabAdapter.preview_restore`
默认实现 + ResourceContributor / ImpactContributor 协议 + 注册中心 +
build_checkpoint_impact 集成 + daemon_checkpoint_service._create_space_checkpoint
集成。验收要点（Charter §6 + 用户验收清单）::

    CC-1:
      - default returns Charter §3.4 schema with all-zero values
      - subclass override is honored

    CC-2:
      - 多 contributor 注册 + 收集顺序无关
      - 失败 contributor 不影响其他 contributor 收集（隔离性）
      - 没有 contributor 注册时不影响现有路径（向后兼容）
      - 注册中心 register / iter / clear / unregister 行为正确

    CC-3:
      - build_checkpoint_impact 注册 contributor 后输出含模块键
      - 没有 contributor 时输出 dict 不含模块键（向后兼容）
      - contributor 失败 / 返回 None / 返回空 dict 都不污染输出
      - 模块名 collision 时后注册者覆盖且打 warning

    Daemon 集成:
      - _create_space_checkpoint 把 contributor 输出合并入 version_refs
      - 没有 contributor 注册时 version_refs 行为完全不变
"""
from __future__ import annotations

import os
import uuid
from typing import Any, List, Mapping, Optional
from unittest.mock import MagicMock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402

django.setup()

import pytest  # noqa: E402

from apps.collab.adapters.base import CollabAdapter  # noqa: E402
from apps.collab.services.contributors import (  # noqa: E402
    ImpactContributor,
    ResourceContributor,
    ResourceRef,
    _clear_impact_contributors,
    _clear_resource_contributors,
    collect_contributed_impact,
    collect_contributed_resources,
    expand_agent_run_ids,
    iter_impact_contributors,
    iter_resource_contributors,
    register_impact_contributor,
    register_resource_contributor,
    unregister_impact_contributor,
    unregister_resource_contributor,
)


# ── Fixtures ──────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _reset_contributor_registries():
    """每个用例前后都清空注册中心，避免相互污染。"""
    _clear_resource_contributors()
    _clear_impact_contributors()
    yield
    _clear_resource_contributors()
    _clear_impact_contributors()


# ── 共享 stub adapter ─────────────────────────────────────


class _MinimalAdapter(CollabAdapter):
    """最小可实例化的 CollabAdapter，用于 CC-1 默认实现验证。

    复刻自 ``test_version_history_service.MockAdapter`` 但不依赖该模块，避免
    测试间隐式耦合。仅实现 abstract 必填项，preview_restore 故意不 override
    以验证默认实现。
    """

    resource_type = "test"

    def serialize_snapshot(self, data):
        return self.compress_json(data)

    def deserialize_snapshot(self, blob):
        return self.decompress_json(blob)

    def compute_diff(self, base_data, current_data):
        return None

    def apply_diff(self, base_data, diff_blob):
        return base_data

    def get_resource(self, resource_id):
        return None

    def check_permission(self, user, resource, action="edit"):
        return True

    def build_snapshot(self, resource):
        return {}

    def persist_changes(self, resource, changes, editor_info):
        return {}

    def restore(self, resource, data, *, prepared=None, user=None):
        return None


# ══════════════════════════════════════════════════════════
# CC-1: CollabAdapter.preview_restore 默认实现 + 子类 override
# ══════════════════════════════════════════════════════════


class TestCC1PreviewRestoreDefault:
    """默认实现返回 Charter §3.4 schema 的全零空摘要。"""

    def test_default_returns_charter_schema(self):
        adapter = _MinimalAdapter()
        result = adapter.preview_restore(resource=object(), target_data={"any": 1})
        assert result == {
            "records_to_restore": 0,
            "records_to_create": 0,
            "records_to_delete": 0,
            "fields_to_restore": [],
            "estimated_duration_ms": 0,
        }

    def test_default_accepts_prepared_kwarg(self):
        """prepared 是可选关键字参数，与 restore() 对称。"""
        adapter = _MinimalAdapter()
        result = adapter.preview_restore(
            resource=object(), target_data={}, prepared={"foo": "bar"},
        )
        assert result["records_to_restore"] == 0

    def test_default_keys_are_safe_to_get(self):
        """默认实现保证调用方可安全 .get(key, default) 取值。"""
        adapter = _MinimalAdapter()
        result = adapter.preview_restore(resource=object(), target_data={})
        for key in (
            "records_to_restore",
            "records_to_create",
            "records_to_delete",
            "fields_to_restore",
            "estimated_duration_ms",
        ):
            assert key in result


class TestCC1PreviewRestoreOverride:
    """子类按 Charter §3.4 schema 真实计算，override 必须生效。"""

    def test_subclass_override_replaces_default(self):
        class FancyAdapter(_MinimalAdapter):
            def preview_restore(self, resource, target_data, *, prepared=None):
                return {
                    "records_to_restore": 1203,
                    "records_to_create": 0,
                    "records_to_delete": 5,
                    "fields_to_restore": ["fld_xxx"],
                    "estimated_duration_ms": 2000,
                }

        adapter = FancyAdapter()
        result = adapter.preview_restore(resource=object(), target_data={})
        assert result["records_to_restore"] == 1203
        assert result["fields_to_restore"] == ["fld_xxx"]

    def test_subclass_can_use_prepared_kwarg(self):
        captured: dict = {}

        class PreparedAwareAdapter(_MinimalAdapter):
            def preview_restore(self, resource, target_data, *, prepared=None, user=None):
                captured["prepared"] = prepared
                return {
                    "records_to_restore": 0,
                    "records_to_create": 0,
                    "records_to_delete": 0,
                    "fields_to_restore": [],
                    "estimated_duration_ms": 0,
                }

        adapter = PreparedAwareAdapter()
        adapter.preview_restore(resource=object(), target_data={}, prepared={"x": 1})
        assert captured["prepared"] == {"x": 1}

    def test_subclass_can_use_user_kwarg(self):
        """user 参数与 restore() 对称——支持权限相关的预览过滤。"""
        captured: dict = {}

        class UserAwareAdapter(_MinimalAdapter):
            def preview_restore(self, resource, target_data, *, prepared=None, user=None):
                captured["user"] = user
                return {
                    "records_to_restore": 0,
                    "records_to_create": 0,
                    "records_to_delete": 0,
                    "fields_to_restore": [],
                    "estimated_duration_ms": 0,
                }

        adapter = UserAwareAdapter()
        sentinel_user = object()
        adapter.preview_restore(resource=object(), target_data={}, user=sentinel_user)
        assert captured["user"] is sentinel_user

    def test_default_can_be_called_with_user_kwarg(self):
        """默认实现接受 user 参数但忽略它。"""
        adapter = _MinimalAdapter()
        result = adapter.preview_restore(
            resource=object(), target_data={}, user=object(),
        )
        assert result["records_to_restore"] == 0

    def test_default_returns_fresh_dict_each_call(self):
        """默认实现每次返回新的 dict，避免子类污染单例默认值。"""
        adapter = _MinimalAdapter()
        r1 = adapter.preview_restore(resource=object(), target_data={})
        r2 = adapter.preview_restore(resource=object(), target_data={})
        assert r1 is not r2
        # 修改 r1 不影响 r2
        r1["records_to_restore"] = 999
        assert r2["records_to_restore"] == 0


# ══════════════════════════════════════════════════════════
# CC-2: ResourceContributor 协议 + 注册中心
# ══════════════════════════════════════════════════════════


class _StubResourceContributor:
    """测试用桩 contributor，记录被调用的 agent_run_ids 并按构造参数返回。"""

    def __init__(
        self,
        name: str,
        refs: List[ResourceRef],
        raise_exc: Optional[BaseException] = None,
    ):
        self.name = name
        self._refs = refs
        self._raise_exc = raise_exc
        self.calls: List[List[str]] = []

    def collect_resources(self, agent_run_ids: List[str]) -> List[ResourceRef]:
        self.calls.append(list(agent_run_ids))
        if self._raise_exc:
            raise self._raise_exc
        return list(self._refs)


class TestCC2RegistryBasics:
    """register / iter / clear / unregister 行为正确。"""

    def test_register_increases_iter_count(self):
        c1 = _StubResourceContributor("tabdata", [])
        c2 = _StubResourceContributor("tabdoc", [])
        register_resource_contributor(c1)
        register_resource_contributor(c2)
        assert len(iter_resource_contributors()) == 2

    def test_iter_returns_snapshot_not_live_view(self):
        c1 = _StubResourceContributor("tabdata", [])
        register_resource_contributor(c1)
        snapshot = iter_resource_contributors()
        _clear_resource_contributors()
        # 修改注册中心后 snapshot 不变
        assert len(snapshot) == 1

    def test_register_same_name_overrides(self):
        c1 = _StubResourceContributor("tabdata", [])
        c2 = _StubResourceContributor("tabdata", [])
        register_resource_contributor(c1)
        register_resource_contributor(c2)
        assert iter_resource_contributors() == [c2]

    def test_unregister_removes_only_named(self):
        c1 = _StubResourceContributor("tabdata", [])
        c2 = _StubResourceContributor("tabdoc", [])
        register_resource_contributor(c1)
        register_resource_contributor(c2)
        unregister_resource_contributor("tabdata")
        remaining = iter_resource_contributors()
        assert remaining == [c2]

    def test_unregister_unknown_silent(self):
        unregister_resource_contributor("ghost")  # 不抛

    def test_register_rejects_missing_name(self):
        class _NoName:
            name = ""

            def collect_resources(self, agent_run_ids):
                return []

        with pytest.raises(ValueError, match="non-empty 'name'"):
            register_resource_contributor(_NoName())

    def test_protocol_runtime_check(self):
        """``ResourceContributor`` 是 ``runtime_checkable`` Protocol。"""
        c = _StubResourceContributor("tabdata", [])
        assert isinstance(c, ResourceContributor)


class TestCC2CollectContributedResources:
    """collect_contributed_resources 的合并 / 隔离 / 兼容语义。"""

    def _ref(self, rt: str, rid: Optional[str] = None, vid: Optional[str] = None) -> ResourceRef:
        return {
            "resource_type": rt,
            "resource_id": rid or str(uuid.uuid4()),
            "version_history_id": vid or str(uuid.uuid4()),
        }

    def test_no_contributors_returns_empty(self):
        """向后兼容：未注册任何 contributor 时返回空 list。"""
        assert collect_contributed_resources(["run-1"]) == []

    def test_single_contributor_returns_refs(self):
        ref = self._ref("table")
        register_resource_contributor(_StubResourceContributor("tabdata", [ref]))
        result = collect_contributed_resources(["run-1"])
        assert result == [ref]

    def test_contributor_called_with_agent_run_ids(self):
        c = _StubResourceContributor("tabdata", [])
        register_resource_contributor(c)
        collect_contributed_resources(["run-1", "run-2"])
        assert c.calls == [["run-1", "run-2"]]

    def test_contributor_filters_invalid_run_ids(self):
        """非 str / 空串的 run id 会被过滤后再透传给 contributor。"""
        c = _StubResourceContributor("tabdata", [])
        register_resource_contributor(c)
        collect_contributed_resources(["run-1", "", None, 42, "run-2"])  # type: ignore[list-item]
        assert c.calls == [["run-1", "run-2"]]

    def test_multiple_contributors_aggregate(self):
        ref_a = self._ref("table")
        ref_b = self._ref("docs")
        register_resource_contributor(_StubResourceContributor("tabdata", [ref_a]))
        register_resource_contributor(_StubResourceContributor("tabdoc", [ref_b]))
        result = collect_contributed_resources(["run-1"])
        assert len(result) == 2
        keys = {f"{r['resource_type']}:{r['resource_id']}" for r in result}
        assert keys == {
            f"table:{ref_a['resource_id']}",
            f"docs:{ref_b['resource_id']}",
        }

    def test_collection_order_independent(self):
        """注册顺序不同，但只要 contributor 返回相同数据，最终合并 dict 一致。"""
        ref_a = self._ref("table", rid="rid-a", vid="vh-a")
        ref_b = self._ref("docs", rid="rid-b", vid="vh-b")

        register_resource_contributor(_StubResourceContributor("tabdata", [ref_a]))
        register_resource_contributor(_StubResourceContributor("tabdoc", [ref_b]))
        result_1 = collect_contributed_resources(["r"])

        _clear_resource_contributors()
        register_resource_contributor(_StubResourceContributor("tabdoc", [ref_b]))
        register_resource_contributor(_StubResourceContributor("tabdata", [ref_a]))
        result_2 = collect_contributed_resources(["r"])

        # 顺序无关：按 (resource_type, resource_id) key 集合相等
        assert {(r["resource_type"], r["resource_id"]) for r in result_1} == \
               {(r["resource_type"], r["resource_id"]) for r in result_2}

    def test_failure_isolation(self):
        """一个 contributor 抛异常，其他 contributor 仍正常返回结果。"""
        ref = self._ref("docs")
        register_resource_contributor(_StubResourceContributor(
            "tabdata", [], raise_exc=RuntimeError("boom"),
        ))
        register_resource_contributor(_StubResourceContributor("tabdoc", [ref]))
        result = collect_contributed_resources(["run-1"])
        assert result == [ref]

    def test_malformed_refs_skipped(self):
        """contributor 返回非法 dict（缺字段）时该条目被丢弃，其他正常。"""
        good = self._ref("table")
        bad_missing_field: Any = {"resource_type": "docs"}
        bad_empty_id: Any = {
            "resource_type": "table",
            "resource_id": "",
            "version_history_id": "vh-1",
        }
        register_resource_contributor(_StubResourceContributor(
            "tabdata", [good, bad_missing_field, bad_empty_id],
        ))
        result = collect_contributed_resources(["run-1"])
        assert result == [good]

    def test_duplicate_key_later_wins(self):
        """同 (resource_type, resource_id) 重复出现时，后注册者覆盖。"""
        rid = str(uuid.uuid4())
        early = self._ref("table", rid=rid, vid="vh-early")
        late = self._ref("table", rid=rid, vid="vh-late")
        register_resource_contributor(_StubResourceContributor("tabdata", [early]))
        register_resource_contributor(_StubResourceContributor("tabdoc", [late]))
        result = collect_contributed_resources(["run-1"])
        assert len(result) == 1
        assert result[0]["version_history_id"] == "vh-late"


# ══════════════════════════════════════════════════════════
# CC-3: ImpactContributor 协议 + 注册中心 + build_checkpoint_impact 集成
# ══════════════════════════════════════════════════════════


class _StubImpactContributor:
    """测试用桩 impact contributor。"""

    def __init__(
        self,
        name: str,
        impact: Optional[Mapping[str, Any]],
        raise_exc: Optional[BaseException] = None,
    ):
        self.name = name
        self._impact = impact
        self._raise_exc = raise_exc
        self.calls: List[List[str]] = []

    def collect_impact(self, agent_run_ids: List[str]) -> Optional[Mapping[str, Any]]:
        self.calls.append(list(agent_run_ids))
        if self._raise_exc:
            raise self._raise_exc
        return self._impact


class TestCC3RegistryBasics:
    """ImpactContributor 注册中心和 ResourceContributor 对称。"""

    def test_register_iter_clear(self):
        c = _StubImpactContributor("tabdata", {"any": 1})
        register_impact_contributor(c)
        assert iter_impact_contributors() == [c]
        _clear_impact_contributors()
        assert iter_impact_contributors() == []

    def test_unregister(self):
        c = _StubImpactContributor("tabdata", {"any": 1})
        register_impact_contributor(c)
        unregister_impact_contributor("tabdata")
        assert iter_impact_contributors() == []

    def test_register_rejects_missing_name(self):
        class _NoName:
            name = None

            def collect_impact(self, agent_run_ids):
                return None

        with pytest.raises(ValueError, match="non-empty 'name'"):
            register_impact_contributor(_NoName())  # type: ignore[arg-type]

    def test_protocol_runtime_check(self):
        c = _StubImpactContributor("tabdata", {"x": 1})
        assert isinstance(c, ImpactContributor)


class TestCC3CollectContributedImpact:
    """collect_contributed_impact 的合并 / 隔离 / 兼容语义。"""

    def test_no_contributors_returns_empty(self):
        assert collect_contributed_impact(["run-1"]) == {}

    def test_single_contributor_routed_by_name(self):
        register_impact_contributor(_StubImpactContributor(
            "tabdata", {"tables_affected": [{"id": "tbl_x"}]},
        ))
        result = collect_contributed_impact(["run-1"])
        assert "tabdata" in result
        assert result["tabdata"]["tables_affected"][0]["id"] == "tbl_x"

    def test_multiple_contributors_aggregate(self):
        register_impact_contributor(_StubImpactContributor("tabdata", {"a": 1}))
        register_impact_contributor(_StubImpactContributor("tabdoc", {"b": 2}))
        result = collect_contributed_impact(["run-1"])
        assert result == {"tabdata": {"a": 1}, "tabdoc": {"b": 2}}

    def test_none_skipped(self):
        """contributor 返回 None 表示无贡献，不进 output。"""
        register_impact_contributor(_StubImpactContributor("tabdata", None))
        register_impact_contributor(_StubImpactContributor("tabdoc", {"b": 2}))
        result = collect_contributed_impact(["run-1"])
        assert result == {"tabdoc": {"b": 2}}

    def test_empty_dict_skipped(self):
        """contributor 返回空 dict 表示无贡献，不进 output。"""
        register_impact_contributor(_StubImpactContributor("tabdata", {}))
        result = collect_contributed_impact(["run-1"])
        assert result == {}

    def test_failure_isolation(self):
        register_impact_contributor(_StubImpactContributor(
            "tabdata", None, raise_exc=RuntimeError("boom"),
        ))
        register_impact_contributor(_StubImpactContributor("tabdoc", {"b": 2}))
        result = collect_contributed_impact(["run-1"])
        assert result == {"tabdoc": {"b": 2}}

    def test_non_mapping_skipped(self):
        register_impact_contributor(_StubImpactContributor(
            "tabdata", "not a dict",  # type: ignore[arg-type]
        ))
        result = collect_contributed_impact(["run-1"])
        assert result == {}


class TestCC3BuildCheckpointImpactIntegration:
    """build_checkpoint_impact 调用 ImpactContributor 路由。"""

    @staticmethod
    def _make_changelog_qs(rows: Optional[List[dict]] = None):
        """构造 ChangeLog queryset mock。

        ``ChangeLog`` 在 build_checkpoint_impact 内部 lazy import，因此必须 patch
        源头模块 ``apps.collab.models.ChangeLog``。
        """
        rows = rows or []
        qs = MagicMock()
        qs.filter.return_value = qs
        qs.count.return_value = len(rows)
        # 切片 [:max_changelogs] 返回 list 即可
        qs.values.return_value = rows
        return qs

    def test_no_contributors_omits_module_keys(self):
        """向后兼容：未注册 contributor 时 impact dict 不含模块键。"""
        from apps.collab.services.checkpoint_context import build_checkpoint_impact

        with patch("apps.collab.models.ChangeLog") as mock_cl:
            qs = self._make_changelog_qs()
            mock_cl.objects.using.return_value.filter.return_value = qs

            impact = build_checkpoint_impact(agent_run_id="run-1")

        # 没有任何模块键
        assert "tabdata" not in impact
        assert "tabdoc" not in impact
        # 也不含 resources / files（changelog 为空 + 无 changed_files）
        assert "resources" not in impact
        assert "files" not in impact

    def test_with_contributor_adds_module_key(self):
        from apps.collab.services.checkpoint_context import build_checkpoint_impact

        register_impact_contributor(_StubImpactContributor(
            "tabdata", {"tables_affected": [{"id": "tbl_x", "n": 1203}]},
        ))

        with patch("apps.collab.models.ChangeLog") as mock_cl:
            qs = self._make_changelog_qs()
            mock_cl.objects.using.return_value.filter.return_value = qs

            impact = build_checkpoint_impact(agent_run_id="run-1")

        assert "tabdata" in impact
        assert impact["tabdata"]["tables_affected"][0]["n"] == 1203

    def test_contributor_failure_does_not_break_legacy_fields(self):
        """contributor 抛异常时 resources / files 既有维度仍正常输出。"""
        from apps.collab.services.checkpoint_context import build_checkpoint_impact

        register_impact_contributor(_StubImpactContributor(
            "tabdata", None, raise_exc=RuntimeError("boom"),
        ))

        with patch("apps.collab.models.ChangeLog") as mock_cl:
            qs = self._make_changelog_qs(rows=[{
                "resource_type": "table",
                "resource_id": uuid.uuid4(),
                "change_type": "update",
                "summary": "改了 1 行",
            }])
            mock_cl.objects.using.return_value.filter.return_value = qs

            impact = build_checkpoint_impact(
                agent_run_id="run-1",
                changed_files=["a.py", "b.py"],
            )

        # 既有维度未被破坏
        assert "resources" in impact
        assert impact["resources_total_count"] == 1
        assert impact["files"] == ["a.py", "b.py"]
        assert impact["files_total_count"] == 2
        # 失败 contributor 不出现在输出
        assert "tabdata" not in impact

    def test_contributor_dict_is_copied(self):
        """contributor 返回的 dict 被复制入 impact，避免外部修改污染。"""
        from apps.collab.services.checkpoint_context import build_checkpoint_impact

        original = {"a": 1, "b": [1, 2, 3]}
        register_impact_contributor(_StubImpactContributor("tabdata", original))

        with patch("apps.collab.models.ChangeLog") as mock_cl:
            qs = self._make_changelog_qs()
            mock_cl.objects.using.return_value.filter.return_value = qs

            impact = build_checkpoint_impact(agent_run_id="run-1")

        # 顶层 dict 是独立的
        assert impact["tabdata"] is not original


# ══════════════════════════════════════════════════════════
# Daemon 集成: _create_space_checkpoint 合并 contributor → version_refs
# ══════════════════════════════════════════════════════════


class TestCC2DaemonCheckpointIntegration:
    """``_create_space_checkpoint`` 调用 ResourceContributor 合并入 version_refs。"""

    def _setup_daemon_mocks(self, contributor_refs: Optional[List[ResourceRef]] = None):
        """为 _create_space_checkpoint 准备所有外部依赖 mock。

        返回 (mock_sc_create, version_refs_captured, mock_vh_filter_update)
        让用例验证最终写入 SpaceCheckpoint 的 version_refs。
        """
        captured: dict = {"version_refs": None, "extra_kwargs": None}

        def _sc_create(**kwargs):
            captured["version_refs"] = dict(kwargs.get("version_refs") or {})
            captured["extra_kwargs"] = kwargs
            cp = MagicMock()
            cp.id = uuid.uuid4()
            return cp

        return captured, _sc_create

    def _run_create_space_checkpoint(
        self,
        captured: dict,
        sc_create_fn,
        contributor_refs: Optional[List[ResourceRef]] = None,
        vh_distinct=None,
        latest_vh_id: Optional[uuid.UUID] = None,
    ):
        """实际执行 _create_space_checkpoint，patch 所有 DB 依赖。

        SpaceCheckpoint / VersionHistory / ContextItem / Space 都在
        ``_create_space_checkpoint`` 内部 lazy import，因此必须 patch 源模块。
        """
        from apps.services.agent_engine.services import daemon_checkpoint_service as svc

        if contributor_refs:
            register_resource_contributor(_StubResourceContributor(
                "tabdata", contributor_refs,
            ))

        space_id = str(uuid.uuid4())

        with patch("apps.collab.models.SpaceCheckpoint") as mock_sc, \
             patch("apps.collab.models.VersionHistory") as mock_vh, \
             patch("apps.tabtinspace.models.ContextItem") as mock_ci, \
             patch("apps.tabtinspace.models.Space") as mock_space, \
             patch("django.db.transaction.atomic") as mock_atomic:
            mock_atomic.return_value.__enter__ = MagicMock(return_value=None)
            mock_atomic.return_value.__exit__ = MagicMock(return_value=False)

            # Space.objects.using(...).filter(...).values(...).first()
            mock_space.objects.using.return_value.filter.return_value.values.return_value.first.return_value = {
                "organization_id": uuid.uuid4(),
            }

            # ContextItem.objects.using(...).filter(...).exclude(...).values_list(...).distinct()
            ci_chain = mock_ci.objects.using.return_value
            ci_chain.filter.return_value.exclude.return_value.values_list.return_value.distinct.return_value = []

            # VersionHistory：用 side_effect 区分多个 filter 调用模式
            vh_chain = mock_vh.objects.using.return_value
            distinct_qs = MagicMock()
            distinct_qs.values.return_value.distinct.return_value = vh_distinct or []

            def vh_filter_side_effect(*args, **kwargs):
                # 取最新 VH：filter(resource_type=..., resource_id=...)
                if "resource_type" in kwargs and "resource_id" in kwargs:
                    qs = MagicMock()
                    qs.order_by.return_value.values_list.return_value.first.return_value = (
                        latest_vh_id
                    )
                    return qs
                # 保护 expired_at 路径：filter(id__in=...)
                if "id__in" in kwargs:
                    qs = MagicMock()
                    qs.values_list.return_value = []
                    qs.update.return_value = 0
                    return qs
                # distinct 路径：filter(resource_id__in=...)
                return distinct_qs

            vh_chain.filter.side_effect = vh_filter_side_effect

            # SpaceCheckpoint.objects.using(...).filter(...).exists() / .create(...)
            sc_chain = mock_sc.objects.using.return_value
            sc_chain.filter.return_value.exists.return_value = False
            sc_chain.create.side_effect = sc_create_fn

            svc._create_space_checkpoint(
                space_id=space_id,
                file_checkpoint_hash="abc123",
                agent_run_id="run-1",
                message_id=None,  # 跳过 enrich 路径，专注 contributor 验证
            )

        return captured

    def test_no_contributor_no_version_refs_change(self):
        """向后兼容：未注册 contributor 时 version_refs 完全由原路径产生。"""
        captured, sc_create_fn = self._setup_daemon_mocks()
        self._run_create_space_checkpoint(captured, sc_create_fn)
        # 没有 ContextItem，没有 contributor → version_refs 应为空 dict
        assert captured["version_refs"] == {}

    def test_contributor_refs_merged_into_version_refs(self):
        """contributor 输出合并入 version_refs（按 resource_type:resource_id key）。"""
        captured, sc_create_fn = self._setup_daemon_mocks()
        rid = str(uuid.uuid4())
        vid = str(uuid.uuid4())
        contributor_refs: List[ResourceRef] = [{
            "resource_type": "table",
            "resource_id": rid,
            "version_history_id": vid,
        }]
        self._run_create_space_checkpoint(
            captured, sc_create_fn, contributor_refs=contributor_refs,
        )
        assert captured["version_refs"] == {f"table:{rid}": vid}

    def test_invalid_vh_id_does_not_crash(self):
        """contributor 给出非法 UUID 时不影响 SpaceCheckpoint 创建（仅跳过保护逻辑）。"""
        captured, sc_create_fn = self._setup_daemon_mocks()
        rid = str(uuid.uuid4())
        contributor_refs: List[ResourceRef] = [{
            "resource_type": "table",
            "resource_id": rid,
            "version_history_id": "not-a-uuid",
        }]
        self._run_create_space_checkpoint(
            captured, sc_create_fn, contributor_refs=contributor_refs,
        )
        # 仍写入了 version_refs（只是 vh_ids 保护逻辑跳过了非法 UUID）
        assert captured["version_refs"] == {f"table:{rid}": "not-a-uuid"}


# ══════════════════════════════════════════════════════════
# Review 修复：expand_agent_run_ids + 跨路径契约一致性
# ══════════════════════════════════════════════════════════


class TestCC2ExpandAgentRunIds:
    """W0-1 修复 P0-B：daemon / HTTP / build_checkpoint_impact 三路径
    必须通过 expand_agent_run_ids 展开级联，与 Charter §3.2 契约对齐。
    """

    def test_empty_returns_empty(self):
        assert expand_agent_run_ids("") == []

    def test_resolve_success_returns_cascade(self):
        with patch("apps.collab.api._resolve_cascading_run_ids") as mock_resolve:
            mock_resolve.return_value = ["run-1", "run-1-sub-a", "run-1-sub-b"]
            result = expand_agent_run_ids("run-1")
        assert result == ["run-1", "run-1-sub-a", "run-1-sub-b"]

    def test_resolve_exception_falls_back_to_single(self):
        """fail-safe：_resolve_cascading_run_ids 抛异常时退回 [agent_run_id]。"""
        with patch("apps.collab.api._resolve_cascading_run_ids") as mock_resolve:
            mock_resolve.side_effect = RuntimeError("boom")
            result = expand_agent_run_ids("run-1")
        assert result == ["run-1"]

    def test_daemon_passes_expanded_run_ids_to_contributor(self):
        """daemon _create_space_checkpoint 调用 contributor 时应传含级联的全量 run id。"""
        from apps.services.agent_engine.services import daemon_checkpoint_service as svc

        capture_contributor = _StubResourceContributor("tabdata", [])
        register_resource_contributor(capture_contributor)

        space_id = str(uuid.uuid4())

        with patch("apps.collab.models.SpaceCheckpoint") as mock_sc, \
             patch("apps.collab.models.VersionHistory") as mock_vh, \
             patch("apps.tabtinspace.models.ContextItem") as mock_ci, \
             patch("apps.tabtinspace.models.Space") as mock_space, \
             patch("apps.collab.api._resolve_cascading_run_ids") as mock_resolve, \
             patch("django.db.transaction.atomic") as mock_atomic:
            mock_atomic.return_value.__enter__ = MagicMock(return_value=None)
            mock_atomic.return_value.__exit__ = MagicMock(return_value=False)

            mock_resolve.return_value = ["run-1", "run-1-sub-a"]

            mock_space.objects.using.return_value.filter.return_value.values.return_value.first.return_value = {
                "organization_id": uuid.uuid4(),
            }
            ci_chain = mock_ci.objects.using.return_value
            ci_chain.filter.return_value.exclude.return_value.values_list.return_value.distinct.return_value = []
            vh_chain = mock_vh.objects.using.return_value
            distinct_qs = MagicMock()
            distinct_qs.values.return_value.distinct.return_value = []
            vh_chain.filter.return_value = distinct_qs

            sc_chain = mock_sc.objects.using.return_value
            sc_chain.filter.return_value.exists.return_value = False
            sc_chain.create.return_value = MagicMock(id=uuid.uuid4())

            svc._create_space_checkpoint(
                space_id=space_id,
                file_checkpoint_hash="abc",
                agent_run_id="run-1",
                message_id=None,
            )

        assert capture_contributor.calls == [["run-1", "run-1-sub-a"]]


class TestCC2HttpCreateSpaceCheckpointIntegration:
    """W0-1 修复 P0-A：HTTP create_space_checkpoint 路径必须接入 ResourceContributor，
    与 Daemon 路径对称——避免 Wave 1 接入 TableResourceContributor 后同 Space
    在不同入口下 SpaceCheckpoint.version_refs 不一致。
    """

    def _setup_http_mocks(self, *, contextitem_resources=None,
                          existing_vhs=None, contributor_refs=None):
        """构造 create_space_checkpoint 所需的所有 mock。"""
        captured: dict = {"version_refs": None, "kwargs": None}

        def _sc_create(**kwargs):
            captured["version_refs"] = dict(kwargs.get("version_refs") or {})
            captured["kwargs"] = kwargs
            cp = MagicMock()
            cp.id = uuid.uuid4()
            cp.name = kwargs.get("name") or ""
            cp.created_at = None
            return cp

        if contributor_refs:
            register_resource_contributor(_StubResourceContributor(
                "tabdata", contributor_refs,
            ))

        return captured, _sc_create

    def _run_http_create(
        self,
        captured,
        sc_create_fn,
        *,
        agent_run_id: str = "run-1",
        file_checkpoint_hash: str = "",
        contextitem_resources=None,
        existing_vhs=None,
    ):
        """执行 HTTP create_space_checkpoint，patch 全部外部依赖。"""
        from apps.collab.api import create_space_checkpoint

        # body / request stubs
        body = MagicMock()
        body.space_id = uuid.uuid4()
        body.name = "test-cp"
        body.file_checkpoint_hash = file_checkpoint_hash
        body.agent_run_id = agent_run_id
        body.trigger = "manual"
        body.user_prompt = ""
        body.diff_summary = None
        body.checkpoint_policy = None
        body.anchor_session_id = ""
        body.anchor_message_id = ""

        request = MagicMock()
        request.auth = MagicMock()
        request.auth.id = "u-test"
        request.auth.nickname = "tester"

        space_obj = MagicMock()
        space_obj.organization_id = uuid.uuid4()

        # api.py 中 SpaceCheckpoint / VersionHistory 是函数级 lazy import，
        # 必须从源模块 patch
        with patch("apps.collab.models.SpaceCheckpoint") as mock_sc, \
             patch("apps.collab.models.VersionHistory") as mock_vh, \
             patch("apps.tabtinspace.models.ContextItem") as mock_ci, \
             patch("apps.tabtinspace.models.Space") as mock_space, \
             patch("apps.tabtinspace.services.base.BaseService") as mock_base_svc_cls, \
             patch("apps.collab.api._get_editor_info", return_value={}) as _, \
             patch("django.db.transaction.atomic") as mock_atomic:
            mock_atomic.return_value.__enter__ = MagicMock(return_value=None)
            mock_atomic.return_value.__exit__ = MagicMock(return_value=False)

            # Space.objects.filter(...).only(...).first()
            mock_space.objects.filter.return_value.only.return_value.first.return_value = space_obj

            # 权限通过
            mock_svc = MagicMock()
            mock_svc.check_space_permission.return_value = True
            mock_base_svc_cls.return_value = mock_svc

            # SpaceCheckpoint.objects.using().filter().first() （幂等检查）
            mock_sc.objects.using.return_value.filter.return_value.first.return_value = None
            mock_sc.objects.using.return_value.create.side_effect = sc_create_fn

            # ContextItem 资源
            ci_chain = mock_ci.objects.using.return_value
            ci_chain.filter.return_value.exclude.return_value.values_list.return_value.distinct.return_value = (
                contextitem_resources or []
            )

            # VersionHistory 查询
            vh_chain = mock_vh.objects.using.return_value
            existing_qs = MagicMock()
            existing_qs.order_by.return_value.distinct.return_value.values_list.return_value = (
                existing_vhs or []
            )

            def vh_filter_side_effect(*args, **kwargs):
                if "id__in" in kwargs:
                    qs = MagicMock()
                    qs.values_list.return_value = []
                    qs.update.return_value = 0
                    return qs
                return existing_qs
            vh_chain.filter.side_effect = vh_filter_side_effect

            return create_space_checkpoint(request, body)

    def test_no_contributor_no_change(self):
        """向后兼容：未注册 contributor 时 HTTP 路径行为不变。"""
        captured, sc_create_fn = self._setup_http_mocks()
        rid = uuid.uuid4()
        vid = uuid.uuid4()
        result = self._run_http_create(
            captured, sc_create_fn,
            contextitem_resources=[str(rid)],
            existing_vhs=[("table", rid, vid)],
        )
        assert captured["version_refs"] == {f"table:{rid}": str(vid)}

    def test_contributor_refs_merged_into_http_version_refs(self):
        """HTTP 路径与 daemon 对称合并 contributor 资源。"""
        captured, sc_create_fn = self._setup_http_mocks()
        rid = str(uuid.uuid4())
        vid = str(uuid.uuid4())
        contributor_refs: List[ResourceRef] = [{
            "resource_type": "table",
            "resource_id": rid,
            "version_history_id": vid,
        }]
        register_resource_contributor(_StubResourceContributor(
            "tabdata", contributor_refs,
        ))
        self._run_http_create(captured, sc_create_fn)
        assert captured["version_refs"] == {f"table:{rid}": vid}

    def test_contributor_alone_satisfies_early_return_check(self):
        """contributor 贡献的资源应能避免 'no_versioned_resources' 400 错误。"""
        captured, sc_create_fn = self._setup_http_mocks()
        rid = str(uuid.uuid4())
        vid = str(uuid.uuid4())
        contributor_refs: List[ResourceRef] = [{
            "resource_type": "table",
            "resource_id": rid,
            "version_history_id": vid,
        }]
        register_resource_contributor(_StubResourceContributor(
            "tabdata", contributor_refs,
        ))
        # ContextItem 路径无资源 + 无 file_checkpoint_hash —— 单靠
        # contributor 应当能让 checkpoint 创建成功（不返回 400）
        result = self._run_http_create(
            captured, sc_create_fn,
            contextitem_resources=[],
            existing_vhs=[],
        )
        # 调用成功（不是 400 元组）说明 contributor 让 early return 通过
        assert isinstance(result, dict) or (isinstance(result, tuple) and result[0] != 400)
        assert captured["version_refs"] == {f"table:{rid}": vid}

    def test_manual_create_persists_client_anchor_session_id(self):
        """#4307：无 agent_run 时客户端传入的 anchor_session_id 应落库。"""
        captured, sc_create_fn = self._setup_http_mocks()
        rid = uuid.uuid4()
        vid = uuid.uuid4()

        from apps.collab.api import create_space_checkpoint

        body = MagicMock()
        body.space_id = uuid.uuid4()
        body.name = "manual-cp"
        body.file_checkpoint_hash = "hash-manual"
        body.agent_run_id = ""
        body.trigger = "manual"
        body.user_prompt = ""
        body.diff_summary = None
        body.checkpoint_policy = {"kind": "manual"}
        body.anchor_session_id = "sess-manual-1"
        body.anchor_message_id = ""

        request = MagicMock()
        request.auth = MagicMock()
        request.auth.id = "u-test"
        request.auth.nickname = "tester"

        space_obj = MagicMock()
        space_obj.organization_id = uuid.uuid4()

        with patch("apps.collab.models.SpaceCheckpoint") as mock_sc, \
             patch("apps.collab.models.VersionHistory") as mock_vh, \
             patch("apps.tabtinspace.models.ContextItem") as mock_ci, \
             patch("apps.tabtinspace.models.Space") as mock_space, \
             patch("apps.tabtinspace.services.base.BaseService") as mock_base_svc_cls, \
             patch("apps.collab.api._get_editor_info", return_value={}), \
             patch("django.db.transaction.atomic") as mock_atomic:
            mock_atomic.return_value.__enter__ = MagicMock(return_value=None)
            mock_atomic.return_value.__exit__ = MagicMock(return_value=False)

            mock_space.objects.filter.return_value.only.return_value.first.return_value = space_obj
            mock_svc = MagicMock()
            mock_svc.check_space_permission.return_value = True
            mock_base_svc_cls.return_value = mock_svc
            mock_sc.objects.using.return_value.filter.return_value.first.return_value = None
            mock_sc.objects.using.return_value.create.side_effect = sc_create_fn

            mock_ci.objects.filter.return_value.exclude.return_value.values_list.return_value = [str(rid)]
            qs = MagicMock()
            qs.order_by.return_value = qs
            qs.distinct.return_value = qs
            qs.values_list.return_value = [("table", rid, vid)]
            mock_vh.objects.using.return_value.filter.return_value = qs

            create_space_checkpoint(request, body)

        assert captured["kwargs"]["anchor_session_id"] == "sess-manual-1"
        assert captured["kwargs"]["agent_run_id"] == ""


class TestCC2BackwardCompatPreservedAfterFix:
    """修复 P0-B 后旧的 build_checkpoint_impact 行为应完全保持。"""

    def test_build_checkpoint_impact_still_resolves_cascading(self):
        """build_checkpoint_impact 现在用 expand_agent_run_ids，但级联展开行为不变。"""
        from apps.collab.services.checkpoint_context import build_checkpoint_impact

        captured_run_ids = []

        def fake_collect_impact(run_ids):
            captured_run_ids.extend(run_ids)
            return {}

        with patch("apps.collab.models.ChangeLog") as mock_cl, \
             patch("apps.collab.api._resolve_cascading_run_ids") as mock_resolve, \
             patch(
                 "apps.collab.services.contributors.collect_contributed_impact",
                 side_effect=fake_collect_impact,
             ):
            mock_resolve.return_value = ["run-1", "run-1-sub-a"]
            qs = MagicMock()
            qs.filter.return_value = qs
            qs.count.return_value = 0
            qs.values.return_value = []
            mock_cl.objects.using.return_value.filter.return_value = qs

            build_checkpoint_impact(agent_run_id="run-1")

        assert captured_run_ids == ["run-1", "run-1-sub-a"]
