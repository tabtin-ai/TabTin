"""
TabData Admin 管理接口 Schema
"""

from datetime import datetime
from typing import Any, Dict, List, Optional

from ninja import Schema


class AdminTableListItemSchema(Schema):
    """后台表格列表项"""

    id: str
    name: str
    description: str = ''
    organization_id: str
    organization_name: Optional[str] = None
    space_id: Optional[str] = None
    space_name: Optional[str] = None
    owner_id: Optional[str] = None
    owner_name: Optional[str] = None
    visibility: str
    is_archived: bool
    is_trashed: bool = False
    trashed_at: Optional[datetime] = None
    previous_status: str = ''
    row_count: int = 0
    field_count: int = 0
    created_at: datetime
    updated_at: datetime


class AdminTableFieldTypeStatSchema(Schema):
    """字段类型统计"""

    field_type: str
    count: int


class AdminTableFieldSummarySchema(Schema):
    """表结构摘要"""

    total_fields: int
    hidden_fields: int
    primary_fields: int
    field_type_stats: List[AdminTableFieldTypeStatSchema]


class AdminTableOperationItemSchema(Schema):
    """后台治理动作记录"""

    id: str
    action_type: str
    operator_id: Optional[str] = None
    operator_name: str = ''
    target_table_ids: List[str]
    requested_count: int
    updated_count: int
    skipped_count: int
    dry_run: bool
    success: bool
    result_message: str = ''
    error_message: str = ''
    trace_id: str = ''
    created_at: datetime


class AdminTablePreviewFieldSchema(Schema):
    """表内容预览字段定义"""

    field_id: str
    field_name: str
    field_type: str
    is_primary: bool
    is_hidden: bool


class AdminTablePreviewRowSchema(Schema):
    """表内容预览行"""

    record_id: str
    order: float
    status: str
    values: Dict[str, Any]
    created_at: datetime
    updated_at: datetime


class AdminTableRecordPreviewSchema(Schema):
    """表内容采样预览"""

    total_rows: int
    returned_rows: int
    fields: List[AdminTablePreviewFieldSchema]
    rows: List[AdminTablePreviewRowSchema]


class AdminTablePaginationSchema(Schema):
    """分页信息"""

    total: int
    page: int
    page_size: int
    total_pages: int


class AdminTableSummarySchema(Schema):
    """后台表格统计"""

    total_tables: int
    filtered_tables: int
    active_tables: int
    archived_tables: int
    trashed_tables: int
    system_tables: int


class AdminTableOperationSummarySchema(Schema):
    """后台治理动作统计"""

    total_operations: int
    success_operations: int
    failed_operations: int
    dry_run_operations: int


class AdminTableListResponseSchema(Schema):
    """后台表格列表响应"""

    items: List[AdminTableListItemSchema]
    pagination: AdminTablePaginationSchema
    summary: AdminTableSummarySchema


class AdminTableDetailResponseSchema(Schema):
    """后台表格详情响应"""

    table: AdminTableListItemSchema
    field_summary: AdminTableFieldSummarySchema
    record_preview: AdminTableRecordPreviewSchema
    recent_operations: List[AdminTableOperationItemSchema]


class AdminTableOperationListResponseSchema(Schema):
    """后台治理动作列表响应"""

    items: List[AdminTableOperationItemSchema]
    pagination: AdminTablePaginationSchema
    summary: AdminTableOperationSummarySchema


class AdminTableAuditExportRequestSchema(Schema):
    """后台治理日志导出请求"""

    action_type: str = 'all'
    success: Optional[bool] = None
    keyword: str = ''
    table_id: str = ''
    operator_id: str = ''
    start_at: Optional[datetime] = None
    end_at: Optional[datetime] = None
    limit: int = 10000


class AdminTableBatchMutationRequestSchema(Schema):
    """批量归档/恢复请求"""

    table_ids: List[str]
    dry_run: bool = False
    reason: str = ''
    ticket_id: str = ''


class AdminTableSensitiveActionRequestSchema(Schema):
    """单表敏感操作请求"""

    reason: str = ''
    ticket_id: str = ''


class AdminTableBatchSkipItemSchema(Schema):
    """批量操作跳过项"""

    table_id: str
    reason: str


class AdminTableBatchMutationResponseSchema(Schema):
    """批量归档/恢复响应"""

    success: bool
    message: str
    dry_run: bool
    requested_count: int
    processed_count: int
    updated_count: int
    skipped: List[AdminTableBatchSkipItemSchema]
    items: List[AdminTableListItemSchema]
