"""
Wave 2 协作者邀请 / 管理 service 单测专用 settings。

策略：
- in-memory SQLite for default + postgresql aliases（绕开本地 PG/MySQL 依赖）
- ``MIGRATION_MODULES = _DisableMigrations()`` 让 Django syncdb 建表，
  绕过 conversation/0024 的 MySQL FULLTEXT、PG GIN/tsvector 等 SQLite 不认的 DDL
- INSTALLED_APPS 装 share service 用例需要的最小集
- DATABASE_ROUTERS 保留 tabdoc/tabdata/tabtinspace/notification 路由器（因
  service 代码会显式 ``.using('postgresql')`` 和 ``connections['postgresql'].on_commit``）

使用方式：
    cd apps/tabtin_django && source venv/bin/activate
    DJANGO_SETTINGS_MODULE=tabtin.settings_share_test \\
        python -m pytest apps/tabdoc/tests/test_share_service.py \\
                          apps/tabdata/tests/test_share_service.py -v

约定：本 settings 仅服务于 share service 测试，未来若有新协作者相关测试可复用。
"""
from __future__ import annotations

from .settings import *  # noqa: F401,F403


# 本 isolated settings 用 _ShareTestRouter 把 tabtinspace 等表建到 'postgresql'
# alias（双库布局仿真）。service 代码统一经 postgres_app_db_alias() 取 alias
# ，必须声明双库模式让其返回 'postgresql'，与 router 落表位置一致；
# 否则 single_pg 默认下 alias 解析为 'default'，default 库无表直接报错。
TABTIN_DATABASE_MODE = "dual"
TABTIN_SINGLE_DATABASE_MODE = False

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

# in-memory SQLite — 不走 router，所有 app 都建到同一个 default 库；
# 但 share_service 代码会显式调 ``.using('postgresql')``，因此 postgresql 别名
# 也必须存在。Django 测试 client 默认对 ``databases`` 集合做隔离 — 测试类要在
# ``databases = {"default", "postgresql"}`` 显式声明。


class _ShareTestRouter:
    """让 tabdoc / tabdata / tabtinspace / notification 都路由到 'postgresql' alias，
    并阻止 SQLite 上无法创建的 PG-only DDL 模型进入 syncdb。

    share_service 代码全程显式 .using('postgresql')、connections['postgresql']，
    必须保持路由一致才能让 ORM 查询命中。
    """

    _PG_APPS = {"tabdoc", "tabdata", "tabtinspace", "notification", "oss"}

    _SKIP_MODELS = {
        # tabdata 模块下纯 PG 模型
        "tabdata.computedoutbox",
        "tabdata.computedoutboxdlq",
        "tabdata.computedoutboxoverflow",
        "tabdata.shadowcomparison",
        "tabdata.shadowlegacysnapshot",
        "tabdata.rowpolicy",
        "tabdata.apicalllog",
        "tabdata.apiusagesummary",
        "tabdata.dataconnector",
        "tabdata.connectortablemapping",
        "tabdata.dbreadonlyconnection",
        "tabdata.tableapitoken",
    }

    def db_for_read(self, model, **hints):
        if model._meta.app_label in self._PG_APPS:
            return "postgresql"
        return None

    def db_for_write(self, model, **hints):
        if model._meta.app_label in self._PG_APPS:
            return "postgresql"
        return None

    def allow_relation(self, obj1, obj2, **hints):
        # 隔离 settings 下两个 alias 都是 SQLite，跨库 join 实际是同一文件
        return True

    def allow_migrate(self, db, app_label, model_name=None, **hints):
        if model_name is not None:
            key = f"{app_label}.{model_name}".lower()
            if key in self._SKIP_MODELS:
                return False
        if app_label in self._PG_APPS:
            return db == "postgresql"
        return None


DATABASE_ROUTERS = [  # type: ignore[name-defined]
    "tabtin.settings_share_test._ShareTestRouter",
]

INSTALLED_APPS = [  # type: ignore[name-defined]
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.postgres",
    "apps.users.auth",
    "apps.users.membership",
    "apps.tabtinspace",
    "apps.services.oss",
    "apps.services.notification",
    "apps.services.billing",
    "apps.tabdoc",
    "apps.tabdata",
]

# 主 urls.py 会 import 大量 app 路由，单测不走 HTTP — 用空 URLConf
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
