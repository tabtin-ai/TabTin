"""
#4370 / Wave 5 离队级联 service 单测专用 settings — 本机 PostgreSQL。

不用双库 SQLite：跨 alias FK / teardown check_constraints 问题太多。
策略对齐 ``settings_tabdata_test``：
- default + postgresql 指向同一物理 PG，postgresql 为 default 的 MIRROR
- syncdb 建表（DisableMigrations）
- 最小 INSTALLED_APPS（与 share 级联用例一致）

使用方式：
    cd apps/tabtin_django && source venv/bin/activate
    USE_SQLITE_FOR_TESTS=0 \\
      DJANGO_SETTINGS_MODULE=tabtin.settings_cascade_pg_test \\
      python -m pytest apps/tabtinspace/tests/test_cascade_service.py -q
"""
from __future__ import annotations

import os

from .settings import *  # noqa: F401,F403

# 单库语义：cascade_service 经 postgres_app_db_alias() 取 alias。
TABTIN_DATABASE_MODE = "single_pg"
TABTIN_SINGLE_DATABASE_MODE = True
os.environ["USE_SQLITE_FOR_TESTS"] = "0"


def _build_pg_config(name: str) -> dict:
    return {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": name,
        "USER": os.getenv("PG_DB_USER", "tabtin"),
        "PASSWORD": os.getenv("PG_DB_PASSWORD", "tabtin_dev_pass"),
        "HOST": os.getenv("PG_DB_HOST", "127.0.0.1"),
        "PORT": os.getenv("PG_DB_PORT", "5432"),
        "OPTIONS": {
            "options": "-c search_path=public",
        },
    }


_pg_db_name = os.getenv("PG_DB_NAME", "tabtin_single")
_pg_test_db_name = os.getenv("PG_TEST_DB_NAME", "test_tabtin_cascade")

DATABASES["default"] = _build_pg_config(_pg_db_name)  # type: ignore[name-defined]
DATABASES["postgresql"] = _build_pg_config(_pg_db_name)  # type: ignore[name-defined]
DATABASES["default"]["TEST"] = {"NAME": _pg_test_db_name}  # type: ignore[name-defined]
DATABASES["postgresql"]["TEST"] = {"MIRROR": "default"}  # type: ignore[name-defined]

# 单库：清空路由器，避免跨库 FK；测试里 .using('postgresql') 经 MIRROR 落到同一库。
DATABASE_ROUTERS = []  # type: ignore[name-defined]

# TabData 显式 alias 在测试事务内可见。
TABDATA_DB = "default"

INSTALLED_APPS = [  # type: ignore[name-defined]
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.postgres",
    "apps.users.auth",
    "apps.users.membership",
    "apps.tabtinspace",
    "apps.services.oss",
    "apps.services.notification",
    "apps.services.billing",
    "apps.tabdoc",
    "apps.tabdata",
]

ROOT_URLCONF = "tabtin.tests_urls_empty"

MIDDLEWARE = [  # type: ignore[name-defined]
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
]


class _DisableMigrations(dict):
    def __contains__(self, item):  # type: ignore[override]
        return True

    def __getitem__(self, item):  # type: ignore[override]
        return None


MIGRATION_MODULES = _DisableMigrations()

PASSWORD_HASHERS = [
    "django.contrib.auth.hashers.MD5PasswordHasher",
]
