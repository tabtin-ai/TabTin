"""
Field API 接口

Field CRUD、类型转换、关联记录/字段查询、选项补全。
"""
import logging
from uuid import UUID

from django.http import HttpRequest
from ninja import Router

from apps.users.auth.permissions import JWTAuth

from apps.tabdata.services import TableService
from apps.tabdata.services.table_service import _DEFAULT_VALUE_UNSET
from apps.tabdata.tasks import convert_field_type_task
from pydantic import ValidationError as PydanticValidationError
from apps.tabdata.schemas import (
    TableFieldCreate, TableFieldUpdate, TableFieldOut,
    TableFieldReorderRequest, BulkFieldCreateRequest,
    FieldConversionCheck, FieldConversionPreview, FieldConversionRequest,
    ErrorResponse,
    LinkableRecordsQuery,
    FIELD_OPTIONS_SCHEMAS,
)
from apps.tabdata.error_codes import ErrorCode
from apps.tabdata.api_helpers import (
    success_response, error_response, not_found_response,
    permission_denied_response, validation_error_response,
    conflict_response, api_error_handler,
)
from apps.tabdata.exceptions import PrimaryFieldDeleteError, SchemaVersionMismatchError
from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.field_creation_contract import (
    validate_ui_creatable_field_type,
    validate_ui_creatable_field_types,
)
from apps.tabdata.models import Table, TableField, TableView
from ninja import Query
from apps.i18n import _

logger = logging.getLogger(__name__)


def _warn_invalid_field_options(field_type: str, options: dict) -> None:
    """校验字段 options 格式，仅记录警告不拒绝请求（灰度期 warn-only）。"""
    if not options:
        return
    schema_cls = FIELD_OPTIONS_SCHEMAS.get(field_type)
    if not schema_cls:
        return
    try:
        schema_cls.model_validate(options)
    except PydanticValidationError as e:
        logger.warning(
            "Field options schema validation warning: type=%s errors=%s options=%s",
            field_type, e.errors(), options,
        )
    except Exception as e:
        logger.debug("Field options schema validation error: type=%s error=%s", field_type, e)


router = Router(tags=["TabData"])
jwt_auth = JWTAuth()


# ==================== Field CRUD ====================

@router.get(
    "/tables/{table_id}/fields",
    response={200: dict, 401: ErrorResponse, 403: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="获取表格的字段列表"
)
@api_error_handler
def list_fields(request: HttpRequest, table_id: UUID):
    """
    获取表格的所有字段

    Args:
        table_id: 表格ID

    Returns:
        字段列表
    """
    service = TableService(user=request.auth)
    fields = service.list_fields(table_id)

    # 使用 Schema 序列化字段列表
    serialized_fields = [TableFieldOut.from_orm(field).dict() for field in fields]

    # 一并返回 schema_version，避免客户端只 loadFields 后乐观锁版本过期
    # （右键「设为主字段」等写路径依赖 expected_schema_version）
    schema_version = (
        Table.objects.using(TABDATA_DB_ALIAS)
        .filter(id=table_id)
        .values_list("schema_version", flat=True)
        .first()
    )

    return success_response({
        "fields": serialized_fields,
        "total": len(serialized_fields),
        "schema_version": schema_version,
    })


@router.get(
    "/fields/{field_id}",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="获取字段详情"
)
@api_error_handler
def get_field(request: HttpRequest, field_id: UUID):
    """
    获取字段详情

    Args:
        field_id: 字段ID

    Returns:
        字段详情
    """
    service = TableService(user=request.auth)
    field = service.get_field(field_id)

    if not field:
        return not_found_response("字段")

    return success_response(TableFieldOut.from_orm(field).dict())


@router.post(
    "/fields",
    response={201: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="创建字段"
)
@api_error_handler
def create_field(request: HttpRequest, data: TableFieldCreate):
    """
    创建新字段（同名同类型幂等，）

    支持指定插入位置：
    - 不指定 insert_position：添加到末尾（默认）
    - insert_position='before' + reference_field_id：在指定字段之前插入
    - insert_position='after' + reference_field_id：在指定字段之后插入

    若同名同类型字段已存在（例如客户端超时后重试），直接返回已有字段。

    Args:
        data: 字段数据

    Returns:
        创建的字段（或已存在的同名同类型字段）
    """
    field_type_error = validate_ui_creatable_field_type(data.field_type)
    if field_type_error:
        return validation_error_response(field_type_error)

    _warn_invalid_field_options(data.field_type, data.options)

    service = TableService(user=request.auth)
    field = service.create_field(
        table_id=data.table_id,
        name=data.name,
        field_type=data.field_type,
        default_value=data.default_value,
        description=data.description,
        options=data.options,
        validation_rules=data.validation_rules,
        insert_position=data.insert_position,
        reference_field_id=data.reference_field_id
    )

    if not field:
        return permission_denied_response()

    return 201, success_response(
        data=TableFieldOut.from_orm(field).dict(),
        message=_("tabdata.field_created")
    )


@router.post(
    "/tables/{table_id}/fields/bulk",
    response={201: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="批量创建字段"
)
@api_error_handler
def bulk_create_fields(request: HttpRequest, table_id: UUID, data: BulkFieldCreateRequest):
    """
    批量创建字段

    一次性创建多个字段，减少请求次数，提升效率。
    最多支持一次创建 50 个字段。

    Args:
        table_id: 表格ID（从URL路径获取）
        data: 批量创建请求数据

    Returns:
        批量操作结果，包含成功创建的字段列表和错误信息
    """
    field_type_error = validate_ui_creatable_field_types(
        field_item.field_type for field_item in data.fields
    )
    if field_type_error:
        return validation_error_response(field_type_error)

    service = TableService(user=request.auth)

    for field_item in data.fields:
        _warn_invalid_field_options(field_item.field_type, field_item.options)

    fields_data = [
        {
            'name': field.name,
            'field_type': field.field_type,
            'default_value': field.default_value,
            'description': field.description,
            'options': field.options
        }
        for field in data.fields
    ]

    created_fields, errors, skipped = service.bulk_create_fields(
        table_id=table_id,
        fields_data=fields_data
    )

    # 幂等语义：全部字段已存在（同名同类型）时 skipped 非空、errors 为空，
    # 应返回 201 而非 400——"确保字段存在"的目标已达成
    if not created_fields and not skipped and errors:
        return validation_error_response("; ".join(errors))

    fields_out = [TableFieldOut.from_orm(field).dict() for field in created_fields]

    message = _("tabdata.batch_field_created", count=len(created_fields))
    if skipped:
        message += f"，已存在跳过 {len(skipped)} 个"
    if errors:
        message += f"，失败 {len(errors)} 个"

    return 201, success_response(
        data={
            "success_count": len(created_fields),
            "fields": fields_out,
            "skipped": skipped,
            "errors": errors
        },
        message=message
    )


@router.put(
    "/fields/{field_id}",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="更新字段"
)
@api_error_handler
def update_field(request: HttpRequest, field_id: UUID, data: TableFieldUpdate):
    """
    更新字段信息

    Args:
        field_id: 字段ID
        data: 更新数据

    Returns:
        更新后的字段
    """
    service = TableService(user=request.auth)
    try:
        field = service.update_field(
            field_id=field_id,
            name=data.name,
            description=data.description,
            default_value=(
                data.default_value
                if 'default_value' in data.model_fields_set
                else _DEFAULT_VALUE_UNSET
            ),
            options=data.options,
            is_hidden=data.is_hidden,
            width=data.width,
            validation_rules=data.validation_rules,
            visibility_roles=data.visibility_roles,
            is_primary=data.is_primary,
            expected_schema_version=data.expected_schema_version,
        )
    except SchemaVersionMismatchError as exc:
        return conflict_response(str(exc))
    except PermissionError as exc:
        return permission_denied_response(str(exc))

    if not field:
        return not_found_response("字段")

    if data.options is not None:
        _warn_invalid_field_options(field.field_type, data.options)

    return success_response(
        data=TableFieldOut.from_orm(field).dict(),
        message=_("tabdata.field_updated")
    )


@router.post(
    "/tables/{table_id}/fields/reorder",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 409: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="重新排序字段"
)
@api_error_handler
def reorder_fields(request: HttpRequest, table_id: UUID, data: TableFieldReorderRequest):
    """
    重新排序表格的字段。

    支持乐观锁：客户端可选择传入 expected_schema_version，
    若服务端当前版本不一致则返回 409，提示用户刷新后重试。

    Args:
        table_id: 表格ID
        data: 排序数据（含可选 expected_schema_version）

    Returns:
        排序结果；并发冲突时返回 409
    """
    service = TableService(user=request.auth)
    field_orders = [{"field_id": item.field_id, "sort_order": item.sort_order} for item in data.field_orders]
    try:
        success = service.reorder_fields(
            table_id,
            field_orders,
            expected_schema_version=data.expected_schema_version,
        )
    except SchemaVersionMismatchError as exc:
        return conflict_response(str(exc))

    if not success:
        return permission_denied_response()

    return success_response(message=_("tabdata.field_reordered"))


@router.delete(
    "/fields/{field_id}",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="删除字段"
)
@api_error_handler
def delete_field(request: HttpRequest, field_id: UUID):
    """
    删除字段（软删除）

    Args:
        field_id: 字段ID

    Returns:
        删除结果
    """
    service = TableService(user=request.auth)
    try:
        service.delete_field(field_id)
    except TableField.DoesNotExist:
        return not_found_response("字段")
    except PermissionError:
        return permission_denied_response()
    except PrimaryFieldDeleteError:
        return error_response(
            ErrorCode.PRIMARY_FIELD_DELETE_DENIED,
            message=_("tabdata.field_delete_failed"),
            status_code=403
        )

    return success_response(message=_("tabdata.field_deleted"))


# ==================== Link Field Helpers ====================

@router.get(
    "/tables/{table_id}/fields/{field_id}/linkable-records",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="获取可关联记录列表"
)
@api_error_handler
def get_linkable_records(
    request: HttpRequest,
    table_id: UUID,
    field_id: UUID,
    query: LinkableRecordsQuery = Query(...),
):
    """
    获取目标表可关联的记录列表（支持搜索、分页）。

    仅对 link 字段类型有效，返回目标表的记录列表。

    安全边界：本端点是表级通用 API，使用 JWT + 表级 viewer 权限控制。
    表单填写场景应使用 ``/forms/{share_id}/link-records/{field_id}`` 端点，
    该端点额外校验字段是否在表单中可见且支持匿名访问。
    """
    service = TableService(user=request.auth)
    if not service.check_table_permission(str(table_id), 'viewer'):
        return permission_denied_response()

    try:
        field = TableField.objects.using(TABDATA_DB_ALIAS).get(id=field_id, table_id=table_id, is_deleted=False)
    except TableField.DoesNotExist:
        return not_found_response("字段")

    if field.field_type != 'link':
        return error_response(
            ErrorCode.VALIDATION_ERROR,
            message=_("tabdata.field_not_link"),
            status_code=400,
        )

    selected_record_ids = None
    if query.selected_record_ids:
        parsed_ids = []
        for raw_id in query.selected_record_ids.split(','):
            candidate = raw_id.strip()
            if not candidate:
                continue
            try:
                UUID(candidate)
            except ValueError:
                return validation_error_response(f"selected_record_ids 包含无效 UUID: {candidate}")
            parsed_ids.append(candidate)
        selected_record_ids = parsed_ids or None

    search_field_ids = None
    if query.search_field_ids:
        search_field_ids = [
            part.strip()
            for part in query.search_field_ids.split(',')
            if part.strip()
        ] or None

    from apps.tabdata.services.link_field_service import LinkFieldService
    try:
        records, total = LinkFieldService.get_linkable_records(
            field,
            search=query.search,
            search_field_id=query.search_field_id,
            search_field_ids=search_field_ids,
            page=query.page,
            page_size=query.page_size,
            exclude_record_id=query.exclude_record_id,
            selected_record_ids=selected_record_ids,
            only_selected=query.only_selected,
            user=request.auth,
        )
    except PermissionError:
        return permission_denied_response()

    return success_response({
        "records": records,
        "total": total,
    })


@router.get(
    "/tables/{table_id}/fields/{field_id}/linkable-fields",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="获取关联字段的目标表字段和视图元数据"
)
@api_error_handler
def get_linkable_fields(
    request: HttpRequest,
    table_id: UUID,
    field_id: UUID,
):
    """
    获取 link 字段对应目标表的字段列表和视图列表，
    供前端 LinkCellEditor 渲染多列显示和高级配置使用。
    """
    service = TableService(user=request.auth)
    if not service.check_table_permission(str(table_id), 'viewer'):
        return permission_denied_response()

    try:
        field = TableField.objects.using(TABDATA_DB_ALIAS).get(id=field_id, table_id=table_id, is_deleted=False)
    except TableField.DoesNotExist:
        return not_found_response("字段")

    if field.field_type != 'link':
        return error_response(
            ErrorCode.VALIDATION_ERROR,
            message=_("tabdata.field_not_link"),
            status_code=400,
        )

    from apps.tabdata.services.link_field_service import LinkFieldService
    try:
        result = LinkFieldService.get_linkable_fields(field, user=request.auth)
    except PermissionError:
        return permission_denied_response()

    return success_response(result)


@router.post(
    "/fields/{field_id}/populate-choices",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="自动补全单选/多选选项（从现有数据收集）"
)
@api_error_handler
def populate_field_choices(request: HttpRequest, field_id: UUID):
    """
    扫描记录数据，自动收集 select/multi_select 的值作为选项写回字段配置
    """
    service = TableService(user=request.auth)
    result, error = service.populate_field_choices(field_id)

    if error == ErrorCode.NOT_FOUND:
        return not_found_response("字段")
    if error == ErrorCode.PERMISSION_DENIED:
        return permission_denied_response()
    if error == ErrorCode.UNSUPPORTED:
        return validation_error_response(_("tabdata.field_type_unsupported_for_choices"))
    if error:
        return validation_error_response(error)

    return success_response(
        data=result,
        message=_("tabdata.options_auto_filled", added=result.get('added_count', 0), total=result.get('total_count', 0))
    )


# ==================== Field Type Conversion ====================

@router.post(
    "/fields/{field_id}/check-conversion",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="检查字段类型转换可行性"
)
@api_error_handler
def check_field_conversion(request: HttpRequest, field_id: UUID, data: FieldConversionCheck):
    """
    检查字段是否可以转换为指定类型

    Args:
        field_id: 字段ID
        data: 转换检查请求

    Returns:
        转换可行性检查结果
    """
    field_type_error = validate_ui_creatable_field_type(data.target_type)
    if field_type_error:
        return validation_error_response(field_type_error)

    service = TableService(user=request.auth)
    result = service.can_convert_field(field_id, data.target_type)

    if result is None:
        return not_found_response("字段")

    return success_response(data=result)


@router.post(
    "/fields/{field_id}/preview-conversion",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="预览字段类型转换效果"
)
@api_error_handler
def preview_field_conversion(request: HttpRequest, field_id: UUID, data: FieldConversionPreview):
    """
    预览字段类型转换的效果

    Args:
        field_id: 字段ID
        data: 转换预览请求

    Returns:
        转换预览结果
    """
    field_type_error = validate_ui_creatable_field_type(data.target_type)
    if field_type_error:
        return validation_error_response(field_type_error)

    service = TableService(user=request.auth)
    result = service.preview_field_conversion(
        field_id=field_id,
        target_type=data.target_type,
        target_options=data.target_options,
        sample_size=data.sample_size
    )

    if result is None:
        return not_found_response("字段")

    return success_response(data=result)


@router.put(
    "/fields/{field_id}/convert",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="执行字段类型转换"
)
@api_error_handler
def convert_field_type(request: HttpRequest, field_id: UUID, data: FieldConversionRequest):
    """
    执行字段类型转换

    Args:
        field_id: 字段ID
        data: 转换请求

    Returns:
        转换结果
    """
    field_type_error = validate_ui_creatable_field_type(data.target_type)
    if field_type_error:
        return validation_error_response(field_type_error)

    service = TableService(user=request.auth)

    if data.async_mode:
        user_id = getattr(request.auth, 'id', None) if getattr(request, 'auth', None) else None
        # ATK-2: 传递 API Key organization 约束到 Celery 任务
        from apps.users.auth.api_key_context import get_api_key_organization_constraint
        _api_key_wt = get_api_key_organization_constraint()
        # C3 / Wave 1.3：freeze 当前 schema_version_token，让 worker 在执行前校验，
        # 删表后该 token 漂移，未消费的旧任务自动跳过（无 "table not found" 报错）
        from apps.tabdata.services.schema_version_token import (
            FROZEN_TOKEN_KEY, get_table_schema_version_token,
        )
        field = service.get_field(field_id)
        frozen_token = get_table_schema_version_token(field.table_id) if field else None
        task_kwargs = {
            'api_key_organization_id': _api_key_wt,
        }
        if frozen_token:
            task_kwargs[FROZEN_TOKEN_KEY] = frozen_token
        task = convert_field_type_task.apply_async(
            args=[
                str(field_id),
                data.target_type,
                data.target_options,
                data.force,
                str(user_id) if user_id else None,
            ],
            kwargs=task_kwargs,
        )
        return success_response(
            data={'task_id': task.id},
            message=_("tabdata.field_conversion_submitted")
        )

    result = service.convert_field_type(
        field_id=field_id,
        target_type=data.target_type,
        target_options=data.target_options,
        force=data.force
    )

    if result is None:
        return not_found_response("字段")

    return success_response(
        data=result,
        message=_("tabdata.field_conversion_success") if result.get('success') else _("tabdata.field_conversion_failed")
    )


# ==================== Delete References Analysis ====================

def _analyze_field_impact(field: TableField) -> dict:
    """
    分析指定字段的依赖影响范围（下游字段、视图、对称 Link）。

    供 delete-references 和 conversion-references 端点共用。
    """
    field_id_str = str(field.id)

    # 1. 下游依赖字段（Lookup / Formula / Rollup 等）
    from apps.tabdata.services.cascade_service import CascadeService
    dep_by_table = CascadeService.get_dependent_fields([field_id_str])

    dependent_fields = []
    if dep_by_table:
        all_dep_ids = []
        for fids in dep_by_table.values():
            all_dep_ids.extend(fids)
        if all_dep_ids:
            dep_field_objs = TableField.objects.using(TABDATA_DB_ALIAS).filter(
                id__in=all_dep_ids,
                is_deleted=False,
            ).select_related('table')
            for f in dep_field_objs:
                dependent_fields.append({
                    "id": str(f.id),
                    "name": f.name,
                    "type": f.field_type,
                    "table_id": str(f.table_id),
                    "table_name": f.table.name if f.table else "",
                })

    # 2. 受影响的视图（filter / sort / group 引用了该字段）
    views = TableView.objects.using(TABDATA_DB_ALIAS).filter(
        table_id=field.table_id,
    )
    affected_views = []
    for view in views:
        usages = _collect_view_field_usages(view, field_id_str, field.name)
        if usages:
            affected_views.append({
                "id": str(view.id),
                "name": view.name,
                "usage": usages,
            })

    # 3. 对称 Link 字段
    symmetric_link_field = None
    if field.field_type == 'link':
        config = field.config or {}
        sym_field_id = config.get('symmetricFieldId')
        is_one_way = config.get('isOneWay', False)
        if not is_one_way and sym_field_id:
            try:
                sym_field = TableField.objects.using(TABDATA_DB_ALIAS).select_related(
                    'table',
                ).get(id=sym_field_id, is_deleted=False)
                symmetric_link_field = {
                    "id": str(sym_field.id),
                    "name": sym_field.name,
                    "table_name": sym_field.table.name if sym_field.table else "",
                }
            except TableField.DoesNotExist:
                pass

    return {
        "dependent_fields": dependent_fields,
        "affected_views": affected_views,
        "symmetric_link_field": symmetric_link_field,
    }


@router.get(
    "/fields/{field_id}/delete-references",
    response={200: dict, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="获取删除字段前的影响分析"
)
@api_error_handler
def get_field_delete_references(request: HttpRequest, field_id: UUID):
    """
    分析删除指定字段后将受到影响的依赖字段、视图和对称 Link 字段。
    供前端在用户确认删除前展示影响范围。
    """
    service = TableService(user=request.auth)
    field = service.get_field(field_id)
    if not field:
        return not_found_response("字段")

    return success_response(_analyze_field_impact(field))


@router.get(
    "/fields/{field_id}/explain",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="字段操作（删除 / 转换）影响 + 可撤销性 explain",
    description=(
        "C1 / Wave 1.3 + PRD §D3：返回字段在指定 action 下的:"
        "可撤销性（``can_undo`` / ``reason_code`` / ``reason``）、"
        "影响摘要（``dependent_fields`` / ``affected_views`` / ``symmetric_link_field``）。"
        "供 W1.4 删除前对话框 / 错误 toast 消费。"
    ),
)
@api_error_handler
def explain_field_action(
    request: HttpRequest,
    field_id: UUID,
    action: str = "delete",
):
    """字段操作前的统一 explain 端点（PRD §D3 + C1 任务要求）。

    - ``action=delete``：返回删除是否会破坏依赖 + 是否可撤销 + 引导文案
    - ``action=convert_to=<type>``（保留接口，本 Wave 透传 ``warnings``）

    Response 结构::

        {
            "field_id": "...",
            "field_name": "...",
            "field_type": "select",
            "action": "delete",
            "undo_capability": {
                "can_undo": true,
                "reason_code": "simple_supported",
                "reason": "支持撤销，可直接 Ctrl+Z 恢复字段及其原生列结构。",
                "deferred_to": null
            },
            "impact": {
                "dependent_fields": [...],
                "affected_views": [...],
                "symmetric_link_field": null
            },
            "warning": "高风险" | "可安全删除"
        }
    """
    from apps.tabdata.services.undo_redo_field_restore import (
        explain_field_restore_capability,
    )

    service = TableService(user=request.auth)
    field = service.get_field(field_id)
    if not field:
        return not_found_response("字段")

    impact = _analyze_field_impact(field)
    undo_capability = explain_field_restore_capability(field.field_type)

    # 风险等级摘要（W1.4 删除前对话框直接渲染）
    has_dependents = bool(impact["dependent_fields"])
    has_views = bool(impact["affected_views"])
    has_symmetric = bool(impact["symmetric_link_field"])
    if has_dependents or has_symmetric:
        warning_level = "high"
    elif has_views:
        warning_level = "medium"
    else:
        warning_level = "low"

    return success_response({
        "field_id": str(field.id),
        "field_name": field.name,
        "field_type": field.field_type,
        "action": action,
        "undo_capability": undo_capability,
        "impact": impact,
        "warning_level": warning_level,
    })


@router.get(
    "/fields/{field_id}/conversion-references",
    response={200: dict, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="获取字段类型转换前的影响分析"
)
@api_error_handler
def get_field_conversion_references(request: HttpRequest, field_id: UUID):
    """
    分析将指定字段转换类型后的影响范围。
    复用 _analyze_field_impact 的核心逻辑，额外返回转换警告提示。
    """
    service = TableService(user=request.auth)
    field = service.get_field(field_id)
    if not field:
        return not_found_response("字段")

    impact = _analyze_field_impact(field)

    warnings = []
    dep_count = len(impact["dependent_fields"])
    if dep_count > 0:
        dep_types = {d["type"] for d in impact["dependent_fields"]}
        warnings.append(
            _("tabdata.conversion_dependent_warning",
              count=dep_count,
              types=", ".join(sorted(dep_types)))
        )
    if impact["affected_views"]:
        warnings.append(
            _("tabdata.conversion_view_warning",
              count=len(impact["affected_views"]))
        )
    if impact["symmetric_link_field"]:
        warnings.append(_("tabdata.conversion_symmetric_link_warning"))

    impact["conversion_warning"] = " ".join(warnings) if warnings else None
    return success_response(impact)


def _collect_view_field_usages(view: TableView, field_id_str: str, field_name: str) -> list:
    """检查视图的 filter / sort / group 配置是否引用了指定字段，返回 usage 列表。"""
    usages = []
    match_set = {field_id_str, field_name}

    # filter（嵌套格式）
    nested_filter = getattr(view, 'filter', None)
    if nested_filter and isinstance(nested_filter, dict):
        if _filter_set_references_field(nested_filter, match_set):
            usages.append("filter")

    # filters（旧版扁平格式），仅当嵌套格式未命中时检查
    if "filter" not in usages:
        for rule in (view.filters or []):
            ref = rule.get('field_id') or rule.get('field') or ''
            if str(ref) in match_set:
                usages.append("filter")
                break

    # sort
    for sort_rule in (view.sorts or []):
        ref = sort_rule.get('field_id') or sort_rule.get('field') or ''
        if str(ref) in match_set:
            usages.append("sort")
            break

    # group
    for group_rule in (view.groups or []):
        ref = group_rule.get('field_id') or group_rule.get('field') or ''
        if str(ref) in match_set:
            usages.append("group")
            break

    return usages


def _filter_set_references_field(filter_set: dict, match_set: set) -> bool:
    """递归检查嵌套 FilterSet 是否引用了目标字段。"""
    items = filter_set.get('filterSet')
    if not isinstance(items, list):
        return False
    for item in items:
        if not isinstance(item, dict):
            continue
        if 'conjunction' in item and 'filterSet' in item:
            if _filter_set_references_field(item, match_set):
                return True
        else:
            ref = item.get('field_id') or item.get('field') or ''
            if str(ref) in match_set:
                return True
    return False
