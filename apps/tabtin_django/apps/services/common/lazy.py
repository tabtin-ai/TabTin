"""Django 侧延迟加载工具。

提供通用的延迟导入和按需注册能力。

使用示例::

    from apps.services.common.lazy import lazy_import

    # 延迟导入模块属性
    get_heavy_service = lazy_import('apps.heavy.module', 'HeavyService')
    service = get_heavy_service()  # 首次调用时才 import
"""

import importlib
import logging

logger = logging.getLogger(__name__)


def lazy_import(module_path: str, attr: str = None):
    """延迟导入模块或模块属性。首次调用时才执行 import。

    Args:
        module_path: 模块的完整 Python 路径，如 ``'apps.heavy.module'``。
        attr: 可选，模块上的属性名。为 None 时返回模块本身。

    Returns:
        一个无参 callable，首次调用时执行 import 并缓存结果。
    """
    _cache = {}

    def getter():
        if "result" not in _cache:
            mod = importlib.import_module(module_path)
            _cache["result"] = getattr(mod, attr) if attr else mod
        return _cache["result"]

    return getter


def lazy_adapter_registry(adapter_map: dict, configured_keys: list) -> list:
    """按配置列表延迟导入并实例化 adapter。

    Args:
        adapter_map: ``{key: (module_path, class_name)}`` 映射。
        configured_keys: 需要加载的 key 列表。

    Returns:
        成功实例化的 adapter 列表（跳过未知 key 和加载失败的项）。
    """
    adapters = []
    for key in configured_keys:
        entry = adapter_map.get(key)
        if entry is None:
            logger.warning(
                "未知 key: %s，可用值: %s",
                key,
                ", ".join(sorted(adapter_map.keys())),
            )
            continue
        module_path, class_name = entry
        try:
            mod = importlib.import_module(module_path)
            cls = getattr(mod, class_name)
            adapters.append(cls())
        except Exception:
            logger.warning("%s 加载失败", key, exc_info=True)
    return adapters
