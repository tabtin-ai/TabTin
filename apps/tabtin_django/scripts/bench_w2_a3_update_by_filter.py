"""W2 A3 update-by-filter 性能基线（service 层直调）。

PRD §A3 验收
------------
1000 行 preflight(count+sample) + atomic commit: p95 < 5s

设计
----
1. 用 fixture 创建真实 Organization → Agent → Space → 表 + 1000 行（ORM + native 双写）。
2. 直调 service 层核心路径：
   - preflight: COUNT(*) + SAMPLE（native SQL）
   - commit: UPDATE ... WHERE filter + RH 写入（native SQL + ORM）
3. 跑 N iterations，测 p50/p95。
4. 自动 cleanup。

环境限制说明
-----------
UpdateByFilterService.preflight/commit 内部查询依赖 Table.db_table_name
属性（当前 model 未定义），fallback 表名不正确。本脚本拆分为两段独立计时：
1. preflight_like: 直接 SQL COUNT + SAMPLE（模拟 preflight 核心开销）
2. commit_like: RecordService.bulk_update_records（模拟 commit 批量写入开销）

用法
----
cd apps/tabtin_django && source venv/bin/activate
RUN_PROD_MODE_FIXTURE_TESTS=1 python scripts/bench_w2_a3_update_by_filter.py
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import statistics
import sys
import traceback
from dataclasses import dataclass
from pathlib import Path
from time import perf_counter
from typing import Any, Dict, List, Optional
from uuid import UUID

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

_REPO_DJANGO_DIR = Path(__file__).resolve().parent.parent
if str(_REPO_DJANGO_DIR) not in sys.path:
    sys.path.insert(0, str(_REPO_DJANGO_DIR))

import django
from django.apps import apps as django_apps

if not django_apps.ready:
    django.setup()

from django.db import connections
from django.utils import timezone

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import Table, TableField, TableRecord
from apps.tabdata.native.ddl_manager import DDLManager
from apps.tabdata.services.record_service import RecordService
from apps.tabtinspace.tests.fixtures import (
    cleanup_test_organization,
    create_test_organization_with_agent,
)


@dataclass
class _BenchUser:
    id: Any
    is_authenticated: bool = True
    is_active: bool = True


def _percentile(values: List[float], pct: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    idx = max(0, min(len(s) - 1, int(len(s) * pct / 100.0)))
    return s[idx]


def _detect_env() -> Dict[str, Any]:
    pg_conn = connections[TABDATA_DB_ALIAS]
    with pg_conn.cursor() as cur:
        cur.execute("SHOW server_version")
        pg_ver = cur.fetchone()[0]
    return {
        "python": platform.python_version(),
        "platform": platform.platform(),
        "django": django.get_version(),
        "postgresql": pg_ver,
    }


def _native_qualified(space_id, table_id) -> str:
    sid = str(space_id).replace("-", "")
    tid = str(table_id).replace("-", "")
    return f'"as_{sid}"."tbl_{tid}"'


def _setup_table(owner_id, space_id, organization_id, run_tag: str, num_rows: int):
    ddl = DDLManager()
    ddl.ensure_schema(space_id)

    tbl = Table.objects.using(TABDATA_DB_ALIAS).create(
        name=f"bench_a3_{run_tag}",
        description=f"W2 A3 bench - {num_rows} rows",
        icon="🔍",
        owner_id=owner_id,
        space_id=space_id,
        organization_id=organization_id,
        row_count=0, field_count=0,
        is_public=False, is_template=False, is_archived=False,
    )
    ddl.create_native_table(space_id, tbl.id)

    pf = TableField.objects.using(TABDATA_DB_ALIAS).create(
        table_id=tbl.id, name="name", field_type="text",
        is_primary=True, order=0, config={},
    )
    status_f = TableField.objects.using(TABDATA_DB_ALIAS).create(
        table_id=tbl.id, name="status", field_type="text",
        order=1, config={},
    )
    nf = TableField.objects.using(TABDATA_DB_ALIAS).create(
        table_id=tbl.id, name="amount", field_type="number",
        order=2, config={"precision": 0},
    )
    for f in (pf, status_f, nf):
        ddl.add_column(space_id, tbl.id, f.id, f.field_type, f.config or {})

    records = []
    for i in range(num_rows):
        records.append(TableRecord(
            table_id=tbl.id,
            data={
                str(pf.id): f"R{i:06d}",
                str(status_f.id): "pending",
                str(nf.id): i,
            },
            order=float(i + 1), version=1, status="active", tags=[],
            created_by_id=owner_id, updated_by_id=owner_id,
        ))
    TableRecord.objects.using(TABDATA_DB_ALIAS).bulk_create(records, batch_size=1000)

    from apps.tabdata.native.record_io import NativeRecordIO
    nio = NativeRecordIO(space_id, tbl.id)
    native_inserts = []
    for r in records:
        row = {"__id": str(r.id)}
        for fld in (pf, status_f, nf):
            row[fld.id.hex] = r.data.get(str(fld.id))
        native_inserts.append(row)
    for batch_start in range(0, len(native_inserts), 500):
        batch = native_inserts[batch_start:batch_start + 500]
        nio.bulk_insert_records(batch)

    Table.objects.using(TABDATA_DB_ALIAS).filter(id=tbl.id).update(
        row_count=num_rows, field_count=3,
    )
    return {
        "table": tbl, "primary_field": pf,
        "status_field": status_f, "number_field": nf,
        "records": records,
    }


def _cleanup(fixture, ctx):
    try:
        tbl = fixture["table"]
        from apps.tabdata.models import RecordHistory, RecordHistoryItem
        rids = list(
            TableRecord.objects.using(TABDATA_DB_ALIAS)
            .filter(table_id=tbl.id).values_list("id", flat=True)
        )
        if rids:
            RecordHistoryItem.objects.using(TABDATA_DB_ALIAS).filter(
                record_id__in=rids
            )._raw_delete(TABDATA_DB_ALIAS)
            RecordHistory.objects.using(TABDATA_DB_ALIAS).filter(
                record_id__in=rids
            )._raw_delete(TABDATA_DB_ALIAS)
        TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=tbl.id
        )._raw_delete(TABDATA_DB_ALIAS)
        TableField.objects.using(TABDATA_DB_ALIAS).filter(table_id=tbl.id).delete()
        Table.objects.using(TABDATA_DB_ALIAS).filter(id=tbl.id).delete()
        DDLManager().drop_schema(tbl.space_id)
    except Exception as e:
        print(f"[Bench] cleanup 部分失败: {e}")
    cleanup_test_organization(ctx["organization"], delete_user=True)


def _reset_status(fixture):
    """每轮后把 status 重置为 pending（native + ORM data 双写）。"""
    tbl = fixture["table"]
    sf_id = str(fixture["status_field"].id)
    sf_hex = fixture["status_field"].id.hex
    qualified = _native_qualified(tbl.space_id, tbl.id)
    conn = connections[TABDATA_DB_ALIAS]
    with conn.cursor() as cur:
        cur.execute(f'UPDATE {qualified} SET "{sf_hex}" = %s', ["pending"])
        cur.execute(
            "UPDATE tabdata_record SET data = jsonb_set("
            "COALESCE(data, '{}'::jsonb), %s, %s::jsonb, true) "
            "WHERE table_id = %s AND is_deleted = false",
            ['{' + sf_id + '}', '"pending"', str(tbl.id)],
        )


def run_bench(rows: int, iterations: int, run_tag: str, output: Optional[str]):
    env = _detect_env()
    started = timezone.now().isoformat()
    print(f"[A3 Bench] rows={rows} iterations={iterations} run_tag={run_tag}")

    ctx = create_test_organization_with_agent(prefix=f"bench_a3_{run_tag}")
    fixture = _setup_table(
        ctx["user"].id, ctx["space"].id, ctx["organization"].id, run_tag, rows,
    )
    tbl = fixture["table"]
    sf = fixture["status_field"]
    sf_hex = sf.id.hex
    qualified = _native_qualified(tbl.space_id, tbl.id)
    print(f"[A3 Bench] table={tbl.id}, {rows} rows, native={qualified}")

    user = ctx["user"]
    sf_id = str(sf.id)

    # Review L29 修复：直接走 UpdateByFilterService.preflight + commit
    # （而不是 RecordService.bulk_update_records 的代理路径），符合 D18
    # 「性能声称必须基于真实路径实测」要求。
    from apps.tabdata.services.update_by_filter_service import UpdateByFilterService
    a3_svc = UpdateByFilterService(user=user, space_id=str(tbl.space_id))

    iter_results = []
    errors = []

    try:
        for it in range(1, iterations + 1):
            print(f"[A3 iter {it}/{iterations}] start")
            t0 = perf_counter()

            try:
                # Phase 1: 真实 preflight（含 confirm_token 签发）
                filter_clause = {sf_id: {"$eq": "pending"}}
                patch = {sf_id: "overdue"}

                preflight_resp = a3_svc.preflight(
                    table_id=str(tbl.id),
                    filter_clause=filter_clause,
                    patch=patch,
                )
                matched = preflight_resp["matched_total"]
                token = preflight_resp["confirm_token"]
                preflight_ms = round((perf_counter() - t0) * 1000, 2)
                print(f"[A3 iter {it}] preflight={preflight_ms}ms matched={matched}")

                # Phase 2: 真实 commit（直调 service，不绕道）
                t1 = perf_counter()
                status, commit_resp = a3_svc.commit(
                    table_id=str(tbl.id),
                    confirm_token=token,
                    filter_clause=filter_clause,
                    patch=patch,
                )
                commit_ms = round((perf_counter() - t1) * 1000, 2)
                total_ms = round((perf_counter() - t0) * 1000, 2)
                updated_count = commit_resp.get("updated_count", 0)
                errs: list = []
                if status != 200:
                    errs.append(f"status={status}")

                print(
                    f"[A3 iter {it}] commit={commit_ms}ms "
                    f"updated={updated_count} errors={len(errs)} total={total_ms}ms "
                    f"status={status}"
                )
                iter_results.append({
                    "iteration": it,
                    "rows": rows,
                    "matched_total": matched,
                    "updated_count": updated_count,
                    "error_count": len(errs),
                    "preflight_ms": preflight_ms,
                    "commit_ms": commit_ms,
                    "total_ms": total_ms,
                })
                if errs:
                    errors.extend(errs[:3])

                _reset_status(fixture)

            except Exception as exc:
                elapsed = round((perf_counter() - t0) * 1000, 2)
                iter_results.append({
                    "iteration": it,
                    "rows": rows,
                    "matched_total": 0,
                    "updated_count": 0,
                    "preflight_ms": elapsed,
                    "commit_ms": 0,
                    "total_ms": elapsed,
                    "exception": str(exc),
                })
                errors.append(f"iter {it}: {type(exc).__name__}: {exc}")
                print(f"[A3 iter {it}] FAILED ({elapsed}ms): {exc}")
                traceback.print_exc()
                try:
                    _reset_status(fixture)
                except Exception:
                    pass

    finally:
        _cleanup(fixture, ctx)
        print("[A3 Bench] cleanup OK")

    total_list = [r["total_ms"] for r in iter_results if r.get("updated_count", 0) > 0]
    pf_list = [r["preflight_ms"] for r in iter_results if r.get("updated_count", 0) > 0]
    cm_list = [r["commit_ms"] for r in iter_results if r.get("updated_count", 0) > 0]
    n = len(total_list)
    p95_label = "p95" if n >= 10 else f"p95(approx-max,n={n})"
    target_ms = 5000.0

    summary = {
        "rows": rows,
        "iterations": iterations,
        "method": "UpdateByFilterService.preflight + commit (real path, L29 fixed)",
        "total_p50_ms": round(statistics.median(total_list), 2) if total_list else None,
        "total_p95_ms": round(_percentile(total_list, 95), 2) if total_list else None,
        "preflight_p50_ms": round(statistics.median(pf_list), 2) if pf_list else None,
        "commit_p50_ms": round(statistics.median(cm_list), 2) if cm_list else None,
        "commit_p95_ms": round(_percentile(cm_list, 95), 2) if cm_list else None,
        "min_ms": round(min(total_list), 2) if total_list else None,
        "max_ms": round(max(total_list), 2) if total_list else None,
        "p95_label": p95_label,
        "target_p95_ms": target_ms,
        "meets_a3_sla": (_percentile(total_list, 95) < target_ms) if total_list else False,
    }

    report = {
        "benchmark": "W2-A3-update_by_filter",
        "scenario": {"rows": rows, "iterations": iterations},
        "started_at": started,
        "finished_at": timezone.now().isoformat(),
        "environment": env,
        "iterations": iter_results,
        "summary": summary,
        "errors": errors[:20],
    }

    print(f"[A3 Bench] summary: {json.dumps(summary, ensure_ascii=False)}")

    if output:
        out_path = Path(output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8",
        )
        print(f"[A3 Bench] JSON: {out_path}")

    return report


def main():
    parser = argparse.ArgumentParser(description="W2 A3 update-by-filter bench")
    parser.add_argument("--rows", type=int, default=1000)
    parser.add_argument("--iterations", type=int, default=3)
    parser.add_argument("--run-tag", type=str, default="")
    parser.add_argument("--output", type=str, default="")
    args = parser.parse_args()

    tag = args.run_tag or timezone.now().strftime("%Y%m%d_%H%M%S")
    out = args.output or f"logs/benchmarks/bench_w2_a3_{tag}.json"
    try:
        run_bench(args.rows, args.iterations, tag, out)
        return 0
    except Exception:
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
