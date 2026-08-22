"""W1c · 跑 capability self-test probe(W1c dry-run 版,真 API 跑留 W3)。

用法:

    # 跑所有 active model × 所有 probe(dry-run)
    python manage.py llm_capability_test --all-active --dry-run

    # 指定 model
    python manage.py llm_capability_test --model=kimi --dry-run

    # 指定 probe
    python manage.py llm_capability_test --all-active --probe=image_base64 --dry-run

    # 输出 JSON 报告
    python manage.py llm_capability_test --all-active --dry-run --save-report=/tmp/probe.json

    # W3 真发 API(本期 stub,raise NotImplementedError)
    python manage.py llm_capability_test --all-active --live

退出码:
- 0:全部 probe 无 regression(under_claim 不算 fail)
- 1:至少一个 probe regression(declared 但 fail)

输出格式:M model × P probe = M*P 单元格表 + drift 详情。
"""

from __future__ import annotations

import json
import sys
from typing import Dict, List

from django.core.management.base import BaseCommand, CommandError

from apps.services.llm.wire_adapter.probes import (
    ALL_PROBES,
    ProbeResult,
    get_probe_by_name,
    run_probes,
)
from apps.services.llm.wire_adapter.validator import (
    select_chat_capable_active_models,
)


class Style:
    RESET = "\033[0m"
    BOLD = "\033[1m"
    GREEN = "\033[32m"
    YELLOW = "\033[33m"
    RED = "\033[31m"
    BLUE = "\033[34m"
    DIM = "\033[2m"


def _colorize(text: str, style: str, use_color: bool) -> str:
    if not use_color:
        return text
    return f"{style}{text}{Style.RESET}"


# 单元格 emoji-free 标记(避免被风格指南拒绝)
def _cell_marker(drift_type: str) -> str:
    return {
        "none": "OK",
        "gated_aligned": "GT",
        "regression": "RG",
        "under_claim": "UC",
        "unknown": "??",
    }.get(drift_type, "??")


class Command(BaseCommand):
    help = "跑 capability self-test probe(W1c dry-run 版,真 API 跑留 W3)"

    def add_arguments(self, parser):
        parser.add_argument("--model", type=str, default=None,
                            help="指定 model(model_name 子串)")
        parser.add_argument("--all-active", action="store_true",
                            help="跑所有 active chat-capable model")
        parser.add_argument("--probe", type=str, default=None,
                            help=f"指定 probe 名(可选: {','.join(p.name for p in ALL_PROBES)})")
        parser.add_argument("--save-report", type=str, default=None,
                            help="JSON 报告路径")
        parser.add_argument("--dry-run", action="store_true", default=True,
                            help="W1c 默认 dry-run(只构造请求 + 跑 wire_adapter,不真发)")
        parser.add_argument("--live", action="store_true", default=False,
                            help="W3 用,真发 LLM API(本期不实装,留 stub)")
        # 注:Django BaseCommand 已注入 --no-color / --force-color

    def handle(self, *args, **opts):
        model_filter = opts.get("model")
        all_active = opts.get("all_active")
        probe_name = opts.get("probe")
        save_report = opts.get("save_report")
        dry_run = opts.get("dry_run", True)
        live = opts.get("live", False)
        use_color = sys.stdout.isatty() and not opts.get("no_color", False)

        if live:
            raise CommandError(
                "--live 路径在 W1c 不实装(留 W3)。本期只支持 --dry-run。"
            )

        if not model_filter and not all_active:
            raise CommandError("必须指定 --model 或 --all-active")

        models = select_chat_capable_active_models(model_filter)
        if not models:
            self.stdout.write(self.style.WARNING(
                f"没有匹配的 active chat-capable model(filter={model_filter!r})"
            ))
            return

        # 选 probe
        if probe_name:
            probe = get_probe_by_name(probe_name)
            if probe is None:
                raise CommandError(
                    f"未知 probe '{probe_name}'。可选: {','.join(p.name for p in ALL_PROBES)}"
                )
            probes = [probe]
        else:
            probes = ALL_PROBES

        self.stdout.write(_colorize(
            f"\n跑 {len(models)} model × {len(probes)} probe = "
            f"{len(models) * len(probes)} dry-run\n",
            Style.BOLD, use_color,
        ))

        results = run_probes(models, probes=probes, dry_run=True)

        # 表格输出(M model 行 × P probe 列)
        self._print_grid(models, probes, results, use_color)

        # drift 详情
        self._print_drift_details(results, use_color)

        # JSON 报告
        if save_report:
            self._save_json_report(models, probes, results, save_report)
            self.stdout.write(_colorize(
                f"\nJSON 报告已写入 {save_report}\n", Style.DIM, use_color,
            ))

        # 总结 + exit code
        n_regression = sum(1 for r in results if r.drift_type == "regression")
        n_pass = sum(1 for r in results if r.drift_type == "none")
        n_gated = sum(1 for r in results if r.drift_type == "gated_aligned")
        n_under = sum(1 for r in results if r.drift_type == "under_claim")

        self.stdout.write("")
        summary = (
            f"统计: pass={n_pass} gated={n_gated} regression={n_regression} "
            f"under_claim={n_under}"
        )
        self.stdout.write(_colorize(summary, Style.BOLD, use_color))

        if n_regression > 0:
            self.stdout.write(_colorize(
                f"\n{n_regression} 个 probe regression(declared 但 fail),"
                "见上方 drift 详情",
                Style.RED, use_color,
            ))
            sys.exit(1)
        else:
            self.stdout.write(_colorize(
                "全部 probe 无 regression",
                Style.GREEN, use_color,
            ))

    # ------------------------------------------------------------------
    # 表格 + 详情
    # ------------------------------------------------------------------

    def _print_grid(
        self,
        models: List,
        probes: List,
        results: List[ProbeResult],
        use_color: bool,
    ) -> None:
        # results 按 (model, probe) 索引
        result_map: Dict = {}
        for r in results:
            result_map[(r.model_id, r.probe_name)] = r

        # header
        model_col_w = max(36, max((len(m.model_name) for m in models), default=20) + 2)
        probe_col_w = 8
        cells = ["Model".ljust(model_col_w), "Provider".ljust(10)]
        for p in probes:
            cells.append(p.name[:probe_col_w].ljust(probe_col_w))
        header = " | ".join(cells)
        self.stdout.write(_colorize(header, Style.BOLD, use_color))
        self.stdout.write("-" * len(header))

        for m in models:
            row = [m.model_name[:model_col_w].ljust(model_col_w)]
            row.append((m.provider.name or "")[:10].ljust(10))
            for p in probes:
                r = result_map.get((str(m.id), p.name))
                if r is None:
                    cell = "  -  "
                else:
                    marker = _cell_marker(r.drift_type)
                    if r.drift_type == "regression":
                        cell = _colorize(marker.ljust(probe_col_w), Style.RED, use_color)
                    elif r.drift_type == "under_claim":
                        cell = _colorize(marker.ljust(probe_col_w), Style.YELLOW, use_color)
                    elif r.drift_type == "gated_aligned":
                        cell = _colorize(marker.ljust(probe_col_w), Style.BLUE, use_color)
                    elif r.drift_type == "none":
                        cell = _colorize(marker.ljust(probe_col_w), Style.GREEN, use_color)
                    else:
                        cell = _colorize(marker.ljust(probe_col_w), Style.DIM, use_color)
                row.append(cell)
            self.stdout.write(" | ".join(row))

        legend = (
            "\n图例: OK=declared 与 observed 都 pass / "
            "GT=gated 一致 / RG=regression / UC=under_claim / ??=未知"
        )
        self.stdout.write(_colorize(legend, Style.DIM, use_color))

    def _print_drift_details(
        self,
        results: List[ProbeResult],
        use_color: bool,
    ) -> None:
        drifts = [r for r in results if r.drift_type in ("regression", "under_claim", "unknown")]
        if not drifts:
            return
        self.stdout.write(_colorize("\n=== Drift 详情 ===\n", Style.BOLD, use_color))
        for r in drifts:
            color = Style.RED if r.drift_type == "regression" else Style.YELLOW
            line = (
                f"\n[{r.drift_type}] {r.model_name} :: {r.probe_name}\n"
                f"  declared = {r.declared}\n"
                f"  observed = {r.observed}\n"
            )
            if r.error_code:
                line += f"  error_code = {r.error_code}\n"
                line += f"  detail     = {r.error_detail}\n"
            if r.downgrade_events:
                line += f"  downgrade_events = {len(r.downgrade_events)}\n"
                for ev in r.downgrade_events:
                    line += f"    - {ev}\n"
            self.stdout.write(_colorize(line, color, use_color))

    # ------------------------------------------------------------------
    # 报告 / 持久化
    # ------------------------------------------------------------------

    def _save_json_report(
        self,
        models: List,
        probes: List,
        results: List[ProbeResult],
        path: str,
    ) -> None:
        data = {
            "version": "W1c.llm_capability_test.v1",
            "models": [
                {
                    "id": str(m.id),
                    "model_name": m.model_name,
                    "provider": (m.provider.name if m.provider_id else ""),
                    "wave_status": m.wave_status,
                }
                for m in models
            ],
            "probes": [
                {"name": p.name, "description": p.description}
                for p in probes
            ],
            "results": [r.to_json() for r in results],
        }
        with open(path, "w", encoding="utf-8") as fp:
            json.dump(data, fp, ensure_ascii=False, indent=2)

