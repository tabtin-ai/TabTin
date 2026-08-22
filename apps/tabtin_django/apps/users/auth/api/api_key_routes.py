"""API Key 管理路由。"""

from datetime import timedelta

from django.http import HttpRequest
from django.utils import timezone
from ninja import Router

from apps.i18n.response import success_response
from apps.services.common.db_router import postgres_app_db_alias

from ._shared import jwt_auth, UserApiKey, CreateApiKeySchema, UpdateApiKeySchema

router = Router()


def _key_to_info(key: UserApiKey) -> dict:
    return {
        'id': str(key.id),
        'organization_id': key.organization_id,
        'name': key.name,
        'description': key.description,
        'key_display': key.mask_key_id(),
        'scopes': key.scopes,
        'rate_limit': key.rate_limit,
        'is_active': key.is_active,
        'expired_at': key.expired_at.isoformat() if key.expired_at else None,
        'last_used_at': key.last_used_at.isoformat() if key.last_used_at else None,
        'use_count': key.use_count,
        'created_at': key.created_at.isoformat(),
    }


@router.post("/api-keys", auth=jwt_auth, tags=["API Key"])
def create_api_key(request: HttpRequest, payload: CreateApiKeySchema):
    """创建 API Key（明文仅返回一次）。organization_id 可选，为空则等价于用户本人登录。"""
    from ninja.errors import HttpError as NinjaHttpError
    user = request.auth

    api_key = getattr(request, 'api_key', None)
    if api_key is not None and not api_key.has_scope('*'):
        raise NinjaHttpError(403, 'API Key 不允许创建新 Key，需要完全访问权限')

    organization_id = (payload.organization_id or '').strip()
    if organization_id:
        from apps.tabtinspace.models import OrganizationMember
        if not OrganizationMember.objects.using(postgres_app_db_alias()).filter(
            user_id=str(user.id), organization_id=organization_id,
        ).exists():
            raise NinjaHttpError(403, '你不是该组织的成员，无法创建限定该组织的 API Key')

    expired_at = None
    if payload.expired_days:
        expired_at = timezone.now() + timedelta(days=payload.expired_days)

    key_instance, plain_key = UserApiKey.create_key(
        user=user,
        name=payload.name,
        organization_id=organization_id,
        description=payload.description,
        scopes=payload.scopes,
        rate_limit=payload.rate_limit,
        expired_at=expired_at,
    )

    return success_response(
        data={
            **_key_to_info(key_instance),
            'plain_key': plain_key,
        },
        message='API Key 已创建，请妥善保存，此密钥不会再次显示',
    )


@router.get("/api-keys", auth=jwt_auth, tags=["API Key"])
def list_api_keys(request: HttpRequest):
    """列出当前用户的所有 API Key（脱敏）"""
    user = request.auth
    keys = UserApiKey.objects.using('default').filter(user=user).order_by('-created_at')
    return success_response(data={
        'keys': [_key_to_info(k) for k in keys],
        'total': keys.count(),
    })


@router.patch("/api-keys/{key_id}", auth=jwt_auth, tags=["API Key"])
def update_api_key(request: HttpRequest, key_id: str, payload: UpdateApiKeySchema):
    """更新 API Key（名称/描述/启用状态）"""
    user = request.auth
    try:
        key = UserApiKey.objects.using('default').get(id=key_id, user=user)
    except UserApiKey.DoesNotExist:
        return success_response(success=False, message='API Key 不存在', code=404)

    if payload.name is not None:
        key.name = payload.name
    if payload.description is not None:
        key.description = payload.description
    if payload.is_active is not None:
        key.is_active = payload.is_active
    key.save(using='default', update_fields=['name', 'description', 'is_active', 'updated_at'])

    return success_response(data=_key_to_info(key), message='已更新')


@router.delete("/api-keys/{key_id}", auth=jwt_auth, tags=["API Key"])
def delete_api_key(request: HttpRequest, key_id: str):
    """撤销（删除）API Key"""
    user = request.auth
    try:
        key = UserApiKey.objects.using('default').get(id=key_id, user=user)
    except UserApiKey.DoesNotExist:
        return success_response(success=False, message='API Key 不存在', code=404)

    key_display = key.mask_key_id()
    key.delete(using='default')

    return success_response(message=f'API Key {key_display} 已撤销')
