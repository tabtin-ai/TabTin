"""``tabtin`` 顶层命令解析与 dispatch（A5 启动包；v3.1 方向锚对齐）。

⚠️ **DORMANT 状态（2026-04-30）**：

``tabtin install`` 命令族 + ``MarketplaceAppInstaller`` 基础设施目前**无生产调用方**：
- 仓库内唯一的 marketplace App 是 ``packages/apps/tabtin-demo-app/``（自标"不进生产"，N-6 验证样板）
- 飞书 lark marketplace App 已于 2026-04-30 整体撤除
- 本模块作为 Tin 形态明确前的占位实现保留，未来可能由 Tin 安装协议替代

详见 [`docs/prd-v4/02-legacy-debt-cleanup.md`](../../../../../../../docs/prd-v4/02-legacy-debt-cleanup.md) Part A。

argparse 风格的命令族实现：

- ``tabtin install <app_id> [...]`` — 装 marketplace App（npm-global / tarball 两类）
- ``tabtin pkg ...``                 — Package Registry 包管理

**v3.1（2026-04-19）**：``tabtin connect`` 命令族整体删除（方向锚 H8）。
TabTin 对 Device 级第三方 App 不代管凭据，由 App 自己管（OS keychain 等）。

**为什么用 argparse 不用 click/typer**：保持零额外依赖（A1-A4 已是纯 stdlib + Django），
让本模块在 ``python -m`` 形式下立即可用，不需要 ``pip install`` 任何新包。

**返回码协议**：
- ``0``：成功
- ``2``：参数错误（argparse 默认）
- ``78`` (EX_CONFIG)：配置缺失（如 tarball 路径下 ``E_INSTALL_CHECKSUM_MISSING``）
- ``126``：拒绝执行（评估层 / fail-close）
- ``127``：找不到 binary（第三方 CLI 未安装）

**Django 启动**：本模块 ``main()`` 入口在第一次需要 Django ORM 时调
``_ensure_django()``——避免 ``argparse --help`` 等不写库的命令路径触发 Django
冷启动开销（~500ms）。
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from typing import List, Optional, Sequence

logger = logging.getLogger(__name__)


# ── Exit codes ──────────────────────────────────────────────────────

EXIT_OK = 0
EXIT_ARG_ERROR = 2
EXIT_CONFIG_MISSING = 78  # EX_CONFIG（如 tarball 路径下 SHA256 缺失但未豁免）
EXIT_DECISION_DENY = 126   # 评估层 deny / 执行层 fail-close
EXIT_BINARY_NOT_FOUND = 127  # 第三方 CLI 未安装


# ── Django bootstrap（lazy）────────────────────────────────────────

_django_initialized = False


def _ensure_django(*, settings_module: Optional[str] = None) -> None:
    """按需启动 Django，避免无副作用的命令（``--help`` 等）触发 ORM 初始化。

    第一次调用后通过模块级标志缓存，多次调用安全。

    ``DJANGO_SETTINGS_MODULE`` 优先级：
    1. 显式传入的 ``settings_module``
    2. 环境变量 ``DJANGO_SETTINGS_MODULE``
    3. ``tabtin.settings``
    """
    global _django_initialized
    if _django_initialized:
        return
    import django

    if settings_module:
        os.environ["DJANGO_SETTINGS_MODULE"] = settings_module
    else:
        os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")
    try:
        django.setup()
    except Exception as exc:
        # 启动失败不应让 ``--help`` 失效；记日志由 caller 决定是否 fail-close
        logger.warning(
            "[tabtin_cli] django.setup() 失败: %s; 后续依赖 ORM 的命令会失败",
            exc,
        )
        raise
    _django_initialized = True


# ── argparse 构造 ──────────────────────────────────────────────────

PROG_NAME = "tabtin"

GENERAL_HELP_EPILOG = """\
可用子命令族：
  install   安装 marketplace App（npm-global 走 npm install -g；tarball 走下载 + 校验 + 解压 + 注册）
  pkg       Package Registry 包管理（publish/install/list/yank/fork）

示例：
  tabtin install <app_id>
  tabtin pkg publish packages/apps/<app_id>/skills/<skill-name>/
  tabtin pkg install <app_id>/<skill-name>

第三方 CLI 凭据由 App 自己管（OS keychain 等）。
TabTin 不代管凭据，登录请直接跑 App 原生命令。

更多帮助：``tabtin <子命令> --help``
"""


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=PROG_NAME,
        description="TabTin 平台统一 CLI — install / pkg 命令族",
        epilog=GENERAL_HELP_EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--settings",
        dest="settings_module",
        help="覆盖 DJANGO_SETTINGS_MODULE（测试 / 多环境时使用）",
    )
    # App Market H1 · G2 — CLI 入口默认静音 Django INFO 日志（见 _apply_cli_logging）。
    # 用户遇到问题要复现完整日志时用 --verbose。
    parser.add_argument(
        "--verbose",
        "-v",
        action="store_true",
        help="保留 Django INFO/DEBUG 日志输出（默认仅 WARNING 及以上）",
    )

    subparsers = parser.add_subparsers(dest="command", required=True, metavar="COMMAND")

    # install <app_id>
    install_parser = subparsers.add_parser(
        "install",
        help="安装 marketplace App",
        description=(
            "安装 marketplace App。按 manifest ``install.type`` 字段分流：\n\n"
            "  - ``npm-global`` （v3.1 主路径）：检查 ``shutil.which``，"
            "未装则默认引导 ``npm install -g <package>``；设 ``--auto-install`` "
            "或 ``TABTIN_AUTO_NPM_INSTALL=1`` 才代跑。装好后写本地 registry + "
            "触发 Wave H Skill 同步注册。\n"
            "  - ``tarball`` （兼容路径）：下载 manifest 中声明的 ``cli.binary``、"
            "按 platform/arch 查 ``cli.checksums`` 校验 SHA256、解压并写本地 registry。"
            "缺失对应 platform 的 checksum 时拒装；dev/CI 通过 "
            "``TABTIN_ALLOW_UNCHECKED_INSTALL=1`` 显式豁免。"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    install_parser.add_argument("app_id", help="要安装的 App ID")
    install_parser.add_argument(
        "--manifest",
        help=(
            "可选：显式指定 app.json 路径（默认从 ``packages/apps/<app_id>/app.json`` 读）。"
            "测试 / 自定义部署时使用"
        ),
    )
    install_parser.add_argument(
        "--registry-dir",
        help=(
            "可选：覆盖 marketplace App 安装目录（默认 ``~/.tabtin-marketplace-apps/``）。"
            "测试时使用"
        ),
    )
    install_parser.add_argument(
        "--json",
        action="store_true",
        help="JSON 输出格式（便于脚本调用 / Agent 消费）",
    )
    install_parser.add_argument(
        "--auto-install",
        action="store_true",
        help=(
            "npm-global 类型 App 未装时代跑 ``npm install -g <package>`` "
            "（等价环境变量 TABTIN_AUTO_NPM_INSTALL=1）。默认关闭 —— "
            "tabtin 不替用户决定是否动 npm 全局目录"
        ),
    )

    # v3.1（2026-04-19）：``tabtin connect`` 命令族整体删除（方向锚 H8）。
    # TabTin 对 Device 级第三方 App 不代管凭据；用户在本机自己跑该 App 自身的
    # ``config init`` / ``auth login`` 等命令，Agent 可引导但不代跑。
    # 详见 docs/app-market/PRD-v3.1-方向锚.md §一 "TabTin 不做" 列表。

    # pkg <action> ...
    from apps.services.agent_engine.cli.tabtin_cli.pkg import build_pkg_subparser
    build_pkg_subparser(subparsers)

    return parser


# ── 主入口 ─────────────────────────────────────────────────────────


def _apply_cli_logging(verbose: bool) -> None:
    """CLI 进程下默认静音 Django INFO/DEBUG，避免污染 shim stdout/stderr。

    Django 启动时 dictConfig 会把几十个 app 的 logger 设到 INFO；普通用户
    敲 ``tabtin install <app_id>`` 不应看到 ``[ToolHub] Registered tool domain``
    这类内部运维日志。

    ``logging.disable(level)`` 是进程级全局开关，在 ``django.setup()`` 之后
    调用仍然生效（不被 dictConfig override），因为它的检查在 logger 内部
    ``isEnabledFor()`` 流程里发生。

    ``verbose=True`` 或 ``TABTIN_VERBOSE=1`` 时不禁用，便于 debug。
    后者是 Go CLI root PersistentPreRun 自动设置的 —— 用户敲
    ``tabtin --verbose ...`` 时 Go 吞掉 flag 但会导出此环境变量，
    Python shim 读它来保持一致行为。
    """
    if verbose or os.getenv("TABTIN_VERBOSE") == "1":
        return
    logging.disable(logging.INFO)


def main(argv: Optional[Sequence[str]] = None) -> int:
    """主入口；返回 exit code。

    ``argv`` 显式传入便于测试；生产环境由 ``__main__.py`` 传 ``sys.argv[1:]``。
    """
    parser = _build_parser()
    # argparse 在 --help / 参数错误时会自己 sys.exit；本模块 main() 永远要返回 int，
    # 测试需要捕获 SystemExit。argparse 已经以 SystemExit(0) / SystemExit(2) 退出，
    # 调用方按需捕获（测试用 pytest.raises(SystemExit)）。
    args = parser.parse_args(argv)

    settings_module: Optional[str] = getattr(args, "settings_module", None)
    _apply_cli_logging(getattr(args, "verbose", False))

    cmd = args.command
    if cmd == "install":
        from apps.services.agent_engine.cli.tabtin_cli import install as install_mod
        _ensure_django(settings_module=settings_module)
        return install_mod.run_install(
            app_id=args.app_id,
            manifest_path=args.manifest,
            registry_dir=args.registry_dir,
            output_json=args.json,
            auto_install=getattr(args, "auto_install", False),
        )
    # v3.1（2026-04-19）：``connect`` 分支已删除（Connect 模型作废，见方向锚 H8）
    if cmd == "pkg":
        from apps.services.agent_engine.cli.tabtin_cli import pkg as pkg_mod
        _ensure_django(settings_module=settings_module)
        return pkg_mod.run_pkg(args)

    parser.error(f"unknown command: {cmd}")
    return EXIT_ARG_ERROR  # unreachable but required for mypy


__all__ = [
    "main",
    "PROG_NAME",
    "EXIT_OK",
    "EXIT_ARG_ERROR",
    "EXIT_CONFIG_MISSING",
    "EXIT_DECISION_DENY",
    "EXIT_BINARY_NOT_FOUND",
]
