"""
SubtaskRun Notification API

PRD 06 §5.4.2 / §5.5：为 proactive-poller（Electron Main 侧）提供
pending 子任务查询、crashed 扫描、mark-notified 标记等能力。

路由前缀：``/services/agent-engine``（由 ``urls_deferred.py`` 注册），
最终 URL 形如 ``/api/services/agent-engine/subtask-runs/pending/`` 等。

认证：JWTAuth（``request.auth`` 返回 User 实例）。
"""

import logging
from datetime import timedelta

from django.db import transaction
from django.utils import timezone
from ninja import Router, Schema
from pydantic import Field
from typing import List, Optional

from apps.users.auth.api import jwt_auth
from apps.services.common.api_errors import raise_unauthorized, raise_bad_request
from apps.services.agent_engine.models import SubtaskRun
from apps.services.agent_engine.services.run_host_lease_service import (
    RunHostLeaseService,
)

logger = logging.getLogger(__name__)

router = Router(tags=["SubtaskRun Notifications"])

TERMINAL_STATUSES = ('completed', 'failed', 'error', 'crashed')
ACTIVE_STATUSES = ('pending', 'running', 'queued')


def _resolve_user_id(request) -> str:
    """从 JWTAuth 提取 user_id 字符串（AGENTS.md：request.auth 是 User 实例）。"""
    return str(request.auth.id)


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class ScanCrashedIn(Schema):
    stale_threshold_minutes: int = Field(5, ge=1, le=60)


class MarkNotifiedIn(Schema):
    run_ids: List[str] = Field(..., min_length=1, max_length=200)


class RunHostLeaseClaimIn(Schema):
    run_id: str = Field(..., max_length=64)
    host_id: str = Field(..., min_length=1, max_length=128)
    lease_seconds: Optional[int] = Field(None, ge=15, le=300)


class RunHostLeaseHeartbeatIn(RunHostLeaseClaimIn):
    lease_token: str = Field(..., max_length=64)


class RunHostLeaseReconcileItem(Schema):
    run_id: str = Field(..., max_length=64)
    lease_token: Optional[str] = Field(None, max_length=64)


class RunHostLeaseReconcileIn(Schema):
    host_id: str = Field(..., min_length=1, max_length=128)
    active_runs: List[RunHostLeaseReconcileItem] = Field(
        default_factory=list,
        max_length=200,
    )
    lease_seconds: Optional[int] = Field(None, ge=15, le=300)


class RunHostLeaseSweepIn(Schema):
    limit: int = Field(200, ge=1, le=500)


class LocalSessionRunDispatchIn(Schema):
    thread_id: str = Field(..., min_length=1, max_length=128)
    run_id: str = Field(..., min_length=1, max_length=64)
    task_id: str = Field(..., min_length=1, max_length=128)
    organization_id: Optional[str] = Field(None, max_length=64)
    host_id: str = Field(..., min_length=1, max_length=128)
    lease_seconds: Optional[int] = Field(None, ge=15, le=300)


# ---------------------------------------------------------------------------
# Run Host leases
# ---------------------------------------------------------------------------

@router.post("/run-host-leases/claim/", auth=jwt_auth)
def claim_run_host_lease(request, payload: RunHostLeaseClaimIn):
    if not request.auth:
        raise_unauthorized()
    return RunHostLeaseService.claim(
        run_id=payload.run_id,
        host_id=payload.host_id,
        user_id=str(request.auth.id),
        lease_seconds=payload.lease_seconds,
    )


@router.post("/run-host-leases/heartbeat/", auth=jwt_auth)
def heartbeat_run_host_lease(request, payload: RunHostLeaseHeartbeatIn):
    if not request.auth:
        raise_unauthorized()
    return RunHostLeaseService.heartbeat(
        run_id=payload.run_id,
        host_id=payload.host_id,
        lease_token=payload.lease_token,
        user_id=str(request.auth.id),
        lease_seconds=payload.lease_seconds,
    )


@router.post("/run-host-leases/reconcile/", auth=jwt_auth)
def reconcile_run_host_leases(request, payload: RunHostLeaseReconcileIn):
    if not request.auth:
        raise_unauthorized()
    return RunHostLeaseService.reconcile(
        host_id=payload.host_id,
        user_id=str(request.auth.id),
        active_runs=[item.model_dump() for item in payload.active_runs],
        lease_seconds=payload.lease_seconds,
    )


@router.post("/run-host-leases/sweep-expired/", auth=jwt_auth)
def sweep_expired_run_host_leases(request, payload: RunHostLeaseSweepIn):
    """收敛当前用户的到期租约；后台任务可直接调用全局 service。"""
    if not request.auth:
        raise_unauthorized()
    return {
        "expired_run_ids": RunHostLeaseService.expire_due(
            limit=payload.limit,
            user_id=str(request.auth.id),
        )
    }


# ---------------------------------------------------------------------------
# Electron local session run acceptance
# ---------------------------------------------------------------------------

@router.post("/session-runs/accept-local/", auth=jwt_auth)
def accept_local_session_run(request, payload: LocalSessionRunDispatchIn):
    """让 Electron 本机 IPC 与移动端转发共用服务端运行事实。"""
    if not request.auth:
        raise_unauthorized()

    from apps.services.agent_engine.services.session_run_state_service import (
        SessionRunStateService,
        serialize_run_state,
    )

    with transaction.atomic():
        run = SessionRunStateService.accept_local_dispatch(
            thread_id=payload.thread_id,
            run_id=payload.run_id,
            task_id=payload.task_id,
            user_id=str(request.auth.id),
            organization_id=payload.organization_id,
        )
        if run is None:
            raise_bad_request("会话或 run_id 无效")
        lease = RunHostLeaseService.claim(
            run_id=str(run.run_id),
            host_id=payload.host_id,
            user_id=str(request.auth.id),
            lease_seconds=payload.lease_seconds,
            idempotent_same_host=True,
        )
        if lease.get("outcome") != "claimed":
            raise_bad_request(
                f"run host lease claim failed: {lease.get('outcome', 'unknown')}"
            )

        from apps.services.agent_engine.models import SessionRunProjection

        projection = SessionRunProjection.objects.filter(
            session_id=run.session_id,
        ).first()
        return {
            "accepted": True,
            "sequence": run.sequence,
            "run_state": serialize_run_state(projection),
            **lease,
        }


# ---------------------------------------------------------------------------
# GET subtask-runs/pending/?parent_thread_id=xxx
# ---------------------------------------------------------------------------

@router.get("/subtask-runs/pending/", auth=jwt_auth)
def list_pending(request, parent_thread_id: str):
    """查询 notified_at IS NULL 且终态的 SubtaskRun（pending 汇报）。"""
    user = request.auth
    if not user:
        raise_unauthorized()

    uid = _resolve_user_id(request)
    qs = SubtaskRun.objects.filter(
        parent_thread_id=parent_thread_id,
        user_id=uid,
        status__in=TERMINAL_STATUSES,
        notified_at__isnull=True,
    ).order_by('ended_at')

    items = []
    for run in qs[:100]:
        items.append({
            'run_id': str(run.subagent_run_id),
            'display_name': run.label or run.agent_name or str(run.subagent_run_id)[:8],
            'short_id': str(run.subagent_run_id)[:4],
            'status': run.status,
            'task': run.task or '',
            'summary': run.result_summary or '',
            'error_message': run.error or '',
            'initiator_speaker_id': run.initiator_speaker_id or '',
            'completed_at': run.ended_at.isoformat() if run.ended_at else None,
        })

    return {
        'pending_count': len(items),
        'thread_ids': [parent_thread_id] if items else [],
        'items': items,
    }


# ---------------------------------------------------------------------------
# POST subtask-runs/scan-crashed/
# ---------------------------------------------------------------------------

@router.post("/subtask-runs/scan-crashed/", auth=jwt_auth)
def scan_crashed(request, payload: ScanCrashedIn, organization_id: str = ""):
    """扫描 status='running' 且超时的 SubtaskRun，标记为 crashed。

    先 UPDATE 再查被修改的行，避免 TOCTOU 竞态。
    """
    user = request.auth
    if not user:
        raise_unauthorized()

    uid = _resolve_user_id(request)
    cutoff = timezone.now() - timedelta(minutes=payload.stale_threshold_minutes)

    base_filter = dict(user_id=uid, status='running', updated_at__lt=cutoff)
    if organization_id:
        base_filter['organization_id'] = organization_id

    stale_pks = list(
        SubtaskRun.objects.filter(**base_filter).values_list('subagent_run_id', flat=True)
    )

    if not stale_pks:
        return {'crashed_runs': []}

    affected = SubtaskRun.objects.filter(
        subagent_run_id__in=stale_pks,
        status='running',
    ).update(status='crashed')
    logger.info('scan_crashed: marked %d SubtaskRun(s) as crashed', affected)

    crashed_runs = list(
        SubtaskRun.objects.filter(
            subagent_run_id__in=stale_pks,
            status='crashed',
        ).values('subagent_run_id', 'child_thread_id', 'parent_thread_id', 'updated_at')
    )

    return {
        'crashed_runs': [
            {
                'run_id': str(r['subagent_run_id']),
                'thread_id': r['child_thread_id'],
                'parent_thread_id': r['parent_thread_id'],
                'updated_at': r['updated_at'].isoformat() if r['updated_at'] else None,
            }
            for r in crashed_runs
        ],
    }


# ---------------------------------------------------------------------------
# GET subtask-runs/pending-threads/
# ---------------------------------------------------------------------------

@router.get("/subtask-runs/pending-threads/", auth=jwt_auth)
def pending_threads(request, organization_id: str = ""):
    """查询当前用户所有有 pending 汇报的 parent_thread_id（去重）。"""
    user = request.auth
    if not user:
        raise_unauthorized()

    uid = _resolve_user_id(request)
    base_filter = dict(user_id=uid, status__in=TERMINAL_STATUSES, notified_at__isnull=True)
    if organization_id:
        base_filter['organization_id'] = organization_id

    thread_ids = list(
        SubtaskRun.objects.filter(**base_filter)
        .values_list('parent_thread_id', flat=True).distinct()[:500]
    )

    return {'thread_ids': thread_ids}


# ---------------------------------------------------------------------------
# GET subtask-runs/active-count/
# ---------------------------------------------------------------------------

@router.get("/subtask-runs/active-count/", auth=jwt_auth)
def active_count(request, organization_id: str = ""):
    """查询当前用户活跃（pending/running/queued）子任务数量。"""
    user = request.auth
    if not user:
        raise_unauthorized()

    uid = _resolve_user_id(request)
    base_filter = dict(user_id=uid, status__in=ACTIVE_STATUSES)
    if organization_id:
        base_filter['organization_id'] = organization_id

    count = SubtaskRun.objects.filter(**base_filter).count()

    return {'active_count': count}


# ---------------------------------------------------------------------------
# POST subtask-runs/mark-notified/
# A-3 修复：用原子 UPDATE … WHERE notified_at IS NULL 保证并发安全。
# ---------------------------------------------------------------------------

@router.post("/subtask-runs/mark-notified/", auth=jwt_auth)
def mark_notified(request, payload: MarkNotifiedIn):
    """将指定 SubtaskRun 标记为已通知（原子操作，幂等安全）。

    返回 ``affected`` 数量——调用方据此判断是否抢到了标记权。
    """
    user = request.auth
    if not user:
        raise_unauthorized()

    uid = _resolve_user_id(request)
    affected = SubtaskRun.objects.filter(
        subagent_run_id__in=payload.run_ids,
        user_id=uid,
        notified_at__isnull=True,
    ).update(notified_at=timezone.now())

    return {'affected': affected}
