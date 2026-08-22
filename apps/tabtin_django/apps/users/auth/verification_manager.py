"""
统一的验证码管理器
解决验证码生成、缓存、验证的一致性问题
"""

import hmac
import os
import secrets
import string
import logging
from typing import Optional, Tuple
from django.core.cache import cache
from django_redis import get_redis_connection
from django.conf import settings

from .utils import check_rate_limit, mask_identifier as _mask_identifier

logger = logging.getLogger(__name__)


class VerificationCodeManager:
    """统一的验证码管理器"""

    COMMUNITY_FIXED_CODE_TYPES = frozenset({'register', 'login'})
    DEFAULT_COMMUNITY_FIXED_CODE = '888888'

    # 验证码类型配置
    CODE_TYPES = {
        'register': {'expire_minutes': 10, 'length': 6},
        'login': {'expire_minutes': 5, 'length': 6},
        'reset_password': {'expire_minutes': 10, 'length': 6},
        'phone_reservation': {'expire_minutes': 5, 'length': 6},
        'verify_email': {'expire_minutes': 10, 'length': 6},
        'verify_phone': {'expire_minutes': 10, 'length': 6},
        'bind_email': {'expire_minutes': 10, 'length': 6},
        'create_api_key': {'expire_minutes': 5, 'length': 6},
        'change_password': {'expire_minutes': 5, 'length': 6},
    }

    @staticmethod
    def get_community_fixed_code(identifier: str, code_type: str) -> str:
        """返回 Community 手机注册/登录固定码；其他场景不启用。"""
        if (
            getattr(settings, 'TABTIN_EDITION', 'saas') != 'community'
            or '@' in identifier
            or code_type not in VerificationCodeManager.COMMUNITY_FIXED_CODE_TYPES
        ):
            return ''
        return (
            getattr(settings, 'AUTH_FIXED_VERIFICATION_CODE', '').strip()
            or VerificationCodeManager.DEFAULT_COMMUNITY_FIXED_CODE
        )

    @staticmethod
    def generate_code(code_type: str = 'login') -> str:
        """
        生成验证码

        Args:
            code_type: 验证码类型

        Returns:
            str: 生成的验证码
        """
        config = VerificationCodeManager.CODE_TYPES.get(code_type, {'length': 6})
        length = config['length']

        # 生成纯数字验证码
        return ''.join(secrets.choice(string.digits) for _ in range(length))

    @staticmethod
    def cache_code(
        identifier: str,
        code: str,
        code_type: str = 'login',
        challenge_key: Optional[str] = None,
    ) -> bool:
        """
        缓存验证码

        Args:
            identifier: 标识符（邮箱或手机号）
            code: 验证码
            code_type: 验证码类型

        Returns:
            bool: 是否缓存成功
        """
        try:
            config = VerificationCodeManager.CODE_TYPES.get(code_type, {'expire_minutes': 5})
            expire_minutes = config['expire_minutes']

            # 使用统一的缓存键格式
            cache_key = VerificationCodeManager._get_cache_key(identifier, code_type, challenge_key)
            ttl_seconds = expire_minutes * 60

            # 优先使用Redis
            try:
                conn = get_redis_connection("default")
                conn.setex(cache_key, ttl_seconds, code)
                logger.info("验证码已缓存到Redis: code_type=%s, identifier=%s, ttl=%ds",
                            code_type, _mask_identifier(identifier), ttl_seconds)
                return True
            except Exception as redis_error:
                logger.warning("Redis缓存失败，使用Django cache: %s", redis_error)
                cache.set(cache_key, code, ttl_seconds)
                logger.info("验证码已缓存到Django cache: code_type=%s, identifier=%s, ttl=%ds",
                            code_type, _mask_identifier(identifier), ttl_seconds)
                return True

        except Exception as e:
            logger.error("验证码缓存失败: identifier=%s, error=%s", _mask_identifier(identifier), e)
            return False

    @staticmethod
    def get_code(
        identifier: str,
        code_type: str = 'login',
        challenge_key: Optional[str] = None,
    ) -> Optional[str]:
        """
        获取缓存的验证码

        Args:
            identifier: 标识符（邮箱或手机号）
            code_type: 验证码类型

        Returns:
            Optional[str]: 验证码或None
        """
        try:
            cache_key = VerificationCodeManager._get_cache_key(identifier, code_type, challenge_key)

            # 优先从Redis获取
            try:
                conn = get_redis_connection("default")
                cached_code = conn.get(cache_key)
                if cached_code:
                    return cached_code.decode() if isinstance(cached_code, bytes) else cached_code
            except Exception as redis_error:
                logger.warning("Redis获取失败，使用Django cache: %s", redis_error)

            # 降级到Django cache
            cached_code = cache.get(cache_key)
            return cached_code

        except Exception as e:
            logger.error("获取验证码失败: identifier=%s, error=%s", _mask_identifier(identifier), e)
            return None

    MAX_VERIFY_ATTEMPTS = 5

    @staticmethod
    def verify_code(
        identifier: str,
        input_code: str,
        code_type: str = 'login',
        delete_after_verify: bool = True,
        challenge_key: Optional[str] = None,
    ) -> bool:
        """
        验证验证码

        Args:
            identifier: 标识符（邮箱或手机号）
            input_code: 输入的验证码
            code_type: 验证码类型
            delete_after_verify: 验证后是否删除

        Returns:
            bool: 验证是否成功
        """
        try:
            # 测试环境旁路：DEBUG + TESTING + 非生产环境 三重守护
            bypass_code = os.environ.get('TEST_BYPASS_VERIFICATION_CODE')
            is_test_env = (
                settings.DEBUG
                and getattr(settings, 'TESTING', False)
                and os.environ.get('ENVIRONMENT') != 'production'
            )
            if (bypass_code
                    and is_test_env
                    and hmac.compare_digest(input_code, bypass_code)):
                logger.info("[TEST] 测试旁路验证码通过: identifier=%s, code_type=%s", _mask_identifier(identifier), code_type)
                return True

            # CA-3: 检查尝试次数是否已超限
            attempt_key = VerificationCodeManager._get_attempts_cache_key(
                identifier, code_type, challenge_key
            )
            attempts = cache.get(attempt_key, 0)
            if attempts >= VerificationCodeManager.MAX_VERIFY_ATTEMPTS:
                VerificationCodeManager.delete_code(identifier, code_type, challenge_key)
                logger.warning(
                    "验证码尝试次数超限(%d次)，已失效: identifier=%s, code_type=%s",
                    attempts, _mask_identifier(identifier), code_type,
                )
                return False

            cached_code = VerificationCodeManager.get_code(identifier, code_type, challenge_key)

            if not cached_code:
                logger.warning("验证码不存在或已过期: identifier=%s, code_type=%s", _mask_identifier(identifier), code_type)
                return False

            is_valid = hmac.compare_digest(cached_code, input_code)

            if is_valid:
                cache.delete(attempt_key)
                if delete_after_verify:
                    VerificationCodeManager.delete_code(identifier, code_type, challenge_key)
                    logger.info("验证码验证成功并已删除: identifier=%s", _mask_identifier(identifier))
                else:
                    logger.info("验证码验证成功: identifier=%s", _mask_identifier(identifier))
            else:
                new_attempts = attempts + 1
                config = VerificationCodeManager.CODE_TYPES.get(code_type, {'expire_minutes': 5})
                cache.set(attempt_key, new_attempts, config['expire_minutes'] * 60)
                if new_attempts >= VerificationCodeManager.MAX_VERIFY_ATTEMPTS:
                    VerificationCodeManager.delete_code(identifier, code_type, challenge_key)
                    logger.warning(
                        "验证码验证失败且达到最大尝试次数(%d次)，已失效: identifier=%s",
                        new_attempts, _mask_identifier(identifier),
                    )
                else:
                    logger.warning(
                        "验证码验证失败(%d/%d): identifier=%s",
                        new_attempts, VerificationCodeManager.MAX_VERIFY_ATTEMPTS,
                        _mask_identifier(identifier),
                    )

            return is_valid

        except Exception as e:
            logger.error("验证码验证异常: identifier=%s, error=%s", _mask_identifier(identifier), e)
            return False

    @staticmethod
    def delete_code(
        identifier: str,
        code_type: str = 'login',
        challenge_key: Optional[str] = None,
    ) -> bool:
        """
        删除验证码

        Args:
            identifier: 标识符（邮箱或手机号）
            code_type: 验证码类型

        Returns:
            bool: 是否删除成功
        """
        try:
            cache_key = VerificationCodeManager._get_cache_key(identifier, code_type, challenge_key)

            # 从Redis删除
            try:
                conn = get_redis_connection("default")
                conn.delete(cache_key)
            except Exception as redis_error:
                logger.warning("Redis删除失败: %s", redis_error)

            # 从Django cache删除
            cache.delete(cache_key)

            logger.info("验证码已删除: code_type=%s, identifier=%s", code_type, _mask_identifier(identifier))
            return True

        except Exception as e:
            logger.error("删除验证码失败: identifier=%s, error=%s", _mask_identifier(identifier), e)
            return False

    @staticmethod
    def check_rate_limit(identifier: str, ip_address: Optional[str] = None) -> Tuple[bool, str]:
        """
        检查发送频率限制

        Args:
            identifier: 标识符（邮箱或手机号）

        Returns:
            Tuple[bool, str]: (是否允许发送, 错误消息)
        """
        try:
            return check_rate_limit("verification_code", identifier, ip_address)
        except Exception:
            logger.exception("频率限制检查失败 (fail-close): identifier=%s", _mask_identifier(identifier))
            return False, "服务暂时不可用，请稍后重试"

    @staticmethod
    def _normalize_identifier(identifier: str) -> str:
        """邮箱保原样；中国大陆手机号统一为 11 位，使发码/验码跨 +86 互通。"""
        if not identifier:
            return identifier
        stripped = identifier.strip()
        if '@' in stripped:
            return stripped
        from .phone import canonicalize_phone
        from .validators import is_phone_number

        canonical = canonicalize_phone(stripped)
        if canonical and (is_phone_number(canonical) or is_phone_number(stripped)):
            return canonical
        return stripped

    @staticmethod
    def _get_cache_key(
        identifier: str,
        code_type: str,
        challenge_key: Optional[str] = None,
    ) -> str:
        """
        生成统一的缓存键

        Args:
            identifier: 标识符
            code_type: 验证码类型

        Returns:
            str: 缓存键
        """
        normalized = VerificationCodeManager._normalize_identifier(identifier)
        key = f"verification_code:{code_type}:{normalized}"
        if challenge_key:
            from .utils import hash_string
            key = f"{key}:challenge:{hash_string(challenge_key)}"
        return key

    @staticmethod
    def _get_attempts_cache_key(
        identifier: str,
        code_type: str,
        challenge_key: Optional[str] = None,
    ) -> str:
        """生成验证码尝试次数的缓存键"""
        normalized = VerificationCodeManager._normalize_identifier(identifier)
        key = f"verify_attempts:{code_type}:{normalized}"
        if challenge_key:
            from .utils import hash_string
            key = f"{key}:challenge:{hash_string(challenge_key)}"
        return key

    @staticmethod
    def send_code(
        identifier: str,
        code_type: str = 'login',
        ip_address: Optional[str] = None,
        skip_rate_limit: bool = False,
        challenge_key: Optional[str] = None,
    ) -> Tuple[bool, str, str]:
        """
        发送验证码的完整流程（生成、缓存、发送）

        Args:
            identifier: 标识符（邮箱或手机号）
            code_type: 验证码类型

        Returns:
            Tuple[bool, str, str]: (是否成功, 消息, 验证码)
        """
        try:
            # 中国大陆手机号归一后再限流 / 缓存 / 发短信，避免 +86 与 11 位各算一套
            normalized_identifier = VerificationCodeManager._normalize_identifier(identifier)

            # 检查频率限制
            if not skip_rate_limit:
                rate_ok, rate_msg = VerificationCodeManager.check_rate_limit(
                    normalized_identifier, ip_address
                )
                if not rate_ok:
                    return False, rate_msg, ""

            # Community 默认不依赖短信供应商。手机号注册和验证码登录使用固定码，
            # 仍走原有缓存、challenge、限流和消费链路；敏感验证码用途不旁路。
            fixed_code = VerificationCodeManager.get_community_fixed_code(
                normalized_identifier, code_type
            )
            if fixed_code:
                cache_ok = VerificationCodeManager.cache_code(
                    normalized_identifier, fixed_code, code_type, challenge_key
                )
                if not cache_ok:
                    return False, "验证码缓存失败，请稍后重试", ""
                logger.warning(
                    "[COMMUNITY-FIXED-CODE] 已使用 Community 固定验证码（跳过真实发送）: "
                    "identifier=%s, code_type=%s。",
                    _mask_identifier(normalized_identifier), code_type,
                )
                return True, f"Community 验证码：{fixed_code}", fixed_code

            # 生成验证码
            code = VerificationCodeManager.generate_code(code_type)

            # 缓存验证码
            cache_ok = VerificationCodeManager.cache_code(
                normalized_identifier, code, code_type, challenge_key
            )
            if not cache_ok:
                return False, "验证码缓存失败，请稍后重试", ""

            # 发送验证码
            if '@' in normalized_identifier:
                from apps.services.email.services.factory import (
                    get_email_config_error,
                    get_email_service,
                )
                from apps.services.common.exceptions import ConfigurationException

                config_error = get_email_config_error()
                if config_error:
                    VerificationCodeManager.delete_code(identifier, code_type, challenge_key)
                    return False, config_error, ""

                try:
                    email_service = get_email_service()
                    result = email_service.send_verification_email(to_email=identifier, code=code)
                    if not result.get('success'):
                        VerificationCodeManager.delete_code(identifier, code_type, challenge_key)
                        return False, f"邮件发送失败：{result.get('message', '未知错误')}", ""
                except ConfigurationException as exc:
                    VerificationCodeManager.delete_code(identifier, code_type, challenge_key)
                    return False, exc.message, ""
                except Exception as e:
                    VerificationCodeManager.delete_code(identifier, code_type, challenge_key)
                    logger.error("邮件服务异常: %s", e, exc_info=True)
                    return False, "邮件服务异常，请稍后重试", ""
            else:
                from apps.services.sms.services.factory import get_sms_service
                from apps.services.common.exceptions import ConfigurationException

                try:
                    sms_service = get_sms_service()
                except (ConfigurationException, ImportError) as exc:
                    VerificationCodeManager.delete_code(identifier, code_type, challenge_key)
                    message = exc.message if isinstance(exc, ConfigurationException) else "短信服务未配置"
                    return False, message, ""

                try:
                    result = sms_service.send_verification_code(phone=identifier, code=code)
                    if not result.get('success'):
                        VerificationCodeManager.delete_code(identifier, code_type, challenge_key)
                        return False, f"短信发送失败：{result.get('message', '未知错误')}", ""
                except ConfigurationException as exc:
                    VerificationCodeManager.delete_code(identifier, code_type, challenge_key)
                    return False, exc.message, ""
                except Exception as e:
                    VerificationCodeManager.delete_code(identifier, code_type, challenge_key)
                    logger.error("短信服务异常: %s", e, exc_info=True)
                    return False, "短信服务异常，请稍后重试", ""

            logger.info("验证码发送流程完成: identifier=%s, code_type=%s", _mask_identifier(identifier), code_type)
            return True, "验证码已发送，请查收", code

        except Exception as e:
            logger.error("发送验证码流程失败: identifier=%s, error=%s", _mask_identifier(identifier), e)
            return False, "验证码发送失败，请稍后重试", ""
