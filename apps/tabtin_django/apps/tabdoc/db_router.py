"""
TabDoc 数据库路由器

将 TabDoc (tabdoc) 模块路由到 PostgreSQL。基于 PostgresAppRouter 基类。
"""

from apps.services.common.db_router import PostgresAppRouter


class TabdocRouter(PostgresAppRouter):
    route_app_labels = {"tabdoc"}
