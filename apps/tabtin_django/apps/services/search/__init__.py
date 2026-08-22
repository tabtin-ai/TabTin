"""
Search package 懒加载导出。

避免 Django app registry 尚未 ready 时，通过 package import 过早触发服务模块导入。
"""

from __future__ import annotations

from importlib import import_module

_EXPORTS = {
    "SearchService": (".services.search_service", "SearchService"),
    "SearchProviderError": (".services.base", "SearchProviderError"),
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
