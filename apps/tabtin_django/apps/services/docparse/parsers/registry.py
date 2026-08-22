"""
解析器注册表

新增解析器只需：
1. 继承 BaseDocumentParser
2. 实现 supported_mimes()
3. 在模块顶层调用 register_parser(YourParser)

service.py 通过 get_parser_for_mime(mime) 自动查找，零改动核心代码。
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .base import BaseDocumentParser

logger = logging.getLogger(__name__)

_registry: dict[str, type[BaseDocumentParser]] = {}


def register_parser(parser_cls: type[BaseDocumentParser]) -> type[BaseDocumentParser]:
    """注册解析器类，将其 supported_mimes 映射到注册表。可用作装饰器。"""
    instance = parser_cls()
    for mime in instance.supported_mimes():
        if mime in _registry:
            logger.debug(
                "MIME %s 的解析器被覆盖: %s → %s",
                mime, _registry[mime].__name__, parser_cls.__name__,
            )
        _registry[mime] = parser_cls
    return parser_cls


def get_parser_for_mime(mime: str) -> type[BaseDocumentParser] | None:
    """根据 MIME 类型查找已注册的解析器。"""
    return _registry.get(mime)


def get_supported_mimes() -> list[str]:
    """返回所有已注册的 MIME 类型。"""
    return list(_registry.keys())
