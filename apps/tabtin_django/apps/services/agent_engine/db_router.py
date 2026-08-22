"""
Agent Engine 数据库路由器

Wave 11（2026-04-17）：将 Agent 引擎 7 个运行期 model（ExecutionTrace / TraceEvent /
ExecutionRun / SubtaskRun / ConversationState / SubAgentTemplate / MonitorTask）
的读写路由到 PostgreSQL，migration 目标同样锁定到 PostgreSQL。

继承 ``PostgresAppRouter`` 保持与 tabdoc/rag/scheduler 等兄弟模块一致的实现。
"""

from apps.services.common.db_router import PostgresAppRouter


class AgentEngineRouter(PostgresAppRouter):
    """Agent Engine 模块数据库路由器，仅路由 app_label='agent_engine' 的模型。"""

    route_app_labels = {"agent_engine"}
