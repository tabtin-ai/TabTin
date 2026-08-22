"""设置 IA Phase 2 · UserProfile.ui_settings 同步 API 单测专用 isolated settings。

策略（参考 ``settings_approval_memo_test.py``）：
- in-memory SQLite for both 'default' + 'postgresql' alias，绕开本地 MySQL
  CREATE DATABASE 权限缺失。
- ``MIGRATION_MODULES = _DisableMigrations()`` → syncdb 直接建表，绕过各 app
  migration 里 SQLite 不认的 MySQL ``CONVERT TO utf8mb4`` / FULLTEXT、PG GIN /
  tsvector / ARRAY[] 等专属 DDL（主 settings 默认 suite 正是撞 billing 的
  ``CONVERT TO CHARACTER SET utf8mb4`` 才必须隔离）。
- **最小 INSTALLED_APPS**：django 核心 + ``apps.i18n``（``_shared`` 链路 import
  ``from apps.i18n import _``）+ ``apps.users.auth``。**刻意不装 tabtinspace /
  membership / wallet 等**——这些 app 的 ``post_save@User`` 信号（如
  ``apps.tabtinspace.signals.create_default_organization``）会在 ``create_user`` 时
  往 PostgreSQL 域写 Organization，单测里会触发 ``DatabaseOperationForbidden``。
  最小 app 集结构性地让这些信号根本不被 connect，``create_user`` 只跑 users_auth
  自己的 5 个 default 域信号。
- ``DATABASE_ROUTERS = []`` —— in-memory SQLite 不分库，全部落 default。

覆盖测试：
    apps/users/auth/tests/test_ui_settings_sync.py

用法（root conftest 的 _ISOLATED_SETTINGS_HINTS 已登记 → 单文件跑会自动切到本 settings）：
    python -m pytest apps/users/auth/tests/test_ui_settings_sync.py -v
显式指定亦可（``-p no:cacheprovider`` 这类多 token 参数会绕过 auto-route，需显式 env）：
    DJANGO_SETTINGS_MODULE=tabtin.settings_ui_settings_test \\
        python -m pytest apps/users/auth/tests/test_ui_settings_sync.py -v
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

# 不走 router —— in-memory SQLite 不需要分库，全部落 default。
DATABASE_ROUTERS = []  # type: ignore[name-defined]

INSTALLED_APPS = [  # type: ignore[name-defined]
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "apps.i18n",
    "apps.users.auth",
]

# 主 urls.py 会 import 全量 app 路由，触发未装 app 报错。
# 这里用空 URLConf——单测不走 HTTP，直接调用路由函数。
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
