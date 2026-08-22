"""Tabtin Project 路由（团队协作场景， 终态）。

Project 是 :class:`tabtinspace.Project` 真表；本路由以 Project 产品语言读取协作房间。
创建 Project 时会同时给创建者供给一个 Workspace；后续成员接受邀请或首次进入 Project
时供给自己的 Workspace。
"""

from django.conf import settings
from ninja import Schema
from typing import Optional

from .shared import *  # noqa: F401,F403

from apps.tabtinspace.models import Project
from apps.tabtinspace.services.project_service import ProjectService
from apps.tabtinspace.services.project_invitation_service import ProjectInvitationService
from apps.tabtinspace.services.project_task_service import ProjectTaskService

router = Router(tags=["Tabtin Space"])


def _projects_enabled() -> bool:
    return bool(getattr(settings, 'TABTIN_ENABLE_PROJECTS', False))


def _project_feature_disabled_response():
    return error_response('FEATURE_DISABLED', 'Project 功能暂未开放', status_code=403)


class ProjectInviteIn(Schema):
    user_id: str
    role: str = 'editor'


class ProjectInviteAcceptIn(Schema):
    device_id: UUID
    working_dir: str
    working_dir_type: str = ''


class ProjectCreateWithWorkspaceIn(ProjectInviteAcceptIn):
    organization_id: UUID
    name: str
    description: str = ''


class ProjectPrimaryAgentIn(Schema):
    agent_id: Optional[UUID] = None


class ProjectTaskCreateIn(Schema):
    title: str
    description: str = ''
    priority: str = 'medium'
    responsible_user_id: UUID


class ProjectTaskBatchCreateIn(Schema):
    tasks: list[ProjectTaskCreateIn]


class ProjectTaskAssignmentResponseIn(Schema):
    accept: bool


class ProjectTaskExecutionIn(Schema):
    agent_id: UUID
    workspace_id: UUID


class ProjectTaskCommentIn(Schema):
    content: str


class ProjectTaskStartRunAttachmentIn(Schema):
    type: str = 'file'
    file_id: str = ''
    filename: str = '附件'
    mime_type: str = ''
    size: int = 0
    url: str = ''
    preview_url: str = ''


class ProjectTaskStartRunIn(Schema):
    message: str = ''
    attachments: list[ProjectTaskStartRunAttachmentIn] = []


class ProjectTaskAcceptanceIn(Schema):
    result_summary: str = ''
    deliverable_title: str = ''
    result_item_ids: Optional[list[UUID]] = None


class ProjectTaskResultVisibilityIn(Schema):
    result_visibility: str


class ProjectTaskBlankResourceIn(Schema):
    resource_type: str
    title: str = ''


def _serialize_project(service: ProjectService, project: Project, *, include_my_workspace: bool = False) -> dict:
    data = {
        "id": str(project.id),
        "organization_id": str(project.organization_id),
        #  终态：Project 只有一种类型，前端仍取 'team_space' 字面量以保持兼容。
        "type": "team_space",
        "name": project.name,
        "description": project.description,
        "avatar": project.avatar,
        "color": project.color,
        "status": project.status,
        # execution_space 语义已废弃：执行落到成员各自 Workspace，无 owner 代执行。
        "execution_space_id": None,
        "table_count": 0,
        "order": project.order,
        "is_archived": project.is_archived,
        "is_default": project.is_default,
        "visibility": project.visibility,
        "member_count": service.member_count(project),
        "primary_agent_id": (
            str(primary_agent_id) if (primary_agent_id := service.primary_agent_id(project)) else None
        ),
        "can_manage": service.check_space_permission(str(project.id), 'editor'),
        "config_version": project.config_version,
        "last_activity_at": project.last_activity_at.isoformat() if project.last_activity_at else None,
        "created_at": project.created_at.isoformat(),
        "updated_at": project.updated_at.isoformat(),
    }
    if include_my_workspace:
        data["my_workspace"] = service.serialize_my_workspace(project=project, user=service.user)
    return data


def _parse_page(request: HttpRequest) -> tuple[int, int]:
    try:
        page = int(request.GET.get('page', '1') or '1')
    except (TypeError, ValueError):
        page = 1
    try:
        page_size = int(request.GET.get('page_size', '100') or '100')
    except (TypeError, ValueError):
        page_size = 100
    return max(1, page), min(max(1, page_size), 200)


@router.get("/projects", auth=jwt_auth, response={200: dict, **RESP_ERR})
def list_projects(request: HttpRequest):
    if not _projects_enabled():
        return success_response({"projects": [], "total": 0})

    organization_id_str = request.GET.get('organization_id')
    if not organization_id_str or organization_id_str in ['null', 'undefined', '']:
        return success_response({"projects": [], "total": 0})

    page, page_size = _parse_page(request)
    service = ProjectService(user=request.auth)
    projects, total = service.list_projects(
        organization_id=UUID(organization_id_str), page=page, page_size=page_size,
    )
    return success_response({
        "projects": [_serialize_project(service, p) for p in projects],
        "total": total,
    })


@router.post("/projects/create-with-workspace", auth=jwt_auth, response=RESP_CREATE_WITH_CONFLICT)
def create_project_with_workspace(request: HttpRequest, data: ProjectCreateWithWorkspaceIn):
    """创建 Project，并在同一事务里创建当前用户的 Workspace。"""
    if not _projects_enabled():
        return _project_feature_disabled_response()

    service = ProjectService(user=request.auth)
    try:
        project, workspace = service.create_project_with_my_workspace(
            organization_id=data.organization_id,
            name=data.name,
            description=data.description,
            device_id=data.device_id,
            working_dir=data.working_dir,
            working_dir_type=data.working_dir_type,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return 201, success_response({
        "project": _serialize_project(service, project, include_my_workspace=True),
        "workspace": workspace,
    })


@router.get("/projects/invitations/pending", auth=jwt_auth, response={200: dict, **RESP_ERR})
def list_my_pending_project_invitations(request: HttpRequest):
    if not _projects_enabled():
        return success_response({"invitations": [], "total": 0})

    service = ProjectInvitationService(user=request.auth)
    try:
        rows = service.list_my_pending_invitations()
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return success_response({
        "invitations": [
            {
                "project_id": str(row["project"].id),
                "project_name": row["project"].name,
                "organization_id": str(row["project"].organization_id),
                "role": row["membership"].role,
                "inviter_name": row["inviter_name"],
                "invited_at": row["membership"].updated_at.isoformat(),
            }
            for row in rows
        ],
        "total": len(rows),
    })


@router.get("/projects/{project_id}", auth=jwt_auth, response={200: dict, **RESP_ERR})
def get_project(request: HttpRequest, project_id: UUID):
    if not _projects_enabled():
        return _project_feature_disabled_response()

    service = ProjectService(user=request.auth)
    project = service.get_project(project_id)
    if not project:
        return not_found_response("Project")
    return success_response(_serialize_project(service, project, include_my_workspace=True))


@router.get("/projects/{project_id}/invitations", auth=jwt_auth, response={200: dict, **RESP_ERR})
def list_project_pending_invitations(request: HttpRequest, project_id: UUID):
    """列出本 Project 尚未接受的邀请（Owner 侧「待接受」状态，）。"""
    if not _projects_enabled():
        return _project_feature_disabled_response()

    service = ProjectInvitationService(user=request.auth)
    try:
        invitations = service.list_project_pending_invitations(project_id=project_id)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return success_response({
        "invitations": invitations,
        "total": len(invitations),
    })


@router.post("/projects/{project_id}/invitations", auth=jwt_auth, response=RESP_CREATE_WITH_CONFLICT)
def invite_project_member(request: HttpRequest, project_id: UUID, data: ProjectInviteIn):
    if not _projects_enabled():
        return _project_feature_disabled_response()

    service = ProjectInvitationService(user=request.auth)
    try:
        membership = service.invite_member(
            project_id=project_id, target_user_id=data.user_id, role=data.role,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return 201, success_response({
        "membership_id": str(membership.id),
        "project_id": str(project_id),
        "user_id": str(membership.user_id),
        "role": membership.role,
        "status": membership.status,
    }, message="邀请已发送")


@router.put("/projects/{project_id}/primary-agent", auth=jwt_auth, response={200: dict, **RESP_ERR_400})
def set_project_primary_agent(request: HttpRequest, project_id: UUID, data: ProjectPrimaryAgentIn):
    if not _projects_enabled():
        return _project_feature_disabled_response()
    service = ProjectService(user=request.auth)
    try:
        agent_id = service.set_primary_agent(project_id=project_id, agent_id=data.agent_id)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return success_response({
        "project_id": str(project_id),
        "primary_agent_id": str(agent_id) if agent_id else None,
    })


@router.post("/projects/{project_id}/invitations/accept", auth=jwt_auth, response={200: dict, **RESP_ERR_400})
def accept_project_invitation(request: HttpRequest, project_id: UUID, data: ProjectInviteAcceptIn):
    if not _projects_enabled():
        return _project_feature_disabled_response()

    service = ProjectInvitationService(user=request.auth)
    try:
        result = service.accept(
            project_id=project_id,
            device_id=data.device_id,
            working_dir=data.working_dir,
            working_dir_type=data.working_dir_type,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return success_response(result, message="已加入项目")


@router.post("/projects/{project_id}/invitations/reject", auth=jwt_auth, response={200: dict, **RESP_ERR_400})
def reject_project_invitation(request: HttpRequest, project_id: UUID):
    if not _projects_enabled():
        return _project_feature_disabled_response()

    service = ProjectInvitationService(user=request.auth)
    try:
        service.reject(project_id=project_id)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return success_response(message="已拒绝邀请")


@router.post("/projects/{project_id}/workspace/ensure", auth=jwt_auth, response={200: dict, **RESP_WITH_CONFLICT})
def ensure_my_project_workspace(request: HttpRequest, project_id: UUID, data: ProjectInviteAcceptIn):
    """当前 Project 成员幂等供给自己的伴生 Workspace（创建者链路 / 存量成员补齐）。"""
    if not _projects_enabled():
        return _project_feature_disabled_response()

    service = ProjectService(user=request.auth)
    try:
        workspace = service.ensure_my_workspace(
            project_id=project_id,
            device_id=data.device_id,
            working_dir=data.working_dir,
            working_dir_type=data.working_dir_type,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return success_response({"workspace": workspace})


@router.get("/projects/{project_id}/tasks", auth=jwt_auth, response={200: dict, **RESP_ERR})
def list_project_tasks(request: HttpRequest, project_id: UUID):
    if not _projects_enabled():
        return _project_feature_disabled_response()
    try:
        tasks = ProjectTaskService(user=request.auth).list_tasks(project_id=project_id)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return success_response({"tasks": tasks, "total": len(tasks)})


@router.get("/projects/{project_id}/tasks/inbox", auth=jwt_auth, response={200: dict, **RESP_ERR})
def list_my_project_task_inbox(request: HttpRequest, project_id: UUID):
    if not _projects_enabled():
        return _project_feature_disabled_response()
    try:
        tasks = ProjectTaskService(user=request.auth).list_inbox(project_id=project_id)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return success_response({"tasks": tasks, "total": len(tasks)})


@router.get(
    "/organizations/{organization_id}/agents/{agent_id}/tasks",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR},
    summary="按 Agent 聚合跨 Project 任务",
)
def list_agent_project_tasks(
    request: HttpRequest,
    organization_id: UUID,
    agent_id: UUID,
):
    if not _projects_enabled():
        return _project_feature_disabled_response()
    try:
        raw_limit = request.GET.get('limit', '20')
        limit = int(raw_limit)
        if limit < 1:
            raise ValueError
    except (ValueError, TypeError):
        return error_response('INVALID_LIMIT', 'limit 参数无效', status_code=400)
    try:
        result = ProjectTaskService(user=request.auth).list_tasks_for_agent(
            organization_id=organization_id,
            agent_id=agent_id,
            cursor=request.GET.get('cursor', ''),
            limit=limit,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return success_response(result)


@router.post("/projects/{project_id}/tasks", auth=jwt_auth, response=RESP_CREATE_WITH_CONFLICT)
def create_project_task(request: HttpRequest, project_id: UUID, data: ProjectTaskCreateIn):
    if not _projects_enabled():
        return _project_feature_disabled_response()
    try:
        task = ProjectTaskService(user=request.auth).create_task(
            project_id=project_id,
            title=data.title,
            description=data.description,
            priority=data.priority,
            responsible_user_id=data.responsible_user_id,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return 201, success_response({"task": task})


@router.post("/projects/{project_id}/tasks/batch", auth=jwt_auth, response=RESP_CREATE_WITH_CONFLICT)
def create_project_tasks_batch(request: HttpRequest, project_id: UUID, data: ProjectTaskBatchCreateIn):
    if not _projects_enabled():
        return _project_feature_disabled_response()
    try:
        tasks = ProjectTaskService(user=request.auth).create_tasks(
            project_id=project_id,
            task_specs=[task.dict() for task in data.tasks],
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return 201, success_response({"tasks": tasks, "total": len(tasks)})


@router.get("/projects/{project_id}/tasks/{task_id}", auth=jwt_auth, response={200: dict, **RESP_ERR})
def get_project_task(request: HttpRequest, project_id: UUID, task_id: UUID):
    if not _projects_enabled():
        return _project_feature_disabled_response()
    try:
        task = ProjectTaskService(user=request.auth).get_task(
            project_id=project_id,
            task_id=task_id,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return success_response({"task": task})


@router.get("/projects/tasks/current", auth=jwt_auth, response={200: dict, **RESP_ERR_400})
def get_current_project_task_workbench(request: HttpRequest):
    """只按 CLI 透传的当前 ChatSession 推导 Project Task，不能传入 Task ID。"""
    if not _projects_enabled():
        return _project_feature_disabled_response()
    try:
        workbench = ProjectTaskService(user=request.auth).get_current_task_workbench(
            session_id=request.headers.get('X-Tabtin-Session-Id', ''),
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return success_response({"workbench": workbench})


@router.post(
    "/projects/tasks/current/resources",
    auth=jwt_auth,
    response={200: dict, **RESP_WITH_CONFLICT},
)
def create_current_project_task_blank_resource(
    request: HttpRequest,
    data: ProjectTaskBlankResourceIn,
):
    """空白直建 TabDoc/TabData，并挂到当前 ProjectTaskRun.result_items。"""
    if not _projects_enabled():
        return _project_feature_disabled_response()
    try:
        resource = ProjectTaskService(user=request.auth).create_blank_task_resource(
            session_id=request.headers.get('X-Tabtin-Session-Id', ''),
            resource_type=data.resource_type,
            title=data.title or '',
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return success_response({"resource": resource})


@router.get("/projects/{project_id}/tasks/{task_id}/feedback", auth=jwt_auth, response={200: dict, **RESP_ERR})
def list_project_task_feedback(request: HttpRequest, project_id: UUID, task_id: UUID):
    """供 Agent 增量读取指定 Task 的公开人工评论。"""
    if not _projects_enabled():
        return _project_feature_disabled_response()
    try:
        raw_limit = request.GET.get('limit', '50')
        limit = int(raw_limit)
        if limit < 1:
            raise ValueError
        feedback = ProjectTaskService(user=request.auth).list_task_feedback(
            project_id=project_id,
            task_id=task_id,
            cursor=request.GET.get('cursor', ''),
            limit=limit,
        )
    except ValueError:
        return error_response('TASK_FEEDBACK_LIMIT_INVALID', 'limit 必须是正整数', status_code=400)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return success_response(feedback)


@router.get("/projects/{project_id}/tasks/{task_id}/workbench", auth=jwt_auth, response={200: dict, **RESP_ERR})
def get_project_task_workbench(request: HttpRequest, project_id: UUID, task_id: UUID):
    """供 Agent CLI 读取的脱敏 Project Task 工作面。"""
    if not _projects_enabled():
        return _project_feature_disabled_response()
    try:
        workbench = ProjectTaskService(user=request.auth).get_task_workbench(
            project_id=project_id,
            task_id=task_id,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return success_response({"workbench": workbench})


@router.post(
    "/projects/{project_id}/tasks/{task_id}/assignment-response",
    auth=jwt_auth,
    response={200: dict, **RESP_WITH_CONFLICT},
)
def respond_project_task_assignment(
    request: HttpRequest,
    project_id: UUID,
    task_id: UUID,
    data: ProjectTaskAssignmentResponseIn,
):
    if not _projects_enabled():
        return _project_feature_disabled_response()
    try:
        task = ProjectTaskService(user=request.auth).respond_assignment(
            project_id=project_id,
            task_id=task_id,
            accept=data.accept,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return success_response({"task": task})


@router.put(
    "/projects/{project_id}/tasks/{task_id}/execution",
    auth=jwt_auth,
    response={200: dict, **RESP_WITH_CONFLICT},
)
def configure_project_task_execution(
    request: HttpRequest,
    project_id: UUID,
    task_id: UUID,
    data: ProjectTaskExecutionIn,
):
    if not _projects_enabled():
        return _project_feature_disabled_response()
    try:
        task = ProjectTaskService(user=request.auth).configure_execution(
            project_id=project_id,
            task_id=task_id,
            agent_id=data.agent_id,
            workspace_id=data.workspace_id,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return success_response({"task": task})


@router.post(
    "/projects/{project_id}/tasks/{task_id}/comments",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR_400},
)
def add_project_task_comment(
    request: HttpRequest,
    project_id: UUID,
    task_id: UUID,
    data: ProjectTaskCommentIn,
):
    if not _projects_enabled():
        return _project_feature_disabled_response()
    try:
        task = ProjectTaskService(user=request.auth).add_comment(
            project_id=project_id,
            task_id=task_id,
            content=data.content,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return success_response({"task": task}, message="评论已发布")


@router.post(
    "/projects/{project_id}/tasks/{task_id}/runs/prepare",
    auth=jwt_auth,
    response={200: dict, **RESP_WITH_CONFLICT},
)
def prepare_project_task_run(request: HttpRequest, project_id: UUID, task_id: UUID):
    if not _projects_enabled():
        return _project_feature_disabled_response()
    try:
        result = ProjectTaskService(user=request.auth).prepare_run(
            project_id=project_id,
            task_id=task_id,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return success_response(result, message="执行会话已准备，可补充说明后开始")


@router.post(
    "/projects/{project_id}/tasks/{task_id}/runs",
    auth=jwt_auth,
    response={200: dict, **RESP_WITH_CONFLICT},
)
def start_project_task_run(
    request: HttpRequest,
    project_id: UUID,
    task_id: UUID,
    data: ProjectTaskStartRunIn = ProjectTaskStartRunIn(),
):
    if not _projects_enabled():
        return _project_feature_disabled_response()
    try:
        result = ProjectTaskService(user=request.auth).start_run(
            project_id=project_id,
            task_id=task_id,
            message=data.message or '',
            attachments=[item.dict() for item in (data.attachments or [])],
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return success_response(result, message="任务已开始执行")


@router.post(
    "/projects/{project_id}/tasks/{task_id}/cancel",
    auth=jwt_auth,
    response={200: dict, **RESP_WITH_CONFLICT},
)
def cancel_project_task(request: HttpRequest, project_id: UUID, task_id: UUID):
    if not _projects_enabled():
        return _project_feature_disabled_response()
    try:
        task = ProjectTaskService(user=request.auth).cancel_task(
            project_id=project_id,
            task_id=task_id,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return success_response({"task": task}, message="任务已取消")


@router.post(
    "/projects/{project_id}/tasks/{task_id}/acceptance",
    auth=jwt_auth,
    response={200: dict, **RESP_WITH_CONFLICT},
)
def accept_project_task_result(
    request: HttpRequest,
    project_id: UUID,
    task_id: UUID,
    data: ProjectTaskAcceptanceIn,
):
    if not _projects_enabled():
        return _project_feature_disabled_response()
    try:
        task = ProjectTaskService(user=request.auth).accept_result(
            project_id=project_id,
            task_id=task_id,
            result_summary=data.result_summary,
            deliverable_title=data.deliverable_title,
            result_item_ids=data.result_item_ids,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return success_response({"task": task}, message="验收完成，结果已发布到 Project 资产")


@router.post(
    "/projects/{project_id}/tasks/{task_id}/result-visibility",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR_400},
)
def set_project_task_result_visibility(
    request: HttpRequest,
    project_id: UUID,
    task_id: UUID,
    data: ProjectTaskResultVisibilityIn,
):
    """责任人开放/收回验收前结果预览；不改变任务状态。"""
    if not _projects_enabled():
        return _project_feature_disabled_response()
    try:
        task = ProjectTaskService(user=request.auth).set_result_visibility(
            project_id=project_id,
            task_id=task_id,
            result_visibility=data.result_visibility,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return success_response({"task": task}, message="结果可见性已更新")


# ── Project 生命周期：归档 / 回收站（；替代已 410 的 /context/spaces/*）──


@router.post("/projects/{project_id}/archive", auth=jwt_auth, response={200: dict, **RESP_ERR})
def archive_project(request: HttpRequest, project_id: UUID):
    if not _projects_enabled():
        return _project_feature_disabled_response()
    service = SpaceService(user=request.auth)
    try:
        success = service.archive_space(project_id)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    if not success:
        return permission_denied_response(_("tabtinspace.space_archive_failed"))
    return success_response(message="Project 已归档")


@router.post("/projects/{project_id}/restore", auth=jwt_auth, response={200: dict, **RESP_ERR})
def restore_project(request: HttpRequest, project_id: UUID):
    if not _projects_enabled():
        return _project_feature_disabled_response()
    service = SpaceService(user=request.auth)
    try:
        success = service.restore_space(project_id)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    if not success:
        return permission_denied_response(_("tabtinspace.space_restore_failed"))
    return success_response(message="Project 已从归档恢复")


@router.post("/projects/{project_id}/trash", auth=jwt_auth, response={200: dict, **RESP_ERR})
def trash_project(request: HttpRequest, project_id: UUID):
    if not _projects_enabled():
        return _project_feature_disabled_response()
    service = SpaceService(user=request.auth)
    try:
        success = service.trash_space(project_id)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    if not success:
        return permission_denied_response(_("tabtinspace.space_trash_failed"))
    return success_response(message="Project 已移入回收站")


@router.post(
    "/projects/{project_id}/restore-from-trash",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR},
)
def restore_project_from_trash(request: HttpRequest, project_id: UUID):
    if not _projects_enabled():
        return _project_feature_disabled_response()
    service = SpaceService(user=request.auth)
    try:
        success = service.restore_space_from_trash(project_id)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    if not success:
        return permission_denied_response(_("tabtinspace.space_restore_failed"))
    return success_response(message="Project 已从回收站恢复")


@router.delete(
    "/projects/{project_id}/permanent-from-trash",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR_400},
)
def permanent_delete_project_from_trash(request: HttpRequest, project_id: UUID):
    """从回收站永久删除 Project（不可恢复）。"""
    if not _projects_enabled():
        return _project_feature_disabled_response()
    service = SpaceService(user=request.auth)
    try:
        success = service.permanent_delete_space_from_trash(project_id)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    if not success:
        return permission_denied_response(_("tabtinspace.space_permanent_delete_failed"))
    return success_response(
        data={"project_id": str(project_id)},
        message="Project 已永久删除",
    )


@router.get(
    "/organizations/{organization_id}/trashed-projects",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR},
)
def list_trashed_projects(request: HttpRequest, organization_id: UUID):
    """列出组织内已移入回收站的 Project（替代已 410 的 trashed-spaces）。"""
    from apps.tabtinspace.models import OrganizationMember, Project

    if not _projects_enabled():
        return success_response({"items": [], "total": 0})

    user = request.auth
    if not user:
        raise HttpError(401, _("auth.unauthenticated"))

    is_member = OrganizationMember.objects.filter(
        organization_id=organization_id,
        user_id=user.id,
    ).exists()
    if not is_member:
        if not getattr(user, 'is_superuser', False):
            raise HttpError(403, _("tabtinspace.no_organization_access"))
        logger.warning(
            "[PermissionBypass] superuser accessed trashed projects: user=%s organization=%s",
            user.id, organization_id,
        )

    projects = (
        Project.objects
        .filter(organization_id=organization_id, trashed_at__isnull=False)
        .only(
            'id', 'name', 'avatar', 'description', 'status',
            'trashed_at', 'trashed_by', 'previous_status', 'created_at',
        )
        .order_by('-trashed_at')
    )

    items = [
        {
            "id": str(row.id),
            "name": row.name,
            "icon": getattr(row, "avatar", "") or "",
            "description": row.description,
            "status": row.status,
            "type": "team_space",
            "trashed_at": row.trashed_at.isoformat() if row.trashed_at else None,
            "trashed_by": str(row.trashed_by) if row.trashed_by else None,
            "previous_status": row.previous_status,
            "created_at": row.created_at.isoformat() if row.created_at else None,
        }
        for row in projects
    ]
    return success_response({"items": items, "total": len(items)})
