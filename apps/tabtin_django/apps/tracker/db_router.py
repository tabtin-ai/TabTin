"""
Tracker 数据库路由器

将 Tracker 模块路由到 PostgreSQL。

波次 3b（2026-05-25）：从 SchedulerRouter / route_app_labels={"scheduler"} 改名而来。
"""

from apps.services.common.db_router import is_single_database_mode, postgres_app_db_alias

# v0.1 §5.1（2026-05-07 收尾）：``TrackerRun.chat_session`` 已从 FK 退化为 UUIDField 软引用，
# 不再需要在 router 层放行 ``conversation`` 跨库关系——保留 ``users_auth`` / ``tabtinspace``
# 是因为还有 ``Tracker.created_by`` / ``Tracker.organization`` 等其他 FK 需要 router 放行。
_CROSS_DB_LABELS = {"users_auth", "tabtinspace"}


class TrackerRouter:
    route_app_labels = {"tracker"}

    def db_for_read(self, model, **hints):
        if is_single_database_mode() and model._meta.app_label in self.route_app_labels:
            return "default"
        if model._meta.app_label == "users_auth":
            return "default"
        if model._meta.app_label in self.route_app_labels:
            return postgres_app_db_alias()
        return None

    def db_for_write(self, model, **hints):
        if is_single_database_mode() and model._meta.app_label in self.route_app_labels:
            return "default"
        if model._meta.app_label == "users_auth":
            return "default"
        if model._meta.app_label in self.route_app_labels:
            return postgres_app_db_alias()
        return None

    def allow_relation(self, obj1, obj2, **hints):
        if is_single_database_mode():
            return True
        if obj1._meta.app_label in self.route_app_labels and obj2._meta.app_label in self.route_app_labels:
            return True

        if obj1._meta.app_label in self.route_app_labels and obj2._meta.app_label in _CROSS_DB_LABELS:
            return True

        if obj2._meta.app_label in self.route_app_labels and obj1._meta.app_label in _CROSS_DB_LABELS:
            return True

        return None

    def allow_migrate(self, db, app_label, model_name=None, **hints):
        if is_single_database_mode():
            return db == "default"
        if app_label in self.route_app_labels:
            return db == "postgresql"
        if db == "postgresql":
            return None
        return None

