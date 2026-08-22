"""
RAG API 接口

使用 Django Ninja 提供 RESTful API
"""

import logging
import threading
from typing import Annotated, List
from ninja import Router, Query
from django.http import HttpRequest
from django.conf import settings

from .schemas import (
    IndexTableRequest,
    IndexTableRecordsRequest,
    IndexBatchRequest,
    IndexDocumentRequest,
    DeleteIndexRequest,
    IndexResponse,
    BatchIndexResponse,
    SearchRequest,
    SearchTableRequest,
    SearchRecordRequest,
    SearchResponse,
    IndexStatsResponse,
    IndexListResponse,
    ErrorResponse,
    SuccessResponse,
    TableResult,
    RecordResult,
    CodeIndexRequest,
    CodeIndexDeleteRequest,
    CodeSyncRequest,
    CodeSyncResponse,
)
from .services import (
    IndexService,
    SearchService,
    ContextService,
)
from apps.services.common.executor import run_in_agent_io_executor
from apps.users.auth.permissions import JWTAuth
from apps.i18n import _

logger = logging.getLogger(__name__)

_search_service = None
_context_service = None
_search_lock = threading.Lock()
_context_lock = threading.Lock()

MAX_BATCH_TABLE_IDS = 100


def _get_search_service():
    global _search_service
    if _search_service is not None:
        return _search_service
    with _search_lock:
        if _search_service is not None:
            return _search_service
        _search_service = SearchService()
        return _search_service


def _get_context_service():
    global _context_service
    if _context_service is not None:
        return _context_service
    with _context_lock:
        if _context_service is not None:
            return _context_service
        _context_service = ContextService()
        return _context_service


from apps.services.billing.decorators import billing_required

router = Router(tags=["RAG"])
# 兼容性别名
AuthBearer = JWTAuth


def _resolve_rag_table_organization(request, kwargs) -> str:
    """从 payload 的 table_id 推导 organization_id（供 @billing_required）。"""
    for arg in list(kwargs.values()):
        table_id = getattr(arg, "table_id", None)
        if table_id:
            return _get_table_organization_id(table_id) or ""
        table_ids = getattr(arg, "table_ids", None)
        if table_ids:
            return _get_table_organization_id(table_ids[0]) or ""
    return ""


def _resolve_rag_document_organization(request, kwargs) -> str:
    """从 payload 的 document_id 推导 organization_id。"""
    for arg in list(kwargs.values()):
        doc_id = getattr(arg, "document_id", None)
        if doc_id:
            return _get_document_organization_id(doc_id) or ""
    return ""


def _safe_error_message(exc: Exception) -> str:
    """生产环境脱敏错误信息，避免泄漏内部细节。"""
    try:
        from apps.services.llm.services.billed_call import InsufficientBalanceError
        if isinstance(exc, InsufficientBalanceError):
            return str(exc)
    except ImportError:
        pass
    if isinstance(exc, ValueError):
        msg = str(exc)
        sensitive_keywords = ('password', 'secret', 'token', 'key', 'credential', 'dsn', 'connection', 'url', 'host', 'port', 'database', 'schema', 'path', 'traceback')
        if any(kw in msg.lower() for kw in sensitive_keywords):
            return "参数校验失败"
        return msg
    if getattr(settings, 'DEBUG', False):
        return str(exc)
    return "内部服务错误，请稍后重试"


def _is_insufficient_balance(exc: Exception) -> bool:
    """判断异常是否为余额不足（延迟导入避免循环依赖）。"""
    try:
        from apps.services.llm.services.billed_call import InsufficientBalanceError
        return isinstance(exc, InsufficientBalanceError)
    except ImportError:
        return False


def _check_rag_enabled():
    """检查 RAG 是否启用，未启用时返回 (503, ErrorResponse)，否则返回 None。"""
    if not getattr(settings, "RAG_ENABLED", True):
        return 503, ErrorResponse(
            error="service_disabled",
            message="RAG service is currently disabled",
        )
    return None


def _code_semantic_search_retired():
    """Stable compatibility response for retired TabCode vector APIs."""
    return 410, ErrorResponse(
        error="code_semantic_search_retired",
        message="TabCode semantic search has been retired; use grep or glob search instead",
    )


def _check_rag_service_guard(organization_id: str | None):
    """检查 RAG embedding 服务是否被组织管理员禁用，被禁用时抛出 ServiceDisabledError"""
    if not organization_id:
        return None
    from apps.services.billing.services.service_guard import ServiceGuardService
    ServiceGuardService.check_service_enabled(organization_id, "rag.embedding", raise_on_disabled=True)
    return None


def _get_table_organization_id(table_id: str) -> str | None:
    try:
        from apps.tabdata.models import Table
        t = Table.objects.filter(id=table_id).only("organization_id").first()
        return str(t.organization_id) if t else None
    except Exception:
        return None


def _get_document_organization_id(document_id: str) -> str | None:
    try:
        from apps.tabdoc.models import Document
        d = Document.objects.filter(id=document_id).only("organization_id").first()
        return str(d.organization_id) if d else None
    except Exception:
        return None


def _require_staff(request):
    """SEC-06: 监控端点需要 is_staff 权限，否则返回 (403, ErrorResponse)。"""
    if not request.auth or not getattr(request.auth, "is_staff", False):
        return 403, ErrorResponse(error="forbidden", message=_("rag.monitor_staff_only"))
    return None


def _get_accessible_organization_ids(user_id: str):
    """获取用户可访问的 organization ID 列表（60 秒缓存）。

    SC-006 修复：直接复用 unified_search_service._get_user_accessible_organizations 的
    缓存逻辑（key: rag:accessible_organizations:{user_id}），消除双缓存 key 不一致问题。
    """
    from apps.rag.services.unified_search_service import _get_user_accessible_organizations
    return _get_user_accessible_organizations(user_id)


def _check_table_access(user_id: str, table_id: str):
    """校验用户对 table 的访问权限。无权限时返回 (403, ErrorResponse)。"""
    try:
        from apps.tabdata.models import Table
        table = Table.objects.filter(id=table_id).only("organization_id").first()
        if not table:
            return 400, ErrorResponse(error="not_found", message=_("rag.table_not_found", table_id=table_id))

        accessible = _get_accessible_organization_ids(user_id)
        if str(table.organization_id) not in accessible:
            return 403, ErrorResponse(error="forbidden", message=_("rag.no_table_permission"))
    except Exception as e:
        logger.warning("Table access check failed: %s", e)
        return 400, ErrorResponse(error="access_check_failed", message=_safe_error_message(e))
    return None


def _check_document_access(user_id: str, document_id: str):
    """校验用户对 document 的访问权限。"""
    try:
        from apps.tabdoc.models import Document
        doc = Document.objects.filter(id=document_id).only("organization_id").first()
        if not doc:
            return 400, ErrorResponse(error="not_found", message=_("rag.document_not_found", document_id=document_id))

        accessible = _get_accessible_organization_ids(user_id)
        if str(doc.organization_id) not in accessible:
            return 403, ErrorResponse(error="forbidden", message=_("rag.no_document_permission"))
    except Exception as e:
        logger.warning("Document access check failed: %s", e)
        return 400, ErrorResponse(error="access_check_failed", message=_safe_error_message(e))
    return None


def _check_task_access(user_id: str, celery_task_id: str):
    """校验用户对 EmbeddingTask 的访问权限（通过 target 的 organization 归属判断）。"""
    from apps.rag.models import EmbeddingTask
    task_record = EmbeddingTask.objects.filter(celery_task_id=celery_task_id).first()
    if not task_record:
        return 403, ErrorResponse(error="forbidden", message=_("rag.no_task_permission"))
    target_id = str(task_record.target_id)
    if task_record.task_type in ("table", "batch"):
        return _check_table_access(user_id, target_id)
    elif task_record.task_type == "record":
        from apps.tabdata.models import TableRecord
        rec = TableRecord.objects.filter(id=target_id).only("table_id").first()
        if not rec:
            return 403, ErrorResponse(error="forbidden", message=_("rag.no_task_permission"))
        return _check_table_access(user_id, str(rec.table_id))
    elif task_record.task_type == "document":
        return _check_document_access(user_id, target_id)
    elif task_record.task_type == "code":
        # SEC-04: organization_id 为 None 时无法做归属校验，直接拒绝
        if not task_record.organization_id:
            return 403, ErrorResponse(error="forbidden", message=_("rag.no_code_index_permission"))
        accessible = _get_accessible_organization_ids(user_id)
        if str(task_record.organization_id) not in accessible:
            return 403, ErrorResponse(error="forbidden", message=_("rag.no_code_index_permission"))
        return None
    # FND-15: 未知 task_type 默认拒绝，防止新类型出现时隐式授权
    logger.warning("Unknown task_type=%r for task %s, denying access", task_record.task_type, celery_task_id)
    return 403, ErrorResponse(error="forbidden", message=_("rag.no_task_permission"))


# ===== 索引管理 API =====

@router.post("/index/table/async", response={200: SuccessResponse, 400: ErrorResponse, 403: ErrorResponse, 503: ErrorResponse}, auth=AuthBearer())
@billing_required(service_key="rag.embedding", organization_id_resolver=_resolve_rag_table_organization)
def create_table_index_async(request: HttpRequest, payload: IndexTableRequest):
    """异步为单个表格创建向量索引"""
    disabled = _check_rag_enabled()
    if disabled:
        return disabled
    user_id = str(request.auth.id)
    denied = _check_table_access(user_id, payload.table_id)
    if denied:
        return denied
    try:
        from apps.rag.tasks import index_table_task

        task = index_table_task.delay(payload.table_id, payload.force)

        return 200, SuccessResponse(
            message=_("rag.index_task_submitted"),
            data={
                "task_id": task.id,
                "table_id": payload.table_id,
                "status": "pending"
            }
        )

    except Exception as e:
        logger.error("提交索引任务失败: %s", e)
        return 400, ErrorResponse(
            error="task_submit_failed",
            message=_("rag.task_submit_failed", detail=_safe_error_message(e))
        )


@router.post("/index/table", response={200: IndexResponse, 400: ErrorResponse, 403: ErrorResponse, 503: ErrorResponse}, auth=AuthBearer())
@billing_required(service_key="rag.embedding", organization_id_resolver=_resolve_rag_table_organization)
async def create_table_index(request: HttpRequest, payload: IndexTableRequest):
    """为单个表格创建向量索引"""
    disabled = _check_rag_enabled()
    if disabled:
        return disabled
    user_id = str(request.auth.id)

    def _run_sync():
        denied = _check_table_access(user_id, payload.table_id)
        if denied:
            return denied
        guard = _check_rag_service_guard(_get_table_organization_id(payload.table_id))
        if guard:
            return guard
        try:
            service = IndexService()
            result = service.index_table(
                table_id=payload.table_id,
                force=payload.force
            )

            return 200, IndexResponse(
                success=True,
                status=result['status'],
                message=_("rag.table_index_status", status=result['status']),
                data=result
            )

        except Exception as e:
            if _is_insufficient_balance(e):
                return 402, ErrorResponse(error="insufficient_balance", message=str(e))
            logger.error("创建表格索引失败: %s", e)
            return 400, ErrorResponse(
                error="index_failed",
                message=_("rag.index_create_failed", detail=_safe_error_message(e))
            )

    return await run_in_agent_io_executor(_run_sync)


@router.post("/index/table/records", response={200: BatchIndexResponse, 400: ErrorResponse, 403: ErrorResponse, 503: ErrorResponse}, auth=AuthBearer())
@billing_required(service_key="rag.embedding", organization_id_resolver=_resolve_rag_table_organization)
async def create_table_records_index(request: HttpRequest, payload: IndexTableRecordsRequest):
    """为表格的所有记录创建向量索引"""
    disabled = _check_rag_enabled()
    if disabled:
        return disabled
    user_id = str(request.auth.id)

    def _run_sync():
        denied = _check_table_access(user_id, payload.table_id)
        if denied:
            return denied
        guard = _check_rag_service_guard(_get_table_organization_id(payload.table_id))
        if guard:
            return guard
        try:
            service = IndexService()
            result = service.index_table_records(
                table_id=payload.table_id,
                force=payload.force
            )

            return 200, BatchIndexResponse(
                success=True,
                total=result['total'],
                completed=result['success'],
                skipped=result['skipped'],
                failed=result['failed'],
                errors=result.get('errors', [])
            )

        except Exception as e:
            if _is_insufficient_balance(e):
                return 402, ErrorResponse(error="insufficient_balance", message=str(e))
            logger.error("创建记录索引失败: %s", e)
            return 400, ErrorResponse(
                error="index_failed",
                message=_("rag.index_create_failed", detail=_safe_error_message(e))
            )

    return await run_in_agent_io_executor(_run_sync)


@router.post("/index/batch", response={200: BatchIndexResponse, 400: ErrorResponse, 403: ErrorResponse, 503: ErrorResponse}, auth=AuthBearer())
@billing_required(service_key="rag.embedding", organization_id_resolver=_resolve_rag_table_organization)
async def create_batch_index(request: HttpRequest, payload: IndexBatchRequest):
    """批量为多个表格创建索引"""
    disabled = _check_rag_enabled()
    if disabled:
        return disabled
    if len(payload.table_ids) > MAX_BATCH_TABLE_IDS:
        return 400, ErrorResponse(
            error="too_many_items",
            message=_("rag.batch_max_tables", max=MAX_BATCH_TABLE_IDS),
        )
    user_id = str(request.auth.id)

    def _run_sync():
        accessible = _get_accessible_organization_ids(user_id)
        from apps.tabdata.models import Table
        allowed_ids = set(
            str(tid) for tid in
            Table.objects.filter(
                id__in=payload.table_ids,
                organization_id__in=accessible,
            ).values_list("id", flat=True)
        )
        denied_ids = [tid for tid in payload.table_ids if tid not in allowed_ids]
        if denied_ids:
            return 403, ErrorResponse(
                error="forbidden",
                message=_("rag.no_table_permission_ids", ids=', '.join(denied_ids[:5])),
            )
        if payload.table_ids:
            guard = _check_rag_service_guard(_get_table_organization_id(payload.table_ids[0]))
            if guard:
                return guard
        try:
            service = IndexService()
            result = service.index_tables_batch(
                table_ids=payload.table_ids,
                force=payload.force
            )

            return 200, BatchIndexResponse(
                success=True,
                total=result['total'],
                completed=result['success'],
                skipped=result['skipped'],
                failed=result['failed'],
                errors=result.get('errors', [])
            )

        except Exception as e:
            if _is_insufficient_balance(e):
                return 402, ErrorResponse(error="insufficient_balance", message=str(e))
            logger.error("批量创建索引失败: %s", e)
            return 400, ErrorResponse(
                error="index_failed",
                message=_("rag.batch_index_failed", detail=_safe_error_message(e))
            )

    return await run_in_agent_io_executor(_run_sync)


@router.post("/index/document", response={200: IndexResponse, 400: ErrorResponse, 403: ErrorResponse, 503: ErrorResponse}, auth=AuthBearer())
@billing_required(service_key="rag.embedding", organization_id_resolver=_resolve_rag_document_organization)
async def create_document_index(request: HttpRequest, payload: IndexDocumentRequest):
    """为单个文档创建向量索引"""
    disabled = _check_rag_enabled()
    if disabled:
        return disabled
    user_id = str(request.auth.id)

    def _run_sync():
        # SEC-10: 权限检查包含同步 ORM 调用，必须在 _run_sync 内执行，避免 ASGI SynchronousOnlyOperation
        denied = _check_document_access(user_id, payload.document_id)
        if denied:
            return denied
        try:
            from apps.tabdoc.services.document_embedding_service import DocumentEmbeddingService
            result = DocumentEmbeddingService.index_document(payload.document_id, force=payload.force, user_id=user_id)
            return 200, IndexResponse(success=True, status=result["status"], message=_("rag.document_index_status", status=result['status']), data=result)
        except Exception as e:
            if _is_insufficient_balance(e):
                return 402, ErrorResponse(error="insufficient_balance", message=str(e))
            logger.error("创建文档索引失败: %s", e)
            return 400, ErrorResponse(error="index_failed", message=_("rag.index_create_failed", detail=_safe_error_message(e)))

    return await run_in_agent_io_executor(_run_sync)


@router.post("/index/document/async", response={200: SuccessResponse, 400: ErrorResponse, 403: ErrorResponse, 503: ErrorResponse}, auth=AuthBearer())
@billing_required(service_key="rag.embedding", organization_id_resolver=_resolve_rag_document_organization)
def create_document_index_async(request: HttpRequest, payload: IndexDocumentRequest):
    """异步为单个文档创建向量索引"""
    disabled = _check_rag_enabled()
    if disabled:
        return disabled
    user_id = str(request.auth.id)
    denied = _check_document_access(user_id, payload.document_id)
    if denied:
        return denied
    try:
        from apps.rag.tasks import index_document_task
        task = index_document_task.delay(payload.document_id, payload.force)
        return 200, SuccessResponse(
            message=_("rag.document_index_submitted"),
            data={"task_id": task.id, "document_id": payload.document_id, "status": "pending"},
        )
    except Exception as e:
        logger.error("提交文档索引任务失败: %s", e)
        return 400, ErrorResponse(error="task_submit_failed", message=_("rag.task_submit_failed", detail=_safe_error_message(e)))


@router.delete("/index", response={200: SuccessResponse, 400: ErrorResponse, 403: ErrorResponse, 503: ErrorResponse}, auth=AuthBearer())
async def delete_index(request: HttpRequest, payload: DeleteIndexRequest):
    """删除表格、记录或文档的索引"""
    disabled = _check_rag_enabled()
    if disabled:
        return disabled
    user_id = str(request.auth.id)

    def _run_sync():
        # SEC-11: 权限检查包含同步 ORM 调用，必须在 _run_sync 内执行，避免 ASGI SynchronousOnlyOperation
        if payload.table_id:
            denied = _check_table_access(user_id, payload.table_id)
            if denied:
                return denied
        elif payload.record_id:
            from apps.tabdata.models import TableRecord
            rec = TableRecord.objects.filter(id=payload.record_id).only("table_id").first()
            if not rec:
                return 400, ErrorResponse(error="not_found", message=_("rag.record_not_found", record_id=payload.record_id))
            denied = _check_table_access(user_id, str(rec.table_id))
            if denied:
                return denied
        elif payload.document_id:
            denied = _check_document_access(user_id, payload.document_id)
            if denied:
                return denied
        try:
            service = IndexService()
            deleted = 0

            if payload.record_id:
                result = service.delete_record_index(payload.record_id)
                deleted = result['deleted']
                message = _("rag.deleted_record_index", count=deleted)
            elif payload.table_id:
                table_result = service.delete_table_index(payload.table_id)
                records_result = service.delete_table_records_index(payload.table_id)
                deleted = table_result['deleted'] + records_result['deleted']
                message = _("rag.deleted_table_index", count=deleted)
            elif payload.document_id:
                from apps.tabdoc.services.document_embedding_service import DocumentEmbeddingService
                result = DocumentEmbeddingService.delete_document_index(payload.document_id)
                deleted = result.get('deleted', 0)
                message = _("rag.deleted_document_index", count=deleted)
            else:
                return 400, ErrorResponse(
                    error="invalid_params",
                    message=_("rag.delete_requires_id")
                )

            return 200, SuccessResponse(
                message=message,
                data={"deleted": deleted}
            )

        except Exception as e:
            logger.error("删除索引失败: %s", e)
            return 400, ErrorResponse(
                error="delete_failed",
                message=_("rag.delete_index_failed", detail=_safe_error_message(e))
            )

    return await run_in_agent_io_executor(_run_sync)


# ===== 检索 API =====

@router.post("/search", response={200: SearchResponse, 400: ErrorResponse, 503: ErrorResponse}, auth=AuthBearer(), deprecated=True)
async def search_knowledge_base_api(request: HttpRequest, payload: SearchRequest):
    """
    [已弃用] 语义检索知识库 — 请使用 /api/rag/v2/search

    仅检索 table + record 类型，不支持 document/skill/tool/mail。
    """
    disabled = _check_rag_enabled()
    if disabled:
        return disabled
    user_id = str(request.auth.id)

    def _run_sync():
        try:
            search_service = _get_search_service()
            context_service = _get_context_service()

            # 1. 表格级检索
            table_results = search_service.search_tables(
                query=payload.query,
                user_id=user_id,
                organization_id=payload.scope_id if payload.scope == "organization" else None,
                top_k=min(payload.top_k // 2, 5),
                similarity_threshold=payload.similarity_threshold,
            )

            # 2. 记录级检索
            record_results = search_service.search_records(
                query=payload.query,
                user_id=user_id,
                table_id=payload.scope_id if payload.scope == "table" else None,
                organization_id=payload.scope_id if payload.scope == "organization" else None,
                top_k=payload.top_k,
                similarity_threshold=payload.similarity_threshold,
            )

            # 3. 构建上下文
            context = context_service.build_hybrid_context(
                table_results=table_results,
                record_results=record_results,
                query=payload.query
            )

            # 4. 提取元数据
            metadata = context_service.extract_metadata(record_results)

            # 5. 格式化结果
            tables = [TableResult(**t) for t in table_results]
            records = [RecordResult(**r) for r in record_results]

            return 200, SearchResponse(
                success=True,
                query=payload.query,
                total=len(table_results) + len(record_results),
                tables=tables,
                records=records,
                context=context,
                metadata=metadata
            )

        except Exception as e:
            if _is_insufficient_balance(e):
                return 402, ErrorResponse(error="insufficient_balance", message=str(e))
            logger.error("检索失败: %s", e)
            return 400, ErrorResponse(
                error="search_failed",
                message=_("rag.search_failed", detail=_safe_error_message(e))
            )

    return await run_in_agent_io_executor(_run_sync)


@router.post("/search/tables", response={200: List[TableResult], 400: ErrorResponse, 503: ErrorResponse}, auth=AuthBearer(), deprecated=True)
async def search_tables_api(request: HttpRequest, payload: SearchTableRequest):
    """
    [已弃用] 检索相关表格 — 请使用 /api/rag/v2/search (content_types=["table"])
    """
    disabled = _check_rag_enabled()
    if disabled:
        return disabled
    user_id = str(request.auth.id)

    def _run_sync():
        try:
            service = _get_search_service()

            results = service.search_tables(
                query=payload.query,
                user_id=user_id,
                organization_id=payload.organization_id,
                top_k=payload.top_k
            )

            return 200, [TableResult(**r) for r in results]

        except Exception as e:
            if _is_insufficient_balance(e):
                return 402, ErrorResponse(error="insufficient_balance", message=str(e))
            logger.error("表格检索失败: %s", e)
            return 400, ErrorResponse(
                error="search_failed",
                message=_("rag.table_search_failed", detail=_safe_error_message(e))
            )

    return await run_in_agent_io_executor(_run_sync)


@router.post("/search/records", response={200: List[RecordResult], 400: ErrorResponse, 503: ErrorResponse}, auth=AuthBearer(), deprecated=True)
async def search_records_api(request: HttpRequest, payload: SearchRecordRequest):
    """
    [已弃用] 检索相关记录 — 请使用 /api/rag/v2/search (content_types=["record"])
    """
    disabled = _check_rag_enabled()
    if disabled:
        return disabled
    user_id = str(request.auth.id)

    def _run_sync():
        try:
            service = _get_search_service()

            results = service.search_records(
                query=payload.query,
                user_id=user_id,
                table_id=payload.table_id,
                organization_id=payload.organization_id,
                top_k=payload.top_k,
            )

            return 200, [RecordResult(**r) for r in results]

        except Exception as e:
            if _is_insufficient_balance(e):
                return 402, ErrorResponse(error="insufficient_balance", message=str(e))
            logger.error("记录检索失败: %s", e)
            return 400, ErrorResponse(
                error="search_failed",
                message=_("rag.record_search_failed", detail=_safe_error_message(e))
            )

    return await run_in_agent_io_executor(_run_sync)


# ===== 统计与管理 API =====

@router.get("/stats", response={200: IndexStatsResponse, 400: ErrorResponse, 503: ErrorResponse}, auth=AuthBearer())
def get_index_stats(request: HttpRequest):
    """获取索引统计信息"""
    disabled = _check_rag_enabled()
    if disabled:
        return disabled
    try:
        service = IndexService()
        stats = service.get_index_stats()
        return 200, IndexStatsResponse(success=True, **stats)
    except Exception as e:
        logger.error("获取统计信息失败: %s", e)
        return 400, ErrorResponse(error="stats_failed", message=_("rag.stats_failed", detail=_safe_error_message(e)))


@router.get("/indexes/tables", response={200: IndexListResponse, 400: ErrorResponse, 503: ErrorResponse}, auth=AuthBearer())
def list_table_indexes(request: HttpRequest, page: Annotated[int, Query(ge=1)] = 1, page_size: Annotated[int, Query(ge=1, le=200)] = 20):
    """获取当前用户可访问的表格索引列表"""
    disabled = _check_rag_enabled()
    if disabled:
        return disabled
    try:
        from apps.rag.models import TableEmbedding

        user_id = str(request.auth.id)
        accessible = _get_accessible_organization_ids(user_id)

        offset = (page - 1) * page_size
        # DS-035: 使用顶层 organization_id 字段过滤，替代 metadata JSON 路径查询
        queryset = TableEmbedding.objects.filter(
            organization_id__in=accessible,
        ).order_by('-created_at')

        total = queryset.count()
        items = queryset[offset:offset + page_size]

        # 格式化结果
        formatted_items = [
            {
                'table_id': str(item.table_id),
                'table_name': item.metadata.get('table_name', ''),
                'content_hash': item.content_hash,
                'status': item.status,
                'created_at': item.created_at.isoformat(),
                'updated_at': item.updated_at.isoformat(),
                'metadata': item.metadata,
            }
            for item in items
        ]

        return 200, IndexListResponse(
            success=True,
            total=total,
            items=formatted_items,
            page=page,
            page_size=page_size
        )

    except Exception as e:
        logger.error("获取表格索引列表失败: %s", e)
        return 400, ErrorResponse(
            error="list_failed",
            message=_("rag.list_failed", detail=_safe_error_message(e))
        )


@router.get("/indexes/records", response={200: IndexListResponse, 400: ErrorResponse, 503: ErrorResponse}, auth=AuthBearer())
def list_record_indexes(
    request: HttpRequest,
    table_id: str = None,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=200)] = 20
):
    """获取当前用户可访问的记录索引列表"""
    disabled = _check_rag_enabled()
    if disabled:
        return disabled
    try:
        from apps.rag.models import RecordEmbedding

        user_id = str(request.auth.id)
        accessible = _get_accessible_organization_ids(user_id)

        # DS-035: 使用顶层 organization_id 字段过滤，替代 metadata JSON 路径查询
        queryset = RecordEmbedding.objects.filter(
            organization_id__in=accessible,
        )
        if table_id:
            queryset = queryset.filter(table_id=table_id)

        queryset = queryset.order_by('-created_at')

        # 分页
        offset = (page - 1) * page_size
        total = queryset.count()
        items = queryset[offset:offset + page_size]

        # 格式化结果
        formatted_items = [
            {
                'record_id': str(item.record_id),
                'table_id': str(item.table_id),
                'table_name': item.metadata.get('table_name', ''),
                'content_hash': item.content_hash,
                'status': item.status,
                'priority': item.priority,
                'version': item.version,
                'created_at': item.created_at.isoformat(),
                'updated_at': item.updated_at.isoformat(),
            }
            for item in items
        ]

        return 200, IndexListResponse(
            success=True,
            total=total,
            items=formatted_items,
            page=page,
            page_size=page_size
        )

    except Exception as e:
        logger.error("获取记录索引列表失败: %s", e)
        return 400, ErrorResponse(
            error="list_failed",
            message=_("rag.list_failed", detail=_safe_error_message(e))
        )


# ===== 任务管理 API =====

@router.get("/tasks/{task_id}", response={200: SuccessResponse, 400: ErrorResponse, 403: ErrorResponse, 503: ErrorResponse}, auth=AuthBearer())
def get_task_status_api(request: HttpRequest, task_id: str):
    """获取任务状态"""
    disabled = _check_rag_enabled()
    if disabled:
        return disabled
    user_id = str(request.auth.id)
    denied = _check_task_access(user_id, task_id)
    if denied:
        return denied
    try:
        from celery.result import AsyncResult

        result = AsyncResult(task_id)

        response_data = {
            'task_id': task_id,
            'state': result.state,
            'ready': result.ready(),
        }

        if result.ready():
            response_data['successful'] = result.successful()
            if result.successful():
                response_data['result'] = result.result
            else:
                # SEC-08: 脱敏处理，避免 Celery 失败信息直接暴露给前端
                response_data['error'] = _safe_error_message(result.info) if isinstance(result.info, Exception) else "任务执行失败"

        return 200, SuccessResponse(
            message=_("rag.task_query_success"),
            data=response_data
        )

    except Exception as e:
        logger.error("查询任务状态失败: task_id=%s, error=%s", task_id, e)
        return 400, ErrorResponse(
            error="query_failed",
            message=_("rag.task_query_failed", detail=_safe_error_message(e))
        )


@router.get("/tasks", response={200: IndexListResponse, 400: ErrorResponse, 503: ErrorResponse}, auth=AuthBearer())
def list_embedding_tasks(
    request: HttpRequest,
    status: str = None,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=200)] = 20
):
    """获取当前用户可访问的向量化任务列表"""
    disabled = _check_rag_enabled()
    if disabled:
        return disabled
    try:
        from django.db.models import Q
        from apps.rag.models import EmbeddingTask
        from apps.tabdata.models import Table, TableRecord

        user_id = str(request.auth.id)
        accessible = _get_accessible_organization_ids(user_id)

        use_organization_field = EmbeddingTask.objects.filter(
            organization_id__isnull=False,
        ).exists()

        if use_organization_field:
            target_filter = Q(organization_id__in=accessible)
        else:
            table_subq = Table.objects.filter(
                organization_id__in=accessible,
            ).values("id")
            record_subq = TableRecord.objects.filter(
                table_id__in=table_subq,
            ).values("id")
            target_filter = Q(target_id__in=table_subq) | Q(target_id__in=record_subq)
            try:
                from apps.tabdoc.models import Document
                doc_subq = Document.objects.filter(
                    organization_id__in=accessible,
                ).values("id")
                target_filter |= Q(target_id__in=doc_subq)
            except Exception:
                pass

        queryset = EmbeddingTask.objects.filter(target_filter)
        if status:
            queryset = queryset.filter(status=status)

        queryset = queryset.order_by('-created_at')

        # 分页
        offset = (page - 1) * page_size
        total = queryset.count()
        items = queryset[offset:offset + page_size]

        # 格式化结果
        formatted_items = [
            {
                'id': str(item.id),
                'task_type': item.task_type,
                'target_id': str(item.target_id),
                'status': item.status,
                'retry_count': item.retry_count,
                'celery_task_id': item.celery_task_id,
                'error_message': item.error_message,
                'created_at': item.created_at.isoformat(),
                'started_at': item.started_at.isoformat() if item.started_at else None,
                'completed_at': item.completed_at.isoformat() if item.completed_at else None,
            }
            for item in items
        ]

        return 200, IndexListResponse(
            success=True,
            total=total,
            items=formatted_items,
            page=page,
            page_size=page_size
        )

    except Exception as e:
        logger.error("获取任务列表失败: %s", e)
        return 400, ErrorResponse(
            error="list_failed",
            message=_("rag.task_list_failed", detail=_safe_error_message(e))
        )


@router.post("/tasks/{task_id}/cancel", response={200: SuccessResponse, 400: ErrorResponse, 403: ErrorResponse, 503: ErrorResponse}, auth=AuthBearer())
def cancel_task(request: HttpRequest, task_id: str):
    """取消任务"""
    disabled = _check_rag_enabled()
    if disabled:
        return disabled
    user_id = str(request.auth.id)
    denied = _check_task_access(user_id, task_id)
    if denied:
        return denied
    try:
        from celery.result import AsyncResult

        result = AsyncResult(task_id)

        if not result.ready():
            result.revoke(terminate=True)

            # 更新数据库状态
            from apps.rag.models import EmbeddingTask
            EmbeddingTask.objects.filter(
                celery_task_id=task_id
            ).update(status='cancelled')

            return 200, SuccessResponse(
                message=_("rag.task_cancelled"),
                data={'task_id': task_id}
            )
        else:
            return 400, ErrorResponse(
                error="task_completed",
                message=_("rag.task_completed_no_cancel")
            )

    except Exception as e:
        logger.error("取消任务失败: task_id=%s, error=%s", task_id, e)
        return 400, ErrorResponse(
            error="cancel_failed",
            message=_("rag.task_cancel_failed", detail=_safe_error_message(e))
        )


@router.post("/index/table/records/async", response={200: SuccessResponse, 400: ErrorResponse, 403: ErrorResponse, 503: ErrorResponse}, auth=AuthBearer())
@billing_required(service_key="rag.embedding", organization_id_resolver=_resolve_rag_table_organization)
def create_table_records_index_async(request: HttpRequest, payload: IndexTableRecordsRequest):
    """异步为表格的所有记录创建索引"""
    disabled = _check_rag_enabled()
    if disabled:
        return disabled
    user_id = str(request.auth.id)
    denied = _check_table_access(user_id, payload.table_id)
    if denied:
        return denied
    guard = _check_rag_service_guard(_get_table_organization_id(payload.table_id))
    if guard:
        return guard
    try:
        from apps.rag.tasks import index_table_records_task

        # 提交异步任务
        task = index_table_records_task.delay(payload.table_id, payload.force)

        return 200, SuccessResponse(
            message=_("rag.batch_index_submitted"),
            data={
                "task_id": task.id,
                "table_id": payload.table_id,
                "status": "pending"
            }
        )

    except Exception as e:
        logger.error("提交批量索引任务失败: %s", e)
        return 400, ErrorResponse(
            error="task_submit_failed",
            message=_("rag.task_submit_failed", detail=_safe_error_message(e))
        )


@router.post("/index/batch/async", response={200: SuccessResponse, 400: ErrorResponse, 403: ErrorResponse, 503: ErrorResponse}, auth=AuthBearer())
@billing_required(service_key="rag.embedding", organization_id_resolver=_resolve_rag_table_organization)
def create_batch_index_async(request: HttpRequest, payload: IndexBatchRequest):
    """异步批量为多个表格创建索引"""
    disabled = _check_rag_enabled()
    if disabled:
        return disabled
    if len(payload.table_ids) > MAX_BATCH_TABLE_IDS:
        return 400, ErrorResponse(
            error="too_many_items",
            message=_("rag.batch_max_tables", max=MAX_BATCH_TABLE_IDS),
        )
    user_id = str(request.auth.id)
    accessible = _get_accessible_organization_ids(user_id)
    from apps.tabdata.models import Table
    allowed_ids = set(
        str(tid) for tid in
        Table.objects.filter(
            id__in=payload.table_ids,
            organization_id__in=accessible,
        ).values_list("id", flat=True)
    )
    denied_ids = [tid for tid in payload.table_ids if tid not in allowed_ids]
    if denied_ids:
        return 403, ErrorResponse(
            error="forbidden",
            message=_("rag.no_table_permission_ids", ids=', '.join(denied_ids[:5])),
        )
    if payload.table_ids:
        guard = _check_rag_service_guard(_get_table_organization_id(payload.table_ids[0]))
        if guard:
            return guard
    try:
        from apps.rag.tasks import index_batch_tables_task

        task = index_batch_tables_task.delay(payload.table_ids, payload.force)

        return 200, SuccessResponse(
            message=_("rag.batch_table_index_submitted"),
            data={
                "task_id": task.id,
                "table_count": len(payload.table_ids),
                "status": "pending"
            }
        )

    except Exception as e:
        logger.error("提交批量表格索引任务失败: %s", e)
        return 400, ErrorResponse(
            error="task_submit_failed",
            message=_("rag.task_submit_failed", detail=_safe_error_message(e))
        )


# ===== 监控与分析 API =====

@router.get("/monitor/quality", response={200: SuccessResponse, 400: ErrorResponse, 403: ErrorResponse, 503: ErrorResponse}, auth=AuthBearer())
def get_index_quality(request: HttpRequest):
    """获取索引质量统计"""
    disabled = _check_rag_enabled()
    if disabled:
        return disabled
    # SEC-06: 全平台统计数据，限 is_staff 管理员访问
    denied = _require_staff(request)
    if denied:
        return denied
    try:
        from apps.rag.services import MonitorService
        service = MonitorService()
        stats = service.get_index_quality_stats()
        return 200, SuccessResponse(message=_("rag.quality_stats_success"), data=stats)
    except Exception as e:
        logger.error("获取索引质量统计失败: %s", e)
        return 400, ErrorResponse(error="stats_failed", message=_("rag.stats_failed", detail=_safe_error_message(e)))


@router.get("/monitor/coverage", response={200: SuccessResponse, 400: ErrorResponse, 403: ErrorResponse, 503: ErrorResponse}, auth=AuthBearer())
def get_index_coverage_api(request: HttpRequest):
    """获取索引覆盖率"""
    disabled = _check_rag_enabled()
    if disabled:
        return disabled
    # SEC-06: 全平台统计数据，限 is_staff 管理员访问
    denied = _require_staff(request)
    if denied:
        return denied
    try:
        from apps.rag.services import MonitorService
        service = MonitorService()
        coverage = service.get_index_coverage()
        return 200, SuccessResponse(message=_("rag.coverage_success"), data=coverage)
    except Exception as e:
        logger.error("获取索引覆盖率失败: %s", e)
        return 400, ErrorResponse(error="coverage_failed", message=_("rag.coverage_failed", detail=_safe_error_message(e)))


@router.get("/monitor/performance", response={200: SuccessResponse, 400: ErrorResponse, 403: ErrorResponse, 503: ErrorResponse}, auth=AuthBearer())
def get_performance_metrics_api(request: HttpRequest, hours: Annotated[int, Query(ge=1, le=720)] = 24):
    """获取性能指标"""
    disabled = _check_rag_enabled()
    if disabled:
        return disabled
    # SEC-06: 全平台统计数据，限 is_staff 管理员访问
    denied = _require_staff(request)
    if denied:
        return denied
    try:
        from apps.rag.services import MonitorService
        service = MonitorService()
        metrics = service.get_performance_metrics(hours=hours)
        return 200, SuccessResponse(message=_("rag.metrics_success"), data=metrics)
    except Exception as e:
        logger.error("获取性能指标失败: %s", e)
        return 400, ErrorResponse(error="metrics_failed", message=_("rag.metrics_failed", detail=_safe_error_message(e)))


@router.get("/monitor/report", response={200: SuccessResponse, 400: ErrorResponse, 403: ErrorResponse, 503: ErrorResponse}, auth=AuthBearer())
def get_comprehensive_report_api(request: HttpRequest):
    """获取综合监控报告"""
    disabled = _check_rag_enabled()
    if disabled:
        return disabled
    # SEC-06: 全平台统计数据，限 is_staff 管理员访问
    denied = _require_staff(request)
    if denied:
        return denied
    try:
        from apps.rag.services import MonitorService
        service = MonitorService()
        report = service.get_comprehensive_report()
        return 200, SuccessResponse(message=_("rag.report_success"), data=report)
    except Exception as e:
        logger.error("生成综合报告失败: %s", e)
        return 400, ErrorResponse(error="report_failed", message=_("rag.report_failed", detail=_safe_error_message(e)))


# ===================================================================
# v2 统一检索 API
# ===================================================================

from .schemas_v2 import (
    UnifiedSearchRequest,
    UnifiedSearchResponse,
    UnifiedSearchErrorResponse,
    SearchHit,
)


@router.post(
    "/v2/search",
    response={200: UnifiedSearchResponse, 400: UnifiedSearchErrorResponse, 402: UnifiedSearchErrorResponse, 410: UnifiedSearchErrorResponse, 503: UnifiedSearchErrorResponse},
    auth=AuthBearer(),
    tags=["RAG v2"],
)
def unified_search_api(request: HttpRequest, payload: UnifiedSearchRequest):
    """
    v2 统一语义检索

    跨内容类型的统一检索入口，支持 table / record / skill / tool / mail / document。

    **参数：**
    - query: 查询文本
    - content_types: 要检索的内容类型列表（为空检索所有类型）
    - organization_id: 组织 ID
    - top_k: 返回结果数量 (1-50)
    - similarity_threshold: 相似度阈值 (0-1)
    - scope: 检索范围约束
    - return_context: 是否返回组装好的 LLM 上下文

    **返回：**
    - hits: 按相似度排序的统一结果列表
    - context: 组装好的上下文（可选）
    - type_counts: 各类型结果数量
    """
    effective_content_types = payload.content_types
    if payload.content_types and "code" in payload.content_types:
        effective_content_types = [
            content_type for content_type in payload.content_types
            if content_type != "code"
        ]
    if payload.content_types and not effective_content_types:
        return 410, UnifiedSearchErrorResponse(
            error="code_semantic_search_retired",
            message="TabCode semantic search has been retired; use grep or glob search instead",
        )

    disabled = _check_rag_enabled()
    if disabled:
        return disabled
    try:
        from apps.rag.services.unified_search_service import get_unified_search_service
        from apps.rag.services import ContextService

        user_id = str(request.auth.id)
        service = get_unified_search_service()

        result = service.search(
            query=payload.query,
            user_id=user_id,
            organization_id=payload.organization_id,
            content_types=effective_content_types,
            top_k=payload.top_k,
            similarity_threshold=payload.similarity_threshold,
            scope=payload.scope,
        )

        if result.get("error"):
            # SEC-09: 通过 _safe_error_message 过滤，避免泄漏内部服务细节
            return 400, UnifiedSearchErrorResponse(
                error="search_failed",
                message=_safe_error_message(Exception(result["error"])),
            )

        context_text = None
        if payload.return_context and result["hits"]:
            context_service = _get_context_service()
            context_text = context_service.build_unified_context(
                hits=result["hits"],
                query=payload.query,
            )

        hits = [SearchHit(**h) for h in result["hits"]]

        return 200, UnifiedSearchResponse(
            query=payload.query,
            total=result["total"],
            hits=hits,
            context=context_text,
            type_counts=result.get("type_counts", {}),
            response_time_ms=result.get("response_time_ms"),
        )

    except Exception as e:
        if _is_insufficient_balance(e):
            return 402, UnifiedSearchErrorResponse(error="insufficient_balance", message=str(e))
        logger.error("v2 unified search failed: %s", e)
        return 400, UnifiedSearchErrorResponse(
            error="search_failed",
            message=_safe_error_message(e),
        )


@router.get(
    "/v2/types",
    response={200: SuccessResponse, 503: ErrorResponse},
    auth=AuthBearer(),
    tags=["RAG v2"],
)
def list_available_types(request: HttpRequest):
    """获取当前可用的内容类型列表"""
    disabled = _check_rag_enabled()
    if disabled:
        return disabled
    from apps.rag.services.unified_search_service import get_unified_search_service
    service = get_unified_search_service()
    return 200, SuccessResponse(
        message=_("rag.available_types"),
        data={"types": service.get_available_types()},
    )


# =====================================================================
# Code Index API — 代码块索引的接收、同步和删除
# =====================================================================

@router.post(
    "/code/index",
    response={200: SuccessResponse, 400: ErrorResponse, 410: ErrorResponse, 503: ErrorResponse},
    auth=AuthBearer(),
    tags=["RAG Code"],
)
def submit_code_chunks(request: HttpRequest, payload: CodeIndexRequest):
    """Compatibility tombstone for the retired code-index producer."""
    return _code_semantic_search_retired()


@router.delete(
    "/code/index",
    response={200: SuccessResponse, 400: ErrorResponse, 403: ErrorResponse},
    auth=AuthBearer(),
    tags=["RAG Code"],
)
def delete_code_index(request: HttpRequest, payload: CodeIndexDeleteRequest):
    """Delete retained TabCode vectors while the compatibility table still exists."""
    try:
        from apps.rag.models import CodeChunkEmbedding
        from apps.rag.tasks import delete_code_project_index

        user_id = str(request.auth.id)
        accessible = _get_accessible_organization_ids(user_id)

        probe = (
            CodeChunkEmbedding.objects.filter(project_id=payload.project_id)
            .only("organization_id")
            .first()
        )
        if probe is None:
            return 400, ErrorResponse(
                error="not_found",
                message=_("rag.project_not_found", project_id=payload.project_id),
            )

        project_organization_id = str(probe.organization_id)
        if (
            project_organization_id not in accessible
            or (
                payload.organization_id
                and payload.organization_id != project_organization_id
            )
        ):
            return 403, ErrorResponse(
                error="forbidden",
                message=_("rag.no_project_index_permission"),
            )

        task = delete_code_project_index.delay(
            project_id=payload.project_id,
            organization_id=project_organization_id,
            file_paths=payload.file_paths,
        )
        return 200, SuccessResponse(
            message=_("rag.code_index_delete_submitted"),
            data={"task_id": task.id},
        )
    except Exception as exc:
        logger.error("Failed to delete retained code index: %s", exc)
        return 400, ErrorResponse(
            error="code_delete_failed",
            message=_("rag.delete_failed", detail=_safe_error_message(exc)),
        )


@router.post(
    "/code/sync",
    response={200: CodeSyncResponse, 400: ErrorResponse, 403: ErrorResponse, 410: ErrorResponse, 503: ErrorResponse},
    auth=AuthBearer(),
    tags=["RAG Code"],
)
def sync_code_index(request: HttpRequest, payload: CodeSyncRequest):
    """Compatibility tombstone for the retired incremental sync API."""
    return _code_semantic_search_retired()
