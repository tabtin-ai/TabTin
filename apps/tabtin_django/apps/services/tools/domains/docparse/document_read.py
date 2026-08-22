"""
parse_document — 读取已上传文档的结构化内容

支持按页读取、关键词搜索，返回带 bbox 的 chunks。
Agent 可通过此工具访问用户上传的 PDF / Word / Excel / PPTX /
TXT / CSV / Markdown / JSON 文档内容。

v0.6：PARSING / FAILED 状态感知 + 异步触发（不再同步阻塞）。
v0.7：权限校验 — 通过 InjectedState 获取 user_id / organization_id，
      查询前验证 FileRecord 归属。
v0.8：RAG-9 分页支持 offset/limit；RAG-10 去重 _check_parse_status、
      关闭结果缓存防止缓存瞬态状态。
"""

from __future__ import annotations

import json
import logging
from typing import Any, Optional

from pydantic import BaseModel, Field
from typing_extensions import Annotated

from apps.services.common.state.injected_state import InjectedState
from apps.services.tools import BaseTool
from apps.services.tools.error_envelope import build_tool_error, json_tool_error

logger = logging.getLogger(__name__)

_DEFAULT_CHUNK_LIMIT = 200


class DocumentReadInput(BaseModel):
    file_id: str = Field(description="文件 ID（FileRecord UUID）")
    page: Optional[int] = Field(
        default=None,
        description="指定页码（从 1 开始），不指定则返回全部页面",
    )
    query: Optional[str] = Field(
        default=None,
        description="关键词搜索，仅返回包含该关键词的内容块",
    )
    offset: int = Field(
        default=0,
        ge=0,
        description="分页偏移量（从 0 开始），跳过前 offset 个 chunks",
    )
    limit: int = Field(
        default=_DEFAULT_CHUNK_LIMIT,
        ge=1,
        le=500,
        description="单次返回最大 chunk 数（默认 200，上限 500）",
    )
    user_id: Annotated[Optional[str], InjectedState("user_id")] = Field(
        None,
        description="User ID (auto-injected)",
    )
    organization_id: Annotated[Optional[str], InjectedState("organization_id")] = Field(
        None,
        description="Organization ID (auto-injected)",
    )


class DocumentReadTool(BaseTool):
    category: str = "read_file"
    name: str = "parse_document"
    description: str = (
        "读取已上传文档的结构化内容，"
        "支持 PDF、Word、Excel、PPTX、TXT、CSV、Markdown、JSON 等格式。"
        "可按页读取或关键词搜索，支持 offset/limit 分页。"
        "返回的内容块包含类型、文本、位置等信息。"
        "如果文档正在解析中，会返回解析进度。"
    )
    risk_level: str = "safe"
    cacheable: bool = False
    cache_ttl: int = 30
    timeout: int = 120
    args_schema: type[DocumentReadInput] = DocumentReadInput

    def run(
        self,
        file_id: str,
        page: Optional[int] = None,
        query: Optional[str] = None,
        offset: int = 0,
        limit: int = _DEFAULT_CHUNK_LIMIT,
        user_id: Optional[str] = None,
        organization_id: Optional[str] = None,
    ) -> str:
        if not user_id and not organization_id:
            return json_tool_error(
                "Authentication is required to read documents.",
                error_kind="runtime_misconfig",
                hint="Ensure the agent runtime injects user_id or organization_id, then retry parse_document.",
                retryable=False,
            )

        from apps.services.docparse.service import DocParseService

        ownership_err = _check_file_ownership(file_id, user_id, organization_id)
        if ownership_err:
            return json.dumps(ownership_err, ensure_ascii=False)

        try:
            status_info = _check_parse_status(file_id)
            if status_info:
                return json.dumps(status_info, ensure_ascii=False)

            if query:
                chunks = DocParseService.search_chunks(file_id, query)
                if not chunks:
                    return json.dumps({
                        "success": True,
                        "message": f"未找到包含 \"{query}\" 的内容",
                        "chunks": [],
                        "total_chunks": 0,
                    }, ensure_ascii=False)
            elif page is not None:
                chunks = DocParseService.get_chunks(file_id, page=page)
                if not chunks:
                    return json.dumps({
                        "success": True,
                        "message": f"第 {page} 页无内容或不存在",
                        "chunks": [],
                        "total_chunks": 0,
                    }, ensure_ascii=False)
            else:
                chunks = DocParseService.get_chunks(file_id)
                if not chunks:
                    parsed = DocParseService.get_parsed(file_id)
                    if not parsed:
                        try:
                            DocParseService.parse_async(file_id)
                        except Exception as exc:
                            logger.warning(
                                "[parse_document] trigger parse failed file_id=%s error_type=%s",
                                file_id,
                                type(exc).__name__,
                            )
                            return json_tool_error(
                                "Failed to trigger document parsing.",
                                error_kind="upstream_error",
                                hint="Retry parse_document once. If it fails again, ask the user to re-upload the document.",
                                retryable=True,
                            )
                        return json_tool_error(
                            "Document has not been parsed yet; an async parse job was started.",
                            error_kind="document_not_ready",
                            hint="Wait a few seconds, then retry parse_document with the same file_id.",
                            retryable=True,
                            context={"status": "parsing"},
                        )

                    return json.dumps({
                        "success": True,
                        "message": "文档已解析但无内容块",
                        "chunks": [],
                        "total_chunks": 0,
                    }, ensure_ascii=False)

        except Exception as exc:
            logger.warning(
                "[parse_document] read failed file_id=%s error_type=%s",
                file_id,
                type(exc).__name__,
            )
            return json_tool_error(
                "Failed to read document content.",
                error_kind="upstream_error",
                hint="Retry parse_document once. If it fails again, confirm the file_id and ask the user for help.",
                retryable=True,
            )

        total_chunks = len(chunks)
        sliced = chunks[offset:offset + limit]

        result_chunks = []
        for c in sliced:
            chunk_data: dict[str, Any] = {
                "type": c.chunk_type,
                "content": c.content,
                "page": c.page.page_number,
            }
            if c.heading_level:
                chunk_data["heading_level"] = c.heading_level
            if c.bbox_x0 is not None:
                chunk_data["bbox"] = [c.bbox_x0, c.bbox_y0, c.bbox_x1, c.bbox_y1]
            result_chunks.append(chunk_data)

        from apps.services.docparse.ref_builder import chunks_to_ref_blocks
        doc_refs = chunks_to_ref_blocks(sliced, file_id=file_id)

        has_more = (offset + limit) < total_chunks
        result: dict[str, Any] = {
            "success": True,
            "total_chunks": total_chunks,
            "returned": len(result_chunks),
            "offset": offset,
            "limit": limit,
            "has_more": has_more,
            "chunks": result_chunks,
            "document_refs": doc_refs,
        }
        if has_more:
            result["next_offset"] = offset + limit

        return json.dumps(result, ensure_ascii=False)


def _check_file_ownership(
    file_id: str,
    user_id: Optional[str],
    organization_id: Optional[str],
) -> dict[str, Any] | None:
    """校验 FileRecord 归属于当前用户/organization，不匹配则返回错误 dict。

    fail-closed：身份缺失时立即拒绝，不触发 DB 查询。
    """
    if not user_id and not organization_id:
        return build_tool_error(
            "Identity is required to verify file access.",
            error_kind="runtime_misconfig",
            hint="Ensure the agent runtime injects user_id or organization_id, then retry parse_document.",
            retryable=False,
        )

    from apps.services.oss.models import FileRecord

    try:
        fr = FileRecord.objects.filter(id=file_id).first()
    except Exception:
        fr = None

    if not fr:
        return build_tool_error(
            "File not found or file_id is invalid.",
            error_kind="resource_not_found",
            hint="Use the exact FileRecord UUID from the uploaded file chip, then retry parse_document.",
            retryable=False,
        )

    if user_id and fr.upload_user == user_id:
        return None

    if organization_id and fr.organization_id and fr.organization_id == organization_id:
        return None

    return build_tool_error(
        "You do not have access to this file.",
        error_kind="permission_denied",
        hint="Ask the user to grant access or upload the document in the current Space, then retry parse_document.",
        retryable=False,
    )


def _check_parse_status(file_id: str) -> dict[str, Any] | None:
    """检查解析状态，若为非 READY 则返回状态信息供 Agent 感知。"""
    from apps.services.docparse.models import ParsedDocument

    doc = ParsedDocument.objects.filter(file_record_id=file_id).first()
    if not doc:
        return None

    if doc.status == ParsedDocument.Status.PARSING:
        return build_tool_error(
            "Document is still being parsed.",
            error_kind="document_not_ready",
            hint="Wait a few seconds, then retry parse_document with the same file_id.",
            retryable=True,
            context={
                "status": "parsing",
                "parsed_pages": doc.parsed_pages,
                "total_pages": doc.total_pages,
            },
        )

    if doc.status == ParsedDocument.Status.FAILED:
        if doc.error_message:
            logger.warning("[parse_document] parse failed file_id=%s", file_id)
        return build_tool_error(
            "Document parsing failed.",
            error_kind="upstream_error",
            hint="Ask the user to re-upload the document or try a different file format, then call parse_document again.",
            retryable=False,
            context={"status": "failed"},
        )

    if doc.status == ParsedDocument.Status.PENDING:
        return build_tool_error(
            "Document is waiting to be parsed.",
            error_kind="document_not_ready",
            hint="Wait a few seconds for parsing to start, then retry parse_document with the same file_id.",
            retryable=True,
            context={"status": "pending"},
        )

    return None
