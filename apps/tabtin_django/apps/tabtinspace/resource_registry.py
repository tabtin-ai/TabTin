"""
resource_registry — item_type → Django Model 的统一映射。

所有需要从 ContextItem.item_type 反查源模型的地方都应使用此模块，
避免多处 if-elif 链或字典映射不同步。
"""
import importlib
import logging
from typing import Optional, Type

from django.db import models

logger = logging.getLogger(__name__)

# 单根契约（docs/single-root-space-prd.md §2.7）：tabcode 资源类型已废弃，
# CodeProject 模型不再被映射；ContextItem 不会再产生 item_type='tabcode' 的条目。
_ITEM_TYPE_TO_MODEL: dict[str, tuple[str, str]] = {
    "tabdoc": ("apps.tabdoc.models", "Document"),
    "tabslide": ("apps.tabslide.models", "SlideProject"),
    "tabdata": ("apps.tabdata.models", "Table"),
    "tabmemo": ("apps.tabmemo.models", "Memo"),
    "tabsite": ("apps.tabsite.models", "Site"),
    "tabfiles": ("apps.services.oss.models", "FileRecord"),
}

_model_cache: dict[str, Optional[Type[models.Model]]] = {}


def get_resource_model(item_type: str) -> Optional[Type[models.Model]]:
    """按 item_type 返回对应的 Django 模型类。结果会被缓存。"""
    from apps.tabtinspace.schemas.common import normalize_legacy_item_type
    item_type = normalize_legacy_item_type(item_type)

    if item_type in _model_cache:
        return _model_cache[item_type]

    entry = _ITEM_TYPE_TO_MODEL.get(item_type)
    if not entry:
        _model_cache[item_type] = None
        return None

    module_path, class_name = entry
    try:
        mod = importlib.import_module(module_path)
        cls = getattr(mod, class_name, None)
        _model_cache[item_type] = cls
        return cls
    except (ImportError, AttributeError) as exc:
        logger.warning("get_resource_model(%s): import failed: %s", item_type, exc)
        _model_cache[item_type] = None
        return None
