"""
M1.1 · UserPortrait 单测专用 settings。

策略（参考 ``settings_approval_memo_test.py``）：
- in-memory SQLite for both 'default' + 'postgresql' alias，绕开本地 MySQL
  CREATE DATABASE 权限缺失。
- ``MIGRATION_MODULES = _DisableMigrations()`` 让 Django 直接 syncdb 建表，
  绕过 ``conversation/0024`` 的 MySQL 专有 ``FULLTEXT INDEX`` 在 SQLite 上失败、
  以及其他 PG 专有 GIN / tsvector 等 SQLite 不认的 DDL。
- INSTALLED_APPS 只装 M1.1 测试需要的最小集：django 核心 + ``users.auth``
  + ``user_portrait``。

使用方式：
    cd apps/tabtin_django && source venv/bin/activate
    DJANGO_SETTINGS_MODULE=tabtin.settings_user_portrait_test \\
        pytest apps/user_portrait/tests/

CI 注意：
    默认 ``pytest`` 走主 ``tabtin.settings``，user_portrait 测试不会被跑到。
    CI 配置必须显式新增一行：
        pytest --ds=tabtin.settings_user_portrait_test apps/user_portrait/tests/
"""
from __future__ import annotations

from .settings import *  # noqa: F401,F403


DATABASES["default"] = {  # type: ignore[name-defined]
    "ENGINE": "django.db.backends.sqlite3",
    "NAME": ":memory:",
    "TEST": {"NAME": ":memory:"},
}
DATABASES["postgresql"] = {  # type: ignore[name-defined]
    "ENGINE": "django.db.backends.sqlite3",
    "NAME": ":memory:",
    "TEST": {"NAME": ":memory:"},
}

# 不走 router —— in-memory SQLite 不需要分库
DATABASE_ROUTERS = []  # type: ignore[name-defined]

INSTALLED_APPS = [  # type: ignore[name-defined]
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "apps.users.auth",
    "apps.user_portrait.apps.UserPortraitConfig",
]

# 主 urls.py 会 import conversation/agent_engine 等 app 的路由，触发未装 app 报错。
# 这里用空 URLConf——单测不走 HTTP，不需要真实路由。
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
