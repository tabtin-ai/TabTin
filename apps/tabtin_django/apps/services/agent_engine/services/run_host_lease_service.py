"""Run Host 租约、fencing 与硬断线收敛。"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from typing import Any, Iterable

from django.db import transaction
from django.utils import timezone

from apps.chat.conversation.models import ChatSession
from apps.services.agent_engine.models import (
    ExecutionRun,
    RunHostLease,
    SessionRunProjection,
)
from apps.services.agent_engine.services.session_run_state_service import (
    ACTIVE_STATUSES,
    SessionRunStateService,
)

DEFAULT_LEASE_SECONDS = 90
MIN_LEASE_SECONDS = 15
MAX_LEASE_SECONDS = 300
HOST_LOST_ERROR_CLASS = "HOST_LOST"
LEASE_EXPIRED_STOP_REASON = "lease_expired"
FENCE_REASON_LEASE_EXPIRED = LEASE_EXPIRED_STOP_REASON
FENCE_REASON_RELEASED = "released"
FENCE_REASON_OWNERSHIP_TRANSFERRED = "ownership_transferred"
FENCE_REASON_PROJECTION_MISMATCH = "projection_mismatch"
FENCE_REASON_HELD = "held"


class RunHostLeaseService:
    """所有写路径严格按 Session → Run → Lease → Projection 加锁。"""

    @staticmethod
    def _projection_tracks_active_run(
        projection: SessionRunProjection | None,
        run: ExecutionRun,
    ) -> bool:
        if projection is None or run.status not in ACTIVE_STATUSES:
            return False
        if (
            projection.current_run_id == run.run_id
            and projection.sequence == run.sequence
        ):
            return True
        # 同一会话允许 Host 同时持有尚未轮到执行的排队 run。它仍需 heartbeat，
        # Host 失联时才能把队列项收口，而不是永久遗留 queued。
        return (
            run.status == ExecutionRun.Status.QUEUED
            and run.sequence > projection.sequence
        )

    @staticmethod
    def _normalize_run_id(run_id: str) -> uuid.UUID | None:
        try:
            return uuid.UUID(str(run_id))
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _lease_seconds(value: int | None) -> int:
        if value is None:
            return DEFAULT_LEASE_SECONDS
        return max(MIN_LEASE_SECONDS, min(MAX_LEASE_SECONDS, int(value)))

    @staticmethod
    def _serialize(lease: RunHostLease, *, outcome: str) -> dict[str, Any]:
        return {
            "outcome": outcome,
            "run_id": str(lease.run_id),
            "host_id": lease.host_id,
            "lease_token": str(lease.lease_token),
            "generation": lease.generation,
            "lease_expires_at": lease.lease_expires_at.isoformat(),
        }

    @staticmethod
    def _reject(
        outcome: str,
        *,
        reason: str,
        run_id: uuid.UUID | str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"outcome": outcome, "reason": reason}
        if run_id is not None:
            payload["run_id"] = str(run_id)
        return payload

    @classmethod
    def claim(
        cls,
        *,
        run_id: str,
        host_id: str,
        user_id: str,
        lease_seconds: int | None = None,
        now: datetime | None = None,
        idempotent_same_host: bool = False,
    ) -> dict[str, Any]:
        normalized = cls._normalize_run_id(run_id)
        host_id = str(host_id or "").strip()
        if normalized is None or not host_id:
            return {"outcome": "invalid"}
        session_id = (
            ExecutionRun.objects.filter(run_id=normalized)
            .values_list("session_id", flat=True)
            .first()
        )
        if not session_id:
            return {"outcome": "not_found"}

        now = now or timezone.now()
        expires_at = now + timedelta(seconds=cls._lease_seconds(lease_seconds))
        with transaction.atomic():
            session = (
                ChatSession.objects.select_for_update()
                .filter(pk=session_id)
                .only("id")
                .first()
            )
            if session is None:
                return {"outcome": "not_found"}
            run = (
                ExecutionRun.objects.select_for_update()
                .filter(run_id=normalized, session_id=session_id)
                .first()
            )
            if run is None or str(run.user_id or "") != str(user_id):
                return {"outcome": "not_found"}

            lease = (
                RunHostLease.objects.select_for_update()
                .filter(run_id=normalized)
                .first()
            )
            # 新行必须在 Projection 锁之前创建，保持全局锁顺序。
            if lease is None:
                lease = RunHostLease.objects.create(
                    run=run,
                    host_id=host_id,
                    claimed_at=now,
                    last_heartbeat_at=now,
                    lease_expires_at=expires_at,
                )
                created = True
            else:
                created = False

            projection = (
                SessionRunProjection.objects.select_for_update()
                .filter(session_id=session_id)
                .first()
            )
            if not cls._projection_tracks_active_run(projection, run):
                if created:
                    lease.delete()
                return cls._reject(
                    "fenced",
                    reason=FENCE_REASON_PROJECTION_MISMATCH,
                    run_id=normalized,
                )

            # 未过期的别人持有不能抢。过期或 lease_expired 释放后只许原 host
            # 领回同一轮；其它 host 仍 held，避免 grace 窗口双执行。
            if not created and lease.released_at is not None:
                if lease.release_reason != LEASE_EXPIRED_STOP_REASON:
                    return cls._reject(
                        "fenced",
                        reason=FENCE_REASON_RELEASED,
                        run_id=normalized,
                    )
                if lease.host_id != host_id:
                    return cls._reject(
                        "held",
                        reason=FENCE_REASON_HELD,
                        run_id=normalized,
                    )

            owned_by_other_live_host = (
                lease.released_at is None
                and lease.host_id != host_id
            )
            if owned_by_other_live_host:
                return cls._reject(
                    "held",
                    reason=FENCE_REASON_HELD,
                    run_id=normalized,
                )
            if (
                idempotent_same_host
                and not created
                and lease.released_at is None
                and lease.lease_expires_at > now
                and lease.host_id == host_id
            ):
                # accept-local 的重试仍属于同一逻辑 dispatch；并发请求按行锁
                # 串行后必须拿到同一 fencing token。真正的 Host 重连继续走
                # 普通 claim/reconcile，仍会旋转 generation fencing 旧进程。
                lease.last_heartbeat_at = now
                lease.lease_expires_at = expires_at
                lease.save(
                    update_fields=[
                        "last_heartbeat_at",
                        "lease_expires_at",
                        "updated_at",
                    ]
                )
                return cls._serialize(lease, outcome="claimed")
            # claim 是新的 fencing epoch；同一 host 重连也旋转 token，让旧进程
            # 即使稍后恢复网络也不能继续 heartbeat。
            if not created:
                lease.lease_token = uuid.uuid4()
                lease.generation += 1
                lease.claimed_at = now
            lease.host_id = host_id
            lease.last_heartbeat_at = now
            lease.lease_expires_at = expires_at
            lease.released_at = None
            lease.release_reason = None
            lease.save(
                update_fields=[
                    "host_id",
                    "lease_token",
                    "generation",
                    "claimed_at",
                    "last_heartbeat_at",
                    "lease_expires_at",
                    "released_at",
                    "release_reason",
                    "updated_at",
                ]
            )
            return cls._serialize(lease, outcome="claimed")

    @classmethod
    def heartbeat(
        cls,
        *,
        run_id: str,
        host_id: str,
        lease_token: str,
        user_id: str,
        lease_seconds: int | None = None,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        normalized = cls._normalize_run_id(run_id)
        host_id = str(host_id or "").strip()
        try:
            normalized_token = uuid.UUID(str(lease_token))
        except (TypeError, ValueError):
            return cls._reject(
                "fenced",
                reason=FENCE_REASON_OWNERSHIP_TRANSFERRED,
                run_id=normalized,
            )
        if normalized is None or not host_id:
            return {"outcome": "invalid"}
        session_id = (
            ExecutionRun.objects.filter(run_id=normalized)
            .values_list("session_id", flat=True)
            .first()
        )
        if not session_id:
            return {"outcome": "not_found"}

        now = now or timezone.now()
        expires_at = now + timedelta(seconds=cls._lease_seconds(lease_seconds))
        with transaction.atomic():
            session = (
                ChatSession.objects.select_for_update()
                .filter(pk=session_id)
                .only("id")
                .first()
            )
            if session is None:
                return {"outcome": "not_found"}
            run = (
                ExecutionRun.objects.select_for_update()
                .filter(run_id=normalized, session_id=session_id)
                .first()
            )
            if run is None or str(run.user_id or "") != str(user_id):
                return {"outcome": "not_found"}
            lease = (
                RunHostLease.objects.select_for_update()
                .filter(run_id=normalized)
                .first()
            )
            projection = (
                SessionRunProjection.objects.select_for_update()
                .filter(session_id=session_id)
                .first()
            )
            if lease is None:
                return cls._reject(
                    "fenced",
                    reason=FENCE_REASON_PROJECTION_MISMATCH,
                    run_id=normalized,
                )
            if lease.released_at is not None:
                reason = (
                    FENCE_REASON_LEASE_EXPIRED
                    if lease.release_reason == LEASE_EXPIRED_STOP_REASON
                    else FENCE_REASON_RELEASED
                )
                return cls._reject("fenced", reason=reason, run_id=normalized)
            if lease.lease_token != normalized_token or lease.host_id != host_id:
                return cls._reject(
                    "fenced",
                    reason=FENCE_REASON_OWNERSHIP_TRANSFERRED,
                    run_id=normalized,
                )
            if lease.lease_expires_at <= now:
                return cls._reject(
                    "fenced",
                    reason=FENCE_REASON_LEASE_EXPIRED,
                    run_id=normalized,
                )
            if not cls._projection_tracks_active_run(projection, run):
                return cls._reject(
                    "fenced",
                    reason=FENCE_REASON_PROJECTION_MISMATCH,
                    run_id=normalized,
                )

            lease.last_heartbeat_at = now
            lease.lease_expires_at = expires_at
            lease.save(
                update_fields=[
                    "last_heartbeat_at",
                    "lease_expires_at",
                    "updated_at",
                ]
            )
            return cls._serialize(lease, outcome="renewed")

    @classmethod
    def expire_due(
        cls,
        *,
        now: datetime | None = None,
        limit: int = 200,
        user_id: str | None = None,
    ) -> list[str]:
        """只扫描显式 lease；没有 lease 的旧客户端永远不会进入候选集。"""
        now = now or timezone.now()
        scan_limit = max(1, limit)
        live_expired = RunHostLease.objects.filter(
            released_at__isnull=True,
            lease_expires_at__lte=now,
        )
        grace_before = now - timedelta(seconds=DEFAULT_LEASE_SECONDS)
        stale_released = RunHostLease.objects.filter(
            released_at__isnull=False,
            release_reason=LEASE_EXPIRED_STOP_REASON,
            released_at__lte=grace_before,
            run__status__in=ACTIVE_STATUSES,
        )
        if user_id is not None:
            live_expired = live_expired.filter(run__user_id=str(user_id))
            stale_released = stale_released.filter(run__user_id=str(user_id))
        run_ids: list[uuid.UUID] = []
        seen: set[uuid.UUID] = set()
        for run_id in live_expired.order_by("lease_expires_at").values_list(
            "run_id", flat=True
        )[:scan_limit]:
            if run_id in seen:
                continue
            seen.add(run_id)
            run_ids.append(run_id)
        remaining = scan_limit - len(run_ids)
        if remaining > 0:
            for run_id in stale_released.order_by("released_at").values_list(
                "run_id", flat=True
            )[:remaining]:
                if run_id in seen:
                    continue
                seen.add(run_id)
                run_ids.append(run_id)
        expired: list[str] = []
        for run_id in run_ids:
            if cls._expire_one(run_id=run_id, now=now):
                expired.append(str(run_id))
        return expired

    @classmethod
    def _expire_one(
        cls,
        *,
        run_id: str | uuid.UUID,
        now: datetime,
        force: bool = False,
        expected_token: uuid.UUID | None = None,
    ) -> bool:
        normalized = cls._normalize_run_id(str(run_id))
        if normalized is None:
            return False
        session_id = (
            ExecutionRun.objects.filter(run_id=normalized)
            .values_list("session_id", flat=True)
            .first()
        )
        if not session_id:
            return False

        with transaction.atomic():
            session = (
                ChatSession.objects.select_for_update()
                .filter(pk=session_id)
                .only("id")
                .first()
            )
            if session is None:
                return False
            run = (
                ExecutionRun.objects.select_for_update()
                .filter(run_id=normalized, session_id=session_id)
                .first()
            )
            if run is None:
                return False
            lease = (
                RunHostLease.objects.select_for_update()
                .filter(run_id=normalized)
                .first()
            )
            projection = (
                SessionRunProjection.objects.select_for_update()
                .filter(session_id=session_id)
                .first()
            )
            if lease is None:
                return False
            if expected_token is not None and lease.lease_token != expected_token:
                return False

            already_released = lease.released_at is not None
            if not force and not already_released and lease.lease_expires_at > now:
                return False
            if not force and already_released:
                if lease.release_reason != LEASE_EXPIRED_STOP_REASON:
                    return False
                grace_deadline = lease.released_at + timedelta(
                    seconds=DEFAULT_LEASE_SECONDS
                )
                if now < grace_deadline:
                    return False
                if run.status in ACTIVE_STATUSES:
                    SessionRunStateService.transition(
                        run_id=str(run.run_id),
                        status=ExecutionRun.Status.INTERRUPTED,
                        stop_reason=LEASE_EXPIRED_STOP_REASON,
                        error_class=HOST_LOST_ERROR_CLASS,
                    )
                return True

            if not already_released:
                lease.released_at = now
                lease.release_reason = LEASE_EXPIRED_STOP_REASON
                lease.save(
                    update_fields=["released_at", "release_reason", "updated_at"]
                )
            should_interrupt = force and run.status in ACTIVE_STATUSES
            if should_interrupt:
                SessionRunStateService.transition(
                    run_id=str(run.run_id),
                    status=ExecutionRun.Status.INTERRUPTED,
                    stop_reason=LEASE_EXPIRED_STOP_REASON,
                    error_class=HOST_LOST_ERROR_CLASS,
                )
            return True

    @classmethod
    def reconcile(
        cls,
        *,
        host_id: str,
        user_id: str,
        active_runs: Iterable[dict[str, Any]],
        lease_seconds: int | None = None,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        """Host 重连对账；未上报的既有租约立即过期，上报项续租或重新 claim。"""
        host_id = str(host_id or "").strip()
        if not host_id:
            return {"runs": [{"outcome": "invalid"}], "converged_run_ids": []}
        now = now or timezone.now()
        reported: set[uuid.UUID] = set()
        results: list[dict[str, Any]] = []
        for item in active_runs:
            normalized = cls._normalize_run_id(str(item.get("run_id", "")))
            if normalized is None:
                results.append({"outcome": "invalid", "run_id": item.get("run_id")})
                continue
            reported.add(normalized)
            token = item.get("lease_token")
            if token:
                result = cls.heartbeat(
                    run_id=str(normalized),
                    host_id=host_id,
                    lease_token=str(token),
                    user_id=user_id,
                    lease_seconds=lease_seconds,
                    now=now,
                )
                if (
                    result.get("outcome") == "fenced"
                    and result.get("reason") == FENCE_REASON_LEASE_EXPIRED
                ):
                    result = cls.claim(
                        run_id=str(normalized),
                        host_id=host_id,
                        user_id=user_id,
                        lease_seconds=lease_seconds,
                        now=now,
                    )
            else:
                result = cls.claim(
                    run_id=str(normalized),
                    host_id=host_id,
                    user_id=user_id,
                    lease_seconds=lease_seconds,
                    now=now,
                )
            results.append(result)

        omitted = list(
            RunHostLease.objects.filter(
                host_id=host_id,
                run__user_id=str(user_id),
                released_at__isnull=True,
            )
            .exclude(run_id__in=reported)
            .values_list("run_id", "lease_token")
        )
        converged: list[str] = []
        for run_id, lease_token in omitted:
            if cls._expire_one(
                run_id=run_id,
                now=now,
                force=True,
                expected_token=lease_token,
            ):
                converged.append(str(run_id))

        # 已上报但 token 过期的 run 也必须立即收敛，不能因“在 active 集合里”
        # 而逃过 omitted 检查。
        for run_id in cls.expire_due(now=now, user_id=user_id):
            run_status = (
                ExecutionRun.objects.filter(run_id=run_id)
                .values_list("status", flat=True)
                .first()
            )
            if run_status in ACTIVE_STATUSES:
                continue
            if run_id not in converged:
                converged.append(run_id)

        return {"runs": results, "converged_run_ids": converged}


__all__ = [
    "DEFAULT_LEASE_SECONDS",
    "FENCE_REASON_HELD",
    "FENCE_REASON_LEASE_EXPIRED",
    "FENCE_REASON_OWNERSHIP_TRANSFERRED",
    "FENCE_REASON_PROJECTION_MISMATCH",
    "FENCE_REASON_RELEASED",
    "HOST_LOST_ERROR_CLASS",
    "LEASE_EXPIRED_STOP_REASON",
    "RunHostLeaseService",
]
