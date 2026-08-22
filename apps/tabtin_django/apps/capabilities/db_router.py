"""
Capabilities 模块数据库路由器

继承 PostgresAppRouter，将所有 capabilities 模型路由到 PostgreSQL。
"""

from apps.services.common.db_router import PostgresAppRouter


class CapabilitiesRouter(PostgresAppRouter):
    route_app_labels = {"capabilities"}
