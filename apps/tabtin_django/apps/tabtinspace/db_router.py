"""
Tabtin Space 数据库路由器

将 Tabtin Space 模型路由到 PostgreSQL。
"""


from apps.services.common.db_router import is_single_database_mode, postgres_app_db_alias


class TabtinspaceRouter:
    # Agent 已拆到 apps.agent，但仍与 Space/Organization 同库同事务。
    route_app_labels = {'tabtinspace', 'agent'}

    def db_for_read(self, model, **hints):
        if is_single_database_mode() and model._meta.app_label in self.route_app_labels:
            return "default"
        if model._meta.app_label == 'users_auth':
            return 'default'
        if model._meta.app_label in self.route_app_labels:
            return postgres_app_db_alias()
        return None

    def db_for_write(self, model, **hints):
        if is_single_database_mode() and model._meta.app_label in self.route_app_labels:
            return "default"
        if model._meta.app_label == 'users_auth':
            return 'default'
        if model._meta.app_label in self.route_app_labels:
            return postgres_app_db_alias()
        return None

    def allow_relation(self, obj1, obj2, **hints):
        if is_single_database_mode():
            return True
        if obj1._meta.app_label in self.route_app_labels and \
           obj2._meta.app_label in self.route_app_labels:
            return True

        if obj1._meta.app_label in self.route_app_labels and \
           obj2._meta.app_label in {'users_auth', 'oss', 'tabdata', 'conversation', 'tracker'}:
            return True

        if obj2._meta.app_label in self.route_app_labels and \
           obj1._meta.app_label in {'users_auth', 'oss', 'tabdata', 'conversation', 'tracker'}:
            return True

        return None

    def allow_migrate(self, db, app_label, model_name=None, **hints):
        if is_single_database_mode():
            return db == "default"
        if app_label in self.route_app_labels:
            return db == 'postgresql'
        return None
