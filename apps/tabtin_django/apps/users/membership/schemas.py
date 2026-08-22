"""
会员体系API Schema定义
"""

from ninja import Schema
from typing import Optional, Dict, Any, List, Literal
from datetime import datetime
from decimal import Decimal


# ============ 请求Schema ============

class MembershipTierListRequest(Schema):
    """会员等级列表请求"""
    active_only: bool = True


class MembershipActivateRequest(Schema):
    """会员激活请求"""
    tier_id: str
    user_id: str
    is_renewal: bool = False


# ============ 响应Schema ============

class MembershipTierResponse(Schema):
    """会员等级响应"""
    id: str
    tier_type: str
    name: str
    description: str
    price: Decimal
    duration_months: int
    max_tables: int
    max_documents: int = -1
    max_groups: int = -1
    max_records_per_table: int
    # Legacy, not enforced (D5/QTA-14) — 以下两个字段保留向后兼容但无实际执行力，
    # 前端不应基于这两个值做 UI 差异展示。传 None 表示该配额已废弃。
    max_api_calls_per_day: Optional[int] = None
    max_crawl_tasks_per_day: Optional[int] = None
    included_storage_bytes: int = 0
    included_llm_credits_monthly: Decimal = Decimal('0')
    max_members: int = -1
    base_seats: int = 1
    extra_seat_price: Decimal = Decimal('0')
    trash_retention_days: int = 30
    features: Dict[str, Any]
    sort_order: int
    display_order: int
    tier_level: int
    is_active: bool


class MembershipStatusResponse(Schema):
    """会员状态响应（用户级 — deprecated, 保留兼容）"""
    is_member: bool
    tier: Optional[Dict[str, Any]] = None
    end_date: Optional[datetime] = None
    is_expired: bool
    days_until_expiry: Optional[int] = None
    auto_renew: bool = False
    quotas: Dict[str, Any]
    features: Dict[str, Any]


class OrganizationMembershipStatusResponse(Schema):
    """组织会员状态响应"""
    organization_id: str
    membership_id: Optional[str] = None
    is_member: bool
    tier: Optional[Dict[str, Any]] = None
    lifecycle_state: str = "free"
    billing_cycle: str = "monthly"
    start_date: Optional[datetime] = None
    end_date: Optional[datetime] = None
    grace_period_end: Optional[datetime] = None
    is_expired: bool
    in_grace_period: bool = False
    grace_days_remaining: Optional[int] = None
    days_until_expiry: Optional[int] = None
    auto_renew: bool = False
    allowed_actions: List[str] = []
    can_upgrade: bool = False
    can_renew: bool = False
    can_manage: bool = False
    purchased_by: str = ''
    quotas: Dict[str, Any]
    quota_usage: Dict[str, Any] = {}
    features: Dict[str, Any]


class OrganizationPurchaseRequest(Schema):
    """组织会员购买请求"""
    tier_id: str
    payment_method: str
    billing_cycle: Optional[str] = "monthly"
    extra_params: Optional[Dict[str, Any]] = None


class OrganizationPurchasePreviewRequest(Schema):
    """组织会员购买预览。账期缺省时兼容为 monthly。"""
    tier_id: str
    billing_cycle: Optional[str] = "monthly"


class OrganizationUpgradePreviewRequest(Schema):
    """升级报价预览；字段名与生命周期 API 契约保持一致。"""
    target_tier_id: str
    billing_cycle: Optional[str] = "monthly"


class OrganizationUpgradeOrderRequest(Schema):
    """创建升级订单；金额和支付方式均由服务端冻结。"""
    target_tier_id: str
    billing_cycle: Optional[str] = "monthly"
    quote_token: str


class MembershipPaymentMethodSwitchRequest(Schema):
    """安全关闭当前扫码订单后，切换到新的第三方支付渠道。"""
    payment_method: Literal["alipay", "wechat"]


class OrganizationLifecycleTargetRequest(Schema):
    """降级 / 同级切换预览请求。"""
    target_tier_id: str
    billing_cycle: Optional[str] = "monthly"


class OrganizationLifecycleTargetApplyRequest(Schema):
    """降级 / 同级切换执行请求；quote_token 必须来自对应 preview。"""
    target_tier_id: str
    billing_cycle: Optional[str] = "monthly"
    quote_token: str


class OrganizationRenewalPreviewRequest(Schema):
    """手动续费预览请求。"""
    billing_cycle: Optional[str] = "monthly"


class OrganizationRenewalOrderRequest(Schema):
    """创建续费订单请求。"""
    billing_cycle: Optional[str] = "monthly"
    quote_token: str


class CancelScheduledChangeRequest(Schema):
    """取消预约降级/切换。"""
    reason: Optional[str] = "user_cancelled"


class AutoRenewRequest(Schema):
    """自动续费开关请求"""
    auto_renew: bool


class BaseResponse(Schema):
    """基础响应"""
    success: bool
    message: str
    data: Optional[Dict[str, Any]] = None
