"""
Services模块公共组件

提供以下功能：
- 异常处理
- 工具函数
- 验证器
- 缓存管理
- 配置管理
- 中间件
- 常量定义
"""

from .exceptions import (
    ServicesBaseException,
    SmsServiceException,
    EmailServiceException,
    OSSServiceException,
    ConfigurationException,
    ValidationException,
    NetworkException,
    RateLimitException,
    AuthenticationException,
)

from .utils import (
    validate_phone_number,
    validate_email,
    generate_verification_code,
    generate_request_id,
    mask_phone_number,
    mask_email,
    calculate_retry_delay,
    sanitize_log_data,
    format_template_params,
    is_rate_limited,
    hash_data,
    get_file_type_from_extension,
)

from .validators import (
    PhoneNumberValidator,
    EmailValidator,
    VerificationCodeValidator,
    SmsContentValidator,
    EmailContentValidator,
    TemplateParamsValidator,
    ConfigValidator,
    validate_sms_request,
    validate_email_request,
    validate_batch_recipients,
    validate_template_format,
)

from .cache import (
    CacheManager,
    cache_manager,
    cache_verification_code,
    get_verification_code,
    verify_code,
    cache_file_info,
    get_cached_file_info,
    cache_config,
    get_cached_config,
    clear_service_cache,
)

from .config import (
    ConfigManager,
    config_manager,
    sms_config,
    email_config,
    oss_config,
    get_service_config,
    validate_service_config,
    get_error_message,
    is_production,
    is_development,
    get_environment,
)

from .constants import (
    SERVICE_TYPES,
    ERROR_CODES,
    REGEX_PATTERNS,
    FILE_TYPE_MAPPING,
    DEFAULT_CONFIG,
    SENSITIVE_WORDS,
    HTTP_STATUS_MAPPING,
    LOG_LEVELS,
    TIME_FORMATS,
    SERVICE_STATUS,
    TASK_STATUS,
    PRIORITY_LEVELS,
    CACHE_KEY_TEMPLATES,
    API_VERSIONS,
    ENVIRONMENTS,
    ENCODINGS,
    HASH_ALGORITHMS,
)

from .middleware import (
    RequestLoggingMiddleware,
    RateLimitMiddleware,
    CORSMiddleware,
    SecurityHeadersMiddleware,
    HealthCheckMiddleware,
    RequestContextMiddleware,
    get_request_id,
    log_api_call,
)

__version__ = '1.0.0'
__author__ = 'Tabtin Team'

__all__ = [
    # 异常类
    'ServicesBaseException',
    'SmsServiceException',
    'EmailServiceException',
    'OSSServiceException',
    'ConfigurationException',
    'ValidationException',
    'NetworkException',
    'RateLimitException',
    'AuthenticationException',

    # 工具函数
    'validate_phone_number',
    'validate_email',
    'generate_verification_code',
    'generate_request_id',
    'mask_phone_number',
    'mask_email',
    'calculate_retry_delay',
    'sanitize_log_data',
    'format_template_params',
    'is_rate_limited',
    'hash_data',
    'get_file_type_from_extension',

    # 验证器
    'PhoneNumberValidator',
    'EmailValidator',
    'VerificationCodeValidator',
    'SmsContentValidator',
    'EmailContentValidator',
    'TemplateParamsValidator',
    'ConfigValidator',
    'validate_sms_request',
    'validate_email_request',
    'validate_batch_recipients',
    'validate_template_format',

    # 缓存管理
    'CacheManager',
    'cache_manager',
    'cache_verification_code',
    'get_verification_code',
    'verify_code',
    'cache_file_info',
    'get_cached_file_info',
    'cache_config',
    'get_cached_config',
    'clear_service_cache',

    # 配置管理
    'ConfigManager',
    'config_manager',
    'sms_config',
    'email_config',
    'oss_config',
    'get_service_config',
    'validate_service_config',
    'get_error_message',
    'is_production',
    'is_development',
    'get_environment',

    # 常量
    'SERVICE_TYPES',
    'ERROR_CODES',
    'REGEX_PATTERNS',
    'FILE_TYPE_MAPPING',
    'DEFAULT_CONFIG',
    'SENSITIVE_WORDS',
    'HTTP_STATUS_MAPPING',
    'LOG_LEVELS',
    'TIME_FORMATS',
    'SERVICE_STATUS',
    'TASK_STATUS',
    'PRIORITY_LEVELS',
    'CACHE_KEY_TEMPLATES',
    'API_VERSIONS',
    'ENVIRONMENTS',
    'ENCODINGS',
    'HASH_ALGORITHMS',

    # 中间件
    'RequestLoggingMiddleware',
    'RateLimitMiddleware',
    'CORSMiddleware',
    'SecurityHeadersMiddleware',
    'HealthCheckMiddleware',
    'RequestContextMiddleware',
    'get_request_id',
    'log_api_call',
]
