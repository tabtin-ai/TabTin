"""Package Registry 单元测试 settings。

策略：
- 继承主 settings 的 INSTALLED_APPS / MIDDLEWARE / ROOT_URLCONF 等全部配置
- 仅覆盖 DATABASES（双 SQLite）、DATABASE_ROUTERS、MIGRATION_MODULES
- 禁用全部 migration（直接 syncdb 建表），避免 conversation MySQL DDL 在 SQLite 上失败
- 在 syncdb 前剥离非 package_registry 模型上的 PG 专用索引（GinIndex 等），
  避免业务模型的 PostgreSQL 专属索引在 SQLite 上抛错
  ``near "[]": syntax error``。本剥离仅作用于测试 settings，不影响生产代码与
  PostgreSQL 真实环境。

使用方式：

    cd apps/tabtin_django && source venv/bin/activate
    python manage.py test apps.services.package_registry.tests.test_api \
        --settings=tabtin.settings_package_registry_test --verbosity=2
"""
from __future__ import annotations

from .settings import *  # noqa: F401,F403


def _install_sqlite_pg_compat() -> None:
    """让 SQLite SchemaEditor 在创建表时兼容 PG 专用类型/索引。

    - ``GinIndex`` / ``BrinIndex`` 等 PG 专属索引：跳过创建。
    - ``ArrayField``：列类型从 ``<base>[]`` 退化为 ``TEXT`` （仅 DDL 阶段；测试
      逻辑实际不读写这些字段）。
    - ``RangeField`` / ``HStoreField``：同样退化为 ``TEXT`` 兜底。

    SQLite 不识别 ``CREATE TABLE ... char(32)[]`` 这种 PG 数组列语法，
    会在 syncdb 时抛 ``near "[]": syntax error``。本 patch 让非
    package_registry 应用中的 PostgreSQL 专属 DDL
    在 SQLite 测试库下可建表，不影响 package_registry 自身行为，
    也不影响生产 PostgreSQL 环境。
    """
    try:
        from django.contrib.postgres.indexes import PostgresIndex
    except Exception:  # pragma: no cover
        return
    try:
        from django.contrib.postgres.fields import ArrayField, HStoreField
    except Exception:  # pragma: no cover
        ArrayField = HStoreField = type("_None", (), {})  # type: ignore
    try:
        from django.contrib.postgres.fields.ranges import RangeField  # type: ignore
    except Exception:
        RangeField = type("_None", (), {})  # type: ignore
    from django.db.backends.sqlite3.schema import (
        DatabaseSchemaEditor as _SqliteEditor,
    )

    # Idempotent guard:同进程多次 import 该 settings 不重复 patch,
    # 避免 monkey-patch 链上叠加导致 _orig_* 指向已 patch 的版本(无限递归风险)。
    if getattr(_SqliteEditor, "_pkg_registry_pg_compat_patched", False):
        return

    # 跳过 PG-only 索引创建
    _orig_add_index = _SqliteEditor.add_index

    def _add_index(self, model, index):
        if isinstance(index, PostgresIndex):
            return
        return _orig_add_index(self, model, index)

    _SqliteEditor.add_index = _add_index

    # 跳过 PG-only 表内 unique/check/etc 约束（部分约束如 partial unique 可能
    # 引用 PG-only 表达式，统一 fallback）
    _orig_add_constraint = _SqliteEditor.add_constraint

    def _add_constraint(self, model, constraint):
        try:
            return _orig_add_constraint(self, model, constraint)
        except Exception:
            # 测试库不需要严格约束完整性（package_registry 自身约束不在这里）
            if model._meta.app_label == "package_registry":
                raise
            return None

    _SqliteEditor.add_constraint = _add_constraint

    # 把 PG 专用字段在 SQLite 上 fallback 成 TEXT
    pg_only_field_types = (ArrayField, HStoreField, RangeField)
    _orig_column_sql = _SqliteEditor.column_sql

    def _column_sql(self, model, field, include_default=False):
        if isinstance(field, pg_only_field_types):
            return "text NULL", []
        return _orig_column_sql(self, model, field, include_default)

    _SqliteEditor.column_sql = _column_sql

    # 标记本进程已 patch,后续 import 走 idempotent 早返回
    _SqliteEditor._pkg_registry_pg_compat_patched = True


_install_sqlite_pg_compat()


DATABASES["default"] = {  # type: ignore[name-defined]
    "ENGINE": "django.db.backends.sqlite3",
    "NAME": str(BASE_DIR / "test_pkg_registry_default.sqlite3"),  # noqa: F405
    "TEST": {
        "NAME": str(BASE_DIR / "test_pkg_registry_default.sqlite3"),  # noqa: F405
        "DEPENDENCIES": [],
    },
}
DATABASES["postgresql"] = {  # type: ignore[name-defined]
    "ENGINE": "django.db.backends.sqlite3",
    "NAME": str(BASE_DIR / "test_pkg_registry_postgresql.sqlite3"),  # noqa: F405
    "TEST": {
        "NAME": str(BASE_DIR / "test_pkg_registry_postgresql.sqlite3"),  # noqa: F405
        "DEPENDENCIES": [],
    },
}

DATABASE_ROUTERS = [  # type: ignore[name-defined]
    "apps.services.package_registry.db_router.PackageRegistryRouter",
    "tabtin.settings_package_registry_test._TestDualDbRouter",
]


class _TestDualDbRouter:
    """让所有非 package_registry 的 app 在两个 SQLite 库上都能建表。"""

    def db_for_read(self, model, **hints):
        return None

    def db_for_write(self, model, **hints):
        return None

    def allow_relation(self, obj1, obj2, **hints):
        return None

    def allow_migrate(self, db, app_label, model_name=None, **hints):
        if app_label == "package_registry":
            return None
        return True


class _DisableMigrations(dict):
    def __contains__(self, item):
        return True

    def __getitem__(self, item):
        return None


MIGRATION_MODULES = _DisableMigrations()

PASSWORD_HASHERS = [
    "django.contrib.auth.hashers.MD5PasswordHasher",
]
