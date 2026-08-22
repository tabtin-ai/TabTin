"""FTS Services 层。

Wave 1 提供：
    - `sync_service`：业务模型 → ES 文档的转换（6 类 `to_*_document`）
    - `outbox_service`：Outbox 表的写入 / 扫描 / 标记（PRD 4.3.B）
    - `bulk_buffer`：`helpers.bulk` 失败隔离 + 分级重试（Wave 0 D3 规范）

Wave 2+ 将补充：
    - `search_service`：multi_search + RRF
    - `hydration_service`：批量查 PG 补 Space/Agent 元信息
    - `acl_service`：Membership-scoped Space ACL
    - `fallback_service`：breaker open 时的降级路径
"""

from __future__ import annotations
