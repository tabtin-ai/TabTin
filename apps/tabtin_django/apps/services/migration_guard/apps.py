from django.apps import AppConfig


class MigrationGuardConfig(AppConfig):
    """Migration Guard —— safe_migrate / check_migration_integrity /
    migration_risk_check / scenario.PostgresMigrationScenarioTestCase。

    注意：不再注入 GuardedMigrationRecorder 补丁。

    起初尝试通过覆写 MigrationRecorder 阻止 ``allow_migrate=False`` 的记录写入
    当前 DB 的 ``django_migrations`` 表，但实测表明这会破坏 Django 的 cross-app
    dependency 检查：Django 设计上要求 **每个数据库的 django_migrations 表都
    记录所有 app 的完整 history**，即使某 app 的 DDL 不在该库执行——这些记录
    用于让 ``check_consistent_history`` 验证跨库 migration 依赖关系。

    详见 apps/services.migration_guard 包注释。
    """

    name = "apps.services.migration_guard"
    label = "migration_guard"
    verbose_name = "Migration Guard"
