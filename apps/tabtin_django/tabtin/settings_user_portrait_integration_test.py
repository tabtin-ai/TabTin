"""
v0.2 USER 画像集成测试 settings — 验证 _check_organization_membership + API 端点。

跟 ``settings_user_portrait_test`` 的区别：
  - 装一个 ``label="tabtinspace"`` 的 fake app（``apps.user_portrait.tests
    ._fake_tabtinspace``），定义最小 Organization / OrganizationMember 模型；
  - 不装真的 ``apps.tabtinspace``，因为它链式依赖 ``apps.tabdata``，而
    tabdata 的 ArrayField 在 SQLite ``CREATE TABLE`` 报 syntax error；
  - fake 模型字段跟真模型在 _check_organization_membership 关心的字段对齐
    （id / owner_id / organization_id / user_id），因此校验逻辑是真测的，
    不是 mock。

为什么这样设计：
  - "P0-7 隐私级缺口"必须有真实数据库的 owner / member / outsider 三方对照
    才能验证；纯 mock 容易掩盖逻辑漏洞。
  - 真 tabtinspace 在 SQLite 跑不起来是基础设施债，不是业务问题；用 fake
    app 隔离这个债，不阻塞 v0.2 隔离不变量的覆盖。

使用方式：
    cd apps/tabtin_django && source venv/bin/activate
    pytest --ds=tabtin.settings_user_portrait_integration_test \\
        apps/user_portrait/tests/test_membership_integration.py \\
        apps/user_portrait/tests/test_api.py
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

# in-memory SQLite 不分库；fake_tabtinspace 跟 user_portrait 同一个 alias 即可。
DATABASE_ROUTERS = []  # type: ignore[name-defined]

INSTALLED_APPS = [  # type: ignore[name-defined]
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "apps.users.auth",
    # fake tabtinspace 必须在 user_portrait 之前注册——确保 apps.get_model
    # 在导入 user_portrait.signals 时已能解析到 ``tabtinspace.Organization``。
    "apps.user_portrait.tests._fake_tabtinspace.apps.FakeTabtinspaceConfig",
    "apps.user_portrait.apps.UserPortraitConfig",
]

MIDDLEWARE = [  # type: ignore[name-defined]
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
]

ROOT_URLCONF = "tabtin.tests_urls_empty"


class _DisableMigrations(dict):
    def __contains__(self, item):  # type: ignore[override]
        return True

    def __getitem__(self, item):  # type: ignore[override]
        return None


MIGRATION_MODULES = _DisableMigrations()


PASSWORD_HASHERS = [
    "django.contrib.auth.hashers.MD5PasswordHasher",
]
