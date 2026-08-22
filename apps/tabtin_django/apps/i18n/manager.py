"""
多语言管理器

职责：
- 加载和缓存翻译文件
- 提供翻译查询接口
- 支持参数化翻译
- 支持回退机制
"""

import json
import logging
from pathlib import Path
from typing import Dict, Any, Optional
from django.core.cache import cache

from .language import SupportedLanguage, DEFAULT_LANGUAGE, get_user_language

logger = logging.getLogger(__name__)


class I18nManager:
    """多语言管理器"""

    def __init__(self):
        self.translations: Dict[SupportedLanguage, Dict[str, str]] = {}
        self.locale_dir = Path(__file__).parent / 'locales'
        self._load_all_translations()

    def _load_all_translations(self):
        """加载所有语言的翻译文件"""
        if not self.locale_dir.exists():
            logger.warning(f"翻译目录不存在: {self.locale_dir}")
            self.locale_dir.mkdir(parents=True, exist_ok=True)
            return

        for lang in SupportedLanguage:
            self._load_translation(lang)

    def _load_translation(self, language: SupportedLanguage):
        """加载单个语言的翻译文件"""
        file_path = self.locale_dir / f"{language.value}.json"

        if not file_path.exists():
            self.translations[language] = {}
            return

        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                self.translations[language] = json.load(f)
            logger.info(f"已加载翻译文件: {file_path} ({len(self.translations[language])} 条)")
        except Exception as e:
            logger.error(f"加载翻译文件失败: {file_path}, 错误: {e}")
            self.translations[language] = {}

    def get_text(
        self,
        key: str,
        language: Optional[SupportedLanguage] = None,
        default: Optional[str] = None,
        **kwargs
    ) -> str:
        """
        获取翻译文本

        Args:
            key: 翻译键（如 "error.not_found"）
            language: 目标语言，如果为None则使用当前语言
            default: 默认文本，如果找不到翻译则返回此值
            **kwargs: 参数化翻译的变量

        Returns:
            翻译后的文本
        """
        # 确定目标语言
        if language is None:
            language = get_user_language()

        # 查找翻译
        text = self._find_translation(key, language, default)

        # 参数化替换
        if kwargs:
            try:
                text = text.format(**kwargs)
            except KeyError as e:
                logger.warning(f"翻译参数缺失: key={key}, missing={e}")

        return text

    def _find_translation(
        self,
        key: str,
        language: SupportedLanguage,
        default: Optional[str]
    ) -> str:
        """
        查找翻译（带回退机制）

        回退顺序：
        1. 目标语言
        2. 同语言不同地区（如 en-GB -> en-US）
        3. 默认语言（zh-CN）
        4. 键名本身或提供的默认值
        """
        # 1. 尝试目标语言
        if language in self.translations:
            text = self._get_nested_value(self.translations[language], key)
            if text:
                return text

        # 2. 尝试同语言不同地区
        lang_prefix = language.value.split('-')[0]
        for fallback_lang in SupportedLanguage:
            if fallback_lang == language:
                continue
            if fallback_lang.value.startswith(lang_prefix):
                if fallback_lang in self.translations:
                    text = self._get_nested_value(self.translations[fallback_lang], key)
                    if text:
                        return text

        # 3. 尝试默认语言
        if language != DEFAULT_LANGUAGE and DEFAULT_LANGUAGE in self.translations:
            text = self._get_nested_value(self.translations[DEFAULT_LANGUAGE], key)
            if text:
                return text

        # 4. 返回默认值或键名
        return default or key

    def _get_nested_value(self, data: Dict[str, Any], key: str) -> Optional[str]:
        """
        获取嵌套字典的值

        支持点号分隔的键，如 "error.validation.required"

        Args:
            data: 字典数据
            key: 键（支持点号分隔）

        Returns:
            值或None
        """
        keys = key.split('.')
        value = data

        for k in keys:
            if isinstance(value, dict) and k in value:
                value = value[k]
            else:
                return None

        return value if isinstance(value, str) else None

    def reload(self):
        """重新加载所有翻译文件"""
        self.translations.clear()
        self._load_all_translations()
        logger.info("已重新加载所有翻译文件")


# 全局单例
i18n_manager = I18nManager()


# 便捷函数
def get_text(key: str, language: Optional[SupportedLanguage] = None, default: Optional[str] = None, **kwargs) -> str:
    """
    获取翻译文本（便捷函数）

    使用示例：
        from apps.i18n import get_text, _

        # 基本用法
        msg = get_text('error.not_found')

        # 指定语言
        msg = get_text('error.not_found', language=SupportedLanguage.EN_US)

        # 参数化
        msg = get_text('error.field_required', field_name='用户名')

        # 简写
        msg = _('error.not_found')
    """
    return i18n_manager.get_text(key, language, default, **kwargs)


# 简写别名
_ = get_text

