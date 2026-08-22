"""FTS Outbox 写入 / 扫描 / 标记（PRD 4.3.B / ADR-04）。

双栈约束：
    - MySQL 上的业务（ChatMessage 等）写 `FtsOutbox`（default 库）
    - PG 上的业务（ContextItem/Agent/Space/Memo/tabchat.Message）写 `FtsOutboxPg`

函数统一以 `db: Literal['default', 'postgresql']` 做分发。

扫描（D5 约束）：
    `scan_outbox` 必须 `.filter(processed_at__isnull=True).order_by('created_at')`
    以命中 PG 的 `fts_outbox_pg_pending_idx`（partial index，`WHERE
    processed_at IS NULL`）；MySQL 端走普通 `(processed_at, created_at)`
    复合索引。顺序一致避免"新旧交替打破 created_at 排序"的数据倾斜。

注意：
    - 写入发生在业务 signal 的**事务内**，不能放 `transaction.on_commit`
      推迟（推迟意味着如果事务被回滚，outbox 条目会缺失）
    - signal 的 `transaction.on_commit` 只用于发 Celery 任务，
      让扫描 worker 提前拿到任务而非兜底 5s 才触发
"""

from __future__ import annotations

import logging
from typing import Any, Literal, Optional

from django.db import models as django_models
from django.db.models import F
from django.utils import timezone

from apps.fts.models import FtsOutbox, FtsOutboxBase, FtsOutboxPg

logger = logging.getLogger(__name__)

__all__ = [
    "DbAlias",
    "write_outbox",
    "scan_outbox",
    "mark_processed",
    "mark_failed",
    "mark_terminal",
    "requeue_terminal",
    "list_terminal_rows",
    "TERMINAL_RETRY_COUNT",
    "get_model",
    "get_backlog",
    "get_terminal_backlog",
]

DbAlias = Literal["default", "postgresql"]

_DB_MODEL_MAP: dict[str, type[FtsOutboxBase]] = {
    "default": FtsOutbox,
    "postgresql": FtsOutboxPg,
}


def get_model(db: DbAlias) -> type[FtsOutboxBase]:
    """按 db 别名返回对应 Outbox Model。

    未登记的 db 直接 raise（防止调用方误传）。
    """
    try:
        return _DB_MODEL_MAP[db]
    except KeyError as exc:
        raise ValueError(
            f"未知 Outbox db alias: {db!r}。允许值: {list(_DB_MODEL_MAP.keys())}",
        ) from exc


def _validate_action(action: str) -> str:
    """校验 action 是否在枚举范围内。"""
    valid = {c.value for c in FtsOutboxBase.Action}
    if action not in valid:
        raise ValueError(f"非法 Outbox action: {action!r}。允许值: {sorted(valid)}")
    return action


def _truncate_error(err: str, limit: int = FtsOutboxBase.LAST_ERROR_MAX_LEN) -> str:
    """截断错误信息到 DB 字段长度（避免 DataError）。"""
    if err is None:
        return ""
    s = str(err)
    if len(s) <= limit:
        return s
    return s[: limit - 1] + "…"


# ── 写入 ────────────────────────────────────────────────────────
def write_outbox(
    *,
    db: DbAlias,
    index_name: str,
    doc_id: str,
    action: str,
    organization_id: Optional[str] = None,
) -> FtsOutboxBase:
    """写入一条 Outbox（签名强制 kwonly，避免调用方顺序混淆）。

    - 该函数**必须在 signal 的事务内**调用；不要包 `transaction.on_commit`
    - 写失败直接 raise（事务内一致性由 signal 调用方保障）
    - 返回创建的 row，便于测试 / 统计
    """
    _validate_action(action)
    Model = get_model(db)
    row = Model.objects.using(db).create(
        index_name=index_name[: Model.INDEX_NAME_MAX_LEN],
        doc_id=doc_id[: Model.DOC_ID_MAX_LEN],
        action=action,
        organization_id=(organization_id or None),
    )
    logger.debug(
        "[FTS] outbox written db=%s index=%s doc=%s action=%s id=%s",
        db, index_name, doc_id, action, row.id,
    )
    return row


# ── 扫描（D5 partial index 命中约束） ──────────────────────────
def scan_outbox(
    db: DbAlias,
    *,
    limit: int = 500,
    max_retries: int = 5,
) -> list[FtsOutboxBase]:
    """扫描待处理 Outbox。

    - 严格按 `processed_at IS NULL` + `ORDER BY created_at` 以命中
      `fts_outbox_pg_pending_idx`（D5 PG partial index 命中约束）
    - 跳过 `retry_count >= max_retries` 的失败样本，交人工/Admin 处理
    - 批次大小 500 默认（PRD 4.3.C bulk 合并窗口）
    """
    Model = get_model(db)
    qs = (
        Model.objects
        .using(db)
        .filter(processed_at__isnull=True, retry_count__lt=max_retries)
        .order_by("created_at")
        [:limit]
    )
    return list(qs)


# ── 标记处理结果 ────────────────────────────────────────────────
def mark_processed(db: DbAlias, ids: list[int]) -> int:
    """批量标记已成功处理，返回影响行数。

    需要单独事务（`transaction.atomic(using=db)`），调用方自己控制
    （调用方通常是 Celery 任务，task 内部自行起事务）。
    """
    if not ids:
        return 0
    Model = get_model(db)
    now = timezone.now()
    return (
        Model.objects
        .using(db)
        .filter(id__in=ids, processed_at__isnull=True)
        .update(processed_at=now)
    )


def mark_failed(db: DbAlias, row_id: int, error: str) -> int:
    """单条标记失败（retry_count +1，写 last_error），返回影响行数。

    保持 `processed_at=NULL` 让 `scan_outbox_task` 按 backoff 继续重试，
    直到 `retry_count >= max_retries` 被扫描过滤。

    **注意**：schema 类失败（strict_dynamic / mapper_parsing）用
    `mark_terminal` 直接置为终态，避免无意义重试 5 次。
    """
    Model = get_model(db)
    return (
        Model.objects
        .using(db)
        .filter(id=row_id, processed_at__isnull=True)
        .update(
            retry_count=F("retry_count") + 1,
            last_error=_truncate_error(error),
        )
    )


# 终态失败阈值：和 `scan_outbox` 的 max_retries 一致，确保 mark_terminal
# 后下一轮 scan 立即过滤这条 row。Wave 5 Prometheus 接 gauge 监控
# `WHERE retry_count >= TERMINAL_RETRY_COUNT` 的行数。
TERMINAL_RETRY_COUNT = 5


def mark_terminal(db: DbAlias, row_id: int, error: str) -> int:
    """把一条 outbox row 直接标记为**终态失败**，不再重试。

    触发场景（D3 规范）：
        - strict_dynamic_mapping_exception（需 SRE 先 put_mapping 再 requeue）
        - mapper_parsing_exception / document_parsing_exception（schema/数据问题）
        - illegal_argument_exception

    行为：
        1. `retry_count` 强制设为 `TERMINAL_RETRY_COUNT=5`，被 `scan_outbox`
           的 `retry_count__lt` 过滤永远跳过
        2. `last_error` 写清楚失败原因（前面带 `TERMINAL:` 前缀便于 grep）
        3. `processed_at` 保持 NULL（未处理），避免被误认为"成功"；Wave 5
           Grafana 按 `retry_count >= 5 AND processed_at IS NULL` 算积压告警

    Wave 5 会加：
        - Prometheus gauge `fts_outbox_terminal_total{failure_class, db}`
        - Admin `manage.py fts_requeue_terminal <row_id>` 修复后重放
    """
    Model = get_model(db)
    truncated = _truncate_error(f"TERMINAL: {error}")
    affected = (
        Model.objects
        .using(db)
        .filter(id=row_id, processed_at__isnull=True)
        .update(
            retry_count=TERMINAL_RETRY_COUNT,
            last_error=truncated,
        )
    )
    if affected:
        logger.error(
            "[FTS][TERMINAL] outbox row %s on db=%s permanently stuck: %s. "
            "SRE action: put_mapping the missing field then `manage.py fts_requeue_terminal %s`",
            row_id, db, truncated, row_id,
        )
    return affected


# ── 监控辅助（Wave 5 指标会用） ────────────────────────────────
def get_backlog(db: DbAlias) -> int:
    """未处理 Outbox 行数，供 Wave 5 Prometheus gauge 使用。"""
    Model = get_model(db)
    return (
        Model.objects
        .using(db)
        .filter(processed_at__isnull=True)
        .count()
    )


def get_terminal_backlog(db: DbAlias) -> int:
    """终态失败的 Outbox 行数（需要 SRE 人工介入）。

    Wave 5 Prometheus gauge：
        fts_outbox_terminal_backlog{db} = get_terminal_backlog(db)
    告警规则建议：> 0 持续 5 分钟 → Critical（schema 问题积压）
    """
    Model = get_model(db)
    return (
        Model.objects
        .using(db)
        .filter(processed_at__isnull=True, retry_count__gte=TERMINAL_RETRY_COUNT)
        .count()
    )


# ── 终态失败重新入队（R5-13） ──────────────────────────────────
def list_terminal_rows(
    db: DbAlias,
    *,
    limit: int = 100,
    row_ids: Optional[list[int]] = None,
) -> list[FtsOutboxBase]:
    """列出处于终态失败的 outbox 行（用于 SRE 排查 + 选择性 requeue）。

    Args:
        db: outbox 库别名
        limit: 单次最多列多少（防误操作；默认 100）
        row_ids: 若提供，仅返回这些 ID 中**确实是 terminal 状态**的行
                 （非 terminal / 不存在的 ID 静默忽略）
    """
    Model = get_model(db)
    qs = (
        Model.objects
        .using(db)
        .filter(processed_at__isnull=True, retry_count__gte=TERMINAL_RETRY_COUNT)
    )
    if row_ids:
        qs = qs.filter(id__in=list(row_ids))
    return list(qs.order_by("id")[:limit])


def requeue_terminal(
    db: DbAlias,
    row_ids: list[int],
    *,
    clear_error: bool = True,
) -> int:
    """把终态失败的 outbox 行重新入队（让 scan_outbox 下一轮重新拉取）。

    使用场景（D3 + ROLLBACK §4.2）：
        SRE 修好 mapping（PUT mapping 加缺失字段）后，把已经 mark_terminal
        的 row 重置 retry_count=0 + 清空 last_error，让 `scan_outbox_task`
        下一轮把它们当作 pending 重新拉取并 bulk flush。

    幂等性：
        - 只对 `processed_at IS NULL AND retry_count >= TERMINAL_RETRY_COUNT`
          的行操作，已 mark_processed 的成功行不动
        - 多次 requeue 同一行：第一次成功 (1)，后续返回 0（行已不在 terminal）

    Args:
        db: outbox 库别名 ('default' / 'postgresql')
        row_ids: 待 requeue 的 row id 列表
        clear_error: 是否同时清空 last_error 字段（默认 True，避免 grep
                     混淆"还在失败"和"刚 requeue"）

    Returns:
        受影响行数（>= 0）。0 表示这些 ID 都不在 terminal 状态
        （已成功 / 不存在 / retry_count < TERMINAL）
    """
    if not row_ids:
        return 0
    Model = get_model(db)
    update_kwargs: dict[str, Any] = {"retry_count": 0}
    if clear_error:
        update_kwargs["last_error"] = ""
    affected = (
        Model.objects
        .using(db)
        .filter(
            id__in=list(row_ids),
            processed_at__isnull=True,
            retry_count__gte=TERMINAL_RETRY_COUNT,
        )
        .update(**update_kwargs)
    )
    if affected:
        logger.info(
            "[FTS][REQUEUE] db=%s requeued %d terminal rows (ids=%s clear_error=%s); "
            "scan_outbox_task next tick will re-pull",
            db, affected, row_ids[:10], clear_error,
        )
    return affected
