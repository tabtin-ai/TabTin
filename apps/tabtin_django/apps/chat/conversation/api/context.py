"""上下文管理 API"""

from ninja import Body

from apps.i18n import _, get_text
from apps.i18n.response import success_response, error_response_with_status
from apps.services.agent_engine.services.group_runtime_service import GroupRuntimeService
from ..models import ChatSession
from ..schemas import (
    ContextResponse,
    UpdateContextRequest,
    ResolveContextRequest,
    ResolveContextResponse,
)
from ._common import (
    router, jwt_auth, logger,
    RECENT_ITEMS_MAX_COUNT,
)


# ============ 上下文管理 ============

@router.get("/sessions/{session_id}/context", auth=jwt_auth, tags=["上下文管理"])
def get_context(request, session_id: str):
    """
    获取会话的上下文信息
    """
    from ..models import ChatContext

    session = ChatSession.objects.filter(id=session_id, user=request.auth).first()
    if not session:
        return error_response_with_status("NOT_FOUND", message=_("chat.session_not_found"), status_code=404)

    try:
        context = session.context
        resp = ContextResponse(
            current_space_id=context.current_space_id or "",
            current_project_id=str(context.current_project_id or session.project_id or ""),
            current_table_id=context.current_table_id or "",
            current_view_id=context.current_view_id or "",
            recent_spaces=context.recent_spaces or [],
            recent_tables=context.recent_tables or [],
            recent_views=context.recent_views or [],
            context_data=context.context_data or {},
            group_runtime=GroupRuntimeService.extract_from_context_data(context.context_data),
        )
    except ChatContext.DoesNotExist:
        resp = ContextResponse(
            current_project_id=str(session.project_id or ""),
            group_runtime=GroupRuntimeService.extract_from_context_data(None),
        )
    return success_response(data=resp.model_dump(mode='json'))


@router.put("/sessions/{session_id}/context", auth=jwt_auth, tags=["上下文管理"])
def update_context(request, session_id: str, data: UpdateContextRequest):
    """
    更新会话的上下文信息
    """
    from ..models import ChatContext

    session = ChatSession.objects.filter(id=session_id, user=request.auth).first()
    if not session:
        return error_response_with_status("NOT_FOUND", message=_("chat.session_not_found"), status_code=404)

    context, created = ChatContext.objects.get_or_create(session=session)

    explicitly_set = data.model_fields_set

    if 'current_space_id' in explicitly_set:
        context.current_space_id = data.current_space_id or ""
        if data.current_space_id and data.current_space_id not in context.recent_spaces:
            context.recent_spaces.insert(0, data.current_space_id)
            context.recent_spaces = context.recent_spaces[:RECENT_ITEMS_MAX_COUNT]

    if 'current_project_id' in explicitly_set:
        project_id = data.current_project_id or ""
        if project_id:
            from uuid import UUID

            from apps.tabtinspace.models import Project
            from apps.tabtinspace.services import SpaceService

            try:
                project_uuid = UUID(str(project_id))
            except (ValueError, TypeError):
                return error_response_with_status(
                    "VALIDATION_ERROR", message="Project ID 非法", status_code=400,
                )
            project = SpaceService(user=request.auth).get_space(project_uuid)
            if not isinstance(project, Project):
                return error_response_with_status(
                    "FORBIDDEN", message="Project 不存在或无权访问", status_code=403,
                )
            if str(project.organization_id) != str(session.organization_id):
                return error_response_with_status(
                    "VALIDATION_ERROR", message="Project 与会话不属于同一 Organization", status_code=400,
                )
            context.current_project_id = project.id
        else:
            context.current_project_id = None

    if 'current_table_id' in explicitly_set:
        context.current_table_id = data.current_table_id or ""
        if data.current_table_id and data.current_table_id not in context.recent_tables:
            context.recent_tables.insert(0, data.current_table_id)
            context.recent_tables = context.recent_tables[:RECENT_ITEMS_MAX_COUNT]

    if 'current_view_id' in explicitly_set:
        context.current_view_id = data.current_view_id or ""
        if data.current_view_id and data.current_view_id not in context.recent_views:
            context.recent_views.insert(0, data.current_view_id)
            context.recent_views = context.recent_views[:RECENT_ITEMS_MAX_COUNT]

    from apps.services.common.app_registry import get_all_context_field_names
    _app_fields = (
        ('current_app_type',)
        + get_all_context_field_names()
        + ('sandbox_path', 'current_folder_path', 'open_tabs')
    )
    ctx_data = context.context_data or {}
    for field in _app_fields:
        if field in explicitly_set:
            value = getattr(data, field, None)
            if value is not None:
                ctx_data[field] = value
            else:
                ctx_data.pop(field, None)
    if 'group_runtime' in explicitly_set:
        group_runtime_payload = (
            data.group_runtime.model_dump(mode='python')
            if data.group_runtime is not None
            else None
        )
        ctx_data = GroupRuntimeService.merge_into_context_data(
            ctx_data,
            group_runtime=group_runtime_payload,
        )
    context.context_data = ctx_data

    context.save()

    # 冷启动弱信号：显式带了可映射 current_app_type 且会话仍为 chat 时升格一次。
    # 已是非 chat 不覆盖（用户乱点 App 不改任务脸）。强证据升格见 Phase C。
    if 'current_app_type' in explicitly_set and data.current_app_type:
        from ..services.session_surface_policy import (
            apply_weak_primary_surface_from_app_type,
        )
        apply_weak_primary_surface_from_app_type(session, data.current_app_type)

    return success_response(data=ContextResponse(
        current_space_id=context.current_space_id or "",
        current_project_id=str(context.current_project_id or session.project_id or ""),
        current_table_id=context.current_table_id or "",
        current_view_id=context.current_view_id or "",
        recent_spaces=context.recent_spaces or [],
        recent_tables=context.recent_tables or [],
        recent_views=context.recent_views or [],
        context_data=context.context_data or {},
        group_runtime=GroupRuntimeService.extract_from_context_data(context.context_data),
    ).model_dump(mode='json'))


# ============ @ 引用解析 ============

@router.post("/resolve-context", auth=jwt_auth, tags=["上下文管理"])
def resolve_context(request, data: ResolveContextRequest):
    """
    解析 @ 引用的上下文 blocks，返回 LLM 可用的文本。

    本地 Runtime 在发送消息前调用此端点，将 @表格/@文档/@字段等引用
    解析为实际数据，注入到 LLM 的 prompt 中。

    整体解析失败时返回非 2xx，让前端落到本地兜底（含 table_id），
    避免静默返回空 context_text 导致 Agent 对引用一无所知。
    单 block 失败仍由 resolve_context_blocks 内部 per-block 降级处理。
    """
    from ..services.context_resolver import resolve_context_blocks

    user_id = str(request.auth.id)
    try:
        context_text, resolved_blocks = resolve_context_blocks(
            data.blocks, user_id,
        )
    except Exception as e:
        logger.warning("[resolve_context] Failed: user=%s error=%s", user_id, e)
        return error_response_with_status(
            "RESOLVE_CONTEXT_FAILED",
            message=_("chat.resolve_context_failed"),
            status_code=500,
            data={
                "resolve_failed": True,
                "context_text": "",
                "resolved_count": 0,
            },
        )

    resolved_count = sum(
        1 for b in resolved_blocks if b.get('_resolved_text')
    )

    return success_response(data=ResolveContextResponse(
        context_text=context_text,
        resolved_count=resolved_count,
    ).model_dump(mode='json'))
