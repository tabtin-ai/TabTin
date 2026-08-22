"""
OSS服务工厂

通过 get_oss_service() 获取 OSS 服务单例，内部使用带 TTL 的缓存
避免每次调用都重新初始化客户端（含 ECS RAM 角色凭证请求）。
"""

import threading
import time
from typing import Dict, Any, Optional
from urllib.parse import urlparse

from django.conf import settings

from .base import OSSServiceBase
from .aliyun_oss import AliyunOSSService
from .local_file_oss import LocalFileOSSService
from apps.services.common.exceptions import ConfigurationException
import logging

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# OSS 服务实例缓存（线程安全，带 TTL）
# STS 凭证有效期通常 1 小时，缓存 25 分钟后刷新以留出安全余量。
# ---------------------------------------------------------------------------
_oss_service_cache: Optional[OSSServiceBase] = None
_cache_expires_at: float = 0
_cache_lock = threading.Lock()
_updater_oss_service_cache: Optional[OSSServiceBase] = None
_updater_cache_expires_at: float = 0
_updater_cache_lock = threading.Lock()
_CACHE_TTL = 25 * 60  # 25 分钟


def get_oss_service(*, force_refresh: bool = False) -> OSSServiceBase:
    """
    获取 OSS 服务实例（带缓存）。

    在 TTL 有效期内返回缓存实例；过期或首次调用时创建新实例。
    ``force_refresh=True`` 可强制刷新缓存（用于配置变更场景）。
    """
    global _oss_service_cache, _cache_expires_at

    now = time.monotonic()
    if not force_refresh and _oss_service_cache is not None and now < _cache_expires_at:
        return _oss_service_cache

    with _cache_lock:
        # Double-check after acquiring lock
        if not force_refresh and _oss_service_cache is not None and now < _cache_expires_at:
            return _oss_service_cache

        service = _create_oss_service()
        _oss_service_cache = service
        _cache_expires_at = time.monotonic() + _CACHE_TTL
        return service


def get_updater_oss_service(*, force_refresh: bool = False) -> OSSServiceBase:
    """获取桌面更新专用 OSS 服务实例。

    Updater 默认回退到通用 OSS 配置；配置 ``UPDATER_OSS_*`` 后使用独立桶/CDN。
    """
    global _updater_oss_service_cache, _updater_cache_expires_at

    now = time.monotonic()
    if not force_refresh and _updater_oss_service_cache is not None and now < _updater_cache_expires_at:
        return _updater_oss_service_cache

    with _updater_cache_lock:
        if not force_refresh and _updater_oss_service_cache is not None and now < _updater_cache_expires_at:
            return _updater_oss_service_cache

        service = _create_oss_service(config_kind="updater")
        _updater_oss_service_cache = service
        _updater_cache_expires_at = time.monotonic() + _CACHE_TTL
        return service


def _create_oss_service(*, config_kind: str = "default") -> OSSServiceBase:
    """根据配置创建新的 OSS 服务实例。"""
    provider = getattr(settings, 'SERVICES_OSS_PROVIDER', 'aliyun').lower()

    if provider == 'aliyun':
        config = _get_aliyun_config(config_kind=config_kind)
        logger.info(
            "创建阿里云OSS服务实例: kind=%s bucket=%s region=%s",
            config_kind, config.get('bucket_name'), config.get('region'),
        )
        return AliyunOSSService(config)

    if provider == 'local':
        if config_kind == "updater":
            raise ConfigurationException("桌面更新包不支持 local OSS provider")
        config = _get_local_config()
        logger.info("创建本地 OSS 服务实例: root=%s", config.get('root_path'))
        return LocalFileOSSService(config)

    raise ConfigurationException(f"不支持的OSS服务提供商: {provider}")


def _get_local_config() -> Dict[str, Any]:
    """获取本地文件系统 OSS 配置。"""
    config = {
        'bucket_name': getattr(settings, 'LOCAL_OSS_BUCKET_NAME', 'tabtin-local-dev'),
        'root_path': getattr(settings, 'LOCAL_OSS_ROOT', None),
        'public_base_url': getattr(settings, 'LOCAL_OSS_PUBLIC_BASE_URL', ''),
        'upload_base_url': getattr(settings, 'LOCAL_OSS_UPLOAD_BASE_URL', ''),
        'access_mode': 'public-read',
        'max_file_size': getattr(settings, 'OSS_MAX_FILE_SIZE', 200 * 1024 * 1024),
    }
    _validate_local_config(config)
    return config


def _validate_local_config(config: Dict[str, Any]) -> None:
    if not config.get('root_path'):
        raise ConfigurationException("本地 OSS 根目录(LOCAL_OSS_ROOT)未配置")
    if not config.get('public_base_url'):
        raise ConfigurationException("本地 OSS 访问端点(LOCAL_OSS_PUBLIC_BASE_URL)未配置")
    if not config.get('upload_base_url'):
        raise ConfigurationException("本地 OSS 上传端点(LOCAL_OSS_UPLOAD_BASE_URL)未配置")

    expected_paths = {
        'public_base_url': '/api/services/oss/local-object',
        'upload_base_url': '/api/services/oss/local-upload',
    }
    origins = set()
    for key, expected_path in expected_paths.items():
        parsed = urlparse(str(config[key]))
        if (
            parsed.scheme not in {'http', 'https'}
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or parsed.path != expected_path
        ):
            raise ConfigurationException(f"本地 OSS {key} 必须是公开 API origin 下的精确端点")
        origins.add((parsed.scheme, parsed.netloc.lower()))

        if not settings.DEBUG and parsed.hostname.lower() in {
            'localhost', '127.0.0.1', '::1', '0.0.0.0', 'django', 'caddy',
        }:
            raise ConfigurationException(
                "生产 local OSS 必须配置客户端可达的 TABTIN_PUBLIC_BASE_URL"
            )

    if len(origins) != 1:
        raise ConfigurationException("本地 OSS 上传和下载端点必须使用同一公开 origin")


def _get_aliyun_config(*, config_kind: str = "default") -> Dict[str, Any]:
    """
    获取阿里云OSS服务配置

    Returns:
        Dict: 阿里云配置

    Raises:
        ConfigurationException: 当配置缺失时
    """
    prefix = 'UPDATER_' if config_kind == 'updater' else ''
    config = {
        'bucket_name': getattr(settings, f'{prefix}OSS_BUCKET_NAME' if prefix else 'ALIYUN_OSS_BUCKET_NAME', None),
        'endpoint': getattr(settings, f'{prefix}OSS_ENDPOINT' if prefix else 'ALIYUN_OSS_ENDPOINT', None),
        'internal_endpoint': getattr(settings, f'{prefix}OSS_INTERNAL_ENDPOINT' if prefix else 'ALIYUN_OSS_INTERNAL_ENDPOINT', None),
        'region': getattr(settings, f'{prefix}OSS_REGION' if prefix else 'ALIYUN_OSS_REGION', None),
        'access_mode': getattr(settings, f'{prefix}OSS_ACCESS_MODE' if prefix else 'ALIYUN_OSS_ACCESS_MODE', 'private'),
        'cdn_domain': getattr(settings, f'{prefix}OSS_CDN_DOMAIN' if prefix else 'ALIYUN_OSS_CDN_DOMAIN', ''),
        'access_key_id': getattr(settings, f'{prefix}ALIYUN_ACCESS_KEY_ID' if prefix else 'ALIYUN_ACCESS_KEY_ID', None),
        'access_key_secret': getattr(settings, f'{prefix}ALIYUN_ACCESS_KEY_SECRET' if prefix else 'ALIYUN_ACCESS_KEY_SECRET', None),
        'security_token': getattr(settings, f'{prefix}ALIYUN_SECURITY_TOKEN' if prefix else 'ALIYUN_SECURITY_TOKEN', None),
    }

    # 验证必需配置
    _validate_aliyun_config(config)

    return config


def _validate_aliyun_config(config: Dict[str, Any]) -> None:
    """
    验证阿里云OSS配置

    Args:
        config: 配置字典

    Raises:
        ConfigurationException: 当配置无效时
    """
    # 基础配置验证
    if not config.get('bucket_name'):
        raise ConfigurationException("阿里云OSS存储桶名称(ALIYUN_OSS_BUCKET_NAME)未配置")

    if not config.get('endpoint'):
        raise ConfigurationException("阿里云OSS访问端点(ALIYUN_OSS_ENDPOINT)未配置")

    if not config.get('region'):
        raise ConfigurationException("阿里云OSS地域(ALIYUN_OSS_REGION)未配置")

    # 验证访问模式
    valid_access_modes = ['private', 'public-read', 'public-read-write']
    if config.get('access_mode') not in valid_access_modes:
        logger.warning(f"无效的访问模式: {config.get('access_mode')}，使用默认值 private")
        config['access_mode'] = 'private'

    # 验证访问密钥（在ECS环境中可选）
    if not config.get('access_key_id') and not config.get('security_token'):
        logger.info("未配置阿里云访问密钥，将尝试使用ECS RAM角色")


def get_available_providers() -> list:
    """
    获取可用的OSS服务提供商列表

    Returns:
        list: 提供商列表
    """
    return ['aliyun', 'local']


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
            service = AliyunOSSService(config)
            return service.validate_config()
        elif provider.lower() == 'local':
            config = _get_local_config()
            service = LocalFileOSSService(config)
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
            'name': '阿里云对象存储OSS',
            'description': '阿里云对象存储服务，提供海量、安全、低成本、高可靠的云存储服务',
            'features': [
                '文件上传下载',
                '批量操作',
                '分片上传',
                '预签名URL',
                'CDN加速',
                '图片处理',
                '生命周期管理',
                '访问控制'
            ],
            'regions': [
                'oss-cn-hangzhou',
                'oss-cn-shanghai',
                'oss-cn-beijing',
                'oss-cn-shenzhen',
                'oss-cn-wuhan-lr'
            ],
            'storage_classes': ['Standard', 'IA', 'Archive', 'ColdArchive'],
            'max_file_size': '48.8TB',
            'max_bucket_count': 100
        },
        'local': {
            'name': '本地文件系统存储',
            'description': '单服务器部署 OSS provider，文件写入 LOCAL_OSS_ROOT 持久卷',
            'features': [
                '文件上传下载',
                '批量操作',
                '预签名直传兼容',
                '本地 HTTP 访问',
            ],
            'regions': ['local'],
            'storage_classes': ['Local'],
            'max_file_size': f"{getattr(settings, 'OSS_MAX_FILE_SIZE', 209715200) // (1024 * 1024)}MB",
            'max_bucket_count': 1,
        }
    }

    return providers_info.get(provider.lower(), {})


def get_default_config() -> Dict[str, Any]:
    """
    获取默认OSS配置

    Returns:
        Dict: 默认配置
    """
    return {
        'provider': 'local',
        'bucket_name': 'example-assets',
        'region': 'oss-cn-wuhan-lr',
        'endpoint': 'oss-cn-wuhan-lr.aliyuncs.com',
        'internal_endpoint': 'oss-cn-wuhan-lr-internal.aliyuncs.com',
        'access_mode': 'public-read',
        'cdn_domain': '',
        'max_file_size': getattr(settings, 'OSS_MAX_FILE_SIZE', 104857600),
        'allowed_extensions': ['jpg', 'jpeg', 'png', 'gif', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'txt', 'zip'],
        'chunk_size': 5242880,  # 5MB
        'max_chunks': 1000
    }
