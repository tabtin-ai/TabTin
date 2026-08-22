"""
DocParse REST API

提供文档解析状态查询、手动触发解析等端点。
"""

from __future__ import annotations

import logging

from ninja import Router

from apps.services.docparse.models import ParsedDocument
from apps.services.docparse.service import DocParseService
from apps.services.oss.models import FileRecord
from apps.users.auth.permissions import JWTAuth

from apps.services.billing.decorators import billing_required

logger = logging.getLogger(__name__)

router = Router(tags=["docparse"])

jwt_auth = JWTAuth()


def _resolve_file_organization(request, kwargs) -> str:
    """从 file_record_id path 参数推导 organization_id。"""
    fid = kwargs.get("file_record_id")
    if not fid:
        return ""
    try:
        wt = FileRecord.objects.filter(id=fid).values_list("organization_id", flat=True).first()
        return str(wt) if wt else ""
    except Exception:
        return ""


def _check_file_ownership(request, file_record_id: str):
    """校验文件归属：upload_user 匹配或 organization 可达。返回 (file_record, error_response)。"""
    try:
        file_record = FileRecord.objects.filter(id=file_record_id).first()
    except Exception:
        file_record = None

    if not file_record:
        return None, {"status": "error", "message": "文件不存在", "code": 404}

    user_id_str = str(request.auth.id)

    if file_record.upload_user == user_id_str:
        return file_record, None

    if file_record.organization_id:
        from apps.tabtinspace.services.base import BaseService
        svc = BaseService(user=request.auth)
        if svc.check_organization_permission(file_record.organization_id, "viewer"):
            return file_record, None

    return None, {"status": "error", "message": "无权访问此文件", "code": 403}


@router.get("/status/{file_record_id}", auth=jwt_auth)
def get_parse_status(request, file_record_id: str):
    """查询文档解析状态"""
    file_record, err = _check_file_ownership(request, file_record_id)
    if err:
        return err

    try:
        parsed = ParsedDocument.objects.filter(file_record_id=file_record_id).first()
        if not parsed:
            return {"status": "not_found", "file_record_id": file_record_id}
        # W1 / L9：三个 endpoint（/status, /summary, /content）统一暴露 failure_code，
        # 让客户端在任意 endpoint 拿到的失败响应都能按 13 类 SSoT 路由到 i18n 文案。
        return {
            "status": parsed.status,
            "file_record_id": file_record_id,
            "total_pages": parsed.total_pages,
            "parsed_pages": parsed.parsed_pages,
            "parse_method": parsed.parse_method,
            "title": parsed.title,
            "parsed_at": parsed.parsed_at.isoformat() if parsed.parsed_at else None,
            "error_message": parsed.error_message or None,
            "failure_code": (
                parsed.failure_code
                if parsed.status == ParsedDocument.Status.FAILED
                else None
            ),
        }
    except Exception as exc:
        logger.error("查询解析状态失败: %s", exc)
        return {"status": "error", "message": str(exc)}


@router.get("/summary/{file_record_id}", auth=jwt_auth)
def get_summary(request, file_record_id: str, max_tokens: int = 2000):
    """获取文档摘要（供本地 Runtime 预处理附件使用）。

    如果文档尚未解析，会自动触发异步解析并返回状态。
    """
    file_record, err = _check_file_ownership(request, file_record_id)
    if err:
        return err

    try:
        parsed = ParsedDocument.objects.filter(file_record_id=file_record_id).first()

        if parsed and parsed.status == ParsedDocument.Status.PARSING:
            progress = ""
            if parsed.total_pages and parsed.parsed_pages:
                progress = f"({parsed.parsed_pages}/{parsed.total_pages}页)"
            elif parsed.parsed_pages:
                progress = f"(已完成{parsed.parsed_pages}页)"
            return {
                "status": "parsing",
                "file_record_id": file_record_id,
                "summary": "",
                "message": f"文档正在解析中{progress}，请稍后重试",
            }

        if parsed and parsed.status == ParsedDocument.Status.FAILED:
            # W1 / L9：暴露结构化 failure_code 给客户端，UI 按全局 13 类
            # SSoT 路由到 i18n 文案（避免各端重复解析 error_message 关键词）。
            return {
                "status": "failed",
                "file_record_id": file_record_id,
                "summary": "",
                "failure_code": parsed.failure_code or "upstream_error",
                "message": f"文档解析失败: {parsed.error_message[:200] if parsed.error_message else '未知错误'}",
            }

        clamped = max(500, min(max_tokens, 8000))
        summary = DocParseService.get_summary(file_record_id, max_tokens=clamped)
        summary_text = (summary or "").strip()

        if summary_text:
            return {
                "status": "ready",
                "file_record_id": file_record_id,
                "summary": summary_text,
                "title": parsed.title if parsed else "",
                "total_pages": parsed.total_pages if parsed else 0,
            }

        # ：ParsedDocument 已 ready 但 0 chunk / 空摘要时，不要再伪装 pending
        # 并反复 parse_async——Host 会把 pending 当成「正在解析中」永久占位。
        if parsed and parsed.status == ParsedDocument.Status.READY:
            return {
                "status": "ready",
                "file_record_id": file_record_id,
                "summary": "",
                "title": parsed.title or "",
                "total_pages": parsed.total_pages or 0,
                "message": "文档已解析完成，但未提取到可用文本",
            }

        DocParseService.parse_async(file_record_id)
        return {
            "status": "pending",
            "file_record_id": file_record_id,
            "summary": "",
            "message": "文档尚未解析，已触发异步解析任务",
        }

    except Exception as exc:
        logger.error("获取文档摘要失败: %s", exc)
        return {"status": "error", "message": str(exc), "summary": ""}


_OVERVIEW_MAX_CHARS = 16_000
_OVERVIEW_MAX_PAGES = 40
_OVERVIEW_MAX_CHUNK_CHARS = 800


def _sample_page_numbers(page_numbers: list[int], max_pages: int) -> list[int]:
    if len(page_numbers) <= max_pages:
        return page_numbers
    last_index = len(page_numbers) - 1
    indexes = {
        round(position * last_index / (max_pages - 1))
        for position in range(max_pages)
    }
    return [page_numbers[index] for index in sorted(indexes)]


def _select_overview_chunks(
    chunks,
    *,
    max_chars: int = _OVERVIEW_MAX_CHARS,
    max_pages: int = _OVERVIEW_MAX_PAGES,
):
    """按页均匀生成文档地图，避免默认读取只覆盖文档开头。"""
    chunks_by_page: dict[int, list] = {}
    for chunk in chunks:
        page_number = chunk.page.page_number if chunk.page else 0
        chunks_by_page.setdefault(page_number, []).append(chunk)

    page_numbers = sorted(chunks_by_page)
    coverage_pages = _sample_page_numbers(page_numbers, max_pages)
    if not coverage_pages:
        return [], []

    per_page_budget = max(300, max_chars // len(coverage_pages))
    selected = []
    for page_number in coverage_pages:
        page_chunks = chunks_by_page[page_number]
        ordered = sorted(
            enumerate(page_chunks),
            key=lambda item: (item[1].chunk_type != "heading", item[0]),
        )
        page_chars = 0
        for _, chunk in ordered:
            content_length = len(chunk.content or "")
            if page_chars and page_chars + content_length > per_page_budget:
                continue
            selected.append(chunk)
            page_chars += content_length
    return selected, coverage_pages


@router.get("/content/{file_record_id}", auth=jwt_auth)
def get_content(
    request,
    file_record_id: str,
    page: int = None,
    query: str = None,
    offset: int = 0,
    limit: int = 200,
    mode: str = "chunks",
):
    """获取文档结构化内容（供本地 Runtime parse_document 工具使用）。"""
    file_record, err = _check_file_ownership(request, file_record_id)
    if err:
        return err

    try:
        parsed = ParsedDocument.objects.filter(file_record_id=file_record_id).first()
        if not parsed:
            DocParseService.parse_async(file_record_id)
            return {
                "status": "pending",
                "message": "文档尚未解析，已触发异步解析任务",
                "chunks": [],
            }

        if parsed.status == ParsedDocument.Status.PARSING:
            return {
                "status": "parsing",
                "message": "文档正在解析中",
                "parsed_pages": parsed.parsed_pages,
                "total_pages": parsed.total_pages,
                "chunks": [],
            }

        if parsed.status == ParsedDocument.Status.FAILED:
            # W1 / L9：暴露结构化 failure_code 给客户端
            return {
                "status": "failed",
                "failure_code": parsed.failure_code or "upstream_error",
                "message": f"文档解析失败: {parsed.error_message[:200] if parsed.error_message else '未知错误'}",
                "chunks": [],
            }

        if mode == "overview":
            all_chunks = list(DocParseService.get_chunks(file_record_id))
            total_chunks = len(all_chunks)
            sliced, coverage_pages = _select_overview_chunks(all_chunks)
            resolved_mode = "overview"
            has_more = False
            result_offset = 0
        elif query:
            chunks = list(DocParseService.search_chunks(file_record_id, query))
            total_chunks = len(chunks)
            clamped_limit = max(1, min(limit, 500))
            sliced = chunks[offset:offset + clamped_limit]
            coverage_pages = sorted({c.page.page_number for c in sliced if c.page})
            resolved_mode = "search"
            has_more = (offset + clamped_limit) < total_chunks
            result_offset = offset
        elif page is not None:
            chunks = list(DocParseService.get_chunks(file_record_id, page=page))
            total_chunks = len(chunks)
            clamped_limit = max(1, min(limit, 500))
            sliced = chunks[offset:offset + clamped_limit]
            coverage_pages = [page] if sliced else []
            resolved_mode = "page"
            has_more = (offset + clamped_limit) < total_chunks
            result_offset = offset
        else:
            chunks = list(DocParseService.get_chunks(file_record_id))
            total_chunks = len(chunks)
            clamped_limit = max(1, min(limit, 500))
            sliced = chunks[offset:offset + clamped_limit]
            coverage_pages = sorted({c.page.page_number for c in sliced if c.page})
            resolved_mode = "chunks"
            has_more = (offset + clamped_limit) < total_chunks
            result_offset = offset

        result_chunks = []
        for c in sliced:
            page_number = c.page.page_number if c.page else 0
            content = c.content
            if resolved_mode == "overview" and len(content) > _OVERVIEW_MAX_CHUNK_CHARS:
                content = f"{content[:_OVERVIEW_MAX_CHUNK_CHARS]}…"
            chunk_data = {
                "type": c.chunk_type,
                "content": content,
                "page": page_number,
            }
            if c.heading_level:
                chunk_data["heading_level"] = c.heading_level
            result_chunks.append(chunk_data)

        return {
            "status": "ready",
            "mode": resolved_mode,
            "total_pages": parsed.total_pages,
            "parsed_pages": parsed.parsed_pages,
            "total_chunks": total_chunks,
            "returned": len(result_chunks),
            "offset": result_offset,
            "has_more": has_more,
            "coverage_pages": coverage_pages,
            "chunks": result_chunks,
        }

    except Exception as exc:
        logger.error("获取文档内容失败: %s", exc)
        return {"status": "error", "message": str(exc), "chunks": []}


@router.post("/parse/{file_record_id}", auth=jwt_auth)
@billing_required(service_key="docparse", organization_id_resolver=_resolve_file_organization)
def trigger_parse(request, file_record_id: str, async_mode: bool = True):
    """手动触发文档解析"""
    file_record, err = _check_file_ownership(request, file_record_id)
    if err:
        return err

    try:
        if not async_mode:
            return {
                "status": "error",
                "code": "sync_parse_disabled",
                "message": "同步解析已禁用，请使用异步解析任务",
            }
        task_id = DocParseService.enqueue(file_record_id)
        status = "queued" if task_id else "already_processing"
        return {"status": status, "task_id": task_id, "file_record_id": file_record_id}
    except Exception as exc:
        logger.error("触发解析失败: %s", exc)
        return {"status": "error", "message": str(exc)}
