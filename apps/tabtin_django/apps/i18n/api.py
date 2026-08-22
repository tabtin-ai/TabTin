"""
I18n API 端点

提供语言切换和翻译管理的API接口
"""

from ninja import Router
from ninja.errors import HttpError
from typing import List
from pydantic import BaseModel

from apps.users.auth.permissions import JWTAuth
from .language import SupportedLanguage, LANGUAGE_NAMES
from .manager import i18n_manager
from .manager import get_text
from .response import success_response, error_response

router = Router(tags=["国际化"])

jwt_auth = JWTAuth()


class LanguageInfo(BaseModel):
    """语言信息"""
    code: str
    name: str


class SupportedLanguagesResponse(BaseModel):
    """支持的语言列表响应"""
    languages: List[LanguageInfo]


class TranslationRequest(BaseModel):
    """翻译请求"""
    key: str
    language: str
    params: dict = {}


@router.get("/languages", response=dict, auth=None, summary="获取支持的语言列表")
def get_supported_languages(request):
    """
    获取系统支持的所有语言

    Returns:
        语言列表
    """
    languages = [
        {"code": lang.value, "name": LANGUAGE_NAMES[lang]}
        for lang in SupportedLanguage
    ]

    return success_response(
        data={"languages": languages},
        message_key="common.success"
    )


@router.post("/translate", response=dict, auth=None, summary="获取翻译文本")
def get_translation(request, payload: TranslationRequest):
    """
    获取指定键的翻译文本

    Args:
        payload: 翻译请求

    Returns:
        翻译文本
    """
    try:
        language = SupportedLanguage(payload.language)
    except ValueError:
        return error_response(
            code="INVALID_LANGUAGE",
            message=get_text("i18n.unsupported_language", value=payload.language),
            status_code=400
        )

    text = i18n_manager.get_text(
        payload.key,
        language=language,
        **payload.params
    )

    return success_response(
        data={"key": payload.key, "text": text, "language": payload.language},
        message_key="common.success"
    )


@router.post("/reload", response=dict, auth=jwt_auth, summary="重新加载翻译文件（管理员）")
def reload_translations(request):
    """
    重新加载所有翻译文件（需要管理员权限）

    Returns:
        操作结果
    """
    # 检查管理员权限
    if not getattr(request.auth, 'is_staff', False):
        return error_response(
            code="PERMISSION_DENIED",
            message_key="auth.permission_denied",
            status_code=403
        )

    try:
        i18n_manager.reload()
        return success_response(
            message=get_text("i18n.reload_success")
        )
    except Exception as e:
        return error_response(
            code="RELOAD_FAILED",
            message=get_text("i18n.reload_failed", detail=str(e)),
            status_code=500
        )
