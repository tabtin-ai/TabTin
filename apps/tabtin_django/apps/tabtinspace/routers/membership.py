"""Tabtin Space membership 路由。"""

from .shared import *  # noqa: F401,F403
from apps.services.common.utils import mask_phone_number
from apps.services.oss.services.public_assets import build_public_asset_url
from apps.users.auth.phone import canonicalize_phone

router = Router(tags=["Tabtin Space"])


@router.post(
    "/organizations/{organization_id}/members/batch-profiles",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR_400},
)
def batch_organization_member_profiles(
    request: HttpRequest,
    organization_id: UUID,
    payload: OrganizationMemberProfilesRequest,
):
    """返回指定组织成员的公开身份资料，供 IM 建群与展示使用。"""
    if not OrganizationService(user=request.auth).check_organization_permission(
        str(organization_id), "viewer"
    ):
        return permission_denied_response(_("tabtinspace.permission_denied"))

    from django.contrib.auth import get_user_model
    from apps.tabtinspace.models import OrganizationMember

    user_ids = list(dict.fromkeys(payload.user_ids))
    member_ids = OrganizationMember.objects.filter(
        organization_id=organization_id,
        user_id__in=user_ids,
    ).values_list("user_id", flat=True)
    users = get_user_model().objects.filter(id__in=member_ids, is_active=True).values(
        "id", "nickname", "username", "avatar", "profile_revision"
    )
    profiles = [
        {
            "id": str(user["id"]),
            "nickname": user.get("nickname") or "",
            "username": user.get("username") or "",
            "avatar": build_public_asset_url(user.get("avatar") or ""),
            "avatar_version": (
                str(user["profile_revision"]) if user.get("profile_revision") else ""
            ),
            "revision": user.get("profile_revision") or 0,
        }
        for user in users
    ]
    return success_response(profiles)


@router.get(
    "/organizations/{organization_id}/members",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR_400},
)
def list_organization_members(
    request: HttpRequest,
    organization_id: UUID,
    search: str = "",
    search_mode: str = "",
    role: str = "",
    offset: int = 0,
    limit: int = 0,
):
    from django.contrib.auth import get_user_model
    User = get_user_model()

    service = OrganizationService(user=request.auth)
    try:
        offset = max(0, offset)
        if limit > 0:
            limit = min(limit, 200)
        members, total = service.list_members(
            organization_id,
            search=search,
            search_mode=search_mode,
            role=role,
            offset=offset,
            limit=limit,
        )
        requester_role = service.get_member_role(
            organization_id,
            str(request.auth.id),
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    user_ids = [str(m.user_id) for m in members]
    users_qs = User.objects.filter(id__in=user_ids).values(
        "id", "nickname", "username", "email", "phone", "avatar"
    )
    user_map = {u["id"]: u for u in users_qs}

    from apps.tabtinspace.schemas.membership import (
        OrganizationMemberWithUserOut,
        MemberUserOut,
    )

    member_data = []
    requester_user_id = str(request.auth.id)
    can_view_member_contact = requester_role == "owner"
    for member in members:
        uid = str(member.user_id)
        u = user_map.get(uid, {})
        phone = canonicalize_phone(u.get("phone") or "")
        if not can_view_member_contact and uid != requester_user_id:
            phone = mask_phone_number(phone)
        item = OrganizationMemberWithUserOut(
            **OrganizationMemberOut.from_orm(member).dict(),
            user=MemberUserOut(
                id=uid,
                nickname=u.get("nickname") or "",
                username=u.get("username") or "",
                email=u.get("email") or "",
                phone=phone,
                avatar=build_public_asset_url(u.get("avatar") or ""),
            ),
        )
        member_data.append(item.dict())

    return success_response({
        "members": member_data,
        "total": total,
    })


@router.get(
    "/organizations/{organization_id}/members/identity-snapshots",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR_400},
)
def list_member_identity_snapshots(request: HttpRequest, organization_id: UUID):
    service = OrganizationService(user=request.auth)
    try:
        snapshots = service.list_member_identity_snapshots(organization_id)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    identities = [
        {
            "user_id": str(snapshot.user_id),
            "display_name": snapshot.display_name,
            "left_at": snapshot.left_at.isoformat(),
        }
        for snapshot in snapshots
    ]
    return success_response({"identities": identities, "total": len(identities)})

@router.get(
    "/organizations/{organization_id}/search-users",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR_400},
)
def search_users_for_organization(request: HttpRequest, organization_id: UUID, q: str = ""):
    service = OrganizationService(user=request.auth)
    try:
        results = service.search_users_for_organization(organization_id, q)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    def mask_email(email) -> str:
        if not email or not isinstance(email, str) or '@' not in email:
            return ""
        local, domain = email.split('@', 1)
        if not local:
            return ""
        if len(local) <= 2:
            masked = local[0] + '***'
        else:
            masked = local[0] + '***' + local[-1]
        return f"{masked}@{domain}"

    users = [
        {
            "id": str(u["id"]),
            "nickname": u.get("nickname") or u.get("username") or "",
            "email_masked": mask_email(u.get("email") or ""),
            "avatar": build_public_asset_url(u.get("avatar") or ""),
        }
        for u in results
    ]
    return success_response({"users": users, "total": len(users)})

@router.post(
    "/organizations/{organization_id}/members",
    auth=jwt_auth,
    response={201: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
)
def add_organization_member(request: HttpRequest, organization_id: UUID, data: OrganizationMemberAdd):
    service = OrganizationService(user=request.auth)
    try:
        member = service.add_member(
            organization_id=organization_id,
            user_id=data.user_id,
            role=data.role
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    _audit(
        request,
        action_type='member_add', target_type='member',
        target_id=member.id, organization_id=organization_id,
        message=f"添加成员 {data.user_id} 为 {data.role}",
        activity_action='joined', resource_name=data.user_id,
    )

    return 201, success_response(
        data=OrganizationMemberOut.from_orm(member).dict(),
        message=_("tabtinspace.member_added")
    )

@router.put(
    "/organizations/{organization_id}/members/{user_id}",
    auth=jwt_auth,
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
)
def update_organization_member(
    request: HttpRequest,
    organization_id: UUID,
    user_id: str,
    data: OrganizationMemberUpdate
):
    service = OrganizationService(user=request.auth)
    try:
        service.update_member_role(
            organization_id=organization_id,
            user_id=user_id,
            role=data.role
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    _audit(
        request,
        action_type='member_role_change', target_type='member',
        target_id=organization_id, organization_id=organization_id,
        message=f"变更成员 {user_id} 角色为 {data.role}",
        request_payload={'user_id': user_id, 'new_role': data.role},
        activity_action='updated', resource_name=user_id,
    )
    return success_response(message=_("tabtinspace.member_role_updated"))

@router.delete(
    "/organizations/{organization_id}/members/{user_id}",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR_400},
)
def remove_organization_member(request: HttpRequest, organization_id: UUID, user_id: str):
    service = OrganizationService(user=request.auth)
    try:
        service.remove_member(organization_id=organization_id, user_id=user_id)
    except ServiceError as e:
        # DELETE 可能在首个响应超时后被客户端重试；目标已不存在即达到期望状态。
        if e.code == 'MEMBER_NOT_FOUND':
            return success_response(message=_("tabtinspace.member_removed"))
        return error_response(e.code, e.message, status_code=e.status)

    _audit(
        request,
        action_type='member_remove', target_type='member',
        target_id=organization_id, organization_id=organization_id,
        message=f"移除成员 {user_id}",
        activity_action='left', resource_name=user_id,
    )
    return success_response(message=_("tabtinspace.member_removed"))

@router.post(
    "/organizations/{organization_id}/leave",
    auth=jwt_auth,
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
)
def leave_organization(request: HttpRequest, organization_id: UUID):
    service = OrganizationService(user=request.auth)
    try:
        service.leave_organization(organization_id)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    _audit(
        request,
        action_type='member_leave', target_type='member',
        target_id=organization_id, organization_id=organization_id,
        message=f"离开组织",
        activity_action='left',
        resource_name=getattr(request.auth, 'get_display_name', lambda: str(request.auth.id))(),
    )

    return success_response(message=_("tabtinspace.organization_left"))

# ：Workspace / Project 正式路径；/spaces/... 过渡别名保留至 Space 壳 DROP。
@router.get("/spaces/{space_id}/memberships", auth=jwt_auth, response={200: dict, 401: ErrorResponse})
@router.get("/workspaces/{space_id}/memberships", auth=jwt_auth, response={200: dict, 401: ErrorResponse})
@router.get("/projects/{space_id}/memberships", auth=jwt_auth, response={200: dict, 401: ErrorResponse})
def list_space_memberships(request: HttpRequest, space_id: UUID):
    service = SpaceAccessService(user=request.auth)
    memberships = service.list_space_memberships(space_id)
    membership_data = [SpaceMembershipOut.from_orm(item).dict() for item in memberships]
    return success_response({
        "memberships": membership_data,
        "total": memberships.count()
    })

@router.post("/spaces/{space_id}/memberships", auth=jwt_auth, response=RESP_CREATE)
@router.post("/workspaces/{space_id}/memberships", auth=jwt_auth, response=RESP_CREATE)
@router.post("/projects/{space_id}/memberships", auth=jwt_auth, response=RESP_CREATE)
def add_space_membership(request: HttpRequest, space_id: UUID, data: SpaceMembershipCreate):
    try:
        service = SpaceAccessService(user=request.auth)
        membership = service.add_space_membership(
            space_id=space_id,
            agent_id=data.agent_id,
            user_id=data.user_id,
            role=data.role,
        )
        return 201, success_response(
            data=SpaceMembershipOut.from_orm(membership).dict(),
            message="Space 成员已添加"
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

@router.delete("/spaces/{space_id}/memberships/{membership_id}", auth=jwt_auth, response={200: dict, **RESP_ERR_400})
@router.delete("/workspaces/{space_id}/memberships/{membership_id}", auth=jwt_auth, response={200: dict, **RESP_ERR_400})
@router.delete("/projects/{space_id}/memberships/{membership_id}", auth=jwt_auth, response={200: dict, **RESP_ERR_400})
def remove_space_membership(request: HttpRequest, space_id: UUID, membership_id: UUID):
    try:
        service = SpaceAccessService(user=request.auth)
        service.remove_space_membership(space_id, membership_id)
        return success_response(message="Space 成员已移除")
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

__all__ = ["router"]
