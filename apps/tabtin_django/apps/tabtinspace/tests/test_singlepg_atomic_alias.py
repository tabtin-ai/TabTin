"""#458 回归：single_pg 下事务 alias 必须与 ORM 路由一致。

历史 bug：service 层硬编码 ``transaction.atomic(using='postgresql')``，而
single_pg 模式下 ``TabtinspaceRouter`` 把 tabtinspace 模型路由到 ``default``
alias——事务开在 ``postgresql`` 镜像连接、``select_for_update`` 查询跑在
``default`` 连接 → ``TransactionManagementError``，API 500。

修复口径：统一经 ``postgres_app_db_alias()`` 取 alias（single_pg 返回
``default``，双库返回 ``postgresql``），保证 atomic / ORM 路由 / on_commit
共享同一个连接。

注意：测试环境下 ``postgresql`` alias 配置为 ``TEST: {'MIRROR': 'default'}``
（共享 default 连接），test runner 内无法复现生产的「两条独立连接」500——
源码级清扫守护见同目录 ``test_singlepg_alias_static_guard.py``（默认 suite
亦执行）。本文件需真 PG（``USE_SQLITE_FOR_TESTS=0`` + ``-m requires_pg_native``）。
"""

import pytest
from django.db import connections, transaction

from apps.services.common.db_router import postgres_app_db_alias


@pytest.mark.django_db(databases=["default", "postgresql"])
def test_router_alias_matches_postgres_app_db_alias():
    """tabtinspace 模型的 ORM 路由结果必须等于 postgres_app_db_alias()。"""
    from apps.tabtinspace.models import Agent, Space, Organization

    alias = postgres_app_db_alias()
    for model in (Agent, Space, Organization):
        assert model.objects.db == alias, (
            f"{model.__name__} 路由到 {model.objects.db!r}，"
            f"与统一事务 alias {alias!r} 不一致（ 回归）"
        )


@pytest.mark.django_db(databases=["default", "postgresql"])
def test_select_for_update_inside_unified_atomic_alias():
    """atomic(using=postgres_app_db_alias()) 内 select_for_update 不得报
    TransactionManagementError（ 主现象）。空表也会真正发 SQL。"""
    from apps.tabtinspace.models import Agent

    alias = postgres_app_db_alias()
    with transaction.atomic(using=alias):
        assert connections[alias].in_atomic_block
        # 原 bug 下该查询跑在事务外的另一条连接上，直接抛
        # TransactionManagementError: select_for_update cannot be used
        # outside of a transaction.
        list(Agent.objects.select_for_update().all()[:1])
