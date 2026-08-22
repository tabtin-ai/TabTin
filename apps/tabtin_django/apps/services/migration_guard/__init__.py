"""Migration Guard —— 跨库迁移辅助与一致性自检工具。

背景（AGENTS.md 警告）：
    PostgreSQL 模块迁移必须加 ``--database=postgresql``，否则 PG 库真实的
    DDL 不会被执行，只是 Django 作为"依赖追踪"把记录写到 default 的
    ``django_migrations`` 表。许多用户会误以为"迁移完成了"而实际上 PG
    的 schema 根本没更新。

本模块提供：

    1. ``safe_migrate`` —— 按固定顺序对已配置库执行 ``migrate``；
       含  拆文件半账 reconcile（旧单体 0107/0108 → 补记 0107a/b、0108a/b）。
    2. ``check_migration_integrity`` —— 检测跨库 migration history / schema。
    3. ``migration_risk_check`` —— 静态扫描高风险操作顺序。
    4. ``scenario.PostgresMigrationScenarioTestCase`` —— 临时 PostgreSQL 上
       走「迁到 N-1 → 脏数据 → 迁到 N」的真实升级场景。

重要的"反模式记录"（保留在此避免将来再踩同一坑）：

    **不要**通过 monkey-patch MigrationRecorder 来阻止"跨库写入"。Django
    设计上就要求每个数据库的 ``django_migrations`` 表持有所有 app 的
    完整 applied 记录，即使某 app 的 DDL 并不在该库执行。这些"影子"
    记录是 Django 内部跨 app 依赖追踪的必需数据。拦截它们会导致
    ``InconsistentMigrationHistory`` 异常以及 migrate 行为紊乱。
"""

default_app_config = "apps.services.migration_guard.apps.MigrationGuardConfig"
