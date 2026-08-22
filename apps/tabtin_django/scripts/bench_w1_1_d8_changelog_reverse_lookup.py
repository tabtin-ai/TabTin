"""W1.1-D8 ChangeLog reverse lookup 真测(替代 W1.1 子 Agent 标的 mock)。

W1.1 子 Agent 在交付时声称 "ChangeLog 1000 行 reverse lookup < 100ms",
但实际是 mock 测试 (sysinfo 决策 D18 已采纳)。本脚本对真实 PG 上的
``ChangeLog.objects.filter(agent_run_id__in=...)`` 做 1000 / 10000 / 50000
行规模实测,验证 / 纠正 W1.1 性能声称。

测试方法
--------
1. 用 raw SQL 批量 ``COPY`` (PG 原生 bulk insert) 在已 migrate 的 dev PG 上
   插入 N 条 ChangeLog 记录,所有记录共享同一个 ``agent_run_id`` (worst case:
   全部命中 reverse lookup)。
2. 跑 ``ChangeLog.objects.using(postgres_app_db_alias()).filter(agent_run_id__in=[...])
   .values_list('resource_type', 'resource_id', 'change_type', 'summary')[:200]``
   (与 ``checkpoint_context.build_checkpoint_impact`` 的真实 query 一致)。
3. 跑 5 轮 warmup + 10 轮测量,取 p50 / p95 / p99。
4. 对照 W1.1 子 Agent 标的 mock 数值,给出"实测 vs 期望"对比。
5. 测试结束清理插入的 ChangeLog。

用法
----
    cd apps/tabtin_django && source venv/bin/activate
    python scripts/bench_w1_1_d8_changelog_reverse_lookup.py
    python scripts/bench_w1_1_d8_changelog_reverse_lookup.py --rows 50000
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
from pathlib import Path
from time import perf_counter
from typing import Dict, List
from uuid import uuid4

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

_REPO_DJANGO_DIR = Path(__file__).resolve().parent.parent
if str(_REPO_DJANGO_DIR) not in sys.path:
    sys.path.insert(0, str(_REPO_DJANGO_DIR))

import django  # noqa: E402

django.setup()

from django.db import connections  # noqa: E402
from django.utils import timezone  # noqa: E402

from apps.collab.models import ChangeLog  # noqa: E402
from apps.services.common.db_router import postgres_app_db_alias


def _percentile(values: List[float], pct: float) -> float:
    if not values:
        return 0.0
    sv = sorted(values)
    idx = max(0, min(len(sv) - 1, int(len(sv) * pct / 100.0)))
    return sv[idx]


def _seed_changelog_rows(*, agent_run_id: str, rows: int) -> str:
    """用 raw INSERT bulk 写入 N 条 ChangeLog,共享同一个 agent_run_id。"""
    conn = connections[postgres_app_db_alias()]
    now = timezone.now()
    batch_size = 1000
    inserted = 0
    sql_prefix = (
        "INSERT INTO collab_change_log "
        "(id, resource_type, resource_id, change_type, summary, "
        "changes, editor_type, editor_id, editor_name, agent_run_id, "
        "session_id, version_history_id, metadata, created_at) VALUES "
    )
    with conn.cursor() as cur:
        for batch_start in range(0, rows, batch_size):
            batch_end = min(batch_start + batch_size, rows)
            value_blocks = []
            param_list: List = []
            for i in range(batch_start, batch_end):
                value_blocks.append(
                    "(%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)"
                )
                param_list.extend([
                    str(uuid4()), "table", str(uuid4()), "update",
                    f"bench seed row {i}", json.dumps({"row": i}),
                    "agent", "bench-editor", "Bench Editor",
                    agent_run_id, f"sess-{i % 10}",
                    None, json.dumps({}), now,
                ])
            cur.execute(sql_prefix + ", ".join(value_blocks), param_list)
            inserted += (batch_end - batch_start)
    return agent_run_id


def _measure_reverse_lookup(
    *,
    agent_run_id: str,
    iterations: int = 10,
    warmup: int = 5,
    limit: int = 200,
) -> Dict:
    """测量 ChangeLog.filter(agent_run_id__in=[run]).values_list(...)[:limit]。"""
    samples_ms: List[float] = []
    counts: List[int] = []
    for _ in range(warmup):
        list(
            ChangeLog.objects.using(postgres_app_db_alias())
            .filter(agent_run_id__in=[agent_run_id])
            .values("resource_type", "resource_id", "change_type", "summary")[:limit]
        )
    for _ in range(iterations):
        start = perf_counter()
        rows = list(
            ChangeLog.objects.using(postgres_app_db_alias())
            .filter(agent_run_id__in=[agent_run_id])
            .values("resource_type", "resource_id", "change_type", "summary")[:limit]
        )
        samples_ms.append((perf_counter() - start) * 1000.0)
        counts.append(len(rows))
    cnt_total = ChangeLog.objects.using(postgres_app_db_alias()).filter(
        agent_run_id__in=[agent_run_id],
    ).count()
    return {
        "iterations": iterations,
        "warmup": warmup,
        "limit": limit,
        "fetched_per_iteration": counts[0] if counts else 0,
        "total_matching_rows": cnt_total,
        "p50_ms": round(statistics.median(samples_ms), 3),
        "p95_ms": round(_percentile(samples_ms, 95), 3),
        "p99_ms": round(_percentile(samples_ms, 99), 3),
        "max_ms": round(max(samples_ms), 3),
        "mean_ms": round(statistics.fmean(samples_ms), 3),
    }


def _measure_count_only(
    *, agent_run_id: str, iterations: int = 10, warmup: int = 5,
) -> Dict:
    """测量 ChangeLog.filter(agent_run_id__in=[run]).count() 单查询."""
    samples_ms: List[float] = []
    qs = ChangeLog.objects.using(postgres_app_db_alias()).filter(agent_run_id__in=[agent_run_id])
    for _ in range(warmup):
        qs.count()
    for _ in range(iterations):
        start = perf_counter()
        qs.count()
        samples_ms.append((perf_counter() - start) * 1000.0)
    return {
        "iterations": iterations,
        "warmup": warmup,
        "p50_ms": round(statistics.median(samples_ms), 3),
        "p95_ms": round(_percentile(samples_ms, 95), 3),
        "p99_ms": round(_percentile(samples_ms, 99), 3),
        "max_ms": round(max(samples_ms), 3),
        "mean_ms": round(statistics.fmean(samples_ms), 3),
    }


def _cleanup(agent_run_id: str) -> int:
    qs = ChangeLog.objects.using(postgres_app_db_alias()).filter(agent_run_id=agent_run_id)
    deleted = qs._raw_delete("postgresql")
    return deleted


def run_scale(rows: int) -> Dict:
    print(f"\n[D8 bench] === rows={rows} ===")
    agent_run_id = f"bench_d8_{uuid4().hex[:12]}"
    print(f"[D8 bench] seeding {rows} rows agent_run_id={agent_run_id}")
    seed_start = perf_counter()
    _seed_changelog_rows(agent_run_id=agent_run_id, rows=rows)
    seed_ms = (perf_counter() - seed_start) * 1000.0
    print(f"[D8 bench] seed done in {seed_ms:.1f} ms")

    try:
        rl = _measure_reverse_lookup(agent_run_id=agent_run_id)
        ct = _measure_count_only(agent_run_id=agent_run_id)
        print(
            f"[D8 bench rows={rows}] reverse_lookup top-200: "
            f"p50={rl['p50_ms']} p95={rl['p95_ms']} p99={rl['p99_ms']} ms "
            f"(matched_total={rl['total_matching_rows']})"
        )
        print(
            f"[D8 bench rows={rows}] count_only: "
            f"p50={ct['p50_ms']} p95={ct['p95_ms']} p99={ct['p99_ms']} ms"
        )
        return {
            "rows": rows,
            "seed_ms": round(seed_ms, 2),
            "reverse_lookup": rl,
            "count_only": ct,
            "w1_1_claim_ms": 100,  # W1.1 子 Agent 声称 < 100ms
            "meets_w1_1_claim": rl["p95_ms"] < 100,
        }
    finally:
        deleted = _cleanup(agent_run_id)
        print(f"[D8 bench] cleanup deleted {deleted} rows")


def main():
    parser = argparse.ArgumentParser(description="W1.1-D8 ChangeLog reverse lookup bench")
    parser.add_argument(
        "--rows",
        type=int,
        nargs="+",
        default=[1000, 10000],
        help="要 seed 的 ChangeLog 行数（多个为阶梯测试）",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=_REPO_DJANGO_DIR / "logs" / "benchmarks" / "bench_w1_1_d8_changelog.json",
    )
    args = parser.parse_args()

    results = []
    for rows in args.rows:
        try:
            results.append(run_scale(rows))
        except Exception as exc:
            print(f"[D8 bench rows={rows}] FAILED: {exc}")
            results.append({"rows": rows, "error": str(exc)})

    output = {
        "scenario": "ChangeLog reverse lookup by agent_run_id",
        "started_at": timezone.now().isoformat(),
        "scales": results,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n[D8 bench] report: {args.output}")

    # 简单的 W1.1 vs 实测对比表格
    print("\n[D8 bench] W1.1 mock claim 校核:")
    print("  rows | p95 (top-200) | meets <100ms?")
    print("  ---- | ------------- | -------------")
    for r in results:
        if "error" in r:
            print(f"  {r['rows']} | ERROR | n/a")
        else:
            print(f"  {r['rows']:5d} | {r['reverse_lookup']['p95_ms']:8.2f} ms | {'✓' if r['meets_w1_1_claim'] else '✗'}")


if __name__ == "__main__":
    main()
