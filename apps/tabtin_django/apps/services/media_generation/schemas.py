"""
媒体生成服务 API 数据模式
"""

from typing import Any, Dict, List, Optional
from pydantic import AliasChoices, BaseModel, ConfigDict, Field


class BaseResponse(BaseModel):
    success: bool
    message: Optional[str] = None
    error_code: Optional[str] = None


# ── 图片生成 ──

class GenerateImageRequest(BaseModel):
    model_config = ConfigDict(protected_namespaces=(), populate_by_name=True)

    model_id: Optional[str] = Field(None, description="模型 UUID")
    # 兼容旧客户端/视频路径仍发的 `model` 字段
    model_name: Optional[str] = Field(
        None,
        description="模型名称（如 wan2.6-t2i）；也可传 catalog 的 id（UUID）",
        validation_alias=AliasChoices("model_name", "model"),
    )
    prompt: str = Field(..., description="提示词", max_length=1500)
    negative_prompt: Optional[str] = Field("", description="反向提示词", max_length=500)
    size: Optional[str] = Field(None, description="分辨率（如 1024*1024）")
    n: Optional[int] = Field(1, ge=1, le=4, description="生成数量")
    seed: Optional[int] = Field(None, description="随机种子")
    prompt_extend: Optional[bool] = Field(True, description="是否开启提示词智能改写")
    organization_id: str = Field(..., description="组织ID（必填）")
    extra_params: Optional[Dict[str, Any]] = Field(None, description="额外参数透传")


class GenerateVideoRequest(BaseModel):
    model_config = ConfigDict(protected_namespaces=(), populate_by_name=True)

    model_id: Optional[str] = Field(None, description="模型 UUID")
    model_name: Optional[str] = Field(
        None,
        description="模型名称（如 wan2.6-t2v）；也可传 catalog 的 id（UUID）",
        validation_alias=AliasChoices("model_name", "model"),
    )
    task_type: Optional[str] = Field("text2video", description="任务类型: text2video / image2video")
    prompt: str = Field(..., description="提示词", max_length=1500)
    negative_prompt: Optional[str] = Field("", description="反向提示词", max_length=500)
    size: Optional[str] = Field(None, description="分辨率（如 1280*720）")
    duration: Optional[int] = Field(5, ge=2, le=15, description="时长(秒)")
    seed: Optional[int] = Field(None, description="随机种子")
    prompt_extend: Optional[bool] = Field(True, description="是否开启提示词智能改写")
    input_image_url: Optional[str] = Field(None, description="首帧图片URL（图生视频）")
    input_audio_url: Optional[str] = Field(None, description="音频URL")
    organization_id: str = Field(..., description="组织ID（必填）")
    extra_params: Optional[Dict[str, Any]] = Field(None, description="额外参数透传")


class TaskResponse(BaseResponse):
    """任务提交/查询响应"""
    task_id: Optional[str] = None
    task_type: Optional[str] = None
    status: Optional[str] = None
    provider_task_id: Optional[str] = None


class StoredMediaFile(BaseModel):
    """OSS 永久产物的稳定身份。"""
    index: int
    file_id: str
    file_name: str
    mime_type: str
    file_size: int
    access_url: str
    artifact_message_id: Optional[str] = None


class TaskDetailResponse(TaskResponse):
    """任务详情响应"""
    prompt: Optional[str] = None
    parameters: Optional[Dict[str, Any]] = None
    result_urls: Optional[List[str]] = None
    stored_urls: Optional[List[str]] = None
    storage_status: Optional[str] = None
    stored_files: Optional[List[StoredMediaFile]] = None
    result_metadata: Optional[Dict[str, Any]] = None
    error_code: Optional[str] = None
    error_message: Optional[str] = None
    created_at: Optional[str] = None
    completed_at: Optional[str] = None


class TaskListResponse(BaseResponse):
    """任务列表响应"""
    tasks: List[TaskDetailResponse] = []
    total: int = 0


class ModelInfoResponse(BaseModel):
    class Config:
        protected_namespaces = ()

    id: str
    model_name: str
    display_name: str
    description: str = ""
    task_type: str
    provider: str
    supported_sizes: List[str] = []
    supported_durations: List[int] = []
    supports_negative_prompt: bool = False
    supports_audio: bool = False
    supports_multi_shot: bool = False
    billing_type: str = ""
    price_per_unit: str = ""
    price_unit: str = ""


class ModelCatalogResponse(BaseResponse):
    models: List[ModelInfoResponse] = []
