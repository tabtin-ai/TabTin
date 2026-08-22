"""Skills 数据库路由器（PostgreSQL）。

Wave 1（PRD V3.3 §11.1 / W0 决策 1 V2）：

`apps.skills` app_label 路由到 PostgreSQL，跟 `Package` / `SpaceAppSettings` 同库
便于 join。新模型三张表（Skill / SkillEnablement / SkillPublishedVersion）全部
落 PG，旧云端 MySQL 表一次性下线。
"""

from apps.services.common.db_router import PostgresAppRouter


class SkillsRouter(PostgresAppRouter):
    route_app_labels = {"skills"}
