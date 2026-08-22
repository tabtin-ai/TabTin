"""
通知 API
"""
from uuid import UUID
from ninja import Router
from django.http import HttpRequest

from apps.i18n import _
from apps.users.auth.permissions import JWTAuth
from apps.services.notification.services.notification_service import NotificationService

router = Router(tags=["Notifications"])
jwt_auth = JWTAuth()


def _success(data=None, message=None):
    message = message or _("notification.operation_success")
    return {"success": True, "code": "SUCCESS", "message": message, "data": data}


def _error(code, message, status=400):
    return status, {"success": False, "code": code, "message": message, "data": None}


def _clean_organization_id(raw: str | None) -> str | None:
    if raw in (None, 'null', 'undefined', ''):
        return None
    return raw


def _include_personal_invitations(request: HttpRequest) -> bool:
    return request.GET.get('include_personal_invitations', '').lower() in {'1', 'true', 'yes'}


def _center_only(request: HttpRequest) -> bool:
    """新通知中心的可加性开关；未携带参数的旧客户端保持原列表语义。"""
    return request.GET.get('center_only', '').lower() in {'1', 'true', 'yes'}


_WS_ACCESS_CACHE_TTL = 60  # seconds


def _user_can_access_organization(user, organization_id: str) -> bool:
    """校验用户是否为 organization 的 owner 或成员（60 秒本地缓存）。"""
    from django.core.cache import cache

    cache_key = f"notif:ws_access:{user.id}:{organization_id}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    result = _check_organization_membership(user, organization_id)
    cache.set(cache_key, result, _WS_ACCESS_CACHE_TTL)
    return result


def _check_organization_membership(user, organization_id: str) -> bool:
    try:
        from apps.tabtinspace.models import Organization, OrganizationMember
        ws = Organization.objects.filter(id=organization_id).only("owner_id").first()
        if not ws:
            return False
        if str(ws.owner_id) == str(user.id):
            return True
        return OrganizationMember.objects.filter(
            organization_id=organization_id, user_id=user.id,
        ).exists()
    except Exception:
        return False


@router.get("/", response={200: dict}, auth=jwt_auth, summary="获取通知列表")
def list_notifications(request: HttpRequest):
    user_id = str(request.auth.id)
    try:
        page = max(1, int(request.GET.get('page', '1')))
        limit = min(100, max(1, int(request.GET.get('limit', '20'))))
    except (TypeError, ValueError):
        return _error("INVALID_PAGINATION", "page/limit must be integers", 400)
    organization_id = _clean_organization_id(request.GET.get('organization_id'))
    include_personal_invitations = _include_personal_invitations(request)
    center_only = _center_only(request)
    unread_only = request.GET.get('status', '').lower() == 'unread'
    category = request.GET.get('category', '').strip()[:64]
    search = request.GET.get('search', '').strip()[:100]

    if organization_id and not _user_can_access_organization(request.auth, organization_id):
        return _error("FORBIDDEN", _("notification.organization_forbidden"), 403)

    result = NotificationService.list_notifications(
        user_id=user_id,
        organization_id=organization_id,
        page=page,
        limit=limit,
        include_personal_invitations=include_personal_invitations,
        unread_only=unread_only,
        category=category,
        search=search,
        center_only=center_only,
    )
    return _success(data=result)


@router.get("/unread-count", response={200: dict}, auth=jwt_auth, summary="获取未读通知数")
def unread_count(request: HttpRequest):
    organization_id = _clean_organization_id(request.GET.get('organization_id'))
    include_personal_invitations = _include_personal_invitations(request)
    center_only = _center_only(request)

    if organization_id and not _user_can_access_organization(request.auth, organization_id):
        return _error("FORBIDDEN", _("notification.organization_access_denied"), 403)

    count = NotificationService.get_unread_count(
        str(request.auth.id),
        organization_id=organization_id,
        include_personal_invitations=include_personal_invitations,
        center_only=center_only,
    )
    return _success(data={"count": count})


@router.post("/{notification_id}/read", response={200: dict}, auth=jwt_auth, summary="标记通知已读")
def mark_read(request: HttpRequest, notification_id: UUID):
    success = NotificationService.mark_read(notification_id, str(request.auth.id))
    if not success:
        return _error("NOT_FOUND", _("notification.not_found"), 404)
    return _success(message=_("notification.marked_read"))


@router.post("/read-all", response={200: dict}, auth=jwt_auth, summary="全部标记已读")
def mark_all_read(request: HttpRequest):
    organization_id = _clean_organization_id(request.GET.get('organization_id'))
    include_personal_invitations = _include_personal_invitations(request)
    center_only = _center_only(request)

    if organization_id and not _user_can_access_organization(request.auth, organization_id):
        return _error("FORBIDDEN", _("notification.organization_access_denied"), 403)

    count = NotificationService.mark_all_read(
        str(request.auth.id),
        organization_id=organization_id,
        include_personal_invitations=include_personal_invitations,
        center_only=center_only,
    )
    return _success(data={"count": count}, message=_("notification.batch_marked_read", count=count))


@router.post(
    "/agent-sessions/{session_id}/acknowledge",
    response={200: dict, 400: dict},
    auth=jwt_auth,
    summary="确认已查看 Agent 会话终态通知",
)
def acknowledge_agent_session(request: HttpRequest, session_id: str):
    """用户进入会话并完成已查看最新消息后，将该用户该 session 的终态铃铛标已读。

    后端权威、幂等；只清 ``agent.task.*`` 终态，不动 HITL / 其它 session / 其它用户。
    """
    sid = (session_id or "").strip()
    if not sid:
        return _error("INVALID_SESSION", _("notification.invalid_session"), 400)

    count = NotificationService.mark_agent_session_terminal_read(
        str(request.auth.id),
        sid,
    )
    return _success(data={"count": count}, message=_("notification.marked_read"))
