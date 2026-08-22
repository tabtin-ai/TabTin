"""Bounded Redis audit and conservative cleanup for Celery pidbox replies."""

from __future__ import annotations

from dataclasses import dataclass
from time import monotonic

from redis import Redis
from redis.exceptions import WatchError

from tabtin.celery_redis_transport import PIDBOX_REPLY_SUFFIX


_BINDING_KEY = "_kombu.binding.reply.celery.pidbox"
_BINDING_SEPARATOR = b"\x06\x16"


@dataclass(frozen=True)
class PidboxReplyMetrics:
    reply_key_count: int
    total_bytes: int
    without_ttl_count: int
    orphan_candidate_count: int
    oldest_idle_seconds: int
    scanned_key_count: int
    scan_complete: bool


@dataclass(frozen=True)
class PidboxReplySweepResult:
    metrics_before: PidboxReplyMetrics
    deleted_count: int
    race_skipped_count: int


@dataclass(frozen=True)
class _ScanResult:
    metrics: PidboxReplyMetrics
    candidate_keys: tuple[bytes, ...]


def _binding_key(global_keyprefix: str) -> str:
    return f"{global_keyprefix}{_BINDING_KEY}"


def _queue_name(key: bytes, global_keyprefix: str) -> str:
    decoded = key.decode("utf-8", errors="strict")
    if global_keyprefix and not decoded.startswith(global_keyprefix):
        return ""
    return decoded[len(global_keyprefix):]


def _bound_queue_names(binding_values: set[bytes]) -> set[str]:
    queues: set[str] = set()
    for value in binding_values:
        parts = value.split(_BINDING_SEPARATOR)
        if len(parts) == 3 and parts[2]:
            queues.add(parts[2].decode("utf-8", errors="replace"))
    return queues


def _scan_pidbox_replies(
    client: Redis,
    *,
    global_keyprefix: str,
    safe_idle_seconds: int,
    scan_count: int,
    max_scanned_keys: int,
    time_budget_seconds: float,
) -> _ScanResult:
    if safe_idle_seconds < 1:
        raise ValueError("safe_idle_seconds must be at least 1")
    if scan_count < 1 or max_scanned_keys < 1 or time_budget_seconds <= 0:
        raise ValueError("scan limits must be positive")

    started = monotonic()
    cursor = 0
    reply_key_count = 0
    total_bytes = 0
    without_ttl_count = 0
    oldest_idle_seconds = 0
    scanned_key_count = 0
    stopped_mid_batch = False
    candidate_keys: list[bytes] = []
    binding_values = client.smembers(_binding_key(global_keyprefix))
    bound_queues = _bound_queue_names(binding_values)
    match = f"{global_keyprefix}*{PIDBOX_REPLY_SUFFIX}"

    while True:
        cursor, keys = client.scan(cursor=cursor, match=match, count=scan_count)
        for key in keys:
            if (
                scanned_key_count >= max_scanned_keys
                or monotonic() - started >= time_budget_seconds
            ):
                stopped_mid_batch = True
                break
            scanned_key_count += 1
            if client.type(key) != b"list":
                continue
            queue_name = _queue_name(key, global_keyprefix)
            if not queue_name.endswith(PIDBOX_REPLY_SUFFIX):
                continue

            ttl = int(client.ttl(key))
            idle_seconds = int(client.object("idletime", key) or 0)
            reply_key_count += 1
            total_bytes += int(client.memory_usage(key) or 0)
            oldest_idle_seconds = max(oldest_idle_seconds, idle_seconds)
            if ttl == -1:
                without_ttl_count += 1
                if queue_name not in bound_queues and idle_seconds >= safe_idle_seconds:
                    candidate_keys.append(key)

        limit_reached = scanned_key_count >= max_scanned_keys
        time_reached = monotonic() - started >= time_budget_seconds
        if cursor == 0 or stopped_mid_batch or limit_reached or time_reached:
            break

    metrics = PidboxReplyMetrics(
        reply_key_count=reply_key_count,
        total_bytes=total_bytes,
        without_ttl_count=without_ttl_count,
        orphan_candidate_count=len(candidate_keys),
        oldest_idle_seconds=oldest_idle_seconds,
        scanned_key_count=scanned_key_count,
        scan_complete=cursor == 0 and not stopped_mid_batch,
    )
    return _ScanResult(metrics=metrics, candidate_keys=tuple(candidate_keys))


def collect_pidbox_reply_metrics(
    client: Redis,
    *,
    global_keyprefix: str = "",
    safe_idle_seconds: int = 600,
    scan_count: int = 100,
    max_scanned_keys: int = 10_000,
    time_budget_seconds: float = 1.0,
) -> PidboxReplyMetrics:
    """Return low-cost lifecycle metrics using bounded ``SCAN`` calls."""
    return _scan_pidbox_replies(
        client,
        global_keyprefix=global_keyprefix,
        safe_idle_seconds=safe_idle_seconds,
        scan_count=scan_count,
        max_scanned_keys=max_scanned_keys,
        time_budget_seconds=time_budget_seconds,
    ).metrics


def _delete_if_still_orphan(
    client: Redis,
    key: bytes,
    *,
    global_keyprefix: str,
    safe_idle_seconds: int,
) -> bool:
    binding_key = _binding_key(global_keyprefix)
    queue_name = _queue_name(key, global_keyprefix)
    with client.pipeline() as pipe:
        try:
            pipe.watch(binding_key, key)
            if pipe.type(key) != b"list" or pipe.ttl(key) != -1:
                return False
            if int(pipe.object("idletime", key) or 0) < safe_idle_seconds:
                return False
            if queue_name in _bound_queue_names(pipe.smembers(binding_key)):
                return False
            pipe.multi()
            pipe.delete(key)
            return bool(pipe.execute()[0])
        except WatchError:
            return False
        finally:
            pipe.reset()


def sweep_orphan_pidbox_replies(
    client: Redis,
    *,
    global_keyprefix: str = "",
    safe_idle_seconds: int = 600,
    scan_count: int = 100,
    max_scanned_keys: int = 10_000,
    max_deleted: int = 100,
    time_budget_seconds: float = 1.0,
) -> PidboxReplySweepResult:
    """Delete only old, unbound, non-expiring pidbox reply lists.

    Candidate discovery is bounded.  Each deletion watches both the reply key
    and the binding set, then rechecks type, TTL, idle age, and binding state.
    A concurrent publish or bind therefore cancels the deletion.
    """
    if max_deleted < 1:
        raise ValueError("max_deleted must be positive")
    scan_result = _scan_pidbox_replies(
        client,
        global_keyprefix=global_keyprefix,
        safe_idle_seconds=safe_idle_seconds,
        scan_count=scan_count,
        max_scanned_keys=max_scanned_keys,
        time_budget_seconds=time_budget_seconds,
    )
    deleted_count = 0
    race_skipped_count = 0
    started = monotonic()
    for key in scan_result.candidate_keys:
        if deleted_count >= max_deleted or monotonic() - started >= time_budget_seconds:
            break
        if _delete_if_still_orphan(
            client,
            key,
            global_keyprefix=global_keyprefix,
            safe_idle_seconds=safe_idle_seconds,
        ):
            deleted_count += 1
        else:
            race_skipped_count += 1
    return PidboxReplySweepResult(
        metrics_before=scan_result.metrics,
        deleted_count=deleted_count,
        race_skipped_count=race_skipped_count,
    )
