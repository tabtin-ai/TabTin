"""Tabtin Space collection schemas。"""

from .common import *  # noqa: F401,F403

class CollectionCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255, description="文件夹名称")
    parent_id: Optional[UUID] = Field(default=None, description="父文件夹 ID，为 null 时创建在根级")
    icon: Optional[str] = Field(default='📁', max_length=50, description="图标")
    color: Optional[str] = Field(default='', max_length=20, description="颜色")
    order: Optional[int] = Field(default=None, description="排序，不传则自动递增")

class CollectionUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=255)
    parent_id: Optional[UUID] = Field(default=None, description="移动到的父文件夹 ID")
    icon: Optional[str] = Field(default=None, max_length=50)
    color: Optional[str] = Field(default=None, max_length=20)
    order: Optional[int] = None
    is_expanded: Optional[bool] = None
    is_pinned: Optional[bool] = Field(default=None, description="是否置顶")

class CollectionOut(BaseModel):
    id: UUID
    # ：org-only 文件夹（不挂 workspace/project）时 space_id 为 None。
    space_id: Optional[UUID] = None
    organization_id: Optional[UUID] = None
    parent_id: Optional[UUID] = None
    name: str
    icon: str = '📁'
    color: str = ''
    order: int = 0
    is_expanded: bool = True
    is_pinned: bool = False
    pinned_at: Optional[datetime] = None
    children: List['CollectionOut'] = Field(default_factory=list)
    item_count: int = Field(default=0, description="文件夹内资源数量（不含子文件夹）")
    created_by_id: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    model_config = ConfigDict(from_attributes=True)

    @model_validator(mode='before')
    @classmethod
    def _inject_space_id_from_host(cls, data):
        return coerce_host_space_id(data)

    @field_validator('children', mode='before')
    @classmethod
    def coerce_children(cls, v):
        """Django RelatedManager → list"""
        if not isinstance(v, list):
            return list(v.all()) if hasattr(v, 'all') else list(v)
        return v

class CollectionListResponse(BaseModel):
    collections: List[CollectionOut]
    total: int

class CollectionReorder(BaseModel):
    """批量重排同级文件夹顺序"""
    collection_ids: List[UUID] = Field(..., description="按新顺序排列的文件夹 ID 列表")
    parent_id: Optional[UUID] = Field(default=None, description="父文件夹 ID；null 表示根级")

class MoveItemsToCollection(BaseModel):
    """将资源移入/移出文件夹"""
    item_ids: List[UUID] = Field(..., description="要移动的 ContextItem ID 列表")
    collection_id: Optional[UUID] = Field(default=None, description="目标文件夹 ID，为 null 时移出文件夹")

class SharedResourcePlacementMove(BaseModel):
    resource_type: str = Field(..., pattern='^(doc|table|file)$')
    resource_id: UUID
    collection_id: Optional[UUID] = None

class ReorderCollectionItems(BaseModel):
    """重排文件夹内资源顺序"""
    collection_id: Optional[UUID] = Field(default=None, description="文件夹 ID；null 表示根层")
    item_ids: List[UUID] = Field(..., description="按新顺序排列的 ContextItem ID 列表")

__all__ = [
    'CollectionCreate',
    'CollectionUpdate',
    'CollectionOut',
    'CollectionListResponse',
    'CollectionReorder',
    'MoveItemsToCollection',
    'SharedResourcePlacementMove',
    'ReorderCollectionItems',
]
