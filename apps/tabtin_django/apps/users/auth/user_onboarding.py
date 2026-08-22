"""用户创建与个人 Space onboarding 编排。

注册 / 验证码自动注册必须先写入 profile.language，再 provision personal organization，
否则 ``create_default_organization`` signal 会在 language=system 时落中文默认 Space 名。
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save

from apps.i18n.language import SupportedLanguage, get_user_language

logger = logging.getLogger(__name__)
User = get_user_model()


def profile_language_from_request(request) -> Optional[str]:
    """把 HTTP 请求语言偏好映射为 UserProfile.language 存储值。"""
    if request is None:
        return None
    language = get_user_language(request=request, user=None)
    if language in (SupportedLanguage.EN_US, SupportedLanguage.EN_GB):
        return 'en-US'
    if language == SupportedLanguage.ZH_CN:
        return 'zh-CN'
    return None


def create_user_with_personal_onboarding(
    request,
    *,
    user_data: dict[str, Any],
    profile_language: Optional[str] = None,
) -> User:
    """创建用户并在正确语言下 provision 个人 organization + 默认 Space。"""
    from apps.tabtinspace.signals import create_default_organization
    from apps.tabtinspace.services.organization_service import OrganizationService

    resolved_language = profile_language or profile_language_from_request(request)

    post_save.disconnect(create_default_organization, sender=User)
    try:
        user = User.objects.create_user(**user_data)
        if resolved_language:
            profile = user.profile
            profile.language = resolved_language
            profile.save(update_fields=['language'])

        organization, created_now = OrganizationService.ensure_personal_organization(user)
        if created_now:
            logger.info(
                "为用户 %s 创建个人 organization(%s) 与默认 Space（language=%s）",
                user.id,
                organization.id,
                resolved_language or 'system',
            )
        return user
    finally:
        post_save.connect(create_default_organization, sender=User)
