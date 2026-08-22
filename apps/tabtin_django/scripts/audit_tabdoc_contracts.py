#!/usr/bin/env python3
"""TabDoc 端点静态契约审计器（机器视角）。

定位
====
本脚本是 **工程层的自动检测**——它不关心"agent 哪个能力用得多"（那是
产品层的事，由 ``docs/agent/tabdoc-coverage-progress.md`` 用人肉判断维护）。
它只回答两个机械问题：

1. **CLI ↔ Django 路径对齐**：Go CLI 在 ``apps_doc.go`` 里声明的 ``Path:``
   有没有对应的 Django ``@router`` 端点？反之 Django 有的 CLI 是不是都暴露了？
2. **契约覆盖统计**：每个 Django 端点是不是已经被 ``test_*_api.py``（SimpleTestCase
   + mock）覆盖？

它**不输出**：
- 优先级判断（这是产品决策，要看 agent 真实使用场景，不是机器猜得出来的）
- 谁应该先补测试（同上）
- 谁更"风险高"（同上）

它**输出**：
- CRITICAL drift（CLI 调了 Django 没的端点）—— 必跪 bug，CI 闸门必拦
- 覆盖率数字（X/Y 已契约覆盖）
- Django-only 端点清单（CLI 没暴露的 UI/集成端点，参考用）

数据源
------
- ``packages/tabtin-cli-go/cmd/apps_doc.go`` 的 ``Path:`` / ``Method:`` 声明
- ``apps/tabtin_django/apps/tabdoc/api.py`` + ``api_share.py`` 的 ``@router.xxx`` 装饰器
- ``apps/tabtin_django/apps/tabdoc/tests/test_*_api.py`` 里的 URL/URL_TPL 常量

用法
----
    # 打印 stdout 摘要（默认）
    python audit_tabdoc_contracts.py

    # CI mode：CLI-only drift 必须 0，否则 exit 1
    python audit_tabdoc_contracts.py --check

    # 完整 JSON 数据（供 CI 报告 / dashboard 消费）
    python audit_tabdoc_contracts.py --json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


# ---------------------------------------------------------------------------
# Path resolution（脚本自己探仓库根，不依赖 cwd）
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parents[3]
GO_CLI_FILE = REPO_ROOT / "packages/tabtin-cli-go/cmd/apps_doc.go"
DJANGO_API_FILES = [
    REPO_ROOT / "apps/tabtin_django/apps/tabdoc/api.py",
    REPO_ROOT / "apps/tabtin_django/apps/tabdoc/api_share.py",
]
TEST_DIR = REPO_ROOT / "apps/tabtin_django/apps/tabdoc/tests"
DJANGO_PREFIX = "/api/tabdoc"


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------


@dataclass
class Endpoint:
    method: str
    path: str           # 归一化路径（{x} → {PARAM}）
    raw_path: str       # 原始路径
    source: str         # "cli_go" / "django_api" / "django_share"
    summary: str = ""
    line: int = 0
    cli_command: str = ""  # 仅 CLI 端点有：对应的 cobra 末段命令名（如 "create"）


# ---------------------------------------------------------------------------
# Path normalization
# ---------------------------------------------------------------------------

# CLI 用 ``{document_id}``、Django 用 ``{document_id}`` 一致；万一历史不一致
# （如某处写 ``{id}``）也通过统一替换成 ``{PARAM}`` 来允许等价比较。
_PARAM_RE = re.compile(r"\{[^/}]+\}")


def normalize_path(path: str) -> str:
    return _PARAM_RE.sub("{PARAM}", path)


# ---------------------------------------------------------------------------
# Extractors
# ---------------------------------------------------------------------------

_CLI_METHOD_RE = re.compile(r'Method:\s+"(GET|POST|PATCH|DELETE|PUT)"')
_CLI_PATH_RE = re.compile(r'Path:\s+"(/api/tabdoc/[^"]+)"')
_CLI_USE_RE = re.compile(r'Use:\s+"([a-z][a-z0-9\-]*)\b')


def extract_cli_endpoints(go_file: Path) -> list[Endpoint]:
    """从 ``apps_doc.go`` 抽 (Method, Path) 对，并尽量配对最近的 ``Use:`` 命令名。

    apps_doc.go 风格固定：
    - 同行：``Route: cmdutil.RouteCliServer, Method: "POST", Path: "/api/..."``
    - 分行：``Method: "POST",`` 紧接 ``Path: "/api/..."``

    Method 与 Path 行距 ≤ 3。Use 在 Path 上方 ≤ 80 行。
    """
    if not go_file.exists():
        return []
    lines = go_file.read_text(encoding="utf-8").splitlines()

    methods: list[tuple[int, str]] = []
    paths: list[tuple[int, str]] = []
    uses: list[tuple[int, str]] = []
    for i, line in enumerate(lines, start=1):
        if m := _CLI_METHOD_RE.search(line):
            methods.append((i, m.group(1)))
        if m := _CLI_PATH_RE.search(line):
            paths.append((i, m.group(1)))
        if m := _CLI_USE_RE.search(line):
            uses.append((i, m.group(1)))

    endpoints: list[Endpoint] = []
    for path_line, path in paths:
        method_val = "UNKNOWN"
        for m_line, m_val in methods:
            if 0 <= path_line - m_line <= 3:
                method_val = m_val
        cli_cmd = ""
        for u_line, u_val in uses:
            if 0 < path_line - u_line <= 80:
                cli_cmd = u_val  # 不 break，让"最近的"覆盖
        endpoints.append(
            Endpoint(
                method=method_val,
                path=normalize_path(path),
                raw_path=path,
                source="cli_go",
                line=path_line,
                cli_command=cli_cmd,
            )
        )
    return endpoints


# Django: 跨多行匹配 ``@router.<method>(\n? "/path", ..., summary="...")``
_DJANGO_DECORATOR_RE = re.compile(
    r'@router\.(get|post|patch|delete|put)\s*\(\s*'
    r'(?:[\n\s]*)?'
    r'"([^"]+)"'
    r'(?:[^)]*?summary\s*=\s*"([^"]*)")?',
    re.DOTALL,
)


def extract_django_endpoints(api_file: Path) -> list[Endpoint]:
    if not api_file.exists():
        return []
    source = api_file.read_text(encoding="utf-8")
    source_tag = "django_share" if api_file.name == "api_share.py" else "django_api"
    endpoints: list[Endpoint] = []
    for m in _DJANGO_DECORATOR_RE.finditer(source):
        method = m.group(1).upper()
        rel_path = m.group(2)
        summary = m.group(3) or ""
        if not rel_path.startswith("/"):
            continue
        full_path = DJANGO_PREFIX + rel_path
        line_no = source[: m.start()].count("\n") + 1
        endpoints.append(
            Endpoint(
                method=method,
                path=normalize_path(full_path),
                raw_path=full_path,
                source=source_tag,
                summary=summary,
                line=line_no,
            )
        )
    return endpoints


_TEST_URL_RE = re.compile(r'(?:URL|URL_TPL)\s*=\s*["\'](/api/tabdoc/[^"\']+)["\']')
_TEST_INLINE_URL_RE = re.compile(r'["\'](/api/tabdoc/[^"\']+)["\']')
_TEST_METHOD_RE = re.compile(r'self\._(post|get|patch|delete)\s*\(')


def extract_test_coverage(test_dir: Path) -> set[tuple[str, str]]:
    """扫 test_*_api.py 抽 (method, normalized_path) 集合。

    保守策略：本文件出现过 ``self._get`` → 文件里所有 URL 都算 GET 覆盖。
    这会造成轻度 false-positive（实际只测了部分 method），但比 false-negative
    更安全——漏报会让用户以为已覆盖。
    """
    coverage: set[tuple[str, str]] = set()
    if not test_dir.exists():
        return coverage
    for py_file in sorted(test_dir.glob("test_*_api.py")):
        text = py_file.read_text(encoding="utf-8")
        methods_used = {m.upper() for m in _TEST_METHOD_RE.findall(text)}
        if not methods_used:
            continue
        urls = set(_TEST_URL_RE.findall(text)) | set(_TEST_INLINE_URL_RE.findall(text))
        for url in urls:
            normalized = normalize_path(url)
            for method in methods_used:
                coverage.add((method, normalized))
    return coverage


# ---------------------------------------------------------------------------
# Audit aggregation
# ---------------------------------------------------------------------------


@dataclass
class AuditReport:
    cli_endpoints: list[Endpoint] = field(default_factory=list)
    django_endpoints: list[Endpoint] = field(default_factory=list)
    coverage: set[tuple[str, str]] = field(default_factory=set)
    # 派生字段
    cli_only: list[Endpoint] = field(default_factory=list)
    django_only: list[Endpoint] = field(default_factory=list)
    covered_django: list[Endpoint] = field(default_factory=list)
    uncovered_django: list[Endpoint] = field(default_factory=list)


def run_audit() -> AuditReport:
    cli_endpoints = extract_cli_endpoints(GO_CLI_FILE)
    django_endpoints: list[Endpoint] = []
    for f in DJANGO_API_FILES:
        django_endpoints.extend(extract_django_endpoints(f))
    coverage = extract_test_coverage(TEST_DIR)

    django_keys = {(e.method, e.path) for e in django_endpoints}
    cli_keys = {(e.method, e.path) for e in cli_endpoints}

    cli_only = [e for e in cli_endpoints if (e.method, e.path) not in django_keys]
    django_only = [e for e in django_endpoints if (e.method, e.path) not in cli_keys]
    covered = [e for e in django_endpoints if (e.method, e.path) in coverage]
    uncovered = [e for e in django_endpoints if (e.method, e.path) not in coverage]

    return AuditReport(
        cli_endpoints=cli_endpoints,
        django_endpoints=django_endpoints,
        coverage=coverage,
        cli_only=cli_only,
        django_only=django_only,
        covered_django=covered,
        uncovered_django=uncovered,
    )


# ---------------------------------------------------------------------------
# CLI entry
# ---------------------------------------------------------------------------


def _format_summary(report: AuditReport) -> str:
    total = len(report.django_endpoints)
    covered = len(report.covered_django)
    pct = covered * 100 // total if total else 0
    cli_total = len(report.cli_endpoints)
    return "\n".join([
        "TabDoc 端点静态契约审计",
        "=" * 40,
        f"CLI 端点数（Go apps_doc.go）        : {cli_total}",
        f"Django 端点数（api.py + api_share.py）: {total}",
        f"契约覆盖（test_*_api.py 覆盖到的）   : {covered}/{total} ({pct}%)",
        "",
        f"⚠️  CLI-only drift（CLI 调但 Django 无）: {len(report.cli_only)}  ← 必跪 bug",
        f"   Django-only（CLI 不暴露的 UI/集成端点）: {len(report.django_only)}",
    ])


def _format_drift_detail(report: AuditReport) -> str:
    lines: list[str] = []
    if report.cli_only:
        lines.append("\nCLI-only drift（CRITICAL）：")
        for ep in report.cli_only:
            lines.append(
                f"  {ep.method:6} {ep.raw_path}  "
                f"(cli command: doc {ep.cli_command}, apps_doc.go:{ep.line})"
            )
    if report.django_only:
        lines.append("\nDjango-only（CLI 未暴露，多为 UI/集成端点）：")
        for ep in sorted(report.django_only, key=lambda e: e.raw_path):
            lines.append(
                f"  {ep.method:6} {ep.raw_path}  "
                f"({ep.source}:{ep.line}  {ep.summary or '_无 summary_'})"
            )
    return "\n".join(lines)


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--check", action="store_true",
                        help="CI mode：CLI-only drift 必须 0 否则 exit 1")
    parser.add_argument("--json", action="store_true",
                        help="完整审计 JSON 打到 stdout")
    parser.add_argument("--detail", action="store_true",
                        help="终端打印 drift 详细清单（默认只打摘要）")
    args = parser.parse_args(argv)

    report = run_audit()

    if args.json:
        payload = {
            "cli_total": len(report.cli_endpoints),
            "django_total": len(report.django_endpoints),
            "coverage": {
                "covered": len(report.covered_django),
                "uncovered": len(report.uncovered_django),
            },
            "drift": {
                "cli_only": [
                    {"method": e.method, "path": e.raw_path,
                     "cli_command": e.cli_command, "line": e.line}
                    for e in report.cli_only
                ],
                "django_only": [
                    {"method": e.method, "path": e.raw_path,
                     "summary": e.summary, "source": e.source, "line": e.line}
                    for e in report.django_only
                ],
            },
            "uncovered_endpoints": [
                {"method": e.method, "path": e.raw_path,
                 "summary": e.summary, "source": e.source}
                for e in report.uncovered_django
            ],
        }
        print(json.dumps(payload, indent=2, ensure_ascii=False))
        return 0

    print(_format_summary(report))
    if args.detail or report.cli_only:
        print(_format_drift_detail(report))

    if args.check:
        if report.cli_only:
            print("\nFAIL: CLI-only drift 存在——agent 跑这些命令会 404。"
                  "立即修复（Django 加端点或 CLI 删命令）。", file=sys.stderr)
            return 1
        print("\nPASS: CLI ↔ Django 端点对齐，无 critical drift")
    return 0


if __name__ == "__main__":
    sys.exit(main())
