"""
Services模块验证器
"""

from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field, field_validator
from .utils import validate_phone_number, validate_email
from .exceptions import ValidationException
from apps.i18n import get_text


class PhoneNumberValidator(BaseModel):
    """手机号码验证器"""
    phone: str = Field(..., description="手机号码")

    @field_validator('phone')
    @classmethod
    def validate_phone(cls, v):
        if not validate_phone_number(v):
            raise ValueError(get_text('service_validation.invalid_phone_format'))
        return v


class EmailValidator(BaseModel):
    """邮箱地址验证器"""
    email: str = Field(..., description="邮箱地址")

    @field_validator('email')
    @classmethod
    def validate_email_format(cls, v):
        if not validate_email(v):
            raise ValueError(get_text('service_validation.invalid_email_format'))
        return v


class VerificationCodeValidator(BaseModel):
    """验证码验证器"""
    code: str = Field(..., min_length=4, max_length=8, description="验证码")

    @field_validator('code')
    @classmethod
    def validate_code_format(cls, v):
        if not v.isdigit():
            raise ValueError(get_text('service_validation.verification_code_digits_only'))
        return v


class SmsContentValidator(BaseModel):
    """短信内容验证器"""
    content: str = Field(..., max_length=500, description="短信内容")

    @field_validator('content')
    @classmethod
    def validate_content(cls, v):
        if not v.strip():
            raise ValueError(get_text('service_validation.sms_content_empty'))

        # 检查敏感词（从常量中获取）
        try:
            from .constants import SENSITIVE_WORDS
            forbidden_words = SENSITIVE_WORDS
        except ImportError:
            forbidden_words = ['测试敏感词']
        for word in forbidden_words:
            if word in v:
                raise ValueError(get_text('service_validation.sms_content_sensitive', word=word))

        return v.strip()


class EmailContentValidator(BaseModel):
    """邮件内容验证器"""
    subject: str = Field(..., max_length=200, description="邮件主题")
    content: str = Field(..., max_length=10000, description="邮件内容")

    @field_validator('subject')
    @classmethod
    def validate_subject(cls, v):
        if not v.strip():
            raise ValueError(get_text('service_validation.email_subject_empty'))
        return v.strip()

    @field_validator('content')
    @classmethod
    def validate_content(cls, v):
        if not v.strip():
            raise ValueError(get_text('service_validation.email_content_empty'))
        return v.strip()


class TemplateParamsValidator(BaseModel):
    """模板参数验证器"""
    template_code: str = Field(..., description="模板代码")
    params: Dict[str, Any] = Field(default_factory=dict, description="模板参数")

    @field_validator('template_code')
    @classmethod
    def validate_template_code(cls, v):
        if not v.strip():
            raise ValueError(get_text('service_validation.template_code_empty'))
        return v.strip()


def validate_sms_request(phone: str, template_code: str, params: Dict[str, Any]) -> None:
    """
    验证短信发送请求

    Args:
        phone: 手机号码
        template_code: 模板代码
        params: 模板参数

    Raises:
        ValidationException: 验证失败时抛出
    """
    try:
        # 验证手机号
        PhoneNumberValidator(phone=phone)

        # 验证模板参数
        TemplateParamsValidator(template_code=template_code, params=params)

        # 如果包含验证码，验证验证码格式
        if 'code' in params:
            VerificationCodeValidator(code=str(params['code']))

    except ValueError as e:
        raise ValidationException(str(e))


def validate_email_request(email: str, subject: str, content: str) -> None:
    """
    验证邮件发送请求

    Args:
        email: 邮箱地址
        subject: 邮件主题
        content: 邮件内容

    Raises:
        ValidationException: 验证失败时抛出
    """
    try:
        # 验证邮箱地址
        EmailValidator(email=email)

        # 验证邮件内容
        EmailContentValidator(subject=subject, content=content)

    except ValueError as e:
        raise ValidationException(str(e))


def validate_batch_recipients(recipients: List[str], recipient_type: str = 'phone') -> None:
    """
    验证批量接收者

    Args:
        recipients: 接收者列表
        recipient_type: 接收者类型 ('phone' 或 'email')

    Raises:
        ValidationException: 验证失败时抛出
    """
    if not recipients:
        raise ValidationException(get_text('service_validation.recipients_empty'))

    if len(recipients) > 100:  # 限制批量发送数量
        raise ValidationException(get_text('service_validation.recipients_too_many', max=100))

    validator_class = PhoneNumberValidator if recipient_type == 'phone' else EmailValidator
    field_name = 'phone' if recipient_type == 'phone' else 'email'

    for recipient in recipients:
        try:
            validator_class(**{field_name: recipient})
        except ValueError as e:
            raise ValidationException(
                get_text(
                    'service_validation.invalid_recipient',
                    recipient_type=recipient_type,
                    recipient=recipient,
                    detail=str(e)
                )
            )


def validate_template_format(template_content: str, required_params: List[str]) -> None:
    """
    验证模板格式

    Args:
        template_content: 模板内容
        required_params: 必需的参数列表

    Raises:
        ValidationException: 验证失败时抛出
    """
    if not template_content.strip():
        raise ValidationException(get_text('service_validation.template_content_empty'))

    # 检查必需参数是否都在模板中
    for param in required_params:
        if f'{{{param}}}' not in template_content and f'${{{param}}}' not in template_content:
            raise ValidationException(get_text('service_validation.template_missing_param', param=param))


class ConfigValidator(BaseModel):
    """配置验证器"""

    @staticmethod
    def validate_sms_config(config: Dict[str, Any]) -> None:
        """验证短信服务配置"""
        required_keys = ['access_key_id', 'access_key_secret', 'region', 'sign_name']

        for key in required_keys:
            if key not in config or not config[key]:
                raise ValidationException(get_text('service_validation.sms_config_missing_param', key=key))

    @staticmethod
    def validate_email_config(config: Dict[str, Any]) -> None:
        """验证邮件服务配置"""
        required_keys = ['host', 'port', 'username', 'password']

        for key in required_keys:
            if key not in config or not config[key]:
                raise ValidationException(get_text('service_validation.email_config_missing_param', key=key))

        # 验证端口号
        try:
            port = int(config['port'])
            if port < 1 or port > 65535:
                raise ValidationException(get_text('service_validation.email_port_range'))
        except (ValueError, TypeError):
            raise ValidationException(get_text('service_validation.email_port_invalid'))
