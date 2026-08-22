"""会话管理相关 API 路由"""
from ninja import Router, Query

from ._shared import (
    HttpRequest,
    _,
    success_response,
    logger,
    jwt_auth,
    UserSessionSchema,
    ApiResponseSchema,
    verify_jwt_token,
    log_security_event,
    UserSession,
)

router = Router(tags=["会话管理"])


@router.get("/sessions", auth=jwt_auth, tags=["用户管理"])
def get_user_sessions(request: HttpRequest):
    """获取用户会话列表"""
    user = request.auth
    sessions = UserSession.objects.filter(user=user, is_active=True).order_by('-last_activity')

    return success_response(data=[
        UserSessionSchema(
            id=str(session.id),
            session_type=session.session_type,
            ip_address=session.ip_address,
            user_agent=session.user_agent,
            device_info=session.device_info,
            created_at=session.created_at,
            last_activity=session.last_activity,
            expires_at=session.expires_at,
            is_active=session.is_active
        ).model_dump()
        for session in sessions
    ])


@router.delete("/sessions/{session_id}", response=ApiResponseSchema, auth=jwt_auth, tags=["用户管理"])
def delete_user_session(request: HttpRequest, session_id: str):
    """删除用户会话"""
    try:
        user = request.auth
        session = UserSession.objects.get(id=session_id, user=user)
        session.is_active = False
        session.save()

        return ApiResponseSchema(
            success=True,
            message=_("auth.session_deleted")
        )

    except UserSession.DoesNotExist:
        return ApiResponseSchema(
            success=False,
            message=_("auth.session_not_found"),
            code="NOT_FOUND"
        )
    except Exception:
        logger.exception("delete_user_session 内部异常")
        return ApiResponseSchema(
            success=False,
            message="操作失败，请稍后重试",
            code="INTERNAL_ERROR"
        )


@router.delete("/sessions", response=ApiResponseSchema, auth=jwt_auth, tags=["用户管理"])
def delete_all_sessions(request: HttpRequest, exclude_current: bool = Query(False)):
    """删除用户所有会话（可选择保留当前会话）"""
    try:
        user = request.auth
        queryset = UserSession.objects.filter(user=user, is_active=True)

        if exclude_current:
            auth_header = request.headers.get('Authorization', '')
            if auth_header.startswith('Bearer '):
                token = auth_header[7:]
                payload = verify_jwt_token(token)
                session_key = payload.get('sid') if payload else None
                if session_key:
                    queryset = queryset.exclude(session_key=session_key)

        updated = queryset.update(is_active=False)

        log_security_event(
            "sessions_terminated",
            request,
            user=user,
            success=True,
            extra={"count": updated, "exclude_current": exclude_current}
        )

        return ApiResponseSchema(
            success=True,
            message=_("auth.sessions_terminated"),
            data={"count": updated}
        )

    except Exception:
        logger.exception("delete_all_sessions 内部异常")
        return ApiResponseSchema(
            success=False,
            message="操作失败，请稍后重试",
            code="INTERNAL_ERROR"
        )
