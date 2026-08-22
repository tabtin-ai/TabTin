"""
RAG Celery 异步任务

提供后台索引任务，支持失败重试和定时任务
"""

import logging
import uuid
from typing import List, Dict, Any, Optional
from celery import shared_task, group
from django.db import transaction
from django.utils import timezone
from django.conf import settings
from itertools import islice

from apps.services.llm.scenes.exceptions import SceneRoutingDisabled

logger = logging.getLogger(__name__)

# SI-08: Lua 脚本：仅当 lock value == owner token 时才删除，防止锁过期后误释放他人的锁
_LUA_RELEASE_LOCK = """
if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
else
    return 0
end
"""

def _safe_uuid(value: str) -> uuid.UUID:
    """安全地将字符串转为 UUID，非合法格式时返回随机 UUID（RC-027）。"""
    try:
        return uuid.UUID(value)
    except (ValueError, AttributeError):
        logger.warning("RC-027: organization_id '%s' is not a valid UUID, using random UUID", value)
        return uuid.uuid4()


def _resolve_table_organization(table_id: str):
    """从 Table 获取 organization_id，失败返回 None。"""
    try:
        from apps.tabdata.models import Table
        t = Table.objects.filter(id=table_id).only("organization_id").first()
        return t.organization_id if t else None
    except Exception:
        return None


def _resolve_record_organization(record_id: str):
    """从 TableRecord → Table 获取 organization_id。"""
    try:
        from apps.tabdata.models import TableRecord
        rec = TableRecord.objects.filter(id=record_id).only("table_id").first()
        if not rec:
            return None
        return _resolve_table_organization(str(rec.table_id))
    except Exception:
        return None


def _resolve_document_organization(document_id: str):
    """从 Document 获取 organization_id。"""
    try:
        from apps.tabdoc.models import Document
        doc = Document.objects.filter(id=document_id).only("organization_id").first()
        return doc.organization_id if doc else None
    except Exception:
        return None


def _cancel_embedding_task(task_record, reason: str) -> None:
    """将预期跳过的索引任务收口为 cancelled，而不是 failed。"""
    task_record.status = 'cancelled'
    task_record.error_message = reason
    task_record.completed_at = timezone.now()
    task_record.save(update_fields=['status', 'error_message', 'completed_at'])


@shared_task(
    bind=True,
    max_retries=3,
    default_retry_delay=60,
    name='rag.index_table_task',
    ignore_result=True,
    time_limit=900,
    soft_time_limit=840,
)
def index_table_task(self, table_id: str, force: bool = False, root_task_id: str = None) -> Dict[str, Any]:
    """
    异步为单个表格创建向量索引

    Args:
        table_id: 表格 ID
        force: 是否强制重建索引
        root_task_id: TI-03 — 首次执行时的 celery_task_id，重试时保持不变以复用同一 EmbeddingTask 记录

    Returns:
        Dict: 索引结果

    Raises:
        Retry: 任务失败时重试
    """
    from apps.rag.services import IndexService
    from apps.rag.models import EmbeddingTask

    task_id = self.request.id
    attempt = self.request.retries
    # TI-03: 首次执行时确立 root_task_id，后续 retry 复用同一记录
    if root_task_id is None:
        root_task_id = task_id

    logger.info(
        "🔄 开始索引任务: table_id=%s, task_id=%s, root_task_id=%s, attempt=%d/%d",
        table_id, task_id, root_task_id, attempt + 1, self.max_retries + 1,
    )

    # SC-004: 获取 target-level 分布式锁，防止不同触发源（信号+定时任务）对同一 table 并发索引
    lock_token = _acquire_target_lock("table", table_id, ttl=960)  # >= time_limit 900s
    if not lock_token:
        logger.info(
            "⏳ table %s 已有其他 worker 正在索引，跳过本次触发 (attempt=%d)",
            table_id, attempt + 1,
        )
        return {"success": False, "table_id": table_id, "reason": "already_processing"}

    organization_id = _resolve_table_organization(table_id)
    if organization_id is None:
        _release_target_lock("table", table_id, lock_token)
        logger.warning("表格不存在或无法解析 organization，跳过索引: table_id=%s", table_id)
        return {"success": False, "table_id": table_id, "reason": "not_found"}

    task_record, _ = EmbeddingTask.objects.update_or_create(
        celery_task_id=root_task_id,
        defaults={
            'task_type': 'table',
            'target_id': table_id,
            'organization_id': organization_id,
            'status': 'processing',
            'retry_count': attempt,
            'started_at': timezone.now(),
        }
    )

    try:
        service = IndexService()
        result = service.index_table(table_id=table_id, force=force)

        if result.get('status') == 'not_found':
            _cancel_embedding_task(task_record, '表格已删除')
            logger.info(f"🗑️ 表格已删除，任务取消: table_id={table_id}")
            return {'success': False, 'table_id': table_id, 'reason': 'not_found'}

        if result.get('status') == 'skipped':
            reason = result.get('reason', 'skipped')
            _cancel_embedding_task(task_record, reason)
            logger.info("⏭️ 表格索引任务跳过: table_id=%s reason=%s", table_id, reason)
            return {
                'success': True, 'skipped': True, 'table_id': table_id,
                'reason': reason, 'task_id': task_id,
            }

        task_record.mark_success()

        logger.info(f"✅ 索引任务完成: table_id={table_id}, status={result['status']}")

        return {
            'success': True,
            'table_id': table_id,
            'result': result,
            'task_id': task_id
        }

    except Exception as exc:
        logger.error(
            "❌ 索引任务失败: table_id=%s, attempt=%d/%d, error=%s",
            table_id, attempt + 1, self.max_retries + 1, exc,
        )
        task_record.mark_failed(str(exc))
        # SC-004: 重试前释放锁，让下一次 retry 重新竞争
        _release_target_lock("table", table_id, lock_token)
        lock_token = ""
        # 由 Celery max_retries 统一控制上限，指数退避；TI-03: 传递 root_task_id
        raise self.retry(
            exc=exc,
            countdown=60 * (2 ** attempt),
            kwargs={'force': force, 'root_task_id': root_task_id},
        )
    finally:
        # SC-004: 任务正常完成时释放锁
        if lock_token:
            _release_target_lock("table", table_id, lock_token)


@shared_task(
    bind=True,
    max_retries=3,
    default_retry_delay=120,
    name='rag.index_table_records_task',
    ignore_result=True,
    time_limit=1800,
    soft_time_limit=1740,
)
def index_table_records_task(self, table_id: str, force: bool = False, root_task_id: str = None) -> Dict[str, Any]:
    """
    异步为表格的所有记录创建向量索引

    Args:
        table_id: 表格 ID
        force: 是否强制重建索引
        root_task_id: TI-03 — 首次执行时的 celery_task_id，重试时保持不变

    Returns:
        Dict: 批量索引结果
    """
    from apps.rag.services import IndexService
    from apps.rag.models import EmbeddingTask
    from apps.tabdata.models import Table

    task_id = self.request.id
    attempt = self.request.retries
    # TI-03: 首次执行时确立 root_task_id
    if root_task_id is None:
        root_task_id = task_id

    logger.info(
        "🔄 开始批量索引任务: table_id=%s, task_id=%s, root_task_id=%s, attempt=%d/%d",
        table_id, task_id, root_task_id, attempt + 1, self.max_retries + 1,
    )

    if not Table.objects.filter(id=table_id).exists():
        logger.info(f"🗑️ 表格已删除，跳过批量索引: table_id={table_id}")
        return {'success': False, 'table_id': table_id, 'reason': 'not_found'}

    # CC-013: 添加 table-level target lock，防止与 embed_record_task 并发产生竞态（SC-003/004 的锁保护盲区）
    # TTL >= time_limit 1800s
    lock_token = _acquire_target_lock("table", table_id, ttl=1860)
    if not lock_token:
        logger.info(
            "⏳ table %s 已有其他 worker 正在索引（records），跳过本次触发 (attempt=%d)",
            table_id, attempt + 1,
        )
        return {"success": False, "table_id": table_id, "reason": "already_processing"}

    organization_id = _resolve_table_organization(table_id)
    if organization_id is None:
        _release_target_lock("table", table_id, lock_token)
        logger.warning("表格不存在或无法解析 organization，跳过批量索引: table_id=%s", table_id)
        return {"success": False, "table_id": table_id, "reason": "not_found"}

    task_record, _ = EmbeddingTask.objects.update_or_create(
        celery_task_id=root_task_id,
        defaults={
            'task_type': 'batch',
            'target_id': table_id,
            'organization_id': organization_id,
            'status': 'processing',
            'retry_count': attempt,
            'started_at': timezone.now(),
        }
    )

    try:
        service = IndexService()
        result = service.index_table_records(table_id=table_id, force=force)

        task_record.mark_success()
        if result.get('status') == 'skipped':
            logger.info(
                f"✅ 批量索引任务完成: table_id={table_id}, "
                f"status=skipped, reason={result.get('reason', 'unknown')}"
            )
        else:
            logger.info(
                f"✅ 批量索引任务完成: table_id={table_id}, "
                f"成功={result.get('success', 0)}, "
                f"失败={result.get('failed', 0)}, "
                f"跳过={result.get('skipped', 0)}"
            )

        return {
            'success': True,
            'table_id': table_id,
            'result': result,
            'task_id': task_id
        }

    except Exception as exc:
        logger.error(
            "❌ 批量索引任务失败: table_id=%s, attempt=%d/%d, error=%s",
            table_id, attempt + 1, self.max_retries + 1, exc,
        )

        task_record.mark_failed(str(exc))

        # CC-013: 重试前释放锁，让下一次 retry 重新竞争
        _release_target_lock("table", table_id, lock_token)
        lock_token = ""

        # TI-03: 传递 root_task_id
        raise self.retry(
            exc=exc,
            countdown=120 * (2 ** attempt),
            kwargs={'force': force, 'root_task_id': root_task_id},
        )
    finally:
        # CC-013: 任务正常完成时释放锁
        if lock_token:
            _release_target_lock("table", table_id, lock_token)


@shared_task(
    bind=True,
    max_retries=2,
    default_retry_delay=60,
    name='rag.index_records_batch_task',
    ignore_result=True,
    time_limit=1800,
    soft_time_limit=1740,
    queue='rag_indexing',
)
def index_records_batch_task(self, record_ids: List[str], force: bool = False) -> Dict[str, Any]:
    """P1-9：处理大表拆分后的一个子批次 record_ids 的向量索引。

    由 IndexService.index_table_records 在表记录超过 MAX_RECORDS_PER_TASK 时 dispatch。
    """
    from apps.rag.services import IndexService

    task_id = self.request.id
    attempt = self.request.retries

    logger.info(
        "🔄 开始子批次记录索引: count=%d, task_id=%s, attempt=%d/%d",
        len(record_ids), task_id, attempt + 1, self.max_retries + 1,
    )

    try:
        service = IndexService()
        result = service.index_records_batch(record_ids, force=force)

        logger.info(
            "✅ 子批次记录索引完成: count=%d, 成功=%d, 失败=%d, 跳过=%d",
            len(record_ids),
            result.get('success', 0),
            result.get('failed', 0),
            result.get('skipped', 0),
        )
        return {'success': True, 'result': result, 'task_id': task_id}

    except Exception as exc:
        logger.error(
            "❌ 子批次记录索引失败: count=%d, attempt=%d/%d, error=%s",
            len(record_ids), attempt + 1, self.max_retries + 1, exc,
        )
        raise self.retry(exc=exc, countdown=60 * (2 ** attempt))


@shared_task(
    bind=True,
    max_retries=2,
    default_retry_delay=180,
    name='rag.index_batch_tables_task',
    time_limit=2400,
    soft_time_limit=2340,
)
def index_batch_tables_task(self, table_ids: List[str], force: bool = False) -> Dict[str, Any]:
    """
    异步批量为多个表格创建索引

    Args:
        table_ids: 表格 ID 列表
        force: 是否强制重建索引

    Returns:
        Dict: 批量索引结果
    """
    from apps.rag.services import IndexService

    task_id = self.request.id
    attempt = self.request.retries

    logger.info(
        "🔄 开始批量表格索引任务: count=%d, task_id=%s, attempt=%d/%d",
        len(table_ids), task_id, attempt + 1, self.max_retries + 1,
    )

    try:
        service = IndexService()
        result = service.index_tables_batch(table_ids=table_ids, force=force)

        logger.info(
            f"✅ 批量表格索引完成: 总数={result['total']}, "
            f"成功={result['success']}, 失败={result['failed']}"
        )

        return {
            'success': True,
            'result': result,
            'task_id': task_id
        }

    except Exception as exc:
        logger.error(
            "❌ 批量表格索引失败: attempt=%d/%d, error=%s",
            attempt + 1, self.max_retries + 1, exc,
        )
        raise self.retry(exc=exc, countdown=180 * (2 ** attempt))


_INCREMENTAL_CHECKPOINT_KEY = "rag:incremental_index:last_processed_id"
_INCREMENTAL_DOC_CHECKPOINT_KEY = "rag:incremental_index:last_processed_doc_id"
_INCREMENTAL_CHECKPOINT_TTL = 86400 * 2  # 48h，覆盖两次调度周期


def _get_checkpoint(key: str = _INCREMENTAL_CHECKPOINT_KEY) -> Optional[str]:
    """从 Redis 读取上次增量索引的断点 ID。"""
    try:
        from django_redis import get_redis_connection
        val = get_redis_connection("default").get(key)
        return val.decode() if val else None
    except Exception:
        return None


def _set_checkpoint(item_id: str, key: str = _INCREMENTAL_CHECKPOINT_KEY) -> None:
    """将已处理的最后一个 id 写入 Redis。"""
    try:
        from django_redis import get_redis_connection
        get_redis_connection("default").set(
            key, item_id, ex=_INCREMENTAL_CHECKPOINT_TTL,
        )
    except Exception:
        logger.warning("[RAG] 无法写入增量索引 checkpoint (key=%s)", key)


def _clear_checkpoint(key: str = _INCREMENTAL_CHECKPOINT_KEY) -> None:
    """一轮完整跑完后清除 checkpoint。"""
    try:
        from django_redis import get_redis_connection
        get_redis_connection("default").delete(key)
    except Exception:
        pass


@shared_task(name='rag.incremental_index_all', time_limit=3600, soft_time_limit=3540, ignore_result=True)
def incremental_index_all() -> Dict[str, Any]:
    """
    定时任务：增量索引所有表格和文档

    RAG-6 修复：同时索引 Table 和 Document。
    SVC-16 修复：支持断点续传，通过 Redis checkpoint 记录进度，
    soft_time_limit 触发后下次从断点继续。
    SC-019 修复：添加 Redis 单实例锁，防止 Celery Beat 多实例并发触发大规模 upsert 风暴。
    """
    if not getattr(settings, "RAG_ENABLED", True):
        return {"success": True, "skipped": True, "reason": "RAG disabled"}

    # SC-019: 单实例互斥锁，TTL 略大于 time_limit 3600s
    _INCREMENTAL_LOCK_KEY = "rag:incremental_index_all:running"
    _INCREMENTAL_LOCK_TTL = 3700
    lock_token = str(uuid.uuid4())
    try:
        from django_redis import get_redis_connection as _grc
        _redis_lock = _grc("default")
        _acquired = bool(_redis_lock.set(_INCREMENTAL_LOCK_KEY, lock_token, nx=True, ex=_INCREMENTAL_LOCK_TTL))
    except Exception:
        logger.warning("[RAG] incremental_index_all: Redis lock unavailable, skipping (fail-closed)")
        return {"success": False, "skipped": True, "reason": "redis_unavailable"}

    if not _acquired:
        logger.info(
            "[RAG] incremental_index_all: another instance is already running, skipping this trigger"
        )
        return {"success": True, "skipped": True, "reason": "another_instance_running"}

    try:
        return _run_incremental_index_all()
    finally:
        # 释放锁
        if _redis_lock is not None:
            try:
                _redis_lock.eval(_LUA_RELEASE_LOCK, 1, _INCREMENTAL_LOCK_KEY, lock_token)
            except Exception:
                pass


def _run_incremental_index_all() -> Dict[str, Any]:
    """incremental_index_all 的实际执行逻辑（SC-019 拆分以支持锁包裹）。"""
    from celery.exceptions import SoftTimeLimitExceeded
    from apps.tabdata.models import Table
    from apps.rag.services import IndexService

    checkpoint_id = _get_checkpoint()
    doc_checkpoint_id = _get_checkpoint(_INCREMENTAL_DOC_CHECKPOINT_KEY)
    if checkpoint_id:
        logger.info("Resuming incremental table index from checkpoint: %s", checkpoint_id)
    if doc_checkpoint_id:
        logger.info("Resuming incremental doc index from checkpoint: %s", doc_checkpoint_id)

    try:
        service = IndexService()
        batch_size = 200
        total = success = skipped = failed = 0
        tables_done = False
        docs_done = False

        # --- Phase 1: Table 索引 ---
        qs = Table.objects.order_by("id").values_list("id", flat=True)
        if checkpoint_id:
            qs = qs.filter(id__gt=checkpoint_id)

        last_id = None
        try:
            for batch_ids in _iter_id_batches(qs.iterator(), batch_size):
                # CC-006: 过滤掉已被 index_table_task 持有锁的 table，避免绕过 SC-004 锁保护产生重复计费
                unlocked_ids = []
                acquired_tokens = {}
                for tid in batch_ids:
                    token = _acquire_target_lock("table", str(tid), ttl=960)
                    if token:
                        unlocked_ids.append(tid)
                        acquired_tokens[str(tid)] = token
                    else:
                        logger.debug(
                            "[RAG] incremental_index_all: table %s already locked by another task, skipping",
                            tid,
                        )
                        skipped += 1

                try:
                    if unlocked_ids:
                        result = service.index_tables_batch(table_ids=unlocked_ids, force=False)
                        total += result.get("total", 0)
                        success += result.get("success", 0)
                        skipped += result.get("skipped", 0)
                        failed += result.get("failed", 0)
                finally:
                    # 释放本批次所有已获取的锁
                    for tid, tok in acquired_tokens.items():
                        _release_target_lock("table", tid, tok)

                last_id = batch_ids[-1]
                _set_checkpoint(last_id)

            tables_done = True

        except SoftTimeLimitExceeded:
            logger.warning(
                "Incremental index interrupted (tables phase), checkpoint=%s, "
                "total=%d success=%d failed=%d",
                last_id, total, success, failed,
            )
            return {
                "success": True,
                "interrupted": True,
                "phase": "tables",
                "checkpoint": last_id,
                "result": {"total": total, "success": success, "skipped": skipped, "failed": failed},
                "timestamp": timezone.now().isoformat(),
            }

        # --- Phase 2: Document 索引 (RAG-6) ---
        try:
            from apps.tabdoc.models import Document
            from apps.tabdoc.services.document_embedding_service import DocumentEmbeddingService

            # ：org-only 文档 space_id 可为 NULL，仍参与增量/全量索引
            doc_qs = (
                Document.objects
                .filter(status="active", trashed_at__isnull=True)
                .exclude(organization_id__isnull=True)
                .order_by("id")
                .values_list("id", flat=True)
            )
            if doc_checkpoint_id:
                doc_qs = doc_qs.filter(id__gt=doc_checkpoint_id)

            last_doc_id = None
            no_billing_total = 0
            try:
                for batch_ids in _iter_id_batches(doc_qs.iterator(), batch_size):
                    counts = DocumentEmbeddingService.index_documents_batch(
                        document_ids=batch_ids, force=False,
                    )
                    total += sum(v for k, v in counts.items() if k != "no_billing")
                    success += counts.get("success", 0)
                    skipped += counts.get("skipped", 0)
                    failed += counts.get("failed", 0)
                    no_billing_total += counts.get("no_billing", 0)
                    last_doc_id = batch_ids[-1]
                    _set_checkpoint(last_doc_id, _INCREMENTAL_DOC_CHECKPOINT_KEY)

                if no_billing_total > 0:
                    logger.warning(
                        "[RAG] BL-003: incremental_index_all skipped billing for %d document(s) "
                        "because created_by_id=None and no user_id was passed. "
                        "These are likely system-imported documents. "
                        "Check Document records with created_by_id IS NULL for billing coverage.",
                        no_billing_total,
                    )

                docs_done = True

            except SoftTimeLimitExceeded:
                logger.warning(
                    "Incremental index interrupted (docs phase), doc_checkpoint=%s, "
                    "total=%d success=%d failed=%d",
                    last_doc_id, total, success, failed,
                )
                return {
                    "success": True,
                    "interrupted": True,
                    "phase": "documents",
                    "checkpoint": last_doc_id,
                    "result": {"total": total, "success": success, "skipped": skipped, "failed": failed},
                    "timestamp": timezone.now().isoformat(),
                }

        except ImportError:
            logger.warning("[RAG] tabdoc module not available, skipping Document indexing")
            docs_done = True

        if tables_done and docs_done:
            _clear_checkpoint()
            _clear_checkpoint(_INCREMENTAL_DOC_CHECKPOINT_KEY)

        logger.info(
            "Incremental index done: total=%d success=%d skipped=%d failed=%d",
            total, success, skipped, failed,
        )
        return {
            "success": True,
            "result": {"total": total, "success": success, "skipped": skipped, "failed": failed},
            "timestamp": timezone.now().isoformat(),
        }

    except Exception as exc:
        logger.error("Incremental index failed: %s", exc)
        return {"success": False, "error": str(exc), "timestamp": timezone.now().isoformat()}


def _iter_id_batches(iterator, batch_size: int):
    """将 ID 迭代器按批次分割为字符串列表。"""
    batch: List[str] = []
    for item in iterator:
        batch.append(str(item))
        if len(batch) >= batch_size:
            yield batch
            batch = []
    if batch:
        yield batch


# =====================================================================
# Docparse → RAG 索引任务（DP-003 修复）
# =====================================================================

def _resolve_docparse_contexts(
    parsed_doc,
) -> list:
    """从 ParsedDocument → FileRecord → 所有活跃 FileUsage 推断全部唯一 (user_id, organization_id, space_id)。

    SDI-012 修复：遍历全部活跃 FileUsage 而非只取 .first()，
    确保多 Space 引用同一文件时，每个 Space 都能得到正确的向量索引。
    返回按 (organization_id, space_id) 排序的上下文列表，保证版本号分配的确定性。
    """
    contexts: list = []
    seen_spaces: set = set()

    try:
        fr = parsed_doc.file_record
        if not fr:
            return contexts

        user_id = str(
            getattr(fr, "upload_user_id", "")
            or getattr(fr, "upload_user", "")
            or ""
        )

        usages = (
            list(fr.usages.filter(is_active=True))
            if hasattr(fr, "usages")
            else []
        )

        for usage in usages:
            ctx_id = usage.context_id or ""
            module = usage.module or ""
            organization_id = None
            space_id = None

            if module == "tabdoc" and ctx_id:
                try:
                    from apps.tabdoc.models import Document

                    doc = (
                        Document.objects.filter(id=ctx_id)
                        .only("organization_id", "space_id")
                        .first()
                    )
                    if doc:
                        organization_id = doc.organization_id
                        space_id = doc.space_id
                except Exception as e:
                    logger.debug(
                        "[DocparseRAG] tabdoc context lookup failed ctx_id=%s: %s",
                        ctx_id, e,
                    )

            elif module == "tabdata" and ctx_id:
                try:
                    from apps.tabdata.models import Table

                    table = (
                        Table.objects.filter(id=ctx_id)
                        .only("organization_id", "space_id")
                        .first()
                    )
                    if table:
                        organization_id = table.organization_id
                        space_id = table.space_id
                except Exception as e:
                    logger.debug(
                        "[DocparseRAG] tabdata context lookup failed ctx_id=%s: %s",
                        ctx_id, e,
                    )

            elif module == "chat" and ctx_id:
                try:
                    from apps.chat.conversation.models import ChatSession

                    sess = (
                        ChatSession.objects.filter(id=ctx_id)
                        .only("organization_id", "workspace_id")
                        .first()
                    )
                    if sess:
                        organization_id = sess.organization_id
                        space_id = sess.workspace_id
                except Exception as e:
                    logger.debug(
                        "[DocparseRAG] chat context lookup failed ctx_id=%s: %s",
                        ctx_id, e,
                    )

            elif module == "crawl" and ctx_id:
                try:
                    from apps.tabtinspace.services.host_resolver import resolve_host

                    space = resolve_host(ctx_id)
                    if space:
                        organization_id = space.organization_id
                        space_id = space.id
                except Exception as e:
                    logger.debug(
                        "[DocparseRAG] crawl context lookup failed ctx_id=%s: %s",
                        ctx_id, e,
                    )

            if organization_id and space_id:
                key = (str(organization_id), str(space_id))
                if key not in seen_spaces:
                    seen_spaces.add(key)
                    contexts.append((user_id, organization_id, space_id))

        if not contexts:
            meta = getattr(fr, "metadata", None) or {}
            ws = meta.get("organization_id")
            sp = meta.get("space_id")
            if ws and sp:
                contexts.append((user_id, ws, sp))

    except Exception as exc:
        logger.debug("[DocparseRAG] context resolution failed: %s", exc)

    contexts.sort(key=lambda c: (str(c[1]), str(c[2])))
    return contexts


def _resolve_docparse_context(parsed_doc) -> tuple:
    """向后兼容包装器：返回第一条上下文或空值。"""
    contexts = _resolve_docparse_contexts(parsed_doc)
    if contexts:
        return contexts[0]
    return "", None, None


@shared_task(
    bind=True,
    max_retries=3,
    default_retry_delay=60,
    name='rag.index_parsed_document_chunks',
    time_limit=600,
    soft_time_limit=560,
)
def index_parsed_document_chunks_task(
    self, file_record_id: str, force: bool = False,
) -> Dict[str, Any]:
    """将 docparse 解析出的文档块写入 pgvector。

    幂等性保证：content_hash 包含 organization_id + space_id + 内容，
    相同内容重复调用会直接 skip。
    """
    from apps.services.docparse.models import ParsedDocument, DocumentChunk
    from apps.rag.models import DocumentEmbedding, EmbeddingTask
    from apps.rag.services.embedding_service import get_embedding_service
    from apps.rag.utils import calculate_content_hash

    task_id = self.request.id
    attempt = self.request.retries

    parsed_doc = ParsedDocument.objects.filter(
        file_record_id=file_record_id,
        status=ParsedDocument.Status.READY,
    ).select_related("file_record").first()

    if not parsed_doc:
        logger.info(
            "[DocparseRAG] No READY ParsedDocument for %s, skip", file_record_id,
        )
        return {
            "status": "skipped",
            "reason": "not_ready",
            "file_record_id": file_record_id,
        }

    chunks_qs = (
        DocumentChunk.objects.filter(page__document=parsed_doc)
        .order_by("page__page_number", "sequence")
        .values_list("content", flat=True)
    )
    content_parts = [c for c in chunks_qs if c and c.strip()]
    if not content_parts:
        return {
            "status": "skipped",
            "reason": "no_content",
            "file_record_id": file_record_id,
        }

    content = "\n".join(content_parts)

    # SDI-012: 遍历所有活跃 FileUsage，为每个引用 Space 创建独立索引
    contexts = _resolve_docparse_contexts(parsed_doc)
    if not contexts:
        logger.warning(
            "[DocparseRAG] Cannot resolve any organization/space for %s, skip",
            file_record_id,
        )
        return {
            "status": "skipped",
            "reason": "missing_context",
            "file_record_id": file_record_id,
        }

    doc_uuid = parsed_doc.id

    # 幂等性检查：所有上下文的 content_hash 均已存在且无过期版本时跳过
    if not force:
        expected_hashes = {
            calculate_content_hash(f"{str(ws)}:{str(sp)}:{content}")
            for _, ws, sp in contexts
        }
        existing_count = DocumentEmbedding.objects.filter(
            document_id=doc_uuid,
            content_hash__in=expected_hashes,
        ).count()
        stale_exists = DocumentEmbedding.objects.filter(
            document_id=doc_uuid,
            version__gt=len(contexts),
        ).exists()
        if existing_count >= len(expected_hashes) and not stale_exists:
            return {
                "status": "skipped",
                "reason": "unchanged",
                "file_record_id": file_record_id,
            }

    primary_user_id = contexts[0][0]
    primary_ws = contexts[0][1]

    task_record, _ = EmbeddingTask.objects.update_or_create(
        celery_task_id=task_id,
        defaults={
            "task_type": "document",
            "target_id": doc_uuid,
            "organization_id": primary_ws,
            "status": "processing",
            "retry_count": attempt,
            "started_at": timezone.now(),
        },
    )

    try:
        from apps.services.llm.services.embedding import embed_text as _unified_embed
        title = parsed_doc.title or ""
        _embed_input = f"{title}\n{content}" if title else content
        _emb_result = _unified_embed(
            scene_key="rag_index_document",
            texts=[_embed_input],
            user_id=primary_user_id,
            organization_id=str(primary_ws),
        )
        vector = _emb_result.vectors[0]

        _CONTENT_STORE_LIMIT = 50_000
        # SC-002 修复：收集所有 DocumentEmbedding 对象后一次 bulk_create(update_conflicts=True)，
        # 通过 INSERT ... ON CONFLICT DO UPDATE 原子完成 upsert，消除 TOCTOU 竞态。
        doc_objs = []
        for idx, (user_id, organization_id, space_id) in enumerate(contexts):
            ws_str = str(organization_id)
            sp_str = str(space_id)
            content_hash = calculate_content_hash(f"{ws_str}:{sp_str}:{content}")
            doc_objs.append(DocumentEmbedding(
                document_id=doc_uuid,
                version=idx + 1,
                organization_id=organization_id,
                space_id=space_id,
                content=content[:_CONTENT_STORE_LIMIT],
                content_hash=content_hash,
                embedding=vector,
                metadata={
                    "title": title,
                    "source": "docparse",
                    "file_record_id": file_record_id,
                    "total_pages": parsed_doc.total_pages,
                    "parse_method": parsed_doc.parse_method or "",
                    "space_id": sp_str,
                },
                status="success",
            ))

        with transaction.atomic(using="postgresql"):
            DocumentEmbedding.objects.bulk_create(
                doc_objs,
                update_conflicts=True,
                unique_fields=['document_id', 'version'],
                update_fields=[
                    'organization_id', 'space_id', 'content', 'content_hash',
                    'embedding', 'metadata', 'status', 'updated_at',
                ],
            )
            # 清理已不再引用的旧版本记录
            DocumentEmbedding.objects.filter(
                document_id=doc_uuid,
                version__gt=len(contexts),
            ).delete()

        task_record.mark_success()
        logger.info(
            "[DocparseRAG] Indexed: file_record=%s, pages=%d, spaces=%d",
            file_record_id, parsed_doc.total_pages, len(contexts),
        )
        return {
            "status": "success",
            "file_record_id": file_record_id,
            "document_id": str(doc_uuid),
            "spaces_indexed": len(contexts),
        }

    except SceneRoutingDisabled:
        _cancel_embedding_task(task_record, 'scene_routing_disabled')
        logger.info("[DocparseRAG] skipped because scene routing is disabled: %s", file_record_id)
        return {
            "status": "skipped", "reason": "scene_routing_disabled",
            "file_record_id": file_record_id,
        }
    except Exception as exc:
        task_record.mark_failed(str(exc))
        logger.error(
            "[DocparseRAG] Index failed for %s (attempt %d/%d): %s",
            file_record_id, attempt + 1, self.max_retries + 1, exc,
        )
        raise self.retry(exc=exc, countdown=60 * (2 ** attempt))


@shared_task(name='rag.cleanup_failed_tasks', time_limit=300, soft_time_limit=270, ignore_result=True)
def cleanup_failed_tasks(days: int = 7) -> Dict[str, Any]:
    """
    定时任务：清理失败的任务记录

    删除指定天数之前的失败任务记录

    Args:
        days: 保留天数（默认 7 天）

    Returns:
        Dict: 清理结果
    """
    from apps.rag.models import EmbeddingTask
    from datetime import timedelta

    logger.info(f"🧹 开始清理失败任务: days={days}")

    try:
        cutoff_date = timezone.now() - timedelta(days=days)

        # 删除失败的任务
        deleted_count = EmbeddingTask.objects.filter(
            status='failed',
            created_at__lt=cutoff_date
        ).delete()[0]

        logger.info(f"✅ 清理完成: 删除 {deleted_count} 条失败任务记录")

        return {
            'success': True,
            'deleted_count': deleted_count,
            'cutoff_date': cutoff_date.isoformat()
        }

    except Exception as exc:
        logger.error(f"❌ 清理失败任务失败: {exc}")
        return {
            'success': False,
            'error': str(exc)
        }


@shared_task(name='rag.reindex_failed_tasks', time_limit=600, soft_time_limit=560, ignore_result=True)
def reindex_failed_tasks(**_kwargs) -> Dict[str, Any]:
    """
    定时任务：清理失败任务中已删除资源的记录，以及 organization 已删除的孤儿 EmbeddingTask。

    重试由 Celery 原生机制（max_retries + 指数退避）负责，
    此任务将以下三类 EmbeddingTask 处理：
    1. 关联资源（Table/Record/Document）已不存在的失败任务 → cancelled
    2. organization_id 指向已删除 organization 的任务（SC-026：孤儿任务清理） → cancelled
    3. CC-009/CC-010：processing 状态超过 _PROCESSING_TIMEOUT_SECONDS 的僵尸任务 → failed
       （SIGTERM/OOM Kill 导致 mark_success 未调用，任务永久卡在 processing）
    """
    from apps.rag.models import EmbeddingTask
    from apps.tabdata.models import Table, TableRecord

    logger.info("🧹 开始清理失败任务中的孤儿记录")

    # CC-009/CC-010：processing 状态超时阈值（秒）。
    # embed_record_task time_limit=300s，加上调度延迟余量，合理超时设为 1800s。
    # 超过此阈值仍处于 processing 的任务视为 SIGTERM/OOM Kill 僵尸任务，转为 failed 触发 reindex。
    _PROCESSING_TIMEOUT_SECONDS = 1800

    try:
        from django.db import transaction
        from django.utils import timezone
        import datetime

        cancelled_count = 0
        orphan_organization_cancelled = 0
        processing_timeout_count = 0

        # CC-009/CC-010: 超时 processing 僵尸任务 → failed，触发后续 reindex 兜底
        try:
            timeout_cutoff = timezone.now() - datetime.timedelta(seconds=_PROCESSING_TIMEOUT_SECONDS)
            with transaction.atomic(using='postgresql'):
                timed_out_tasks = list(
                    EmbeddingTask.objects.select_for_update(skip_locked=True)
                    .filter(
                        status='processing',
                        started_at__lt=timeout_cutoff,
                    )
                    .order_by('started_at')[:200]
                )
                for task in timed_out_tasks:
                    task.status = 'failed'
                    task.error_message = (
                        f'processing 超时（超过 {_PROCESSING_TIMEOUT_SECONDS}s），'
                        f'推测为 SIGTERM/OOM Kill 导致 worker 未正常结束'
                    )
                    task.save(update_fields=['status', 'error_message'])
                    processing_timeout_count += 1

            if processing_timeout_count:
                logger.warning(
                    "[CC-009/CC-010] 检测到 %d 个 processing 超时僵尸任务，已转为 failed 等待 reindex",
                    processing_timeout_count,
                )
            else:
                logger.debug("[CC-009/CC-010] 无 processing 超时任务")
        except Exception as timeout_exc:
            logger.warning("[CC-009/CC-010] processing 超时检测异常，跳过此步骤: %s", timeout_exc)

        # SC-026: 先清理 organization 已删除的孤儿 EmbeddingTask（包含所有状态，非仅 failed）
        try:
            from apps.tabtinspace.models import Organization

            with transaction.atomic(using='postgresql'):
                # 取出所有有 organization_id 的非终态任务（pending/processing/failed）
                active_tasks_with_ws = list(
                    EmbeddingTask.objects.select_for_update(skip_locked=True)
                    .filter(
                        organization_id__isnull=False,
                        status__in=('pending', 'processing', 'failed'),
                    )
                    .order_by('created_at')[:500]
                )

                if active_tasks_with_ws:
                    task_organization_ids = {str(t.organization_id) for t in active_tasks_with_ws}
                    existing_organization_ids = set(
                        str(wid) for wid in
                        Organization.objects.filter(id__in=list(task_organization_ids))
                        .values_list('id', flat=True)
                    )
                    deleted_organization_ids = task_organization_ids - existing_organization_ids

                    if deleted_organization_ids:
                        for task in active_tasks_with_ws:
                            if str(task.organization_id) in deleted_organization_ids:
                                task.status = 'cancelled'
                                task.error_message = 'organization 已删除，任务成为孤儿记录'
                                task.save(update_fields=['status', 'error_message'])
                                orphan_organization_cancelled += 1

                        logger.info(
                            "[SC-026] 清理 organization 已删除的孤儿 EmbeddingTask: cancelled=%d, "
                            "deleted_organizations=%s",
                            orphan_organization_cancelled,
                            deleted_organization_ids,
                        )
        except Exception as ws_exc:
            logger.warning("[SC-026] organization 孤儿任务清理异常，跳过此步骤: %s", ws_exc)

        with transaction.atomic(using='postgresql'):
            failed_tasks = list(
                EmbeddingTask.objects.select_for_update(skip_locked=True)
                .filter(status='failed')
                .order_by('created_at')[:200]
            )

            if not failed_tasks:
                logger.info("✅ 没有需要清理的失败任务")
                return {
                    'success': True,
                    'cancelled': 0,
                    'orphan_organization_cancelled': orphan_organization_cancelled,
                    'processing_timeout_converted': processing_timeout_count,
                }

            table_target_ids = {
                str(t.target_id) for t in failed_tasks
                if t.task_type in ('table', 'batch')
            }
            record_target_ids = {
                str(t.target_id) for t in failed_tasks
                if t.task_type == 'record'
            }
            document_target_ids = {
                str(t.target_id) for t in failed_tasks
                if t.task_type == 'document'
            }
            # SI-09: 收集 code 类型任务对应的 project_id（存放在 error_message 或保守保留）
            code_task_ids = {
                str(t.id) for t in failed_tasks
                if t.task_type == 'code'
            }

            existing_table_ids = set(
                str(tid) for tid in
                Table.objects.filter(id__in=list(table_target_ids))
                .values_list('id', flat=True)
            ) if table_target_ids else set()

            existing_record_ids = set(
                str(rid) for rid in
                TableRecord.objects.filter(id__in=list(record_target_ids))
                .values_list('id', flat=True)
            ) if record_target_ids else set()

            existing_document_ids: set = document_target_ids.copy()
            if document_target_ids:
                try:
                    from apps.tabdoc.models import Document
                    existing_document_ids = set(
                        str(did) for did in
                        Document.objects.filter(
                            id__in=list(document_target_ids),
                            trashed_at__isnull=True,
                        ).exclude(
                            status='archived',
                        ).values_list('id', flat=True)
                    )
                except Exception as doc_exc:
                    logger.warning("Document 查询异常，跳过 document 类型清理: %s", doc_exc)
                    existing_document_ids = document_target_ids.copy()

            # SI-09: code 类型的项目存在性——通过 CodeChunkEmbedding 表检查 project_id
            # code 任务的 target_id 存的是 organization_id 而非 project_id，无法直接查项目，
            # 保守处理：code 失败任务一律视为"资源仍存在"，不自动 cancel，避免积压数据丢失。
            for task in failed_tasks:
                tid = str(task.target_id)
                resource_exists = (
                    (task.task_type in ('table', 'batch') and tid in existing_table_ids)
                    or (task.task_type == 'record' and tid in existing_record_ids)
                    or (task.task_type == 'document' and tid in existing_document_ids)
                    or (task.task_type == 'code')  # SI-09: code 类型保守保留，避免误 cancel
                )
                if not resource_exists:
                    task.status = 'cancelled'
                    task.error_message = '目标资源已删除'
                    task.save(update_fields=['status', 'error_message'])
                    cancelled_count += 1

            if code_task_ids:
                logger.info(
                    "[SI-09] 跳过 %d 个 code 类型失败任务的 cancel 检查（保守策略）",
                    len(code_task_ids),
                )

        logger.info("✅ 失败任务清理完成: 取消 %d 个(资源已删除)", cancelled_count)

        return {
            'success': True,
            'cancelled': cancelled_count,
            'total_checked': len(failed_tasks),
            'orphan_organization_cancelled': orphan_organization_cancelled,
            'processing_timeout_converted': processing_timeout_count,
        }

    except Exception as exc:
        logger.error(f"❌ 失败任务清理失败: {exc}")
        return {'success': False, 'error': str(exc)}


def _acquire_record_lock(record_id: str, ttl: int = 360) -> str:
    """
    获取 record 级别分布式锁，防止同一 record 的并发 embed 任务（SC-003 修复）。

    TTL 略大于 embed_record_task time_limit（300s），确保任务超时后锁自动释放。

    Returns:
        owner token (str) if lock acquired; empty string if lock already held or Redis unavailable.
        On Redis failure returns empty string (fail-closed), consistent with _acquire_target_lock.
    """
    try:
        from django_redis import get_redis_connection
        redis = get_redis_connection("default")
        token = str(uuid.uuid4())
        acquired = bool(
            redis.set(f"rag:record_index_lock:{record_id}", token, nx=True, ex=ttl)
        )
        return token if acquired else ""
    except Exception:
        logger.warning(
            "Redis lock acquire failed for record %s, skipping (fail-closed)", record_id, exc_info=True
        )
        return ""


def _release_record_lock(record_id: str, token: str = "") -> None:
    """释放 record 级别分布式锁，通过 owner token 验证防止误释放。"""
    _lua_release = """
if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
else
    return 0
end
"""
    try:
        from django_redis import get_redis_connection
        redis = get_redis_connection("default")
        if token:
            redis.eval(_lua_release, 1, f"rag:record_index_lock:{record_id}", token)
        else:
            redis.delete(f"rag:record_index_lock:{record_id}")
    except Exception:
        pass


@shared_task(
    bind=True,
    max_retries=3,
    default_retry_delay=60,
    name='rag.embed_record_task',
    ignore_result=True,
    time_limit=300,
    soft_time_limit=270,
)
def embed_record_task(self, record_id: str, force: bool = False, root_task_id: str = None) -> Dict[str, Any]:
    """
    异步为单个记录创建向量索引

    Args:
        record_id: 记录 ID
        force: 是否强制重建索引
        root_task_id: TI-03 — 首次执行时的 celery_task_id，重试时保持不变

    Returns:
        Dict: 索引结果

    SC-003 修复：在任务入口通过 Redis 分布式锁保证同一 record 不被并发处理。
    当 embedding API 响应时间超过防抖窗口（5s）时，跨窗口触发的第二个任务会
    在此处检测到锁已被持有，直接跳过，避免并发 upsert 引发 SC-002 竞态。
    """
    from apps.rag.services import IndexService
    from apps.rag.models import EmbeddingTask
    from apps.tabdata.models import TableRecord

    task_id = self.request.id
    attempt = self.request.retries
    # TI-03: 首次执行时确立 root_task_id
    if root_task_id is None:
        root_task_id = task_id

    # SC-003: 获取 record 级别分布式锁，防止跨防抖窗口的并发执行
    lock_token = _acquire_record_lock(record_id)
    if not lock_token:
        logger.info(
            "⏭️ 跳过记录索引任务（已有并发任务处理中）: record_id=%s, task_id=%s",
            record_id, task_id,
        )
        return {'success': False, 'record_id': record_id, 'reason': 'concurrent_task_skipped'}

    logger.info(
        "🔄 开始记录索引任务: record_id=%s, task_id=%s, root_task_id=%s, attempt=%d/%d",
        record_id, task_id, root_task_id, attempt + 1, self.max_retries + 1,
    )

    organization_id = _resolve_record_organization(record_id)
    if organization_id is None:
        _release_record_lock(record_id, lock_token)
        logger.warning("记录不存在或无法解析 organization，跳过索引: record_id=%s", record_id)
        return {"success": False, "record_id": record_id, "reason": "not_found"}

    task_record, _ = EmbeddingTask.objects.update_or_create(
        celery_task_id=root_task_id,
        defaults={
            'task_type': 'record',
            'target_id': record_id,
            'organization_id': organization_id,
            'status': 'processing',
            'retry_count': attempt,
            'started_at': timezone.now(),
        }
    )

    try:
        if not TableRecord.objects.filter(id=record_id).exists():
            task_record.status = 'cancelled'
            task_record.error_message = '记录已删除'
            task_record.completed_at = timezone.now()
            task_record.save(update_fields=['status', 'error_message', 'completed_at'])
            logger.info(f"🗑️ 记录已删除，任务取消: record_id={record_id}")
            return {'success': False, 'record_id': record_id, 'reason': 'not_found'}

        service = IndexService()
        result = service.index_record(record_id, force=force)

        if result.get('status') == 'skipped':
            reason = result.get('reason', 'skipped')
            _cancel_embedding_task(task_record, reason)
            logger.info("⏭️ 记录索引任务跳过: record_id=%s reason=%s", record_id, reason)
            return {
                'success': True, 'skipped': True, 'record_id': record_id,
                'reason': reason, 'task_id': task_id,
            }

        task_record.mark_success()

        logger.info(f"✅ 记录索引完成: record_id={record_id}")

        return {
            'success': True,
            'record_id': record_id,
            'embedding_id': result.get('embedding_id'),
            'task_id': task_id
        }

    except Exception as exc:
        logger.error(
            "❌ 记录索引失败: record_id=%s, attempt=%d/%d, error=%s",
            record_id, attempt + 1, self.max_retries + 1, exc,
        )

        task_record.mark_failed(str(exc))

        # SC-003: 重试前释放锁，让下一次 retry 重新竞争，防止 finally 双重释放
        _release_record_lock(record_id, lock_token)
        lock_token = ""
        # TI-03: 传递 root_task_id
        raise self.retry(
            exc=exc,
            countdown=60 * (2 ** attempt),
            kwargs={'force': force, 'root_task_id': root_task_id},
        )
    finally:
        # 确保任务正常完成时释放 record 锁（异常路径已在 except 块中释放）
        if lock_token:
            _release_record_lock(record_id, lock_token)


def _send_rag_alert_webhook(anomalies: List[Dict[str, Any]]) -> None:
    """向配置的 Webhook URL 发送 RAG 异常告警（飞书/企微/Slack 通用 JSON）。

    仅当 settings.RAG_ALERT_WEBHOOK_URL 非空时才发送，否则静默跳过。
    """
    webhook_url = getattr(settings, "RAG_ALERT_WEBHOOK_URL", None)
    if not webhook_url or not anomalies:
        return
    try:
        import requests as _requests

        payload = {
            "msg_type": "text",
            "content": {
                "text": (
                    f"[RAG Alert] {len(anomalies)} 条异常:\n"
                    + "\n".join(
                        f"- [{a.get('severity', 'unknown').upper()}] {a.get('message', '')}"
                        for a in anomalies
                    )
                ),
            },
        }
        resp = _requests.post(webhook_url, json=payload, timeout=10)
        if resp.ok:
            logger.info("[RAG Webhook] 告警已发送: %d 条异常", len(anomalies))
        else:
            logger.warning("[RAG Webhook] 发送失败: status=%d body=%s", resp.status_code, resp.text[:200])
    except Exception as exc:
        logger.warning("[RAG Webhook] 发送异常: %s", exc)


@shared_task(name='rag.report_rag_status', time_limit=600, soft_time_limit=560, ignore_result=True)
def report_rag_status() -> Dict[str, Any]:
    """
    RAG 系统状态报告任务（定时执行）

    生成系统健康报告，包括索引质量、覆盖率、性能指标、异常检测等。
    检测到高严重度异常时会触发 logger.critical，并在配置了 RAG_ALERT_WEBHOOK_URL
    时向 Webhook 发送 JSON 告警消息（SS-008）。

    Returns:
        Dict: 状态报告
    """
    from apps.rag.services import MonitorService

    logger.info("📊 开始生成 RAG 系统状态报告")

    try:
        service = MonitorService()

        # 生成综合报告（复用 coverage 避免重复查询）
        report = service.get_comprehensive_report()
        anomalies = report['anomalies']
        suggestions = service.get_optimization_suggestions()

        # 记录关键指标
        index_quality = report['index_quality']
        coverage = report['index_coverage']

        logger.info(
            f"📈 RAG 状态："
            f" 表格向量={index_quality['total_tables']}"
            f" 记录向量={index_quality['total_records']}"
            f" 失败率={index_quality['failure_rate']}%"
            f" 表格覆盖率={coverage['table_coverage']['coverage_rate']}%"
        )

        # 异常告警（SS-008）
        if anomalies['has_anomalies']:
            high_anomalies = [a for a in anomalies['anomalies'] if a.get('severity') == 'high']
            medium_anomalies = [a for a in anomalies['anomalies'] if a.get('severity') != 'high']

            for anomaly in high_anomalies:
                # high 级别使用 critical，确保运维监控平台能拦截
                logger.critical(
                    "🚨 [RAG ALERT][HIGH] %s | details=%s",
                    anomaly['message'], anomaly.get('details', {}),
                )
            for anomaly in medium_anomalies:
                logger.warning(
                    "⚠️  [RAG ALERT][%s] %s",
                    anomaly['severity'].upper(), anomaly['message'],
                )

            # 可选 Webhook 通知（飞书/企微/Slack 等通用 POST JSON 格式）
            _send_rag_alert_webhook(anomalies['anomalies'])

        # 优化建议
        if suggestions:
            logger.info(f"💡 {len(suggestions)} 条优化建议")

        logger.info("✅ RAG 状态报告生成完成")

        return {
            'success': True,
            'report': report,
            'anomalies': anomalies,
            'suggestions': suggestions,
            'timestamp': timezone.now().isoformat()
        }

    except Exception as e:
        logger.error(f"❌ 生成状态报告失败: {e}")
        return {
            'success': False,
            'error': str(e),
            'timestamp': timezone.now().isoformat()
        }


@shared_task(name='rag.get_task_status', time_limit=30, soft_time_limit=25)
def get_task_status(task_id: str) -> Dict[str, Any]:
    """
    获取任务状态

    Args:
        task_id: Celery 任务 ID

    Returns:
        Dict: 任务状态信息
    """
    from celery.result import AsyncResult

    try:
        result = AsyncResult(task_id)

        return {
            'task_id': task_id,
            'state': result.state,
            'ready': result.ready(),
            'successful': result.successful() if result.ready() else None,
            'result': result.result if result.ready() else None,
            'info': result.info
        }

    except Exception as exc:
        logger.error(f"❌ 获取任务状态失败: task_id={task_id}, error={exc}")
        return {
            'task_id': task_id,
            'error': str(exc)
        }


# ===== Skill Embedding 索引任务 =====


def _iter_organization_owner_pairs(total: Dict[str, int]) -> None:
    """遍历所有 organization → 选一位 owner/成员逐个刷新 user 来源 Skill 索引。

    ：Skill 租户键改为 organization_id；直接按 organization 维度定时兜底，
    不再走 space → workspace 反查，也不再依赖已下线的 Redis LOCAL_CACHE_KEY。
    """
    from apps.tabtinspace.models import Organization, OrganizationMember
    from apps.skills.services.embedding_service import SkillEmbeddingService

    _BATCH = 500
    offset = 0

    while True:
        org_ids = list(
            Organization.objects.values_list("id", flat=True)
            .order_by("id")[offset:offset + _BATCH]
        )
        if not org_ids:
            break
        offset += len(org_ids)

        for org_id in org_ids:
            uid = (
                OrganizationMember.objects.filter(organization_id=org_id)
                .values_list("user_id", flat=True)
                .first()
            )
            if not uid:
                continue
            try:
                org_counts = SkillEmbeddingService.index_organization_skills(
                    user_id=str(uid), organization_id=str(org_id),
                )
                for k in ("indexed", "skipped", "failed"):
                    total[k] += org_counts.get(k, 0)
                total["organizations"] += 1
            except Exception as org_exc:
                logger.warning(
                    "[SkillEmbedding] organization %s 索引失败: %s",
                    org_id, org_exc,
                )

    logger.info(
        "[SkillEmbedding] organization 遍历完成: %d 个 organization",
        total["organizations"],
    )


@shared_task(
    bind=True,
    max_retries=2,
    default_retry_delay=120,
    name='rag.index_all_skills',
    time_limit=600,
    soft_time_limit=560,
)
def index_all_skills_task(self) -> Dict[str, Any]:
    """定时刷新所有技能的向量索引（全局 + 各 organization 的 user 来源 skill）。

    ：租户键换 organization_id 后，兜底扫描直接按 organization 维度做——
    对每个 organization 选一位成员触发 `index_organization_skills(user_id, organization_id)`，
    与事件驱动的 index_single_skill_task 形成互补。
    """
    from apps.skills.services.embedding_service import SkillEmbeddingService

    logger.info("[SkillEmbedding] 开始全量索引技能...")
    total = {"indexed": 0, "skipped": 0, "failed": 0, "organizations": 0}
    try:
        counts = SkillEmbeddingService.index_all_skills()
        for k in ("indexed", "skipped", "failed"):
            total[k] += counts.get(k, 0)
        logger.info(
            "[SkillEmbedding] 全局索引完成: indexed=%d skipped=%d failed=%d",
            counts["indexed"], counts["skipped"], counts["failed"],
        )
    except Exception as exc:
        logger.error("[SkillEmbedding] 全局索引失败: %s", exc)
        raise self.retry(exc=exc)

    try:
        _iter_organization_owner_pairs(total)
    except Exception as exc:
        logger.warning("[SkillEmbedding] organization 遍历阶段出错: %s", exc)

    return {"success": True, **total}


@shared_task(
    bind=True,
    max_retries=2,
    default_retry_delay=10,
    name='rag.index_single_skill',
    time_limit=60,
    soft_time_limit=50,
)
def index_single_skill_task(
    self,
    skill_key: str,
    name: str,
    description: str,
    source: str = "platform",
    tags: Optional[List[str]] = None,
    location: Optional[str] = None,
    organization_id: Optional[str] = None,
) -> Dict[str, Any]:
    """EMB-001 / ：事件驱动的单 Skill 索引任务。

    供 SkillsRegistryService install/update/save 路径异步调用，
    使全局 / 用户来源 Skill 变更能在秒级（而非 ~10 分钟）内刷新向量索引。
    """
    from apps.skills.services.embedding_service import SkillEmbeddingService

    try:
        updated = SkillEmbeddingService.index_skill(
            skill_key=skill_key,
            name=name,
            description=description,
            source=source,
            tags=tags,
            location=location,
            organization_id=organization_id,
        )
        return {"success": True, "skill_key": skill_key, "updated": updated}
    except Exception as exc:
        logger.warning("[SkillEmbedding] single skill index failed for %s: %s", skill_key, exc)
        raise self.retry(exc=exc)


@shared_task(
    bind=True,
    max_retries=1,
    default_retry_delay=30,
    name='rag.index_organization_skills',
    time_limit=300,
    soft_time_limit=270,
)
def index_organization_skills_task(
    self, user_id: str, organization_id: str, agent_id: Optional[str] = None,
) -> Dict[str, Any]:
    """索引指定 organization 的 user 来源技能（Skill 上传/更新时触发）。

    ：租户键换成 organization_id；可选 ``agent_id`` 用于内部推导。
    """
    from apps.skills.services.embedding_service import SkillEmbeddingService

    try:
        counts = SkillEmbeddingService.index_organization_skills(
            user_id=user_id, organization_id=organization_id, agent_id=agent_id,
        )
        return {"success": True, **counts}
    except Exception as exc:
        logger.warning("[SkillEmbedding] organization index failed: %s", exc)
        raise self.retry(exc=exc)


# ===== ToolEmbedding 索引任务（EMB-002） =====

@shared_task(
    bind=True,
    max_retries=2,
    default_retry_delay=120,
    name='rag.index_all_tools',
    time_limit=300,
    soft_time_limit=270,
)
def index_all_tools_task(self) -> Dict[str, Any]:
    """EMB-002: 定时刷新所有工具的向量索引。

    ToolEmbedding 之前仅有 post_delete 信号清理，无定时全量刷新，
    RegisteredTool 更新后向量可能永久过期。
    """
    try:
        from apps.capabilities.services.tool_embedding import ToolEmbeddingService
        stats = ToolEmbeddingService.index_all()
        logger.info("[ToolEmbedding] 全量索引完成: %s", stats)
        return {"success": True, **stats}
    except Exception as exc:
        logger.error("[ToolEmbedding] 全量索引失败: %s", exc)
        raise self.retry(exc=exc)


# ===== 数据修复任务 =====

@shared_task(
    bind=True,
    max_retries=0,
    name='rag.backfill_record_metadata',
    time_limit=1200,
    soft_time_limit=1140,
)
def backfill_record_metadata_task(self, batch_size: int = 500) -> Dict[str, Any]:
    """回填 RecordEmbedding metadata 中缺失的 organization_id / space_id。"""
    from apps.rag.models import RecordEmbedding
    from apps.tabdata.models import Table

    updated = 0
    skipped = 0
    failed = 0

    table_cache: Dict[str, Dict[str, str]] = {}

    qs = RecordEmbedding.objects.values_list("id", "table_id", "metadata").iterator()
    batch: list = []

    for row_id, table_id, metadata in qs:
        if metadata and metadata.get("organization_id"):
            skipped += 1
            continue
        batch.append((row_id, str(table_id)))
        if len(batch) >= batch_size:
            _updated, _failed = _process_backfill_batch(batch, table_cache)
            updated += _updated
            failed += _failed
            batch = []

    if batch:
        _updated, _failed = _process_backfill_batch(batch, table_cache)
        updated += _updated
        failed += _failed

    logger.info(
        "[BackfillMetadata] done: updated=%d skipped=%d failed=%d",
        updated, skipped, failed,
    )
    return {"updated": updated, "skipped": skipped, "failed": failed}


@shared_task(
    bind=True,
    max_retries=0,
    name='rag.backfill_table_metadata',
    time_limit=1200,
    soft_time_limit=1140,
)
def backfill_table_metadata_task(self, batch_size: int = 500) -> Dict[str, Any]:
    """SK-003: 回填 TableEmbedding 顶层 organization_id 字段中缺失的值。

    migration 0011 只添加了字段，没有回填逻辑；
    migration 0013 只回填了 space_id，未回填 organization_id。
    此任务从 metadata.organization_id 持续回填，确保历史数据正确。
    """
    from apps.rag.models import TableEmbedding
    import uuid as _uuid

    updated = 0
    skipped = 0
    failed = 0

    qs = TableEmbedding.objects.filter(organization_id__isnull=True).values_list("id", "table_id", "metadata").iterator()
    batch_objs: list = []

    for row_id, table_id, metadata in qs:
        raw_ws = (metadata or {}).get("organization_id", "")
        if not raw_ws:
            skipped += 1
            continue
        try:
            parsed_ws = _uuid.UUID(str(raw_ws))
        except (ValueError, AttributeError):
            skipped += 1
            continue
        batch_objs.append((row_id, parsed_ws))

        if len(batch_objs) >= batch_size:
            u, f = _apply_table_embedding_organization_backfill(batch_objs)
            updated += u
            failed += f
            batch_objs = []

    if batch_objs:
        u, f = _apply_table_embedding_organization_backfill(batch_objs)
        updated += u
        failed += f

    logger.info(
        "[BackfillTableMetadata] done: updated=%d skipped=%d failed=%d",
        updated, skipped, failed,
    )
    return {"updated": updated, "skipped": skipped, "failed": failed}


def _apply_table_embedding_organization_backfill(
    batch: list,
) -> tuple:
    """对 TableEmbedding 批量回填 organization_id。"""
    from apps.rag.models import TableEmbedding

    updated = 0
    failed = 0
    for row_id, parsed_ws in batch:
        try:
            TableEmbedding.objects.filter(id=row_id, organization_id__isnull=True).update(organization_id=parsed_ws)
            updated += 1
        except Exception:
            failed += 1
    return updated, failed


def _process_backfill_batch(
    batch: list,
    table_cache: Dict[str, Dict[str, str]],
) -> tuple:
    from apps.rag.models import RecordEmbedding
    from apps.tabdata.models import Table

    table_ids_needed = {tid for _, tid in batch if tid not in table_cache}
    if table_ids_needed:
        for t in Table.objects.filter(id__in=table_ids_needed).only("id", "organization_id", "space_id"):
            table_cache[str(t.id)] = {
                "organization_id": str(t.organization_id),
                "space_id": str(t.space_id),
            }

    updated = 0
    failed = 0
    for row_id, table_id in batch:
        info = table_cache.get(table_id)
        if not info:
            failed += 1
            continue
        try:
            import uuid as _uuid
            emb = RecordEmbedding.objects.get(id=row_id)
            meta = emb.metadata or {}
            meta["organization_id"] = info["organization_id"]
            meta["space_id"] = info["space_id"]
            emb.metadata = meta
            if info["organization_id"]:
                try:
                    emb.organization_id = _uuid.UUID(info["organization_id"])
                except (ValueError, AttributeError):
                    pass
            if info["space_id"]:
                try:
                    emb.space_id = _uuid.UUID(info["space_id"])
                except (ValueError, AttributeError):
                    pass
            emb.save(update_fields=["metadata", "organization_id", "space_id"])
            updated += 1
        except Exception:
            failed += 1
    return updated, failed


# ===== SVC-37: 批量合并 flush 任务 =====

@shared_task(name='rag.flush_record_batch', time_limit=120, soft_time_limit=100, ignore_result=True)
def _flush_record_batch(table_id: str) -> Dict[str, Any]:
    """
    Trailing edge 防抖 flush：从 Redis Set 中原子弹出积累的 record_id，
    逐批分发 embed_record_task。

    TI-04 修复：
    1. 使用 SPOP 代替 SMEMBERS+DELETE，避免 flush 期间新写入被一并清除（竞争窗口）
    2. 分批取出（每批 500），防止一次性加载超大 Set
    3. trigger_key 在所有记录分发完毕后才删除，时序正确
    4. 若触及上限（5000）且 Set 仍有余量，重新调度 flush 保证数据不丢

    SC-005 修复：SPOP + delay 非原子补偿
    SPOP 弹出 record_ids 后若 broker 故障导致 delay() 失败，将未成功分发的
    record_ids 回写到 Redis Set，防止数据永久丢失。
    """
    _BATCH_SIZE = 500
    _MAX_TOTAL = 5000
    _RECORD_BATCH_SET_TTL = 300  # DA-006: 与防抖窗口保持一致，broker 故障恢复窗口 5 分钟

    try:
        from django_redis import get_redis_connection
        redis = get_redis_connection("default")
        set_key = f"rag:record_batch:{table_id}"
        trigger_key = f"rag:record_batch_trigger:{table_id}"

        flushed = 0
        while flushed < _MAX_TOTAL:
            batch = redis.spop(set_key, _BATCH_SIZE)
            if not batch:
                break
            decoded = [rid.decode() if isinstance(rid, bytes) else rid for rid in batch]
            logger.debug(
                "[RAG] Flushing record batch: table_id=%s, batch=%d, total_so_far=%d",
                table_id, len(decoded), flushed + len(decoded),
            )
            # P1-10 修复：50 条一组 micro-batch 投递，兼顾 pipeline 效率和故障粒度。
            # 单 micro-batch 失败最多丢 50 条而非全部，且减少 broker 调用次数。
            _MICRO_BATCH_SIZE = 50
            failed_ids = []
            it = iter(decoded)
            for micro_batch in iter(lambda: list(islice(it, _MICRO_BATCH_SIZE)), []):
                try:
                    group(
                        embed_record_task.s(rid, force=False)
                        for rid in micro_batch
                    ).apply_async()
                except Exception as dispatch_exc:
                    logger.warning(
                        "[RAG] micro-batch dispatch failed, will restore to set: "
                        "table_id=%s, batch_size=%d, error=%s",
                        table_id, len(micro_batch), dispatch_exc,
                    )
                    failed_ids.extend(micro_batch)

            if failed_ids:
                try:
                    redis.sadd(set_key, *failed_ids)
                    redis.expire(set_key, _RECORD_BATCH_SET_TTL)  # DA-006: 300s 与防抖窗口一致
                    logger.warning(
                        "[RAG] Restored %d failed record_ids to set: table_id=%s",
                        len(failed_ids), table_id,
                    )
                except Exception as restore_exc:
                    logger.error(
                        "[RAG] CRITICAL: Failed to restore record_ids to set after dispatch failure. "
                        "Data may be lost! table_id=%s, lost_ids=%s, error=%s",
                        table_id, failed_ids, restore_exc,
                    )

            flushed += len(decoded) - len(failed_ids)

        if flushed > 0:
            logger.info("[RAG] flush_record_batch done: table_id=%s, flushed=%d", table_id, flushed)

        remaining = redis.scard(set_key)
        if remaining > 0:
            logger.warning(
                "[RAG] flush_record_batch cap hit, rescheduling: table_id=%s, remaining=%d",
                table_id, remaining,
            )
            _flush_record_batch.apply_async((table_id,), countdown=5)
        else:
            redis.delete(trigger_key)

        return {"flushed": flushed, "table_id": table_id}
    except Exception as exc:
        logger.error("[RAG] flush_record_batch failed: table=%s, error=%s", table_id, exc)
        return {"flushed": 0, "error": str(exc)}


# ===== SVC-17: 异步删除索引任务 =====

@shared_task(name='rag.async_delete_table_index', time_limit=300, soft_time_limit=270, ignore_result=True)
def _async_delete_table_index(table_id: str) -> Dict[str, Any]:
    """异步删除表格索引，避免在 on_commit 回调中同步阻塞 HTTP 线程。"""
    from apps.rag.services import IndexService
    try:
        service = IndexService()
        service.delete_table_index(table_id)
        service.delete_table_records_index(table_id)
        logger.info("Async deleted table index: table_id=%s", table_id)
        return {"success": True, "table_id": table_id}
    except Exception as e:
        logger.error("Async delete table index failed: table_id=%s, error=%s", table_id, e)
        return {"success": False, "error": str(e)}


@shared_task(name='rag.async_delete_record_index', time_limit=60, soft_time_limit=50, ignore_result=True)
def _async_delete_record_index(record_id: str) -> Dict[str, Any]:
    """异步删除记录索引，避免在 on_commit 回调中同步阻塞 HTTP 线程。"""
    from apps.rag.services import IndexService
    try:
        service = IndexService()
        service.delete_record_index(record_id)
        return {"success": True, "record_id": record_id}
    except Exception as e:
        logger.error("Async delete record index failed: record_id=%s, error=%s", record_id, e)
        return {"success": False, "error": str(e)}


@shared_task(name='rag.async_delete_document_index', time_limit=300, soft_time_limit=270, ignore_result=True)
def _async_delete_document_index(document_id: str) -> Dict[str, Any]:
    """异步删除文档索引，避免在 on_commit 回调中同步阻塞 HTTP 线程（SVC-17 补全）。"""
    try:
        from apps.tabdoc.services.document_embedding_service import DocumentEmbeddingService
        DocumentEmbeddingService.delete_document_index(document_id)
        logger.info("Async deleted document index: document_id=%s", document_id)
        return {"success": True, "document_id": document_id}
    except Exception as e:
        logger.error("Async delete document index failed: document_id=%s, error=%s", document_id, e)
        return {"success": False, "error": str(e)}


# ===== Celery Beat 定时任务配置 =====

from celery.schedules import crontab

RAG_BEAT_SCHEDULE = {
    'rag-incremental-index-daily': {
        'task': 'rag.incremental_index_all',
        'schedule': crontab(hour=2, minute=0),
        'options': {'expires': 3600},
    },
    'rag-cleanup-failed-tasks-weekly': {
        'task': 'rag.cleanup_failed_tasks',
        'schedule': crontab(hour=3, minute=0, day_of_week=0),
        'args': (7,),
        'options': {'expires': 3600},
    },
    'rag-cleanup-orphan-failed-daily': {
        'task': 'rag.reindex_failed_tasks',
        'schedule': crontab(hour=4, minute=0),
        'options': {'expires': 3600},
    },
    'rag-report-status-hourly': {
        'task': 'rag.report_rag_status',
        'schedule': crontab(minute=30),
        'options': {'expires': 1800},
    },
    # EMB-001: 提高频率到每 10 分钟，配合事件驱动的 index_single_skill_task 作为兜底
    'rag-index-skills-periodic': {
        'task': 'rag.index_all_skills',
        'schedule': crontab(minute='*/10'),
        'options': {'expires': 540},
    },
    # EMB-002: ToolEmbedding 定时全量刷新（每小时），补全 post_delete 信号不覆盖的更新场景
    'rag-index-tools-hourly': {
        'task': 'rag.index_all_tools',
        'schedule': crontab(minute=45),
        'options': {'expires': 1800},
    },
    'rag-cleanup-search-logs-daily': {
        'task': 'rag.cleanup_old_search_logs',
        'schedule': crontab(hour=5, minute=0),
        'options': {'expires': 3600},
    },
    # SC-010: 定期回填 RecordEmbedding metadata 中缺失的 organization_id，修复幽灵数据问题
    'rag-backfill-record-metadata-daily': {
        'task': 'rag.backfill_record_metadata',
        'schedule': crontab(hour=6, minute=0),
        'options': {'expires': 3600},
    },
    # SK-003: 定期回填 TableEmbedding 缺失的 organization_id（migration 0011 未回填）
    'rag-backfill-table-metadata-daily': {
        'task': 'rag.backfill_table_metadata',
        'schedule': crontab(hour=6, minute=30),
        'options': {'expires': 3600},
    },
}


_SEARCH_LOG_BATCH_SIZE = 2000
_SEARCH_LOG_RETENTION_DAYS = getattr(settings, 'RAG_SEARCH_LOG_RETENTION_DAYS', 30)


@shared_task(
    name='rag.log_search_async',
    ignore_result=True,
    time_limit=30,
    soft_time_limit=25,
)
def log_search_async(
    query: str,
    user_id: str,
    results_count: int,
    top_similarity: float,
    response_time_ms: int,
    organization_id=None,
    content_types=None,
    scope=None,
    threshold=None,
    top_k=None,
) -> None:
    """PVEC-010: 异步写入 SearchLog，避免同步写入对每次检索增加 PostgreSQL 写压力。

    写入失败时以结构化日志记录关键指标，确保 PostgreSQL 故障期间监控数据仍有可观测性。
    """
    try:
        from apps.rag.models import SearchLog
        SearchLog.objects.using("postgresql").create(
            user_id=user_id,
            query=query,
            results_count=results_count,
            top_similarity_score=top_similarity,
            response_time_ms=response_time_ms,
            filters={
                "source": "unified_search_v2",
                "organization_id": organization_id,
                "content_types": content_types,
                "scope": scope,
                "threshold": threshold,
                "top_k": top_k,
            },
        )
    except Exception as exc:
        logger.warning(
            "[RAG] log_search_async failed: %s | "
            "search_metric user_id=%s results_count=%d response_time_ms=%d "
            "top_similarity=%.4f organization_id=%s",
            exc,
            user_id,
            results_count,
            response_time_ms,
            top_similarity,
            organization_id,
        )



@shared_task(
    name='rag.cleanup_old_search_logs',
    ignore_result=True,
    time_limit=600,
    soft_time_limit=560,
)
def cleanup_old_search_logs(retention_days: int = _SEARCH_LOG_RETENTION_DAYS):
    """清理过期的 SearchLog 记录（含 1536 维向量，约 6KB/行）。

    每天执行一次，分批删除防止锁表和事务过大。
    """
    from datetime import timedelta
    from django.utils import timezone
    from apps.rag.models import SearchLog

    cutoff = timezone.now() - timedelta(days=retention_days)
    total_deleted = 0

    while True:
        batch_ids = list(
            SearchLog.objects.using("postgresql")
            .filter(created_at__lt=cutoff)
            .values_list("id", flat=True)[:_SEARCH_LOG_BATCH_SIZE]
        )
        if not batch_ids:
            break
        deleted, _ = SearchLog.objects.using("postgresql").filter(id__in=batch_ids).delete()
        total_deleted += deleted

    if total_deleted:
        logger.info("[RAG] SearchLog cleanup: deleted=%d retention=%d days", total_deleted, retention_days)


# =====================================================================
# Document Embedding Tasks
# =====================================================================

@shared_task(
    bind=True,
    max_retries=3,
    default_retry_delay=60,
    name='rag.index_document_task',
    ignore_result=True,
    time_limit=900,
    soft_time_limit=840,
)
def index_document_task(self, document_id: str, force: bool = False, root_task_id: str = None) -> Dict[str, Any]:
    """异步为单个文档创建向量索引（含 EmbeddingTask 追踪）。

    root_task_id: TI-03 — 首次执行时的 celery_task_id，重试时保持不变以复用同一记录。
    """
    from apps.rag.models import EmbeddingTask
    from apps.tabdoc.services.document_embedding_service import DocumentEmbeddingService

    task_id = self.request.id
    attempt = self.request.retries
    # TI-03: 首次执行时确立 root_task_id
    if root_task_id is None:
        root_task_id = task_id

    # SC-004: 获取 document target-level 分布式锁，防止不同触发源并发索引同一文档
    lock_token = _acquire_target_lock("document", document_id, ttl=960)  # >= time_limit 900s
    if not lock_token:
        logger.info(
            "⏳ document %s 已有其他 worker 正在索引，跳过本次触发 (attempt=%d)",
            document_id, attempt + 1,
        )
        return {"success": False, "document_id": document_id, "reason": "already_processing"}

    organization_id = _resolve_document_organization(document_id)
    if organization_id is None:
        _release_target_lock("document", document_id, lock_token)
        logger.warning("文档不存在或无法解析 organization，跳过索引: document_id=%s", document_id)
        return {"success": False, "document_id": document_id, "reason": "not_found"}

    task_record, _ = EmbeddingTask.objects.update_or_create(
        celery_task_id=root_task_id,
        defaults={
            'task_type': 'document',
            'target_id': document_id,
            'organization_id': organization_id,
            'status': 'processing',
            'retry_count': attempt,
            'started_at': timezone.now(),
        },
    )

    try:
        result = DocumentEmbeddingService.index_document(document_id, force=force)

        status = result.get("status", "failed")
        if status == "success":
            task_record.mark_success()
        elif status in ("skipped", "not_found"):
            task_record.status = "cancelled"
            task_record.error_message = result.get("reason", status)
            task_record.completed_at = timezone.now()
            task_record.save(update_fields=["status", "error_message", "completed_at"])
        else:
            task_record.mark_failed(result.get("error", "unknown"))

        return result

    except Exception as exc:
        task_record.mark_failed(str(exc))
        logger.error("[DocEmbedding] task failed for %s: %s", document_id, exc)
        # SC-004: 重试前释放锁，让下一次 retry 重新竞争
        _release_target_lock("document", document_id, lock_token)
        lock_token = ""
        # TI-03: 传递 root_task_id
        raise self.retry(exc=exc, kwargs={'force': force, 'root_task_id': root_task_id})
    finally:
        # SC-004: 任务正常完成时释放锁
        if lock_token:
            _release_target_lock("document", document_id, lock_token)


@shared_task(
    name='rag.index_documents_batch_task',
    time_limit=1800,
    soft_time_limit=1740,
)
def index_documents_batch_task(document_ids: List[str], force: bool = False) -> Dict[str, int]:
    """批量文档向量索引。"""
    from apps.tabdoc.services.document_embedding_service import DocumentEmbeddingService
    return DocumentEmbeddingService.index_documents_batch(document_ids, force=force)


# =====================================================================
# Retired TabCode indexing task compatibility
# =====================================================================

@shared_task(
    bind=True,
    max_retries=3,
    default_retry_delay=60,
    name='rag.index_code_chunks_task',
    time_limit=1200,
    soft_time_limit=1140,
)
def index_code_chunks_task(
    self,
    project_id: str,
    organization_id: str,
    chunks_data: Optional[List[Dict[str, Any]]] = None,
    force: bool = False,
    user_id: str = '',
    file_hashes: Optional[Dict[str, str]] = None,
    chunks_staging_key: Optional[str] = None,
    root_task_id: str = None,
) -> Dict[str, Any]:
    """
    Retired task-name tombstone.

    Keep the Celery name for one release so stale messages are consumed without
    producing embeddings. Staged payloads are best-effort deleted immediately;
    Redis TTL remains the fallback.
    """
    if chunks_staging_key:
        try:
            from django_redis import get_redis_connection
            get_redis_connection("default").delete(chunks_staging_key)
        except Exception as exc:
            logger.warning(
                "Retired code-index task could not clean staging key %s: %s",
                chunks_staging_key,
                exc,
            )
    logger.info("Ignored retired code-index task for project_id=%s", project_id)
    return {
        'success': False,
        'retired': True,
        'project_id': project_id,
        'error': 'code_semantic_search_retired',
    }


# SC-004: target-level 分布式锁辅助函数（用于 table/record/document 索引任务互斥）
def _acquire_target_lock(target_type: str, target_id: str, ttl: int = 600) -> str:
    """获取 target-level 分布式锁，防止不同触发源对同一 target 并发索引。

    SC-004 修复：使用 owner-token 模式为 table/record/document 添加 target_id
    级别 Redis 互斥锁。TTL 默认 600s（覆盖对应任务的 time_limit）。

    Returns:
        owner token (str) if lock acquired; empty string otherwise (including Redis failure).
    """
    try:
        from django_redis import get_redis_connection
        redis_conn = get_redis_connection("default")
        token = str(uuid.uuid4())
        acquired = bool(
            redis_conn.set(f"rag:index_lock:{target_type}:{target_id}", token, nx=True, ex=ttl)
        )
        return token if acquired else ""
    except Exception:
        logger.warning(
            "Redis target lock acquire failed for %s:%s — fail-closed, will retry",
            target_type, target_id,
            exc_info=True,
        )
        return ""


def _release_target_lock(target_type: str, target_id: str, token: str = "") -> None:
    """释放 target-level 分布式锁，通过 owner token 防止误释放他人的锁。"""
    try:
        from django_redis import get_redis_connection
        redis_conn = get_redis_connection("default")
        lock_key = f"rag:index_lock:{target_type}:{target_id}"
        if token:
            redis_conn.eval(_LUA_RELEASE_LOCK, 1, lock_key, token)
        else:
            redis_conn.delete(lock_key)
    except Exception:
        pass


@shared_task(name='rag.delete_code_project_index', time_limit=600, soft_time_limit=560)
def delete_code_project_index(
    project_id: str,
    file_paths: Optional[List[str]] = None,
    organization_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Delete retained code vectors without restoring indexing or retrieval."""
    from apps.rag.models import CodeChunkEmbedding

    lock_token = _acquire_target_lock('code', project_id, ttl=600)
    if not lock_token:
        logger.warning("Could not acquire retained code-index deletion lock: project_id=%s", project_id)
        return {'deleted': 0, 'project_id': project_id, 'error': 'lock_failed'}

    try:
        queryset = CodeChunkEmbedding.objects.filter(project_id=project_id)
        if organization_id:
            queryset = queryset.filter(organization_id=organization_id)
        if file_paths:
            queryset = queryset.filter(file_path__in=file_paths)

        batch_size = 5000
        deleted_count = 0
        while True:
            ids = list(queryset.values_list('id', flat=True)[:batch_size])
            if not ids:
                break
            CodeChunkEmbedding.objects.filter(id__in=ids).delete()
            deleted_count += len(ids)
    finally:
        _release_target_lock('code', project_id, lock_token)

    logger.info(
        "Deleted retained code index: project_id=%s, files=%s, deleted=%d",
        project_id,
        len(file_paths) if file_paths else 'ALL',
        deleted_count,
    )
    return {'deleted': deleted_count, 'project_id': project_id}
