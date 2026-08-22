"""Wave 7.1 (charter v1.8 §6.3 事件本体声明机制) — app manifest events[] 字段加载与查询。

测试范围（与 plan v2.1 §Phase 7.1 验收对齐）：
1. **schema 解析**：``packages/apps/<id>/app.json`` 的 ``events[]`` 字段被
   ``_load_app_definition_from_manifest`` 正确解析为 ``AppEventDefinition``
2. **缺失兼容**：app.json 没有 ``events`` 字段时不报错（"只声明 schema 不强制实现"）
3. **格式异常容忍**：events 非 list / 单条非 dict / key 缺失 / key 重复时
   静默跳过 + logger.warning，不阻断启动
4. **聚合查询**：``get_all_app_events`` / ``get_app_events`` / ``find_event``
   返回稳定有序结果
5. **真实 manifest 回归**：tabmail / tabdoc 真 manifest 已声明 ≥ 1 条事件
   （charter v1.8 §6.3 北极星 `tabtin event list | grep -c "tabmail\\|tabdoc"` ≥ 1 的源头）

设计取舍（**反思 9 防线**）：
- 不用 MagicMock 制造 model 对象；走真 ``_load_app_definition_from_manifest``
  解析 tmp_path 写入的真 JSON 文件
- 真 manifest 回归用 ``ar.CORE_APPS`` 全局已加载的不可变状态——若解析逻辑
  错了，CI 阶段就会 fail
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from unittest.mock import patch

import pytest

from apps.services.common import app_registry as ar
from apps.services.common.app_registry import (
    AppDefinition,
    AppEventDefinition,
    _load_app_definition_from_manifest,
    find_event,
    get_all_app_events,
    get_app_events,
)


# ─── Helpers ──────────────────────────────────────────────────


def _write_manifest(apps_root: Path, folder: str, data: dict) -> Path:
    d = apps_root / folder
    d.mkdir(parents=True)
    p = d / "app.json"
    p.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return p


def _minimal_manifest(app_id: str, events: list | None = None) -> dict:
    """最小可解析 manifest（不含 events / 含 events 两种形态共用）。"""
    out: dict = {
        "id": app_id,
        "name": app_id.title(),
        "kind": "app",
        "agentIntegration": {
            "contextType": None,
            "contextFields": [],
            "toolDomains": [],
            "hasPromptSection": False,
            "displayField": "",
            "workspaceRootSource": "",
            "isFrontendDependent": False,
            "typeAliases": [],
        },
        "catalog": {
            "category": "intelligence",
            "desktopGroup": "capabilities",
            "canCreate": False,
            "searchable": False,
            "isDefaultEnabled": True,
            "order": 50,
        },
    }
    if events is not None:
        out["events"] = events
    return out


# ─── 1. schema 解析 ──────────────────────────────────────────


def test_events_field_parsed_into_app_definition(tmp_path: Path) -> None:
    """合法 events[] 应被解析为 AppEventDefinition tuple，字段一一映射。"""
    manifest = _minimal_manifest(
        "x_test_app",
        events=[
            {
                "key": "x_test_app.entity.action",
                "label": "测试事件",
                "description": "用于回归测试",
                "payload_schema": {
                    "fields": [
                        {"name": "id", "type": "string", "required": True},
                        {"name": "tag", "type": "string", "required": False},
                    ],
                },
                "filterable_fields": ["id", "tag"],
                "ai_filterable": True,
            }
        ],
    )
    p = _write_manifest(tmp_path, "x_test_app", manifest)

    app_def = _load_app_definition_from_manifest(p)

    assert app_def is not None
    assert isinstance(app_def, AppDefinition)
    assert len(app_def.events) == 1

    ev = app_def.events[0]
    assert isinstance(ev, AppEventDefinition)
    assert ev.key == "x_test_app.entity.action"
    assert ev.label == "测试事件"
    assert ev.description == "用于回归测试"
    assert ev.filterable_fields == ("id", "tag")
    assert ev.ai_filterable is True
    # payload_schema 转 tuple-of-tuples（frozen dataclass 兼容）
    assert ev.payload_schema == (
        ("id", "string", True),
        ("tag", "string", False),
    )


# ─── 2. 缺失兼容（"只声明 schema 不强制实现"约束）────────


def test_missing_events_field_yields_empty_tuple(tmp_path: Path) -> None:
    """app.json 没有 events 字段 → events=()，不报错。"""
    manifest = _minimal_manifest("x_no_events_app", events=None)
    p = _write_manifest(tmp_path, "x_no_events_app", manifest)

    app_def = _load_app_definition_from_manifest(p)

    assert app_def is not None
    assert app_def.events == ()


def test_empty_events_list_yields_empty_tuple(tmp_path: Path) -> None:
    """显式 events: [] → events=()，不报错。"""
    manifest = _minimal_manifest("x_empty_events_app", events=[])
    p = _write_manifest(tmp_path, "x_empty_events_app", manifest)

    app_def = _load_app_definition_from_manifest(p)

    assert app_def is not None
    assert app_def.events == ()


# ─── 3. 格式异常容忍 ────────────────────────────────────────


def test_events_non_list_silently_skipped(tmp_path: Path) -> None:
    """events 字段是非 list 类型 → 全跳过 + warning，不抛异常。

    注：Django LOGGING 配置会拦截 propagate，pytest caplog 抓不到。
    本测试通过 ``patch.object(logger, 'warning')`` 直接监听调用更稳妥。
    """
    manifest = _minimal_manifest("x_bad_events_app", events=None)
    manifest["events"] = "not_a_list"  # type: ignore[assignment]
    p = _write_manifest(tmp_path, "x_bad_events_app", manifest)

    with patch("apps.services.common.app_registry.logger") as mock_log:
        app_def = _load_app_definition_from_manifest(p)

    assert app_def is not None
    assert app_def.events == ()
    # 任何 warning 调用的第 2/3 个 arg（format args）含 "非 list" 即可
    warning_calls = [
        " ".join(str(a) for a in c.args)
        for c in mock_log.warning.call_args_list
    ]
    assert any("非 list" in msg for msg in warning_calls), (
        f"应有'非 list' warning，实际 warning calls={warning_calls}"
    )


def test_event_missing_key_silently_skipped(tmp_path: Path) -> None:
    """events 单条缺少 key → 跳过该条，其它正常解析。"""
    manifest = _minimal_manifest(
        "x_partial_events_app",
        events=[
            {"label": "缺 key 的事件"},  # 应被跳过
            {"key": "x_partial_events_app.e.a", "label": "OK"},
        ],
    )
    p = _write_manifest(tmp_path, "x_partial_events_app", manifest)

    with patch("apps.services.common.app_registry.logger") as mock_log:
        app_def = _load_app_definition_from_manifest(p)

    assert app_def is not None
    assert len(app_def.events) == 1
    assert app_def.events[0].key == "x_partial_events_app.e.a"
    warning_calls = [
        " ".join(str(a) for a in c.args)
        for c in mock_log.warning.call_args_list
    ]
    assert any("缺少 key" in msg for msg in warning_calls)


def test_event_duplicate_key_skipped(tmp_path: Path) -> None:
    """events 同一 manifest 重复 key → 仅保留首次，后续 warning 跳过。"""
    manifest = _minimal_manifest(
        "x_dup_events_app",
        events=[
            {"key": "x_dup.entity.act", "label": "first"},
            {"key": "x_dup.entity.act", "label": "second"},
        ],
    )
    p = _write_manifest(tmp_path, "x_dup_events_app", manifest)

    with patch("apps.services.common.app_registry.logger") as mock_log:
        app_def = _load_app_definition_from_manifest(p)

    assert len(app_def.events) == 1
    assert app_def.events[0].label == "first"
    warning_calls = [
        " ".join(str(a) for a in c.args)
        for c in mock_log.warning.call_args_list
    ]
    assert any("重复 key" in msg for msg in warning_calls)


def test_event_key_not_three_segments_warns_but_kept(tmp_path: Path) -> None:
    """charter §6.3 强约束：业务事件 key 必须三段式。
    若不符合，当前策略：logger.warning 但仍登记（避免阻断 manifest 加载）。
    """
    manifest = _minimal_manifest(
        "x_warn_events_app",
        events=[{"key": "single_segment", "label": "只有一段"}],
    )
    p = _write_manifest(tmp_path, "x_warn_events_app", manifest)

    with patch("apps.services.common.app_registry.logger") as mock_log:
        app_def = _load_app_definition_from_manifest(p)

    assert len(app_def.events) == 1  # 不阻断
    warning_calls = [
        " ".join(str(a) for a in c.args)
        for c in mock_log.warning.call_args_list
    ]
    assert any("非三段式" in msg for msg in warning_calls)


# ─── 4. 聚合查询 ──────────────────────────────────────────


def test_get_all_app_events_aggregates_across_apps() -> None:
    """get_all_app_events 应聚合 builtin + marketplace App 的 events。

    依赖**真 CORE_APPS** —— Wave 7.1 已给 tabmail / tabdoc 加 events[]，
    所以本测试断言"至少能找到这两个 app 的事件"。
    （这是 charter v1.8 §6.3 北极星 1 的代码层支撑。）
    """
    pairs = get_all_app_events()
    assert len(pairs) >= 2  # 至少 tabmail + tabdoc 各 1 条

    app_ids = {app_id for app_id, _ev in pairs}
    assert "tabmail" in app_ids
    assert "tabdoc" in app_ids


def test_get_app_events_filters_by_app_id() -> None:
    """get_app_events('tabmail') 只返回 tabmail 的事件。"""
    events = get_app_events("tabmail")
    assert len(events) >= 1
    assert all(ev.key.startswith("tabmail.") for ev in events)


def test_get_app_events_unknown_app_returns_empty() -> None:
    """未知 app_id → 空 tuple（不抛异常）。"""
    assert get_app_events("nonexistent_app_xyz") == ()


def test_find_event_by_key_returns_app_id_and_event() -> None:
    """find_event 根据 event key 反查归属 app + AppEventDefinition。"""
    found = find_event("tabmail.email.received")
    assert found is not None
    app_id, ev = found
    assert app_id == "tabmail"
    assert ev.key == "tabmail.email.received"
    assert ev.label  # 非空 label


def test_find_event_unknown_key_returns_none() -> None:
    assert find_event("xx.yy.zz_nonexistent") is None


# ─── 5. 真实 manifest 回归 ──────────────────────────────────


def test_real_tabmail_manifest_declares_events() -> None:
    """tabmail/app.json 必须声明 ≥ 1 条业务事件（charter §6.3 + plan §Phase 7 北极星 1）。"""
    tabmail = ar.get_app("tabmail")
    assert tabmail is not None, "tabmail 应注册为 builtin App"
    assert len(tabmail.events) >= 1
    keys = {ev.key for ev in tabmail.events}
    # tabmail.email.received 是 charter §5.3 用户旅程"建事件触发任务"的标准示例
    assert "tabmail.email.received" in keys


def test_real_tabdoc_manifest_declares_events() -> None:
    """tabdoc/app.json 必须声明 ≥ 1 条业务事件。"""
    tabdoc = ar.get_app("tabdoc")
    assert tabdoc is not None
    assert len(tabdoc.events) >= 1
    keys = {ev.key for ev in tabdoc.events}
    assert any(k.startswith("tabdoc.") for k in keys)


def test_real_event_keys_follow_three_segment_convention() -> None:
    """所有真 manifest 声明的事件 key 必须是 ``<app>.<entity>.<action>`` 三段式
    （charter §6.3 + §8 拒绝清单 #9）。
    """
    for app_id, ev in get_all_app_events():
        # 至少两个 dot 分隔符 → 三段以上
        segments = ev.key.split(".")
        assert len(segments) >= 3, (
            f"{app_id} event key {ev.key!r} 必须是三段式"
            f" <app>.<entity>.<action>（charter §6.3）"
        )
        # 第一段应等于 app_id（一致性约束）
        assert segments[0] == app_id, (
            f"{app_id} event key {ev.key!r} 第一段应等于 app_id"
        )


# ─── 5b. surface 字段解析 + 真实 manifest 三态分类回归（切片 1：分类真源 SSOT）──


def test_surface_field_parsed_into_app_definition(tmp_path: Path) -> None:
    """合法 surface 字符串应被解析到 AppDefinition.surface。"""
    manifest = _minimal_manifest("x_surface_app")
    manifest["surface"] = "collaborative"
    p = _write_manifest(tmp_path, "x_surface_app", manifest)

    app_def = _load_app_definition_from_manifest(p)

    assert app_def is not None
    assert app_def.surface == "collaborative"


def test_missing_surface_field_yields_none(tmp_path: Path) -> None:
    """manifest 未声明 surface → surface=None（技能包场景，不报错）。"""
    manifest = _minimal_manifest("x_no_surface_app")
    p = _write_manifest(tmp_path, "x_no_surface_app", manifest)

    app_def = _load_app_definition_from_manifest(p)

    assert app_def is not None
    assert app_def.surface is None


def test_invalid_surface_field_yields_none_and_warns(tmp_path: Path) -> None:
    """surface 非法（非字符串 / 空串）→ 降级 None + warning，不阻断加载。"""
    manifest = _minimal_manifest("x_bad_surface_app")
    manifest["surface"] = 123  # type: ignore[assignment]
    p = _write_manifest(tmp_path, "x_bad_surface_app", manifest)

    with patch("apps.services.common.app_registry.logger") as mock_log:
        app_def = _load_app_definition_from_manifest(p)

    assert app_def is not None
    assert app_def.surface is None
    warning_calls = [
        " ".join(str(a) for a in c.args)
        for c in mock_log.warning.call_args_list
    ]
    assert any("surface" in msg for msg in warning_calls), (
        f"应有 surface 非法 warning，实际 warning calls={warning_calls}"
    )


# 三态分类唯一真源（SSOT）——权威映射见 docs/agent/capability-taxonomy.md。
# 任何 manifest surface 声明改错，此表会立刻 fail。
_EXPECTED_SURFACE: dict[str, str] = {
    # builtin：平台常驻核心能力
    "tabweb": "builtin",
    "terminal": "builtin",
    "tabfolder": "builtin",
    "tabcode": "builtin",
    "tabdesktop": "builtin",
    "tabphone": "builtin",
    "tabvideo": "builtin",
    "tabwhiteboard": "builtin",
    # local：个人可自助安装的本地扩展（Personal Plugin）
    "cowart": "local",
    "tabtin-demo-app": "local",
    # collaborative：需团队治理的协作应用
    "tabdoc": "collaborative",
    "tabdata": "collaborative",
    "tabslide": "collaborative",
    "tabfiles": "collaborative",
    "tabmail": "collaborative",
    "tabmemo": "collaborative",
    "tabsite": "collaborative",
    "tabtracker": "collaborative",
    "tabinbox": "collaborative",
    "orchestration": "collaborative",
}

# 技能包不是应用形态 → 不声明 surface。
_EXPECTED_NO_SURFACE: set[str] = {
    "tabtin-office-skills-pack",
    "tabtin-workflow-skills-pack",
    "tabtin-docs-factory-pack",
    "tabtin-research-pack",
    "tabtin-marketing-pack",
    "tabtin-design-quality-pack",
    "tabtin-engineering-discipline-pack",
    "tabtin-sales-followup-pack",
    "tabtin-meeting-actions-pack",
    "tabtin-integrations-lite-pack",
    "tabtin-role-packs",
    "tabtin-meta-skills-pack",
    "tabtin-writing-tools-pack",
    "tabtin-collab-efficiency-pack",
    "tabtin-data-toolkit-pack",
    "tabtin-business-analysis-pack",
    "tabtin-creative-toolkit-pack",
    "tabtin-dev-toolkit-pack",
}


def test_real_manifests_declare_expected_surface() -> None:
    """真 manifest 的 surface 声明必须与权威三态映射一致。"""
    for app_id, expected in _EXPECTED_SURFACE.items():
        app_def = ar.get_app(app_id)
        assert app_def is not None, f"{app_id} 应注册为 App"
        assert app_def.surface == expected, (
            f"{app_id} surface 期望 {expected!r}，实际 {app_def.surface!r}"
        )


def test_skill_packs_have_no_surface() -> None:
    """技能包（独立层，非应用形态）不应声明 surface。"""
    for app_id in _EXPECTED_NO_SURFACE:
        app_def = ar.get_app(app_id)
        assert app_def is not None, f"{app_id} 应注册为 App"
        assert app_def.surface is None, (
            f"技能包 {app_id} 不应有 surface，实际 {app_def.surface!r}"
        )


def test_surface_values_within_taxonomy_vocabulary() -> None:
    """全量已注册 App 的 surface 只允许三态词汇或 None（不得漂移）。"""
    allowed = {"builtin", "local", "collaborative", None}
    for app_def in list(ar.CORE_APPS.values()) + list(ar.MARKETPLACE_APPS.values()):
        assert app_def.surface in allowed, (
            f"{app_def.id} surface={app_def.surface!r} 不在三态词汇内"
        )


# ─── 6. _validate_manifest_consistency events 块审计（**Wave 7 续作 P1-4**）──


def test_validate_manifest_consistency_detects_invalid_events(
    tmp_path: Path,
) -> None:
    """**Wave 7 续作 P1-4 修复防线**：``_validate_manifest_consistency`` 必须把
    events 字段违规列入 startup audit warnings。

    场景覆盖（与 ``_check_events_block`` 对齐）：
      a) events 整体非 list
      b) 单条非 dict
      c) key 缺失 / 非字符串
      d) key 不是三段式
      e) key 第一段 ≠ app_id
      f) key 重复

    设计：用 patch.object 把 ``_PROJECT_ROOT`` 临时指向 tmp_path，让
    validator 扫描我们伪造的违规 manifest，断言每类违规都触发对应 warning。
    （对齐 test_app_registry_check.py 的既有用法）
    """
    from apps.services.common.app_registry_check import (
        _validate_manifest_consistency,
    )

    # 1) 在 tmp_path 下伪造 packages/apps/<id>/app.json 多个 manifest
    apps_root = tmp_path / "packages" / "apps"
    apps_root.mkdir(parents=True)

    # a) events 非 list
    a_dir = apps_root / "x_audit_a"
    a_dir.mkdir()
    (a_dir / "app.json").write_text(json.dumps({
        "id": "x_audit_a",
        "name": "Audit A",
        "events": "not_a_list",
    }), encoding="utf-8")

    # b) events 单条非 dict + d) key 不三段 + e) key 第一段错 + f) 重复
    b_dir = apps_root / "x_audit_b"
    b_dir.mkdir()
    (b_dir / "app.json").write_text(json.dumps({
        "id": "x_audit_b",
        "name": "Audit B",
        "events": [
            "not_a_dict",                                           # b
            {"key": "single_segment"},                              # d 不三段
            {"key": "wrong_app.entity.act"},                        # e 第一段错
            {"key": "x_audit_b.entity.act"},                        # 合法
            {"key": "x_audit_b.entity.act"},                        # f 重复
            {"label": "缺 key"},                                    # c key 缺失
        ],
    }), encoding="utf-8")

    # 2) patch.object 把 _PROJECT_ROOT 指向 tmp_path，CORE_APPS 包含两个伪造
    #    app 让 validator 不在"manifest 在注册表中无对应条目"分支早退
    fake_app_a = AppDefinition(id="x_audit_a", name="A")
    fake_app_b = AppDefinition(id="x_audit_b", name="B")
    with (
        patch.object(ar, "CORE_APPS",
                     {"x_audit_a": fake_app_a, "x_audit_b": fake_app_b}),
        patch.object(ar, "MARKETPLACE_APPS", {}),
        patch.object(ar, "_PROJECT_ROOT", tmp_path),
    ):
        warnings = _validate_manifest_consistency()

    # 3) 断言关键 warnings 都被列入
    joined = "\n".join(warnings)
    assert "x_audit_a" in joined and "events 字段非 list" in joined, (
        f"应抓到 events 非 list 警告；实际:\n{joined}"
    )
    assert "x_audit_b" in joined, "应有 x_audit_b 相关警告"
    assert "非 dict 条目" in joined, f"应抓到非 dict 条目警告；实际:\n{joined}"
    assert "非三段式" in joined, f"应抓到三段式警告；实际:\n{joined}"
    assert "≠ app_id" in joined or "第一段" in joined, (
        f"应抓到 key 第一段 ≠ app_id 警告；实际:\n{joined}"
    )
    assert "重复" in joined, f"应抓到重复 key 警告；实际:\n{joined}"
    assert "缺少 key" in joined, f"应抓到 key 缺失警告；实际:\n{joined}"


def test_validate_manifest_consistency_does_not_warn_for_clean_events(
    tmp_path: Path,
) -> None:
    """干净的 events 块（全部三段式 + 第一段=app_id + 无重复）不应产生任何
    events 相关 warning。

    本测试是 P1-4 修复防回归的反向防线——避免 _check_events_block 误报。
    """
    from apps.services.common.app_registry_check import (
        _validate_manifest_consistency,
    )

    apps_root = tmp_path / "packages" / "apps"
    apps_root.mkdir(parents=True)

    clean_dir = apps_root / "x_clean"
    clean_dir.mkdir()
    (clean_dir / "app.json").write_text(json.dumps({
        "id": "x_clean",
        "name": "Clean",
        "events": [
            {"key": "x_clean.entity.create"},
            {"key": "x_clean.entity.update"},
            {"key": "x_clean.entity.delete"},
        ],
    }), encoding="utf-8")

    fake_app = AppDefinition(id="x_clean", name="Clean")
    with (
        patch.object(ar, "CORE_APPS", {"x_clean": fake_app}),
        patch.object(ar, "MARKETPLACE_APPS", {}),
        patch.object(ar, "_PROJECT_ROOT", tmp_path),
    ):
        warnings = _validate_manifest_consistency()

    # 收集到的 warnings 中不应包含 x_clean 的 events 相关警告
    events_related = [
        w for w in warnings
        if "x_clean" in w and (
            "非三段式" in w or "重复" in w or "≠ app_id" in w or "非 dict" in w
        )
    ]
    assert not events_related, (
        "干净 events 块不应触发 events 相关 warning，实际:\n"
        + "\n".join(events_related)
    )
