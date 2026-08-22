"""
数据库路由 — 将 tabsite 的所有模型操作路由到 PostgreSQL

【注意】此 App 的 migrate 命令必须加 --database=postgresql:
  python manage.py migrate tabsite --database=postgresql

如果遗漏该参数，迁移会被误记录到 MySQL 的 django_migrations 表，
而 PostgreSQL 实际未执行 DDL，运行时报 column does not exist。
"""

from apps.services.common.db_router import PostgresAppRouter


class TabsiteRouter(PostgresAppRouter):
    route_app_labels = {"tabsite"}
