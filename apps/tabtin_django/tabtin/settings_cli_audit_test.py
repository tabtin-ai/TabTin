"""CLI 测试 settings（CLI audit + 执行前 verify stub + Wave H Skill 同步注册）。

策略（参考 ``settings_planning_test.py``）：

- ``default`` + ``postgresql`` 两个 alias 各用独立的 SQLite 文件，
  绕过本地 MySQL CREATE DATABASE 权限缺失 + PG 测试库重复创建的循环依赖。
- 保留 ``AgentEngineRouter``，让 ``CliAuditEvent`` 等模型路由到 ``postgresql``，
  与生产环境的路由行为一致；``transaction.atomic(using='postgresql')`` 正确生效。
- 禁用全部 migration（直接 ``syncdb`` 建表），避免 conversation MySQL 专有 DDL
  在 sqlite 上失败。
- 加载 CLI audit + Wave H Skill 同步注册所需的最小 app 集合。

> v3.1（2026-04-19）：``app_connect`` 整体删除（方向锚 H2），原"保留
> ``AppConnectRouter``" 配置已同步移除。

使用方式：

    cd apps/tabtin_django && source venv/bin/activate
    DJANGO_SETTINGS_MODULE=tabtin.settings_cli_audit_test \
        python -m pytest apps/services/agent_engine/cli/tests/test_audit.py -v

也是 ``apps/services/agent_engine/cli/tests/conftest.py`` 的默认 settings。
"""
from __future__ import annotations

from .settings import *  # noqa: F401,F403


# 让 default 与 postgresql 各自映射到独立 sqlite 文件，并显式 ``DEPENDENCIES=[]``
# 避免 Django ``get_unique_databases_and_mirrors`` 默认引入"default 依赖 postgresql"
# 的隐式 dep 触发 "Circular dependency in TEST[DEPENDENCIES]"
DATABASES["default"] = {  # type: ignore[name-defined]
    "ENGINE": "django.db.backends.sqlite3",
    "NAME": str(BASE_DIR / "test_cli_audit_default.sqlite3"),  # noqa: F405
    "TEST": {
        "NAME": str(BASE_DIR / "test_cli_audit_default.sqlite3"),  # noqa: F405
        "DEPENDENCIES": [],
    },
}
DATABASES["postgresql"] = {  # type: ignore[name-defined]
    "ENGINE": "django.db.backends.sqlite3",
    "NAME": str(BASE_DIR / "test_cli_audit_postgresql.sqlite3"),  # noqa: F405
    "TEST": {
        "NAME": str(BASE_DIR / "test_cli_audit_postgresql.sqlite3"),  # noqa: F405
        "DEPENDENCIES": [],
    },
}

DATABASE_ROUTERS = [  # type: ignore[name-defined]
    "apps.services.agent_engine.db_router.AgentEngineRouter",
    # users_auth 是 dual-DB（两个库都建表），其 M2M through 表引用 auth_permission
    # / auth_group（仅 default 库），SQLite FK 检查在 TransactionTestCase flush
    # 时会报 "no such table"。让 auth/contenttypes 也 dual-DB 修复此问题。
    "tabtin.settings_cli_audit_test._TestDualDbRouter",
]

INSTALLED_APPS = [  # type: ignore[name-defined]
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "apps.users.auth",
    "apps.credential_vault.apps.CredentialVaultConfig",
    "apps.services.agent_engine.apps.AgentEngineConfig",
    # v3.1 方向锚 · Wave H：Skill 同步注册需要 ManagedSkill 模型
    "apps.skills.apps.SkillsConfig",
]

MIDDLEWARE = [  # type: ignore[name-defined]
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
]

ROOT_URLCONF = "apps.services.agent_engine.cli.tests._empty_urls"


class _TestDualDbRouter:
    """测试环境 dual-DB router：让 ``auth`` / ``contenttypes`` 在两个库都存在。

    仅在测试 settings 中使用，避免 TransactionTestCase flush 时 SQLite FK 报
    ``no such table: auth_permission`` 错误（users_auth M2M through 表引用）。
    """

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


class _DisableMigrations(dict):
    def __contains__(self, item):  # type: ignore[override]
        return True

    def __getitem__(self, item):  # type: ignore[override]
        return None


MIGRATION_MODULES = _DisableMigrations()

PASSWORD_HASHERS = [
    "django.contrib.auth.hashers.MD5PasswordHasher",
]
