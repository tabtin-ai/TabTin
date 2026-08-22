"""
邮件服务工厂
"""

from typing import Dict, Any, Optional
from django.conf import settings
from .base import EmailServiceBase
from .tencent_email import TencentEmailService
from apps.services.common.exceptions import ConfigurationException
import logging

logger = logging.getLogger(__name__)


def get_email_config_error() -> Optional[str]:
    """
    检查邮件服务配置是否可用。

    Returns:
        None 表示配置完整；否则返回面向用户的错误说明。
    """
    try:
        _get_tencent_config()
        return None
    except ConfigurationException as exc:
        return exc.message


def get_email_service() -> EmailServiceBase:
    """
    根据配置返回对应的邮件服务实例

    Returns:
        EmailServiceBase: 配置的邮件服务实例

    Raises:
        ConfigurationException: 当配置无效时
    """
    provider = getattr(settings, 'SERVICES_EMAIL_PROVIDER', 'tencent').lower()

    if provider == 'tencent':
        config = _get_tencent_config()
        logger.info(f"使用腾讯企业邮箱服务: host={config.get('host')}, from={config.get('from_email')}")
        return TencentEmailService(config)
    else:
        raise ConfigurationException(f"不支持的邮件服务提供商: {provider}")


def _get_tencent_config() -> Dict[str, Any]:
    """
    获取腾讯企业邮箱服务配置

    Returns:
        Dict: 腾讯配置

    Raises:
        ConfigurationException: 当配置缺失时
    """
    config = {
        'host': getattr(settings, 'EMAIL_HOST', 'smtp.exmail.qq.com'),
        'port': getattr(settings, 'EMAIL_PORT', 465),
        'username': getattr(settings, 'EMAIL_HOST_USER', None),
        'password': getattr(settings, 'EMAIL_HOST_PASSWORD', None),
        'use_ssl': getattr(settings, 'EMAIL_USE_SSL', True),
        'use_tls': getattr(settings, 'EMAIL_USE_TLS', False),
        'timeout': getattr(settings, 'EMAIL_TIMEOUT', 30),
        'from_email': getattr(settings, 'DEFAULT_FROM_EMAIL', getattr(settings, 'EMAIL_HOST_USER', None)),
        'company_name': getattr(settings, 'COMPANY_NAME', 'TabTin'),
        'website': getattr(settings, 'COMPANY_WEBSITE', 'https://www.example.com'),
        'support_email': getattr(settings, 'SUPPORT_EMAIL', 'support@laichang.live'),
    }

    # 验证必需配置
    _validate_tencent_config(config)

    return config


def _validate_tencent_config(config: Dict[str, Any]) -> None:
    """
    验证腾讯企业邮箱配置

    Args:
        config: 配置字典

    Raises:
        ConfigurationException: 当配置无效时
    """
    # 基础配置验证
    if not config.get('host'):
        raise ConfigurationException("邮件服务器地址(EMAIL_HOST)未配置")

    if not config.get('username'):
        raise ConfigurationException("邮件服务器用户名(EMAIL_HOST_USER)未配置")

    if not config.get('password'):
        raise ConfigurationException("邮件服务器密码(EMAIL_HOST_PASSWORD)未配置")

    if not config.get('from_email'):
        raise ConfigurationException("默认发件人邮箱(DEFAULT_FROM_EMAIL)未配置")

    # 端口验证
    try:
        port = int(config.get('port', 0))
        if port < 1 or port > 65535:
            raise ConfigurationException("邮件服务器端口号必须在1-65535之间")
    except (ValueError, TypeError):
        raise ConfigurationException("邮件服务器端口号必须是有效的数字")


def get_available_providers() -> list:
    """
    获取可用的邮件服务提供商列表

    Returns:
        list: 提供商列表
    """
    return ['tencent']


def validate_provider_config(provider: str) -> bool:
    """
    验证指定提供商的配置是否有效

    Args:
        provider: 提供商名称

    Returns:
        bool: 配置是否有效
    """
    try:
        if provider.lower() == 'tencent':
            config = _get_tencent_config()
            service = TencentEmailService(config)
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
        'tencent': {
            'name': '腾讯企业邮箱',
            'description': '腾讯企业邮箱SMTP服务，支持HTML邮件、附件等',
            'features': ['HTML邮件', '纯文本邮件', '附件支持', '模板邮件', '批量发送'],
            'smtp_hosts': ['smtp.exmail.qq.com'],
            'ports': [25, 465, 587],
            'auth_methods': ['用户名密码']
        }
    }

    return providers_info.get(provider.lower(), {})
