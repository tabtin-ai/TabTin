"""
LLM 提示词多语言管理

职责：
- 管理LLM提示词的多语言版本
- 根据用户语言动态选择提示词
- 自动替换网站示例为本地化版本
"""

import logging
from typing import Dict, Any, Optional
from pathlib import Path

from .language import SupportedLanguage, get_user_language
from .manager import i18n_manager

logger = logging.getLogger(__name__)


class PromptI18nManager:
    """LLM提示词国际化管理器"""

    def __init__(self):
        self.prompt_templates: Dict[str, Dict[SupportedLanguage, str]] = {}

    def register_prompt(
        self,
        prompt_id: str,
        templates: Dict[SupportedLanguage, str]
    ):
        """
        注册多语言提示词模板

        Args:
            prompt_id: 提示词ID（如 "pagination_analysis"）
            templates: 各语言的提示词模板
        """
        self.prompt_templates[prompt_id] = templates
        logger.debug(f"注册提示词模板: {prompt_id}, 支持语言: {list(templates.keys())}")

    def get_prompt(
        self,
        prompt_id: str,
        language: Optional[SupportedLanguage] = None,
        **kwargs
    ) -> str:
        """
        获取本地化的提示词

        Args:
            prompt_id: 提示词ID
            language: 目标语言，如果为None则使用当前语言
            **kwargs: 提示词变量（会自动处理网站示例）

        Returns:
            本地化的提示词
        """
        # 确定目标语言
        if language is None:
            language = get_user_language()

        # 获取提示词模板
        if prompt_id not in self.prompt_templates:
            logger.warning(f"提示词模板不存在: {prompt_id}")
            return ""

        templates = self.prompt_templates[prompt_id]

        # 查找目标语言的模板（带回退机制）
        template = self._find_template(templates, language)

        # 处理网站示例
        kwargs = self._localize_website_examples(kwargs, language)

        # 替换变量
        try:
            return template.format(**kwargs)
        except KeyError as e:
            logger.warning(f"提示词参数缺失: prompt_id={prompt_id}, missing={e}")
            return template

    def _find_template(
        self,
        templates: Dict[SupportedLanguage, str],
        language: SupportedLanguage
    ) -> str:
        """
        查找模板（带回退机制）

        回退顺序：
        1. 目标语言
        2. 同语言不同地区
        3. 英语
        4. 第一个可用的模板
        """
        # 1. 目标语言
        if language in templates:
            return templates[language]

        # 2. 同语言不同地区
        lang_prefix = language.value.split('-')[0]
        for lang, template in templates.items():
            if lang.value.startswith(lang_prefix):
                return template

        # 3. 英语
        for lang in [SupportedLanguage.EN_US, SupportedLanguage.EN_GB]:
            if lang in templates:
                return templates[lang]

        # 4. 第一个可用的
        return next(iter(templates.values()))

    def _localize_website_examples(
        self,
        kwargs: Dict[str, Any],
        language: SupportedLanguage
    ) -> Dict[str, Any]:
        """
        将变量中的网站示例本地化

        Args:
            kwargs: 原始变量
            language: 目标语言

        Returns:
            本地化后的变量
        """
        # 定义需要本地化的变量名模式
        example_keys = ['website_examples', 'example_websites', 'examples']

        result = kwargs.copy()

        for key in example_keys:
            if key in result:
                result[key] = self._get_localized_examples(language)

        return result

    def _get_localized_examples(self, language: SupportedLanguage) -> str:
        """
        获取本地化的网站示例

        Args:
            language: 目标语言

        Returns:
            本地化的网站示例字符串
        """
        # 确定使用中文还是英文示例
        is_chinese = language.value.startswith('zh')
        example_lang = 'zh' if is_chinese else 'en'

        # 获取所有类别的示例
        categories = [
            'social_media',
            'ecommerce',
            'news',
            'video',
            'entertainment',
            'forum'
        ]

        examples = []
        for category in categories:
            key = f"website_examples.{category}.{example_lang}"
            example = i18n_manager.get_text(key, language)
            if example and example != key:
                examples.append(example)

        return ', '.join(examples) if examples else ""


# 全局单例
prompt_i18n_manager = PromptI18nManager()


def get_localized_prompt(
    prompt_id: str,
    language: Optional[SupportedLanguage] = None,
    **kwargs
) -> str:
    """
    获取本地化的提示词（便捷函数）

    使用示例：
        from apps.i18n.prompt import get_localized_prompt

        # 基本用法
        prompt = get_localized_prompt('pagination_analysis', url=url)

        # 指定语言
        prompt = get_localized_prompt(
            'pagination_analysis',
            language=SupportedLanguage.EN_US,
            url=url
        )
    """
    return prompt_i18n_manager.get_prompt(prompt_id, language, **kwargs)

