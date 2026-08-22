"""TabTin 统一搜索引擎（Full-Text Search）。

本 App 承载 PRD《2026-04-16-unified-search-engine》的后端实现：
    - 客户端（client.py）连接阿里云 Elasticsearch 8.x 托管服务
    - 索引定义（index_definitions.py）维护 6 个索引 mapping
    - Outbox（models.py）保障增量同步最终一致
    - Celery 队列 `search_indexing` 消费索引任务

Wave 0 范围：基础设施骨架。signal 注册 / API / RRF / 降级走后续 Wave。

`SEARCH_ENGINE_ENABLED` 的 flag 状态矩阵（ADR-12）：

+----------------+----------------+---------------+--------------------+
| 层             | flag=false     | flag=true     | 备注               |
+================+================+===============+====================+
| apps.py ready  | 不注册 signal  | 注册 signal   | Wave 1 起注册      |
+----------------+----------------+---------------+--------------------+
| client.get_    | raise Search-  | 返回单例      | 调用方必须判断     |
| client()       | EngineDisabled |               |                    |
+----------------+----------------+---------------+--------------------+
| signal handler | 不写 outbox    | 写 outbox     | Wave 1 在 handler  |
| （Wave 1+）    |                |               | 开头 gate          |
+----------------+----------------+---------------+--------------------+
| scan_outbox_   | 跳过消费       | 正常消费      | Wave 1 起实现      |
| task（Wave 1+）|                |               |                    |
+----------------+----------------+---------------+--------------------+
| /api/search    | 走原有 DB 搜索 | 走 ES + 降级  | Wave 2 起实现；    |
| （Wave 2+）    | 路径           |               | breaker open 亦降级|
+----------------+----------------+---------------+--------------------+

回滚：`SEARCH_ENGINE_ENABLED=false` 是安全回滚开关（ADR-13），
切换后无需重启其他服务；outbox 已有数据不丢失，等 flag 再打开后继续消费。

Django 3.2+ 已自动发现 `FtsConfig`，不再需要 `default_app_config`。
"""
