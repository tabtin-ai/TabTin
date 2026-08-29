"""
Schema Market 数据库路由

与 schema_discovery 保持一致，使用 PostgreSQL 存储模板及使用记录。
"""


class SchemaMarketRouter:
    route_app_labels = {'schema_market'}

    def db_for_read(self, model, **hints):
        if model._meta.app_label in self.route_app_labels:
            return 'postgresql'
        return None

    def db_for_write(self, model, **hints):
        if model._meta.app_label in self.route_app_labels:
            return 'postgresql'
        return None

    def allow_relation(self, obj1, obj2, **hints):
        if obj1._meta.app_label in self.route_app_labels and obj2._meta.app_label in self.route_app_labels:
            return True
        if obj1._meta.app_label in self.route_app_labels and obj2._meta.app_label == 'users_auth':
            return True
        if obj2._meta.app_label in self.route_app_labels and obj1._meta.app_label == 'users_auth':
            return True
        return None

    def allow_migrate(self, db, app_label, model_name=None, **hints):
        if app_label in self.route_app_labels:
            return db == 'postgresql'
        if db == 'postgresql':
            return None
        return None
