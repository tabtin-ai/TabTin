"""
Pydantic数据模型
"""

from typing import Optional, List
from datetime import datetime
from pydantic import BaseModel, EmailStr, Field, field_validator, validator
from ninja import Schema
import re


class UserRegisterSchema(Schema):
    """
    用户注册数据模型

    用户注册需要提供邮箱或手机号之一，以及6位验证码进行验证。
    注册成功后，对应的邮箱或手机号将自动设置为已验证状态。
    """
    email: Optional[EmailStr] = Field(
        None,
        description="邮箱地址",
        json_schema_extra={"example": "user@example.com"}
    )
    phone: Optional[str] = Field(
        None,
        description="中国大陆手机号",
        min_length=11,
        max_length=11,
        json_schema_extra={"example": "13800138000"}
    )
    password: str = Field(
        ...,
        description="密码，至少8位，须含大写/小写/数字/特殊字符中的至少3种",
        min_length=8,
        max_length=128,
        json_schema_extra={"example": "MyPassword123!"}
    )
    nickname: Optional[str] = Field(
        None,
        description="用户昵称",
        max_length=50,
        json_schema_extra={"example": "小明"}
    )
    username: Optional[str] = Field(
        None,
        description="用户名，用于@username主页标识，只能包含字母、数字、下划线",
        min_length=3,
        max_length=20,
        json_schema_extra={"example": "xiaoming123"}
    )
    verification_code: str = Field(
        ...,
        description="6位数字验证码，通过发送验证码接口获取",
        min_length=6,
        max_length=6,
        json_schema_extra={"example": "123456"}
    )
    invite_code: Optional[str] = Field(
        None,
        description="兼容字段；注册后续准入流程使用",
        max_length=64,
        json_schema_extra={"example": "ALPHA2026"}
    )
    language: Optional[str] = Field(
        None,
        description="界面语言偏好（影响默认 Space 名称等 onboarding 文案）",
        pattern="^(system|zh-CN|zh-TW|en-US|ja-JP|ko-KR|de-DE|fr-FR|es-ES)$",
    )

    # 所有验证逻辑移到业务逻辑中处理，避免Django Ninja返回422错误


class UserLoginSchema(Schema):
    """
    用户登录数据模型

    支持使用用户名、邮箱或手机号登录。
    """
    username: str = Field(
        ...,
        description="登录标识：用户名、邮箱或手机号",
        json_schema_extra={"example": "user@example.com"}
    )
    password: str = Field(
        ...,
        description="登录密码",
        json_schema_extra={"example": "MyPassword123!"}
    )
    remember_me: bool = Field(
        False,
        description="记住我（延长Token有效期至7天）",
        json_schema_extra={"example": False}
    )


class VerificationCodeLoginSchema(Schema):
    """验证码登录数据模型"""
    username: str = Field(..., description="邮箱/手机号")
    verification_code: str = Field(..., description="验证码", min_length=6, max_length=6)
    challenge_key: Optional[str] = Field(None, description="本次发码挑战 key", min_length=16, max_length=64)
    invite_code: Optional[str] = Field(None, description="兼容字段；注册后续准入流程使用", max_length=64)
    remember_me: bool = Field(
        False,
        description="记住我（延长Token有效期至7天）",
        json_schema_extra={"example": False}
    )

    # 验证码格式验证移到业务逻辑中处理


class PhoneReservationSchema(Schema):
    """手机号预约请求。"""

    phone: str = Field(
        ...,
        description="预约手机号",
        json_schema_extra={"example": "13800138000"},
    )
    verification_code: str = Field(
        ...,
        description="6位短信验证码",
        min_length=6,
        max_length=6,
        json_schema_extra={"example": "123456"},
    )


class SendVerificationCodeSchema(Schema):
    """
    发送验证码数据模型

    根据不同的验证码类型，系统会进行相应的验证和处理。
    """
    username: str = Field(
        ...,
        description="邮箱地址或手机号",
        json_schema_extra={"example": "user@example.com"}
    )
    code_type: str = Field(
        "login",
        description="验证码类型：login(登录)、register(注册)、reset_password(密码重置)、phone_reservation(手机号预约)、create_api_key(创建API Key)、change_password(修改密码)",
        pattern="^(login|register|reset_password|phone_reservation|create_api_key|change_password)$",
        json_schema_extra={"example": "register"}
    )
    invite_code: Optional[str] = Field(None, description="兼容字段；注册后续准入流程使用", max_length=64)
    challenge_key: Optional[str] = Field(None, description="客户端为本次发码生成的挑战 key", min_length=16, max_length=64)


class ForgotPasswordSchema(Schema):
    """忘记密码数据模型"""
    username: str = Field(..., description="邮箱/手机号")


class PasswordResetSchema(Schema):
    """密码重置数据模型"""
    username: str = Field(..., description="邮箱/手机号")
    verification_code: str = Field(..., description="验证码", min_length=6, max_length=6)
    new_password: str = Field(..., description="新密码", min_length=8, max_length=128)

    # 密码验证移到业务逻辑中处理，避免Django Ninja返回422错误


class CurrentUserPasswordResetSchema(Schema):
    """已登录用户验证码重置密码数据模型"""
    verification_code: str = Field(..., description="验证码", min_length=6, max_length=6)
    new_password: str = Field(..., description="新密码", min_length=8, max_length=128)

    # 密码验证移到业务逻辑中处理，避免Django Ninja返回422错误


class PasswordChangeSchema(Schema):
    """修改密码数据模型"""
    old_password: str = Field(..., description="原密码")
    new_password: str = Field(..., description="新密码", min_length=8, max_length=128)
    verification_code: Optional[str] = None

    # 密码验证移到业务逻辑中处理


class UserProfileUpdateSchema(Schema):
    """用户资料更新数据模型"""
    nickname: Optional[str] = Field(None, description="昵称", max_length=50)
    username: Optional[str] = Field(None, description="用户名", min_length=3, max_length=20)
    bio: Optional[str] = Field(None, description="个人简介", max_length=500)
    avatar_file_id: Optional[str] = Field(
        None,
        description="头像文件 ID（通过 presign→PUT→confirm 上传后返回的 file_id）",
        max_length=36,
    )

    # 用户名验证移到业务逻辑中处理


class UserProfileSettingsSchema(Schema):
    """用户配置设置数据模型"""
    is_public_profile: Optional[bool] = Field(None, description="公开资料")
    allow_email_notifications: Optional[bool] = Field(None, description="允许邮件通知")
    allow_sms_notifications: Optional[bool] = Field(None, description="允许短信通知")
    timezone: Optional[str] = Field(None, description="时区")
    language: Optional[str] = Field(
        None,
        description="语言",
        pattern="^(system|zh-CN|zh-TW|en-US|ja-JP|ko-KR|de-DE|fr-FR|es-ES)$",
    )
    theme: Optional[str] = Field(None, description="主题", pattern="^(light|dark|auto)$")
    homepage_template: Optional[str] = Field(None, description="主页模板", max_length=50)
    max_collections: Optional[int] = Field(None, description="最大收藏数", ge=0)


class UISettingsUpdateSchema(Schema):
    """PUT /profile/ui-settings 请求体：待合并的个人偏好增量（仿 ApprovalPreferencesUpdateSchema）。

    格式: {settings: {<namespace>: {value: <任意 JSON>, updatedAt: number(ms epoch)}}}
    只传变更的 namespace（增量），按 namespace 做 last-write-wins 合并。
    """
    settings: dict


class EmailVerificationSchema(Schema):
    """邮箱验证数据模型"""
    email: EmailStr = Field(..., description="邮箱")
    verification_code: str = Field(..., description="验证码", min_length=6, max_length=6)


class BindEmailSendSchema(Schema):
    """已登录用户绑定邮箱：发送验证码"""
    email: EmailStr = Field(..., description="待绑定的邮箱")


class BindEmailSchema(Schema):
    """已登录用户绑定邮箱：校验验证码并写入"""
    email: EmailStr = Field(..., description="待绑定的邮箱")
    verification_code: str = Field(..., description="验证码", min_length=6, max_length=6)


class PhoneVerificationSchema(Schema):
    """手机验证数据模型"""
    phone: str = Field(..., description="手机号", min_length=11, max_length=11)
    verification_code: str = Field(..., description="验证码", min_length=6, max_length=6)

    # 手机号验证移到业务逻辑中处理


# 响应数据模型
class UserInfoSchema(Schema):
    """用户信息响应模型"""
    id: str
    username: Optional[str]
    email: Optional[str]
    phone: Optional[str]
    nickname: Optional[str]
    avatar: Optional[str]
    bio: Optional[str]
    is_verified_email: bool
    is_verified_phone: bool
    date_joined: datetime
    last_login: Optional[datetime]
    login_count: int
    invite_code_required: bool = False
    invite_code_redeemed: bool = True
    has_usable_password: bool = True
    is_staff: bool = False
    is_superuser: bool = False
    role: str = "user"


class UserProfileSchema(Schema):
    """用户配置响应模型"""
    is_public_profile: bool
    allow_email_notifications: bool
    allow_sms_notifications: bool
    timezone: str
    language: str
    theme: str
    homepage_template: str
    max_collections: int


class LoginResponseSchema(Schema):
    """登录响应模型"""
    access_token: str
    refresh_token: str
    token_type: str = "Bearer"
    expires_in: int
    user: UserInfoSchema
    is_new_user: bool = False


class RefreshTokenSchema(Schema):
    """Token刷新请求模型"""
    refresh_token: str = Field(..., description="刷新令牌")


class RefreshTokenResponseSchema(Schema):
    """Token刷新响应模型"""
    access_token: str = Field(..., description="新的访问令牌")
    refresh_token: str = Field(..., description="新的刷新令牌")
    token_type: str = Field("Bearer", description="令牌类型")
    expires_in: int = Field(..., description="访问令牌有效期（秒）")


# ── OAuth Device Authorization Flow（，简化版 RFC 8628）──────

class DeviceCodeRequestSchema(Schema):
    """CLI 申请 device_code 的请求模型"""
    client_id: str = Field("tabtin-cli", description="发起方客户端标识，仅用于审计展示")
    device_name: Optional[str] = Field(None, description="设备/终端展示名，展示给用户做确认")
    scope: Optional[str] = Field(None, description="预留字段：申请的权限范围")


class DeviceCodeResponseSchema(Schema):
    """device_code 申请响应模型，字段对齐 RFC 8628 Device Authorization Response"""
    device_code: str = Field(..., description="设备端轮询凭据，仅 CLI 侧持有")
    user_code: str = Field(..., description="展示给用户的短码，用户在授权确认页核对")
    verification_uri: str = Field(..., description="用户完成授权确认的页面地址")
    verification_uri_complete: str = Field(..., description="预填 user_code 的授权确认地址")
    expires_in: int = Field(..., description="device_code 有效期（秒）")
    interval: int = Field(..., description="CLI 轮询建议的最小间隔（秒）")


class DeviceApproveSchema(Schema):
    """已登录用户在授权确认页对 user_code 的确认/拒绝操作"""
    user_code: str = Field(..., description="授权确认页展示/输入的短码")
    approve: bool = Field(True, description="True=同意授权，False=拒绝授权")


class DeviceTokenRequestSchema(Schema):
    """CLI 轮询换取 token 的请求模型"""
    device_code: str = Field(..., description="申请 code 时返回的 device_code")
    client_id: Optional[str] = Field(None, description="客户端标识，仅用于审计比对")
    grant_type: str = Field(
        "urn:ietf:params:oauth:grant-type:device_code",
        description="固定为 device_code 授权类型，预留给未来扩展其它 grant_type",
    )


class UserSessionSchema(Schema):
    """用户会话响应模型"""
    id: str
    session_type: str
    ip_address: str
    user_agent: str
    device_info: dict
    created_at: datetime
    last_activity: datetime
    expires_at: datetime
    is_active: bool


class UserActionLogSchema(Schema):
    """用户操作日志响应模型"""
    id: str
    action_type: str
    description: str
    ip_address: str
    success: bool
    error_message: Optional[str]
    created_at: datetime


class UserGroupSchema(Schema):
    """用户组响应模型"""
    id: str
    name: str
    description: str
    group_type: str
    max_members: Optional[int]
    is_active: bool
    created_at: datetime


class PasswordStrengthCheckSchema(Schema):
    """密码强度检查请求模型（CA-5: 密码通过 body 传输，不暴露在 URL）"""
    password: str = Field(..., description="待检查的密码")


class PasswordStrengthSchema(Schema):
    """密码强度响应模型"""
    score: int = Field(..., description="强度评分(0-100)")
    level: str = Field(..., description="强度等级")
    suggestions: List[str] = Field(..., description="改进建议")


class ApiResponseSchema(Schema):
    """通用API响应模型"""
    success: bool = Field(..., description="是否成功")
    message: str = Field(..., description="响应消息")
    data: Optional[dict] = Field(None, description="响应数据")
    code: str = Field("SUCCESS", description="业务状态码")


class RateLimitResponseSchema(ApiResponseSchema):
    """标准限流响应；旧客户端仍可忽略新增的等待秒数字段。"""

    retry_after_seconds: int = Field(..., ge=1, description="建议重试前等待的秒数")


class LoginErrorResponseSchema(ApiResponseSchema):
    """登录失败响应；锁定时携带建议等待秒数。"""
    retry_after_seconds: Optional[int] = Field(None, description="建议重试前等待的秒数")


class RedeemInviteCodeSchema(Schema):
    """登录后邀请码兑换请求。"""
    invite_code: str = Field(..., description="邀请码", min_length=1, max_length=64)


class PaginationSchema(Schema):
    """分页响应模型"""
    total: int = Field(..., description="总数量")
    page: int = Field(..., description="当前页码")
    page_size: int = Field(..., description="每页数量")
    total_pages: int = Field(..., description="总页数")
    has_next: bool = Field(..., description="是否有下一页")
    has_previous: bool = Field(..., description="是否有上一页")


class PaginatedResponseSchema(Schema):
    """分页数据响应模型"""
    success: bool = Field(..., description="是否成功")
    message: str = Field(..., description="响应消息")
    data: List[dict] = Field(..., description="数据列表")
    pagination: PaginationSchema = Field(..., description="分页信息")
    code: str = Field("SUCCESS", description="业务状态码")


# ── User API Key Schemas ─────────────────────────────────────────

class CreateApiKeySchema(Schema):
    organization_id: Optional[str] = Field(None, description="限定组织 ID（为空则可操作所有组织）")
    name: str = Field(..., description="Key 名称", min_length=1, max_length=100)
    description: str = Field('', description="描述")
    scopes: List[str] = Field(default=['*'], description="权限范围")
    rate_limit: int = Field(60, description="限流(次/分钟)")
    expired_days: Optional[int] = Field(None, description="有效天数(null=永不过期)")
    verification_code: Optional[str] = None

    @field_validator('scopes')
    @classmethod
    def validate_scopes(cls, v):
        from .models import UserApiKey
        valid_scopes = {s[0] for s in UserApiKey.PLATFORM_SCOPES}
        for scope in v:
            if scope not in valid_scopes:
                raise ValueError(f"无效的 scope: '{scope}'，合法值: {', '.join(sorted(valid_scopes))}")
        return v


class ApiKeyInfoSchema(Schema):
    id: str
    organization_id: Optional[str] = Field('', description="限定组织 ID（空=不限定）")
    name: str
    description: str
    key_display: str = Field(..., description="脱敏后的 key 标识 (ttn_xxxx...)")
    scopes: List[str]
    rate_limit: int
    is_active: bool
    expired_at: Optional[datetime]
    last_used_at: Optional[datetime]
    use_count: int
    created_at: datetime


class UpdateApiKeySchema(Schema):
    name: Optional[str] = Field(None, max_length=100)
    description: Optional[str] = None
    is_active: Optional[bool] = None
