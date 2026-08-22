"""
Billing / Payment 测试专用 settings。

目标：
1. 使用单一 SQLite 测试库，避免本地 MySQL 用户没有创建 test 库权限。
2. 将 `postgresql` alias 镜像到 `default`，绕开双 sqlite 迁移阶段的锁表问题。
3. 只加载 billing/payment/oss 相关最小依赖，避免无关模块的 PostgreSQL 专有迁移阻塞。
"""

from __future__ import annotations

from pathlib import Path

from .settings import *  # noqa: F401,F403

_test_db_path = Path(BASE_DIR) / "test_billing_minimal.sqlite3"  # type: ignore[name-defined]

DATABASES["default"] = {  # type: ignore[name-defined]
    "ENGINE": "django.db.backends.sqlite3",
    "NAME": _test_db_path,
}
DATABASES["postgresql"] = {  # type: ignore[name-defined]
    "ENGINE": "django.db.backends.sqlite3",
    "NAME": _test_db_path,
    "TEST": {"MIRROR": "default"},
}

# 测试统一落到一个库，避免双库路由导致表缺失或重复迁移。
DATABASE_ROUTERS = []  # type: ignore[name-defined]

# 只保留 billing/payment 回归所需的最小应用集。
INSTALLED_APPS = [  # type: ignore[name-defined]
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "ninja",
    "apps.users.auth",
    "apps.users.membership",
    "apps.users.wallet",
    "apps.services.payment",
    "apps.services.billing",
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

ROOT_URLCONF = "apps.services.billing.tests.test_urls"
BILLING_DISABLE_ADMIN_ROUTER = True


class _DisableMigrations(dict):
    def __contains__(self, item):  # type: ignore[override]
        return True

    def __getitem__(self, item):  # type: ignore[override]
        return None


MIGRATION_MODULES = _DisableMigrations()

PASSWORD_HASHERS = [
    "django.contrib.auth.hashers.MD5PasswordHasher",
]
