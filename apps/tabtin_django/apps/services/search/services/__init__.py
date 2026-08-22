"""
Search services 懒加载导出。

避免 package import 在 Django 启动阶段过早触发依赖初始化。
"""

from __future__ import annotations

from importlib import import_module

_EXPORTS = {
    "SearchProviderError": (".base", "SearchProviderError"),
    "SearchService": (".search_service", "SearchService"),
}

__all__ = list(_EXPORTS.keys())


def __getattr__(name: str):
    if name not in _EXPORTS:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

    module_path, attr_name = _EXPORTS[name]
    module = import_module(module_path, __name__)
    value = getattr(module, attr_name)
    globals()[name] = value
    return value
