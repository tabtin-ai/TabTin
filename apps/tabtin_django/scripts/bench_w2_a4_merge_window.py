"""W2 A4 合并窗口推送效率基线。

模拟 500 次 cell 变更 → 统计实际 push_cells 调用次数，
验证合并窗口 (TABDATA_YDOC_MERGE_WINDOW_MS) 的降噪效果。

PRD §A4 验收
------------
500 行批量更新下，前端 push 次数从 500 降到 ≤ 5（合并窗口 80ms）。
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from unittest.mock import MagicMock, patch
from uuid import uuid4

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

_REPO_DJANGO_DIR = Path(__file__).resolve().parent.parent
if str(_REPO_DJANGO_DIR) not in sys.path:
    sys.path.insert(0, str(_REPO_DJANGO_DIR))

import django
from django.apps import apps as django_apps

if not django_apps.ready:
    django.setup()

from django.test import override_settings

from apps.tabdata.subscribers.collab_ydoc import (
    _MergeWindowManager,
    _MERGE_WINDOW_FLUSH_THRESHOLD,
)


def run_merge_bench(num_changes: int = 500, window_ms: int = 80):
    print(f"[A4 Merge] num_changes={num_changes} window_ms={window_ms}")
    mgr = _MergeWindowManager()
    table_id = uuid4()
    table_key = str(table_id)

    mock_push = MagicMock()

    with override_settings(TABDATA_YDOC_MERGE_WINDOW_MS=window_ms):
        with patch(
            "apps.tabdata.subscribers.collab_ydoc._should_skip_push",
            return_value=False,
        ):
            with patch(
                "apps.tabdata.services.collab_service.CollabService.push_cells",
                mock_push,
            ):
                for i in range(num_changes):
                    changes = [
                        {"record_id": f"r{i}", "field_id_hex": "f1", "value": f"v{i}"}
                    ]
                    mgr.add(table_key, table_id, changes, "bench-user")

                push_during = mock_push.call_count
                print(f"[A4 Merge] 窗口内推送次数: {push_during}")

                time.sleep(window_ms / 1000.0 + 0.1)

                mgr.flush_all()
                push_total = mock_push.call_count
                print(f"[A4 Merge] 总推送次数（含 flush）: {push_total}")

    total_cells_pushed = sum(
        len(call.kwargs.get("changes", []))
        for call in mock_push.call_args_list
    )

    reduction_ratio = 1.0 - (push_total / max(num_changes, 1))

    result = {
        "benchmark": "W2-A4-merge_window",
        "num_changes": num_changes,
        "window_ms": window_ms,
        "flush_threshold": _MERGE_WINDOW_FLUSH_THRESHOLD,
        "push_count_during": push_during,
        "push_count_total": push_total,
        "total_cells_pushed": total_cells_pushed,
        "reduction_ratio": round(reduction_ratio, 4),
        "cells_match": total_cells_pushed == num_changes,
        "meets_a4_target": push_total <= 5,
    }

    print(f"[A4 Merge] result: {json.dumps(result, ensure_ascii=False)}")

    if num_changes > 0 and window_ms == 0:
        print("[A4 Merge] 对比：无窗口（window_ms=0）每次 add 立即 push")
        mgr2 = _MergeWindowManager()
        mock_push2 = MagicMock()
        with override_settings(TABDATA_YDOC_MERGE_WINDOW_MS=0):
            with patch(
                "apps.tabdata.subscribers.collab_ydoc._should_skip_push",
                return_value=False,
            ):
                with patch(
                    "apps.tabdata.services.collab_service.CollabService.push_cells",
                    mock_push2,
                ):
                    for i in range(num_changes):
                        changes = [
                            {"record_id": f"r{i}", "field_id_hex": "f1", "value": f"v{i}"}
                        ]
                        mgr2.add(table_key, table_id, changes, "bench-user")
        result["no_window_push_count"] = mock_push2.call_count

    return result


def main():
    out_path = Path("logs/benchmarks/bench_w2_a4_merge_window.json")
    out_path.parent.mkdir(parents=True, exist_ok=True)

    results = {}

    print("=" * 60)
    print("场景 1: 窗口=80ms, 500 次变更")
    results["window_80ms"] = run_merge_bench(500, 80)

    print()
    print("=" * 60)
    print("场景 2: 无窗口(0ms), 500 次变更")
    results["window_0ms"] = run_merge_bench(500, 0)

    print()
    print("=" * 60)
    print("场景 3: 窗口=80ms, 1000 次变更")
    results["window_80ms_1000"] = run_merge_bench(1000, 80)

    out_path.write_text(
        json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8",
    )
    print(f"\n[A4 Merge] JSON: {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
