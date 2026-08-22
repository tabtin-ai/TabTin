"""
LlmRouter — 强制 services_llm app 走 PostgreSQL。

v0.1 宪法 §02 §5.1：services_llm app 整体迁 PostgreSQL，与 RAG / agent_engine /
scheduler 同库，方便用量分析跨表 join。

注意：
- DefaultDatabaseRouter._pg_app_labels 已包含 'llm'，但那只控制 migrate 走 PG；
  本 router 显式控制 ORM 的 db_for_read / db_for_write，避免读写仍走 MySQL
  造成 schema 与 IO 路径分裂。
"""


from apps.services.common.db_router import is_single_database_mode, postgres_app_db_alias


class LlmRouter:
    """
    规则：
      - app_label='llm' 的所有 model：read/write/migrate 全部强制走 'postgresql'
      - 跨库关系（如 LLMUsageFact.organization_id 软引用 Organization）通过 CharField
        软引用，不依赖 router；本 router 仅放行同 app 内 PG model 之间的关系。
    """

    route_app_labels = {'llm'}

    def db_for_read(self, model, **hints):
        if model._meta.app_label in self.route_app_labels:
            return postgres_app_db_alias()
        return None

    def db_for_write(self, model, **hints):
        if model._meta.app_label in self.route_app_labels:
            return postgres_app_db_alias()
        return None

    def allow_relation(self, obj1, obj2, **hints):
        if is_single_database_mode():
            return True
        if (
            obj1._meta.app_label in self.route_app_labels
            and obj2._meta.app_label in self.route_app_labels
        ):
            return True
        return None

    def allow_migrate(self, db, app_label, model_name=None, **hints):
        if is_single_database_mode():
            return db == "default"
        if app_label in self.route_app_labels:
            return db == 'postgresql'
        return None
