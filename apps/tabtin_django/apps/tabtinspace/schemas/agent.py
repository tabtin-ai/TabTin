"""Tabtin Space 侧遗留 agent schema。

身份 CRUD schema 正典在 ``apps.agent.schemas``；本模块仅保留
working_dir 校验工具与历史 re-export，供 Space/Workspace 路径使用。
"""

from __future__ import annotations

from pathlib import PurePosixPath, PureWindowsPath
import re
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

from apps.agent.schemas import (  # noqa: F401
    AgentCreate,
    AgentOut,
    AgentPreferredModelUpdate,
    AgentUpdate,
    AgentConfigUpdateSchema,
)

WorkingDirType = Literal["code", "mixed", "doc"]

_INVALID_PATH_CHARS = re.compile(r"[\x00-\x1f]")
_MAX_PATH_LEN = 2048


def _is_supported_absolute_path(value: str) -> bool:
    """用标准库路径模块同时识别 control_device 的 POSIX / Windows 绝对路径。"""
    return PurePosixPath(value).is_absolute() or PureWindowsPath(value).is_absolute()


def _normalize_working_dir(value: Optional[str]) -> Optional[str]:
    """Workspace 工作目录路径校验 + 归一化。"""
    if value is None:
        return None
    if value == "":
        return ""
    if _INVALID_PATH_CHARS.search(value):
        raise ValueError("working_dir 含非法控制字符")
    if len(value) > _MAX_PATH_LEN:
        raise ValueError(f"working_dir 超过 {_MAX_PATH_LEN} 字符上限")
    if value.startswith("~"):
        raise ValueError("working_dir 不允许 ~ 前缀，请使用展开后的绝对路径")
    if not _is_supported_absolute_path(value):
        raise ValueError("working_dir 必须是绝对路径")
    normalized = value.rstrip("/").rstrip("\\") or value[0]
    return normalized


class AgentSecurityUpdate(BaseModel):
    """Agent.agent_config.security 子树的 API 入参 schema（v3 PRD §5.2.5）。"""

    allow_yolo_mode: Optional[bool] = Field(
        default=None,
        description="Agent 级 yolo gate（默认 false）。#3503 起为读兼容 legacy 字段，新写入用 approval_grant。",
    )

    model_config = ConfigDict(extra="forbid")


__all__ = [
    "WorkingDirType",
    "AgentCreate",
    "AgentSecurityUpdate",
    "AgentUpdate",
    "AgentOut",
    "AgentPreferredModelUpdate",
    "AgentConfigUpdateSchema",
    "_normalize_working_dir",
    "_is_supported_absolute_path",
]
