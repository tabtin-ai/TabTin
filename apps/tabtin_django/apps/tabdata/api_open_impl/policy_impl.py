from uuid import UUID

from django.http import HttpRequest, JsonResponse

from apps.tabdata.api_helpers import success_response
from apps.tabdata.api_open_impl.common import impl_error_handler
from apps.tabdata.api_open_schemas import RLSPolicyBody, RLSPolicyUpdateBody, RLSToggleBody
from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.error_codes import ErrorCode, get_error_response
from apps.tabdata.models import Table
from apps.tabdata.models_rls import RowPolicy
from apps.tabdata.services.rls_service import rls_service

_VALID_OPS = {'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'ALL'}
_VALID_POLICY_TYPES = {'PERMISSIVE', 'RESTRICTIVE'}


def _validate_policy_fields(body, *, check_operation=True, check_policy_type=True):
    """校验 operation 和 policy_type，返回错误响应或 None。"""
    if check_operation and body.operation is not None:
        if body.operation.upper() not in _VALID_OPS:
            return JsonResponse(
                get_error_response(
                    ErrorCode.VALIDATION_ERROR,
                    f"无效的操作类型: {body.operation}，可选: {', '.join(sorted(_VALID_OPS))}",
                ),
                status=400,
            )
    if check_policy_type and body.policy_type is not None:
        if body.policy_type.upper() not in _VALID_POLICY_TYPES:
            return JsonResponse(
                get_error_response(ErrorCode.VALIDATION_ERROR, "策略类型必须为 PERMISSIVE 或 RESTRICTIVE"),
                status=400,
            )
    return None


@impl_error_handler('策略列表')
def list_policies_impl(request: HttpRequest, table_id: UUID):
    table = Table.objects.using(TABDATA_DB_ALIAS).get(id=table_id)

    policies = RowPolicy.objects.using(TABDATA_DB_ALIAS).filter(table_id=table_id).order_by('created_at')
    return JsonResponse(success_response(data={
        'rls_enabled': table.rls_enabled,
        'rls_force': table.rls_force,
        'policies': [
            {
                'id': str(p.id),
                'name': p.name,
                'operation': p.operation,
                'policy_type': p.policy_type,
                'condition': p.condition,
                'apply_to_tokens': p.apply_to_tokens,
                'apply_to_jwt': p.apply_to_jwt,
                'is_active': p.is_active,
                'created_at': p.created_at.isoformat() if p.created_at else None,
                'updated_at': p.updated_at.isoformat() if p.updated_at else None,
            }
            for p in policies
        ],
    }), status=200)


@impl_error_handler('策略创建')
def create_policy_impl(request: HttpRequest, table_id: UUID, body: RLSPolicyBody):
    if err := _validate_policy_fields(body):
        return err

    Table.objects.using(TABDATA_DB_ALIAS).get(id=table_id)

    if RowPolicy.objects.using(TABDATA_DB_ALIAS).filter(table_id=table_id, name=body.name).exists():
        return JsonResponse(
            get_error_response(ErrorCode.VALIDATION_ERROR, f"策略名称 \"{body.name}\" 已存在"),
            status=400,
        )

    policy = RowPolicy(
        table_id=table_id,
        name=body.name,
        operation=body.operation.upper(),
        policy_type=body.policy_type.upper(),
        condition=body.condition,
        apply_to_tokens=body.apply_to_tokens,
        apply_to_jwt=body.apply_to_jwt,
        is_active=body.is_active,
    )
    policy.save(using=TABDATA_DB_ALIAS)

    rls_service.invalidate_cache(table_id)

    return JsonResponse(success_response(data={
        'id': str(policy.id),
        'name': policy.name,
        'operation': policy.operation,
        'policy_type': policy.policy_type,
        'condition': policy.condition,
    }), status=201)


@impl_error_handler('策略更新')
def update_policy_impl(request: HttpRequest, table_id: UUID, policy_id: UUID, body: RLSPolicyUpdateBody):
    policy = RowPolicy.objects.using(TABDATA_DB_ALIAS).get(id=policy_id, table_id=table_id)

    if err := _validate_policy_fields(body):
        return err

    update_fields = []
    if body.name is not None:
        conflict = RowPolicy.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=table_id, name=body.name,
        ).exclude(id=policy_id).exists()
        if conflict:
            return JsonResponse(
                get_error_response(ErrorCode.VALIDATION_ERROR, f"策略名称 \"{body.name}\" 已存在"),
                status=400,
            )
        policy.name = body.name
        update_fields.append('name')
    if body.operation is not None:
        policy.operation = body.operation.upper()
        update_fields.append('operation')
    if body.policy_type is not None:
        policy.policy_type = body.policy_type.upper()
        update_fields.append('policy_type')
    if body.condition is not None:
        policy.condition = body.condition
        update_fields.append('condition')
    if body.apply_to_tokens is not None:
        policy.apply_to_tokens = body.apply_to_tokens
        update_fields.append('apply_to_tokens')
    if body.apply_to_jwt is not None:
        policy.apply_to_jwt = body.apply_to_jwt
        update_fields.append('apply_to_jwt')
    if body.is_active is not None:
        policy.is_active = body.is_active
        update_fields.append('is_active')

    if update_fields:
        policy.save(using=TABDATA_DB_ALIAS, update_fields=update_fields + ['updated_at'])
        rls_service.invalidate_cache(table_id)

    return JsonResponse(success_response(data={
        'id': str(policy.id),
        'name': policy.name,
        'operation': policy.operation,
        'policy_type': policy.policy_type,
        'condition': policy.condition,
        'is_active': policy.is_active,
    }), status=200)


@impl_error_handler('策略删除')
def delete_policy_impl(request: HttpRequest, table_id: UUID, policy_id: UUID):
    deleted_count, _ = (
        RowPolicy.objects.using(TABDATA_DB_ALIAS)
        .filter(id=policy_id, table_id=table_id)
        .delete()
    )
    if deleted_count == 0:
        return JsonResponse(get_error_response(ErrorCode.NOT_FOUND, "策略不存在"), status=404)

    rls_service.invalidate_cache(table_id)

    return JsonResponse(success_response(data={'deleted': True}), status=200)


@impl_error_handler('RLS 开关')
def toggle_rls_impl(request: HttpRequest, table_id: UUID, body: RLSToggleBody):
    table = Table.objects.using(TABDATA_DB_ALIAS).get(id=table_id)

    table.rls_enabled = body.rls_enabled
    table.rls_force = body.rls_force
    table.save(using=TABDATA_DB_ALIAS, update_fields=['rls_enabled', 'rls_force', 'updated_at'])

    rls_service.invalidate_cache(table_id)

    return JsonResponse(success_response(data={
        'rls_enabled': table.rls_enabled,
        'rls_force': table.rls_force,
    }), status=200)
