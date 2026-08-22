"""
TabSlide 数据库路由器

将 TabSlide 模块路由到 PostgreSQL。基于 PostgresAppRouter 基类。
"""

from apps.services.common.db_router import PostgresAppRouter


class SlideRouter(PostgresAppRouter):
    route_app_labels = {"tabslide"}
