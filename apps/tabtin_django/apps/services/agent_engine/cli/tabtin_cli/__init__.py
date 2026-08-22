"""``tabtin`` 平台 CLI（A5 启动包；v3.1 方向锚对齐）。

提供命令族：

- ``tabtin install <app_id>`` — 装 marketplace App（npm-global / tarball 两类）
- ``tabtin pkg ...``           — Package Registry 包管理

入口：

- ``python -m apps.services.agent_engine.cli.tabtin_cli ...`` — 直接调用
- Go CLI 薄 shim：``packages/tabtin-cli-go/cmd/app_platform_*.go``
  内部 fork 本 Python module

> **v3.1（2026-04-19）**：``tabtin connect`` 命令族整体删除（方向锚 H8）。
> TabTin 对 Device 级第三方 App 不代管凭据；用户在本机自己跑该 App 的
> ``config init`` / ``auth login`` 等命令，Agent 可引导但不代跑。
> 详见 ``docs/app-market/PRD-v3.1-方向锚.md``。

A5 范围（不含）：

- AdminDash 前端（Wave E）
"""

from apps.services.agent_engine.cli.tabtin_cli.cli import main

__all__ = ["main"]
