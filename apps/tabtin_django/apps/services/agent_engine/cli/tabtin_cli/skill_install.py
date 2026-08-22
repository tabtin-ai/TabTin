"""Marketplace App Skill 同步注册（PRD V3.3 / W0 决策补丁 2）。

**Wave 1 重构**：

device 来源（marketplace App / MCP server 自带 skill）**不进云端 ``Skill`` 表**——
本机 ``LocalSkillRegistry`` 扫描 ``~/.agents/skills/`` 索引（D19 + W0 决策补丁 2）。

历史职责（v3.1 方向锚 N-7）：``tabtin install <app>`` 完成 npm 部分后，本模块
fork 执行 manifest 声明的 ``skillsInstall`` 命令，把 App 自带的 SKILL.md 装到
``~/.agents/skills/`` 目录。

Wave 1 行为变化：
- **不再**做云端表 upsert（device 来源不进 ``Skill`` 表）
- 改为返回 ``discovered_skill_dirs`` 列表，由调用方（``tabtin install`` 或测试）
  决定如何使用（如本机 LocalSkillRegistry 立即扫描刷新）

业务流程：
1. ``tabtin install <app_id>`` 完成 npm 部分（``install.py:_install_via_npm``）
2. 本模块被调用，读 manifest ``install.skillsInstall`` 字段
3. fork 执行 ``skillsInstall`` 命令（如 ``npx skills add <package> -y -g``）
4. 扫描 ``~/.agents/skills/<scope_prefix>*/SKILL.md`` 按 manifest
   ``skills.autoLoad`` / ``skills.onDemand`` 白名单过滤出本 App 的
5. 返回发现的 skill 目录列表（不写云端 DB）
"""

from __future__ import annotations

import logging
import os
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


DEFAULT_AGENTS_SKILLS_DIR = Path.home() / ".agents" / "skills"


def _agents_skills_dir() -> Path:
    override = os.environ.get("TABTIN_AGENTS_SKILLS_DIR")
    if override:
        return Path(override)
    return DEFAULT_AGENTS_SKILLS_DIR


def _run_skills_install(
    command: str,
    *,
    timeout: float = 180.0,
) -> None:
    """fork 执行 manifest 声明的 skillsInstall 命令。"""
    if not command or not command.strip():
        return
    logger.info("[tabtin skill install] 执行: %s", command)
    proc = subprocess.run(
        command,
        shell=True,
        stdin=subprocess.DEVNULL,
        timeout=timeout,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"[E_SKILL_INSTALL_FAILED] skillsInstall 命令退出码 {proc.returncode}: "
            f"{command!r}"
        )


def discover_installed_skill_dirs(
    expected_skill_names: List[str],
    *,
    agents_skills_dir: Optional[Path] = None,
) -> List[Path]:
    """在 skills 装载根下按白名单找出已装的 skill 目录。"""
    root = agents_skills_dir or _agents_skills_dir()
    if not root.is_dir():
        logger.warning("[tabtin skill install] skills 目录不存在: %s", root)
        return []

    found: List[Path] = []
    for name in expected_skill_names:
        d = root / name
        if (d / "SKILL.md").is_file():
            found.append(d)
    return found


def _list_expected_skill_names(manifest: Dict[str, Any]) -> List[str]:
    """从 manifest ``skills`` 块里抽出预期 skill 名单。"""
    skills_cfg = manifest.get("skills") or {}
    names: List[str] = []
    for key in ("autoLoad", "onDemand"):
        val = skills_cfg.get(key)
        if isinstance(val, list):
            names.extend([str(x) for x in val if isinstance(x, str)])
    return [n for n in names if n != "setup"]


def install_and_register_app_skills(
    *,
    app_id: str,
    manifest: Dict[str, Any],
    organization_id: Optional[str] = None,
    skip_install: bool = False,
) -> Dict[str, Any]:
    """装 + 发现一步到位（Wave 1 起不再登记到云端 DB）。

    步骤：
    1. fork 执行 manifest 声明的 ``skillsInstall`` 命令（如 ``npx skills add ...``）
    2. 按 ``skills.autoLoad`` + ``skills.onDemand`` 白名单扫 ``~/.agents/skills/``
    3. 返回发现的 skill 目录列表

    返回 dict 字段：
    - ``installed``: bool — skillsInstall 命令是否执行成功
    - ``discovered_skill_dirs``: List[str] — 发现的 skill 目录绝对路径
    - ``skip_reason``: str | None — 跳过原因（manifest 没声明 / skip_install）
    - ``install_error``: str | None — skillsInstall 执行失败的错误信息

    设备端调用方应通过本机 ``LocalSkillRegistry`` 即时扫描这些目录的 SKILL.md，
    渲染到「本机」分组（device 来源，PRD V3.3 D19）。``organization_id`` 参数保留
    但不再使用——device skill 不做 organization 隔离（D19 + 跨 organization 共享）。
    """
    install_cfg = manifest.get("install") or {}
    install_command = install_cfg.get("skillsInstall", "").strip()

    result: Dict[str, Any] = {
        "install_command": install_command,
        "installed": False,
        "discovered_skill_dirs": [],
    }

    if install_command and not skip_install:
        try:
            _run_skills_install(install_command)
            result["installed"] = True
        except RuntimeError as exc:
            result["install_error"] = str(exc)
            logger.warning(
                "[tabtin skill install] skillsInstall 失败: %s", exc,
            )
            return result
    elif not install_command:
        result["skip_reason"] = "manifest.install.skillsInstall 未声明"

    expected = _list_expected_skill_names(manifest)
    if not expected:
        result["skip_reason"] = (
            result.get("skip_reason")
            or "manifest.skills.autoLoad / onDemand 未声明"
        )
        return result

    skill_dirs = discover_installed_skill_dirs(expected)
    result["discovered_skill_dirs"] = [str(d) for d in skill_dirs]

    if not skill_dirs:
        logger.warning(
            "[tabtin skill install] %s：期望的 skill 目录一个都没找到 "
            "（期望 %d 个，根目录 %s）",
            app_id, len(expected), _agents_skills_dir(),
        )

    return result


__all__ = [
    "DEFAULT_AGENTS_SKILLS_DIR",
    "install_and_register_app_skills",
    "discover_installed_skill_dirs",
]
