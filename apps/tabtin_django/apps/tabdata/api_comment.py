"""记录详情内部评论 API。"""

from uuid import UUID

from django.http import HttpRequest
from ninja import Router, Schema
from pydantic import Field

from apps.tabdata.api_helpers import (
    api_error_handler,
    error_response,
    permission_denied_response,
    success_response,
)
from apps.tabdata.error_codes import ErrorCode
from apps.tabdata.exceptions import RLSAccessDenied
from apps.tabdata.models import RecordComment
from apps.tabdata.schemas import ErrorResponse
from apps.tabdata.services.comment_service import RecordCommentService
from apps.tabdata.services.rls_service import RLSContext
from apps.users.auth.permissions import JWTAuth

router = Router(tags=["TabData"])
jwt_auth = JWTAuth()


class CreateRecordCommentBody(Schema):
    content: str
    client_request_id: str | None = None
    mentions: list[str] = Field(default_factory=list)
    mention_user_ids: list[str] = Field(default_factory=list)
    reply_to_comment_id: UUID | None = None


class UpdateRecordCommentThreadStatusBody(Schema):
    status: str


def _rls_denied_response():
    return permission_denied_response("行级安全策略限制了对此记录的访问")


@router.get(
    "/records/{record_id}/comment-mention-candidates",
    response={
        200: dict,
        400: ErrorResponse,
        401: ErrorResponse,
        403: ErrorResponse,
        404: ErrorResponse,
        500: ErrorResponse,
    },
    auth=jwt_auth,
    summary="获取记录评论可提及成员",
)
@api_error_handler
def list_record_comment_mention_candidates(
    request: HttpRequest,
    record_id: UUID,
    q: str = "",
    limit: int = 50,
):
    service = RecordCommentService(user=request.auth)
    try:
        candidates = service.list_mention_candidates(
            record_id,
            query=q,
            limit=limit,
            rls_context=RLSContext.from_request(request),
        )
    except RLSAccessDenied:
        return _rls_denied_response()
    return success_response({"candidates": candidates})


@router.get(
    "/tables/{table_id}/record-comment-counts",
    response={
        200: dict,
        400: ErrorResponse,
        401: ErrorResponse,
        403: ErrorResponse,
        404: ErrorResponse,
        500: ErrorResponse,
    },
    auth=jwt_auth,
    summary="批量获取记录评论数",
)
@api_error_handler
def list_record_comment_counts(
    request: HttpRequest,
    table_id: UUID,
    record_ids: str,
    status: str | None = None,
):
    service = RecordCommentService(user=request.auth)
    result = service.count_comments(
        table_id,
        record_ids=record_ids.split(","),
        status=status,
        rls_context=RLSContext.from_request(request),
    )
    return success_response(result)


@router.get(
    "/records/{record_id}/comments",
    response={
        200: dict,
        400: ErrorResponse,
        401: ErrorResponse,
        403: ErrorResponse,
        404: ErrorResponse,
        500: ErrorResponse,
    },
    auth=jwt_auth,
    summary="获取记录评论",
)
@api_error_handler
def list_record_comments(
    request: HttpRequest,
    record_id: UUID,
    status: str | None = None,
    before: str | None = None,
    cursor: str | None = None,
    anchor: UUID | None = None,
    limit: int = 50,
):
    service = RecordCommentService(user=request.auth)
    try:
        result = service.list_comments(
            record_id,
            status=status,
            before=before,
            cursor=cursor,
            anchor=anchor,
            limit=limit,
            include_audit=True,
            rls_context=RLSContext.from_request(request),
        )
    except RLSAccessDenied:
        return _rls_denied_response()
    return success_response(result)


@router.patch(
    "/records/{record_id}/comment-threads/{thread_id}/status",
    response={
        200: dict,
        400: ErrorResponse,
        401: ErrorResponse,
        403: ErrorResponse,
        404: ErrorResponse,
        500: ErrorResponse,
    },
    auth=jwt_auth,
    summary="更新记录评论线程状态",
)
@api_error_handler
def update_record_comment_thread_status(
    request: HttpRequest,
    record_id: UUID,
    thread_id: UUID,
    data: UpdateRecordCommentThreadStatusBody,
):
    service = RecordCommentService(user=request.auth)
    try:
        thread = service.update_thread_status(
            record_id,
            thread_id,
            status=data.status,
            rls_context=RLSContext.from_request(request),
        )
    except RLSAccessDenied:
        return _rls_denied_response()
    return success_response({"thread": service.serialize_thread(thread)})


@router.post(
    "/records/{record_id}/comments",
    response={
        201: dict,
        400: ErrorResponse,
        401: ErrorResponse,
        403: ErrorResponse,
        404: ErrorResponse,
        500: ErrorResponse,
    },
    auth=jwt_auth,
    summary="新增记录评论",
)
@api_error_handler
def create_record_comment(
    request: HttpRequest,
    record_id: UUID,
    data: CreateRecordCommentBody,
):
    service = RecordCommentService(user=request.auth)
    try:
        comment, created = service.create_comment(
            record_id,
            content=data.content,
            client_request_id=data.client_request_id,
            mentions=[*data.mention_user_ids, *data.mentions],
            reply_to_comment_id=data.reply_to_comment_id,
            rls_context=RLSContext.from_request(request),
        )
    except RLSAccessDenied:
        return _rls_denied_response()
    except RecordComment.DoesNotExist:
        return error_response(
            ErrorCode.NOT_FOUND,
            message="回复的评论不存在",
            status_code=404,
        )
    return 201, success_response(
        {
            "comment": service.serialize_comment(comment, include_audit=True),
            "created": created,
        }
    )


@router.delete(
    "/records/{record_id}/comments/{comment_id}",
    response={
        200: dict,
        400: ErrorResponse,
        401: ErrorResponse,
        403: ErrorResponse,
        404: ErrorResponse,
        500: ErrorResponse,
    },
    auth=jwt_auth,
    summary="删除记录评论",
)
@api_error_handler
def delete_record_comment(
    request: HttpRequest,
    record_id: UUID,
    comment_id: UUID,
):
    service = RecordCommentService(user=request.auth)
    try:
        comment = service.delete_comment(
            record_id,
            comment_id,
            rls_context=RLSContext.from_request(request),
        )
    except RLSAccessDenied:
        return _rls_denied_response()
    return success_response(
        {
            "deleted": True,
            "comment_id": str(comment.id),
            "comment": service.serialize_comment(comment, include_audit=True),
        }
    )
