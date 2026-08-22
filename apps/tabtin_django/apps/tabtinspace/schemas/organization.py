"""Tabtin Space organization schemas。"""

from .common import *  # noqa: F401,F403


def _normalize_logo_settings(settings: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not settings:
        return settings
    logo_ref = settings.get("logo_url")
    if not isinstance(logo_ref, str) or not logo_ref.strip():
        return settings
    try:
        from apps.services.oss.services.public_assets import build_public_asset_url
        logo_url = build_public_asset_url(logo_ref)
    except Exception:
        logo_url = logo_ref
    if logo_url == logo_ref:
        return settings
    return {**settings, "logo_url": logo_url}

class OrganizationBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=100, description="组织名称")
    description: Optional[str] = Field(None, max_length=1000, description="描述")
    icon: Optional[str] = Field(None, max_length=50, description="图标")

class OrganizationCreate(OrganizationBase):
    settings: Optional[Dict[str, Any]] = Field(default=None, description="组织设置")
    default_agent_device_fingerprint: Optional[str] = Field(default=None, description="默认 Space 绑定的执行设备指纹")
    default_agent_working_dir: Optional[str] = Field(default=None, description="默认 Space 工作目录")
    default_agent_working_dir_type: Optional[str] = Field(default=None, description="默认 Space 工作目录类型")

class OrganizationUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    icon: Optional[str] = None
    settings: Optional[Dict[str, Any]] = None

class OrganizationOut(OrganizationBase):
    id: UUID
    owner_id: str
    is_default: bool
    type: str = Field(default="team", description="组织类型：personal / team")
    member_count: Optional[int] = None
    space_count: Optional[int] = None
    settings: Optional[Dict[str, Any]] = None
    created_at: datetime
    updated_at: datetime
    model_config = ConfigDict(from_attributes=True)

    @field_validator("settings", mode="before")
    @classmethod
    def normalize_settings_public_assets(cls, value):
        if isinstance(value, dict):
            return _normalize_logo_settings(value)
        return value

class OrganizationListResponse(BaseModel):
    organizations: List[OrganizationOut]
    total: int

class OwnershipTransferRequest(BaseModel):
    new_owner_user_id: str = Field(..., description="新 owner 的用户 ID")

class AuditLogQuery(BaseModel):
    action_type: Optional[str] = None
    target_type: Optional[str] = None
    operator_id: Optional[str] = None
    date_from: Optional[str] = None
    date_to: Optional[str] = None
    page: int = Field(default=1, ge=1)
    limit: int = Field(default=50, ge=1, le=200)


__all__ = [
    'OrganizationBase',
    'OrganizationCreate',
    'OrganizationUpdate',
    'OrganizationOut',
    'OrganizationListResponse',
    'OwnershipTransferRequest',
    'AuditLogQuery',
]
