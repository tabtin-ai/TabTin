"""
服务开关预检守卫。

在计费服务执行前检查 OrganizationServicePolicy，阻断已禁用的服务。
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from apps.services.billing.exceptions import BillingError

logger = logging.getLogger(__name__)

_CACHE_PREFIX = "billing:svc_policy:"
_CACHE_TTL = 30  # seconds
_SENTINEL_NONE: Dict[str, Any] = {"__sentinel__": True}


class ServiceDisabledError(BillingError):
    """服务被组织管理员禁用"""

    def __init__(self, service_key: str, organization_id: str):
        self.service_key = service_key
        self.organization_id = organization_id
        super().__init__(
            f"Service '{service_key}' is disabled for organization '{organization_id}'",
            code="SERVICE_DISABLED",
        )


_SERVICE_KEY_FIELD_MAP = {
    "media.image": "enable_media_image",
    "media.video": "enable_media_video",
    "media.audio": "enable_media_audio",
    "speech.asr": "enable_speech_asr",
    "speech.tts": "enable_speech_tts",
    "rag.embedding": "enable_rag_embedding",
    "web.search": "enable_web_search",
    "docparse": "enable_docparse",
}


def _is_service_enabled(policy_dict: Dict[str, bool], service_key: str) -> bool:
    field = _SERVICE_KEY_FIELD_MAP.get(service_key)
    if field is None:
        return True
    return bool(policy_dict.get(field, True))


class ServiceGuardService:
    """服务开关预检守卫"""

    @staticmethod
    def check_service_enabled(
        organization_id: str,
        service_key: str,
        *,
        raise_on_disabled: bool = False,
    ) -> Optional[dict]:
        """检查服务是否启用。

        Returns:
            None: 服务已启用（放行）
            dict: 服务已禁用（阻断），包含 blocked/reason/service_key
        """
        if not organization_id:
            return None

        policy_dict = ServiceGuardService._get_policy_dict(organization_id)
        if policy_dict is None:
            return None

        if _is_service_enabled(policy_dict, service_key):
            return None

        result = {
            "blocked": True,
            "reason": "service_disabled",
            "service_key": service_key,
            "message": "该服务已被组织管理员禁用",
        }

        if raise_on_disabled:
            raise ServiceDisabledError(service_key, organization_id)

        return result

    @staticmethod
    def check_auto_index_enabled(
        organization_id: str,
        index_type: str = "doc",
    ) -> bool:
        """检查自动索引是否启用。

        Args:
            index_type: 当前仅支持 "doc"
        """
        if not organization_id:
            return True

        policy_dict = ServiceGuardService._get_policy_dict(organization_id)
        if policy_dict is None:
            return True

        if index_type == "doc":
            return bool(policy_dict.get("enable_auto_doc_index", True))
        return True

    @staticmethod
    def _get_policy_dict(organization_id: str) -> Optional[Dict[str, bool]]:
        """获取服务策略 dict（带短期缓存，避免缓存 ORM 对象的序列化风险）"""
        from django.core.cache import cache

        cache_key = f"{_CACHE_PREFIX}{organization_id}"
        cached = cache.get(cache_key)
        if cached is not None:
            if isinstance(cached, dict) and cached.get("__sentinel__"):
                return None
            if isinstance(cached, dict):
                return cached
            return None

        from apps.services.billing.models import OrganizationServicePolicy

        policy = OrganizationServicePolicy.objects.filter(
            organization_id=organization_id
        ).first()

        if policy is None:
            cache.set(cache_key, _SENTINEL_NONE, _CACHE_TTL)
            return None

        policy_dict = {
            "enable_media_image": policy.enable_media_image,
            "enable_media_video": policy.enable_media_video,
            "enable_media_audio": policy.enable_media_audio,
            "enable_speech_asr": policy.enable_speech_asr,
            "enable_speech_tts": policy.enable_speech_tts,
            "enable_rag_embedding": policy.enable_rag_embedding,
            "enable_web_search": policy.enable_web_search,
            "enable_docparse": policy.enable_docparse,
            "enable_auto_doc_index": policy.enable_auto_doc_index,
        }
        cache.set(cache_key, policy_dict, _CACHE_TTL)
        return policy_dict

    @staticmethod
    def invalidate_cache(organization_id: str) -> None:
        """策略变更后清除缓存"""
        from django.core.cache import cache

        cache.delete(f"{_CACHE_PREFIX}{organization_id}")
