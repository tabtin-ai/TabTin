"""C1 兜底字段回收站：定期清理过期软删除字段。

Celery beat 定时任务。清理逻辑：
1. 找到 ``is_deleted=True`` 且 ``updated_at < (now - TTL)`` 的 ``TableField``
2. 对每个字段：物理删除 native 列（DDL DROP COLUMN）+ 删除 ORM 记录
3. 清理 stale ``FieldReference`` 边
4. 每批 100 个，防止长事务
"""
from __future__ import annotations

import logging
from datetime import timedelta

from celery import shared_task
from django.conf import settings
from django.utils import timezone

from apps.tabdata.constants import TABDATA_DB_ALIAS

logger = logging.getLogger(__name__)


FIELD_RECYCLE_CLEANUP_BEAT_SCHEDULE = {
    'tabdata-field-recycle-cleanup': {
        'task': 'apps.tabdata.tasks.field_recycle_cleanup.cleanup_expired_deleted_fields',
        'schedule': 3600.0 * 6,  # 6 hours
        'options': {'queue': 'default'},
    },
}


@shared_task(
    bind=True,
    name='apps.tabdata.tasks.field_recycle_cleanup.cleanup_expired_deleted_fields',
    max_retries=1,
    default_retry_delay=300,
    acks_late=True,
    queue='default',
)
def cleanup_expired_deleted_fields(self, batch_size: int = 100):
    """清理超过保留期的软删除字段。

    流程：
    1. 查询所有 ``is_deleted=True`` 且超过 TTL 的字段
    2. 分批处理（``batch_size`` 默认 100）
    3. 每个字段：DDL DROP COLUMN → 删除 FieldReference → 删除 ORM
    """
    from django.db import transaction
    from apps.tabdata.models import FieldReference, Table, TableField
    from apps.tabdata.native.ddl_manager import DDLManager, resolve_schema_partition_id
    from apps.tabdata.native.pg_type_map import is_system_field

    ttl_days = getattr(settings, 'TABDATA_FIELD_RECYCLE_BIN_TTL_DAYS', 30)
    cutoff = timezone.now() - timedelta(days=ttl_days)

    expired_fields = list(
        TableField.objects.using(TABDATA_DB_ALIAS)
        .filter(is_deleted=True, updated_at__lt=cutoff)
        .select_related('table')
        .order_by('updated_at')[:batch_size]
    )

    if not expired_fields:
        logger.info('field_recycle_cleanup: no expired fields found (TTL=%dd)', ttl_days)
        return 0

    ddl = DDLManager(db_alias=TABDATA_DB_ALIAS)
    cleaned = 0
    errors = 0

    for field_obj in expired_fields:
        try:
            table = field_obj.table
            with transaction.atomic(using=TABDATA_DB_ALIAS):
                if not is_system_field(field_obj.field_type):
                    try:
                        partition_id = resolve_schema_partition_id(table)
                        if ddl.native_table_exists(partition_id, table.id):
                            ddl.drop_column(
                                partition_id, table.id, field_obj.id,
                            )
                    except Exception:
                        logger.warning(
                            'field_recycle_cleanup: DROP COLUMN failed for %s (table=%s)',
                            field_obj.id, table.id, exc_info=True,
                        )

                FieldReference.objects.using(TABDATA_DB_ALIAS).filter(
                    from_field_id=field_obj.id,
                ).delete()
                FieldReference.objects.using(TABDATA_DB_ALIAS).filter(
                    to_field_id=field_obj.id,
                ).delete()

                field_obj.delete(using=TABDATA_DB_ALIAS)

            cleaned += 1
            logger.info(
                'field_recycle_cleanup: purged field %s (%s) from table %s',
                field_obj.id, field_obj.name, table.id,
            )
        except Exception:
            errors += 1
            logger.exception(
                'field_recycle_cleanup: failed to purge field %s from table %s',
                field_obj.id, getattr(field_obj, 'table_id', '?'),
            )

    logger.info(
        'field_recycle_cleanup: done. cleaned=%d, errors=%d, batch=%d, ttl=%dd',
        cleaned, errors, len(expired_fields), ttl_days,
    )
    return cleaned
