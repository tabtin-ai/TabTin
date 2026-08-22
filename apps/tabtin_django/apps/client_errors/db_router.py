"""客户端错误监控模块数据库路由器 - 路由到 PostgreSQL。"""


from apps.services.common.db_router import is_single_database_mode, postgres_app_db_alias


class ClientErrorsRouter:

    route_app_labels = {"client_errors"}

    def db_for_read(self, model, **hints):
        if model._meta.app_label in self.route_app_labels:
            return postgres_app_db_alias()
        return None

    def db_for_write(self, model, **hints):
        if model._meta.app_label in self.route_app_labels:
            return postgres_app_db_alias()
        return None

    def allow_relation(self, obj1, obj2, **hints):
        if is_single_database_mode():
            return True
        if (
            obj1._meta.app_label in self.route_app_labels
            or obj2._meta.app_label in self.route_app_labels
        ):
            return True
        return None

    def allow_migrate(self, db, app_label, model_name=None, **hints):
        if is_single_database_mode():
            return db == "default"
        if app_label in self.route_app_labels:
            return db == "postgresql"
        return None
