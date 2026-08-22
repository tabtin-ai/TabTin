"""
原生列存储模块 (Native Column Storage)

将多维表格从 JSONField 存储迁移到 PostgreSQL 原生列，
让每张多维表格成为一张真正的数据库表。

模块组成：
- pg_type_map: 字段类型 → PostgreSQL 列类型映射
- ddl_manager: Schema / Table / Column DDL 操作
- query_builder: 原生 SQL 查询构建（Filter / Sort / Aggregate）
- record_io: 原生记录读写（INSERT / SELECT / UPDATE）
- value_converter: Python ↔ PostgreSQL 值转换
- feature_flags: 迁移阶段控制开关
- backfill_service: 历史数据回填 (Phase 1)
- consistency_checker: 数据一致性校验 (Phase 2)
- agent_sql: Agent SQL 接入层 (Phase 4)
"""
