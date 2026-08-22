"""
Daemon Checkpoint 编排服务

Electron 的 Checkpoint 由 renderer 端自行驱动（用户发消息时 init，Agent 完成时 commit）。
Daemon 无 renderer，需要后端通过 WS action 编排 checkpoint_init / checkpoint_commit / checkpoint_restore。

设计原则：
- 仅对 Daemon 设备 dispatch checkpoint action，Electron 设备由客户端自行管理
- checkpoint_init 采用 fire-and-forget，不阻塞 Agent 启动路径
- checkpoint_commit 在后台线程执行，不阻塞 HTTP 响应返回
- checkpoint 操作失败不阻断 Agent 执行（best-effort）

Checkpoint 触发时机：
- agent_turn_done: Agent Turn 正常完成时创建
- pre_approval: HITL 审批中断前自动创建（审批拒绝后可回滚到此快照）

已知限制（后续可优化）：
- ask_user 场景下未绑定 checkpoint（用户提问不涉及危险操作）
- checkpoint_restore 失败时 rollback/unrevert API 仍返回 success（未向用户暴露文件恢复状态）
- 快速并发消息理论上可能导致 init/commit 交错，但 ChatService 对同 session 有排队机制
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

CHECKPOINT_INIT_TIMEOUT = 10
CHECKPOINT_WRITE_TREE_TIMEOUT = 15
CHECKPOINT_COMMIT_TIMEOUT = 30
CHECKPOINT_DIFF_SUMMARY_TIMEOUT = 15
CHECKPOINT_RESTORE_TIMEOUT = 30

# QC-04 / PRD §4.3.2：file ChangeLog 批量写入实现已抽取到
# ``apps.collab.services.file_changelog``，供本模块（Daemon 路径）与
# ``apps/chat/conversation/api/rollback.update_message_checkpoint``（Electron 路径）
# 共用；此处仅做向后兼容的 re-export，保证既有调用点不中断。
#
# 2026-05-13：新增 ``extract_changed_files_from_diff_summary`` import——daemon
# 端不再返回 ``changed_files`` 数组，本模块改为从 ``diff_summary.files[*].file``
# 反推。详见 ``maybe_checkpoint_commit`` 中 ``_dispatch_checkpoint_action``
# 之后的 changed_files 派生逻辑。
from apps.collab.services.file_changelog import (  # noqa: E402,F401
    extract_changed_files_from_diff_summary,
    file_path_to_resource_id as _file_path_to_resource_id,
    hash_file_path as hash_file_path_to_resource_id,
    record_file_changelogs as _record_file_changelogs_impl,
)

_Callable = Any  # 避免 from typing import Callable 仅用于类型注释

# Agent run 开始前的 baseline tree hash 缓存，用于 commit 后计算精确 diff_summary。
# key=thread_id, value=(generation, tree_hash)
# generation 递增计数器，防止跨轮次 stale baseline 串台。
_baseline_by_thread: Dict[str, tuple] = {}
_baseline_generation: Dict[str, int] = {}


def _push_checkpoint_failed_event(
    thread_id: str,
    session_id: Optional[str],
    message_id: Optional[str],
    reason: str,
) -> None:
    """通过 WS 向前端推送 checkpoint_failed 事件，使 Daemon 模式下前端能感知失败。

    复用 agent.stream topic，前端通过已有的 stream 订阅即可收到。
    """
    try:
        from apps.services.common.ws.bus import publish_ws_event
        from apps.services.common.ws.protocol import build_envelope, new_event_id
        from apps.services.common.agent_protocol.namespace import stream_topic, stream_event_type

        topic = stream_topic(thread_id)
        envelope = build_envelope(
            stream_event_type("checkpoint_failed"),
            new_event_id(),
            {
                "session_id": session_id or "",
                "message_id": message_id or "",
                "reason": reason,
            },
            thread_id=thread_id,
        )
        publish_ws_event(topic, envelope)
    except Exception:
        logger.debug(
            "[DaemonCheckpoint] _push_checkpoint_failed_event failed: thread=%s",
            thread_id, exc_info=True,
        )


def _push_checkpoint_restore_failed_event(
    thread_id: str,
    reason: str,
    commit_hash: Optional[str] = None,
) -> None:
    """通过 WS 向前端推送 checkpoint_restore_failed（Daemon 异常恢复路径）。"""
    session_id = _parse_session_id(thread_id)
    try:
        from apps.services.common.ws.bus import publish_ws_event
        from apps.services.common.ws.protocol import build_envelope, new_event_id
        from apps.services.common.agent_protocol.namespace import stream_topic, stream_event_type

        topic = stream_topic(thread_id)
        payload: Dict[str, Any] = {
            "session_id": session_id or "",
            "message_id": "",
            "reason": reason,
        }
        if commit_hash:
            payload["commit_hash"] = commit_hash
        envelope = build_envelope(
            stream_event_type("checkpoint_restore_failed"),
            new_event_id(),
            payload,
            thread_id=thread_id,
        )
        publish_ws_event(topic, envelope)
    except Exception:
        logger.warning(
            "[DaemonCheckpoint] _push_checkpoint_restore_failed_event failed: thread=%s",
            thread_id,
            exc_info=True,
        )


def _push_checkpoint_success_event(
    thread_id: str,
    session_id: Optional[str],
    message_id: Optional[str],
    commit_hash: str,
) -> None:
    """通过 WS 向前端推送 checkpoint_success 事件，使 Daemon 模式下前端能重置 failCount。"""
    try:
        from apps.services.common.ws.bus import publish_ws_event
        from apps.services.common.ws.protocol import build_envelope, new_event_id
        from apps.services.common.agent_protocol.namespace import stream_topic, stream_event_type

        topic = stream_topic(thread_id)
        envelope = build_envelope(
            stream_event_type("checkpoint_success"),
            new_event_id(),
            {
                "session_id": session_id or "",
                "message_id": message_id or "",
                "commit_hash": commit_hash,
            },
            thread_id=thread_id,
        )
        publish_ws_event(topic, envelope)
    except Exception:
        logger.debug(
            "[DaemonCheckpoint] _push_checkpoint_success_event failed: thread=%s",
            thread_id, exc_info=True,
        )


def _parse_session_id(thread_id: str) -> Optional[str]:
    """从 thread_id 中提取 session_id，格式不匹配返回 None。"""
    from apps.chat.conversation.utils import CHAT_SESSION_PREFIX

    if not thread_id or not thread_id.startswith(CHAT_SESSION_PREFIX):
        return None
    return thread_id[len(CHAT_SESSION_PREFIX):]


def _run_in_background(name: str, fn: _Callable) -> None:
    """在 daemon 线程中执行 fn，自动管理 DB 连接和异常。"""
    def _worker():
        from django.db import close_old_connections
        close_old_connections()
        try:
            fn()
        except Exception:
            logger.warning("[DaemonCheckpoint] %s worker failed", name, exc_info=True)
        finally:
            close_old_connections()

    threading.Thread(target=_worker, daemon=True).start()


DAEMON_NOT_APPLICABLE = "not_applicable"
DAEMON_OFFLINE = "offline"
DAEMON_NO_WORKSPACE = "no_workspace"


def _resolve_daemon_context(thread_id: str) -> Optional[Dict[str, Any]]:
    """判断 thread 绑定的执行设备是否为在线 Daemon，返回 context 或 None。

    Returns:
        {"device_fingerprint": str, "project_path": str, "space_id": str} — Daemon 在线且配置完整
        {"_skip_reason": str} — Daemon 设备但不可用（离线/无 workspace）
        None — 非 Daemon 设备，无需操作

    ``space_id``（C-FH6）：thread→session→space 的单一来源，供 per-file rewind /
    preview 的 dispatch 透传给 daemon 侧 path guard（``params._space_id`` →
    ``workspaceSnapshotResolver``）。缺它时 daemon guard 回落 ``config.workspace_root``
    单根，多 workspace 会误判。
    """
    session_id = _parse_session_id(thread_id)
    if not session_id:
        return None

    try:
        from apps.chat.conversation.models import ChatSession
        session = (
            ChatSession.objects
            .filter(id=session_id)
            .first()
        )
        if not session or not session.workspace:
            return None

        from apps.tabtinspace.services.execution_binding import resolve_control_device
        device = resolve_control_device(space=session.workspace)
        if not device:
            return None
        if getattr(device, 'device_type', None) != 'daemon':
            return None
        # W13 D6 短期实施：busy 视为可用——daemon 在跑任务时也允许 checkpoint
        # 推送（DaemonAgentHost 按 sessionId 互斥，不会与运行中的会话冲突）。
        from apps.services.common.device_capability_registry import (
            DEVICE_AVAILABLE_STATUSES,
        )
        if getattr(device, 'status', None) not in DEVICE_AVAILABLE_STATUSES:
            logger.debug(
                "[DaemonCheckpoint] daemon device offline, skip: fp=%s",
                device.fingerprint,
            )
            return {"_skip_reason": DAEMON_OFFLINE}

        project_path = session.workspace.working_dir
        if not project_path:
            logger.debug(
                "[DaemonCheckpoint] no working_dir in Workspace: workspace=%s",
                session.workspace.id,
            )
            return {"_skip_reason": DAEMON_NO_WORKSPACE}

        return {
            "device_fingerprint": device.fingerprint,
            "project_path": project_path,
            # C-FH6：dispatch 时透传给 daemon path guard 的真实 session 根。
            "space_id": str(session.workspace.id),
        }
    except Exception:
        logger.debug("[DaemonCheckpoint] _resolve_daemon_context failed", exc_info=True)
        return None


def _dispatch_checkpoint_action(
    thread_id: str,
    action_type: str,
    params: Dict[str, Any],
    timeout: int,
) -> Optional[Dict[str, Any]]:
    """向 Daemon 设备 dispatch checkpoint action 并等待结果。"""
    from apps.services.common.dispatch.frontend_dispatcher import get_frontend_dispatcher

    dispatcher = get_frontend_dispatcher()
    result = dispatcher.dispatch_action(
        thread_id=thread_id,
        action_type=action_type,
        params=params,
        timeout=timeout,
    )
    if result and result.get("success"):
        return result.get("data", result)

    error = result.get("error", "unknown") if result else "no response"
    logger.warning(
        "[DaemonCheckpoint] %s failed: thread=%s error=%s",
        action_type, thread_id, error,
    )
    return None


def _with_space_id(params: Dict[str, Any], space_id: Optional[str]) -> Dict[str, Any]:
    """C-FH6：把 session 的 ``space_id`` 注入 dispatch params。

    daemon action-bridge 的 EF-05 fallback 会把 ``params.space_id`` 落到
    ``params._space_id``（envelope 顶层无 ``space_id`` 时），供
    ``buildFileHistoryPathGuard`` 用真实 session 根解析 v3 snapshot.allowedPaths。
    ``space_id`` 为空时不注入（daemon 侧自然回落 ``config.workspace_root``）。
    """
    if space_id:
        return {**params, "space_id": space_id}
    return params


def _persist_checkpoint_hash(
    thread_id: str,
    message_id: str,
    commit_hash: str,
    state_index: Optional[int] = None,
    changed_files: Optional[list] = None,
    diff_summary: Optional[Dict[str, Any]] = None,
    session_id: Optional[str] = None,
    agent_run_id: Optional[str] = None,
) -> None:
    """将 commit_hash / diff_summary 写入 ChatMessage，并批量写入 file 级 ChangeLog。

    CP-OBS-2: state_index 由调用方在后台线程启动前同步计算后传入，
    避免后台线程执行时 messages_json 已增长导致索引失准。

    QC-04 / PRD §4.3.2：为每个 changed_file 批量写入
    ``ChangeLog(resource_type='file', resource_id=UUID5(path), session_id=..., agent_run_id=...)``，
    使 vibe coding 场景的代码文件变更能被 ``conversation-anchors`` API 追溯。
    ChangeLog 写入失败不影响 ChatMessage 持久化主链路（ChangeLog 在 PG、ChatMessage
    在 MySQL，本就不共享事务）。
    """
    try:
        from apps.chat.conversation.models import ChatMessage

        update_kwargs: Dict[str, Any] = {"checkpoint_hash": commit_hash}
        if state_index is not None:
            update_kwargs["checkpoint_state_index"] = state_index
        if changed_files is not None:
            update_kwargs["changed_files"] = changed_files
        if diff_summary is not None:
            update_kwargs["diff_summary"] = diff_summary

        # ── W3 §3.3.1 + P0-E 修复：双锚定 checkpoint_anchor_block ──
        # checkpoint_anchor_block_id：取该 message 的最后一个 block 的 block_id
        #  （reassembler 已把 slot.block_id 塞到 block dict 内）
        # checkpoint_anchor_block_index：该 block 的 index（在 content_blocks_json 数组）
        # 即便后续 trim 任务把 thinking/tool_result 大字段清空，block 头部
        # 元数据（block_id + type）仍保留——anchor 通过 block_id 仍可精确
        # 定位（防 trim 重排）
        msg = ChatMessage.objects.filter(id=message_id).only(
            'id', 'content_blocks_json',
        ).first()
        if msg and msg.content_blocks_json:
            blocks = msg.content_blocks_json
            if isinstance(blocks, list) and blocks:
                last_block = blocks[-1]
                if isinstance(last_block, dict):
                    anchor_block_id = (
                        last_block.get('block_id')
                        or last_block.get('id')  # tool_use 等用 id 字段
                        or ''
                    )
                    if anchor_block_id:
                        update_kwargs["checkpoint_anchor_block_id"] = str(anchor_block_id)
                        update_kwargs["checkpoint_anchor_block_index"] = len(blocks) - 1

        from django.utils import timezone
        update_kwargs["updated_at"] = timezone.now()
        updated = ChatMessage.objects.filter(id=message_id).update(**update_kwargs)
        if updated:
            logger.info(
                "[DaemonCheckpoint] persisted checkpoint: msg=%s hash=%s state_index=%s diff=%s",
                message_id, commit_hash, state_index,
                bool(diff_summary),
            )
        else:
            logger.warning(
                "[DaemonCheckpoint] message not found for checkpoint persist: msg=%s",
                message_id,
            )
    except Exception:
        logger.warning(
            "[DaemonCheckpoint] _persist_checkpoint_hash failed: msg=%s",
            message_id, exc_info=True,
        )

    if changed_files:
        try:
            _record_file_changelogs_impl(
                changed_files=changed_files,
                diff_summary=diff_summary,
                commit_hash=commit_hash,
                agent_run_id=agent_run_id or "",
                session_id=session_id or "",
                log_prefix="[DaemonCheckpoint]",
            )
        except Exception:
            logger.warning(
                "[DaemonCheckpoint] record_file_changelogs failed (non-blocking): msg=%s",
                message_id, exc_info=True,
            )


def _create_space_checkpoint(
    space_id: str,
    file_checkpoint_hash: str,
    agent_run_id: str = "",
    message_id: Optional[str] = None,
    trigger: str = "agent_turn_done",
    extra_metadata: Optional[Dict[str, Any]] = None,
    checkpoint_policy: Optional[Dict[str, Any]] = None,
    diff_summary: Optional[Dict[str, Any]] = None,
    session_id: Optional[str] = None,
) -> None:
    """创建 SpaceCheckpoint，将文件快照和各模块资源版本打包为原子存档点。

    防护措施：
    - 同一 agent_run_id 不重复创建（幂等）
    - 无资源变更时仅保存文件快照
    - 查询失败不阻塞主流程
    """
    try:
        from uuid import UUID
        from apps.collab.models import SpaceCheckpoint, VersionHistory
        from apps.tabtinspace.models import ContextItem, Space

        space_uuid = UUID(space_id)

        if agent_run_id:
            existing = SpaceCheckpoint.objects.using("postgresql").filter(
                space_id=space_uuid, agent_run_id=agent_run_id,
            ).exists()
            if existing:
                logger.debug(
                    "[DaemonCheckpoint] SpaceCheckpoint already exists for run=%s, skipping",
                    agent_run_id,
                )
                return
        # NOTE: exists() + create() 有 TOCTOU 竞态窗口，但 SpaceCheckpoint 无
        # unique 约束，重复创建不影响功能正确性（恢复时取 latest）。

        from apps.tabtinspace.services.host_resolver import host_organization_id
        organization_id = host_organization_id(space_uuid)

        from apps.tabtinspace.services.asset_host import asset_host_q

        resource_id_strs = list(
            ContextItem.objects.using("postgresql")
            .filter(asset_host_q(space_uuid), trashed_at__isnull=True)
            .exclude(resource_id="")
            .values_list("resource_id", flat=True)
            .distinct()
        )

        resource_uuids = []
        for rid in resource_id_strs:
            try:
                resource_uuids.append(UUID(str(rid)))
            except ValueError:
                continue

        # ── W3.0 / D27：先 spin-wait pending ChangeLog Celery 任务 ────────
        # tabdata 把 ChangeLog 写入异步化（Celery）后，``enrich_checkpoint_for_creation``
        # 内部的 ``build_checkpoint_impact`` 与下方 ``collect_contributed_resources``
        # 都反查 ChangeLog（``TableResourceContributor`` / ``TableImpactContributor``），
        # 若 Celery 任务还没完成，version_refs / impact.tabdata 都会漏收本 turn 的写入。
        # 在 enrich + contributor 两次 ChangeLog 反查 **之前** 同步等待，默认 5s 超时
        # （:func:`apps.tabdata.services.async_changelog.wait_for_pending_changelogs`）。
        # 超时仅 warning（已在 wait 函数内部打），不阻断 Checkpoint 创建。
        if agent_run_id:
            try:
                from apps.tabdata.services.async_changelog import (
                    wait_for_pending_changelogs,
                )
                wait_for_pending_changelogs(agent_run_id)
            except Exception:
                logger.debug(
                    "[DaemonCheckpoint] wait_for_pending_changelogs raised "
                    "(non-blocking): run=%s",
                    agent_run_id, exc_info=True,
                )

        # ── 提取对话决策上下文（best-effort，失败不影响 Checkpoint 创建）──
        enriched: Dict[str, Any] = {
            'anchor_session_id': session_id or '',
            'anchor_message_id': '',
            'checkpoint_context': None,
        }

        if message_id or agent_run_id:
            try:
                from apps.collab.services.checkpoint_context import enrich_checkpoint_for_creation
                # Wave 12 (H1-02): 透传 Daemon 外层已解析的 session_id，让
                # metadata.checkpoint_context.session_id 与一等字段 anchor_session_id 同源，
                # 消除"一等字段有值但 metadata 内层为空"的不一致。
                enriched = enrich_checkpoint_for_creation(
                    agent_run_id=agent_run_id,
                    message_id=message_id or '',
                    session_id=session_id or '',
                    space_resource_ids=resource_uuids or None,
                    diff_summary=diff_summary,
                    include_sub_conversations=bool(message_id),
                )
                if not enriched.get('anchor_session_id') and session_id:
                    enriched['anchor_session_id'] = session_id
            except Exception:
                logger.warning(
                    "[DaemonCheckpoint] 提取 checkpoint_context 失败，不影响 Checkpoint 创建: message=%s",
                    message_id, exc_info=True,
                )

        anchor_session_id = enriched.get('anchor_session_id', '')
        anchor_message_id = enriched.get('anchor_message_id', '')
        checkpoint_context = enriched.get('checkpoint_context')

        # ── W0-1 CC-2：在 atomic 块前预计算 contributor 资源 ─────────────────
        # 与 enrich_checkpoint_for_creation 同样在事务外预计算的模式对齐——
        # contributor 内部可能查 ChangeLog 等慢路径，放在 atomic 块外避免延长
        # PG 事务持有时间。失败 contributed_refs 退回 [] 由收集器内的隔离逻辑
        # 兜底，主链路不阻塞。
        contributed_refs: list = []
        if agent_run_id:
            try:
                from apps.collab.services.contributors import (
                    collect_contributed_resources,
                    expand_agent_run_ids,
                )
                # 与 build_checkpoint_impact 对称：传给 contributor 的是含子 Agent
                # 级联的全量 run id 列表（Charter §3.2 契约）。
                all_run_ids = expand_agent_run_ids(agent_run_id)
                contributed_refs = collect_contributed_resources(all_run_ids)
            except Exception:
                logger.warning(
                    "[DaemonCheckpoint] collect_contributed_resources failed "
                    "(non-blocking): run=%s",
                    agent_run_id, exc_info=True,
                )

        from django.db import transaction as db_transaction

        with db_transaction.atomic(using="postgresql"):
            # BUG-2 fix: 逐资源用 order_by("-created_at").first() 取最新 VH，
            # 而非 Max("id")——UUID4 是随机的，Max 返回字节序最大而非时间最新。
            # 逻辑与 collab/api.py create_space_checkpoint 对齐。
            version_refs = {}
            if resource_uuids:
                distinct_resources = (
                    VersionHistory.objects.using("postgresql")
                    .filter(resource_id__in=resource_uuids)
                    .values("resource_type", "resource_id")
                    .distinct()
                )
                for rv in distinct_resources:
                    latest_id = (
                        VersionHistory.objects.using("postgresql")
                        .filter(
                            resource_type=rv["resource_type"],
                            resource_id=rv["resource_id"],
                        )
                        .order_by("-created_at")
                        .values_list("id", flat=True)
                        .first()
                    )
                    if latest_id:
                        key = f"{rv['resource_type']}:{rv['resource_id']}"
                        version_refs[key] = str(latest_id)

            # ── W0-1 CC-2：合并 ResourceContributor 贡献 ──────────────────
            # contributed_refs 已在 atomic 块前预计算（避免延长事务持有时间）。
            # 模块（tabdata / tabdoc / ...）通过 collab.services.contributors
            # 注册的 ResourceContributor 把 ContextItem 路径未覆盖（例如 Agent
            # 创建后还未 attach 到 Space）但本 turn 实际写入过的资源合并入
            # version_refs。Charter §3.2 / D2 协议方向。
            #
            # 合并语义：contributor 优先（dict.update 后到为准）——contributor
            # 给的是"该 agent_run 真正写入的 VH"，比 ContextItem 路径取到的
            # "当前最新 VH"更精准（两个时刻可能不同）。
            #
            # 向后兼容：未注册任何 contributor 时 contributed_refs == []，
            # version_refs 与原实现完全一致。
            for ref in contributed_refs:
                key = f"{ref['resource_type']}:{ref['resource_id']}"
                version_refs[key] = ref["version_history_id"]

            # BUG-3 fix (CC-005): 保护被引用 VH 的 expired_at，防止 cleanup_expired 删除。
            # 记录 original_expired_at 到 metadata，以便删除 checkpoint 时恢复。
            # W0-1：contributor 贡献的 VH id 可能不是合法 UUID（contributor bug），
            # 用 try/except 跳过避免污染整个 vh_ids 列表。
            vh_ids = []
            for vid in version_refs.values():
                try:
                    vh_ids.append(UUID(vid))
                except (ValueError, TypeError):
                    logger.debug(
                        "[DaemonCheckpoint] skip invalid VH id in version_refs: %r",
                        vid,
                    )
            original_expired_at: Dict[str, str] = {}
            if vh_ids:
                for vid, exp_at in (
                    VersionHistory.objects.using("postgresql")
                    .filter(id__in=vh_ids, expired_at__isnull=False)
                    .values_list("id", "expired_at")
                ):
                    original_expired_at[str(vid)] = exp_at.isoformat()

            base_metadata: Dict[str, Any] = {}
            if original_expired_at:
                base_metadata["original_expired_at"] = original_expired_at
            if checkpoint_policy:
                base_metadata["checkpoint_policy"] = checkpoint_policy
            if extra_metadata:
                base_metadata.update(extra_metadata)
            if checkpoint_context:
                base_metadata['checkpoint_context'] = checkpoint_context

            cp = SpaceCheckpoint.objects.using("postgresql").create(
                space_id=space_uuid,
                name="",
                version_refs=version_refs,
                file_checkpoint_hash=file_checkpoint_hash,
                agent_run_id=agent_run_id,
                trigger=trigger,
                metadata=base_metadata,
                anchor_session_id=anchor_session_id,
                anchor_message_id=anchor_message_id,
                **({'organization_id': organization_id} if organization_id else {}),
            )

            if vh_ids:
                VersionHistory.objects.using("postgresql").filter(
                    id__in=vh_ids,
                    expired_at__isnull=False,
                ).update(expired_at=None)

        logger.info(
            "[DaemonCheckpoint] SpaceCheckpoint created: space=%s resources=%d vh_protected=%d hash=%s run=%s anchor=%s/%s",
            space_id, len(version_refs), len(original_expired_at),
            file_checkpoint_hash[:8] if file_checkpoint_hash else "none",
            agent_run_id[:8] if agent_run_id else "none",
            anchor_session_id[:8] if anchor_session_id else "none",
            anchor_message_id[:8] if anchor_message_id else "none",
        )

        # 异步生成 intent_summary + decision_summary（best-effort）
        try:
            from apps.services.agent_engine.tasks.checkpoint_summary import maybe_dispatch_checkpoint_summaries
            maybe_dispatch_checkpoint_summaries(
                str(cp.id), checkpoint_context, diff_summary,
                log_prefix="[DaemonCheckpoint] ",
            )
        except Exception:
            logger.debug("[DaemonCheckpoint] Failed to dispatch summary tasks", exc_info=True)

    except Exception:
        logger.warning(
            "[DaemonCheckpoint] _create_space_checkpoint failed: space=%s",
            space_id, exc_info=True,
        )


def _resolve_state_index(thread_id: str) -> Optional[int]:
    """从 ConversationState.messages_json 获取当前长度作为 state_index。"""
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
    except Exception:
        logger.debug(
            "[DaemonCheckpoint] _resolve_state_index failed: thread=%s",
            thread_id, exc_info=True,
        )
    return None


def _get_last_checkpoint_hash(thread_id: str, user_id: Optional[str] = None) -> Optional[str]:
    """从 session 最近的 assistant 消息上获取 checkpoint_hash，用于异常恢复。

    当 *user_id* 可用时，通过 ``session__user_id`` 做防御性鉴权过滤，
    防止内部调用链路变更后出现跨 session 数据泄露。
    """
    session_id = _parse_session_id(thread_id)
    if not session_id:
        return None
    try:
        from apps.chat.conversation.models import ChatMessage

        filters: Dict[str, Any] = {
            "session_id": session_id,
            "role": "assistant",
        }
        if user_id:
            filters["session__user_id"] = user_id

        msg = (
            ChatMessage.objects
            .filter(**filters)
            .exclude(checkpoint_hash__isnull=True)
            .exclude(checkpoint_hash='')
            .order_by('-created_at', '-id')
            .values_list('checkpoint_hash', flat=True)
            .first()
        )
        return msg
    except Exception:
        logger.debug("[DaemonCheckpoint] _get_last_checkpoint_hash failed", exc_info=True)
        return None


# ── 公开 API ──


@dataclass
class FileHistoryRewindOutcome:
    """per-file 文件回退结果（``maybe_file_history_rewind`` 返回）。

    回退「本地文件恢复」从旧 shadow-git ``checkpoint_restore(commit_hash)`` 切到
    per-file ``file_history_rewind(anchor_id)``（§3.9）。本结果同时承载「宿主分流」判据，供 rollback API 透传给前端。

    host:
      - ``'local'``  —— 非 Daemon（Electron 本地宿主）：后端**未碰文件**，由前端
        ``fileHistoryIpc.rewind`` 负责本地回退。
      - ``'daemon'`` —— Daemon 宿主：文件在远端，后端已 dispatch ``file_history_rewind``
        让 Daemon 用 per-file 账本回退；前端**不**应再本地 rewind（本进程无该 thread 账本）。
    success: 仅 ``host=='daemon'`` 有意义——文件是否全部回退成功（dispatch 成功且
      ``failed_files`` 为空）。``host=='local'`` 恒为 True（后端无操作）。
    failed_files: Daemon 回退失败的文件相对路径，fail-visible 透传到 UI（实现要求 4）。
    skip_reason: Daemon 设备离线 / 无 workspace 时的原因（``offline`` / ``no_workspace``）。
    """

    host: str = 'local'
    success: bool = True
    failed_files: List[str] = field(default_factory=list)
    skip_reason: Optional[str] = None


@dataclass
class TranscriptTruncateOutcome:
    """对话回退 transcript 截断结果（``maybe_session_transcript_truncate`` 返回，）。

    与 :class:`FileHistoryRewindOutcome` 同款宿主分流：

    host:
      - ``'local'``  —— 非 Daemon（Electron 本地宿主）：后端**未碰 transcript**，由前端
        经 IPC ``agent-engine:rollback-transcript`` 让本机 host 写 rewind 软标记。
      - ``'daemon'`` —— Daemon 宿主：transcript 在远端，后端已 dispatch
        ``session_transcript_truncate`` 让 Daemon 写软标记；前端不应本地处理。
    success: 仅 ``host=='daemon'`` 有意义——dispatch 是否成功。``host=='local'`` 恒 True。
    skip_reason: Daemon 设备离线 / 无 workspace 时的原因。
    """

    host: str = 'local'
    success: bool = True
    # daemon 是否真截断了 transcript（False = 锚不中且无 fallback，未截断 → fail-visible）。
    applied: Optional[bool] = None
    skip_reason: Optional[str] = None


@dataclass
class FileHistoryPreviewOutcome:
    """per-file 回退**预览**结果（``maybe_file_history_preview`` 返回）。

    回退预览（RewindPreviewPanel）此前在 Daemon 宿主上仍用 shadow-git
    ``checkpoint_hash`` 推断「将恢复哪些文件」（失真）；FH-4 改走 per-file
    ``file_history_preview`` action（daemon 侧已实现，原为死代码），按 anchor 那
    一轮真实 track 过的文件清单出预览。本结果同时承载「宿主分流」判据，供 preview
    API 透传给前端：

    host:
      - ``'local'``  —— 非 Daemon（Electron 本地宿主）：preview 由前端
        ``fileHistoryIpc.getAffectedPaths`` 本地算，后端不 dispatch（``affected_paths``
        留空）。
      - ``'daemon'`` —— Daemon 宿主：文件在远端，后端 dispatch ``file_history_preview``
        取真实 ``affected_paths``；前端据 ``file_restore_host==='daemon'`` 用这份清单
        渲染 per-file 文件区块，替代 shadow-git diff fallback。
    affected_paths: 仅 ``host=='daemon'`` 有意义——anchor 那一轮回退将写/删的文件
      相对路径（已过 daemon path guard）。``host=='local'`` 恒为空。
    success: 仅 ``host=='daemon'`` 有意义——预览 dispatch 是否成功拿到清单。
    skip_reason: Daemon 设备离线 / 无 workspace 时的原因（``offline`` / ``no_workspace``）。
    """

    host: str = 'local'
    affected_paths: List[str] = field(default_factory=list)
    success: bool = True
    skip_reason: Optional[str] = None


class DaemonCheckpointService:
    """后端编排 Daemon 设备上的 Checkpoint 操作。

    所有方法均为 best-effort：失败只记日志不抛异常，不阻断业务流程。
    """

    @staticmethod
    def maybe_checkpoint_init(thread_id: str) -> None:
        """Agent Turn 开始前调用。对 Daemon 设备 fire-and-forget 发送 checkpoint_init，
        然后用 write-tree 捕获 baseline tree hash（用于 commit 后精确计算 diff_summary）。

        不阻塞调用方——在后台线程中执行 dispatch + 等待。
        """
        ctx = _resolve_daemon_context(thread_id)
        if ctx is None or "_skip_reason" in ctx:
            return

        gen = _baseline_generation.get(thread_id, 0) + 1
        _baseline_generation[thread_id] = gen

        def _do_init():
            logger.info(
                "[DaemonCheckpoint] checkpoint_init: thread=%s project=%s gen=%d",
                thread_id, ctx["project_path"], gen,
            )
            init_result = _dispatch_checkpoint_action(
                thread_id=thread_id,
                action_type="checkpoint_init",
                params={"project_path": ctx["project_path"]},
                timeout=CHECKPOINT_INIT_TIMEOUT,
            )
            if not init_result:
                return

            tree_result = _dispatch_checkpoint_action(
                thread_id=thread_id,
                action_type="checkpoint_write_tree",
                params={"project_path": ctx["project_path"]},
                timeout=CHECKPOINT_WRITE_TREE_TIMEOUT,
            )
            if tree_result:
                tree_hash = tree_result.get("tree_hash")
                if tree_hash:
                    # 只有当 generation 仍为当前值时才写入（防止被更新的 turn 覆盖）
                    if _baseline_generation.get(thread_id) == gen:
                        _baseline_by_thread[thread_id] = (gen, tree_hash)
                        logger.info(
                            "[DaemonCheckpoint] baseline captured: thread=%s hash=%s gen=%d",
                            thread_id, tree_hash[:12], gen,
                        )

        _run_in_background("checkpoint_init", _do_init)

    @staticmethod
    def maybe_checkpoint_commit(
        thread_id: str,
        message_id: Optional[str] = None,
        trigger: str = "agent_turn_done",
        allow_empty: bool = False,
        visible_in_history: Optional[bool] = None,
    ) -> None:
        """Agent Turn 完成后调用。在后台线程中对 Daemon 发送 checkpoint_commit，
        并将返回的 commit_hash 持久化到 ChatMessage，然后创建 SpaceCheckpoint。

        不阻塞调用方。
        """
        ctx = _resolve_daemon_context(thread_id)
        if ctx is None or "_skip_reason" in ctx:
            return

        state_index = _resolve_state_index(thread_id)

        session_id = _parse_session_id(thread_id)
        space_id = None
        agent_run_id = ""
        if session_id:
            try:
                from apps.chat.conversation.models import ChatSession, ChatMessage as CM
                s = ChatSession.objects.filter(id=session_id).values('workspace_id').first()
                if s:
                    space_id = str(s['workspace_id']) if s['workspace_id'] else None
                if message_id:
                    msg = CM.objects.filter(id=message_id).values('agent_run_id').first()
                    if msg:
                        agent_run_id = msg.get('agent_run_id') or ""
            except Exception:
                logger.debug("[DaemonCheckpoint] failed to resolve space_id/agent_run_id", exc_info=True)

        # W3.0 / D27 review fix（产品 P0-1 / 用户 P0-1）：
        # A3 ``_trigger_checkpoint_anchor`` 调 ``maybe_checkpoint_commit(thread_id)``
        # 时不传 ``message_id``，原实现会让 ``agent_run_id`` 保持 ``""`` →
        # ``_create_space_checkpoint`` 的 ``if agent_run_id:`` 分支整块跳过，
        # 既不 ``wait_for_pending_changelogs`` 也不调 ``collect_contributed_resources``。
        # 在 ChangeLog 异步化（D27）下，这意味着 A3 自动 anchor 完全绕过 D2
        # contributor 协议 + Celery barrier → version_refs 漏 tabdata，rollback 失效。
        # 兜底：从主线程的 ``run_context`` ContextVar 读 ``agent_run_id``，
        # 与 ``ChangeLogSubscriber._write_change_log`` 走的同源（W1.1 D8 已统一）。
        if not agent_run_id:
            try:
                from apps.services.common.platform_context import get_current_run_id
                run_id_from_ctx = get_current_run_id() or ""
                if run_id_from_ctx:
                    agent_run_id = run_id_from_ctx
                    logger.debug(
                        "[DaemonCheckpoint] resolved agent_run_id=%s from ContextVar "
                        "(no message_id supplied; A3-style anchor)",
                        agent_run_id,
                    )
            except Exception:
                logger.debug(
                    "[DaemonCheckpoint] get_current_run_id ContextVar fallback failed",
                    exc_info=True,
                )

        # 在主线程中弹出 baseline，避免后台线程启动延迟导致被后续 init 覆盖。
        # 只使用当前 generation 的 baseline，过期的直接丢弃。
        current_gen = _baseline_generation.get(thread_id, 0)
        cached = _baseline_by_thread.pop(thread_id, None)
        baseline_hash = cached[1] if cached and cached[0] == current_gen else None
        checkpoint_policy: Dict[str, Any] = {
            "kind": trigger,
            "trigger": trigger,
            "allowEmpty": allow_empty,
            "visibleInHistory": (
                visible_in_history
                if visible_in_history is not None
                else trigger in ("agent_turn_done", "manual", "error_compensation")
            ),
        }
        if message_id:
            checkpoint_policy["anchor"] = message_id
        if baseline_hash:
            checkpoint_policy["baselineHash"] = baseline_hash

        def _do_commit():
            logger.info(
                "[DaemonCheckpoint] checkpoint_commit: thread=%s project=%s msg=%s baseline=%s",
                thread_id, ctx["project_path"], message_id,
                baseline_hash[:12] if baseline_hash else "none",
            )
            result = _dispatch_checkpoint_action(
                thread_id=thread_id,
                action_type="checkpoint_commit",
                params={
                    "project_path": ctx["project_path"],
                    "policy": checkpoint_policy,
                },
                timeout=CHECKPOINT_COMMIT_TIMEOUT,
            )
            if not result:
                logger.error(
                    "[DaemonCheckpoint] Checkpoint commit 失败: dispatch 无响应",
                    extra={
                        "checkpoint_failure": True,
                        "checkpoint_failure_reason": "dispatch_no_response",
                        "session_id": session_id,
                        "space_id": space_id,
                        "agent_run_id": agent_run_id,
                        "message_id": message_id,
                    },
                )
                _push_checkpoint_failed_event(
                    thread_id, session_id, message_id,
                    reason="dispatch_no_response",
                )
                return

            commit_hash = result.get("commit_hash")
            if not commit_hash:
                if trigger == "tabdata_auto_anchor" and space_id:
                    _create_space_checkpoint(
                        space_id, "", agent_run_id,
                        message_id=message_id,
                        trigger=trigger,
                        checkpoint_policy=checkpoint_policy,
                        session_id=session_id or "",
                    )
                    logger.info(
                        "[DaemonCheckpoint] tabdata auto-anchor recorded without file commit: "
                        "thread=%s space=%s",
                        thread_id, space_id,
                    )
                    return
                logger.info(
                    "[DaemonCheckpoint] checkpoint_commit skipped: no file changes "
                    "(thread=%s trigger=%s)",
                    thread_id, trigger,
                )
                return

            # 计算 diff_summary：用 baseline tree hash 精确归因本轮 Agent 变更
            diff_summary = None
            try:
                diff_params: Dict[str, Any] = {
                    "project_path": ctx["project_path"],
                    "commit_hash": commit_hash,
                }
                if baseline_hash:
                    diff_params["base_hash"] = baseline_hash
                diff_result = _dispatch_checkpoint_action(
                    thread_id=thread_id,
                    action_type="checkpoint_diff_summary",
                    params=diff_params,
                    timeout=CHECKPOINT_DIFF_SUMMARY_TIMEOUT,
                )
                if diff_result and diff_result.get("summary"):
                    diff_summary = diff_result["summary"]
                    diff_files = diff_result.get("files")
                    if diff_files:
                        diff_summary["files"] = diff_files
            except Exception:
                logger.debug(
                    "[DaemonCheckpoint] diff_summary failed (non-blocking): thread=%s",
                    thread_id, exc_info=True,
                )

            # 顺序依赖：_persist_checkpoint_hash 必须先于 _create_space_checkpoint。
            # 前者将 changed_files / diff_summary 写入 MySQL ChatMessage，
            # 后者读取该字段构建 impact.files。
            # QC-04: 同时传入 session_id/agent_run_id，让 _persist_checkpoint_hash
            # 批量写入 file 级 ChangeLog（resource_type='file'），解决 vibe coding
            # 场景代码变更无法追溯到对话位置的问题。
            #
            # **2026-05-13 SSoT 切换**：changed_files 不再从 daemon ``result.get
            # ("changed_files")`` 读取（daemon 已停止返回此字段），改为从
            # ``diff_summary.files[*].file`` 反推。Shadow Git diff 是 ground truth：
            #   1. 单源 SSoT：避免旧"daemon best-effort 数组 + Shadow Git diff"
            #      双轨可能不一致的问题
            #   2. 覆盖面完整：包括 LLM 通过 run_terminal_command rm/mv/sed -i
            #      改的文件（旧 daemon 端 hook 只覆盖 file_write/edit/delete）
            #   3. 失败软降级：``diff_summary`` 为 None 时（diff_summary 调用失败
            #      或确实无变更）``extract_changed_files_from_diff_summary`` 返
            #      空数组，``_persist_checkpoint_hash`` 跳过 file_changelog 写入
            if message_id:
                changed_files = (
                    extract_changed_files_from_diff_summary(diff_summary) or None
                )
                _persist_checkpoint_hash(
                    thread_id, message_id, commit_hash, state_index,
                    changed_files, diff_summary,
                    session_id=session_id or "",
                    agent_run_id=agent_run_id or "",
                )

            if space_id:
                # QC-13 (Wave 12): 必须显式传 session_id，与 maybe_checkpoint_before_approval
                # 保持对称。即使 agent_run_id/message_id 为空、enrich 失败，
                # anchor_session_id 一等字段仍能被填充，保证 SpaceCheckpoint 回查率 100%。
                _create_space_checkpoint(
                    space_id, commit_hash, agent_run_id,
                    message_id=message_id, diff_summary=diff_summary,
                    session_id=session_id or "",
                    trigger=trigger,
                    checkpoint_policy=checkpoint_policy,
                )

            _push_checkpoint_success_event(
                thread_id, session_id, message_id, commit_hash,
            )

        _run_in_background("checkpoint_commit", _do_commit)

    @staticmethod
    def maybe_checkpoint_before_approval(
        thread_id: str,
        tool_names: Optional[list] = None,
    ) -> None:
        """HITL 审批中断前调用。在后台线程中对 Daemon 发送 checkpoint_commit，
        创建 pre-approval checkpoint，使审批拒绝后用户可回滚到此快照。

        命名约定: trigger="pre_approval"，metadata 中记录待审批工具名。
        不阻塞调用方（fail-soft）。
        """
        ctx = _resolve_daemon_context(thread_id)
        if ctx is None or "_skip_reason" in ctx:
            return

        session_id = _parse_session_id(thread_id)
        space_id = None
        if session_id:
            try:
                from apps.chat.conversation.models import ChatSession
                s = ChatSession.objects.filter(id=session_id).values('workspace_id').first()
                if s:
                    space_id = str(s['workspace_id']) if s['workspace_id'] else None
            except Exception:
                logger.debug("[DaemonCheckpoint] failed to resolve workspace_id for pre-approval", exc_info=True)

        def _do_pre_approval():
            label = ",".join((tool_names or [])[:3]) or "unknown"
            checkpoint_policy: Dict[str, Any] = {
                "kind": "pre_approval",
                "trigger": "pre_approval",
                "allowEmpty": True,
                "visibleInHistory": False,
            }
            logger.info(
                "[DaemonCheckpoint] pre-approval checkpoint: thread=%s tools=%s",
                thread_id, label,
            )
            result = _dispatch_checkpoint_action(
                thread_id=thread_id,
                action_type="checkpoint_commit",
                params={
                    "project_path": ctx["project_path"],
                    "policy": checkpoint_policy,
                },
                timeout=CHECKPOINT_COMMIT_TIMEOUT,
            )
            if not result:
                logger.warning(
                    "[DaemonCheckpoint] pre-approval checkpoint failed: no response, thread=%s",
                    thread_id,
                )
                return

            commit_hash = result.get("commit_hash")
            if not commit_hash:
                logger.warning(
                    "[DaemonCheckpoint] pre-approval checkpoint failed: no commit_hash, thread=%s",
                    thread_id,
                )
                return

            if space_id:
                _create_space_checkpoint(
                    space_id,
                    commit_hash,
                    agent_run_id="",
                    message_id=None,
                    trigger="pre_approval",
                    extra_metadata={"pending_tools": (tool_names or [])[:5]},
                    checkpoint_policy=checkpoint_policy,
                    session_id=session_id or "",
                )

            _push_checkpoint_success_event(
                thread_id, session_id, None, commit_hash,
            )
            logger.info(
                "[DaemonCheckpoint] pre-approval checkpoint created: hash=%s tools=%s",
                commit_hash[:8] if commit_hash else "none", label,
            )

        _run_in_background("pre_approval_checkpoint", _do_pre_approval)

    @staticmethod
    def maybe_checkpoint_restore(
        thread_id: str,
        commit_hash: str,
        *,
        move_head: bool = False,
    ) -> bool:
        """Rollback/Unrevert 时调用。对 Daemon 设备 dispatch checkpoint_restore。

        此操作是同步的（调用方需要知道结果来决定后续流程）。

        Returns:
            True 成功或非 Daemon 无需操作，False 失败（包括 Daemon 离线）。
        """
        if not commit_hash:
            return True

        try:
            ctx = _resolve_daemon_context(thread_id)
            if ctx is None:
                return True  # 非 Daemon 设备，无需操作
            if "_skip_reason" in ctx:
                logger.warning(
                    "[DaemonCheckpoint] checkpoint_restore skipped: %s (thread=%s)",
                    ctx["_skip_reason"], thread_id,
                )
                return False  # Daemon 设备但不可用（离线/无 workspace），文件无法恢复

            logger.info(
                "[DaemonCheckpoint] checkpoint_restore: thread=%s project=%s hash=%s",
                thread_id, ctx["project_path"], commit_hash,
            )
            result = _dispatch_checkpoint_action(
                thread_id=thread_id,
                action_type="checkpoint_restore",
                params={
                    "project_path": ctx["project_path"],
                    "commit_hash": commit_hash,
                    "move_head": move_head,
                },
                timeout=CHECKPOINT_RESTORE_TIMEOUT,
            )
            return result is not None
        except Exception:
            logger.warning(
                "[DaemonCheckpoint] maybe_checkpoint_restore failed: thread=%s hash=%s",
                thread_id, commit_hash, exc_info=True,
            )
            return False

    @staticmethod
    def maybe_file_history_rewind(
        thread_id: str,
        anchor_id: str,
    ) -> FileHistoryRewindOutcome:
        """Rollback 时的 per-file「本地文件恢复」——替换 shadow-git
        ``maybe_checkpoint_restore``（§3.9）。

        语义：``anchor_id = 那一轮顶层 agentRunId``。仅对 **Daemon 宿主会话**
        dispatch ``file_history_rewind`` action，让 Daemon 用 per-file 账本把
        anchor 那一轮**开始前** track 过的文件还原（只回退 Agent 改过的文件、
        不碰用户手改 / shell 改动，跟 git / 工作区根权限无关）。Electron 本地
        宿主由前端 ``fileHistoryIpc.rewind`` 负责，本方法返回 ``host='local'``
        让调用方据此把文件层交还前端、**不**在后端碰文件。

        同步操作（调用方需结果决定 ``file_restore_success`` + 宿主分流字段）。

        Returns:
            :class:`FileHistoryRewindOutcome`（host / success / failed_files / skip_reason）。
        """
        outcome = FileHistoryRewindOutcome()
        if not anchor_id:
            # FH-3：宿主分流**独立于 anchor 是否存在**。无锚点（目标那一轮还没
            # agent run / 老消息无 agent_run_id）时仍要先判宿主：
            #   - Daemon 宿主会话：即使 anchor=None 也回 host='daemon'（无可回退 →
            #     no-op、success 保持 True），别让前端在 daemon thread 上盲调本地
            #     rewind（本进程无该 thread 账本，盲调必抛错假警报）。
            #   - 非 Daemon（Electron 本地宿主）：host='local'，前端
            #     executeRollbackPipeline 自有「无锚点跳过」分支，不报错不 reset。
            try:
                ctx = _resolve_daemon_context(thread_id)
                if ctx is not None:
                    outcome.host = 'daemon'
            except Exception:
                logger.debug(
                    "[DaemonCheckpoint] file_history_rewind no-anchor host resolve failed: thread=%s",
                    thread_id, exc_info=True,
                )
            return outcome

        try:
            ctx = _resolve_daemon_context(thread_id)
            if ctx is None:
                # 非 Daemon 设备（Electron 本地宿主 / 无控制设备）：文件在本机，
                # 后端不碰，前端 fileHistoryIpc.rewind 负责。
                return outcome

            # 至此确定是 Daemon 宿主会话——文件层归后端，前端不应本地 rewind。
            outcome.host = 'daemon'
            if "_skip_reason" in ctx:
                # Daemon 设备但离线 / 无 workspace：后端无法回退；本进程前端也无该
                # thread 账本。标 host='daemon'（前端跳过本地 rewind）+ success=False
                # （fail-visible：文件未回退）。
                outcome.success = False
                outcome.skip_reason = ctx["_skip_reason"]
                logger.warning(
                    "[DaemonCheckpoint] file_history_rewind skipped: %s (thread=%s anchor=%s)",
                    ctx["_skip_reason"], thread_id, anchor_id,
                )
                return outcome

            logger.info(
                "[DaemonCheckpoint] file_history_rewind: thread=%s anchor=%s",
                thread_id, anchor_id,
            )
            result = _dispatch_checkpoint_action(
                thread_id=thread_id,
                action_type="file_history_rewind",
                # C-FH6：带 session 的 space_id，让 daemon path guard
                # （buildFileHistoryPathGuard 读 params._space_id）用真实 session 根
                # 解析 v3 snapshot.allowedPaths，而非回落 config.workspace_root 单根。
                # space_id 经 daemon action-bridge EF-05 fallback
                # （params.space_id → params._space_id）注入。
                params=_with_space_id({"anchor_id": anchor_id}, ctx.get("space_id")),
                timeout=CHECKPOINT_RESTORE_TIMEOUT,
            )
            if result is None:
                # dispatch 无响应 / handler 返回 success=false（如该 thread 在 Daemon
                # 上无 file-history 账本、path guard 拒绝）。
                outcome.success = False
                return outcome

            failed_files = result.get("failed_files") or []
            outcome.failed_files = list(failed_files)
            outcome.success = len(outcome.failed_files) == 0
            return outcome
        except Exception:
            logger.warning(
                "[DaemonCheckpoint] maybe_file_history_rewind failed: thread=%s anchor=%s",
                thread_id, anchor_id, exc_info=True,
            )
            # _resolve_daemon_context 自身吞异常返 None；异常基本只可能发生在
            # 已确定 host='daemon' 之后的 dispatch 链路上，标 success=False fail-visible。
            outcome.success = False
            return outcome

    @staticmethod
    def maybe_session_transcript_truncate(
        thread_id: str,
        keep_message_count: Optional[int],
        *,
        target_message_id: Optional[str] = None,
        target_role: Optional[str] = None,
        target_content: Optional[str] = None,
        target_occurrence_index: Optional[int] = None,
        mode: Optional[str] = None,
    ) -> TranscriptTruncateOutcome:
        """对话回退时的 transcript 截断——与 per-file rewind 同栈。

        仅对 **Daemon 宿主会话** dispatch ``session_transcript_truncate`` action，让
        Daemon 在远端 ``messages.jsonl`` 写 rewind 软标记（不删行，可 unrevert；物理
        截断推迟到发下一条消息）。Electron 本地宿主由前端 IPC 负责，本方法返回
        ``host='local'`` 让调用方把 transcript 层交还前端。

        ``keep_message_count`` = 重建后保留的 user/assistant 消息条数（对齐
        ``ChatSession.revert_state_index`` / ``ConversationState.messages_json`` 长度）。

        同步操作（调用方据结果决定 fail-visible）。
        """
        outcome = TranscriptTruncateOutcome()
        try:
            ctx = _resolve_daemon_context(thread_id)
            if ctx is None:
                # 非 Daemon（Electron 本地宿主）：transcript 在本机，后端不碰。
                return outcome

            outcome.host = 'daemon'
            if "_skip_reason" in ctx:
                outcome.success = False
                outcome.skip_reason = ctx["_skip_reason"]
                logger.warning(
                    "[DaemonCheckpoint] session_transcript_truncate skipped: %s (thread=%s)",
                    ctx["_skip_reason"], thread_id,
                )
                return outcome

            params: Dict[str, Any] = {}
            if keep_message_count is not None:
                params["keep_message_count"] = int(keep_message_count)
            if target_message_id:
                params["target_message_id"] = str(target_message_id)
            if target_role:
                params["target_role"] = target_role
            if target_content:
                params["target_content"] = target_content
            if target_occurrence_index is not None:
                params["target_occurrence_index"] = int(target_occurrence_index)
            if mode:
                params["mode"] = mode
            logger.info(
                "[DaemonCheckpoint] session_transcript_truncate: thread=%s keep=%s target=%s",
                thread_id, keep_message_count, target_message_id,
            )
            result = _dispatch_checkpoint_action(
                thread_id=thread_id,
                action_type="session_transcript_truncate",
                params=_with_space_id(params, ctx.get("space_id")),
                timeout=CHECKPOINT_RESTORE_TIMEOUT,
            )
            outcome.success = result is not None
            if result is not None:
                outcome.applied = bool(result.get("applied"))
            return outcome
        except Exception:
            logger.warning(
                "[DaemonCheckpoint] maybe_session_transcript_truncate failed: thread=%s",
                thread_id, exc_info=True,
            )
            outcome.success = False
            return outcome

    @staticmethod
    def maybe_session_transcript_unrevert(thread_id: str) -> TranscriptTruncateOutcome:
        """对话回退撤销（unrevert）时移除 Daemon 远端 transcript 的 rewind 软标记。

        仅对 Daemon 宿主会话 dispatch ``session_transcript_unrevert``；Electron 本地
        宿主由前端 IPC 负责，返回 ``host='local'``。
        """
        outcome = TranscriptTruncateOutcome()
        try:
            ctx = _resolve_daemon_context(thread_id)
            if ctx is None:
                return outcome
            outcome.host = 'daemon'
            if "_skip_reason" in ctx:
                outcome.success = False
                outcome.skip_reason = ctx["_skip_reason"]
                return outcome
            result = _dispatch_checkpoint_action(
                thread_id=thread_id,
                action_type="session_transcript_unrevert",
                params=_with_space_id({}, ctx.get("space_id")),
                timeout=CHECKPOINT_RESTORE_TIMEOUT,
            )
            outcome.success = result is not None
            return outcome
        except Exception:
            logger.warning(
                "[DaemonCheckpoint] maybe_session_transcript_unrevert failed: thread=%s",
                thread_id, exc_info=True,
            )
            outcome.success = False
            return outcome

    @staticmethod
    def maybe_file_history_preview(
        thread_id: str,
        anchor_id: str,
        space_id: Optional[str] = None,
    ) -> FileHistoryPreviewOutcome:
        """Rollback 预览的 per-file「将恢复哪些文件」——FH-4。

        照 :meth:`maybe_file_history_rewind` 模板，但**只读不写**：仅对 Daemon 宿主
        会话 dispatch ``file_history_preview`` action（daemon 侧已实现），取 anchor 那
        一轮真实 track 过、回退将写/删的文件相对路径清单（已过 daemon path guard），
        让 RewindPreviewPanel 在 Daemon 宿主上也能出真 per-file 文件清单，替代失真的
        shadow-git ``checkpoint_hash`` 推断。

        宿主分流（与 rewind 一致，FH-3 同款独立于 anchor）：
          - 非 Daemon（Electron 本地宿主 / 无控制设备）：返回 ``host='local'``、
            ``affected_paths=[]``——preview 由前端 ``fileHistoryIpc.getAffectedPaths``
            本地算，后端不 dispatch。
          - Daemon 宿主：返回 ``host='daemon'`` + 真实 ``affected_paths``；离线 / 无
            workspace 时 ``host='daemon'`` + ``success=False`` + ``skip_reason``（前端据
            host='daemon' 跳过本地探测，清单为空时回退 shadow-git diff 兜底）。

        ``anchor_id`` 为空（目标那一轮还没 agent run / 老消息无 agent_run_id）时仍判
        宿主：Daemon 宿主回 ``host='daemon'``、``affected_paths=[]``（无可预览，非失败）。

        ``space_id``（C-FH6）：优先用调用方显式传入（rollback preview 路径有 session），
        缺省回退 ctx 解析值；经 dispatch 透传给 daemon path guard。
        """
        outcome = FileHistoryPreviewOutcome()
        try:
            ctx = _resolve_daemon_context(thread_id)
            if ctx is None:
                # 非 Daemon 设备：preview 交还前端本地能力，后端不 dispatch。
                return outcome

            # 至此确定是 Daemon 宿主会话——文件预览归后端。
            outcome.host = 'daemon'
            if "_skip_reason" in ctx:
                # Daemon 设备但离线 / 无 workspace：拿不到清单。标 host='daemon'
                # （前端据此跳过本地探测）+ success=False + skip_reason。
                outcome.success = False
                outcome.skip_reason = ctx["_skip_reason"]
                logger.warning(
                    "[DaemonCheckpoint] file_history_preview skipped: %s (thread=%s anchor=%s)",
                    ctx["_skip_reason"], thread_id, anchor_id,
                )
                return outcome

            if not anchor_id:
                # Daemon 宿主但无锚点：无可预览（非失败）。affected_paths 留空，
                # host='daemon' 让前端不误用本地探测。
                return outcome

            logger.info(
                "[DaemonCheckpoint] file_history_preview: thread=%s anchor=%s",
                thread_id, anchor_id,
            )
            result = _dispatch_checkpoint_action(
                thread_id=thread_id,
                action_type="file_history_preview",
                # C-FH6：与 rewind 同款带 space_id（显式优先，缺省回退 ctx），
                # 让 daemon path guard 用真实 session 根校验受影响路径。
                params=_with_space_id(
                    {"anchor_id": anchor_id},
                    space_id or ctx.get("space_id"),
                ),
                timeout=CHECKPOINT_RESTORE_TIMEOUT,
            )
            if result is None:
                # dispatch 无响应 / handler 返回 success=false（如该 thread 在 Daemon
                # 上无 file-history 账本、path guard 拒绝受影响路径）。
                outcome.success = False
                return outcome

            affected_paths = result.get("affected_paths") or []
            outcome.affected_paths = list(affected_paths)
            return outcome
        except Exception:
            logger.warning(
                "[DaemonCheckpoint] maybe_file_history_preview failed: thread=%s anchor=%s",
                thread_id, anchor_id, exc_info=True,
            )
            # 与 rewind 同款：异常基本只可能发生在已确定 host='daemon' 之后的 dispatch
            # 链路上，标 success=False（前端据 host='daemon' + 空清单回退 shadow-git diff）。
            outcome.success = False
            return outcome

    @staticmethod
    def maybe_checkpoint_restore_on_error(
        thread_id: str,
        user_id: Optional[str] = None,
        anchor_run_id: Optional[str] = None,
    ) -> bool:
        """Agent 异常路径调用。把失败这轮 Agent 改过的文件恢复到该轮**开始前**。

        per-file 迁移（CO-1）：**不再走 shadow-git ``git reset --hard``**。旧实现对
        整个工作区硬重置到上一轮 checkpoint，会把本轮**用户手改 / shell 改动**的文件
        一并冲掉（与 per-file「只回退 Agent 通过文件工具改过的文件」相悖，在 Daemon
        宿主上是数据风险）。现改为 ``maybe_file_history_rewind(anchor_run_id)``：只回退
        该 anchor 那一轮 track 过的文件，不碰手改 / shell、与 git / 工作区根权限无关。

        ``anchor_run_id = 失败这轮顶层 agentRunId``（由 result_finalizer 传入：
        stream-error 路径用当前 ``run_id``，exception 路径用 ``_lookup_latest_run_id``）。
        为空时（极端：拿不到失败轮 run_id）**跳过文件恢复、只记 warning、绝不 reset**
        （沿用阶段 0 止血「无锚点不 reset」原则，杜绝整仓 reset 数据地雷）。

        *user_id* 形参保留以兼容旧调用方；per-file 鉴权由 daemon 侧 action-bridge 的
        envelope thread 认证 + path guard 负责，此处不再据它查 checkpoint。

        仅 Daemon 宿主会话在后端恢复；Electron 本地宿主 error 自愈由前端
        ``fileHistoryIpc`` 负责（``maybe_file_history_rewind`` 对非 Daemon 返
        ``host='local'``，本方法据此返回 True = 后端无需恢复）。

        Returns:
            True  — per-file 恢复成功 / 非 Daemon 无需恢复 / 无锚点跳过（无需 reset）
            False — Daemon 宿主下 per-file rewind 失败（文件可能仍处失败状态，fail-visible）
        """
        del user_id  # per-file 路径不再据此查 checkpoint；保留形参仅为兼容旧调用方签名
        _baseline_by_thread.pop(thread_id, None)
        _baseline_generation.pop(thread_id, None)
        try:
            if not anchor_run_id:
                # 无锚点（拿不到失败轮 run_id）：跳过文件恢复，**绝不 reset**（沿用阶段 0
                # 止血原则）。只记 warning，让日志可见文件可能停留在失败 Agent run 改过的状态。
                logger.warning(
                    "[DaemonCheckpoint] restore_on_error: no anchor run_id (thread=%s). "
                    "Skipping file restore (will NOT reset). Files may remain in the modified "
                    "state left by the failed Agent run.",
                    thread_id,
                )
                return True

            # per-file rewind（替代 shadow-git reset --hard）：只回退该 anchor 那一轮
            # Agent track 过的文件，不碰用户手改 / shell。宿主分流（Daemon vs 本地）+
            # skip_reason（Daemon 离线/无 workspace）由 maybe_file_history_rewind 内部判定。
            outcome = DaemonCheckpointService.maybe_file_history_rewind(thread_id, anchor_run_id)
            if outcome.host != 'daemon':
                # 非 Daemon 宿主（Electron 本地）：文件在本机，error 自愈由前端负责，
                # 后端无需恢复（与旧 ``ctx is None → True`` 语义一致）。
                return True
            if not outcome.success:
                logger.error(
                    "[DaemonCheckpoint] restore_on_error per-file rewind failed: "
                    "thread=%s anchor=%s failed_files=%s skip=%s",
                    thread_id, anchor_run_id, outcome.failed_files, outcome.skip_reason,
                )
                _push_checkpoint_restore_failed_event(
                    thread_id,
                    reason="file_history_rewind_failed",
                    commit_hash=anchor_run_id,
                )
            return outcome.success
        except Exception:
            logger.error(
                "[DaemonCheckpoint] maybe_checkpoint_restore_on_error failed: thread=%s",
                thread_id, exc_info=True,
            )
            _push_checkpoint_restore_failed_event(
                thread_id,
                reason="restore_exception",
                commit_hash=anchor_run_id or "",
            )
            return False

    @staticmethod
    def ensure_daemon_snapshot_hash(session) -> Optional[str]:
        """在 rollback 时，确保 Daemon 设备有 revert_snapshot_hash（用于后续 unrevert）。

        Electron 由前端传入 safety_snapshot_hash（回退前文件快照）；
        Daemon 无前端，后端自动查找当前最新的 checkpoint_hash
        （代表回退前的文件系统状态），作为 unrevert 时的恢复目标。

        Returns:
            用于 unrevert 的 snapshot_hash，或 None
        """
        try:
            existing = session.revert_snapshot_hash
            # bugbot 评审  high：前端 createSafetySnapshot 只判本机 file-history IPC
            # 是否可用、不判会话宿主，会给 Daemon 会话也写入 per-file ``safety:`` 前缀 ref。
            # 但 Daemon unrevert 走 shadow-git，``safety:`` ref 是非法目标，maybe_checkpoint_restore
            # 会拿到坏 ref、远端文件无法还原。故：非 safety: ref 直接沿用；safety: ref 视为
            # 「未设」继续往下用 shadow-git hash 覆盖（仅当下方确认是 Daemon 会话）。
            is_per_file_safety = isinstance(existing, str) and existing.startswith('safety:')
            if existing and not is_per_file_safety:
                return existing

            thread_id = getattr(session, 'thread_id', None)
            if not thread_id:
                return existing

            ctx = _resolve_daemon_context(thread_id)
            if ctx is None or "_skip_reason" in ctx:
                # 非 Daemon（Electron 本地宿主）：per-file safety: ref 是合法的本地锚点，
                # 原样保留（前端 unrevert 会用它 fileHistoryIpc.rewind 还原）。
                return existing

            from apps.chat.conversation.models import ChatMessage
            pre_rollback_hash = (
                ChatMessage.objects
                .filter(session=session, role='assistant')
                .exclude(checkpoint_hash__isnull=True)
                .exclude(checkpoint_hash='')
                .order_by('-created_at', '-id')
                .values_list('checkpoint_hash', flat=True)
                .first()
            )
            if not pre_rollback_hash:
                return None

            logger.info(
                "[DaemonCheckpoint] auto-filling revert_snapshot_hash for daemon: "
                "session=%s hash=%s",
                session.id, pre_rollback_hash,
            )
            # CP-OBS-3: 用 atomic + conditional update 防止并发 rollback 互相覆写。
            # ：Daemon 会话若被前端误写 per-file ``safety:`` ref，这里用真实
            # shadow-git hash 覆盖（条件放宽为 isnull 或 safety: 前缀）。
            from django.db import transaction
            from django.db.models import Q
            from django.utils import timezone
            with transaction.atomic():
                updated_count = type(session).objects.filter(
                    Q(revert_snapshot_hash__isnull=True)
                    | Q(revert_snapshot_hash__startswith='safety:'),
                    id=session.id,
                ).update(
                    revert_snapshot_hash=pre_rollback_hash,
                    updated_at=timezone.now(),
                )
            if updated_count:
                session.revert_snapshot_hash = pre_rollback_hash
            else:
                # 并发写入时另一方先写成功，刷新内存副本
                session.refresh_from_db(fields=['revert_snapshot_hash'])
            return session.revert_snapshot_hash
        except Exception:
            logger.warning(
                "[DaemonCheckpoint] ensure_daemon_snapshot_hash failed: session=%s",
                session.id, exc_info=True,
            )
            return None
