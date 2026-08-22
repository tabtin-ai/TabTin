"""Tabtin Space context_item schemas。"""

from .common import *  # noqa: F401,F403

class ContextItemBase(BaseModel):
    item_type: str = Field(..., max_length=50, description="上下文类型")
    title: Optional[str] = Field(None, max_length=255, description="标题")
    preview: Optional[str] = Field(None, description="预览摘要")
    status: Optional[str] = Field(None, max_length=50, description="状态")
    resource_id: Optional[str] = Field(None, max_length=100, description="资源ID")
    metadata: Optional[Dict[str, Any]] = Field(default=None, description="元数据")
    order: Optional[int] = Field(default=0, description="排序")

class ContextItemCreate(ContextItemBase):
    pass

class ContextItemUpdate(BaseModel):
    title: Optional[str] = None
    preview: Optional[str] = None
    status: Optional[str] = None
    resource_id: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None
    order: Optional[int] = None
    is_archived: Optional[bool] = None
    is_pinned: Optional[bool] = None
    # ：显式传 null 表示移到根；省略字段表示不改
    parent_id: Optional[UUID] = None

class ContextItemOwnerOut(BaseModel):
    """用户展示信息（名字 + 头像）。用于创建者 created_by 与资源所有者 owner。"""
    id: str
    display_name: str = ""
    avatar: str = ""

class ContextItemOut(ContextItemBase):
    id: UUID
    # ：org-only 资源（不挂 workspace/project）时 space_id 为 None。
    space_id: Optional[UUID] = None
    organization_id: Optional[UUID] = None
    is_archived: bool
    is_pinned: bool = False
    pinned_at: Optional[datetime] = None
    collection_id: Optional[UUID] = None
    # ：知识库树父节点（ContextItem.parent）
    parent_id: Optional[UUID] = None
    created_by_id: Optional[str] = None
    updated_by_id: Optional[str] = None
    # created_by / owner / last_visited_at 由列表接口批量回填（router enrich），不走 ORM 属性。
    # 用 validation_alias 指向模型上不存在的属性名，避免 from_orm 误读 created_by(User) FK
    # 触发额外查询或校验失败；序列化输出仍用字段名 created_by / owner / last_visited_at。
    created_by: Optional[ContextItemOwnerOut] = Field(
        default=None, validation_alias="created_by_owner_info",
    )
    # 资源级真实所有者（Document/Table.owner_id）；与 created_by（创建审计）分离
    owner_id: Optional[str] = Field(default=None, validation_alias="resource_owner_id_value")
    owner: Optional[ContextItemOwnerOut] = Field(
        default=None, validation_alias="resource_owner_info",
    )
    last_visited_at: Optional[datetime] = Field(
        default=None, validation_alias="last_visited_at_value",
    )
    # ：资源级能力位（router enrich）；默认 False，避免前端误开危险操作
    can_view: bool = False
    can_edit: bool = False
    can_move: bool = False
    can_share: bool = False
    can_trash: bool = False
    can_delete: bool = False
    created_at: datetime
    updated_at: datetime
    # 不设 populate_by_name：created_by / last_visited_at 仅按 validation_alias 取值，
    # 避免 from_orm 回退读取模型上真实的 created_by(User) FK 触发额外查询/校验失败。
    # 这两个字段一律由 router enrich 写入 dict，不经 ORM 属性。
    model_config = ConfigDict(from_attributes=True)

    @model_validator(mode='before')
    @classmethod
    def _inject_space_id_from_host(cls, data):
        return coerce_host_space_id(data)

class TrashedContextItemOut(ContextItemOut):
    """回收站资源，额外包含回收时间和操作人"""
    trashed_at: Optional[datetime] = None
    trashed_by: Optional[UUID] = None
    previous_status: Optional[str] = None

class ContextItemListResponse(BaseModel):
    items: List[ContextItemOut]
    total: int
    page: int = 1
    page_size: int = 100


class ReorderKnowledgeTreeSiblings(BaseModel):
    """#7214：按 ContextItem.parent 同级重排（与云盘 collection_id 解耦）。"""
    item_ids: List[UUID] = Field(..., description="同级资源 ID 的新顺序")
    parent_id: Optional[UUID] = Field(
        default=None,
        description="父 ContextItem ID；null 表示云文档根节点同级",
    )

class OrganizationSearchItemOut(BaseModel):
    id: UUID
    item_type: str
    title: str = ""
    preview: str = ""
    resource_id: Optional[str] = None
    #  / ：org-only 云资产无 Workspace/Project 宿主，space_id 可为 null
    space_id: Optional[UUID] = None
    space_name: str = ""
    organization_id: Optional[UUID] = None
    collection_id: Optional[UUID] = None
    metadata: Optional[Dict[str, Any]] = None
    is_archived: bool = False
    is_pinned: bool = False
    updated_at: Optional[datetime] = None
    created_at: Optional[datetime] = None
    rank: float = 0
    # 云盘搜索行：与列表同口径回填位置 / owner / 访问时间 / capability
    created_by: Optional[ContextItemOwnerOut] = None
    owner_id: Optional[str] = None
    owner: Optional[ContextItemOwnerOut] = None
    last_visited_at: Optional[datetime] = None
    can_view: bool = False
    can_edit: bool = False
    can_move: bool = False
    can_share: bool = False
    can_trash: bool = False
    can_delete: bool = False

class SpaceResourceItem(BaseModel):
    """统一资源条目 — 跨模块的资源列表项"""
    type: str = Field(..., description="资源类型: tabdata / tabdoc / tabslide / tabvideo / tabwhiteboard / tabmemo / tabcode")
    id: str = Field(..., description="资源 ID")
    name: str = Field(..., description="资源名称")
    icon: str = Field(default="", description="图标 emoji")
    description: str = Field(default="", description="描述")
    created_at: str = Field(default="", description="创建时间 ISO 格式")
    updated_at: str = Field(default="", description="更新时间 ISO 格式")
    created_by: Optional[str] = Field(default=None, description="创建者 ID")
    metadata: Optional[Dict[str, Any]] = Field(default=None, description="资源特有元数据")

class SpaceResourceListResponse(BaseModel):
    """统一资源列表响应"""
    items: List[SpaceResourceItem]
    total: int
    by_type: Dict[str, int] = Field(default_factory=dict, description="按类型分组的计数")

__all__ = [
    'ContextItemBase',
    'ContextItemCreate',
    'ContextItemUpdate',
    'ContextItemOwnerOut',
    'ContextItemOut',
    'TrashedContextItemOut',
    'ContextItemListResponse',
    'ReorderKnowledgeTreeSiblings',
    'OrganizationSearchItemOut',
    'SpaceResourceItem',
    'SpaceResourceListResponse',
]
