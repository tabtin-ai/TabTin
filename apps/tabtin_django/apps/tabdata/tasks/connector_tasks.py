"""
数据连接器 Celery 异步任务

包含镜像表同步任务。

修复：
- DATA-27: 区分可重试/不可重试错误，认证失败、表不存在等永久性错误不再占用重试资源
"""
import logging

from celery import shared_task
from django.core.cache import caches
from django.utils import timezone

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.users.membership.services.quota_service import QuotaService
from apps.users.membership.exceptions import QuotaExceededError

logger = logging.getLogger(__name__)


def _is_retryable_connector_error(exc: Exception) -> bool:
    """DATA-27: 判断连接器异常是否为可重试的瞬时故障。

    可重试：网络中断、连接超时、服务端临时不可用等。
    不可重试：认证失败、表/Schema 不存在、权限不足、SQL 语法错误等。
    """
    try:
        import psycopg2
    except ImportError:
        return True

    _NON_RETRYABLE = (
        psycopg2.ProgrammingError,     # 表不存在、SQL 语法错误
        psycopg2.DataError,            # 数据格式错误
        psycopg2.IntegrityError,       # 约束违反
        psycopg2.NotSupportedError,    # 不支持的操作
    )
    if isinstance(exc, _NON_RETRYABLE):
        return False

    if isinstance(exc, psycopg2.OperationalError):
        msg = str(exc).lower()
        _PERMANENT_KEYWORDS = (
            'password authentication failed',
            'no pg_hba.conf entry',
            'authentication failed',
            'role "', 'does not exist',
        )
        if any(kw in msg for kw in _PERMANENT_KEYWORDS):
            return False
        return True

    if isinstance(exc, (ConnectionError, TimeoutError, OSError)):
        return True

    try:
        from django.db.utils import OperationalError as DjOperationalError
        if isinstance(exc, DjOperationalError):
            msg = str(exc).lower()
            _PERMANENT_KW = (
                'password authentication failed',
                'no pg_hba.conf entry',
                'authentication failed',
                'role "', 'does not exist',
            )
            if any(kw in msg for kw in _PERMANENT_KW):
                return False
            return True
    except ImportError:
        pass

    if isinstance(exc, (ValueError, TypeError, KeyError)):
        return False

    return True

CONNECTOR_SYNC_LOCK_TTL = 600  # 分布式锁超时（秒），略大于 soft_time_limit

# ── Celery Beat 定时调度 ──

CONNECTOR_BEAT_SCHEDULE = {
    "tabdata-sync-mirror-tables": {
        "task": "tabdata.sync_all_mirror_tables",
        "schedule": 60,  # 每分钟检查是否有 mirror 表需要同步
        "options": {"expires": 50},
    },
}


def _acquire_sync_lock(mapping_id: str) -> bool:
    """尝试获取 mapping 级别的 Redis 分布式锁。"""
    cache = caches['default']
    lock_key = f"connector_sync:{mapping_id}"
    return cache.add(lock_key, "1", timeout=CONNECTOR_SYNC_LOCK_TTL)


def _release_sync_lock(mapping_id: str) -> None:
    """释放 mapping 级别的 Redis 分布式锁。"""
    cache = caches['default']
    lock_key = f"connector_sync:{mapping_id}"
    cache.delete(lock_key)


def _write_created_records_to_native(table, records, table_fields) -> None:
    """connector bulk_create 不触发双写，这里显式补齐 native 行。"""
    if not records:
        return

    from apps.tabdata.native.backfill_service import BackfillService
    from apps.tabdata.native.ddl_manager import DDLManager, resolve_schema_partition_id
    from apps.tabdata.native.record_io import NativeRecordIO

    partition_id = resolve_schema_partition_id(table)
    ddl = DDLManager()
    ddl.ensure_columns_synced(partition_id, table.id, table_fields)

    rows = [
        BackfillService._build_native_row(record, table_fields)
        for record in records
    ]
    if rows:
        NativeRecordIO(partition_id, table.id).bulk_insert_records(rows)


def _delete_all_records_from_native(table) -> int:
    """Clear the native source of truth before a connector full replacement."""
    from apps.tabdata.native.ddl_manager import resolve_schema_partition_id
    from apps.tabdata.native.record_io import NativeRecordIO

    partition_id = resolve_schema_partition_id(table)
    return NativeRecordIO(partition_id, table.id).delete_all_records()


def _persist_mapping_status(mapping, *, update_sync_at: bool = False):
    """持久化 mapping 的同步状态，确保失败状态不丢失。"""
    fields = ['last_sync_status', 'last_sync_error', 'last_sync_row_count', 'updated_at']
    if update_sync_at:
        mapping.last_sync_at = timezone.now()
        fields.append('last_sync_at')
    mapping.save(using=TABDATA_DB_ALIAS, update_fields=fields)


@shared_task(
    bind=True,
    name='tabdata.sync_connector_table',
    max_retries=2,
    default_retry_delay=60,
    acks_late=True,
    time_limit=300,
    soft_time_limit=280,
    queue='heavy',
)
def sync_connector_table(self, mapping_id: str, **kwargs):
    """
    同步单个连接器表映射的数据。

    由手动触发或定时调度调用。
    DATA-9: 使用 Redis 分布式锁防止同一 mapping 并发同步。
    DATA-8: 失败时持久化错误状态，且不推进 last_sync_at。

    C3 / Wave 1.3：从 ``kwargs[FROZEN_TOKEN_KEY]`` 取任务发布时 freeze 的
    ``schema_version_token``，校验失败 no-op + 释放锁。
    """
    from apps.tabdata.models_connector import ConnectorTableMapping
    from apps.tabdata.services.schema_version_token import (
        FROZEN_TOKEN_KEY, assert_table_token_or_skip,
    )

    if not _acquire_sync_lock(mapping_id):
        logger.info("Connector sync already running for mapping %s, skip", mapping_id)
        return {'status': 'skipped', 'reason': 'lock_held'}

    try:
        try:
            mapping = ConnectorTableMapping.objects.using(TABDATA_DB_ALIAS).get(id=mapping_id)
        except ConnectorTableMapping.DoesNotExist:
            logger.warning("ConnectorTableMapping %s not found, skip sync", mapping_id)
            return

        # C3：mapping 找到了，校验对应 table 的 token；token 漂移 → no-op
        expected_token = kwargs.get(FROZEN_TOKEN_KEY)
        if not assert_table_token_or_skip(
            str(mapping.table_id), expected_token, task_name="sync_connector_table",
        ):
            return {
                'status': 'skipped',
                'reason': 'table_token_mismatch',
                'mapping_id': mapping_id,
            }

        connector = mapping.connector
        if connector.status == 'disabled':
            logger.info("Connector %s is disabled, skip sync", connector.id)
            return

        from apps.tabdata.services.connector_service import ConnectorService
        svc = ConnectorService(user=connector.created_by)

        try:
            instance = svc._get_connector_instance(connector)
            try:
                _do_mirror_sync(instance, mapping)
                mapping.last_sync_status = 'success'
                mapping.last_sync_error = ''
                _persist_mapping_status(mapping, update_sync_at=True)
                _refresh_row_count_after_sync(str(mapping.table_id))
                _trigger_rag_index_after_sync(str(mapping.table_id))
            finally:
                instance.close()
        except QuotaExceededError as e:
            skipped = getattr(e, 'skipped_count', 0)
            logger.warning(
                "Connector sync quota exceeded for mapping %s: %s (skipped %d rows)",
                mapping_id, e, skipped,
            )
            mapping.last_sync_status = 'quota_exceeded'
            mapping.last_sync_error = (
                f"配额超限，跳过 {skipped} 条记录: {str(e)[:400]}"
                if skipped else str(e)[:500]
            )
            mapping.last_sync_row_count = 0
            _persist_mapping_status(mapping, update_sync_at=False)
        except Exception as e:
            logger.exception("Connector sync failed for mapping %s", mapping_id)
            mapping.last_sync_status = 'error'
            mapping.last_sync_error = str(e)[:500]
            _persist_mapping_status(mapping, update_sync_at=False)
            # DATA-27: 仅瞬时故障才重试；认证失败、表不存在等永久性错误直接终止
            retryable = _is_retryable_connector_error(e)
            if self.request.retries < self.max_retries and retryable:
                raise self.retry(exc=e)
            if not retryable:
                logger.warning(
                    "Connector sync 永久性错误，不重试: mapping=%s, error_type=%s",
                    mapping_id, type(e).__name__,
                )
    finally:
        _release_sync_lock(mapping_id)


def _do_mirror_sync(connector_instance, mapping):
    """执行全量或增量镜像同步。"""
    from apps.tabdata.models import TableRecord

    ext_schema = mapping.external_schema
    ext_table = mapping.external_table
    field_mapping = mapping.field_mapping  # {ext_col: tabdata_field_id}

    if mapping.mirror_strategy == 'incremental' and mapping.incremental_column:
        _incremental_sync(connector_instance, mapping, ext_schema, ext_table, field_mapping)
    else:
        _full_sync(connector_instance, mapping, ext_schema, ext_table, field_mapping)


def _full_sync(connector_instance, mapping, ext_schema, ext_table, field_mapping):
    """Full sync: 流式拉取外部数据并分批写入，避免 OOM。

    DATA-7: 不再将所有行累积到 all_rows 列表，改为每批拉取后
    立即映射 + 写入 DB，峰值内存仅为单批 500 行。
    """
    from django.db import transaction
    from apps.tabdata.models import Table, TableField, TableRecord
    from apps.tabdata.services.record_service import next_record_version
    from apps.tabdata.services.view_version_sync import mark_table_record_delete_version

    table = Table.objects.using(TABDATA_DB_ALIAS).get(id=mapping.table_id)
    created_by = mapping.connector.created_by

    table_fields = list(
        TableField.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=mapping.table_id, is_deleted=False,
        )
    )

    # 第一步：预检外部表总行数用于配额检查（轻量查询，不拉全量数据）
    _, ext_total = connector_instance.query(ext_schema, ext_table, limit=1, offset=0)
    if ext_total > 0:
        try:
            QuotaService().check_quota(
                quota_type="max_records_per_table",
                increment=ext_total,
                current_usage=0,
                organization_id=str(table.organization_id) if table.organization_id else None,
                actor=created_by,
            )
        except QuotaExceededError:
            raise
        except Exception as e:
            logger.warning("全量同步配额预检异常，按 D1 放行: %s", e)

    # 第二步：替换旧记录。先给本轮导入分配版本；删除水位在 finally 中以
    # 一个更晚的完成版本发布，避免客户端在新批次尚未落完时提前全量刷新。
    with transaction.atomic(using=TABDATA_DB_ALIAS):
        # 版本分配必须与清空、初始水位共用同一事务并持续持有 Table 锁；
        # 否则并发写可能拿到更高 token 后又被本轮清空。
        replacement_version = next_record_version(mapping.table_id)
        TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=mapping.table_id,
            is_deleted=False,
        ).update(is_deleted=True, version=replacement_version)
        _delete_all_records_from_native(table)
        # 与实际清空同事务发布第一道水位，worker 被强杀时客户端也不会
        # 永久保留旧行；finally 的完成水位会在流式导入结束后再次对账。
        mark_table_record_delete_version(
            table_id=mapping.table_id,
            version=replacement_version,
            db_alias=TABDATA_DB_ALIAS,
        )

    # 第三步：流式拉取 + 分批写入
    batch_size = 500
    offset = 0
    total_imported = 0

    try:
        while True:
            rows, total = connector_instance.query(
                ext_schema, ext_table,
                limit=batch_size, offset=offset,
            )
            if not rows:
                break

            mapped_rows = []
            for row in rows:
                mapped = {}
                for ext_col, value in row.items():
                    field_id = field_mapping.get(ext_col)
                    if field_id:
                        mapped[field_id] = value
                if mapped:
                    mapped_rows.append(mapped)

            if mapped_rows:
                records_to_create = [
                    TableRecord(
                        table_id=mapping.table_id,
                        data=fields,
                        created_by=created_by,
                        updated_by=created_by,
                        version=replacement_version,
                    )
                    for fields in mapped_rows
                ]
                TableRecord.objects.using(TABDATA_DB_ALIAS).bulk_create(
                    records_to_create, batch_size=batch_size,
                )
                _write_created_records_to_native(table, records_to_create, table_fields)
                total_imported += len(mapped_rows)

            offset += batch_size
            if offset >= total:
                break
    finally:
        # 全量同步是 authoritative replacement：即使旧表为空、外部读取失败，
        # 或只写入了部分批次，也必须强制客户端全量对账。完成版本晚于同步
        # 期间可能提交的并发写，且避免同版本分页让客户端漏掉后续批次。
        with transaction.atomic(using=TABDATA_DB_ALIAS):
            completion_version = next_record_version(mapping.table_id)
            mark_table_record_delete_version(
                table_id=mapping.table_id,
                version=completion_version,
                db_alias=TABDATA_DB_ALIAS,
            )

    mapping.last_sync_row_count = total_imported

    if total_imported > 0:
        _write_sync_version_history(
            mapping.table_id, total_imported, created_by, sync_type="full",
        )

    logger.info(
        "Full sync completed for mapping %s: %d rows (streamed)",
        mapping.id, total_imported,
    )


def _incremental_sync(connector_instance, mapping, ext_schema, ext_table, field_mapping):
    """Incremental sync: fetch only rows newer than the last watermark."""
    from apps.tabdata.models import TableField, TableRecord

    created_by = mapping.connector.created_by
    inc_col = mapping.incremental_column

    table_fields = list(
        TableField.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=mapping.table_id, is_deleted=False,
        )
    )

    # Build a filter for rows newer than the last sync watermark
    watermark_filter = None
    if mapping.last_sync_at and inc_col:
        watermark_filter = {
            'column': inc_col,
            'op': '>',
            'value': mapping.last_sync_at.isoformat(),
        }

    rows, total = connector_instance.query(
        ext_schema, ext_table,
        limit=1000, offset=0,
        filters=watermark_filter,
    )

    mapped_rows = []
    for row in rows:
        mapped = {}
        for ext_col, value in row.items():
            field_id = field_mapping.get(ext_col)
            if field_id:
                mapped[field_id] = value
        if mapped:
            mapped_rows.append(mapped)

    # QTA-02: 增量同步前检查记录数配额，超配额则跳过新增并记录警告
    if mapped_rows:
        from apps.tabdata.models import Table

        try:
            table = Table.objects.using(TABDATA_DB_ALIAS).filter(id=mapping.table_id).first()
            current_usage = TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=mapping.table_id, is_deleted=False,
            ).count()
            QuotaService().check_quota(
                quota_type="max_records_per_table",
                increment=len(mapped_rows),
                current_usage=current_usage,
                organization_id=str(table.organization_id) if table and table.organization_id else None,
                actor=created_by,
            )
        except QuotaExceededError as qe:
            logger.warning(
                "增量同步 mapping %s 配额不足，跳过 %d 条新增记录",
                mapping.id, len(mapped_rows),
            )
            qe.skipped_count = len(mapped_rows)
            raise
        except Exception as e:
            logger.warning("增量同步配额预检异常，按 D1 放行: %s", e)

    # Create new records for the incremental batch
    if mapped_rows:
        records_to_create = [
            TableRecord(
                table_id=mapping.table_id,
                data=fields,
                created_by=created_by,
                updated_by=created_by,
            )
            for fields in mapped_rows
        ]
        TableRecord.objects.using(TABDATA_DB_ALIAS).bulk_create(
            records_to_create, batch_size=500,
        )
        table = Table.objects.using(TABDATA_DB_ALIAS).get(id=mapping.table_id)
        _write_created_records_to_native(table, records_to_create, table_fields)

    # Advance watermark so next sync only fetches newer rows
    mapping.last_sync_at = timezone.now()
    mapping.last_sync_row_count = len(mapped_rows)

    if mapped_rows:
        _write_sync_version_history(
            mapping.table_id, len(mapped_rows), created_by, sync_type="incremental",
        )

    logger.info(
        "Incremental sync completed for mapping %s: %d rows",
        mapping.id, len(mapped_rows),
    )


@shared_task(
    name='tabdata.sync_all_mirror_tables',
    ignore_result=True,
    time_limit=300,
    soft_time_limit=280,
    queue='heavy',
)
def sync_all_mirror_tables():
    """
    定时任务：检查所有 mirror 模式的映射，到期则触发同步。

    应由 Celery Beat 每分钟调度一次。

    C3 / Wave 1.3：发布 ``sync_connector_table`` 时 freeze 当前
    ``Table.schema_version_token``。删表后的旧 mapping 在 worker 校验失败 no-op。
    """
    from apps.tabdata.models_connector import ConnectorTableMapping
    from apps.tabdata.services.schema_version_token import (
        FROZEN_TOKEN_KEY, get_table_schema_version_token,
    )

    now = timezone.now()
    mappings = ConnectorTableMapping.objects.using(TABDATA_DB_ALIAS).filter(
        sync_mode='mirror',
        connector__status='connected',
    ).select_related('connector')

    def _publish_with_token(mapping_id: str, table_id: str) -> None:
        token = get_table_schema_version_token(table_id)
        kwargs = {FROZEN_TOKEN_KEY: token} if token else {}
        sync_connector_table.apply_async(args=[mapping_id], kwargs=kwargs)

    for mapping in mappings:
        # Check if sync is due
        if mapping.last_sync_at is None:
            # Never synced — trigger now
            _publish_with_token(str(mapping.id), str(mapping.table_id))
            continue

        from datetime import timedelta
        next_sync_at = mapping.last_sync_at + timedelta(minutes=mapping.mirror_interval_minutes)
        if now >= next_sync_at:
            _publish_with_token(str(mapping.id), str(mapping.table_id))


def _write_sync_version_history(table_id, total_imported, editor_user, *, sync_type="full"):
    """同步完成后补写 VersionHistory + ChangeLog，使连接器同步可通过 Checkpoint 回滚。

    best-effort：失败不阻断同步流程。
    """
    try:
        from django.db import transaction
        from apps.collab.registry import get_adapter
        from apps.collab.service import VersionHistoryService
        from apps.collab.models import ChangeLog

        adapter = get_adapter("table")
        if not adapter:
            return

        resource = adapter.get_resource(str(table_id))
        if not resource:
            return

        version_data = adapter.get_version_data(resource)
        if version_data is None:
            return

        editor_info = {
            "editor_type": "system",
            "editor_id": str(editor_user.id) if editor_user else "",
            "editor_name": "",
        }
        organization_id = getattr(resource, "organization_id", None)

        svc = VersionHistoryService(adapter)
        with transaction.atomic(using="postgresql"):
            vh = svc.create_history(
                resource.id,
                version_data,
                editor_info,
                force_snapshot=True,
                skip_throttle=True,
                organization_id=organization_id,
            )
            # QC-05 遗留项说明：Celery 定时任务同步外部连接器数据，editor_type='system'，
            # 本就无对话上下文（agent_run_id=""、session_id=""）。显式赋空值以明确
            # 这不是 ContextVar 丢失，而是"无会话可关联"的正常场景，
            # 避免填充率监控误报为漏失。
            ChangeLog.objects.using("postgresql").create(
                resource_type="table",
                resource_id=resource.id,
                change_type="connector_sync",
                summary=f"连接器{sync_type}同步：{total_imported} 行",
                changes={
                    "sync_type": sync_type,
                    "row_count": total_imported,
                },
                editor_type="system",
                editor_id=str(editor_user.id) if editor_user else "",
                version_history=vh,
                agent_run_id="",
                session_id="",
            )
    except Exception as exc:
        logger.warning(
            "Connector sync VH/CL write failed (non-blocking): table=%s err=%s",
            table_id, exc,
        )


def _refresh_row_count_after_sync(table_id: str) -> None:
    """bulk_create/soft-delete 不触发 post_save，手动刷新 Table.row_count。"""
    try:
        from apps.tabdata.models import Table, TableRecord
        Table.objects.using(TABDATA_DB_ALIAS).filter(id=table_id).update(
            row_count=TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=table_id, is_deleted=False,
            ).count()
        )
    except Exception as exc:
        logger.warning("Connector sync row_count refresh failed: table=%s err=%s", table_id, exc)


def _trigger_rag_index_after_sync(table_id: str) -> None:
    """Mirror 同步使用 bulk_create，不触发 post_save 信号，
    需要显式调度 RAG 记录索引以保持搜索数据一致。
    """
    try:
        from django.conf import settings
        if not getattr(settings, "RAG_ENABLED", True):
            return
        if not getattr(settings, "RAG_AUTO_EMBED_RECORDS", True):
            return
        from apps.rag.tasks import index_table_records_task
        index_table_records_task.apply_async(
            args=[table_id],
            kwargs={"force": False},
            countdown=10,
        )
        logger.info("Scheduled RAG index after mirror sync: table_id=%s", table_id)
    except Exception as exc:
        logger.warning("Failed to schedule RAG index after sync: %s", exc)
