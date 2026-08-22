"""credential_vault 测试 settings（W1-B 新增）。

为什么要独立 settings：
- 项目默认 ``tabtin.settings`` 依赖 MySQL/PG 真实 DDL，本地开发机没有
  ``CREATE DATABASE`` 权限，``python manage.py test`` 在 setup_databases 就会爆；
- 部分 migration 含 MySQL 专有 DDL（如 FULLTEXT INDEX），sqlite 跑 migrate 会报
  "near 'INDEX': syntax error"；
- 故参考 ``settings_cli_audit_test.py`` 的最小 app 集合 + 禁用 migration 的做法
  （等价 Django ``syncdb`` 建表）。

使用方式：

    cd apps/tabtin_django && source venv/bin/activate
    DJANGO_SETTINGS_MODULE=tabtin.settings_credential_vault_test \\
        python manage.py test apps.credential_vault
"""
from __future__ import annotations

from .settings import *  # noqa: F401,F403


DATABASES["default"] = {  # type: ignore[name-defined]
    "ENGINE": "django.db.backends.sqlite3",
    "NAME": str(BASE_DIR / "test_credential_vault_default.sqlite3"),  # noqa: F405
    "TEST": {
        "NAME": str(BASE_DIR / "test_credential_vault_default.sqlite3"),  # noqa: F405
        "DEPENDENCIES": [],
    },
}
DATABASES["postgresql"] = {  # type: ignore[name-defined]
    "ENGINE": "django.db.backends.sqlite3",
    "NAME": str(BASE_DIR / "test_credential_vault_postgresql.sqlite3"),  # noqa: F405
    "TEST": {
        "NAME": str(BASE_DIR / "test_credential_vault_postgresql.sqlite3"),  # noqa: F405
        "DEPENDENCIES": [],
    },
}


class _DualDbRouter:
    """让 ``auth`` / ``contenttypes`` 在两库都建表（TransactionTestCase flush 需要）。"""

    _dual_labels = {"auth", "contenttypes", "sessions", "users_auth"}

    def db_for_read(self, model, **hints):
        return None

    def db_for_write(self, model, **hints):
        return None

    def allow_relation(self, obj1, obj2, **hints):
        return None

    def allow_migrate(self, db, app_label, model_name=None, **hints):
        if app_label in self._dual_labels:
            return True
        return None


DATABASE_ROUTERS = [  # type: ignore[name-defined]
    "tabtin.settings_credential_vault_test._DualDbRouter",
]


INSTALLED_APPS = [  # type: ignore[name-defined]
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "apps.users.auth",
    "apps.credential_vault.apps.CredentialVaultConfig",
]


MIDDLEWARE = [  # type: ignore[name-defined]
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
]


ROOT_URLCONF = "apps.credential_vault.tests"


class _DisableMigrations(dict):
    """禁用所有 app 的 migration，直接走 syncdb 建表。"""

    def __contains__(self, item):  # type: ignore[override]
        return True

    def __getitem__(self, item):  # type: ignore[override]
        return None


MIGRATION_MODULES = _DisableMigrations()


PASSWORD_HASHERS = [
    "django.contrib.auth.hashers.MD5PasswordHasher",
]
