"""
Plan Service 集成测试 settings — 验证 plan_create → Document → ContextItem → Collection 链路。

基于 settings_planning_test 扩展：增加 tabdoc app 和路由。
"""
from __future__ import annotations

from .settings_planning_test import *  # noqa: F401,F403

INSTALLED_APPS = [  # type: ignore[name-defined]
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.postgres",
    "ninja",
    "django_celery_results",
    "apps.users.auth",
    "apps.tabdata",
    "apps.tabtinspace",
    "apps.tabdoc",
    "apps.services.oss",
    "apps.i18n",
]

CELERY_TASK_ALWAYS_EAGER = True  # type: ignore[name-defined]
CELERY_TASK_EAGER_PROPAGATES = True  # type: ignore[name-defined]


class _PlanIntegrationRouter:
    """Routes tabtinspace + tabdoc to 'postgresql' alias; users_auth to 'default'."""

    _pg_labels = {"tabtinspace", "tabdoc"}

    def db_for_read(self, model, **hints):
        if model._meta.app_label == "users_auth":
            return "default"
        if model._meta.app_label in self._pg_labels:
            return "postgresql"
        return None

    def db_for_write(self, model, **hints):
        if model._meta.app_label == "users_auth":
            return "default"
        if model._meta.app_label in self._pg_labels:
            return "postgresql"
        return None

    def allow_relation(self, obj1, obj2, **hints):
        labels = {obj1._meta.app_label, obj2._meta.app_label}
        if labels & self._pg_labels:
            return True
        return None

    def allow_migrate(self, db, app_label, model_name=None, **hints):
        if app_label in self._pg_labels:
            return db == "postgresql"
        return None


DATABASE_ROUTERS = [  # type: ignore[name-defined]
    "tabtin.settings_plan_integration_test._PlanIntegrationRouter",
]
