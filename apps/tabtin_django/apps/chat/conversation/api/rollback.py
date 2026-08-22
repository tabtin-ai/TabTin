"""回滚与检查点管理 API"""

import hashlib
import json
from dataclasses import dataclass, field
from typing import Optional, get_args
from uuid import uuid4

from django.db import transaction
from django.utils import timezone

from apps.services.common.db_router import postgres_app_db_alias
from apps.i18n import _
from apps.i18n.response import success_response, error_response_with_status
from ..models import ChatSession, ChatMessage
from ..services.file_restore_finalize_lease import (
    FileRestoreFinalizePendingError,
    build_file_restore_finalize_expiry,
    get_pending_file_restore_apply,
    require_no_pending_file_restore,
)
from ..schemas import (
    RollbackRequest,
    RollbackExecuteRequest,
    RollbackResponse,
    RollbackPreviewRequest,
    RollbackPreviewResponse,
    RevertHistoryEntryView,
    RevertHistoryResponse,
    ResourceChangePreview,
    ResourceRestoreInfo,
    FileRestoreFinalizeRequest,
    FileRestoreFinalizeResponse,
    ResourceRestoreRequest,
    ResourceRestoreResult,
    ResourceRestoreResponse,
    UnrevertResponse,
    UpdateCheckpointRequest,
    UpdateCheckpointResponse,
)
from ._common import (
    router, jwt_auth, logger,
    REVERT_HISTORY_MAX_ENTRIES, SESSION_PREVIEW_MAX_LEN,
    CHECKPOINT_DEGRADED_REASON_MISSING_EFFECTIVE_CHECKPOINT,
    _build_session_rollback_state,
    _build_checkpoint_record,
    _build_rollback_apply_result,
    _get_space_checkpoint_summary,
)

_CHECKPOINT_ROUTE_RESPONSES = {
    200: dict,
    400: dict,
    401: dict,
    403: dict,
    404: dict,
    409: dict,
    503: dict,
    500: dict,
}

_RUNTIME_REWIND_TIMEOUT_SECONDS = 30
_FILE_PREVIEW_TIMEOUT_SECONDS = 5
_CONVERSATION_ONLY_FILE_REASONS = frozenset({
    'no_file_history',
    'file_snapshot_missing',
    'path_guard_denied',
    'unrestorable_files',
})


def _reject_pending_file_restore(session: ChatSession):
    """在同一 session 行锁内阻止消费/改写尚未确认的本机文件回退。"""
    try:
        require_no_pending_file_restore(session)
    except FileRestoreFinalizePendingError as error:
        if error.result_unknown:
            return error_response_with_status(
                'FILE_RESTORE_RESULT_UNKNOWN',
                message=_(
                    'chat.file_restore_result_unknown',
                    default='工作区文件回退结果未确认，请连接原执行设备并重新确认当前文件状态',
                ),
                status_code=409,
            )
        return error_response_with_status(
            'FILE_RESTORE_FINALIZE_PENDING',
            message=_(
                'chat.file_restore_finalize_pending',
                default='工作区文件仍在确认回退结果，请稍后再试',
            ),
            status_code=409,
        )
    return None


def _execution_checkpoint_space_id(session: ChatSession) -> Optional[str]:
    """Return the Workspace that owns execution/checkpoint state for this session.

    ：ChatSession.workspace 已是执行现场，不再经 Space.execution_space 跳转。
    """
    if not session.workspace_id:
        return None
    return str(session.workspace_id)


@dataclass(frozen=True)
class _RuntimeRewindResult:
    """运行时回退边界的执行结果。"""

    applied: bool
    keep_message_count: Optional[int] = None
    # 仅 Electron 控制设备在移动端路径填写：它已在 DB 投影前真实执行过
    # per-file rewind，不能再让 rollback_session 用 local 宿主默认成功覆盖。
    file_restore_coordinated: bool = False
    file_restore_success: Optional[bool] = None
    file_restore_status: Optional[str] = None
    file_restore_reason: Optional[str] = None
    failed_files: tuple[str, ...] = ()
    file_restore_failed_file_count: int = 0
    error: Optional[str] = None


@dataclass(frozen=True)
class _RuntimeFilePreviewResult:
    """绑定 Electron 对本机 per-file 账本的只读预览结果。"""

    status: str
    affected_paths: tuple[str, ...] = ()
    reason: Optional[str] = None
    revision: Optional[str] = None
    unrestorable_files: tuple[tuple[str, str], ...] = ()
    device_fingerprint: Optional[str] = None


@dataclass(frozen=True)
class _ResolvedFilePreview:
    host: str
    status: str
    affected_paths: tuple[str, ...] = ()
    reason: Optional[str] = None
    revision: Optional[str] = None
    unrestorable_files: tuple[tuple[str, str], ...] = ()
    device_fingerprint: Optional[str] = None

    @property
    def success(self) -> bool:
        return self.status != 'unavailable'


def _build_file_preview_revision(
    *,
    session_id: Optional[str] = None,
    thread_id: Optional[str] = None,
    host: Optional[str] = None,
    device_fingerprint: Optional[str] = None,
    rewind_anchor_id: Optional[str],
    status: str,
    reason: Optional[str],
    affected_paths: tuple[str, ...] | list[str],
) -> str:
    payload = {
        'version': 1,
        'session_id': session_id,
        'thread_id': thread_id,
        'host': host,
        'device_fingerprint': device_fingerprint,
        'rewind_anchor_id': rewind_anchor_id,
        'status': status,
        'reason': reason,
        'affected_paths': sorted(set(affected_paths)),
    }
    encoded = json.dumps(
        payload,
        sort_keys=True,
        ensure_ascii=False,
        separators=(',', ':'),
    ).encode('utf-8')
    return f"v1:{hashlib.sha256(encoded).hexdigest()}"


def _build_transcript_rewind_params(
    session: ChatSession,
    target_msg: ChatMessage,
    *,
    mode: str = 'rollback',
    file_rewind_anchor_id: Optional[str] = None,
) -> dict[str, object]:
    """构造给执行宿主的回退锚点，消息 ID 优先、内容仅作 legacy fallback。

    ``file_rewind_anchor_id`` 只在移动端经 Electron 控制设备回退时使用：
    Electron 的主进程会在确认 transcript boundary 后，按该锚点执行同一会话的
    per-file rewind，再把真实结果回传给本接口。
    """
    target_content = (target_msg.text_summary or '').strip()
    target_occurrence_index = None
    if target_content and target_msg.role in ('user', 'assistant'):
        from ..services.conversation_time import conversation_sort_key

        occurrence = 0
        same_role_messages = list(session.messages.filter(role=target_msg.role).values(
            'id', 'role', 'text_summary', 'message_kind', 'arrival_seq', 'created_at',
        ))
        same_role_messages.sort(key=conversation_sort_key)
        for msg in same_role_messages:
            if msg['message_kind'] in ('environment_context', 'agent_profile_context', 'system_prompt_context'):
                continue
            if (msg['text_summary'] or '').strip() != target_content:
                continue
            occurrence += 1
            if msg['id'] == target_msg.id:
                target_occurrence_index = occurrence
                break

    params: dict[str, object] = {
        'session_id': str(session.id),
        'target_message_id': str(target_msg.id),
        'target_role': target_msg.role,
        'mode': mode,
        'space_id': _execution_checkpoint_space_id(session),
        'organization_id': str(session.organization_id or ''),
    }
    if target_content:
        params['target_content'] = target_content
    if target_occurrence_index is not None:
        params['target_occurrence_index'] = target_occurrence_index
    if file_rewind_anchor_id:
        params['file_rewind_anchor_id'] = file_rewind_anchor_id
    return params


def _parse_runtime_rewind_result(
    result: object,
    *,
    has_electron_file_anchor: bool,
    strict_file_confirmation: bool,
) -> _RuntimeRewindResult:
    """解析执行设备回传的回退结果，不信任移动端请求体。

    新版 Electron 必须显式回传 ``file_restore_coordinated``，否则带文件锚点的
    移动端回退会被拒绝，而不会沿用旧版 ``host=local => True`` 的假成功。
    """
    if not isinstance(result, dict):
        return _RuntimeRewindResult(applied=False, error='执行设备未在规定时间内确认回退，请重试。')
    if not result.get('success'):
        return _RuntimeRewindResult(
            applied=False,
            error=str(result.get('error') or '执行设备未能完成对话上下文回退。'),
        )

    data = result.get('data')
    runtime_data = data if isinstance(data, dict) else {}
    if runtime_data.get('applied') is not True:
        return _RuntimeRewindResult(
            applied=False,
            error='执行设备未找到可回退的对话边界，请刷新会话后重试。',
        )

    keep_message_count = runtime_data.get('keep_message_count')
    if isinstance(keep_message_count, bool) or not isinstance(keep_message_count, int) or keep_message_count < 0:
        keep_message_count = None

    if not has_electron_file_anchor:
        return _RuntimeRewindResult(applied=True, keep_message_count=keep_message_count)

    if runtime_data.get('file_restore_coordinated') is not True:
        if not strict_file_confirmation:
            # 已发布旧 Electron 只回 transcript applied。不能把缺失的文件结果
            # 猜成成功，也不能让新后端把旧移动端整条回退流程打断：对话继续投影，
            # 文件层诚实标为 unavailable，提示升级后才能得到可验证恢复。
            return _RuntimeRewindResult(
                applied=True,
                keep_message_count=keep_message_count,
                file_restore_coordinated=True,
                file_restore_success=False,
                file_restore_status='unavailable',
                file_restore_reason='desktop_upgrade_required',
            )
        return _RuntimeRewindResult(
            applied=False,
            error='桌面端未确认工作区文件回退。请升级桌面端后重试。',
        )
    file_restore_success = runtime_data.get('file_restore_success')
    if not isinstance(file_restore_success, bool):
        return _RuntimeRewindResult(
            applied=False,
            error='桌面端未返回文件回退结果。请升级桌面端后重试。',
        )
    file_restore_status = runtime_data.get('file_restore_status')
    valid_restore_statuses = {'success', 'not_applicable', 'partial', 'failed', 'unavailable'}
    if file_restore_status is None:
        # 兼容已发布 Electron：旧端只返回 bool，新后端仍可安全解析。
        file_restore_status = 'success' if file_restore_success else 'failed'
    if file_restore_status not in valid_restore_statuses:
        return _RuntimeRewindResult(
            applied=False,
            error='桌面端返回了无法识别的文件回退状态，请升级桌面端后重试。',
        )
    status_means_success = file_restore_status in {'success', 'not_applicable'}
    if status_means_success != file_restore_success:
        return _RuntimeRewindResult(
            applied=False,
            error='桌面端返回的文件回退结果互相矛盾，请刷新后重试。',
        )
    failed_files = runtime_data.get('failed_files')
    normalized_failed_files = tuple(
        item for item in failed_files if isinstance(item, str)
    ) if isinstance(failed_files, list) else ()
    return _RuntimeRewindResult(
        applied=True,
        keep_message_count=keep_message_count,
        file_restore_coordinated=True,
        file_restore_success=file_restore_success,
        file_restore_status=file_restore_status,
        file_restore_reason=(
            str(runtime_data.get('file_restore_reason'))
            if runtime_data.get('file_restore_reason')
            else None
        ),
        failed_files=normalized_failed_files,
        file_restore_failed_file_count=len(normalized_failed_files),
    )


def _request_runtime_timeline_rewind(
    session: ChatSession,
    target_msg: ChatMessage,
    *,
    mode: str = 'rollback',
    contract_version: int = 1,
    expected_file_preview_revision: Optional[str] = None,
) -> _RuntimeRewindResult:
    """让会话绑定的执行设备先写入 transcript rewind boundary。

    这是移动端的唯一可用路径：手机只负责发起与呈现，真正持有 Agent 上下文的
    Electron/Daemon 必须先确认边界已落盘，随后才允许服务端更新可见会话投影。
    """
    if not session.thread_id:
        return _RuntimeRewindResult(applied=False, error='会话没有可用的执行线程，无法回退。')
    if not session.workspace:
        return _RuntimeRewindResult(applied=False, error='会话没有绑定执行现场，无法回退。')

    try:
        from apps.services.common.device_capability_registry import DEVICE_AVAILABLE_STATUSES
        from apps.tabtinspace.services.execution_binding import resolve_control_device

        device = resolve_control_device(space=session.workspace)
        if device is None:
            return _RuntimeRewindResult(
                applied=False,
                error='没有可用的执行设备。请打开运行该会话的桌面端或启动执行设备后重试。',
            )
        if getattr(device, 'status', None) not in DEVICE_AVAILABLE_STATUSES:
            return _RuntimeRewindResult(
                applied=False,
                error='执行设备当前不在线。请恢复连接后再回退。',
            )
        device_fingerprint = str(getattr(device, 'fingerprint', '') or '')
        if not device_fingerprint:
            return _RuntimeRewindResult(applied=False, error='执行设备缺少可用标识，无法回退。')
        is_electron_control_device = getattr(device, 'device_type', None) == 'electron'
        # 与 rollback_session 的 per-file 语义使用同一锚点。Electron file-history
        # 账本由控制设备持有，必须在 DB 投影前由该设备实际 rewind。
        file_rewind_anchor_id = _resolve_rewind_anchor_id(session, target_msg)

        from apps.services.agent_engine.services.frontend_action_service import get_frontend_action_service

        action_service = get_frontend_action_service()
        task_id = f'session-rewind:{uuid4()}'
        published = action_service.publish_action(
            session.thread_id,
            {
                'data': {
                    'task_id': task_id,
                    'type': 'session_transcript_truncate',
                    'params': _build_transcript_rewind_params(
                        session,
                        target_msg,
                        mode=mode,
                        file_rewind_anchor_id=file_rewind_anchor_id if is_electron_control_device else None,
                    ) | ({
                        'expected_file_preview_revision': expected_file_preview_revision,
                    } if expected_file_preview_revision else {}),
                },
            },
            target_device_fingerprint=device_fingerprint,
            timeout_ms=_RUNTIME_REWIND_TIMEOUT_SECONDS * 1000,
        )
        if not published:
            return _RuntimeRewindResult(
                applied=False,
                error='回退请求未能送达执行设备，请确认设备在线后重试。',
            )

        result = action_service.wait_for_result(
            session.thread_id,
            task_id,
            _RUNTIME_REWIND_TIMEOUT_SECONDS,
        )
    except Exception:
        logger.warning(
            'rollback_execute: failed to request runtime rewind session=%s target=%s',
            session.id,
            target_msg.id,
            exc_info=True,
        )
        return _RuntimeRewindResult(applied=False, error='暂时无法联系执行设备，请稍后重试。')

    if not result:
        return _RuntimeRewindResult(applied=False, error='执行设备未在规定时间内确认回退，请重试。')
    return _parse_runtime_rewind_result(
        result,
        has_electron_file_anchor=(
            is_electron_control_device and bool(file_rewind_anchor_id)
        ),
        strict_file_confirmation=contract_version >= 2,
    )


def _request_runtime_file_preview(
    session: ChatSession,
    rewind_anchor_id: Optional[str],
) -> _RuntimeFilePreviewResult:
    """向绑定 Electron 查询本机文件账本，供移动端确认前展示真实影响。"""
    if not rewind_anchor_id:
        return _RuntimeFilePreviewResult(status='not_applicable', reason='no_file_anchor')
    if not session.thread_id or not session.workspace:
        return _RuntimeFilePreviewResult(status='unavailable', reason='execution_context_missing')

    try:
        from apps.services.common.device_capability_registry import DEVICE_AVAILABLE_STATUSES
        from apps.tabtinspace.services.execution_binding import resolve_control_device

        device = resolve_control_device(space=session.workspace)
        if device is None:
            return _RuntimeFilePreviewResult(status='unavailable', reason='no_control_device')
        if getattr(device, 'device_type', None) != 'electron':
            return _RuntimeFilePreviewResult(status='unavailable', reason='not_electron_host')
        if getattr(device, 'status', None) not in DEVICE_AVAILABLE_STATUSES:
            return _RuntimeFilePreviewResult(status='unavailable', reason='device_offline')
        device_fingerprint = str(getattr(device, 'fingerprint', '') or '')
        if not device_fingerprint:
            return _RuntimeFilePreviewResult(status='unavailable', reason='device_fingerprint_missing')

        from apps.services.agent_engine.services.frontend_action_service import get_frontend_action_service

        action_service = get_frontend_action_service()
        task_id = f'file-rewind-preview:{uuid4()}'
        published = action_service.publish_action(
            session.thread_id,
            {
                'data': {
                    'task_id': task_id,
                    'type': 'file_history_preview',
                    'params': {
                        'session_id': str(session.id),
                        'anchor_id': rewind_anchor_id,
                        'space_id': _execution_checkpoint_space_id(session),
                        'organization_id': str(session.organization_id or ''),
                    },
                },
            },
            target_device_fingerprint=device_fingerprint,
            timeout_ms=_FILE_PREVIEW_TIMEOUT_SECONDS * 1000,
        )
        if not published:
            return _RuntimeFilePreviewResult(status='unavailable', reason='preview_not_delivered')
        result = action_service.wait_for_result(
            session.thread_id,
            task_id,
            _FILE_PREVIEW_TIMEOUT_SECONDS,
        )
    except Exception:
        logger.warning(
            'rollback_preview: Electron file preview failed session=%s anchor=%s',
            session.id,
            rewind_anchor_id,
            exc_info=True,
        )
        return _RuntimeFilePreviewResult(status='unavailable', reason='preview_failed')

    if not isinstance(result, dict):
        return _RuntimeFilePreviewResult(status='unavailable', reason='preview_timeout')
    if result.get('success') is not True:
        return _RuntimeFilePreviewResult(status='unavailable', reason='preview_failed')
    raw_data = result.get('data')
    data = raw_data if isinstance(raw_data, dict) else {}
    status = data.get('file_preview_status')
    if status not in {'available', 'not_applicable', 'unavailable'}:
        return _RuntimeFilePreviewResult(status='unavailable', reason='invalid_preview_result')
    raw_paths = data.get('affected_paths')
    paths = tuple(item for item in raw_paths if isinstance(item, str)) if isinstance(raw_paths, list) else ()
    reason = str(data.get('file_preview_reason')) if data.get('file_preview_reason') else None
    revision = (
        str(data.get('file_preview_revision')).strip()
        if data.get('file_preview_revision')
        else None
    )
    raw_unrestorable = data.get('unrestorable_files')
    unrestorable = tuple(
        (
            str(item.get('path') or ''),
            str(item.get('reason') or 'unrestorable'),
        )
        for item in raw_unrestorable
        if isinstance(item, dict) and item.get('path')
    ) if isinstance(raw_unrestorable, list) else ()
    # 协议矛盾是 unknown，不能由服务端替执行设备猜语义。
    invalid_shape = (
        (status == 'available' and (not paths or bool(unrestorable)))
        or (status == 'not_applicable' and (bool(paths) or bool(unrestorable)))
        or (status == 'unavailable' and bool(paths) and not unrestorable)
        or (bool(unrestorable) and status != 'unavailable')
    )
    if invalid_shape:
        return _RuntimeFilePreviewResult(
            status='unavailable',
            reason='invalid_preview_result',
            device_fingerprint=device_fingerprint,
        )
    if status in {'available', 'not_applicable'} and not revision:
        return _RuntimeFilePreviewResult(
            status='unavailable',
            reason='file_preview_revision_missing',
            device_fingerprint=device_fingerprint,
        )
    return _RuntimeFilePreviewResult(
        status=status,
        affected_paths=paths,
        reason=reason,
        revision=revision,
        unrestorable_files=unrestorable,
        device_fingerprint=device_fingerprint,
    )


def _resolve_file_preview_for_client(
    *,
    session: ChatSession,
    rewind_anchor_id: Optional[str],
    client_type: str,
) -> _ResolvedFilePreview:
    """用同一逻辑解析 preview 与 execute 的文件影响，避免确认后漂移。"""
    resolved = _ResolvedFilePreview(
        host='local',
        status='not_applicable',
        reason='no_file_anchor' if not rewind_anchor_id else None,
    )
    if session.thread_id:
        try:
            from apps.services.agent_engine.services.daemon_checkpoint_service import DaemonCheckpointService

            outcome = DaemonCheckpointService.maybe_file_history_preview(
                session.thread_id,
                rewind_anchor_id or '',
                space_id=_execution_checkpoint_space_id(session),
            )
            if outcome.host == 'daemon':
                if not outcome.success:
                    resolved = _ResolvedFilePreview(
                        host='daemon',
                        status='unavailable',
                        reason=outcome.skip_reason or 'daemon_preview_failed',
                    )
                elif outcome.affected_paths:
                    resolved = _ResolvedFilePreview(
                        host='daemon',
                        status='available',
                        affected_paths=tuple(outcome.affected_paths),
                    )
                else:
                    resolved = _ResolvedFilePreview(
                        host='daemon',
                        status='not_applicable',
                        reason='no_file_changes',
                    )
        except Exception:
            logger.warning(
                'rollback_preview: file host resolution failed session=%s',
                session.id,
                exc_info=True,
            )
            return _ResolvedFilePreview(
                host='local',
                status='unavailable',
                reason='file_host_resolution_failed',
            )

    if resolved.host == 'local' and client_type in {'ios', 'android'}:
        electron = _request_runtime_file_preview(session, rewind_anchor_id)
        return _ResolvedFilePreview(
            host='local',
            status=electron.status,
            affected_paths=electron.affected_paths,
            reason=electron.reason,
            revision=electron.revision,
            unrestorable_files=electron.unrestorable_files,
            device_fingerprint=electron.device_fingerprint,
        )
    return resolved

# `revert_history` 是混合用途的审计字段：除用户回退操作（rollback /
# resource_rollback / unrevert）外，还混写了系统消息清理状态（type=cleanup，
# 由 persistence_pipeline / abandoned_pg_repair 写入），后者已通过
# rollback_state.cleanup_status 呈现给用户，不属于「回退操作历史」。读取接口
# 只返回 RevertHistoryEntryView 声明的展示类型，白名单从 schema 的 type
# Literal 派生（单一真相源，schema 增删类型时自动同步）。
_DISPLAY_REVERT_TYPES = frozenset(
    get_args(RevertHistoryEntryView.model_fields['type'].annotation)
)


def _log_missing_rollback_target(session: ChatSession, target_message_id: str, *, endpoint: str) -> None:
    """
     诊断：回退预览/执行返回「目标消息不存在」(404) 时落一条结构化日志。

    前端的回退 `target_message_id` 用的是 UUID 形态的 ChatMessage.id，能走到这里
    （而非 UUIDField 抛 ValueError → 500）说明 id 是合法 UUID，但在「本会话」消息表里查不到。
    三类根因需要 live 区分，这条日志一次性把判据采齐，避免每次都得连库手查：
      - cross_session：消息其实存在，但归属另一个 session（分屏 / fork / 会话错配）；
      - never_persisted：全库都查不到（落库被 silent drop，或流式刚结束尚未 flush）；
      - hard_deleted：曾被前一次回滚物理清理。

    仅写服务端日志、不改响应体，对调用方零行为影响。
    """
    try:
        global_msg = ChatMessage.objects.filter(id=target_message_id).only('id', 'session_id', 'role').first()
    except (ValueError, TypeError):
        # 理论上不会到这里（非法 UUID 在 endpoint 的 filter 处就会抛），兜底防御。
        logger.warning(
            "[rollback] %s target_message_id 非法 UUID：session=%s target=%s",
            endpoint, session.id, target_message_id,
        )
        return

    if global_msg is None:
        cause = "never_persisted_or_hard_deleted"
        other_session_id = None
    elif str(global_msg.session_id) != str(session.id):
        cause = "cross_session"
        other_session_id = str(global_msg.session_id)
    else:
        # 同 session 又查得到却走到 404，属逻辑悖论，单独标记便于排查 filter/路由异常。
        cause = "unexpected_present_in_session"
        other_session_id = str(global_msg.session_id)

    logger.warning(
        "[rollback] %s 目标消息不存在 cause=%s session=%s target=%s "
        "session_message_count=%s belongs_to_session=%s",
        endpoint, cause, session.id, target_message_id,
        session.messages.count(), other_session_id,
    )


# ---------------------------------------------------------------------------
# 辅助函数
# ---------------------------------------------------------------------------

def _resolve_checkpoint_state_index(
    session: ChatSession,
    explicit_state_index: Optional[int],
) -> Optional[int]:
    """
    解析 checkpoint_state_index。

    优先使用前端显式传入值；若未传，则尝试从 ConversationState.messages_json
    计算当前长度，保证 rollback 能截断到准确状态。
    """
    if explicit_state_index is not None:
        if explicit_state_index < 0:
            logger.warning(
                "Checkpoint: invalid explicit state index %s, fallback to auto resolve",
                explicit_state_index,
            )
        else:
            return explicit_state_index

    thread_id = getattr(session, "thread_id", None)
    if not thread_id:
        return None

    try:
        from apps.services.agent_engine.models import ConversationState

        conv_state = (
            ConversationState.objects
            .only("messages_json")
            .filter(thread_id=thread_id)
            .first()
        )
        if conv_state and isinstance(conv_state.messages_json, list):
            return len(conv_state.messages_json)
    except Exception as exc:
        logger.warning(
            "Checkpoint: resolve checkpoint_state_index failed thread_id=%s err=%s",
            thread_id,
            exc,
        )

    return None

# ============ 检查点管理 ============

_RESOURCE_MODEL_MAP: dict[str, tuple[str, str]] | None = None

def _get_resource_model_map() -> dict[str, tuple[str, str]]:
    """resource_type -> (model_import_path, name_field)"""
    global _RESOURCE_MODEL_MAP
    if _RESOURCE_MODEL_MAP is None:
        _RESOURCE_MODEL_MAP = {
            'docs':    ('apps.tabdoc.models.Document',       'title'),
            'slide':   ('apps.tabslide.models.SlideProject',  'name'),
            'table':   ('apps.tabdata.models.Table',          'name'),
        }
    return _RESOURCE_MODEL_MAP


_RESOURCE_TYPE_LABELS: dict[str, str] = {
    'docs': '文档',
    'slide': '幻灯片',
    'table': '数据表',
}


def _resolve_resource_names(changes: list[dict]) -> dict[tuple[str, str], str]:
    """批量查询受影响资源的可读名称。"""
    grouped: dict[str, set[str]] = {}
    for c in changes:
        rtype = c.get('resource_type', '')
        rid = str(c.get('resource_id', ''))
        if rtype and rid:
            grouped.setdefault(rtype, set()).add(rid)

    result: dict[tuple[str, str], str] = {}
    model_map = _get_resource_model_map()

    for rtype, ids in grouped.items():
        mapping = model_map.get(rtype)
        if not mapping:
            continue
        _, name_field = mapping
        model_cls = _load_resource_model(rtype)
        if not model_cls:
            continue
        try:
            rows = model_cls.objects.using(postgres_app_db_alias()).filter(
                id__in=list(ids)
            ).values_list('id', name_field)
            for rid, rname in rows:
                result[(rtype, str(rid))] = rname or ''
        except Exception:
            logger.warning("_resolve_resource_names: failed for %s", rtype, exc_info=True)

    return result


@dataclass
class _PendingVersionRestore:
    """中间状态：需要查询 VersionHistory 才能确定具体回退方案的资源。"""
    resource_type: str
    resource_id: str
    resource_name: str
    change_count: int
    agent_run_ids: list[str]


class _ResourceVersionQueryError(RuntimeError):
    """资源版本查询失败；这是预览未知，不是已知无版本。"""


def _build_resource_state_revision(resource_type: str, resource_id: str) -> str:
    """生成结构化资源当前态指纹，绑定预览与执行时的协作版本。

    资源模型的版本/更新时间用于捕获 DB-first 编辑，最新 VersionHistory 用于
    捕获 collab-first 编辑。任一查询异常都属于 unknown，不能降级成“无变化”。
    """
    try:
        model_cls = _load_resource_model(resource_type)
        model_state: dict | None = None
        if model_cls is not None:
            available_fields = {field.name for field in model_cls._meta.concrete_fields}
            state_fields = [
                name for name in (
                    'id', 'updated_at', 'modified_at', 'latest_version', 'revn',
                    'current_version', 'trashed_at', 'status',
                )
                if name in available_fields
            ]
            model_state = (
                model_cls.objects.using(postgres_app_db_alias())
                .filter(id=resource_id)
                .values(*state_fields)
                .first()
            )

        from apps.collab.models import VersionHistory
        latest_history = (
            VersionHistory.objects.using(postgres_app_db_alias())
            .filter(resource_type=resource_type, resource_id=resource_id)
            .order_by('-created_at', '-id')
            .values('id', 'created_at')
            .first()
        )
    except Exception as exc:
        raise _ResourceVersionQueryError(
            f'cannot read current resource state for {resource_type}:{resource_id}'
        ) from exc

    payload = {
        'version': 1,
        'resource_type': resource_type,
        'resource_id': resource_id,
        'model': model_state,
        'latest_history': latest_history,
    }
    encoded = json.dumps(
        payload,
        sort_keys=True,
        ensure_ascii=False,
        default=str,
        separators=(',', ':'),
    ).encode('utf-8')
    return f"v1:{hashlib.sha256(encoded).hexdigest()}"


def _attach_resource_state_revisions(plan: list[dict]) -> list[dict]:
    """为每个计划项附加当前态 CAS 指纹；失败时整份资源预览不可用。"""
    return [
        {
            **item,
            'expected_current_state_revision': _build_resource_state_revision(
                str(item.get('resource_type') or ''),
                str(item.get('resource_id') or ''),
            ),
        }
        for item in plan
    ]


def _lock_v2_resource_rows(data: ResourceRestoreRequest) -> None:
    """按稳定顺序锁定 v2 请求涉及的资源行，覆盖校验到恢复的竞态窗口。"""
    if data.rollback_contract_version < 2:
        return
    grouped: dict[type, set[str]] = {}
    for item in data.items:
        model_cls = _load_resource_model(item.resource_type)
        if model_cls is None:
            continue
        grouped.setdefault(model_cls, set()).add(item.resource_id)
    for model_cls in sorted(grouped, key=lambda cls: f'{cls.__module__}.{cls.__name__}'):
        # 强制求值以持有行锁直到 rollback_resources 的 postgres 事务结束。
        list(
            model_cls.objects.using(postgres_app_db_alias())
            .select_for_update()
            .filter(id__in=sorted(grouped[model_cls]))
            .values_list('id', flat=True)
        )


@dataclass
class _RollbackPreviewComputation:
    """preview 与 apply 共享的回退影响计算结果。"""
    target_msg: ChatMessage
    anchor_message: Optional[ChatMessage]
    checkpoint_hash: Optional[str]
    # per-file 回退锚点（§3.9 规则 3）= 目标那一轮顶层 agentRunId，用于
    # file_history_rewind。与旧 checkpoint_hash（git，仍服务于资源/SpaceCheckpoint
    # 增强）解耦——「本地文件恢复」这一层改走它，修掉 shadow-git 的 off-by-one。
    rewind_anchor_id: Optional[str]
    state_index: Optional[int]
    truncated_count: int
    messages_preview: list[dict] = field(default_factory=list)
    resource_changes: list[dict] = field(default_factory=list)
    resource_restore_plan: list[dict] = field(default_factory=list)
    resource_preview_status: str = 'not_applicable'
    resource_preview_reason: Optional[str] = None
    preview_revision: str = ''
    unrestorable_items: list[str] = field(default_factory=list)
    effective_checkpoint: Optional[object] = None
    degraded_reasons: list[str] = field(default_factory=list)
    impact: dict = field(default_factory=dict)
    no_impact: bool = False


def _build_rollback_preview_revision(
    *,
    session: ChatSession,
    target_msg: ChatMessage,
    messages_to_remove: list[dict],
    checkpoint_hash: Optional[str],
    state_index: Optional[int],
    rewind_anchor_id: Optional[str],
    resource_changes: list[dict],
    resource_restore_plan: list[dict],
    resource_preview_status: str,
    resource_preview_reason: Optional[str],
) -> str:
    """对用户已确认的时间线/文件锚点/资源计划生成稳定修订指纹。

    客户端在 editAndResend 执行时必须回传；服务端在任何 runtime /
    文件/资源副作用之前重算并比对，避免用户确认 A 却执行 B。
    """
    timeline = [
        {
            'id': str(row.get('id') or ''),
            'role': row.get('role') or '',
            'text_summary': row.get('text_summary') or '',
            'agent_run_id': row.get('agent_run_id') or '',
            'message_kind': row.get('message_kind') or '',
            'arrival_seq': row.get('arrival_seq'),
            'created_at': row.get('created_at').isoformat() if row.get('created_at') else None,
        }
        for row in messages_to_remove
    ]

    def canonical_items(items: list[dict]) -> list[dict]:
        return sorted(
            items,
            key=lambda item: json.dumps(
                item,
                sort_keys=True,
                ensure_ascii=False,
                default=str,
                separators=(',', ':'),
            ),
        )

    payload = {
        'version': 1,
        'session_id': str(session.id),
        'target': {
            'id': str(target_msg.id),
            'role': target_msg.role,
            'text_summary': target_msg.text_summary or '',
            'arrival_seq': target_msg.arrival_seq,
            'created_at': target_msg.created_at.isoformat() if target_msg.created_at else None,
        },
        'timeline': timeline,
        'checkpoint_hash': checkpoint_hash,
        'state_index': state_index,
        'rewind_anchor_id': rewind_anchor_id,
        'resource_preview_status': resource_preview_status,
        'resource_preview_reason': resource_preview_reason,
        'resource_changes': canonical_items(resource_changes),
        'resource_restore_plan': canonical_items(resource_restore_plan),
    }
    encoded = json.dumps(
        payload,
        sort_keys=True,
        ensure_ascii=False,
        default=str,
        separators=(',', ':'),
    ).encode('utf-8')
    return f"v1:{hashlib.sha256(encoded).hexdigest()}"


def _validate_rollback_preview_revision(
    *,
    mode: str,
    contract_version: int,
    supplied_revision: Optional[str],
    current_revision: str,
    supplied_file_revision: Optional[str] = None,
    current_file_revision: Optional[str] = None,
):
    """验证用户确认的预览仍是当前权威影响。

    普通 rollback 保留旧客户端缺字段语义；editAndResend 是新的高风险
    时间线重写模式，未回传指纹必须 fail-closed。
    """
    supplied = (supplied_revision or '').strip()
    if contract_version >= 2 and mode == 'editAndResend' and not supplied:
        return error_response_with_status(
            'ROLLBACK_PREVIEW_REQUIRED',
            message=_('chat.rollback_preview_required', default='请先重新检查对话、文件和资源的回退范围'),
            status_code=409,
        )
    supplied_file = (supplied_file_revision or '').strip()
    if contract_version >= 2 and mode == 'editAndResend' and not supplied_file:
        return error_response_with_status(
            'FILE_PREVIEW_REQUIRED',
            message=_('chat.file_preview_required', default='请先重新检查工作区文件的回退范围'),
            status_code=409,
        )
    if supplied and supplied != current_revision:
        return error_response_with_status(
            'ROLLBACK_PREVIEW_STALE',
            message=_('chat.rollback_preview_stale', default='对话或资源已发生变化，请重新检查回退范围'),
            status_code=409,
        )
    if current_file_revision is not None and supplied_file and supplied_file != current_file_revision:
        return error_response_with_status(
            'FILE_PREVIEW_STALE',
            message=_('chat.file_preview_stale', default='工作区文件已发生变化，请重新检查回退范围'),
            status_code=409,
        )
    return None


def _validate_file_preview_acknowledgement(
    *,
    mode: str,
    contract_version: int,
    current_status: str,
    current_reason: Optional[str],
    acknowledged_reason: Optional[str],
):
    """校验“仅重写对话”是用户对同一稳定风险的明确授权。

    瞬时未知状态即使客户端伪造 acknowledgement 也不放行；v1 保持
    已发布客户端语义。
    """
    if contract_version < 2 or mode != 'editAndResend' or current_status != 'unavailable':
        return None

    reason = (current_reason or '').strip()
    acknowledged = (acknowledged_reason or '').strip()
    if reason not in _CONVERSATION_ONLY_FILE_REASONS:
        return error_response_with_status(
            'FILE_PREVIEW_UNAVAILABLE',
            message=_('chat.file_preview_unavailable', default='暂时无法确认工作区文件影响，请重新检查'),
            status_code=409,
        )
    if acknowledged != reason:
        return error_response_with_status(
            'FILE_PREVIEW_ACK_REQUIRED',
            message=_(
                'chat.file_preview_ack_required',
                default='请先确认工作区文件不会自动恢复，再继续编辑重发',
            ),
            status_code=409,
        )
    return None


def _validate_resource_restore_preview(
    *,
    session: ChatSession,
    data: ResourceRestoreRequest,
):
    """把 v2 资源恢复请求限制在用户刚确认的预览计划内。

    ``rollback/resources`` 是对话回退后的第二个请求。仅校验资源是否落在回退
    消息范围内仍允许客户端替换 action / 目标版本，因此 v2 必须重新计算权威
    预览并要求每个计划项都显式选择恢复或 skip。v1 保留已发布客户端旧契约。
    """
    if data.rollback_contract_version < 2:
        return None

    supplied_revision = (data.preview_revision or '').strip()
    if not supplied_revision:
        return error_response_with_status(
            'ROLLBACK_PREVIEW_REQUIRED',
            message=_('chat.rollback_preview_required', default='请先重新检查对话、文件和资源的回退范围'),
            status_code=409,
        )

    active_operation = next((
        entry
        for entry in reversed(list(session.revert_history or []))
        if entry.get('type') == 'rollback'
        and entry.get('mode') == 'editAndResend'
        and str(entry.get('target_message_id') or '') == str(session.revert_message_id or '')
        and int(entry.get('rollback_contract_version') or 1) >= 2
    ), None)
    if (
        active_operation is None
        or active_operation.get('preview_revision') != supplied_revision
    ):
        return error_response_with_status(
            'ROLLBACK_OPERATION_STALE',
            message=_('chat.rollback_operation_stale', default='这次编辑重发已失效，请重新开始'),
            status_code=409,
        )
    if active_operation.get('resource_restore_status') != 'pending':
        return error_response_with_status(
            'ROLLBACK_OPERATION_CONSUMED',
            message=_('chat.rollback_operation_consumed', default='这次编辑重发已经执行，请勿重复提交'),
            status_code=409,
        )

    target_message_id = session.revert_message_id
    target_msg = (
        session.messages.filter(id=target_message_id).first()
        if target_message_id
        else None
    )
    if target_msg is None:
        return error_response_with_status(
            'ROLLBACK_PREVIEW_STALE',
            message=_('chat.rollback_preview_stale', default='对话或资源已发生变化，请重新检查回退范围'),
            status_code=409,
        )

    preview = _compute_rollback_preview(session, target_msg)
    if supplied_revision != preview.preview_revision:
        return error_response_with_status(
            'ROLLBACK_PREVIEW_STALE',
            message=_('chat.rollback_preview_stale', default='对话或资源已发生变化，请重新检查回退范围'),
            status_code=409,
        )

    plan_by_key = {
        (str(item.get('resource_type') or ''), str(item.get('resource_id') or '')): item
        for item in preview.resource_restore_plan
        if item.get('resource_type') and item.get('resource_id')
    }
    seen_keys: set[tuple[str, str]] = set()
    for requested in data.items:
        key = (requested.resource_type, requested.resource_id)
        if key in seen_keys:
            return error_response_with_status(
                'RESOURCE_RESTORE_PLAN_INVALID',
                message=_('chat.resource_restore_plan_invalid', default='资源恢复计划包含重复项目，请重新检查'),
                status_code=409,
            )
        seen_keys.add(key)

        expected = plan_by_key.get(key)
        if expected is None:
            return error_response_with_status(
                'RESOURCE_RESTORE_PLAN_STALE',
                message=_('chat.resource_restore_plan_stale', default='资源恢复范围已发生变化，请重新检查'),
                status_code=409,
            )

        # skip 只代表用户明确放弃此项，不产生资源副作用；仍要求该资源确实出现
        # 在已确认计划里。真正执行的项目必须与服务端计划 action / version 完全一致。
        if requested.action == 'skip':
            continue
        expected_action = str(expected.get('action') or '')
        expected_version = str(expected.get('restore_to_version_id') or '') or None
        requested_version = str(requested.restore_to_version_id or '') or None
        if (
            expected.get('can_restore') is not True
            or requested.action != expected_action
            or requested_version != expected_version
        ):
            return error_response_with_status(
                'RESOURCE_RESTORE_PLAN_STALE',
                message=_('chat.resource_restore_plan_stale', default='资源恢复计划已发生变化，请重新检查'),
                status_code=409,
            )

    if seen_keys != set(plan_by_key):
        return error_response_with_status(
            'RESOURCE_RESTORE_PLAN_INCOMPLETE',
            message=_('chat.resource_restore_plan_incomplete', default='请逐项确认所有受影响资源的处理方式'),
            status_code=409,
        )

    if any(item.action != 'skip' for item in data.items) and preview.resource_preview_status != 'available':
        return error_response_with_status(
            'RESOURCE_PREVIEW_UNAVAILABLE',
            message=_('chat.resource_preview_unavailable', default='暂时无法确认资源恢复范围，请重新检查'),
            status_code=409,
        )
    return None


def _resolve_rewind_anchor_id(session: ChatSession, target_msg: ChatMessage) -> Optional[str]:
    """解析 per-file 回退锚点。

    per-file 引擎 ``beginSnapshot`` 在轮**开始前**建基线，锚到某 run → 文件恢复到「该
    run 开始前」的世界。与前端 ``resolveRewindAnchorId`` 语义**完全一致**：

    - target 是 ``assistant``（点某条回复「回退到此位置」， 起**保留该轮**、仅撤销
      其后）→ 取其后第一条属于**不同 run** 的顶层 ``assistant`` 的 ``agent_run_id``
      （= 回退到本轮**之后**那一轮开始前，保留本轮文件）。本轮之后无新 run（含末条）→ None。
    - target 是 ``user``（编辑 + 恢复并发送，**移除**该消息）→ 取它之后第一条 assistant
      的 ``agent_run_id``（= 该 user 触发的那一轮）。

    返回 ``None``：目标之后无更晚的 run、命中 assistant 缺 ``agent_run_id``、或子 Agent 主消息。
    """
    from ..services.conversation_time import conversation_point, q_conversation_after

    later_top_level_assistants = session.messages.filter(
        role='assistant',
    ).exclude(
        subagent_run_id__gt='',
    ).filter(
        q_conversation_after(target_msg, include_target=False),
    )

    def first_by_conversation_time(queryset):
        return min(
            queryset,
            default=None,
            key=lambda message: (conversation_point(message), str(message.id)),
        )

    if target_msg.role == 'assistant':
        if target_msg.subagent_run_id:
            return None
        #  方向 B：保留该轮，锚到其后第一条「不同 run」的顶层 assistant
        # （回退其后各轮文件、保留本轮）。无法确定本轮 run（空 run id）→ None，不瞎猜。
        target_run = target_msg.agent_run_id or None
        if not target_run:
            return None
        next_run = first_by_conversation_time(
            later_top_level_assistants.exclude(agent_run_id=target_run),
        )
        return (next_run.agent_run_id or None) if next_run else None

    first_assistant = first_by_conversation_time(later_top_level_assistants)
    return (first_assistant.agent_run_id or None) if first_assistant else None


def _compute_rollback_preview(session: ChatSession, target_msg: ChatMessage) -> _RollbackPreviewComputation:
    """统一计算 rollback preview / apply 所需的影响信息，避免 preview 与 apply 漂移。

     方案 B：边界改按**对话时间**（arrival_seq，runtime emit 权威）而非
    created_at（落库时间）——relay 迟到重投场景下 created_at 顺序与真实对话
    顺序可以完全颠倒，preview 集合会错乱。legacy 行（arrival_seq NULL）回落
    created_at，见 conversation_time.q_conversation_before/after。
    """
    from ..services.conversation_time import (
        conversation_point,
        conversation_sort_key,
        q_conversation_after,
        q_conversation_before,
    )

    is_assistant_target = target_msg.role == 'assistant'
    ckpt_qs = (
        session.messages
        .filter(role='assistant')
        .exclude(checkpoint_hash__isnull=True)
        .exclude(checkpoint_hash='')
        .filter(q_conversation_before(target_msg, include_target=False))
    )
    # 对话时间上最靠近目标的 checkpoint 锚点（Python 侧取 max，兼容 legacy 回落）。
    last_checkpoint_msg = max(ckpt_qs, default=None, key=conversation_point)

    if is_assistant_target:
        # 「回退对话到此处」：保留所点 assistant 回复本身，仅移除其后的消息
        # （对齐 tooltip「移除之后的消息」+ _build_revert_visible_message_filter 的
        # assistant id__lte 可见边界；#4528 姊妹缺陷：曾用 id__gte 把这条回复也算进
        # 移除、清算时删掉）。文件仍回到该轮开始前（anchor=自身 run）。
        checkpoint_hash = last_checkpoint_msg.checkpoint_hash if last_checkpoint_msg else None
        state_index = last_checkpoint_msg.checkpoint_state_index if last_checkpoint_msg else None
        msgs_to_remove = session.messages.filter(
            q_conversation_after(target_msg, include_target=False)
        )
        anchor_message = last_checkpoint_msg
    else:
        checkpoint_hash = last_checkpoint_msg.checkpoint_hash if last_checkpoint_msg else None
        state_index = last_checkpoint_msg.checkpoint_state_index if last_checkpoint_msg else None
        msgs_to_remove = session.messages.filter(
            q_conversation_after(target_msg, include_target=True)
        )
        anchor_message = last_checkpoint_msg

    # W3 §3.3.1：rollback 预览 content → text_summary（content 字段已 drop）
    # ：预览列表按对话时间排序（Python 侧，兼容 legacy NULL 行回落 created_at）。
    msgs_to_remove_rows = sorted(
        msgs_to_remove.values(
            'id', 'role', 'text_summary', 'agent_run_id', 'message_kind', 'created_at',
            'arrival_seq',
        ),
        key=conversation_sort_key,
    )
    from ..services.semantic_message_count import (
        count_semantic_messages_from_values,
        is_context_injection_row,
    )

    remove_count = count_semantic_messages_from_values(msgs_to_remove_rows)
    # 预览列表与语义计数口径对齐：排除对用户不可见的 context 注入行（含 Runtime 内部上下文），
    # 否则「将移除 N 条」（已排除 context）与列表（含 context）行数对不上，且列表里
    # 会露出 <context type="environment"> 这类系统注入内容。
    # ：同理排除 hitl_interaction 事实行（语义计数已作 turn-transparent 排除，
    # 预览列表不排会多出 content_preview 为空的幽灵行）。
    preview_source_rows = [
        r for r in msgs_to_remove_rows
        if not is_context_injection_row(r) and r.get('message_kind') != 'hitl_interaction'
    ]
    preview_msgs = list(reversed(preview_source_rows[-5:]))
    messages_preview = [
        {
            "id": str(m["id"]),
            "role": m["role"],
            "content_preview": (m.get("text_summary") or "")[:SESSION_PREVIEW_MAX_LEN],
            "agent_run_id": m.get("agent_run_id") or "",
            "created_at": m["created_at"].isoformat() if m["created_at"] else None,
        }
        for m in preview_msgs
    ]

    run_ids = set()
    unrestorable = []
    resource_lineage_missing = False
    for m in msgs_to_remove.values('agent_run_id', 'role'):
        rid = m.get('agent_run_id') or ''
        if rid:
            run_ids.add(rid)
        elif m['role'] == 'assistant':
            resource_lineage_missing = True
            unrestorable.append("部分历史 assistant 消息缺少 agent_run_id，无法追溯关联资源变更")

    resource_preview_status = 'not_applicable'
    resource_preview_reason: Optional[str] = None
    if run_ids:
        try:
            from apps.collab.api import _resolve_cascading_run_ids
            expanded = set()
            for rid in run_ids:
                expanded.update(_resolve_cascading_run_ids(rid))
            run_ids = expanded
        except Exception:
            logger.debug("rollback_preview: cascading run_id resolution failed", exc_info=True)
            resource_preview_status = 'unavailable'
            resource_preview_reason = 'resource_lineage_query_failed'

    if resource_lineage_missing:
        resource_preview_status = 'unavailable'
        resource_preview_reason = 'resource_lineage_missing'

    resource_changes = []
    changes: list[dict] = []
    name_lookup: dict[tuple[str, str], str] = {}
    if run_ids:
        try:
            from apps.collab.constants import VIRTUAL_RESOURCE_TYPES
            from apps.collab.models import ChangeLog
            changes = list(ChangeLog.objects.using(postgres_app_db_alias()).filter(
                agent_run_id__in=list(run_ids)
            ).exclude(
                resource_type__in=VIRTUAL_RESOURCE_TYPES,
            ).values(
                'resource_type', 'resource_id', 'change_type', 'summary', 'agent_run_id',
            ))

            name_lookup = _resolve_resource_names(changes)

            resource_changes = [
                ResourceChangePreview(
                    resource_type=c['resource_type'],
                    resource_id=str(c['resource_id']),
                    resource_name=name_lookup.get((c['resource_type'], str(c['resource_id'])), ''),
                    change_type=c['change_type'],
                    summary=c.get('summary') or '',
                    agent_run_id=c.get('agent_run_id') or '',
                ).model_dump()
                for c in changes
            ]
        except Exception:
            logger.warning("rollback_preview: ChangeLog query failed", exc_info=True)
            resource_preview_status = 'unavailable'
            resource_preview_reason = 'resource_change_query_failed'

    resource_restore_plan = []
    if changes:
        try:
            resource_restore_plan = _compute_restore_plan(changes, name_lookup)
        except _ResourceVersionQueryError:
            logger.warning("rollback_preview: resource version query failed", exc_info=True)
            resource_preview_status = 'unavailable'
            resource_preview_reason = 'resource_version_query_failed'
        except Exception:
            logger.warning("rollback_preview: restore plan computation failed", exc_info=True)
            resource_preview_status = 'unavailable'
            resource_preview_reason = 'resource_restore_plan_failed'

    if changes and resource_preview_status != 'unavailable':
        changed_resource_keys = {
            (str(item.get('resource_type') or ''), str(item.get('resource_id') or ''))
            for item in changes
            if item.get('resource_type') and item.get('resource_id')
        }
        planned_resource_keys = {
            (str(item.get('resource_type') or ''), str(item.get('resource_id') or ''))
            for item in resource_restore_plan
            if item.get('resource_type') and item.get('resource_id')
        }
        if not changed_resource_keys.issubset(planned_resource_keys):
            resource_preview_status = 'unavailable'
            resource_preview_reason = 'resource_restore_plan_incomplete'
        else:
            resource_preview_status = 'available'

    if resource_restore_plan and checkpoint_hash:
        try:
            resource_restore_plan = _enhance_plan_with_space_checkpoint(
                resource_restore_plan, checkpoint_hash, _execution_checkpoint_space_id(session),
            )
        except Exception:
            logger.debug("rollback_preview: SpaceCheckpoint enhancement skipped", exc_info=True)

    restorable_count = len([item for item in resource_restore_plan if item.get('can_restore')])
    effective_checkpoint = None
    degraded_reasons: list[str] = []
    if checkpoint_hash and anchor_message:
        effective_checkpoint = _build_checkpoint_record(
            anchor_message,
            space_checkpoint=_get_space_checkpoint_summary(session, checkpoint_hash),
            messages_to_remove=remove_count,
            resource_change_count=len(resource_changes),
            resource_restore_count=restorable_count,
            compact=False,
        )
        degraded_reasons = list(effective_checkpoint.degraded_reasons or [])
    elif remove_count > 0 or resource_changes:
        degraded_reasons.append(CHECKPOINT_DEGRADED_REASON_MISSING_EFFECTIVE_CHECKPOINT)

    no_impact = (
        remove_count == 0 and
        not checkpoint_hash and
        len(resource_changes) == 0 and
        len(resource_restore_plan) == 0 and
        resource_preview_status != 'unavailable'
    )

    # DC-W0-1-1 / D15 方案 A / Wave 1.1：把模块维度（首期 tabdata）的影响摘要
    # 注入 impact 字典，供 RewindPreviewPanel 显示「影响 N 张表 / N 行记录」与
    # 字段级 preview。tabdata 数据由
    # :class:`apps.tabdata.contributors.TableImpactContributor` 提供
    # （Charter §3.3）；TableAdapter.preview_restore 给出字段 diff +
    # estimated_duration_ms（Charter §3.4）。
    modules_impact: dict = {}
    if run_ids:
        try:
            from apps.collab.services.contributors import collect_contributed_impact

            modules_impact = dict(collect_contributed_impact(list(run_ids)))
        except Exception:
            logger.debug(
                "rollback_preview: contributors collect_impact failed",
                exc_info=True,
            )

    # 对 tabdata 维度的每个 table 进一步调用 TableAdapter.preview_restore，
    # 在影响摘要里附带字段级 diff + estimated_duration_ms（DC-W0-1-1 落地）。
    # 仅 SpaceCheckpoint 已 enhance 过 plan、能解析出 target VH 时启用。
    if 'tabdata' in modules_impact and resource_restore_plan:
        try:
            modules_impact['tabdata'] = _enrich_tabdata_impact_with_preview(
                tabdata_impact=modules_impact['tabdata'],
                resource_restore_plan=resource_restore_plan,
            )
        except Exception:
            logger.debug(
                "rollback_preview: tabdata preview_restore enrichment failed",
                exc_info=True,
            )

    impact_payload = {
        'files': {
            'available': bool(checkpoint_hash),
            'diff_available': bool(effective_checkpoint and effective_checkpoint.capability_scope.file_diff),
        },
        'resources': {
            'available': len(resource_changes) > 0 or len(resource_restore_plan) > 0,
            'change_count': len(resource_changes),
            'restore_count': restorable_count,
        },
        'messages': {
            'to_remove': remove_count,
        },
    }
    impact_payload.update(modules_impact)

    rewind_anchor_id = _resolve_rewind_anchor_id(session, target_msg)
    preview_revision = _build_rollback_preview_revision(
        session=session,
        target_msg=target_msg,
        messages_to_remove=msgs_to_remove_rows,
        checkpoint_hash=checkpoint_hash,
        state_index=state_index,
        rewind_anchor_id=rewind_anchor_id,
        resource_changes=resource_changes,
        resource_restore_plan=resource_restore_plan,
        resource_preview_status=resource_preview_status,
        resource_preview_reason=resource_preview_reason,
    )

    return _RollbackPreviewComputation(
        target_msg=target_msg,
        anchor_message=anchor_message,
        checkpoint_hash=checkpoint_hash,
        rewind_anchor_id=rewind_anchor_id,
        state_index=state_index,
        truncated_count=remove_count,
        messages_preview=messages_preview,
        resource_changes=resource_changes,
        resource_restore_plan=resource_restore_plan,
        resource_preview_status=resource_preview_status,
        resource_preview_reason=resource_preview_reason,
        preview_revision=preview_revision,
        unrestorable_items=list(dict.fromkeys(unrestorable)),
        effective_checkpoint=effective_checkpoint,
        degraded_reasons=degraded_reasons,
        impact=impact_payload,
        no_impact=no_impact,
    )


def _enrich_tabdata_impact_with_preview(
    *,
    tabdata_impact: dict,
    resource_restore_plan: list[dict],
) -> dict:
    """DC-W0-1-1：对 tabdata 维度每个 table 调 ``TableAdapter.preview_restore``，
    把 ``records_to_create / records_to_delete / records_to_restore /
    fields_to_restore / estimated_duration_ms`` 合并入 ``tables_affected[].preview``。

    输入数据来源:
    - ``tabdata_impact`` —— :class:`apps.tabdata.contributors.TableImpactContributor`
      的输出（含 ``tables_affected`` list）。
    - ``resource_restore_plan`` —— 已 enhance 过的 plan，含
      ``restore_to_version_id`` 字段，可用于反查目标 VH。

    Fail-safe：单 table preview 失败仅打 debug 不抛；TabData adapter / VH
    无法定位时该 table preview 字段缺失但其余信息仍展示。
    """
    if not isinstance(tabdata_impact, dict):
        return tabdata_impact
    tables_affected = tabdata_impact.get('tables_affected') or []
    if not tables_affected:
        return tabdata_impact

    # 把 plan 按 (resource_type, resource_id) 索引
    plan_index = {
        (item.get('resource_type'), str(item.get('resource_id'))): item
        for item in resource_restore_plan
        if item.get('resource_type') == 'table' and item.get('resource_id')
    }
    if not plan_index:
        return tabdata_impact

    try:
        from apps.collab.adapters.table import TableCollabAdapter
        from apps.collab.models import VersionHistory
    except Exception:
        return tabdata_impact

    adapter = TableCollabAdapter()
    enriched_tables = []
    for entry in tables_affected:
        if not isinstance(entry, dict):
            enriched_tables.append(entry)
            continue
        tid = str(entry.get('table_id') or '')
        plan_item = plan_index.get(('table', tid))
        if not plan_item or not plan_item.get('restore_to_version_id'):
            enriched_tables.append(entry)
            continue

        try:
            from uuid import UUID
            vh = VersionHistory.objects.using(postgres_app_db_alias()).filter(
                id=UUID(plan_item['restore_to_version_id']),
            ).only('blob').first()
            if not vh or not vh.blob:
                enriched_tables.append(entry)
                continue
            target_data = adapter.deserialize_snapshot(bytes(vh.blob))
            if not isinstance(target_data, dict):
                enriched_tables.append(entry)
                continue
            resource = adapter.get_resource_for_rollback(tid)
            if not resource:
                enriched_tables.append(entry)
                continue
            preview = adapter.preview_restore(resource, target_data)
            enriched_tables.append({**entry, 'preview': preview})
        except Exception:
            logger.debug(
                "rollback_preview: tabdata preview enrichment failed for table=%s",
                tid, exc_info=True,
            )
            enriched_tables.append(entry)

    return {**tabdata_impact, 'tables_affected': enriched_tables}


def _enhance_plan_with_space_checkpoint(
    plan: list[dict],
    checkpoint_hash: str,
    space_id,
) -> list[dict]:
    """当存在 SpaceCheckpoint 时，用其 version_refs 增强 restore plan。

    SpaceCheckpoint 记录了该时间点每个资源的精确 VH ID，比从 ChangeLog 逆向
    计算 pre_change_version 更可靠。
    """
    if not checkpoint_hash or not space_id:
        return plan

    from apps.collab.models import SpaceCheckpoint, VersionHistory
    cp = (
        SpaceCheckpoint.objects.using(postgres_app_db_alias())
        .filter(space_id=space_id, file_checkpoint_hash=checkpoint_hash)
        .order_by("-created_at")
        .values("version_refs", "created_at")
        .first()
    )
    if not cp or not cp.get("version_refs"):
        return plan

    version_refs = cp["version_refs"]
    cp_time = cp.get("created_at")

    vh_ids = [v for v in version_refs.values() if v]
    vh_times = {}
    if vh_ids:
        from uuid import UUID
        vh_uuids = []
        for vid in vh_ids:
            try:
                vh_uuids.append(UUID(vid))
            except ValueError:
                continue
        if vh_uuids:
            for row in VersionHistory.objects.using(postgres_app_db_alias()).filter(
                id__in=vh_uuids
            ).values("id", "created_at"):
                vh_times[str(row["id"])] = row["created_at"]

    enhanced = []
    for item in plan:
        key = f"{item.get('resource_type')}:{item.get('resource_id')}"
        ref_vh_id = version_refs.get(key)
        if ref_vh_id and item.get("action") in ("restore_version", "no_version"):
            vh_time = vh_times.get(ref_vh_id) or cp_time
            enhanced.append({
                **item,
                "action": "restore_version",
                "can_restore": True,
                "restore_to_version_id": ref_vh_id,
                "restore_to_version_time": vh_time.isoformat() if vh_time else None,
                "action_label": item.get("action_label") or _("chat.action_label_restore_checkpoint", default="恢复到检查点版本"),
            })
        else:
            enhanced.append(item)
    return enhanced


def _compute_restore_plan(
    changes: list[dict],
    name_lookup: dict[tuple[str, str], str],
) -> list[dict]:
    """
    根据 ChangeLog 记录计算各资源的回退计划。

    按 (resource_type, resource_id) 分组，确定每个资源的回退方式：
    - create → trash（Agent 创建的资源，回退时移入回收站）
    - update → restore_version（恢复到变更前的版本）
    - delete → skip（已删除的资源暂不处理）
    """
    from collections import defaultdict
    from apps.collab.models import VersionHistory

    grouped: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for c in changes:
        key = (c['resource_type'], str(c['resource_id']))
        grouped[key].append(c)

    plan: list[dict | _PendingVersionRestore] = []

    for (rtype, rid), group in grouped.items():
        change_types = {c['change_type'] for c in group}
        rname = name_lookup.get((rtype, rid), '')

        if 'create' in change_types:
            plan.append(ResourceRestoreInfo(
                resource_type=rtype,
                resource_id=rid,
                resource_name=rname,
                action='trash',
                action_label=_('chat.action_label_trash', default='将移入回收站'),
                can_restore=True,
                change_count=len(group),
            ).model_dump())
            continue

        if 'update' in change_types or 'restore' in change_types:
            agent_run_ids = [c.get('agent_run_id', '') for c in group if c.get('agent_run_id')]
            if agent_run_ids:
                plan.append(_PendingVersionRestore(
                    resource_type=rtype,
                    resource_id=rid,
                    resource_name=rname,
                    change_count=len(group),
                    agent_run_ids=agent_run_ids,
                ))
                continue

        plan.append(ResourceRestoreInfo(
            resource_type=rtype,
            resource_id=rid,
            resource_name=rname,
            action='no_version' if 'update' in change_types else 'skip',
            action_label=_('chat.action_label_no_version', default='无版本记录可恢复') if 'update' in change_types else '',
            can_restore=False,
            change_count=len(group),
        ).model_dump())

    pending_items = {
        (p.resource_type, p.resource_id): p
        for p in plan if isinstance(p, _PendingVersionRestore)
    }

    if pending_items:
        all_run_ids = set()
        for p in pending_items.values():
            all_run_ids.update(p.agent_run_ids)

        try:
            from apps.collab.models import ChangeLog as CL
            fallback_times: dict[tuple[str, str], "datetime"] = {}
            version_times: dict[tuple[str, str], "datetime"] = {}
            post_version_ids: set[str] = set()
            cl_entries = CL.objects.using(postgres_app_db_alias()).filter(
                agent_run_id__in=list(all_run_ids)
            ).values(
                'resource_type',
                'resource_id',
                'created_at',
                'version_history_id',
                'version_history__created_at',
            ).order_by('created_at')

            for entry in cl_entries:
                key = (entry['resource_type'], str(entry['resource_id']))
                if key not in pending_items:
                    continue
                if key not in fallback_times:
                    fallback_times[key] = entry['created_at']
                if (
                    key not in version_times
                    and entry.get('version_history_id')
                    and entry.get('version_history__created_at')
                ):
                    version_times[key] = entry['version_history__created_at']
                elif (
                    key in version_times
                    and entry.get('version_history_id')
                    and entry.get('version_history__created_at')
                    and entry['version_history__created_at'] < version_times[key]
                ):
                    version_times[key] = entry['version_history__created_at']
                if entry.get('version_history_id'):
                    post_version_ids.add(str(entry['version_history_id']))

            earliest_times = {
                key: version_times.get(key) or fallback_time
                for key, fallback_time in fallback_times.items()
            }

            from django.db.models import Q as _Q
            vh_q = _Q()
            for key, etime in earliest_times.items():
                if key in pending_items:
                    if key in version_times:
                        vh_q |= _Q(resource_type=key[0], resource_id=key[1], created_at__lte=etime)
                    else:
                        vh_q |= _Q(resource_type=key[0], resource_id=key[1], created_at__lt=etime)

            pre_version_map: dict[tuple[str, str], dict] = {}
            if vh_q:
                vh_candidates = VersionHistory.objects.using(postgres_app_db_alias()).filter(vh_q)
                if post_version_ids:
                    vh_candidates = vh_candidates.exclude(id__in=list(post_version_ids))
                for v in (
                    vh_candidates
                    .order_by('resource_type', 'resource_id', '-created_at')
                    .values('id', 'name', 'created_at', 'is_named', 'resource_type', 'resource_id')
                ):
                    vkey = (v['resource_type'], str(v['resource_id']))
                    if vkey not in pre_version_map:
                        pre_version_map[vkey] = v

            for i, item in enumerate(plan):
                if not isinstance(item, _PendingVersionRestore):
                    continue

                key = (item.resource_type, item.resource_id)
                if key not in earliest_times:
                    plan[i] = ResourceRestoreInfo(
                        resource_type=item.resource_type,
                        resource_id=item.resource_id,
                        resource_name=item.resource_name,
                        action='no_version',
                        action_label=_('chat.action_label_no_history', default='无历史版本可恢复'),
                        can_restore=False,
                        change_count=item.change_count,
                    ).model_dump()
                    continue

                pre_version = pre_version_map.get(key)

                if pre_version:
                    version_label = pre_version['name'] or str(pre_version['id'])[:8]
                    plan[i] = ResourceRestoreInfo(
                        resource_type=item.resource_type,
                        resource_id=item.resource_id,
                        resource_name=item.resource_name,
                        action='restore_version',
                        action_label=_('chat.action_label_restore_version', default='恢复到版本 {version}', version=version_label),
                        can_restore=True,
                        restore_to_version_id=str(pre_version['id']),
                        restore_to_version_time=pre_version['created_at'].isoformat() if pre_version['created_at'] else None,
                        change_count=item.change_count,
                    ).model_dump()
                else:
                    plan[i] = ResourceRestoreInfo(
                        resource_type=item.resource_type,
                        resource_id=item.resource_id,
                        resource_name=item.resource_name,
                        action='no_version',
                        action_label=_('chat.action_label_no_history', default='无历史版本可恢复'),
                        can_restore=False,
                        change_count=item.change_count,
                    ).model_dump()

        except Exception as exc:
            logger.warning("_compute_restore_plan: VersionHistory query failed", exc_info=True)
            raise _ResourceVersionQueryError('resource version history query failed') from exc

    return _attach_resource_state_revisions(
        [item for item in plan if isinstance(item, dict)]
    )


def _publish_resource_rollback_notice(
    session: "ChatSession",
    results: list[dict],
    requested_items_by_key: dict[tuple[str, str], dict],
    restored: int,
) -> None:
    """回退资源成功后，向 session 的 thread 推送系统通知（H8 协作者感知）。

    协作者如果正在编辑被回退的资源，可通过此通知及时刷新页面获取最新内容。
    """
    if restored <= 0 or not session.thread_id:
        return

    try:
        from apps.services.common.chat_stream_publisher import ChatStreamPublisher

        succeeded = [r for r in results if r.get('success')]
        name_lookup = _resolve_resource_names(succeeded)

        details: list[str] = []
        for r in succeeded:
            rtype = r['resource_type']
            rid = r['resource_id']
            type_label = _RESOURCE_TYPE_LABELS.get(rtype, rtype)
            rname = name_lookup.get((rtype, rid), '')
            label = f"{type_label}「{rname}」" if rname else f"{type_label}({rid[:8]})"
            item_action = requested_items_by_key.get((rtype, rid), {}).get('action', '')
            if item_action == 'trash':
                details.append(f"{label} 已移入回收站")
            else:
                details.append(f"{label} 已恢复到历史版本")

        notice = _("chat.resource_rollback_notice",
                    default="回退操作已执行：{details}。如果你正在编辑相关资源，请刷新页面。",
                    details="；".join(details))
        ChatStreamPublisher.publish_system_notice(session.thread_id, notice)
        logger.info(
            "rollback_resources: published rollback notice thread=%s restored=%d",
            session.thread_id, restored,
        )
    except Exception:
        logger.warning("_publish_resource_rollback_notice: failed", exc_info=True)


# ---------------------------------------------------------------------------
# 路由函数
# ---------------------------------------------------------------------------

@router.post(
    "/sessions/{session_id}/rollback/preview",
    auth=jwt_auth,
    response=_CHECKPOINT_ROUTE_RESPONSES,
    tags=["检查点管理"],
)
def rollback_preview(request, session_id: str, data: RollbackPreviewRequest):
    """
    回滚预览（dry-run）— 返回回退影响清单，不实际执行。

    计算将移除的消息数量、关联的资源变更、以及不可追溯的历史消息。
    """
    session = ChatSession.objects.filter(
        id=session_id, user=request.auth
    ).first()
    if not session:
        return error_response_with_status(
            "NOT_FOUND", message=_("chat.session_not_found"), status_code=404,
        )
    target_msg = session.messages.filter(id=data.target_message_id).first()
    if not target_msg:
        _log_missing_rollback_target(session, data.target_message_id, endpoint="preview")
        return error_response_with_status(
            "NOT_FOUND", message=_("chat.target_message_not_found"), status_code=404,
        )
    if target_msg.role not in ('user', 'assistant'):
        return error_response_with_status(
            "VALIDATION_ERROR", message=_("chat.rollback_user_assistant_only"), status_code=400,
        )

    preview_result = _compute_rollback_preview(session, target_msg)

    # ── FH-4：Daemon 宿主 per-file 回退预览（§3.5/§3.9）─────────────────────────
    # Daemon 宿主会话此前在前端用失真的 shadow-git checkpoint_hash 推断「将恢复哪些
    # 文件」；现由后端 dispatch file_history_preview（per-file 真实账本，daemon 侧已实现
    # 但原为死代码）取 anchor 那一轮真实 affected_paths，连同宿主分流判据
    # file_restore_host 一并下发，前端据 'daemon' 用 affected_paths 渲染 per-file 清单。
    # Electron 本地宿主：maybe_file_history_preview 返回 host='local' + 空清单，前端
    # 仍走本地 fileHistoryIpc.getAffectedPaths（链路不变，不破坏本地路径）。
    request_headers = getattr(request, 'headers', {})
    client_type = str(request_headers.get('X-Client-Type', '') or '').strip().lower()
    file_preview = _resolve_file_preview_for_client(
        session=session,
        rewind_anchor_id=preview_result.rewind_anchor_id,
        client_type=client_type,
    )
    affected_paths = list(file_preview.affected_paths)
    file_preview_revision = file_preview.revision or _build_file_preview_revision(
        session_id=str(session.id),
        thread_id=str(session.thread_id or ''),
        host=file_preview.host,
        device_fingerprint=file_preview.device_fingerprint,
        rewind_anchor_id=preview_result.rewind_anchor_id,
        status=file_preview.status,
        reason=file_preview.reason,
        affected_paths=file_preview.affected_paths,
    )

    return success_response(data=RollbackPreviewResponse(
        target_message_id=str(target_msg.id),
        target_timestamp=target_msg.created_at.isoformat() if target_msg.created_at else None,
        messages_to_remove=preview_result.truncated_count,
        messages_preview=preview_result.messages_preview,
        checkpoint_hash=preview_result.checkpoint_hash,
        effective_checkpoint=preview_result.effective_checkpoint,
        resource_changes=preview_result.resource_changes,
        resource_restore_plan=preview_result.resource_restore_plan,
        resource_preview_status=preview_result.resource_preview_status,
        resource_preview_reason=preview_result.resource_preview_reason,
        preview_revision=preview_result.preview_revision,
        unrestorable_items=preview_result.unrestorable_items,
        degraded_reasons=preview_result.degraded_reasons,
        no_impact=preview_result.no_impact,
        impact=preview_result.impact,
        affected_paths=affected_paths,
        rewind_anchor_id=preview_result.rewind_anchor_id,
        file_restore_host=file_preview.host,
        file_preview_success=file_preview.success,
        file_preview_status=file_preview.status,
        file_preview_reason=file_preview.reason,
        unrestorable_files=[
            {'path': path, 'reason': reason}
            for path, reason in file_preview.unrestorable_files
        ],
        file_preview_revision=file_preview_revision,
    ).model_dump(mode='json'))


@router.post(
    "/sessions/{session_id}/rollback/execute",
    auth=jwt_auth,
    response=_CHECKPOINT_ROUTE_RESPONSES,
    tags=["检查点管理"],
)
@transaction.atomic
def execute_rollback_from_control_client(request, session_id: str, data: RollbackExecuteRequest):
    """从移动端等非执行端安全执行会话回退。

    先让绑定的 Electron/Daemon runtime 写入时间线边界；只有它明确返回 applied，
    才复用正式 rollback 投影。这样不会把 ``runtime_rewind_applied`` 这类宿主
    事实交给手机伪造。
    """
    # 锁住会话直到执行设备完成 compare-and-apply 且 DB 投影落下。消息写入会经过
    # 同一 session 外键/序列化边界，避免校验预览后、runtime 副作用前又插入新消息。
    session = ChatSession.objects.select_for_update().filter(
        id=session_id,
        user=request.auth,
    ).first()
    if not session:
        return error_response_with_status(
            "NOT_FOUND", message=_("chat.session_not_found"), status_code=404,
        )
    pending_error = _reject_pending_file_restore(session)
    if pending_error is not None:
        return pending_error
    if (
        data.rollback_contract_version >= 2
        and data.mode == 'editAndResend'
        and session.revert_message_id is not None
    ):
        return error_response_with_status(
            'ROLLBACK_OPERATION_CONSUMED',
            message=_('chat.rollback_operation_consumed', default='这次编辑重发已经执行，请勿重复提交'),
            status_code=409,
        )

    target_msg = session.messages.filter(id=data.target_message_id).first()
    if not target_msg:
        _log_missing_rollback_target(session, data.target_message_id, endpoint="execute")
        return error_response_with_status(
            "NOT_FOUND", message=_("chat.target_message_not_found"), status_code=404,
        )
    if target_msg.role not in ('user', 'assistant'):
        return error_response_with_status(
            "VALIDATION_ERROR", message=_("chat.rollback_user_assistant_only"), status_code=400,
        )

    preview_result = _compute_rollback_preview(session, target_msg)
    request_headers = getattr(request, 'headers', {})
    client_type = str(request_headers.get('X-Client-Type', '') or '').strip().lower()
    current_file_preview = _resolve_file_preview_for_client(
        session=session,
        rewind_anchor_id=preview_result.rewind_anchor_id,
        client_type=client_type,
    )
    current_file_revision = current_file_preview.revision or _build_file_preview_revision(
        session_id=str(session.id),
        thread_id=str(session.thread_id or ''),
        host=current_file_preview.host,
        device_fingerprint=current_file_preview.device_fingerprint,
        rewind_anchor_id=preview_result.rewind_anchor_id,
        status=current_file_preview.status,
        reason=current_file_preview.reason,
        affected_paths=current_file_preview.affected_paths,
    )
    revision_error = _validate_rollback_preview_revision(
        mode=data.mode,
        contract_version=data.rollback_contract_version,
        supplied_revision=data.preview_revision,
        current_revision=preview_result.preview_revision,
        supplied_file_revision=data.file_preview_revision,
        current_file_revision=current_file_revision,
    )
    if revision_error is not None:
        return revision_error
    acknowledgement_error = _validate_file_preview_acknowledgement(
        mode=data.mode,
        contract_version=data.rollback_contract_version,
        current_status=current_file_preview.status,
        current_reason=current_file_preview.reason,
        acknowledged_reason=data.acknowledged_file_preview_reason,
    )
    if acknowledgement_error is not None:
        return acknowledgement_error

    runtime_result = _request_runtime_timeline_rewind(
        session,
        target_msg,
        mode=data.mode,
        contract_version=data.rollback_contract_version,
        expected_file_preview_revision=data.file_preview_revision,
    )
    if not runtime_result.applied:
        return error_response_with_status(
            "RUNTIME_REWIND_UNAVAILABLE",
            message=runtime_result.error or '执行设备未能完成对话上下文回退。',
            status_code=409,
        )

    # ``rollback_session`` 仍承担文件、资源、审计和全端广播；给同一 request 标一个
    # 仅进程内可见的标记，避免它在 DB 投影后再次向 runtime 发同一条 rewind。
    # 该标记不来自客户端请求，不能被 API body 伪造。
    previous_marker = getattr(request, '_runtime_rewind_coordinated', False)
    previous_file_restore_result = getattr(request, '_runtime_file_restore_result', None)
    previous_validated_preview = getattr(request, '_validated_rollback_preview_result', None)
    request._runtime_rewind_coordinated = True
    request._runtime_file_restore_result = (
        runtime_result if runtime_result.file_restore_coordinated else None
    )
    # runtime 已执行不可逆 transcript/file 副作用后，nested rollback_session 必须
    # 复用副作用前已通过 revision 校验的冻结预览，不能因资源/VH 随后变化再次 409。
    request._validated_rollback_preview_result = preview_result
    try:
        return rollback_session(
            request,
            session_id,
            RollbackRequest(
                target_message_id=data.target_message_id,
                safety_snapshot_hash=data.safety_snapshot_hash,
                rollback_reason=data.rollback_reason,
                runtime_rewind_applied=True,
                runtime_keep_message_count=runtime_result.keep_message_count,
                mode=data.mode,
                preview_revision=data.preview_revision,
                file_preview_revision=data.file_preview_revision,
                acknowledged_file_preview_reason=data.acknowledged_file_preview_reason,
                rollback_contract_version=data.rollback_contract_version,
            ),
        )
    finally:
        request._runtime_rewind_coordinated = previous_marker
        request._runtime_file_restore_result = previous_file_restore_result
        request._validated_rollback_preview_result = previous_validated_preview


@router.post(
    "/sessions/{session_id}/rollback",
    auth=jwt_auth,
    response=_CHECKPOINT_ROUTE_RESPONSES,
    tags=["检查点管理"],
)
def rollback_session(request, session_id: str, data: RollbackRequest):
    """
    软回滚会话到指定消息。

    只标记回滚点（设置 session.revert_message_id），不立即删除消息或
    截断 PG ConversationState。物理清理推迟到用户发送新消息时执行
    （见 _cleanup_reverted_messages）。

    这保证了回滚是可撤销的——用户可以通过 unrevert 恢复到回滚前的状态。
    """
    from django.db import transaction

    with transaction.atomic():
        session = ChatSession.objects.select_for_update().filter(
            id=session_id, user=request.auth
        ).first()
        if not session:
            return error_response_with_status("NOT_FOUND", message=_("chat.session_not_found"), status_code=404)

        pending_error = _reject_pending_file_restore(session)
        if pending_error is not None:
            return pending_error

        if (
            data.rollback_contract_version >= 2
            and data.mode == 'editAndResend'
            and session.revert_message_id is not None
        ):
            return error_response_with_status(
                'ROLLBACK_OPERATION_CONSUMED',
                message=_('chat.rollback_operation_consumed', default='这次编辑重发已经执行，请勿重复提交'),
                status_code=409,
            )

        if not data.runtime_rewind_applied:
            return error_response_with_status(
                "VALIDATION_ERROR",
                message=_("chat.rollback_runtime_first_required"),
                status_code=400,
            )

        target_msg = session.messages.filter(id=data.target_message_id).first()
        if not target_msg:
            _log_missing_rollback_target(session, data.target_message_id, endpoint="apply")
            return error_response_with_status("NOT_FOUND", message=_("chat.target_message_not_found"), status_code=404)
        if target_msg.role not in ('user', 'assistant'):
            return error_response_with_status("VALIDATION_ERROR", message=_("chat.rollback_user_assistant_only"), status_code=400)

        validated_preview = getattr(request, '_validated_rollback_preview_result', None)
        if (
            validated_preview is not None
            and str(getattr(validated_preview, 'target_msg', target_msg).id) == str(target_msg.id)
        ):
            preview_result = validated_preview
        else:
            preview_result = _compute_rollback_preview(session, target_msg)
            revision_error = _validate_rollback_preview_revision(
                mode=data.mode,
                contract_version=data.rollback_contract_version,
                supplied_revision=data.preview_revision,
                current_revision=preview_result.preview_revision,
                supplied_file_revision=data.file_preview_revision,
            )
            if revision_error is not None:
                return revision_error
        checkpoint_hash = preview_result.checkpoint_hash
        rewind_anchor_id = preview_result.rewind_anchor_id
        state_index = preview_result.state_index
        truncated_count = preview_result.truncated_count
        anchor_message = preview_result.anchor_message

        if preview_result.no_impact:
            logger.info(
                "rollback_session: noop session=%s user=%s target_msg=%s",
                session_id,
                request.auth.id,
                data.target_message_id,
            )
            rollback_state = _build_session_rollback_state(session)
            apply_result_view = _build_rollback_apply_result(
                apply_id=f"rollback_noop:{session_id}:{timezone.now().isoformat()}",
                session=session,
                overall_status='success',
                checkpoint_record=preview_result.effective_checkpoint,
                file_restore_success=True,
                file_restore_status='not_applicable',
            )
            return success_response(data=RollbackResponse(
                success=True,
                mode=data.mode,
                checkpoint_hash=checkpoint_hash,
                truncated_message_count=0,
                file_restore_success=True,
                file_restore_status='not_applicable',
                file_restore_reason='no_impact',
                overall_status='success',
                rollback_state=rollback_state,
                checkpoint_record=preview_result.effective_checkpoint,
                apply_result=apply_result_view,
                partial_success_details=None,
                message=_(
                    "chat.rollback_noop",
                    default="当前已在目标状态，无需进入回退态",
                ),
            ).model_dump(mode='json'))

        session.revert_message_id = target_msg.id
        session.revert_snapshot_hash = data.safety_snapshot_hash or None
        session.revert_state_index = state_index
        session.revert_at = timezone.now()
        session.revert_resource_state = None

        history_apply_id = f"rollback:{session_id}:{timezone.now().isoformat()}"
        rollback_reason = (data.rollback_reason or '').strip()[:500]
        requested_finalize_expiry = (
            build_file_restore_finalize_expiry()
            if data.defer_local_file_restore_finalize
            else None
        )
        _append_revert_history(session, {
            'type': 'rollback',
            'apply_id': history_apply_id,
            'target_message_id': str(target_msg.id),
            'snapshot_hash': checkpoint_hash,
            'messages_removed': truncated_count,
            'apply_result': 'success',
            'partial_success_details': None,
            'rollback_reason': rollback_reason or None,
            'mode': data.mode,
            'preview_revision': data.preview_revision,
            'file_preview_revision': data.file_preview_revision,
            'acknowledged_file_preview_reason': data.acknowledged_file_preview_reason,
            'rollback_contract_version': data.rollback_contract_version,
            'resource_restore_status': (
                'pending'
                if data.rollback_contract_version >= 2
                and data.mode == 'editAndResend'
                and bool(preview_result.resource_restore_plan)
                else 'not_applicable'
            ),
            'file_restore_status': 'pending' if data.defer_local_file_restore_finalize else None,
            'file_restore_finalize_required': bool(data.defer_local_file_restore_finalize),
            'file_restore_finalize_expires_at': requested_finalize_expiry,
            'created_at': timezone.now().isoformat(),
        })

        session.save(update_fields=[
            'revert_message_id',
            'revert_snapshot_hash',
            'revert_state_index',
            'revert_at',
            'revert_resource_state',
            'revert_history',
            'updated_at',
        ])

    logger.info("rollback_session: session=%s user=%s target_msg=%s truncated=%d has_checkpoint=%s",
                session_id, request.auth.id, data.target_message_id, truncated_count, bool(checkpoint_hash))

    # ── 本地文件恢复：per-file rewind + 宿主分流（§3.9）──────────────────────
    # 旧实现走 shadow-git ``maybe_checkpoint_restore(checkpoint_hash)``（off-by-one）；
    # 现切到 per-file ``maybe_file_history_rewind(anchor_id)``——anchor = 目标那一轮顶层
    # agentRunId。宿主分流：
    #   - Daemon 宿主：后端 dispatch file_history_rewind 回退远端文件，结果决定
    #     file_restore_success；file_restore_host='daemon' 让前端**跳过**本地 rewind。
    #   - Electron 本地宿主：桌面端直接发起时仍由 renderer 回退；移动端控制
    #     路径则已由绑定 Electron 主进程在本段之前执行并确认，不能再默认成功。
    # 仅切「本地文件恢复」这一层——对话截断 / 云资源 plan / HITL 取消 / unrevert 编排不变。
    # FH-3：宿主分流**独立于 anchor 是否存在**——只要会话有 thread 就先判宿主。
    # Daemon 会话即使 rewind_anchor_id=None（目标那一轮还没 agent run / 老消息无
    # agent_run_id）也回 host='daemon'（success=True、no-op），别让前端在 daemon
    # thread 上盲调本地 rewind 报假失败。条件从 `rewind_anchor_id and thread_id`
    # 放宽为 `thread_id`；空锚点交给 maybe_file_history_rewind 内部 no-op 分流。
    file_restore_success = True
    file_restore_status = 'not_applicable' if not rewind_anchor_id else 'success'
    file_restore_reason = 'no_file_anchor' if not rewind_anchor_id else None
    failed_files: list[str] = []
    file_restore_host = 'local'
    file_restore_failure_reason = 'daemon_restore_failed'
    runtime_file_restore_result = getattr(request, '_runtime_file_restore_result', None)
    if getattr(runtime_file_restore_result, 'file_restore_coordinated', False):
        # 仅 execute_rollback_from_control_client 写入此 request 私有 marker。它来自
        # 已认证的 Electron device action result，不能由移动端 body 伪造。
        file_restore_success = runtime_file_restore_result.file_restore_success is True
        file_restore_status = runtime_file_restore_result.file_restore_status or (
            'success' if file_restore_success else 'failed'
        )
        file_restore_reason = runtime_file_restore_result.file_restore_reason
        failed_files = list(runtime_file_restore_result.failed_files)
        file_restore_host = 'local'
        if not file_restore_success:
            file_restore_failure_reason = (
                file_restore_reason or 'control_device_file_restore_failed'
            )
            logger.warning(
                'rollback_session: Electron control-device file rewind partial session=%s failed_files=%s',
                session_id,
                getattr(runtime_file_restore_result, 'file_restore_failed_file_count', 0),
            )
    elif session.thread_id:
        try:
            from apps.services.agent_engine.services.daemon_checkpoint_service import DaemonCheckpointService
            # 迁移期保留：为 Daemon unrevert 预存 revert_snapshot_hash（unrevert 仍走
            # shadow-git，「unrevert 真砍」属 ui-offline，不在本次范围）。非 Daemon 自 no-op。
            DaemonCheckpointService.ensure_daemon_snapshot_hash(session)
            rewind_outcome = DaemonCheckpointService.maybe_file_history_rewind(
                session.thread_id, rewind_anchor_id or '',
            )
            file_restore_host = rewind_outcome.host
            if rewind_outcome.host == 'daemon':
                file_restore_success = rewind_outcome.success
                failed_files = list(rewind_outcome.failed_files)
                if not rewind_anchor_id:
                    file_restore_status = 'not_applicable'
                    file_restore_reason = 'no_file_anchor'
                elif rewind_outcome.success:
                    file_restore_status = 'success'
                    file_restore_reason = None
                else:
                    file_restore_status = 'failed'
                    file_restore_reason = rewind_outcome.skip_reason or 'daemon_restore_failed'
                    file_restore_failure_reason = file_restore_reason
                if not rewind_outcome.success:
                    try:
                        from apps.services.common.chat_stream_publisher import ChatStreamPublisher
                        failed_n = len(rewind_outcome.failed_files)
                        notice = (
                            f"文件恢复失败：{failed_n} 个文件未能回退到目标状态，请手动检查"
                            if failed_n else
                            "文件恢复失败，Daemon 上的文件可能未回退到目标状态，请手动检查"
                        )
                        ChatStreamPublisher.publish_system_notice(session.thread_id, notice)
                    except Exception:
                        logger.warning("rollback_session: failed to publish system notice", exc_info=True)
        except Exception:
            # ensure_daemon_snapshot_hash / maybe_file_history_rewind 均自吞异常，
            # 这里基本是死路防御；保守标文件层失败、不擅自改 host（默认 local 让前端兜底）。
            file_restore_success = False
            file_restore_status = 'failed'
            file_restore_reason = 'daemon_restore_failed'
            logger.debug("[DaemonCheckpoint] rollback file_history_rewind failed", exc_info=True)

    file_restore_finalize_required = bool(
        data.rollback_contract_version >= 2
        and data.mode == 'editAndResend'
        and data.defer_local_file_restore_finalize
        and file_restore_host == 'local'
        and rewind_anchor_id
        and not getattr(runtime_file_restore_result, 'file_restore_coordinated', False)
    )
    if file_restore_finalize_required:
        # Electron Host 尚未写盘；这里必须诚实保持 pending，不能让其他端/审计
        # 在真实本机 CAS 前看到 workspace_files=success。
        file_restore_success = False
        file_restore_status = 'pending'
        file_restore_reason = 'awaiting_local_file_restore_finalize'
        failed_files = []

    # ──  对话回退：transcript 截断 + 宿主分流（与 file_history_rewind 同栈）──
    # 远端 Daemon 宿主：后端 dispatch session_transcript_truncate 让 daemon 在远端
    # messages.jsonl 写 rewind 软标记（物理截断推迟到发下一条消息的 commitRewind）；
    # 否则遥控回退后 daemon 那份 transcript 不会被截，下一轮上下文仍含被回退轮次。
    # Electron 本地宿主：transcript 在本机，前端经 IPC rollback-transcript 写软标记，
    # 后端不碰（host='local' 时本调用 no-op）。
    # 截断边界：优先 target_message_id（流式 assistant 落盘 id === ChatMessage.id），
    # 内容/出现序号仅作为 legacy transcript fallback。由移动端控制接口协调的回退
    # 已在写 DB 前获得真实 runtime 确认，此处不能重复写同一个 rewind boundary。
    if session.thread_id and not getattr(request, '_runtime_rewind_coordinated', False):
        rewind_params = _build_transcript_rewind_params(session, target_msg)
        try:
            from apps.services.agent_engine.services.daemon_checkpoint_service import DaemonCheckpointService
            transcript_outcome = DaemonCheckpointService.maybe_session_transcript_truncate(
                session.thread_id,
                state_index,
                target_message_id=rewind_params['target_message_id'],
                target_role=rewind_params['target_role'],
                target_content=rewind_params.get('target_content'),
                target_occurrence_index=rewind_params.get('target_occurrence_index'),
                mode=rewind_params['mode'],
            )
            # fail-visible：dispatch 失败（success=False）或 daemon 锚不中未截断
            # （applied=False）都明确告知——否则下一轮 daemon 上下文仍含被回退内容。
            if transcript_outcome.host == 'daemon' and (
                not transcript_outcome.success or transcript_outcome.applied is False
            ):
                try:
                    from apps.services.common.chat_stream_publisher import ChatStreamPublisher
                    ChatStreamPublisher.publish_system_notice(
                        session.thread_id,
                        "对话上下文回退未完全生效：Daemon 远端会话记录可能未截断，"
                        "下一轮可能仍包含被回退内容，请重试",
                    )
                except Exception:
                    logger.warning("rollback_session: failed to publish transcript notice", exc_info=True)
        except Exception:
            logger.debug("[DaemonCheckpoint] rollback session_transcript_truncate failed", exc_info=True)

    apply_result = 'partial_success' if file_restore_finalize_required else _resolve_apply_result(
        file_restore_success=file_restore_success,
    )
    partial_success_details = None if file_restore_finalize_required else _build_partial_success_details(
        file_restore_success=file_restore_success,
        file_restore_status=file_restore_status,
        file_restore_failure_reason=file_restore_failure_reason,
    )
    try:
        session = ChatSession.objects.get(id=session_id, user=request.auth)
        if _update_history_entry_by_apply_id(session, history_apply_id, {
            'apply_result': apply_result,
            'partial_success_details': partial_success_details,
            'file_restore_status': file_restore_status,
            'file_restore_reason': file_restore_reason,
            'failed_files': failed_files,
            'file_restore_finalize_required': file_restore_finalize_required,
            'file_restore_finalize_expires_at': (
                requested_finalize_expiry if file_restore_finalize_required else None
            ),
        }):
            session.save(update_fields=['revert_history', 'updated_at'])
    except Exception:
        logger.warning("rollback_session: failed to persist apply_result", exc_info=True)

    refreshed_session = ChatSession.objects.filter(id=session_id, user=request.auth).first() or session
    checkpoint_record = (
        _build_checkpoint_record(
            anchor_message,
            space_checkpoint=_get_space_checkpoint_summary(refreshed_session, checkpoint_hash),
            messages_to_remove=truncated_count,
            compact=False,
        )
        if anchor_message else None
    )
    apply_result_view = _build_rollback_apply_result(
        apply_id=history_apply_id,
        session=refreshed_session,
        overall_status=apply_result,
        checkpoint_record=checkpoint_record,
        file_restore_success=file_restore_success,
        file_restore_status=file_restore_status,
        file_restore_failure_reason=file_restore_failure_reason,
    )

    try:
        summary_parts = []
        if truncated_count > 0:
            summary_parts.append(_("chat.system_rollback_msgs", count=truncated_count, default=f"回退了 {truncated_count} 条消息"))
        # Daemon 宿主或移动端已确认的 Electron 控制设备，文件层均已在本响应前
        # 得到真实结果；普通 Electron renderer 发起的回退仍由前端后续执行，不在此误报。
        if file_restore_host == 'daemon' or getattr(runtime_file_restore_result, 'file_restore_coordinated', False):
            if file_restore_status == 'not_applicable':
                summary_parts.append(_(
                    "chat.system_rollback_files_not_applicable",
                    default="未发现可恢复的文件版本",
                ))
            elif file_restore_success:
                summary_parts.append(_("chat.system_rollback_files_ok", default="文件已恢复"))
            else:
                summary_parts.append(_("chat.system_rollback_files_issue", default="文件恢复待确认"))
        system_content = _("chat.system_rollback_complete", default="回退完成") + (" — " + "，".join(summary_parts) if summary_parts else "")
        # W3 §3.3.1：content 字段已 drop —— system 消息走 text_summary +
        # content_blocks_json 单 text block 形态
        # W1b：显式 message_kind='llm' 防 model default 漂移（system 提示气泡按 LLM 语义，非协议层 tool_artifact 产物）
        if data.mode != 'editAndResend':
            ChatMessage.objects.create(
                session_id=session_id,
                role='system',
                message_kind='llm',
                text_summary=system_content[:200],
                content_blocks_json=[{'type': 'text', 'text': system_content}] if system_content else [],
            )
    except Exception:
        logger.warning("rollback_session: failed to create system message", exc_info=True)

    #  全端收敛：广播 rollback 给所有订阅 agent.stream.{thread} 的端（其他设备 /
    # 窗口），让各端统一截断本地消息时间线——不再要刷新才同步。携带 target_message_id +
    # target_role，客户端据此镜像 _build_revert_visible_message_filter 的可见性裁剪。
    if refreshed_session.thread_id:
        try:
            from apps.services.common.chat_stream_publisher import ChatStreamPublisher
            from apps.services.common.agent_protocol.constants import AgentStreamEvent
            ChatStreamPublisher.publish_ws(
                refreshed_session.thread_id,
                AgentStreamEvent.ROLLBACK,
                {
                    'session_id': str(session_id),
                    'target_message_id': str(target_msg.id),
                    'target_role': target_msg.role,
                    'keep_message_count': state_index,
                    'mode': data.mode,
                    'revert_at': session.revert_at.isoformat() if session.revert_at else None,
                    # 让观察端同步更新 revert 横幅状态（含 cleanup_status / can_unrevert）。
                    'rollback_state': _build_session_rollback_state(refreshed_session).model_dump(mode='json'),
                },
            )
        except Exception:
            logger.warning("rollback_session: failed to broadcast rollback event", exc_info=True)

    return success_response(data=RollbackResponse(
        success=True,
        mode=data.mode,
        checkpoint_hash=checkpoint_hash,
        truncated_message_count=truncated_count,
        file_restore_success=file_restore_success,
        file_restore_status=file_restore_status,
        file_restore_reason=file_restore_reason,
        failed_files=failed_files,
        file_restore_host=file_restore_host,
        overall_status=apply_result,
        rollback_state=_build_session_rollback_state(refreshed_session),
        checkpoint_record=checkpoint_record,
        apply_result=apply_result_view,
        partial_success_details=partial_success_details,
        file_restore_finalize_required=file_restore_finalize_required,
        file_restore_finalize_expires_at=(
            requested_finalize_expiry if file_restore_finalize_required else None
        ),
        message=_("chat.rollback_marked", count=truncated_count),
    ).model_dump(mode='json'))


def _file_restore_finalize_hash(data: FileRestoreFinalizeRequest) -> str:
    payload = data.model_dump(mode='json', exclude={'apply_id'})
    encoded = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    return hashlib.sha256(encoded).hexdigest()


@router.post(
    "/sessions/{session_id}/rollback/files/finalize",
    auth=jwt_auth,
    response=_CHECKPOINT_ROUTE_RESPONSES,
    tags=["检查点管理"],
)
@transaction.atomic
def finalize_local_file_restore(request, session_id: str, data: FileRestoreFinalizeRequest):
    """确认 v2 Electron Host 本机文件 CAS 的真实结果。

    初次 ``/rollback`` 已落会话投影但把文件层保持 pending。本接口只允许
    对同一 apply/revision 精确完成一次；完全相同的网络重试幂等返回，任何不同
    结果都在更新历史前 409。
    """
    session = ChatSession.objects.select_for_update().filter(
        id=session_id,
        user=request.auth,
    ).first()
    if not session:
        return error_response_with_status('NOT_FOUND', message=_("chat.session_not_found"), status_code=404)

    # 先结算过期租约；旧 Host 在租约后到达时必须明确被拒，不能覆盖之后的操作。
    get_pending_file_restore_apply(session)
    history = list(session.revert_history or [])
    entry = next((item for item in reversed(history) if item.get('apply_id') == data.apply_id), None)
    if not entry or entry.get('type') != 'rollback':
        return error_response_with_status(
            'ROLLBACK_APPLY_NOT_FOUND',
            message=_('chat.rollback_apply_not_found', default='找不到待确认的文件回退操作'),
            status_code=409,
        )
    if entry.get('file_restore_finalize_expired_at'):
        return error_response_with_status(
            'FILE_RESTORE_FINALIZE_EXPIRED',
            message=_(
                'chat.file_restore_finalize_expired',
                default='工作区文件确认已过期，请重新检查当前状态',
            ),
            status_code=409,
        )
    latest_rollback = next(
        (item for item in reversed(history) if item.get('type') == 'rollback'),
        None,
    )
    if (
        latest_rollback is None
        or latest_rollback.get('apply_id') != data.apply_id
        or str(session.revert_message_id or '') != str(entry.get('target_message_id') or '')
    ):
        return error_response_with_status(
            'ROLLBACK_OPERATION_STALE',
            message=_(
                'chat.rollback_operation_stale',
                default='这次编辑重发已失效，请重新开始',
            ),
            status_code=409,
        )
    if (
        entry.get('rollback_contract_version') != data.rollback_contract_version
        or entry.get('preview_revision') != data.preview_revision
        or entry.get('file_preview_revision') != data.file_preview_revision
    ):
        return error_response_with_status(
            'ROLLBACK_PREVIEW_STALE',
            message=_('chat.rollback_preview_stale', default='回退预览已变化，请重新检查'),
            status_code=409,
        )

    result_hash = _file_restore_finalize_hash(data)
    previous_hash = entry.get('file_restore_finalize_hash')
    if previous_hash:
        if previous_hash != result_hash:
            return error_response_with_status(
                'FILE_RESTORE_FINALIZE_CONFLICT',
                message=_('chat.file_restore_finalize_conflict', default='文件回退结果已经确认，不能再次修改'),
                status_code=409,
            )
    elif not entry.get('file_restore_finalize_required') or entry.get('file_restore_status') != 'pending':
        return error_response_with_status(
            'FILE_RESTORE_FINALIZE_NOT_PENDING',
            message=_('chat.file_restore_finalize_not_pending', default='当前操作不等待文件回退结果'),
            status_code=409,
        )

    file_restore_success = data.file_restore_status in {'success', 'not_applicable'}
    file_restore_failure_reason = data.file_restore_reason or (
        'local_file_restore_failed' if not file_restore_success else 'no_file_changes'
    )
    overall_status = _resolve_apply_result(file_restore_success=file_restore_success)
    partial_success_details = _build_partial_success_details(
        file_restore_success=file_restore_success,
        file_restore_status=data.file_restore_status,
        file_restore_failure_reason=file_restore_failure_reason,
    )

    if not previous_hash:
        entry.update({
            'file_restore_status': data.file_restore_status,
            'file_restore_reason': data.file_restore_reason,
            'failed_files': list(data.failed_files),
            'unrestorable_files': [item.model_dump(mode='json') for item in data.unrestorable_files],
            'file_restore_finalize_required': False,
            'file_restore_reconfirmation_required': False,
            'file_restore_finalize_hash': result_hash,
            'file_restore_finalized_at': timezone.now().isoformat(),
            'apply_result': overall_status,
            'partial_success_details': partial_success_details,
        })
        session.revert_history = history
        session.save(update_fields=['revert_history', 'updated_at'])

    apply_result_view = _build_rollback_apply_result(
        apply_id=data.apply_id,
        session=session,
        overall_status=overall_status,
        file_restore_success=file_restore_success,
        file_restore_status=data.file_restore_status,
        file_restore_failure_reason=file_restore_failure_reason,
    )
    return success_response(data=FileRestoreFinalizeResponse(
        apply_id=data.apply_id,
        file_restore_success=file_restore_success,
        file_restore_status=data.file_restore_status,
        file_restore_reason=data.file_restore_reason,
        failed_files=data.failed_files,
        unrestorable_files=data.unrestorable_files,
        overall_status=overall_status,
        rollback_state=_build_session_rollback_state(session),
        apply_result=apply_result_view,
    ).model_dump(mode='json'))


@router.post(
    "/sessions/{session_id}/rollback/resources",
    auth=jwt_auth,
    response=_CHECKPOINT_ROUTE_RESPONSES,
    tags=["检查点管理"],
)
@transaction.atomic(using=postgres_app_db_alias())
@transaction.atomic
def rollback_resources(request, session_id: str, data: ResourceRestoreRequest):
    """
    执行资源恢复 — 根据回退计划恢复各结构化资源到指定版本。

    在 rollback_session（聊天+文件回退）完成后调用，
    将 Agent 操作影响的文档、数据表、设计稿等恢复到 Agent 操作前的版本。
    """
    session = ChatSession.objects.select_for_update().filter(
        id=session_id, user=request.auth
    ).first()
    if not session:
        return error_response_with_status(
            "NOT_FOUND", message=_("chat.session_not_found"), status_code=404,
        )

    pending_error = _reject_pending_file_restore(session)
    if pending_error is not None:
        return pending_error

    if not session.revert_message_id:
        return error_response_with_status(
            "VALIDATION_ERROR", message=_("chat.session_not_reverted"), status_code=400,
        )

    _lock_v2_resource_rows(data)
    preview_error = _validate_resource_restore_preview(session=session, data=data)
    if preview_error is not None:
        return preview_error

    from apps.collab.registry import get_adapter
    from apps.collab.service import VersionHistoryService

    allowed_resources = _get_allowed_rollback_resources(session)

    editor_info = {
        "editor_type": "system",
        "editor_id": f"rewind:{session_id}",
        "editor_name": "Agent Rewind",
    }

    pre_rollback_map: dict[tuple[str, str], dict] = {}
    requested_items_by_key: dict[tuple[str, str], dict] = {}

    for item in data.items:
        if item.action == 'skip':
            continue
        requested_items_by_key[(item.resource_type, item.resource_id)] = {
            'resource_type': item.resource_type,
            'resource_id': item.resource_id,
            'action': item.action,
            'restore_to_version_id': item.restore_to_version_id,
        }
        pre_rollback_map[(item.resource_type, item.resource_id)] = {
            'resource_type': item.resource_type,
            'resource_id': item.resource_id,
            'action': item.action,
            'restore_to_version_id': item.restore_to_version_id,
            'pre_version_id': None,
            'success': None,
        }

    results: list[dict] = []
    restored = 0
    failed = 0
    collab_sync_warnings: list[dict[str, str]] = []

    for item in data.items:
        rtype = item.resource_type
        rid = item.resource_id
        action = item.action

        if action == 'skip':
            continue

        if allowed_resources is not None and (rtype, rid) not in allowed_resources:
            results.append(ResourceRestoreResult(
                resource_type=rtype,
                resource_id=rid,
                success=False,
                error='资源不在本次回退范围内',
            ).model_dump())
            failed += 1
            continue

        if action == 'trash':
            adapter = get_adapter(rtype)
            if adapter:
                resource = adapter.get_resource_for_rollback(rid)
                if resource and not adapter.check_permission(request.auth, resource, "edit"):
                    logger.error("rollback_resources: permission denied for trash %s:%s user=%s", rtype, rid, request.auth.id)
                    results.append(ResourceRestoreResult(
                        resource_type=rtype,
                        resource_id=rid,
                        success=False,
                        error='无编辑权限',
                    ).model_dump())
                    failed += 1
                    continue

            ok = _trash_resource(rtype, rid, editor_id=editor_info['editor_id'])
            results.append(ResourceRestoreResult(
                resource_type=rtype,
                resource_id=rid,
                success=ok,
                error='' if ok else '移入回收站失败',
            ).model_dump())
            if ok:
                restored += 1
                from apps.collab.api import _force_close_collab_document
                fc_result = _force_close_collab_document(rtype, rid)
                if not fc_result["success"]:
                    logger.warning(
                        "rollback_resources: force_close failed after trash for %s:%s",
                        rtype, rid,
                    )
                    collab_sync_warnings.append({
                        'resource': f'{rtype}:{rid}',
                        'warning': 'force_close_failed',
                    })
            else:
                failed += 1
            continue

        if action == 'restore_version':
            if not item.restore_to_version_id:
                results.append(ResourceRestoreResult(
                    resource_type=rtype,
                    resource_id=rid,
                    success=False,
                    error='缺少目标版本 ID',
                ).model_dump())
                failed += 1
                continue

            adapter = get_adapter(rtype)
            if not adapter:
                results.append(ResourceRestoreResult(
                    resource_type=rtype,
                    resource_id=rid,
                    success=False,
                    error=f'不支持的资源类型: {rtype}',
                ).model_dump())
                failed += 1
                continue

            resource = adapter.get_resource_for_rollback(rid)
            if resource and not adapter.check_permission(request.auth, resource, "edit"):
                logger.error("rollback_resources: permission denied for restore %s:%s user=%s", rtype, rid, request.auth.id)
                results.append(ResourceRestoreResult(
                    resource_type=rtype,
                    resource_id=rid,
                    success=False,
                    error='无编辑权限',
                ).model_dump())
                failed += 1
                continue

            try:
                if resource is None:
                    results.append(ResourceRestoreResult(
                        resource_type=rtype,
                        resource_id=rid,
                        success=False,
                        error='资源不存在',
                    ).model_dump())
                    failed += 1
                    continue

                baseline_vh_id = _capture_unrevert_baseline_version(
                    adapter=adapter,
                    resource=resource,
                    session_id=str(session_id),
                )
                pre_rollback_map[(rtype, rid)]['pre_version_id'] = baseline_vh_id

                svc = VersionHistoryService(adapter)
                from uuid import UUID
                vh = svc.restore_to_version(
                    resource_id=UUID(rid),
                    version_id=UUID(item.restore_to_version_id),
                    editor_info=editor_info,
                )
                if vh:
                    results.append(ResourceRestoreResult(
                        resource_type=rtype,
                        resource_id=rid,
                        success=True,
                    ).model_dump())
                    restored += 1
                    from apps.collab.api import _force_close_collab_document
                    fc_result = _force_close_collab_document(rtype, rid, reason="document_restored")
                    if not fc_result["success"]:
                        logger.warning(
                            "rollback_resources: force_close failed after restore for %s:%s",
                            rtype, rid,
                        )
                        collab_sync_warnings.append({
                            'resource': f'{rtype}:{rid}',
                            'warning': 'force_close_failed',
                        })
                else:
                    results.append(ResourceRestoreResult(
                        resource_type=rtype,
                        resource_id=rid,
                        success=False,
                        error='版本恢复失败：版本不存在或数据无法重建',
                    ).model_dump())
                    failed += 1
            except Exception as e:
                logger.warning(
                    "rollback_resources: restore failed for %s:%s", rtype, rid,
                    exc_info=True,
                )
                results.append(ResourceRestoreResult(
                    resource_type=rtype,
                    resource_id=rid,
                    success=False,
                    error=str(e)[:200],
                ).model_dump())
                failed += 1
            continue

        results.append(ResourceRestoreResult(
            resource_type=rtype,
            resource_id=rid,
            success=False,
            error=f'未知操作: {action}',
        ).model_dump())
        failed += 1

    for r in results:
        key = (r['resource_type'], r['resource_id'])
        if key in pre_rollback_map:
            pre_rollback_map[key]['success'] = r.get('success', False)
            if not r.get('success'):
                pre_rollback_map[key]['error'] = r.get('error', '')[:200]
    pre_rollback_state: list[dict] = list(pre_rollback_map.values())

    retryable_items = [
        {
            **requested_items_by_key.get(
                (r['resource_type'], r['resource_id']),
                {
                    'resource_type': r['resource_type'],
                    'resource_id': r['resource_id'],
                    'action': None,
                    'restore_to_version_id': None,
                },
            ),
        }
        for r in results
        if not r.get('success')
    ]
    apply_result = _resolve_apply_result(
        file_restore_success=True,
        failed_count=failed,
    )
    partial_success_details = _build_partial_success_details(
        restored_count=restored,
        failed_count=failed,
        retryable_items=retryable_items,
        collab_sync_warnings=collab_sync_warnings,
    )
    effective_state: list[dict] = []
    state_persist_failed = False
    if pre_rollback_state:
        succeeded_keys = {
            (r['resource_type'], r['resource_id'])
            for r in results if r.get('success')
        }
        effective_state = [
            entry for entry in pre_rollback_state
            if (entry['resource_type'], entry['resource_id']) in succeeded_keys
        ]
        from django.db import transaction as txn
        try:
            with txn.atomic():
                session_obj = ChatSession.objects.select_for_update().filter(id=session_id, user=request.auth).first()
                if session_obj:
                    update_fields = ['revert_history', 'updated_at']
                    if effective_state:
                        session_obj.revert_resource_state = effective_state
                        update_fields.insert(0, 'revert_resource_state')
                    reapply_resource_items = _build_reapply_resource_items(effective_state)
                    _append_revert_history(session_obj, {
                        'type': 'resource_rollback',
                        'apply_id': f"resource_rollback:{session_id}:{timezone.now().isoformat()}",
                        'restored_count': restored,
                        'failed_count': failed,
                        'resources': [
                            {'resource_type': r['resource_type'], 'resource_id': r['resource_id'], 'success': r.get('success', False)}
                            for r in results
                        ],
                        'reapply_resource_items': reapply_resource_items,
                        'apply_result': apply_result,
                        'partial_success_details': partial_success_details,
                        'created_at': timezone.now().isoformat(),
                    })
                    session_obj.save(update_fields=update_fields)
        except Exception:
            state_persist_failed = True
            effective_state = []
            collab_sync_warnings.append({
                'resource': f'session:{session_id}',
                'warning': 'revert_state_persist_failed',
            })
            logger.warning("rollback_resources: failed to save pre_rollback_state", exc_info=True)

    logger.info("rollback_resources: session=%s user=%s restored=%d failed=%d items=%d",
                session_id, request.auth.id, restored, failed, len(data.items))

    _publish_resource_rollback_notice(session, results, requested_items_by_key, restored)

    aggregate_apply_result = apply_result
    aggregate_partial_success_details = partial_success_details
    aggregate_file_restore_success = True
    try:
        session_obj = ChatSession.objects.filter(id=session_id, user=request.auth).first()
        if session_obj:
            history = list(session_obj.revert_history or [])
            for entry in reversed(history):
                if entry.get('type') == 'rollback':
                    aggregate_apply_result, aggregate_partial_success_details, aggregate_file_restore_success = (
                        _merge_rollback_apply_state(
                            previous_apply_result=entry.get('apply_result'),
                            previous_partial_success_details=entry.get('partial_success_details'),
                            current_apply_result=apply_result,
                            current_partial_success_details=partial_success_details,
                        )
                    )
                    entry['apply_result'] = aggregate_apply_result
                    entry['partial_success_details'] = aggregate_partial_success_details
                    if (
                        data.rollback_contract_version >= 2
                        and entry.get('mode') == 'editAndResend'
                        and entry.get('preview_revision') == data.preview_revision
                    ):
                        entry['resource_restore_status'] = 'completed'
                        entry['resource_restore_result'] = {
                            'restored_count': restored,
                            'failed_count': failed,
                            'skipped_count': len([item for item in data.items if item.action == 'skip']),
                        }
                    break
            session_obj.revert_history = history
            session_obj.save(update_fields=['revert_history', 'updated_at'])
            session = session_obj
    except Exception:
        logger.warning("rollback_resources: failed to persist apply_result", exc_info=True)

    if state_persist_failed:
        aggregate_apply_result = (
            'failed' if failed >= len([i for i in data.items if i.action != 'skip']) else 'partial_success'
        )
        aggregate_partial_success_details = aggregate_partial_success_details or {}
        resources_detail = aggregate_partial_success_details.setdefault('resources', {})
        resources_detail['collab_sync_warnings'] = collab_sync_warnings

    apply_result_view = _build_rollback_apply_result(
        apply_id=f"rollback_resources:{session_id}:{timezone.now().isoformat()}",
        session=session,
        overall_status=aggregate_apply_result,
        file_restore_success=aggregate_file_restore_success,
        restored_count=restored,
        failed_count=failed,
        retryable_items=retryable_items,
        collab_sync_warnings=collab_sync_warnings,
    )

    compensation_available = any(
        entry.get('success') and (entry.get('pre_version_id') or entry.get('action') == 'trash')
        for entry in pre_rollback_state
    ) and not state_persist_failed

    return success_response(data=ResourceRestoreResponse(
        success=failed == 0,
        results=results,
        restored_count=restored,
        failed_count=failed,
        overall_status=aggregate_apply_result,
        compensation_available=compensation_available,
        partial_success_details=aggregate_partial_success_details,
        collab_sync_warnings=collab_sync_warnings,
        rollback_state=_build_session_rollback_state(session),
        apply_result=apply_result_view,
    ).model_dump(mode='json'))


def _capture_unrevert_baseline_version(*, adapter, resource, session_id: str) -> str:
    """
    Create an authoritative point-in-time snapshot for unrevert.

    Referencing "latest VersionHistory" is not enough: it may be older than the
    visible resource state or may predate metadata fields such as TabDoc titles.
    """
    from uuid import UUID

    from apps.collab.service import VersionHistoryService

    resource_id = UUID(str(resource.id))
    snapshot_data = adapter.get_version_data(resource)
    extra_metadata: dict = {}
    if getattr(adapter, "resource_type", "") == "docs" and isinstance(snapshot_data, bytes):
        extra_metadata["tabdoc_title"] = getattr(resource, "title", "")
    svc = VersionHistoryService(adapter)
    vh = svc.create_history(
        resource_id=resource_id,
        data=snapshot_data,
        editor_info={
            "editor_type": "system",
            "editor_id": f"unrevert-baseline:{session_id}",
            "editor_name": "Agent Rewind Baseline",
        },
        force_snapshot=True,
        organization_id=getattr(resource, "organization_id", None),
        skip_throttle=True,
        extra_metadata=extra_metadata,
    )
    if not vh:
        raise RuntimeError("failed to create unrevert baseline version")
    return str(vh.id)


def _build_reapply_resource_items(resource_state: list[dict] | None) -> list[dict]:
    """Build a reusable resource rollback plan from the successful rollback state."""
    items: list[dict] = []
    for entry in resource_state or []:
        action = entry.get('action')
        if action not in ('restore_version', 'trash'):
            continue
        if not entry.get('resource_type') or not entry.get('resource_id'):
            continue
        items.append({
            'resource_type': entry['resource_type'],
            'resource_id': entry['resource_id'],
            'action': action,
            'restore_to_version_id': entry.get('restore_to_version_id'),
        })
    return items


def _get_allowed_rollback_resources(session: "ChatSession") -> set[tuple[str, str]] | None:
    """根据 session 的回退范围，计算允许操作的资源 (resource_type, resource_id) 集合。
    返回 None 表示非回退 session（revert_message_id 为空）。"""
    if not session.revert_message_id:
        return None
    try:
        target_msg = session.messages.filter(id=session.revert_message_id).first()
        if not target_msg:
            logger.warning("_get_allowed_rollback_resources: target message %s not found, denying all", session.revert_message_id)
            return set()

        from ..services.conversation_time import q_conversation_after
        msgs_after = session.messages.filter(
            q_conversation_after(
                target_msg,
                include_target=target_msg.role == 'user',
            ),
        ).values_list('agent_run_id', flat=True)
        run_ids = {rid for rid in msgs_after if rid}

        if not run_ids:
            return set()

        try:
            from apps.collab.api import _resolve_cascading_run_ids
            expanded = set()
            for rid in run_ids:
                expanded.update(_resolve_cascading_run_ids(rid))
            run_ids = expanded
        except Exception:
            pass

        from apps.collab.models import ChangeLog
        cl_entries = ChangeLog.objects.using(postgres_app_db_alias()).filter(
            agent_run_id__in=list(run_ids)
        ).values_list('resource_type', 'resource_id')
        return {(rt, str(rid)) for rt, rid in cl_entries}
    except Exception:
        logger.warning("_get_allowed_rollback_resources: query failed, denying all resources", exc_info=True)
        return set()


def _append_revert_history(session: "ChatSession", entry: dict, max_entries: int = REVERT_HISTORY_MAX_ENTRIES) -> None:
    """向 session.revert_history 追加一条记录，保留最近 max_entries 条。"""
    session.append_revert_history(entry, max_entries=max_entries)


def _update_history_entry_by_apply_id(session: "ChatSession", apply_id: str, updates: dict) -> bool:
    """从 revert_history 末尾反向查找 apply_id 匹配的条目并更新，返回是否找到。

    仅修改 session.revert_history 内存数据，不调用 save()。
    """
    history = list(session.revert_history or [])
    for entry in reversed(history):
        if entry.get('apply_id') == apply_id:
            entry.update(updates)
            session.revert_history = history
            return True
    return False


def _build_partial_success_details(
    *,
    file_restore_success: bool = True,
    file_restore_status: Optional[str] = None,
    file_restore_failure_reason: str = 'daemon_restore_failed',
    restored_count: int = 0,
    failed_count: int = 0,
    retryable_items: Optional[list[dict]] = None,
    collab_sync_warnings: Optional[list[dict]] = None,
) -> Optional[dict]:
    """根据文件/资源层结果拼最小 partial_success_details。

    ``status`` 是可加性扩展，用于区分部分恢复与完全失败；已发布客户端仍读取
    ``success``，因此两者必须同时输出，不能把旧字段从原始历史字典中删掉。
    """
    details: dict = {}
    if not file_restore_success:
        details["workspace_files"] = {
            "success": False,
            "status": "partial_success" if file_restore_status == 'partial' else "failed",
            "reason": file_restore_failure_reason,
        }
    if failed_count > 0 or retryable_items or collab_sync_warnings:
        details["resources"] = {
            "restored_count": restored_count,
            "failed_count": failed_count,
            "retryable": retryable_items or [],
            "collab_sync_warnings": collab_sync_warnings or [],
        }
    return details or None


def _resolve_apply_result(
    *,
    file_restore_success: bool = True,
    failed_count: int = 0,
) -> str:
    if not file_restore_success or failed_count > 0:
        return 'partial_success'
    return 'success'


def _merge_rollback_apply_state(
    *,
    previous_apply_result: Optional[str],
    previous_partial_success_details: Optional[dict],
    current_apply_result: str,
    current_partial_success_details: Optional[dict],
) -> tuple[str, Optional[dict], bool]:
    """合并 rollback 与后续 resource rollback 的聚合状态。

    rollback/resources 不会重新执行文件恢复，因此若首次 rollback 已记录
    workspace_files 失败，后续资源层成功时也不能把该失败状态覆盖掉。
    资源层细节则以当前一次 restoreResources 的结果为准。
    """
    previous_details = previous_partial_success_details or {}
    current_details = current_partial_success_details or {}
    workspace_files = previous_details.get('workspace_files')
    resources = current_details.get('resources')

    merged_details: dict = {}
    if workspace_files:
        merged_details['workspace_files'] = workspace_files
    if resources:
        merged_details['resources'] = resources

    if previous_apply_result == 'failed' or current_apply_result == 'failed':
        overall_status = 'failed'
    elif workspace_files or current_apply_result == 'partial_success':
        overall_status = 'partial_success'
    else:
        overall_status = 'success'

    return overall_status, (merged_details or None), not bool(workspace_files)


def _load_resource_model(resource_type: str):
    """根据 resource_type 加载对应 Django Model 类，找不到返回 None。"""
    model_map = _get_resource_model_map()
    mapping = model_map.get(resource_type)
    if not mapping:
        return None
    try:
        from importlib import import_module
        mod_path, cls_name = mapping[0].rsplit('.', 1)
        return getattr(import_module(mod_path), cls_name)
    except Exception:
        logger.warning("_load_resource_model: failed to load %s", resource_type, exc_info=True)
        return None


def _trash_resource(resource_type: str, resource_id: str, editor_id: str = "") -> bool:
    """将 Agent 创建的资源移入回收站，使用 TrashableModelMixin.trash() 以正确处理 status/previous_status。"""
    from django.db import transaction

    model_cls = _load_resource_model(resource_type)
    if not model_cls:
        return False

    try:
        with transaction.atomic(using=postgres_app_db_alias()):
            obj = model_cls.objects.using(postgres_app_db_alias()).select_for_update().filter(
                id=resource_id,
                trashed_at__isnull=True,
            ).first()
            if not obj:
                return False

            if hasattr(obj, 'trash'):
                obj.trash(user_id=editor_id or None, save=True)
            else:
                from django.utils import timezone as tz
                obj.trashed_at = tz.now()
                if editor_id:
                    obj.trashed_by = editor_id
                if hasattr(obj, 'status'):
                    obj.previous_status = getattr(obj, 'status', '') or ''
                    obj.status = 'trashed'
                update_fields = ['trashed_at', 'trashed_by']
                if hasattr(obj, 'status'):
                    update_fields += ['status', 'previous_status']
                if hasattr(obj, 'updated_at'):
                    update_fields.append('updated_at')
                obj.save(update_fields=update_fields)
        return True
    except Exception:
        logger.warning("_trash_resource: failed for %s:%s", resource_type, resource_id, exc_info=True)
        return False


@router.post(
    "/sessions/{session_id}/unrevert",
    auth=jwt_auth,
    response=_CHECKPOINT_ROUTE_RESPONSES,
    tags=["检查点管理"],
)
def unrevert_session(request, session_id: str):
    """
    撤销回滚 — 清除 session 的 revert 标记，返回回滚前的 snapshot_hash
    让前端恢复文件到回滚前状态。同时反向恢复被回退的资源。
    """
    from django.db import transaction

    with transaction.atomic():
        session = ChatSession.objects.select_for_update().filter(
            id=session_id, user=request.auth
        ).first()
        if not session:
            return error_response_with_status("NOT_FOUND", message=_("chat.session_not_found"), status_code=404)

        pending_error = _reject_pending_file_restore(session)
        if pending_error is not None:
            return pending_error

        if not session.revert_message_id:
            return error_response_with_status("VALIDATION_ERROR", message=_("chat.session_not_reverted"), status_code=400)

        snapshot_hash = session.revert_snapshot_hash
        resource_state = session.revert_resource_state

        failed_items: list[dict] = []
        collab_sync_warnings: list[dict[str, str]] = []
        if resource_state:
            try:
                failed_items = _unrevert_resources(
                    resource_state,
                    session_id,
                    collab_sync_warnings=collab_sync_warnings,
                )
            except Exception:
                logger.exception("unrevert_session: resource restore failed, keeping revert mark for retry. session=%s", session_id)
                return error_response_with_status(
                    "INTERNAL_ERROR",
                    message=_("chat.unrevert_resource_failed", default="资源恢复失败，请重试"),
                    status_code=500,
                )

        failed_keys = {
            (item.get('resource_type'), item.get('resource_id'))
            for item in failed_items
        }
        successful_resource_state = [
            entry for entry in (resource_state or [])
            if (entry.get('resource_type'), entry.get('resource_id')) not in failed_keys
        ]
        unrevert_apply_result = 'partial_success' if failed_items else 'success'
        unrevert_partial_details = {
            'resources': {
                'failed_count': len(failed_items),
                'failed_items': failed_items,
            },
        } if failed_items else None
        if collab_sync_warnings:
            unrevert_partial_details = unrevert_partial_details or {'resources': {}}
            unrevert_partial_details['resources']['collab_sync_warnings'] = collab_sync_warnings
        reapply_resource_items = _build_reapply_resource_items(successful_resource_state)

        history_apply_id = f"unrevert:{session_id}:{timezone.now().isoformat()}"
        _append_revert_history(session, {
            'type': 'unrevert',
            'apply_id': history_apply_id,
            'target_message_id': str(session.revert_message_id) if session.revert_message_id else None,
            'snapshot_hash': snapshot_hash,
            'resource_count': len(resource_state) if resource_state else 0,
            'reapply_resource_items': reapply_resource_items,
            'apply_result': unrevert_apply_result,
            'partial_success_details': unrevert_partial_details,
            'created_at': timezone.now().isoformat(),
        })

        update_fields = ['revert_resource_state', 'revert_history', 'updated_at']
        if failed_items:
            session.revert_resource_state = [
                entry for entry in (resource_state or [])
                if (entry.get('resource_type'), entry.get('resource_id')) in failed_keys
            ]
        else:
            session.revert_message_id = None
            session.revert_snapshot_hash = None
            session.revert_state_index = None
            session.revert_at = None
            session.revert_resource_state = None
            update_fields = [
                'revert_message_id',
                'revert_snapshot_hash',
                'revert_state_index',
                'revert_at',
                *update_fields,
            ]
        session.save(update_fields=update_fields)

    # ：撤销回退时同步移除 Daemon 远端 transcript 的 rewind 软标记（事务外做，
    # 避免 WS round-trip 占用 DB 事务）。Electron 本地宿主由前端 IPC unrevert-transcript
    # 负责；daemon clearRewind 无标记时自 no-op，故无条件调用是安全的。
    if session.thread_id:
        try:
            from apps.services.agent_engine.services.daemon_checkpoint_service import DaemonCheckpointService
            DaemonCheckpointService.maybe_session_transcript_unrevert(session.thread_id)
        except Exception:
            logger.debug("[DaemonCheckpoint] unrevert session_transcript_unrevert failed", exc_info=True)

    # CO-2 / ：unrevert 文件层恢复分流：
    #   - Daemon 宿主：shadow-git safety snapshot（revert_snapshot_hash 为 git commit hash）
    #   - Electron 本地宿主：per-file safety anchor（safety_snapshot_ref 以 ``safety:`` 前缀），
    #     由前端 renderer 在 unrevert 前 ``fileHistoryIpc.rewind(safetyRef)`` 还原；
    #     后端此处保持 file_restore_success=False，避免谎称已还原。
    file_restore_success = False
    if snapshot_hash and session.thread_id:
        from apps.services.agent_engine.services.daemon_checkpoint_service import (
            DaemonCheckpointService,
            _resolve_daemon_context,
        )
        _daemon_ctx = _resolve_daemon_context(session.thread_id)
        is_daemon_host = _daemon_ctx is not None and "_skip_reason" not in _daemon_ctx
        if is_daemon_host:
            try:
                restore_ok = DaemonCheckpointService.maybe_checkpoint_restore(
                    session.thread_id, snapshot_hash,
                )
                file_restore_success = bool(restore_ok)
                if not restore_ok:
                    try:
                        from apps.services.common.chat_stream_publisher import ChatStreamPublisher
                        ChatStreamPublisher.publish_system_notice(
                            session.thread_id,
                            "文件恢复失败，Daemon 上的文件可能未恢复到回滚前状态，请手动检查",
                        )
                    except Exception:
                        logger.warning("unrevert_session: failed to publish system notice", exc_info=True)
            except Exception:
                file_restore_success = False
                logger.debug("[DaemonCheckpoint] unrevert checkpoint_restore failed", exc_info=True)
        # else 本地宿主：per-file safety 由前端 renderer 还原；无 safety ref 时
        # file_restore_success 保持 False —— 前端据此走 unrevertPartial 如实告知。

    apply_result = _resolve_apply_result(
        file_restore_success=file_restore_success,
        failed_count=len(failed_items),
    )
    partial_success_details = _build_partial_success_details(
        file_restore_success=file_restore_success,
    )
    if unrevert_partial_details:
        partial_success_details = partial_success_details or {}
        partial_success_details['resources'] = unrevert_partial_details['resources']

    if apply_result != 'success':
        try:
            session = ChatSession.objects.get(id=session_id, user=request.auth)
            if _update_history_entry_by_apply_id(session, history_apply_id, {
                'apply_result': apply_result,
                'partial_success_details': partial_success_details,
            }):
                session.save(update_fields=['revert_history', 'updated_at'])
        except Exception:
            logger.warning("unrevert_session: failed to persist apply_result", exc_info=True)

    logger.info("unrevert_session: session=%s user=%s resources=%d failed=%d",
                session_id, request.auth.id, len(resource_state) if resource_state else 0, len(failed_items))

    checkpoint_record = None
    apply_result_view = _build_rollback_apply_result(
        apply_id=f"unrevert:{session_id}:{timezone.now().isoformat()}",
        session=session,
        overall_status=apply_result,
        checkpoint_record=checkpoint_record,
        file_restore_success=file_restore_success,
        restored_count=len(successful_resource_state),
        failed_count=len(failed_items),
        retryable_items=reapply_resource_items,
        collab_sync_warnings=collab_sync_warnings,
    )

    try:
        if failed_items:
            system_content = _("chat.system_unrevert_resource_partial", default="已恢复部分内容，但仍有资源未恢复到回退前状态")
        elif file_restore_success:
            system_content = _("chat.system_unrevert_complete", default="已恢复到回退前的状态")
        else:
            system_content = _("chat.system_unrevert_partial", default="已恢复原状，但工作区文件可能需要手动确认")
        # W3 §3.3.1：content 字段已 drop —— system 消息走 text_summary +
        # content_blocks_json 单 text block 形态
        # W1b：显式 message_kind='llm' 防 model default 漂移（system 提示气泡按 LLM 语义，非协议层 tool_artifact 产物）
        ChatMessage.objects.create(
            session_id=session_id,
            role='system',
            message_kind='llm',
            text_summary=system_content[:200],
            content_blocks_json=[{'type': 'text', 'text': system_content}] if system_content else [],
        )
    except Exception:
        logger.warning("unrevert_session: failed to create system message", exc_info=True)

    #  全端收敛：广播 unrevert，让所有端恢复显示被回退内容（不再要刷新）。
    if apply_result == 'success' and session.thread_id:
        try:
            from apps.services.common.chat_stream_publisher import ChatStreamPublisher
            from apps.services.common.agent_protocol.constants import AgentStreamEvent
            ChatStreamPublisher.publish_ws(
                session.thread_id,
                AgentStreamEvent.UNREVERT,
                {
                    'session_id': str(session_id),
                    'rollback_state': _build_session_rollback_state(session).model_dump(mode='json'),
                },
            )
        except Exception:
            logger.warning("unrevert_session: failed to broadcast unrevert event", exc_info=True)

    return success_response(data=UnrevertResponse(
        success=apply_result == 'success',
        snapshot_hash=snapshot_hash,
        file_restore_success=file_restore_success,
        overall_status=apply_result,
        rollback_state=_build_session_rollback_state(session),
        checkpoint_record=checkpoint_record,
        apply_result=apply_result_view,
        partial_success_details=partial_success_details or None,
        reapply_resource_items=reapply_resource_items,
        message=_("chat.unrevert_success"),
    ).model_dump(mode='json'))


@router.get(
    "/sessions/{session_id}/revert-history",
    auth=jwt_auth,
    response=_CHECKPOINT_ROUTE_RESPONSES,
    tags=["检查点管理"],
)
def get_revert_history(request, session_id: str):
    """查询会话的回退操作历史。"""
    session = ChatSession.objects.filter(
        id=session_id, user=request.auth
    ).only('revert_history').first()
    if not session:
        return error_response_with_status("NOT_FOUND", message=_("chat.session_not_found"), status_code=404)

    history = [
        RevertHistoryEntryView(**entry).model_dump(mode='json')
        for entry in (session.revert_history or [])
        if entry.get('type') in _DISPLAY_REVERT_TYPES
    ]
    return success_response(data=RevertHistoryResponse(
        history=history,
    ).model_dump(mode='json'))


def _unrevert_resources(
    resource_state: list[dict],
    session_id: str,
    *,
    collab_sync_warnings: list[dict[str, str]] | None = None,
) -> list[dict]:
    """反向恢复被回退的资源到 rollback 前状态。返回失败项列表。"""
    from apps.collab.registry import get_adapter
    from apps.collab.service import VersionHistoryService
    from uuid import UUID

    editor_info = {
        "editor_type": "system",
        "editor_id": f"unrevert:{session_id}",
        "editor_name": "Agent Unrevert",
    }

    failed_items: list[dict] = []

    for entry in resource_state:
        rtype = entry.get('resource_type', '')
        rid = entry.get('resource_id', '')
        action = entry.get('action', '')
        pre_version_id = entry.get('pre_version_id')

        try:
            if action == 'trash':
                if not _untrash_resource(rtype, rid):
                    failed_items.append({
                        'resource_type': rtype,
                        'resource_id': rid,
                        'error': '资源恢复出回收站失败',
                    })
            elif action == 'restore_version' and pre_version_id:
                adapter = get_adapter(rtype)
                if not adapter:
                    failed_items.append({
                        'resource_type': rtype,
                        'resource_id': rid,
                        'error': f'不支持的资源类型: {rtype}',
                    })
                    continue
                svc = VersionHistoryService(adapter)
                vh = svc.restore_to_version(
                    resource_id=UUID(rid),
                    version_id=UUID(pre_version_id),
                    editor_info=editor_info,
                )
                if not vh:
                    failed_items.append({
                        'resource_type': rtype,
                        'resource_id': rid,
                        'error': '版本恢复失败：版本不存在或数据无法重建',
                    })
                    continue
                try:
                    from apps.collab.api import _force_close_collab_document
                    fc_result = _force_close_collab_document(rtype, rid, reason="document_restored")
                    if not fc_result["success"]:
                        if collab_sync_warnings is not None:
                            collab_sync_warnings.append({
                                'resource': f'{rtype}:{rid}',
                                'warning': 'force_close_failed',
                            })
                except Exception as exc:
                    logger.warning(
                        "_unrevert_resources: force_close failed for %s:%s",
                        rtype, rid, exc_info=True,
                    )
                    if collab_sync_warnings is not None:
                        collab_sync_warnings.append({
                            'resource': f'{rtype}:{rid}',
                            'warning': 'force_close_failed',
                        })
            elif action == 'restore_version':
                failed_items.append({
                    'resource_type': rtype,
                    'resource_id': rid,
                    'error': '缺少 rollback 前 baseline 版本 ID',
                })
            else:
                failed_items.append({
                    'resource_type': rtype,
                    'resource_id': rid,
                    'error': f'未知操作: {action}',
                })
        except Exception as exc:
            logger.warning(
                "_unrevert_resources: failed for %s:%s (action=%s)",
                rtype, rid, action, exc_info=True,
            )
            failed_items.append({
                'resource_type': rtype,
                'resource_id': rid,
                'error': str(exc)[:200],
            })

    return failed_items


def _untrash_resource(resource_type: str, resource_id: str) -> bool:
    """将资源从回收站恢复，使用 TrashableModelMixin.restore_from_trash() 以正确恢复 status/previous_status。"""
    from django.db import transaction

    model_cls = _load_resource_model(resource_type)
    if not model_cls:
        return False

    try:
        with transaction.atomic(using=postgres_app_db_alias()):
            obj = model_cls.objects.using(postgres_app_db_alias()).select_for_update().filter(
                id=resource_id,
                trashed_at__isnull=False,
            ).first()
            if not obj:
                return False

            if hasattr(obj, 'restore_from_trash'):
                obj.restore_from_trash(save=True)
            else:
                target_status = getattr(obj, 'previous_status', '') or 'active'
                obj.trashed_at = None
                obj.trashed_by = None
                update_fields = ['trashed_at', 'trashed_by']
                if hasattr(obj, 'status'):
                    obj.status = target_status
                    update_fields.append('status')
                if hasattr(obj, 'previous_status'):
                    obj.previous_status = ''
                    update_fields.append('previous_status')
                if hasattr(obj, 'updated_at'):
                    update_fields.append('updated_at')
                obj.save(update_fields=update_fields)
        return True
    except Exception:
        logger.warning("_untrash_resource: failed for %s:%s", resource_type, resource_id, exc_info=True)
        return False


@router.patch(
    "/messages/{message_id}/checkpoint",
    auth=jwt_auth,
    response=_CHECKPOINT_ROUTE_RESPONSES,
    tags=["检查点管理"],
)
def update_message_checkpoint(request, message_id: str, data: UpdateCheckpointRequest):
    """
    更新消息的检查点数据（前端在 agent run 完成后调用）。
    """
    msg = ChatMessage.objects.select_related('session').filter(id=message_id).first()
    if not msg:
        return error_response_with_status("NOT_FOUND", message=_("chat.message_not_found"), status_code=404)

    if str(msg.session.user_id) != str(request.auth.id):
        return error_response_with_status("FORBIDDEN", message=_("chat.no_permission"), status_code=403)
    if msg.role != 'assistant':
        return error_response_with_status("VALIDATION_ERROR", message=_("chat.checkpoint_assistant_only"), status_code=400)
    if not data.checkpoint_hash or not data.checkpoint_hash.strip():
        return error_response_with_status("VALIDATION_ERROR", message=_("chat.checkpoint_hash_required"), status_code=400)

    resolved_state_index = _resolve_checkpoint_state_index(
        msg.session,
        data.checkpoint_state_index,
    )

    update_fields = []
    if msg.checkpoint_hash != data.checkpoint_hash:
        msg.checkpoint_hash = data.checkpoint_hash
        update_fields.append('checkpoint_hash')

    if (
        resolved_state_index is not None and
        msg.checkpoint_state_index != resolved_state_index
    ):
        msg.checkpoint_state_index = resolved_state_index
        update_fields.append('checkpoint_state_index')

    diff_summary_dict: Optional[dict] = None
    if data.diff_summary is not None:
        diff_summary_dict = data.diff_summary.model_dump()
        if msg.diff_summary != diff_summary_dict:
            msg.diff_summary = diff_summary_dict
            update_fields.append('diff_summary')

    if update_fields:
        update_fields.append('updated_at')
        msg.save(update_fields=update_fields)

    # QC-04 / PE-02: Electron 路径也批量写入 file 级 ChangeLog，
    # 与 Daemon `_persist_checkpoint_hash` 写入口径一致。`changed_files`
    # 从 `diff_summary.files[*].file` 提取（不需要客户端额外传字段），使得
    # `conversation-anchors?resource_type=file&resource_id={UUID5(path)}` 在
    # Electron 驱动的 checkpoint 上也能命中。失败不影响主链路。
    if diff_summary_dict:
        try:
            from apps.collab.services.file_changelog import (
                extract_changed_files_from_diff_summary,
                record_file_changelogs,
            )
            changed_files = extract_changed_files_from_diff_summary(diff_summary_dict)
            if changed_files:
                record_file_changelogs(
                    changed_files=changed_files,
                    diff_summary=diff_summary_dict,
                    commit_hash=data.checkpoint_hash or "",
                    agent_run_id=getattr(msg, "agent_run_id", "") or "",
                    session_id=str(msg.session_id) if msg.session_id else "",
                    log_prefix="[ElectronCheckpoint]",
                )
        except Exception:
            import logging as _logging
            _logging.getLogger(__name__).warning(
                "update_message_checkpoint: file ChangeLog write failed (non-blocking): msg=%s",
                message_id, exc_info=True,
            )

    return success_response(data=UpdateCheckpointResponse(
        message_id=str(msg.id),
        checkpoint_state_index=msg.checkpoint_state_index,
    ).model_dump(mode='json'))
