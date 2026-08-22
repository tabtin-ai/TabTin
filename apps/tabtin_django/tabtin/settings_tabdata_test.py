"""
TabData 测试专用设置（PostgreSQL 版本）— 仅用于自动化测试，请勿在生产环境引用。

用途：
- 避免默认测试配置把 `default` 和 `postgresql` 同时切到 sqlite，
  导致 PostgreSQL 专用迁移 SQL（如 DO 语句）在 sqlite 下失败。
- 避免测试时依赖本地 MySQL socket（/tmp/mysql.sock）。

使用方式：
    apps/tabtin_django/venv/bin/python \
    apps/tabtin_django/manage.py test \
    apps.tabdata.tests.test_import_export_enhanced \
    --settings tabtin.settings_tabdata_test
"""

from __future__ import annotations

import os

from .settings import *  # noqa: F401,F403


def _build_pg_config(name: str) -> dict:
    return {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": name,
        "USER": os.getenv("PG_DB_USER", "tabtin_single"),
        "PASSWORD": os.getenv("PG_DB_PASSWORD", ""),
        "HOST": os.getenv("PG_DB_HOST", "localhost"),
        "PORT": os.getenv("PG_DB_PORT", "5432"),
        "OPTIONS": {
            "options": "-c search_path=public",
        },
    }


_pg_db_name = os.getenv("PG_DB_NAME", "tabtin_single")
_pg_test_db_name = os.getenv("PG_TEST_DB_NAME", "test_tabtin_tabdata")

DATABASES["default"] = _build_pg_config(_pg_db_name)
DATABASES["postgresql"] = _build_pg_config(_pg_db_name)

# 两个 alias 共用同一物理测试库
# postgresql 设为 default 的 MIRROR，Django 只创建/销毁 default 的测试库
DATABASES["default"]["TEST"] = {"NAME": _pg_test_db_name}
DATABASES["postgresql"]["TEST"] = {"MIRROR": "default"}

# 清空路由器：syncdb 在单库上创建所有表，避免跨库 FK 与表缺失问题
DATABASE_ROUTERS = []  # type: ignore[name-defined]

# TabData 代码用 TABDATA_DB_ALIAS 路由查询（默认 'postgresql'）；
# 测试环境强制改为 'default'，保证 TestCase 事务内数据可见。
TABDATA_DB = "default"

# pgvector 扩展可能未安装，排除所有使用 pgvector.django.VectorField 的 app
_PGVECTOR_APPS = {"apps.rag", "apps.capabilities"}
INSTALLED_APPS = [  # type: ignore[name-defined]
    app for app in INSTALLED_APPS
    if app not in _PGVECTOR_APPS
    and not any(app.startswith(p + ".") for p in _PGVECTOR_APPS)
]

# 主 urls.py 会 import 被排除的 app，使用空 URLConf 跳过
ROOT_URLCONF = "apps.tabdata.tests.empty_urls"

class _DisableMigrations(dict):
    """
    TabData 测试场景下禁用全部迁移，统一走 syncdb 建表。
    目标是快速验证服务逻辑，避免历史迁移脚本在临时库阻塞。
    """

    def __contains__(self, item):  # type: ignore[override]
        return True

    def __getitem__(self, item):  # type: ignore[override]
        return None


MIGRATION_MODULES = _DisableMigrations()
