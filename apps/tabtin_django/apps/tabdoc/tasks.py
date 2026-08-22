"""
TabDoc 异步任务 (V3)

任务清单:
- merge_doc_updates:          每 30s 合并 DocUpdate 队列到 Document 快照
- cleanup_expired_history:    每小时清理过期 DocHistory + 分级降采样
- create_document_version:    [V2 兼容] 旧版全量快照任务，保留但不再由新代码触发
"""
import logging
from datetime import timedelta

from celery import shared_task
from django.conf import settings
from django.db import transaction
from django.db.models import Count
from django.utils import timezone

from apps.tabdoc.models import HISTORY_TTL_FREE, HISTORY_TTL_PRO, HISTORY_TTL_TEAM

logger = logging.getLogger("tabdoc.tasks")

_TIER_TTL_MAP = {
    "free": HISTORY_TTL_FREE,       # 7 天
    "basic": HISTORY_TTL_PRO,       # 30 天
    "pro": HISTORY_TTL_PRO,         # 30 天
    "enterprise": HISTORY_TTL_TEAM,  # 90 天
}


def _resolve_history_ttl(organization_id) -> int:
    """根据组织会员等级返回历史版本 TTL（秒）。"""
    if not organization_id:
        return HISTORY_TTL_FREE
    try:
        from apps.users.membership.models import OrganizationMembership

        ws = OrganizationMembership.objects.select_related("tier").filter(
            organization_id=str(organization_id),
            status="active",
        ).first()
        if ws is None:
            return HISTORY_TTL_FREE
        if ws.end_date is not None and ws.end_date < timezone.now():
            return HISTORY_TTL_FREE
        tier_type = getattr(ws.tier, "tier_type", None)
        return _TIER_TTL_MAP.get(tier_type, HISTORY_TTL_FREE)
    except Exception:
        # INT-79: 付费用户被降级为 free TTL 时应有 warning 级日志可观测
        logger.warning(
            "Failed to resolve organization tier for %s, using free TTL",
            organization_id,
            exc_info=True,
        )
        return HISTORY_TTL_FREE


# ═══════════════════════════════════════════════════════════════════
# Celery Beat 调度配置
# ═══════════════════════════════════════════════════════════════════

TABDOC_BEAT_SCHEDULE = {
    "tabdoc-merge-doc-updates-sweep": {
        "task": "tabdoc.merge_doc_updates_sweep",
        "schedule": 120,
        "kwargs": {"limit": 100},
        "options": {"expires": 100, "queue": "doc_merge"},
    },
    "tabdoc-cleanup-history": {
        "task": "tabdoc.cleanup_expired_history",
        "schedule": 3600,
        "options": {"expires": 3000},
    },
    "tabdoc-fix-missing-binary": {
        "task": "tabdoc.fix_missing_binary",
        "schedule": 3600 * 6,  # 每 6 小时
        "kwargs": {"limit": 200},
        "options": {"expires": 3600 * 5},
    },
    "tabdoc-cleanup-orphan-comment-attachments": {
        "task": "tabdoc.cleanup_orphan_comment_attachments",
        "schedule": 3600,
        "options": {"expires": 3000},
    },
}


@shared_task(
    name="tabdoc.cleanup_orphan_comment_attachments",
    ignore_result=True,
    time_limit=300,
    soft_time_limit=280,
)
def cleanup_orphan_comment_attachments():
    from apps.tabdoc.services.comment_attachment_service import CommentAttachmentService

    return CommentAttachmentService.cleanup_orphans()


def _is_document_embedding_enabled() -> bool:
    """Return whether automatic TabDoc embedding is enabled globally."""
    return (
        getattr(settings, "RAG_ENABLED", True)
        and getattr(settings, "RAG_AUTO_EMBED_DOCUMENTS", True)
    )


# ═══════════════════════════════════════════════════════════════════
# V3 新任务
# ═══════════════════════════════════════════════════════════════════


@shared_task(
    name="tabdoc.index_document_embedding",
    bind=True,
    max_retries=2,
    ignore_result=True,
    time_limit=900,
    soft_time_limit=840,
    queue="rag_indexing",
)
def index_document_embedding(self, document_id: str, root_task_id: str = None):
    """
    INT-26/INT-27: 异步执行单文档 embedding 索引。

    由 merge_doc_updates 合并成功后触发，避免同步 embedding 阻塞 Beat 任务。
    内置 Celery 重试机制，失败有追踪日志。

    TD-002: 补充 EmbeddingTask 追踪，使 MonitorService 可感知路径 B 的失败。
    root_task_id: 首次执行时的 celery_task_id，重试时保持不变以复用同一 EmbeddingTask 记录（TI-03 模式）。
    """
    if not _is_document_embedding_enabled():
        logger.info(
            "index_document_embedding: skipped disabled feature for doc %s",
            document_id,
        )
        return {"status": "skipped", "reason": "rag_document_embedding_disabled"}

    from apps.rag.models import EmbeddingTask
    from apps.tabdoc.services.document_embedding_service import DocumentEmbeddingService

    task_id = self.request.id
    attempt = self.request.retries
    if root_task_id is None:
        root_task_id = task_id

    organization_id = _resolve_document_organization(document_id)

    task_record, _ = EmbeddingTask.objects.update_or_create(
        celery_task_id=root_task_id,
        defaults={
            "task_type": "document",
            "target_id": document_id,
            "organization_id": organization_id,
            "status": "processing",
            "retry_count": attempt,
            "started_at": timezone.now(),
        },
    )

    try:
        result = DocumentEmbeddingService.index_document(document_id)
        status = result.get("status", "unknown")
        if status == "success":
            task_record.mark_success()
        elif status in ("skipped", "not_found"):
            task_record.status = "cancelled"
            task_record.error_message = result.get("reason", status)
            task_record.completed_at = timezone.now()
            task_record.save(update_fields=["status", "error_message", "completed_at"])
        else:
            task_record.mark_failed(result.get("error", "embedding failed"))
            logger.warning(
                "index_document_embedding: failed for doc %s: reason=%s retryable=%s error=%s",
                document_id,
                result.get("failure_reason", "unknown"),
                result.get("retryable", True),
                result.get("error", ""),
            )
            if result.get("retryable") is False:
                return {
                    "status": "failed",
                    "retryable": False,
                    "failure_reason": result.get("failure_reason", "unknown"),
                }
            raise RuntimeError(result.get("error", "embedding failed"))
        logger.info("index_document_embedding: doc=%s status=%s", document_id, status)
    except Exception as exc:
        task_record.mark_failed(str(exc))
        logger.warning(
            "index_document_embedding: error for doc %s, retry=%d: %s",
            document_id, self.request.retries, exc,
        )
        raise self.retry(countdown=15, kwargs={"root_task_id": root_task_id}) from exc


def _resolve_document_organization(document_id: str):
    """从 Document 获取 organization_id，供 EmbeddingTask 追踪使用。"""
    try:
        from apps.tabdoc.models import Document
        doc = Document.objects.filter(id=document_id).only("organization_id").first()
        return doc.organization_id if doc else None
    except Exception:
        return None


def _merge_single_document(doc_id) -> str:
    from django.core.cache import cache as django_cache
    from apps.tabdoc.models import DocUpdate, Document
    from apps.tabdoc.services.document_service import DocumentService

    lock_key = f"lock:merge_doc:{doc_id}"
    if not django_cache.add(lock_key, "1", timeout=270):
        logger.debug("merge_doc_updates: skipping doc %s (locked by another worker)", doc_id)
        return "locked"
    try:
        document = Document.objects.get(id=doc_id)
        service = DocumentService(user=None)
        if service.merge_updates(document):
            document.refresh_from_db(fields=["last_editor_type", "last_editor_id"])
            if not _is_document_embedding_enabled():
                logger.info(
                    "merge_doc_updates: embedding disabled, not dispatching for doc %s",
                    doc_id,
                )
                return "merged"
            try:
                index_document_embedding.apply_async(
                    args=[str(doc_id)],
                    queue="rag_indexing",
                    expires=900,
                )
            except Exception:
                logger.warning(
                    "merge_doc_updates: failed to dispatch embedding task for doc %s",
                    doc_id,
                    exc_info=True,
                )
                return "embedding_enqueue_failed"
            return "merged"
        return "noop"
    except Document.DoesNotExist:
        DocUpdate.objects.filter(document_id=doc_id).delete()
        logger.warning("Document %s not found, cleaned up orphan updates", doc_id)
        return "orphan_cleaned"
    finally:
        django_cache.delete(lock_key)


@shared_task(
    name="tabdoc.merge_doc_for_document",
    bind=True,
    max_retries=1,
    ignore_result=True,
    time_limit=180,
    soft_time_limit=160,
    queue="doc_merge",
)
def merge_doc_for_document(self, document_id: str):
    """per-doc debounce 后触发的单文档合并入口。"""
    return {"document_id": document_id, "result": _merge_single_document(document_id)}


@shared_task(
    name="tabdoc.merge_doc_updates_sweep",
    bind=True,
    max_retries=0,
    ignore_result=True,
    time_limit=180,
    soft_time_limit=160,
    queue="doc_merge",
)
def merge_doc_updates_sweep(self, limit: int = 100):
    return merge_doc_updates.run(limit=limit)


@shared_task(
    name="tabdoc.merge_doc_updates",
    bind=True,
    max_retries=1,
    ignore_result=True,
    time_limit=180,
    soft_time_limit=160,
    queue="doc_merge",
)
def merge_doc_updates(self=None, limit: int = 100):
    """
    定时合并 DocUpdate 队列到 Document 快照。

    扫描所有有待合并 DocUpdate 的文档，逐个执行合并。
    由 Celery Beat 每 30 秒触发。
    """
    from apps.tabdoc.models import DocUpdate

    # INT-21: 只处理 active 文档，排除 trashed/archived 文档避免全表扫描
    doc_ids = list(
        DocUpdate.objects
        .filter(document__status="active")
        .values_list("document_id", flat=True)
        .distinct()
    )

    if not doc_ids:
        return

    # CRT-16: cap 单轮处理上限，防止文档量过大时超过 soft_time_limit
    _MERGE_BATCH_CAP = max(1, int(limit))
    if len(doc_ids) > _MERGE_BATCH_CAP:
        logger.warning(
            "merge_doc_updates: %d documents pending, capping to %d (rest deferred to next beat)",
            len(doc_ids), _MERGE_BATCH_CAP,
        )
        doc_ids = doc_ids[:_MERGE_BATCH_CAP]

    logger.info("merge_doc_updates: found %d documents with pending updates", len(doc_ids))

    merged_count = 0
    error_count = 0
    consecutive_fails = 0  # CRT-20: 连续失败计数器

    for doc_id in doc_ids:
        try:
            result = _merge_single_document(doc_id)
            if result == "merged":
                merged_count += 1
                consecutive_fails = 0  # CRT-20: 成功则重置
            elif result == "embedding_enqueue_failed":
                error_count += 1
                consecutive_fails += 1
            else:
                consecutive_fails = 0  # CRT-20: merge 返回 False（无需合并）也重置
        except Exception:
            error_count += 1
            consecutive_fails += 1  # CRT-20: 异常累加
            logger.exception("Failed to merge updates for document %s", doc_id)
            # CRT-20: 连续失败熔断（collab-live 可能不可达）
            if consecutive_fails >= _CONSECUTIVE_FAIL_ABORT:
                logger.warning(
                    "merge_doc_updates: %d consecutive failures, aborting early "
                    "(collab-live may be unavailable). merged=%d, errors=%d",
                    consecutive_fails, merged_count, error_count,
                )
                return
    logger.info(
        "merge_doc_updates completed: merged=%d, errors=%d, total=%d",
        merged_count, error_count, len(doc_ids),
    )


@shared_task(name="tabdoc.cleanup_expired_history", bind=True, max_retries=1, ignore_result=True, time_limit=300, soft_time_limit=280)
def cleanup_expired_history(self):
    """
    清理过期的 DocHistory + 分级降采样。

    由 Celery Beat 每小时触发。

    清理规则:
    1. 删除 expired_at < now() 的记录
    2. 分级降采样:
       - 1-7 天前: 每小时保留 1 个（删除同小时内多余的）
       - 7-30 天前: 每天保留 1 个（删除同天内多余的）
    3. 保护有 diff 依赖的全量锚点（延迟清理）
    """
    # INT-83: 多副本 Beat 并发保护
    from django.core.cache import cache as django_cache
    lock_key = "lock:cleanup_expired_history"
    if not django_cache.add(lock_key, "1", timeout=290):
        logger.debug("cleanup_expired_history: skipped (locked by another worker)")
        return
    try:
        _run_cleanup_expired_history()
    finally:
        django_cache.delete(lock_key)


def _run_cleanup_expired_history():
    """cleanup_expired_history 的实际执行体（提取以便锁外测试）。"""
    from apps.tabdoc.models import DocHistory

    now = timezone.now()

    # ── 第 1 步: 删除已过期的记录 ──
    # 命名版本和置顶版本永不过期，排除在外
    expired_qs = DocHistory.objects.filter(
        expired_at__lt=now,
        is_named=False,
        pinned=False,
    )

    # 保护被 diff 引用的全量快照
    referenced_snapshot_ids = set(
        DocHistory.objects.filter(
            base_history__isnull=False,
            expired_at__gte=now,  # 只保护未过期 diff 引用的 snapshot
        ).values_list("base_history_id", flat=True)
    )

    if referenced_snapshot_ids:
        expired_qs = expired_qs.exclude(id__in=referenced_snapshot_ids)

    expired_count = expired_qs.count()
    if expired_count > 0:
        expired_qs.delete()
        logger.info("Deleted %d expired DocHistory records", expired_count)

    # ── 第 2 步: 分级降采样 ──
    downsample_count = 0

    # 1-7 天前: 每小时保留 1 个
    boundary_1d = now - timedelta(days=1)
    boundary_7d = now - timedelta(days=7)
    downsample_count += _downsample_range(
        boundary_7d, boundary_1d, truncate_to="hour"
    )

    # 7-30 天前: 每天保留 1 个
    boundary_30d = now - timedelta(days=30)
    downsample_count += _downsample_range(
        boundary_30d, boundary_7d, truncate_to="day"
    )

    # 30-90 天前: 每周保留 1 个（覆盖 Team 用户 90 天 TTL 区间，对齐 VH/SlideHistory）
    boundary_90d = now - timedelta(days=90)
    downsample_count += _downsample_range(
        boundary_90d, boundary_30d, truncate_to="week"
    )

    if downsample_count > 0:
        logger.info("Downsampled %d DocHistory records", downsample_count)

    logger.info(
        "cleanup_expired_history completed: expired=%d, downsampled=%d",
        expired_count, downsample_count,
    )


def _downsample_range(start, end, truncate_to: str) -> int:
    """
    对指定时间范围内的 DocHistory 进行降采样。

    保留每个 (document, time_bucket) 中最新的一条，删除其余的。
    不删除全量快照（is_snapshot=True 且有 diff 引用的）。

    CRT-19: 使用 PostgreSQL ROW_NUMBER() 窗口函数一次性识别待删除行，
    替换原来的 N+1 逐组查询。
    """
    from apps.tabdoc.models import DocHistory
    from django.db import connections

    _trunc_map = {"hour": "hour", "day": "day", "week": "week"}
    pg_trunc = _trunc_map.get(truncate_to, "day")
    trunc_expr = f"date_trunc('{pg_trunc}', created_at)"

    protected_snapshot_ids = list(
        DocHistory.objects.filter(
            base_history__isnull=False,
            expired_at__gte=timezone.now(),
        ).values_list("base_history_id", flat=True)
    )

    exclude_clause = ""
    params: list = [start, end]
    if protected_snapshot_ids:
        placeholders = ", ".join(["%s"] * len(protected_snapshot_ids))
        exclude_clause = f"AND id NOT IN ({placeholders})"
        params.extend(protected_snapshot_ids)

    sql = f"""
        DELETE FROM tabdoc_history
        WHERE id IN (
            SELECT id FROM (
                SELECT id,
                       ROW_NUMBER() OVER (
                           PARTITION BY document_id, {trunc_expr}
                           ORDER BY created_at DESC, id DESC
                       ) AS rn
                FROM tabdoc_history
                WHERE created_at >= %s
                  AND created_at < %s
                  AND is_named = FALSE
                  AND pinned = FALSE
            ) ranked
            WHERE rn > 1
            {exclude_clause}
        )
    """

    with connections["postgresql"].cursor() as cursor:
        cursor.execute(sql, params)
        return cursor.rowcount


_CONSECUTIVE_FAIL_ABORT = 3


@shared_task(name="tabdoc.fix_missing_binary", bind=True, max_retries=0, ignore_result=True, time_limit=300, soft_time_limit=280)
def fix_missing_binary(self, limit: int = 200):
    """
    定期修复缺失 description_binary 的文档。

    当 collab-live 不可达时创建的文档可能缺失 binary，
    此任务通过 ensure_description_binary 批量修复。
    由 Celery Beat 每 6 小时触发。

    熔断机制：连续 3 次失败则提前终止（collab-live 很可能不可达）。
    """
    from django.db.models import Q
    from apps.tabdoc.models import Document
    from apps.tabdoc.services.document_service import DocumentService

    qs = Document.objects.using("postgresql").filter(
        status="active",
    ).filter(
        Q(description_binary__isnull=True) | Q(description_binary=b""),
    ).exclude(
        description_markdown="",
    ).exclude(
        description_markdown__isnull=True,
    )

    total = qs.count()
    if total == 0:
        return

    logger.info("fix_missing_binary: found %d documents, processing up to %d", total, limit)

    docs = qs.only("id")[:limit]
    fixed = 0
    failed = 0
    consecutive_fails = 0

    for doc in docs:
        try:
            if DocumentService.ensure_description_binary(doc.id):
                fixed += 1
                consecutive_fails = 0
            else:
                failed += 1
                consecutive_fails += 1
        except Exception:
            failed += 1
            consecutive_fails += 1
            logger.debug("fix_missing_binary: failed for doc %s", doc.id, exc_info=True)

        if consecutive_fails >= _CONSECUTIVE_FAIL_ABORT:
            logger.warning(
                "fix_missing_binary: %d consecutive failures, aborting early "
                "(collab-live may be unavailable). fixed=%d, failed=%d",
                consecutive_fails, fixed, failed,
            )
            return

    logger.info(
        "fix_missing_binary completed: fixed=%d, failed=%d, remaining=%d",
        fixed, failed, max(0, total - limit),
    )


# ═══════════════════════════════════════════════════════════════════
# V2 兼容任务（保留，不再由新代码触发）
# ═══════════════════════════════════════════════════════════════════


@shared_task(name="tabdoc.create_document_version", bind=True, max_retries=2, ignore_result=True, time_limit=300, soft_time_limit=280)
def create_document_version(self, document_id: str, user_id: str | None = None):
    """
    [V2 兼容] 异步创建 DocumentVersion 快照。

    由旧版 DocumentService.save_content() 触发，V3 架构不再调用。
    保留以兼容可能还在队列中的任务。
    """
    from apps.tabdoc.models import Document, DocumentVersion, MAX_VERSIONS_PER_DOC

    try:
        document = Document.objects.get(id=document_id)
    except Document.DoesNotExist:
        logger.warning("Document %s not found, skipping version creation", document_id)
        return

    try:
        # INT-77: CREATE → COUNT → DELETE 包裹在事务中，防止并发时版本数超限
        with transaction.atomic(using="postgresql"):
            DocumentVersion.objects.create(
                document=document,
                organization_id=document.organization_id,
                description_binary=document.description_binary,
                description_markdown=document.description_markdown or "",
                description_json=document.description_json or {},
                description_plaintext=document.description_plaintext or "",
                version=document.latest_version,
                last_saved_at=document.updated_at,
                created_by_id=user_id,
            )

            version_count = DocumentVersion.objects.filter(document=document).count()
            if version_count > MAX_VERSIONS_PER_DOC:
                excess = version_count - MAX_VERSIONS_PER_DOC
                oldest_ids = list(
                    DocumentVersion.objects.filter(document=document)
                    .order_by("created_at")
                    .values_list("id", flat=True)[:excess]
                )
                if oldest_ids:
                    DocumentVersion.objects.filter(id__in=oldest_ids).delete()

        logger.info("Document %s: version created (V2 compat)", document_id)

    except Exception as exc:
        logger.exception("Failed to create version for document %s: %s", document_id, exc)
        raise self.retry(countdown=30) from exc
