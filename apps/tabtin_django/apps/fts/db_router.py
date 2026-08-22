"""FTS 双栈数据库路由器（ADR-04）。

职责：
    - `FtsOutbox` 路由到 MySQL（default），对齐 `ChatMessage` 等所在库的
      signal 事务边界，避免跨库一致性盲区。
    - `FtsOutboxPg` 路由到 PostgreSQL（postgresql），对齐 PG 侧模型的
      signal 事务边界。

之所以同 app 下两个模型路由到不同库，是因为 PRD 4.3 要求 Outbox 写入
必须与业务 `post_save` 处于同一事务；TabTin 业务库双栈并存
（MySQL + PG），因此 Outbox 也必须双栈。

注意：
    - `FtsRouter` 必须注册在 `DefaultDatabaseRouter` 之前，确保能先决策。
    - 不修改 `DefaultDatabaseRouter._pg_app_labels`；`fts` 由本 Router
      独立管理（未登记模型会抛 ImproperlyConfigured，避免默默写错库）。
    - `users_auth` 等跨库模型由现有路由链管理，本 Router 不涉及关联判定。

新增 fts 模型须显式登记：
    1. 在 `_PG_MODELS` 或 `_MYSQL_MODELS` 中加入小写 model_name；
    2. 若跨库关联（读其他 PG app），在 `allow_relation` 里补规则；
    3. 运行 `manage.py makemigrations fts --database=<target>`。
未登记将触发 `ImproperlyConfigured`，这是刻意设计（Review A6）。
"""

from __future__ import annotations

from django.core.exceptions import ImproperlyConfigured

from apps.services.common.db_router import is_single_database_mode, postgres_app_db_alias


# model_name 在 Django 内部统一为小写，例如
#   FtsOutbox       -> 'ftsoutbox'
#   FtsOutboxPg     -> 'ftsoutboxpg'
#   SearchAnalytics -> 'searchanalytics'（Wave 5 新增；与 FtsOutboxPg 同库）
_PG_MODELS: frozenset[str] = frozenset({"ftsoutboxpg", "searchanalytics"})
_MYSQL_MODELS: frozenset[str] = frozenset({"ftsoutbox"})


def _resolve_db(model) -> str | None:
    if model._meta.app_label != "fts":
        return None
    if is_single_database_mode():
        return "default"
    model_name = model._meta.model_name
    if model_name in _PG_MODELS:
        return postgres_app_db_alias()
    if model_name in _MYSQL_MODELS:
        return "default"
    # 未知 fts 模型 -> 强制开发期失败，防止数据静默落错库
    raise ImproperlyConfigured(
        f"apps.fts 模型 {model_name!r} 未在 FtsRouter 登记。"
        f" 请将它加入 apps/fts/db_router.py 的 _PG_MODELS 或 _MYSQL_MODELS，"
        f" 并同步更新 makemigrations 目标数据库。",
    )


class FtsRouter:
    """基于 model_name 拆分 fts app 内的双库模型。"""

    def db_for_read(self, model, **hints):
        return _resolve_db(model)

    def db_for_write(self, model, **hints):
        return _resolve_db(model)

    def allow_relation(self, obj1, obj2, **hints):
        if is_single_database_mode():
            return True
        # 本 App 不声明跨库关系；让后续路由器或 Django 默认逻辑决定。
        return None

    def allow_migrate(self, db, app_label, model_name=None, **hints):
        if app_label != "fts":
            return None
        # makemigrations 早期 state 检查 model_name=None，交给后续路由器
        if model_name is None:
            return None
        if is_single_database_mode():
            return db == "default"
        name = str(model_name).lower()
        if name in _PG_MODELS:
            return db == "postgresql"
        if name in _MYSQL_MODELS:
            return db == "default"
        # 未登记模型：不做判定，交给 DefaultDatabaseRouter 兜底
        # （兜底会禁止写入 postgresql，MySQL 也不是目标库时 migration 静默跳过）。
        # 注意：makemigrations 不会走这里，只有真正执行 migrate 才会。
        # 真正的保护放在 _resolve_db 运行时 raise。
        return None
