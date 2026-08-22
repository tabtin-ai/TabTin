"""
短信服务Pydantic模型
"""

from typing import Dict, Any, Optional, List
from datetime import datetime
from pydantic import BaseModel, Field, field_validator
from ..common.utils import validate_phone_number
from apps.i18n import get_text


class SmsBaseRequest(BaseModel):
    """短信请求基础模型"""
    phone: str = Field(..., description="手机号码")

    @field_validator('phone')
    @classmethod
    def validate_phone_number(cls, v):
        if not validate_phone_number(v):
            raise ValueError(get_text('service_validation.invalid_phone_format'))
        return v


class SendSmsRequest(SmsBaseRequest):
    """发送短信请求模型"""
    template_code: str = Field(..., description="模板代码")
    template_params: Dict[str, Any] = Field(default_factory=dict, description="模板参数")

    @field_validator('template_code')
    @classmethod
    def validate_template_code(cls, v):
        if not v.strip():
            raise ValueError(get_text('service_validation.template_code_empty'))
        return v.strip()


class SendVerificationCodeRequest(SmsBaseRequest):
    """发送验证码请求模型"""
    code: str = Field(..., min_length=4, max_length=8, description="验证码")

    @field_validator('code')
    @classmethod
    def validate_code(cls, v):
        if not v.isdigit():
            raise ValueError(get_text('service_validation.verification_code_digits_only'))
        return v


class BatchSmsRequest(BaseModel):
    """批量发送短信请求模型"""
    phones: List[str] = Field(..., min_length=1, max_length=100, description="手机号码列表")
    template_code: str = Field(..., description="模板代码")
    template_params: Dict[str, Any] = Field(default_factory=dict, description="模板参数")

    @field_validator('phones')
    @classmethod
    def validate_phones(cls, v):
        for phone in v:
            if not validate_phone_number(phone):
                raise ValueError(get_text('service_validation.invalid_phone_number', phone=phone))
        return v

    @field_validator('template_code')
    @classmethod
    def validate_template_code(cls, v):
        if not v.strip():
            raise ValueError(get_text('service_validation.template_code_empty'))
        return v.strip()


class QueryStatusRequest(BaseModel):
    """查询状态请求模型"""
    message_id: str = Field(..., description="消息ID")

    @field_validator('message_id')
    @classmethod
    def validate_message_id(cls, v):
        if not v.strip():
            raise ValueError(get_text('service_validation.message_id_empty'))
        return v.strip()


class SmsResponse(BaseModel):
    """短信响应基础模型"""
    success: bool = Field(..., description="是否成功")
    message: str = Field(..., description="响应消息")
    timestamp: str = Field(..., description="时间戳")
    error_code: Optional[str] = Field(None, description="错误代码")
    data: Optional[Dict[str, Any]] = Field(None, description="响应数据")


class SendSmsResponse(SmsResponse):
    """发送短信响应模型"""

    class SendSmsData(BaseModel):
        message_id: str = Field(..., description="消息ID")
        request_id: str = Field(..., description="请求ID")
        aliyun_request_id: Optional[str] = Field(None, description="阿里云请求ID")

    data: Optional[SendSmsData] = None


class BatchSmsResponse(SmsResponse):
    """批量发送短信响应模型"""

    class BatchSmsData(BaseModel):
        total: int = Field(..., description="总数")
        success_count: int = Field(..., description="成功数量")
        failed_count: int = Field(..., description="失败数量")
        results: List[Dict[str, Any]] = Field(..., description="详细结果")

    data: Optional[BatchSmsData] = None


class QueryStatusResponse(SmsResponse):
    """查询状态响应模型"""

    class QueryStatusData(BaseModel):
        total_count: int = Field(..., description="总数量")
        details: List[Dict[str, Any]] = Field(..., description="详细信息")

    data: Optional[QueryStatusData] = None


class SmsRecordResponse(BaseModel):
    """短信记录响应模型"""
    id: str = Field(..., description="记录ID")
    phone_number: str = Field(..., description="手机号码")
    template_code: str = Field(..., description="模板代码")
    template_params: Dict[str, Any] = Field(..., description="模板参数")
    sign_name: str = Field(..., description="短信签名")
    content: str = Field(..., description="短信内容")
    status: str = Field(..., description="发送状态")
    provider: str = Field(..., description="服务提供商")
    message_id: Optional[str] = Field(None, description="消息ID")
    error_code: Optional[str] = Field(None, description="错误代码")
    error_message: Optional[str] = Field(None, description="错误消息")
    created_at: datetime = Field(..., description="创建时间")
    sent_at: Optional[datetime] = Field(None, description="发送时间")
    delivered_at: Optional[datetime] = Field(None, description="送达时间")
    retry_count: int = Field(..., description="重试次数")
    cost: Optional[float] = Field(None, description="费用")


class SmsRecordListResponse(BaseModel):
    """短信记录列表响应模型"""
    total: int = Field(..., description="总数")
    page: int = Field(..., description="当前页")
    page_size: int = Field(..., description="每页大小")
    records: List[SmsRecordResponse] = Field(..., description="记录列表")


class SmsTemplateResponse(BaseModel):
    """短信模板响应模型"""
    id: str = Field(..., description="模板ID")
    template_code: str = Field(..., description="模板代码")
    template_name: str = Field(..., description="模板名称")
    template_content: str = Field(..., description="模板内容")
    template_type: str = Field(..., description="模板类型")
    status: str = Field(..., description="审核状态")
    provider: str = Field(..., description="服务提供商")
    required_params: List[str] = Field(..., description="必需参数")
    is_active: bool = Field(..., description="是否启用")
    created_at: datetime = Field(..., description="创建时间")
    updated_at: datetime = Field(..., description="更新时间")


class SmsStatisticsResponse(BaseModel):
    """短信统计响应模型"""
    date: str = Field(..., description="统计日期")
    provider: str = Field(..., description="服务提供商")
    template_code: str = Field(..., description="模板代码")
    total_sent: int = Field(..., description="发送总数")
    success_count: int = Field(..., description="成功数量")
    failed_count: int = Field(..., description="失败数量")
    delivered_count: int = Field(..., description="送达数量")
    success_rate: float = Field(..., description="成功率")
    delivery_rate: float = Field(..., description="送达率")
    total_cost: Optional[float] = Field(None, description="总费用")


class ServiceStatusResponse(BaseModel):
    """服务状态响应模型"""
    provider: str = Field(..., description="服务提供商")
    status: str = Field(..., description="服务状态")
    config_valid: bool = Field(..., description="配置是否有效")
    last_check: datetime = Field(..., description="最后检查时间")
    features: List[str] = Field(..., description="支持的功能")
    regions: List[str] = Field(..., description="支持的地域")


class HealthCheckResponse(BaseModel):
    """健康检查响应模型"""
    service: str = Field(..., description="服务名称")
    status: str = Field(..., description="服务状态")
    version: str = Field(..., description="版本号")
    timestamp: datetime = Field(..., description="检查时间")
    dependencies: Dict[str, str] = Field(..., description="依赖服务状态")


# 请求查询参数模型
class SmsRecordQueryParams(BaseModel):
    """短信记录查询参数"""
    phone: Optional[str] = Field(None, description="手机号码")
    template_code: Optional[str] = Field(None, description="模板代码")
    status: Optional[str] = Field(None, description="发送状态")
    start_date: Optional[str] = Field(None, description="开始日期")
    end_date: Optional[str] = Field(None, description="结束日期")
    page: int = Field(1, ge=1, description="页码")
    page_size: int = Field(20, ge=1, le=100, description="每页大小")


class SmsStatisticsQueryParams(BaseModel):
    """短信统计查询参数"""
    provider: Optional[str] = Field(None, description="服务提供商")
    template_code: Optional[str] = Field(None, description="模板代码")
    start_date: Optional[str] = Field(None, description="开始日期")
    end_date: Optional[str] = Field(None, description="结束日期")
