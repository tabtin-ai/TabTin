"""
邮件服务Pydantic模型
"""

from typing import Dict, Any, Optional, List
from datetime import datetime
from pydantic import BaseModel, Field, EmailStr, field_validator
from ..common.utils import validate_email
from apps.i18n import get_text


class EmailBaseRequest(BaseModel):
    """邮件请求基础模型"""
    email: EmailStr = Field(..., description="邮箱地址")


class SendEmailRequest(BaseModel):
    """发送邮件请求模型"""
    to_email: EmailStr = Field(..., description="收件人邮箱")
    subject: str = Field(..., min_length=1, max_length=500, description="邮件主题")
    content: str = Field(..., min_length=1, description="邮件内容")
    content_type: str = Field(default='html', description="内容类型")
    priority: str = Field(default='normal', description="优先级")
    attachments: Optional[List[Dict[str, Any]]] = Field(None, description="附件列表")

    @field_validator('content_type')
    @classmethod
    def validate_content_type(cls, v):
        if v not in ['html', 'plain']:
            raise ValueError(get_text('service_validation.content_type_invalid'))
        return v

    @field_validator('priority')
    @classmethod
    def validate_priority(cls, v):
        if v not in ['low', 'normal', 'high', 'urgent']:
            raise ValueError(get_text('service_validation.priority_invalid'))
        return v

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


class SendVerificationEmailRequest(EmailBaseRequest):
    """发送验证码邮件请求模型"""
    code: str = Field(..., min_length=4, max_length=8, description="验证码")

    @field_validator('code')
    @classmethod
    def validate_code(cls, v):
        if not v.isdigit():
            raise ValueError(get_text('service_validation.verification_code_digits_only'))
        return v


class SendTemplateEmailRequest(EmailBaseRequest):
    """发送模板邮件请求模型"""
    template_name: str = Field(..., description="模板名称")
    template_params: Dict[str, Any] = Field(default_factory=dict, description="模板参数")

    @field_validator('template_name')
    @classmethod
    def validate_template_name(cls, v):
        if not v.strip():
            raise ValueError(get_text('service_validation.template_name_empty'))
        return v.strip()


class BatchEmailRequest(BaseModel):
    """批量发送邮件请求模型"""
    emails: List[EmailStr] = Field(..., min_length=1, max_length=100, description="邮箱地址列表")
    subject: str = Field(..., min_length=1, max_length=500, description="邮件主题")
    content: str = Field(..., min_length=1, description="邮件内容")
    content_type: str = Field(default='html', description="内容类型")

    @field_validator('content_type')
    @classmethod
    def validate_content_type(cls, v):
        if v not in ['html', 'plain']:
            raise ValueError(get_text('service_validation.content_type_invalid'))
        return v


class EmailResponse(BaseModel):
    """邮件响应基础模型"""
    success: bool = Field(..., description="是否成功")
    message: str = Field(..., description="响应消息")
    timestamp: str = Field(..., description="时间戳")
    error_code: Optional[str] = Field(None, description="错误代码")
    data: Optional[Dict[str, Any]] = Field(None, description="响应数据")


class SendEmailResponse(EmailResponse):
    """发送邮件响应模型"""

    class SendEmailData(BaseModel):
        message_id: str = Field(..., description="消息ID")
        request_id: str = Field(..., description="请求ID")
        to_email: str = Field(..., description="收件人邮箱")

    data: Optional[SendEmailData] = None


class BatchEmailResponse(EmailResponse):
    """批量发送邮件响应模型"""

    class BatchEmailData(BaseModel):
        total: int = Field(..., description="总数")
        success_count: int = Field(..., description="成功数量")
        failed_count: int = Field(..., description="失败数量")
        results: List[Dict[str, Any]] = Field(..., description="详细结果")

    data: Optional[BatchEmailData] = None


class EmailRecordResponse(BaseModel):
    """邮件记录响应模型"""
    id: str = Field(..., description="记录ID")
    recipient_email: str = Field(..., description="收件人邮箱")
    sender_email: str = Field(..., description="发件人邮箱")
    subject: str = Field(..., description="邮件主题")
    content_type: str = Field(..., description="内容类型")
    template_name: str = Field(..., description="模板名称")
    template_params: Dict[str, Any] = Field(..., description="模板参数")
    status: str = Field(..., description="发送状态")
    priority: str = Field(..., description="优先级")
    provider: str = Field(..., description="服务提供商")
    message_id: Optional[str] = Field(None, description="消息ID")
    error_code: Optional[str] = Field(None, description="错误代码")
    error_message: Optional[str] = Field(None, description="错误消息")
    has_attachments: bool = Field(..., description="是否有附件")
    created_at: datetime = Field(..., description="创建时间")
    sent_at: Optional[datetime] = Field(None, description="发送时间")
    delivered_at: Optional[datetime] = Field(None, description="送达时间")
    opened_at: Optional[datetime] = Field(None, description="打开时间")
    clicked_at: Optional[datetime] = Field(None, description="点击时间")
    retry_count: int = Field(..., description="重试次数")
    open_count: int = Field(..., description="打开次数")
    click_count: int = Field(..., description="点击次数")


class EmailRecordListResponse(BaseModel):
    """邮件记录列表响应模型"""
    total: int = Field(..., description="总数")
    page: int = Field(..., description="当前页")
    page_size: int = Field(..., description="每页大小")
    records: List[EmailRecordResponse] = Field(..., description="记录列表")


class EmailTemplateResponse(BaseModel):
    """邮件模板响应模型"""
    id: str = Field(..., description="模板ID")
    template_name: str = Field(..., description="模板名称")
    template_subject: str = Field(..., description="邮件主题模板")
    template_content: str = Field(..., description="邮件内容模板")
    template_type: str = Field(..., description="模板类型")
    content_type: str = Field(..., description="内容类型")
    status: str = Field(..., description="状态")
    required_params: List[str] = Field(..., description="必需参数")
    description: str = Field(..., description="模板描述")
    is_active: bool = Field(..., description="是否启用")
    created_at: datetime = Field(..., description="创建时间")
    updated_at: datetime = Field(..., description="更新时间")


class EmailStatisticsResponse(BaseModel):
    """邮件统计响应模型"""
    date: str = Field(..., description="统计日期")
    provider: str = Field(..., description="服务提供商")
    template_name: str = Field(..., description="模板名称")
    total_sent: int = Field(..., description="发送总数")
    success_count: int = Field(..., description="成功数量")
    failed_count: int = Field(..., description="失败数量")
    delivered_count: int = Field(..., description="送达数量")
    opened_count: int = Field(..., description="打开数量")
    clicked_count: int = Field(..., description="点击数量")
    bounced_count: int = Field(..., description="退回数量")
    success_rate: float = Field(..., description="成功率")
    delivery_rate: float = Field(..., description="送达率")
    open_rate: float = Field(..., description="打开率")
    click_rate: float = Field(..., description="点击率")
    bounce_rate: float = Field(..., description="退回率")


class ServiceStatusResponse(BaseModel):
    """服务状态响应模型"""
    provider: str = Field(..., description="服务提供商")
    status: str = Field(..., description="服务状态")
    config_valid: bool = Field(..., description="配置是否有效")
    last_check: datetime = Field(..., description="最后检查时间")
    features: List[str] = Field(..., description="支持的功能")
    smtp_hosts: List[str] = Field(..., description="SMTP服务器")


class HealthCheckResponse(BaseModel):
    """健康检查响应模型"""
    service: str = Field(..., description="服务名称")
    status: str = Field(..., description="服务状态")
    version: str = Field(..., description="版本号")
    timestamp: datetime = Field(..., description="检查时间")
    dependencies: Dict[str, str] = Field(..., description="依赖服务状态")


# 请求查询参数模型
class EmailRecordQueryParams(BaseModel):
    """邮件记录查询参数"""
    email: Optional[str] = Field(None, description="邮箱地址")
    template_name: Optional[str] = Field(None, description="模板名称")
    status: Optional[str] = Field(None, description="发送状态")
    priority: Optional[str] = Field(None, description="优先级")
    start_date: Optional[str] = Field(None, description="开始日期")
    end_date: Optional[str] = Field(None, description="结束日期")
    page: int = Field(1, ge=1, description="页码")
    page_size: int = Field(20, ge=1, le=100, description="每页大小")


class EmailStatisticsQueryParams(BaseModel):
    """邮件统计查询参数"""
    provider: Optional[str] = Field(None, description="服务提供商")
    template_name: Optional[str] = Field(None, description="模板名称")
    start_date: Optional[str] = Field(None, description="开始日期")
    end_date: Optional[str] = Field(None, description="结束日期")


class EmailTemplateQueryParams(BaseModel):
    """邮件模板查询参数"""
    template_type: Optional[str] = Field(None, description="模板类型")
    status: Optional[str] = Field(None, description="状态")
    is_active: Optional[bool] = Field(None, description="是否启用")


class CreateEmailTemplateRequest(BaseModel):
    """创建邮件模板请求模型"""
    template_name: str = Field(..., description="模板名称")
    template_subject: str = Field(..., description="邮件主题模板")
    template_content: str = Field(..., description="邮件内容模板")
    template_type: str = Field(default='notification', description="模板类型")
    content_type: str = Field(default='html', description="内容类型")
    required_params: List[str] = Field(default_factory=list, description="必需参数")
    description: str = Field(default='', description="模板描述")

    @field_validator('template_name')
    @classmethod
    def validate_template_name(cls, v):
        if not v.strip():
            raise ValueError(get_text('service_validation.template_name_empty'))
        return v.strip()

    @field_validator('template_subject')
    @classmethod
    def validate_template_subject(cls, v):
        if not v.strip():
            raise ValueError(get_text('service_validation.template_subject_empty'))
        return v.strip()

    @field_validator('template_content')
    @classmethod
    def validate_template_content(cls, v):
        if not v.strip():
            raise ValueError(get_text('service_validation.template_content_empty'))
        return v.strip()

    @field_validator('template_type')
    @classmethod
    def validate_template_type(cls, v):
        valid_types = ['verification', 'welcome', 'notification', 'marketing', 'system', 'other']
        if v not in valid_types:
            raise ValueError(get_text('service_validation.template_type_invalid', types=", ".join(valid_types)))
        return v

    @field_validator('content_type')
    @classmethod
    def validate_content_type(cls, v):
        if v not in ['html', 'plain']:
            raise ValueError(get_text('service_validation.content_type_invalid'))
        return v


class UpdateEmailTemplateRequest(BaseModel):
    """更新邮件模板请求模型"""
    template_subject: Optional[str] = Field(None, description="邮件主题模板")
    template_content: Optional[str] = Field(None, description="邮件内容模板")
    template_type: Optional[str] = Field(None, description="模板类型")
    content_type: Optional[str] = Field(None, description="内容类型")
    required_params: Optional[List[str]] = Field(None, description="必需参数")
    description: Optional[str] = Field(None, description="模板描述")
    is_active: Optional[bool] = Field(None, description="是否启用")

    @field_validator('template_subject')
    @classmethod
    def validate_template_subject(cls, v):
        if v is not None and not v.strip():
            raise ValueError(get_text('service_validation.template_subject_empty'))
        return v.strip() if v else v

    @field_validator('template_content')
    @classmethod
    def validate_template_content(cls, v):
        if v is not None and not v.strip():
            raise ValueError(get_text('service_validation.template_content_empty'))
        return v.strip() if v else v
