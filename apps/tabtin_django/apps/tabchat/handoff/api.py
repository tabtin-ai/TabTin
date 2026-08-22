"""IM 上下文交接 REST API（挂载在 /api/im/handoffs 下）。"""

from __future__ import annotations

import logging

from ninja import Router, Schema

from apps.i18n import _
from apps.tabchat.handoff.service import HandoffService
from apps.tabchat.schemas import ApiResponse
from apps.users.auth.api import jwt_auth

logger = logging.getLogger(__name__)

router = Router()


class HandoffReferenceIn(Schema):
    ref_type: str
    resource_id: str
    title_snapshot: str = ""
    summary_snapshot: str = ""
    source_link: dict | None = None


class CreateHandoffRequest(Schema):
    conversation_id: str
    goal: str
    progress: list[dict] | None = None
    next_steps: list[dict] | None = None
    risks: list[dict] | None = None
    scope: str = "continuable"
    recipients: list[str]
    references: list[HandoffReferenceIn] | None = None
    send: bool = True


class HandoffActionRequest(Schema):
    action: str
    note: str = ""


class TakeOverSessionRequest(Schema):
    agent_id: str
    workspace_id: str


def _service_error(e: Exception) -> ApiResponse:
    code = 403 if isinstance(e, PermissionError) else 400
    return ApiResponse(success=False, message=str(e), code=code)


@router.post("", response=ApiResponse, auth=jwt_auth)
def create_handoff(request, payload: CreateHandoffRequest):
    """创建交接包（默认创建后立即发送到会话）。"""
    user = request.auth
    try:
        package = HandoffService.create_package(
            conversation_id=payload.conversation_id,
            actor_user_id=str(user.id),
            goal=payload.goal,
            progress=payload.progress,
            next_steps=payload.next_steps,
            risks=payload.risks,
            scope=payload.scope,
            recipients=payload.recipients,
            references=[r.dict() for r in (payload.references or [])],
            authorization_header=request.headers.get("Authorization", ""),
        )
        if payload.send:
            package = HandoffService.send_package(
                package_id=str(package.id), actor_user_id=str(user.id),
            )
        return ApiResponse(
            data=HandoffService.serialize_package(package, viewer_user_id=str(user.id)),
        )
    except (ValueError, PermissionError) as e:
        return _service_error(e)
    except Exception:
        logger.exception("Failed to create handoff")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.post("/{handoff_id}/send", response=ApiResponse, auth=jwt_auth)
def send_handoff(request, handoff_id: str):
    """发送草稿交接包（幂等）。"""
    user = request.auth
    try:
        package = HandoffService.send_package(
            package_id=handoff_id, actor_user_id=str(user.id),
        )
        return ApiResponse(
            data=HandoffService.serialize_package(package, viewer_user_id=str(user.id)),
        )
    except (ValueError, PermissionError) as e:
        return _service_error(e)
    except Exception:
        logger.exception("Failed to send handoff")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.get("/{handoff_id}", response=ApiResponse, auth=jwt_auth)
def get_handoff(request, handoff_id: str):
    """交接包详情（会话成员可看；接收者首次打开记 viewed）。"""
    user = request.auth
    try:
        data = HandoffService.get_package(
            package_id=handoff_id, viewer_user_id=str(user.id),
        )
        return ApiResponse(data=data)
    except (ValueError, PermissionError) as e:
        return _service_error(e)
    except Exception:
        logger.exception("Failed to get handoff")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.get("", response=ApiResponse, auth=jwt_auth)
def list_handoffs(request, conversation_id: str):
    """会话内交接包列表（最新在前，不含材料明细）。"""
    user = request.auth
    try:
        items = HandoffService.list_packages(
            conversation_id=conversation_id, viewer_user_id=str(user.id),
            authorization_header=request.headers.get("Authorization", ""),
        )
        return ApiResponse(data={"items": items})
    except (ValueError, PermissionError) as e:
        return _service_error(e)
    except Exception:
        logger.exception("Failed to list handoffs")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.post("/{handoff_id}/actions", response=ApiResponse, auth=jwt_auth)
def act_on_handoff(request, handoff_id: str, payload: HandoffActionRequest):
    """接收者动作：acknowledge / take_over / reject（带可选备注）。"""
    user = request.auth
    try:
        data = HandoffService.act(
            package_id=handoff_id,
            actor_user_id=str(user.id),
            action=payload.action,
            note=payload.note,
        )
        return ApiResponse(data=data)
    except (ValueError, PermissionError) as e:
        return _service_error(e)
    except Exception:
        logger.exception("Failed to act on handoff")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.post("/{handoff_id}/take-over-session", response=ApiResponse, auth=jwt_auth)
def take_over_handoff_session(request, handoff_id: str, payload: TakeOverSessionRequest):
    """接手交接并建会话：冻结快照物化成接收人自己的 Agent × Workspace 新会话。

    响应 data 对齐 shared-fork：ChatSessionSchema（前端可直接进入该会话）。
    幂等：linked_session_id 已指向本人仍存在的会话时直接返回，不重复建。
    """
    # conversation api 聚合模块较重且 tabchat.api 会在装载期挂本 router，
    # 相关依赖仅在请求时导入，避免 app 装载顺序问题。
    from apps.chat.conversation.api._common import (
        _session_to_schema,
        _visible_message_count,
    )
    from apps.chat.conversation.services.execution_target import ExecutionTargetError

    user = request.auth
    try:
        session = HandoffService.take_over_session(
            package_id=handoff_id,
            actor_user_id=str(user.id),
            agent_id=payload.agent_id,
            workspace_id=payload.workspace_id,
        )
        return ApiResponse(
            data=_session_to_schema(
                session, message_count=_visible_message_count(session),
            ).model_dump(mode="json"),
        )
    except ExecutionTargetError as e:
        # 归属校验失败带自己的 status_code（400 / 403），不走 _service_error 粗分
        return ApiResponse(success=False, message=str(e), code=e.status_code)
    except (ValueError, PermissionError) as e:
        return _service_error(e)
    except Exception:
        logger.exception("Failed to take over handoff session")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.get("/{handoff_id}/transcript", response=ApiResponse, auth=jwt_auth)
def get_handoff_transcript(request, handoff_id: str):
    """交接包完整冻结对话快照（Agent runtime 拉取用，不截断）。"""
    user = request.auth
    try:
        data = HandoffService.get_full_transcript(
            package_id=handoff_id, viewer_user_id=str(user.id),
        )
        return ApiResponse(data=data)
    except (ValueError, PermissionError) as e:
        return _service_error(e)
    except Exception:
        logger.exception("Failed to get handoff transcript")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.post("/{handoff_id}/revoke", response=ApiResponse, auth=jwt_auth)
def revoke_handoff(request, handoff_id: str):
    """发起人撤销交接包（卡片保留，材料入口失效）。"""
    user = request.auth
    try:
        package = HandoffService.revoke(
            package_id=handoff_id, actor_user_id=str(user.id),
        )
        return ApiResponse(
            data=HandoffService.serialize_package(package, viewer_user_id=str(user.id)),
        )
    except (ValueError, PermissionError) as e:
        return _service_error(e)
    except Exception:
        logger.exception("Failed to revoke handoff")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)
