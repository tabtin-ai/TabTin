"""资源访问申请 REST API（正典挂载在 /api/resource-access-requests）。"""

from __future__ import annotations

import logging

from ninja import Router, Schema

from apps.i18n import _
from apps.services.common.resource_access.service import (
    ResourceAccessRequestError,
    ResourceAccessRequestService,
)
from apps.tabchat.schemas import ApiResponse
from apps.users.auth.api import jwt_auth

logger = logging.getLogger(__name__)

router = Router()


class CreateResourceAccessRequest(Schema):
    # 可加性：旧 IM 卡客户端继续必传会话 + 消息；工具栏申请 editor 可省略来源。
    source_conversation_id: str | None = None
    # 旧客户端继续传 Django Message.id；新客户端改传稳定 message_ref。
    source_message_id: int | None = None
    source_message_ref: str | None = None
    resource_type: str
    resource_id: str
    # 缺省 viewer，保持  IM 卡契约；工具栏传 editor。
    role: str | None = None
    # 权限不足空状态的直达申请；服务端仍校验申请人属于资源所在组织。
    source_surface: str | None = None


def _error_response(exc: ResourceAccessRequestError) -> ApiResponse:
    return ApiResponse(
        success=False,
        message=exc.message,
        code=exc.status,
        data={"error_code": exc.code},
    )


@router.post("", response=ApiResponse, auth=jwt_auth)
def create_resource_access_request(request, payload: CreateResourceAccessRequest):
    """申请资源访问（viewer / editor）；已有同级或更高级 pending 时幂等返回。"""
    user = request.auth
    try:
        data = ResourceAccessRequestService.create_request(
            requester=user,
            authorization_header=str(
                getattr(request, "META", {}).get("HTTP_AUTHORIZATION", "") or ""
            ),
            source_conversation_id=payload.source_conversation_id,
            source_message_id=payload.source_message_id,
            source_message_ref=payload.source_message_ref,
            resource_type=payload.resource_type,
            resource_id=payload.resource_id,
            role=payload.role,
            source_surface=payload.source_surface,
        )
        return ApiResponse(data=data)
    except ResourceAccessRequestError as exc:
        return _error_response(exc)
    except Exception:
        logger.exception("Failed to create resource access request")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.post("/{request_id}/approve", response=ApiResponse, auth=jwt_auth)
def approve_resource_access_request(request, request_id: str):
    """资源 owner 批准申请；锁行后按申请 role 授予权限，幂等。"""
    user = request.auth
    try:
        data = ResourceAccessRequestService.approve_request(
            actor=user,
            request_id=request_id,
        )
        return ApiResponse(data=data)
    except ResourceAccessRequestError as exc:
        return _error_response(exc)
    except Exception:
        logger.exception("Failed to approve resource access request")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)
