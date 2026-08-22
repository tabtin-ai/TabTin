"""Tabtin Space invitation schemas。"""

from .common import *  # noqa: F401,F403

# 两级模型（2026-06-10）：新邀请只允许授予 editor；存量 admin/viewer 邀请记录仍可展示。
class InvitationEmailCreate(BaseModel):
    email: str = Field(..., description="被邀请人邮箱")
    role: Literal['editor'] = Field(default='editor', description="授予角色")
    expires_hours: int = Field(default=72, ge=1, le=720, description="过期时间（小时）")

class InvitationLinkCreate(BaseModel):
    role: Literal['editor'] = Field(default='editor', description="授予角色")
    max_uses: int = Field(default=-1, description="最大使用次数，-1 表示无限制")
    expires_hours: int = Field(default=168, ge=1, le=720, description="过期时间（小时）")

class InvitationDirectCreate(BaseModel):
    user_id: str = Field(..., description="被邀请用户 ID")
    role: Literal['editor'] = Field(default='editor', description="授予角色")
    expires_hours: int = Field(default=72, ge=1, le=720, description="过期时间（小时）")

class InvitationPhoneCreate(BaseModel):
    phone: str = Field(..., description="被邀请人手机号（须为已注册用户）")
    role: Literal['editor'] = Field(default='editor', description="授予角色")
    expires_hours: int = Field(default=72, ge=1, le=720, description="过期时间（小时）")

class InvitationRespondRequest(BaseModel):
    accept: bool = Field(..., description="是否接受邀请")

class InvitationOut(BaseModel):
    id: UUID
    organization_id: UUID
    invited_by: str
    invite_type: str
    email: Optional[str] = None
    invited_user_id: Optional[str] = None
    invite_phone: Optional[str] = None
    # 列表/创建响应附带；非 ORM 字段，按 invited_user_id 解析 User 展示名
    invited_user_nickname: Optional[str] = None
    # 直接邀请在组织 Owner 的待处理列表中需要展示被邀请人的可读身份；保留
    # invited_user_id 以兼容既有客户端和管理链路。
    invited_user_phone: Optional[str] = None
    role: str
    token: str
    status: str
    expires_at: datetime
    max_uses: int
    use_count: int
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)

    @classmethod
    def from_invitation(
        cls,
        inv,
        invited_user_nickname: str = '',
        invited_user_phone: Optional[str] = None,
    ) -> 'InvitationOut':
        return cls(
            id=inv.id,
            organization_id=inv.organization_id,
            invited_by=inv.invited_by,
            invite_type=inv.invite_type,
            email=inv.email,
            invited_user_id=inv.invited_user_id or None,
            invite_phone=getattr(inv, 'invite_phone', '') or None,
            invited_user_nickname=invited_user_nickname or None,
            invited_user_phone=invited_user_phone,
            role=inv.role,
            token=inv.token,
            status=inv.status,
            expires_at=inv.expires_at,
            max_uses=inv.max_uses,
            use_count=inv.use_count,
            created_at=inv.created_at,
        )

class PendingInvitationOut(BaseModel):
    """被邀请者视角的邀请信息"""
    id: UUID
    organization_id: UUID
    organization_name: str = ''
    organization_icon: str = ''
    invited_by: str
    invited_by_name: str = ''
    role: str
    status: str
    expires_at: datetime
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)

    @classmethod
    def from_invitation(cls, inv, inviter_name: str = '') -> 'PendingInvitationOut':
        return cls(
            id=inv.id,
            organization_id=inv.organization_id,
            organization_name=inv.organization.name if inv.organization else '',
            organization_icon=inv.organization.icon if inv.organization else '',
            invited_by=inv.invited_by,
            invited_by_name=inviter_name,
            role=inv.role,
            status=inv.status,
            expires_at=inv.expires_at,
            created_at=inv.created_at,
        )

class InvitationAccept(BaseModel):
    token: str = Field(..., description="邀请令牌")

__all__ = [
    'InvitationEmailCreate',
    'InvitationLinkCreate',
    'InvitationDirectCreate',
    'InvitationPhoneCreate',
    'InvitationRespondRequest',
    'InvitationOut',
    'PendingInvitationOut',
    'InvitationAccept',
]
