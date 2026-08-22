"""
AdminDash 用户管理 Schema 定义
"""

from datetime import datetime
from decimal import Decimal
from typing import Any, Dict, List, Optional

from ninja import Schema


class AdminInviteCodeCreateRequestSchema(Schema):
    """创建邀请码请求。"""

    code: Optional[str] = None
    generate_count: int = 1
    code_length: int = 10
    description: str = ""
    channel: str
    campaign: str = ""
    is_active: bool = True
    starts_at: Optional[datetime] = None
    expires_at: Optional[datetime] = None
    usage_limit: Optional[int] = 1


class AdminInviteCodeUpdateRequestSchema(Schema):
    """更新邀请码请求。"""

    description: Optional[str] = None
    channel: Optional[str] = None
    campaign: Optional[str] = None
    is_active: Optional[bool] = None
    starts_at: Optional[datetime] = None
    expires_at: Optional[datetime] = None
    usage_limit: Optional[int] = None


class AdminSensitiveActionRequestSchema(Schema):
    """敏感操作通用请求。"""

    reason: str = ""
    ticket_id: str = ""


class AdminInviteCodeItemSchema(Schema):
    """邀请码列表项。"""

    id: str
    code: str
    description: str
    channel: str
    campaign: str
    is_active: bool
    status: str
    starts_at: Optional[datetime] = None
    expires_at: Optional[datetime] = None
    usage_limit: Optional[int] = None
    used_count: int
    remaining_uses: Optional[int] = None
    created_by_display_name: str = ""
    created_at: datetime
    updated_at: datetime
    disabled_at: Optional[datetime] = None


class AdminInviteCodeSummarySchema(Schema):
    """邀请码汇总指标。"""

    total_codes: int
    active_codes: int
    available_codes: int
    used_count: int
    recent_7d_redemptions: int


class AdminInvitePaginationSchema(Schema):
    """邀请码分页信息。"""

    total: int
    page: int
    page_size: int
    total_pages: int


class AdminInviteCodeListResponseSchema(Schema):
    """邀请码列表响应。"""

    items: List[AdminInviteCodeItemSchema]
    pagination: AdminInvitePaginationSchema
    summary: AdminInviteCodeSummarySchema


class AdminInviteCodeMutationResponseSchema(Schema):
    """邀请码变更响应。"""

    success: bool
    message: str
    items: List[AdminInviteCodeItemSchema]


class AdminInviteRedemptionItemSchema(Schema):
    """邀请码使用记录。"""

    id: str
    user_id: str
    user_display_name: str
    user_email: Optional[str] = None
    user_phone: Optional[str] = None
    identifier_hash: str
    entrypoint: str
    ip_address: Optional[str] = None
    user_agent: str
    consumed_at: datetime


class AdminInviteRedemptionListResponseSchema(Schema):
    """邀请码使用记录响应。"""

    items: List[AdminInviteRedemptionItemSchema]
    pagination: AdminInvitePaginationSchema


class AdminIntentUserItemSchema(Schema):
    """意向客户列表项。"""

    id: str
    phone: str
    created_at: datetime


class AdminIntentUserSummarySchema(Schema):
    """意向客户汇总指标。"""

    total_users: int
    recent_7d_users: int


class AdminIntentUserListResponseSchema(Schema):
    """意向客户列表响应。"""

    items: List[AdminIntentUserItemSchema]
    pagination: AdminInvitePaginationSchema
    summary: AdminIntentUserSummarySchema


class AdminWalletSummarySchema(Schema):
    """钱包摘要"""

    credits: int = 0
    credits_precise: Decimal = Decimal("0")
    credits_frozen: int = 0
    credits_frozen_precise: Decimal = Decimal("0")


class AdminUserOrganizationSummarySchema(Schema):
    """用户所属组织摘要（列表页）"""

    organization_count: int = 0
    primary_organization_id: Optional[str] = None
    primary_organization_name: Optional[str] = None


class AdminUserListItemSchema(Schema):
    """用户列表项"""

    id: str
    username: Optional[str] = None
    nickname: Optional[str] = None
    display_name: str
    email: Optional[str] = None
    phone: Optional[str] = None
    role: str
    status: str
    is_staff: bool
    is_superuser: bool
    is_verified_email: bool
    is_verified_phone: bool
    date_joined: datetime
    last_login: Optional[datetime] = None
    login_count: int
    failed_login_attempts: int
    active_session_count: int
    wallet: Optional[AdminWalletSummarySchema] = None
    organization_summary: Optional[AdminUserOrganizationSummarySchema] = None


class AdminUserPaginationSchema(Schema):
    """分页信息"""

    total: int
    page: int
    page_size: int
    total_pages: int


class AdminUserOrganizationItemSchema(Schema):
    """用户加入的单个组织"""

    membership_id: str
    organization_id: str
    organization_name: str
    organization_type: str
    organization_status: str
    is_default: bool
    role: str
    member_count: int
    owner_id: str
    joined_at: datetime


class AdminUserOrganizationListResponseSchema(Schema):
    """用户加入的组织列表"""

    organizations: List[AdminUserOrganizationItemSchema]
    total: int
    pagination: AdminUserPaginationSchema


class AdminUserSummarySchema(Schema):
    """用户总览统计"""

    total_users: int
    filtered_users: int
    active_users: int
    inactive_users: int
    admin_users: int
    operator_users: int
    normal_users: int


class AdminUserListResponseSchema(Schema):
    """用户列表响应"""

    items: List[AdminUserListItemSchema]
    pagination: AdminUserPaginationSchema
    summary: AdminUserSummarySchema


class AdminIntentUserItemSchema(Schema):
    """意向用户列表项"""

    id: str
    phone: str
    created_at: datetime


class AdminIntentUserSummarySchema(Schema):
    """意向用户总览统计"""

    total_intent_users: int
    filtered_intent_users: int


class AdminIntentUserListResponseSchema(Schema):
    """意向用户列表响应"""

    items: List[AdminIntentUserItemSchema]
    pagination: AdminUserPaginationSchema
    summary: AdminIntentUserSummarySchema


class AdminUserSessionSchema(Schema):
    """用户会话摘要"""

    id: str
    session_type: str
    ip_address: str
    user_agent: str
    created_at: datetime
    last_activity: datetime
    expires_at: datetime
    is_active: bool


class AdminUserActionLogSchema(Schema):
    """用户行为日志摘要"""

    id: str
    action_type: str
    description: str
    success: bool
    ip_address: str
    created_at: datetime


class AdminUserDetailResponseSchema(Schema):
    """用户详情响应"""

    user: AdminUserListItemSchema
    sessions: List[AdminUserSessionSchema]
    recent_actions: List[AdminUserActionLogSchema]


class AdminUserStatusUpdateSchema(Schema):
    """账号状态更新请求"""

    status: str
    reason: str
    ticket_id: str = ""


class AdminUserRoleUpdateSchema(Schema):
    """用户角色更新请求（Deprecated: use AdminAccount role assignment APIs instead）"""

    role: str
    reason: str
    ticket_id: str = ""


class AdminUserMutationResponseSchema(Schema):
    """用户更新响应"""

    success: bool
    message: str
    user: AdminUserListItemSchema


class AdminUserBatchStatusUpdateSchema(Schema):
    """批量账号状态更新请求"""

    user_ids: List[str]
    status: str
    reason: str
    ticket_id: str = ""


class AdminUserBatchRoleUpdateSchema(Schema):
    """批量用户角色更新请求（Deprecated: use AdminAccount role assignment APIs instead）"""

    user_ids: List[str]
    role: str
    reason: str
    ticket_id: str = ""


class AdminBatchSkipItemSchema(Schema):
    """批量处理跳过项"""

    user_id: str
    reason: str


class AdminUserBatchMutationResponseSchema(Schema):
    """批量用户更新响应"""

    success: bool
    message: str
    requested_count: int
    processed_count: int
    updated_count: int
    skipped: List[AdminBatchSkipItemSchema]
    items: List[AdminUserListItemSchema]


class AdminDirtyUserCleanupByPhoneRequestSchema(Schema):
    """开发/测试环境临时清理脏用户数据请求"""

    phone: str
    dry_run: bool = True
    include_search: bool = True
    confirm_phone: Optional[str] = None
    confirmation: str = ""


class AdminDirtyUserCleanupResponseSchema(Schema):
    """开发/测试环境临时清理脏用户数据响应"""

    success: bool
    message: str
    dry_run: bool
    user_id: Optional[str] = None
    phone: str
    username: Optional[str] = None
    counts_before: Dict[str, Any]
    cleanup_stats: Optional[Dict[str, Any]] = None
    delete_result: Optional[Dict[str, Any]] = None
    search_cleanup_output: str = ""
    counts_after: Optional[Dict[str, Any]] = None


class AdminAuditExportRequestSchema(Schema):
    """审计导出请求"""

    user_ids: Optional[List[str]] = None
    action_type: Optional[str] = None
    success: Optional[bool] = None
    keyword: Optional[str] = None
    start_at: Optional[datetime] = None
    end_at: Optional[datetime] = None
    limit: int = 5000


# ── 用户钱包交易记录 ──


class AdminWalletTransactionSchema(Schema):
    """钱包交易记录"""

    id: str
    transaction_type: str
    amount: int
    amount_precise: Decimal
    balance_before: int
    balance_before_precise: Decimal
    balance_after: int
    balance_after_precise: Decimal
    description: str
    operator_user_id: str = ""
    operator_display_name: str = ""
    related_order_id: str = ""
    organization_id: str = ""
    created_at: Optional[datetime] = None


class AdminWalletTransactionsResponseSchema(Schema):
    """钱包交易记录列表响应"""

    wallet_id: Optional[str] = None
    credits: int = 0
    credits_precise: Decimal = Decimal("0")
    credits_frozen: int = 0
    transactions: List[AdminWalletTransactionSchema]
    total: int
    page: int
    page_size: int
    total_pages: int


class AdminUserRechargeRequestSchema(Schema):
    """管理员给用户充值请求"""

    amount: int
    description: str = ""


class AdminUserRechargeResponseSchema(Schema):
    """管理员给用户充值响应"""

    success: bool
    message: str
    wallet_id: str
    credits_before: int
    credits_after: int
    amount: int


# ── AdminDash 后台治理 ──


class AdminAccountItemSchema(Schema):
    id: str
    user_id: str
    display_name: str
    email: Optional[str] = None
    phone: Optional[str] = None
    employee_no: str = ""
    department: str = ""
    position: str = ""
    status: str
    admin_login_enabled: bool
    role_codes: List[str]
    last_admin_login_at: Optional[datetime] = None
    last_admin_login_ip: Optional[str] = None
    created_at: datetime


class AdminAccountListResponseSchema(Schema):
    items: List[AdminAccountItemSchema]
    total: int
    page: int
    page_size: int
    total_pages: int


class AdminAccountMutationRequestSchema(Schema):
    user_id: str
    display_name: str = ""
    employee_no: str = ""
    department: str = ""
    position: str = ""
    admin_login_enabled: bool = True
    role_codes: List[str] = []
    reason: str
    ticket_id: str = ""


class AdminAccountUpdateRequestSchema(Schema):
    display_name: Optional[str] = None
    employee_no: Optional[str] = None
    department: Optional[str] = None
    position: Optional[str] = None
    admin_login_enabled: Optional[bool] = None
    status: Optional[str] = None
    role_codes: Optional[List[str]] = None
    reason: str
    ticket_id: str = ""


class AdminPermissionItemSchema(Schema):
    code: str
    name: str
    category: str
    risk_level: str
    description: str = ""
    is_active: bool


class AdminRoleItemSchema(Schema):
    id: str
    code: str
    name: str
    description: str = ""
    is_system: bool
    is_active: bool
    permission_codes: List[str]


class AdminRoleCreateRequestSchema(Schema):
    code: str
    name: str
    description: str = ""
    permission_codes: List[str] = []
    reason: str
    ticket_id: str = ""


class AdminRoleUpdateRequestSchema(Schema):
    name: Optional[str] = None
    description: Optional[str] = None
    is_active: Optional[bool] = None
    reason: str
    ticket_id: str = ""


class AdminRolePermissionsUpdateSchema(Schema):
    permission_codes: List[str]
    reason: str
    ticket_id: str = ""


class AdminSensitiveActionItemSchema(Schema):
    id: str
    actor_user_id: Optional[str] = None
    actor_admin_account_id: Optional[str] = None
    actor_display_name: str = ""
    permission_code: str
    action: str
    target_type: str
    target_id: str
    reason: str
    ticket_id: str
    before_json: Dict[str, Any]
    after_json: Dict[str, Any]
    ip: Optional[str] = None
    request_id: str = ""
    created_at: datetime


class AdminSensitiveActionListResponseSchema(Schema):
    items: List[AdminSensitiveActionItemSchema]
    total: int
    page: int
    page_size: int
    total_pages: int


class AdminLoginLogItemSchema(Schema):
    id: str
    admin_account_id: Optional[str] = None
    user_id: str
    display_name: str = ""
    ip: Optional[str] = None
    login_method: str
    success: bool
    fail_reason: str
    created_at: datetime


class AdminLoginLogListResponseSchema(Schema):
    items: List[AdminLoginLogItemSchema]
    total: int
    page: int
    page_size: int
    total_pages: int
