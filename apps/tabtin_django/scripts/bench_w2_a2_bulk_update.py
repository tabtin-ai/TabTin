"""W2 A2 bulk_update_records 性能基线。

PRD §A2 验收
------------
500 行 bulk update 单字段: p95 < 2s
1000 行 bulk update 单字段: p95 < 5s

设计
----
1. 用 fixture 创建真实 Organization → Agent → Space → 表 + 500 行。
2. 通过 RecordService.bulk_update_records 更新 1 个 number 字段。
3. 跑 N iterations，测 p50/p95。
4. 自动 cleanup。

用法
----
cd apps/tabtin_django && source venv/bin/activate
RUN_PROD_MODE_FIXTURE_TESTS=1 python scripts/bench_w2_a2_bulk_update.py
RUN_PROD_MODE_FIXTURE_TESTS=1 python scripts/bench_w2_a2_bulk_update.py --rows 1000 --iterations 3
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import statistics
import sys
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from time import perf_counter
from typing import Any, Dict, List, Optional
from uuid import uuid4

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


def _setup_table(owner_id, space_id, organization_id, run_tag: str, num_rows: int):
    ddl = DDLManager()
    ddl.ensure_schema(space_id)

    tbl = Table.objects.using(TABDATA_DB_ALIAS).create(
        name=f"bench_a2_{run_tag}",
        description=f"W2 A2 bench - {num_rows} rows",
        icon="📝",
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
    nf = TableField.objects.using(TABDATA_DB_ALIAS).create(
        table_id=tbl.id, name="amount", field_type="number",
        order=1, config={"precision": 0},
    )
    for f in (pf, nf):
        ddl.add_column(space_id, tbl.id, f.id, f.field_type, f.config or {})

    records = []
    for i in range(num_rows):
        records.append(TableRecord(
            table_id=tbl.id,
            data={pf.id.hex: f"R{i:06d}", nf.id.hex: i},
            order=float(i + 1), version=1, status="active", tags=[],
            created_by_id=owner_id, updated_by_id=owner_id,
        ))
    TableRecord.objects.using(TABDATA_DB_ALIAS).bulk_create(records, batch_size=1000)

    from apps.tabdata.native.record_io import NativeRecordIO
    nio = NativeRecordIO(space_id, tbl.id)
    native_inserts = []
    for r in records:
        native_inserts.append({
            "__id": str(r.id),
            pf.id.hex: r.data.get(pf.id.hex),
            nf.id.hex: r.data.get(nf.id.hex),
        })
    for batch_start in range(0, len(native_inserts), 500):
        nio.bulk_insert_records(native_inserts[batch_start:batch_start + 500])

    Table.objects.using(TABDATA_DB_ALIAS).filter(id=tbl.id).update(
        row_count=num_rows, field_count=2,
    )
    return {"table": tbl, "primary_field": pf, "number_field": nf, "records": records}


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


def run_bench(rows: int, iterations: int, run_tag: str, output: Optional[str]):
    env = _detect_env()
    started = timezone.now().isoformat()
    print(f"[A2 Bench] rows={rows} iterations={iterations} run_tag={run_tag}")
    print(f"[A2 Bench] env: PG={env['postgresql']} Py={env['python']}")

    ctx = create_test_organization_with_agent(prefix=f"bench_a2_{run_tag}")
    print(f"[A2 Bench] fixture: space={ctx['space'].id}")

    fixture = _setup_table(
        ctx["user"].id, ctx["space"].id, ctx["organization"].id, run_tag, rows,
    )
    print(f"[A2 Bench] table={fixture['table'].id}, {rows} rows created")

    user = _BenchUser(id=ctx["user"].id)
    svc = RecordService(user=user)
    nf_id = str(fixture["number_field"].id)
    record_ids = [str(r.id) for r in fixture["records"]]

    iter_results = []
    errors = []

    tbl = fixture["table"]
    nf_hex = fixture["number_field"].id.hex
    qualified = f'"as_{str(tbl.space_id).replace("-", "")}"."tbl_{str(tbl.id).replace("-", "")}"'

    def _verify_native_value(expected_min: int, expected_max: int) -> dict:
        """读 native 列的实际值，验证 P0-3 修复（native 列真的写入了）"""
        with connections[TABDATA_DB_ALIAS].cursor() as cur:
            cur.execute(
                f'SELECT COUNT(*), MIN("{nf_hex}"), MAX("{nf_hex}") FROM {qualified}'
            )
            row = cur.fetchone()
        return {
            "native_count": int(row[0] or 0),
            "native_min": row[1],
            "native_max": row[2],
            "expected_min": expected_min,
            "expected_max": expected_max,
            "matches": (
                row[1] is not None
                and row[2] is not None
                and float(row[1]) == float(expected_min)
                and float(row[2]) == float(expected_max)
            ),
        }

    try:
        for it in range(1, iterations + 1):
            base = it * 1000
            updates = [
                {"record_id": rid, "data": {nf_id: base + idx}}
                for idx, rid in enumerate(record_ids)
            ]
            print(f"[A2 iter {it}/{iterations}] updating {len(updates)} records...")
            t0 = perf_counter()
            try:
                updated, errs = svc.bulk_update_records(updates)
                elapsed_ms = round((perf_counter() - t0) * 1000, 2)
                native_check = _verify_native_value(
                    expected_min=base,
                    expected_max=base + len(record_ids) - 1,
                )
                iter_results.append({
                    "iteration": it,
                    "rows": len(updates),
                    "updated_count": len(updated),
                    "error_count": len(errs),
                    "elapsed_ms": elapsed_ms,
                    "native_check": native_check,
                })
                print(
                    f"[A2 iter {it}] elapsed={elapsed_ms}ms updated={len(updated)} errors={len(errs)} "
                    f"native_match={native_check['matches']} "
                    f"native_min={native_check['native_min']} native_max={native_check['native_max']}"
                )
                if not native_check['matches']:
                    print(f"[A2 iter {it}] ❌ NATIVE 列校验失败！expected={base}-{base + len(record_ids) - 1} got={native_check['native_min']}-{native_check['native_max']}")
                if errs:
                    errors.extend(errs[:5])
            except Exception as exc:
                elapsed_ms = round((perf_counter() - t0) * 1000, 2)
                iter_results.append({
                    "iteration": it,
                    "rows": len(updates),
                    "updated_count": 0,
                    "error_count": 1,
                    "elapsed_ms": elapsed_ms,
                    "exception": str(exc),
                })
                errors.append(f"iter {it}: {type(exc).__name__}: {exc}")
                print(f"[A2 iter {it}] FAILED ({elapsed_ms}ms): {exc}")
                traceback.print_exc()
    finally:
        _cleanup(fixture, ctx)
        print("[A2 Bench] cleanup OK")

    elapsed_list = [r["elapsed_ms"] for r in iter_results if r.get("updated_count", 0) > 0]
    n = len(elapsed_list)
    p95_label = "p95" if n >= 10 else f"p95(approx-max,n={n})"
    target_ms = 2000.0 if rows <= 500 else 5000.0

    summary = {
        "rows": rows,
        "iterations": iterations,
        "update_field": "number (1 field)",
        "p50_ms": round(statistics.median(elapsed_list), 2) if elapsed_list else None,
        "p95_ms": round(_percentile(elapsed_list, 95), 2) if elapsed_list else None,
        "min_ms": round(min(elapsed_list), 2) if elapsed_list else None,
        "max_ms": round(max(elapsed_list), 2) if elapsed_list else None,
        "mean_ms": round(statistics.fmean(elapsed_list), 2) if elapsed_list else None,
        "p95_label": p95_label,
        "target_p95_ms": target_ms,
        "meets_a2_sla": (_percentile(elapsed_list, 95) < target_ms) if elapsed_list else False,
    }

    report = {
        "benchmark": "W2-A2-bulk_update_records",
        "scenario": {"rows": rows, "iterations": iterations, "field_count": 1},
        "started_at": started,
        "finished_at": timezone.now().isoformat(),
        "environment": env,
        "iterations": iter_results,
        "summary": summary,
        "errors": errors[:20],
    }

    print(f"[A2 Bench] summary: {json.dumps(summary, ensure_ascii=False)}")

    if output:
        out_path = Path(output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[A2 Bench] JSON: {out_path}")

    return report


def main():
    parser = argparse.ArgumentParser(description="W2 A2 bulk_update_records bench")
    parser.add_argument("--rows", type=int, default=500)
    parser.add_argument("--iterations", type=int, default=5)
    parser.add_argument("--run-tag", type=str, default="")
    parser.add_argument("--output", type=str, default="")
    args = parser.parse_args()

    tag = args.run_tag or timezone.now().strftime("%Y%m%d_%H%M%S")
    out = args.output or f"logs/benchmarks/bench_w2_a2_{tag}.json"
    try:
        run_bench(args.rows, args.iterations, tag, out)
        return 0
    except Exception:
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
