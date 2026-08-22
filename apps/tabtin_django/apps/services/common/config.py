"""
Services模块配置管理器
"""

import os
from typing import Any, Dict, Optional, Union, List
from django.conf import settings
import logging

from .constants import DEFAULT_CONFIG, SERVICE_TYPES, ERROR_CODES
from .cache import get_cached_config, cache_config
from .exceptions import ConfigurationException

logger = logging.getLogger(__name__)


class ConfigManager:
    """配置管理器"""

    def __init__(self, service_name: str = None):
        """
        初始化配置管理器

        Args:
            service_name: 服务名称
        """
        self.service_name = service_name or 'common'
        self._config_cache = {}

    def get(self, key: str, default: Any = None, use_cache: bool = True) -> Any:
        """
        获取配置值

        Args:
            key: 配置键
            default: 默认值
            use_cache: 是否使用缓存

        Returns:
            Any: 配置值
        """
        try:
            # 首先尝试从缓存获取
            if use_cache:
                cached_value = get_cached_config(self.service_name, key)
                if cached_value is not None:
                    return cached_value

            # 尝试从Django settings获取
            full_key = f"{self.service_name.upper()}_{key}" if self.service_name != 'common' else key
            value = getattr(settings, full_key, None)

            if value is not None:
                # 缓存配置值
                if use_cache:
                    cache_config(self.service_name, key, value)
                return value

            # 尝试从环境变量获取
            env_value = os.getenv(full_key)
            if env_value is not None:
                # 尝试转换类型
                converted_value = self._convert_value(env_value)
                if use_cache:
                    cache_config(self.service_name, key, converted_value)
                return converted_value

            # 尝试从默认配置获取
            if key in DEFAULT_CONFIG:
                default_value = DEFAULT_CONFIG[key]
                if use_cache:
                    cache_config(self.service_name, key, default_value)
                return default_value

            return default
        except Exception as e:
            logger.error(f"配置获取失败: {self.service_name}:{key} - {e}")
            return default

    def set(self, key: str, value: Any, persist: bool = False) -> bool:
        """
        设置配置值

        Args:
            key: 配置键
            value: 配置值
            persist: 是否持久化（暂不实现）

        Returns:
            bool: 是否设置成功
        """
        try:
            # 缓存配置值
            cache_config(self.service_name, key, value)

            # 更新内存缓存
            self._config_cache[key] = value

            if persist:
                logger.warning(f"配置持久化功能暂未实现: {key}")

            logger.debug(f"配置设置成功: {self.service_name}:{key}")
            return True
        except Exception as e:
            logger.error(f"配置设置失败: {self.service_name}:{key} - {e}")
            return False

    def get_required(self, key: str) -> Any:
        """
        获取必需的配置值

        Args:
            key: 配置键

        Returns:
            Any: 配置值

        Raises:
            ConfigurationException: 配置不存在时抛出
        """
        value = self.get(key)
        if value is None:
            raise ConfigurationException(f"必需的配置项缺失: {self.service_name}:{key}")
        return value

    def get_int(self, key: str, default: int = 0) -> int:
        """获取整数配置值"""
        value = self.get(key, default)
        try:
            return int(value)
        except (ValueError, TypeError):
            logger.warning(f"配置值转换为整数失败: {key}={value}, 使用默认值: {default}")
            return default

    def get_float(self, key: str, default: float = 0.0) -> float:
        """获取浮点数配置值"""
        value = self.get(key, default)
        try:
            return float(value)
        except (ValueError, TypeError):
            logger.warning(f"配置值转换为浮点数失败: {key}={value}, 使用默认值: {default}")
            return default

    def get_bool(self, key: str, default: bool = False) -> bool:
        """获取布尔配置值"""
        value = self.get(key, default)
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            return value.lower() in ('true', '1', 'yes', 'on')
        return bool(value)

    def get_list(self, key: str, default: List = None, separator: str = ',') -> List:
        """获取列表配置值"""
        default = default or []
        value = self.get(key, default)
        if isinstance(value, list):
            return value
        if isinstance(value, str):
            return [item.strip() for item in value.split(separator) if item.strip()]
        return default

    def get_dict(self, key: str, default: Dict = None) -> Dict:
        """获取字典配置值"""
        default = default or {}
        value = self.get(key, default)
        if isinstance(value, dict):
            return value
        return default

    def validate_required_config(self, required_keys: List[str]) -> None:
        """
        验证必需的配置项

        Args:
            required_keys: 必需的配置键列表

        Raises:
            ConfigurationException: 配置验证失败时抛出
        """
        missing_keys = []
        for key in required_keys:
            if self.get(key) is None:
                missing_keys.append(key)

        if missing_keys:
            raise ConfigurationException(
                f"服务 {self.service_name} 缺少必需配置: {', '.join(missing_keys)}"
            )

    def get_service_config(self) -> Dict[str, Any]:
        """
        获取服务的完整配置

        Returns:
            Dict: 服务配置字典
        """
        config = {}

        # 根据服务类型获取相应的配置
        if self.service_name == 'sms':
            config.update(self._get_sms_config())
        elif self.service_name == 'email':
            config.update(self._get_email_config())
        elif self.service_name == 'oss':
            config.update(self._get_oss_config())

        return config

    def _get_sms_config(self) -> Dict[str, Any]:
        """获取SMS服务配置"""
        return {
            'provider': self.get('PROVIDER', 'aliyun'),
            'access_key_id': self.get('ACCESS_KEY_ID'),
            'access_key_secret': self.get('ACCESS_KEY_SECRET'),
            'region': self.get('REGION', 'cn-hangzhou'),
            'sign_name': self.get('SIGN_NAME'),
            'template_code': self.get('TEMPLATE_CODE'),
            'use_ecs_role': self.get_bool('USE_ECS_ROLE', True),
        }

    def _get_email_config(self) -> Dict[str, Any]:
        """获取Email服务配置"""
        return {
            'provider': self.get('PROVIDER', 'tencent'),
            'host': self.get('HOST'),
            'port': self.get_int('PORT', 465),
            'username': self.get('USERNAME'),
            'password': self.get('PASSWORD'),
            'use_tls': self.get_bool('USE_TLS', True),
            'use_ssl': self.get_bool('USE_SSL', True),
        }

    def _get_oss_config(self) -> Dict[str, Any]:
        """获取OSS服务配置"""
        return {
            'provider': self.get('PROVIDER', 'aliyun'),
            'bucket_name': self.get('BUCKET_NAME'),
            'endpoint': self.get('ENDPOINT'),
            'internal_endpoint': self.get('INTERNAL_ENDPOINT'),
            'region': self.get('REGION'),
            'access_mode': self.get('ACCESS_MODE', 'private'),
            'cdn_domain': self.get('CDN_DOMAIN', ''),
            'max_file_size': self.get_int('MAX_FILE_SIZE', DEFAULT_CONFIG['MAX_FILE_SIZE']),
            'allowed_extensions': self.get_list('ALLOWED_EXTENSIONS', DEFAULT_CONFIG['ALLOWED_FILE_EXTENSIONS']),
        }

    def _convert_value(self, value: str) -> Union[str, int, float, bool]:
        """
        尝试转换环境变量值的类型

        Args:
            value: 字符串值

        Returns:
            Union[str, int, float, bool]: 转换后的值
        """
        # 尝试转换为布尔值
        if value.lower() in ('true', 'false'):
            return value.lower() == 'true'

        # 尝试转换为整数
        try:
            return int(value)
        except ValueError:
            pass

        # 尝试转换为浮点数
        try:
            return float(value)
        except ValueError:
            pass

        # 返回原始字符串
        return value

    def reload(self) -> None:
        """重新加载配置"""
        self._config_cache.clear()
        logger.info(f"配置重新加载: {self.service_name}")


# 全局配置管理器实例
config_manager = ConfigManager()
sms_config = ConfigManager('sms')
email_config = ConfigManager('email')
oss_config = ConfigManager('oss')


def get_service_config(service_name: str) -> Dict[str, Any]:
    """
    获取服务配置

    Args:
        service_name: 服务名称

    Returns:
        Dict: 服务配置
    """
    manager = ConfigManager(service_name)
    return manager.get_service_config()


def validate_service_config(service_name: str) -> bool:
    """
    验证服务配置

    Args:
        service_name: 服务名称

    Returns:
        bool: 配置是否有效
    """
    try:
        manager = ConfigManager(service_name)

        if service_name == 'sms':
            required_keys = ['SIGN_NAME', 'TEMPLATE_CODE']
            if not manager.get_bool('USE_ECS_ROLE', True):
                required_keys.extend(['ACCESS_KEY_ID', 'ACCESS_KEY_SECRET'])
        elif service_name == 'email':
            required_keys = ['HOST', 'USERNAME', 'PASSWORD']
        elif service_name == 'oss':
            required_keys = ['BUCKET_NAME', 'ENDPOINT', 'REGION']
        else:
            return True

        manager.validate_required_config(required_keys)
        return True
    except ConfigurationException as e:
        logger.error(f"服务配置验证失败: {service_name} - {e}")
        return False


def get_error_message(error_code: str, default: str = "未知错误") -> str:
    """
    根据错误代码获取错误消息

    Args:
        error_code: 错误代码
        default: 默认错误消息

    Returns:
        str: 错误消息
    """
    error_messages = {
        ERROR_CODES['SUCCESS']: '操作成功',
        ERROR_CODES['UNKNOWN_ERROR']: '未知错误',
        ERROR_CODES['INVALID_PARAMS']: '参数无效',
        ERROR_CODES['MISSING_PARAMS']: '参数缺失',
        ERROR_CODES['VALIDATION_ERROR']: '参数验证失败',
        ERROR_CODES['CONFIG_ERROR']: '配置错误',
        ERROR_CODES['NETWORK_ERROR']: '网络连接异常',
        ERROR_CODES['AUTH_ERROR']: '认证失败',
        ERROR_CODES['RATE_LIMIT_ERROR']: '请求频率过高',
        ERROR_CODES['SMS_ERROR']: '短信服务异常',
        ERROR_CODES['EMAIL_ERROR']: '邮件服务异常',
        ERROR_CODES['OSS_ERROR']: 'OSS服务异常',
    }

    return error_messages.get(error_code, default)


def is_production() -> bool:
    """检查是否为生产环境"""
    return getattr(settings, 'DEBUG', True) is False


def is_development() -> bool:
    """检查是否为开发环境"""
    return getattr(settings, 'DEBUG', True) is True


def get_environment() -> str:
    """获取当前环境"""
    if is_production():
        return 'production'
    return 'development'


def is_yjs_first_enabled(product: str = "all") -> bool:
    """
    检查 Agent Y.js-first 写入模式是否对指定产品启用。

    Y.js-first 模式下，Agent 变更先注入 Y.Doc CRDT，由 Hocuspocus onStore
    自动持久化到 DB，与用户编辑共享同一条链路。

    通过 Django settings.AGENT_YJS_FIRST 控制，支持按产品粒度开关。

    settings 示例:
        AGENT_YJS_FIRST = True                          # 全部启用（默认）
        AGENT_YJS_FIRST = False                         # 全部关闭
        AGENT_YJS_FIRST = {"tabslide": True}  # 按产品

    Args:
        product: 产品标识（tabslide/tabdoc/tabdata）
    """
    flag = getattr(settings, "AGENT_YJS_FIRST", True)
    if isinstance(flag, bool):
        return flag
    if isinstance(flag, dict):
        return flag.get(product, True)
    return True
