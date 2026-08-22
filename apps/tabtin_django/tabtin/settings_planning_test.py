"""
Wave 1-B Planning Collection 预置回归测试 settings。

策略：
- default + postgresql 两个 alias 各自独立的 in-memory SQLite，绕过本地
  MySQL CREATE DATABASE 权限缺失，且避免文件残留导致并行/重跑时污染。
- 保留 tabtinspace router 让 tabtinspace.* 模型落到 'postgresql' alias，
  这样 @transaction.atomic(using='postgresql') 才能正确管理事务并回滚。
- 禁用所有 migration（直接 syncdb 建表），避免 conversation/0024 的
  MySQL 专有 FULLTEXT INDEX 在 SQLite 上失败。
- 只加载 tabtinspace 预置回归所需的最小 app 集合。
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

# 保留 tabtinspace 路由器，让 tabtinspace.* model 落到 'postgresql' alias，
# 这样 @transaction.atomic(using='postgresql') 才能正确管理事务并回滚。
# users_auth 仍走 default，跨库 FK 由 router 的 allow_relation 放行。
DATABASE_ROUTERS = [  # type: ignore[name-defined]
    "apps.tabtinspace.db_router.TabtinspaceRouter",
]

INSTALLED_APPS = [  # type: ignore[name-defined]
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.postgres",
    "ninja",
    "apps.users.auth",
    "apps.tabdata",  # tabtinspace.organization_service 间接依赖 Table model
    "apps.tabtinspace",
    "apps.services.oss",
    "apps.i18n",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "apps.i18n.middleware.I18nMiddleware",
]

ROOT_URLCONF = "apps.tabtinspace.tests._planning_test_urls"


class _DisableMigrations(dict):
    def __contains__(self, item):  # type: ignore[override]
        return True

    def __getitem__(self, item):  # type: ignore[override]
        return None


MIGRATION_MODULES = _DisableMigrations()

PASSWORD_HASHERS = [
    "django.contrib.auth.hashers.MD5PasswordHasher",
]
