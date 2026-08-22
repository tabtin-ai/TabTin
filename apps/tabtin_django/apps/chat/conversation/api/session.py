"""会话管理 API"""

import uuid
from functools import partial
from typing import Optional
from asgiref.sync import sync_to_async
from ninja import Body
from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import transaction
from django.utils import timezone

from apps.i18n import _, get_text
from apps.i18n.response import success_response, error_response_with_status
from apps.services.common.db_router import postgres_app_db_alias
from apps.services.common.error_codes import err_response
from apps.services.common.runtime_build import parse_client_build
from apps.services.llm.api_common import _read_user_default_model_id
from apps.services.daemon_control.feature import (
    daemon_control_enabled_for_organization,
)
from ..models import ChatSession, ChatMessage, SessionShare
from ..schemas import (
    CreateSessionRequest,
    QuickStartSessionRequest,
    QuickStartSessionResponse,
    UpdateSessionRequest,
    ChatSessionSchema,
    ChatSessionListResponse,
    SwitchModelRequest,
    SwitchModelResponse,
    SwitchContextTierRequest,
    SwitchContextTierResponse,
    UpdateModelParamsRequest,
    UpdateModelParamsResponse,
    GenerateTitleRequest,
    GenerateTitleResponse,
    CompactSessionRequest,
    CompactSessionResponse,
    ChatSessionWithAgentSchema,
    AllSessionListResponse,
    SessionReadAckRequest,
)
from ._common import (
    router, jwt_auth, logger,
    SESSION_PREVIEW_MAX_LEN, SESSION_PREVIEW_SHORT_LEN,
    ACTIVE_TASK_WINDOW_SECONDS,
    _get_session_with_shared_access,
    _is_model_visible_for_user,
    _get_organization_default_model_id,
    _visible_message_count,
    _last_visible_message_content,
    _session_to_schema,
    _build_session_execution_target,
    _build_session_rollback_state,
    _batch_resolve_tracker_run_meta,
    _fetch_tracker_run_session_ids,
)
from ..services.agent_mention_sessions import (
    fetch_agent_mention_session_ids as _fetch_agent_mention_session_ids,
    session_is_agent_mention as _session_is_agent_mention,
)
from ..services.llm_model_loader import attach_llm_models_to_sessions


DECLARED_MODEL_ID_PREFIX = "declared:"
def _is_declared_model_id(model_id) -> bool:
    return isinstance(model_id, str) and model_id.startswith(DECLARED_MODEL_ID_PREFIX)


def _daemon_control_enabled_for_request(request, organization_id) -> bool:
    return daemon_control_enabled_for_organization(
        client=parse_client_build(request),
        user_id=str(request.auth.id),
        organization_id=str(organization_id or ""),
    )


def _resolve_session_target_device(*, owner_user_id, workspace, device_id=""):
    from apps.services.daemon_control.client import (
        DaemonControlUnavailable,
        TargetDeviceUnavailable,
        resolve_device,
        resolve_device_by_installation,
    )

    workspace_installation_id = str(
        getattr(getattr(workspace, "device", None), "fingerprint", "") or ""
    )
    try:
        if device_id:
            target_device = resolve_device(
                owner_user_id=str(owner_user_id),
                device_id=device_id,
            )
        else:
            target_device = resolve_device_by_installation(
                owner_user_id=str(owner_user_id),
                installation_id=workspace_installation_id,
            )
    except TargetDeviceUnavailable as exc:
        return None, error_response_with_status(
            "DEVICE_UNAVAILABLE", message=str(exc), status_code=409
        )
    except DaemonControlUnavailable:
        return None, error_response_with_status(
            "SERVICE_UNAVAILABLE",
            message="设备控制服务暂时不可用",
            status_code=503,
        )

    target_device_id = str(target_device["device_id"])
    target_installation_id = str(target_device["installation_id"])
    if workspace_installation_id != target_installation_id:
        return None, error_response_with_status(
            "VALIDATION_ERROR",
            message="目标设备与执行 Workspace 所属设备不一致",
            status_code=400,
        )
    return (target_device_id, target_installation_id), None


# ============ 会话管理 ============

@router.post("/sessions", auth=jwt_auth, tags=["会话管理"])
def create_session(request, data: CreateSessionRequest):
    """
    创建新会话

    创建一个新的对话会话，关联到指定的组织
    支持指定初始使用的 LLM 模型
    """
    from apps.services.llm.models import LLMModel
    from django.conf import settings

    from apps.tabtinspace.models import Agent, Project, Workspace
    from apps.tabtinspace.services import SpaceService
    from uuid import UUID

    try:
        agent_uuid = UUID(data.agent_id)
    except Exception:
        return error_response_with_status("VALIDATION_ERROR", message="Agent ID 非法", status_code=400)
    agent = Agent.objects.filter(
        id=agent_uuid,
        is_active=True,
        owner_user_id=request.auth.id,
    ).first()
    if not agent:
        return error_response_with_status("FORBIDDEN", message="Agent 不存在或不属于当前用户", status_code=403)
    # Agent/Workspace 都是个人资源，但仍必须受当前 Organization 成员资格
    # 约束；被移出团队后不能继续用遗留 ID 创建该租户的会话。
    if not SpaceService(user=request.auth).check_organization_permission(
        str(agent.organization_id), "viewer"
    ):
        return error_response_with_status("FORBIDDEN", message="无权访问该 Organization", status_code=403)

    workspace = None
    if data.workspace_id:
        try:
            workspace_uuid = UUID(data.workspace_id)
        except Exception:
            return error_response_with_status("VALIDATION_ERROR", message="Workspace ID 非法", status_code=400)
        # ：与 check_space_permission 同真源，不再用 created_by 单独放行。
        host = SpaceService(user=request.auth).get_space(workspace_uuid)
        if not isinstance(host, Workspace):
            return error_response_with_status("FORBIDDEN", message="Workspace 不存在或不属于当前用户", status_code=403)
        workspace = host

    project = None
    if data.project_id:
        try:
            project_uuid = UUID(data.project_id)
        except Exception:
            return error_response_with_status("VALIDATION_ERROR", message="Project ID 非法", status_code=400)
        host = SpaceService(user=request.auth).get_space(project_uuid)
        if not isinstance(host, Project):
            return error_response_with_status("FORBIDDEN", message="Project 不存在或无权访问", status_code=403)
        project = host

    # 发布兼容：已安装的旧 Electron / 移动端仍会传多义 space_id。只在新字段
    # 未提供时按真实 host 类型归一，最终仍只保存 workspace/project 两个明确 FK。
    if data.space_id:
        try:
            legacy_scope_uuid = UUID(data.space_id)
        except Exception:
            return error_response_with_status("VALIDATION_ERROR", message="兼容 Space ID 非法", status_code=400)
        legacy_host = SpaceService(user=request.auth).get_space(legacy_scope_uuid)
        if legacy_host is None:
            return error_response_with_status("FORBIDDEN", message="兼容 Space 不存在或无权访问", status_code=403)
        if isinstance(legacy_host, Project):
            if project is not None and project.id != legacy_host.id:
                return error_response_with_status("VALIDATION_ERROR", message="project_id 与 space_id 不一致", status_code=400)
            project = project or legacy_host
        elif isinstance(legacy_host, Workspace):
            if workspace is not None and workspace.id != legacy_host.id:
                return error_response_with_status("VALIDATION_ERROR", message="workspace_id 与 space_id 不一致", status_code=400)
            workspace = workspace or legacy_host
        else:
            return error_response_with_status("VALIDATION_ERROR", message="兼容 Space 类型不支持", status_code=400)

    organization_id = str(agent.organization_id)
    if project and workspace is None:
        return error_response_with_status(
            "VALIDATION_ERROR",
            message="Project 会话必须指定执行 Workspace",
            status_code=400,
        )
    if workspace and str(workspace.organization_id) != organization_id:
        return error_response_with_status("VALIDATION_ERROR", message="Agent 与 Workspace 不属于同一 Organization", status_code=400)
    if project and str(project.organization_id) != organization_id:
        return error_response_with_status("VALIDATION_ERROR", message="Agent 与 Project 不属于同一 Organization", status_code=400)
    if data.organization_id and organization_id != data.organization_id:
        return error_response_with_status("VALIDATION_ERROR", message=get_text("chat.organization_mismatch", organization_id=data.organization_id), status_code=400)

    session_owner = request.auth
    requested_session_id = None
    existing_idempotent_session = None
    if data.session_id:
        try:
            requested_session_id = uuid.UUID(data.session_id)
        except (ValueError, TypeError, AttributeError):
            return error_response_with_status(
                "VALIDATION_ERROR",
                message="session_id 必须是 UUID",
                status_code=400,
            )
        existing_idempotent_session = ChatSession.objects.filter(
            id=requested_session_id
        ).first()
        if (
            existing_idempotent_session is not None
            and existing_idempotent_session.user_id != session_owner.id
        ):
            return error_response_with_status(
                "CONFLICT",
                message="session_id 已被其他用户使用，不能复用",
                status_code=409,
            )

    target_device_id = ""
    target_device_installation_id = ""
    daemon_control_enabled = False
    requested_target_device_id = (data.target_device_id or "").strip()
    if existing_idempotent_session is not None:
        if (
            requested_target_device_id
            and existing_idempotent_session.target_device_id
            != requested_target_device_id
        ):
            return error_response_with_status(
                "CONFLICT",
                message="session_id 与既有会话的目标设备不一致，不能复用或覆盖",
                status_code=409,
            )
        target_device_id = existing_idempotent_session.target_device_id
        target_device_installation_id = (
            existing_idempotent_session.target_device_installation_id
        )
    else:
        daemon_control_enabled = _daemon_control_enabled_for_request(
            request,
            organization_id,
        )
    if existing_idempotent_session is None and (
        requested_target_device_id or (workspace is not None and daemon_control_enabled)
    ):
        if not daemon_control_enabled:
            return error_response_with_status(
                "SERVICE_UNAVAILABLE",
                message="当前组织尚未启用设备控制",
                status_code=503,
            )
        resolved_target, target_error = _resolve_session_target_device(
            owner_user_id=session_owner.id,
            workspace=workspace,
            device_id=requested_target_device_id,
        )
        if target_error:
            return target_error
        target_device_id, target_device_installation_id = resolved_target

    from apps.services.llm.services.capability_guard import (
        CHAT_MODEL_MODES,
        apply_chat_model_filter,
        is_llm_model_instance,
    )
    from apps.services.llm.services.model_resolver import resolve_model

    # 获取或验证模型
    model_instance = None
    if data.model_id:
        if _is_declared_model_id(data.model_id):
            return error_response_with_status(
                "VALIDATION_ERROR",
                message=get_text("chat.model_not_found", model_id=data.model_id),
                status_code=400,
            )
        try:
            model_instance = resolve_model(
                model_id=data.model_id,
                organization_id=organization_id,
                user_id=str(request.auth.id),
                require_active=True,
                allowed_modes=CHAT_MODEL_MODES,
            )
        except (ValidationError, ValueError, TypeError, AttributeError):
            model_instance = None
        if not model_instance:
            return error_response_with_status("VALIDATION_ERROR", message=get_text("chat.model_not_found", model_id=data.model_id), status_code=400)
        if not is_llm_model_instance(model_instance, require_chat_mode=True):
            return error_response_with_status("VALIDATION_ERROR", message=get_text("chat.model_not_found", model_id=data.model_id), status_code=400)
        if not _is_model_visible_for_user(
            model_instance,
            organization_id,
            str(request.auth.id)
        ):
            return error_response_with_status("FORBIDDEN", message=get_text("chat.model_not_found", model_id=data.model_id), status_code=403)
    else:
        # 1) 优先使用当前用户在该组织下设置的个人默认模型
        user_default_model_id = _read_user_default_model_id(request.auth, organization_id)
        if user_default_model_id:
            try:
                uuid.UUID(str(user_default_model_id))
                model_instance = resolve_model(
                    model_id=user_default_model_id,
                    organization_id=organization_id,
                    user_id=str(request.auth.id),
                    require_active=True,
                    allowed_modes=CHAT_MODEL_MODES,
                )
            except (ValidationError, ValueError, TypeError, AttributeError):
                logger.info("create_session: 用户默认模型无效=%r，跳过", user_default_model_id)
                model_instance = None
            if model_instance and (
                not is_llm_model_instance(model_instance, require_chat_mode=True)
                or not _is_model_visible_for_user(
                    model_instance,
                    organization_id,
                    str(request.auth.id),
                )
            ):
                model_instance = None

        # 2) 回退到组织默认模型
        organization_default_model_id = _get_organization_default_model_id(organization_id)
        if organization_default_model_id:
            try:
                uuid.UUID(str(organization_default_model_id))
            except (ValueError, TypeError, AttributeError):
                logger.info("create_session: organization 默认模型非 UUID=%r，跳过", organization_default_model_id)
                organization_default_model_id = None
        if not model_instance and organization_default_model_id:
            model_instance = apply_chat_model_filter(
                LLMModel.objects.select_related('provider').filter(
                    id=organization_default_model_id,
                    provider__routing_enabled=True,
                ),
            ).first()
            if model_instance and not _is_model_visible_for_user(
                model_instance,
                organization_id,
                str(request.auth.id)
            ):
                model_instance = None

        # 3) 回退到系统默认模型
        if not model_instance:
            default_model_name = getattr(settings, 'DEFAULT_LLM_MODEL', 'gpt-4o')
            model_instance = apply_chat_model_filter(
                LLMModel.objects.select_related('provider').filter(
                    model_name=default_model_name,
                    provider__routing_enabled=True,
                ),
            ).first()
            if model_instance and not _is_model_visible_for_user(
                model_instance,
                organization_id,
                str(request.auth.id)
            ):
                model_instance = None

        # 4) 再回退到可用模型列表中的第一个
        if not model_instance:
            from apps.services.llm.services import get_available_models
            from apps.services.llm.services.factory import filter_models_by_member_tier
            available = get_available_models(
                user_id=str(request.auth.id),
                organization_id=organization_id
            )
            if organization_id:
                available = filter_models_by_member_tier(available, organization_id, str(request.auth.id))
            # v0.1：catalog 输出的 'mode' 已对齐到 capability_domain；chat 链路只保留 chat 域。
            chat_available = [
                m for m in available
                if (m.get('mode') or m.get('capability_domain')) in (None, 'chat', 'completion')
            ]
            # 防御：available 列表可能含「声明式模型」（provider 声明、非 DB 行，id 形如
            # declared:provider:model），用作 LLMModel 主键查会抛 UUID ValidationError（→ 500）。
            # 只取 id 为合法 UUID 的真实 DB 模型。
            _real_model_ids = []
            for _m in chat_available:
                try:
                    uuid.UUID(str(_m.get('id')))
                except (ValueError, TypeError, AttributeError):
                    continue
                _real_model_ids.append(_m['id'])
            if _real_model_ids:
                model_instance = LLMModel.objects.select_related('provider').filter(
                    id=_real_model_ids[0],
                    provider__routing_enabled=True
                ).first()

    # 产品决策：「+ 新对话」一定建新 session，不再"空会话复用"。
    #
    # 老逻辑会拿"同用户 + 同 Space + active + 无消息"的旧 session 直接复用，
    # 只覆盖 current_model_id；preset / context_tier / rollback_state /
    # 旧 thread_id 全部带回——用户点 + 看起来是新建，实际可能落到一个被
    # 回退过、有遗留状态的旧 session 上。已被 dogfood 现场证实是个体验
    # 杀手（详见 newchat 分支 reviewed PR 中的根因排查）。
    #
    # 现在改为：未提供 session_id 时，每次 createSession 都建一行新 ChatSession。
    # 客户端提供 UUID 时，它同时是会话主键和本次创建的幂等键：网络重试只能
    # 返回同一条完全一致的创建事实，绝不借此覆写已有会话。
    session_defaults = {
        "user": session_owner,
        "organization_id": organization_id,
        "agent_id": agent.id,
        "workspace_id": workspace.id if workspace else None,
        "project_id": project.id if project else None,
        "target_device_id": target_device_id,
        "target_device_installation_id": target_device_installation_id,
        "agent_mode": data.agent_mode or '',
        "title": get_text("chat.new_session_title"),
        "current_model_id": model_instance.id if model_instance else None,
        "default_model_id": model_instance.id if model_instance else None,
    }
    session_created = True
    if requested_session_id is not None:
        session, session_created = ChatSession.objects.get_or_create(
            id=requested_session_id,
            defaults=session_defaults,
        )
        if not session_created:
            # 先检查所有者，避免相同 UUID 被其他用户用作读取或覆写入口。
            if session.user_id != session_owner.id:
                return error_response_with_status(
                    "CONFLICT",
                    message="session_id 已被其他用户使用，不能复用",
                    status_code=409,
                )

            # 幂等键冻结创建时决定会话归属和运行方式的全部事实。任一项
            # 不一致均显式冲突，而不是把新请求静默映射到旧会话。
            frozen_fact_keys = (
                "organization_id",
                "agent_id",
                "workspace_id",
                "project_id",
                "target_device_id",
                "target_device_installation_id",
                "agent_mode",
            )
            # ``model_id`` 未传时表示「由服务端替新会话选择默认模型」，而不是
            # 客户端声明的创建事实。网络重试期间组织默认模型可能已调整；此时
            # 必须保留既有会话冻结的模型，不能因为当前默认值不同而把同一
            # session_id 误判成冲突。显式指定模型仍是创建事实，继续严格比较。
            if data.model_id:
                frozen_fact_keys += ("current_model_id", "default_model_id")

            requested_facts = {
                key: session_defaults[key]
                for key in frozen_fact_keys
            }
            existing_facts_all = {
                "organization_id": session.organization_id,
                "agent_id": session.agent_id,
                "workspace_id": session.workspace_id,
                "project_id": session.project_id,
                "target_device_id": session.target_device_id,
                "target_device_installation_id": session.target_device_installation_id,
                "agent_mode": session.agent_mode,
                "current_model_id": session.current_model_id,
                "default_model_id": session.default_model_id,
            }
            existing_facts = {
                key: existing_facts_all[key]
                for key in frozen_fact_keys
            }
            if existing_facts != requested_facts:
                return error_response_with_status(
                    "CONFLICT",
                    message="session_id 与既有会话的创建配置不一致，不能复用或覆盖",
                    status_code=409,
                )
    else:
        session = ChatSession.objects.create(
            **session_defaults,
        )

    # 空 session 的清理后续由 GC 任务承接（产品策略）。
    # 初始化上下文。current_space_id 是用户当前浏览的资源宿主，不再被会话创建
    # 偷写成执行 Workspace 或 Project；协作投影只写 current_project_id。
    try:
        from ..models import ChatContext
        ChatContext.objects.get_or_create(
            session=session,
            defaults={"current_project_id": project.id if project else None},
        )
    except Exception:
        logger.warning("create_session: failed to init ChatContext for session=%s", session.id, exc_info=True)

    # 新建 session 时已 fetch 出 model_instance，直接注入 FK 缓存避免 _session_to_schema 再查一次。
    # 幂等重试则必须使用既有行冻结的模型；不能把本次解析到的「当前默认模型」
    # 伪装成既有 session 的 current/default_model。
    from ..services.llm_model_loader import set_cached_session_models
    if session_created:
        set_cached_session_models(session, current=model_instance, default=model_instance)
    else:
        set_cached_session_models(
            session,
            current=session.current_model,
            default=session.default_model,
        )

    schema = _session_to_schema(
        session,
        message_count=0,
        is_reverted=bool(session.revert_message_id),
        revert_snapshot_hash=session.revert_snapshot_hash,
    )

    if session_created:
        from ..services.session_activity_publisher import publish_session_activity
        publish_session_activity(session, reason="created")

    return success_response(data=schema.model_dump(mode='json'))


@router.post("/sessions/quick-start", auth=jwt_auth, tags=["会话管理"])
def quick_start_session(request, data: QuickStartSessionRequest):
    """
    草稿预建：一次 RTT 完成 session 创建 + 初始上下文写入 + group_runtime 投影。

    供 Electron 草稿态 prefetch 使用，减少 create / context PUT / context GET 三轮往返。
    """
    from ..models import ChatContext
    from ..services.context_fingerprint import build_context_sync_fingerprint
    from apps.services.agent_engine.services.group_runtime_service import GroupRuntimeService

    create_result = create_session(
        request,
        CreateSessionRequest(
            session_id=data.session_id,
            agent_id=data.agent_id,
            workspace_id=data.workspace_id,
            target_device_id=data.target_device_id,
            project_id=data.project_id,
            space_id=data.space_id,
            organization_id=data.organization_id,
            model_id=data.model_id,
            agent_mode=data.agent_mode,
            approval_mode=data.approval_mode,
        ),
    )
    if not isinstance(create_result, dict) or not create_result.get("success"):
        return create_result

    session_data = create_result.get("data") or {}
    session_id = session_data.get("id")
    if not session_id:
        return error_response_with_status(
            "INTERNAL_ERROR",
            message=get_text("chat.session_not_found"),
            status_code=500,
        )

    context_payload: dict = {}
    if data.current_space_id is not None:
        context_payload["current_space_id"] = data.current_space_id
    if data.current_project_id is not None:
        context_payload["current_project_id"] = data.current_project_id
    if data.current_app_type is not None:
        context_payload["current_app_type"] = data.current_app_type
    if data.open_tabs is not None:
        context_payload["open_tabs"] = data.open_tabs

    group_runtime = GroupRuntimeService.extract_from_context_data(None)
    context_fingerprint = None

    if context_payload:
        from .context import update_context
        from ..schemas import UpdateContextRequest

        update_fields = {
            key: context_payload[key]
            for key in context_payload
        }
        update_result = update_context(
            request,
            session_id,
            UpdateContextRequest(**update_fields),
        )
        if not isinstance(update_result, dict) or not update_result.get("success"):
            return update_result
        context_data = (update_result.get("data") or {})
        # 指纹按客户端请求载荷对齐：空串与 null 统一成 null，避免与 Electron
        # contextPayload（current_*_id: null）对不上而反复 sync。
        fingerprint_payload = {
            "current_space_id": data.current_space_id or None,
            "current_project_id": data.current_project_id or None,
            "workspace_mode": None,
            "current_app_type": data.current_app_type,
            "userTimeZone": None,
            "open_tabs": data.open_tabs if data.open_tabs is not None else [],
        }
        group_runtime = context_data.get("group_runtime") or group_runtime
        context_fingerprint = build_context_sync_fingerprint(session_id, fingerprint_payload)
    else:
        try:
            context = ChatContext.objects.get(session_id=session_id)
            group_runtime = GroupRuntimeService.extract_from_context_data(context.context_data)
        except ChatContext.DoesNotExist:
            group_runtime = GroupRuntimeService.extract_from_context_data(None)

    response = QuickStartSessionResponse(
        session=session_data,
        group_runtime=group_runtime,
        context_fingerprint=context_fingerprint,
    )
    return success_response(data=response.model_dump(mode='json'))


@router.get("/sessions", auth=jwt_auth, tags=["会话管理"])  # noqa: F811
def list_sessions(
    request,
    workspace_id: Optional[str] = None,
    project_id: Optional[str] = None,
    # 只读兼容旧客户端；新调用必须使用 workspace_id / project_id。
    space_id: Optional[str] = None,
    limit: int = 20,
    status: Optional[str] = None,
    exclude_agent_mention_sessions: bool = False,
    include_tracker_runs: bool = False,
):
    """
    获取会话列表

    查询用户在指定 Workspace / Project 下的会话。
    ``workspace_id`` 与 ``project_id`` 二选一：前者只列执行现场中的个人会话，
    后者只列明确归属该协作场的会话。

    隐患 5 / 方案 ①(charter v1.8 §6.7 主侧栏分桶):
      - ``include_tracker_runs=False``(默认):剔除关联 TrackerRun 的 ChatSession,
        响应里附带 ``tracker_run_count`` 让前端折叠分组 header 仍能显示数量。
        per_run 模式下 Tracker 跑得多会把普通对话挤出 limit 范围,
        前端折叠分组只是 cosmetic——后端先在源头分桶才彻底。
      - ``include_tracker_runs=True``:仅返回关联 TrackerRun 的 ChatSession
        (即"打开折叠分组 → 单独 fetch Tracker 对话"模式)。
      - 跨库 PG 查询失败时 fallback 到原"不分桶"行为(返回全部) + logger.warning,
        不能让 chat 列表 API 因 scheduler 故障整个 500。
    """
    try:
        offset = int(request.GET.get('offset', 0))
        if offset < 0:
            offset = 0
    except (ValueError, TypeError):
        offset = 0

    from apps.tabtinspace.services import SpaceService
    from apps.tabtinspace.models import Workspace, Project
    from uuid import UUID

    if workspace_id and project_id:
        return error_response_with_status(
            "VALIDATION_ERROR",
            message="workspace_id 与 project_id 不能同时用于列表查询",
            status_code=400,
        )

    context_key = (workspace_id or project_id or space_id or "").strip()
    if not context_key:
        return error_response_with_status(
            "VALIDATION_ERROR",
            message="workspace_id 或 project_id 不能为空",
            status_code=400,
        )
    try:
        context_uuid = UUID(context_key)
    except Exception:
        return error_response_with_status(
            "VALIDATION_ERROR",
            message=get_text("chat.space_not_found", space_id=context_key),
            status_code=400,
        )

    host = SpaceService(user=request.auth).get_space(context_uuid)
    workspace = None
    project = None
    if (workspace_id or (space_id and not project_id)) and isinstance(host, Workspace):
        workspace = host
    elif (project_id or (space_id and not workspace_id)) and isinstance(host, Project):
        project = host
    else:
        # ：去掉 created_by 静默兜底——列表可见与写权限必须同真源
        # （SpaceMembership），否则会掩盖缺 owner membership 的数据缺口。
        return error_response_with_status(
            "FORBIDDEN",
            message=get_text("chat.space_not_found", space_id=context_key),
            status_code=403,
        )

    from django.db.models import Count, Subquery, OuterRef, Q

    # W3 §3.3.1：content → text_summary（会话列表预览专用字段）
    # ：排除 hitl_interaction——审批/追问事实行 text_summary 为空，
    # 落在最新位时会把预览打成空白。
    last_msg_subquery = ChatMessage.objects.filter(
        session=OuterRef('pk'),
    ).exclude(message_kind='hitl_interaction').order_by('-created_at').values('text_summary')[:1]
    last_role_subquery = ChatMessage.objects.filter(
        session=OuterRef('pk'),
    ).exclude(message_kind='hitl_interaction').order_by('-created_at').values('role')[:1]

    if workspace is not None:
        user_filter = Q(user=request.auth, workspace_id=workspace.id)
    else:
        # Project 成员只看自己的对话；成员协作不等于共享对方原始 Agent 对话。
        user_filter = Q(user=request.auth, project_id=project.id)

    fork_count_subquery = ChatSession.objects.filter(
        forked_from_id=OuterRef('pk'),
    ).values('forked_from_id').annotate(cnt=Count('id')).values('cnt')

    query = ChatSession.objects.select_related(
        'run_state_projection',
        'workspace__organization',
    ).filter(
        user_filter
    ).exclude(
        thread_id__contains='-sub-',
    ).annotate(
        # CH-5：message_count 排除子 Agent message（subagent_run_id 非空；与
        # _common._visible_messages_queryset / message.py get_messages 同口径）。
        _total_message_count=Count(
            'messages',
            filter=Q(messages__subagent_run_id='') | Q(messages__subagent_run_id__isnull=True),
        ),
        _last_message_content=Subquery(last_msg_subquery),
        _last_msg_role=Subquery(last_role_subquery),
        _fork_count=Subquery(fork_count_subquery),
    )

    if status:
        query = query.filter(status=status)

    # 隐患 5 / 方案 ①(charter v1.8 §6.7):后端 Tracker session 分桶。
    # _fetch_tracker_run_session_ids 跨库 PG 查询,失败时返 None → fallback 到
    # 原"不分桶"行为(不让 chat 列表 API 因 scheduler 故障整个 500)。
    # 性能:先物化本 query 范围(已按 user/space/status 过滤)的 session id 作为
    # candidate 传给 helper,让 PG 只在这批里查 TrackerRun —— 避免全表 distinct
    # 扫描 + 巨型 id__in(per_run 高频 Tracker 在归档窗口内可堆上万行)。
    # values_list('id') 不引用上面 annotate 的 Subquery,物化轻量。
    candidate_ids = list(query.values_list('id', flat=True))

    organization_id = workspace.organization_id if workspace is not None else project.organization_id
    agent_mention_session_ids: set[str] = set()
    if exclude_agent_mention_sessions:
        agent_mention_session_ids = _fetch_agent_mention_session_ids(
            organization_id=organization_id,
            candidate_session_ids=candidate_ids,
        )
        if agent_mention_session_ids:
            query = query.exclude(id__in=agent_mention_session_ids)
            candidate_ids = [
                session_id
                for session_id in candidate_ids
                if str(session_id) not in agent_mention_session_ids
            ]

    tracker_session_ids = _fetch_tracker_run_session_ids(candidate_session_ids=candidate_ids)
    tracker_run_count: Optional[int] = None
    if tracker_session_ids is not None:
        if include_tracker_runs:
            # 仅返回 Tracker session(展开折叠分组时单独 fetch 走这里)
            query = query.filter(id__in=tracker_session_ids)
        else:
            # 默认:剔除 Tracker session,响应附带 count 让前端 header badge 仍可见
            if tracker_session_ids:
                # tracker_session_ids 已被 candidate 收窄为"本 query 范围 ∩ Tracker
                # session",故 len() 即"本 Space 该用户该状态下的 Tracker session 数",
                # 与折叠分组展开后实际行数一致(不会把别人 Space / 别的用户算进来)。
                tracker_run_count = len(tracker_session_ids)
                query = query.exclude(id__in=tracker_session_ids)
            else:
                tracker_run_count = 0
    elif include_tracker_runs:
        # fallback 路径下 include_tracker_runs=True 没法靠谱满足 → 返空列表更安全,
        # 避免把"全部对话"假装成"Tracker 对话"展示给用户(否则展开分组会看到普通对话)。
        query = query.none()

    total = query.count()
    # 排序口径与 list_all_sessions 同源、与前端 getSessionActivityTs 同源：
    # 优先 last_message_at（真活跃时间），回退 updated_at（无消息会话）。
    # 否则一个 5/9 创建、今天发新消息的会话会被 updated_at 排到分页末尾，
    # 前端二次排序也救不回（已经不在 limit 范围内）。
    from django.db.models.functions import Coalesce as _Coalesce
    sessions = list(
        query.order_by(_Coalesce('last_message_at', 'updated_at').desc())
             [offset:offset+limit]
    )

    # 软引用 LLMModel 批量预加载（v0.1 宪法 §5.1，替代旧 prefetch_related）
    attach_llm_models_to_sessions(sessions)

    revert_msg_ids = [s.revert_message_id for s in sessions if s.revert_message_id]
    revert_msg_map = {}
    if revert_msg_ids:
        revert_msg_map = {
            str(m.id): m
            for m in ChatMessage.objects.filter(id__in=revert_msg_ids).only('id', 'role', 'created_at')
        }

    # P0-1 修复:批量预解析 tracker_run 元信息,避免 _session_to_schema 内部 N+1 跨库查询
    tracker_run_map = _batch_resolve_tracker_run_meta(sessions)
    page_mention_ids = (
        set()
        if exclude_agent_mention_sessions
        else _fetch_agent_mention_session_ids(
            organization_id=organization_id,
            candidate_session_ids=[s.id for s in sessions],
        )
    )

    session_list = []
    for s in sessions:
        rmsg = revert_msg_map.get(str(s.revert_message_id)) if s.revert_message_id else None
        message_count = _visible_message_count(s, revert_msg=rmsg) if s.revert_message_id else s._total_message_count
        if s.revert_message_id:
            last_visible = _last_visible_message_content(s, revert_msg=rmsg)
            preview = last_visible[:SESSION_PREVIEW_MAX_LEN] if last_visible else None
        else:
            last_content = getattr(s, '_last_message_content', None) or ''
            preview = last_content[:SESSION_PREVIEW_MAX_LEN] if last_content else None
        session_list.append(_session_to_schema(
            s,
            message_count=message_count,
            last_message_preview=preview,
            is_reverted=bool(s.revert_message_id),
            revert_snapshot_hash=s.revert_snapshot_hash,
            fork_count=getattr(s, '_fork_count', None) or 0,
            tracker_run_meta=tracker_run_map.get(str(s.id)),
            title=s.title or get_text("chat.new_session_title"),
            is_agent_mention_session=str(s.id) in page_mention_ids,
        ))

    return success_response(data=ChatSessionListResponse(
        sessions=session_list,
        total=total,
        excluded_agent_mention_session_ids=sorted(agent_mention_session_ids),
        tracker_run_count=tracker_run_count,
    ).model_dump(mode='json'))


# 列表头像：Agent 有身份但未配置自定义/品牌图时，回落品牌默认（与 Electron 编辑态一致）。
# 否则任务列表会几乎全是彩色首字（大量「默认 Space 执行身份」settings 为空）。
_DEFAULT_AGENT_AVATAR_KEY = 'general-assistant'


def _resolve_session_avatar(*, project: dict | None, agent: dict | None) -> Optional[str]:
    """会话列表头像：Project 头像优先，其次该会话 Agent 自己的头像。

    向前兼容：Project 会话的取值与历史行为完全一致（仍是 ``project.avatar``）；
    过去恒为 ``None`` 的普通会话现在补上 Agent 头像，旧客户端只会从「没有头像」
    变成「有头像」，不存在解析破坏。取值口径与 Electron ``extractAgentAvatarUrl``
    一致：自定义 ``avatar_url`` 优先，其次预置 ``avatar_key``（由客户端解析成图）。
    Agent 存在但两者皆空时回落 ``general-assistant``，避免任务列表长期首字兜底。
    """
    if project:
        project_avatar = (project.get('avatar') or '').strip()
        if project_avatar:
            return project_avatar
    if agent:
        settings = agent.get('settings')
        if isinstance(settings, dict):
            avatar_url = (settings.get('avatar_url') or '').strip()
            avatar_key = (settings.get('avatar_key') or '').strip()
            if avatar_url or avatar_key:
                return avatar_url or avatar_key
        return _DEFAULT_AGENT_AVATAR_KEY
    return None


def _build_session_summary(
    s: ChatSession,
    space_info: dict,
    project_info: dict,
    agent_info: dict,
    revert_msg=None,
    message_match_map: dict | None = None,
    tracker_run_meta: Optional[dict] = None,
    read_receipt=None,
    latest_completed_run=None,
) -> 'ChatSessionWithAgentSchema':
    """B4: 会话列表序列化工厂函数

    ``tracker_run_meta``: 由 :func:`_batch_resolve_tracker_run_meta` 批量预解析得到的
    GoalRun 元信息(charter v1.8 §6.7)。``None`` 表示该 session 未关联 Tracker Run
    (而非"还未解析")。
    """
    message_count = (
        _visible_message_count(s, revert_msg=revert_msg) if s.revert_message_id
        else getattr(s, '_total_message_count', 0)
    )

    last_role = getattr(s, '_last_msg_role', None)
    last_content = getattr(s, '_last_msg_content', None) or ''

    if s.revert_message_id:
        preview_text = _last_visible_message_content(s, revert_msg=revert_msg)
        preview = preview_text[:SESSION_PREVIEW_SHORT_LEN] if preview_text else None
    elif last_content:
        # 最后一条不论出自 Agent 还是用户都给预览：列表二行要回答「这条任务
        # 讲到哪了」，用户刚发完话就空一行是断片。Electron 发送时本来就用用户
        # 输入做乐观预览（sendMessageAction），刷新后被这里抹掉才是不一致。
        # 向前兼容：只是把过去恒为 None 的分支填上值，字段类型语义不变。
        preview = last_content[:SESSION_PREVIEW_SHORT_LEN]
    else:
        preview = None

    from apps.services.agent_engine.models import SessionRunProjection
    from apps.services.agent_engine.services.session_run_state_service import (
        ACTIVE_STATUSES,
        serialize_run_state,
    )

    try:
        projection = s.run_state_projection
    except SessionRunProjection.DoesNotExist:
        projection = None

    if projection is not None:
        run_state = serialize_run_state(projection)
        has_active = projection.status in ACTIVE_STATUSES
        last_run_failed = projection.status == 'failed'
    else:
        # 历史兼容：只有尚无权威投影的旧会话才允许按消息时间回退。
        _last_msg_recent = False
        if s.last_message_at:
            from django.utils import timezone as _tz
            _last_msg_recent = (
                _tz.now() - s.last_message_at
            ).total_seconds() < ACTIVE_TASK_WINDOW_SECONDS
        has_active = (
            s.status == 'active'
            and last_role == 'user'
            and getattr(s, '_total_message_count', 0) > 0
            and _last_msg_recent
        )
        last_run_failed = False
        run_state = None

    from apps.services.agent_engine.services.session_read_state_service import (
        SessionReadStateService,
    )
    read_snapshot = SessionReadStateService.snapshot(
        receipt=read_receipt,
        latest_completed_run=latest_completed_run,
    )

    workspace = space_info.get(str(s.workspace_id)) if s.workspace_id else None
    project = project_info.get(str(s.project_id)) if s.project_id else None
    ag_id = s.agent_id
    ag = agent_info.get(str(ag_id)) if ag_id else None

    search_match_ctx = (message_match_map or {}).get(str(s.id))

    from ..services.title_generator import TitleGeneratorService as _TGS
    from ..services.session_surface_policy import normalize_surface
    title_is_default = _TGS.should_auto_generate_title(s)
    return ChatSessionWithAgentSchema(
        id=str(s.id),
        title=s.title or get_text("chat.new_session_title"),
        title_is_default=title_is_default,
        title_generation_status=getattr(s, 'title_generation_status', None) or None,
        status=s.status,
        is_pinned=s.is_pinned,
        pinned_at=s.pinned_at,
        organization_id=s.organization_id,
        space_id=str(s.project_id) if s.project_id else (str(s.workspace_id) if s.workspace_id else None),
        workspace_id=str(s.workspace_id) if s.workspace_id else None,
        execution_target=_build_session_execution_target(
            workspace.get('device_id') if workspace else None,
            getattr(s, 'target_device_id', None),
        ),
        created_at=s.created_at,
        updated_at=s.updated_at,
        last_message_at=s.last_message_at,
        message_count=message_count,
        last_message_preview=preview,
        is_reverted=bool(s.revert_message_id),
        rollback_state=_build_session_rollback_state(s),
        space_name=(project or workspace or {}).get('name'),
        project_id=str(s.project_id) if s.project_id else None,
        project_name=project.get('name') if project else None,
        agent_id=str(ag_id) if ag_id else None,
        agent_name=ag.get('name') if ag else None,
        # Project 当前没有独立 icon 字段；不要把不存在的 ORM 字段当作
        # Agent 图标查询。Project 头像仍通过 agent_avatar 兼容现有客户端展示。
        agent_icon=None,
        agent_avatar=_resolve_session_avatar(project=project, agent=ag),
        agent_type=ag.get('type') if ag else None,
        has_active_task=has_active,
        has_unread_reply=read_snapshot["has_unread_reply"],
        read_state=read_snapshot["read_state"],
        last_run_failed=last_run_failed,
        run_state=run_state,
        search_match_context=search_match_ctx,
        # P0-2 修复:跨 Space 主列表也需要 tracker_run 字段才能让前端 trackerRuns 分组生效
        tracker_run=tracker_run_meta,
        primary_surface=normalize_surface(getattr(s, 'primary_surface', None)),
    )


def _build_match_snippet(content: str, keyword: str, max_len: int = 80) -> str:
    """从消息内容中截取关键词附近的片段作为搜索命中预览。"""
    if not content:
        return ''
    lower_content = content.lower()
    lower_kw = keyword.lower()
    pos = lower_content.find(lower_kw)
    if pos == -1:
        return content[:max_len] + ('...' if len(content) > max_len else '')
    start = max(0, pos - max_len // 3)
    end = min(len(content), pos + len(keyword) + max_len * 2 // 3)
    snippet = content[start:end]
    if start > 0:
        snippet = '...' + snippet
    if end < len(content):
        snippet = snippet + '...'
    return snippet


# 消息搜索性能常量
_MSG_SEARCH_MAX_HITS = 200
_MSG_SEARCH_TIMEOUT_MS = 3000


def _search_message_content(
    user,
    organization_id: str,
    keyword: str,
) -> tuple[list[str], dict[str, str]]:
    """搜索消息内容，返回 (匹配的 session_id 列表, {session_id: snippet} 映射)。

    优先使用 MySQL FULLTEXT (MATCH AGAINST)，不可用时降级为 icontains。
    """
    import time

    session_ids: list[str] = []
    match_map: dict[str, str] = {}
    start_ts = time.monotonic()

    base_filter = dict(
        session__user=user,
        session__organization_id=organization_id,
        role__in=['user', 'assistant'],
    )

    try:
        # W3 §3.3.1：content 字段已 drop，FULLTEXT(content) 索引随之失效；改用
        # text_summary 字段做关键词匹配（覆盖会话列表场景的"按预览搜"需求）。
        # 全文搜索完整体由 FTS（apps/fts/）独立模块承担——不在这里重建。
        msg_hits = list(
            ChatMessage.objects
            .filter(**base_filter)
            .filter(text_summary__icontains=keyword)
            .order_by('-created_at')
            .values_list('session_id', 'text_summary')[:_MSG_SEARCH_MAX_HITS]
        )
    except Exception:
        logger.info("_search_message_content: text_summary search 异常，fallback 重试")
        elapsed_ms = (time.monotonic() - start_ts) * 1000
        if elapsed_ms > _MSG_SEARCH_TIMEOUT_MS:
            logger.warning("_search_message_content: timeout after text_summary failure (%.0fms)", elapsed_ms)
            return [], {}
        try:
            # W3 §3.3.1：fallback 也用 text_summary（content 字段已 drop）
            msg_hits = list(
                ChatMessage.objects
                .filter(**base_filter, text_summary__icontains=keyword)
                .order_by('-created_at')
                .values_list('session_id', 'text_summary')[:_MSG_SEARCH_MAX_HITS]
            )
        except Exception:
            logger.warning("_search_message_content: icontains fallback failed", exc_info=True)
            return [], {}

    seen: set[str] = set()
    for sid, content in msg_hits:
        sid_str = str(sid)
        if sid_str not in seen:
            seen.add(sid_str)
            match_map[sid_str] = _build_match_snippet(content, keyword, max_len=80)
            session_ids.append(sid_str)

    elapsed_ms = (time.monotonic() - start_ts) * 1000
    if elapsed_ms > 1000:
        logger.warning(
            "_search_message_content: slow query (%.0fms, %d hits, %d sessions)",
            elapsed_ms, len(msg_hits), len(session_ids),
        )

    return session_ids, match_map


@router.get("/sessions/all", auth=jwt_auth, tags=["会话管理"])
def list_all_sessions(
    request,
    organization_id: str,
    limit: int = 50,
    offset: int = 0,
    status: Optional[str] = None,
    keyword: Optional[str] = None,
    agent_id: Optional[str] = None,
    include_tracker_runs: bool = False,
    workspace_id: Optional[str] = None,
    run_status: Optional[str] = None,
):
    """
    跨 Space 获取用户所有对话

    返回当前用户在指定 Organization 下所有 ChatSession,
    附带 Agent/Space 元信息,支持按标题搜索和按 Agent 筛选。

    可选筛选（均在排序 / 分页之前生效）:
      - ``workspace_id``: 按 ChatSession.workspace_id 收窄
      - ``run_status``: 按 ``run_state_projection.status`` 收窄（与生命周期
        ``status`` 正交；例如 active + waiting_user）
      - 无运行态投影的历史会话不会被 ``run_status`` 误纳入

    隐患 5 / 方案 ①(charter v1.8 §6.7 主侧栏分桶):
      - ``include_tracker_runs=False``(默认):剔除关联 TrackerRun 的 ChatSession,
        响应附带 ``tracker_run_count`` 让前端折叠分组 header 展示数量。
        排序 ``Coalesce(last_message_at, updated_at).desc()`` + 分页 ``[offset:offset+limit]``
        让 [Tracker] 和普通 session 共享同一个 offset —— 周期 Tracker 跑得多时
        前端 limit=50 一次拿到的可能大半是 [Tracker] 把普通对话挤出 limit 范围;
        前端折叠分组只是 cosmetic,后端在源头分桶才彻底。
      - ``include_tracker_runs=True``:仅返回关联 TrackerRun 的 ChatSession
        (即"打开折叠分组 → 单独 fetch Tracker 对话"模式)。
      - 跨库 PG 查询失败时 fallback 到原"不分桶"行为(返回全部) + logger.warning。
    """

    from django.db.models import Count, Subquery, OuterRef, Q
    from django.db.models.functions import Coalesce

    # B2: 单一 Subquery 取最后一条消息的 text_summary 和 role（W3 §3.3.1：
    # content → text_summary 字段重命名）
    # ：两个子查询同步排除 hitl_interaction——除预览空白外，_last_msg_role
    # 还参与 has_active_task 判定，事实行（role=assistant）不该改变该口径。
    last_msg_content = (
        ChatMessage.objects
        .filter(session=OuterRef('pk'))
        .exclude(message_kind='hitl_interaction')
        .order_by('-created_at')
        .values('text_summary')[:1]
    )
    last_msg_role = (
        ChatMessage.objects
        .filter(session=OuterRef('pk'))
        .exclude(message_kind='hitl_interaction')
        .order_by('-created_at')
        .values('role')[:1]
    )

    # 运行态投影随 session 一次 JOIN 取回，避免列表逐行查询。
    query = ChatSession.objects.select_related(
        'run_state_projection',
        'run_state_projection__current_run',
    ).filter(
        user=request.auth,
        organization_id=organization_id,
    ).annotate(
        # CH-5：message_count 排除子 Agent message（subagent_run_id 非空；与
        # _common._visible_messages_queryset / message.py get_messages 同口径）。
        _total_message_count=Count(
            'messages',
            filter=Q(messages__subagent_run_id='') | Q(messages__subagent_run_id__isnull=True),
        ),
        _last_msg_content=Subquery(last_msg_content),
        _last_msg_role=Subquery(last_msg_role),
    )

    if agent_id:
        query = query.filter(agent_id=agent_id)

    if status:
        query = query.filter(status=status)

    # ：workspace / 运行态筛选必须在排序与分页之前，否则客户端二次过滤
    # 会让「加载更多」跳条、段内数量不可信。
    if workspace_id:
        try:
            workspace_uuid = uuid.UUID(str(workspace_id))
        except (ValueError, TypeError, AttributeError):
            return error_response_with_status(
                "VALIDATION_ERROR",
                message="Workspace ID 非法",
                status_code=400,
            )
        query = query.filter(workspace_id=workspace_uuid)

    if run_status:
        query = query.filter(run_state_projection__status=run_status)

    message_match_map: dict[str, str] = {}
    if keyword:
        from django.db.models import Q

        title_q = Q(title__icontains=keyword)

        matching_agent_ids = []
        try:
            from apps.agent.models import Agent as _AgModel
            matching_agent_ids = list(
                _AgModel.objects.using(postgres_app_db_alias())
                .filter(organization_id=organization_id, name__icontains=keyword)
                .values_list('id', flat=True)
            )
        except Exception:
            logger.warning("list_all_sessions: keyword agent search failed", exc_info=True)

        message_match_session_ids, message_match_map = _search_message_content(
            request.auth, organization_id, keyword,
        )

        combined_q = title_q
        if matching_agent_ids:
            combined_q = combined_q | Q(agent_id__in=matching_agent_ids)
        if message_match_session_ids:
            combined_q = combined_q | Q(id__in=message_match_session_ids)
        query = query.filter(combined_q)

    # 隐患 5 / 方案 ①(charter v1.8 §6.7):后端 Tracker session 分桶 ——
    # 在排序 + 分页之前做,否则 [Tracker] 和普通 session 共享同一个 offset 时
    # 周期 Tracker 会把普通对话挤出 limit 范围(前端折叠分组只是 cosmetic)。
    # 性能:同 list_sessions,先物化本 query 范围的 id 作为 candidate 收窄跨库查询,
    # 避免全表 distinct 扫 PG TrackerRun + 巨型 id__in。
    candidate_ids = list(query.values_list('id', flat=True))
    tracker_session_ids = _fetch_tracker_run_session_ids(candidate_session_ids=candidate_ids)
    tracker_run_count: Optional[int] = None
    if tracker_session_ids is not None:
        if include_tracker_runs:
            query = query.filter(id__in=tracker_session_ids)
        else:
            if tracker_session_ids:
                # 同 list_sessions:tracker_session_ids 已被 candidate 收窄为本范围 ∩
                # Tracker,len() 即本用户本 organization 范围内的 Tracker session 数,
                # 与展开分组后实际行数一致。
                tracker_run_count = len(tracker_session_ids)
                query = query.exclude(id__in=tracker_session_ids)
            else:
                tracker_run_count = 0
    elif include_tracker_runs:
        # fallback 路径下 include=True 没法靠谱满足 → 返空更安全(同 list_sessions)
        query = query.none()

    query = query.order_by(
        Coalesce('last_message_at', 'updated_at').desc()
    )

    total = query.count()
    sessions = list(query[offset:offset + limit])
    has_more = (offset + len(sessions)) < total

    if not sessions:
        return success_response(data=AllSessionListResponse(
            sessions=[], total=total, has_more=has_more,
            tracker_run_count=tracker_run_count,
        ).model_dump(mode='json'))

    # ── Step 2: PostgreSQL 批量查 Workspace 展示信息 + Session Agent ──
    # ：ChatSession 不再有 space_id；展示信息只按 workspace_id 批量查。
    workspace_ids = list({str(s.workspace_id) for s in sessions if s.workspace_id})
    project_ids = list({str(s.project_id) for s in sessions if s.project_id})
    agent_ids = {s.agent_id for s in sessions if s.agent_id}

    space_info = {}
    project_info = {}
    agent_info = {}
    if workspace_ids:
        from apps.tabtinspace.models import Workspace as WorkspaceModel

        workspaces = WorkspaceModel.objects.using(postgres_app_db_alias()).filter(
            id__in=workspace_ids
        ).values('id', 'name', 'organization_id', 'device_id')
        for workspace in workspaces:
            space_info.setdefault(str(workspace['id']), workspace)

    if project_ids:
        from apps.tabtinspace.models import Project as ProjectModel

        projects = ProjectModel.objects.using(postgres_app_db_alias()).filter(
            id__in=project_ids
        ).values('id', 'name', 'avatar')
        for project in projects:
            project_info[str(project['id'])] = project

    if agent_ids:
        from apps.agent.models import Agent as AgentModel

        agents = AgentModel.objects.using(postgres_app_db_alias()).filter(
            id__in=list(agent_ids)
        ).values('id', 'name', 'type', 'is_active', 'settings')
        for ag in agents:
            agent_info[str(ag['id'])] = ag

    # ── Step 3: 合并结果 ──
    revert_msg_ids = [s.revert_message_id for s in sessions if s.revert_message_id]
    revert_msg_map = {}
    if revert_msg_ids:
        revert_msg_map = {
            str(m.id): m
            for m in ChatMessage.objects.filter(id__in=revert_msg_ids).only('id', 'role', 'created_at')
        }

    # P0-1 / P0-2 修复:批量预解析 tracker_run 元信息(单次跨库 PG 查询替代 N+1)
    tracker_run_map = _batch_resolve_tracker_run_meta(sessions)
    from apps.services.agent_engine.models import ExecutionRun, SessionReadReceipt

    read_receipt_map = {
        str(receipt.session_id): receipt
        for receipt in SessionReadReceipt.objects.filter(
            user=request.auth,
            session_id__in=[session.id for session in sessions],
        )
    }
    latest_completed_run_map = {
        str(run.session_id): run
        for run in ExecutionRun.objects.filter(
            session_id__in=[str(session.id) for session in sessions],
            status=ExecutionRun.Status.COMPLETED,
            unread_eligible=True,
            terminal_projection_revision__isnull=False,
        )
        .order_by("session_id", "-sequence")
        .distinct("session_id")
    }

    session_list = [
        _build_session_summary(
            s, space_info, project_info, agent_info,
            revert_msg=revert_msg_map.get(str(s.revert_message_id)) if s.revert_message_id else None,
            message_match_map=message_match_map if keyword else None,
            tracker_run_meta=tracker_run_map.get(str(s.id)),
            read_receipt=read_receipt_map.get(str(s.id)),
            latest_completed_run=latest_completed_run_map.get(str(s.id)),
        )
        for s in sessions
    ]

    return success_response(data=AllSessionListResponse(
        sessions=session_list,
        total=total,
        has_more=has_more,
        tracker_run_count=tracker_run_count,
    ).model_dump(mode='json'))


@router.get("/sessions/{session_id}", auth=jwt_auth, tags=["会话管理"])
def get_session(request, session_id: str, share_id: Optional[str] = None):
    """
    获取会话详情
    """
    # v0.1 宪法 §5.1：current_model / default_model 已是软引用（跨库 UUIDField），
    # 不再支持 select_related/prefetch_related——单点接口直接 attach 一次。
    session, _is_shared = _get_session_with_shared_access(
        session_id,
        request.auth,
        include_session_share=True,
        session_share_id=share_id,
    )
    if not session:
        return error_response_with_status("NOT_FOUND", message=_("chat.session_not_found"), status_code=404)

    attach_llm_models_to_sessions([session])
    last_visible = _last_visible_message_content(session)
    preview = (last_visible[:SESSION_PREVIEW_MAX_LEN] if last_visible else None)
    agent = session.agent if session.agent_id else None
    agent_settings = agent.settings if agent and isinstance(agent.settings, dict) else {}
    agent_avatar = agent_settings.get("avatar_url")
    schema = _session_to_schema(
        session,
        message_count=_visible_message_count(session),
        last_message_preview=preview,
        is_reverted=bool(session.revert_message_id),
        revert_snapshot_hash=session.revert_snapshot_hash,
        agent_name=((agent.name or "").strip() or None) if agent else None,
        agent_avatar=(agent_avatar.strip() or None) if isinstance(agent_avatar, str) else None,
        is_agent_mention_session=_session_is_agent_mention(session),
    )
    return success_response(data=schema.model_dump(mode='json'))


@router.post("/sessions/{session_id}/read", auth=jwt_auth, tags=["会话管理"])
def acknowledge_session_read(
    request,
    session_id: str,
    data: SessionReadAckRequest,
):
    """确认当前用户已完整查看指定 completed run；游标只能单调前进。"""
    session, _is_shared = _get_session_with_shared_access(
        session_id,
        request.auth,
        include_session_share=True,
    )
    if not session:
        return error_response_with_status(
            "NOT_FOUND",
            message=_("chat.session_not_found"),
            status_code=404,
        )

    from apps.services.agent_engine.services.session_read_state_service import (
        SessionReadStateService,
    )

    result = SessionReadStateService.acknowledge(
        session_id=session_id,
        user=request.auth,
        through_run_id=data.through_run_id,
        through_revision=data.through_revision,
    )
    if result["outcome"] == "invalid":
        return error_response_with_status(
            "VALIDATION_ERROR",
            message="阅读水位参数无效",
            status_code=400,
        )
    if result["outcome"] in {"not_found", "stale_or_non_terminal"}:
        return error_response_with_status(
            "STALE_READ_CURSOR",
            message="该运行轮次不是可确认的当前终态",
            status_code=409,
        )
    return success_response(data=result)


@router.put("/sessions/{session_id}", auth=jwt_auth, tags=["会话管理"])
@transaction.atomic
def update_session(request, session_id: str, data: UpdateSessionRequest):
    """
    更新会话
    """
    session = ChatSession.objects.select_for_update().filter(
        id=session_id,
        user=request.auth,
    ).first()
    if not session:
        return error_response_with_status("NOT_FOUND", message=_("chat.session_not_found"), status_code=404)

    if data.status == "archived" and SessionShare.objects.filter(
        session_id=session.id,
        status__in=("pending", "active"),
    ).exists():
        return error_response_with_status(
            "CONFLICT",
            message="请先停止共享任务再归档",
            status_code=409,
        )

    workspace_update_requested = 'workspace_id' in data.model_fields_set
    next_workspace = None
    resolved_target = None
    if workspace_update_requested:
        from apps.tabtinspace.models import Workspace
        from apps.tabtinspace.services import SpaceService

        if data.workspace_id is None:
            if session.target_device_installation_id:
                return error_response_with_status(
                    "CONFLICT",
                    message="已确定执行设备的会话不能切换为 observer",
                    status_code=409,
                )
        else:
            # ：绑定会话 Workspace 走 membership 权限，不用 created_by。
            host = SpaceService(user=request.auth).get_space(data.workspace_id)
            if (
                not isinstance(host, Workspace)
                or str(host.organization_id) != str(session.organization_id)
            ):
                return error_response_with_status(
                    "FORBIDDEN",
                    message="Workspace 不存在或不属于当前用户",
                    status_code=403,
                )
            frozen_installation_id = str(
                session.target_device_installation_id or ""
            )
            workspace_installation_id = str(
                getattr(getattr(host, "device", None), "fingerprint", "") or ""
            )
            if (
                frozen_installation_id
                and workspace_installation_id != frozen_installation_id
            ):
                return error_response_with_status(
                    "CONFLICT",
                    message="会话已绑定其他执行设备，不能跨设备切换 Workspace",
                    status_code=409,
                )
            if not frozen_installation_id and _daemon_control_enabled_for_request(
                request,
                session.organization_id,
            ):
                resolved_target, target_error = _resolve_session_target_device(
                    owner_user_id=request.auth.id,
                    workspace=host,
                )
                if target_error:
                    return target_error
            next_workspace = host

    if data.title is not None:
        title = data.title.strip()
        if not title:
            return error_response_with_status("BAD_REQUEST", message=_("chat.session_title_empty"), status_code=400)
        session.title = title
        # 手动重命名是用户明确写入的标题，后续 backfill / selectSession
        # 兜底不应再把它当成待生成标题反复入队。
        session.title_generation_status = 'done'
        session.title_generation_failed_at = None
    if data.status is not None:
        session.status = data.status
    if data.is_pinned is not None:
        session.is_pinned = data.is_pinned
        session.pinned_at = timezone.now() if data.is_pinned else None
    if data.agent_id is not None:
        from apps.tabtinspace.models import Agent

        agent = Agent.objects.filter(
            id=data.agent_id,
            organization_id=session.organization_id,
            owner_user_id=request.auth.id,
            is_active=True,
        ).first()
        if not agent:
            return error_response_with_status(
                "FORBIDDEN",
                message="Agent 不存在或不属于当前用户",
                status_code=403,
            )
        previous_agent_id = session.agent_id
        session.agent = agent
        # ：落库 system 事实供审计/追溯；前端时间线不再展示。
        if previous_agent_id != agent.id:
            agent_name = (agent.name or '').strip() or str(agent.id)
            ChatMessage.objects.create(
                session=session,
                role='system',
                message_kind='llm',
                text_summary=f'Agent 已切换成{agent_name}',
                metadata={
                    'system_fact': 'agent_switched',
                    'from_agent_id': str(previous_agent_id) if previous_agent_id else None,
                    'to_agent_id': str(agent.id),
                    'to_agent_name': agent_name,
                    'actor_user_id': str(request.auth.id),
                },
            )
            # 目录脸跟执行 Agent：推送带上 name/avatar，避免只改 agent_id 时旧头像残留。
            from ..services.session_activity_publisher import publish_session_activity
            publish_session_activity(session, reason="agent_switched")
    if workspace_update_requested:
        session.workspace = next_workspace
        if resolved_target:
            (
                session.target_device_id,
                session.target_device_installation_id,
            ) = resolved_target
    if data.agent_mode is not None:
        # ：与 CreateSession / chat.send_message 同字段；schema 已限制为
        # SELECTABLE_AGENT_MODES（ask|agent|plan|group）。
        session.agent_mode = data.agent_mode
    session.save()

    attach_llm_models_to_sessions([session])
    last_visible = _last_visible_message_content(session)
    preview = (last_visible[:SESSION_PREVIEW_MAX_LEN] if last_visible else None)
    schema = _session_to_schema(
        session,
        message_count=_visible_message_count(session),
        last_message_preview=preview,
        is_reverted=bool(session.revert_message_id),
        revert_snapshot_hash=session.revert_snapshot_hash,
        is_agent_mention_session=_session_is_agent_mention(session),
    )
    return success_response(data=schema.model_dump(mode='json'))


@router.delete("/sessions/{session_id}", auth=jwt_auth, tags=["会话管理"])
def delete_session(request, session_id: str):
    """
    删除会话
    """
    session = ChatSession.objects.filter(id=session_id, user=request.auth).first()
    if not session:
        return error_response_with_status("NOT_FOUND", message=_("chat.session_not_found"), status_code=404)

    session.delete()

    return success_response(message_key="chat.session_deleted")


@router.post("/sessions/{session_id}/generate-title", auth=jwt_auth, tags=["会话管理"])
async def generate_title(request, session_id: str, data: GenerateTitleRequest):
    """
    触发会话标题生成（fire-and-forget）。

    ：调用方必须在 body 携带 ``user_message``；与消息是否已落库解耦，
    不从 DB 回读正文。HTTP 立即返回 ``{accepted}``，后台用请求正文调
    ``title_generation`` scene；标题经 ``agent.user.title_updated`` 投递。
    """
    from ..services.title_generator import TitleGeneratorService
    from apps.services.agent_engine.services.persistence_pipeline import (
        dispatch_title_generation_sync_first,
        ensure_thread_id,
    )
    from apps.services.common.executor import fire_and_forget_in_agent_executor

    user_message = (data.user_message or "").strip()
    if not user_message:
        return success_response(data=GenerateTitleResponse(
            accepted=False, reason='empty_user_message',
        ).model_dump(mode='json'))

    @sync_to_async(thread_sensitive=False)
    def _load_session():
        sess = ChatSession.objects.filter(id=session_id, user=request.auth).first()
        if not sess:
            return None, None
        already_has_title = not TitleGeneratorService.should_auto_generate_title(sess)
        return sess, already_has_title

    session, already_has_title = await _load_session()
    if not session:
        return error_response_with_status(
            "NOT_FOUND",
            message=_("chat.session_not_found"),
            status_code=404,
        )

    force = bool(data.force)

    if not force and already_has_title:
        return success_response(data=GenerateTitleResponse(
            accepted=False, reason='already_has_title',
        ).model_dump(mode='json'))

    @sync_to_async(thread_sensitive=False)
    def _ensure_thread() -> str:
        return ensure_thread_id(session, str(session.id))

    thread_id = await _ensure_thread()

    fire_and_forget_in_agent_executor(
        partial(
            dispatch_title_generation_sync_first,
            session_id=str(session.id),
            thread_id=thread_id,
            user_message=user_message,
            user_id=str(request.auth.id),
            selected_model_id=(data.model_id or "").strip() or None,
            force=force,
        ),
    )

    return success_response(data=GenerateTitleResponse(
        accepted=True,
    ).model_dump(mode='json'))


@router.post("/sessions/{session_id}/compact", auth=jwt_auth, tags=["会话管理"])
def compact_session(request, session_id: str, data: CompactSessionRequest):
    """
    生成/更新会话摘要（压缩会话上下文）。

    Wave 1 A2 改造：会话不存在 / 无权访问从原 fail-soft ``{success: False, reason:
    'session_not_found'}`` 形态（被识别为"假装成功"反模式）改为显式的 NOT_FOUND
    错误响应。

    **形态备注（避免 reviewer 困惑）**：本期返回的是 ``error_response_with_status(
    'NOT_FOUND', ..., status_code=404)`` —— legacy ``(404, {success: False, code, ...})``
    tuple 形态，**不是** wire envelope ``err_response('NOT_FOUND')`` 形态。这是
    contract 主战场 §五已登记的 P1 项（``error_response_with_status`` 老 helper
    全仓 sweep 留 W6/W7 surface 收敛时统一），本期只动 fail-soft → NOT_FOUND
    的语义切换，不动 helper 形态。前端依赖 ``response.code === 'NOT_FOUND'``
    判别（HttpClient unwrap 老形态时 throw ChatAPIError，前端 caller catch 即可）。
    """
    from ..services.compaction_service import (
        SessionCompactionService,
        SessionCompactionNotFoundError,
    )

    try:
        result = SessionCompactionService.compact_session(
            session_id=session_id,
            user=request.auth,
            force=data.force,
            keep_last_messages=data.keep_last_messages,
            summary_max_tokens=data.summary_max_tokens,
        )
    except SessionCompactionNotFoundError:
        return error_response_with_status(
            "NOT_FOUND",
            message=_("chat.session_not_found"),
            status_code=404,
        )
    return success_response(data=CompactSessionResponse(**result).model_dump(mode='json'))


# ============ 模型管理（新增）============

@router.put("/sessions/{session_id}/model", auth=jwt_auth, tags=["模型管理"])
def switch_model(request, session_id: str, data: SwitchModelRequest):
    """
    切换会话使用的模型
    """
    session = ChatSession.objects.filter(id=session_id, user=request.auth).first()
    if not session:
        return error_response_with_status("NOT_FOUND", message=_("chat.session_not_found"), status_code=404)

    from apps.services.llm.services.capability_guard import CHAT_MODEL_MODES, is_llm_model_instance
    from apps.services.llm.services.model_resolver import resolve_model

    # 验证并获取目标模型
    if _is_declared_model_id(data.model_id):
        return error_response_with_status(
            "VALIDATION_ERROR",
            message=get_text("chat.model_not_found", model_id=data.model_id),
            status_code=400,
        )
    try:
        new_model = resolve_model(
            model_id=data.model_id,
            organization_id=session.organization_id,
            user_id=str(request.auth.id),
            require_active=True,
            allowed_modes=CHAT_MODEL_MODES,
        )
    except (ValidationError, ValueError, TypeError, AttributeError):
        new_model = None
    if not new_model:
        return error_response_with_status("VALIDATION_ERROR", message=get_text("chat.model_not_found", model_id=data.model_id), status_code=400)
    if not is_llm_model_instance(new_model, require_chat_mode=True):
        return error_response_with_status("VALIDATION_ERROR", message=get_text("chat.model_not_found", model_id=data.model_id), status_code=400)
    if not _is_model_visible_for_user(
        new_model,
        session.organization_id,
        str(request.auth.id)
    ):
        return error_response_with_status("FORBIDDEN", message=get_text("chat.model_not_found", model_id=data.model_id), status_code=403)

    # 记录切换前的模型（软引用：先按 ID 查 LLMModel）
    previous_id = str(session.current_model_id) if session.current_model_id else None
    previous_model = session.current_model  # property，按 ID fallback 查询一次
    previous_name = previous_model.model_name if previous_model else None

    # 校验请求里附带的 context_tier_id（若有）必须存在于目标模型档位列表
    update_fields = ['current_model_id', 'updated_at']
    requested_tier_id = (data.context_tier_id or '').strip()
    if requested_tier_id:
        tier_id = _validate_context_tier_for_model(new_model, requested_tier_id)
        if tier_id is None:
            return error_response_with_status(
                "VALIDATION_ERROR",
                message=get_text(
                    "chat.context_tier_not_found",
                    tier_id=requested_tier_id,
                ),
                status_code=400,
            )
        session.context_tier_id = tier_id
        update_fields.append('context_tier_id')
    else:
        # 切到新模型时清空老档位 ID（旧档位 ID 在新模型上很可能不存在）
        if previous_model and previous_model.id != new_model.id and session.context_tier_id:
            session.context_tier_id = ''
            update_fields.append('context_tier_id')
    # W2b:切模型保留 runtime profile 意图,不再清空。
    # 可选懒升级 v1→v2;不调用 resolver、不落 resolved。
    if session.model_param_overrides:
        from apps.services.llm.runtime_profile.persistence import (
            maybe_upgrade_stored_overrides,
        )
        upgraded = maybe_upgrade_stored_overrides(session.model_param_overrides)
        if upgraded is not None:
            session.model_param_overrides = upgraded
            update_fields.append('model_param_overrides')

    session.current_model_id = new_model.id
    session.save(update_fields=update_fields)

    def notify_session_observers():
        try:
            from apps.services.common.agent_protocol.namespace import session_event_type, session_topic
            from apps.services.common.ws.bus import publish_ws_event
            from apps.services.common.ws.protocol import build_envelope, new_event_id

            session_id_value = str(session.id)
            publish_ws_event(
                session_topic(session_id_value),
                build_envelope(
                    session_event_type("model_changed"),
                    new_event_id(),
                    {"session_id": session_id_value},
                    session_id=session_id_value,
                ),
            )
        except Exception:
            logger.warning(
                "[switch_model] Failed to notify session observers: session=%s",
                session.id,
                exc_info=True,
            )

    transaction.on_commit(notify_session_observers)

    return success_response(data=SwitchModelResponse(
        success=True,
        session_id=str(session.id),
        previous_model_id=previous_id,
        previous_model_name=previous_name,
        current_model_id=str(new_model.id),
        current_model_name=new_model.model_name,
        context_tier_id=session.context_tier_id or None,
        message=get_text("chat.model_switch_success")
    ).model_dump(mode='json'))


def _validate_context_tier_for_model(model_instance, tier_id: str) -> Optional[str]:
    """校验 tier_id 是否存在于模型 tiered_pricing.tiers 中。

    Returns: 命中时返回原 tier_id 字符串；未命中或模型未配档位时返回 None。
    """
    try:
        from apps.services.llm.services.billing import get_model_context_tiers
    except ImportError:
        return None
    tiers = get_model_context_tiers(
        getattr(model_instance, 'custom_billing_config', {}) or {}
    )
    if not tiers:
        return None
    for tier in tiers:
        if tier.get('id') == tier_id:
            return tier_id
    return None


def _normalize_model_param_overrides(
    overrides,
) -> Optional[dict]:
    """归一化 Session ``model_param_overrides`` 为 v2 落库形态。

    - 接受 v2 ``{v:2, thinking_mode:...}`` 与 v1 ``{reasoning_effort:...}``
    - 非法枚举 / 非 dict → ``None``(调用方返回 400)
    - 不调用 Proxy resolver、不写入 resolved
    """
    from apps.services.llm.runtime_profile.persistence import (
        InvalidModelParamOverrides,
        normalize_model_param_overrides_for_storage,
    )
    try:
        return normalize_model_param_overrides_for_storage(overrides)
    except InvalidModelParamOverrides:
        return None


@router.put("/sessions/{session_id}/context-tier", auth=jwt_auth, tags=["模型管理"])
def switch_context_tier(request, session_id: str, data: SwitchContextTierRequest):
    """
    切换会话当前使用的上下文档位（如标准 200K / 长上下文 1M）。

    不切换模型，仅更新档位选择。tier_id 留空 = 重置为默认档。
    """
    session = ChatSession.objects.filter(id=session_id, user=request.auth).first()
    if not session:
        return error_response_with_status(
            "NOT_FOUND", message=_("chat.session_not_found"), status_code=404,
        )

    previous_tier_id = session.context_tier_id or None
    requested_tier_id = (data.context_tier_id or '').strip()

    if not requested_tier_id:
        # 重置为默认档
        if session.context_tier_id:
            session.context_tier_id = ''
            session.save(update_fields=['context_tier_id', 'updated_at'])
        return success_response(data=SwitchContextTierResponse(
            success=True,
            session_id=str(session.id),
            previous_tier_id=previous_tier_id,
            current_tier_id=None,
            message=get_text("chat.context_tier_reset_default"),
        ).model_dump(mode='json'))

    # session.current_model 是软引用 property，会按 current_model_id 单点查 LLMModel
    current_model = session.current_model
    if not current_model:
        return error_response_with_status(
            "VALIDATION_ERROR",
            message=get_text("chat.session_no_model"),
            status_code=400,
        )

    tier_id = _validate_context_tier_for_model(current_model, requested_tier_id)
    if tier_id is None:
        return error_response_with_status(
            "VALIDATION_ERROR",
            message=get_text(
                "chat.context_tier_not_found",
                tier_id=requested_tier_id,
            ),
            status_code=400,
        )

    if session.context_tier_id != tier_id:
        session.context_tier_id = tier_id
        session.save(update_fields=['context_tier_id', 'updated_at'])

    return success_response(data=SwitchContextTierResponse(
        success=True,
        session_id=str(session.id),
        previous_tier_id=previous_tier_id,
        current_tier_id=tier_id,
        message=get_text("chat.context_tier_switch_success"),
    ).model_dump(mode='json'))


@router.put("/sessions/{session_id}/model-params", auth=jwt_auth, tags=["模型管理"])
def update_model_params(request, session_id: str, data: UpdateModelParamsRequest):
    """持久化会话级 Runtime Profile 意图(v2);响应带旧客户端兼容投影。"""
    session = ChatSession.objects.filter(id=session_id, user=request.auth).first()
    if not session:
        return error_response_with_status(
            "NOT_FOUND", message=_("chat.session_not_found"), status_code=404,
        )

    normalized = _normalize_model_param_overrides(
        data.model_param_overrides,
    )
    if normalized is None:
        return error_response_with_status(
            "VALIDATION_ERROR",
            message=_("Unsupported model runtime parameter"),
            status_code=400,
        )

    if session.model_param_overrides != normalized:
        session.model_param_overrides = normalized
        session.save(update_fields=['model_param_overrides', 'updated_at'])

    from apps.services.llm.runtime_profile.persistence import (
        serialize_model_param_overrides_for_client,
    )
    return success_response(data=UpdateModelParamsResponse(
        success=True,
        session_id=str(session.id),
        model_param_overrides=serialize_model_param_overrides_for_client(
            normalized,
        ) or {},
    ).model_dump(mode='json'))
