"""
支付服务API Schema定义
"""

from ninja import Schema
from typing import Optional, Dict, Any, List
from datetime import datetime
from decimal import Decimal


# ============ 请求Schema ============

class CreateOrderRequest(Schema):
    """创建订单请求"""
    # 不再从请求体获取user_id，而是从JWT token获取
    order_type: str  # membership / credits / storage_package / billing_addon / cash_wallet
    payment_method: str  # alipay / wechat
    subject: str
    description: Optional[str] = ""
    amount: Decimal
    business_data: Dict[str, Any]  # 业务数据（会员tier_id、点券package_id、storage_package_id等）
    extra_params: Optional[Dict[str, Any]] = None  # 额外参数（支付类型等）


class QueryOrderRequest(Schema):
    """查询订单请求"""
    order_no: str


class CancelOrderRequest(Schema):
    """取消订单请求"""
    order_no: str


# ============ 响应Schema ============

class CreateOrderResponse(Schema):
    """创建订单响应"""
    success: bool
    message: str
    order_no: str
    order_id: str
    pay_url: Optional[str] = None
    qr_code: Optional[str] = None
    form_html: Optional[str] = None
    expired_at: datetime


class OrderStatusResponse(Schema):
    """订单状态响应"""
    order_no: str
    status: str
    order_type: str
    subject: str
    amount: Decimal
    paid_amount: Decimal
    payment_method: str
    created_at: datetime
    paid_at: Optional[datetime] = None
    expired_at: datetime
    status_reason: Optional[str] = None


class OrderListItemSchema(Schema):
    """订单列表中的单条订单摘要"""
    id: str
    order_no: str
    order_type: str
    subject: str
    amount: Decimal
    status: str
    payment_method: str
    created_at: datetime
    paid_at: Optional[datetime] = None
    expired_at: datetime
    status_reason: Optional[str] = None


class BaseResponse(Schema):
    """基础响应"""
    success: bool
    message: str
    data: Optional[Dict[str, Any]] = None
