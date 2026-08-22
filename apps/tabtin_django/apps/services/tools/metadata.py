"""
ToolMetadata — Layer 0 工具元数据

纯数据类，描述工具的执行特征，不依赖任何业务模块。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Literal, Optional, Tuple


@dataclass(frozen=True)
class ToolMetadata:
    """工具元数据快照 — 用于序列化、前端展示、权限评估等场景。"""

    name: str
    description: str = ""
    execution_mode: Literal["server", "client", "hybrid"] = "server"
    risk_level: Literal["safe", "review", "strict"] = "safe"
    required_permissions: List[str] = field(default_factory=list)
    optional: bool = False
    available_modes: Optional[Tuple[str, ...]] = None
    timeout: int = 0
    category: Optional[str] = None
    cacheable: bool = False
    cache_ttl: int = 300
    defer_load: bool = False
    app_id: Optional[str] = None


__all__ = ["ToolMetadata"]
