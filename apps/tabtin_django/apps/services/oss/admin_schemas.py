"""
OSS 后台治理接口 Schema
"""

from datetime import datetime
from typing import List, Optional

from ninja import Schema


class AdminOssOrganizationRepairAssessmentSchema(Schema):
    """单文件 organization 归属修复评估"""

    file_id: str
    file_name: str = ''
    repair_state: str = ''
    reason_code: str = ''
    recommended_action_code: str = ''
    recommended_action_label: str = ''
    recommended_action_detail: str = ''
    current_organization_id: Optional[str] = None
    resolved_organization_id: Optional[str] = None
    evidence_source: str = ''
    reference_organization_ids: List[str] = []
    upload_task_organization_ids: List[str] = []
    repaired: bool = False
    reason: str = ''


class AdminOssFileItemSchema(Schema):
    """后台文件列表项"""

    id: str
    file_name: str
    file_key: str
    file_path: str
    file_size: int
    file_size_display: str = ''
    file_type: str
    mime_type: str
    file_extension: str
    bucket_name: str
    is_public: bool
    status: str
    upload_user: str = ''
    upload_source: str = ''
    download_count: int = 0
    view_count: int = 0
    ref_count: int = 0
    organization_id: Optional[str] = None
    space_id: Optional[str] = None
    organization_repair: Optional[AdminOssOrganizationRepairAssessmentSchema] = None
    created_at: datetime
    updated_at: datetime
    deleted_at: Optional[datetime] = None


class AdminOssReferenceItemSchema(Schema):
    """后台附件引用项"""

    reference_id: str
    organization_id: str
    space_id: Optional[str] = None
    table_id: str
    field_id: str
    record_id: Optional[str] = None
    is_deleted: bool
    created_at: datetime
    updated_at: datetime


class AdminOssTaskItemSchema(Schema):
    """后台上传任务项"""

    task_id: str
    task_name: str
    task_type: str
    status: str
    progress: float
    total_files: int
    completed_files: int
    failed_files: int
    total_size: int
    uploaded_size: int
    error_message: str = ''
    created_by: str = ''
    organization_id: str = ''
    created_at: datetime
    updated_at: datetime
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None


class AdminOssPaginationSchema(Schema):
    """分页信息"""

    total: int
    page: int
    page_size: int
    total_pages: int


class AdminOssFileUsageItemSchema(Schema):
    """通用文件引用追踪项"""

    id: str
    module: str
    context_type: str = ''
    context_id: str = ''
    user_id: str = ''
    is_active: bool = True
    created_at: datetime
    deactivated_at: Optional[datetime] = None


class AdminOssFileSummarySchema(Schema):
    """后台文件统计"""

    total_files: int
    filtered_files: int
    completed_files: int
    failed_files: int
    deleted_files: int
    public_files: int
    private_files: int
    total_size: int
    orphan_files: int = 0
    orphan_size: int = 0
    owned_files: int = 0
    owned_size: int = 0
    unowned_files: int = 0
    unowned_size: int = 0
    orphan_unowned_files: int = 0
    orphan_unowned_size: int = 0
    repairable_unowned_files: int = 0
    conflict_unowned_files: int = 0
    unverifiable_unowned_files: int = 0
    repairable_from_attachment_reference_files: int = 0
    repairable_from_upload_task_files: int = 0
    repairable_from_dual_evidence_files: int = 0
    conflict_reference_files: int = 0
    conflict_upload_task_files: int = 0
    conflict_cross_source_files: int = 0
    missing_evidence_unowned_files: int = 0
    lookup_error_unowned_files: int = 0


class AdminOssTaskSummarySchema(Schema):
    """后台上传任务统计"""

    total_tasks: int
    processing_tasks: int
    completed_tasks: int
    failed_tasks: int
    cancelled_tasks: int


class AdminOssFileListResponseSchema(Schema):
    """后台文件列表响应"""

    items: List[AdminOssFileItemSchema]
    pagination: AdminOssPaginationSchema
    summary: AdminOssFileSummarySchema


class AdminOssFileDetailResponseSchema(Schema):
    """后台文件详情响应"""

    file: AdminOssFileItemSchema
    references: List[AdminOssReferenceItemSchema]
    reference_count: int
    usages: List[AdminOssFileUsageItemSchema] = []
    usage_count: int = 0
    related_tasks: List[AdminOssTaskItemSchema]


class AdminOssTaskListResponseSchema(Schema):
    """后台上传任务列表响应"""

    items: List[AdminOssTaskItemSchema]
    pagination: AdminOssPaginationSchema
    summary: AdminOssTaskSummarySchema


class AdminOssOperationItemSchema(Schema):
    """后台治理操作日志项"""

    id: str
    action_type: str
    operator_id: Optional[str] = None
    operator_name: str = ''
    organization_id: str = ''
    organization_ids: List[str]
    target_file_ids: List[str]
    requested_count: int
    processed_count: int
    deleted_count: int
    skipped_count: int
    dry_run: bool
    success: bool
    message: str = ''
    error_message: str = ''
    trace_id: str = ''
    created_at: datetime


class AdminOssOperationSummarySchema(Schema):
    """后台治理操作统计"""

    total_operations: int
    success_operations: int
    failed_operations: int
    dry_run_operations: int


class AdminOssOperationListResponseSchema(Schema):
    """后台治理操作列表响应"""

    items: List[AdminOssOperationItemSchema]
    pagination: AdminOssPaginationSchema
    summary: AdminOssOperationSummarySchema


class AdminOssOrganizationCostItemSchema(Schema):
    """组织存储用量对账项"""

    organization_id: str
    file_count: int
    file_storage_bytes: int
    metered_file_count: int
    metered_storage_bytes: int
    storage_gap_bytes: int
    last_metered_at: Optional[datetime] = None
    metered_updated_at: Optional[datetime] = None


class AdminOssCostSummarySchema(Schema):
    """存储用量对账统计"""

    organization_count: int
    file_organization_count: int
    metered_organization_count: int
    total_file_storage_bytes: int
    total_metered_storage_bytes: int
    total_storage_gap_bytes: int
    file_only_organization_count: int = 0
    metered_only_organization_count: int = 0
    organization_gap_count: int = 0
    unowned_files: int = 0
    unowned_file_storage_bytes: int = 0


class AdminOssCostOverviewResponseSchema(Schema):
    """存储用量对账响应"""

    items: List[AdminOssOrganizationCostItemSchema]
    pagination: AdminOssPaginationSchema
    summary: AdminOssCostSummarySchema


class AdminOssBatchDeleteRequestSchema(Schema):
    """批量删除请求"""

    file_ids: List[str]
    dry_run: bool = False
    reason: str = ''
    ticket_id: str = ''


class AdminOssBatchDeleteSkipItemSchema(Schema):
    """批量删除跳过项"""

    file_id: str
    reason: str


class AdminOssBatchDeleteResponseSchema(Schema):
    """批量删除响应"""

    success: bool
    message: str
    dry_run: bool
    requested_count: int
    processed_count: int
    deleted_count: int
    skipped: List[AdminOssBatchDeleteSkipItemSchema]
    items: List[AdminOssFileItemSchema]


class AdminOssBatchRepairOrganizationRequestSchema(Schema):
    """批量修复文件 organization 归属请求"""

    file_ids: List[str]
    dry_run: bool = False
    reason: str = ''
    ticket_id: str = ''


class AdminOssBatchRepairOrganizationResultSchema(AdminOssOrganizationRepairAssessmentSchema):
    """单文件 organization 归属修复结果"""


class AdminOssBatchRepairOrganizationResponseSchema(Schema):
    """批量修复文件 organization 归属响应"""

    success: bool
    message: str
    dry_run: bool
    requested_count: int
    processed_count: int
    repaired_count: int
    skipped_count: int
    results: List[AdminOssOrganizationRepairAssessmentSchema]
