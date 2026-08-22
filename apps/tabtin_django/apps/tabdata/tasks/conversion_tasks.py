"""
字段类型转换异步任务

DATA-1 修复：max_retries=0 禁止重试，避免部分失败后重试导致数据不一致。
转换操作本身在 service 层已包裹 transaction.atomic，失败时自动回滚。

C3 / Wave 1.3：接入 Table.schema_version_token 校验。caller 通过 ``kwargs[FROZEN_TOKEN_KEY]``
携带任务发布时的 token，worker 入口校验失败 no-op。
"""
from __future__ import annotations

import logging

from celery import shared_task
from uuid import UUID
from typing import Optional, Dict, Any
from django.contrib.auth import get_user_model

from apps.tabdata.services.table_service import TableService

logger = logging.getLogger(__name__)


@shared_task(
    bind=True,
    name="tabdata.convert_field_type",
    soft_time_limit=25 * 60,
    time_limit=30 * 60,
    max_retries=0,
)
def convert_field_type_task(
    self,
    field_id: str,
    target_type: str,
    target_options: Optional[Dict[str, Any]] = None,
    force: bool = False,
    user_id: Optional[str] = None,
    api_key_organization_id: str = '',
    **kwargs,
) -> Dict[str, Any]:
    """
    异步执行字段类型转换。

    max_retries=0：类型转换非幂等操作，部分写入后重试会导致数据格式不一致，
    因此禁止 Celery 自动重试，由调用方决定是否重新发起。

    C3 / Wave 1.3：从 ``kwargs[FROZEN_TOKEN_KEY]`` 取任务发布时 freeze 的
    ``schema_version_token``，校验失败 no-op（避免删表后持续报错）。
    """
    from apps.tabdata.services.schema_version_token import (
        FROZEN_TOKEN_KEY, assert_table_token_or_skip,
    )

    # C3：先 resolve table_id（field 可能已被删，此时也应 no-op）
    table_id = _resolve_table_id_from_field(field_id)
    expected_token = kwargs.get(FROZEN_TOKEN_KEY)
    if table_id and not assert_table_token_or_skip(
        table_id, expected_token, task_name="convert_field_type",
    ):
        return {
            'status': 'skipped',
            'reason': 'table_token_mismatch',
            'field_id': field_id,
        }

    User = get_user_model()
    user = None
    if user_id:
        try:
            user = User.objects.get(id=user_id)
        except User.DoesNotExist:
            user = None

    try:
        service = TableService(user=user)
        result = service.convert_field_type(
            UUID(field_id),
            target_type,
            target_options,
            force
        )

        if result and result.get('success') and result.get('converted_count', 0) > 0:
            table_id_from_result = result.get('table_id') or table_id
            if table_id_from_result:
                _trigger_rag_index_after_conversion(str(table_id_from_result))

        return result
    except Exception as exc:
        logger.exception(
            "convert_field_type_task failed: field=%s target=%s",
            field_id, target_type,
        )
        return {
            'success': False,
            'error': str(exc),
            'field_id': field_id,
        }


def _resolve_table_id_from_field(field_id: str) -> Optional[str]:
    try:
        from apps.tabdata.models import TableField
        from apps.tabdata.constants import TABDATA_DB_ALIAS
        field = TableField.objects.using(TABDATA_DB_ALIAS).filter(
            id=field_id, is_deleted=False,
        ).only("table_id").first()
        return str(field.table_id) if field else None
    except Exception:
        return None


def _trigger_rag_index_after_conversion(table_id: str) -> None:
    """字段类型转换使用 bulk_update，不触发 post_save 信号，
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
            countdown=5,
        )
        logger.info("Scheduled RAG index after field conversion: table_id=%s", table_id)
    except Exception as exc:
        logger.warning("Failed to schedule RAG index after conversion: %s", exc)
