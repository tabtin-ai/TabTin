"""
数据导入/导出 Celery 异步任务

大文件场景下避免 HTTP 请求超时，通过 Celery 异步执行导入/导出，
完成后通过 WS 事件通知客户端。

修复：
- DATA-3: 支持从 OSS 中转读取大文件，避免 Celery 消息体撑爆 Redis
- DATA-4: 路由到 heavy 队列，不再与 default 轻量任务竞争 Worker
- DATA-16: 导入全程推送进度事件，消除用户黑盒感知
- DATA-17: 异步导入结果与同步路径统一：结构化错误分类 + error_summary 聚合
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional
from uuid import UUID

from celery import shared_task
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.tabdata.services.import_error_classifier import (
    classify_import_error, build_error_summary,
)

logger = logging.getLogger(__name__)

_RETRYABLE_EXCEPTIONS = (
    ConnectionError,
    TimeoutError,
    OSError,
)

try:
    from django.db.utils import OperationalError, InterfaceError
    _RETRYABLE_EXCEPTIONS = _RETRYABLE_EXCEPTIONS + (OperationalError, InterfaceError)
except ImportError:
    pass


def _is_retryable(exc: Exception) -> bool:
    """判断是否为可重试的瞬时故障（DB 断连、网络超时等）。"""
    return isinstance(exc, _RETRYABLE_EXCEPTIONS)


def _refresh_row_count_after_bulk(table_id: str) -> None:
    """bulk_create 不触发 post_save，手动刷新 Table.row_count。"""
    try:
        from apps.tabdata.models import Table, TableRecord
        from apps.tabdata.constants import TABDATA_DB_ALIAS
        Table.objects.using(TABDATA_DB_ALIAS).filter(id=table_id).update(
            row_count=TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=table_id, is_deleted=False,
            ).count()
        )
    except Exception as exc:
        logger.warning("Import row_count refresh failed: table=%s err=%s", table_id, exc)


def _trigger_rag_index_after_bulk_write(table_id: str) -> None:
    """bulk_create/bulk_update 不触发 Django post_save 信号，
    需要显式调度 RAG 记录索引任务以保持搜索数据一致。
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
        logger.info("Scheduled RAG index after bulk write: table_id=%s", table_id)
    except Exception as exc:
        logger.warning("Failed to schedule RAG index after bulk write: %s", exc)


def _notify_import_export_result(
    *,
    user_id: str,
    table_id: str,
    action: str,
    result: Dict[str, Any],
) -> None:
    """通过 WS 可靠投递通知客户端导入/导出完成。"""
    try:
        from apps.services.common.ws.bus import publish_ws_event_reliable
        from apps.services.common.ws.protocol import build_envelope, new_event_id

        event_id = new_event_id()
        envelope = build_envelope(
            "table.events.delta",
            event_id,
            {
                "table_id": table_id,
                "record_ids": [],
                "action": action,
                "metadata": {
                    "user_id": user_id,
                    **result,
                },
            },
            event_id=event_id,
            table_id=table_id,
        )
        publish_ws_event_reliable(f"table.events.{table_id}", envelope)
    except Exception as exc:
        logger.error("[import_export] reliable WS notify failed for %s: %s", action, exc, exc_info=True)


def _notify_import_progress(
    *,
    user_id: str,
    table_id: str,
    phase: str,
    percentage: int,
) -> None:
    """DATA-16: 推送导入进度事件，让前端实时展示进度条。"""
    try:
        from apps.tabdata.services.table_event_service import table_event_service
        table_event_service.publish_table_update(
            table_id=table_id,
            record_ids=[],
            action="import_progress",
            metadata={
                "user_id": user_id,
                "phase": phase,
                "percentage": percentage,
            },
        )
    except Exception as exc:
        logger.debug("import_progress WS notify failed: %s", exc)


def _download_from_oss(object_key: str, cleanup: bool = True) -> bytes:
    """DATA-3: 从 OSS 中转桶下载文件内容。

    ``cleanup=False`` 用于  W3 的 ``/import/oss-file``：那条路径读的是有
    ``FileRecord`` 托管的用户上传文件（带 FileUsage 引用计数与组织存储计量），
    删掉物理对象会留下指向空对象的记录、计量也对不上；只有 ``import_transit/``
    这种一次性裸中转键才该读完即删。
    """
    from apps.services.oss.services.factory import get_oss_service
    oss = get_oss_service()
    data = oss.download_bytes(object_key)
    if cleanup:
        try:
            oss.delete_object(object_key)
        except Exception as exc:
            logger.warning("清理 OSS 中转文件失败: key=%s err=%s", object_key, exc)
    return data


def _resolve_file_content(
    file_type: str,
    file_content: Optional[str],
    oss_object_key: Optional[str],
    oss_cleanup: bool = True,
):
    """根据传参方式还原文件内容，返回 (text_content, file_bytes)。

    - oss_object_key 优先：从 OSS 下载原始字节
    - file_content 回退：csv/json 为明文字符串，excel 为 base64
    """
    if oss_object_key:
        raw = _download_from_oss(oss_object_key, cleanup=oss_cleanup)
        if file_type == 'excel':
            return None, raw
        try:
            return raw.decode('utf-8-sig'), None
        except UnicodeDecodeError:
            return raw.decode('gbk'), None

    if file_type == 'excel':
        import base64
        return None, base64.b64decode(file_content)
    return file_content, None


@shared_task(
    bind=True,
    name="tabdata.async_import_data",
    queue="heavy",
    soft_time_limit=25 * 60,
    time_limit=30 * 60,
    max_retries=1,
    default_retry_delay=60,
)
def async_import_data(
    self,
    *,
    table_id: str,
    file_type: str,
    file_content: Optional[str] = None,
    oss_object_key: Optional[str] = None,
    oss_cleanup: bool = True,
    user_id: str,
    skip_errors: bool = False,
    update_existing: bool = False,
    primary_key_field: Optional[str] = None,
    auto_create_missing_fields: bool = True,
    sheet_name: Optional[str] = None,
    is_token_auth: bool = False,
    api_key_organization_id: str = '',
) -> Dict[str, Any]:
    """
    异步执行数据导入。

    DATA-3: 支持 oss_object_key（大文件从 OSS 读取，避免 Redis 消息体过大）。
     W3: oss_cleanup=False 时不删除源对象（用于有 FileRecord 托管的用户上传文件）。
    DATA-4: 路由到 heavy 队列。
    DATA-16: 过程中推送进度事件。
    api_key_organization_id: ATK-2 — API Key organization 约束，由 prerun 信号恢复到 ContextVar。
    """
    # C4 / Wave 4: validate schema_version_token before executing
    from apps.tabdata.services.schema_version_token import (
        FROZEN_TOKEN_KEY, assert_table_token_or_skip,
    )
    expected_token = self.request.kwargs.get(FROZEN_TOKEN_KEY) if self.request.kwargs else None
    if not assert_table_token_or_skip(table_id, expected_token, task_name="async_import_data"):
        return {"status": "skipped", "reason": "table_token_mismatch"}

    User = get_user_model()
    user = None
    if user_id:
        try:
            user = User.objects.get(id=user_id)
        except User.DoesNotExist:
            return {"status": "error", "message": "用户不存在"}

    if not file_content and not oss_object_key:
        return {"status": "error", "message": "缺少文件内容：file_content 和 oss_object_key 均为空"}

    _notify_import_progress(
        user_id=user_id, table_id=table_id, phase="preparing", percentage=5,
    )

    text_content, file_bytes = _resolve_file_content(
        file_type, file_content, oss_object_key, oss_cleanup=oss_cleanup,
    )

    _notify_import_progress(
        user_id=user_id, table_id=table_id, phase="importing", percentage=20,
    )

    from apps.tabdata.services.import_service import ImportService
    from apps.tabdata.services.rls_service import RLSContext
    service = ImportService(user=user)
    rls_ctx = RLSContext(
        user_id=user_id,
        is_token_auth=is_token_auth,
    )

    def _on_write_progress(processed: int, total: int) -> None:
        pct = 20 + int(processed / max(total, 1) * 70)
        _notify_import_progress(
            user_id=user_id, table_id=table_id,
            phase="writing", percentage=min(pct, 90),
        )

    try:
        if file_type == 'csv':
            created, updated, errors = service.import_from_csv(
                UUID(table_id), text_content,
                skip_errors=skip_errors,
                update_existing=update_existing,
                primary_key_field=primary_key_field,
                auto_create_missing_fields=auto_create_missing_fields,
                rls_context=rls_ctx,
                progress_callback=_on_write_progress,
            )
        elif file_type == 'excel':
            created, updated, errors = service.import_from_excel(
                UUID(table_id), file_bytes,
                skip_errors=skip_errors,
                update_existing=update_existing,
                primary_key_field=primary_key_field,
                sheet_name=sheet_name,
                auto_create_missing_fields=auto_create_missing_fields,
                rls_context=rls_ctx,
                progress_callback=_on_write_progress,
            )
        elif file_type == 'json':
            created, updated, errors = service.import_from_json(
                UUID(table_id), text_content,
                skip_errors=skip_errors,
                update_existing=update_existing,
                primary_key_field=primary_key_field,
                auto_create_missing_fields=auto_create_missing_fields,
                rls_context=rls_ctx,
                progress_callback=_on_write_progress,
            )
        else:
            return {"status": "error", "message": f"不支持的文件类型: {file_type}"}

        _notify_import_progress(
            user_id=user_id, table_id=table_id, phase="finishing", percentage=90,
        )

        classified = [classify_import_error(e) for e in errors]
        error_summary = build_error_summary(classified)
        _MAX_DETAIL_ERRORS = 50

        result = {
            "status": "success",
            "created_count": created,
            "updated_count": updated,
            "error_summary": error_summary,
            "total_error_count": len(errors),
            "errors": [e.to_dict() for e in classified[:_MAX_DETAIL_ERRORS]],
            "truncated": len(errors) > _MAX_DETAIL_ERRORS,
            "completed_at": timezone.now().isoformat(),
        }
    except Exception as exc:
        logger.exception("async_import_data failed: table=%s", table_id)
        if self.request.retries < self.max_retries and _is_retryable(exc):
            raise self.retry(exc=exc)
        result = {
            "status": "error",
            "message": str(exc),
            "completed_at": timezone.now().isoformat(),
        }

    _notify_import_export_result(
        user_id=user_id,
        table_id=table_id,
        action="import_completed",
        result=result,
    )

    return result


@shared_task(
    bind=True,
    name="tabdata.async_export_data",
    queue="heavy",
    soft_time_limit=25 * 60,
    time_limit=30 * 60,
    max_retries=1,
    default_retry_delay=60,
)
def async_export_data(
    self,
    *,
    table_id: str,
    export_format: str,
    user_id: str,
    field_ids: Optional[List[str]] = None,
    record_ids: Optional[List[str]] = None,
    view_id: Optional[str] = None,
    view_query: Optional[Dict[str, Any]] = None,
    include_headers: bool = True,
    sheet_name: str = "Sheet1",
    format_type: str = "array",
    orientation: str = "landscape",
    title: Optional[str] = None,
    is_token_auth: bool = False,
    api_key_organization_id: str = '',
) -> Dict[str, Any]:
    """
    异步执行数据导出，结果存入 OSS 并通过 WS 通知客户端下载链接。

    Args:
        table_id: 表格 ID
        export_format: 导出格式 (csv / excel / json / pdf)
        user_id: 操作用户 ID
        field_ids: 导出字段 ID 列表
        record_ids: 导出记录 ID 列表
        view_id: 视图 ID
        is_token_auth: 是否为 API Token 认证
        api_key_organization_id: ATK-2 — API Key organization 约束，由 prerun 信号恢复到 ContextVar
    """
    User = get_user_model()
    user = None
    if user_id:
        try:
            user = User.objects.get(id=user_id)
        except User.DoesNotExist:
            return {"status": "error", "message": "用户不存在"}

    from apps.tabdata.services.export_service import ExportService
    from apps.tabdata.services.rls_service import RLSContext
    service = ExportService(user=user)
    rls_ctx = RLSContext(
        user_id=user_id,
        is_token_auth=is_token_auth,
    )

    parsed_field_ids = [UUID(fid) for fid in field_ids] if field_ids else None
    parsed_record_ids = [UUID(rid) for rid in record_ids] if record_ids else None
    parsed_view_id = UUID(view_id) if view_id else None

    try:
        _tid = UUID(table_id)
        if export_format == 'csv':
            content = service.export_to_csv(
                _tid, parsed_field_ids, parsed_record_ids, parsed_view_id,
                include_headers=include_headers,
                rls_context=rls_ctx,
                view_query=view_query,
            )
            file_name = f"export_{table_id[:8]}.csv"
            mime_type = "text/csv"
        elif export_format == 'excel':
            content = service.export_to_excel(
                _tid, parsed_field_ids, parsed_record_ids, parsed_view_id,
                include_headers=include_headers, sheet_name=sheet_name,
                rls_context=rls_ctx,
                view_query=view_query,
            )
            file_name = f"export_{table_id[:8]}.xlsx"
            mime_type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        elif export_format == 'json':
            content = service.export_to_json(
                _tid, parsed_field_ids, parsed_record_ids, parsed_view_id,
                format_type=format_type,
                rls_context=rls_ctx,
                view_query=view_query,
            )
            file_name = f"export_{table_id[:8]}.json"
            mime_type = "application/json"
        elif export_format == 'pdf':
            content = service.export_to_pdf(
                _tid, parsed_field_ids, parsed_record_ids, parsed_view_id,
                orientation=orientation, title=title,
                rls_context=rls_ctx,
                view_query=view_query,
            )
            file_name = f"export_{table_id[:8]}.pdf"
            mime_type = "application/pdf"
        else:
            return {"status": "error", "message": f"不支持的导出格式: {export_format}"}

        file_id = _upload_export_to_oss(
            content, file_name, mime_type,
            user_id=user_id, table_id=table_id,
        )

        if file_id is None:
            result = {
                "status": "error",
                "message": "导出文件上传 OSS 失败，请稍后重试",
                "completed_at": timezone.now().isoformat(),
            }
        else:
            result = {
                "status": "success",
                "file_id": file_id,
                "file_name": file_name,
                "completed_at": timezone.now().isoformat(),
            }
    except Exception as exc:
        logger.exception("async_export_data failed: table=%s", table_id)
        if self.request.retries < self.max_retries and _is_retryable(exc):
            raise self.retry(exc=exc)
        result = {
            "status": "error",
            "message": str(exc),
            "completed_at": timezone.now().isoformat(),
        }

    _notify_import_export_result(
        user_id=user_id,
        table_id=table_id,
        action="export_completed",
        result=result,
    )
    return result


def _upload_export_to_oss(
    content: Any,
    file_name: str,
    mime_type: str,
    user_id: str = "",
    table_id: str = "",
) -> Optional[str]:
    """将导出内容上传到 OSS 并返回 FileRecord ID。

    上传成功后通过 FileRegistryService 注册 FileRecord + FileUsage，
    防止孤儿清理器误删导出文件。

    P0-7 安全修复: 不再返回公开 URL，返回 file_id 供认证下载端点使用。
    DATA-20: OSS 不可用时返回 None（而非空字符串），调用方据此判断上传是否成功。
    """
    try:
        from apps.services.oss.services.factory import get_oss_service
        oss = get_oss_service()
        import uuid as _uuid
        file_bytes = content if isinstance(content, bytes) else content.encode('utf-8')
        timestamp = timezone.now().strftime('%Y%m%d%H%M%S')
        unique_suffix = _uuid.uuid4().hex[:8]
        object_key = f"export/{timestamp}_{unique_suffix}_{file_name}"
        oss.upload_bytes(file_bytes, object_key, content_type=mime_type)

        organization_id = ""
        if table_id:
            from apps.tabdata.models import Table
            from apps.tabdata.constants import TABDATA_DB_ALIAS
            table = Table.objects.using(TABDATA_DB_ALIAS).filter(id=table_id).first()
            if table and table.organization_id:
                organization_id = str(table.organization_id)

        from apps.services.oss.services.file_registry import FileRegistryService
        file_record = FileRegistryService.register_uploaded_file(
            object_key=object_key,
            file_name=file_name,
            file_size=len(file_bytes),
            content_type=mime_type,
            module='tabdata',
            user_id=user_id,
            organization_id=organization_id,
            context_type='export',
            context_id=table_id,
            upload_source='tabdata_export',
            is_public=False,
        )
        return str(file_record.id)
    except Exception as exc:
        logger.error("OSS upload failed, export file not persisted: %s", exc)
        return None
