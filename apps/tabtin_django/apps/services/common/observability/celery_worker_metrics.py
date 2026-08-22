"""Prometheus runtime metrics for Celery workers.

This module is intentionally worker-local. It records Celery signal events into
prometheus_client's in-process or multiprocess storage and exposes them through
an embedded HTTP endpoint for PodMonitor scraping.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from functools import wraps
from pathlib import Path
from typing import Any

from celery.signals import (
    task_failure,
    task_postrun,
    task_prerun,
    task_retry,
    worker_process_shutdown,
    worker_ready,
)
from prometheus_client import CollectorRegistry, Counter, Histogram, REGISTRY, start_http_server
from prometheus_client.multiprocess import MultiProcessCollector, mark_process_dead

logger = logging.getLogger(__name__)

_DEFAULT_MULTIPROC_DIR = "/tmp/prometheus_multiproc"
_DEFAULT_METRICS_PORT = 9102
_TASK_STARTS: dict[str, tuple[float, str, str]] = {}
_SERVER_LOCK = threading.Lock()
_SERVER_STARTED = False


def _env_bool(key: str, default: bool = False) -> bool:
    raw = os.getenv(key)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _metrics_enabled() -> bool:
    return _env_bool("CELERY_WORKER_METRICS_ENABLED", False)


def _metrics_port() -> int:
    raw = os.getenv("CELERY_WORKER_METRICS_PORT", "")
    if not raw:
        return _DEFAULT_METRICS_PORT
    try:
        port = int(raw)
    except ValueError:
        logger.warning("[CeleryMetrics] invalid CELERY_WORKER_METRICS_PORT=%r; use %s", raw, _DEFAULT_METRICS_PORT)
        return _DEFAULT_METRICS_PORT
    return port


def _multiprocess_dir_path() -> Path:
    multiproc_dir = (
        os.getenv("PROMETHEUS_MULTIPROC_DIR", "").strip()
        or os.getenv("CELERY_WORKER_METRICS_MULTIPROC_DIR", "").strip()
        or _DEFAULT_MULTIPROC_DIR
    )
    return Path(multiproc_dir)


def prepare_multiprocess_dir() -> Path | None:
    if not _metrics_enabled():
        return None

    multiproc_path = _multiprocess_dir_path()
    os.environ.setdefault("PROMETHEUS_MULTIPROC_DIR", str(multiproc_path))
    try:
        multiproc_path.mkdir(parents=True, exist_ok=True)
    except OSError:
        logger.exception("[CeleryMetrics] failed to create PROMETHEUS_MULTIPROC_DIR=%s", multiproc_path)
        return None

    for db_file in multiproc_path.glob("*.db"):
        try:
            if db_file.is_file():
                db_file.unlink()
        except OSError:
            logger.debug("[CeleryMetrics] failed to remove stale metrics file %s", db_file, exc_info=True)
    return multiproc_path


task_success_total = Counter(
    "tabtin_celery_task_success_total",
    "Total Celery tasks completed successfully.",
    ["worker", "queue", "task_name"],
)

task_failed_total = Counter(
    "tabtin_celery_task_failed_total",
    "Total Celery tasks failed.",
    ["worker", "queue", "task_name", "exception_type"],
)

task_retry_total = Counter(
    "tabtin_celery_task_retry_total",
    "Total Celery task retries.",
    ["worker", "queue", "task_name", "exception_type"],
)

task_duration_seconds = Histogram(
    "tabtin_celery_task_duration_seconds",
    "Celery task runtime duration in seconds.",
    ["worker", "queue", "task_name", "state"],
    buckets=(0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1200, 1800),
)


def _worker_name() -> str:
    return (
        os.getenv("CELERY_WORKER_NAME", "").strip()
        or os.getenv("CELERY_QUEUES", "").strip()
        or os.getenv("HOSTNAME", "").strip()
        or "unknown"
    )


def _delivery_info_queue(delivery_info: Any) -> str:
    if not isinstance(delivery_info, dict):
        return "unknown"
    for key in ("queue", "routing_key"):
        value = delivery_info.get(key)
        if value:
            return str(value)
    return "unknown"


def _task_request(sender: Any = None, task: Any = None, request: Any = None) -> Any:
    if request is not None:
        return request
    for obj in (sender, task):
        value = getattr(obj, "request", None)
        if value is not None:
            return value
    return None


def _task_name(sender: Any = None, task: Any = None, request: Any = None) -> str:
    for obj in (sender, task, request):
        value = getattr(obj, "name", None) or getattr(obj, "task", None)
        if value:
            return str(value)
    return "unknown"


def _task_queue(sender: Any = None, task: Any = None, request: Any = None) -> str:
    for obj in (sender, task):
        queue = getattr(obj, "queue", None)
        if queue:
            return str(queue)

    req = _task_request(sender=sender, task=task, request=request)
    return _delivery_info_queue(getattr(req, "delivery_info", None))


def _exception_type(exception: Any) -> str:
    if exception is None:
        return "unknown"
    if isinstance(exception, type):
        return exception.__name__
    return type(exception).__name__


def _task_key(task_id: Any) -> str | None:
    if task_id is None:
        return None
    return str(task_id)


def _state_label(state: Any) -> str:
    if state is None:
        return "unknown"
    return str(state).lower()


def _metrics_registry() -> CollectorRegistry:
    if os.getenv("PROMETHEUS_MULTIPROC_DIR"):
        registry = CollectorRegistry()
        MultiProcessCollector(registry)
        return registry
    return REGISTRY


def _safe_signal_handler(event: str):
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            try:
                return func(*args, **kwargs)
            except Exception:
                logger.debug("[CeleryMetrics] failed to record %s", event, exc_info=True)
                return None

        return wrapper

    return decorator


def _start_metrics_server_once() -> bool:
    global _SERVER_STARTED
    if not _metrics_enabled():
        return False

    with _SERVER_LOCK:
        if _SERVER_STARTED:
            return True
        port = _metrics_port()
        if prepare_multiprocess_dir() is None:
            return False
        try:
            start_http_server(port, addr="0.0.0.0", registry=_metrics_registry())
        except Exception:
            logger.exception("[CeleryMetrics] failed to start metrics server on port %s", port)
            return False
        _SERVER_STARTED = True
        logger.info("[CeleryMetrics] metrics server listening on 0.0.0.0:%s", port)
        return True


@worker_ready.connect(weak=False)
@_safe_signal_handler("worker_ready")
def _on_worker_ready(sender=None, **kwargs):
    _start_metrics_server_once()


@task_prerun.connect(weak=False)
@_safe_signal_handler("task_prerun")
def _on_task_prerun(sender=None, task_id=None, task=None, **kwargs):
    if not _metrics_enabled():
        return
    key = _task_key(task_id)
    if key is None:
        return
    _TASK_STARTS[key] = (time.monotonic(), _task_name(sender=sender, task=task), _task_queue(sender=sender, task=task))


@task_postrun.connect(weak=False)
@_safe_signal_handler("task_postrun")
def _on_task_postrun(sender=None, task_id=None, task=None, state=None, **kwargs):
    if not _metrics_enabled():
        return

    worker = _worker_name()
    task_name = _task_name(sender=sender, task=task)
    queue = _task_queue(sender=sender, task=task)
    key = _task_key(task_id)
    started = _TASK_STARTS.pop(key, None) if key is not None else None
    if started is not None:
        started_at, started_task_name, started_queue = started
        task_name = started_task_name or task_name
        queue = started_queue or queue
        task_duration_seconds.labels(
            worker=worker,
            queue=queue,
            task_name=task_name,
            state=_state_label(state),
        ).observe(max(time.monotonic() - started_at, 0))

    if str(state).upper() == "SUCCESS":
        task_success_total.labels(worker=worker, queue=queue, task_name=task_name).inc()


@task_failure.connect(weak=False)
@_safe_signal_handler("task_failure")
def _on_task_failure(sender=None, task_id=None, exception=None, **kwargs):
    if not _metrics_enabled():
        return
    task_failed_total.labels(
        worker=_worker_name(),
        queue=_task_queue(sender=sender),
        task_name=_task_name(sender=sender),
        exception_type=_exception_type(exception),
    ).inc()


@task_retry.connect(weak=False)
@_safe_signal_handler("task_retry")
def _on_task_retry(sender=None, request=None, reason=None, **kwargs):
    if not _metrics_enabled():
        return
    task_retry_total.labels(
        worker=_worker_name(),
        queue=_task_queue(sender=sender, request=request),
        task_name=_task_name(sender=sender, request=request),
        exception_type=_exception_type(reason),
    ).inc()


@worker_process_shutdown.connect(weak=False)
@_safe_signal_handler("worker_process_shutdown")
def _on_worker_process_shutdown(sender=None, pid=None, **kwargs):
    if not os.getenv("PROMETHEUS_MULTIPROC_DIR"):
        return
    try:
        mark_process_dead(pid or os.getpid())
    except Exception:
        logger.debug("[CeleryMetrics] failed to mark process dead", exc_info=True)
