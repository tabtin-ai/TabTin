"""Schema Discovery API

提供 Schema 模板和缓存管理的 API
"""

from ninja import Router
from ninja.errors import HttpError
from typing import Optional, List
from pydantic import BaseModel, Field
import logging

from apps.schema_discovery.services import TemplateManager, SchemaCache
from apps.schema_discovery.models import GeneratedSchema, SchemaUsageLog

logger = logging.getLogger(__name__)

router = Router(tags=["Schema Discovery"])


# ==================== Schemas ====================

class SchemaTemplateOut(BaseModel):
    """Schema 模板输出"""
    id: str
    module_name: str
    template_json: dict
    description: str
    version: str
    is_active: bool
    created_at: str
    updated_at: str

    class Config:
        from_attributes = True


class QueryCachedSchemaIn(BaseModel):
    """查询缓存 Schema 请求"""
    url: str = Field(..., description="目标 URL")
    min_confidence: float = Field(0.8, description="最小置信度", ge=0, le=1)
    user_id: Optional[str] = Field(None, description="用户 ID（可选）")


class SaveSchemaIn(BaseModel):
    """保存 Schema 请求"""
    thread_id: str = Field(..., description="Thread ID")
    user_id: str = Field(..., description="用户 ID")
    url: str = Field(..., description="原始 URL")
    schema_json: dict = Field(..., description="完整的 Schema JSON")
    modules_used: List[str] = Field(..., description="使用的模块列表")
    confidence: float = Field(..., description="置信度", ge=0, le=1)
    sample_data: Optional[List[dict]] = Field(None, description="采样数据")
    validation_stats: Optional[dict] = Field(None, description="验证统计")


class LogUsageIn(BaseModel):
    """记录使用日志请求"""
    schema_id: str = Field(..., description="Schema ID")
    user_id: str = Field(..., description="用户 ID")
    url: str = Field(..., description="使用的 URL")
    instruction: str = Field("", description="用户指令")
    success: bool = Field(..., description="是否成功")
    extracted_count: Optional[int] = Field(None, description="提取的数据条数")
    error_message: str = Field("", description="错误信息")
    execution_time_ms: Optional[int] = Field(None, description="执行时间（毫秒）")


class SchemaOut(BaseModel):
    """Schema 输出"""
    id: str
    thread_id: str
    user_id: str
    url: str
    domain: str
    url_pattern: str
    schema_json: dict
    modules_used: list
    confidence: float
    sample_data: Optional[list]
    validation_stats: Optional[dict]
    usage_count: int
    success_rate: Optional[float]
    created_at: str
    last_used_at: Optional[str]

    class Config:
        from_attributes = True


class UsageLogOut(BaseModel):
    """使用日志输出"""
    id: int
    schema_id: str
    user_id: str
    url: str
    instruction: str
    success: bool
    extracted_count: Optional[int]
    error_message: str
    execution_time_ms: Optional[int]
    created_at: str

    class Config:
        from_attributes = True


# ==================== 模板管理 API ====================

@router.get("/templates", response=List[SchemaTemplateOut], summary="获取所有活跃模板")
def list_templates(request):
    """获取所有活跃的 Schema 模板"""
    try:
        templates = TemplateManager.get_all_templates()
        # 转换为 dict 列表并处理类型转换
        result = []
        for template in templates:
            result.append({
                'id': str(template.id),
                'module_name': template.module_name,
                'template_json': template.template_json,
                'description': template.description,
                'version': template.version,
                'is_active': template.is_active,
                'created_at': template.created_at.isoformat(),
                'updated_at': template.updated_at.isoformat(),
            })
        return result
    except Exception as e:
        logger.error(f"❌ 获取模板列表失败: {e}")
        raise HttpError(500, f"获取模板列表失败: {str(e)}")


@router.get("/templates/{module_name}", response=SchemaTemplateOut, summary="获取指定模板")
def get_template(request, module_name: str):
    """根据模块名获取 Schema 模板"""
    try:
        template = TemplateManager.get_template(module_name)
        if not template:
            raise HttpError(404, f"模板不存在: {module_name}")
        return {
            'id': str(template.id),
            'module_name': template.module_name,
            'template_json': template.template_json,
            'description': template.description,
            'version': template.version,
            'is_active': template.is_active,
            'created_at': template.created_at.isoformat(),
            'updated_at': template.updated_at.isoformat(),
        }
    except HttpError:
        raise
    except Exception as e:
        logger.error(f"❌ 获取模板失败: {e}")
        raise HttpError(500, f"获取模板失败: {str(e)}")


@router.post("/templates/{module_name}/generate", response=dict, summary="根据模板生成 Schema")
def generate_from_template(request, module_name: str, overrides: dict = None):
    """根据模板生成 Schema

    Args:
        module_name: 模板模块名
        overrides: 覆盖的字段（可选）
    """
    try:
        schema = TemplateManager.generate_from_template(module_name, overrides or {})
        return schema
    except ValueError as e:
        raise HttpError(400, str(e))
    except Exception as e:
        logger.error(f"❌ 生成 Schema 失败: {e}")
        raise HttpError(500, f"生成 Schema 失败: {str(e)}")


# ==================== Schema 缓存 API ====================

@router.post("/schemas/query", response=Optional[SchemaOut], summary="查询缓存的 Schema")
def query_cached_schema(request, payload: QueryCachedSchemaIn):
    """查询缓存的 Schema"""
    try:
        schema = SchemaCache.query_cached_schema(
            url=payload.url,
            min_confidence=payload.min_confidence,
            user_id=payload.user_id
        )
        if not schema:
            return None
        return {
            'id': str(schema.id),
            'thread_id': schema.thread_id,
            'user_id': str(schema.user_id),
            'url': schema.url,
            'domain': schema.domain,
            'url_pattern': schema.url_pattern,
            'schema_json': schema.schema_json,
            'modules_used': schema.modules_used,
            'confidence': schema.confidence,
            'sample_data': schema.sample_data,
            'validation_stats': schema.validation_stats,
            'usage_count': schema.usage_count,
            'success_rate': schema.success_rate,
            'created_at': schema.created_at.isoformat(),
            'last_used_at': schema.last_used_at.isoformat() if schema.last_used_at else None,
        }
    except Exception as e:
        logger.error(f"❌ 查询缓存失败: {e}")
        raise HttpError(500, f"查询缓存失败: {str(e)}")


@router.post("/schemas", response=SchemaOut, summary="保存生成的 Schema")
def save_schema(request, payload: SaveSchemaIn):
    """保存生成的 Schema"""
    try:
        schema = SchemaCache.save_schema(
            thread_id=payload.thread_id,
            user_id=payload.user_id,
            url=payload.url,
            schema_json=payload.schema_json,
            modules_used=payload.modules_used,
            confidence=payload.confidence,
            sample_data=payload.sample_data,
            validation_stats=payload.validation_stats
        )
        return {
            'id': str(schema.id),
            'thread_id': schema.thread_id,
            'user_id': str(schema.user_id),
            'url': schema.url,
            'domain': schema.domain,
            'url_pattern': schema.url_pattern,
            'schema_json': schema.schema_json,
            'modules_used': schema.modules_used,
            'confidence': schema.confidence,
            'sample_data': schema.sample_data,
            'validation_stats': schema.validation_stats,
            'usage_count': schema.usage_count,
            'success_rate': schema.success_rate,
            'created_at': schema.created_at.isoformat(),
            'last_used_at': schema.last_used_at.isoformat() if schema.last_used_at else None,
        }
    except Exception as e:
        logger.error(f"❌ 保存 Schema 失败: {e}")
        raise HttpError(500, f"保存 Schema 失败: {str(e)}")


@router.get("/schemas/{schema_id}", response=SchemaOut, summary="获取指定 Schema")
def get_schema(request, schema_id: str):
    """根据 ID 获取 Schema"""
    try:
        schema = GeneratedSchema.objects.get(pk=schema_id)
        return {
            'id': str(schema.id),
            'thread_id': schema.thread_id,
            'user_id': str(schema.user_id),
            'url': schema.url,
            'domain': schema.domain,
            'url_pattern': schema.url_pattern,
            'schema_json': schema.schema_json,
            'modules_used': schema.modules_used,
            'confidence': schema.confidence,
            'sample_data': schema.sample_data,
            'validation_stats': schema.validation_stats,
            'usage_count': schema.usage_count,
            'success_rate': schema.success_rate,
            'created_at': schema.created_at.isoformat(),
            'last_used_at': schema.last_used_at.isoformat() if schema.last_used_at else None,
        }
    except GeneratedSchema.DoesNotExist:
        raise HttpError(404, f"Schema 不存在: {schema_id}")
    except Exception as e:
        logger.error(f"❌ 获取 Schema 失败: {e}")
        raise HttpError(500, f"获取 Schema 失败: {str(e)}")


@router.get("/schemas", response=List[SchemaOut], summary="根据域名查询 Schema")
def list_schemas_by_domain(request, domain: str, min_confidence: float = 0.0, limit: int = 10):
    """根据域名查询 Schema"""
    try:
        schemas = SchemaCache.get_schemas_by_domain(
            domain=domain,
            min_confidence=min_confidence,
            limit=limit
        )
        result = []
        for schema in schemas:
            result.append({
                'id': str(schema.id),
                'thread_id': schema.thread_id,
                'user_id': str(schema.user_id),
                'url': schema.url,
                'domain': schema.domain,
                'url_pattern': schema.url_pattern,
                'schema_json': schema.schema_json,
                'modules_used': schema.modules_used,
                'confidence': schema.confidence,
                'sample_data': schema.sample_data,
                'validation_stats': schema.validation_stats,
                'usage_count': schema.usage_count,
                'success_rate': schema.success_rate,
                'created_at': schema.created_at.isoformat(),
                'last_used_at': schema.last_used_at.isoformat() if schema.last_used_at else None,
            })
        return result
    except Exception as e:
        logger.error(f"❌ 查询 Schema 失败: {e}")
        raise HttpError(500, f"查询 Schema 失败: {str(e)}")


@router.post("/schemas/{schema_id}/usage", response=UsageLogOut, summary="记录 Schema 使用日志")
def log_schema_usage(request, schema_id: str, payload: LogUsageIn):
    """记录 Schema 使用日志"""
    try:
        log = SchemaCache.log_usage(
            schema_id=schema_id,
            user_id=payload.user_id,
            url=payload.url,
            instruction=payload.instruction,
            success=payload.success,
            extracted_count=payload.extracted_count,
            error_message=payload.error_message,
            execution_time_ms=payload.execution_time_ms
        )
        return {
            'id': log.id,
            'schema_id': str(log.schema_id),
            'user_id': str(log.user_id),
            'url': log.url,
            'instruction': log.instruction,
            'success': log.success,
            'extracted_count': log.extracted_count,
            'error_message': log.error_message,
            'execution_time_ms': log.execution_time_ms,
            'created_at': log.created_at.isoformat(),
        }
    except GeneratedSchema.DoesNotExist:
        raise HttpError(404, f"Schema 不存在: {schema_id}")
    except Exception as e:
        logger.error(f"❌ 记录使用日志失败: {e}")
        raise HttpError(500, f"记录使用日志失败: {str(e)}")


@router.get("/schemas/{schema_id}/usage", response=List[UsageLogOut], summary="获取 Schema 使用日志")
def get_schema_usage_logs(request, schema_id: str, limit: int = 50):
    """获取 Schema 的使用日志"""
    try:
        logs = SchemaUsageLog.objects.filter(schema_id=schema_id).order_by('-created_at')[:limit]
        result = []
        for log in logs:
            result.append({
                'id': log.id,
                'schema_id': str(log.schema_id),
                'user_id': str(log.user_id),
                'url': log.url,
                'instruction': log.instruction,
                'success': log.success,
                'extracted_count': log.extracted_count,
                'error_message': log.error_message,
                'execution_time_ms': log.execution_time_ms,
                'created_at': log.created_at.isoformat(),
            })
        return result
    except Exception as e:
        logger.error(f"❌ 获取使用日志失败: {e}")
        raise HttpError(500, f"获取使用日志失败: {str(e)}")


@router.delete("/schemas/cleanup", response=dict, summary="清理低质量 Schema")
def cleanup_low_quality_schemas(
    request,
    min_confidence: float = 0.5,
    min_success_rate: float = 0.3,
    min_usage_count: int = 5
):
    """清理低质量的 Schema"""
    try:
        deleted_count = SchemaCache.delete_low_quality_schemas(
            min_confidence=min_confidence,
            min_success_rate=min_success_rate,
            min_usage_count=min_usage_count
        )
        return {"deleted_count": deleted_count, "message": f"已删除 {deleted_count} 个低质量 Schema"}
    except Exception as e:
        logger.error(f"❌ 清理失败: {e}")
        raise HttpError(500, f"清理失败: {str(e)}")
