"""W1c · 校验 active LLMModel 的 wire_adapter capability 配置 + 检测 drift。

用法:

    # 校验所有 active chat-capable model
    python manage.py validate_wire_capabilities --all-active

    # 校验指定 model(model_name 子串)
    python manage.py validate_wire_capabilities --model=kimi

    # strict 模式(任何 warning 升级为 error)
    python manage.py validate_wire_capabilities --all-active --strict

    # 输出 JSON 报告
    python manage.py validate_wire_capabilities --all-active --save-report=/tmp/report.json

退出码:
- 0:全部 model 通过(strict 时无 warning)
- 1:至少一个 model 有 error(strict 时含 warning)

输出格式:终端表格 + 详细问题清单。
"""

from __future__ import annotations

import json
import sys
from typing import List

from django.core.management.base import BaseCommand, CommandError

from apps.services.llm.wire_adapter.validator import (
    ValidationReport,
    select_chat_capable_active_models,
    validate_models,
)


# ANSI 颜色(若 stdout 是 tty 才用;非 tty 时降级为纯文本)
class Style:
    RESET = "\033[0m"
    BOLD = "\033[1m"
    GREEN = "\033[32m"
    YELLOW = "\033[33m"
    RED = "\033[31m"
    DIM = "\033[2m"


def _colorize(text: str, style: str, use_color: bool) -> str:
    if not use_color:
        return text
    return f"{style}{text}{Style.RESET}"


class Command(BaseCommand):
    help = "校验 active LLMModel 的 wire_adapter capability 配置 + 检测 drift"

    def add_arguments(self, parser):
        parser.add_argument(
            "--model",
            type=str,
            default=None,
            help="指定 model(model_name 子串匹配)",
        )
        parser.add_argument(
            "--all-active",
            action="store_true",
            help="检查所有 active chat-capable model",
        )
        parser.add_argument(
            "--strict",
            action="store_true",
            help="任何 warning 升级为 error",
        )
        parser.add_argument(
            "--save-report",
            type=str,
            default=None,
            help="输出 JSON 报告到指定路径",
        )
        # 注:Django BaseCommand 已注入 --no-color / --force-color,这里复用

    def handle(self, *args, **opts):
        model_filter = opts.get("model")
        all_active = opts.get("all_active")
        strict = opts.get("strict", False)
        save_report = opts.get("save_report")
        # Django BaseCommand 接管 --no-color,通过 self.style 间接生效;
        # 这里直接 check 终端
        use_color = sys.stdout.isatty() and not opts.get("no_color", False)

        if not model_filter and not all_active:
            raise CommandError("必须指定 --model 或 --all-active")

        models = select_chat_capable_active_models(model_filter)
        if not models:
            self.stdout.write(self.style.WARNING(
                f"没有匹配的 active chat-capable model(filter={model_filter!r})"
            ))
            return

        self.stdout.write(_colorize(
            f"\n校验 {len(models)} 个 active chat-capable model (strict={strict})\n",
            Style.BOLD, use_color,
        ))

        reports = validate_models(models)

        # 表格输出
        self._print_table(reports, strict, use_color)

        # 详细问题清单
        self._print_details(reports, use_color)

        # JSON 报告
        if save_report:
            self._save_json_report(reports, save_report)
            self.stdout.write(_colorize(
                f"\nJSON 报告已写入 {save_report}\n", Style.DIM, use_color,
            ))

        # 总结 + exit code
        n_pass = sum(1 for r in reports if r.passed(strict=strict))
        n_fail = len(reports) - n_pass
        self.stdout.write("")
        if n_fail == 0:
            self.stdout.write(_colorize(
                f"全部 {n_pass}/{len(reports)} 个 model 通过校验"
                + (" (strict)" if strict else ""),
                Style.GREEN, use_color,
            ))
        else:
            self.stdout.write(_colorize(
                f"{n_fail}/{len(reports)} 个 model 未通过校验",
                Style.RED, use_color,
            ))
            sys.exit(1)

    # ------------------------------------------------------------------
    # 输出
    # ------------------------------------------------------------------

    def _print_table(
        self,
        reports: List[ValidationReport],
        strict: bool,
        use_color: bool,
    ) -> None:
        cols = ["Provider", "Model", "Wave", "Cfg", "Err", "Warn", "Status"]
        widths = [10, 42, 12, 4, 4, 5, 8]

        # header
        header = " | ".join(c.ljust(w) for c, w in zip(cols, widths))
        self.stdout.write(_colorize(header, Style.BOLD, use_color))
        self.stdout.write("-" * len(header))

        for r in reports:
            cfg = "yes" if r.is_configured else "NO"
            err_count = len(r.errors)
            warn_count = len(r.warnings)
            passed = r.passed(strict=strict)
            status = "PASS" if passed else "FAIL"

            row_data = [
                r.provider[:widths[0]],
                r.model_name[:widths[1]],
                r.wave_status[:widths[2]],
                cfg[:widths[3]],
                str(err_count)[:widths[4]],
                str(warn_count)[:widths[5]],
                status,
            ]
            row = " | ".join(d.ljust(w) for d, w in zip(row_data, widths))

            if not passed:
                self.stdout.write(_colorize(row, Style.RED, use_color))
            elif warn_count > 0:
                self.stdout.write(_colorize(row, Style.YELLOW, use_color))
            else:
                self.stdout.write(_colorize(row, Style.GREEN, use_color))

    def _print_details(
        self,
        reports: List[ValidationReport],
        use_color: bool,
    ) -> None:
        any_issue = any(r.issues for r in reports)
        if not any_issue:
            return

        self.stdout.write(_colorize("\n=== 问题详情 ===\n", Style.BOLD, use_color))

        for r in reports:
            if not r.issues:
                continue
            header = f"\n[{r.provider}] {r.model_name} ({r.model_id})"
            self.stdout.write(_colorize(header, Style.BOLD, use_color))
            for issue in r.issues:
                if issue.level == "error":
                    color = Style.RED
                    prefix = "ERR"
                elif issue.level == "warning":
                    color = Style.YELLOW
                    prefix = "WARN"
                else:
                    color = Style.DIM
                    prefix = "INFO"
                line = (
                    f"  [{prefix}] {issue.rule} :: {issue.field}\n"
                    f"        {issue.message}"
                )
                if issue.observed is not None:
                    line += f"\n        observed = {issue.observed!r}"
                if issue.expected:
                    line += f"\n        expected = {issue.expected!r}"
                if issue.hint:
                    line += f"\n        hint     = {issue.hint}"
                self.stdout.write(_colorize(line, color, use_color))

    # ------------------------------------------------------------------
    # 报告 / 持久化
    # ------------------------------------------------------------------

    def _save_json_report(
        self,
        reports: List[ValidationReport],
        path: str,
    ) -> None:
        data = {
            "version": "W1c.validate_wire_capabilities.v1",
            "models": [r.to_json() for r in reports],
        }
        with open(path, "w", encoding="utf-8") as fp:
            json.dump(data, fp, ensure_ascii=False, indent=2)

