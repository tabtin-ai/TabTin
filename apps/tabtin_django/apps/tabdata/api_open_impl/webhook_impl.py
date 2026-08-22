from typing import Optional
from uuid import UUID

from django.http import HttpRequest, JsonResponse
from django.db.models import Q

from apps.tabdata.api_open_impl.common import impl_error_handler
from apps.tabdata.api_helpers import success_response
from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.error_codes import ErrorCode, get_error_response
from apps.tabdata.models import Table
from apps.tabdata.api_open_schemas import WebhookCreateBody, WebhookUpdateBody


def _ensure_webhook_space_access(
    request: HttpRequest,
    space_id: str,
    required_role: str = 'editor',
    table_id: Optional[str] = None,
):
    """校验当前请求是否可管理指定 Space 下的 webhook。"""
    from apps.tabtinspace.services.base import BaseService
    from apps.tabtinspace.services.host_resolver import resolve_host

    space = resolve_host(space_id)
    if space is None:
        return None, JsonResponse(
            get_error_response(ErrorCode.NOT_FOUND, 'Space 不存在'),
            status=404,
        )

    if not BaseService(user=request.auth).check_space_permission(str(space_id), required_role):
        return None, JsonResponse(
            get_error_response(
                ErrorCode.PERMISSION_DENIED,
                f'无权以 {required_role} 权限访问该 Space',
            ),
            status=403,
        )

    api_token = getattr(request, 'api_token', None)
    if api_token:
        if getattr(api_token, 'table_ids', None) is not None:
            if not table_id:
                return None, JsonResponse(
                    get_error_response(
                        ErrorCode.PERMISSION_DENIED,
                        '当前 Token 为表级授权，不能访问 Space 级 Webhook 能力',
                    ),
                    status=403,
                )
            if not api_token.can_access_table(str(table_id), space_id=str(space_id)):
                return None, JsonResponse(
                    get_error_response(ErrorCode.PERMISSION_DENIED, 'Token 无权访问当前表格的 Webhook'),
                    status=403,
                )
        elif not api_token.can_access_space(str(space_id)):
            return None, JsonResponse(
                get_error_response(ErrorCode.PERMISSION_DENIED, 'Token 无权访问该 Space'),
                status=403,
            )

    return space, None


def _resolve_organization_from_space(space_id: Optional[str]):
    if not space_id:
        return None, None
    from apps.tabtinspace.services.host_resolver import resolve_host
    space = resolve_host(space_id)
    if not space:
        return None, JsonResponse(
            get_error_response(ErrorCode.NOT_FOUND, 'Space 不存在'),
            status=404,
        )
    return str(space.organization_id), None


def _ensure_organization_access(request: HttpRequest, organization_id: str, required_role: str = 'editor'):
    from apps.tabtinspace.services.base import BaseService

    if not BaseService(user=request.auth).check_organization_permission(str(organization_id), required_role):
        return JsonResponse(
            get_error_response(
                ErrorCode.PERMISSION_DENIED,
                f'无权以 {required_role} 权限访问该 Organization',
            ),
            status=403,
        )
    return None


def _ensure_webhook_table_scope(
    table_id: Optional[str],
    *,
    organization_id: str,
    space_id: Optional[str] = None,
):
    """校验 webhook 绑定的表格存在且属于指定 Organization。"""
    if not table_id:
        return None, None

    try:
        table = Table.objects.using(TABDATA_DB_ALIAS).get(id=table_id)
    except Table.DoesNotExist:
        return None, JsonResponse(
            get_error_response(ErrorCode.TABLE_NOT_FOUND, '表格不存在'),
            status=404,
        )

    if str(table.organization_id) != str(organization_id):
        return None, JsonResponse(
            get_error_response(ErrorCode.VALIDATION_ERROR, 'table_id 不属于指定的 Organization'),
            status=400,
        )
    if space_id and table.space_id and str(table.space_id) != str(space_id):
        return None, JsonResponse(
            get_error_response(ErrorCode.VALIDATION_ERROR, 'table_id 不属于当前 Space 上下文'),
            status=400,
        )

    return table, None


def _get_webhook_with_access(request: HttpRequest, webhook_id: UUID, required_role: str = 'editor'):
    """按 webhook_id 获取 webhook，并校验其所属 Space 的访问权限。"""
    from apps.tabdata.models_webhook import TableWebhook

    try:
        webhook = TableWebhook.objects.using(TABDATA_DB_ALIAS).get(id=webhook_id)
    except TableWebhook.DoesNotExist:
        return None, JsonResponse(
            get_error_response(ErrorCode.NOT_FOUND, 'Webhook 不存在'),
            status=404,
        )

    if webhook.organization_id:
        err = _ensure_organization_access(request, str(webhook.organization_id), required_role=required_role)
        if err is not None:
            return None, err
    else:
        _, err = _ensure_webhook_space_access(
            request,
            str(webhook.space_id),
            required_role=required_role,
            table_id=str(webhook.table_id) if webhook.table_id else None,
        )
        if err is not None:
            return None, err

    return webhook, None


def _serialize_webhook(webhook, include_secret: bool = False) -> dict:
    """序列化 Webhook 对象"""
    result = {
        'id': str(webhook.id),
        'organization_id': str(webhook.organization_id) if webhook.organization_id else None,
        'space_id': str(webhook.space_id) if webhook.space_id else None,
        'table_id': str(webhook.table_id) if webhook.table_id else None,
        'url': webhook.url,
        'events': webhook.events,
        'is_active': webhook.is_active,
        'max_retries': webhook.max_retries,
        'total_deliveries': webhook.total_deliveries,
        'failed_deliveries': webhook.failed_deliveries,
        'last_triggered_at': webhook.last_triggered_at.isoformat() if webhook.last_triggered_at else None,
        'created_at': webhook.created_at.isoformat() if webhook.created_at else None,
        'updated_at': webhook.updated_at.isoformat() if webhook.updated_at else None,
    }
    if include_secret:
        result['secret'] = webhook.secret
    return result


@impl_error_handler('Webhook')
def create_webhook_impl(request: HttpRequest, body: WebhookCreateBody):
    if not body.space_id:
        return JsonResponse(
            get_error_response(ErrorCode.VALIDATION_ERROR, detail='space_id 不能为空'),
            status=400,
        )

    from apps.tabdata.models_webhook import TableWebhook, WEBHOOK_EVENT_TYPES

    invalid_events = [e for e in body.events if e not in WEBHOOK_EVENT_TYPES]
    if invalid_events:
        return JsonResponse(
            get_error_response(ErrorCode.VALIDATION_ERROR, detail=f'不支持的事件类型: {", ".join(invalid_events)}'),
            status=400,
        )

    _, err = _ensure_webhook_space_access(
        request,
        body.space_id,
        required_role='editor',
        table_id=body.table_id,
    )
    if err is not None:
        return err

    organization_id, err = _resolve_organization_from_space(body.space_id)
    if err is not None:
        return err

    err = _ensure_organization_access(request, organization_id, required_role='editor')
    if err is not None:
        return err

    _, err = _ensure_webhook_table_scope(
        body.table_id,
        organization_id=organization_id,
        space_id=body.space_id,
    )
    if err is not None:
        return err

    webhook = TableWebhook.objects.using(TABDATA_DB_ALIAS).create(
        organization_id=organization_id,
        space_id=body.space_id,
        table_id=body.table_id,
        url=body.url,
        events=body.events,
        secret=body.secret or TableWebhook.generate_secret(),
        max_retries=body.max_retries,
        created_by=request.auth,
    )

    return JsonResponse(
        success_response(data=_serialize_webhook(webhook, include_secret=True)),
        status=201,
    )


@impl_error_handler('Webhook')
def list_webhooks_impl(request: HttpRequest):
    from apps.tabdata.models_webhook import TableWebhook

    space_id = request.GET.get('space_id')
    if not space_id:
        return JsonResponse(
            get_error_response(ErrorCode.VALIDATION_ERROR, detail='space_id 参数必填'),
            status=400,
        )

    table_id = request.GET.get('table_id')
    organization_id, err = _resolve_organization_from_space(space_id)
    if err is not None:
        return err

    err = _ensure_organization_access(request, organization_id, required_role='editor')
    if err is not None:
        return err

    qs = TableWebhook.objects.using(TABDATA_DB_ALIAS).filter(
        Q(organization_id=organization_id)
        | Q(organization_id__isnull=True, space_id=space_id),
        space_id__in=[space_id, None],
    )

    if table_id:
        _, err = _ensure_webhook_table_scope(
            table_id,
            organization_id=organization_id,
            space_id=space_id,
        )
        if err is not None:
            return err
        qs = qs.filter(table_id=table_id)

    webhooks = list(qs)

    return JsonResponse(
        success_response(data={
            'webhooks': [_serialize_webhook(wh) for wh in webhooks],
            'total': len(webhooks),
        }),
        status=200,
    )


@impl_error_handler('Webhook')
def update_webhook_impl(request: HttpRequest, webhook_id: UUID, body: WebhookUpdateBody):
    from apps.tabdata.models_webhook import WEBHOOK_EVENT_TYPES

    webhook, err = _get_webhook_with_access(request, webhook_id, required_role='editor')
    if err is not None:
        return err

    if body.url is not None:
        webhook.url = body.url
    if body.events is not None:
        invalid_events = [e for e in body.events if e not in WEBHOOK_EVENT_TYPES]
        if invalid_events:
            return JsonResponse(
                get_error_response(ErrorCode.VALIDATION_ERROR, detail=f'不支持的事件类型: {", ".join(invalid_events)}'),
                status=400,
            )
        webhook.events = body.events
    if body.is_active is not None:
        webhook.is_active = body.is_active
    if body.secret is not None:
        webhook.secret = body.secret
    if body.max_retries is not None:
        webhook.max_retries = body.max_retries

    webhook.save()

    return JsonResponse(
        success_response(data=_serialize_webhook(webhook)),
        status=200,
    )


@impl_error_handler('Webhook')
def delete_webhook_impl(request: HttpRequest, webhook_id: UUID):
    webhook, err = _get_webhook_with_access(request, webhook_id, required_role='editor')
    if err is not None:
        return err

    webhook.delete()

    return JsonResponse(success_response(message='Webhook 已删除'), status=200)


@impl_error_handler('Webhook')
def test_webhook_impl(request: HttpRequest, webhook_id: UUID):
    from apps.tabdata.services.webhook_service import WebhookDeliveryService

    webhook, err = _get_webhook_with_access(request, webhook_id, required_role='editor')
    if err is not None:
        return err

    payload = WebhookDeliveryService.build_payload(
        event_type='webhook.test',
        space_id=str(webhook.space_id),
        table_id=str(webhook.table_id) if webhook.table_id else None,
        data={'message': 'This is a test event from TabTin'},
    )

    # 同步发送测试事件（不走 Celery）
    success = WebhookDeliveryService.deliver(str(webhook.id), payload)

    return JsonResponse(
        success_response(data={
            'success': success,
            'message': '测试事件发送成功' if success else '测试事件发送失败，请检查 URL 和网络',
        }),
        status=200,
    )
