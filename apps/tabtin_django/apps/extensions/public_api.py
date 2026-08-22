"""Extension 公开接口标记

轻量模块，零 Django 依赖，避免 import 循环。
被 @public_api 标记的类/函数/方法承诺接口稳定性：
- 签名变更需要更新 API baseline
- 移除或重命名需要 deprecation 周期
"""

from __future__ import annotations

import functools
import inspect
from typing import Callable, TypeVar

T = TypeVar("T")

_PUBLIC_API_REGISTRY: dict[str, dict] = {}


def public_api(description: str = ""):
    """标记为插件 SDK 公开接口。"""

    def decorator(obj: T) -> T:
        obj._is_public_api = True  # type: ignore[attr-defined]
        obj._public_api_description = description  # type: ignore[attr-defined]

        module = inspect.getmodule(obj)
        module_name = module.__name__ if module else "<unknown>"
        name = getattr(obj, "__qualname__", getattr(obj, "__name__", str(obj)))

        sig = None
        if callable(obj) and not isinstance(obj, type):
            try:
                sig = str(inspect.signature(obj))
            except (ValueError, TypeError):
                pass

        _PUBLIC_API_REGISTRY[f"{module_name}.{name}"] = {
            "name": name,
            "module": module_name,
            "kind": "class" if isinstance(obj, type) else "function",
            "signature": sig,
            "description": description,
        }

        return obj  # type: ignore[return-value]

    return decorator


def get_public_api_registry() -> dict[str, dict]:
    """返回当前已注册的所有公开接口快照。"""
    return dict(_PUBLIC_API_REGISTRY)
