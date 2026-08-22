"""
TabData 数据库路由器

将 TabData 模块的数据路由到 PostgreSQL 数据库
其他模块继续使用 MySQL 数据库

特别处理跨数据库的 ForeignKey 查询
"""
from apps.services.common.db_router import is_single_database_mode, postgres_app_db_alias
from apps.tabdata.constants import TABDATA_DB_ALIAS


class TabdataRouter:
    """
    TabData 专用数据库路由器

    路由规则：
    - apps.tabdata 下的所有模型使用 PostgreSQL
    - 其他模型使用 default（MySQL）
    - 特别处理：User 模型始终使用 MySQL（default）
    """

    route_app_labels = {'tabdata'}

    def db_for_read(self, model, **hints):
        """
        读取操作的数据库路由

        特殊处理：User模型始终从MySQL读取
        """
        if is_single_database_mode() and model._meta.app_label in self.route_app_labels:
            return "default"
        # User模型（users_auth）始终使用MySQL
        if model._meta.app_label == 'users_auth':
            return 'default'

        # TabData 模型使用 PostgreSQL
        if model._meta.app_label in self.route_app_labels:
            return postgres_app_db_alias()

        return None

    def db_for_write(self, model, **hints):
        if is_single_database_mode() and model._meta.app_label in self.route_app_labels:
            return "default"
        if model._meta.app_label == 'users_auth':
            return 'default'

        # TabData 模型使用 PostgreSQL
        if model._meta.app_label in self.route_app_labels:
            return postgres_app_db_alias()

        return None  # 其他模型使用default数据库

    def allow_relation(self, obj1, obj2, **hints):
        """
        允许关系的规则

        TabData 模型可以关联 User 模型（跨数据库）
        其他关系按默认规则处理
        """
        if is_single_database_mode():
            return True
        # 如果两个对象都在同一个app中，允许关系
        if obj1._meta.app_label in self.route_app_labels and \
           obj2._meta.app_label in self.route_app_labels:
            return True

        # TabData 模型可以关联 User / OSS / Context Space 模型
        if obj1._meta.app_label in self.route_app_labels and \
           obj2._meta.app_label in {'users_auth', 'oss', 'tabtinspace'}:
            return True

        if obj2._meta.app_label in self.route_app_labels and \
           obj1._meta.app_label in {'users_auth', 'oss', 'tabtinspace'}:
            return True

        return None

    def allow_migrate(self, db, app_label, model_name=None, **hints):
        """
        迁移操作的数据库路由

        - TabData 的迁移只在 PostgreSQL 数据库执行
        - 其他 app 在 PostgreSQL 的迁移返回 None 交由其他路由器决定
        """
        if is_single_database_mode():
            return db == "default"
        if app_label in self.route_app_labels:
            return db == TABDATA_DB_ALIAS

        if db == TABDATA_DB_ALIAS:
            return None

        return None
