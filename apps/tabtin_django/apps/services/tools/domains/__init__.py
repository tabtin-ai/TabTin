"""
services.tools.domains — 工具域实现层

所有域工具实现（common/table/tabdoc/rag/...）的唯一真实位置。
（W10e 前 apps.orchestration.tools 下的 re-export shim 已于 2026-04-17
随 orchestration 极简化一并删除。）

避免在包导入时触发工具注册，减少循环依赖风险。
"""

__all__ = [
    "get_tool_registry",
    "get_all_tools",
    "get_tool_by_name",
    "get_tool_info",
    "get_action_tool_manifest_info",
    "get_registration_health",
]


def __getattr__(name: str):
    if name in __all__:
        from . import registry

        return getattr(registry, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def __dir__():
    return sorted(list(globals().keys()) + __all__)
