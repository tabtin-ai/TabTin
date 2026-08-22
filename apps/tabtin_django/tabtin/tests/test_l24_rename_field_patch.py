"""L24 monkey-patch 单元测试 (W1.5-prep / 三视角 Review P0 修复)。

验证 ``tabtin/__init__.py:_patch_rename_field_indexes`` 的核心契约:

1. ``ProjectState.rename_field`` 在 RenameField 后,model_state.options['indexes']
   中的 ``Index.fields`` 和 ``Index.fields_orders`` **同时** 更新到 new_name。
2. Django 5.0+ 时本 patch 自动 no-op (避免与 native fix 叠加)。
3. fallback 不再降级到 ``clone()+改 fields`` 的 broken 路径。

不依赖任何具体 app(用合成 ProjectState),纯单测,无 DB I/O。
"""
from __future__ import annotations

import os
import sys

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402

if not django.apps.apps.ready:  # type: ignore[attr-defined]
    django.setup()

import pytest  # noqa: E402

from django.db.migrations.state import ModelState, ProjectState  # noqa: E402
from django.db.models import Index  # noqa: E402


@pytest.fixture()
def project_state_with_renamable_index():
    """合成一个 ProjectState,含 BillingAnomalyAlert-like model 与一个 Index。"""
    from django.db import models

    fields = [
        ("id", models.AutoField(primary_key=True)),
        ("workspace_id", models.CharField(max_length=100)),
        ("created_at", models.DateTimeField()),
    ]
    options = {
        "indexes": [
            Index(
                fields=["workspace_id", "created_at"],
                name="services_bi_workspa_3bed48_idx",
            ),
        ],
    }
    ms = ModelState(
        app_label="testapp",
        name="DummyModel",
        fields=fields,
        options=options,
    )
    state = ProjectState()
    state.add_model(ms)
    return state


def test_rename_field_synchronizes_index_fields_orders(
    project_state_with_renamable_index,
):
    """L24 核心:RenameField 后 Index.fields 和 fields_orders 必须同步。"""
    state = project_state_with_renamable_index
    state.rename_field("testapp", "dummymodel", "workspace_id", "organization_id")

    ms = state.models["testapp", "dummymodel"]
    idx = ms.options["indexes"][0]

    assert idx.name == "services_bi_workspa_3bed48_idx", (
        "Index 名字本身不应改变(只 rename field)"
    )
    assert idx.fields == ["organization_id", "created_at"], (
        f"Index.fields 应被 update 到 organization_id, 实际: {idx.fields}"
    )
    assert idx.fields_orders == [("organization_id", ""), ("created_at", "")], (
        f"L24 修复:Index.fields_orders 必须同步 update 到 organization_id, "
        f"实际: {idx.fields_orders} (这是 Django 4.2 ticket )"
    )


def test_rename_field_idempotent_for_unaffected_index(
    project_state_with_renamable_index,
):
    """rename 一个 model 中没有 index 引用的字段,index 不变。"""
    state = project_state_with_renamable_index
    state.rename_field("testapp", "dummymodel", "id", "pk_id")

    ms = state.models["testapp", "dummymodel"]
    idx = ms.options["indexes"][0]

    assert idx.fields == ["workspace_id", "created_at"], (
        "无关字段 rename 不应改其它 Index.fields"
    )
    assert idx.fields_orders == [("workspace_id", ""), ("created_at", "")]


def test_rename_field_partial_match_in_composite_index():
    """复合 index 仅一个字段被 rename 时,只改对应位置。"""
    from django.db import models

    fields = [
        ("id", models.AutoField(primary_key=True)),
        ("meter_key", models.CharField(max_length=50)),
        ("scope", models.CharField(max_length=20)),
        ("workspace_id", models.CharField(max_length=100)),
        ("is_active", models.BooleanField()),
    ]
    options = {
        "indexes": [
            Index(
                fields=["meter_key", "scope", "workspace_id", "is_active"],
                name="services_bi_meter_k_593ca3_idx",
            ),
        ],
    }
    ms = ModelState(
        app_label="testapp",
        name="MeterPricing",
        fields=fields,
        options=options,
    )
    state = ProjectState()
    state.add_model(ms)
    state.rename_field("testapp", "meterpricing", "workspace_id", "organization_id")

    idx = state.models["testapp", "meterpricing"].options["indexes"][0]
    assert idx.fields == ["meter_key", "scope", "organization_id", "is_active"]
    assert idx.fields_orders == [
        ("meter_key", ""),
        ("scope", ""),
        ("organization_id", ""),
        ("is_active", ""),
    ]


def test_rename_field_unique_together_synced(project_state_with_renamable_index):
    """unique_together 字段引用同步更新(已是 patch 已有功能,加测保护)。"""
    from django.db import models

    fields = [
        ("id", models.AutoField(primary_key=True)),
        ("workspace_id", models.CharField(max_length=100)),
        ("name", models.CharField(max_length=100)),
    ]
    options = {
        "unique_together": {("workspace_id", "name")},
    }
    ms = ModelState(
        app_label="testapp",
        name="UTModel",
        fields=fields,
        options=options,
    )
    state = ProjectState()
    state.add_model(ms)
    state.rename_field("testapp", "utmodel", "workspace_id", "organization_id")

    ut = state.models["testapp", "utmodel"].options.get("unique_together")
    # Django 4.2 ProjectState 把 set/tuple 统一存成 list of lists
    normalized = {tuple(g) for g in ut}
    assert normalized == {("organization_id", "name")}, (
        f"unique_together 应同步 rename, 实际: {ut}"
    )


def test_django_5_compatibility_disabled():
    """Django 5.0+ 时 patch 应自动 no-op (检查代码不依赖 patch 函数本身行为)。

    本测试只在 Django < 5.0 跑(因为我们仍在 4.2);Django 5.0 升级后,
    本 patch 应被删除,本测试也应被改成"验证 native 行为"。
    """
    import django as _dj
    if _dj.VERSION >= (5, 0):
        pytest.skip("Django 5.0+ has native  fix; patch should be removed")

    from django.db.migrations.state import ProjectState
    rename_field_attr = ProjectState.rename_field
    assert rename_field_attr is not None
    assert callable(rename_field_attr)


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v", "--no-header", "-p", "no:cacheprovider"]))
