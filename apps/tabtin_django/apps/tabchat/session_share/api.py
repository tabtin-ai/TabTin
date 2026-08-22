"""IM 任务共享 REST API（挂载在 /api/im/session-shares 下）。"""

from __future__ import annotations

import logging

from ninja import Router, Schema

from apps.i18n import _
from apps.tabchat.schemas import ApiResponse
from apps.chat.conversation.services import session_share_card_service
from apps.users.auth.api import jwt_auth

logger = logging.getLogger(__name__)

router = Router()


class CreateSessionShareRequest(Schema):
    session_id: str
    grantee_user_id: str
    can_fork: bool = False
    can_chat: bool = False
    conversation_id: str | None = None
    client_request_id: str | None = None
    restore_share_id: str | None = None


def _service_error(e: Exception) -> ApiResponse:
    code = 403 if isinstance(e, PermissionError) else 400
    return ApiResponse(success=False, message=str(e), code=code)


@router.post("", response=ApiResponse, auth=jwt_auth)
def create_session_share(request, payload: CreateSessionShareRequest):
    """共享会话给同 org 用户并发任务共享卡到双方 DM。

    普通分享会创建独立授权并发新卡；指定 restore_share_id 恢复已撤销卡片时，
    若已有锚点则只刷新原卡状态。
    本地共享意图已提交、但 IM 发送结果未确认时返回 503；确定性拒绝返回
    502。两者的 ``data`` 都保留共享、会话、消息和请求的稳定标识。
    """
    user = request.auth
    try:
        data = session_share_card_service.share_and_send_card(
            actor_user=user,
            session_id=payload.session_id,
            grantee_user_id=payload.grantee_user_id,
            can_fork=payload.can_fork,
            can_chat=payload.can_chat,
            authorization_header=str(
                getattr(request, "headers", {}).get("Authorization", "") or "",
            ),
            conversation_id_hint=payload.conversation_id,
            client_request_id=payload.client_request_id,
            restore_share_id=payload.restore_share_id,
        )
        return ApiResponse(data=data)
    except session_share_card_service.SessionShareDeliveryUnconfirmed as e:
        logger.warning(
            "Session share saved with unconfirmed IM delivery",
            extra={
                "share_id": e.result.get("id"),
                "tabtin_conversation_id": e.result.get("conversation_id"),
                "tabtin_message_id": e.result.get("message_id"),
                "client_request_id": e.result.get("client_request_id"),
            },
        )
        return ApiResponse(
            success=False,
            message=str(e),
            data=e.result,
            code=503,
        )
    except session_share_card_service.SessionShareDeliveryRejected as e:
        logger.error(
            "Session share saved with rejected IM delivery",
            extra={
                "share_id": e.result.get("id"),
                "tabtin_conversation_id": e.result.get("conversation_id"),
                "tabtin_message_id": e.result.get("message_id"),
                "client_request_id": e.result.get("client_request_id"),
            },
        )
        return ApiResponse(
            success=False,
            message=str(e),
            data=e.result,
            code=502,
        )
    except (ValueError, PermissionError) as e:
        return _service_error(e)
    except Exception:
        logger.exception("Failed to create session share")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.get("", response=ApiResponse, auth=jwt_auth)
def list_session_shares(
    request,
    peer_user_id: str | None = None,
    session_id: str | None = None,
    organization_id: str | None = None,
):
    """列出会话共享，两种口径二选一：

    - ``peer_user_id``：我与某对端之间的双向共享（DM「共享对话」面板）；
    - ``session_id``：某会话的全部共享行（会话头部协作区，仅 owner）。

    两种口径都只返回当前用户有权参与的行；含 revoked。
    """
    user = request.auth
    try:
        if bool(peer_user_id) == bool(session_id):
            return ApiResponse(
                success=False,
                message="peer_user_id 与 session_id 必须且只能传一个",
                code=400,
            )
        if session_id:
            data = session_share_card_service.list_shares_for_session(
                owner_user=user, session_id=session_id,
            )
        else:
            data = session_share_card_service.list_shares_with_peer(
                viewer_user=user,
                peer_user_id=peer_user_id,
                organization_id=organization_id,
            )
        return ApiResponse(data={"shares": data})
    except (ValueError, PermissionError) as e:
        return _service_error(e)
    except Exception:
        logger.exception("Failed to list session shares")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.get("/{share_id}", response=ApiResponse, auth=jwt_auth)
def get_session_share(request, share_id: str):
    """共享详情（owner 或 grantee 可见），附双方展示名供卡片渲染。"""
    user = request.auth
    try:
        data = session_share_card_service.get_share_detail(
            viewer_user=user, share_id=share_id,
        )
        return ApiResponse(data=data)
    except (ValueError, PermissionError) as e:
        return _service_error(e)
    except Exception:
        logger.exception("Failed to get session share")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.post("/{share_id}/revoke", response=ApiResponse, auth=jwt_auth)
def revoke_session_share(request, share_id: str):
    """owner 撤销共享（幂等）；卡片状态刷新为 revoked 并广播。"""
    user = request.auth
    try:
        data = session_share_card_service.revoke_and_refresh_card(
            actor_user=user, share_id=share_id,
        )
        return ApiResponse(data=data)
    except session_share_card_service.SessionShareResourceRevokeError as e:
        logger.exception("Failed to revoke session-share resource ACL")
        return ApiResponse(success=False, message=str(e), code=500)
    except (ValueError, PermissionError) as e:
        return _service_error(e)
    except Exception:
        logger.exception("Failed to revoke session share")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)
