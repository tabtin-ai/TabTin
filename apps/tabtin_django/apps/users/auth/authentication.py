"""
认证后端
"""

from django.contrib.auth.backends import BaseBackend
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.core.validators import validate_email
import re

from .verification_manager import VerificationCodeManager
from .validators import validate_verification_code, is_phone_number

User = get_user_model()


class MultiFieldAuthBackend(BaseBackend):
    """支持邮箱、手机号、用户名多字段登录的认证后端"""

    def authenticate(self, request, username=None, password=None, **kwargs):
        """
        认证用户
        支持邮箱、手机号、用户名登录
        """
        if username is None or password is None:
            return None

        user = self._get_user_by_identifier(username)

        if user is None:
            return None

        # 检查账号是否被锁定
        if user.is_account_locked():
            return None

        # 验证密码
        if user.check_password(password):
            # 登录成功，更新登录统计；顺带把 +86 收敛为 11 位（无冲突时）
            if self._is_phone(username):
                from .phone import maybe_canonicalize_stored_phone

                maybe_canonicalize_stored_phone(user)
            user.increment_login_count()
            return user
        else:
            # 登录失败，增加失败次数
            user.increment_failed_login()
            return None

    def get_user(self, user_id):
        """根据用户ID获取用户对象"""
        try:
            return User.objects.get(pk=user_id)
        except User.DoesNotExist:
            return None

    def _get_user_by_identifier(self, identifier):
        """根据标识符获取用户（邮箱、手机号或用户名）"""
        try:
            if self._is_email(identifier):
                # 邮箱登录
                return User.objects.get(email=identifier, is_active=True)
            elif self._is_phone(identifier):
                # 手机号登录：+86 / 11 位互认
                from .phone import resolve_user_by_phone

                return resolve_user_by_phone(identifier, active_only=True)
            else:
                # 用户名登录
                return User.objects.get(username=identifier, is_active=True)
        except User.DoesNotExist:
            return None

    def _is_email(self, identifier):
        """检查是否为邮箱格式"""
        try:
            validate_email(identifier)
            return True
        except ValidationError:
            return False

    def _is_phone(self, identifier):
        """检查是否为手机号格式"""
        return is_phone_number(identifier)


class VerificationCodeAuthBackend(BaseBackend):
    """验证码登录认证后端（已废弃，不再注册到 AUTHENTICATION_BACKENDS）"""

    def authenticate(self, request, username=None, verification_code=None, **kwargs):
        """
        使用验证码认证用户
        """
        if username is None or verification_code is None:
            return None

        # 这里需要验证验证码的有效性
        # 实际实现中需要从缓存或数据库中验证验证码
        if not self._verify_code(username, verification_code):
            return None

        user = self._get_user_by_identifier(username)
        if user and user.is_active:
            if user.is_account_locked():
                return None
            user.increment_login_count()
            return user

        return None

    def get_user(self, user_id):
        """根据用户ID获取用户对象"""
        try:
            return User.objects.get(pk=user_id)
        except User.DoesNotExist:
            return None

    def _get_user_by_identifier(self, identifier):
        """根据标识符获取用户"""
        try:
            if self._is_email(identifier):
                return User.objects.get(email=identifier, is_active=True)
            elif self._is_phone(identifier):
                from .phone import resolve_user_by_phone

                return resolve_user_by_phone(identifier, active_only=True)
            else:
                return User.objects.get(username=identifier, is_active=True)
        except User.DoesNotExist:
            return None

    def _verify_code(self, identifier, code):
        """验证验证码（需要实现具体逻辑）"""
        try:
            validate_verification_code(code)
        except ValidationError:
            return False

        return VerificationCodeManager.verify_code(
            identifier,
            code,
            'login',
            delete_after_verify=True
        )

    def _is_email(self, identifier):
        """检查是否为邮箱格式"""
        try:
            validate_email(identifier)
            return True
        except ValidationError:
            return False

    def _is_phone(self, identifier):
        """检查是否为手机号格式"""
        return is_phone_number(identifier)
