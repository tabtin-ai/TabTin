"""Agent Memory 数据库路由器

将 ``agent_memory`` 域路由到与 TabMemo 相同的 PostgreSQL 库（``PostgresAppRouter``
基类解析到 ``postgres_app_db_alias()``，single_pg 下即 ``default``）。

⚠️  W1 不变量：读写只经 router 决策，**不显式** ``.using()``——避免在
``manage.py test`` 的镜像连接下，``select_for_update`` 与 fixture 写入落到不同
物理连接而互锁（W1 曾因此挂死 10 分钟）。
"""

from apps.services.common.db_router import PostgresAppRouter


class AgentMemoryRouter(PostgresAppRouter):
    route_app_labels = {"agent_memory"}
    _cross_db_labels = PostgresAppRouter._cross_db_labels | {"llm"}
