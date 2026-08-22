"""
RAG v2 API Schemas

统一检索接口的请求/响应模型，支持跨内容类型的语义检索。
"""

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field


# ===== 内容类型定义 =====

ContentType = Literal["table", "record", "skill", "tool", "mail", "document", "code"]


# ===== 检索请求 =====

class UnifiedSearchRequest(BaseModel):
    """统一检索请求"""

    query: str = Field(..., description="查询文本", min_length=1, max_length=2000)
    content_types: Optional[List[ContentType]] = Field(
        None,
        description="要检索的内容类型列表，为空时检索所有可用类型",
    )
    organization_id: Optional[str] = Field(None, description="组织 ID")
    top_k: int = Field(default=10, ge=1, le=50, description="每种类型返回的最大结果数")
    similarity_threshold: Optional[float] = Field(
        None, ge=0.0, le=1.0,
        description="相似度阈值（0-1），为空时使用默认配置",
    )
    scope: Optional[Dict[str, str]] = Field(
        None,
        description="检索范围约束，如 {\"space_id\": \"...\", \"table_id\": \"...\"}",
    )
    return_context: bool = Field(
        default=True,
        description="是否返回组装好的 LLM 上下文",
    )


# ===== 检索结果 =====

class SearchHit(BaseModel):
    """统一检索结果条目"""

    content_type: ContentType = Field(..., description="内容类型")
    source_id: str = Field(..., description="来源对象 ID")
    title: str = Field(default="", description="标题/名称")
    content: str = Field(default="", description="内容摘要")
    similarity: float = Field(..., description="相似度分数 (0-1)")
    metadata: Dict[str, Any] = Field(default_factory=dict, description="附加元数据")


class UnifiedSearchResponse(BaseModel):
    """统一检索响应"""

    success: bool = Field(True)
    query: str = Field(..., description="查询文本")
    total: int = Field(default=0, description="结果总数")
    hits: List[SearchHit] = Field(default_factory=list, description="检索结果列表")
    context: Optional[str] = Field(None, description="组装好的 LLM 上下文")
    type_counts: Dict[str, int] = Field(
        default_factory=dict,
        description="各类型的结果数量",
    )
    response_time_ms: Optional[int] = Field(None, description="响应耗时 (ms)")


class UnifiedSearchErrorResponse(BaseModel):
    """统一检索错误响应"""

    success: bool = Field(False)
    error: str = Field(..., description="错误类型")
    message: str = Field(..., description="错误消息")
