"""Wave E — App Platform Admin API 单元测试 settings。

独立 sqlite 文件避免 MySQL/PG 环境依赖。
仅加载 admin_app_platform_api 所需的最小 app 集。
"""
from __future__ import annotations

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

SECRET_KEY = "test-secret-key-for-app-platform-tests"
DEBUG = True

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": str(BASE_DIR / "test_app_platform_default.sqlite3"),
        "TEST": {
            "NAME": str(BASE_DIR / "test_app_platform_default.sqlite3"),
            "DEPENDENCIES": [],
        },
    },
    "postgresql": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": str(BASE_DIR / "test_app_platform_pg.sqlite3"),
        "TEST": {
            "NAME": str(BASE_DIR / "test_app_platform_pg.sqlite3"),
            "DEPENDENCIES": [],
        },
    },
}

INSTALLED_APPS = [
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "apps.users.auth",
    "apps.credential_vault.apps.CredentialVaultConfig",
    "apps.services.agent_engine.apps.AgentEngineConfig",
]

DATABASE_ROUTERS = [
    "apps.services.agent_engine.db_router.AgentEngineRouter",
    "tabtin.settings_app_platform_test._DualDbRouter",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
]

ROOT_URLCONF = "apps.services.agent_engine.cli.tests._empty_urls"

AUTH_USER_MODEL = "users_auth.User"

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

PASSWORD_HASHERS = [
    "django.contrib.auth.hashers.MD5PasswordHasher",
]


class _DisableMigrations(dict):
    def __contains__(self, item):  # type: ignore[override]
        return True

    def __getitem__(self, item):  # type: ignore[override]
        return None


MIGRATION_MODULES = _DisableMigrations()


class _DualDbRouter:
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
