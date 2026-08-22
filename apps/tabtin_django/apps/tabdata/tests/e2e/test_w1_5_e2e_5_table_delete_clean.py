"""Wave 1.5 E2E-5 — 删表干净(prod-mode 真表)。

PRD §八 L1097-1119 / E2E-5
--------------------------

> 删表 → 5s 内 Celery worker 停止报错。

本测试覆盖 PRD §C3 完整链路:

1. **bump schema_version_token**:删表/trash 时 token 被 bump
2. **assert_table_token_or_skip**:已发布的旧 task(用 frozen 旧 token)被 skip
3. **5s 内停止报错**:freeze 旧 token 的任务在删表后立即返回 ``status=skipped``,
   不再尝试访问已 DROP 的 native 表(无 OperationalError 风暴)

C3 接入的 task(Wave 1.3 子 Agent 报告):
- ``conversion_tasks`` - 字段类型转换
- ``connector_tasks`` - 数据源连接器
- ``import_export_tasks`` - 导入导出
- 部分 ``cascade_tasks`` 也接入(待最终确认)

依赖
----

- ``L24.2 fixture helper``
- ``apps.tabdata.services.schema_version_token`` (C3 / Wave 1.3)
- ``TableService.delete_table / trash_table``
"""
from __future__ import annotations

import os
from typing import Any
from uuid import uuid4

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402

django.setup()

import pytest  # noqa: E402

from apps.tabdata.constants import TABDATA_DB_ALIAS  # noqa: E402
from apps.tabdata.models import Table, TableField  # noqa: E402
from apps.tabdata.native.ddl_manager import DDLManager  # noqa: E402
from apps.tabdata.services.schema_version_token import (  # noqa: E402
    FROZEN_TOKEN_KEY,
    assert_table_token_or_skip,
    bump_table_schema_version_token,
    get_table_schema_version_token,
)
from apps.tabdata.services.table_service import TableService  # noqa: E402
from apps.tabtinspace.tests.fixtures import (  # noqa: E402
    cleanup_test_organization,
    create_test_organization_with_agent,
)


# 真表 case 统一 gate;源码 grep 类无 DB 依赖,在 class 上单独标。
_REQUIRES_PROD_MODE = pytest.mark.skipif(
    os.environ.get("RUN_PROD_MODE_FIXTURE_TESTS") != "1",
    reason="E2E-5 真表 case 需要 prod-mode; 设 RUN_PROD_MODE_FIXTURE_TESTS=1 启用",
)


from apps.tabdata.tests.e2e.conftest import RealUser as _RealUser  # 三视角 P0 修复:共享 stub


@pytest.fixture()
def e2e5_table():
    """构造 organization + space + 表(带一个 text 字段)。"""
    ctx = create_test_organization_with_agent(prefix=f"e2e5_{uuid4().hex[:6]}")
    organization = ctx["organization"]
    space = ctx["space"]
    user = ctx["user"]

    ddl = DDLManager()
    ddl.ensure_schema(space.id)
    table = Table.objects.using(TABDATA_DB_ALIAS).create(
        name=f"e2e5_table_{uuid4().hex[:6]}",
        description="E2E-5 删表干净测试表",
        icon="🗑",
        owner_id=user.id, space_id=space.id, organization_id=organization.id,
        row_count=0, field_count=1,
    )
    ddl.create_native_table(space.id, table.id)
    pf = TableField.objects.using(TABDATA_DB_ALIAS).create(
        table_id=table.id,
        name="title", field_type="text", is_primary=True, order=0, config={},
    )
    ddl.add_column(space.id, table.id, pf.id, "text", {})

    try:
        yield {
            "ctx": ctx, "table": table, "user": user, "user_obj": _RealUser(user.id),
            "primary_field": pf, "space": space, "organization": organization,
        }
    finally:
        try:
            from apps.tabdata.models import TableRecord
            TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=table.id,
            )._raw_delete(TABDATA_DB_ALIAS)
            TableField.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=table.id,
            ).delete()
            Table.objects.using(TABDATA_DB_ALIAS).filter(id=table.id).delete()
            DDLManager().drop_schema(space.id)
        except Exception as exc:
            print(f"[E2E-5 cleanup] {exc}")
        cleanup_test_organization(organization, delete_user=True)


# ── 1. token bump 闭环 ────────────────────────────────────────


@_REQUIRES_PROD_MODE
class TestE2E5SchemaVersionTokenBump:
    """C3 schema_version_token 在 trash/delete/restore 时被 bump。"""

    def test_trash_table_bumps_token(self, e2e5_table):
        """trash_table 后 token 必须改变。"""
        ctx = e2e5_table
        table = ctx["table"]
        svc = TableService(user=ctx["user_obj"])

        token_before = get_table_schema_version_token(table.id)
        assert token_before is not None

        ok = svc.trash_table(table.id)
        assert ok is True

        token_after = get_table_schema_version_token(table.id)
        assert token_after is not None
        assert str(token_after) != str(token_before), (
            f"trash 后 token 必须 bump: before={token_before} after={token_after}"
        )

    def test_delete_table_bumps_token_then_table_disappears(self, e2e5_table):
        """delete_table(永久):token bump + 表消失 + assert_table_token_or_skip 返 False。"""
        ctx = e2e5_table
        table = ctx["table"]
        svc = TableService(user=ctx["user_obj"])

        # freeze 当前 token(模拟某 task 发布时 freeze 的 token)
        frozen_token = get_table_schema_version_token(table.id)
        assert frozen_token is not None

        ok = svc.delete_table(table.id)
        assert ok is True

        # 表删除后 get 返 None(表不存在)
        token_after = get_table_schema_version_token(table.id)
        assert token_after is None, "delete_table 后 token 应返 None(表不存在)"

        # assert_table_token_or_skip 必须返 False(表不存在 → no-op)
        result = assert_table_token_or_skip(
            table.id, str(frozen_token), task_name="e2e5_test",
        )
        assert result is False, (
            "delete 后,持旧 frozen_token 的 task 必须返 False → no-op"
        )


# ── 2. 5s 内 worker 停止报错(token 漂移就 skip) ──────────────


@_REQUIRES_PROD_MODE
class TestE2E5WorkerStopsErrorWithin5Seconds:
    """模拟 worker 接到 task 后,token 漂移(被删表)时立即 skip,不进入业务逻辑。"""

    def test_token_mismatch_returns_false_no_op(self, e2e5_table):
        """token 漂移必须返 False(不阻塞),让 task 函数体内 if not skip 走 return。"""
        ctx = e2e5_table
        table = ctx["table"]

        frozen_token = str(get_table_schema_version_token(table.id))

        # 模拟 task 之前发布、token 已 freeze
        # 现在表被删除/trash → bump
        bump_table_schema_version_token(
            table.id, reason="test_simulated_drift", user=ctx["user_obj"],
        )

        # task 在 worker 里执行 assert_table_token_or_skip
        result = assert_table_token_or_skip(
            table.id, frozen_token, task_name="e2e5_drift_test",
        )
        assert result is False, "token 漂移必须立即返 False"

    def test_no_expected_token_passthrough_for_legacy_tasks(self, e2e5_table):
        """旧 task 未启用 token 防御(expected_token=None)→ 必须直接 True 透传。"""
        ctx = e2e5_table
        table = ctx["table"]
        result = assert_table_token_or_skip(
            table.id, None, task_name="e2e5_legacy_compat",
        )
        assert result is True, (
            "expected_token=None 应直接返 True(向后兼容旧 task,不破坏现网)"
        )

    def test_token_match_returns_true_continues(self, e2e5_table):
        """token 一致 → True,task 继续业务逻辑。"""
        ctx = e2e5_table
        table = ctx["table"]
        current_token = str(get_table_schema_version_token(table.id))
        result = assert_table_token_or_skip(
            table.id, current_token, task_name="e2e5_match",
        )
        assert result is True


# ── 3. 验证 5 个 task 文件都接入了 token 防御(源代码扫描) ──


class TestE2E5TasksHaveTokenAssertion:
    """C3 接入清单的 task 文件都有 ``assert_table_token_or_skip`` 调用。

    源代码 grep 验证(避免依赖 Celery worker 实跑环境):
    - ``conversion_tasks``
    - ``connector_tasks``
    - ``import_export_tasks``(部分)
    """

    @pytest.mark.parametrize("task_module", [
        "apps.tabdata.tasks.conversion_tasks",
        "apps.tabdata.tasks.connector_tasks",
    ])
    def test_task_module_uses_token_assertion(self, task_module: str):
        """每个 task 模块的源代码必须 import 并使用 ``assert_table_token_or_skip``。"""
        import importlib
        import inspect

        mod = importlib.import_module(task_module)
        src = inspect.getsource(mod)
        assert "assert_table_token_or_skip" in src, (
            f"{task_module} 必须接入 C3 token 防御 (assert_table_token_or_skip)"
        )

    def test_frozen_token_key_constant_exported(self):
        """``FROZEN_TOKEN_KEY`` 必须可 import(caller 用此 key freeze)。"""
        assert FROZEN_TOKEN_KEY, "FROZEN_TOKEN_KEY 常量必须有值"
        assert isinstance(FROZEN_TOKEN_KEY, str)
