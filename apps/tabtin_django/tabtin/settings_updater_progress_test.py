"""Updater 公开 API（/updates/progress 等）测试专用 settings。

为什么不复用 ``settings_updater_test``：
该文件装了 ``apps.tabtinspace``，而 tabtinspace 的 app ready 链路
（signals → services → organization_service）如今 import 了 ``apps.tabdata``
乃至 billing 模型——在最小应用集 + SQLite 下无法加载（PG 专属字段建表失败）。
公开 API 测试不需要 Organization/Space，砍掉 tabtinspace 即可保持最小集稳定。

使用方式：
    cd apps/tabtin_django
    ./venv/bin/python manage.py test apps.updater.tests.test_progress_api \\
        --settings=tabtin.settings_updater_progress_test
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
    "TEST": {"MIRROR": "default"},
}

DATABASE_ROUTERS = []  # type: ignore[name-defined]

INSTALLED_APPS = [  # type: ignore[name-defined]
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "ninja",
    "apps.users.auth",
    # asset_service 的 blockmap 资产测试需要 FileRecord / FileUsage
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

ROOT_URLCONF = "apps.updater.tests.progress_test_urls"


class _DisableMigrations(dict):
    def __contains__(self, item):  # type: ignore[override]
        return True

    def __getitem__(self, item):  # type: ignore[override]
        return None


MIGRATION_MODULES = _DisableMigrations()

PASSWORD_HASHERS = [
    "django.contrib.auth.hashers.MD5PasswordHasher",
]
