"""数据库路由：tabchat 模块使用 PostgreSQL。"""

from apps.services.common.db_router import PostgresAppRouter


class TabchatRouter(PostgresAppRouter):
    route_app_labels = {"tabchat"}
