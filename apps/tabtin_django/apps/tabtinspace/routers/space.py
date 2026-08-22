"""#3266 终态：``/spaces`` 路由集体退役。

个人执行现场 CRUD 全部改走 ``/api/context/workspaces``（见 ``routers/workspace.py``）；
团队协作房间 CRUD 走 ``/api/context/projects``（见 ``routers/project.py``）；
Space 表本身进入退役窗口，最终随 DROP 迁移消失。

保留本模块仅为兼容前端未完成切换的旧调用：所有端点回 410 Gone + 明确迁移目标，
避免出现"你的功能坏了"的静默失败。
"""

from .shared import *  # noqa: F401,F403

router = Router(tags=["Tabtin Space"])


# 保留 space_id UUID 声明避免旧调用的 500；不做业务处理。
_GONE_TARGET_WORKSPACES = "/api/context/workspaces"
_GONE_TARGET_PROJECTS = "/api/context/projects"


def _gone(target: str, resource: str = "Space"):
    """统一 410 响应：告知调用方新的资源与端点。"""
    return 410, {
        "success": False,
        "error": {
            "code": "SPACE_RETIRED",
            "message": (
                f"{resource} 路由已退役；个人执行现场请使用 "
                f"{_GONE_TARGET_WORKSPACES}，团队协作房间请使用 {_GONE_TARGET_PROJECTS}。"
            ),
            "migration": {
                "workspaces": _GONE_TARGET_WORKSPACES,
                "projects": _GONE_TARGET_PROJECTS,
                "hint": target,
            },
        },
    }


_RESP_GONE = {410: dict, 401: ErrorResponse}


@router.get("/spaces", auth=jwt_auth, response=_RESP_GONE)
def list_spaces(request: HttpRequest):
    return _gone(_GONE_TARGET_WORKSPACES)


@router.post("/spaces", auth=jwt_auth, response=_RESP_GONE)
def create_space(request: HttpRequest):
    return _gone(_GONE_TARGET_WORKSPACES)


@router.get("/spaces/{space_id}", auth=jwt_auth, response=_RESP_GONE)
def get_space(request: HttpRequest, space_id: UUID):
    return _gone(_GONE_TARGET_WORKSPACES)


@router.put("/spaces/{space_id}", auth=jwt_auth, response=_RESP_GONE)
def update_space(request: HttpRequest, space_id: UUID):
    return _gone(_GONE_TARGET_WORKSPACES)


@router.delete("/spaces/{space_id}", auth=jwt_auth, response=_RESP_GONE)
def delete_space(request: HttpRequest, space_id: UUID):
    return _gone(_GONE_TARGET_WORKSPACES)


@router.get("/spaces/{space_id}/apps", auth=jwt_auth, response=_RESP_GONE)
def get_space_app_settings(request: HttpRequest, space_id: UUID):
    return _gone(f"{_GONE_TARGET_WORKSPACES}/{{workspace_id}}/apps")


@router.put("/spaces/{space_id}/apps", auth=jwt_auth, response=_RESP_GONE)
def update_space_app_settings(request: HttpRequest, space_id: UUID):
    return _gone(f"{_GONE_TARGET_WORKSPACES}/{{workspace_id}}/apps")


@router.post(
    "/spaces/{space_id}/ensure-execution-agent",
    auth=jwt_auth,
    response=_RESP_GONE,
)
def ensure_space_execution_agent(request: HttpRequest, space_id: UUID):
    return _gone(_GONE_TARGET_WORKSPACES)


@router.post("/spaces/{space_id}/archive", auth=jwt_auth, response=_RESP_GONE)
def archive_space(request: HttpRequest, space_id: UUID):
    return _gone(_GONE_TARGET_WORKSPACES)


@router.post("/spaces/{space_id}/restore", auth=jwt_auth, response=_RESP_GONE)
def restore_space(request: HttpRequest, space_id: UUID):
    return _gone(_GONE_TARGET_WORKSPACES)


@router.post("/spaces/{space_id}/status", auth=jwt_auth, response=_RESP_GONE)
def update_space_status(request: HttpRequest, space_id: UUID):
    return _gone(_GONE_TARGET_WORKSPACES)


@router.post("/spaces/{space_id}/trash-self", auth=jwt_auth, response=_RESP_GONE)
def trash_space(request: HttpRequest, space_id: UUID):
    return _gone(_GONE_TARGET_WORKSPACES)


@router.post(
    "/spaces/{space_id}/restore-from-trash",
    auth=jwt_auth,
    response=_RESP_GONE,
)
def restore_space_from_trash(request: HttpRequest, space_id: UUID):
    return _gone(_GONE_TARGET_WORKSPACES)


@router.delete(
    "/spaces/{space_id}/permanent-from-trash",
    auth=jwt_auth,
    response=_RESP_GONE,
)
def permanent_delete_space_from_trash(request: HttpRequest, space_id: UUID):
    return _gone(_GONE_TARGET_WORKSPACES)


@router.get(
    "/organizations/{organization_id}/trashed-spaces",
    auth=jwt_auth,
    response=_RESP_GONE,
)
def list_trashed_spaces(request: HttpRequest, organization_id: UUID):
    return _gone(_GONE_TARGET_WORKSPACES)


@router.get("/spaces/{space_id}/stats", auth=jwt_auth, response=_RESP_GONE)
def get_space_stats(request: HttpRequest, space_id: UUID):
    return _gone(_GONE_TARGET_WORKSPACES)


__all__ = ["router"]
