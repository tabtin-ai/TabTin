"""FTS Outbox 双栈模型（PRD 4.3.B + ADR-04）+ Wave 5 SearchAnalytics。

Outbox Pattern 用于保障增量同步的最终一致性：
    1. 业务 `post_save` signal handler 在事务内写 Outbox（与业务数据同原子）
    2. `transaction.on_commit` 回调发 Celery 任务以最低延迟消费
    3. `scan_outbox_task`（Wave 1 beat 每 5s）扫描未处理条目，兜底发送

之所以 MySQL + PG 各建一份 Outbox，是因为同一事务不能跨数据库，
`ChatMessage` 写 MySQL 的事务中只能写 MySQL 端 Outbox，
`ContextItem` / `Agent` 等写 PG 的事务中只能写 PG 端 Outbox。

Router：`apps.fts.db_router.FtsRouter`（见同目录 db_router.py）。

Wave 5 新增 SearchAnalytics（PRD 6.4）：
    - 记录每次搜索的 query / types / 命中数 / 耗时 / 降级状态 / 点击行为
    - 数据库选 PostgreSQL（与 FtsOutboxPg 同库），便于零结果分析（PG 优于 MySQL）
"""

from __future__ import annotations

import uuid

from django.db import models


class FtsOutboxBase(models.Model):
    """双栈 Outbox 的公共字段抽象基类。

    同步字段：
        - index_name：目标 ES 索引名（如 `tabtin-messages`、
          `tabtin-resources`，或 rollover 后的 `tabtin-messages-2026-04`）
        - doc_id：ES 文档主键（通常等于业务模型 pk 的字符串形式）
        - action：`upsert` / `delete` / `update_by_query`（Wave 1 起扩展）
        - organization_id：租户隔离上下文；便于 Wave 2 ACL 失效 / 降级
          rate limit 按租户切片
        - created_at：入队时间（用于延迟指标、backlog 告警）
        - processed_at：扫描 worker 处理后写入；`NULL` = 待处理
        - retry_count：失败重试计数（配合 Wave 1 retry_backoff）
        - last_error：最近一次失败原因摘要（截断，便于定位）

    action 统一为短字符串，避免 Wave 间语义发散；具体允许值由 Wave 1
    在 tasks 层做校验。
    """

    ACTION_MAX_LEN = 16
    INDEX_NAME_MAX_LEN = 64
    DOC_ID_MAX_LEN = 64
    ORGANIZATION_ID_MAX_LEN = 64
    LAST_ERROR_MAX_LEN = 512

    # action 合法值枚举（业务层用 `FtsOutboxBase.Action.*` 引用）。
    # Wave 0 只定义常量，Wave 1 在 tasks 层做校验；这里用 TextChoices
    # 自动获得前端/管理后台的选择文案。
    class Action(models.TextChoices):
        UPSERT = "upsert", "Upsert"
        DELETE = "delete", "Delete"

    id = models.BigAutoField(primary_key=True)
    index_name = models.CharField(max_length=INDEX_NAME_MAX_LEN)
    doc_id = models.CharField(max_length=DOC_ID_MAX_LEN)
    action = models.CharField(
        max_length=ACTION_MAX_LEN,
        choices=Action.choices,
    )
    # organization_id 使用 NULL 表示"无租户上下文"，严禁与有租户的空串混用
    # （Review A7：便于 Wave 2 `WHERE organization_id IS NOT NULL` 做 backlog
    #  分租户切片 / 降级限流按租户计数）。
    organization_id = models.CharField(
        max_length=ORGANIZATION_ID_MAX_LEN,
        null=True,
        blank=True,
    )
    created_at = models.DateTimeField(auto_now_add=True)
    processed_at = models.DateTimeField(null=True, blank=True)
    retry_count = models.IntegerField(default=0)
    last_error = models.CharField(
        max_length=LAST_ERROR_MAX_LEN,
        blank=True,
        default="",
    )

    class Meta:
        abstract = True


class FtsOutbox(FtsOutboxBase):
    """MySQL（default）侧 Outbox。

    覆盖模型：`ChatMessage`、`ChatSession`（对话消息 + 会话元信息）。
    """

    class Meta:
        app_label = "fts"
        db_table = "fts_outbox"
        indexes = [
            # MySQL 不支持 partial index，走普通复合索引；
            # `processed_at IS NULL` 的过滤借助列上 NULL 最前的选择性即可。
            models.Index(
                fields=["processed_at", "created_at"],
                name="fts_outbox_proc_created_idx",
            ),
            models.Index(
                fields=["index_name", "doc_id"],
                name="fts_outbox_idx_doc_idx",
            ),
            # 租户切片查询（Wave 2/5 backlog 监控 + 降级 rate limit）
            models.Index(
                fields=["organization_id", "processed_at"],
                name="fts_outbox_wt_proc_idx",
            ),
        ]


class FtsOutboxPg(FtsOutboxBase):
    """PostgreSQL 侧 Outbox。

    覆盖模型：`ContextItem`、`Agent`、`Space`、`Memo`、tabchat.Message。
    """

    class Meta:
        app_label = "fts"
        db_table = "fts_outbox_pg"
        indexes = [
            # PG partial index：只索引待处理行，扫描 worker 查询成本
            # 与 backlog 大小线性；已处理行不占索引空间。
            models.Index(
                fields=["processed_at", "created_at"],
                name="fts_outbox_pg_pending_idx",
                condition=models.Q(processed_at__isnull=True),
            ),
            models.Index(
                fields=["index_name", "doc_id"],
                name="fts_outbox_pg_idx_doc_idx",
            ),
            # 租户切片 partial（同上语义，仅 pending 行纳入）
            models.Index(
                fields=["organization_id", "processed_at"],
                name="fts_outbox_pg_wt_pending_idx",
                condition=models.Q(processed_at__isnull=True),
            ),
        ]


# ── Wave 5 新增：搜索行为分析（PRD 6.4） ────────────────────────
class SearchAnalytics(models.Model):
    """每次 `/api/search` 调用的分析快照。

    用途：
        - 零结果率分析（PRD 6.3 告警入口）
        - CTR / 点击位置分析（点击哪几条结果）
        - 降级覆盖率（degraded 路径的实际命中比例）
        - Agent vs 人 搜索行为对比

    数据库选 PostgreSQL：
        - 与 FtsOutboxPg 同库，简化运维
        - PG GIN 索引对 query 文本分析友好（`tsvector`），后续可加索引
        - organization_id / created_at 双索引足够支撑 24h 级别的运营查询

    隐私：
        - 不记录 IP / User-Agent / 整段 message body
        - query 字段是用户输入；上线前需要法务确认是否截断或脱敏（PRD 5.5）

    GDPR：
        - 用户主动删除账号时，由 `manage.py fts_forget_user <user_id>` 一并清理
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    user_id = models.UUIDField(db_index=True)
    organization_id = models.UUIDField(db_index=True)
    query = models.TextField()
    types = models.CharField(max_length=64, blank=True, default="")
    result_count = models.IntegerField()
    took_ms = models.IntegerField()
    degraded = models.BooleanField(default=False)
    # Wave 5 R4-09 新增：notice 字段也写入分析（区分"无访问 Space"）
    notice = models.CharField(max_length=64, null=True, blank=True)
    clicked_result_id = models.CharField(max_length=64, null=True, blank=True)
    clicked_result_type = models.CharField(max_length=32, null=True, blank=True)
    clicked_position = models.IntegerField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        app_label = "fts"
        db_table = "fts_analytics"
        indexes = [
            models.Index(fields=["organization_id", "-created_at"]),
            models.Index(fields=["result_count", "-created_at"]),  # 零结果分析
            models.Index(fields=["user_id", "-created_at"]),  # 用户行为分析
        ]
