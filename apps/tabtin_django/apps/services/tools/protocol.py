"""
ToolProtocol / ToolRegistryProtocol — Layer 0 纯接口层

定义工具和注册表的 Protocol，供类型检查和松耦合引用使用。
不依赖 LangChain 或任何业务模块。
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Literal, Optional, Protocol, runtime_checkable


@runtime_checkable
class ToolProtocol(Protocol):
    """工具最小协议 — 任何实现 name/description/run 的对象均可匹配。"""

    name: str
    description: str
    execution_mode: Literal["server", "client", "hybrid"]
    risk_level: Literal["safe", "review", "strict"]
    required_permissions: List[str]
    optional: bool
    timeout: int

    def run(self, **kwargs: Any) -> Any: ...


@runtime_checkable
class ToolRegistryProtocol(Protocol):
    """注册表协议 — ToolHub 的抽象接口。"""

    def register_provider(
        self,
        domain: str,
        provider: Callable[[], List[Any]],
        app_id: Optional[str] = None,
        source: str = "builtin",
        namespace: Optional[str] = None,
        overwrite: bool = False,
        defer_load: bool = False,
    ) -> None: ...

    def get_tools(
        self,
        domain: Optional[str] = None,
        allowed_app_ids: Optional[List[str]] = None,
    ) -> List["ToolProtocol"]: ...

    def get_tool_by_name(
        self,
        tool_name: str,
        domain: Optional[str] = None,
    ) -> Optional["ToolProtocol"]: ...

    def list_domains(self) -> List[str]: ...

    def get_health_report(self) -> Dict[str, Any]: ...


__all__ = ["ToolProtocol", "ToolRegistryProtocol"]
