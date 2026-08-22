"""Package Registry PostgreSQL 真实并发测试 settings(D2)。

策略:
- ``postgresql`` 别名走主 settings 中的真实 PostgreSQL(本地 dev 库 ``tabtin_local``)
- ``default`` 别名退化为 SQLite,避免触发 ``test_<mysql>`` 库的创建权限问题
  (本地 MySQL 用户通常无 CREATEDB 权限;package_registry 自己只用 PG)
- 必须配合 ``--keepdb`` 复用 PG 真实库

使用方式::

    cd apps/tabtin_django && source venv/bin/activate
    USE_SQLITE_FOR_TESTS=0 python manage.py test \\
        apps.services.package_registry.tests.test_concurrent_publish_pg \\
        --settings=tabtin.settings_postgresql_concurrency_test \\
        --keepdb --noinput

注意:测试逻辑全部走 ``TransactionTestCase`` + 显式清理,不会污染 dev 数据。
"""
from __future__ import annotations

import os

# 强制不要退化为 SQLite — 主 settings 的 PG 别名要保持真实 PG
os.environ["USE_SQLITE_FOR_TESTS"] = "0"

from .settings import *  # noqa: F401,F403


# default 走 SQLite — 避免 MySQL test 库创建权限问题。
# package_registry 模块本身完全依赖 PG,default 库只是 Django auth/contenttypes
# 等基础表的容器。
DATABASES["default"] = {  # type: ignore[name-defined]
    "ENGINE": "django.db.backends.sqlite3",
    "NAME": str(BASE_DIR / "test_d2_default.sqlite3"),  # noqa: F405
    "TEST": {"NAME": str(BASE_DIR / "test_d2_default.sqlite3")},  # noqa: F405
}


# 关键:禁用全部 migration。
# - default(SQLite)走 syncdb,自动建表;PG 兼容层 patch 让 SQLite 也能
#   建出 ArrayField/GinIndex 这些 PG 专属 schema。
# - postgresql(真实 PG)在 ``--keepdb`` 模式下,Django 不会重新建表,
#   会直接使用已存在的 dev 库;但 ``allow_migrate``/``sync_apps`` 仍可能
#   触发 syncdb 创建未在 migration 中声明的 app。我们用一个 router 限制
#   PG 库只接受 package_registry 的写入,让 syncdb 跳过其他 app。
class _DisableMigrations(dict):
    def __contains__(self, item):
        return True

    def __getitem__(self, item):
        return None


MIGRATION_MODULES = _DisableMigrations()


class _D2DualDbRouter:
    """让 default(SQLite)接所有 app,PG(真库)只接 package_registry。

    PG 真库已经有完整 migration 应用,我们不希望 ``setup_databases`` 在 PG
    上跑 ``sync_apps`` 重复建表(很多模块用 PG 专属字段类型,会冲突)。

    本路由在 ``allow_migrate(db='postgresql', app_label!='package_registry')``
    时返回 ``False``,让 Django syncdb 完全跳过这些 app 在 PG 上的建表。
    """

    def db_for_read(self, model, **hints):
        return None

    def db_for_write(self, model, **hints):
        return None

    def allow_relation(self, obj1, obj2, **hints):
        return None

    def allow_migrate(self, db, app_label, model_name=None, **hints):
        if db == "postgresql":
            # PG 库只接 package_registry,其它一律拒绝
            return app_label == "package_registry"
        # default(SQLite)允许全部
        return True


# 替换主 settings 的 router 链,让 D2 测试拿到干净的双库行为
DATABASE_ROUTERS = [  # type: ignore[name-defined]
    "apps.services.package_registry.db_router.PackageRegistryRouter",
    "tabtin.settings_postgresql_concurrency_test._D2DualDbRouter",
]

# 复用 settings_package_registry_test 同款的 SQLite PG 兼容层 — 保证
# default 库 syncdb 时也能容纳 tabdata 等模块的 ArrayField/GinIndex(虽然
# 我们不会去读写,但 syncdb 全量建表时仍要避免 SQL 语法错误)。
def _install_sqlite_pg_compat_for_default() -> None:
    try:
        from django.contrib.postgres.indexes import PostgresIndex
    except Exception:
        return
    try:
        from django.contrib.postgres.fields import ArrayField, HStoreField
    except Exception:
        ArrayField = HStoreField = type("_None", (), {})
    try:
        from django.contrib.postgres.fields.ranges import RangeField
    except Exception:
        RangeField = type("_None", (), {})
    from django.db.backends.sqlite3.schema import (
        DatabaseSchemaEditor as _SqliteEditor,
    )

    _orig_add_index = _SqliteEditor.add_index

    def _add_index(self, model, index):
        if isinstance(index, PostgresIndex):
            return
        return _orig_add_index(self, model, index)

    _SqliteEditor.add_index = _add_index

    _orig_add_constraint = _SqliteEditor.add_constraint

    def _add_constraint(self, model, constraint):
        try:
            return _orig_add_constraint(self, model, constraint)
        except Exception:
            if model._meta.app_label == "package_registry":
                raise
            return None

    _SqliteEditor.add_constraint = _add_constraint

    pg_only_field_types = (ArrayField, HStoreField, RangeField)
    _orig_column_sql = _SqliteEditor.column_sql

    def _column_sql(self, model, field, include_default=False):
        if isinstance(field, pg_only_field_types):
            return "text NULL", []
        return _orig_column_sql(self, model, field, include_default)

    _SqliteEditor.column_sql = _column_sql


_install_sqlite_pg_compat_for_default()


PASSWORD_HASHERS = [
    "django.contrib.auth.hashers.MD5PasswordHasher",
]
