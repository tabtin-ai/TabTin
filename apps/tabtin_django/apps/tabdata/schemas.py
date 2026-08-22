

"""
TabData Pydantic Schema 定义

用于 API 请求和响应的数据验证和序列化
"""
from typing import Optional, List, Dict, Any, Generic, TypeVar, Literal, Union
from datetime import datetime
from pydantic import BaseModel, Field, ConfigDict, field_validator, ValidationInfo, model_validator
from uuid import UUID

from apps.tabdata.constants import MAX_BULK_FIELDS, MAX_BULK_RECORDS
from apps.tabdata.view_column_meta_compat import log_legacy_view_column_meta_alias_usage

# ============ 统一响应 Schema ============
# 从 common 导入并 re-export，保持现有 import 路径兼容
# e.g.  from apps.tabdata.schemas import StandardResponse  仍然有效

from apps.services.common.base_schemas import StandardResponse, ErrorResponse  # noqa: F401

T = TypeVar('T')



# ============ 现有 Schema 保持不变 ============


# ============ 旧版响应 Schema (兼容) ============

class BaseResponse(BaseModel):
    """基础响应模型 (已废弃,使用 StandardResponse)"""
    success: bool = True
    message: str = ""


# ============ Table Schema ============

class TableBase(BaseModel):
    """表格基础模型"""
    name: str = Field(..., min_length=1, max_length=100, description="表格名称")
    description: Optional[str] = Field(None, max_length=500, description="表格描述")
    icon: Optional[str] = Field(None, max_length=50, description="表格图标")


class TableCreate(TableBase):
    """创建表格请求。

    ：表只挂 Organization；不再接受 ``space_id``。
    """
    organization_id: UUID = Field(..., description="所属 Organization ID")
    use_default_fields: bool = Field(default=True, description="是否使用默认字段模板（ID、标题、状态、创建时间）")
    schema_history_id: Optional[UUID] = Field(None, description="关联的 Schema 历史记录 ID")
    default_source_url: Optional[str] = Field(None, description="默认数据源 URL")
    collection_id: Optional[UUID] = Field(None, description="云盘合集 ID（写入 ContextItem.collection_id）")
    parent_item_id: Optional[UUID] = Field(
        None, description="#7160 知识库树父 ContextItem ID（写入 ContextItem.parent）",
    )


class TableCreateHierarchical(TableBase):
    """遗留层级 API 创建表格请求（URL 中的 space_id 已忽略，表直属 Organization）。"""
    use_default_fields: bool = Field(default=True, description="是否使用默认字段模板（ID、标题、状态、创建时间）")
    schema_history_id: Optional[UUID] = Field(None, description="关联的 Schema 历史记录 ID")
    default_source_url: Optional[str] = Field(None, description="默认数据源 URL")
    collection_id: Optional[UUID] = Field(None, description="云盘合集 ID（写入 ContextItem.collection_id）")
    parent_item_id: Optional[UUID] = Field(
        None, description="#7160 知识库树父 ContextItem ID（写入 ContextItem.parent）",
    )


class TableUpdate(BaseModel):
    """更新表格请求"""
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    description: Optional[str] = None
    icon: Optional[str] = None


class TableOut(TableBase):
    """表格响应"""
    id: UUID
    # ：org-only 表直属 Organization，无 Space 宿主时为 null
    space_id: Optional[UUID] = None
    organization_id: Optional[UUID] = None
    owner_id: str  # UUID字符串 (修正: Table模型使用owner而非created_by)
    default_view_id: Optional[str] = None  # UUID字符串
    schema_history_id: Optional[str] = None  # UUID字符串
    default_source_url: Optional[str] = None
    row_count: Optional[int] = 0
    field_count: int = 0
    schema_version: int = 0
    visibility: str = "normal"  # normal / system / hidden
    is_public: bool = False
    is_template: bool = False
    is_archived: bool
    current_user_role: Optional[str] = Field(
        None,
        description="当前用户对该表格的角色：owner / admin / editor / viewer，"
                    "未认证或无法计算时为 null（向后兼容）"
    )
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)

    @classmethod
    def from_orm(cls, obj, current_user_role: Optional[str] = None):
        """自定义ORM转换，确保UUID字段正确转换为字符串"""
        data = {
            'id': obj.id,
            'space_id': obj.space_id,
            'organization_id': getattr(obj, 'organization_id', None),
            'owner_id': str(obj.owner_id) if obj.owner_id else None,
            'name': obj.name,
            'description': obj.description,
            'icon': obj.icon,
            'default_view_id': str(obj.default_view_id) if obj.default_view_id else None,
            'schema_history_id': str(obj.schema_history_id) if obj.schema_history_id else None,
            'default_source_url': obj.default_source_url or '',
            'row_count': None if getattr(obj, 'rls_enabled', False) else obj.row_count,
            'field_count': obj.field_count,
            'schema_version': obj.schema_version,
            'visibility': obj.visibility,
            'is_public': obj.is_public,
            'is_template': obj.is_template,
            'is_archived': obj.is_archived,
            'current_user_role': current_user_role,
            'created_at': obj.created_at,
            'updated_at': obj.updated_at,
        }
        return cls(**data)


class TableListResponse(BaseModel):
    """表格列表响应"""
    tables: List[TableOut]
    total: int


# ============ Field Schema ============


def _validate_field_type(v: str) -> str:
    """字段类型合法性校验（供多个 Schema 复用）"""
    from apps.tabdata.models import TableField
    valid_types = {choice[0] for choice in TableField.FIELD_TYPE_CHOICES}
    from apps.tabdata.services.table_service import FIELD_TYPE_ALIASES
    if v in valid_types:
        return v
    if v in FIELD_TYPE_ALIASES:
        return FIELD_TYPE_ALIASES[v]
    raise ValueError(f"不支持的字段类型: {v}")


class TableFieldBase(BaseModel):
    """字段基础模型。"""
    name: str = Field(..., min_length=1, max_length=100, description="字段名称")
    field_type: str = Field(..., description="字段类型（text/number/select/...）")
    default_value: Optional[Dict[str, Any]] = Field(default=None, description="字段默认值")
    description: Optional[str] = Field(None, max_length=500, description="字段描述")
    options: Optional[Dict[str, Any]] = Field(default=None, description="字段配置选项")

    @field_validator('field_type')
    @classmethod
    def validate_field_type_value(cls, v: str) -> str:
        return _validate_field_type(v)

class TableFieldCreate(TableFieldBase):
    """创建字段请求"""
    table_id: UUID = Field(..., description="所属表格ID")
    validation_rules: Optional[Dict[str, Any]] = Field(
        None,
        description="字段验证规则（min_length/max_length/pattern 等）",
    )
    insert_position: Optional[str] = Field(
        None,
        description="插入位置：before（在参考字段之前）、after（在参考字段之后）、不指定则添加到末尾",
        pattern="^(before|after)$"
    )
    reference_field_id: Optional[UUID] = Field(
        None,
        description="参考字段ID（与insert_position配合使用，指定在哪个字段前/后插入）"
    )


class TableFieldUpdate(BaseModel):
    """更新字段请求"""
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    description: Optional[str] = None
    default_value: Optional[Dict[str, Any]] = None
    options: Optional[Dict[str, Any]] = None
    is_hidden: Optional[bool] = None
    width: Optional[int] = Field(None, ge=80, le=800, description="列宽(像素)")
    validation_rules: Optional[Dict[str, Any]] = None
    is_primary: Optional[bool] = Field(None, description="是否设为主字段")
    expected_schema_version: Optional[int] = Field(
        None,
        ge=0,
        description="客户端期望的 schema_version，用于字段结构乐观锁"
    )
    visibility_roles: Optional[List[str]] = Field(
        None,
        description="允许查看该字段的角色列表（owner/admin/editor/viewer/all）"
    )

    @model_validator(mode='before')
    @classmethod
    def reject_field_type_change(cls, data: Any) -> Any:
        """字段类型变更不走 update，须用 convert 三件套（TDA-15 / P0-C6）。"""
        if isinstance(data, dict):
            for key in ('field_type', 'type'):
                if data.get(key) is not None:
                    raise ValueError(
                        '字段类型不可通过 update 修改；请使用 field check / preview / convert'
                    )
        return data


class TableFieldOut(TableFieldBase):
    """字段响应"""
    id: UUID
    table_id: UUID
    is_primary: bool
    order: int  # 字段排序
    is_hidden: bool
    width: int
    validation_rules: Dict[str, Any]
    visibility_roles: List[str] = Field(default_factory=list, description="字段可见角色")
    # cellValueType 抽象层
    cellValueType: Optional[str] = Field(None, description="单元格值逻辑类型: string/number/boolean/dateTime")
    isMultipleCellValue: Optional[bool] = Field(None, description="是否为多值字段")
    created_at: datetime
    updated_at: datetime

    @field_validator('field_type')
    @classmethod
    def validate_field_type_value(cls, v: str) -> str:
        """响应端将无法识别的落库类型统一降级为基础文本类型。"""
        try:
            return _validate_field_type(v)
        except ValueError:
            return 'text'

    @classmethod
    def from_orm(cls, obj):
        """自定义 ORM 映射，将 config 映射到 options"""
        data = {
            'id': obj.id,
            'table_id': obj.table_id,
            'name': obj.name,
            'field_type': obj.field_type,
            'default_value': obj.default_value,
            'description': obj.description,
            'options': obj.config,  # ⭐ 将 config 映射到 options
            'is_primary': obj.is_primary,
            'order': obj.order,
            'is_hidden': obj.is_hidden,
            'width': obj.width,
            'validation_rules': obj.validation_rules,
            'visibility_roles': obj.config.get('visibility_roles', []) if obj.config else [],
            'cellValueType': getattr(obj, 'cell_value_type', None) or 'string',
            'isMultipleCellValue': bool(getattr(obj, 'is_multiple_cell_value', False)),
            'created_at': obj.created_at,
            'updated_at': obj.updated_at,
        }
        return cls(**data)

    model_config = ConfigDict(from_attributes=True)


class TableFieldListResponse(BaseModel):
    """字段列表响应"""
    fields: List[TableFieldOut]
    total: int


class FieldOrderItem(BaseModel):
    """字段排序项"""
    field_id: UUID = Field(..., description="字段ID")
    sort_order: int = Field(..., description="排序号")


class TableFieldReorderRequest(BaseModel):
    """字段重新排序请求"""
    field_orders: List[FieldOrderItem] = Field(..., description="字段排序列表")
    expected_schema_version: Optional[int] = Field(
        None,
        description=(
            "客户端读取字段列表时的 schema_version（可选）。"
            "若提供且与服务端当前版本不一致，服务端返回 409 冲突，"
            "提示客户端刷新后重试，防止并发重排时静默覆盖他人操作。"
        ),
    )


class BulkFieldCreateItem(BaseModel):
    """批量创建字段项"""
    name: str = Field(..., min_length=1, max_length=100, description="字段名称")
    field_type: str = Field(..., description="字段类型")
    default_value: Optional[Dict[str, Any]] = Field(default=None, description="字段默认值")
    description: Optional[str] = Field(None, max_length=500, description="字段描述")
    options: Optional[Dict[str, Any]] = Field(default=None, description="字段配置选项")

    @field_validator('field_type')
    @classmethod
    def validate_field_type_value(cls, v: str) -> str:
        return _validate_field_type(v)


class BulkFieldCreateRequest(BaseModel):
    """批量创建字段请求（table_id从URL路径获取）"""
    fields: List[BulkFieldCreateItem] = Field(
        ...,
        min_length=1,
        max_length=MAX_BULK_FIELDS,
        description=f"字段列表（最多{MAX_BULK_FIELDS}个）",
    )


class BulkFieldCreateResponse(BaseModel):
    """批量创建字段响应"""
    success_count: int = Field(..., description="成功创建的字段数量")
    fields: List[TableFieldOut] = Field(..., description="成功创建的字段列表")
    errors: List[str] = Field(default_factory=list, description="错误信息列表")


# ============ Field Type Conversion Schema ============

class FieldConversionCheck(BaseModel):
    """字段类型转换检查请求"""
    target_type: str = Field(..., description="目标字段类型")


class FieldConversionCheckResponse(BaseModel):
    """字段类型转换检查响应"""
    can_convert: bool = Field(..., description="是否可以转换")
    field_id: Optional[str] = Field(None, description="字段ID")
    from_type: Optional[str] = Field(None, description="源字段类型")
    to_type: Optional[str] = Field(None, description="目标字段类型")
    is_primary: Optional[bool] = Field(None, description="是否为主字段")
    error: Optional[str] = Field(None, description="错误信息")


class FieldConversionPreview(BaseModel):
    """字段类型转换预览请求"""
    target_type: str = Field(..., description="目标字段类型")
    target_options: Optional[Dict[str, Any]] = Field(None, description="目标字段选项")
    sample_size: int = Field(default=10, description="采样数量")


class ConversionPreviewItem(BaseModel):
    """转换预览项"""
    original: Any = Field(..., description="原始值")
    converted: Any = Field(..., description="转换后的值")
    success: bool = Field(..., description="转换是否成功")
    error: Optional[str] = Field(None, description="转换错误信息")


class FieldConversionPreviewResponse(BaseModel):
    """字段类型转换预览响应"""
    can_convert: bool = Field(..., description="是否可以转换")
    field_id: Optional[str] = Field(None, description="字段ID")
    field_name: Optional[str] = Field(None, description="字段名称")
    from_type: Optional[str] = Field(None, description="源字段类型")
    to_type: Optional[str] = Field(None, description="目标字段类型")
    is_primary: Optional[bool] = Field(None, description="是否为主字段")
    success_rate: Optional[float] = Field(None, description="转换成功率")
    preview: Optional[List[ConversionPreviewItem]] = Field(None, description="转换预览")
    error: Optional[str] = Field(None, description="错误信息")


class FieldConversionRequest(BaseModel):
    """字段类型转换请求"""
    target_type: str = Field(..., description="目标字段类型")
    target_options: Optional[Dict[str, Any]] = Field(None, description="目标字段选项")
    force: bool = Field(default=False, description="是否强制转换（忽略数据转换失败）")
    async_mode: bool = Field(default=False, description="是否异步执行转换")


class FieldConversionResponse(BaseModel):
    """字段类型转换响应"""
    success: bool = Field(..., description="转换是否成功")
    field_id: Optional[str] = Field(None, description="字段ID")
    from_type: Optional[str] = Field(None, description="源字段类型")
    to_type: Optional[str] = Field(None, description="目标字段类型")
    message: Optional[str] = Field(None, description="转换消息")
    error: Optional[str] = Field(None, description="错误信息")
    task_id: Optional[str] = Field(None, description="异步任务ID")
    affected_records: Optional[int] = Field(None, description="受影响的记录数")
    converted_count: Optional[int] = Field(None, description="成功转换的记录数")
    cleared_count: Optional[int] = Field(None, description="被清空的记录数")
    auto_created_options: Optional[List[str]] = Field(None, description="自动创建的选项列表（仅单选/多选）")


# ============ Attachment Schemas ============


class AttachmentUploadFile(BaseModel):
    file_name: str = Field(..., description="文件名称")
    file_size: int = Field(..., ge=1, description="文件大小（字节）")
    mime_type: Optional[str] = Field(None, description="MIME 类型")
    chunk_size: Optional[int] = Field(None, ge=1, description="分片大小（字节）")
    is_public: Optional[bool] = Field(None, description="是否公开可访问")


class AttachmentUploadTaskCreate(BaseModel):
    table_id: UUID = Field(..., description="目标表格ID")
    field_id: UUID = Field(..., description="附件字段ID")
    record_id: Optional[UUID] = Field(None, description="记录ID")
    files: List[AttachmentUploadFile] = Field(..., description="待上传文件列表")
    task_type: str = Field(default='chunk', description="任务类型：single/batch/chunk")


class AttachmentUploadFileOut(BaseModel):
    upload_item_id: str
    file_name: str
    file_size: int
    chunk_size: int
    total_parts: int
    object_key: str
    upload_id: str


class AttachmentUploadTaskResponse(BaseModel):
    task_id: str
    task_type: str
    files: List[AttachmentUploadFileOut]


class AttachmentPartUploadResponse(BaseModel):
    upload_item_id: str
    part_number: int
    etag: str
    completed_parts: int
    total_parts: int
    uploaded_size: int


class AttachmentReferenceOut(BaseModel):
    reference_id: str
    file_id: str
    table_id: Optional[str]
    field_id: Optional[str]
    record_id: Optional[str]
    name: str
    url: str
    size: int
    mime_type: Optional[str]
    bucket: Optional[str]
    key: Optional[str]
    extra: Dict[str, Any]
    created_at: str
    updated_at: str
    created_by: Optional[str]


class AttachmentCompleteResponse(BaseModel):
    upload_item_id: str
    file_id: Optional[str]
    reference: Optional[AttachmentReferenceOut]
    status: str


class AttachmentReuseRequest(BaseModel):
    file_id: UUID = Field(..., description="目标文件ID")
    table_id: UUID = Field(..., description="目标表格ID")
    field_id: UUID = Field(..., description="附件字段ID")
    record_id: UUID = Field(..., description="目标记录ID")


class AttachmentAccessRequest(BaseModel):
    """按 TabData 业务资源上下文为附件重新签发访问地址。"""

    file_id: UUID = Field(..., description="平台文件ID")
    table_id: UUID = Field(..., description="附件所在表格ID")
    field_id: Optional[UUID] = Field(None, description="附件所在字段ID")
    record_id: Optional[UUID] = Field(None, description="附件所在记录ID")
    reference_id: Optional[UUID] = Field(None, description="附件引用ID")


# ============ Record Schema ============

class RecordOrderContext(BaseModel):
    """创建记录顺序上下文"""
    view_id: Optional[UUID] = Field(default=None, description="当前视图ID（可选）")
    anchor_record_id: Optional[UUID] = Field(default=None, description="锚点记录ID（before/after 时必填）")
    position: Literal['before', 'after', 'end'] = Field(
        default='end',
        description="插入位置：before/after/end",
    )
    group_values: Optional[Dict[str, Any]] = Field(
        default=None,
        description="分组字段默认值（预留）",
    )


class TableRecordCreate(BaseModel):
    """创建记录请求"""
    table_id: UUID = Field(..., description="所属表格ID")
    data: Dict[str, Any] = Field(default_factory=dict, description="旧协议记录数据（字段名/字段ID -> 字段值）")
    fields: Optional[Dict[str, Any]] = Field(
        default=None,
        description="记录字段映射（key 类型由 fieldKeyType 指定）",
    )
    field_key_type: Literal['id', 'name', 'dbFieldName'] = Field(
        default='name',
        alias='fieldKeyType',
        description="fields 的 key 类型（id/name/dbFieldName）",
    )
    order_context: Optional[RecordOrderContext] = Field(
        default=None,
        description="可选的插入顺序上下文（支持锚点插入）",
    )

    model_config = ConfigDict(populate_by_name=True)

    def resolved_payload(self) -> Dict[str, Any]:
        if self.fields is not None:
            return dict(self.fields)
        return dict(self.data)


class TableRecordUpdate(BaseModel):
    """更新记录请求"""
    data: Dict[str, Any] = Field(default_factory=dict, description="旧协议记录数据（部分更新）")
    fields: Optional[Dict[str, Any]] = Field(
        default=None,
        description="记录字段映射（key 类型由 fieldKeyType 指定）",
    )
    field_key_type: Literal['id', 'name', 'dbFieldName'] = Field(
        default='name',
        alias='fieldKeyType',
        description="fields 的 key 类型（id/name/dbFieldName）",
    )
    expected_version: Optional[int] = Field(
        default=None,
        description="可选的记录版本；与服务端当前版本不一致时拒绝更新",
    )

    model_config = ConfigDict(populate_by_name=True)

    @model_validator(mode='after')
    def validate_payload(self):
        if self.fields is None and not self.data:
            raise ValueError("data 与 fields 不能同时为空")
        return self

    def resolved_payload(self) -> Dict[str, Any]:
        if self.fields is not None:
            return dict(self.fields)
        return dict(self.data)


class TableRecordOut(BaseModel):
    """记录响应"""
    id: UUID
    row_id: str
    table_id: UUID
    data: Dict[str, Any]
    fields: Dict[str, Any] = Field(default_factory=dict, description="记录字段映射")
    order: float
    version: int
    created_by_id: str  # UUID字符串
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class TableRecordListResponse(BaseModel):
    """记录列表响应"""
    records: List[TableRecordOut]
    total: int
    page: int
    page_size: int


class BulkRecordCreateRequest(BaseModel):
    """批量创建记录请求

    records 格式兼容三种写法：
      1. 扁平 dict: [{"标题": "xxx", "状态": "待处理"}]
      2. fields 包裹: [{"fields": {"标题": "xxx"}}]
      3. data 包裹: [{"data": {"标题": "xxx"}}]
    """
    table_id: UUID = Field(..., description="表格ID")
    records: List[Dict[str, Any]] = Field(
        ...,
        min_length=1,
        max_length=MAX_BULK_RECORDS,
        description=f"记录数据列表（每次最多 {MAX_BULK_RECORDS} 条）",
    )
    field_key_type: Literal['id', 'name', 'dbFieldName'] = Field(
        default='name',
        alias='fieldKeyType',
        description="fields 的 key 类型（id/name/dbFieldName）",
    )
    order_context: Optional[RecordOrderContext] = Field(
        default=None,
        description="批量创建共用的插入顺序上下文",
    )
    operation_group_id: Optional[str] = Field(
        default=None,
        description="操作组ID；前端可透传稳定批次ID以保证整组 undo/history",
    )

    model_config = ConfigDict(populate_by_name=True)

    def resolved_records(self) -> List[Dict[str, Any]]:
        """将三种输入格式统一展开为扁平 dict 列表"""
        result = []
        for item in self.records:
            if 'fields' in item and isinstance(item['fields'], dict):
                result.append(item['fields'])
            elif 'data' in item and isinstance(item['data'], dict):
                result.append(item['data'])
            else:
                result.append(item)
        return result


class RecordUpsertRequest(BaseModel):
    """Agent JWT upsert 请求（table_id 在 body，复用 open API upsert 语义）。"""
    table_id: UUID = Field(..., description="表格ID")
    records: List[Dict[str, Any]] = Field(
        ...,
        min_length=1,
        max_length=MAX_BULK_RECORDS,
        description=f'记录列表，每项格式: {{"fields": {{"字段名": "值"}}}} 或扁平 dict',
    )
    upsert_on: List[str] = Field(
        ...,
        min_length=1,
        description="去重字段列表（字段名或字段ID，取决于 field_key_type）",
    )
    field_key_type: Literal['id', 'name', 'dbFieldName'] = Field(
        default='name',
        alias='fieldKeyType',
        description="fields 的 key 类型（id/name/dbFieldName）",
    )

    model_config = ConfigDict(populate_by_name=True)


class BulkRecordUpdateItem(BaseModel):
    """批量更新记录项"""
    record_id: UUID = Field(..., description="记录ID")
    data: Dict[str, Any] = Field(..., description="更新数据")
    base_snapshot: Optional[Dict[str, Any]] = Field(default=None, description="编辑前的字段值快照，用于冲突检测")


class BulkRecordUpdateRequest(BaseModel):
    """批量更新记录请求"""
    updates: List[BulkRecordUpdateItem] = Field(
        ...,
        min_length=1,
        max_length=MAX_BULK_RECORDS,
        description=f"更新列表（每次最多 {MAX_BULK_RECORDS} 条）",
    )
    operation_group_id: Optional[str] = Field(
        default=None,
        description="操作组ID；前端可透传稳定批次ID以保证整组 undo/history",
    )


class RecordReorderRequest(BaseModel):
    """记录重排序请求"""
    table_id: UUID = Field(..., description="表格ID")
    record_ids: List[UUID] = Field(
        ...,
        min_length=1,
        max_length=MAX_BULK_RECORDS,
        description=f"需要移动的记录ID列表（每次最多 {MAX_BULK_RECORDS} 条）",
    )
    anchor_record_id: Optional[UUID] = Field(
        default=None,
        description="锚点记录ID（before/after 时必填，且不能是被移动记录）",
    )
    position: Literal['before', 'after', 'end'] = Field(
        default='end',
        description="插入位置：before/after/end",
    )
    view_id: Optional[UUID] = Field(
        default=None,
        description="视图ID（可选，仅用于审计与前端语义对齐）",
    )
    group_values: Optional[Dict[str, Any]] = Field(
        default=None,
        description="分组字段值（可选，拖拽跨分组时用于同步记录分组字段）",
    )


class BulkRecordDeleteRequest(BaseModel):
    """批量删除记录请求"""
    record_ids: List[UUID] = Field(
        ...,
        min_length=1,
        max_length=MAX_BULK_RECORDS,
        description=f"记录ID列表（每次最多 {MAX_BULK_RECORDS} 条）",
    )
    operation_group_id: Optional[str] = Field(
        default=None,
        description="操作组ID；前端可透传稳定批次ID以保证整组 undo/history",
    )


class BulkOperationResponse(BaseModel):
    """批量操作响应"""
    success_count: int = Field(..., description="成功数量")
    errors: List[str] = Field(default_factory=list, description="错误信息列表")
    deleted_record_ids: Optional[List[str]] = Field(
        default=None,
        description=(
            "批量删除成功或已不存在（可幂等清投影）的记录 ID（仅 bulk-delete）"
        ),
    )
    failed_record_ids: Optional[List[str]] = Field(
        default=None,
        description="批量删除失败的记录 ID（仅 bulk-delete）",
    )
    total_count: Optional[int] = Field(default=None, description="请求总数量")
    processed_count: Optional[int] = Field(default=None, description="已处理数量")
    failed_count: Optional[int] = Field(default=None, description="失败数量")
    batch_size: Optional[int] = Field(default=None, description="服务端分批大小")
    batches_completed: Optional[int] = Field(default=None, description="已完成分批数")
    total_batches: Optional[int] = Field(default=None, description="总分批数")


# ============ View Schema ============

class TableViewBase(BaseModel):
    """视图基础模型"""
    name: str = Field(..., min_length=1, max_length=100, description="视图名称")
    view_type: str = Field(default="grid", description="视图类型 (grid/kanban/calendar/gallery/list)")
    description: Optional[str] = Field(None, max_length=500, description="视图描述")


class TableViewCreate(TableViewBase):
    """创建视图请求"""
    table_id: UUID = Field(..., description="所属表格ID")
    filter: Optional[Dict[str, Any]] = Field(
        default=None,
        description="嵌套过滤条件 FilterSet，优先于 filters",
    )
    filters: Optional[List[Dict[str, Any]]] = Field(default=[], description="过滤条件（旧版扁平格式）")
    sorts: Optional[List[Dict[str, Any]]] = Field(default=[], description="排序规则")
    groups: Optional[List[Dict[str, Any]]] = Field(
        default=None,
        description="分组规则（看板分列字段；与 config.group_by_field 双向对齐）",
    )
    visible_fields: Optional[List[str]] = Field(default=[], description="可见字段列表")
    field_order: Optional[List[str]] = Field(default=[], description="字段顺序")
    column_meta: Optional[Dict[str, Dict[str, Any]]] = Field(
        default=None,
        alias='columnMeta',
        description="视图列元数据；推荐传 column_meta，columnMeta 为兼容别名（优先级高于 visible_fields/field_order）",
    )
    config: Optional[Dict[str, Any]] = Field(default={}, description="视图配置")

    model_config = ConfigDict(populate_by_name=True)

    @model_validator(mode='before')
    @classmethod
    def _log_legacy_column_meta_alias(cls, raw: Any):
        if isinstance(raw, dict) and 'columnMeta' in raw:
            log_legacy_view_column_meta_alias_usage(
                'TableViewCreate.columnMeta',
                shape='map',
            )
        return raw


class TableViewUpdate(BaseModel):
    """更新视图请求"""
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    description: Optional[str] = None
    filter: Optional[Dict[str, Any]] = Field(
        default=None,
        description="嵌套过滤条件 FilterSet，优先于 filters",
    )
    filters: Optional[List[Dict[str, Any]]] = None
    sorts: Optional[List[Dict[str, Any]]] = None
    groups: Optional[List[Dict[str, Any]]] = None
    visible_fields: Optional[List[str]] = None
    field_order: Optional[List[str]] = None
    column_meta: Optional[Dict[str, Dict[str, Any]]] = Field(
        default=None,
        alias='columnMeta',
        description="视图列元数据；推荐传 column_meta，columnMeta 为兼容别名（优先级高于 visible_fields/field_order）",
    )
    config: Optional[Dict[str, Any]] = None
    is_shared: Optional[bool] = None
    is_locked: Optional[bool] = None

    model_config = ConfigDict(populate_by_name=True)

    @model_validator(mode='before')
    @classmethod
    def _log_legacy_column_meta_alias(cls, raw: Any):
        if isinstance(raw, dict) and 'columnMeta' in raw:
            log_legacy_view_column_meta_alias_usage(
                'TableViewUpdate.columnMeta',
                shape='map',
            )
        return raw


class TableViewColumnMetaRoItem(BaseModel):
    """columnMetaRo 条目"""
    field_id: str = Field(..., alias='fieldId', description='字段ID')
    column_meta: Dict[str, Any] = Field(
        ...,
        alias='columnMeta',
        description='列元数据补丁；推荐用 column_meta，columnMeta 为兼容别名',
    )

    model_config = ConfigDict(populate_by_name=True)

    @model_validator(mode='before')
    @classmethod
    def _log_legacy_column_meta_alias(cls, raw: Any):
        if isinstance(raw, dict) and 'columnMeta' in raw and 'column_meta' not in raw:
            log_legacy_view_column_meta_alias_usage(
                'TableViewColumnMetaRoItem.columnMeta',
                shape='item',
            )
        return raw


class TableViewColumnMetaUpdate(BaseModel):
    """更新视图列元数据请求"""
    column_meta: Union[
        Dict[str, Dict[str, Any]],
        List[TableViewColumnMetaRoItem],
    ] = Field(
        ...,
        alias='columnMeta',
        description="视图列元数据补丁；推荐传 column_meta，兼容 columnMeta / columnMetaRo",
    )

    model_config = ConfigDict(populate_by_name=True)

    @model_validator(mode='before')
    @classmethod
    def _normalize_input_shape(cls, raw: Any):
        if isinstance(raw, list):
            log_legacy_view_column_meta_alias_usage(
                'TableViewColumnMetaUpdate.columnMetaRo',
                shape='direct-array',
            )
            return {'column_meta': raw}

        if isinstance(raw, dict):
            if 'column_meta' in raw:
                return raw
            if 'columnMeta' in raw:
                log_legacy_view_column_meta_alias_usage(
                    'TableViewColumnMetaUpdate.columnMeta',
                    shape='wrapped-map',
                )
                return raw

            # 兼容包装格式：{ columnMetaRo: [...] }
            if 'columnMetaRo' in raw:
                log_legacy_view_column_meta_alias_usage(
                    'TableViewColumnMetaUpdate.columnMetaRo',
                    shape='wrapped-array',
                )
                return {'column_meta': raw.get('columnMetaRo')}

            # 兼容直接 map：{ fieldId: { ...meta } }
            if all(isinstance(value, dict) for value in raw.values()):
                return {'column_meta': raw}

        return raw

    def to_column_meta_map(self) -> Dict[str, Dict[str, Any]]:
        raw = self.column_meta
        if isinstance(raw, dict):
            return {
                str(field_id): dict(meta)
                for field_id, meta in raw.items()
                if isinstance(meta, dict)
            }

        normalized: Dict[str, Dict[str, Any]] = {}
        for item in raw:
            field_id = str(item.field_id).strip()
            if not field_id:
                continue
            normalized[field_id] = dict(item.column_meta or {})

        return normalized


class TableViewOut(TableViewBase):
    """视图响应"""
    id: UUID
    table_id: UUID
    created_by_id: Optional[str] = None  # UUID字符串
    filters: List[Dict[str, Any]] = []
    sorts: List[Dict[str, Any]] = []
    groups: List[Dict[str, Any]] = []
    visible_fields: List[str] = []
    field_order: List[str] = []
    column_meta: Dict[str, Dict[str, Any]] = Field(default_factory=dict, description="视图列元数据（推荐读取字段）")
    columnMeta: Dict[str, Dict[str, Any]] = Field(default_factory=dict, description="视图列元数据（camelCase 兼容别名，后续计划下线）")
    config: Dict[str, Any] = {}
    is_shared: bool = False
    is_locked: bool = False
    order: int = 0
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class TableViewListResponse(BaseModel):
    """视图列表响应"""
    views: List[TableViewOut]
    total: int


class ViewReorderRequest(BaseModel):
    """视图重排序请求"""
    view_orders: List[Dict[str, Any]] = Field(..., description="视图顺序列表")

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "view_orders": [
                    {"view_id": "uuid1", "order": 0},
                    {"view_id": "uuid2", "order": 1}
                ]
            }
        }
    )


# ============ Import/Export Schema ============

class ImportPreviewRequest(BaseModel):
    """导入预览请求"""
    table_id: UUID = Field(..., description="目标表格ID")
    file_type: str = Field(..., description="文件类型 (csv/excel/json)")
    preview_rows: int = Field(default=10, ge=1, le=100, description="预览行数")


class FieldMappingItem(BaseModel):
    """字段映射项"""
    source: str = Field(..., description="源列名（文件中的列名）")
    target: str = Field(..., description="目标字段ID（空字符串表示未匹配）")
    target_name: str = Field(..., description="目标字段名（空字符串表示未匹配）")
    confidence: float = Field(..., ge=0, le=1, description="匹配置信度 (1.0=精确, 0.8=模糊, 0.0=未匹配)")
    inferred_type: str = Field(..., description="推断/已知的字段类型")


class ValidationIssueItem(BaseModel):
    """验证问题项"""
    row: int = Field(..., description="行号")
    field: str = Field(..., description="字段名")
    issue: str = Field(..., description="问题描述")


class ImportPreviewStats(BaseModel):
    """导入预览统计"""
    total_rows: int = Field(..., description="总行数")
    preview_rows: int = Field(..., description="预览行数")
    field_count: int = Field(..., description="列数")
    total_validation_issues: int = Field(default=0, description="验证问题总数")


class ImportPreviewResponse(BaseModel):
    """导入预览响应"""
    preview_data: List[Dict[str, Any]] = Field(..., description="预览数据（行对象数组）")
    field_mapping: List[FieldMappingItem] = Field(..., description="字段映射列表")
    validation_issues: List[ValidationIssueItem] = Field(default_factory=list, description="验证问题")
    stats: ImportPreviewStats = Field(..., description="统计信息")


class ImportFromCSVRequest(BaseModel):
    """CSV导入请求"""
    table_id: UUID = Field(..., description="目标表格ID")
    csv_content: str = Field(..., description="CSV文件内容")
    skip_errors: bool = Field(default=False, description="是否跳过错误行")
    update_existing: bool = Field(default=False, description="是否更新已存在的记录")
    primary_key_field: Optional[str] = Field(default=None, description="主键字段名（用于增量导入）")
    auto_create_missing_fields: bool = Field(default=True, description="是否自动创建缺失字段（按分片创建）")


class ImportFromExcelRequest(BaseModel):
    """Excel导入请求"""
    table_id: UUID = Field(..., description="目标表格ID")
    skip_errors: bool = Field(default=False, description="是否跳过错误行")
    update_existing: bool = Field(default=False, description="是否更新已存在的记录")
    primary_key_field: Optional[str] = Field(default=None, description="主键字段名（用于增量导入）")
    sheet_name: Optional[str] = Field(default=None, description="工作表名称")
    auto_create_missing_fields: bool = Field(default=True, description="是否自动创建缺失字段（按分片创建）")


class ImportFromJSONRequest(BaseModel):
    """JSON导入请求"""
    table_id: UUID = Field(..., description="目标表格ID")
    json_content: str = Field(..., description="JSON文件内容")
    skip_errors: bool = Field(default=False, description="是否跳过错误行")
    update_existing: bool = Field(default=False, description="是否更新已存在的记录")
    primary_key_field: Optional[str] = Field(default=None, description="主键字段名（用于增量导入）")
    auto_create_missing_fields: bool = Field(default=True, description="是否自动创建缺失字段（按分片创建）")
    fast_mode: bool = Field(
        default=False,
        description=(
            "快速模式：使用批量化路径降低 RH/CL/VH 写入开销。"
            "Wave 1.1 (B-2) 起仍会写完整的 RecordHistory + ChangeLog + VersionHistory（"
            "通过 `field_changes._import_source='fast_mode'` 与 "
            "`ChangeLog.changes._import_source='fast_mode'` 标识来源），"
            "保持与 default 模式的 Checkpoint 回滚链路完全等价。"
            "性能差异主要体现在 emit 路径开销，1 万行级别 default 与 fast_mode "
            "实测都在 batch_write_record_histories 量级。"
        ),
    )


class ImportSpaceFromJSONRequest(BaseModel):
    """Space 级 JSON 导入请求（Base 快照）。"""
    space_id: UUID = Field(..., description="目标 Space ID")
    json_content: str = Field(..., description="base_full JSON 内容")
    skip_errors: bool = Field(default=False, description="是否跳过单表导入错误并继续导入后续表")
    update_existing: bool = Field(default=False, description="是否启用增量导入（按主键更新）")
    primary_key_field: Optional[str] = Field(default=None, description="主键字段名（用于增量导入）")
    auto_create_missing_fields: bool = Field(default=True, description="是否自动创建缺失字段（按分片创建）")


class AsyncImportFileRequest(BaseModel):
    """异步文件导入请求（文件上传模式）"""
    table_id: UUID = Field(..., description="目标表格ID")
    file_type: str = Field(default='csv', description="文件类型 (csv / excel / json)")
    skip_errors: bool = Field(default=False, description="是否跳过错误行")
    update_existing: bool = Field(default=False, description="是否更新已存在的记录")
    primary_key_field: Optional[str] = Field(default=None, description="主键字段名（用于增量导入）")
    auto_create_missing_fields: bool = Field(default=True, description="是否自动创建缺失字段")
    sheet_name: Optional[str] = Field(default=None, description="Excel 工作表名称")


class ImportResponse(BaseModel):
    """导入响应"""
    created_count: int = Field(..., description="新建记录数量")
    updated_count: int = Field(default=0, description="更新记录数量")
    errors: List[str] = Field(default_factory=list, description="错误信息列表")
    import_metadata: Optional[Dict[str, Any]] = Field(default=None, description="导入过程元信息（字段分片创建/批次写入统计）")


_MAX_EXPORT_RECORD_IDS = 10000
_MAX_EXPORT_FIELD_IDS = 500


class ExportViewQueryMixin(BaseModel):
    """当前视图的请求态查询覆盖；省略时继续读取持久化 View 配置。"""
    filters: Optional[List[Dict[str, Any]]] = Field(default=None, max_length=100, description="请求态视图筛选条件")
    filter_logic: Optional[Literal["and", "or"]] = Field(default=None, description="请求态筛选逻辑")
    sorts: Optional[List[Dict[str, Any]]] = Field(default=None, max_length=20, description="请求态视图排序")
    groups: Optional[List[Dict[str, Any]]] = Field(default=None, max_length=20, description="请求态视图分组")


class ExportRequest(ExportViewQueryMixin):
    """通用导出请求"""
    table_id: UUID = Field(..., description="表格ID")
    field_ids: Optional[List[UUID]] = Field(default=None, max_length=_MAX_EXPORT_FIELD_IDS, description="要导出的字段ID列表")
    record_ids: Optional[List[UUID]] = Field(default=None, max_length=_MAX_EXPORT_RECORD_IDS, description="要导出的记录ID列表")
    view_id: Optional[UUID] = Field(default=None, description="视图ID（应用视图筛选）")
    format: str = Field(..., description="导出格式 (csv/excel/json/pdf)")


class ExportToCSVRequest(ExportViewQueryMixin):
    """CSV导出请求"""
    table_id: UUID = Field(..., description="表格ID")
    field_ids: Optional[List[UUID]] = Field(default=None, max_length=_MAX_EXPORT_FIELD_IDS, description="要导出的字段ID列表")
    record_ids: Optional[List[UUID]] = Field(default=None, max_length=_MAX_EXPORT_RECORD_IDS, description="要导出的记录ID列表")
    view_id: Optional[UUID] = Field(default=None, description="视图ID")
    include_headers: bool = Field(default=True, description="是否包含表头")
    async_mode: bool = Field(default=False, description="异步模式：大文件时通过 Celery 执行，完成后 WS 通知下载链接")


class ExportToExcelRequest(ExportViewQueryMixin):
    """Excel导出请求"""
    table_id: UUID = Field(..., description="表格ID")
    field_ids: Optional[List[UUID]] = Field(default=None, max_length=_MAX_EXPORT_FIELD_IDS, description="要导出的字段ID列表")
    record_ids: Optional[List[UUID]] = Field(default=None, max_length=_MAX_EXPORT_RECORD_IDS, description="要导出的记录ID列表")
    view_id: Optional[UUID] = Field(default=None, description="视图ID")
    include_headers: bool = Field(default=True, description="是否包含表头")
    sheet_name: str = Field(default="Sheet1", max_length=31, description="工作表名称")
    async_mode: bool = Field(default=False, description="异步模式：大文件时通过 Celery 执行，完成后 WS 通知下载链接")


class ExportToJSONRequest(ExportViewQueryMixin):
    """JSON导出请求"""
    table_id: UUID = Field(..., description="表格ID")
    field_ids: Optional[List[UUID]] = Field(default=None, max_length=_MAX_EXPORT_FIELD_IDS, description="要导出的字段ID列表")
    record_ids: Optional[List[UUID]] = Field(default=None, max_length=_MAX_EXPORT_RECORD_IDS, description="要导出的记录ID列表")
    view_id: Optional[UUID] = Field(default=None, description="视图ID")
    format_type: Literal["array", "structured", "table_full"] = Field(
        default="array",
        description="JSON格式 (array/structured/table_full)",
    )
    async_mode: bool = Field(default=False, description="异步模式：大文件时通过 Celery 执行，完成后 WS 通知下载链接")


class ExportSpaceFromJSONRequest(BaseModel):
    """Space 级 JSON 导出请求（Base 快照）。"""
    space_id: UUID = Field(..., description="Space ID")
    table_ids: Optional[List[UUID]] = Field(default=None, max_length=200, description="要导出的表ID列表")
    include_archived: bool = Field(default=False, description="是否包含归档表")
    format_type: Literal["base_full"] = Field(
        default="base_full",
        description="项目JSON格式 (base_full)",
    )


class ExportToPDFRequest(ExportViewQueryMixin):
    """PDF导出请求"""
    table_id: UUID = Field(..., description="表格ID")
    field_ids: Optional[List[UUID]] = Field(default=None, max_length=_MAX_EXPORT_FIELD_IDS, description="要导出的字段ID列表")
    record_ids: Optional[List[UUID]] = Field(default=None, max_length=_MAX_EXPORT_RECORD_IDS, description="要导出的记录ID列表")
    view_id: Optional[UUID] = Field(default=None, description="视图ID")
    orientation: Literal["portrait", "landscape"] = Field(default="landscape", description="页面方向")
    title: Optional[str] = Field(default=None, max_length=500, description="PDF标题")
    async_mode: bool = Field(default=False, description="异步模式：大文件时通过 Celery 执行，完成后 WS 通知下载链接")


class ExportStatsResponse(BaseModel):
    """导出统计响应"""
    table_id: str
    field_count: int
    record_count: int
    estimated_size: Dict[str, float]


# ============ View Configuration Schema ============

class ViewConfigValidateRequest(BaseModel):
    """视图配置验证请求"""
    table_id: UUID = Field(..., description="表格ID")
    view_type: str = Field(..., description="视图类型 (grid/kanban/calendar/gallery/list)")
    config: Dict[str, Any] = Field(..., description="视图配置")


class ViewConfigValidateResponse(BaseModel):
    """视图配置验证响应"""
    is_valid: bool = Field(..., description="配置是否合法")
    errors: List[str] = Field(default=[], description="错误列表")
    warnings: List[str] = Field(default=[], description="警告列表")
    suggestions: Optional[Dict[str, Any]] = Field(default=None, description="配置建议")


class ViewRecordsRequest(BaseModel):
    """视图数据查询请求"""
    page: int = Field(default=1, ge=1, description="页码")
    page_size: int = Field(default=100, ge=1, le=1000, description="每页大小")
    date_range: Optional[str] = Field(default=None, description="日期范围（日历视图专用），格式: 2025-01-01,2025-01-31")


class ViewRecordsResponse(BaseModel):
    """视图数据查询响应"""
    view: Dict[str, Any] = Field(..., description="视图信息")
    records: List[Dict[str, Any]] = Field(..., description="记录列表")
    total: int = Field(..., description="当前视图全量总数")
    matched_total: Optional[int] = Field(default=None, description="当前视图全量匹配总数")
    delta_total: Optional[int] = Field(default=None, description="only_delta=true 时本次增量命中总数")
    page: int = Field(..., description="当前页码")
    page_size: int = Field(..., description="每页大小")
    metadata: Dict[str, Any] = Field(..., description="视图类型特定的元数据")
    latest_version: Optional[int] = Field(default=None, description="当前视图最新版本 token")
    has_changes: Optional[bool] = Field(default=None, description="自 since_version 以来是否有变更")


class ViewColumnStatisticItem(BaseModel):
    """列统计项"""
    field_id: str = Field(..., description="字段ID")
    field_name: str = Field(..., description="字段名称")
    agg_func: str = Field(..., description="统计函数")
    value: Optional[Any] = Field(default=None, description="统计值")


class ViewColumnStatisticsResponse(BaseModel):
    """视图列统计响应"""
    view_id: str = Field(..., description="视图ID")
    latest_version: int = Field(..., description="当前视图匹配记录最新版本")
    total_records: int = Field(..., description="匹配记录总数")
    column_statistics: List[ViewColumnStatisticItem] = Field(default_factory=list, description="列统计结果")


# ============ 撤销/重做 Schema ============

class UndoRequest(BaseModel):
    """撤销请求"""
    only_my_operations: bool = Field(
        default=False,
        description="是否只撤销当前用户的操作"
    )


class RedoRequest(BaseModel):
    """重做请求"""
    only_my_operations: bool = Field(
        default=False,
        description="是否只重做当前用户的操作"
    )


class HistoryOperationUser(BaseModel):
    """历史操作用户信息"""
    id: Optional[str] = Field(None, description="用户ID")
    name: str = Field(..., description="用户显示名称")


class HistoryOperationItemOut(BaseModel):
    """历史操作字段级明细"""
    field_key: str = Field(..., description="字段键（字段ID或系统字段）")
    field_name: Optional[str] = Field(None, description="字段显示名称（含已删除字段）")
    field_type: Optional[str] = Field(None, description="字段类型（含已删除字段）")
    before: Any = Field(default=None, description="变更前值")
    after: Any = Field(default=None, description="变更后值")


class HistoryOperationOut(BaseModel):
    """历史操作输出"""
    id: str = Field(..., description="历史记录ID")
    record_id: str = Field(..., description="记录ID")
    action: str = Field(..., description="操作类型: create/update/delete")
    action_display: str = Field(..., description="操作类型显示名称")
    field_changes: Dict[str, Any] = Field(default_factory=dict, description="字段变更详情")
    items: List[HistoryOperationItemOut] = Field(default_factory=list, description="字段级历史明细")
    user: Optional[HistoryOperationUser] = Field(None, description="操作者")
    created_at: str = Field(..., description="操作时间")
    is_undone: bool = Field(..., description="是否已撤销")
    undone_at: Optional[str] = Field(None, description="撤销时间")
    undone_by: Optional[HistoryOperationUser] = Field(None, description="撤销者")
    operation_group_id: Optional[str] = Field(None, description="操作组ID")
    editor_type: str = Field(default="user", description="编辑者类型: user/agent/system")


class UndoRedoResponse(BaseModel):
    """撤销/重做响应"""
    success: bool = Field(..., description="是否成功")
    message: Optional[str] = Field(None, description="消息")
    operation: Optional[HistoryOperationOut] = Field(None, description="操作详情")


class BatchUndoRedoResponse(BaseModel):
    """批量撤销/重做响应"""
    success: bool = Field(..., description="是否成功")
    message: Optional[str] = Field(None, description="消息")
    operations: List[HistoryOperationOut] = Field(default_factory=list, description="操作列表")
    count: int = Field(default=0, description="影响的操作数量")


class UndoStackQuery(BaseModel):
    """撤销栈查询参数"""
    only_my_operations: bool = Field(
        default=False,
        description="是否只显示当前用户的操作"
    )
    limit: int = Field(
        default=20,
        ge=1,
        le=100,
        description="返回数量限制"
    )


class UndoStackResponse(BaseModel):
    """撤销栈响应"""
    operations: List[HistoryOperationOut] = Field(..., description="可撤销的操作列表")
    total: int = Field(..., description="总数")


class RedoStackResponse(BaseModel):
    """重做栈响应"""
    operations: List[HistoryOperationOut] = Field(..., description="可重做的操作列表")
    total: int = Field(..., description="总数")


class RecordHistoryQuery(BaseModel):
    """记录历史查询参数"""
    cursor: Optional[str] = Field(
        default=None,
        description="游标（上一页最后一条历史记录 ID）"
    )
    start_date: Optional[str] = Field(
        default=None,
        alias='startDate',
        description="起始时间（ISO 8601）"
    )
    end_date: Optional[str] = Field(
        default=None,
        alias='endDate',
        description="结束时间（ISO 8601）"
    )
    include_undone: bool = Field(
        default=True,
        description="是否包含已撤销的操作"
    )
    limit: int = Field(
        default=50,
        ge=1,
        le=200,
        description="返回数量限制"
    )

    model_config = ConfigDict(populate_by_name=True)


class RecordHistoryResponse(BaseModel):
    """记录历史响应"""
    operations: List[HistoryOperationOut] = Field(..., description="历史操作列表")
    history_list: Optional[List[HistoryOperationOut]] = Field(
        default=None,
        description="历史列表（兼容别名）"
    )
    user_map: Optional[Dict[str, HistoryOperationUser]] = Field(
        default=None,
        description="操作用户映射"
    )
    total: int = Field(..., description="总数")
    next_cursor: Optional[str] = Field(None, description="下一页游标")


class TableHistoryQuery(BaseModel):
    """表格历史查询参数"""
    cursor: Optional[str] = Field(
        default=None,
        description="游标（上一页最后一条历史记录 ID）"
    )
    start_date: Optional[str] = Field(
        default=None,
        alias='startDate',
        description="起始时间（ISO 8601）"
    )
    end_date: Optional[str] = Field(
        default=None,
        alias='endDate',
        description="结束时间（ISO 8601）"
    )
    include_undone: bool = Field(
        default=True,
        description="是否包含已撤销的操作"
    )
    only_my_operations: bool = Field(
        default=False,
        description="是否仅显示当前用户的操作"
    )
    limit: int = Field(
        default=50,
        ge=1,
        le=200,
        description="返回数量限制"
    )

    model_config = ConfigDict(populate_by_name=True)


class TableHistoryResponse(BaseModel):
    """表格历史响应"""
    operations: List[HistoryOperationOut] = Field(..., description="历史操作列表")
    history_list: Optional[List[HistoryOperationOut]] = Field(
        default=None,
        description="历史列表（兼容别名）"
    )
    user_map: Optional[Dict[str, HistoryOperationUser]] = Field(
        default=None,
        description="操作用户映射"
    )
    total: int = Field(..., description="总数")
    next_cursor: Optional[str] = Field(None, description="下一页游标")


class RecordSnapshotQuery(BaseModel):
    """记录快照查询参数"""
    history_id: str = Field(..., description="历史记录 ID，用于重建该时间点的快照")


class RecordSnapshotResponse(BaseModel):
    """记录快照响应"""
    record_id: str = Field(..., description="记录 ID")
    history_id: str = Field(..., description="历史记录 ID")
    snapshot: Dict[str, Any] = Field(..., description="记录在该时间点的数据快照")


class TableSnapshotRecordOut(BaseModel):
    """表格快照中的单条记录"""
    record_id: str = Field(..., description="记录 ID")
    row_id: str = Field(..., description="稳定行 ID（通常等于 record_id）")
    order: float = Field(..., description="记录排序值")
    is_deleted: bool = Field(default=False, description="该快照行是否为删除预览行")
    data: Dict[str, Any] = Field(default_factory=dict, description="记录在该时间点的数据")


class TableSnapshotResponse(BaseModel):
    """表格快照响应"""
    table_id: str = Field(..., description="表格 ID")
    history_id: str = Field(..., description="历史记录 ID")
    snapshot: List[TableSnapshotRecordOut] = Field(
        default_factory=list,
        description="表格在该时间点的记录快照（还原默认仅未删除记录；历史预览可包含当时已删除的记录并标记 is_deleted）",
    )
    total: int = Field(..., description="快照记录总数")
    is_truncated: bool = Field(default=False, description="是否因行数上限截断")


class RestoreRecordRequest(BaseModel):
    """还原记录请求"""
    history_id: str = Field(..., description="目标历史记录 ID")


class RestoreRecordResponse(BaseModel):
    """还原记录响应"""
    record_id: str = Field(..., description="记录 ID")
    data: Dict[str, Any] = Field(..., description="还原后的记录数据")
    changed_fields: int = Field(..., description="变更的字段数量")


class RestoreTableRequest(BaseModel):
    """还原表格请求"""
    history_id: str = Field(..., description="目标历史记录 ID")


class RestoreTableResponse(BaseModel):
    """还原表格响应"""
    table_id: str = Field(..., description="表格 ID")
    history_id: str = Field(..., description="目标历史记录 ID")
    changed_records: int = Field(..., description="发生变化的记录数量")
    changed_histories: int = Field(..., description="生成的历史记录数量")
    changed_fields: int = Field(default=0, description="发生变化的字段数量")
    operation_group_id: Optional[str] = Field(
        None,
        description="本次还原对应的操作组 ID（用于整组撤销/重做）",
    )
    sync_mode: str = Field(
        default="none",
        description="协作同步模式：resync / force_close / failed / none",
    )


# ============ 命名版本（手动保存）============


class CreateTableNamedVersionRequest(BaseModel):
    """创建表格命名版本请求"""
    name: str = Field(default='', description="版本名称（可选）")
    # ：侧栏选中历史快照时传入，保存左侧正在预览的内容；缺省则拍当前表
    history_id: Optional[str] = Field(
        default=None,
        description="可选。从指定历史快照（RecordHistory / ChangeLog / VersionHistory id）创建命名版本",
    )


class RenameTableNamedVersionRequest(BaseModel):
    """重命名表格命名版本请求"""
    name: str = Field(..., description="新名称")


class TableNamedVersionOut(BaseModel):
    """表格命名版本响应"""
    id: str
    table_id: str
    history_id: Optional[str] = None
    snapshot_at: Optional[str] = None
    name: str = ''
    created_by: Optional[str] = None
    created_at: Optional[str] = None


# ============ Agent SQL (Phase 4) ============

class AgentSQLQueryRequest(BaseModel):
    """Agent SQL 只读查询请求"""
    sql: str = Field(..., min_length=1, max_length=10000, description="SQL 查询语句（支持中文表名/字段名）")
    params: Optional[List[Any]] = Field(default=None, description="SQL 参数列表（用于 %s 占位符）")


class AgentSQLExecuteRequest(BaseModel):
    """Agent SQL 写入执行请求"""
    sql: str = Field(..., min_length=1, max_length=10000, description="SQL 写入语句（INSERT/UPDATE/DELETE）")
    params: Optional[List[Any]] = Field(default=None, description="SQL 参数列表")
    allow_delete: bool = Field(default=False, description="是否允许 DELETE 操作（需显式确认）")


# ============ Link 字段 Schema ============


class LinkableRecordItem(BaseModel):
    """可关联记录条目"""
    id: str = Field(..., description="记录 ID")
    title: str = Field(default="", description="记录标题（主字段值）")


class LinkableRecordsResponse(BaseModel):
    """可关联记录列表响应"""
    records: List[LinkableRecordItem] = Field(default_factory=list)
    total: int = Field(default=0, description="总数")


class LinkableRecordsQuery(BaseModel):
    """可关联记录查询参数"""
    search: str = Field(default="", description="搜索关键词")
    search_field_id: Optional[str] = Field(None, description="按指定字段搜索（默认主字段）")
    search_field_ids: Optional[str] = Field(
        None,
        description="全局搜索限定字段（逗号分隔 field id；与选择器表头列对齐）",
    )
    page: int = Field(default=1, ge=1, description="页码")
    page_size: int = Field(default=200, ge=1, le=500, description="每页数量")
    exclude_record_id: Optional[str] = Field(None, description="排除的记录 ID（当前编辑的记录）")
    selected_record_ids: Optional[str] = Field(
        default=None,
        description="已选记录 ID（逗号分隔）",
    )
    only_selected: bool = Field(
        default=False,
        description="是否仅返回 selected_record_ids 对应记录（用于已选择面板）",
    )


class LinkableFieldItem(BaseModel):
    """目标表字段元数据"""
    id: str = Field(..., description="字段 ID")
    name: str = Field(..., description="字段名称")
    field_type: str = Field(..., description="字段类型")
    is_primary: bool = Field(default=False, description="是否为主字段")


class LinkableFieldsResponse(BaseModel):
    """目标表字段和视图响应"""
    fields: List[LinkableFieldItem] = Field(default_factory=list)
    views: List[Dict[str, Any]] = Field(default_factory=list, description="[{id, name}]")


# ============ Sub-Record Schema ============


class SubRecordCreateRequest(BaseModel):
    """创建子记录请求"""
    table_id: UUID = Field(..., description="所属表格ID")
    parent_record_id: UUID = Field(..., description="父记录ID")
    parent_field_id: Optional[UUID] = Field(
        default=None,
        description="父字段ID，为空则自动选择/创建默认父字段",
    )
    data: Dict[str, Any] = Field(default_factory=dict, description="子记录数据")
    order_context: Optional[RecordOrderContext] = Field(
        default=None,
        description="可选的插入顺序上下文",
    )


class SubRecordCreateResponse(BaseModel):
    """创建子记录响应"""
    record: TableRecordOut
    parent_field_id: UUID = Field(..., description="父记录字段ID")


class SubRecordMoveRequest(BaseModel):
    """移动子记录（改变父级）请求"""
    table_id: UUID = Field(..., description="所属表格ID")
    record_id: UUID = Field(..., description="要移动的记录ID")
    new_parent_id: Optional[UUID] = Field(
        default=None, description="新父记录ID，null 表示变为顶级记录"
    )
    parent_field_id: Optional[UUID] = Field(
        default=None, description="父字段ID，为空则自动获取"
    )


class SubRecordReorderTreeRequest(BaseModel):
    """树拖拽原子提交请求 — 单事务完成排序 + 层级变更"""
    table_id: UUID = Field(..., description="所属表格ID")
    moved_root_record_id: UUID = Field(..., description="拖拽的根记录ID")
    new_parent_id: Optional[UUID] = Field(
        default=None, description="新父记录ID，null 表示提为顶级记录"
    )
    position: Literal['before', 'after', 'end'] = Field(
        default='after', description="插入位置：before/after/end"
    )
    anchor_record_id: Optional[UUID] = Field(
        default=None, description="锚点记录ID（before/after 时必填）"
    )
    parent_field_id: Optional[UUID] = Field(
        default=None, description="父字段ID，为空则自动获取"
    )
    move_with_descendants: bool = Field(
        default=True, description="是否连同子树整体移动"
    )


# ============ 表单视图相关 Schema ============

class FormSubmitRequest(BaseModel):
    """公开表单提交请求"""
    fields: Dict[str, Any] = Field(..., description="字段数据 { field_id: value }")


class FormPasswordVerifyRequest(BaseModel):
    """表单密码验证请求"""
    password: str = Field(..., min_length=1, max_length=255, description="访问密码")


# ============ Field Options Schema (warn-only 校验) ============
#
# 各字段类型的 options 结构定义。用于灰度期 warn-only 校验：
# 校验失败仅记录 WARNING 日志，不拒绝请求。
# 所有 Schema 使用 extra='allow' 容忍未知字段，所有属性可选。


class SelectFieldOptions(BaseModel):
    """select / multi_select 字段 options"""
    choices: Optional[list] = None
    model_config = ConfigDict(extra='allow')


class NumberFieldOptions(BaseModel):
    """number 字段 options"""
    precision: Optional[int] = None
    format: Optional[str] = None
    model_config = ConfigDict(extra='allow')


class RatingFieldOptions(BaseModel):
    """rating 字段 options"""
    max: Optional[int] = Field(None, ge=1, le=10)
    icon: Optional[str] = None
    model_config = ConfigDict(extra='allow')


class DateFieldOptions(BaseModel):
    """date 字段 options"""
    format: Optional[str] = None
    include_time: Optional[bool] = None
    model_config = ConfigDict(extra='allow')


class LinkFieldOptions(BaseModel):
    """link 字段 options"""
    foreignTableId: Optional[str] = None
    relationship: Optional[str] = None
    isOneWay: Optional[bool] = None
    symmetricFieldId: Optional[str] = None
    lookupFieldId: Optional[str] = None
    model_config = ConfigDict(extra='allow')

    @field_validator('relationship')
    @classmethod
    def validate_relationship(cls, v):
        valid = {'OneOne', 'OneMany', 'ManyOne', 'ManyMany'}
        if v is not None and v not in valid:
            raise ValueError(f"relationship 必须为 {'/'.join(sorted(valid))}，当前为 {v!r}")
        return v


class UserFieldOptions(BaseModel):
    """user 字段 options"""
    isMultiple: Optional[bool] = None
    shouldNotify: Optional[bool] = None
    model_config = ConfigDict(extra='allow')


FIELD_OPTIONS_SCHEMAS: Dict[str, type] = {
    'select': SelectFieldOptions,
    'multi_select': SelectFieldOptions,
    'number': NumberFieldOptions,
    'rating': RatingFieldOptions,
    'date': DateFieldOptions,
    'link': LinkFieldOptions,
    'user': UserFieldOptions,
}
