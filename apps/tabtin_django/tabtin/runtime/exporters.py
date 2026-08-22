"""Runtime registry exporters."""

from __future__ import annotations

from pathlib import Path
from typing import Mapping

from tabtin.runtime.registry import (
    BEAT_REGISTRY,
    LEGACY_DEFAULT_QUEUE_ALLOWLIST,
    LEGACY_HEAVY_QUEUE_ALLOWLIST,
    QUEUE_REGISTRY,
    TASK_REGISTRY,
    WORKER_REGISTRY,
)
from tabtin.runtime.validators import RuntimeValidationResult, validate_runtime_manifest


REPO_ROOT = Path(__file__).resolve().parents[4]
DEFAULT_MARKDOWN_PATH = REPO_ROOT / "docs/ops-governance/17-runtime-task-worker-registry.md"


def export_runtime_manifest_markdown(
    *,
    output_path: Path | str = DEFAULT_MARKDOWN_PATH,
    validation_result: RuntimeValidationResult | None = None,
) -> Path:
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    validation = validation_result or validate_runtime_manifest()
    path.write_text(build_runtime_manifest_markdown(validation), encoding="utf-8")
    return path


def build_runtime_manifest_markdown(validation: RuntimeValidationResult) -> str:
    sections = [
        "# Runtime Task / Worker Registry",
        "## 0. 部署口径",
        "TabTin Runtime 生产与本地部署统一采用 **8 组 worker + 单 beat**：`worker-critical`、`worker-default`、`worker-realtime`、`worker-search`、`worker-data-ai`、`worker-heavy`、`worker-tracker`、`worker-ai-background`，以及一个 Celery Beat 进程。ACK、deploy compose、systemd、supervisor 和本地脚本都应保持这个口径。",
        "## 1. 字段说明",
        "本文件由 `python manage.py export_runtime_manifest --format markdown` 从 `tabtin.runtime.registry` 生成。",
        "队列、Worker、Task、Beat 的字段含义以 `apps/tabtin_django/tabtin/runtime/registry.py` 顶部中文 docstring 为准。",
        "## 2. Queue Registry",
        _render_mapping(QUEUE_REGISTRY),
        "## 3. Worker Registry",
        _render_mapping(WORKER_REGISTRY),
        "## 4. Task Registry",
        _render_mapping(TASK_REGISTRY),
        "## 5. Beat Registry",
        _render_mapping(BEAT_REGISTRY),
        "## 6. Legacy Default Allowlist",
        _render_mapping(LEGACY_DEFAULT_QUEUE_ALLOWLIST),
        "## 7. Legacy Heavy Allowlist",
        _render_mapping(LEGACY_HEAVY_QUEUE_ALLOWLIST),
        "## 8. Worker 启动脚本映射",
        _render_worker_commands(),
        "## 9. 维护规则",
        "\n".join(
            [
                "1. 新增 queue / worker / task / beat 必须先登记 registry。",
                "2. realtime task 不允许进入 default。",
                "3. RAG / Embedding、TabData compute、DocMerge 不允许进入 heavy。",
                "4. 高频 Beat 只能作为 polling 或 fallback/retry/recovery，不允许替代事件主链路。",
                "5. Feature flag 默认关闭，新链路按灰度开启。",
            ]
        ),
        "## 10. Validation Result",
        _render_validation(validation),
        "## 11. Rollout / Rollback 顺序",
        _render_rollout_plan(),
        "",
    ]
    return "\n\n".join(sections)


def _render_mapping(data: Mapping) -> str:
    if not data:
        return "_空_"
    blocks = []
    for key, spec in data.items():
        blocks.append(f"### `{key}`")
        if isinstance(spec, Mapping):
            for field, value in spec.items():
                blocks.append(f"- `{field}`: {value}")
        else:
            blocks.append(f"- {spec}")
    return "\n".join(blocks)


def _render_worker_commands() -> str:
    lines = []
    for key, spec in WORKER_REGISTRY.items():
        lines.append(f"### `{key}`")
        lines.append(f"- 队列: {', '.join(spec['queues'])}")
        lines.append(f"- 命令: `{spec['command']}`")
    return "\n".join(lines)


def _render_validation(validation: RuntimeValidationResult) -> str:
    lines = [f"- Status: `{validation.status}`"]
    for item in validation.passed:
        lines.append(f"- PASS: {item}")
    for item in validation.warnings:
        lines.append(f"- WARN: {item}")
    for item in validation.failures:
        lines.append(f"- FAIL: {item}")
    return "\n".join(lines)


def _render_rollout_plan() -> str:
    return "\n".join(
        [
            "### Rollout",
            "1. 先部署新 worker，使 `realtime_delivery`、`rag_indexing`、`doc_merge` 等新队列已有消费者。",
            "2. 再让 Celery route / Beat schedule 生效，把重点任务投到新队列。",
            "3. 最后灰度开启 feature flag：Channel Gateway immediate delivery、TabDoc debounce merge、RAG dedicated queue。",
            "",
            "### Rollback",
            "1. 先关闭 feature flag，停止继续产生新链路流量。",
            "2. 确认新队列无积压或积压已被消费完。",
            "3. 再回滚 route / worker 拓扑，避免任务投递到无人消费的队列。",
        ]
    )
