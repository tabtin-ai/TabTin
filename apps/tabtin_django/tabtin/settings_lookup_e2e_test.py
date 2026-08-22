"""
Lookup E2E 测试专用 settings。

目标：
1. 使用 PostgreSQL 双库，避免 sqlite 与 PG 专有迁移 SQL 不兼容。
2. 保留迁移，确保模型/约束行为尽量接近真实环境。
3. 移除 rag（依赖 pgvector）以降低本地测试前置依赖。
"""

from __future__ import annotations

import os

from .settings import *  # noqa: F401,F403


def _build_pg_config(name: str) -> dict:
    return {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": name,
        "USER": os.getenv("PG_DB_USER", "postgres"),
        "PASSWORD": os.getenv("PG_DB_PASSWORD", ""),
        "HOST": os.getenv("PG_DB_HOST", "localhost"),
        "PORT": os.getenv("PG_DB_PORT", "5432"),
        "OPTIONS": {
            "options": "-c search_path=public",
        },
    }


_pg_db_name = os.getenv("PG_DB_NAME", "tabtin_single")
_pg_test_db_name = os.getenv("PG_TEST_DB_NAME", "test_tabtin_e2e")

DATABASES["default"] = _build_pg_config(_pg_db_name)
DATABASES["default"]["TEST"] = {"NAME": _pg_test_db_name}
# 测试使用单一数据库，postgresql 镜像 default
DATABASES["postgresql"] = _build_pg_config(_pg_db_name)
DATABASES["postgresql"]["TEST"] = {"MIRROR": "default"}

# rag 依赖 pgvector，测试场景无需加载
INSTALLED_APPS = [app for app in INSTALLED_APPS if app != "apps.rag"]  # type: ignore[name-defined]
# 禁用所有数据库路由，让所有表都在 default 库中创建
DATABASE_ROUTERS = []  # type: ignore[assignment]

# oss.0002 迁移在 PG 上触发 like-index 名冲突，tabdata.0013 又依赖 oss.0001。
# 彻底禁用所有迁移，改用 syncdb 从 model 直接建表，避免迁移图冲突。
class _DisableMigrations:
    def __contains__(self, item: str) -> bool:
        return True

    def __getitem__(self, item: str):
        return None

MIGRATION_MODULES = _DisableMigrations()  # type: ignore[assignment]

PASSWORD_HASHERS = [
    "django.contrib.auth.hashers.MD5PasswordHasher",
]
