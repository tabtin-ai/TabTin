"""
短信服务工厂
"""

from typing import Dict, Any
from django.conf import settings
from .base import SmsServiceBase
from .aliyun_sms import AliyunSmsService
from apps.services.common.exceptions import ConfigurationException
import logging

logger = logging.getLogger(__name__)


def get_sms_service() -> SmsServiceBase:
    """
    根据配置返回对应的短信服务实例

    Returns:
        SmsServiceBase: 配置的短信服务实例

    Raises:
        ConfigurationException: 当配置无效时
    """
    provider = getattr(settings, 'SERVICES_SMS_PROVIDER', 'aliyun').lower()

    if provider == 'aliyun':
        config = _get_aliyun_config()
        logger.info(f"使用阿里云短信服务: region={config.get('region')}, sign_name={config.get('sign_name')}")
        return AliyunSmsService(config)
    else:
        raise ConfigurationException(f"不支持的短信服务提供商: {provider}")


def _get_aliyun_config() -> Dict[str, Any]:
    """
    获取阿里云短信服务配置

    Returns:
        Dict: 阿里云配置

    Raises:
        ConfigurationException: 当配置缺失时
    """
    # 密钥优先级：SMS 专用 (ALIYUN_SMS_ACCESS_KEY_*) > 全局 (ALIYUN_ACCESS_KEY_*)。
    # 允许短信走独立子账号（与 OSS 等其他阿里云服务隔离），未设专用变量时保持原有行为。
    sms_access_key_id = (
        getattr(settings, 'ALIYUN_SMS_ACCESS_KEY_ID', None)
        or getattr(settings, 'ALIYUN_ACCESS_KEY_ID', None)
    )
    sms_access_key_secret = (
        getattr(settings, 'ALIYUN_SMS_ACCESS_KEY_SECRET', None)
        or getattr(settings, 'ALIYUN_ACCESS_KEY_SECRET', None)
    )
    config = {
        'region': getattr(settings, 'ALIYUN_SMS_REGION', 'cn-hangzhou'),
        'sign_name': getattr(settings, 'ALIYUN_SMS_SIGN_NAME', None),
        'verification_template_code': getattr(settings, 'ALIYUN_SMS_TEMPLATE_CODE', 'example-template-code'),
        'access_key_id': sms_access_key_id,
        'access_key_secret': sms_access_key_secret,
        'security_token': getattr(settings, 'ALIYUN_SECURITY_TOKEN', None),
        'use_ecs_role': getattr(settings, 'ALIYUN_USE_ECS_ROLE', True),
    }

    # 验证必需配置
    _validate_aliyun_config(config)

    return config


def _validate_aliyun_config(config: Dict[str, Any]) -> None:
    """
    验证阿里云配置

    Args:
        config: 配置字典

    Raises:
        ConfigurationException: 当配置无效时
    """
    use_ecs_role = getattr(settings, 'ALIYUN_USE_ECS_ROLE', True)
    # 基础配置验证
    if not config.get('sign_name'):
        raise ConfigurationException("阿里云短信签名(ALIYUN_SMS_SIGN_NAME)未配置")

    if not config.get('region'):
        raise ConfigurationException("阿里云地域(ALIYUN_SMS_REGION)未配置")

    # 验证访问密钥（在生产环境中必需）
    if use_ecs_role:
        logger.info("阿里云短信服务将使用ECS RAM角色或环境凭证获取访问密钥")
    else:
        if not config.get('access_key_id') and not config.get('security_token'):
            logger.warning("阿里云访问密钥ID(ALIYUN_ACCESS_KEY_ID)未配置，将尝试使用环境凭证")

        if not config.get('access_key_secret') and not config.get('security_token'):
            logger.warning("阿里云访问密钥Secret(ALIYUN_ACCESS_KEY_SECRET)未配置，将尝试使用环境凭证")



def get_available_providers() -> list:
    """
    获取可用的短信服务提供商列表

    Returns:
        list: 提供商列表
    """
    return ['aliyun']


def validate_provider_config(provider: str) -> bool:
    """
    验证指定提供商的配置是否有效

    Args:
        provider: 提供商名称

    Returns:
        bool: 配置是否有效
    """
    try:
        if provider.lower() == 'aliyun':
            config = _get_aliyun_config()
            service = AliyunSmsService(config)
            return service.validate_config()
        else:
            return False
    except Exception as e:
        logger.error(f"验证{provider}配置失败: {e}")
        return False


def get_provider_info(provider: str) -> Dict[str, Any]:
    """
    获取提供商信息

    Args:
        provider: 提供商名称

    Returns:
        Dict: 提供商信息
    """
    providers_info = {
        'aliyun': {
            'name': '阿里云短信服务',
            'description': '阿里云短信服务，支持验证码、通知短信等',
            'features': ['验证码短信', '通知短信', '批量发送', '发送状态查询'],
            'regions': ['cn-hangzhou', 'cn-beijing', 'cn-shanghai', 'cn-shenzhen'],
            'auth_methods': ['ECS角色', 'STS Token', 'AccessKey']
        }
    }

    return providers_info.get(provider.lower(), {})
