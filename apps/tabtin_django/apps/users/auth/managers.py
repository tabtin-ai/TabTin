"""
用户管理器
"""

from django.contrib.auth.models import BaseUserManager
from django.core.exceptions import ValidationError
from django.core.validators import validate_email
import re


class UserManager(BaseUserManager):
    """自定义用户管理器"""

    def _create_user(self, email=None, phone=None, password=None, **extra_fields):
        """创建用户的通用方法"""
        if not email and not phone:
            raise ValueError('用户必须提供邮箱或手机号')

        # 验证邮箱格式
        if email:
            try:
                validate_email(email)
            except ValidationError:
                raise ValueError('邮箱格式不正确')
            email = self.normalize_email(email)

        # 验证并归一化手机号：中国大陆不保留 +86，统一存 11 位
        if phone:
            from .phone import canonicalize_phone

            phone = canonicalize_phone(phone) or phone
            if not self._validate_phone(phone):
                raise ValueError('手机号格式不正确')

        user = self.model(
            email=email,
            phone=phone,
            **extra_fields
        )

        if password:
            user.set_password(password)
        else:
            user.set_unusable_password()

        user.save(using=self._db)
        return user

    def create_user(self, email=None, phone=None, password=None, **extra_fields):
        """创建普通用户"""
        extra_fields.setdefault('is_staff', False)
        extra_fields.setdefault('is_superuser', False)
        return self._create_user(email, phone, password, **extra_fields)

    def create_superuser(self, email=None, phone=None, password=None, **extra_fields):
        """创建超级用户"""
        extra_fields.setdefault('is_staff', True)
        extra_fields.setdefault('is_superuser', True)

        if extra_fields.get('is_staff') is not True:
            raise ValueError('超级用户必须设置 is_staff=True')
        if extra_fields.get('is_superuser') is not True:
            raise ValueError('超级用户必须设置 is_superuser=True')

        return self._create_user(email, phone, password, **extra_fields)

    def get_by_natural_key(self, username):
        """通过自然键获取用户（支持邮箱、手机号、用户名）"""
        from .validators import is_phone_number
        if '@' in username:
            return self.get(email=username)
        elif is_phone_number(username):
            from .phone import resolve_user_by_phone

            user = resolve_user_by_phone(username, active_only=False)
            if user is None:
                raise self.model.DoesNotExist(
                    f"{self.model._meta.object_name} matching query does not exist."
                )
            return user
        else:
            return self.get(username=username)

    def _validate_phone(self, phone):
        """验证手机号格式（E.164 简化版）"""
        from .validators import PHONE_REGEX
        return bool(re.match(PHONE_REGEX, phone))

    def get_active_users(self):
        """获取活跃用户"""
        return self.filter(is_active=True)

    def get_verified_users(self):
        """获取已验证用户"""
        return self.filter(
            is_active=True,
            is_verified_email=True
        )
