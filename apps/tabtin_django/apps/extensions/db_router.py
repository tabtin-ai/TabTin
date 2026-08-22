"""数据库路由：extensions 模块使用 PostgreSQL。"""

from apps.services.common.db_router import PostgresAppRouter


class ExtensionsRouter(PostgresAppRouter):
    route_app_labels = {"extensions"}
