"""
Conversation API 共享基础设施

所有子模块共用的 router、认证、日志、常量和辅助函数。
"""

from ninja import Router
from typing import Any, Iterable, Optional
from uuid import UUID
import logging

from apps.users.auth.permissions import JWTAuth
from apps.i18n import _, get_text
from apps.i18n.response import success_response, error_response_with_status
from ..models import ChatSession, ChatMessage
from apps.services.common.db_router import postgres_app_db_alias
from apps.services.agent_execution.effective_runtime_config import resolve_workspace_approval_mode

try:
    from apps.collab.services.checkpoint_context import USER_PROMPT_PREVIEW_MAX_LENGTH as _USER_PROMPT_MAX
except ImportError:
    _USER_PROMPT_MAX = 200

router = Router()
jwt_auth = JWTAuth()
logger = logging.getLogger(__name__)

# ============ 模块常量 ============
FORK_ASYNC_THRESHOLD = 200
FORK_BATCH_SIZE = 500
SESSION_PREVIEW_MAX_LEN = 120
SESSION_PREVIEW_SHORT_LEN = 60
ACTIVE_TASK_WINDOW_SECONDS = 300
MAX_MESSAGE_PAGE_SIZE = 100
REVERT_HISTORY_MAX_ENTRIES = 50
RECENT_ITEMS_MAX_COUNT = 10
CHECKPOINT_DEGRADED_REASON_MISSING_FILE_SNAPSHOT = 'missing_file_snapshot'
CHECKPOINT_DEGRADED_REASON_MISSING_RESOURCE_SNAPSHOT = 'missing_resource_snapshot'
CHECKPOINT_DEGRADED_REASON_MISSING_EFFECTIVE_CHECKPOINT = 'missing_effective_checkpoint'

# 哨兵值:区分 "未预解析(回退到单点查询)" vs "已预解析为 None(跳过)"。
# 列表 API 走批量预解析,把 ``tracker_run_meta=batch_map.get(sid)`` 传进 ``_session_to_schema``
# (None 也是合法的预解析结果);get_session 等单点 API 不传该参数,触发单点解析以保持兼容。
_UNSET = object()


def _build_session_execution_target(workspace_device_id, target_device_id=None):
    """生成会话执行目标；历史冻结目标优先于 Workspace 当前绑定。"""
    device_id = target_device_id or workspace_device_id
    if not device_id:
        return None
    return {
        'kind': 'bound_device',
        'device_identity_key': str(device_id),
    }


def _get_session_with_shared_access(
    session_id,
    user,
    *,
    include_session_share=False,
    session_share_id=None,
    **_legacy_kwargs,
):
    """获取当前用户可访问的 session，返回 ``(session, is_shared)``。

    三级判据（命中即返回）：
    1. **owner**：``session.user == user`` → ``(session, False)``；
    2. **workspace 共享**：对 session 锚点 Workspace 有成员权限 → ``(session, True)``；
    3. **会话共享（ 文档协同式）**：该用户持有 active ``SessionShare``
       （grantee）→ ``(session, True)``。组织内全量透明——过程 / 工具 / 产物随
       主链路读端点与 WS 实时流对 grantee 放开，这正是产品口径。

    ``include_session_share``：**默认 False（安全默认）**。第 3 分支只授权
    「读 + 流」——读端点 / WS 订阅 / ``user_can_access_session`` 必须显式传
    ``True``；写路径保持默认或显式 ``False``，拦掉 session-share grantee。
    grantee 发言驱动只走 shared-chat（can_chat 档、执行身份 = owner，见
    api/session_share.py）。

    历史参数 ``select_related_fields`` 已废弃——v0.1 宪法 §5.1 后 current_model /
    default_model 是软引用 UUIDField，不支持 select_related。调用方需在 fetch 完
    session 后显式调 :func:`attach_llm_models_to_sessions` 预加载（或依赖 property
    单点 fallback）。这里保留 ``**_legacy_kwargs`` 是兼容旧调用方，不再生效。

    非 UUID 的 session_id（如前端误传的 prompt_*）直接视为未找到，避免 UUIDField
    查询抛 ValidationError 并污染 Sentry。
    """
    try:
        UUID(str(session_id))
    except (ValueError, TypeError, AttributeError):
        return None, False

    # sharedsession: 入口携带具体 shareId 时，权限只认这一张卡。这里必须放在
    # owner / Workspace / 任意 active share 之前，避免撤销后的共享页借其它权限
    # 继续读取；普通任务入口不传该字段，保持既有兼容语义。
    if session_share_id is not None:
        if not include_session_share:
            return None, False
        try:
            from ..services import session_share_service

            scoped_share = session_share_service.get_active_share_by_id_for_user(
                share_id=session_share_id,
                session_id=session_id,
                user=user,
            )
        except Exception:
            scoped_share = None
            logger.warning(
                "[conversation] share-scoped access check failed: "
                "session=%s share=%s user=%s",
                session_id,
                session_share_id,
                getattr(user, "id", None),
                exc_info=True,
            )
        if scoped_share is not None:
            return scoped_share.session, True
        return None, False

    qs = ChatSession.objects.select_related("workspace__organization")

    session = qs.filter(id=session_id, user=user).first()
    if session:
        return session, False

    #  / ：ChatSession.space FK 已 Drop；共享访问以 workspace 为锚，
    # 成员权限门替代旧的 space__type=team_space 闸门。
    #
    # Project 私有执行会话挂在责任人伴生 Workspace 上：其他 Project 成员对该
    # Workspace 无权限，故不会误入 shared 分支。合法 shared/team
    # session 仍可通过 Workspace 成员权限放行。
    shared_session = (
        qs.select_related("workspace")
        .filter(id=session_id, workspace__isnull=False)
        .first()
    )
    if shared_session and shared_session.workspace_id:
        try:
            from apps.tabtinspace.services.base import BaseService

            if BaseService(user=user).check_space_permission(str(shared_session.workspace_id)):
                return shared_session, True
        except Exception:
            logger.warning(
                "[conversation] shared workspace session access check failed: "
                "session=%s user=%s",
                session_id,
                getattr(user, "id", None),
                exc_info=True,
            )

    #  会话共享（文档协同式）：仅当调用方显式 include_session_share=True
    # 时放行——读 / 流全量透明；默认 False 防写路径漏传扩大权限。
    if include_session_share and user is not None:
        try:
            from ..services import session_share_service

            share = session_share_service.get_active_share(
                session_id=session_id, user=user,
            )
        except Exception:
            share = None
            logger.warning(
                "[conversation] session share access check failed: session=%s user=%s",
                session_id,
                getattr(user, "id", None),
                exc_info=True,
            )
        if share is not None:
            return share.session, True

    return None, False


def user_can_access_session(session_id, user, *, session_share_id=None) -> bool:
    """HTTP / WS 共用的 owner-or-shared capability。

    与 :func:`_get_session_with_shared_access` 同判据：本人拥有、对 session
    锚点 Workspace 有成员权限，或持有 active SessionShare（——grantee
    据此订阅 WS 实时流，revoked 后立即失效）。Project 私有执行会话对非责任人
    返回 False。本函数只回答「能不能看」；写权限由各写端点自行把关。
    """
    if user is None:
        return False
    session, _is_shared = _get_session_with_shared_access(
        session_id,
        user,
        include_session_share=True,
        session_share_id=session_share_id,
    )
    return session is not None


def resolve_session_id_for_thread(thread_id: Optional[str]) -> Optional[str]:
    """把 ``agent.stream.{thread_id}`` 映射到 ChatSession.id。

    ``chat-session-{uuid}`` 直接解析；其它合法 thread 前缀回查
    ``ChatSession.thread_id``。解析失败返回 None（调用方 fail-close）。
    """
    if not thread_id:
        return None
    prefix = "chat-session-"
    if thread_id.startswith(prefix):
        candidate = thread_id[len(prefix):]
        try:
            UUID(str(candidate))
        except (ValueError, TypeError, AttributeError):
            return None
        return candidate
    try:
        session_id = (
            ChatSession.objects.filter(thread_id=thread_id)
            .values_list("id", flat=True)
            .first()
        )
    except Exception:
        logger.warning(
            "[conversation] resolve_session_id_for_thread failed: thread=%s",
            thread_id,
            exc_info=True,
        )
        return None
    return str(session_id) if session_id else None


def _is_model_visible_for_user(model, organization_id: Optional[str], user_id: Optional[str]) -> bool:
    # v0.1：LLMProvider.is_active 字段已删（0022），可见性 = provider.routing_enabled + scope。
    if not model or not model.provider or not getattr(model.provider, 'routing_enabled', False):
        return False

    provider = model.provider
    scope = getattr(provider, 'scope', 'global')

    if scope == 'global':
        return True

    if scope == 'organization':
        return bool(organization_id) and provider.organization_id == organization_id

    if scope == 'user':
        if not user_id or provider.user_id != str(user_id):
            return False
        if provider.organization_id:
            return bool(organization_id) and provider.organization_id == organization_id
        return True

    return False


def _get_organization_default_model_id(organization_id: Optional[str]) -> Optional[str]:
    if not organization_id:
        return None
    from apps.tabtinspace.models import Organization
    try:
        organization = Organization.objects.get(id=organization_id)
    except Organization.DoesNotExist:
        return None
    settings = organization.settings or {}
    return settings.get('llm_default_model_id')


def _visible_messages_queryset(session: ChatSession, revert_msg=None):
    """返回 revert 状态下可见的消息 queryset，非 revert 时返回全部消息。

    传入已查好的 revert_msg 可避免重复查库（批量场景优化）。

    CH-5：统一排除子 Agent message（subagent_run_id 非空）——它们经 daemon trace
    wiring 落进主 session（设计上保留落库，见 ChatMessage.message_kind 字段注释），
    但不属于主对话，不应计入消息数 / 不应在主时间线展示。与 message.py get_messages
    的 `exclude(subagent_run_id__gt='')` 同口径。
    """
    base = session.messages.exclude(subagent_run_id__gt='')
    if not session.revert_message_id:
        return base

    if revert_msg is None:
        revert_msg = session.messages.filter(id=session.revert_message_id).first()
    if not revert_msg:
        return base

    return base.filter(_build_revert_visible_message_filter(session, revert_msg))


def _build_revert_visible_message_filter(session: ChatSession, revert_msg: ChatMessage):
    """构造回退态消息可见过滤条件。

    普通消息只展示回退点之前的内容；system 消息也不应无条件放行，
    否则会把被回退区间里后续 turn 的系统提示重新漏到时间线里。
    唯一例外是本次 rollback 后生成的系统提示，用 ``revert_at`` 区分。

     方案 B：可见边界按**对话时间**（arrival_seq）而非 created_at——
    relay 迟到重投的行 created_at 是补投时刻，与真实对话顺序可颠倒；legacy 行
    回落 created_at（见 conversation_time.q_conversation_before）。assistant
    目标含自身（id__lte 语义）、user 目标不含，与旧口径一致。
    """
    from django.db.models import Q

    from ..services.conversation_time import q_conversation_before

    visible_before_target = q_conversation_before(
        revert_msg,
        include_target=revert_msg.role == 'assistant',
    )
    if not session.revert_at:
        return visible_before_target
    return visible_before_target | Q(role='system', created_at__gte=session.revert_at)


def _visible_message_count(session: ChatSession, revert_msg=None) -> int:
    """在 revert 状态下返回可见消息数，否则返回全部消息数。"""
    return _visible_messages_queryset(session, revert_msg=revert_msg).count()


def _get_space_checkpoint_summaries(
    session: ChatSession,
    checkpoint_hashes: Iterable[str],
) -> dict[str, dict[str, Any]]:
    """批量查询 SpaceCheckpoint 摘要，避免消息列表 N+1。"""
    hashes = list(dict.fromkeys([
        checkpoint_hash
        for checkpoint_hash in checkpoint_hashes
        if checkpoint_hash
    ]))
    if not hashes or not session.workspace_id:
        return {}

    try:
        from apps.collab.models import SpaceCheckpoint

        # ：ChatSession.workspace 已是执行现场，不再经 Space.execution_space 跳转
        checkpoint_space_id = session.workspace_id

        rows = (
            SpaceCheckpoint.objects.using(postgres_app_db_alias())
            .filter(space_id=checkpoint_space_id, file_checkpoint_hash__in=hashes)
            .order_by("file_checkpoint_hash", "-created_at")
            .values(
                "file_checkpoint_hash",
                "id",
                "version_refs",
                "agent_run_id",
                "trigger",
                "created_at",
                "metadata",
            )
        )

        summaries: dict[str, dict[str, Any]] = {}
        for row in rows:
            checkpoint_hash = row.get("file_checkpoint_hash")
            if not checkpoint_hash or checkpoint_hash in summaries:
                continue
            summaries[checkpoint_hash] = {
                "id": row.get("id"),
                "version_refs": row.get("version_refs"),
                "agent_run_id": row.get("agent_run_id"),
                "trigger": row.get("trigger"),
                "created_at": row.get("created_at"),
                "metadata": row.get("metadata") or {},
            }
        return summaries
    except Exception:
        logger.debug("checkpoint space summaries lookup failed", exc_info=True)
        return {}


def _get_space_checkpoint_summary(
    session: ChatSession,
    checkpoint_hash: Optional[str],
) -> Optional[dict[str, Any]]:
    if not checkpoint_hash:
        return None
    return _get_space_checkpoint_summaries(session, [checkpoint_hash]).get(checkpoint_hash)


def _last_visible_message_content(session: ChatSession, revert_msg=None) -> str:
    """在 revert 状态下返回最后一条可见消息的 text_summary（W3 §3.3.1：
    content → text_summary 字段重命名）。

    ：排除 hitl_interaction 事实行（text_summary 恒空，会把预览打成空白）。"""
    last = (
        _visible_messages_queryset(session, revert_msg=revert_msg)
        .exclude(message_kind='hitl_interaction')
        .order_by('-created_at')
        .values_list('text_summary', flat=True)
        .first()
    )
    return last or ''


def _derive_cleanup_status(session: ChatSession) -> str:
    """根据当前 session 字段和最近历史推导最小 cleanup 状态。"""
    if session.revert_message_id:
        return 'pending'
    if session.revert_state_index is not None:
        return 'pending_retry'
    history = list(session.revert_history or [])
    for entry in reversed(history):
        if entry.get('type') == 'cleanup':
            status = entry.get('cleanup_status') or 'done'
            if status == 'abandoned':
                return 'failed'
            return status
    last_apply_entry = _get_last_revert_apply_entry(session)
    if last_apply_entry and last_apply_entry.get('type') in ('rollback', 'unrevert'):
        return 'done'
    return 'not_started'


def _get_last_revert_apply_entry(session: ChatSession) -> Optional[dict[str, Any]]:
    """返回最近一次 rollback / unrevert 的聚合结果。"""
    history = list(session.revert_history or [])
    for entry in reversed(history):
        if entry.get('type') in ('rollback', 'unrevert'):
            return entry
    return None


def _build_checkpoint_capability_scope(
    *,
    has_file_snapshot: bool,
    has_resource_snapshot: bool,
    can_unrevert: bool = False,
) -> dict[str, bool]:
    return {
        'message_preview': True,
        'file_diff': has_file_snapshot,
        'file_restore': has_file_snapshot,
        'resource_restore': has_resource_snapshot,
        'unrevert': can_unrevert,
    }


def _extract_checkpoint_context(
    space_checkpoint: Optional[dict[str, Any]],
) -> Optional[dict[str, Any]]:
    """从 SpaceCheckpoint.metadata 中提取 checkpoint_context。"""
    if not space_checkpoint:
        return None
    metadata = space_checkpoint.get('metadata') or {}
    return metadata.get('checkpoint_context')


def _build_checkpoint_record(
    message: ChatMessage,
    *,
    space_checkpoint: Optional[dict[str, Any]] = None,
    messages_to_remove: int = 0,
    resource_change_count: int = 0,
    resource_restore_count: int = 0,
    compact: bool = True,
):
    """构建用户可见的 checkpoint 聚合视图。"""
    from ..schemas import (
        CheckpointRecordView,
        CheckpointResourceSnapshotRefView,
        CheckpointConversationStateRefView,
        CheckpointImpactSummaryView,
        CheckpointCapabilityScopeView,
        CheckpointContextView,
        CheckpointImpactDetailView,
    )

    file_snapshot_ref = message.checkpoint_hash or None
    version_refs = (space_checkpoint or {}).get('version_refs') or {}
    has_resource_snapshot = bool(version_refs)
    degraded_reasons: list[str] = []
    if not file_snapshot_ref:
        degraded_reasons.append(CHECKPOINT_DEGRADED_REASON_MISSING_FILE_SNAPSHOT)
    if not has_resource_snapshot:
        degraded_reasons.append(CHECKPOINT_DEGRADED_REASON_MISSING_RESOURCE_SNAPSHOT)

    # 对话时间线本身是每条已完成 assistant turn 的回退锚点；即便这轮没有
    # 文件/资源快照，仍可安全回退对话，只是不能完整恢复外部副作用。因此这里
    # 必须是 degraded 而不是 unavailable，否则客户端会把"回退到这里"入口隐藏掉。
    if degraded_reasons:
        status = 'degraded'
    else:
        status = 'ready'

    sp_id = (space_checkpoint or {}).get('id')
    checkpoint_id = str(sp_id) if sp_id else str(message.id)

    ctx_raw = _extract_checkpoint_context(space_checkpoint)
    checkpoint_policy = ((space_checkpoint or {}).get('metadata') or {}).get('checkpoint_policy') or {}
    checkpoint_trigger = (space_checkpoint or {}).get('trigger') or checkpoint_policy.get('trigger') or None
    visible_in_history = checkpoint_policy.get('visibleInHistory')
    if visible_in_history is None:
        visible_in_history = checkpoint_policy.get('visible_in_history')
    context_summary = None
    if ctx_raw:
        full_prompt = ctx_raw.get('user_prompt') or ''
        decision_summary_raw = ctx_raw.get('decision_summary')
        sub_conversations_raw = ctx_raw.get('sub_conversations')
        common_fields = dict(
            session_id=ctx_raw.get('session_id'),
            assistant_message_id=ctx_raw.get('assistant_message_id'),
            user_message_id=ctx_raw.get('user_message_id') or None,
            agent_run_id=ctx_raw.get('agent_run_id'),
            intent_summary=ctx_raw.get('intent_summary'),
            decision_summary=decision_summary_raw if isinstance(decision_summary_raw, dict) else None,
            sub_conversations=sub_conversations_raw if isinstance(sub_conversations_raw, list) else None,
        )
        if compact:
            context_summary = CheckpointContextView(
                user_prompt=full_prompt[:_USER_PROMPT_MAX] if full_prompt else None,
                **common_fields,
            )
        else:
            impact_raw = ctx_raw.get('impact') or {}
            context_summary = CheckpointContextView(
                user_prompt=full_prompt or None,
                **common_fields,
                impact=CheckpointImpactDetailView(
                    files=impact_raw.get('files'),
                    files_truncated=impact_raw.get('files_truncated', False),
                    files_total_count=impact_raw.get('files_total_count', 0),
                    resources=impact_raw.get('resources'),
                    resources_truncated=impact_raw.get('resources_truncated', False),
                    resources_total_count=impact_raw.get('resources_total_count', 0),
                ) if impact_raw else None,
            )

    return CheckpointRecordView(
        checkpoint_id=checkpoint_id,
        session_id=str(message.session_id),
        anchor_type='assistant_turn',
        anchor_message_id=str(message.id),
        anchor_agent_run_id=message.agent_run_id or None,
        created_at=message.created_at,
        file_snapshot_ref=file_snapshot_ref,
        resource_snapshot_ref=CheckpointResourceSnapshotRefView(
            space_checkpoint_id=str(sp_id) if sp_id else None,
            has_version_refs=has_resource_snapshot,
            version_ref_count=len(version_refs),
            agent_run_id=(space_checkpoint or {}).get('agent_run_id') or message.agent_run_id or None,
        ) if (space_checkpoint is not None or has_resource_snapshot) else None,
        conversation_state_ref=CheckpointConversationStateRefView(
            checkpoint_state_index=message.checkpoint_state_index,
        ),
        status=status,
        capability_scope=CheckpointCapabilityScopeView(**_build_checkpoint_capability_scope(
            has_file_snapshot=bool(file_snapshot_ref),
            has_resource_snapshot=has_resource_snapshot,
            can_unrevert=True,
        )),
        degraded_reasons=degraded_reasons,
        impact_summary=CheckpointImpactSummaryView(
            file_summary=message.diff_summary,
            resource_change_count=resource_change_count,
            resource_restore_count=resource_restore_count,
            messages_to_remove=messages_to_remove,
        ),
        context_summary=context_summary,
        trigger=checkpoint_trigger,
        visible_in_history=visible_in_history if isinstance(visible_in_history, bool) else None,
    )


def _build_session_rollback_state(session: ChatSession):
    """构建会话级 rollback 状态视图。"""
    from ..schemas import SessionRollbackStateView

    last_apply_entry = _get_last_revert_apply_entry(session)
    return SessionRollbackStateView(
        session_id=str(session.id),
        revert_active=bool(session.revert_message_id),
        target_message_id=str(session.revert_message_id) if session.revert_message_id else None,
        target_checkpoint_id=None,
        revert_state_index=session.revert_state_index,
        safety_snapshot_ref=session.revert_snapshot_hash,
        cleanup_status=_derive_cleanup_status(session),
        can_unrevert=bool(session.revert_message_id),
        last_apply_result=(last_apply_entry or {}).get('apply_result'),
        partial_success_details=(last_apply_entry or {}).get('partial_success_details'),
        resource_restore_state=session.revert_resource_state,
        last_rollback_reason=(last_apply_entry or {}).get('rollback_reason'),
        last_operation_mode=(last_apply_entry or {}).get('mode') or 'rollback',
        updated_at=session.updated_at,
    )


def _build_rollback_apply_result(
    *,
    apply_id: str,
    session: ChatSession,
    overall_status: str,
    checkpoint_record=None,
    file_restore_success: bool = True,
    file_restore_status: Optional[str] = None,
    file_restore_failure_reason: str = 'daemon_restore_failed',
    restored_count: int = 0,
    failed_count: int = 0,
    retryable_items: Optional[list[dict[str, str]]] = None,
    collab_sync_warnings: Optional[list[dict[str, str]]] = None,
):
    """构建 rollback / unrevert / resource restore 的聚合结果。"""
    from ..schemas import (
        RollbackApplyLayerView,
        RollbackApplyLayersView,
        RollbackApplyResultView,
    )

    cleanup_status = _derive_cleanup_status(session)
    workspace_file_status = file_restore_status or (
        'success' if file_restore_success else 'failed'
    )
    # RollbackApplyLayerView 使用跨层通用枚举；对外 response 的 unavailable 在层级
    # 视图中仍是 failed，并通过 reason 保留“设备不可用”而非“写盘失败”的区别。
    workspace_layer_status = {
        'partial': 'partial_success',
        'unavailable': 'failed',
    }.get(workspace_file_status, workspace_file_status)
    return RollbackApplyResultView(
        apply_id=apply_id,
        overall_status=overall_status,
        checkpoint_id=checkpoint_record.checkpoint_id if checkpoint_record else None,
        checkpoint_record=checkpoint_record,
        session_state=_build_session_rollback_state(session),
        layers=RollbackApplyLayersView(
            conversation=RollbackApplyLayerView(
                status='success' if overall_status in ('success', 'partial_success') else 'failed',
            ),
            workspace_files=RollbackApplyLayerView(
                status=workspace_layer_status,
                reason=(
                    None
                    if workspace_file_status in ('success', 'not_applicable')
                    else file_restore_failure_reason
                ),
            ),
            resources=RollbackApplyLayerView(
                status=(
                    'not_applicable'
                    if restored_count == 0 and failed_count == 0
                    else 'success' if failed_count == 0 else 'partial_success'
                ),
                restored_count=restored_count,
                failed_count=failed_count,
                retryable=retryable_items or [],
                warnings=collab_sync_warnings or [],
            ),
            pg_state=RollbackApplyLayerView(
                status='pending' if cleanup_status == 'pending' else (
                    'failed' if cleanup_status in ('failed', 'pending_retry') else
                    'success' if cleanup_status == 'done' else 'not_applicable'
                ),
                reason='cleanup_pending_retry' if cleanup_status == 'pending_retry' else None,
            ),
        ),
        collab_sync_warnings=collab_sync_warnings or [],
    )


def _resolve_tracker_run_meta(session) -> Optional[dict]:
    """Wave 5 (charter v1.8 §6.7) — 解析 ChatSession 关联的 GoalRun(若有)。

    后端 GoalRun.chat_session 是反向 FK(scheduler 在 PostgreSQL,conversation 在 MySQL,
    跨库 db_constraint=False)。前端 ChatSession UI 需要识别"这是不是 Tracker Run、
    是哪个 Tracker、第几次 Run"以渲染 4 个表达点(breadcrumb / icon / system msg /
    状态指示器)。

    返回 dict（前端 ChatSessionSchema.tracker_run 字段）或 None：
        {
          "run_id": str,
          "run_index": int,             # 该 Tracker 的第几次 Run（按 created_at 排序）
          "run_status": str,            # pending / running / success / failed / cancelled
          "tracker_id": str,
          "tracker_name": str,
          "tracker_origin": str,        # user_created（本期固定，charter §7.1 origin 字段已移除）
          "trigger_type": str,          # 本次 Run 的触发来源
          "tracker_trigger_type": str,  # 原任务的 cron / interval / at 等触发类型
          "trigger_context": dict,
          "started_at": iso str | None,
          "finished_at": iso str | None,
        }
    """
    try:
        from apps.tracker.models import Tracker, TrackerRun
    except Exception:
        return None

    try:
        # 反向 FK: TrackerRun.chat_session_id == session.id（跨库,需 SchedulerRouter 放行）
        run = TrackerRun.objects.filter(
            chat_session_id=session.id,
        ).select_related('tracker').order_by('-created_at').first()
    except Exception as exc:  # 跨库异常静默(不能让 ChatSession API 因 scheduler 故障而 500)
        logger.debug("[_resolve_tracker_run_meta] failed: %s", exc)
        return None

    if not run:
        return None

    tracker: Tracker = run.tracker
    if not tracker:
        return None

    # 计算 run_index: 该 Tracker 第几次 Run(按 created_at 升序),用于 breadcrumb "Run #N"
    try:
        run_index = TrackerRun.objects.filter(
            tracker_id=tracker.id,
            created_at__lte=run.created_at,
        ).count()
    except Exception:
        run_index = 0

    # Wave 6 续作 P0-3 / P0-4 (charter §4.4 / plan §Phase 6 验收 #1):
    # 从 TrackerRun.context 抽产物定位 + 恢复动作(成功 → 复制产物链接;失败 → 渲染按钮)
    artifact_ref = _extract_tracker_artifact_ref(run)
    recovery_actions = _extract_tracker_recovery_actions(run)

    return {
        "run_id": str(run.id),
        "run_index": run_index,
        "run_status": run.status,
        "tracker_id": str(tracker.id),
        "tracker_name": tracker.name or '',
        # charter §7.1 origin 字段已移除,本期固定 user_created。预留字段为将来 system_preset 用。
        "tracker_origin": "user_created",
        "trigger_type": run.trigger_type,
        "tracker_trigger_type": tracker.trigger_type,
        "trigger_context": run.trigger_context or {},
        "started_at": run.started_at.isoformat() if getattr(run, 'started_at', None) else None,
        "finished_at": run.finished_at.isoformat() if getattr(run, 'finished_at', None) else None,
        # Wave 6 (charter §4.4):前端按 skill_key 推 app 映射,决定"看产物"
        # 跳哪个 app(notificationTargetResolver / Bell 双按钮)。
        "skill_key": tracker.skill_key or '',
        # Wave 6 续作 P0-3:产物定位字段(snake_case in schema, 前端转 camelCase)
        **({"artifact_ref": artifact_ref} if artifact_ref else {}),
        # Wave 6 续作 P0-4:失败时的可点击恢复动作
        **({"recovery_actions": recovery_actions} if recovery_actions else {}),
    }


# Wave 6 续作 P0-3 / P0-4 共享的 GoalRun.context 抽取逻辑。
# 与 apps/scheduler/services/goal_notification.py 的 _extract_artifact_ref /
# _extract_recovery_actions 字段约定一致——同一份 context JSON,两个出口共用同一份
# 解析规则,避免双方各自解析时漂移。
_TRACKER_ARTIFACT_FIELDS = (
    "artifact_id",
    "memo_id",
    "record_ids",
    "doc_id",
    "slide_id",
    "code_path",
)


def _extract_tracker_artifact_ref(run) -> Optional[dict]:
    """从 GoalRun.context["agent_result"] / context 顶层抽 artifact_ref。

    返回:
      None  → 无产物字段(前端"复制产物链接"按钮不渲染)
      dict  → {snake_case_key: value, ...}(snake_case,前端 navigator 转 camelCase)
    """
    try:
        ctx = getattr(run, "context", None) or {}
    except Exception:
        return None
    if not isinstance(ctx, dict):
        return None
    sources: list[dict] = []
    agent_result = ctx.get("agent_result")
    if isinstance(agent_result, dict):
        sources.append(agent_result)
    sources.append(ctx)

    out: dict = {}
    for src in sources:
        for key in _TRACKER_ARTIFACT_FIELDS:
            if key in src and src[key] not in (None, "", []):
                if key not in out:
                    out[key] = src[key]
    return out or None


def _extract_tracker_recovery_actions(run) -> list[dict]:
    """从 GoalRun.context["recovery_actions"] 抽 RecoveryAction[]。"""
    try:
        ctx = getattr(run, "context", None) or {}
    except Exception:
        return []
    if not isinstance(ctx, dict):
        return []
    actions = ctx.get("recovery_actions")
    if not isinstance(actions, list):
        return []
    cleaned: list[dict] = []
    for it in actions:
        if not isinstance(it, dict):
            continue
        kind = it.get("kind")
        label = it.get("label")
        if not kind or not label:
            continue
        out_item = {"kind": str(kind), "label": str(label)}
        if "model" in it and it["model"]:
            out_item["model"] = str(it["model"])
        cleaned.append(out_item)
    return cleaned


def _fetch_tracker_run_session_ids(
    candidate_session_ids: Optional[Iterable] = None,
) -> Optional[set]:
    """跨库查询"关联 TrackerRun 的 ChatSession ID 集合"。

    隐患 5 / 方案 ①(charter v1.8 §6.7 主侧栏分桶)的核心 helper:list_sessions /
    list_all_sessions 用此集合在 ChatSession queryset 上 ``exclude`` 或 ``filter``,
    把 Tracker per_run session 从默认列表里剔除/单独取出。

    Args:
        candidate_session_ids: 可选,限定只查这些 ChatSession 是否关联 Tracker
            (适合"已经按 user/space/organization 过滤好一批 session id"再问哪些是
            Tracker 的场景)。None 时查全集——适合做"全量分桶"。

    Returns:
        set[str] 关联 TrackerRun 的 ChatSession ID 字符串集合,或 None 表示
        跨库查询失败/scheduler 模块不可用——调用方应 fallback 到"不分桶"行为
        (返回全部 session,不让 chat 列表 API 因 scheduler 故障整个 500)。
    """
    try:
        from apps.tracker.models import TrackerRun  # noqa: F401
    except Exception as exc:
        logger.debug("[_fetch_tracker_run_session_ids] tracker module unavailable: %s", exc)
        return None

    try:
        qs = TrackerRun.objects.filter(chat_session_id__isnull=False)
        if candidate_session_ids is not None:
            ids_list = [str(sid) for sid in candidate_session_ids if sid]
            if not ids_list:
                return set()
            qs = qs.filter(chat_session_id__in=ids_list)
        return {
            str(sid)
            for sid in qs.values_list('chat_session_id', flat=True).distinct()
            if sid
        }
    except Exception as exc:
        logger.warning(
            "[_fetch_tracker_run_session_ids] cross-db query failed, "
            "list API will fall back to no-bucketing: %s", exc,
        )
        return None


def _batch_resolve_tracker_run_meta(sessions: 'Iterable') -> dict:
    """批量解析多个 ChatSession 的 tracker_run 元信息(P0-1 性能修复)。

    替代 N+1 跨库查询模式 —— 列表 API 应当统一调用本函数,而非对每个 session
    独立调用 :func:`_resolve_tracker_run_meta`。

    实现:
    1. 一次性 ``TrackerRun.objects.filter(chat_session_id__in=session_ids).select_related('tracker')``
       拿到所有 session 关联的最新 TrackerRun(每个 session 取 created_at 最大那条);
    2. 一次性查询每个 TrackerRun 的 run_index(同 tracker 中 created_at 升序的位次);
    3. 在内存里组装成 ``{session_id_str: meta_dict}``,供 ``_session_to_schema`` /
       ``_build_session_summary`` 通过 ``tracker_run_meta`` 形参注入。

    100 个 session 的列表,跨库 PG 查询从 200 次降到 2 次。

    返回 ``{}`` 当 scheduler 模块不可用、跨库故障或无任何匹配。
    """
    session_id_strs = [str(s.id) for s in sessions if getattr(s, 'id', None)]
    if not session_id_strs:
        return {}

    try:
        from apps.tracker.models import Tracker, TrackerRun  # noqa: F401
    except Exception:
        return {}

    try:
        # 一次性拿所有 session 的所有 TrackerRun(后续在 Python 里挑每 session 最新的那条)
        runs = list(
            TrackerRun.objects
            .filter(chat_session_id__in=session_id_strs)
            .select_related('tracker')
            .order_by('chat_session_id', '-created_at')
        )
    except Exception as exc:
        logger.debug("[_batch_resolve_tracker_run_meta] cross-db fetch failed: %s", exc)
        return {}

    if not runs:
        return {}

    # 每个 session 只保留 created_at 最大的那条(等价于 _resolve_tracker_run_meta 的 .first())
    latest_per_session: dict = {}
    for run in runs:
        sid = str(run.chat_session_id) if run.chat_session_id else None
        if not sid:
            continue
        # order_by 已按 -created_at 排序,首次遇到即最新
        if sid not in latest_per_session:
            latest_per_session[sid] = run

    if not latest_per_session:
        return {}

    # 一次性算每个 (tracker_id, run.created_at) 的 run_index:
    # 同 tracker 内 created_at <= 该 run.created_at 的总数(等于按时间升序的位次)。
    # 思路:把所有 (tracker_id, run_id, created_at) 拉回来,在 Python 里按 tracker 分组排序计数。
    from collections import defaultdict
    tracker_ids = list({str(r.tracker_id) for r in latest_per_session.values() if r.tracker_id})
    run_index_map: dict = {}  # {run_id_str: index}
    if tracker_ids:
        try:
            all_runs_for_trackers = list(
                TrackerRun.objects
                .filter(tracker_id__in=tracker_ids)
                .order_by('tracker_id', 'created_at')
                .values_list('id', 'tracker_id', 'created_at')
            )
        except Exception as exc:
            logger.debug("[_batch_resolve_tracker_run_meta] run_index fetch failed: %s", exc)
            all_runs_for_trackers = []

        per_tracker_counter: dict = defaultdict(int)
        for run_id, tracker_id, _created_at in all_runs_for_trackers:
            per_tracker_counter[str(tracker_id)] += 1
            run_index_map[str(run_id)] = per_tracker_counter[str(tracker_id)]

    result: dict = {}
    for sid, run in latest_per_session.items():
        tracker = run.tracker
        if not tracker:
            continue
        # Wave 6 续作 P0-3 / P0-4:批量路径同步透传 artifact_ref + recovery_actions
        artifact_ref = _extract_tracker_artifact_ref(run)
        recovery_actions = _extract_tracker_recovery_actions(run)
        result[sid] = {
            "run_id": str(run.id),
            "run_index": run_index_map.get(str(run.id), 0),
            "run_status": run.status,
            "tracker_id": str(tracker.id),
            "tracker_name": tracker.name or '',
            "tracker_origin": "user_created",
            "trigger_type": run.trigger_type,
            "tracker_trigger_type": tracker.trigger_type,
            "trigger_context": run.trigger_context or {},
            "started_at": run.started_at.isoformat() if getattr(run, 'started_at', None) else None,
            "finished_at": run.finished_at.isoformat() if getattr(run, 'finished_at', None) else None,
            # Wave 6 (charter §4.4):skill_key 让前端按 app 映射跳产物。
            "skill_key": tracker.skill_key or '',
            **({"artifact_ref": artifact_ref} if artifact_ref else {}),
            **({"recovery_actions": recovery_actions} if recovery_actions else {}),
        }
    return result


def _serialize_session_model_param_overrides(stored):
    """Session 读路径:v2 意图 + 旧客户端 ``reasoning_effort`` 兼容投影。"""
    from apps.services.llm.runtime_profile.persistence import (
        serialize_model_param_overrides_for_client,
    )
    return serialize_model_param_overrides_for_client(stored)


def _session_to_schema(session, *, message_count=None, last_message_preview=None,
                       is_reverted=False, revert_snapshot_hash=None,
                       fork_count=0, tracker_run_meta=_UNSET, **overrides) -> 'ChatSessionSchema':
    """将 ChatSession ORM 对象转换为 ChatSessionSchema。

    ``tracker_run_meta``：批量解析的 TrackerRun 元信息(charter v1.8 §6.7)。
        - ``_UNSET``(默认): 单点回退到 :func:`_resolve_tracker_run_meta` 跨库查询(慢)。
        - ``None``: 显式标记 "已批量解析过,本 session 无关联 TrackerRun"(快,跳过单点 N+1)。
        - ``dict``: 已批量预解析的 meta,直接使用。
    列表 API 应统一传 ``tracker_run_meta=batch_map.get(str(s.id))`` 避免 N+1,
    单点 API(如 get_session)保持向后兼容,继续触发单点解析。
    """
    from ..schemas import ChatSessionSchema
    if tracker_run_meta is _UNSET:
        # 兼容路径:无批量预解析(如 get_session 等单 session API),跑单点 resolver
        resolved_tracker_run = _resolve_tracker_run_meta(session)
    else:
        resolved_tracker_run = tracker_run_meta
    # v0.1 宪法 §5.1：current_model / default_model 是软引用 property，列表场景调用方
    # 应在 fetch session 后调 ``attach_llm_models_to_sessions`` 把 LLMModel 注入缓存
    # （否则 property 会单点 fallback 一次查 PG）。这里直接用 _id 字段 + property 一次
    # 拿到 LLMModel.model_name——同 session 上 current_model / default_model 各调一次。
    current_model_obj = session.current_model
    default_model_obj = session.default_model
    # title_is_default 由 server 算（信赖 i18n_manager 全量翻译值集合），但
    # title_generation_status='done' 表示用户/系统已明确完成标题流程，即使标题
    # 文本等于默认文案也不再触发前端兜底生成。
    # 前端 selectSession 兜底用这个字段决定是否需要触发 generate-title。
    from ..services.title_generator import TitleGeneratorService as _TGS
    from ..services.session_surface_policy import normalize_surface
    _title_is_default = _TGS.should_auto_generate_title(session)
    from apps.services.agent_engine.models import SessionRunProjection
    from apps.services.agent_engine.services.session_run_state_service import (
        ACTIVE_STATUSES,
        serialize_run_state,
    )

    workspace = getattr(session, 'workspace', None)
    workspace_device_id = getattr(workspace, 'device_id', None) if workspace else None
    execution_target = _build_session_execution_target(
        workspace_device_id,
        getattr(session, 'target_device_id', None),
    )

    try:
        projection = session.run_state_projection
    except SessionRunProjection.DoesNotExist:
        projection = None
    if projection is not None:
        run_state = serialize_run_state(projection)
        has_active_task = projection.status in ACTIVE_STATUSES
        last_run_failed = projection.status == 'failed'
    else:
        # 与 /sessions/all 一致：只有无投影的历史会话才走消息时间兼容回退。
        last_message_recent = False
        if session.last_message_at:
            from django.utils import timezone as _tz
            last_message_recent = (
                _tz.now() - session.last_message_at
            ).total_seconds() < ACTIVE_TASK_WINDOW_SECONDS
        has_active_task = (
            session.status == 'active'
            and getattr(session, '_last_msg_role', None) == 'user'
            and (message_count or 0) > 0
            and last_message_recent
        )
        last_run_failed = False
        run_state = None
    base = dict(
        id=str(session.id),
        title=session.title or '',
        status=session.status,
        is_pinned=bool(getattr(session, 'is_pinned', False)),
        pinned_at=getattr(session, 'pinned_at', None),
        is_paused=getattr(session, 'is_paused', False),
        title_is_default=_title_is_default,
        # 后台状态；列表 UI 不展示 failed 徽标，供触发 / backfill 使用。
        title_generation_status=getattr(session, 'title_generation_status', None) or None,
        organization_id=session.organization_id,
        project_id=str(session.project_id) if getattr(session, 'project_id', None) else None,
        # 过渡期 scope：Project 优先，其次执行 Workspace；新建请求不再接收 space_id。
        space_id=(
            str(session.project_id) if getattr(session, 'project_id', None)
            else (str(session.workspace_id) if session.workspace_id else None)
        ),
        agent_id=str(session.agent_id) if getattr(session, 'agent_id', None) else None,
        workspace_id=str(session.workspace_id) if getattr(session, 'workspace_id', None) else None,
        execution_target=execution_target,
        target_device_id=getattr(session, 'target_device_id', '') or None,
        agent_mode=getattr(session, 'agent_mode', '') or '',
        approval_mode=resolve_workspace_approval_mode(
            getattr(session, 'workspace', None),
            project=getattr(session, 'project_id', None),
        ),
        thread_id=session.thread_id,
        current_model_id=str(session.current_model_id) if session.current_model_id else None,
        current_model_name=current_model_obj.model_name if current_model_obj else None,
        default_model_id=str(session.default_model_id) if session.default_model_id else None,
        default_model_name=default_model_obj.model_name if default_model_obj else None,
        context_tier_id=getattr(session, 'context_tier_id', '') or None,
        model_param_overrides=_serialize_session_model_param_overrides(
            getattr(session, 'model_param_overrides', None),
        ),
        created_at=session.created_at,
        updated_at=session.updated_at,
        last_message_at=session.last_message_at,
        message_count=message_count,
        last_message_preview=last_message_preview,
        has_active_task=has_active_task,
        last_run_failed=last_run_failed,
        run_state=run_state,
        input_tokens=getattr(session, 'input_tokens', 0) or 0,
        output_tokens=getattr(session, 'output_tokens', 0) or 0,
        total_tokens=getattr(session, 'total_tokens', 0) or 0,
        cache_read_input_tokens=getattr(session, 'cache_read_input_tokens', 0) or 0,
        cache_creation_input_tokens=getattr(session, 'cache_creation_input_tokens', 0) or 0,
        # context_tokens 字段保留在 schema 上以向下兼容老客户端构建；
        # 服务端不再 emit 真实值（2026-05-10 messages-as-truth 改造，
        # 详见 ChatSession.context_tokens 字段注释）。前端 ring 用量
        # 走 ChatMessage.metadata.last_input_tokens 派生路径。
        context_tokens=0,
        compaction_count=getattr(session, 'compaction_count', 0) or 0,
        last_compaction_at=getattr(session, 'last_compaction_at', None),
        is_reverted=is_reverted,
        revert_snapshot_hash=revert_snapshot_hash,
        rollback_state=_build_session_rollback_state(session),
        forked_from_id=str(session.forked_from_id) if session.forked_from_id else None,
        fork_point_message_id=str(session.fork_point_message_id) if session.fork_point_message_id else None,
        fork_count=fork_count,
        fork_copy_status=getattr(session, 'fork_copy_status', None) or None,
        # Wave 5 (charter v1.8 §6.7): 反向冗余 GoalRun 关联信息,供前端 UI 表达 4 表达点。
        # P0-1 修复:列表 API 通过 tracker_run_meta 批量预注入,避免 N+1 跨库查询。
        tracker_run=resolved_tracker_run,
        primary_surface=normalize_surface(getattr(session, 'primary_surface', None)),
        is_agent_mention_session=False,
    )
    base.update(overrides)
    return ChatSessionSchema(**base)
