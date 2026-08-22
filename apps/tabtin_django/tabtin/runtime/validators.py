"""Runtime registry validation."""

from __future__ import annotations

from dataclasses import dataclass, field
from fnmatch import fnmatch
from typing import Mapping

from django.conf import settings

from tabtin.runtime.registry import (
    BEAT_REGISTRY,
    LEGACY_DEFAULT_QUEUE_ALLOWLIST,
    LEGACY_HEAVY_QUEUE_ALLOWLIST,
    QUEUE_REGISTRY,
    TASK_REGISTRY,
    WORKER_REGISTRY,
)


@dataclass
class RuntimeValidationResult:
    passed: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    failures: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.failures

    @property
    def status(self) -> str:
        if self.failures:
            return "FAIL"
        if self.warnings:
            return "WARN"
        return "PASS"


def validate_runtime_manifest() -> RuntimeValidationResult:
    result = RuntimeValidationResult()
    _validate_registry_references(result)
    _validate_worker_queue_consumers(result)
    _validate_route_patterns(result, getattr(settings, "CELERY_TASK_ROUTES", {}))
    _validate_forbidden_routes(result, getattr(settings, "CELERY_TASK_ROUTES", {}))
    _validate_beat_roles(result)
    _validate_settings_routes(result, getattr(settings, "CELERY_TASK_ROUTES", {}))
    if not result.failures:
        result.passed.append("runtime manifest structure and routes are valid")
    return result


def resolve_route_queue(task_name: str, routes: Mapping[str, Mapping[str, str]]) -> str | None:
    if task_name in routes:
        return routes[task_name].get("queue")
    for pattern, route in routes.items():
        if "*" in pattern and fnmatch(task_name, pattern):
            return route.get("queue")
    return getattr(settings, "CELERY_TASK_DEFAULT_QUEUE", "default")


def _validate_registry_references(result: RuntimeValidationResult) -> None:
    for queue, spec in QUEUE_REGISTRY.items():
        for worker in spec["expected_workers"]:
            if worker not in WORKER_REGISTRY:
                result.failures.append(f"QUEUE_REGISTRY[{queue}] expected worker 不存在: {worker}")

    for worker, spec in WORKER_REGISTRY.items():
        for queue in spec["queues"]:
            if queue not in QUEUE_REGISTRY:
                result.failures.append(f"WORKER_REGISTRY[{worker}] queue 未登记: {queue}")

    for task, spec in TASK_REGISTRY.items():
        if spec["queue"] not in QUEUE_REGISTRY:
            result.failures.append(f"TASK_REGISTRY[{task}] queue 未登记: {spec['queue']}")
        if spec["worker"] not in WORKER_REGISTRY:
            result.failures.append(f"TASK_REGISTRY[{task}] worker 未登记: {spec['worker']}")

    for beat, spec in BEAT_REGISTRY.items():
        if spec["task"] not in TASK_REGISTRY:
            result.failures.append(f"BEAT_REGISTRY[{beat}] task 未登记: {spec['task']}")
        if spec["queue"] not in QUEUE_REGISTRY:
            result.failures.append(f"BEAT_REGISTRY[{beat}] queue 未登记: {spec['queue']}")


def _validate_worker_queue_consumers(result: RuntimeValidationResult) -> None:
    required_consumers = {
        "realtime_delivery": "worker-realtime",
        "rag_indexing": "worker-data-ai",
        "doc_merge": "worker-data-ai",
    }
    for queue, worker in required_consumers.items():
        worker_spec = WORKER_REGISTRY.get(worker)
        if not worker_spec or queue not in worker_spec.get("queues", []):
            result.failures.append(f"{queue} 必须由 {worker} 消费")


def _validate_route_patterns(
    result: RuntimeValidationResult,
    routes: Mapping[str, Mapping[str, str]],
) -> None:
    if "channel_gateway.*" in routes:
        result.failures.append("不允许使用 channel_gateway.* 通配路由；必须精确登记实时任务")


def _validate_forbidden_routes(
    result: RuntimeValidationResult,
    routes: Mapping[str, Mapping[str, str]],
) -> None:
    for task, spec in TASK_REGISTRY.items():
        queue = spec["queue"]
        lower_task = task.lower()
        lower_text = f"{task} {spec.get('display_name', '')} {spec.get('description', '')}".lower()
        if "channel_gateway" in lower_task and queue == "default":
            result.failures.append(f"realtime task 不允许落 default: {task}")
        if ("rag" in lower_text or "embedding" in lower_text) and queue == "heavy":
            result.failures.append(f"RAG / Embedding task 不允许落 heavy: {task}")
        if "tabdata" in lower_text and "compute" in lower_text and queue == "heavy":
            result.failures.append(f"TabData compute task 不允许落 heavy: {task}")
        if ("docmerge" in lower_text or "doc_merge" in lower_text or "文档合并" in lower_text) and queue == "heavy":
            result.failures.append(f"DocMerge task 不允许落 heavy: {task}")
        if "cleanup" in lower_task and queue in {"realtime_delivery", "critical"}:
            result.failures.append(f"cleanup task 不允许落 {queue}: {task}")

    for route_name, route in routes.items():
        queue = route.get("queue")
        if queue == "default" and route_name not in TASK_REGISTRY and route_name not in LEGACY_DEFAULT_QUEUE_ALLOWLIST:
            continue
        if queue == "heavy" and route_name not in TASK_REGISTRY and route_name not in LEGACY_HEAVY_QUEUE_ALLOWLIST:
            continue


def _validate_beat_roles(result: RuntimeValidationResult) -> None:
    allowed_roles = {
        "main_path",
        "fallback_sweep",
        "retry",
        "recovery",
        "cleanup",
        "archive",
        "stats",
        "report",
        "health_probe",
        "polling",
    }
    for beat, spec in BEAT_REGISTRY.items():
        role = spec["role"]
        if role not in allowed_roles:
            result.failures.append(f"BEAT_REGISTRY[{beat}] role 非法: {role}")
        if spec["is_main_path"] and role != "polling":
            result.failures.append(f"高频 Beat 不允许作为实时主链路: {beat}")


def _validate_settings_routes(
    result: RuntimeValidationResult,
    routes: Mapping[str, Mapping[str, str]],
) -> None:
    for task, spec in TASK_REGISTRY.items():
        actual = resolve_route_queue(task, routes)
        if actual != spec["queue"]:
            result.failures.append(
                f"settings.py route 与 TASK_REGISTRY 不一致: {task} expected={spec['queue']} actual={actual}"
            )
