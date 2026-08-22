"""
RAG 信号处理器

自动触发索引任务。

SVC-37 修复：防抖改为 trailing edge + 批量合并。
- _should_index: 保持 leading edge（用于 table/field 级别的低频信号）
- _debounce_record_index: 新增 trailing edge 批量合并机制，
  同一 table 的 record 变更在窗口期内合并为一次 batch embed 任务。

bulk_update 兜底说明（D5 决策）：
  QuerySet.update() / bulk_update() 不触发 Django 信号，因此批量写入操作的
  变更不会经过本文件的信号处理器。根据架构决策 D5，采用定时兜底策略：
  - tasks.py 的 incremental_index_all 通过 updated_at > last_indexed_at 比对
    检测未被信号覆盖的变更，调度频率为每 4-6 小时执行一次。
  - 此策略接受最长 4-6 小时的索引延迟，适用于批量导入、Admin 操作等低频场景。
  - 如需更实时的覆盖，应在批量写入入口手动调用索引任务（需产品侧评估成本）。
"""

import logging
import threading
import time
from django.db.models.signals import post_save, post_delete
from django.dispatch import receiver
from django.conf import settings
from django.core.cache import cache
from django.db import transaction

logger = logging.getLogger(__name__)

# TI-08: Redis 降级路径内存速率限制，防止 Redis 故障时任务风暴
# 每个 table_id 在降级路径下最多每 _FALLBACK_RATE_LIMIT_SECONDS 秒触发一次任务
_FALLBACK_RATE_LIMIT_SECONDS = 5
_fallback_lock = threading.Lock()
_fallback_last_dispatch: dict = {}

_RECORD_DEBOUNCE_SECONDS = 5
# DA-006 修复：TTL 从 30s 延长至 300s（5 分钟）。
# 原值 30s 在 Celery 队列拥堵时过短——flush 任务排队等待超过 25s 后，
# Redis Set 过期，spop 返回空，已积累的 record_id 全部静默丢失。
# 300s 覆盖常规队列拥堵场景，flush 任务最多延迟 _RECORD_DEBOUNCE_SECONDS(5s)，
# 二者之和远小于新 TTL，不会出现数据丢失。
_RECORD_BATCH_SET_TTL = 300


def _resolve_organization_for_fallback(task_type: str, target_id: str):
    """解析降级路径的 organization_id，失败返回 None。"""
    try:
        if task_type in ('table', 'batch'):
            from apps.tabdata.models import Table
            t = Table.objects.using('postgresql').filter(id=target_id).only("organization_id").first()
            return t.organization_id if t else None
        elif task_type == 'document':
            from apps.tabdoc.models import Document
            doc = Document.objects.using('postgresql').filter(id=target_id).only("organization_id").first()
            return doc.organization_id if doc else None
    except Exception:
        pass
    return None


def _create_fallback_embedding_task(task_type: str, target_id: str, error: Exception) -> None:
    """
    CC-012: on_commit 回调中 task.delay() 失败时的降级补偿。

    Celery broker 不可用时，Django 静默吞掉 on_commit 回调异常，
    导致"DB 已提交但 Celery 任务未入队"——连 EmbeddingTask 记录都不存在，
    reindex_failed_tasks 也无法兜底。

    本函数在 broker 写入失败时写入 EmbeddingTask(status='failed')，
    确保 reindex_failed_tasks 定时任务能在 4-6 小时内（D5 决策）扫描到并重试。
    """
    try:
        import uuid as _uuid_mod
        from apps.rag.models import EmbeddingTask

        organization_id = _resolve_organization_for_fallback(task_type, target_id)
        if organization_id is None:
            logger.warning(
                "[CC-012] 无法解析 organization_id，跳过降级写入（incremental_index_all 将兜底）: "
                "task_type=%s, target_id=%s",
                task_type, target_id,
            )
            return

        EmbeddingTask.objects.create(
            task_type=task_type,
            target_id=_uuid_mod.UUID(str(target_id)),
            organization_id=organization_id,
            status='failed',
            error_message=f'broker 写入失败（on_commit 降级）: {error}',
        )
        logger.info(
            "[CC-012] 降级 EmbeddingTask 写入成功: task_type=%s, target_id=%s",
            task_type, target_id,
        )
    except Exception as db_exc:
        logger.error(
            "[CC-012] 降级写入 EmbeddingTask 也失败，此次索引将依赖 incremental_index_all 兜底: "
            "task_type=%s, target_id=%s, error=%s",
            task_type, target_id, db_exc,
        )


def _is_rag_enabled() -> bool:
    return getattr(settings, "RAG_ENABLED", True)


def _should_index(key: str, cooldown_seconds: int = 5) -> bool:
    """
    Cache-based 防抖（leading edge）：同一 key 在 cooldown 秒内只触发一次。
    用于 table / field 级别低频信号。

    TI-05 修复：cache 命中时直接 return False，不刷新 TTL。
    Leading edge 语义：首次触发后设定 cooldown，cooldown 期间不触发也不刷新。
    修复前的错误：命中时仍 cache.set 刷新 TTL，导致持续写入期间永不触发。
    """
    cache_key = f"rag:signal_debounce:{key}"
    if cache.get(cache_key):
        return False
    cache.set(cache_key, 1, timeout=cooldown_seconds)
    return True


def _debounce_record_index(table_id: str, record_id: str) -> None:
    """
    Trailing edge 批量合并：将 record_id 加入 Redis Set，
    仅在窗口期首次触发时调度延迟任务，到期后一次性处理所有积累的 record。
    """
    set_key = f"rag:record_batch:{table_id}"
    trigger_key = f"rag:record_batch_trigger:{table_id}"

    try:
        from django_redis import get_redis_connection
        redis = get_redis_connection("default")
        redis.sadd(set_key, record_id)
        redis.expire(set_key, _RECORD_BATCH_SET_TTL)

        already_scheduled = redis.set(trigger_key, "1", nx=True, ex=_RECORD_DEBOUNCE_SECONDS)
        if already_scheduled:
            from apps.rag.tasks import _flush_record_batch
            _flush_record_batch.apply_async(
                args=[table_id],
                countdown=_RECORD_DEBOUNCE_SECONDS,
            )
    except Exception:
        logger.warning(
            "Redis 不可用，回退为单条 embed: table=%s record=%s",
            table_id, record_id,
        )
        # TI-08 修复：降级路径加内存速率限制，防止 Redis 故障时批量写入触发任务风暴。
        # 同一 table_id 在 _FALLBACK_RATE_LIMIT_SECONDS 内只允许发出一个降级任务。
        # 被节流的 record 依赖 incremental_index_all 定时任务兜底（D5 决策）。
        now = time.monotonic()
        with _fallback_lock:
            last = _fallback_last_dispatch.get(table_id, 0.0)
            if now - last < _FALLBACK_RATE_LIMIT_SECONDS:
                logger.debug(
                    "降级路径速率限制命中，跳过任务发送: table=%s record=%s",
                    table_id, record_id,
                )
                return
            _fallback_last_dispatch[table_id] = now
        from apps.rag.tasks import embed_record_task
        embed_record_task.delay(record_id, force=False)


@receiver(post_save, sender='tabdata.Table')
def auto_index_table(sender, instance, created, **kwargs):
    if not _is_rag_enabled() or not settings.RAG_AUTO_EMBED_TABLES:
        return

    if created or (kwargs.get('update_fields') and
                   any(field in kwargs['update_fields']
                       for field in ['name', 'description'])):
        if not _should_index(f"table:{instance.id}"):
            return
        table_id = str(instance.id)
        logger.info("Table changed, queuing index: table_id=%s", table_id)

        def _do_index():
            from apps.rag.tasks import index_table_task
            try:
                index_table_task.delay(table_id, force=False)
            except Exception as broker_exc:
                logger.warning(
                    "[CC-012] index_table_task.delay 失败: table_id=%s, error=%s",
                    table_id, broker_exc,
                )
                _create_fallback_embedding_task('table', table_id, broker_exc)

        transaction.on_commit(_do_index)


# DA-007 修复：原条件 `'data' in update_fields` 依赖已废弃的 JSONField。
# 新代码通过原生列路径写入，不再在 update_fields 中包含 'data'，
# 导致此条件永远不满足，索引更新被静默跳过。
#
# 修复策略：定义"纯系统字段"集合——更新这些字段不影响记录可被检索的内容。
# 当 update_fields 完全由系统字段构成时，跳过索引（例如软删除、排序、版本号更新）。
# 其他情况（created=True、update_fields=None、或包含非系统字段）均触发索引。
_RECORD_SYSTEM_ONLY_FIELDS = frozenset({
    'is_deleted', 'deleted_at', 'version', 'updated_at', 'updated_by_id',
    'updated_by', 'order', 'status', 'tags',
})


# auto_index_record（原 post_save signal）已迁移到 DDD 体系：
#   DDD 路径 → subscribers/rag_index.py (RAGIndexSubscriber)
#   非 DDD 路径 → subscribers/_utils.py notify_record_changed_for_rag()


@receiver(post_save, sender='tabdata.TableField')
def auto_index_table_field(sender, instance, created, **kwargs):
    if not _is_rag_enabled() or not settings.RAG_AUTO_EMBED_TABLES:
        return

    update_fields = kwargs.get('update_fields')
    watched_fields = {
        'name', 'field_type', 'description', 'config',
        'is_deleted', 'order',
    }
    should_index = created or (not update_fields) or bool(watched_fields.intersection(update_fields))
    if should_index:
        if not _should_index(f"table:{instance.table_id}"):
            return
        table_id = str(instance.table_id)
        logger.info(
            "Field changed, queuing table index: table_id=%s, field_id=%s",
            table_id, instance.id,
        )

        def _do_index():
            from apps.rag.tasks import index_table_task
            try:
                index_table_task.delay(table_id, force=False)
            except Exception as broker_exc:
                logger.warning(
                    "[CC-012] index_table_task.delay 失败(field): table_id=%s, error=%s",
                    table_id, broker_exc,
                )
                _create_fallback_embedding_task('table', table_id, broker_exc)

        transaction.on_commit(_do_index)


@receiver(post_delete, sender='tabdata.Table')
def auto_delete_table_index(sender, instance, **kwargs):
    """SVC-17 修复：删除操作改为 .delay() 异步执行，不阻塞 HTTP 线程。"""
    if not _is_rag_enabled():
        return
    table_id = str(instance.id)
    logger.info("Table deleted, scheduling async index cleanup: table_id=%s", table_id)

    def _do_delete():
        from apps.rag.tasks import _async_delete_table_index
        _async_delete_table_index.delay(table_id)

    transaction.on_commit(_do_delete)


@receiver(post_delete, sender='tabdata.TableRecord')
def auto_delete_record_index(sender, instance, **kwargs):
    """SVC-17 修复：删除操作改为 .delay() 异步执行，不阻塞 HTTP 线程。"""
    if not _is_rag_enabled():
        return
    record_id = str(instance.id)
    logger.debug("Record deleted, scheduling async index cleanup: record_id=%s", record_id)

    def _do_delete():
        from apps.rag.tasks import _async_delete_record_index
        _async_delete_record_index.delay(record_id)

    transaction.on_commit(_do_delete)


@receiver(post_delete, sender='tabdata.TableField')
def auto_delete_table_field_index(sender, instance, **kwargs):
    """
    TI-06 修复：字段删除是破坏性操作，使用独立的 debounce key（rag:del:{table_id}）
    而非与 save 信号共用 rag:table:{table_id}，避免同一 table 5s 内删除多个字段时
    后续删除被防抖静默忽略（导致索引永久包含已删除字段的 schema）。
    delete 路径与 save 路径 key 隔离，各自独立的 cooldown 窗口。
    """
    if not _is_rag_enabled() or not settings.RAG_AUTO_EMBED_TABLES:
        return
    table_id = str(instance.table_id)
    if not _should_index(f"del:table:{instance.table_id}"):
        return
    logger.info(
        "Field deleted, queuing table index: table_id=%s, field_id=%s",
        table_id, instance.id,
    )

    def _do_index():
        from apps.rag.tasks import index_table_task
        try:
            index_table_task.delay(table_id, force=False)
        except Exception as broker_exc:
            logger.warning(
                "[CC-012] index_table_task.delay 失败(field delete): table_id=%s, error=%s",
                table_id, broker_exc,
            )
            _create_fallback_embedding_task('table', table_id, broker_exc)

    transaction.on_commit(_do_index)


# ====================================================================
# Document (TabDoc) signals
# ====================================================================

@receiver(post_save, sender='tabdoc.Document')
def auto_index_document(sender, instance, created, **kwargs):
    if not _is_rag_enabled():
        return
    if not getattr(settings, "RAG_AUTO_EMBED_DOCUMENTS", True):
        return

    update_fields = kwargs.get('update_fields')
    watched = {'title', 'description_plaintext', 'description_markdown', 'description_json'}
    should_index = created or (not update_fields) or bool(watched.intersection(update_fields or []))
    if not should_index:
        return

    organization_id = str(getattr(instance, 'organization_id', '') or '')
    if organization_id:
        from apps.services.billing.services.service_guard import ServiceGuardService
        if not ServiceGuardService.check_auto_index_enabled(organization_id, "doc"):
            return
        block = ServiceGuardService.check_service_enabled(organization_id, "rag.embedding")
        if block:
            return

    document_id = str(instance.id)

    if not _should_index(f"document:{instance.id}"):
        # TD-003 修复：防抖拦截时设置 pending 标记并调度 trailing 补偿任务。
        # 路径 A 的 leading-edge 防抖（5s cooldown）在首次保存后 5s 内丢弃后续变更，
        # 而路径 B（merge_doc_updates）只处理 DocUpdate 队列，API 直接 Document.save()
        # 不产生 DocUpdate，导致防抖窗口内的变更永久丢失。
        # 解决：首次被拦截时设置 pending_key（只调度一次 trailing 任务，避免任务风暴）。
        pending_key = f"rag:doc_embed_pending:{document_id}"
        trigger_key = f"rag:doc_embed_pending_trigger:{document_id}"
        _cooldown = 5  # 与 _should_index 的 cooldown 保持一致
        try:
            cache.set(pending_key, "1", timeout=_cooldown + 2)
            already_scheduled = cache.add(trigger_key, "1", timeout=_cooldown)
            if already_scheduled:
                def _do_trailing_index():
                    from apps.rag.tasks import index_document_task
                    # 在 on_commit 内检查 pending 标记是否仍存在（若已被路径 A 覆盖则跳过）
                    if cache.get(pending_key):
                        cache.delete(pending_key)
                        index_document_task.apply_async(
                            args=[document_id],
                            kwargs={"force": False},
                            countdown=_cooldown,
                        )
                transaction.on_commit(_do_trailing_index)
        except Exception:
            logger.warning(
                "[DocSignal] failed to schedule trailing embed for document %s",
                document_id,
            )
        return

    # 清理可能存在的 pending 标记（本次已触发，trailing 任务不需要再跑）
    cache.delete(f"rag:doc_embed_pending:{document_id}")

    logger.info("Document changed, queuing embedding: document_id=%s", document_id)

    def _do_index():
        from apps.rag.tasks import index_document_task
        try:
            index_document_task.delay(document_id, force=False)
        except Exception as broker_exc:
            logger.warning(
                "[CC-012] index_document_task.delay 失败: document_id=%s, error=%s",
                document_id, broker_exc,
            )
            _create_fallback_embedding_task('document', document_id, broker_exc)

    transaction.on_commit(_do_index)


@receiver(post_delete, sender='tabdoc.Document')
def auto_delete_document_index(sender, instance, **kwargs):
    """SVC-17 补全：文档删除也使用 .delay() 异步执行，与 table/record 一致。"""
    if not _is_rag_enabled():
        return
    document_id = str(instance.id)
    logger.info("Document deleted, scheduling async embedding cleanup: document_id=%s", document_id)

    def _do_delete():
        from apps.rag.tasks import _async_delete_document_index
        _async_delete_document_index.delay(document_id)

    transaction.on_commit(_do_delete)
