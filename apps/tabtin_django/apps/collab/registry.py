"""
Collab Adapter 注册中心

各模块在 AppConfig.ready() 或首次使用时注册自己的 adapter。
统一 API 和 Service 通过 registry 获取对应模块的 adapter。
"""
import logging
from typing import Optional

from .adapters.base import CollabAdapter

logger = logging.getLogger("collab.registry")

_adapters: dict[str, CollabAdapter] = {}


def register_adapter(adapter: CollabAdapter) -> None:
    """注册模块 adapter。"""
    if not adapter.resource_type:
        raise ValueError("adapter.resource_type must be set")
    if adapter.resource_type in _adapters:
        logger.warning(
            "Overriding adapter for resource_type=%s", adapter.resource_type
        )
    _adapters[adapter.resource_type] = adapter
    logger.info("Registered collab adapter: %s", adapter.resource_type)


def get_adapter(resource_type: str) -> Optional[CollabAdapter]:
    """获取已注册的模块 adapter。"""
    return _adapters.get(resource_type)


def get_adapter_or_raise(resource_type: str) -> CollabAdapter:
    """获取已注册的模块 adapter，未注册则抛异常。"""
    adapter = _adapters.get(resource_type)
    if adapter is None:
        raise ValueError(
            f"No collab adapter registered for resource_type='{resource_type}'. "
            f"Available: {list(_adapters.keys())}"
        )
    return adapter


def list_registered_types() -> list[str]:
    """列出所有已注册的资源类型。"""
    return list(_adapters.keys())
