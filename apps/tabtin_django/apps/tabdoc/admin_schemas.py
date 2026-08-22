"""
TabDoc Admin 管理接口 Schema
"""

from datetime import datetime
from typing import List, Optional

from ninja import Schema
from pydantic import Field, model_validator


class AdminDocListItemSchema(Schema):
    """后台文档列表项"""

    id: str
    title: str
    status: str
    organization_id: str
    organization_name: Optional[str] = None
    space_id: str
    space_name: Optional[str] = None
    parent_id: Optional[str] = None
    parent_title: Optional[str] = None
    latest_version: int
    icon: str = ''
    tags: List[str] = Field(default_factory=list)
    permission_override_count: int
    version_count: int
    content_length: int
    created_by_id: Optional[str] = None
    created_by_name: Optional[str] = None
    updated_by_id: Optional[str] = None
    updated_by_name: Optional[str] = None
    is_trashed: bool = False
    trashed_at: Optional[datetime] = None
    previous_status: str = ''
    created_at: datetime
    updated_at: datetime


class AdminDocPaginationSchema(Schema):
    """分页信息"""

    total: int
    page: int
    page_size: int
    total_pages: int


class AdminDocSummarySchema(Schema):
    """后台文档统计"""

    total_documents: int
    filtered_documents: int
    active_documents: int
    archived_documents: int
    trashed_documents: int
    documents_with_permission_overrides: int


class AdminDocListResponseSchema(Schema):
    """后台文档列表响应"""

    items: List[AdminDocListItemSchema]
    pagination: AdminDocPaginationSchema
    summary: AdminDocSummarySchema


class AdminDocVersionSchema(Schema):
    """后台文档版本条目"""

    id: str
    document_id: str
    version: Optional[int] = None
    created_by_id: Optional[str] = None
    created_by_name: Optional[str] = None
    last_saved_at: Optional[datetime] = None
    created_at: datetime


class AdminDocPermissionSchema(Schema):
    """后台文档权限条目"""

    id: str
    document_id: str
    subject_type: str
    subject_id: str
    permission: str
    is_active: bool
    created_by_id: Optional[str] = None
    created_by_name: Optional[str] = None
    created_at: datetime
    updated_at: datetime


class AdminDocDetailStatsSchema(Schema):
    """后台文档详情统计"""

    total_versions: int
    total_permission_overrides: int
    active_permission_overrides: int


class AdminDocDetailResponseSchema(Schema):
    """后台文档详情响应"""

    document: AdminDocListItemSchema
    content_raw: str  # 实际可能是 HTML 或 Markdown，来自 document.description_markdown
    content_plaintext: str
    recent_versions: List[AdminDocVersionSchema]
    permissions: List[AdminDocPermissionSchema]
    stats: AdminDocDetailStatsSchema


class AdminDocBatchMutationRequestSchema(Schema):
    """批量归档/恢复请求"""

    document_ids: List[str]
    dry_run: bool = False
    reason: str = ''
    ticket_id: str = ''


class AdminDocBatchSkipItemSchema(Schema):
    """批量操作跳过项"""

    document_id: str
    reason: str


class AdminDocBatchMutationResponseSchema(Schema):
    """批量归档/恢复响应"""

    success: bool
    message: str
    dry_run: bool
    requested_count: int
    processed_count: int
    updated_count: int
    skipped: List[AdminDocBatchSkipItemSchema]
    items: List[AdminDocListItemSchema]


class AdminDocRestoreRequestSchema(Schema):
    """版本恢复请求"""

    version: Optional[int] = None
    version_id: Optional[str] = None
    reason: str = ''
    ticket_id: str = ''

    @model_validator(mode="after")
    def check_version_or_version_id(self) -> "AdminDocRestoreRequestSchema":
        if self.version is None and self.version_id is None:
            raise ValueError("version 和 version_id 至少须提供一个")
        return self


class AdminDocRestoreResponseSchema(Schema):
    """版本恢复响应"""

    success: bool
    message: str
    document: AdminDocListItemSchema


class AdminDocSensitiveActionRequestSchema(Schema):
    """单动作敏感操作参数"""

    reason: str = ''
    ticket_id: str = ''


class AdminDocPermissionEntryInputSchema(Schema):
    """权限覆盖输入条目"""

    subject_type: str
    subject_id: str
    permission: str
    is_active: bool = True


class AdminDocPermissionsUpdateRequestSchema(Schema):
    """权限覆盖更新请求"""

    entries: List[AdminDocPermissionEntryInputSchema]
    reason: str = ''
    ticket_id: str = ''


class AdminDocPermissionsUpdateResponseSchema(Schema):
    """权限覆盖更新响应"""

    success: bool
    message: str
    entries: List[AdminDocPermissionSchema]


class AdminDocOperationItemSchema(Schema):
    """治理任务条目"""

    id: str
    action_type: str
    operator_id: Optional[str] = None
    operator_name: str = ''
    target_document_ids: List[str]
    requested_count: int
    updated_count: int
    skipped_count: int
    dry_run: bool
    success: bool
    result_message: str = ''
    error_message: str = ''
    trace_id: str = ''
    created_at: datetime


class AdminDocOperationSummarySchema(Schema):
    """治理任务摘要"""

    total_operations: int
    success_operations: int
    failed_operations: int
    dry_run_operations: int


class AdminDocOperationListResponseSchema(Schema):
    """治理任务列表响应"""

    items: List[AdminDocOperationItemSchema]
    pagination: AdminDocPaginationSchema
    summary: AdminDocOperationSummarySchema


class AdminDocAuditExportRequestSchema(Schema):
    """治理审计导出请求"""

    action_type: str = 'all'
    success: Optional[bool] = None
    keyword: str = ''
    document_id: str = ''
    limit: int = 5000
