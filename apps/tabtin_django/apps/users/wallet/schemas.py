"""
钱包系统API Schema定义
"""

from ninja import Schema
from typing import Optional, Dict, Any, List
from datetime import datetime
from decimal import Decimal


# ============ 请求Schema ============

class TransactionHistoryRequest(Schema):
    """交易历史请求"""
    user_id: str
    transaction_type: Optional[str] = None
    limit: int = 20
    offset: int = 0


# ============ 响应Schema ============

class WalletInfoResponse(Schema):
    """钱包信息响应"""
    credits: int
    credits_precise: Decimal
    credits_frozen: int
    credits_frozen_precise: Decimal
    available_credits: int
    available_credits_precise: Decimal


class OrganizationWalletInfoResponse(Schema):
    """组织钱包信息响应"""
    organization_id: str
    credits: int
    credits_precise: Decimal
    credits_frozen: int
    credits_frozen_precise: Decimal
    available_credits: int
    available_credits_precise: Decimal


class CreditPackageResponse(Schema):
    """点券套餐响应"""
    id: str
    name: str
    description: str
    price: Decimal
    credits_amount: int
    bonus_credits: int
    total_credits: int
    discount_percentage: float
    sort_order: int
    is_active: bool


class TransactionResponse(Schema):
    """交易记录响应"""
    id: str
    transaction_type: str
    amount: int
    amount_precise: Decimal
    balance_before: int
    balance_before_precise: Decimal
    balance_after: int
    balance_after_precise: Decimal
    organization_id: str
    description: str
    created_at: datetime
    related_order_id: Optional[str] = None
    reference_id: Optional[str] = None
    usage_event_id: Optional[str] = None
    meter_key: Optional[str] = None
    quantity: Optional[Decimal] = None
    unit_price: Optional[Decimal] = None
    unit: Optional[str] = None
    aggregation_key: Optional[str] = None
    charge_status: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None


class TransactionHistoryResponse(Schema):
    """交易历史响应"""
    total: int
    transactions: List[TransactionResponse]


class BaseResponse(Schema):
    """基础响应"""
    success: bool
    message: str
    data: Optional[Dict[str, Any]] = None
