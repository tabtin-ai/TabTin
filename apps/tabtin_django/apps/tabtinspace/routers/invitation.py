"""Tabtin Space invitation 路由。"""

from .shared import *  # noqa: F401,F403

router = Router(tags=["Tabtin Space"])

def _serialize_invitation(invitation) -> dict:
    """序列化单条邀请；定向邀请附带被邀请人昵称。"""
    from apps.tabtinspace.services.invitation_service import resolve_invitee_nicknames

    nickname = ''
    user_id = (getattr(invitation, 'invited_user_id', None) or '').strip()
    if user_id:
        nickname = resolve_invitee_nicknames([invitation]).get(user_id, '')

    invited_user_phone = None
    if invitation.invite_type == 'direct' and user_id:
        from django.contrib.auth import get_user_model

        User = get_user_model()
        user = User.objects.using('default').filter(id=user_id).values('phone').first()
        invited_user_phone = (user or {}).get('phone') or None

    item = InvitationOut.from_invitation(
        invitation,
        invited_user_nickname=nickname,
        invited_user_phone=invited_user_phone,
    ).dict()
    return item


def _serialize_invitation_list(invitations):
    """批量序列化邀请列表；补齐昵称与直接邀请可读手机号。"""
    from apps.tabtinspace.services.invitation_service import resolve_invitee_nicknames

    nickname_map = resolve_invitee_nicknames(invitations)

    direct_user_ids = {
        invitation.invited_user_id
        for invitation in invitations
        if invitation.invite_type == 'direct' and invitation.invited_user_id
    }
    user_phone_map = {}
    if direct_user_ids:
        from django.contrib.auth import get_user_model

        User = get_user_model()
        user_phone_map = {
            str(user['id']): user['phone'] or None
            for user in User.objects.using('default').filter(id__in=direct_user_ids).values(
                'id', 'phone',
            )
        }

    data = []
    for invitation in invitations:
        user_id = (invitation.invited_user_id or '').strip()
        nickname = nickname_map.get(user_id, '')
        invited_user_phone = user_phone_map.get(user_id) if invitation.invite_type == 'direct' else None
        data.append(
            InvitationOut.from_invitation(
                invitation,
                invited_user_nickname=nickname,
                invited_user_phone=invited_user_phone,
            ).dict()
        )
    return data


def _notify_members_invite_accepted(
    *,
    actor,
    organization_id: str,
    organization_name: str,
    role: str,
) -> None:
    """邀请被接受后通知团队其他成员，标题展示实际加入者。"""
    from apps.services.notification.services.organization_notification_formatter import (
        format_organization_notification,
    )
    from apps.tabtinspace.services.space_activity_service import resolve_user_display_name

    member_name = resolve_user_display_name(actor) or str(getattr(actor, 'id', ''))
    display = format_organization_notification(
        'member_joined_by_invitation',
        organization_name=organization_name,
        member_name=member_name,
        role=role,
    )
    membership_id = ''
    try:
        from apps.tabtinspace.models import OrganizationMember
        membership_id = str(
            OrganizationMember.objects.only('id').get(
                organization_id=organization_id,
                user_id=getattr(actor, 'id', ''),
            ).id
        )
    except Exception:
        pass
    try:
        NotificationService.notify_organization_members(
            organization_id=organization_id,
            type='invite_accepted',
            title=display.title,
            body=display.body,
            metadata={
                'member_user_id': str(getattr(actor, 'id', '')),
                'member_name': member_name,
                'role': role,
                'organization_name': organization_name,
                'category': 'organization',
                'behavior': 'notification_only',
                'dedupe_key': f'organization:member:joined:{membership_id or str(getattr(actor, "id", ""))}',
                'source_event_id': f'organization:member:joined:{membership_id or str(getattr(actor, "id", ""))}',
            },
            exclude_user_id=str(getattr(actor, 'id', '')),
        )
    except Exception:
        pass

@router.post("/organizations/{organization_id}/invitations/email", auth=jwt_auth, response=RESP_CREATE)
def create_email_invitation(request: HttpRequest, organization_id: UUID, data: InvitationEmailCreate):
    service = InvitationService(user=request.auth)
    try:
        invitation = service.create_email_invitation(
            organization_id=organization_id,
            email=data.email,
            role=data.role,
            expires_hours=data.expires_hours,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    _audit(
        request,
        action_type='invitation_create', target_type='invitation',
        target_id=invitation.id, organization_id=organization_id,
        message=f"邀请 {data.email} 为 {data.role}",
        activity_action='invited', resource_name=data.email,
    )

    return 201, success_response(
        data=_serialize_invitation(invitation),
        message=_("tabtinspace.invitation_sent"),
    )

@router.post("/organizations/{organization_id}/invitations/link", auth=jwt_auth, response=RESP_CREATE)
def create_link_invitation(request: HttpRequest, organization_id: UUID, data: InvitationLinkCreate):
    service = InvitationService(user=request.auth)
    try:
        invitation = service.create_link_invitation(
            organization_id=organization_id,
            role=data.role,
            max_uses=data.max_uses,
            expires_hours=data.expires_hours,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    _audit(
        request,
        action_type='invitation_create', target_type='invitation',
        target_id=invitation.id, organization_id=organization_id,
        message=f"创建邀请链接 (角色: {data.role})",
        activity_action='created', resource_name='邀请链接',
    )

    return 201, success_response(
        data=_serialize_invitation(invitation),
        message=_("tabtinspace.invitation_link_created"),
    )

@router.get("/organizations/{organization_id}/invitations", auth=jwt_auth, response={200: dict, **RESP_ERR_400})
def list_invitations(request: HttpRequest, organization_id: UUID):
    service = InvitationService(user=request.auth)
    try:
        invitations = service.list_invitations(organization_id)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    data = _serialize_invitation_list(invitations)
    return success_response({"invitations": data, "total": len(data)})

# ⚠️ 路由注册顺序：``…/invitations/direct`` 与 ``…/invitations/phone`` 字面路径
# 必须在 ``…/invitations/{invitation_id}`` 通配符**之前**注册（同 my-pending vs
# {token} 的注释）。ninja 把 UUID 参数注册为 str 转换器，先注册的通配 pattern 会
# 把 ``direct`` / ``phone`` 当 invitation_id 吞掉，POST 命中 DELETE-only 视图返回
# 405。live 验证铁证：修复前 POST …/invitations/direct → 405 Allow: DELETE。
@router.post("/organizations/{organization_id}/invitations/direct", auth=jwt_auth, response=RESP_CREATE)
def create_direct_invitation(request: HttpRequest, organization_id: UUID, data: InvitationDirectCreate):
    service = InvitationService(user=request.auth)
    try:
        invitation = service.create_direct_invitation(
            organization_id=organization_id,
            target_user_id=data.user_id,
            role=data.role,
            expires_hours=data.expires_hours,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    _audit(
        request,
        action_type='invitation_create', target_type='invitation',
        target_id=invitation.id, organization_id=organization_id,
        message=f"直接邀请用户 {data.user_id} 为 {data.role}",
        activity_action='invited', resource_name=data.user_id,
    )

    return 201, success_response(
        data=_serialize_invitation(invitation),
        message=_("tabtinspace.invitation_sent"),
    )

@router.post("/organizations/{organization_id}/invitations/phone", auth=jwt_auth, response=RESP_CREATE)
def create_phone_invitation(request: HttpRequest, organization_id: UUID, data: InvitationPhoneCreate):
    service = InvitationService(user=request.auth)
    try:
        invitation = service.create_phone_invitation(
            organization_id=organization_id,
            phone=data.phone,
            role=data.role,
            expires_hours=data.expires_hours,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    _audit(
        request,
        action_type='invitation_create', target_type='invitation',
        target_id=invitation.id, organization_id=organization_id,
        message=f"通过手机号 {data.phone} 邀请用户为 {data.role}",
        activity_action='invited', resource_name=data.phone,
    )

    return 201, success_response(
        data=_serialize_invitation(invitation),
        message=_("tabtinspace.invitation_sent"),
    )

@router.delete("/organizations/{organization_id}/invitations/{invitation_id}", auth=jwt_auth, response={200: dict, **RESP_ERR_400})
def cancel_invitation(request: HttpRequest, organization_id: UUID, invitation_id: UUID):
    service = InvitationService(user=request.auth)
    try:
        service.cancel_invitation(organization_id, invitation_id)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    _audit(
        request,
        action_type='invitation_cancel', target_type='invitation',
        target_id=invitation_id, organization_id=organization_id,
        message=f"取消邀请 {invitation_id}",
    )

    return success_response(message=_("tabtinspace.invitation_cancelled"))

# ⚠️ 路由注册顺序：``/invitations/my-pending`` 必须在 ``/invitations/{token}``
# 通配符**之前**注册（详见 approval_memo.py 的同类注释）。否则 ninja 会把
# ``my-pending`` 当成 token 字面量进入 ``get_invitation_info``，要么找不到 invitation
# 返回 404，要么命中错的 handler。dogfood 验证铁证：修复前 GET /api/context/invitations/my-pending → 404。
@router.get("/invitations/my-pending", auth=jwt_auth, response={200: dict, **RESP_ERR_400})
def list_my_pending_invitations(request: HttpRequest):
    service = InvitationService(user=request.auth)
    try:
        results = service.list_my_pending_invitations()
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    data = [
        PendingInvitationOut.from_invitation(r['invitation'], inviter_name=r['inviter_name']).dict()
        for r in results
    ]
    return success_response({"invitations": data, "total": len(data)})

@router.get("/invitations/{token}", auth=jwt_auth_optional, response={200: dict, **RESP_ERR_400})
def get_invitation_info(request: HttpRequest, token: str):
    # 可选登录：匿名仍可预览通用链；登录用户可命中 already_used
    from apps.services.common.public_share.auth import get_authenticated_user

    service = InvitationService(user=get_authenticated_user(request))
    try:
        info = service.get_invitation_info(token)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return success_response(data=info)

@router.post("/invitations/{token}/accept", auth=jwt_auth, response={200: dict, **RESP_ERR_400})
def accept_invitation(request: HttpRequest, token: str):
    service = InvitationService(user=request.auth)
    try:
        result = service.accept_invitation(token)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    wt_id = result.get('organization_id', '')
    _audit(
        request,
        action_type='invitation_accept', target_type='invitation',
        target_id=wt_id or '00000000-0000-0000-0000-000000000000',
        organization_id=wt_id,
        message=f"接受邀请加入组织 {result.get('organization_name', '')}",
        activity_action='joined',
        resource_name=getattr(request.auth, 'get_display_name', lambda: str(request.auth.id))(),
    )
    try:
        _notify_members_invite_accepted(
            actor=request.auth,
            organization_id=wt_id,
            organization_name=result.get('organization_name', ''),
            role=result.get('role', 'viewer'),
        )
    except Exception:
        pass

    return success_response(data=result, message=_("tabtinspace.organization_joined"))

@router.post("/invitations/{invitation_id}/respond", auth=jwt_auth, response={200: dict, **RESP_ERR_400})
def respond_to_invitation(request: HttpRequest, invitation_id: UUID, data: InvitationRespondRequest):
    service = InvitationService(user=request.auth)
    try:
        result = service.respond_to_invitation(invitation_id, data.accept)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    action = 'invitation_accept' if data.accept else 'invitation_reject'
    wt_id = result.get('organization_id', '')
    _audit(
        request,
        action_type=action, target_type='invitation',
        target_id=str(invitation_id),
        organization_id=wt_id,
        message=f"{'接受' if data.accept else '拒绝'}邀请加入组织 {result.get('organization_name', '')}",
        activity_action='joined' if data.accept else 'rejected',
        resource_name=getattr(request.auth, 'get_display_name', lambda: str(request.auth.id))(),
    )

    if data.accept:
        try:
            _notify_members_invite_accepted(
                actor=request.auth,
                organization_id=wt_id,
                organization_name=result.get('organization_name', ''),
                role=result.get('role', 'viewer'),
            )
        except Exception:
            pass

    msg = _("tabtinspace.organization_joined") if data.accept else _("tabtinspace.invitation_rejected")
    return success_response(data=result, message=msg)

__all__ = ["router"]
