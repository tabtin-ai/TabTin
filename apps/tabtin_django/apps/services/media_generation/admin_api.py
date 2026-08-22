"""
媒体生成服务 Admin 管理 API

- 仅后台 staff 用户可访问读接口
- 仅后台 superuser 可执行写操作
"""

from __future__ import annotations

import logging
from decimal import Decimal

from django.db.models import Count, Q
from ninja import Router
from ninja.errors import HttpError

from apps.users.auth.permissions import StaffAuth, SuperuserAuth

from .models import MediaProvider, MediaModel, MediaTask
from .admin_schemas import (
    AdminMediaProviderSchema,
    AdminMediaProviderCreateSchema,
    AdminMediaProviderUpdateSchema,
    AdminMediaProviderListResponseSchema,
    AdminMediaModelSchema,
    AdminMediaModelCreateSchema,
    AdminMediaModelUpdateSchema,
    AdminMediaModelListResponseSchema,
    AdminMediaTaskSchema,
    AdminMediaTaskListResponseSchema,
    AdminMediaTaskSummarySchema,
    AdminMediaPaginationSchema,
)

router = Router(auth=StaffAuth())
logger = logging.getLogger(__name__)

def _mask_api_key(key: str) -> str:
    if not key or len(key) < 8:
        return '***'
    return key[:6] + '...' + key[-4:]

def _provider_to_schema(p: MediaProvider) -> AdminMediaProviderSchema:
    return AdminMediaProviderSchema(
        id=str(p.id),
        name=p.name,
        provider_key=p.provider_key,
        display_name=p.display_name,
        base_url=p.base_url,
        api_key_masked=_mask_api_key(p.api_key),
        scope=p.scope,
        user_id=p.user_id,
        organization_id=p.organization_id,
        is_active=p.is_active,
        priority=p.priority,
        rate_limit=p.rate_limit,
        runtime_status=p.runtime_status,
        model_count=p.mediamodel_set.count(),
        created_at=p.created_at,
        updated_at=p.updated_at,
    )

def _model_to_schema(m: MediaModel) -> AdminMediaModelSchema:
    return AdminMediaModelSchema(
        id=str(m.id),
        provider_id=str(m.provider_id),
        provider_name=m.provider.display_name if m.provider else '',
        model_name=m.model_name,
        display_name=m.display_name,
        description=m.description,
        task_type=m.task_type,
        supported_sizes=m.supported_sizes or [],
        supported_durations=m.supported_durations or [],
        max_prompt_length=m.max_prompt_length,
        supports_negative_prompt=m.supports_negative_prompt,
        supports_prompt_extend=m.supports_prompt_extend,
        supports_audio=m.supports_audio,
        supports_multi_shot=m.supports_multi_shot,
        billing_type=m.billing_type,
        price_per_unit=str(m.price_per_unit),
        price_unit=m.price_unit,
        free_quota=m.free_quota,
        is_active=m.is_active,
        created_at=m.created_at,
        updated_at=m.updated_at,
    )

def _task_to_schema(t: MediaTask) -> AdminMediaTaskSchema:
    return AdminMediaTaskSchema(
        id=str(t.id),
        task_type=t.task_type,
        status=t.status,
        provider_name=t.provider.display_name if t.provider else '',
        model_name=t.model.model_name if t.model else '',
        user_id=t.user_id,
        organization_id=t.organization_id or '',
        provider_task_id=t.provider_task_id,
        prompt=t.prompt,
        negative_prompt=t.negative_prompt,
        parameters=t.parameters or {},
        input_resources=t.input_resources or {},
        result_urls=t.result_urls or [],
        stored_urls=t.stored_urls or [],
        result_metadata=t.result_metadata or {},
        cost_amount=str(t.cost_amount),
        cost_unit=t.cost_unit,
        error_code=t.error_code,
        error_message=t.error_message,
        poll_count=t.poll_count,
        created_at=t.created_at,
        updated_at=t.updated_at,
        submitted_at=t.submitted_at,
        completed_at=t.completed_at,
    )

# ── 一键初始化 ──

@router.post('/media/seed-defaults', auth=SuperuserAuth())
def seed_defaults(request):
    """一键初始化默认提供商和模型配置"""

    from .seed_data import seed_default_data
    result = seed_default_data(api_key="", dry_run=False)
    logger.info(
        f"[MediaAdmin] Seed defaults: providers={result['created_providers']}, "
        f"models={result['created_models']}, skipped={result['skipped_models']}"
    )
    return {
        "success": True,
        "message": (
            f"初始化完成: 创建 {result['created_providers']} 个提供商, "
            f"{result['created_models']} 个模型, "
            f"跳过 {result['skipped_models']} 个已存在模型"
        ),
        "created_providers": result["created_providers"],
        "created_models": result["created_models"],
        "skipped_models": result["skipped_models"],
        "details": result["details"],
    }

# ── Provider CRUD ──

@router.get('/media/providers', auth=StaffAuth(), response=AdminMediaProviderListResponseSchema)
def list_providers(request):
    """获取所有媒体生成提供商"""

    providers = MediaProvider.objects.all().order_by('-priority', '-created_at')
    return AdminMediaProviderListResponseSchema(
        items=[_provider_to_schema(p) for p in providers]
    )

@router.post('/media/providers', auth=SuperuserAuth(), response=AdminMediaProviderSchema)
def create_provider(request, payload: AdminMediaProviderCreateSchema):
    """创建媒体生成提供商"""
    provider = MediaProvider.objects.create(
        name=payload.name,
        provider_key=payload.provider_key or payload.name,
        display_name=payload.display_name,
        base_url=payload.base_url,
        api_key=payload.api_key,
        scope=payload.scope,
        user_id=payload.user_id,
        organization_id=payload.organization_id,
        is_active=payload.is_active,
        priority=payload.priority,
        rate_limit=payload.rate_limit,
    )
    logger.info(f"[MediaAdmin] 创建 Provider: {provider.display_name} ({provider.id})")
    return _provider_to_schema(provider)

@router.put('/media/providers/{provider_id}', auth=SuperuserAuth(), response=AdminMediaProviderSchema)
def update_provider(request, provider_id: str, payload: AdminMediaProviderUpdateSchema):
    """更新媒体生成提供商"""
    try:
        provider = MediaProvider.objects.get(id=provider_id)
    except MediaProvider.DoesNotExist:
        raise HttpError(404, '提供商不存在')

    update_fields = []
    for field_name in ('display_name', 'base_url', 'api_key', 'is_active', 'priority', 'rate_limit', 'runtime_status'):
        value = getattr(payload, field_name, None)
        if value is not None:
            setattr(provider, field_name, value)
            update_fields.append(field_name)

    if update_fields:
        update_fields.append('updated_at')
        provider.save(update_fields=update_fields)
        logger.info(f"[MediaAdmin] 更新 Provider: {provider.display_name}, fields={update_fields}")

    return _provider_to_schema(provider)

@router.delete('/media/providers/{provider_id}', auth=SuperuserAuth())
def delete_provider(request, provider_id: str):
    """删除媒体生成提供商"""
    try:
        provider = MediaProvider.objects.get(id=provider_id)
    except MediaProvider.DoesNotExist:
        raise HttpError(404, '提供商不存在')

    name = provider.display_name
    provider.delete()
    logger.info(f"[MediaAdmin] 删除 Provider: {name} ({provider_id})")
    return {"success": True, "message": f"已删除提供商: {name}"}

# ── Model CRUD ──

@router.get('/media/models', auth=StaffAuth(), response=AdminMediaModelListResponseSchema)
def list_models(request, task_type: str = None, provider_id: str = None):
    """获取所有媒体生成模型"""

    qs = MediaModel.objects.select_related('provider').all()
    if task_type:
        qs = qs.filter(task_type=task_type)
    if provider_id:
        qs = qs.filter(provider_id=provider_id)
    qs = qs.order_by('task_type', 'model_name')
    return AdminMediaModelListResponseSchema(
        items=[_model_to_schema(m) for m in qs]
    )

@router.post('/media/models', auth=SuperuserAuth(), response=AdminMediaModelSchema)
def create_model(request, payload: AdminMediaModelCreateSchema):
    """创建媒体生成模型"""
    try:
        provider = MediaProvider.objects.get(id=payload.provider_id)
    except MediaProvider.DoesNotExist:
        raise HttpError(404, '提供商不存在')

    model = MediaModel.objects.create(
        provider=provider,
        model_name=payload.model_name,
        display_name=payload.display_name,
        description=payload.description,
        task_type=payload.task_type,
        supported_sizes=payload.supported_sizes,
        supported_durations=payload.supported_durations,
        max_prompt_length=payload.max_prompt_length,
        supports_negative_prompt=payload.supports_negative_prompt,
        supports_prompt_extend=payload.supports_prompt_extend,
        supports_audio=payload.supports_audio,
        supports_multi_shot=payload.supports_multi_shot,
        billing_type=payload.billing_type,
        price_per_unit=Decimal(payload.price_per_unit) if payload.price_per_unit else Decimal('0'),
        price_unit=payload.price_unit,
        free_quota=payload.free_quota,
        is_active=payload.is_active,
    )
    logger.info(f"[MediaAdmin] 创建 Model: {model.model_name} ({model.id})")
    return _model_to_schema(model)

@router.put('/media/models/{model_id}', auth=SuperuserAuth(), response=AdminMediaModelSchema)
def update_model(request, model_id: str, payload: AdminMediaModelUpdateSchema):
    """更新媒体生成模型"""
    try:
        model = MediaModel.objects.select_related('provider').get(id=model_id)
    except MediaModel.DoesNotExist:
        raise HttpError(404, '模型不存在')

    update_fields = []
    for field_name in (
        'display_name', 'description', 'supported_sizes', 'supported_durations',
        'supports_negative_prompt', 'supports_prompt_extend', 'supports_audio',
        'supports_multi_shot', 'billing_type', 'price_unit', 'is_active',
    ):
        value = getattr(payload, field_name, None)
        if value is not None:
            setattr(model, field_name, value)
            update_fields.append(field_name)

    if payload.price_per_unit is not None:
        model.price_per_unit = Decimal(payload.price_per_unit)
        update_fields.append('price_per_unit')

    if update_fields:
        update_fields.append('updated_at')
        model.save(update_fields=update_fields)
        logger.info(f"[MediaAdmin] 更新 Model: {model.model_name}, fields={update_fields}")

    return _model_to_schema(model)

@router.delete('/media/models/{model_id}', auth=SuperuserAuth())
def delete_model(request, model_id: str):
    """删除媒体生成模型"""
    try:
        model = MediaModel.objects.get(id=model_id)
    except MediaModel.DoesNotExist:
        raise HttpError(404, '模型不存在')

    name = model.model_name
    model.delete()
    logger.info(f"[MediaAdmin] 删除 Model: {name} ({model_id})")
    return {"success": True, "message": f"已删除模型: {name}"}

# ── Task 管理 ──

@router.get('/media/tasks', auth=StaffAuth(), response=AdminMediaTaskListResponseSchema)
def list_tasks(
    request,
    task_type: str = None,
    status: str = None,
    user_id: str = None,
    keyword: str = None,
    page: int = 1,
    page_size: int = 20,
):
    """获取媒体生成任务列表"""

    qs = MediaTask.objects.select_related('provider', 'model').all()
    if task_type:
        qs = qs.filter(task_type=task_type)
    if status:
        qs = qs.filter(status=status)
    if user_id:
        qs = qs.filter(user_id=user_id)
    if keyword:
        qs = qs.filter(Q(prompt__icontains=keyword) | Q(provider_task_id__icontains=keyword))

    total = qs.count()
    total_pages = max(1, (total + page_size - 1) // page_size)
    offset = (page - 1) * page_size
    items = qs.order_by('-created_at')[offset:offset + page_size]

    summary_qs = MediaTask.objects.all()
    summary = AdminMediaTaskSummarySchema(
        total_tasks=summary_qs.count(),
        pending_tasks=summary_qs.filter(status='pending').count(),
        running_tasks=summary_qs.filter(status='running').count(),
        succeeded_tasks=summary_qs.filter(status='succeeded').count(),
        failed_tasks=summary_qs.filter(status='failed').count(),
    )

    return AdminMediaTaskListResponseSchema(
        items=[_task_to_schema(t) for t in items],
        pagination=AdminMediaPaginationSchema(
            total=total, page=page, page_size=page_size, total_pages=total_pages,
        ),
        summary=summary,
    )

@router.get('/media/tasks/{task_id}', auth=StaffAuth(), response=AdminMediaTaskSchema)
def get_task(request, task_id: str):
    """获取单个任务详情"""

    try:
        task = MediaTask.objects.select_related('provider', 'model').get(id=task_id)
    except MediaTask.DoesNotExist:
        raise HttpError(404, '任务不存在')
    return _task_to_schema(task)

@router.post('/media/tasks/{task_id}/retry', auth=SuperuserAuth())
def retry_task(request, task_id: str):
    """重试失败的任务"""
    try:
        task = MediaTask.objects.get(id=task_id)
    except MediaTask.DoesNotExist:
        raise HttpError(404, '任务不存在')

    if task.status != 'failed':
        raise HttpError(400, f'仅失败任务可重试，当前状态: {task.status}')

    task.status = 'pending'
    task.error_code = ''
    task.error_message = ''
    task.poll_count = 0
    task.completed_at = None
    task.save(update_fields=['status', 'error_code', 'error_message', 'poll_count', 'completed_at', 'updated_at'])

    from .tasks.polling import poll_media_task
    poll_media_task.delay(str(task.id))

    logger.info(f"[MediaAdmin] 重试任务: {task_id}")
    return {"success": True, "message": "任务已重新提交"}
