"""
Schema Discovery数据库路由器

将Schema Discovery模块的数据路由到PostgreSQL数据库
"""


class SchemaDiscoveryRouter:
    """
    Schema Discovery专用数据库路由器

    路由规则：
    - apps.schema_discovery下的所有模型使用PostgreSQL
    - 利用PostgreSQL的JSONB特性存储Schema数据
    """

    route_app_labels = {'schema_discovery'}

    def db_for_read(self, model, **hints):
        """
        读取操作的数据库路由

        Schema Discovery模型从PostgreSQL读取
        """
        if model._meta.app_label in self.route_app_labels:
            return 'postgresql'
        return None  # 其他模型使用default数据库

    def db_for_write(self, model, **hints):
        """
        写入操作的数据库路由

        Schema Discovery模型写入PostgreSQL
        """
        if model._meta.app_label in self.route_app_labels:
            return 'postgresql'
        return None  # 其他模型使用default数据库

    def allow_relation(self, obj1, obj2, **hints):
        """
        允许关系的规则

        Schema Discovery模型可以关联User模型（跨数据库）
        """
        # 如果两个对象都在schema_discovery中，允许关系
        if obj1._meta.app_label in self.route_app_labels and \
           obj2._meta.app_label in self.route_app_labels:
            return True

        # Schema Discovery可以关联User模型
        if obj1._meta.app_label in self.route_app_labels and \
           obj2._meta.app_label == 'users_auth':
            return True

        if obj2._meta.app_label in self.route_app_labels and \
           obj1._meta.app_label == 'users_auth':
            return True

        return None

    def allow_migrate(self, db, app_label, model_name=None, **hints):
        """
        迁移操作的数据库路由

        - Schema Discovery的迁移只在postgresql数据库执行
        - 其他app的迁移不在postgresql数据库执行
        """
        if app_label in self.route_app_labels:
            return db == 'postgresql'

        # 其他app不在postgresql数据库迁移
        if db == 'postgresql':
            return False

        return None
