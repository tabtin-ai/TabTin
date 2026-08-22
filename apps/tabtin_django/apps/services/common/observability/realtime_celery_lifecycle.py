"""Structured lifecycle logs for realtime Celery workers.

The realtime worker can churn child processes very quickly when memory recycle
thresholds sit below the normal process baseline. These signal handlers keep the
logs narrow: detailed task records are emitted only for realtime_delivery tasks
or channel gateway tasks, and process records only from the realtime worker.
"""

from __future__ import annotations

import json
import logging
import os
import socket
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from celery.signals import (
    task_failure,
    task_postrun,
    task_prerun,
    task_received,
    task_retry,
    task_revoked,
    worker_process_init,
    worker_process_shutdown,
)

logger = logging.getLogger(__name__)

REALTIME_QUEUE = "realtime_delivery"
REALTIME_TASK_PREFIXES = ("channel_gateway.",)
REALTIME_TASK_MODULES = ("apps.channel_gateway.tasks",)
CHANNEL_OUTBOUND_ID_TASKS = {
    "channel_gateway.deliver_one_outbox",
}
_TASK_STARTS: dict[str, tuple[float, int | None]] = {}
_REALTIME_WORKER_CACHE: bool | None = None


def _utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_status_rss_kib(status_text: str) -> int | None:
    for line in status_text.splitlines():
        if line.startswith("VmRSS:"):
            parts = line.split()
            if len(parts) >= 2:
                try:
                    return int(parts[1])
                except ValueError:
                    return None
    return None


def _read_rss_kib(path: str = "/proc/self/status") -> int | None:
    try:
        return _parse_status_rss_kib(Path(path).read_text(encoding="utf-8", errors="replace"))
    except Exception:
        return None


def _read_first_int(paths: tuple[str, ...]) -> int | None:
    for path in paths:
        try:
            text = Path(path).read_text(encoding="utf-8", errors="replace").strip()
        except Exception:
            continue
        if not text or text == "max":
            continue
        try:
            return int(text)
        except ValueError:
            continue
    return None


def _read_cgroup_memory_bytes() -> int | None:
    return _read_first_int((
        "/sys/fs/cgroup/memory.current",
        "/sys/fs/cgroup/memory/memory.usage_in_bytes",
    ))


def _delivery_info_queue(delivery_info: Any) -> str | None:
    if not isinstance(delivery_info, dict):
        return None
    for key in ("queue", "routing_key", "exchange"):
        value = delivery_info.get(key)
        if value:
            return str(value)
    return None


def _task_name(sender: Any = None, request: Any = None) -> str:
    for obj in (sender, request):
        value = getattr(obj, "name", None) or getattr(obj, "task", None)
        if value:
            return str(value)
    return ""


def _task_module(sender: Any = None) -> str:
    run = getattr(sender, "run", None)
    return str(getattr(run, "__module__", "") or getattr(sender, "__module__", "") or "")


def _task_queue(sender: Any = None, request: Any = None) -> str | None:
    queue = getattr(sender, "queue", None)
    if queue:
        return str(queue)
    delivery_info = getattr(request, "delivery_info", None)
    return _delivery_info_queue(delivery_info)


def _is_realtime_task(task_name: str, module_name: str, queue: str | None) -> bool:
    return (
        queue == REALTIME_QUEUE
        or task_name.startswith(REALTIME_TASK_PREFIXES)
        or module_name.startswith(REALTIME_TASK_MODULES)
    )


def _read_proc_1_cmdline() -> str:
    try:
        return Path("/proc/1/cmdline").read_bytes().replace(b"\0", b" ").decode("utf-8", errors="replace")
    except Exception:
        return ""


def _is_realtime_worker_process() -> bool:
    global _REALTIME_WORKER_CACHE
    if _REALTIME_WORKER_CACHE is not None:
        return _REALTIME_WORKER_CACHE
    env_queues = os.getenv("CELERY_QUEUES", "")
    cmdline = _read_proc_1_cmdline()
    _REALTIME_WORKER_CACHE = REALTIME_QUEUE in env_queues.split(",") or REALTIME_QUEUE in cmdline
    return _REALTIME_WORKER_CACHE


def _extract_correlation_ids(task_name: str, args: Any = None, kwargs: Any = None) -> dict[str, str | None]:
    kwargs = kwargs if isinstance(kwargs, dict) else {}
    outbox_id = None
    channel_outbound_id = None

    if task_name in CHANNEL_OUTBOUND_ID_TASKS:
        channel_outbound_id = kwargs.get("channel_outbound_id") or kwargs.get("outbox_id")

    first_arg = None
    if isinstance(args, (list, tuple)) and args:
        first_arg = args[0]

    if first_arg is not None:
        if task_name in CHANNEL_OUTBOUND_ID_TASKS and channel_outbound_id is None:
            channel_outbound_id = first_arg

    return {
        "outbox_id": str(outbox_id) if outbox_id is not None else None,
        "channel_outbound_id": str(channel_outbound_id) if channel_outbound_id is not None else None,
    }


def _request_args_kwargs(request: Any) -> tuple[Any, Any]:
    return getattr(request, "args", None), getattr(request, "kwargs", None)


def _exit_reason(exitcode: Any) -> str:
    if exitcode == 0:
        return "normal"
    if exitcode == 155:
        return "recycle"
    if exitcode in (-9, "signal 9", "SIGKILL"):
        return "sigkill"
    if exitcode is None:
        return "unknown"
    return "unknown"


def _base_payload(event: str) -> dict[str, Any]:
    return {
        "event": event,
        "timestamp": _utc_timestamp(),
        "hostname": socket.gethostname(),
        "queue": None,
        "task_id": None,
        "task_name": None,
        "pid": os.getpid(),
        "ppid": os.getppid(),
        "duration_ms": None,
        "state": None,
        "exitcode": None,
        "terminated": None,
        "signum": None,
        "rss_kib": _read_rss_kib(),
        "rss_delta_kib": None,
        "cgroup_memory_bytes": _read_cgroup_memory_bytes(),
        "outbox_id": None,
        "channel_outbound_id": None,
        "exception_type": None,
        "metric": None,
    }


def _emit(payload: dict[str, Any]) -> None:
    try:
        logger.info(
            "celery_realtime_lifecycle %s",
            json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
        )
    except Exception:
        logger.debug("failed to emit realtime celery lifecycle log", exc_info=True)


@task_received.connect(weak=False)
def _on_task_received(sender=None, request=None, **kwargs):
    task_name = _task_name(sender, request)
    queue = _task_queue(sender, request)
    if not _is_realtime_task(task_name, "", queue):
        return
    args, task_kwargs = _request_args_kwargs(request)
    payload = _base_payload("task_received")
    payload.update({
        "queue": queue,
        "task_id": str(getattr(request, "id", "") or "") or None,
        "task_name": task_name,
        "state": "received",
        **_extract_correlation_ids(task_name, args=args, kwargs=task_kwargs),
    })
    _emit(payload)


@task_prerun.connect(weak=False)
def _on_task_prerun(sender=None, task_id=None, task=None, args=None, kwargs=None, **extra):
    task_name = _task_name(sender or task)
    queue = _task_queue(sender or task)
    module_name = _task_module(sender or task)
    if not _is_realtime_task(task_name, module_name, queue):
        return
    rss = _read_rss_kib()
    if task_id:
        _TASK_STARTS[str(task_id)] = (time.monotonic(), rss)
    payload = _base_payload("task_prerun")
    payload.update({
        "queue": queue,
        "task_id": str(task_id) if task_id else None,
        "task_name": task_name,
        "state": "started",
        "rss_kib": rss,
        **_extract_correlation_ids(task_name, args=args, kwargs=kwargs),
    })
    _emit(payload)


@task_postrun.connect(weak=False)
def _on_task_postrun(sender=None, task_id=None, task=None, args=None, kwargs=None, state=None, **extra):
    task_name = _task_name(sender or task)
    queue = _task_queue(sender or task)
    module_name = _task_module(sender or task)
    if not _is_realtime_task(task_name, module_name, queue):
        return
    now = time.monotonic()
    end_rss = _read_rss_kib()
    started = _TASK_STARTS.pop(str(task_id), None) if task_id else None
    duration_ms = None
    rss_delta_kib = None
    if started is not None:
        started_at, start_rss = started
        duration_ms = int((now - started_at) * 1000)
        if end_rss is not None and start_rss is not None:
            rss_delta_kib = end_rss - start_rss
    payload = _base_payload("task_postrun")
    payload.update({
        "queue": queue,
        "task_id": str(task_id) if task_id else None,
        "task_name": task_name,
        "duration_ms": duration_ms,
        "state": str(state) if state is not None else None,
        "rss_kib": end_rss,
        "rss_delta_kib": rss_delta_kib,
        **_extract_correlation_ids(task_name, args=args, kwargs=kwargs),
    })
    _emit(payload)


@task_failure.connect(weak=False)
def _on_task_failure(sender=None, task_id=None, exception=None, args=None, kwargs=None, **extra):
    task_name = _task_name(sender)
    queue = _task_queue(sender)
    module_name = _task_module(sender)
    if not _is_realtime_task(task_name, module_name, queue):
        return
    payload = _base_payload("task_failure")
    payload.update({
        "queue": queue,
        "task_id": str(task_id) if task_id else None,
        "task_name": task_name,
        "state": type(exception).__name__ if exception is not None else "failure",
        "exception_type": type(exception).__name__ if exception is not None else None,
        **_extract_correlation_ids(task_name, args=args, kwargs=kwargs),
    })
    _emit(payload)


@task_retry.connect(weak=False)
def _on_task_retry(sender=None, request=None, reason=None, **kwargs):
    task_name = _task_name(sender, request)
    queue = _task_queue(sender, request)
    module_name = _task_module(sender)
    if not _is_realtime_task(task_name, module_name, queue):
        return
    args, task_kwargs = _request_args_kwargs(request)
    payload = _base_payload("task_retry")
    payload.update({
        "queue": queue,
        "task_id": str(getattr(request, "id", "") or "") or None,
        "task_name": task_name,
        "state": type(reason).__name__ if reason is not None else "retry",
        "exception_type": type(reason).__name__ if reason is not None else None,
        **_extract_correlation_ids(task_name, args=args, kwargs=task_kwargs),
    })
    _emit(payload)


@task_revoked.connect(weak=False)
def _on_task_revoked(sender=None, request=None, terminated=None, signum=None, expired=None, **kwargs):
    task_name = _task_name(sender, request)
    queue = _task_queue(sender, request)
    module_name = _task_module(sender)
    if not _is_realtime_task(task_name, module_name, queue):
        return
    args, task_kwargs = _request_args_kwargs(request)
    payload = _base_payload("task_revoked")
    payload.update({
        "queue": queue,
        "task_id": str(getattr(request, "id", "") or "") or None,
        "task_name": task_name,
        "state": "expired" if expired else "revoked",
        "terminated": bool(terminated),
        "signum": signum,
        **_extract_correlation_ids(task_name, args=args, kwargs=task_kwargs),
    })
    _emit(payload)


@worker_process_init.connect(weak=False)
def _on_worker_process_init(sender=None, **kwargs):
    if not _is_realtime_worker_process():
        return
    payload = _base_payload("worker_process_init")
    payload.update({
        "queue": REALTIME_QUEUE,
        "state": "started",
        "worker": "realtime",
        "metric": "celery_worker_child_started_total",
    })
    _emit(payload)


@worker_process_shutdown.connect(weak=False)
def _on_worker_process_shutdown(sender=None, pid=None, exitcode=None, **kwargs):
    if not _is_realtime_worker_process():
        return
    # SIGKILL usually prevents the child from running this handler. Parent logs
    # remain the source of truth for signal-9 counts.
    payload = _base_payload("worker_process_shutdown")
    payload.update({
        "queue": REALTIME_QUEUE,
        "pid": pid or os.getpid(),
        "exitcode": exitcode,
        "state": "shutdown",
        "exit_reason": _exit_reason(exitcode),
        "worker": "realtime",
        "metric": "celery_worker_child_shutdown_total",
    })
    _emit(payload)
