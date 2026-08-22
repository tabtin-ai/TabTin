"""
OSS服务API数据模式定义
"""

from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field, field_validator
from datetime import datetime


class FileUploadRequest(BaseModel):
    """文件上传请求"""
    folder: Optional[str] = Field(default="", description="上传文件夹路径")
    filename: Optional[str] = Field(default=None, description="自定义文件名")
    content_type: Optional[str] = Field(default=None, description="文件MIME类型")
    tags: Optional[List[str]] = Field(default=[], description="文件标签")
    metadata: Optional[Dict[str, Any]] = Field(default={}, description="文件元数据")
    is_public: Optional[bool] = Field(default=True, description="是否公开访问")

    @field_validator('folder')
    @classmethod
    def validate_folder(cls, v):
        if v and not v.endswith('/'):
            v += '/'
        return v.lstrip('/')


class FileUploadResponse(BaseModel):
    """文件上传响应"""
    file_id: str = Field(description="文件ID")
    file_name: str = Field(description="文件名")
    file_key: str = Field(description="文件键")
    file_size: int = Field(description="文件大小(字节)")
    file_type: str = Field(description="文件类型")
    file_hash: str = Field(description="文件哈希")
    access_url: str = Field(description="访问URL")
    cdn_url: Optional[str] = Field(description="CDN URL")
    upload_time: datetime = Field(description="上传时间")


class BatchUploadRequest(BaseModel):
    """批量上传请求"""
    urls: Optional[List[str]] = Field(default=[], description="URL 列表（batch-upload-urls 使用）")
    folder: Optional[str] = Field(default="", description="上传文件夹路径")
    tags: Optional[List[str]] = Field(default=[], description="文件标签")
    metadata: Optional[Dict[str, Any]] = Field(default={}, description="文件元数据")
    is_public: Optional[bool] = Field(default=True, description="是否公开访问")
    organization_id: Optional[str] = Field(default="", description="组织 ID（用于存储计量）")
    module: Optional[str] = Field(default="", description="来源模块")
    context_type: Optional[str] = Field(default="", description="上下文类型")
    context_id: Optional[str] = Field(default="", description="上下文实体 ID")

    @field_validator('folder')
    @classmethod
    def validate_folder(cls, v):
        if v and not v.endswith('/'):
            v += '/'
        return v.lstrip('/')


class BatchUploadResponse(BaseModel):
    """批量上传响应"""
    task_id: str = Field(description="任务ID")
    task_name: str = Field(description="任务名称")
    total_files: int = Field(description="总文件数")
    status: str = Field(description="任务状态")


class FileListRequest(BaseModel):
    """文件列表请求"""
    folder: Optional[str] = Field(default="", description="文件夹路径")
    file_type: Optional[str] = Field(default=None, description="文件类型过滤")
    search: Optional[str] = Field(default="", description="搜索关键词")
    page: int = Field(default=1, ge=1, description="页码")
    page_size: int = Field(default=20, ge=1, le=100, description="每页数量")
    sort_by: Optional[str] = Field(default="created_at", description="排序字段")
    sort_order: Optional[str] = Field(default="desc", description="排序方向")

    @field_validator('folder')
    @classmethod
    def validate_folder(cls, v):
        if v and not v.endswith('/'):
            v += '/'
        return v.lstrip('/')

    @field_validator('sort_order')
    @classmethod
    def validate_sort_order(cls, v):
        if v not in ['asc', 'desc']:
            return 'desc'
        return v


class FileInfo(BaseModel):
    """文件信息"""
    file_id: str = Field(description="文件ID")
    file_name: str = Field(description="文件名")
    file_key: str = Field(description="文件键")
    file_path: str = Field(description="文件路径")
    file_size: int = Field(description="文件大小(字节)")
    file_type: str = Field(description="文件类型")
    mime_type: str = Field(description="MIME类型")
    file_extension: str = Field(description="文件扩展名")
    file_hash: str = Field(description="文件哈希")
    access_url: str = Field(description="访问URL")
    cdn_url: Optional[str] = Field(description="CDN URL")
    is_public: bool = Field(description="是否公开访问")
    download_count: int = Field(description="下载次数")
    view_count: int = Field(description="查看次数")
    tags: List[str] = Field(description="文件标签")
    metadata: Dict[str, Any] = Field(description="文件元数据")
    status: str = Field(description="文件状态")
    upload_user: Optional[str] = Field(description="上传用户")
    upload_source: Optional[str] = Field(description="上传来源")
    created_at: datetime = Field(description="创建时间")
    updated_at: datetime = Field(description="更新时间")


class FileListResponse(BaseModel):
    """文件列表响应"""
    files: List[FileInfo] = Field(description="文件列表")
    total: int = Field(description="总数量")
    page: int = Field(description="当前页码")
    page_size: int = Field(description="每页数量")
    total_pages: int = Field(description="总页数")


class FileUpdateRequest(BaseModel):
    """文件更新请求"""
    file_name: Optional[str] = Field(default=None, description="新文件名")
    tags: Optional[List[str]] = Field(default=None, description="文件标签")
    metadata: Optional[Dict[str, Any]] = Field(default=None, description="文件元数据")
    is_public: Optional[bool] = Field(default=None, description="是否公开访问")


class FileCopyRequest(BaseModel):
    """文件复制请求"""
    source_file_id: str = Field(description="源文件ID")
    target_folder: Optional[str] = Field(default="", description="目标文件夹")
    target_filename: Optional[str] = Field(default=None, description="目标文件名")

    @field_validator('target_folder')
    @classmethod
    def validate_target_folder(cls, v):
        if v and not v.endswith('/'):
            v += '/'
        return v.lstrip('/')


class FileMoveRequest(BaseModel):
    """文件移动请求"""
    source_file_id: str = Field(description="源文件ID")
    target_folder: Optional[str] = Field(default="", description="目标文件夹")
    target_filename: Optional[str] = Field(default=None, description="目标文件名")

    @field_validator('target_folder')
    @classmethod
    def validate_target_folder(cls, v):
        if v and not v.endswith('/'):
            v += '/'
        return v.lstrip('/')


class BatchDeleteRequest(BaseModel):
    """批量删除请求"""
    file_ids: List[str] = Field(description="文件ID列表", min_length=1, max_length=100)


class BatchDeleteResponse(BaseModel):
    """批量删除响应"""
    deleted_count: int = Field(description="删除成功数量")
    failed_count: int = Field(description="删除失败数量")
    failed_files: List[Dict[str, str]] = Field(description="删除失败的文件")


class PresignedUrlRequest(BaseModel):
    """预签名URL请求"""
    file_id: str = Field(description="文件ID")
    expiration: Optional[int] = Field(default=3600, ge=60, le=86400, description="过期时间(秒)")
    method: Optional[str] = Field(default="GET", description="HTTP方法")

    @field_validator('method')
    @classmethod
    def validate_method(cls, v):
        if v.upper() not in ['GET', 'PUT', 'POST', 'DELETE']:
            return 'GET'
        return v.upper()


class PresignedUrlResponse(BaseModel):
    """预签名URL响应"""
    file_id: str = Field(description="文件ID")
    presigned_url: str = Field(description="预签名URL")
    expiration: int = Field(description="过期时间(秒)")
    expires_at: datetime = Field(description="过期时间点")


class TaskInfo(BaseModel):
    """任务信息"""
    task_id: str = Field(description="任务ID")
    task_name: str = Field(description="任务名称")
    task_type: str = Field(description="任务类型")
    status: str = Field(description="任务状态")
    progress: float = Field(description="进度百分比")
    total_files: int = Field(description="总文件数")
    completed_files: int = Field(description="已完成文件数")
    failed_files: int = Field(description="失败文件数")
    total_size: int = Field(description="总大小(字节)")
    uploaded_size: int = Field(description="已上传大小(字节)")
    error_message: Optional[str] = Field(description="错误信息")
    result_data: Dict[str, Any] = Field(description="结果数据")
    created_by: Optional[str] = Field(description="创建用户")
    created_at: datetime = Field(description="创建时间")
    updated_at: datetime = Field(description="更新时间")
    started_at: Optional[datetime] = Field(description="开始时间")
    completed_at: Optional[datetime] = Field(description="完成时间")


class TaskListRequest(BaseModel):
    """任务列表请求"""
    task_type: Optional[str] = Field(default=None, description="任务类型过滤")
    status: Optional[str] = Field(default=None, description="状态过滤")
    page: int = Field(default=1, ge=1, description="页码")
    page_size: int = Field(default=20, ge=1, le=100, description="每页数量")


class TaskListResponse(BaseModel):
    """任务列表响应"""
    tasks: List[TaskInfo] = Field(description="任务列表")
    total: int = Field(description="总数量")
    page: int = Field(description="当前页码")
    page_size: int = Field(description="每页数量")
    total_pages: int = Field(description="总页数")


class BucketInfo(BaseModel):
    """存储桶信息"""
    bucket_name: str = Field(description="存储桶名称")
    region: str = Field(description="地域")
    endpoint: str = Field(description="访问端点")
    access_mode: str = Field(description="访问模式")
    cdn_domain: Optional[str] = Field(description="CDN域名")
    total_files: int = Field(description="总文件数")
    total_size: int = Field(description="总大小(字节)")
    created_at: datetime = Field(description="创建时间")


class StatisticsRequest(BaseModel):
    """统计请求"""
    start_date: Optional[str] = Field(default=None, description="开始日期(YYYY-MM-DD)")
    end_date: Optional[str] = Field(default=None, description="结束日期(YYYY-MM-DD)")
    bucket_name: Optional[str] = Field(default=None, description="存储桶名称")


class StatisticsResponse(BaseModel):
    """统计响应"""
    total_files: int = Field(description="总文件数")
    total_size: int = Field(description="总大小(字节)")
    upload_count: int = Field(description="上传次数")
    download_count: int = Field(description="下载次数")
    delete_count: int = Field(description="删除次数")
    traffic_upload: int = Field(description="上传流量(字节)")
    traffic_download: int = Field(description="下载流量(字节)")
    file_type_stats: Dict[str, int] = Field(description="文件类型统计")
    daily_stats: List[Dict[str, Any]] = Field(description="每日统计")


# ---------------------------------------------------------------------------
# 直传模式 Schema
# ---------------------------------------------------------------------------

class PresignUploadFileItem(BaseModel):
    """presign-upload-batch 中的单文件描述"""
    filename: str = Field(description="文件名")
    content_type: Optional[str] = Field(default=None, description="MIME 类型")
    file_size: int = Field(ge=0, description="文件大小（字节）")
    file_hash: Optional[str] = Field(default=None, description="文件 MD5 hex（用于秒传）")
    hash_algorithm: Optional[str] = Field(default=None, description="哈希算法（md5/sha256/sha256-sampled）")
    module: Optional[str] = Field(default="other", description="来源模块（秒传命中时用于创建 FileUsage）")
    context_type: Optional[str] = Field(default="", description="上下文类型（秒传命中时用于创建 FileUsage）")
    context_id: Optional[str] = Field(default="", description="上下文实体 ID（秒传命中时用于创建 FileUsage）")
    is_public: Optional[bool] = Field(default=False, description="是否公开访问")


class PresignUploadRequest(BaseModel):
    """请求直传签名（单文件）"""
    filename: str = Field(description="文件名（仅 basename，不含路径分隔符）")
    folder: Optional[str] = Field(default="", description="目标文件夹")
    content_type: Optional[str] = Field(default=None, description="MIME 类型")
    file_size: int = Field(ge=0, description="文件大小（字节）")
    file_hash: Optional[str] = Field(default=None, description="文件 MD5 hex（用于秒传）")
    hash_algorithm: Optional[str] = Field(default=None, description="哈希算法（md5/sha256/sha256-sampled）")
    organization_id: Optional[str] = Field(default=None, description="组织 ID（用于存储配额校验）")
    module: Optional[str] = Field(default="other", description="来源模块（chat/tabdata/tabdoc/tabslide/other）")
    context_type: Optional[str] = Field(default="", description="上下文类型（message/record/document/project）")
    context_id: Optional[str] = Field(default="", description="上下文实体 ID")
    object_key: Optional[str] = Field(default=None, description="自定义 OSS key（仅限 TabSite 等内部调用，保留完整相对路径）")
    is_public: Optional[bool] = Field(default=False, description="是否公开访问")


class PresignUploadBatchRequest(BaseModel):
    """请求直传签名（批量）"""
    files: List[PresignUploadFileItem] = Field(min_length=1, max_length=50, description="文件列表")
    folder: Optional[str] = Field(default="", description="目标文件夹")
    organization_id: Optional[str] = Field(default=None, description="组织 ID（用于存储配额校验）")


class ConfirmUploadRequest(BaseModel):
    """上传完成回调"""
    object_key: str = Field(description="OSS 对象键")
    file_name: str = Field(description="原始文件名")
    file_size: int = Field(ge=0, description="文件大小（字节）")
    content_type: Optional[str] = Field(default="application/octet-stream", description="MIME 类型")
    file_hash: Optional[str] = Field(default=None, description="文件 MD5 hex")
    hash_algorithm: Optional[str] = Field(default=None, description="哈希算法（md5/sha256/sha256-sampled）")
    module: Optional[str] = Field(default="other", description="来源模块（chat/tabdata/tabdoc/tabslide/other）")
    context_type: Optional[str] = Field(default="", description="上下文类型（message/record/document/project）")
    context_id: Optional[str] = Field(default="", description="上下文实体 ID")
    organization_id: Optional[str] = Field(default=None, description="组织 ID（用于存储计量）")
    is_public: Optional[bool] = Field(default=False, description="是否公开访问")


class ConfirmUploadBatchRequest(BaseModel):
    """批量上传完成回调"""
    items: List[ConfirmUploadRequest] = Field(min_length=1, max_length=50, description="上传确认列表")


# 通用响应模式
class SuccessResponse(BaseModel):
    """成功响应（失败时也可复用；#7767 等业务错误依赖 error_code 稳定透出）"""
    success: bool = Field(default=True, description="是否成功")
    message: str = Field(description="响应消息")
    data: Optional[Any] = Field(description="响应数据")
    timestamp: str = Field(description="时间戳")
    error_code: Optional[str] = Field(default=None, description="错误代码（success=false 时）")


class ErrorResponse(BaseModel):
    """错误响应"""
    success: bool = Field(default=False, description="是否成功")
    message: str = Field(description="错误消息")
    error_code: Optional[str] = Field(description="错误代码")
    timestamp: str = Field(description="时间戳")


# ---------------------------------------------------------------------------
# 存储分析 — Phase 1
# ---------------------------------------------------------------------------

class StorageModuleBreakdown(BaseModel):
    module: str
    display_name: str
    file_count: int
    total_bytes: int


class StorageOverviewResponse(BaseModel):
    quota_bytes: int
    used_bytes: int
    used_pct: float
    file_count: int
    approximate: bool = False
    by_module: List[StorageModuleBreakdown] = []


class StorageMemberBreakdown(BaseModel):
    user_id: str
    display_name: str = ""
    file_count: int
    total_bytes: int


class StorageFileTypeBreakdown(BaseModel):
    file_type: str
    file_count: int
    total_bytes: int


class StorageLargeFileItem(BaseModel):
    file_id: str
    file_name: str
    file_size: int
    file_type: str
    mime_type: str = ""
    module: str = ""
    module_display: str = ""
    context_type: str = ""
    context_id: str = ""
    context_display: str = ""
    upload_user: str = ""
    upload_user_display: str = ""
    created_at: str = ""
    cdn_url: str = ""


# ---------------------------------------------------------------------------
# 存储文件管理 — Phase 2
# ---------------------------------------------------------------------------

class StorageFileItem(BaseModel):
    file_id: str
    file_name: str
    file_size: int
    file_type: str
    mime_type: str = ""
    module: str = ""
    module_display: str = ""
    context_type: str = ""
    context_id: str = ""
    context_display: str = ""
    upload_user: str = ""
    upload_user_display: str = ""
    created_at: str = ""
    cdn_url: str = ""
    ref_count: int = 0
    is_safe_to_delete: bool = False


class StorageFileListResponse(BaseModel):
    items: List[StorageFileItem] = []
    next_cursor: Optional[str] = None
    has_more: bool = False
    total_estimate: int = 0


class StorageFileUsageItem(BaseModel):
    usage_id: str
    module: str
    module_display: str = ""
    context_type: str = ""
    context_id: str = ""
    is_active: bool = True
    created_at: str = ""


class StorageBatchDeleteRequest(BaseModel):
    file_ids: List[str] = Field(min_length=1, max_length=50, description="要删除的文件 ID 列表")


class StorageBatchDeleteResultItem(BaseModel):
    file_id: str
    success: bool
    message: str = ""
    usage_count_removed: int = 0


class StorageBatchDeleteResponse(BaseModel):
    success_count: int = 0
    failed_count: int = 0
    results: List[StorageBatchDeleteResultItem] = []
