"""Tabtin Space space schemas。"""

from .common import *  # noqa: F401,F403
from .agent import WorkingDirType, _normalize_working_dir

class SpaceBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=100, description="Space 名称")
    description: Optional[str] = Field(None, max_length=1000, description="Space 描述")
    icon: Optional[str] = Field(None, max_length=50, description="Space 图标")
    avatar: Optional[str] = Field(None, max_length=500, description="头像文件引用或展示 URL")
    color: Optional[str] = Field(None, max_length=20, description="标签颜色")

class SpaceCreate(SpaceBase):
    organization_id: UUID = Field(..., description="所属组织ID")
    type: Optional[str] = Field(default="workspace", description="Space 类型：workspace/team_space")
    agent_id: Optional[UUID] = Field(default=None, description="兼容关联 Agent ID（可选）")
    execution_space_id: Optional[UUID] = Field(default=None, description="团队 Space 固定执行的个人 Space ID")
    device_id: Optional[UUID] = Field(default=None, description="Space 执行设备 ID")
    working_dir: Optional[str] = Field(default=None, description="Space 在执行设备上的工作目录绝对路径")
    working_dir_type: Optional[WorkingDirType] = Field(default=None, description="工作目录类型：code/mixed/doc")
    custom_rules: Optional[str] = Field(
        default=None,
        max_length=5000,
        description="进入此 Workspace 后的现场自定义规则（ 落 Workspace.custom_rules，不写 Agent）",
    )
    status: Optional[str] = Field(default='active', description="Space 状态")
    order: Optional[int] = Field(default=0, description="排序")

    @field_validator('working_dir')
    @classmethod
    def _validate_working_dir(cls, v: Optional[str]) -> Optional[str]:
        return _normalize_working_dir(v)

class SpaceUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    description: Optional[str] = None
    icon: Optional[str] = None
    avatar: Optional[str] = Field(None, max_length=500, description="头像文件引用或展示 URL，传空字符串清除")
    color: Optional[str] = None
    status: Optional[str] = None
    order: Optional[int] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    expected_version: Optional[int] = Field(default=None, description="CAS 乐观并发控制：传入当前 config_version，版本不匹配时返回 409")

class SpaceOut(SpaceBase):
    id: UUID
    organization_id: UUID
    project_id: Optional[UUID] = Field(default=None, description="所属 Project ID（Project 创建的 Workspace）")
    agent_id: Optional[UUID] = Field(default=None, description="兼容关联 Agent ID（可选）")
    execution_space_id: Optional[UUID] = Field(default=None, description="团队 Space 固定执行的个人 Space ID")
    execution_agent_id: Optional[UUID] = Field(default=None, description="当前 Space 解析出的执行 Agent ID")
    execution_binding_source: Optional[str] = Field(default=None, description="执行 Agent 的解析来源")
    owner_execution_device_id: Optional[UUID] = Field(default=None, description="团队 Space Owner 执行设备 ID")
    owner_execution_device_name: str = Field(default="", description="团队 Space Owner 执行设备名称")
    owner_execution_device_status: str = Field(default="", description="团队 Space Owner 执行设备状态")
    bound_device_id: Optional[UUID] = Field(default=None, description="Space 绑定设备 ID")
    control_device_id: Optional[UUID] = Field(default=None, description="Space 执行设备 ID")
    working_dir: str = Field(default="", description="Space 工作目录绝对路径")
    normalized_working_dir: str = Field(default="", description="Space 标准化工作目录")
    working_dir_type: str = Field(default="", description="工作目录类型：code/mixed/doc")
    type: str
    status: str
    table_count: int
    order: int
    is_archived: bool
    is_default: bool
    visibility: str = Field(default='private', description='可见范围：private=仅创建者，shared=已共享')
    member_count: int = Field(default=1, description='当前有效成员数（含 owner）')
    config_version: int = Field(default=0, description="配置版本号（CAS 乐观并发控制）")
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    last_activity_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime
    model_config = ConfigDict(from_attributes=True)

class SpaceListResponse(BaseModel):
    spaces: List[SpaceOut]
    total: int

class SpaceStatsResponse(BaseModel):
    space_id: str
    space_name: str
    status: str
    is_archived: bool
    table_count: int
    active_table_count: int
    total_records: int
    created_at: str
    updated_at: str

class SpaceStatusUpdate(BaseModel):
    status: str = Field(..., description="新状态：active/paused/completed/archived")

class SpaceAppsSettingsUpdate(BaseModel):
    disabled_apps: Optional[List[str]] = Field(default=None, description="禁用的 APP 列表")

class SpaceAppOut(BaseModel):
    """单个 APP 在 Space 中的状态"""
    id: str = Field(..., description="APP 唯一标识")
    name: str = Field(..., description="显示名")
    icon: str = Field(default="", description="图标标识")
    icon_asset: Optional[dict] = Field(
        default=None,
        description="包内 SVG 图标资产描述（default/variants/presentation/aliases）",
    )
    can_create: bool = Field(default=True, description="是否可新建")
    searchable: bool = Field(default=False, description="是否可搜索")
    enabled: bool = Field(default=True, description="是否启用")
    order: int = Field(default=0, description="排序权重")
    # ── ui_contract（additive，前端按需消费） ──
    desktop_group: str = Field(default="", description="Desktop 分组: cloudResources/localResources/capabilities/extensions")
    category: str = Field(default="", description="应用分类 ID")
    context_type: Optional[str] = Field(default=None, description="Agent 上下文类型标识")
    ui_runtime: str = Field(default="", description="UI 呈现方式: localBundle/embeddedWeb/iframe")
    distribution: str = Field(default="builtin", description="来源: builtin/marketplace")
    install_scope: str = Field(default="organization", description="安装层: organization/device")
    surface: Optional[str] = Field(
        default=None,
        description="应用形态（三态分类 SSOT）: builtin/local/collaborative；技能包等未声明为 null",
    )
    embedded_web: Optional[dict] = Field(default=None, description="embeddedWeb 配置（含 baseUrl/urlPatterns/sessionMode）")
    context_url_field: str = Field(default="", description="embeddedWeb 主 context 字段名（如 current_<app>_url）")

__all__ = [
    'SpaceBase',
    'SpaceCreate',
    'SpaceUpdate',
    'SpaceOut',
    'SpaceListResponse',
    'SpaceStatsResponse',
    'SpaceStatusUpdate',
    'SpaceAppsSettingsUpdate',
    'SpaceAppOut',
]
