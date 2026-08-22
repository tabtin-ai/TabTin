"""tabtin-demo-app CLI 主入口。

遵守 TabTin CLI envelope 协议（marketplace-app-boundary.md §3.2）：
  - stdout 仅输出 envelope JSON（{ok, data} 或 {ok, error}）
  - stderr 输出诊断、进度、人类可读提示
  - exit code 跟随 envelope（成功 0，失败 1+）
  - 业务错误码以 TABTIN_DEMO_APP_ 前缀（R7 规范）

子命令：
    issue create  --title TITLE --repo OWNER/REPO [--body BODY] [--labels L1,L2]
    issue list    --repo OWNER/REPO [--state open|closed|all] [--limit N]
    issue get     --repo OWNER/REPO --number N
    issue close   --repo OWNER/REPO --number N
    auth  login   [--mocked]
    auth  status
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, NoReturn, Optional, Sequence

from . import auth, config, github_api

# ── envelope 输出工具 ─────────────────────────────────────────────
# 遵守 cli-protocol-spec.md + marketplace-app-boundary.md R2/R7

APP_ID_UPPER = "TABTIN_DEMO_APP"


def emit_ok(data: Any) -> NoReturn:
    """envelope 成功路径：stdout 输出 + exit 0。"""
    sys.stdout.write(json.dumps({"ok": True, "data": data}, ensure_ascii=False) + "\n")
    sys.exit(0)


def emit_err(
    code_suffix: str, message: str, *,
    suggestions: list[str] | None = None,
    retryable: bool = False,
    exit_code: int = 1,
) -> NoReturn:
    """envelope 失败路径：stdout 输出 + exit 跟随。code 自动加 APP 前缀。"""
    error: dict[str, Any] = {
        "code": f"{APP_ID_UPPER}_{code_suffix}",
        "message": message,
        "retryable": retryable,
    }
    if suggestions:
        error["suggestions"] = suggestions
    sys.stdout.write(json.dumps({"ok": False, "error": error}, ensure_ascii=False) + "\n")
    sys.exit(exit_code)


def log(msg: str) -> None:
    """诊断 / 进度走 stderr，不污染 stdout 管道。"""
    sys.stderr.write(msg + "\n")


# ── 命令实现 ──────────────────────────────────────────────────────

def _get_token_or_exit() -> str:
    token = config.get_access_token()
    if not token:
        emit_err(
            "AUTH_REQUIRED", "未认证，请先运行 tabtin-demo-app auth login",
            suggestions=["tabtin-demo-app auth login", "tabtin-demo-app auth login --mocked"],
        )
    return token


def _get_base_url() -> str:
    return os.environ.get("GITHUB_DEMO_BASE_URL", github_api.API_BASE)


def cmd_issue_create(args: argparse.Namespace) -> None:
    token = _get_token_or_exit()
    labels = [l.strip() for l in args.labels.split(",") if l.strip()] if args.labels else None
    try:
        result = github_api.create_issue(
            token, args.repo, args.title,
            body=args.body, labels=labels,
            base_url=_get_base_url(),
        )
    except github_api.GitHubAPIError as exc:
        emit_err("GITHUB_API_ERROR", str(exc), retryable=True)

    emit_ok(result)


def cmd_issue_list(args: argparse.Namespace) -> None:
    token = _get_token_or_exit()
    try:
        issues = github_api.list_issues(
            token, args.repo,
            state=args.state, per_page=args.limit,
            base_url=_get_base_url(),
        )
    except github_api.GitHubAPIError as exc:
        emit_err("GITHUB_API_ERROR", str(exc), retryable=True)

    emit_ok(issues)


def cmd_issue_get(args: argparse.Namespace) -> None:
    token = _get_token_or_exit()
    try:
        issue = github_api.get_issue(
            token, args.repo, args.number,
            base_url=_get_base_url(),
        )
    except github_api.GitHubAPIError as exc:
        emit_err("GITHUB_API_ERROR", str(exc), retryable=True)

    emit_ok(issue)


def cmd_issue_close(args: argparse.Namespace) -> None:
    token = _get_token_or_exit()
    try:
        result = github_api.close_issue(
            token, args.repo, args.number,
            base_url=_get_base_url(),
        )
    except github_api.GitHubAPIError as exc:
        emit_err("GITHUB_API_ERROR", str(exc), retryable=True)

    emit_ok(result)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="tabtin-demo-app",
        description="GitHub Issue 管理演示 App (Simple Todo Demo)",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    # ── issue ──
    issue_parser = subparsers.add_parser("issue", help="GitHub Issue 操作")
    issue_sub = issue_parser.add_subparsers(dest="action", required=True)

    create_p = issue_sub.add_parser("create", help="创建 Issue")
    create_p.add_argument("--title", required=True, help="Issue 标题")
    create_p.add_argument("--repo", required=True, help="仓库 (owner/repo)")
    create_p.add_argument("--body", default=None, help="Issue 内容（content）")
    create_p.add_argument("--labels", default=None, help="标签 (逗号分隔)")

    list_p = issue_sub.add_parser("list", help="列出 Issue")
    list_p.add_argument("--repo", required=True, help="仓库 (owner/repo)")
    list_p.add_argument("--state", default="open", choices=("open", "closed", "all"))
    list_p.add_argument("--limit", type=int, default=30, help="最大返回数")

    get_p = issue_sub.add_parser("get", help="查看单个 Issue")
    get_p.add_argument("--repo", required=True, help="仓库 (owner/repo)")
    get_p.add_argument("--number", type=int, required=True, help="Issue 编号")

    close_p = issue_sub.add_parser("close", help="关闭 Issue")
    close_p.add_argument("--repo", required=True, help="仓库 (owner/repo)")
    close_p.add_argument("--number", type=int, required=True, help="Issue 编号")

    # ── auth ──
    auth_parser = subparsers.add_parser("auth", help="GitHub OAuth 认证")
    auth_sub = auth_parser.add_subparsers(dest="action", required=True)

    login_p = auth_sub.add_parser("login", help="OAuth 登录")
    login_p.add_argument("--mocked", action="store_true", help="使用 mock token（测试用）")

    auth_sub.add_parser("status", help="查看认证状态")

    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    if args.command == "auth":
        if args.action == "login":
            return auth.login(mocked=args.mocked)
        if args.action == "status":
            return auth.show_status()

    if args.command == "issue":
        handlers = {
            "create": cmd_issue_create,
            "list": cmd_issue_list,
            "get": cmd_issue_get,
            "close": cmd_issue_close,
        }
        handler = handlers.get(args.action)
        if handler:
            handler(args)
            return 0

    parser.print_help()
    return 2
