"""
W2-轮 1（PRD 05 v0.4 §7.7）· PermissionAudit 单测专用 settings。

策略与 ``settings_approval_memo_test.py`` 一致：
- in-memory SQLite for both 'default' + 'postgresql' alias
- ``MIGRATION_MODULES = _DisableMigrations()`` 让 Django 直接 syncdb 建表
- INSTALLED_APPS 只装单测需要的最小集（agent_engine + users.auth + tabtinspace）

使用方式：
    cd apps/tabtin_django && source venv/bin/activate
    DJANGO_SETTINGS_MODULE=tabtin.settings_permission_audit_test \\
        python manage.py test \\
        apps.services.agent_engine.tests.test_permission_audit_model -v 2

或 pytest：
    pytest --ds=tabtin.settings_permission_audit_test \\
        apps/services/agent_engine/tests/test_permission_audit_model.py

⚠️ ``test_indexes_present_in_pg`` 在 SQLite 下跳过（PG 专有 pg_indexes 视图）。
真实 PG 索引存在性由 ``bash scripts/backend/migrate-all.sh`` + ``migrate-check.sh`` 双库
迁移强约束保证；本测试套件主要验证 model schema / 字段 / 查询路径。
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

DATABASE_ROUTERS = []  # type: ignore[name-defined]

INSTALLED_APPS = [  # type: ignore[name-defined]
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "apps.users.auth",
    "apps.services.agent_engine",
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
