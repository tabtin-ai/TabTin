"""
Table API 接口

Table CRUD、统计。
"""
import logging
from typing import Optional
from uuid import UUID

from django.http import HttpRequest
from ninja import Router

from apps.users.auth.permissions import JWTAuth

from apps.tabdata.services import TableService
from apps.tabdata.schemas import (
    TableCreate, TableCreateHierarchical, TableUpdate, TableOut,
    ErrorResponse,
)
from apps.tabdata.error_codes import ErrorCode
from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.api_helpers import (
    success_response, error_response, not_found_response,
    permission_denied_response, validation_error_response,
    api_error_handler,
)
from apps.tabdata.services import RecordService
from apps.tabtinspace.services.organization_control_guard import (
    OrganizationControlBlockedError,
    organization_control_blocked_response,
)
from apps.users.membership.exceptions import MembershipException, QuotaExceededError as MembershipQuotaExceededError
from apps.i18n import _

logger = logging.getLogger(__name__)

router = Router(tags=["TabData"])
jwt_auth = JWTAuth()


# ==================== 权限角色计算 ====================


def _compute_user_table_role(user, table) -> Optional[str]:
    """
    计算用户对表格的有效角色。

    与 BaseService.get_table_role / check_table_permission 一致：
    1. 表格所有者 → 'owner'
    2. TablePermission 资源级权限 → 直接返回 permission 值
    3. 无权限 → None（**不**回退 Organization 角色）
    """
    if user is None:
        return None

    from apps.tabdata.services.base import BaseService as TabDataBaseService
    return TabDataBaseService(user=user).get_table_role(str(table.id))


def _compute_user_table_role_safe(user, table) -> Optional[str]:
    """_compute_user_table_role 的安全封装，异常时返回 None"""
    try:
        return _compute_user_table_role(user, table)
    except Exception as e:
        logger.warning("Failed to compute user table role: %s", e)
        return None


def _batch_compute_user_table_roles(user, tables) -> dict:
    """
    批量计算用户对多个表格的角色（优化 list 接口 N+1 问题）。

    返回 {table_id_str: role_str}。口径与 get_table_role 一致：
    owner ∪ 显式 TablePermission，无 Organization fallback。
    """
    if user is None or not tables:
        return {}

    user_id = str(user.id)
    table_list = list(tables)
    result: dict = {}

    table_ids = [t.id for t in table_list]
    perm_map: dict = {}
    try:
        from apps.tabdata.models import TablePermission
        perms = TablePermission.objects.using(TABDATA_DB_ALIAS).filter(
            table_id__in=table_ids,
            subject_type='user',
            subject_id=user_id,
            is_active=True,
        ).values_list('table_id', 'permission')
        perm_map = {str(tid): perm for tid, perm in perms}
    except Exception:
        pass

    for table in table_list:
        tid = str(table.id)

        if table.owner_id and str(table.owner_id) == user_id:
            result[tid] = 'owner'
            continue

        if tid in perm_map:
            result[tid] = perm_map[tid]
            continue

        result[tid] = None

    return result


def _batch_compute_roles_safe(user, tables) -> dict:
    """_batch_compute_user_table_roles 的安全封装"""
    try:
        return _batch_compute_user_table_roles(user, tables)
    except Exception as e:
        logger.warning("Failed to batch compute user table roles: %s", e)
        return {}


# ==================== Health ====================

@router.get("/health", auth=None, summary="健康检查")
@api_error_handler
def health_check(request: HttpRequest):
    """
    TabData 模块健康检查接口

    Returns:
        dict: 健康状态
    """
    return {
        "status": "healthy",
        "module": "tabdata",
        "message": "TabData module is running"
    }


# ==================== Table CRUD ====================

@router.get(
    "/organizations/{organization_id}/tables",
    response={200: dict, 401: ErrorResponse, 403: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="获取组织的表格列表"
)
@api_error_handler
def list_tables(
    request: HttpRequest,
    organization_id: UUID
):
    """
    获取组织中的表格列表（支持分页）
    """
    search = request.GET.get('search', None)
    if search in ['null', 'undefined', '']:
        search = None

    is_archived_str = request.GET.get('is_archived', 'false')
    is_archived = is_archived_str.lower() == 'true' if is_archived_str not in ['null', 'undefined', ''] else False

    is_trashed_str = request.GET.get('is_trashed', 'false')
    is_trashed = is_trashed_str.lower() == 'true' if is_trashed_str not in ['null', 'undefined', ''] else False

    include_system_str = request.GET.get('include_system', None)
    include_system = None
    if include_system_str not in [None, '', 'null', 'undefined']:
        include_system = include_system_str.lower() == 'true'

    try:
        page = max(1, int(request.GET.get('page', '1') or '1'))
    except (ValueError, TypeError):
        page = 1
    try:
        page_size = min(max(1, int(request.GET.get('page_size', '200') or '200')), 500)
    except (ValueError, TypeError):
        page_size = 200

    current_space_id_str = request.GET.get('current_space_id', None)
    if current_space_id_str in ['null', 'undefined', '']:
        current_space_id_str = None

    service = TableService(user=request.auth)
    qs = service.list_tables(
        organization_id=organization_id,
        search=search,
        is_archived=is_archived,
        is_trashed=is_trashed,
        include_system=include_system,
    )

    if current_space_id_str:
        from django.db.models import Case, When, Value, IntegerField
        try:
            boost_space_uuid = UUID(current_space_id_str)
            current_space_boost = Case(
                When(space_id=boost_space_uuid, then=Value(0)),
                default=Value(1),
                output_field=IntegerField(),
            )
            qs = qs.annotate(_space_boost=current_space_boost).order_by(
                '_space_boost', '-updated_at',
            )
        except (ValueError, TypeError):
            pass

    total = qs.count()
    offset = (page - 1) * page_size
    tables = list(qs[offset:offset + page_size])

    role_map = _batch_compute_roles_safe(request.auth, tables)

    from apps.tabtinspace.services.space_utils import resolve_space_names
    _sn_map = resolve_space_names(t.space_id for t in tables if t.space_id)

    serialized_tables = []
    for table in tables:
        _sid_str = str(table.space_id) if table.space_id else None
        serialized_tables.append({
            "id": str(table.id),
            "name": table.name,
            "description": table.description,
            "icon": table.icon,
            "owner_id": str(table.owner_id) if table.owner_id else None,
            "space_id": _sid_str,
            "space_name": _sn_map.get(_sid_str, "") if _sid_str else "",
            "default_view_id": str(table.default_view_id) if table.default_view_id else None,
            "row_count": None if getattr(table, 'rls_enabled', False) else table.row_count,
            "field_count": table.field_count,
            "visibility": table.visibility,
            "is_public": table.is_public,
            "is_template": table.is_template,
            "is_archived": table.is_archived,
            "is_trashed": table.is_trashed,
            "trashed_at": table.trashed_at.isoformat() if table.trashed_at else None,
            "current_user_role": role_map.get(str(table.id)),
            "created_at": table.created_at.isoformat() if table.created_at else None,
            "updated_at": table.updated_at.isoformat() if table.updated_at else None,
        })

    return success_response({
        "tables": serialized_tables,
        "total": total,
        "page": page,
        "page_size": page_size,
    })


@router.get(
    "/organizations/{organization_id}/spaces/{space_id}/tables",
    response={200: dict, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="获取 Space 的表格列表（层级化接口）"
)
@api_error_handler
def list_space_tables(
    request: HttpRequest,
    organization_id: UUID,
    space_id: UUID
):
    """
    获取 Space 中的表格列表（严格层级化接口）

    Args:
        organization_id: 组织ID
        space_id: Space ID
        search: 搜索关键词
        is_archived: 是否只查询已归档的表格
        include_system: 是否包含系统表（null=默认, true=全部, false=仅普通表）

    Returns:
        表格列表
    """
    try:
        from apps.tabtinspace.services.base import ensure_space_in_organization
        ensure_space_in_organization(organization_id, space_id)
    except ValueError:
        return not_found_response("智能体空间")

    # 手动获取查询参数，避免类型验证问题
    search = request.GET.get('search', None)
    if search in ['null', 'undefined', '']:
        search = None

    is_archived_str = request.GET.get('is_archived', 'false')
    is_archived = is_archived_str.lower() == 'true' if is_archived_str not in ['null', 'undefined', ''] else False

    is_trashed_str = request.GET.get('is_trashed', 'false')
    is_trashed = is_trashed_str.lower() == 'true' if is_trashed_str not in ['null', 'undefined', ''] else False

    # include_system: null/不传=默认(normal+system), true=全部, false=仅normal
    include_system_str = request.GET.get('include_system', None)
    include_system = None
    if include_system_str not in [None, '', 'null', 'undefined']:
        include_system = include_system_str.lower() == 'true'

    try:
        page = max(1, int(request.GET.get('page', '1') or '1'))
    except (ValueError, TypeError):
        page = 1
    try:
        page_size = min(max(1, int(request.GET.get('page_size', '200') or '200')), 500)
    except (ValueError, TypeError):
        page_size = 200

    service = TableService(user=request.auth)
    qs = service.list_tables(
        space_id=space_id,
        search=search,
        is_archived=is_archived,
        is_trashed=is_trashed,
        include_system=include_system,
    )

    total = qs.count()
    offset = (page - 1) * page_size
    tables = list(qs[offset:offset + page_size])

    role_map = _batch_compute_roles_safe(request.auth, tables)

    serialized_tables = []
    for table in tables:
        serialized_tables.append({
            "id": str(table.id),
            "name": table.name,
            "description": table.description,
            "icon": table.icon,
            "owner_id": str(table.owner_id) if table.owner_id else None,
            "space_id": str(table.space_id) if table.space_id else None,
            "default_view_id": str(table.default_view_id) if table.default_view_id else None,
            "row_count": None if getattr(table, 'rls_enabled', False) else table.row_count,
            "field_count": table.field_count,
            "visibility": table.visibility,
            "is_public": table.is_public,
            "is_template": table.is_template,
            "is_archived": table.is_archived,
            "is_trashed": table.is_trashed,
            "trashed_at": table.trashed_at.isoformat() if table.trashed_at else None,
            "current_user_role": role_map.get(str(table.id)),
            "created_at": table.created_at.isoformat() if table.created_at else None,
            "updated_at": table.updated_at.isoformat() if table.updated_at else None,
        })

    return success_response({
        "tables": serialized_tables,
        "total": total,
        "page": page,
        "page_size": page_size,
    })


@router.post(
    "/organizations/{organization_id}/tables",
    response={201: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="在组织中创建表格（org-only，）"
)
@api_error_handler
def create_organization_table(
    request: HttpRequest,
    organization_id: UUID,
    data: TableCreateHierarchical,
):
    """
    在 Organization 下创建新表格（不挂 Space）。

    ：表直属 Organization；原生 schema 分区用 organization_id。
    """
    try:
        service = TableService(user=request.auth)
        table = service.create_table(
            organization_id=organization_id,
            space_id=None,
            name=data.name,
            description=data.description,
            icon=data.icon,
            use_default_fields=data.use_default_fields,
            schema_history_id=data.schema_history_id,
            default_source_url=data.default_source_url,
            collection_id=data.collection_id,
            parent_item_id=data.parent_item_id,
        )

        if not table:
            return permission_denied_response("创建表格失败，权限不足")

        user_role = _compute_user_table_role_safe(request.auth, table)
        return 201, success_response(
            data=TableOut.from_orm(table, current_user_role=user_role).dict(),
            message=_("tabdata.table_created")
        )
    except OrganizationControlBlockedError as e:
        return organization_control_blocked_response(e)
    except MembershipQuotaExceededError as e:
        return error_response(
            ErrorCode.QUOTA_EXCEEDED,
            message=str(e),
            status_code=403,
            detail=str(e)
        )
    except MembershipException as e:
        return error_response(
            ErrorCode.PERMISSION_DENIED,
            message=str(e),
            status_code=403,
        )
    except ValueError as e:
        return validation_error_response(str(e))


@router.post(
    "/organizations/{organization_id}/spaces/{space_id}/tables",
    response={201: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="在 Space 中创建表格（层级化接口）"
)
@api_error_handler
def create_space_table(
    request: HttpRequest,
    organization_id: UUID,
    space_id: UUID,
    data: TableCreateHierarchical
):
    """
    在 Space 中创建新表格（严格层级化接口）

    Args:
        organization_id: 组织ID
        space_id: Space ID（从URL路径获取）
        data: 表格数据（不包含 space_id）

    Returns:
        创建的表格
    """
    # ：遗留 Space 路径——仅校验 org 归属后创建 org-only 表，不写入 space_id
    try:
        from apps.tabtinspace.services.base import ensure_space_in_organization
        ensure_space_in_organization(organization_id, space_id)
    except ValueError:
        return not_found_response("智能体空间")

    try:
        service = TableService(user=request.auth)
        table = service.create_table(
            organization_id=organization_id,
            space_id=None,
            name=data.name,
            description=data.description,
            icon=data.icon,
            use_default_fields=data.use_default_fields,
            schema_history_id=data.schema_history_id,
            default_source_url=data.default_source_url,
            collection_id=data.collection_id,
            parent_item_id=data.parent_item_id,
        )

        if not table:
            return permission_denied_response("创建表格失败，权限不足")

        user_role = _compute_user_table_role_safe(request.auth, table)
        return 201, success_response(
            data=TableOut.from_orm(table, current_user_role=user_role).dict(),
            message=_("tabdata.table_created")
        )
    except OrganizationControlBlockedError as e:
        return organization_control_blocked_response(e)
    except MembershipQuotaExceededError as e:
        return error_response(
            ErrorCode.QUOTA_EXCEEDED,
            message=str(e),
            status_code=403,
            detail=str(e)
        )
    except MembershipException as e:
        return error_response(
            ErrorCode.PERMISSION_DENIED,
            message=str(e),
            status_code=403,
        )


@router.get(
    "/tables/{table_id}",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="获取表格详情"
)
@api_error_handler
def get_table(request: HttpRequest, table_id: UUID):
    """
    获取表格详情

    Args:
        table_id: 表格ID

    Returns:
        表格详情（含 current_user_role）
    """
    service = TableService(user=request.auth)
    table = service.get_table(table_id)

    if not table:
        return not_found_response("表格")

    user_role = _compute_user_table_role_safe(request.auth, table)
    table_data = TableOut.from_orm(table, current_user_role=user_role).dict()
    return success_response(table_data)


@router.post(
    "/tables",
    response={201: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="创建表格"
)
@api_error_handler
def create_table(request: HttpRequest, data: TableCreate):
    """
    创建新表格

    Args:
        data: 表格数据

    Returns:
        创建的表格
    """
    try:
        service = TableService(user=request.auth)
        table = service.create_table(
            organization_id=data.organization_id,
            space_id=None,
            name=data.name,
            description=data.description,
            icon=data.icon,
            use_default_fields=data.use_default_fields,
            schema_history_id=data.schema_history_id,
            default_source_url=data.default_source_url,
            collection_id=data.collection_id,
            parent_item_id=data.parent_item_id,
        )

        if not table:
            return permission_denied_response("创建表格失败，权限不足")

        user_role = _compute_user_table_role_safe(request.auth, table)
        return 201, success_response(
            data=TableOut.from_orm(table, current_user_role=user_role).dict(),
            message=_("tabdata.table_created")
        )
    except OrganizationControlBlockedError as e:
        return organization_control_blocked_response(e)
    except MembershipQuotaExceededError as e:
        return error_response(
            ErrorCode.QUOTA_EXCEEDED,
            message=str(e),
            status_code=403,
            detail=str(e)
        )
    except MembershipException as e:
        return error_response(
            ErrorCode.PERMISSION_DENIED,
            message=str(e),
            status_code=403,
        )


@router.put(
    "/tables/{table_id}",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="更新表格"
)
@api_error_handler
def update_table(request: HttpRequest, table_id: UUID, data: TableUpdate):
    """
    更新表格信息

    Args:
        table_id: 表格ID
        data: 更新数据

    Returns:
        更新后的表格
    """
    service = TableService(user=request.auth)
    table = service.update_table(
        table_id=table_id,
        name=data.name,
        description=data.description,
        icon=data.icon
    )

    if not table:
        return not_found_response("表格")

    user_role = _compute_user_table_role_safe(request.auth, table)
    return success_response(
        data=TableOut.from_orm(table, current_user_role=user_role).dict(),
        message=_("tabdata.table_updated")
    )


@router.post(
    "/tables/{table_id}/archive",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="归档表格"
)
@api_error_handler
def archive_table(request: HttpRequest, table_id: UUID):
    """
    归档表格

    Args:
        table_id: 表格ID

    Returns:
        归档结果
    """
    service = TableService(user=request.auth)
    success = service.archive_table(table_id)

    if not success:
        return permission_denied_response("归档表格失败，权限不足或表格不存在")

    return success_response(message=_("tabdata.table_archived"))


@router.post(
    "/tables/{table_id}/restore",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="恢复表格"
)
@api_error_handler
def restore_table(request: HttpRequest, table_id: UUID):
    """
    恢复已归档的表格

    Args:
        table_id: 表格ID

    Returns:
        恢复结果
    """
    service = TableService(user=request.auth)
    success = service.restore_table(table_id)

    if not success:
        return permission_denied_response("恢复表格失败，权限不足或表格不存在")

    return success_response(message=_("tabdata.table_restored"))


@router.delete(
    "/tables/{table_id}",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="删除表格"
)
@api_error_handler
def delete_table(request: HttpRequest, table_id: UUID):
    """
    删除表格（永久删除）

    Args:
        table_id: 表格ID

    Returns:
        删除结果
    """
    service = TableService(user=request.auth)
    success = service.delete_table(table_id)

    if not success:
        return permission_denied_response("删除表格失败，只有组织所有者可以删除表格")

    return success_response(message=_("tabdata.table_deleted"))


@router.post(
    "/tables/{table_id}/trash",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="移入回收站"
)
@api_error_handler
def trash_table(request: HttpRequest, table_id: UUID):
    service = TableService(user=request.auth)
    success = service.trash_table(table_id)
    if not success:
        return permission_denied_response("移入回收站失败，权限不足或表格不存在")
    return success_response(message=_("tabdata.table_trashed"))


@router.post(
    "/tables/{table_id}/restore-from-trash",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="从回收站恢复"
)
@api_error_handler
def restore_table_from_trash(request: HttpRequest, table_id: UUID):
    service = TableService(user=request.auth)
    success = service.restore_table_from_trash(table_id)
    if not success:
        return permission_denied_response("恢复表格失败，权限不足或表格不存在")
    return success_response(message=_("tabdata.table_untrashed"))


@router.delete(
    "/tables/{table_id}/permanent",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="永久删除"
)
@api_error_handler
def permanent_delete_table(request: HttpRequest, table_id: UUID):
    service = TableService(user=request.auth)
    success = service.permanent_delete_table(table_id)
    if not success:
        return permission_denied_response("永久删除失败，权限不足或表格不在回收站中")
    return success_response(message=_("tabdata.table_permanently_deleted"))


# ==================== Statistics ====================

@router.get(
    "/tables/{table_id}/stats",
    response={200: dict, 401: ErrorResponse, 403: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="获取表格统计信息"
)
@api_error_handler
def get_table_stats(request: HttpRequest, table_id: UUID):
    """
    获取表格的统计信息

    Args:
        table_id: 表格ID

    Returns:
        统计信息
    """
    from apps.tabdata.services.rls_service import RLSContext

    service = RecordService(user=request.auth)
    record_count = service.get_record_count(
        table_id, rls_context=RLSContext.from_request(request),
    )

    return success_response({
        "table_id": str(table_id),
        "record_count": record_count
    })


# ==================== Search Index ====================

@router.get(
    "/tables/{table_id}/search-index/status",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="获取表格搜索索引状态"
)
@api_error_handler
def get_table_search_index_status(request: HttpRequest, table_id: UUID):
    """
    获取表格搜索索引状态：
    - 是否启用
    - 索引健康状态
    - 字段索引覆盖情况
    """
    from apps.tabdata.services import SearchIndexService
    from apps.tabdata.models import Table

    service = SearchIndexService(user=request.auth)
    try:
        result = service.get_search_index_status(table_id)
        return success_response(result)
    except Table.DoesNotExist:
        return not_found_response("表格")
    except Exception as e:
        logger.exception("获取搜索索引状态失败")
        return error_response(ErrorCode.INTERNAL_ERROR, message=_("tabdata.search_index_status_failed"), status_code=500)


@router.post(
    "/tables/{table_id}/search-index/toggle",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="切换表格搜索索引"
)
@api_error_handler
def toggle_table_search_index(request: HttpRequest, table_id: UUID):
    """
    切换搜索索引状态。

    请求体:
    - enabled: bool | null（可选）
      - true: 强制开启
      - false: 强制关闭
      - null/省略: 切换当前状态
    """
    import json
    from typing import Optional
    from apps.tabdata.services import SearchIndexService
    from apps.tabdata.models import Table

    enabled: Optional[bool] = None
    if request.body:
        try:
            payload = json.loads(request.body)
        except json.JSONDecodeError as exc:
            return validation_error_response(f"请求体 JSON 格式错误: {exc}")

        if not isinstance(payload, dict):
            return validation_error_response("请求体必须为对象")

        if 'enabled' in payload:
            raw_enabled = payload.get('enabled')
            if raw_enabled is None:
                enabled = None
            elif isinstance(raw_enabled, bool):
                enabled = raw_enabled
            else:
                return validation_error_response("参数 enabled 必须是布尔值或 null")

    service = SearchIndexService(user=request.auth)
    try:
        result = service.toggle_search_index(table_id, enabled=enabled)
        return success_response(result, message=_("tabdata.search_index_updated"))
    except Table.DoesNotExist:
        return not_found_response("表格")
    except Exception as e:
        logger.exception("切换搜索索引失败")
        return error_response(ErrorCode.INTERNAL_ERROR, message=_("tabdata.search_index_toggle_failed"), status_code=500)


@router.post(
    "/tables/{table_id}/search-index/repair",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="修复表格搜索索引"
)
@api_error_handler
def repair_table_search_index(request: HttpRequest, table_id: UUID):
    """
    修复搜索索引：
    - 补齐缺失索引
    - 清理冗余索引
    - 修复定义异常索引
    """
    from apps.tabdata.services import SearchIndexService
    from apps.tabdata.models import Table

    service = SearchIndexService(user=request.auth)
    try:
        result = service.repair_search_index(table_id)
        return success_response(result, message=_("tabdata.search_index_repaired"))
    except Table.DoesNotExist:
        return not_found_response("表格")
    except Exception as e:
        logger.exception("修复搜索索引失败")
        return error_response(ErrorCode.INTERNAL_ERROR, message=_("tabdata.search_index_repair_failed"), status_code=500)


@router.get(
    "/tables/{table_id}/search-index/query",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="搜索记录并返回命中索引"
)
@api_error_handler
def search_records_by_index(request: HttpRequest, table_id: UUID):
    """

    返回匹配搜索条件的记录索引列表：
    [{index, fieldId, recordId}, ...]

    查询参数:
    - search: 搜索关键词（必填，最大 1000 字符）
    - field_id: 字段ID（逗号分隔或 'all_fields'，可选，默认全字段）
    - hide_not_match_row: 是否隐藏不匹配行（'true'/'false'，影响 index 计算）
    - view_id: 视图ID（可选，用于排序）
    - skip: 分页偏移（默认 0）
    - take: 每页数量（默认 100，最大 1000）
    """
    from apps.tabdata.services import SearchIndexService
    from apps.tabdata.models import Table

    search_value = request.GET.get('search', '').strip()[:1000]
    if not search_value:
        return validation_error_response("search 参数不能为空")

    field_id = request.GET.get('field_id', None)
    hide_not_match_row_raw = request.GET.get('hide_not_match_row', 'false')
    hide_not_match_row = hide_not_match_row_raw.lower() in ('true', '1', 'yes')

    view_id_raw = request.GET.get('view_id', None)
    view_id = UUID(view_id_raw) if view_id_raw else None

    try:
        skip = max(0, int(request.GET.get('skip', 0)))
    except (ValueError, TypeError):
        skip = 0

    try:
        take = min(1000, max(1, int(request.GET.get('take', 100))))
    except (ValueError, TypeError):
        take = 100

    service = SearchIndexService(user=request.auth)
    try:
        result = service.search_records(
            table_id=table_id,
            search_value=search_value,
            field_id=field_id,
            hide_not_match_row=hide_not_match_row,
            view_id=view_id,
            skip=skip,
            take=take,
        )
        return success_response(result)
    except Table.DoesNotExist:
        return not_found_response("表格")
    except Exception as e:
        logger.exception("搜索记录失败")
        return error_response(ErrorCode.INTERNAL_ERROR, message=_("tabdata.search_record_failed"), status_code=500)


@router.get(
    "/tables/{table_id}/search-index/count",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="搜索记录匹配总数"
)
@api_error_handler
def search_records_count(request: HttpRequest, table_id: UUID):
    """

    返回匹配搜索条件的 field-record 对总数。

    查询参数:
    - search: 搜索关键词（必填，最大 1000 字符）
    - field_id: 字段ID（逗号分隔或 'all_fields'，可选，默认全字段）
    - view_id: 视图ID（可选）
    """
    from apps.tabdata.services import SearchIndexService
    from apps.tabdata.models import Table

    search_value = request.GET.get('search', '').strip()[:1000]
    if not search_value:
        return success_response({'count': 0})

    field_id = request.GET.get('field_id', None)
    view_id_raw = request.GET.get('view_id', None)
    view_id = UUID(view_id_raw) if view_id_raw else None

    service = SearchIndexService(user=request.auth)
    try:
        count = service.search_count(
            table_id=table_id,
            search_value=search_value,
            field_id=field_id,
            view_id=view_id,
        )
        return success_response({'count': count})
    except Table.DoesNotExist:
        return not_found_response("表格")
    except Exception as e:
        logger.exception("搜索记录计数失败")
        return error_response(ErrorCode.INTERNAL_ERROR, message=_("tabdata.search_count_failed"), status_code=500)
