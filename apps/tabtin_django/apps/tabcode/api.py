"""TabCode API 路由"""

from ninja import Router

from apps.users.auth.permissions import JWTAuth

jwt_auth = JWTAuth()
from apps.i18n.response import success_response, error_response_with_status as error_response, not_found_response
from apps.tabcode.schemas import (
    CodeProjectCreateRequest,
    CodeProjectUpdateRequest,
    CodeProjectDetailOut,
)
from apps.tabcode.services.code_project_service import CodeProjectService

router = Router(tags=["TabCode"])
service = CodeProjectService()


def _serialize_project(p) -> dict:
    return CodeProjectDetailOut(
        id=str(p.id),
        title=p.title,
        local_path=p.local_path,
        git_remote_url=p.git_remote_url,
        status=p.status,
        created_at=p.created_at.isoformat(),
        updated_at=p.updated_at.isoformat(),
    ).dict()


# ── 项目级 CRUD ──────────────────────────────────────────────


@router.get(
    "/spaces/{space_id}/code-projects",
    auth=jwt_auth,
    summary="列出代码项目",
)
def list_code_projects(request, space_id: str):
    try:
        projects = service.list_projects(space_id, request.auth)
        return success_response([_serialize_project(p) for p in projects])
    except Exception as e:
        return error_response(str(e))


@router.post(
    "/spaces/{space_id}/code-projects",
    auth=jwt_auth,
    summary="创建代码项目",
)
def create_code_project(request, space_id: str, body: CodeProjectCreateRequest):
    organization_id = request.headers.get("X-Organization-Id", "").strip()
    if not organization_id:
        return error_response("缺少 X-Organization-Id", code=400)

    try:
        from apps.tabtinspace.services.base import ensure_space_in_organization
        ensure_space_in_organization(organization_id, space_id)
    except ValueError:
        return not_found_response("Agent空间不存在或不属于指定组织")

    try:
        p = service.create_project(
            space_id=space_id,
            organization_id=organization_id,
            user=request.auth,
            title=body.title,
            local_path=body.local_path,
            git_remote_url=body.git_remote_url,
        )
        return success_response(_serialize_project(p))
    except Exception as e:
        return error_response(str(e))


@router.get(
    "/spaces/{space_id}/code-projects/{code_project_id}",
    auth=jwt_auth,
    summary="获取代码项目详情",
)
def get_code_project(request, space_id: str, code_project_id: str):
    try:
        p = service.get_project(space_id, code_project_id, request.auth)
        return success_response(_serialize_project(p))
    except CodeProjectService.DoesNotExist:
        return error_response("代码项目不存在", code=404)
    except Exception as e:
        return error_response(str(e))


@router.put(
    "/spaces/{space_id}/code-projects/{code_project_id}",
    auth=jwt_auth,
    summary="更新代码项目",
)
def update_code_project(
    request, space_id: str, code_project_id: str, body: CodeProjectUpdateRequest
):
    try:
        p = service.update_project(
            space_id=space_id,
            code_project_id=code_project_id,
            user=request.auth,
            title=body.title,
            local_path=body.local_path,
            git_remote_url=body.git_remote_url,
        )
        return success_response(_serialize_project(p))
    except Exception as e:
        return error_response(str(e))


@router.delete(
    "/spaces/{space_id}/code-projects/{code_project_id}",
    auth=jwt_auth,
    summary="归档代码项目",
)
def archive_code_project(request, space_id: str, code_project_id: str):
    try:
        service.archive_project(space_id, code_project_id, request.auth)
        return success_response({"archived": True})
    except Exception as e:
        return error_response(str(e))


@router.post(
    "/spaces/{space_id}/code-projects/{code_project_id}/trash",
    auth=jwt_auth,
    summary="移入回收站",
)
def trash_code_project(request, space_id: str, code_project_id: str):
    try:
        service.trash_project(space_id, code_project_id, request.auth)
        return success_response({"trashed": True})
    except ValueError as e:
        return error_response(str(e))
    except Exception as e:
        return error_response(str(e))


@router.post(
    "/spaces/{space_id}/code-projects/{code_project_id}/restore-from-trash",
    auth=jwt_auth,
    summary="从回收站恢复",
)
def restore_code_project_from_trash(request, space_id: str, code_project_id: str):
    try:
        service.restore_project_from_trash(space_id, code_project_id, request.auth)
        return success_response({"restored": True})
    except ValueError as e:
        return error_response(str(e))
    except Exception as e:
        return error_response(str(e))


@router.delete(
    "/spaces/{space_id}/code-projects/{code_project_id}/permanent",
    auth=jwt_auth,
    summary="永久删除",
)
def permanent_delete_code_project(request, space_id: str, code_project_id: str):
    try:
        service.permanent_delete_project(space_id, code_project_id, request.auth)
        return success_response({"deleted": True})
    except ValueError as e:
        return error_response(str(e))
    except Exception as e:
        return error_response(str(e))
