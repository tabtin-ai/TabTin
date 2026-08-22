"""
Services模块工具函数
"""

import re
import random
import string
import hashlib
from typing import Optional, Dict, Any
from datetime import datetime, timedelta
import logging

logger = logging.getLogger(__name__)


def validate_phone_number(phone: str) -> bool:
    """
    验证手机号码格式

    Args:
        phone: 手机号码

    Returns:
        bool: 是否为有效手机号
    """
    if not phone:
        return False

    from apps.services.common.constants import REGEX_PATTERNS
    return bool(re.match(REGEX_PATTERNS['PHONE'], phone))


def validate_email(email: str) -> bool:
    """
    验证邮箱地址格式

    Args:
        email: 邮箱地址

    Returns:
        bool: 是否为有效邮箱
    """
    if not email:
        return False

    # 邮箱正则表达式
    pattern = r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$'
    return bool(re.match(pattern, email))


def generate_verification_code(length: int = 6) -> str:
    """
    生成验证码

    Args:
        length: 验证码长度，默认6位

    Returns:
        str: 生成的验证码
    """
    return ''.join(random.choices(string.digits, k=length))


def generate_request_id() -> str:
    """
    生成请求ID

    Returns:
        str: 唯一请求ID
    """
    timestamp = datetime.now().strftime('%Y%m%d%H%M%S')
    random_str = ''.join(random.choices(string.ascii_lowercase + string.digits, k=8))
    return f"{timestamp}_{random_str}"


def mask_phone_number(phone: str) -> str:
    """
    手机号脱敏处理

    Args:
        phone: 手机号码

    Returns:
        str: 脱敏后的手机号
    """
    if not phone or len(phone) < 7:
        return phone

    return f"{phone[:3]}****{phone[-4:]}"


def mask_email(email: str) -> str:
    """
    邮箱地址脱敏处理

    Args:
        email: 邮箱地址

    Returns:
        str: 脱敏后的邮箱
    """
    if not email or '@' not in email:
        return email

    local, domain = email.split('@', 1)
    if len(local) <= 2:
        masked_local = local
    else:
        masked_local = f"{local[0]}***{local[-1]}"

    return f"{masked_local}@{domain}"


def calculate_retry_delay(attempt: int, base_delay: float = 1.0, max_delay: float = 60.0) -> float:
    """
    计算重试延迟时间（指数退避算法）

    Args:
        attempt: 重试次数
        base_delay: 基础延迟时间（秒）
        max_delay: 最大延迟时间（秒）

    Returns:
        float: 延迟时间（秒）
    """
    delay = base_delay * (2 ** attempt)
    return min(delay, max_delay)


def sanitize_log_data(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    清理日志数据，移除敏感信息

    Args:
        data: 原始数据

    Returns:
        Dict: 清理后的数据
    """
    sensitive_keys = ['password', 'token', 'secret', 'key', 'credential']
    sanitized = {}

    for key, value in data.items():
        if any(sensitive in key.lower() for sensitive in sensitive_keys):
            sanitized[key] = '***'
        elif isinstance(value, dict):
            sanitized[key] = sanitize_log_data(value)
        else:
            sanitized[key] = value

    return sanitized


def format_template_params(template: str, **params) -> str:
    """
    格式化模板参数

    Args:
        template: 模板字符串
        **params: 参数字典

    Returns:
        str: 格式化后的字符串
    """
    try:
        return template.format(**params)
    except KeyError as e:
        logger.error(f"模板参数缺失: {e}")
        raise ValueError(f"模板参数缺失: {e}")


def is_rate_limited(key: str, limit: int, window: int, cache_backend=None) -> bool:
    """
    检查是否触发频率限制。

    Args:
        key: 限制键
        limit: 限制次数
        window: 时间窗口（秒）
        cache_backend: 缓存后端（保留向后兼容，未使用）

    Returns:
        bool: 是否被限制
    """
    try:
        from .cache import is_rate_limited as cache_rate_limit
        limited, _count, _ttl = cache_rate_limit('common', key, limit, window)
        return limited
    except ImportError:
        logger.warning("缓存模块不可用，频率限制功能禁用")
        return False


def hash_data(data: str, algorithm: str = 'sha256') -> str:
    """
    数据哈希

    Args:
        data: 要哈希的数据
        algorithm: 哈希算法

    Returns:
        str: 哈希值
    """
    hash_func = getattr(hashlib, algorithm)
    return hash_func(data.encode('utf-8')).hexdigest()


def get_file_type_from_extension(extension: str) -> str:
    """
    根据文件扩展名获取文件类型

    Args:
        extension: 文件扩展名（不含点）

    Returns:
        str: 文件类型
    """
    extension = extension.lower().lstrip('.')

    # 图片类型
    image_extensions = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico', 'tiff']
    if extension in image_extensions:
        return 'image'

    # 文档类型
    document_extensions = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'odt', 'ods', 'odp']
    if extension in document_extensions:
        return 'document'

    # 视频类型
    video_extensions = ['mp4', 'avi', 'mov', 'wmv', 'flv', 'webm', 'mkv', '3gp', 'rm', 'rmvb']
    if extension in video_extensions:
        return 'video'

    # 音频类型
    audio_extensions = ['mp3', 'wav', 'flac', 'aac', 'ogg', 'wma', 'm4a', 'opus']
    if extension in audio_extensions:
        return 'audio'

    # 压缩包类型
    archive_extensions = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'z']
    if extension in archive_extensions:
        return 'archive'

    # 其他类型
    return 'other'
