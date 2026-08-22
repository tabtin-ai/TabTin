"""用户画像数据库路由。

UserPortrait 与 TabMemo / Organization 同库（PostgreSQL），蒸馏时需要直接读 TabMemo。
"""

from apps.services.common.db_router import PostgresAppRouter


class UserPortraitRouter(PostgresAppRouter):
    route_app_labels = {"user_portrait"}
