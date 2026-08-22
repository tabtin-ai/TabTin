"""
子记录 (Sub-Record) API 接口

提供子记录的创建、父字段管理等功能。
"""

import logging
from uuid import UUID

from django.http import HttpRequest
from ninja import Router

from apps.tabdata.api_helpers import (
    api_error_handler,
    error_response,
    not_found_response,
    permission_denied_response,
    success_response,
    validation_error_response,
)
from apps.tabdata.error_codes import ErrorCode
from apps.tabdata.schemas import (
    ErrorResponse,
    SubRecordCreateRequest,
    SubRecordMoveRequest,
    SubRecordReorderTreeRequest,
)
from apps.tabdata.services import TableService
from apps.tabdata.services.sub_record_service import SubRecordService
from apps.tabdata.utils.record_serializers import serialize_record
from apps.users.auth.permissions import JWTAuth
from apps.i18n import _

logger = logging.getLogger(__name__)

router = Router(tags=["Sub-Record"])
jwt_auth = JWTAuth()


# ==================== Sub-Record API ====================


def _check_table_permission(user, table_id: UUID, role: str) -> bool:
    service = TableService(user=user)
    return service.check_table_permission(str(table_id), role)


@router.post(
    "/create",
    response={201: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="创建子记录",
)
@api_error_handler
def create_sub_record(request: HttpRequest, data: SubRecordCreateRequest):
    """
    创建子记录

    自动确保父记录字段存在。如果表格中没有父记录字段会自动创建。
    """
    if not _check_table_permission(request.auth, data.table_id, 'editor'):
        return permission_denied_response("无权限修改该表格")

    try:
        order_ctx = (
            data.order_context.model_dump(exclude_none=True)
            if data.order_context
            else None
        )
        new_record, parent_field = SubRecordService.create_sub_record(
            table_id=data.table_id,
            parent_record_id=data.parent_record_id,
            parent_field_id=data.parent_field_id,
            data=dict(data.data),
            user=request.auth,
            order_context=order_ctx,
        )
        return 201, success_response(
            data={
                'record': serialize_record(new_record),
                'parent_field_id': str(parent_field.id),
            },
            message=_("tabdata.sub_record_created"),
        )
    except PermissionError as e:
        return permission_denied_response(str(e))
    except ValueError as e:
        logger.warning("创建子记录业务校验失败: %s", e)
        return validation_error_response(str(e))
    except Exception as e:
        logger.exception("创建子记录失败")
        return error_response(
            ErrorCode.INTERNAL_ERROR,
            message=_("tabdata.sub_record_create_failed"),
            status_code=500,
        )


@router.get(
    "/tables/{table_id}/parent-field",
    response={
        200: dict,
        400: ErrorResponse,
        401: ErrorResponse,
        403: ErrorResponse,
        404: ErrorResponse,
        500: ErrorResponse,
    },
    auth=jwt_auth,
    summary="获取表格的父记录字段",
)
@api_error_handler
def get_parent_field(request: HttpRequest, table_id: UUID):
    """
    获取表格中用于子记录层级的父记录字段。
    如果不存在则返回 field: null。
    """
    if not _check_table_permission(request.auth, table_id, 'viewer'):
        return permission_denied_response("无权限访问该表格")

    parent_field = SubRecordService.get_parent_field(table_id)
    if parent_field is None:
        return 200, success_response(data={'field': None})

    return 200, success_response(
        data={
            'field': {
                'id': str(parent_field.id),
                'name': parent_field.name,
                'field_type': parent_field.field_type,
                'config': parent_field.config,
            }
        }
    )


def _serialize_parent_field(parent_field) -> dict:
    return {
        'id': str(parent_field.id),
        'name': parent_field.name,
        'field_type': parent_field.field_type,
        'config': parent_field.config,
    }


@router.post(
    "/tables/{table_id}/ensure-parent-field",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="确保父记录字段存在",
)
@api_error_handler
def ensure_parent_field(request: HttpRequest, table_id: UUID):
    """
    查找或创建子记录父字段（幂等）。
    如果已存在则直接返回，否则自动创建名为"父记录"的字段。
    """
    if not _check_table_permission(request.auth, table_id, 'editor'):
        return permission_denied_response("无权限修改该表格")

    try:
        parent_field = SubRecordService.ensure_parent_field(
            table_id=table_id, user=request.auth
        )
        return 200, success_response(data={'field': _serialize_parent_field(parent_field)})
    except PermissionError as e:
        return permission_denied_response(str(e))
    except ValueError as e:
        logger.warning("确保父记录字段业务校验失败: %s", e)
        return validation_error_response(str(e))
    except Exception as e:
        logger.exception("确保父记录字段失败")
        return error_response(
            ErrorCode.INTERNAL_ERROR,
            message=_("tabdata.ensure_parent_field_failed"),
            status_code=500,
        )


@router.post(
    "/tables/{table_id}/create-parent-field",
    response={201: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="创建新的父记录字段",
)
@api_error_handler
def create_parent_field(request: HttpRequest, table_id: UUID):
    """
    始终创建新的子记录父字段（非幂等）。

    用于工具栏「创建父记录字段」：每次调用生成独立关系列。
    """
    if not _check_table_permission(request.auth, table_id, 'editor'):
        return permission_denied_response("无权限修改该表格")

    try:
        parent_field = SubRecordService.create_parent_field(
            table_id=table_id, user=request.auth
        )
        return 201, success_response(
            data={'field': _serialize_parent_field(parent_field)},
            message=_("tabdata.parent_field_created"),
        )
    except PermissionError as e:
        return permission_denied_response(str(e))
    except ValueError as e:
        logger.warning("创建父记录字段业务校验失败: %s", e)
        return validation_error_response(str(e))
    except Exception as e:
        logger.exception("创建父记录字段失败")
        return error_response(
            ErrorCode.INTERNAL_ERROR,
            message=_("tabdata.create_parent_field_failed"),
            status_code=500,
        )


@router.get(
    "/tables/{table_id}/self-link-fields",
    response={200: dict, 401: ErrorResponse, 403: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="获取可用作父记录的自引用字段列表",
)
@api_error_handler
def list_self_link_fields(request: HttpRequest, table_id: UUID):
    """
    获取表格中所有可用作父记录字段的自引用单向 link 字段。
    用于视图配置面板选择父记录字段。
    """
    if not _check_table_permission(request.auth, table_id, 'viewer'):
        return permission_denied_response("无权限访问该表格")

    fields = SubRecordService.get_self_link_fields(table_id)
    return 200, success_response(
        data={
            'fields': [
                {
                    'id': str(f.id),
                    'name': f.name,
                    'config': f.config,
                    'is_sub_record_parent': bool(
                        (f.config or {}).get('isSubRecordParentField')
                    ),
                }
                for f in fields
            ]
        }
    )


@router.post(
    "/move",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="移动记录层级（改变父记录）",
)
@api_error_handler
def move_sub_record(request: HttpRequest, data: SubRecordMoveRequest):
    """
    移动记录到新的父记录下，或变为顶级记录。
    用于拖拽改变层级关系。
    """
    if not _check_table_permission(request.auth, data.table_id, 'editor'):
        return permission_denied_response("无权限修改该表格")

    try:
        SubRecordService.move_record(
            table_id=data.table_id,
            record_id=data.record_id,
            new_parent_id=data.new_parent_id,
            parent_field_id=data.parent_field_id,
            user=request.auth,
        )
        return 200, success_response(
            data={'success': True},
            message=_("tabdata.record_hierarchy_updated"),
        )
    except PermissionError as e:
        return permission_denied_response(str(e))
    except ValueError as e:
        logger.warning("移动记录层级业务校验失败: %s", e)
        return validation_error_response(str(e))
    except Exception as e:
        logger.exception("移动记录层级失败")
        return error_response(
            ErrorCode.INTERNAL_ERROR,
            message=_("tabdata.move_record_hierarchy_failed"),
            status_code=500,
        )


@router.post(
    "/reorder-tree",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="树拖拽原子提交（排序 + 层级单事务）",
)
@api_error_handler
def reorder_tree(request: HttpRequest, data: SubRecordReorderTreeRequest):
    """
    树拖拽原子提交 — 单事务完成排序 + 层级变更。

    拖拽父记录时子树整体跟随移动，任一步校验失败整体回滚。
    """
    if not _check_table_permission(request.auth, data.table_id, 'editor'):
        return permission_denied_response("无权限修改该表格")

    try:
        result = SubRecordService.reorder_tree(
            table_id=data.table_id,
            moved_root_record_id=data.moved_root_record_id,
            new_parent_id=data.new_parent_id,
            position=data.position,
            anchor_record_id=data.anchor_record_id,
            parent_field_id=data.parent_field_id,
            move_with_descendants=data.move_with_descendants,
            user=request.auth,
        )
        return 200, success_response(
            data=result,
            message=_("tabdata.tree_drag_done"),
        )
    except PermissionError as e:
        return permission_denied_response(str(e))
    except ValueError as e:
        logger.warning("树拖拽业务校验失败: %s", e)
        return validation_error_response(str(e))
    except Exception as e:
        logger.exception("树拖拽原子提交失败")
        return error_response(
            ErrorCode.INTERNAL_ERROR,
            message=_("tabdata.tree_drag_commit_failed"),
            status_code=500,
        )
