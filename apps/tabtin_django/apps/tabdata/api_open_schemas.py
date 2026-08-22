"""
Open API Schema 定义

所有请求体 / 响应体 Schema 集中管理。
由 api_open.py 和 api_open_space.py 共同引用。
"""
from typing import Literal, Optional, List

from ninja import Schema
from pydantic import Field as PydField

from apps.tabdata.constants import DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE


# ── 查询 & 过滤 ──────────────────────────────────────────


class FilterItemSchema(Schema):
    """
    单条过滤条件。

    使用 field（字段名）或 field_id（字段UUID）指定目标字段，
    operator 为比较运算符，value 为比较值。
    """
    field_id: Optional[str] = PydField(default=None, description='字段 UUID（与 field 二选一）')
    field: Optional[str] = PydField(default=None, description='字段名（与 field_id 二选一，取决于 field_key_type）')
    operator: str = PydField(description='运算符：equals, not_equals, contains, greater_than, less_than, is_empty, is_not_empty 等')
    value: Optional[object] = PydField(default=None, description='比较值')


class FilterSetSchema(Schema):
    """
    嵌套过滤组，支持 AND/OR 组合。

    示例:
    ```json
    {
      "conjunction": "and",
      "filterSet": [
        {"field": "状态", "operator": "equals", "value": "进行中"},
        {"field": "优先级", "operator": "greater_than", "value": 3}
      ]
    }
    ```
    """
    conjunction: str = PydField(default='and', description='组合逻辑：and | or')
    filterSet: Optional[list] = PydField(default=None, description='过滤条件列表，可嵌套 FilterSetSchema')


class SortItemSchema(Schema):
    """排序项"""
    field_id: Optional[str] = PydField(default=None, description='字段 UUID')
    field: Optional[str] = PydField(default=None, description='字段名')
    order: str = PydField(default='asc', description='排序方向：asc | desc')


class GroupItemSchema(Schema):
    """分组项"""
    field_id: Optional[str] = PydField(default=None, description='字段 UUID')
    field: Optional[str] = PydField(default=None, description='字段名')
    order: str = PydField(default='asc', description='分组排序方向：asc | desc')


class QueryRecordsBody(Schema):
    """
    结构化查询请求体。

    支持过滤、排序、分组、分页、增量同步等高级查询能力。
    """
    filter: Optional[FilterSetSchema] = PydField(default=None, description='过滤条件')
    sort: Optional[List[SortItemSchema]] = PydField(default=None, description='排序规则（按列表顺序优先）')
    groups: Optional[List[GroupItemSchema]] = PydField(default=None, description='分组规则列表')
    search: Optional[str] = PydField(default=None, description='全文搜索关键词')
    field_key_type: str = PydField(default='name', description='字段引用方式：name（字段名）| id（字段UUID）| dbFieldName（数据库列名）')
    fields: Optional[List[str]] = PydField(default=None, description='只返回指定字段（投影）')
    page: int = PydField(default=1, ge=1, description='页码（从 1 开始）')
    page_size: int = PydField(default=DEFAULT_PAGE_SIZE, le=MAX_PAGE_SIZE, ge=1, description=f'每页记录数（最大 {MAX_PAGE_SIZE}）')
    since_version: Optional[int] = PydField(
        default=None,
        description='增量查询：只返回此版本之后的变更。响应中的 latest_version 可用于下次请求',
    )
    only_delta: bool = PydField(
        default=False,
        description='仅返回变更的记录（需配合 since_version）。为 true 时只返回新增/修改的记录',
    )


# ── 记录 CRUD ─────────────────────────────────────────────


class OpenCreateRecordBody(Schema):
    """创建单条记录请求体"""
    fields: dict = PydField(default_factory=dict, description='字段键值对，key 为字段名或字段ID（取决于 field_key_type）')
    field_key_type: str = PydField(default='name', description='字段引用方式：name | id | dbFieldName')


class OpenUpdateRecordBody(Schema):
    """更新单条记录请求体"""
    fields: dict = PydField(default_factory=dict, description='要更新的字段键值对')
    field_key_type: str = PydField(default='name', description='字段引用方式：name | id | dbFieldName')


class BulkCreateBody(Schema):
    """
    批量创建记录请求体（单次最多 2000 条）。

    每条记录的 fields 使用字段名或字段ID作为 key（取决于 field_key_type）。
    """
    records: list = PydField(description='记录列表，每项格式: {"fields": {"字段名": "值"}}')
    field_key_type: str = PydField(default='name', description='字段引用方式：name | id | dbFieldName')


class BulkUpdateBody(Schema):
    """
    批量更新记录请求体（单次最多 2000 条）。

    每条记录必须包含 id 和 fields。
    """
    records: list = PydField(description='记录列表，每项格式: {"id": "record-uuid", "fields": {"字段名": "新值"}}')
    field_key_type: str = PydField(default='name', description='字段引用方式：name | id | dbFieldName')


class BulkDeleteBody(Schema):
    """批量删除记录请求体"""
    record_ids: List[str] = PydField(description='要删除的记录 UUID 列表')


class UpsertBody(Schema):
    """
    Upsert 请求体 — 按业务字段去重，存在则更新，不存在则创建。

    适用于 CRM 同步等需要去重写入的场景。单次最多 2000 条。
    """
    records: list = PydField(description='记录列表，每项格式: {"fields": {"字段名": "值"}}')
    upsert_on: List[str] = PydField(description='去重字段列表（字段名或字段ID，取决于 field_key_type）。支持多字段联合去重')
    field_key_type: str = PydField(default='name', description='字段引用方式：name | id | dbFieldName')


# ── 导入导出 ──────────────────────────────────────────────


class OpenImportCSVBody(Schema):
    """Open API CSV 导入请求体。"""
    csv_content: str = PydField(description='CSV 文本内容')
    skip_errors: bool = PydField(default=False, description='是否跳过错误行继续导入')
    update_existing: bool = PydField(default=False, description='是否更新已存在记录')
    primary_key_field: Optional[str] = PydField(default=None, description='用于增量导入的主键字段')
    auto_create_missing_fields: bool = PydField(default=True, description='是否自动创建缺失字段')


class OpenImportJSONBody(Schema):
    """Open API JSON 导入请求体。"""
    json_content: str = PydField(
        description='JSON 文本内容，支持对象数组、structured、table_full 三种格式',
    )
    skip_errors: bool = PydField(default=False, description='是否跳过错误行继续导入')
    update_existing: bool = PydField(default=False, description='是否更新已存在记录')
    primary_key_field: Optional[str] = PydField(default=None, description='用于增量导入的主键字段')
    auto_create_missing_fields: bool = PydField(default=True, description='是否自动创建缺失字段')


class OpenImportPreviewBody(Schema):
    """Open API 导入预览请求体。"""
    file_type: Literal["csv", "json", "excel"] = PydField(
        description='预览内容类型：csv | json | excel',
    )
    file_content: Optional[str] = PydField(
        default=None,
        description='待预览的文本内容。CSV 请直接传原始文本，JSON 支持对象数组、structured、table_full',
    )
    file_base64: Optional[str] = PydField(
        default=None,
        description='当 file_type=excel 时传入 Excel 文件的 base64 文本内容，支持纯 base64 或 data URL 形式',
    )
    sheet_name: Optional[str] = PydField(default=None, description='Excel 工作表名称，仅 file_type=excel 时生效')
    preview_rows: int = PydField(default=10, ge=1, le=100, description='预览行数')


class OpenImportExcelBody(Schema):
    """Open API Excel 导入请求体。"""
    file_base64: str = PydField(
        description='Excel 文件的 base64 文本内容，支持纯 base64 或 data URL 形式',
    )
    skip_errors: bool = PydField(default=False, description='是否跳过错误行继续导入')
    update_existing: bool = PydField(default=False, description='是否更新已存在记录')
    primary_key_field: Optional[str] = PydField(default=None, description='用于增量导入的主键字段')
    sheet_name: Optional[str] = PydField(default=None, description='工作表名称，默认使用第一个工作表')
    auto_create_missing_fields: bool = PydField(default=True, description='是否自动创建缺失字段')


class OpenExportCSVBody(Schema):
    """Open API CSV 导出请求体。"""
    field_ids: Optional[List[str]] = PydField(default=None, description='要导出的字段 UUID 列表')
    record_ids: Optional[List[str]] = PydField(default=None, description='要导出的记录 UUID 列表')
    view_id: Optional[str] = PydField(default=None, description='视图 UUID（用于按视图过滤）')
    include_headers: bool = PydField(default=True, description='是否包含表头')


class OpenExportJSONBody(Schema):
    """Open API JSON 导出请求体。"""
    field_ids: Optional[List[str]] = PydField(default=None, description='要导出的字段 UUID 列表')
    record_ids: Optional[List[str]] = PydField(default=None, description='要导出的记录 UUID 列表')
    view_id: Optional[str] = PydField(default=None, description='视图 UUID（用于按视图过滤）')
    format_type: Literal["array", "structured", "table_full"] = PydField(
        default='array',
        description='JSON 导出格式：array | structured | table_full',
    )


class OpenExportExcelBody(Schema):
    """Open API Excel 导出请求体。"""
    field_ids: Optional[List[str]] = PydField(default=None, description='要导出的字段 UUID 列表')
    record_ids: Optional[List[str]] = PydField(default=None, description='要导出的记录 UUID 列表')
    view_id: Optional[str] = PydField(default=None, description='视图 UUID（用于按视图过滤）')
    include_headers: bool = PydField(default=True, description='是否包含表头')
    sheet_name: str = PydField(default='Sheet1', description='Excel 工作表名称')


class OpenExportPDFBody(Schema):
    """Open API PDF 导出请求体。"""
    field_ids: Optional[List[str]] = PydField(default=None, description='要导出的字段 UUID 列表')
    record_ids: Optional[List[str]] = PydField(default=None, description='要导出的记录 UUID 列表')
    view_id: Optional[str] = PydField(default=None, description='视图 UUID（用于按视图过滤）')
    orientation: Literal["portrait", "landscape"] = PydField(
        default='landscape',
        description='PDF 页面方向：portrait | landscape',
    )
    title: Optional[str] = PydField(default=None, description='PDF 标题，默认为表名')


# ── 聚合 ──────────────────────────────────────────────────


class AggregationItemSchema(Schema):
    """单个聚合指标"""
    field: Optional[str] = PydField(default=None, description='字段名（与 field_id 二选一）')
    field_id: Optional[str] = PydField(default=None, description='字段 UUID（与 field 二选一）')
    function: str = PydField(
        description=(
            '聚合函数：count, count_distinct, count_empty, count_not_empty, '
            'sum, average, min, max, percent_empty, percent_not_empty, percent_unique'
        ),
    )


class AggregationBody(Schema):
    """
    聚合查询请求体。

    对一张表执行聚合计算，可选配合 filter 缩小范围。

    示例:
    ```json
    {
      "aggregations": [
        {"field": "金额", "function": "sum"},
        {"field": "状态", "function": "count_distinct"},
        {"function": "count"}
      ],
      "filter": {
        "conjunction": "and",
        "filterSet": [
          {"field": "状态", "operator": "equals", "value": "已完成"}
        ]
      }
    }
    ```
    """
    aggregations: List[AggregationItemSchema] = PydField(
        description='聚合指标列表（至少一个）',
    )
    filter: Optional[FilterSetSchema] = PydField(default=None, description='过滤条件（可选）')
    field_key_type: str = PydField(default='name', description='字段引用方式：name | id | dbFieldName')


# ── RLS ───────────────────────────────────────────────────


class RLSPolicyBody(Schema):
    """RLS 策略创建/更新请求体"""
    name: str = PydField(min_length=1, max_length=100, description='策略名称')
    operation: str = PydField(
        default='ALL',
        description='操作类型: SELECT / INSERT / UPDATE / DELETE / ALL',
    )
    policy_type: str = PydField(
        default='PERMISSIVE',
        description='策略类型: PERMISSIVE (OR合并) / RESTRICTIVE (AND合并)',
    )
    condition: dict = PydField(
        description='策略条件 (Filter DSL)，支持 $token.user_id / $current_user_id 等运行时变量',
    )
    apply_to_tokens: bool = PydField(default=True, description='API Token 访问时生效')
    apply_to_jwt: bool = PydField(default=False, description='JWT 用户访问时是否也生效')
    is_active: bool = PydField(default=True, description='是否启用')


class RLSPolicyUpdateBody(Schema):
    """RLS 策略更新请求体"""
    name: Optional[str] = PydField(default=None, min_length=1, max_length=100)
    operation: Optional[str] = PydField(default=None)
    policy_type: Optional[str] = PydField(default=None)
    condition: Optional[dict] = PydField(default=None)
    apply_to_tokens: Optional[bool] = PydField(default=None)
    apply_to_jwt: Optional[bool] = PydField(default=None)
    is_active: Optional[bool] = PydField(default=None)


class RLSToggleBody(Schema):
    """表格 RLS 开关请求体"""
    rls_enabled: bool = PydField(description='是否启用行级安全')
    rls_force: bool = PydField(default=False, description='是否对 JWT 用户也强制生效')


# ── 表 / 字段 / 视图 ─────────────────────────────────────


class InlineFieldDefinition(Schema):
    """建表时内联定义的字段。"""
    name: str = PydField(description='字段名称', min_length=1, max_length=100)
    field_type: str = PydField(description='字段类型：text, number, select, date, checkbox, url, email, phone, attachment 等')
    description: Optional[str] = PydField(default='', description='字段描述')
    options: Optional[dict] = PydField(default=None, description='字段选项配置（如 select 的 choices）')
    is_primary: bool = PydField(default=False, description='是否为主字段（每表仅一个）')
    default_value: Optional[dict] = PydField(default=None, description='字段默认值')


class OpenCreateTableBody(Schema):
    """Open API 创建表格请求体"""
    space_id: str = PydField(description='目标 Space UUID')
    name: str = PydField(min_length=1, max_length=100, description='表格名称')
    description: Optional[str] = PydField(default='', description='表格描述')
    icon: Optional[str] = PydField(default=None, description='表格图标')
    use_default_fields: bool = PydField(default=True, description='是否使用默认字段模板（传入 fields 时自动忽略）')
    fields: Optional[List[InlineFieldDefinition]] = PydField(default=None, description='内联字段定义列表，一步建表+定义 schema')


class OpenUpdateTableBody(Schema):
    """Open API 更新表格请求体"""
    name: Optional[str] = PydField(default=None, min_length=1, max_length=100, description='表格名称')
    description: Optional[str] = PydField(default=None, description='表格描述')
    icon: Optional[str] = PydField(default=None, description='表格图标')


class OpenCreateFieldBody(Schema):
    """Open API 创建字段请求体"""
    name: str = PydField(min_length=1, max_length=100, description='字段名称')
    type: Optional[str] = PydField(default=None, description='字段类型（兼容别名，优先使用 field_type）')
    field_type: Optional[str] = PydField(default=None, description='字段类型：text, number, select, date, checkbox, url, email, phone, attachment, link 等')
    description: Optional[str] = PydField(default='', description='字段描述')
    options: Optional[dict] = PydField(default=None, description='字段选项配置（选项列表、格式等，依字段类型而定）')
    default_value: Optional[dict] = PydField(default=None, description='字段默认值')


class OpenUpdateFieldBody(Schema):
    """Open API 更新字段请求体"""
    name: Optional[str] = PydField(default=None, min_length=1, max_length=100, description='字段名称')
    description: Optional[str] = PydField(default=None, description='字段描述')
    options: Optional[dict] = PydField(default=None, description='字段选项配置')
    default_value: Optional[dict] = PydField(default=None, description='字段默认值')
    field_type: Optional[str] = PydField(default=None, description='转换字段类型（支持别名如 single_select → select）')
    type: Optional[str] = PydField(default=None, description='字段类型（兼容别名，优先使用 field_type）')
    is_hidden: Optional[bool] = PydField(default=None, description='是否隐藏')
    width: Optional[int] = PydField(default=None, ge=80, description='字段列宽（最小 80）')


class OpenCreateViewBody(Schema):
    """Open API 创建视图请求体"""
    name: str = PydField(min_length=1, max_length=100, description='视图名称')
    type: str = PydField(default='grid', description='视图类型：grid, kanban, calendar, gallery')
    description: Optional[str] = PydField(default=None, max_length=500, description='视图描述')
    filter: Optional[dict] = PydField(default=None, description='嵌套过滤条件（FilterSet 格式，优先于 filters）')
    filters: Optional[List[dict]] = PydField(default=None, description='过滤条件列表（旧版扁平格式）')
    sorts: Optional[List[dict]] = PydField(default=None, description='排序规则列表')
    groups: Optional[List[dict]] = PydField(default=None, description='分组规则列表（看板分列；与 config.group_by_field 对齐）')
    visible_fields: Optional[List[str]] = PydField(default=None, description='可见字段 UUID 列表')
    field_order: Optional[List[str]] = PydField(default=None, description='字段排序 UUID 列表')
    config: Optional[dict] = PydField(default=None, description='视图配置')


class OpenUpdateViewBody(Schema):
    """Open API 更新视图请求体"""
    name: Optional[str] = PydField(default=None, min_length=1, max_length=100, description='视图名称')
    description: Optional[str] = PydField(default=None, max_length=500, description='视图描述')
    filter: Optional[dict] = PydField(default=None, description='嵌套过滤条件（FilterSet 格式，优先于 filters）')
    filters: Optional[List[dict]] = PydField(default=None, description='过滤条件列表（旧版扁平格式）')
    sorts: Optional[List[dict]] = PydField(default=None, description='排序规则列表')
    groups: Optional[List[dict]] = PydField(default=None, description='分组规则列表')
    visible_fields: Optional[List[str]] = PydField(default=None, description='可见字段 UUID 列表')
    field_order: Optional[List[str]] = PydField(default=None, description='字段排序 UUID 列表')
    config: Optional[dict] = PydField(default=None, description='视图配置')


# ── Webhook ───────────────────────────────────────────────


class WebhookCreateBody(Schema):
    """创建 Webhook 请求体"""
    space_id: Optional[str] = PydField(default=None, description='Space ID（Space 级路由可省略，由 URL 路径自动填充）')
    table_id: Optional[str] = PydField(default=None, description='表格 ID（null=全 Space）')
    url: str = PydField(description='Webhook 投递地址（HTTPS）')
    events: List[str] = PydField(description='订阅的事件类型列表')
    secret: Optional[str] = PydField(default=None, description='自定义签名密钥（留空则自动生成）')
    max_retries: int = PydField(default=3, ge=0, le=10, description='最大重试次数')


class WebhookUpdateBody(Schema):
    """更新 Webhook 请求体"""
    url: Optional[str] = None
    events: Optional[List[str]] = None
    is_active: Optional[bool] = None
    secret: Optional[str] = None
    max_retries: Optional[int] = PydField(default=None, ge=0, le=10)
