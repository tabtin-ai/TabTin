"""
RAG API Schemas

定义请求和响应的数据模型
"""

from typing import List, Dict, Any, Optional
from pydantic import BaseModel, Field
from datetime import datetime


# ===== 索引管理相关 =====

class IndexTableRequest(BaseModel):
    """为单个表格创建索引"""
    table_id: str = Field(..., description="表格 ID（UUID）")
    force: bool = Field(default=False, description="是否强制重建索引")


class IndexTableRecordsRequest(BaseModel):
    """为表格的所有记录创建索引"""
    table_id: str = Field(..., description="表格 ID（UUID）")
    force: bool = Field(default=False, description="是否强制重建索引")


class IndexBatchRequest(BaseModel):
    """批量创建索引"""
    table_ids: List[str] = Field(..., description="表格 ID 列表", max_length=100)
    force: bool = Field(default=False, description="是否强制重建索引")


class IndexDocumentRequest(BaseModel):
    """为单个文档创建索引"""
    document_id: str = Field(..., description="文档 ID（UUID）")
    force: bool = Field(default=False, description="是否强制重建索引")


class DeleteIndexRequest(BaseModel):
    """删除索引"""
    table_id: Optional[str] = Field(None, description="表格 ID（可选）")
    record_id: Optional[str] = Field(None, description="记录 ID（可选）")
    document_id: Optional[str] = Field(None, description="文档 ID（可选）")


class IndexResponse(BaseModel):
    """索引操作响应"""
    success: bool = Field(..., description="是否成功")
    status: str = Field(..., description="操作状态")
    message: Optional[str] = Field(None, description="消息")
    data: Optional[Dict[str, Any]] = Field(None, description="详细数据")


class BatchIndexResponse(BaseModel):
    """批量索引响应"""
    success: bool = Field(..., description="是否成功")
    total: int = Field(..., description="总数")
    completed: int = Field(..., description="成功数")
    skipped: int = Field(..., description="跳过数")
    failed: int = Field(..., description="失败数")
    errors: List[Dict[str, str]] = Field(default=[], description="错误列表")


# ===== 检索相关 =====

class SearchRequest(BaseModel):
    """检索请求"""
    query: str = Field(..., description="查询文本", min_length=1)
    scope: str = Field(default="organization", description="检索范围（organization/project/table）")
    scope_id: Optional[str] = Field(None, description="范围 ID（可选）")
    top_k: int = Field(default=10, ge=1, le=50, description="返回结果数量")
    similarity_threshold: Optional[float] = Field(None, ge=0.0, le=1.0, description="相似度阈值")


class SearchTableRequest(BaseModel):
    """表格检索请求"""
    query: str = Field(..., description="查询文本", min_length=1)
    organization_id: Optional[str] = Field(None, description="工作区 ID（可选）")
    top_k: int = Field(default=5, ge=1, le=20, description="返回结果数量")


class SearchRecordRequest(BaseModel):
    """记录检索请求"""
    query: str = Field(..., description="查询文本", min_length=1)
    table_id: Optional[str] = Field(None, description="表格 ID（可选）")
    organization_id: Optional[str] = Field(None, description="组织 ID（用于计费归属）")
    top_k: int = Field(default=10, ge=1, le=50, description="返回结果数量")


class TableResult(BaseModel):
    """表格检索结果"""
    table_id: str
    table_name: str
    similarity_score: float
    content_preview: Optional[str] = None
    metadata: Dict[str, Any] = {}


class RecordResult(BaseModel):
    """记录检索结果"""
    record_id: str
    table_id: str
    table_name: str
    similarity_score: float
    content: str
    metadata: Dict[str, Any] = {}
    created_at: str


class SearchResponse(BaseModel):
    """检索响应"""
    success: bool = Field(..., description="是否成功")
    query: str = Field(..., description="查询文本")
    total: int = Field(..., description="结果总数")
    tables: List[TableResult] = Field(default=[], description="表格结果")
    records: List[RecordResult] = Field(default=[], description="记录结果")
    context: Optional[str] = Field(None, description="格式化的上下文")
    metadata: Optional[Dict[str, Any]] = Field(None, description="元数据")
    response_time_ms: Optional[int] = Field(None, description="响应时间（毫秒）")


# ===== 统计相关 =====

class IndexStatsResponse(BaseModel):
    """索引统计响应"""
    success: bool = Field(..., description="是否成功")
    table_embeddings: int = Field(..., description="表格向量数")
    record_embeddings: int = Field(..., description="记录向量数")
    document_embeddings: int = Field(default=0, description="文档向量数")
    skill_embeddings: int = Field(default=0, description="技能向量数")
    total_embeddings: int = Field(..., description="总向量数")
    embedding_tasks: Optional[int] = Field(None, description="待处理任务数")


class TableIndexInfo(BaseModel):
    """表格索引信息"""
    table_id: str
    table_name: str
    content_hash: str
    status: str
    created_at: datetime
    updated_at: datetime
    metadata: Dict[str, Any] = {}


class RecordIndexInfo(BaseModel):
    """记录索引信息"""
    record_id: str
    table_id: str
    table_name: str
    content_hash: str
    status: str
    priority: int
    version: int
    created_at: datetime
    updated_at: datetime


class IndexListResponse(BaseModel):
    """索引列表响应"""
    success: bool = Field(..., description="是否成功")
    total: int = Field(..., description="总数")
    items: List[Dict[str, Any]] = Field(..., description="索引列表")
    page: int = Field(default=1, description="页码")
    page_size: int = Field(default=20, description="每页数量")


# ===== 通用响应 =====

class ErrorResponse(BaseModel):
    """错误响应"""
    success: bool = Field(False, description="是否成功")
    error: str = Field(..., description="错误类型")
    message: str = Field(..., description="错误消息")
    details: Optional[Dict[str, Any]] = Field(None, description="详细信息")


class SuccessResponse(BaseModel):
    """成功响应"""
    success: bool = Field(True, description="是否成功")
    message: str = Field(..., description="消息")
    data: Optional[Dict[str, Any]] = Field(None, description="数据")


# ===== 代码索引相关 =====

class CodeChunkItem(BaseModel):
    """单个代码块"""
    file_path: str = Field(..., description="文件相对路径")
    start_line: int = Field(..., ge=1, description="起始行号 (1-indexed)")
    end_line: int = Field(..., ge=1, description="结束行号 (inclusive)")
    content: str = Field(..., description="代码内容")
    signature: str = Field(default='', description="函数/类签名")
    kind: str = Field(default='block', description="代码块类型: function/class/method/interface/module/block")
    language: str = Field(..., description="编程语言标识")
    metadata: Dict[str, Any] = Field(default_factory=dict, description="扩展元数据")


class CodeIndexRequest(BaseModel):
    """提交代码块用于后端 embedding"""
    project_id: str = Field(..., description="项目标识 ({organization_id}:{hash})")
    organization_id: str = Field(..., description="组织 ID")
    chunks: List[CodeChunkItem] = Field(..., description="代码块列表", max_length=250)
    file_hashes: Optional[Dict[str, str]] = Field(None, description="文件路径 -> 文件级 content hash 映射（用于增量同步）")
    force: bool = Field(default=False, description="是否强制重建（忽略 content_hash 去重）")


class CodeIndexDeleteRequest(BaseModel):
    """删除代码索引"""
    project_id: str = Field(..., description="项目标识")
    organization_id: Optional[str] = Field(None, description="组织 ID（用于权限校验）")
    file_paths: Optional[List[str]] = Field(None, description="要删除的文件路径列表（为空则删除整个项目）")


class CodeSyncRequest(BaseModel):
    """增量同步请求：前端发送文件 hash 列表，后端返回需要重新 chunking 的文件"""
    project_id: str = Field(..., description="项目标识")
    organization_id: Optional[str] = Field(None, description="组织 ID（用于权限校验）")
    file_hashes: Dict[str, str] = Field(..., description="文件路径 -> content_hash 映射")


class CodeSyncResponse(BaseModel):
    """增量同步响应"""
    files_to_reindex: List[str] = Field(default=[], description="需要重新 chunking 的文件路径")
    files_to_remove: List[str] = Field(default=[], description="后端有但前端已删除的文件路径")
    up_to_date_count: int = Field(default=0, description="无需更新的文件数")
