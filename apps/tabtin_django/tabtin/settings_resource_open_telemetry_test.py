"""
「Agent 产物在 Space 内的打开」专题 Wave 7 — ResourceOpenTelemetry endpoint
集成测试专用 settings。

为何独立 settings（参考 ``settings_user_portrait_test.py`` / ``settings_approval_memo_test.py`` 同款模式）：

- 主 ``tabtin.settings`` 的 migration 链含 MySQL 专用 ``CONVERT TO CHARACTER
  SET utf8mb4`` (`payment/0007` / `billing/0024`) + PG 专用 ARRAY[]/GIN/tsvector
  等 DDL，在默认 SQLite 测试库（``USE_SQLITE_FOR_TESTS=1``）上撞语法错。
- 但本 endpoint 测试只需要 ``apps.services.agent_engine`` 的 ResourceOpenEvent
  表 + 用户认证骨架，**不需要** payment / billing / tabdata 等其它 app 的
  migration 跑通。
- 所以走 ``MIGRATION_MODULES = _DisableMigrations()`` 让 Django syncdb 直接按
  models.py 建表，绕开整条历史 migration。

使用方式（与 W7 北极星 #3 对齐）：

    cd apps/tabtin_django && source venv/bin/activate
    DJANGO_SETTINGS_MODULE=tabtin.settings_resource_open_telemetry_test \\
        python manage.py test \\
        apps.services.agent_engine.tests.test_resource_open_telemetry

或用 pytest（conftest 的 ``_ISOLATED_SETTINGS_HINTS`` 自动 route）：

    cd apps/tabtin_django && pytest \\
        apps/services/agent_engine/tests/test_resource_open_telemetry.py
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


# 缩 INSTALLED_APPS 到本测试需要的最小集，避免主 settings 里 tabdata / billing /
# payment 等 app 的 model 在 SQLite 上 syncdb 撞 ARRAY[] / pg_indexes / FULLTEXT
# 等 PG/MySQL-only 字段。
INSTALLED_APPS = [  # type: ignore[name-defined]
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "apps.users.auth",
    "apps.services.agent_engine.apps.AgentEngineConfig",
]


class _DisableMigrations(dict):
    def __contains__(self, item):  # type: ignore[override]
        return True

    def __getitem__(self, item):  # type: ignore[override]
        return None


MIGRATION_MODULES = _DisableMigrations()


# Isolated settings 不走主 urls.py（避免 import 整个 deferred router 链）。
# 直接挂 telemetry endpoint，让测试能 POST 真路由。
ROOT_URLCONF = "tabtin.tests_urls_resource_open_telemetry"

MIDDLEWARE = [  # type: ignore[name-defined]
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
]


PASSWORD_HASHERS = [
    "django.contrib.auth.hashers.MD5PasswordHasher",
]
