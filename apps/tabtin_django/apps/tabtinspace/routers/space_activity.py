"""Tabtin Space 动态流路由。"""

from .shared import *  # noqa: F401,F403

from apps.tabtinspace.services.space_activity_service import (
    DEFAULT_ACTIVITY_PAGE_SIZE,
    SpaceActivityService,
)

router = Router(tags=["Tabtin Space"])


# ：Workspace / Project 正式路径；/spaces/... 过渡别名保留至 Space 壳 DROP。
@router.get(
    "/spaces/{space_id}/activities",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR},
)
@router.get(
    "/workspaces/{space_id}/activities",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR},
)
@router.get(
    "/projects/{space_id}/activities",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR},
)
def list_space_activities(
    request: HttpRequest,
    space_id: UUID,
    page: int = 1,
    limit: int = DEFAULT_ACTIVITY_PAGE_SIZE,
):
    """分页返回宿主（Workspace / Project）动态流事件（最新在前）。

    viewer 及以上可读；page/limit 上限在 service 层收口。
    """
    service = SpaceActivityService(user=request.auth)
    try:
        result = service.list_activities(space_id, page=page, limit=limit)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return success_response(data=result)


__all__ = ["router"]
