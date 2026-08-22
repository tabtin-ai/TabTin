import logging
from typing import Optional
from uuid import UUID

from django.http import HttpRequest, JsonResponse

from apps.tabdata.api_helpers import success_response
from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.error_codes import ErrorCode, get_error_response
from apps.tabdata.field_creation_contract import validate_ui_creatable_field_type
from apps.tabdata.models import Table, TableField
from apps.tabdata.schemas import TableFieldOut
from apps.tabdata.services import TableService
from apps.tabdata.services.table_service import _DEFAULT_VALUE_UNSET, resolve_field_type_alias
from apps.tabdata.api_open_schemas import OpenCreateFieldBody, OpenUpdateFieldBody
from apps.tabdata.api_open_impl.common import impl_error_handler

logger = logging.getLogger(__name__)


def _resolve_field_type(body) -> Optional[str]:
    raw = body.field_type or body.type
    if not raw:
        return None
    return resolve_field_type_alias(raw)


@impl_error_handler('字段列表')
def list_fields_impl(request: HttpRequest, table_id: UUID):
    service = TableService(user=request.auth)
    fields = service.list_fields(table_id)
    serialized = [TableFieldOut.from_orm(f).dict() for f in fields]
    return JsonResponse(
        success_response(data={'fields': serialized, 'total': len(serialized)}),
        status=200,
    )


def get_field_map_impl(request: HttpRequest, table_id: UUID):
    try:
        service = TableService(user=request.auth)
        fields = service.list_fields(table_id)
        active_fields = [f for f in fields if not f.is_deleted]
        field_map = {f.name: str(f.id) for f in active_fields}
        api_name_map = {
            f.api_name: str(f.id) for f in active_fields
            if getattr(f, 'api_name', '')
        }
        table = Table.objects.using(TABDATA_DB_ALIAS).get(id=table_id)
        result = {
            'field_map': field_map,
            'schema_version': getattr(table, 'schema_version', 0),
        }
        if api_name_map:
            result['api_name_map'] = api_name_map
        return JsonResponse(
            success_response(data=result),
            status=200,
        )
    except Table.DoesNotExist:
        return JsonResponse(
            get_error_response(ErrorCode.TABLE_NOT_FOUND, "表格不存在"),
            status=404,
        )
    except Exception:
        logger.exception('Open API get_field_map error')
        return JsonResponse(
            get_error_response(ErrorCode.INTERNAL_ERROR, "获取字段映射失败"),
            status=500,
        )


@impl_error_handler('字段')
def open_create_field_impl(request: HttpRequest, table_id: UUID, body: OpenCreateFieldBody):
    resolved_type = _resolve_field_type(body)
    if not resolved_type:
        return JsonResponse(
            get_error_response(ErrorCode.VALIDATION_ERROR, '必须指定 field_type 或 type'),
            status=400,
        )
    field_type_error = validate_ui_creatable_field_type(resolved_type)
    if field_type_error:
        return JsonResponse(
            get_error_response(ErrorCode.VALIDATION_ERROR, field_type_error),
            status=400,
        )

    service = TableService(user=request.auth)
    field = service.create_field(
        table_id=table_id,
        name=body.name,
        field_type=resolved_type,
        description=body.description or '',
        options=body.options,
        default_value=body.default_value,
    )
    if not field:
        return JsonResponse(
            get_error_response(ErrorCode.PERMISSION_DENIED, "创建字段失败"),
            status=403,
        )
    return JsonResponse(
        success_response(data=TableFieldOut.from_orm(field).dict()),
        status=201,
    )


@impl_error_handler('字段')
def open_update_field_impl(request: HttpRequest, table_id: UUID, field_id: UUID, body: OpenUpdateFieldBody):
    service = TableService(user=request.auth)

    resolved_type = _resolve_field_type(body) if (body.field_type or body.type) else None
    if resolved_type:
        field_type_error = validate_ui_creatable_field_type(resolved_type)
        if field_type_error:
            return JsonResponse(
                get_error_response(ErrorCode.VALIDATION_ERROR, field_type_error),
                status=400,
            )
        existing = TableField.objects.using(TABDATA_DB_ALIAS).filter(
            id=field_id, is_deleted=False,
        ).values_list('field_type', flat=True).first()
        if existing is None:
            return JsonResponse(
                get_error_response(ErrorCode.FIELD_NOT_FOUND, "字段不存在"),
                status=404,
            )
        if existing != resolved_type:
            conv_result = service.convert_field_type(
                field_id=field_id,
                target_type=resolved_type,
                target_options=body.options,
            )
            if not conv_result.get('success'):
                return JsonResponse(
                    get_error_response(
                        ErrorCode.VALIDATION_ERROR,
                        conv_result.get('error', '字段类型转换失败'),
                    ),
                    status=400,
                )

    field = service.update_field(
        field_id=field_id,
        name=body.name,
        description=body.description,
        options=body.options if not resolved_type else None,
        default_value=(
            body.default_value
            if 'default_value' in body.model_fields_set
            else _DEFAULT_VALUE_UNSET
        ),
        is_hidden=body.is_hidden,
        width=body.width,
    )
    if not field:
        return JsonResponse(
            get_error_response(ErrorCode.FIELD_NOT_FOUND, "字段不存在"),
            status=404,
        )
    return JsonResponse(
        success_response(data=TableFieldOut.from_orm(field).dict()),
        status=200,
    )


def open_delete_field_impl(request: HttpRequest, table_id: UUID, field_id: UUID):
    """删除字段 — 含 is_deleted/is_primary 校验，不使用通用装饰器以保留自定义错误码。"""
    try:
        field = TableField.objects.using(TABDATA_DB_ALIAS).filter(
            id=field_id, table_id=table_id,
        ).first()

        if not field or field.is_deleted:
            return JsonResponse(
                get_error_response(ErrorCode.FIELD_NOT_FOUND, "字段不存在"),
                status=404,
            )

        if field.is_primary:
            return JsonResponse(
                get_error_response(ErrorCode.PRIMARY_FIELD_DELETE_DENIED, "主字段不允许删除"),
                status=400,
            )

        service = TableService(user=request.auth)
        try:
            service.delete_field(field_id)
        except TableField.DoesNotExist:
            return JsonResponse(
                get_error_response(ErrorCode.FIELD_NOT_FOUND, "字段不存在"),
                status=404,
            )
        except PermissionError:
            return JsonResponse(
                get_error_response(ErrorCode.PERMISSION_DENIED, "无权限删除此字段"),
                status=403,
            )
        return JsonResponse(success_response(message="字段已删除"), status=200)
    except ValueError as e:
        return JsonResponse(
            get_error_response(ErrorCode.VALIDATION_ERROR, str(e)),
            status=400,
        )
    except Exception:
        logger.exception('Open API delete_field error')
        return JsonResponse(
            get_error_response(ErrorCode.INTERNAL_ERROR, "删除字段失败，请稍后重试"),
            status=500,
        )
