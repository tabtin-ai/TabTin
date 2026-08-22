"""Monorepo 仓库根的稳健解析（INFRA-2 自包含修复）。

历史上后端多处用写死的 ``Path(__file__).resolve().parents[N]`` 回推仓库根，再去读
monorepo 同级 ``packages/``（App manifest、capability 契约、bundled skills 等）。
N 随文件嵌套深度各异、是把"目录层级"当契约的脆弱写法：后端因此硬绑 monorepo 布局，
容器化 / 独立部署一旦层级变化（如后端单独放置）就 ``IndexError`` 崩，且无法自包含。

集中到此，按优先级解析：
1. 环境变量 ``TABTIN_REPO_ROOT``（部署 / 镜像显式注入，最稳）；
2. 自底向上找标记目录（``pnpm-workspace.yaml`` 或同时含 ``packages/`` + ``apps/``）；
3. 兜底退化到本文件的相对深度（保持历史行为）。

放在 ``apps.services`` 下（其 ``__init__`` 为空）而非 ``apps.services.common``
（``__init__`` 重，会引入 middleware/config，早期 import 有环风险），仅依赖标准库，
可安全用于 app ready / 模块 import 期。
"""
from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path


def _looks_like_repo_root(path: Path) -> bool:
    if (path / "pnpm-workspace.yaml").is_file():
        return True
    return (path / "packages").is_dir() and (path / "apps").is_dir()


@lru_cache(maxsize=1)
def get_repo_root() -> Path:
    """返回 monorepo 仓库根（含 ``packages/`` / ``apps/`` / ``pnpm-workspace.yaml``）。"""
    env_value = os.environ.get("TABTIN_REPO_ROOT")
    if env_value:
        candidate = Path(env_value).expanduser().resolve()
        if candidate.is_dir():
            return candidate

    here = Path(__file__).resolve()
    for parent in here.parents:
        if _looks_like_repo_root(parent):
            return parent

    # 兜底：本文件位于 apps/tabtin_django/apps/services/repo_root.py
    # parents[0]=services [1]=apps [2]=tabtin_django [3]=apps [4]=<repo root>
    return here.parents[4]


def get_packages_dir() -> Path:
    """``<repo>/packages`` 目录。"""
    return get_repo_root() / "packages"
