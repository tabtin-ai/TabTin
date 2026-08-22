"""
通用数据库路由器

为使用 PostgreSQL 的 App 提供统一的 DB Router 基类，
消除 tabdoc / design / ppt 等模块的重复路由代码。

使用方式:
    # 在 apps/{module}/db_router.py 中
    from apps.services.common.db_router import PostgresAppRouter

    class TabdocRouter(PostgresAppRouter):
        route_app_labels = {"tabdoc"}

然后在 settings.py DATABASE_ROUTERS 中注册即可。
"""


def is_single_database_mode() -> bool:
    """Return True when all relational business data lives in default PostgreSQL."""
    try:
        from django.conf import settings
        return bool(getattr(settings, "TABTIN_SINGLE_DATABASE_MODE", False))
    except Exception:
        return False


def postgres_app_db_alias() -> str:
    """Alias for apps that historically routed to the `postgresql` database."""
    return "default" if is_single_database_mode() else "postgresql"


def resolve_db_alias(alias: str) -> str:
    """Map legacy aliases to the active relational DB alias.

    During the single-PG transition, old runtime code may still ask for
    ``postgresql``. Route those calls to ``default`` so ORM reads, raw SQL,
    transactions, and on_commit callbacks share the same Django connection.
    """
    if alias == "postgresql" and is_single_database_mode():
        return "default"
    return alias


class PostgresAppRouter:
    """
    PostgreSQL App 通用路由器

    子类只需定义 `route_app_labels` 集合。

    行为:
      - 读写路由到 "postgresql"
      - 允许与 tabtinspace / users_auth 的跨库关系
      - 迁移只允许在 "postgresql" 上执行
    """

    route_app_labels: set = set()

    # 允许跨库关联的 app_label 集合
    _cross_db_labels = {"tabtinspace", "users_auth"}

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
        labels = self.route_app_labels | self._cross_db_labels
        if obj1._meta.app_label in labels and obj2._meta.app_label in labels:
            return True
        return None

    def allow_migrate(self, db, app_label, model_name=None, **hints):
        if is_single_database_mode():
            return db == "default"
        if app_label in self.route_app_labels:
            return db == "postgresql"
        return None


class DefaultDatabaseRouter:
    """
    兜底路由器 — 必须放在 DATABASE_ROUTERS 列表最后。

    规则：
      - 如果前面的路由器都没有明确处理（全部返回 None），
        则非 PostgreSQL 模块禁止在 postgresql 上迁移，
        PostgreSQL 模块禁止在 default（MySQL）上迁移。
      - 跨库依赖模块（_dual_db_labels）在两个数据库上都允许迁移，
        因为 PostgreSQL 模型通过 select_related 等操作 JOIN 这些表。
    """

    # 所有应路由到 PostgreSQL 的 app_label
    # ⚠️ 新增 PG App 时务必同步加入此处，否则 allow_migrate 会让该 app 的
    # migration 写到 default (MySQL)（兜底分支 `return db == 'default'`），
    # 形成 silent data corruption（详见 cross-db-refs.md §四 4.3）。
    _pg_app_labels = {
        "tabdata",
        "tabtinspace",
        "rag",
        "agent_engine",
        "tracker",
        "tabdoc",
        "tabslide",
        "tabcode",
        "tabvideo",
        "speech",
        "extensions",
        "tabmail",
        "collab",
        "notification",
        "tabchat",
        "tabwhiteboard",
        "tabmemo",
        "capabilities",
        "tins",
        "tabinbox",
        "tabphone",
        "client_errors",
        "tabsite",
        # v3.1（2026-04-19）：app_connect 已删除（Connect 模型作废，见 PRD-v3.1-方向锚）
        "package_registry",
        "user_portrait",  # USER 层用户画像（M1，2026-04-22）
        # browser_env 已于 2026-05-01 完全本地化退役（详见
        # Skills Wave 1（PRD V3.3 §11.1 / W0 决策 1 V2，2026-05-02）：
        # 新模型三张表（Skill / SkillEnablement / SkillPublishedVersion）落 PG，
        # 跟 Package / SpaceAppSettings 同库消除跨库 ref 表 + 启用关系可 join。
        "skills",
        "llm",
    }

    # 主库是 MySQL，但 PostgreSQL 侧也需要影子表（被 55+ 个 FK select_related JOIN）
    # 'auth' 跟 'contenttypes' 也加 dual_db——users_auth 在 PG 影子表的 M2M(groups/user_permissions)
    # FK 指向 auth_group/auth_permission/django_content_type，不补影子会 ProgrammingError
    _dual_db_labels = {"users_auth", "auth", "contenttypes"}

    def db_for_read(self, model, **hints):
        return None

    def db_for_write(self, model, **hints):
        return None

    def allow_relation(self, obj1, obj2, **hints):
        if is_single_database_mode():
            return True
        return None

    def allow_migrate(self, db, app_label, model_name=None, **hints):
        if is_single_database_mode():
            return db == "default"
        if app_label in self._pg_app_labels:
            return db == "postgresql"
        if app_label in self._dual_db_labels:
            return True
        return db == "default"
