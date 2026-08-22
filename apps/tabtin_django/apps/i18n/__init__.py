"""
国际化 (i18n) 模块

提供统一的多语言支持，包括：
- 错误消息翻译
- API响应翻译
- LLM提示词多语言管理
- 网站示例本地化
"""

from .manager import i18n_manager, get_text, _
from .language import get_user_language, set_user_language, SupportedLanguage

__all__ = [
    'i18n_manager',
    'get_text',
    '_',
    'get_user_language',
    'set_user_language',
    'SupportedLanguage',
]

