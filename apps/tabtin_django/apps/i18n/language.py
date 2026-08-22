"""
语言检测和管理

职责：
- 从请求头检测用户语言
- 提供语言切换接口
- 定义支持的语言列表
"""

from enum import Enum
from typing import Optional
import threading


class SupportedLanguage(str, Enum):
    """支持的语言"""
    ZH_CN = "zh-CN"  # 简体中文
    ZH_TW = "zh-TW"  # 繁体中文
    EN_US = "en-US"  # 英语（美国）
    EN_GB = "en-GB"  # 英语（英国）
    JA_JP = "ja-JP"  # 日语
    KO_KR = "ko-KR"  # 韩语
    ES_ES = "es-ES"  # 西班牙语
    FR_FR = "fr-FR"  # 法语
    DE_DE = "de-DE"  # 德语
    PT_BR = "pt-BR"  # 葡萄牙语（巴西）
    RU_RU = "ru-RU"  # 俄语
    AR_SA = "ar-SA"  # 阿拉伯语


# 语言显示名称
LANGUAGE_NAMES = {
    SupportedLanguage.ZH_CN: "简体中文",
    SupportedLanguage.ZH_TW: "繁體中文",
    SupportedLanguage.EN_US: "English (US)",
    SupportedLanguage.EN_GB: "English (UK)",
    SupportedLanguage.JA_JP: "日本語",
    SupportedLanguage.KO_KR: "한국어",
    SupportedLanguage.ES_ES: "Español",
    SupportedLanguage.FR_FR: "Français",
    SupportedLanguage.DE_DE: "Deutsch",
    SupportedLanguage.PT_BR: "Português",
    SupportedLanguage.RU_RU: "Русский",
    SupportedLanguage.AR_SA: "العربية",
}

# 默认语言
DEFAULT_LANGUAGE = SupportedLanguage.ZH_CN

# 线程本地存储，用于保存当前请求的语言
_thread_local = threading.local()


def _normalize_profile_language(value: Optional[str]) -> Optional[SupportedLanguage]:
    """规范化用户配置语言值"""
    if not value:
        return None
    if value == "system":
        return None
    lower = value.lower()
    if lower.startswith("zh"):
        return SupportedLanguage.ZH_CN
    if lower.startswith("en"):
        return SupportedLanguage.EN_US
    try:
        return SupportedLanguage(value)
    except ValueError:
        return None


def get_user_language(request=None, user=None) -> SupportedLanguage:
    """
    获取用户语言偏好

    优先级：
    1. 线程本地变量（当前请求设置的）
    2. 用户设置（数据库中的偏好）
    3. Accept-Language 请求头
    4. 默认语言

    Args:
        request: Django request对象
        user: Django user对象

    Returns:
        用户语言
    """
    # 1. 检查线程本地变量
    if hasattr(_thread_local, 'language'):
        return _thread_local.language

    # 2. 检查用户设置
    if user:
        profile = getattr(user, 'profile', None)
        profile_language = getattr(profile, 'language', None) if profile else None
        normalized = _normalize_profile_language(profile_language)
        if normalized:
            return normalized

        if hasattr(user, 'language_preference') and user.language_preference:
            try:
                return SupportedLanguage(user.language_preference)
            except ValueError:
                pass

    # 3. 检查请求头
    if request:
        accept_language = request.headers.get('Accept-Language', '')
        detected_lang = _detect_language_from_header(accept_language)
        if detected_lang:
            return detected_lang

    # 4. 返回默认语言
    return DEFAULT_LANGUAGE


def set_user_language(language: SupportedLanguage):
    """
    设置当前线程的语言（用于请求处理期间）

    Args:
        language: 语言代码
    """
    _thread_local.language = language


def clear_user_language():
    """清除当前线程的语言设置"""
    if hasattr(_thread_local, 'language'):
        delattr(_thread_local, 'language')


def _detect_language_from_header(accept_language: str) -> Optional[SupportedLanguage]:
    """
    从 Accept-Language 请求头检测语言

    Args:
        accept_language: Accept-Language 头内容

    Returns:
        检测到的语言，如果无法识别返回 None
    """
    if not accept_language:
        return None

    # 解析 Accept-Language，格式：zh-CN,zh;q=0.9,en;q=0.8
    languages = []
    for item in accept_language.split(','):
        parts = item.strip().split(';')
        lang = parts[0].strip()
        # 提取权重
        quality = 1.0
        if len(parts) > 1 and parts[1].strip().startswith('q='):
            try:
                quality = float(parts[1].strip()[2:])
            except ValueError:
                quality = 1.0
        languages.append((lang, quality))

    # 按权重排序
    languages.sort(key=lambda x: x[1], reverse=True)

    # 匹配支持的语言
    for lang, _ in languages:
        # 完全匹配（如 zh-CN）
        try:
            return SupportedLanguage(lang)
        except ValueError:
            pass

        # 前缀匹配（如 zh 匹配 zh-CN）
        lang_prefix = lang.split('-')[0].lower()
        for supported_lang in SupportedLanguage:
            if supported_lang.value.split('-')[0].lower() == lang_prefix:
                return supported_lang

    return None


def get_language_region(language: SupportedLanguage) -> str:
    """
    获取语言对应的地区代码

    Args:
        language: 语言代码

    Returns:
        地区代码（如 CN, US, JP）
    """
    return language.value.split('-')[1] if '-' in language.value else language.value


def is_rtl_language(language: SupportedLanguage) -> bool:
    """
    判断是否为从右到左的语言

    Args:
        language: 语言代码

    Returns:
        是否为RTL语言
    """
    rtl_languages = {SupportedLanguage.AR_SA}
    return language in rtl_languages
