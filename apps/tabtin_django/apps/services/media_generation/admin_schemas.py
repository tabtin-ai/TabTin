"""
媒体生成服务 Admin 管理接口 Schema
"""

from datetime import datetime
from typing import Any, Dict, List, Optional
from decimal import Decimal

from ninja import Schema


class AdminMediaProviderSchema(Schema):
    class Config:
        protected_namespaces = ()

    id: str
    name: str
    provider_key: str
    display_name: str
    base_url: str
    api_key_masked: str
    scope: str
    user_id: Optional[str] = None
    organization_id: Optional[str] = None
    is_active: bool
    priority: int
    rate_limit: int
    runtime_status: str
    model_count: int = 0
    created_at: datetime
    updated_at: datetime


class AdminMediaProviderCreateSchema(Schema):
    name: str
    provider_key: str = ''
    display_name: str
    base_url: str
    api_key: str
    scope: str = 'global'
    user_id: Optional[str] = None
    organization_id: Optional[str] = None
    is_active: bool = True
    priority: int = 0
    rate_limit: int = 30


class AdminMediaProviderUpdateSchema(Schema):
    display_name: Optional[str] = None
    base_url: Optional[str] = None
    api_key: Optional[str] = None
    is_active: Optional[bool] = None
    priority: Optional[int] = None
    rate_limit: Optional[int] = None
    runtime_status: Optional[str] = None


class AdminMediaModelSchema(Schema):
    class Config:
        protected_namespaces = ()

    id: str
    provider_id: str
    provider_name: str
    model_name: str
    display_name: str
    description: str = ''
    task_type: str
    supported_sizes: List[str] = []
    supported_durations: List[int] = []
    max_prompt_length: int = 500
    supports_negative_prompt: bool = False
    supports_prompt_extend: bool = True
    supports_audio: bool = False
    supports_multi_shot: bool = False
    billing_type: str
    price_per_unit: str = '0'
    price_unit: str = ''
    free_quota: int = 0
    is_active: bool
    created_at: datetime
    updated_at: datetime


class AdminMediaModelCreateSchema(Schema):
    class Config:
        protected_namespaces = ()

    provider_id: str
    model_name: str
    display_name: str
    description: str = ''
    task_type: str
    supported_sizes: List[str] = []
    supported_durations: List[int] = []
    max_prompt_length: int = 500
    supports_negative_prompt: bool = False
    supports_prompt_extend: bool = True
    supports_audio: bool = False
    supports_multi_shot: bool = False
    billing_type: str = 'image_count'
    price_per_unit: str = '0'
    price_unit: str = ''
    free_quota: int = 0
    is_active: bool = True


class AdminMediaModelUpdateSchema(Schema):
    display_name: Optional[str] = None
    description: Optional[str] = None
    supported_sizes: Optional[List[str]] = None
    supported_durations: Optional[List[int]] = None
    supports_negative_prompt: Optional[bool] = None
    supports_prompt_extend: Optional[bool] = None
    supports_audio: Optional[bool] = None
    supports_multi_shot: Optional[bool] = None
    billing_type: Optional[str] = None
    price_per_unit: Optional[str] = None
    price_unit: Optional[str] = None
    is_active: Optional[bool] = None


class AdminMediaTaskSchema(Schema):
    class Config:
        protected_namespaces = ()

    id: str
    task_type: str
    status: str
    provider_name: str = ''
    model_name: str = ''
    user_id: str
    organization_id: str = ''
    provider_task_id: str = ''
    prompt: str
    negative_prompt: str = ''
    parameters: Dict[str, Any] = {}
    input_resources: Dict[str, Any] = {}
    result_urls: List[str] = []
    stored_urls: List[str] = []
    result_metadata: Dict[str, Any] = {}
    cost_amount: str = '0'
    cost_unit: str = ''
    error_code: str = ''
    error_message: str = ''
    poll_count: int = 0
    created_at: datetime
    updated_at: datetime
    submitted_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None


class AdminMediaPaginationSchema(Schema):
    total: int
    page: int
    page_size: int
    total_pages: int


class AdminMediaTaskSummarySchema(Schema):
    total_tasks: int
    pending_tasks: int
    running_tasks: int
    succeeded_tasks: int
    failed_tasks: int


class AdminMediaProviderListResponseSchema(Schema):
    items: List[AdminMediaProviderSchema]


class AdminMediaModelListResponseSchema(Schema):
    items: List[AdminMediaModelSchema]


class AdminMediaTaskListResponseSchema(Schema):
    items: List[AdminMediaTaskSchema]
    pagination: AdminMediaPaginationSchema
    summary: AdminMediaTaskSummarySchema
