"""
Services模块缓存工具
"""

import json
import time
import hashlib
from typing import Any, Optional, Dict, List, Union
from django.core.cache import cache
from django.conf import settings
import logging

from .constants import DEFAULT_CONFIG, CACHE_KEY_TEMPLATES

logger = logging.getLogger(__name__)


class CacheManager:
    """缓存管理器"""

    def __init__(self, prefix: str = None, default_timeout: int = None):
        """
        初始化缓存管理器

        Args:
            prefix: 缓存键前缀
            default_timeout: 默认超时时间（秒）
        """
        self.prefix = prefix or DEFAULT_CONFIG['CACHE_KEY_PREFIX']
        self.default_timeout = default_timeout or DEFAULT_CONFIG['CACHE_DEFAULT_TIMEOUT']

    def _make_key(self, key: str) -> str:
        """生成完整的缓存键"""
        return f"{self.prefix}{key}"

    def get(self, key: str, default: Any = None) -> Any:
        """
        获取缓存值

        Args:
            key: 缓存键
            default: 默认值

        Returns:
            Any: 缓存值或默认值
        """
        try:
            full_key = self._make_key(key)
            value = cache.get(full_key, default)
            logger.debug(f"缓存获取: {full_key} -> {'命中' if value != default else '未命中'}")
            return value
        except Exception as e:
            logger.error(f"缓存获取失败: {key} - {e}")
            return default

    def set(self, key: str, value: Any, timeout: int = None) -> bool:
        """
        设置缓存值

        Args:
            key: 缓存键
            value: 缓存值
            timeout: 超时时间（秒）

        Returns:
            bool: 是否设置成功
        """
        try:
            full_key = self._make_key(key)
            timeout = timeout or self.default_timeout
            cache.set(full_key, value, timeout)
            logger.debug(f"缓存设置: {full_key} (超时: {timeout}秒)")
            return True
        except Exception as e:
            logger.error(f"缓存设置失败: {key} - {e}")
            return False

    def delete(self, key: str) -> bool:
        """
        删除缓存

        Args:
            key: 缓存键

        Returns:
            bool: 是否删除成功
        """
        try:
            full_key = self._make_key(key)
            cache.delete(full_key)
            logger.debug(f"缓存删除: {full_key}")
            return True
        except Exception as e:
            logger.error(f"缓存删除失败: {key} - {e}")
            return False

    def get_or_set(self, key: str, callable_func, timeout: int = None) -> Any:
        """
        获取缓存值，如果不存在则调用函数设置

        Args:
            key: 缓存键
            callable_func: 可调用函数
            timeout: 超时时间（秒）

        Returns:
            Any: 缓存值或函数返回值
        """
        try:
            full_key = self._make_key(key)
            timeout = timeout or self.default_timeout

            value = cache.get(full_key)
            if value is not None:
                logger.debug(f"缓存命中: {full_key}")
                return value

            # 缓存未命中，调用函数获取值
            value = callable_func()
            cache.set(full_key, value, timeout)
            logger.debug(f"缓存设置: {full_key} (通过函数)")
            return value
        except Exception as e:
            logger.error(f"缓存获取或设置失败: {key} - {e}")
            return callable_func()

    def add(self, key: str, value: Any, timeout: int = None) -> bool:
        """
        仅在 key 不存在时设置缓存值（原子操作）。

        Returns:
            bool: True 表示写入成功（key 之前不存在），False 表示 key 已存在。
        """
        try:
            full_key = self._make_key(key)
            timeout = timeout or self.default_timeout
            return cache.add(full_key, value, timeout)
        except Exception as e:
            logger.error(f"缓存 add 失败: {key} - {e}")
            return False

    def increment(self, key: str, delta: int = 1, timeout: int = None) -> int:
        """
        原子递增缓存值（委托给 Redis INCR）。

        Args:
            timeout: 当 key 不存在需要兜底 set 时使用的过期时间。

        Returns:
            int: 递增后的值
        """
        try:
            full_key = self._make_key(key)
            return cache.incr(full_key, delta)
        except ValueError:
            cache.set(full_key, delta, timeout or self.default_timeout)
            return delta
        except Exception as e:
            logger.error(f"缓存递增失败: {key} - {e}")
            return delta

    def clear_pattern(self, pattern: str) -> int:
        """
        清除匹配模式的缓存

        Args:
            pattern: 模式字符串

        Returns:
            int: 清除的缓存数量
        """
        try:
            # 注意：这个功能依赖于缓存后端的支持
            # Django的默认缓存后端不支持模式匹配
            # 这里提供一个基础实现
            logger.warning(f"模式清除功能需要Redis等支持模式匹配的缓存后端: {pattern}")
            return 0
        except Exception as e:
            logger.error(f"缓存模式清除失败: {pattern} - {e}")
            return 0


# 全局缓存管理器实例
cache_manager = CacheManager()


def get_cache_key(template: str, **kwargs) -> str:
    """
    根据模板生成缓存键

    Args:
        template: 缓存键模板
        **kwargs: 模板参数

    Returns:
        str: 生成的缓存键
    """
    try:
        return template.format(**kwargs)
    except KeyError as e:
        logger.error(f"缓存键模板参数缺失: {e}")
        return template


def cache_verification_code(phone_or_email: str, code: str, code_type: str = 'sms',
                          expire_time: int = None) -> bool:
    """
    缓存验证码

    Args:
        phone_or_email: 手机号或邮箱
        code: 验证码
        code_type: 验证码类型 ('sms' 或 'email')
        expire_time: 过期时间（秒）

    Returns:
        bool: 是否缓存成功
    """
    try:
        expire_time = expire_time or DEFAULT_CONFIG['VERIFICATION_CODE_EXPIRE']

        if code_type == 'sms':
            key = get_cache_key(CACHE_KEY_TEMPLATES['SMS_CODE'], phone=phone_or_email)
        else:
            key = get_cache_key(CACHE_KEY_TEMPLATES['EMAIL_CODE'], email=phone_or_email)

        cache_data = {
            'code': code,
            'created_at': int(time.time()),
            'expire_at': int(time.time()) + expire_time
        }

        return cache_manager.set(key, cache_data, expire_time)
    except Exception as e:
        logger.error(f"验证码缓存失败: {phone_or_email} - {e}")
        return False


def get_verification_code(phone_or_email: str, code_type: str = 'sms') -> Optional[Dict]:
    """
    获取验证码

    Args:
        phone_or_email: 手机号或邮箱
        code_type: 验证码类型 ('sms' 或 'email')

    Returns:
        Optional[Dict]: 验证码信息或None
    """
    try:
        if code_type == 'sms':
            key = get_cache_key(CACHE_KEY_TEMPLATES['SMS_CODE'], phone=phone_or_email)
        else:
            key = get_cache_key(CACHE_KEY_TEMPLATES['EMAIL_CODE'], email=phone_or_email)

        cache_data = cache_manager.get(key)
        if cache_data and isinstance(cache_data, dict):
            # 检查是否过期
            if cache_data.get('expire_at', 0) > int(time.time()):
                return cache_data
            else:
                # 已过期，删除缓存
                cache_manager.delete(key)

        return None
    except Exception as e:
        logger.error(f"验证码获取失败: {phone_or_email} - {e}")
        return None


def verify_code(phone_or_email: str, input_code: str, code_type: str = 'sms',
               delete_after_verify: bool = True) -> bool:
    """
    验证验证码

    Args:
        phone_or_email: 手机号或邮箱
        input_code: 输入的验证码
        code_type: 验证码类型 ('sms' 或 'email')
        delete_after_verify: 验证后是否删除缓存

    Returns:
        bool: 验证是否成功
    """
    try:
        cache_data = get_verification_code(phone_or_email, code_type)
        if not cache_data:
            return False

        import hmac
        stored_code = cache_data.get('code', '')
        is_valid = hmac.compare_digest(str(stored_code), str(input_code))

        if is_valid and delete_after_verify:
            # 验证成功后删除缓存
            if code_type == 'sms':
                key = get_cache_key(CACHE_KEY_TEMPLATES['SMS_CODE'], phone=phone_or_email)
            else:
                key = get_cache_key(CACHE_KEY_TEMPLATES['EMAIL_CODE'], email=phone_or_email)
            cache_manager.delete(key)

        return is_valid
    except Exception as e:
        logger.error(f"验证码验证失败: {phone_or_email} - {e}")
        return False


_RATE_LIMIT_LUA = """
local key     = KEYS[1]
local limit   = tonumber(ARGV[1])
local window  = tonumber(ARGV[2])

local current = redis.call('INCR', key)
if current == 1 then
    redis.call('EXPIRE', key, window)
end

local ttl = redis.call('TTL', key)
if ttl < 0 then
    redis.call('EXPIRE', key, window)
    ttl = window
end

if current > limit then
    return { 1, current, ttl }
end
return { 0, current, ttl }
"""

_lua_sha: str | None = None


def _get_redis_connection():
    """获取原生 Redis 连接（仅限 django-redis 后端）。"""
    try:
        from django_redis import get_redis_connection
        return get_redis_connection("default")
    except Exception:
        return None


def is_rate_limited(service: str, key: str, limit: int, window: int) -> tuple[bool, int, int]:
    """
    检查是否触发频率限制。

    优先使用 Redis Lua 脚本（单次 RTT，严格原子），
    回退到 Django cache get→incr（best-effort）。

    Returns:
        (is_limited, current_count, ttl_seconds)
    """
    full_key = get_cache_key(CACHE_KEY_TEMPLATES['RATE_LIMIT'], service=service, key=key)
    prefixed_key = cache_manager._make_key(full_key)

    # ── 优先 Lua 原子路径 ──
    redis_conn = _get_redis_connection()
    if redis_conn is not None:
        try:
            global _lua_sha
            if _lua_sha is None:
                _lua_sha = redis_conn.script_load(_RATE_LIMIT_LUA)
            result = redis_conn.evalsha(_lua_sha, 1, prefixed_key, limit, window)
            is_limited, current, ttl = int(result[0]), int(result[1]), int(result[2])
            if is_limited:
                logger.warning("频率限制触发: %s:%s - %d/%d", service, key, current, limit)
            return bool(is_limited), current, max(ttl, 0)
        except Exception as e:
            logger.debug("Lua 限流回退到 Django cache: %s", e)
            _lua_sha = None

    # ── 回退路径：Django cache ──
    try:
        current_count = cache_manager.get(full_key, 0)
        if current_count >= limit:
            logger.warning("频率限制触发: %s:%s - %d/%d", service, key, current_count, limit)
            return True, current_count, window

        cache_manager.add(full_key, 0, window)
        try:
            new_count = cache_manager.increment(full_key, 1, timeout=window)
        except ValueError:
            cache_manager.set(full_key, 1, window)
            new_count = 1

        return False, new_count, window
    except Exception as e:
        logger.error("频率限制检查失败（fail-closed）: %s:%s - %s", service, key, e)
        return True, 0, window


def cache_file_info(file_id: str, file_info: Dict, timeout: int = None) -> bool:
    """
    缓存文件信息

    Args:
        file_id: 文件ID
        file_info: 文件信息
        timeout: 超时时间（秒）

    Returns:
        bool: 是否缓存成功
    """
    try:
        key = get_cache_key(CACHE_KEY_TEMPLATES['FILE_INFO'], file_id=file_id)
        timeout = timeout or DEFAULT_CONFIG['CACHE_DEFAULT_TIMEOUT']
        return cache_manager.set(key, file_info, timeout)
    except Exception as e:
        logger.error(f"文件信息缓存失败: {file_id} - {e}")
        return False


def get_cached_file_info(file_id: str) -> Optional[Dict]:
    """
    获取缓存的文件信息

    Args:
        file_id: 文件ID

    Returns:
        Optional[Dict]: 文件信息或None
    """
    try:
        key = get_cache_key(CACHE_KEY_TEMPLATES['FILE_INFO'], file_id=file_id)
        return cache_manager.get(key)
    except Exception as e:
        logger.error(f"文件信息获取失败: {file_id} - {e}")
        return None


def cache_config(service: str, config_key: str, config_value: Any, timeout: int = None) -> bool:
    """
    缓存配置信息

    Args:
        service: 服务名称
        config_key: 配置键
        config_value: 配置值
        timeout: 超时时间（秒）

    Returns:
        bool: 是否缓存成功
    """
    try:
        key = get_cache_key(CACHE_KEY_TEMPLATES['CONFIG'], service=service, key=config_key)
        timeout = timeout or DEFAULT_CONFIG['CACHE_DEFAULT_TIMEOUT'] * 24  # 配置缓存更长时间
        return cache_manager.set(key, config_value, timeout)
    except Exception as e:
        logger.error(f"配置缓存失败: {service}:{config_key} - {e}")
        return False


def get_cached_config(service: str, config_key: str, default: Any = None) -> Any:
    """
    获取缓存的配置信息

    Args:
        service: 服务名称
        config_key: 配置键
        default: 默认值

    Returns:
        Any: 配置值或默认值
    """
    try:
        key = get_cache_key(CACHE_KEY_TEMPLATES['CONFIG'], service=service, key=config_key)
        return cache_manager.get(key, default)
    except Exception as e:
        logger.error(f"配置获取失败: {service}:{config_key} - {e}")
        return default


def clear_service_cache(service: str) -> bool:
    """
    清除服务相关的所有缓存

    Args:
        service: 服务名称

    Returns:
        bool: 是否清除成功
    """
    try:
        # 这里需要根据实际的缓存后端实现
        # 目前只是记录日志
        logger.info(f"清除服务缓存: {service}")
        return True
    except Exception as e:
        logger.error(f"服务缓存清除失败: {service} - {e}")
        return False
