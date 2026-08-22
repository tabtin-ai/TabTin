"""
RAG 模块数据库路由器

将 RAG 模块的所有模型路由到 PostgreSQL 数据库
"""


from apps.services.common.db_router import is_single_database_mode, postgres_app_db_alias


class RagRouter:
    """
    RAG 模块数据库路由器

    将 apps.rag 模块的所有模型操作路由到 postgresql 数据库
    """

    route_app_labels = {'rag'}

    def db_for_read(self, model, **hints):
        """
        读操作路由
        """
        if model._meta.app_label in self.route_app_labels:
            return postgres_app_db_alias()
        return None

    def db_for_write(self, model, **hints):
        """
        写操作路由
        """
        if model._meta.app_label in self.route_app_labels:
            return postgres_app_db_alias()
        return None

    def allow_relation(self, obj1, obj2, **hints):
        """
        RAG 模型之间允许关系；
        RAG 模型与其他库模型禁止 FK（使用 UUID 手动引用）。
        """
        if is_single_database_mode():
            return True
        labels = {obj1._meta.app_label, obj2._meta.app_label}
        if labels <= self.route_app_labels:
            return True
        if labels & self.route_app_labels:
            return False
        return None

    def allow_migrate(self, db, app_label, model_name=None, **hints):
        """
        迁移路由

        RAG 模块只在 postgresql 数据库中迁移
        """
        if is_single_database_mode():
            return db == "default"
        if app_label in self.route_app_labels:
            return db == 'postgresql'
        return None
