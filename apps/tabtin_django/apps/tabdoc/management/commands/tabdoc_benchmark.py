"""
TabDoc 性能压测命令（打开/保存 P95）

用法：
    python manage.py tabdoc_benchmark
    python manage.py tabdoc_benchmark --iterations 100 --size-kb 64
    python manage.py tabdoc_benchmark --iterations 50 --size-kb 128 --json

说明：
  - 默认创建一个临时文档，压测完成后清理（--keep-data 可保留）
  - 主要输出 open/save 的 p50/p95/p99（毫秒）
"""

from __future__ import annotations

import json
import math
import statistics
import uuid
from dataclasses import asdict, dataclass
from time import perf_counter
from typing import Any
from unittest.mock import patch

from django.core.management.base import BaseCommand, CommandError
from django.db import connections, router

from apps.tabdoc.models import Document, DocumentVersion
from apps.tabdoc.services import DocumentService


def _percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return float(ordered[0])
    idx = (len(ordered) - 1) * p
    lower = math.floor(idx)
    upper = math.ceil(idx)
    if lower == upper:
        return float(ordered[lower])
    lower_v = ordered[lower]
    upper_v = ordered[upper]
    return float(lower_v + (upper_v - lower_v) * (idx - lower))


@dataclass
class MetricSummary:
    count: int
    min_ms: float
    max_ms: float
    avg_ms: float
    p50_ms: float
    p95_ms: float
    p99_ms: float


def _summarize(samples: list[float]) -> MetricSummary:
    if not samples:
        return MetricSummary(
            count=0,
            min_ms=0.0,
            max_ms=0.0,
            avg_ms=0.0,
            p50_ms=0.0,
            p95_ms=0.0,
            p99_ms=0.0,
        )
    return MetricSummary(
        count=len(samples),
        min_ms=min(samples),
        max_ms=max(samples),
        avg_ms=statistics.fmean(samples),
        p50_ms=_percentile(samples, 0.50),
        p95_ms=_percentile(samples, 0.95),
        p99_ms=_percentile(samples, 0.99),
    )


def _build_markdown(size_kb: int, seed: int) -> str:
    target_bytes = max(1, size_kb) * 1024
    header = f"# TabDoc Benchmark {seed}\n\n"
    line = f"- 行 {seed}: 这是一段用于性能压测的正文，包含 **加粗**、`code`、链接 https://tabtin.ai\n"
    body_parts: list[str] = [header]
    while len("".join(body_parts).encode("utf-8")) < target_bytes:
        body_parts.append(line)
    return "".join(body_parts)


def _build_pm_json(text: str) -> dict[str, Any]:
    return {
        "type": "doc",
        "content": [
            {
                "type": "paragraph",
                "content": [{"type": "text", "text": text}],
            }
        ],
    }


class Command(BaseCommand):
    help = "压测 TabDoc 打开/保存性能并输出 P95 指标"

    def add_arguments(self, parser):
        parser.add_argument(
            "--iterations",
            type=int,
            default=50,
            help="每个阶段（open/save）迭代次数，默认 50",
        )
        parser.add_argument(
            "--size-kb",
            type=int,
            default=64,
            help="文档正文目标大小（KB），默认 64",
        )
        parser.add_argument(
            "--warmup",
            type=int,
            default=5,
            help="预热次数，默认 5",
        )
        parser.add_argument(
            "--keep-data",
            action="store_true",
            help="保留压测生成的文档数据（默认清理）",
        )
        parser.add_argument(
            "--json",
            action="store_true",
            help="输出 JSON 格式结果",
        )

    def handle(self, *args, **options):
        iterations = int(options["iterations"])
        size_kb = int(options["size_kb"])
        warmup = int(options["warmup"])
        keep_data = bool(options["keep_data"])
        json_mode = bool(options["json"])

        if iterations <= 0:
            raise CommandError("--iterations 必须大于 0")
        if size_kb <= 0:
            raise CommandError("--size-kb 必须大于 0")
        if warmup < 0:
            raise CommandError("--warmup 不能小于 0")

        organization_id = str(uuid.uuid4())
        project_id = str(uuid.uuid4())
        service = DocumentService(user=None)
        route_alias = router.db_for_write(Document) or "default"
        route_engine = connections[route_alias].settings_dict.get("ENGINE", "")

        # tabdoc 路由目标是 PostgreSQL；若目标库不是 PostgreSQL，继续执行但标注仅供参考。
        if "postgresql" not in route_engine:
            self.stdout.write(
                self.style.WARNING(
                    f"[WARN] tabdoc 路由数据库({route_alias})不是 PostgreSQL，结果仅供本地参考。"
                )
            )

        # 压测聚焦存储链路，权限/索引更新不纳入测量。
        service._ensure_space_context = lambda *_args, **_kwargs: None
        service.check_space_permission = lambda *_args, **_kwargs: True
        service.check_document_permission = lambda *_args, **_kwargs: True
        service._update_search_vector = lambda *_args, **_kwargs: None

        open_samples: list[float] = []
        save_samples: list[float] = []
        document_id = ""

        markdown = _build_markdown(size_kb=size_kb, seed=0)
        plaintext = service._normalize_plaintext(markdown)
        pm_json = _build_pm_json(markdown)

        with patch("apps.tabdoc.services.document_service.ResourceBridge.on_create"), patch(
            "apps.tabdoc.services.document_service.ResourceBridge.on_update"
        ), patch("apps.tabdoc.tasks.create_document_version.delay", return_value=None):
            document = service.create_document(
                organization_id=organization_id,
                project_id=project_id,
                parent_id=None,
                title="TabDoc Benchmark",
                initial_content_pm_json=pm_json,
                initial_content_markdown=markdown,
                initial_content_plaintext=plaintext,
            )
            document_id = str(document.id)

            # Warmup
            for i in range(warmup):
                service.get_document(document_id, required_role="viewer")
                warm_md = _build_markdown(size_kb=size_kb, seed=10_000 + i)
                document = service.save_content(
                    document,
                    base_version=document.latest_version,
                    content_pm_json=_build_pm_json(warm_md),
                    content_markdown=warm_md,
                    content_plaintext=service._normalize_plaintext(warm_md),
                )

            # Open benchmark
            for _ in range(iterations):
                started = perf_counter()
                service.get_document(document_id, required_role="viewer")
                open_samples.append((perf_counter() - started) * 1000)

            # Save benchmark
            for i in range(iterations):
                md = _build_markdown(size_kb=size_kb, seed=i + 1)
                started = perf_counter()
                document = service.save_content(
                    document,
                    base_version=document.latest_version,
                    content_pm_json=_build_pm_json(md),
                    content_markdown=md,
                    content_plaintext=service._normalize_plaintext(md),
                )
                save_samples.append((perf_counter() - started) * 1000)

        open_summary = _summarize(open_samples)
        save_summary = _summarize(save_samples)

        result = {
            "iterations": iterations,
            "warmup": warmup,
            "size_kb": size_kb,
            "document_id": document_id,
            "open": asdict(open_summary),
            "save": asdict(save_summary),
        }

        if json_mode:
            self.stdout.write(json.dumps(result, ensure_ascii=False, indent=2))
        else:
            self.stdout.write("[TabDoc Benchmark] 完成")
            self.stdout.write(
                "  open(ms): "
                f"avg={open_summary.avg_ms:.2f} p50={open_summary.p50_ms:.2f} "
                f"p95={open_summary.p95_ms:.2f} p99={open_summary.p99_ms:.2f}"
            )
            self.stdout.write(
                "  save(ms): "
                f"avg={save_summary.avg_ms:.2f} p50={save_summary.p50_ms:.2f} "
                f"p95={save_summary.p95_ms:.2f} p99={save_summary.p99_ms:.2f}"
            )
            self.stdout.write(
                f"  meta: iterations={iterations}, warmup={warmup}, size_kb={size_kb}, "
                f"document_id={document_id}, db_alias={route_alias}"
            )

        if not keep_data and document_id:
            DocumentVersion.objects.using(route_alias).filter(document_id=document_id).delete()
            Document.objects.using(route_alias).filter(id=document_id).delete()
