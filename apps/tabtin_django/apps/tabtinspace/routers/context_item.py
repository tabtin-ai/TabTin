"""Tabtin Space context_item 路由。"""

from typing import Optional

from .shared import *  # noqa: F401,F403
from apps.tabtinspace.schemas.common import normalize_legacy_item_type

router = Router(tags=["Tabtin Space"])

_CLOUD_DRIVE_ITEM_TYPES = frozenset({"tabdoc", "tabdata", "tabfiles"})


def _parse_cloud_drive_item_types(raw: Optional[str]) -> set[str]:
    """解析逗号分隔类型并白名单到云盘三种；非法片段丢弃。"""
    if not raw:
        return set()
    parsed: set[str] = set()
    for part in raw.split(","):
        token = part.strip()
        if not token or token in ("null", "undefined"):
            continue
        normalized = normalize_legacy_item_type(token)
        if normalized in _CLOUD_DRIVE_ITEM_TYPES:
            parsed.add(normalized)
    return parsed


@router.get(
    "/organizations/{organization_id}/search",
    auth=jwt_auth,
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse},
)
def organization_search(request: HttpRequest, organization_id: UUID):
    """
    全局搜索端点。

    Query Params:
        q (str, required): 搜索关键词
        type (str, optional): 单类型过滤（旧参数，兼容）
        types (str, optional): 多类型白名单，如 tabdoc,tabdata,tabfiles（云盘首页）
        page (int, optional): 页码（默认 1）
        page_size (int, optional): 每页数量（默认 20, 最大 100）
    """
    item_type = request.GET.get("type", None)
    if item_type in ['null', 'undefined', '']:
        item_type = None
    types_raw = request.GET.get("types", None)
    has_types = bool(types_raw and types_raw not in ("null", "undefined"))
    if item_type and has_types:
        return error_response(
            "VALIDATION_ERROR",
            "不能同时传 type 与 types",
            status_code=400,
        )
    item_types = _parse_cloud_drive_item_types(types_raw) if has_types else None
    if has_types and not item_types:
        try:
            page = max(1, int(request.GET.get("page") or 1))
            page_size = min(100, max(1, int(request.GET.get("page_size") or 20)))
        except (ValueError, TypeError):
            page, page_size = 1, 20
        return success_response(
            data={"items": [], "total": 0, "page": page, "page_size": page_size},
        )

    try:
        page = max(1, int(request.GET.get("page") or 1))
        page_size = min(100, max(1, int(request.GET.get("page_size") or 20)))
    except (ValueError, TypeError):
        page, page_size = 1, 20
    query = request.GET.get("q", "").strip()
    if not query:
        return success_response(data={"items": [], "total": 0, "page": page, "page_size": page_size})

    service = ContextItemService(user=request.auth)
    items, total = service.organization_search(
        organization_id=organization_id,
        query=query,
        item_type=item_type,
        item_types=item_types,
        page=page,
        page_size=page_size,
    )

    from apps.tabtinspace.schemas.context_item import OrganizationSearchItemOut

    items_data = []
    for item in items:
        host = item.workspace or item.project
        host_id = item.workspace_id or item.project_id
        org_id = item.organization_id
        if org_id is None and host is not None:
            org_id = getattr(host, "organization_id", None)
        items_data.append(
            OrganizationSearchItemOut(
                id=item.id,
                item_type=item.item_type,
                title=item.title or "",
                preview=(item.preview[:200] if item.preview else ""),
                resource_id=item.resource_id,
                space_id=host_id,
                space_name=host.name if host else "",
                organization_id=org_id,
                collection_id=item.collection_id,
                metadata=item.metadata,
                is_archived=item.is_archived,
                is_pinned=bool(item.is_pinned),
                updated_at=item.updated_at,
                created_at=item.created_at,
                rank=float(item.rank) if hasattr(item, 'rank') and item.rank else 0,
            ).dict()
        )

    _enrich_owner_info(items, items_data)
    _enrich_last_visited(items, items_data, request.auth)
    _enrich_capabilities(items, items_data, request.auth)

    return success_response(
        data={"items": items_data, "total": total, "page": page, "page_size": page_size},
    )

@router.get(
    "/organizations/{organization_id}/context-items",
    auth=jwt_auth,
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse},
)
def list_organization_context_items(request: HttpRequest, organization_id: UUID):
    """列出当前用户在 Organization 内可访问的资源，不依赖某个 Space 作为 anchor。

    云盘首页扩展：
    - ``item_types``：分页前多类型白名单（与旧 ``item_type`` 互斥）
    - ``visited_only`` + ``sort=-last_visited_at``：按当前用户访问时间排序分页
    """
    item_type = request.GET.get('item_type', None)
    if item_type in ['null', 'undefined', '']:
        item_type = None
    item_types_raw = request.GET.get('item_types', None)
    has_item_types = bool(item_types_raw and item_types_raw not in ('null', 'undefined'))
    if item_type and has_item_types:
        return error_response(
            'VALIDATION_ERROR',
            '不能同时传 item_type 与 item_types',
            status_code=400,
        )

    normalized_item_type = normalize_legacy_item_type(item_type) if item_type else None
    item_types = _parse_cloud_drive_item_types(item_types_raw) if has_item_types else None
    # ：组织级列表支持 tabdata/tabdoc/tabfiles；未传 item_type 时交给 service 返回全部可访问项
    if normalized_item_type is not None and normalized_item_type not in _CLOUD_DRIVE_ITEM_TYPES:
        return success_response({
            "items": [],
            "total": 0,
            "page": 1,
            "page_size": 100,
        })
    if has_item_types and not item_types:
        return success_response({
            "items": [],
            "total": 0,
            "page": 1,
            "page_size": 100,
        })

    is_archived_str = request.GET.get('is_archived', None)
    is_archived = None if not is_archived_str or is_archived_str in ['null', 'undefined', ''] else is_archived_str.lower() == 'true'

    visited_only_raw = (request.GET.get('visited_only') or '').strip().lower()
    visited_only = visited_only_raw in ('1', 'true', 'yes')
    sort = (request.GET.get('sort') or '').strip() or None

    # ：按云盘文件夹过滤；collection_id=root|null 表示未入夹
    collection_id_raw = (request.GET.get('collection_id') or '').strip()
    collection_id = None
    unfiled_only = False
    if collection_id_raw and collection_id_raw not in ('undefined',):
        if collection_id_raw.lower() in ('root', 'null', '__root__'):
            unfiled_only = True
        else:
            try:
                collection_id = UUID(collection_id_raw)
            except (ValueError, TypeError):
                return error_response(
                    'VALIDATION_ERROR',
                    'collection_id 必须是 UUID，或 root/null（未入夹）',
                    status_code=400,
                )

    try:
        page = max(1, int(request.GET.get('page') or 1))
        page_size = min(100, max(1, int(request.GET.get('page_size') or 100)))
    except (ValueError, TypeError):
        page, page_size = 1, 100

    service = ContextItemService(user=request.auth)
    items, total = service.list_items_for_organization(
        organization_id=organization_id,
        item_type=normalized_item_type,
        item_types=item_types,
        is_archived=is_archived,
        page=page,
        page_size=page_size,
        collection_id=collection_id,
        unfiled_only=unfiled_only,
        visited_only=visited_only,
        sort=sort,
    )

    item_data = [ContextItemOut.from_orm(item).dict() for item in items]
    _enrich_empty_previews(items, item_data)
    _enrich_owner_info(items, item_data)
    _enrich_last_visited(items, item_data, request.auth)
    _enrich_capabilities(items, item_data, request.auth)
    for i, item in enumerate(items):
        host = item.workspace or item.project
        if host:
            item_data[i]['space_name'] = host.name

    return success_response({
        "items": item_data,
        "total": total,
        "page": page,
        "page_size": page_size,
    })


@router.get(
    "/organizations/{organization_id}/cloud-drive/shared-feed",
    auth=jwt_auth,
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse},
)
def list_cloud_drive_shared_feed(request: HttpRequest, organization_id: UUID):
    """云盘「分享给我」统一 feed：分页前聚合 tabdoc/tabdata/tabfiles。"""
    item_types_raw = request.GET.get("item_types", "tabdoc,tabdata,tabfiles")
    item_types = _parse_cloud_drive_item_types(item_types_raw)
    if not item_types:
        return success_response(data={"items": [], "next_cursor": None, "limit": 30})

    cursor = (request.GET.get("cursor") or "").strip() or None
    try:
        limit = max(1, min(100, int(request.GET.get("limit") or 30)))
    except (ValueError, TypeError):
        limit = 30

    service = ContextItemService(user=request.auth)
    try:
        page_items, feed, next_cursor = service.list_cloud_drive_shared_feed(
            organization_id=organization_id,
            item_types=item_types,
            cursor=cursor,
            limit=limit,
        )
    except ValueError:
        return error_response("VALIDATION_ERROR", "cursor 无效", status_code=400)

    # 与 list/search 同口径：can_view/edit/move/share/trash/delete
    _enrich_capabilities(page_items, feed, request.auth)

    return success_response(data={
        "items": feed,
        "next_cursor": next_cursor,
        "limit": limit,
    })

@router.get("/organizations/{organization_id}/knowledge-tree", auth=jwt_auth, response={200: dict, 401: ErrorResponse})
def get_organization_knowledge_tree(request: HttpRequest, organization_id: UUID):
    """Notion 式云文档知识库树（仅 ContextItem.parent；与云盘 Collection 解耦）。"""
    item_types_raw = request.GET.get("item_types", "tabdoc,tabdata")
    item_types = {
        t.strip()
        for t in item_types_raw.split(",")
        if t.strip() in {"tabdoc", "tabdata"}
    } or {"tabdoc", "tabdata"}

    try:
        depth = max(1, min(5, int(request.GET.get("depth") or 2)))
    except (ValueError, TypeError):
        depth = 2
    owned_only = (request.GET.get("owned_only") or "").strip().lower() in ("1", "true", "yes")

    from apps.tabtinspace.services.knowledge_tree_service import KnowledgeTreeService

    service = KnowledgeTreeService(user=request.auth)
    data = service.build_tree(
        organization_id=organization_id,
        item_types=item_types,
        depth=depth,
        owned_only=owned_only,
    )
    return success_response(data=data)

@router.get(
    "/organizations/{organization_id}/knowledge-tree/nodes/{node_id}/children",
    auth=jwt_auth,
    response={200: dict, 401: ErrorResponse},
)
def get_knowledge_tree_node_children(request: HttpRequest, organization_id: UUID, node_id: UUID):
    """Lazy 加载知识库树节点的直接子节点（tabdoc / tabdata）。"""
    node_type = (request.GET.get("node_type") or "").strip()
    if node_type not in {"tabdoc", "tabdata"}:
        return error_response(
            "BAD_REQUEST",
            message="node_type must be tabdoc or tabdata",
            status_code=400,
        )

    item_types_raw = request.GET.get("item_types", "tabdoc,tabdata")
    item_types = {
        t.strip()
        for t in item_types_raw.split(",")
        if t.strip() in {"tabdoc", "tabdata"}
    } or {"tabdoc", "tabdata"}
    owned_only = (request.GET.get("owned_only") or "").strip().lower() in ("1", "true", "yes")

    from apps.tabtinspace.services.knowledge_tree_service import KnowledgeTreeService

    service = KnowledgeTreeService(user=request.auth)
    children = service.list_node_children(
        organization_id=organization_id,
        node_id=node_id,
        node_type=node_type,
        item_types=item_types,
        owned_only=owned_only,
    )
    return success_response(data={"children": children, "node_id": str(node_id), "node_type": node_type})


@router.post(
    "/organizations/{organization_id}/knowledge-tree/reorder-siblings",
    auth=jwt_auth,
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse},
)
def reorder_knowledge_tree_siblings(
    request: HttpRequest,
    organization_id: UUID,
    data: ReorderKnowledgeTreeSiblings,
):
    """按 ContextItem.parent 同级重排；不触碰 collection_id。"""
    from apps.tabtinspace.services.base import ServiceError
    from apps.tabtinspace.services.knowledge_tree_service import KnowledgeTreeService

    service = KnowledgeTreeService(user=request.auth)
    try:
        updated = service.reorder_siblings(
            organization_id=organization_id,
            parent_id=data.parent_id,
            item_ids=data.item_ids,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return success_response(data={"updated": updated}, message="知识树同级顺序已更新")

@router.get("/organizations/{organization_id}/trash", auth=jwt_auth, response={200: dict, 401: ErrorResponse})
def list_organization_trashed_items(
    request: HttpRequest,
    organization_id: UUID,
    item_type: str = None,
    page: int = 1,
    page_size: int = 100,
):
    """Organization 级资源回收站列表——资源归属团队，不再以 Space 为回收站边界。"""
    page = max(1, page)
    page_size = min(max(1, page_size), 200)

    service = ContextItemService(user=request.auth)
    items, total = service.list_trashed_items_for_organization(
        organization_id=organization_id,
        item_type=item_type,
        page=page,
        page_size=page_size,
    )
    items_data = [TrashedContextItemOut.from_orm(item).dict() for item in items]
    _enrich_owner_info(items, items_data)
    for i, item in enumerate(items):
        host = item.workspace or item.project
        if host:
            items_data[i]['space_name'] = host.name
    from apps.services.billing.services.entitlement_limits_service import EntitlementLimitsService
    try:
        retention_days = EntitlementLimitsService.get_recycle_retention_days(str(organization_id)) or 30
    except Exception:
        # 回收站列表不能因套餐数据暂时不可用而整体失败，沿用免费版安全默认值。
        retention_days = 30
    return success_response({
        "items": items_data,
        "total": total,
        "page": page,
        "page_size": page_size,
        "retention_days": retention_days,
    })

@router.post("/organizations/{organization_id}/trash/empty", auth=jwt_auth, response={200: dict, **RESP_ERR})
def empty_organization_trash(request: HttpRequest, organization_id: UUID):
    service = ContextItemService(user=request.auth)
    deleted_count = service.empty_organization_trash(organization_id)
    return success_response({
        "deleted_count": deleted_count,
        "message": f"已永久删除 {deleted_count} 个资源",
    })

# ：/spaces 退役；宿主资源走 /workspaces|/projects（path 参数名仍为 space_id，值为 host id）。
@router.get("/spaces/{space_id}/trash", auth=jwt_auth, response={200: dict, 401: ErrorResponse})
@router.get("/workspaces/{space_id}/trash", auth=jwt_auth, response={200: dict, 401: ErrorResponse})
@router.get("/projects/{space_id}/trash", auth=jwt_auth, response={200: dict, 401: ErrorResponse})
def list_trashed_items(
    request: HttpRequest,
    space_id: UUID,
    item_type: str = None,
    page: int = 1,
    page_size: int = 100,
):
    page = max(1, page)
    page_size = min(max(1, page_size), 200)

    service = ContextItemService(user=request.auth)
    items, total = service.list_trashed_items(
        space_id=space_id,
        item_type=item_type,
        page=page,
        page_size=page_size,
    )
    items_data = [TrashedContextItemOut.from_orm(item).dict() for item in items]
    _enrich_owner_info(items, items_data)
    return success_response({
        "items": items_data,
        "total": total,
        "page": page,
        "page_size": page_size,
    })

@router.post("/spaces/{space_id}/trash/empty", auth=jwt_auth, response={200: dict, **RESP_ERR})
@router.post("/workspaces/{space_id}/trash/empty", auth=jwt_auth, response={200: dict, **RESP_ERR})
@router.post("/projects/{space_id}/trash/empty", auth=jwt_auth, response={200: dict, **RESP_ERR})
def empty_space_trash(request: HttpRequest, space_id: UUID):
    service = ContextItemService(user=request.auth)
    deleted_count = service.empty_trash(space_id)
    return success_response({
        "deleted_count": deleted_count,
        "message": f"已永久删除 {deleted_count} 个资源",
    })

@router.get("/spaces/{space_id}/context-items", auth=jwt_auth, response={200: dict, 401: ErrorResponse})
@router.get("/workspaces/{space_id}/context-items", auth=jwt_auth, response={200: dict, 401: ErrorResponse})
@router.get("/projects/{space_id}/context-items", auth=jwt_auth, response={200: dict, 401: ErrorResponse})
def list_context_items(request: HttpRequest, space_id: UUID):
    item_type = request.GET.get('item_type', None)

    is_archived_str = request.GET.get('is_archived', None)
    is_archived = None if not is_archived_str or is_archived_str in ['null', 'undefined', ''] else is_archived_str.lower() == 'true'

    try:
        page_str = request.GET.get('page', '1')
        page = int(page_str) if page_str and page_str not in ['null', 'undefined', ''] else 1
    except (TypeError, ValueError):
        page = 1
    page = max(1, page)

    try:
        page_size_str = request.GET.get('page_size', '100')
        page_size = int(page_size_str) if page_size_str and page_size_str not in ['null', 'undefined', ''] else 100
    except (TypeError, ValueError):
        page_size = 100
    page_size = min(max(1, page_size), 200)

    scope = request.GET.get('scope', 'space')
    if scope not in ('space', 'organization'):
        scope = 'space'

    service = ContextItemService(user=request.auth)
    items, total = service.list_items(
        space_id=space_id,
        item_type=item_type,
        is_archived=is_archived,
        page=page,
        page_size=page_size,
        scope=scope,
    )

    item_data = [ContextItemOut.from_orm(item).dict() for item in items]

    _enrich_empty_previews(items, item_data)
    _enrich_owner_info(items, item_data)
    _enrich_last_visited(items, item_data, request.auth)
    _enrich_capabilities(items, item_data, request.auth)

    if scope == "organization":
        for i, item in enumerate(items):
            host = item.workspace or item.project
            if host:
                item_data[i]['space_name'] = host.name

    return success_response({
        "items": item_data,
        "total": total,
        "page": page,
        "page_size": page_size,
    })

@router.post("/spaces/{space_id}/context-items", auth=jwt_auth, response=RESP_CREATE_SIMPLE)
@router.post("/workspaces/{space_id}/context-items", auth=jwt_auth, response=RESP_CREATE_SIMPLE)
@router.post("/projects/{space_id}/context-items", auth=jwt_auth, response=RESP_CREATE_SIMPLE)
def create_context_item(request: HttpRequest, space_id: UUID, data: ContextItemCreate):
    service = ContextItemService(user=request.auth)
    item = service.create_item(
        space_id=space_id,
        item_type=data.item_type,
        title=data.title,
        preview=data.preview,
        status=data.status,
        order=data.order,
        resource_id=data.resource_id,
        metadata=data.metadata
    )

    if not item:
        return permission_denied_response(_("tabtinspace.context_item_create_failed"))

    return 201, success_response(
        data=ContextItemOut.from_orm(item).dict(),
        message=_("tabtinspace.context_item_created")
    )

@router.post("/context-items/{item_id}/access", auth=jwt_auth, response={200: dict, **RESP_ERR})
def record_context_item_access(request: HttpRequest, item_id: UUID):
    """记录当前用户最近一次打开该资源（upsert last_visited_at=now）。

    资源主页「最近访问」列与排序的数据来源。轻量幂等，前端在打开资源时 fire-and-forget。
    """
    service = ContextItemService(user=request.auth)
    ok = service.record_access(item_id)
    if not ok:
        return not_found_response(_("tabtinspace.context_item_not_found"))
    return success_response(message="ok")

@router.get("/context-items/{item_id}", auth=jwt_auth, response={200: dict, **RESP_ERR})
def get_context_item(request: HttpRequest, item_id: UUID):
    service = ContextItemService(user=request.auth)
    item = service.get_item(item_id)

    if not item:
        return not_found_response(_("tabtinspace.context_item_not_found"))

    return success_response(ContextItemOut.from_orm(item).dict())

@router.patch("/context-items/{item_id}", auth=jwt_auth, response={200: dict, **RESP_ERR_400})
def update_context_item(request: HttpRequest, item_id: UUID, data: ContextItemUpdate):
    service = ContextItemService(user=request.auth)
    update_kwargs = dict(
        item_id=item_id,
        title=data.title,
        preview=data.preview,
        status=data.status,
        order=data.order,
        is_archived=data.is_archived,
        is_pinned=data.is_pinned,
        resource_id=data.resource_id,
        metadata=data.metadata,
    )
    # ：显式传 parent_id（含 null 落根）才改树；省略则不动
    fields_set = getattr(data, "model_fields_set", None) or getattr(data, "__fields_set__", set())
    if "parent_id" in fields_set:
        update_kwargs["parent_id"] = data.parent_id

    try:
        item = service.update_item(**update_kwargs)
    except ValueError as exc:
        return error_response("BAD_REQUEST", str(exc), status_code=400)

    if not item:
        return permission_denied_response(_("tabtinspace.context_item_update_failed"))

    _push_context_item_ws(item, "resource_updated", request.auth)

    return success_response(
        data=ContextItemOut.from_orm(item).dict(),
        message=_("tabtinspace.context_item_updated")
    )

@router.delete("/context-items/{item_id}", auth=jwt_auth, response={200: dict, **RESP_ERR})
def archive_context_item(request: HttpRequest, item_id: UUID):
    service = ContextItemService(user=request.auth)
    item = service.get_item(item_id)
    success = service.archive_item(item_id)

    if not success:
        return permission_denied_response(_("tabtinspace.context_item_archive_failed"))

    if item:
        _push_context_item_ws(item, "resource_archived", request.auth)

    return success_response(message=_("tabtinspace.context_item_archived"))

@router.get("/spaces/{space_id}/search", auth=jwt_auth, response={200: dict, 401: ErrorResponse})
@router.get("/workspaces/{space_id}/search", auth=jwt_auth, response={200: dict, 401: ErrorResponse})
@router.get("/projects/{space_id}/search", auth=jwt_auth, response={200: dict, 401: ErrorResponse})
def search_space_resources(request: HttpRequest, space_id: UUID):
    """
    跨 App 统一搜索端点。

    Query Params:
        q (str, required): 搜索关键词
        type (str, optional): 资源类型过滤 (table→TabData / document→TabDoc / ppt→TabSlide)
        include_archived (bool, optional): 是否包含已归档（默认 false）
        page (int, optional): 页码（默认 1）
        page_size (int, optional): 每页数量（默认 50）
    """
    item_type = request.GET.get("type", None)
    include_archived = request.GET.get("include_archived", "").lower() == "true"
    try:
        page = max(1, int(request.GET.get("page") or 1))
        page_size = min(200, max(1, int(request.GET.get("page_size") or 50)))
    except (ValueError, TypeError):
        page, page_size = 1, 50
    query = request.GET.get("q", "").strip()
    if not query:
        return success_response(
            data={"items": [], "total": 0, "page": page, "page_size": page_size},
            message=_("tabtinspace.enter_search_keyword"),
        )

    service = ContextItemService(user=request.auth)
    items, total = service.search_items(
        space_id=space_id,
        query=query,
        item_type=item_type,
        include_archived=include_archived,
        page=page,
        page_size=page_size,
    )

    items_data = []
    for item in items:
        d = ContextItemOut.from_orm(item).dict()
        if hasattr(item, 'rank') and item.rank is not None:
            d['rank'] = float(item.rank)
        items_data.append(d)

    return success_response(
        data={"items": items_data, "total": total, "page": page, "page_size": page_size},
    )

__all__ = ["router"]
