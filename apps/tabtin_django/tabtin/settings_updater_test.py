"""
Updater 测试专用 settings。

目标：
1. 使用单一 SQLite 测试库，避免默认测试配置的双库锁表问题。
2. 只加载 updater 管理 API 回归所需的最小应用集，提升稳定性与执行速度。
"""

from __future__ import annotations

from pathlib import Path

from .settings import *  # noqa: F401,F403

_test_db_path = Path(BASE_DIR) / "test_updater_minimal.sqlite3"  # type: ignore[name-defined]

DATABASES["default"] = {  # type: ignore[name-defined]
    "ENGINE": "django.db.backends.sqlite3",
    "NAME": _test_db_path,
}
DATABASES["postgresql"] = {  # type: ignore[name-defined]
    "ENGINE": "django.db.backends.sqlite3",
    "NAME": _test_db_path,
    "TEST": {"MIRROR": "default"},
}

DATABASE_ROUTERS = []  # type: ignore[name-defined]

INSTALLED_APPS = [  # type: ignore[name-defined]
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "ninja",
    "apps.users.auth",
    "apps.tabtinspace",
    "apps.services.oss",
    "apps.updater",
    "apps.i18n",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "apps.i18n.middleware.I18nMiddleware",
]

ROOT_URLCONF = "apps.updater.tests.test_urls"


class _DisableMigrations(dict):
    def __contains__(self, item):  # type: ignore[override]
        return True

    def __getitem__(self, item):  # type: ignore[override]
        return None


MIGRATION_MODULES = _DisableMigrations()

PASSWORD_HASHERS = [
    "django.contrib.auth.hashers.MD5PasswordHasher",
]
