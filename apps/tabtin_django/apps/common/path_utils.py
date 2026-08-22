"""Monorepo path utilities.

#8726: 收敛为 ``apps.services.repo_root`` 的 thin re-export。

历史实现只认 ``pnpm-workspace.yaml`` / ``package.json``+``packages/``，容器镜像
（``TABTIN_REPO_ROOT=/app``、无根 package.json）会 fallback 到
``BASE_DIR.parent=/app/apps``，导致 ``AppPackageSkillsService`` 扫不到
``/app/packages/apps``，默认 Agent 只能 seed 到 platform skill。
"""
from __future__ import annotations

from pathlib import Path

from apps.services.repo_root import get_packages_dir, get_repo_root


def find_repo_root(start: Path | None = None) -> Path:
    """兼容旧 API；忽略 *start*，一律走 SSoT ``get_repo_root``。"""
    _ = start  # 旧启发式已废弃；仓库根由 TABTIN_REPO_ROOT / 标记目录解析
    return get_repo_root()


__all__ = [
    "find_repo_root",
    "get_packages_dir",
    "get_repo_root",
]
