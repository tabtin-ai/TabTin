"""``tabtin pkg`` 子命令族 — Package Registry CLI。

命令集：
  tabtin pkg publish <dir>                             # 发布包
  tabtin pkg install <namespace>/<name>[@version]      # 安装包
  tabtin pkg list <namespace>/<name>                   # 列出版本
  tabtin pkg yank <namespace>/<name>@<version> --reason "..."  # 下架版本
  tabtin pkg revert <namespace>/<name>@<target-version>        # 回滚到旧版本
  tabtin pkg fork <source-ns>/<name> --to <target-ns>/<name>   # fork 包

运行在 Django 环境中，直接调用 services 层（不走 HTTP API）。
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
from pathlib import Path
from typing import Any

from apps.services.agent_engine.cli.tabtin_cli.cli import EXIT_OK

logger = logging.getLogger(__name__)


def _maybe_upsert_managed_skill(
    *,
    directory: str,
    namespace: str,
    name: str,
    organization_id: str,
    user_id: str | None,
    package_id: str,
) -> bool:
    """Wave 1（PRD V3.3 §11.1）：客户端 CLI 上传后的服务端登记由
    ``services.finalize_version`` → ``_upsert_managed_skill_from_finalize`` 完成
    （写新 ``Skill`` 表，PG 同库）。

    本函数保留作为兼容性占位 — 客户端 CLI 不再做 ORM 写入；返回 True 表示
    "服务端会自动登记，无需 CLI 兜底"。
    """
    skill_md_path = Path(directory) / "SKILL.md"
    return skill_md_path.is_file()


def _get_user_context() -> dict[str, str | None]:
    """从环境变量获取用户 / organization 上下文。"""
    user_id = os.environ.get("TABTIN_USER_ID")
    if not user_id:
        logger.warning(
            "[tabtin pkg] TABTIN_USER_ID 未设置，使用匿名 UUID。"
            "生产环境应设置此变量以确保操作可审计。"
        )
        user_id = "00000000-0000-0000-0000-000000000000"
    return {
        "user_id": user_id,
        "organization_id": os.environ.get("TABTIN_ORGANIZATION_ID"),
    }


def _print_json_error(exc: BaseException, *, code: str) -> None:
    payload = {
        "success": False,
        "error": {
            "code": code,
            "type": type(exc).__name__,
            "message": str(exc),
        },
    }
    json.dump(payload, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


def _parse_pkg_ref(ref: str) -> dict[str, Any]:
    """解析 <namespace>/<name>[@<version>] 格式。

    返回 {"namespace": str, "name": str, "version": int | None}
    """
    m = re.match(r"^([a-z0-9][a-z0-9._-]*)/([a-z0-9][a-z0-9._-]*)(?:@(\d+))?$", ref)
    if not m:
        raise ValueError(
            f"无效的包引用格式: {ref!r}，期望 <namespace>/<name>[@<version>]。"
            "namespace 和 name 只能包含小写字母、数字、点、下划线和连字符"
        )
    return {
        "namespace": m.group(1),
        "name": m.group(2),
        "version": int(m.group(3)) if m.group(3) else None,
    }


def _parse_fork_ref(ref: str) -> dict[str, str]:
    """解析 <namespace>/<name> 格式（无版本号）。"""
    m = re.match(r"^([a-z0-9][a-z0-9._-]*)/([a-z0-9][a-z0-9._-]*)$", ref)
    if not m:
        raise ValueError(
            f"无效的包引用格式: {ref!r}，期望 <namespace>/<name>"
        )
    return {"namespace": m.group(1), "name": m.group(2)}


def _infer_from_directory(directory: str) -> dict[str, str]:
    """从目录路径推断 namespace 和 name。

    支持的目录结构：
    - packages/apps/<namespace>/skills/<name>/
    - 任意 <parent>/<name>/ （parent 作为 namespace）
    """
    p = Path(directory).resolve()
    parts = p.parts

    for i, part in enumerate(parts):
        if part == "skills" and i >= 2 and i + 1 < len(parts):
            ns = parts[i - 1]
            name = parts[i + 1] if i + 1 < len(parts) else p.name
            return {"namespace": ns.lower(), "name": name.lower()}

    if len(parts) >= 2:
        return {"namespace": parts[-2].lower(), "name": parts[-1].lower()}

    return {"namespace": "default", "name": p.name.lower()}


def _get_client(ctx: dict[str, str | None]):
    from apps.services.package_registry.client import PackageRegistryClient
    return PackageRegistryClient(
        user_id=ctx["user_id"],
        organization_id=ctx.get("organization_id"),
    )


# ── publish ──────────────────────────────────────────────────────

def _run_publish(args: argparse.Namespace) -> int:
    ctx = _get_user_context()
    client = _get_client(ctx)
    use_json = getattr(args, "json", False)

    directory = args.directory
    if not Path(directory).is_dir():
        msg = f"目录不存在: {directory}"
        if use_json:
            _print_json_error(FileNotFoundError(msg), code="E_DIR_NOT_FOUND")
        else:
            print(f"[tabtin pkg publish] {msg}", file=sys.stderr)
        return 1

    info = _infer_from_directory(directory)
    namespace = args.namespace or info["namespace"]
    name = args.name or info["name"]
    organization_id = args.organization_id or ctx.get("organization_id")

    if not organization_id:
        msg = "需要 --organization-id 或设置 TABTIN_ORGANIZATION_ID 环境变量"
        if use_json:
            _print_json_error(ValueError(msg), code="E_MISSING_ORGANIZATION")
        else:
            print(f"[tabtin pkg publish] {msg}", file=sys.stderr)
        return 1

    try:
        result = client.publish(
            directory=directory,
            namespace=namespace,
            name=name,
            organization_id=organization_id,
            version_label=args.version_label,
        )
    except PermissionError as exc:
        if use_json:
            _print_json_error(exc, code="E_PERMISSION_DENIED")
        else:
            print(f"[tabtin pkg publish] {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        if use_json:
            _print_json_error(exc, code="E_PUBLISH_FAILED")
        else:
            print(f"[tabtin pkg publish] 失败: {exc}", file=sys.stderr)
        return 1

    skill_created = _maybe_upsert_managed_skill(
        directory=directory,
        namespace=namespace,
        name=name,
        organization_id=organization_id,
        user_id=ctx["user_id"],
        package_id=result["package_id"],
    )

    if use_json:
        payload = {"success": True, **result}
        if skill_created:
            payload["managed_skill"] = True
        json.dump(payload, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
    else:
        print(f"[tabtin pkg publish] {namespace}/{name} 发布成功")
        print(f"  version_seq : {result['version_seq']}")
        print(f"  version_label: {result.get('version_label', 'n/a')}")
        print(f"  bundle_sha256: {result['bundle_sha256'][:16]}...")
        print(f"  file_count  : {result['file_count']}")
        print(f"  total_size  : {result['total_size']} bytes")
        if skill_created:
            print(f"  managed_skill: ✓ 已同步")
        print(f"  安装命令   : tabtin pkg install {namespace}/{name}@{result['version_seq']}")
    return EXIT_OK


# ── install ──────────────────────────────────────────────────────

def _run_install(args: argparse.Namespace) -> int:
    ctx = _get_user_context()
    client = _get_client(ctx)
    use_json = getattr(args, "json", False)

    try:
        ref = _parse_pkg_ref(args.package_ref)
    except ValueError as exc:
        if use_json:
            _print_json_error(exc, code="E_INVALID_REF")
        else:
            print(f"[tabtin pkg install] {exc}", file=sys.stderr)
        return 1

    try:
        result = client.install(
            namespace=ref["namespace"],
            name=ref["name"],
            version_seq=ref["version"],
            target_dir=args.target_dir,
        )
    except LookupError as exc:
        if use_json:
            _print_json_error(exc, code="E_NOT_FOUND")
        else:
            print(f"[tabtin pkg install] {exc}", file=sys.stderr)
        return 1
    except PermissionError as exc:
        if use_json:
            _print_json_error(exc, code="E_VERSION_YANKED")
        else:
            print(f"[tabtin pkg install] {exc}", file=sys.stderr)
            print("  提示: 使用 tabtin pkg list 查看可用版本", file=sys.stderr)
        return 1
    except Exception as exc:
        if use_json:
            _print_json_error(exc, code="E_INSTALL_FAILED")
        else:
            print(f"[tabtin pkg install] 失败: {exc}", file=sys.stderr)
        return 1

    if use_json:
        json.dump({"success": True, **result}, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
    else:
        print(f"[tabtin pkg install] {ref['namespace']}/{ref['name']} 安装成功")
        print(f"  version_seq: {result['version_seq']}")
        print(f"  target_dir : {result['target_dir']}")
        print(f"  files      : {len(result['files'])} 个")
    return EXIT_OK


# ── list ─────────────────────────────────────────────────────────

def _run_list(args: argparse.Namespace) -> int:
    ctx = _get_user_context()
    client = _get_client(ctx)
    use_json = getattr(args, "json", False)

    try:
        ref = _parse_fork_ref(args.package_ref)
    except ValueError as exc:
        if use_json:
            _print_json_error(exc, code="E_INVALID_REF")
        else:
            print(f"[tabtin pkg list] {exc}", file=sys.stderr)
        return 1

    try:
        versions = client.list_versions(
            namespace=ref["namespace"], name=ref["name"],
        )
    except LookupError as exc:
        if use_json:
            _print_json_error(exc, code="E_NOT_FOUND")
        else:
            print(f"[tabtin pkg list] {exc}", file=sys.stderr)
        return 1

    if use_json:
        json.dump({"success": True, "versions": versions}, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
    else:
        print(f"[tabtin pkg list] {ref['namespace']}/{ref['name']} — {len(versions)} 个版本")
        for v in versions:
            yanked = " [YANKED]" if v.get("is_yanked") else ""
            label = f" ({v['version_label']})" if v.get("version_label") else ""
            print(f"  v{v['version_seq']}{label}{yanked}"
                  f"  files={v['file_count']}  size={v['total_size']}  {v['created_at'][:10]}")
    return EXIT_OK


# ── yank ─────────────────────────────────────────────────────────

def _run_yank(args: argparse.Namespace) -> int:
    ctx = _get_user_context()
    client = _get_client(ctx)
    use_json = getattr(args, "json", False)

    try:
        ref = _parse_pkg_ref(args.package_ref)
    except ValueError as exc:
        if use_json:
            _print_json_error(exc, code="E_INVALID_REF")
        else:
            print(f"[tabtin pkg yank] {exc}", file=sys.stderr)
        return 1

    if ref["version"] is None:
        msg = "必须指定版本号，格式: <ns>/<name>@<version>"
        if use_json:
            _print_json_error(ValueError(msg), code="E_MISSING_VERSION")
        else:
            print(f"[tabtin pkg yank] {msg}", file=sys.stderr)
        return 1

    try:
        result = client.yank(
            namespace=ref["namespace"],
            name=ref["name"],
            version_seq=ref["version"],
            reason=args.reason,
        )
    except LookupError as exc:
        if use_json:
            _print_json_error(exc, code="E_NOT_FOUND")
        else:
            print(f"[tabtin pkg yank] {exc}", file=sys.stderr)
        return 1

    if use_json:
        json.dump({"success": True, **result}, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
    else:
        print(f"[tabtin pkg yank] {ref['namespace']}/{ref['name']}@{ref['version']} 已下架")
        print(f"  yanked_at: {result['yanked_at']}")
        print(f"  reason   : {args.reason}")
    return EXIT_OK


# ── revert ───────────────────────────────────────────────────────

def _run_revert(args: argparse.Namespace) -> int:
    ctx = _get_user_context()
    client = _get_client(ctx)
    use_json = getattr(args, "json", False)

    try:
        ref = _parse_pkg_ref(args.package_ref)
    except ValueError as exc:
        if use_json:
            _print_json_error(exc, code="E_INVALID_REF")
        else:
            print(f"[tabtin pkg revert] {exc}", file=sys.stderr)
        return 1

    if ref["version"] is None:
        msg = "必须指定版本号,格式: <ns>/<name>@<version>"
        if use_json:
            _print_json_error(ValueError(msg), code="E_MISSING_VERSION")
        else:
            print(f"[tabtin pkg revert] {msg}", file=sys.stderr)
        return 1

    try:
        result = client.revert(
            namespace=ref["namespace"],
            name=ref["name"],
            target_version_seq=ref["version"],
        )
    except LookupError as exc:
        if use_json:
            _print_json_error(exc, code="E_NOT_FOUND")
        else:
            print(f"[tabtin pkg revert] {exc}", file=sys.stderr)
        return 1
    except PermissionError as exc:
        if use_json:
            _print_json_error(exc, code="E_VERSION_YANKED")
        else:
            print(f"[tabtin pkg revert] {exc}", file=sys.stderr)
            print("  提示: yank 的版本不能 revert,请用 tabtin pkg list 查看可用版本", file=sys.stderr)
        return 1
    except ValueError as exc:
        if use_json:
            _print_json_error(exc, code="E_REVERT_FAILED")
        else:
            print(f"[tabtin pkg revert] {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        if use_json:
            _print_json_error(exc, code="E_REVERT_FAILED")
        else:
            print(f"[tabtin pkg revert] 失败: {exc}", file=sys.stderr)
        return 1

    if use_json:
        json.dump({"success": True, **result}, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
    else:
        print(f"[tabtin pkg revert] {ref['namespace']}/{ref['name']} 已回滚到 v{ref['version']}")
        print(f"  new_version_seq : {result['new_version_seq']}")
        print(f"  target_version_seq : {result['target_version_seq']}")
        print(f"  version_label   : {result.get('version_label') or 'n/a'}")
        print(f"  synced_skills   : {result['synced_skills']} 个 Skill 已同步")
    return EXIT_OK


# ── fork ─────────────────────────────────────────────────────────

def _run_fork(args: argparse.Namespace) -> int:
    ctx = _get_user_context()
    client = _get_client(ctx)
    use_json = getattr(args, "json", False)

    try:
        source = _parse_fork_ref(args.source_ref)
    except ValueError as exc:
        if use_json:
            _print_json_error(exc, code="E_INVALID_REF")
        else:
            print(f"[tabtin pkg fork] source: {exc}", file=sys.stderr)
        return 1

    try:
        target = _parse_fork_ref(args.to)
    except ValueError as exc:
        if use_json:
            _print_json_error(exc, code="E_INVALID_REF")
        else:
            print(f"[tabtin pkg fork] target (--to): {exc}", file=sys.stderr)
        return 1

    organization_id = args.organization_id or ctx.get("organization_id")
    if not organization_id:
        msg = "需要 --organization-id 或设置 TABTIN_ORGANIZATION_ID 环境变量"
        if use_json:
            _print_json_error(ValueError(msg), code="E_MISSING_ORGANIZATION")
        else:
            print(f"[tabtin pkg fork] {msg}", file=sys.stderr)
        return 1

    at_version = getattr(args, "at_version", None)

    try:
        result = client.fork(
            source_ns=source["namespace"],
            source_name=source["name"],
            target_ns=target["namespace"],
            target_name=target["name"],
            target_organization_id=organization_id,
            fork_at_version_seq=at_version,
        )
    except (LookupError, ValueError) as exc:
        if use_json:
            _print_json_error(exc, code="E_FORK_FAILED")
        else:
            print(f"[tabtin pkg fork] {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        if use_json:
            _print_json_error(exc, code="E_FORK_FAILED")
        else:
            print(f"[tabtin pkg fork] 失败: {exc}", file=sys.stderr)
        return 1

    if use_json:
        json.dump({"success": True, **result}, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
    else:
        print(f"[tabtin pkg fork] {source['namespace']}/{source['name']}"
              f" → {target['namespace']}/{target['name']} 成功")
        print(f"  new_package_id  : {result['new_package_id']}")
        print(f"  copied_versions : {result['copied_versions']}")
    return EXIT_OK


# ── argparse 构造 ────────────────────────────────────────────────

def build_pkg_subparser(subparsers: argparse._SubParsersAction) -> None:
    """在顶层 subparsers 注册 ``tabtin pkg`` 命令族。"""
    pkg_parser = subparsers.add_parser(
        "pkg",
        help="Package Registry 包管理（publish/install/list/yank/fork）",
        description="Package Registry CLI — 管理包的发布、安装、版本和 fork。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    pkg_subs = pkg_parser.add_subparsers(dest="pkg_command", required=True, metavar="ACTION")

    # publish
    pub = pkg_subs.add_parser("publish", help="发布目录为包")
    pub.add_argument("directory", help="要发布的目录路径")
    pub.add_argument("--namespace", help="包的命名空间（默认从目录推断）")
    pub.add_argument("--name", help="包名（默认从目录推断）")
    pub.add_argument("--organization-id", dest="organization_id", help="归属 Organization ID")
    pub.add_argument("--version-label", dest="version_label", help="自定义版本标签（如 1.0.0）")
    pub.add_argument("--json", action="store_true", help="JSON 输出格式")

    # install
    inst = pkg_subs.add_parser("install", help="安装包到本地")
    inst.add_argument("package_ref", help="<namespace>/<name>[@version]")
    inst.add_argument("--target-dir", dest="target_dir", help="安装目标目录（默认 ~/.tabtin/packages/<ns>/<name>/）")
    inst.add_argument("--json", action="store_true", help="JSON 输出格式")

    # list
    lst = pkg_subs.add_parser("list", help="列出包的所有版本")
    lst.add_argument("package_ref", help="<namespace>/<name>")
    lst.add_argument("--json", action="store_true", help="JSON 输出格式")

    # yank
    ynk = pkg_subs.add_parser("yank", help="下架指定版本")
    ynk.add_argument("package_ref", help="<namespace>/<name>@<version>")
    ynk.add_argument("--reason", required=True, help="下架原因")
    ynk.add_argument("--json", action="store_true", help="JSON 输出格式")

    # revert
    rev = pkg_subs.add_parser("revert", help="回滚到指定旧版本(创建新版本指向旧内容)")
    rev.add_argument("package_ref", help="<namespace>/<name>@<target-version>")
    rev.add_argument("--json", action="store_true", help="JSON 输出格式")

    # fork
    frk = pkg_subs.add_parser("fork", help="Fork 一个包到新命名空间")
    frk.add_argument("source_ref", help="<source-namespace>/<name>")
    frk.add_argument("--to", required=True, help="<target-namespace>/<target-name>")
    frk.add_argument("--organization-id", dest="organization_id", help="目标 Organization ID")
    frk.add_argument("--at-version", dest="at_version", type=int, help="只 fork 到指定版本（默认全部）")
    frk.add_argument("--json", action="store_true", help="JSON 输出格式")


def run_pkg(args: argparse.Namespace) -> int:
    """``tabtin pkg <action>`` 入口分发。"""
    dispatch = {
        "publish": _run_publish,
        "install": _run_install,
        "list": _run_list,
        "yank": _run_yank,
        "revert": _run_revert,
        "fork": _run_fork,
    }
    handler = dispatch.get(args.pkg_command)
    if handler is None:
        print(f"[tabtin pkg] 未知子命令: {args.pkg_command}", file=sys.stderr)
        return 1
    return handler(args)


__all__ = ["build_pkg_subparser", "run_pkg"]
