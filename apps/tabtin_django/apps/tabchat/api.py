"""TabChat REST API。

所有端点统一挂载在 /api/im/ 下。
"""

from __future__ import annotations

import logging

from ninja import Query, Router

from apps.i18n import _
from apps.users.auth.api import jwt_auth
from apps.services.oss.services.public_assets import build_public_asset_url
from apps.services.billing.services.entitlement_limits_service import EntitlementLimitExceeded
from django.contrib.auth import get_user_model

from apps.tabchat.schemas import (
    AddAgentsRequest,
    AddLabelsRequest,
    AddMembersRequest,
    AcceptExternalContactRequest,
    BindConversationAgentWorkspaceRequest,
    ApiResponse,
    BatchUsersRequest,
    ConversationMuteRequest,
    ConversationPinRequest,
    ConversationDetailOut,
    ConversationOut,
    CreateDMRequest,
    CreateExternalContactInvitationRequest,
    CreateAgentTaskFromMessageRequest,
    CreateGroupRequest,
    CreateSpaceChannelRequest,
    CreateLabelRequest,
    DiscoverExternalContactRequest,
    EditMessageRequest,
    MarkReadRequest,
    MessageOut,
    MessageUserStateRequest,
    ReactionRequest,
    ResolveMessageReferencesRequest,
    SendMessageRequest,
    UnreadCountOut,
    UpdateConversationAgentWorkspaceRequest,
    UpdateConversationRequest,
    UpdateExternalContactInvitationRequest,
    UpdateExternalContactRequest,
    UpdateLabelRequest,
)
from apps.tabtinspace.models import OrganizationMember
from apps.tabchat.services.conversation_service import ConversationService
from apps.tabchat.services.external_contact_service import (
    ExternalContactResolver,
    ExternalContactService,
)
from apps.tabchat.services.profile_sync_service import avatar_version
from apps.tabchat.services.message_service import (
    MessageService,
    resolve_resource_card_preview,
)
from apps.tabchat.services.team_space_task_service import (
    create_agent_task_thread_from_channel_message,
)

User = get_user_model()

logger = logging.getLogger(__name__)

router = Router()
# 开源 / Django IM 主链路把消息数据面重新挂回公开 router。
legacy_message_router = router


def _check_organization_access(user_id: str, organization_id: str) -> ApiResponse | None:
    """校验用户是否为 organization 成员（含 owner）。通过返回 None，失败返回 403 ApiResponse。"""
    from apps.tabchat.utils import is_organization_member

    if not is_organization_member(organization_id, user_id):
        return ApiResponse(success=False, message=_("tabchat.no_organization_access"), code=403)
    return None


def _business_error_response(error: Exception) -> ApiResponse:
    """保留旧错误 envelope，同时为新客户端提供稳定业务码。"""
    status_code = 403 if isinstance(error, PermissionError) else 400
    error_code = getattr(error, "error_code", "")
    data = {"error_code": error_code} if error_code else None
    return ApiResponse(success=False, message=str(error), code=status_code, data=data)


# ── 会话管理 ──


@router.post("/conversations/dm", response=ApiResponse, auth=jwt_auth)
def create_dm(request, payload: CreateDMRequest):
    """创建或获取 DM 会话。"""
    user = request.auth
    if err := _check_organization_access(str(user.id), payload.organization_id):
        return err
    try:
        if payload.external_contact_id:
            conv = ConversationService.create_external_dm(
                organization_id=payload.organization_id,
                creator_id=str(user.id),
                external_contact_id=payload.external_contact_id,
            )
        else:
            if not payload.other_user_id:
                return ApiResponse(success=False, message="缺少私信对象", code=400)
            conv = ConversationService.create_dm(
                organization_id=payload.organization_id,
                creator_id=str(user.id),
                other_user_id=payload.other_user_id,
            )
        return ApiResponse(data={"conversation_id": str(conv.id)})
    except EntitlementLimitExceeded as e:
        data = {"error_code": e.code, **e.to_response_data()}
        return ApiResponse(success=False, message=str(e), code=403, data=data)
    except (ValueError, PermissionError) as e:
        code = 403 if isinstance(e, PermissionError) else 400
        return ApiResponse(success=False, message=str(e), code=code)
    except Exception as e:
        logger.exception("Failed to create DM")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.post("/conversations/group", response=ApiResponse, auth=jwt_auth)
def create_group(request, payload: CreateGroupRequest):
    """创建群聊。"""
    user = request.auth
    if err := _check_organization_access(str(user.id), payload.organization_id):
        return err
    try:
        conv = ConversationService.create_group(
            organization_id=payload.organization_id,
            creator_id=str(user.id),
            name=payload.name,
            member_ids=payload.member_ids,
            avatar_url=payload.avatar_url,
            space_id=payload.space_id,
            external_contact_ids=payload.external_contact_ids,
            client_request_id=payload.client_request_id,
        )
        return ApiResponse(data={"conversation_id": str(conv.id)})
    except EntitlementLimitExceeded as e:
        data = {"error_code": e.code, **e.to_response_data()}
        return ApiResponse(success=False, message=str(e), code=403, data=data)
    except (ValueError, PermissionError) as e:
        return _business_error_response(e)
    except Exception as e:
        logger.exception("Failed to create group")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.get("/external-contacts", response=ApiResponse, auth=jwt_auth)
def list_external_contacts(request, organization_id: str = Query(...)):
    """列出当前用户的外部联系人关系；调用方按 relationship 判断可用能力。"""
    user = request.auth
    if err := _check_organization_access(str(user.id), organization_id):
        return err
    try:
        return ApiResponse(
            data={
                "items": ExternalContactResolver.list_for_user(
                    str(user.id),
                    organization_id,
                ),
            },
        )
    except Exception:
        logger.exception("Failed to list external contacts")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.post("/external-contacts/discover", response=ApiResponse, auth=jwt_auth)
def discover_external_contact(request, payload: DiscoverExternalContactRequest):
    user = request.auth
    if err := _check_organization_access(str(user.id), payload.organization_id):
        return err
    try:
        return ApiResponse(data=ExternalContactService.discover(
            str(user.id),
            payload.organization_id,
            payload.phone,
        ))
    except (ValueError, PermissionError) as error:
        return _business_error_response(error)
    except Exception:
        logger.exception("Failed to discover external contact")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.post("/external-contact-invitations", response=ApiResponse, auth=jwt_auth)
def create_external_contact_invitation(
    request,
    payload: CreateExternalContactInvitationRequest,
):
    user = request.auth
    if err := _check_organization_access(str(user.id), payload.organization_id):
        return err
    try:
        return ApiResponse(data=ExternalContactService.invite(
            str(user.id),
            payload.organization_id,
            payload.target_user_id,
            payload.note or "",
        ), code=201)
    except (ValueError, PermissionError) as error:
        return _business_error_response(error)
    except Exception:
        logger.exception("Failed to create external contact invitation")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.get("/external-contact-invitations", response=ApiResponse, auth=jwt_auth)
def list_external_contact_invitations(
    request,
    organization_id: str = Query(...),
    direction: str | None = Query(None),
    status: str | None = Query(None),
):
    user = request.auth
    if err := _check_organization_access(str(user.id), organization_id):
        return err
    try:
        return ApiResponse(data={
            "items": ExternalContactService.list_invitations(
                str(user.id),
                direction=direction,
                status=status,
            ),
        })
    except Exception:
        logger.exception("Failed to list external contact invitations")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.post("/external-contacts/accept", response=ApiResponse, auth=jwt_auth)
def accept_external_contact(request, payload: AcceptExternalContactRequest):
    user = request.auth
    if err := _check_organization_access(str(user.id), payload.organization_id):
        return err
    try:
        return ApiResponse(data=ExternalContactService.accept(
            str(user.id),
            payload.organization_id,
            payload.invite_code,
        ))
    except (ValueError, PermissionError) as error:
        return _business_error_response(error)
    except Exception:
        logger.exception("Failed to accept external contact")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.patch(
    "/external-contact-invitations/{invitation_id}",
    response=ApiResponse,
    auth=jwt_auth,
)
def update_external_contact_invitation(
    request,
    invitation_id: str,
    payload: UpdateExternalContactInvitationRequest,
):
    user = request.auth
    if err := _check_organization_access(str(user.id), payload.organization_id):
        return err
    try:
        return ApiResponse(data=ExternalContactService.resolve_invitation(
            str(user.id),
            invitation_id,
            payload.action,
        ))
    except (ValueError, PermissionError) as error:
        return _business_error_response(error)
    except Exception:
        logger.exception("Failed to update external contact invitation")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.patch("/external-contacts/{contact_id}", response=ApiResponse, auth=jwt_auth)
def update_external_contact(
    request,
    contact_id: str,
    payload: UpdateExternalContactRequest,
):
    user = request.auth
    if err := _check_organization_access(str(user.id), payload.organization_id):
        return err
    try:
        return ApiResponse(data=ExternalContactService.update_contact(
            str(user.id),
            payload.organization_id,
            contact_id,
            payload.action,
        ))
    except (ValueError, PermissionError) as error:
        return _business_error_response(error)
    except Exception:
        logger.exception("Failed to update external contact")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.post("/spaces/{space_id}/channels", response=ApiResponse, auth=jwt_auth)
def create_space_channel(request, space_id: str, payload: CreateSpaceChannelRequest):
    """在团队 Space 内创建讨论频道。频道成员边界继承 SpaceMembership。"""
    user = request.auth
    if err := _check_organization_access(str(user.id), payload.organization_id):
        return err
    try:
        conv = ConversationService.create_space_channel(
            organization_id=payload.organization_id,
            space_id=space_id,
            creator_id=str(user.id),
            name=payload.name,
        )
        return ApiResponse(data={"conversation_id": str(conv.id)}, code=201)
    except (ValueError, PermissionError) as e:
        code = 403 if isinstance(e, PermissionError) else 400
        return ApiResponse(success=False, message=str(e), code=code)
    except Exception:
        logger.exception("Failed to create space channel")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.patch("/spaces/{space_id}/channels/{conversation_id}", response=ApiResponse, auth=jwt_auth)
def rename_space_channel(
    request,
    space_id: str,
    conversation_id: str,
    payload: UpdateConversationRequest,
):
    """重命名团队 Space 频道。仅 Space owner 可操作。"""
    user = request.auth
    if payload.name is None:
        return ApiResponse(success=False, message="频道名称不能为空", code=400)
    try:
        conv = ConversationService.rename_space_channel(
            space_id=space_id,
            conversation_id=conversation_id,
            user_id=str(user.id),
            name=payload.name,
        )
        if conv is None:
            return ApiResponse(success=False, message=_("tabchat.session_not_found"), code=404)
        return ApiResponse(message=_("tabchat.update_success"))
    except (ValueError, PermissionError) as e:
        code = 403 if isinstance(e, PermissionError) else 400
        return ApiResponse(success=False, message=str(e), code=code)
    except ValueError as e:
        return ApiResponse(success=False, message=str(e), code=400)
    except Exception:
        logger.exception("Failed to rename space channel")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.post("/spaces/{space_id}/channels/{conversation_id}/archive", response=ApiResponse, auth=jwt_auth)
def archive_space_channel(request, space_id: str, conversation_id: str):
    """归档团队 Space 频道。历史保留，不提供硬删除。"""
    user = request.auth
    try:
        archived = ConversationService.archive_space_channel(
            space_id,
            conversation_id,
            str(user.id),
        )
        if not archived:
            return ApiResponse(success=False, message=_("tabchat.session_not_found"), code=404)
        return ApiResponse(message=_("tabchat.update_success"))
    except PermissionError as e:
        return ApiResponse(success=False, message=str(e), code=403)
    except ValueError as e:
        return ApiResponse(success=False, message=str(e), code=400)
    except Exception:
        logger.exception("Failed to archive space channel")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.get("/conversations", response=ApiResponse, auth=jwt_auth)
def list_conversations(
    request,
    organization_id: str = Query(...),
    label_ids: str | None = Query(None),
):
    """获取会话列表（含未读数、label）。

    TC-37：label_ids 非空时按 label AND 筛选，逗号分隔，支持系统 label sys:mention。
    """
    user = request.auth
    if err := _check_organization_access(str(user.id), organization_id):
        return err
    parsed_label_ids = [
        lid.strip() for lid in (label_ids or "").split(",") if lid.strip()
    ] if label_ids else None
    try:
        conversations = ConversationService.list_conversations(
            organization_id=organization_id,
            user_id=str(user.id),
            label_ids=parsed_label_ids,
        )
        return ApiResponse(data=conversations)
    except Exception as e:
        logger.exception("Failed to list conversations")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.get("/conversations/{conversation_id}", response=ApiResponse, auth=jwt_auth)
def get_conversation(request, conversation_id: str):
    """获取会话详情（含成员列表）。"""
    user = request.auth
    try:
        detail = ConversationService.get_conversation_detail(
            conversation_id=conversation_id,
            user_id=str(user.id),
        )
        if detail is None:
            return ApiResponse(success=False, message=_("tabchat.session_not_found_or_no_access"), code=404)
        return ApiResponse(data=detail)
    except Exception as e:
        logger.exception("Failed to get conversation detail")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.get("/conversations/{conversation_id}/history-state", response=ApiResponse, auth=jwt_auth)
def get_conversation_history_state(request, conversation_id: str):
    """返回当前用户的个人历史可见性水位，供移动端在订阅实时流前建立过滤栅栏。"""
    user = request.auth
    try:
        cleared_seq = ConversationService.get_history_cleared_seq(conversation_id, str(user.id))
        return ApiResponse(data={"history_cleared_seq": cleared_seq})
    except (ValueError, PermissionError) as e:
        code = 403 if isinstance(e, PermissionError) else 400
        return ApiResponse(success=False, message=str(e), code=code)
    except Exception:
        logger.exception("Failed to get conversation history state")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.post(
    "/conversations/{conversation_id}/messages/{message_id}/agent-task",
    response=ApiResponse,
    auth=jwt_auth,
)
def create_agent_task_from_message(
    request,
    conversation_id: str,
    message_id: int,
    payload: CreateAgentTaskFromMessageRequest,
):
    """从团队 Space 频道消息询问 Agent。"""
    user = request.auth
    try:
        result = create_agent_task_thread_from_channel_message(
            conversation_id=conversation_id,
            message_id=message_id,
            actor_user=user,
            additional_context=payload.additional_context,
            agent_id=payload.agent_id,
        )
        from apps.chat.conversation.api._common import _session_to_schema
        from apps.chat.conversation.models import ChatContext

        # 会话显式挂执行 Workspace + 协作 Project；旧 Context 仅作历史回退。
        collaboration_space_id = result.session.project_id
        try:
            ctx = ChatContext.objects.filter(session=result.session).only("current_project_id").first()
            collaboration_space_id = collaboration_space_id or (ctx.current_project_id if ctx else None)
        except Exception:
            collaboration_space_id = None

        session_schema = _session_to_schema(
            result.session,
            message_count=0,
            is_reverted=False,
            revert_snapshot_hash=None,
        ).model_dump(mode="json")
        if collaboration_space_id:
            # 过渡期 wire scope 对团队侧栏仍表示协作场 Project，不是执行 Workspace。
            session_schema["project_id"] = str(collaboration_space_id)
            session_schema["space_id"] = str(collaboration_space_id)

        #  / ：频道消息升级 Agent 任务新建的是责任人私有执行会话，
        # 不得再向其他 Project 成员广播完整 session schema/id。共享面走 Task /
        # 评论 / 呈递结果通道；会话列表恢复靠按用户过滤的 sessions.list。

        return ApiResponse(
            data={
                "session_id": str(result.session.id),
                "thread_id": result.session.thread_id,
                "space_id": str(collaboration_space_id or result.session.workspace_id or ""),
                "workspace_id": str(result.session.workspace_id) if result.session.workspace_id else None,
                "organization_id": str(result.session.organization_id),
                "title": result.session.title,
                "session": session_schema,
                "default_prompt": result.prompt,
                "source_message_ids": result.source_message_ids,
            },
            code=201,
        )
    except PermissionError as e:
        return _business_error_response(e)
    except ValueError as e:
        return _business_error_response(e)
    except Exception:
        logger.exception("Failed to create Team Space Agent task from IM message")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.patch("/conversations/{conversation_id}", response=ApiResponse, auth=jwt_auth)
def update_conversation(request, conversation_id: str, payload: UpdateConversationRequest):
    """更新群聊信息（名称、头像）。"""
    user = request.auth
    try:
        kwargs = {}
        if payload.name is not None:
            kwargs["name"] = payload.name
        if payload.avatar_url is not None:
            kwargs["avatar_url"] = payload.avatar_url

        conv = ConversationService.update_conversation(
            conversation_id=conversation_id,
            user_id=str(user.id),
            **kwargs,
        )
        if conv is None:
            return ApiResponse(success=False, message=_("tabchat.session_not_found"), code=404)
        return ApiResponse(message=_("tabchat.update_success"))
    except PermissionError as e:
        return ApiResponse(success=False, message=str(e), code=403)
    except ValueError as e:
        return ApiResponse(success=False, message=str(e), code=400)
    except Exception as e:
        logger.exception("Failed to update conversation")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


# ── 会话偏好（置顶/免打扰） ──


@router.post("/conversations/{conversation_id}/pin", response=ApiResponse, auth=jwt_auth)
def toggle_pin(
    request,
    conversation_id: str,
    payload: ConversationPinRequest | None = None,
):
    """设置会话置顶；旧客户端不传请求体时继续按切换处理。"""
    user = request.auth
    try:
        pinned = ConversationService.toggle_pinned(
            conversation_id,
            str(user.id),
            pinned=payload.pinned if payload is not None else None,
        )
        return ApiResponse(data={"pinned": pinned})
    except (ValueError, PermissionError) as e:
        code = 403 if isinstance(e, PermissionError) else 400
        return ApiResponse(success=False, message=str(e), code=code)
    except Exception as e:
        logger.exception("Failed to toggle pin")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.post("/conversations/{conversation_id}/mute", response=ApiResponse, auth=jwt_auth)
def toggle_mute(
    request,
    conversation_id: str,
    payload: ConversationMuteRequest | None = None,
):
    """设置会话免打扰；旧客户端不传请求体时继续按切换处理。"""
    user = request.auth
    try:
        muted = ConversationService.toggle_muted(
            conversation_id,
            str(user.id),
            muted=payload.muted if payload is not None else None,
        )
        return ApiResponse(data={"muted": muted})
    except (ValueError, PermissionError) as e:
        code = 403 if isinstance(e, PermissionError) else 400
        return ApiResponse(success=False, message=str(e), code=code)
    except Exception as e:
        logger.exception("Failed to toggle mute")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.post("/conversations/{conversation_id}/clear-history", response=ApiResponse, auth=jwt_auth)
def clear_history(request, conversation_id: str):
    """清空聊天记录（只清自己侧，不影响其他成员）。"""
    user = request.auth
    try:
        cleared_seq = ConversationService.clear_history(conversation_id, str(user.id))
        return ApiResponse(
            message=_("tabchat.update_success"),
            data={"cleared_seq": cleared_seq},
        )
    except (ValueError, PermissionError) as e:
        code = 403 if isinstance(e, PermissionError) else 400
        return ApiResponse(success=False, message=str(e), code=code)
    except Exception:
        logger.exception("Failed to clear history")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.post("/conversations/{conversation_id}/leave", response=ApiResponse, auth=jwt_auth)
def leave_conversation(request, conversation_id: str):
    """退出群聊（群主自动转让 / 最后一人直接退）。"""
    user = request.auth
    try:
        ok = ConversationService.leave_conversation(conversation_id, str(user.id))
        if not ok:
            return ApiResponse(success=False, message=_("tabchat.session_not_found"), code=404)
        return ApiResponse(message=_("tabchat.update_success"))
    except (ValueError, PermissionError) as e:
        code = 403 if isinstance(e, PermissionError) else 400
        return ApiResponse(success=False, message=str(e), code=code)
    except Exception:
        logger.exception("Failed to leave conversation")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


# ── 成员管理 ──


@router.post("/conversations/{conversation_id}/members", response=ApiResponse, auth=jwt_auth)
def add_members(request, conversation_id: str, payload: AddMembersRequest):
    """添加成员到群聊。"""
    user = request.auth
    try:
        external_contacts = ExternalContactResolver.resolve_for_group(
            str(user.id),
            payload.external_contact_ids,
        )
        added = ConversationService.add_members(
            conversation_id=conversation_id,
            operator_id=str(user.id),
            member_ids=payload.member_ids,
            external_contacts=external_contacts,
        )
        external_contact_by_user = {
            contact.peer_user_id: contact.contact_id
            for contact in external_contacts
        }
        return ApiResponse(data={
            "added_user_ids": [
                user_id for user_id in added
                if user_id not in external_contact_by_user
            ],
            "added_external_contact_ids": [
                external_contact_by_user[user_id]
                for user_id in added
                if user_id in external_contact_by_user
            ],
        })
    except (ValueError, PermissionError) as e:
        code = 403 if isinstance(e, PermissionError) else 400
        return ApiResponse(success=False, message=str(e), code=code)
    except Exception as e:
        logger.exception("Failed to add members")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.post("/conversations/{conversation_id}/agents", response=ApiResponse, auth=jwt_auth)
def add_agents(request, conversation_id: str, payload: AddAgentsRequest):
    """把 AI Agent 加入群聊（TC-8）。"""
    user = request.auth
    try:
        added = ConversationService.add_agents(
            conversation_id=conversation_id,
            operator_id=str(user.id),
            agent_ids=payload.agent_ids,
        )
        return ApiResponse(data={"added_agent_ids": added})
    except (ValueError, PermissionError) as e:
        return _business_error_response(e)
    except Exception:
        logger.exception("Failed to add agents")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.delete(
    "/conversations/{conversation_id}/agents/{agent_id}",
    response=ApiResponse,
    auth=jwt_auth,
)
def remove_agent(request, conversation_id: str, agent_id: str):
    """把 AI Agent 移出群聊（TC-8）。"""
    user = request.auth
    try:
        removed = ConversationService.remove_agent(
            conversation_id=conversation_id,
            operator_id=str(user.id),
            agent_id=agent_id,
        )
        if not removed:
            return ApiResponse(success=False, message=_("tabchat.member_not_found"), code=404)
        return ApiResponse(message=_("tabchat.operation_success"))
    except (ValueError, PermissionError) as e:
        code = 403 if isinstance(e, PermissionError) else 400
        return ApiResponse(success=False, message=str(e), code=code)
    except Exception:
        logger.exception("Failed to remove agent")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.get(
    "/conversations/{conversation_id}/agent-bindings",
    response=ApiResponse,
    auth=jwt_auth,
)
def list_agent_bindings(request, conversation_id: str):
    """列出普通群聊里 Agent 的执行现场绑定。"""
    from apps.tabchat.services.conversation_agent_workspace_service import (
        ConversationAgentWorkspaceService,
    )

    user = request.auth
    try:
        items = ConversationAgentWorkspaceService.list_bindings(
            conversation_id,
            str(user.id),
        )
        return ApiResponse(data={"items": items})
    except (ValueError, PermissionError) as e:
        code = 403 if isinstance(e, PermissionError) else 400
        return ApiResponse(success=False, message=str(e), code=code)
    except Exception:
        logger.exception("Failed to list agent bindings")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.post(
    "/conversations/{conversation_id}/agent-bindings",
    response=ApiResponse,
    auth=jwt_auth,
)
def create_agent_binding(
    request,
    conversation_id: str,
    payload: BindConversationAgentWorkspaceRequest,
):
    """加入自己的 Agent 并绑定执行现场。"""
    from apps.tabchat.services.conversation_agent_workspace_service import (
        ConversationAgentWorkspaceService,
    )

    user = request.auth
    try:
        binding = ConversationAgentWorkspaceService.bind_agent(
            conversation_id,
            str(user.id),
            payload.agent_id,
            payload.workspace_id,
        )
        return ApiResponse(data=binding)
    except (ValueError, PermissionError) as e:
        code = 403 if isinstance(e, PermissionError) else 400
        return ApiResponse(success=False, message=str(e), code=code)
    except Exception:
        logger.exception("Failed to create agent binding")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.patch(
    "/conversations/{conversation_id}/agent-bindings/{agent_id}",
    response=ApiResponse,
    auth=jwt_auth,
)
def update_agent_binding(
    request,
    conversation_id: str,
    agent_id: str,
    payload: UpdateConversationAgentWorkspaceRequest,
):
    """主人更换已入群 Agent 的执行现场。"""
    from apps.tabchat.services.conversation_agent_workspace_service import (
        ConversationAgentWorkspaceService,
    )

    user = request.auth
    try:
        binding = ConversationAgentWorkspaceService.update_binding(
            conversation_id,
            str(user.id),
            agent_id,
            payload.workspace_id,
        )
        return ApiResponse(data=binding)
    except (ValueError, PermissionError) as e:
        code = 403 if isinstance(e, PermissionError) else 400
        return ApiResponse(success=False, message=str(e), code=code)
    except Exception:
        logger.exception("Failed to update agent binding")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.delete(
    "/conversations/{conversation_id}/agent-bindings/{agent_id}",
    response=ApiResponse,
    auth=jwt_auth,
)
def delete_agent_binding(request, conversation_id: str, agent_id: str):
    """移出 Agent 并删除执行现场绑定。"""
    from apps.tabchat.services.conversation_agent_workspace_service import (
        ConversationAgentWorkspaceService,
    )

    user = request.auth
    try:
        removed = ConversationAgentWorkspaceService.unbind_agent(
            conversation_id,
            str(user.id),
            agent_id,
        )
        if not removed:
            return ApiResponse(success=False, message=_("tabchat.member_not_found"), code=404)
        return ApiResponse(message=_("tabchat.operation_success"))
    except (ValueError, PermissionError) as e:
        code = 403 if isinstance(e, PermissionError) else 400
        return ApiResponse(success=False, message=str(e), code=code)
    except Exception:
        logger.exception("Failed to delete agent binding")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.delete(
    "/conversations/{conversation_id}/members/{target_user_id}",
    response=ApiResponse,
    auth=jwt_auth,
)
def remove_member(request, conversation_id: str, target_user_id: str):
    """移除成员或自行退出群聊。"""
    user = request.auth
    try:
        removed = ConversationService.remove_member(
            conversation_id=conversation_id,
            operator_id=str(user.id),
            target_user_id=target_user_id,
        )
        if not removed:
            return ApiResponse(success=False, message=_("tabchat.member_not_found"), code=404)
        return ApiResponse(message=_("tabchat.operation_success"))
    except (ValueError, PermissionError) as e:
        code = 403 if isinstance(e, PermissionError) else 400
        return ApiResponse(success=False, message=str(e), code=code)
    except Exception as e:
        logger.exception("Failed to remove member")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


# ── 消息 ──


@router.get("/conversations/{conversation_id}/messages", response=ApiResponse, auth=jwt_auth)
def get_messages(
    request,
    conversation_id: str,
    before: int | None = Query(None),
    limit: int = Query(50, ge=1, le=100),
    content_filter: str | None = Query(None),
):
    """获取消息历史（cursor 分页）。"""
    user = request.auth
    try:
        messages = MessageService.get_messages(
            conversation_id=conversation_id,
            user_id=str(user.id),
            before_id=before,
            limit=limit,
            content_filter=content_filter,
        )
        return ApiResponse(data=messages)
    except PermissionError as e:
        return ApiResponse(success=False, message=str(e), code=403)
    except ValueError as e:
        return ApiResponse(success=False, message=str(e), code=400)
    except Exception as e:
        logger.exception("Failed to get messages")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.post(
    "/conversations/{conversation_id}/message-references/resolve",
    response=ApiResponse,
    auth=jwt_auth,
)
def resolve_message_references(
    request,
    conversation_id: str,
    payload: ResolveMessageReferencesRequest,
):
    """批量解析 IM 消息中的 TabTin 正文引用。"""
    try:
        items = MessageService.resolve_message_references(
            conversation_id=conversation_id,
            user_id=str(request.auth.id),
            message_ids=payload.message_ids,
        )
        return ApiResponse(data={"items": items})
    except PermissionError as exc:
        return ApiResponse(success=False, message=str(exc), code=403)
    except ValueError as exc:
        return ApiResponse(success=False, message=str(exc), code=400)
    except Exception:
        logger.exception("Failed to resolve message references")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.post("/conversations/{conversation_id}/messages", response=ApiResponse, auth=jwt_auth)
def send_message(request, conversation_id: str, payload: SendMessageRequest):
    """发送消息。"""
    user = request.auth
    try:
        msg = MessageService.send_message(
            conversation_id=conversation_id,
            sender_id=str(user.id),
            content=payload.content,
            message_type=payload.message_type,
            reply_to_id=payload.reply_to_id,
            metadata=payload.metadata,
            client_request_id=payload.client_request_id,
        )
        return ApiResponse(
            data={
                "id": msg.id,
                "tabtin_message_id": str(msg.id),
                "seq": msg.seq,
                "conversation_id": str(msg.conversation_id),
                "created_at": msg.created_at.isoformat() if msg.created_at else None,
            },
            code=201,
        )
    except (ValueError, PermissionError) as e:
        return _business_error_response(e)
    except Exception as e:
        logger.exception("Failed to send message")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.delete(
    "/conversations/{conversation_id}/messages/{message_id}",
    response=ApiResponse,
    auth=jwt_auth,
)
def delete_message(request, conversation_id: str, message_id: int):
    """撤回消息（限发送后 2 分钟内，仅发送者可操作）。"""
    user = request.auth
    try:
        result = MessageService.delete_message(
            conversation_id=conversation_id,
            message_id=message_id,
            user_id=str(user.id),
        )
        if not result:
            return ApiResponse(success=False, message=_("tabchat.message_not_found"), code=404)
        return ApiResponse(message=_("tabchat.message_recalled"))
    except PermissionError as e:
        return ApiResponse(success=False, message=str(e), code=403)
    except ValueError as e:
        return ApiResponse(success=False, message=str(e), code=400)
    except Exception as e:
        logger.exception("Failed to delete message")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.patch(
    "/conversations/{conversation_id}/messages/{message_id}",
    response=ApiResponse,
    auth=jwt_auth,
)
def edit_message(request, conversation_id: str, message_id: int, payload: EditMessageRequest):
    """编辑一条文本消息（仅本人、无时限，打「已编辑」标记）。"""
    user = request.auth
    try:
        data = MessageService.edit_message(
            conversation_id=conversation_id,
            message_id=message_id,
            user_id=str(user.id),
            content=payload.content,
            metadata=payload.metadata,
        )
        return ApiResponse(data=data)
    except PermissionError as e:
        return ApiResponse(success=False, message=str(e), code=403)
    except ValueError as e:
        return ApiResponse(success=False, message=str(e), code=400)
    except Exception:
        logger.exception("Failed to edit message")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.put(
    "/conversations/{conversation_id}/messages/{message_id}/star",
    response=ApiResponse,
    auth=jwt_auth,
)
def set_message_star(
    request,
    conversation_id: str,
    message_id: int,
    payload: MessageUserStateRequest,
):
    try:
        enabled = MessageService.set_message_starred(
            conversation_id,
            message_id,
            str(request.auth.id),
            payload.enabled,
        )
        return ApiResponse(data={"starred": enabled})
    except (ValueError, PermissionError) as exc:
        return ApiResponse(
            success=False,
            message=str(exc),
            code=403 if isinstance(exc, PermissionError) else 404,
        )


@router.put(
    "/conversations/{conversation_id}/messages/{message_id}/hide",
    response=ApiResponse,
    auth=jwt_auth,
)
def set_message_hidden(
    request,
    conversation_id: str,
    message_id: int,
    payload: MessageUserStateRequest,
):
    try:
        enabled = MessageService.set_message_hidden(
            conversation_id,
            message_id,
            str(request.auth.id),
            payload.enabled,
        )
        return ApiResponse(data={"hidden": enabled})
    except (ValueError, PermissionError) as exc:
        return ApiResponse(
            success=False,
            message=str(exc),
            code=403 if isinstance(exc, PermissionError) else 404,
        )


@router.get(
    "/conversations/{conversation_id}/messages/{message_id}/attachment-url",
    response=ApiResponse,
    auth=jwt_auth,
)
def get_message_attachment_url(request, conversation_id: str, message_id: int):
    """获取 IM 附件临时下载 URL（TC-13：按 file_id + FileUsage 换链）。"""
    user = request.auth
    try:
        data = MessageService.get_attachment_download_url(
            conversation_id=conversation_id,
            message_id=message_id,
            user_id=str(user.id),
        )
        return ApiResponse(data=data)
    except PermissionError as e:
        return ApiResponse(success=False, message=str(e), code=403)
    except ValueError as e:
        return ApiResponse(success=False, message=str(e), code=404)
    except Exception:
        logger.exception("Failed to get message attachment url")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.get(
    "/conversations/{conversation_id}/messages/{message_id}/read-receipts",
    response=ApiResponse,
    auth=jwt_auth,
)
def get_message_read_receipts(request, conversation_id: str, message_id: int):
    """查看自己发送消息在群内的已读/未读成员。"""
    try:
        data = MessageService.get_message_read_receipts(
            conversation_id, message_id, str(request.auth.id),
        )
        return ApiResponse(data=data)
    except PermissionError as exc:
        return ApiResponse(success=False, message=str(exc), code=403)
    except ValueError as exc:
        return ApiResponse(success=False, message=str(exc), code=404)
    except Exception:
        logger.exception("Failed to get message read receipts")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.post("/conversations/{conversation_id}/read", response=ApiResponse, auth=jwt_auth)
def mark_read(request, conversation_id: str, payload: MarkReadRequest):
    """标记会话消息为已读。"""
    user = request.auth
    try:
        count = MessageService.mark_as_read(
            conversation_id=conversation_id,
            user_id=str(user.id),
            last_message_id=payload.last_message_id,
        )
        return ApiResponse(data={"marked_count": count})
    except PermissionError as e:
        return ApiResponse(success=False, message=str(e), code=403)
    except ValueError as e:
        return ApiResponse(success=False, message=str(e), code=400)
    except Exception as e:
        logger.exception("Failed to mark read")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


# ── Emoji 反应 ──


@router.post(
    "/conversations/{conversation_id}/messages/{message_id}/reactions",
    response=ApiResponse,
    auth=jwt_auth,
)
def add_reaction(request, conversation_id: str, message_id: str, payload: ReactionRequest):
    """添加 emoji 反应。"""
    user = request.auth
    try:
        resolved_message_id = MessageService.resolve_visible_message_id(
            conversation_id, message_id,
        )
        created = MessageService.add_reaction(
            conversation_id, resolved_message_id, str(user.id), payload.emoji,
        )
        return ApiResponse(data={"created": created})
    except (ValueError, PermissionError) as e:
        code = 403 if isinstance(e, PermissionError) else 400
        return ApiResponse(success=False, message=str(e), code=code)
    except Exception as e:
        logger.exception("Failed to add reaction")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.delete(
    "/conversations/{conversation_id}/messages/{message_id}/reactions",
    response=ApiResponse,
    auth=jwt_auth,
)
def remove_reaction(
    request,
    conversation_id: str,
    message_id: str,
    emoji: str = Query(...),
):
    """移除 emoji 反应。"""
    user = request.auth
    try:
        resolved_message_id = MessageService.resolve_visible_message_id(
            conversation_id, message_id,
        )
        removed = MessageService.remove_reaction(
            conversation_id, resolved_message_id, str(user.id), emoji,
        )
        return ApiResponse(data={"removed": removed})
    except PermissionError as e:
        return ApiResponse(success=False, message=str(e), code=403)
    except Exception as e:
        logger.exception("Failed to remove reaction")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


# ── 消息置顶 ──


@router.get(
    "/conversations/{conversation_id}/pinned-messages",
    response=ApiResponse,
    auth=jwt_auth,
)
def list_pinned_messages(request, conversation_id: str):
    """列出会话内置顶消息。"""
    user = request.auth
    try:
        data = MessageService.list_pinned_messages(conversation_id, str(user.id))
        return ApiResponse(data=data)
    except PermissionError as e:
        return ApiResponse(success=False, message=str(e), code=403)
    except ValueError as e:
        return ApiResponse(success=False, message=str(e), code=404)
    except Exception:
        logger.exception("Failed to list pinned messages")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.post(
    "/conversations/{conversation_id}/messages/{message_id}/pin",
    response=ApiResponse,
    auth=jwt_auth,
)
def pin_message(request, conversation_id: str, message_id: int):
    """置顶一条消息（群聊仅管理员，私聊任意成员）。"""
    user = request.auth
    try:
        data = MessageService.pin_message(conversation_id, message_id, str(user.id))
        return ApiResponse(data=data)
    except PermissionError as e:
        return ApiResponse(success=False, message=str(e), code=403)
    except ValueError as e:
        return ApiResponse(success=False, message=str(e), code=400)
    except Exception:
        logger.exception("Failed to pin message")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.delete(
    "/conversations/{conversation_id}/messages/{message_id}/pin",
    response=ApiResponse,
    auth=jwt_auth,
)
def unpin_message(request, conversation_id: str, message_id: int):
    """取消置顶。"""
    user = request.auth
    try:
        MessageService.unpin_message(conversation_id, message_id, str(user.id))
        return ApiResponse()
    except PermissionError as e:
        return ApiResponse(success=False, message=str(e), code=403)
    except ValueError as e:
        return ApiResponse(success=False, message=str(e), code=400)
    except Exception:
        logger.exception("Failed to unpin message")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


# ── 未读汇总 ──


@router.get("/unread-count", response=ApiResponse, auth=jwt_auth)
def get_unread_count(request, organization_id: str = Query(...)):
    """获取全局未读汇总（各会话未读数）。"""
    user = request.auth
    if err := _check_organization_access(str(user.id), organization_id):
        return err
    try:
        counts = MessageService.get_unread_counts(
            organization_id=organization_id,
            user_id=str(user.id),
        )
        total = sum(counts.values())
        return ApiResponse(data={
            "total": total,
            "conversations": counts,
        })
    except Exception as e:
        logger.exception("Failed to get unread count")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


# ── 资源卡按需预览 ──


@router.get("/resource-card-preview", response=ApiResponse, auth=jwt_auth)
def get_resource_card_preview(
    request,
    card_type: str = Query(...),
    resource_id: str = Query(...),
):
    """按需读取资源卡最新预览（title / description / preview_table）。

    用于前端渲染存量资源卡时拉真实内容，绕开可能 stale 的 ContextItem.preview
    快照。校验当前用户对资源 viewer 权限（卡片=指针，收卡≠授权——无权返回 403、
    不暴露内容）。
    """
    if card_type not in ("document", "table"):
        return ApiResponse(success=False, message="不支持的资源类型", code=400)
    try:
        data = resolve_resource_card_preview(card_type, resource_id, request.auth)
        return ApiResponse(data=data)
    except ValueError as e:
        return ApiResponse(success=False, message=str(e), code=404)
    except PermissionError as e:
        return ApiResponse(success=False, message=str(e), code=403)
    except Exception:
        logger.exception("Failed to resolve resource card preview")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


# ── 消息搜索 ──


@router.get("/search/grouped", response=ApiResponse, auth=jwt_auth)
def search_message_groups(
    request,
    organization_id: str = Query(...),
    q: str = Query(...),
    group_offset: int = Query(0, ge=0),
    group_limit: int = Query(8, ge=1, le=20),
    per_group_limit: int = Query(3, ge=1, le=20),
):
    """按用户私聊 / 群组聚合搜索；聚合组与组内消息分别分页。"""
    user = request.auth
    if err := _check_organization_access(str(user.id), organization_id):
        return err
    try:
        data = MessageService.search_message_groups(
            organization_id=organization_id,
            user_id=str(user.id),
            query=q,
            group_offset=group_offset,
            group_limit=group_limit,
            per_group_limit=per_group_limit,
        )
        return ApiResponse(data=data)
    except Exception:
        logger.exception("Failed to search grouped messages")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.get("/search", response=ApiResponse, auth=jwt_auth)
def search_messages(
    request,
    organization_id: str = Query(...),
    q: str = Query(...),
    conversation_id: str | None = Query(None),
    limit: int = Query(20, ge=1, le=50),
    offset: int = Query(0, ge=0),
):
    """搜索消息。"""
    user = request.auth
    if err := _check_organization_access(str(user.id), organization_id):
        return err
    try:
        results = MessageService.search_messages(
            organization_id=organization_id,
            user_id=str(user.id),
            query=q,
            conversation_id=conversation_id,
            limit=limit,
            offset=offset,
        )
        return ApiResponse(data=results)
    except PermissionError as e:
        return ApiResponse(success=False, message=str(e), code=403)
    except Exception as e:
        logger.exception("Failed to search messages")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


# ── 搜索 organization 成员 ──


@router.get("/members/search", response=ApiResponse, auth=jwt_auth)
def search_organization_members(
    request,
    organization_id: str = Query(...),
    q: str = Query(""),
    limit: int = Query(20, ge=1, le=50),
):
    """搜索 organization 内的成员（按昵称/用户名/邮箱模糊匹配）。

    面向普通成员，不需要 admin 权限。用于创建对话时选人。
    """
    user = request.auth
    if err := _check_organization_access(str(user.id), organization_id):
        return err
    try:
        from django.db.models import Q as DQ

        organization_members = OrganizationMember.objects.filter(
            organization_id=organization_id
        ).exclude(user_id=str(user.id))

        member_user_ids = list(organization_members.values_list("user_id", flat=True))
        if not member_user_ids:
            return ApiResponse(data=[])

        qs = User.objects.filter(id__in=member_user_ids, is_active=True)

        query = q.strip()
        if query:
            qs = qs.filter(
                DQ(nickname__icontains=query)
                | DQ(username__icontains=query)
                | DQ(email__icontains=query)
            )

        qs = qs[:limit]
        results = [
            {
                "id": str(u.id),
                "nickname": u.nickname or "",
                "username": u.username or "",
                "avatar": build_public_asset_url(getattr(u, "avatar", "") or ""),
            }
            for u in qs
        ]
        return ApiResponse(data=results)
    except Exception as e:
        logger.exception("Failed to search organization members")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


# ── 搜索 organization 内 AI Agent（TC-8 加成员/选人用） ──


@router.get("/agents/search", response=ApiResponse, auth=jwt_auth)
def search_organization_agents(
    request,
    organization_id: str = Query(...),
    q: str = Query(""),
    limit: int = Query(20, ge=1, le=50),
):
    """搜索 organization 内可加入会话的 AI Agent（bot 类型、启用中）。"""
    user = request.auth
    if err := _check_organization_access(str(user.id), organization_id):
        return err
    try:
        from apps.tabtinspace.models import Agent

        qs = (
            Agent.objects.filter(
                organization_id=organization_id,
                type="bot",
                is_active=True,
            )
            .filter(owner_user_id=user.id)
        )
        query = q.strip()
        if query:
            qs = qs.filter(name__icontains=query)

        agents = list(qs.order_by("name", "id").values("id", "name")[:limit])
        results = [
            {
                "id": str(a["id"]),
                "name": a.get("name") or "",
                "avatar": "",
            }
            for a in agents
        ]
        return ApiResponse(data=results)
    except Exception:
        logger.exception("Failed to search organization agents")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


# ── 用户 Profile 批量查询 ──


@router.post("/users/batch", response=ApiResponse, auth=jwt_auth)
def batch_get_users(request, payload: BatchUsersRequest):
    """批量获取用户公开信息（限同 organization 成员）。"""
    user = request.auth
    if err := _check_organization_access(str(user.id), payload.organization_id):
        return err
    user_ids = list(set(payload.user_ids))[:200]
    ws_user_ids = set(
        OrganizationMember.objects.filter(
            organization_id=payload.organization_id, user_id__in=user_ids
        ).values_list("user_id", flat=True)
    )
    try:
        users = User.objects.filter(id__in=ws_user_ids, is_active=True).values(
            "id", "nickname", "username", "avatar", "profile_revision"
        )
        profiles = [
            {
                "id": str(u["id"]),
                "nickname": u.get("nickname") or "",
                "username": u.get("username") or "",
                # 头像 DB 存 object key（迁移 0012 起），需解析为公共资产 URL；
                # 旧完整 URL / 外部 URL / 空值由 build_public_asset_url 兼容处理。
                "avatar": build_public_asset_url(u.get("avatar") or ""),
                "avatar_version": avatar_version(u.get("profile_revision") or 0),
                "revision": u.get("profile_revision") or 0,
            }
            for u in users
        ]
        return ApiResponse(data=profiles)
    except Exception as e:
        logger.exception("Failed to batch get users")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


# ── TC-37：会话 label 管理 ──


@router.get("/labels", response=ApiResponse, auth=jwt_auth)
def list_labels(request, organization_id: str = Query(...)):
    """列出当前用户在当前 organization 的 label 库（含每个 label 的会话数）。"""
    user = request.auth
    if err := _check_organization_access(str(user.id), organization_id):
        return err
    try:
        from apps.tabchat.services.label_service import LabelService
        labels = LabelService.list_labels(organization_id, str(user.id))
        return ApiResponse(data=labels)
    except PermissionError as e:
        return ApiResponse(success=False, message=str(e), code=403)
    except Exception:
        logger.exception("Failed to list labels")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.post("/labels", response=ApiResponse, auth=jwt_auth)
def create_label(request, payload: CreateLabelRequest):
    """创建 label。"""
    user = request.auth
    if err := _check_organization_access(str(user.id), payload.organization_id):
        return err
    try:
        from apps.tabchat.services.label_service import LabelService
        label = LabelService.create_label(
            organization_id=payload.organization_id,
            user_id=str(user.id),
            name=payload.name,
            color=payload.color,
        )
        return ApiResponse(data=label)
    except ValueError as e:
        return ApiResponse(success=False, message=str(e), code=400)
    except PermissionError as e:
        return ApiResponse(success=False, message=str(e), code=403)
    except Exception:
        logger.exception("Failed to create label")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.patch("/labels/{label_id}", response=ApiResponse, auth=jwt_auth)
def update_label(request, label_id: str, payload: UpdateLabelRequest):
    """改名 / 改色。"""
    user = request.auth
    try:
        from apps.tabchat.services.label_service import LabelService
        label = LabelService.update_label(
            label_id=label_id,
            user_id=str(user.id),
            name=payload.name,
            color=payload.color,
        )
        return ApiResponse(data=label)
    except ValueError as e:
        return ApiResponse(success=False, message=str(e), code=404)
    except PermissionError as e:
        return ApiResponse(success=False, message=str(e), code=403)
    except Exception:
        logger.exception("Failed to update label")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.delete("/labels/{label_id}", response=ApiResponse, auth=jwt_auth)
def delete_label(request, label_id: str):
    """删除 label（从所有会话撕掉）。返回 affected 会话数。"""
    user = request.auth
    try:
        from apps.tabchat.services.label_service import LabelService
        affected = LabelService.delete_label(label_id, str(user.id))
        return ApiResponse(data={"affected_conversations": affected})
    except ValueError as e:
        return ApiResponse(success=False, message=str(e), code=404)
    except PermissionError as e:
        return ApiResponse(success=False, message=str(e), code=403)
    except Exception:
        logger.exception("Failed to delete label")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.post("/conversations/{conversation_id}/labels", response=ApiResponse, auth=jwt_auth)
def add_conversation_labels(request, conversation_id: str, payload: AddLabelsRequest):
    """给会话追加 label。"""
    user = request.auth
    try:
        from apps.tabchat.services.label_service import LabelService
        result = LabelService.add_labels_to_conversation(
            conversation_id=conversation_id,
            user_id=str(user.id),
            label_ids=payload.label_ids,
        )
        return ApiResponse(data=result)
    except ValueError as e:
        return ApiResponse(success=False, message=str(e), code=400)
    except PermissionError as e:
        return ApiResponse(success=False, message=str(e), code=403)
    except Exception:
        logger.exception("Failed to add conversation labels")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.delete("/conversations/{conversation_id}/labels/{label_id}", response=ApiResponse, auth=jwt_auth)
def remove_conversation_label(request, conversation_id: str, label_id: str):
    """撕掉会话的某个 label。"""
    user = request.auth
    try:
        from apps.tabchat.services.label_service import LabelService
        result = LabelService.remove_label_from_conversation(
            conversation_id=conversation_id,
            user_id=str(user.id),
            label_id=label_id,
        )
        return ApiResponse(data=result)
    except ValueError as e:
        return ApiResponse(success=False, message=str(e), code=400)
    except PermissionError as e:
        return ApiResponse(success=False, message=str(e), code=403)
    except Exception:
        logger.exception("Failed to remove conversation label")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


@router.get("/conversations/{conversation_id}/labels", response=ApiResponse, auth=jwt_auth)
def get_conversation_labels(request, conversation_id: str):
    """列出会话当前 label（含成员身份 + organization 归属校验）。"""
    user = request.auth
    try:
        from apps.tabchat.utils import is_conversation_user_active
        if not is_conversation_user_active(conversation_id, str(user.id)):
            return ApiResponse(success=False, message=_("tabchat.no_organization_access"), code=403)
        from apps.tabchat.services.label_service import LabelService
        labels = LabelService.get_conversation_labels_raw(conversation_id, str(user.id))
        return ApiResponse(data=labels)
    except Exception:
        logger.exception("Failed to get conversation labels")
        return ApiResponse(success=False, message=_("tabchat.internal_error"), code=500)


# ── IM 上下文交接（handoff 子域，端点见 apps/tabchat/handoff/api.py）──

# 自建 IM 消息面与会话面本来就注册在同一个 /api/im Router 上，
# `legacy_message_router` 只是供契约测试引用的兼容别名，不能再挂回自身。

from apps.tabchat.handoff.api import router as handoff_router  # noqa: E402

router.add_router("/handoffs", handoff_router)

# ── IM 任务共享（session_share 子域，端点见 apps/tabchat/session_share/api.py）──

from apps.tabchat.session_share.api import router as session_share_router  # noqa: E402

router.add_router("/session-shares", session_share_router)

# ── 资源访问申请兼容别名（正典：/api/resource-access-requests）──

from apps.tabchat.resource_access.api import router as resource_access_router  # noqa: E402

router.add_router("/resource-access-requests", resource_access_router)
