"""Tabtin Space collection（文件夹）路由。

#7140：新增 ``/organizations/{organization_id}/collections`` 系列路径，支持
Organization 级（org-only）文件夹树，与 workspace/project 路径并列、互不影响。
"""

from .shared import *  # noqa: F401,F403

router = Router(tags=["Tabtin Space"])

@router.get(
    "/organizations/{organization_id}/shared-resource-placements",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR},
)
def list_shared_resource_placements(request: HttpRequest, organization_id: UUID):
    from apps.tabtinspace.services import SharedResourcePlacementService
    try:
        placements = SharedResourcePlacementService(user=request.auth).list(organization_id)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return success_response(data={'placements': placements})

@router.put(
    "/organizations/{organization_id}/shared-resource-placement",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR_400},
)
def move_shared_resource_placement(
    request: HttpRequest,
    organization_id: UUID,
    data: SharedResourcePlacementMove,
):
    from apps.tabtinspace.services import SharedResourcePlacementService
    try:
        placement = SharedResourcePlacementService(user=request.auth).move(
            organization_id,
            data.resource_type,
            data.resource_id,
            data.collection_id,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return success_response(data={
        'resource_type': placement.resource_type,
        'resource_id': placement.resource_id,
        'collection_id': str(placement.collection_id) if placement.collection_id else None,
    })

@router.delete(
    "/organizations/{organization_id}/shared-resource-placement",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR_400},
)
def dismiss_shared_resource_placement(
    request: HttpRequest,
    organization_id: UUID,
    data: SharedResourcePlacementMove,
):
    from apps.tabtinspace.services import SharedResourcePlacementService
    try:
        SharedResourcePlacementService(user=request.auth).dismiss(
            organization_id, data.resource_type, data.resource_id,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return success_response(data={'dismissed': True})

@router.post(
    "/organizations/{organization_id}/shared-resource-placement/dismiss",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR_400},
)
def dismiss_shared_resource_placement_post(
    request: HttpRequest,
    organization_id: UUID,
    data: SharedResourcePlacementMove,
):
    """桌面端 dismiss 兼容入口：避免部分 Electron 代理丢弃 DELETE body。"""
    from apps.tabtinspace.services import SharedResourcePlacementService
    try:
        SharedResourcePlacementService(user=request.auth).dismiss(
            organization_id, data.resource_type, data.resource_id,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return success_response(data={'dismissed': True})

# ：/spaces 退役；个人宿主走 /workspaces，团队宿主走 /projects（id-reuse 同源 handler）。
@router.get("/spaces/{space_id}/collections", auth=jwt_auth, response={200: dict, 401: ErrorResponse})
@router.get("/workspaces/{space_id}/collections", auth=jwt_auth, response={200: dict, 401: ErrorResponse})
@router.get("/projects/{space_id}/collections", auth=jwt_auth, response={200: dict, 401: ErrorResponse})
def list_collections(request: HttpRequest, space_id: UUID):
    service = CollectionService(user=request.auth)
    collections = service.list_collections(space_id)
    return success_response(data={
        "collections": collections,
        "total": len(collections),
    })

@router.get(
    "/organizations/{organization_id}/collections",
    auth=jwt_auth,
    response={200: dict, 401: ErrorResponse},
    summary="列出 Organization 级（org-only）文件夹树",
)
def list_collections_for_organization(request: HttpRequest, organization_id: UUID):
    service = CollectionService(user=request.auth)
    collections = service.list_collections_for_organization(organization_id)
    return success_response(data={
        "collections": collections,
        "total": len(collections),
    })

@router.post("/spaces/{space_id}/collections", auth=jwt_auth, response=RESP_CREATE)
@router.post("/workspaces/{space_id}/collections", auth=jwt_auth, response=RESP_CREATE)
@router.post("/projects/{space_id}/collections", auth=jwt_auth, response=RESP_CREATE)
def create_collection(request: HttpRequest, space_id: UUID, data: CollectionCreate):
    from apps.tabtinspace.services.organization_control_guard import (
        OrganizationControlBlockedError,
        organization_control_blocked_response,
    )

    service = CollectionService(user=request.auth)
    try:
        coll = service.create_collection(
            space_id=space_id,
            name=data.name,
            parent_id=data.parent_id,
            icon=data.icon or '📁',
            color=data.color or '',
            order=data.order,
        )
    except OrganizationControlBlockedError as e:
        return organization_control_blocked_response(e)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    if not coll:
        return permission_denied_response(_("tabtinspace.collection_create_failed"))

    _push_collection_ws(space_id, 'collection_created', coll)

    from apps.tabtinspace.schemas.collection import CollectionOut
    return 201, success_response(
        data=CollectionOut.from_orm(coll).dict(),
        message="文件夹创建成功",
    )

@router.post(
    "/organizations/{organization_id}/collections",
    auth=jwt_auth,
    response=RESP_CREATE,
    summary="在 Organization 级（org-only）文件夹树下创建文件夹",
)
def create_collection_for_organization(
    request: HttpRequest, organization_id: UUID, data: CollectionCreate,
):
    from apps.tabtinspace.services.organization_control_guard import (
        OrganizationControlBlockedError,
        organization_control_blocked_response,
    )

    service = CollectionService(user=request.auth)
    try:
        coll = service.create_collection_for_organization(
            organization_id=organization_id,
            name=data.name,
            parent_id=data.parent_id,
            icon=data.icon or '📁',
            color=data.color or '',
            order=data.order,
        )
    except OrganizationControlBlockedError as e:
        return organization_control_blocked_response(e)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    if not coll:
        return permission_denied_response(_("tabtinspace.collection_create_failed"))

    _push_collection_ws(None, 'collection_created', coll, organization_id=str(organization_id))

    from apps.tabtinspace.schemas.collection import CollectionOut
    return 201, success_response(
        data=CollectionOut.from_orm(coll).dict(),
        message="文件夹创建成功",
    )

@router.patch("/collections/{collection_id}", auth=jwt_auth, response={200: dict, **RESP_ERR_400})
def update_collection(request: HttpRequest, collection_id: UUID, data: CollectionUpdate):
    service = CollectionService(user=request.auth)
    try:
        coll = service.update_collection(
            collection_id=collection_id,
            name=data.name,
            parent_id=data.parent_id if 'parent_id' in data.model_fields_set else ...,
            icon=data.icon,
            color=data.color,
            order=data.order,
            is_expanded=data.is_expanded,
            is_pinned=data.is_pinned,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    if not coll:
        return permission_denied_response(_("tabtinspace.collection_update_failed"))

    from apps.tabtinspace.services.asset_host import host_id_of, organization_id_of

    # ：org-only 文件夹没有 space 宿主，显式带 organization_id 广播。
    _push_collection_ws(
        host_id_of(coll), 'collection_updated', coll,
        organization_id=organization_id_of(coll),
    )

    from apps.tabtinspace.schemas.collection import CollectionOut
    return success_response(
        data=CollectionOut.from_orm(coll).dict(),
        message="文件夹更新成功",
    )

@router.delete("/collections/{collection_id}", auth=jwt_auth, response={200: dict, **RESP_ERR})
def delete_collection(request: HttpRequest, collection_id: UUID):
    from apps.tabtinspace.models import Collection as CollectionModel
    from apps.tabtinspace.services.asset_host import host_id_of, organization_id_of
    try:
        coll = CollectionModel.objects.get(id=collection_id)
        space_id = host_id_of(coll)
        org_id = organization_id_of(coll)
    except CollectionModel.DoesNotExist:
        return not_found_response(_("tabtinspace.collection_not_found"))

    service = CollectionService(user=request.auth)
    collection_ids = [str(cid) for cid in service.collect_collection_tree_ids(coll)]
    created_by_id = str(coll.created_by_id) if coll.created_by_id else None
    if not service.delete_collection(collection_id):
        return permission_denied_response(_("tabtinspace.collection_delete_failed"))

    _push_collection_ws(space_id, 'collection_deleted', None, extra={
        'collection_id': str(collection_id),
        'collection_ids': collection_ids,
        'created_by_id': created_by_id,
    }, organization_id=org_id)
    return success_response(message="文件夹已删除")

@router.post("/spaces/{space_id}/collections/reorder", auth=jwt_auth, response={200: dict, **RESP_ERR_400})
@router.post("/workspaces/{space_id}/collections/reorder", auth=jwt_auth, response={200: dict, **RESP_ERR_400})
@router.post("/projects/{space_id}/collections/reorder", auth=jwt_auth, response={200: dict, **RESP_ERR_400})
def reorder_collections(request: HttpRequest, space_id: UUID, data: CollectionReorder):
    service = CollectionService(user=request.auth)
    if not service.reorder_collections(space_id, data.collection_ids, data.parent_id):
        return permission_denied_response(_("tabtinspace.collection_reorder_failed"))

    _push_collection_ws(space_id, 'collections_reordered', None)
    return success_response(message="文件夹顺序已更新")

@router.post(
    "/organizations/{organization_id}/collections/reorder",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR_400},
    summary="重排 Organization 级（org-only）同级文件夹顺序",
)
def reorder_collections_for_organization(
    request: HttpRequest, organization_id: UUID, data: CollectionReorder,
):
    service = CollectionService(user=request.auth)
    if not service.reorder_collections_for_organization(organization_id, data.collection_ids):
        return permission_denied_response(_("tabtinspace.collection_reorder_failed"))

    # ：仅通知操作者本人（其私有树）。
    _push_collection_ws(
        None,
        'collections_reordered',
        None,
        organization_id=str(organization_id),
        recipient_user_ids=[str(request.auth.id)],
    )
    return success_response(message="文件夹顺序已更新")

@router.post("/spaces/{space_id}/collections/move-items", auth=jwt_auth, response={200: dict, **RESP_ERR_400})
@router.post("/workspaces/{space_id}/collections/move-items", auth=jwt_auth, response={200: dict, **RESP_ERR_400})
@router.post("/projects/{space_id}/collections/move-items", auth=jwt_auth, response={200: dict, **RESP_ERR_400})
def move_items_to_collection(request: HttpRequest, space_id: UUID, data: MoveItemsToCollection):
    service = CollectionService(user=request.auth)
    try:
        updated = service.move_items(
            space_id=space_id,
            item_ids=data.item_ids,
            collection_id=data.collection_id,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    _push_collection_ws(space_id, 'items_moved', None, extra={
        'collection_id': str(data.collection_id) if data.collection_id else None,
        'count': updated,
    })
    return success_response(data={"updated": updated}, message=f"已移动 {updated} 个资源")


@router.post(
    "/organizations/{organization_id}/collections/move-items",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR_400},
    summary="将资源移入/移出 Organization 级（org-only）文件夹",
)
def move_items_to_collection_for_organization(
    request: HttpRequest, organization_id: UUID, data: MoveItemsToCollection,
):
    service = CollectionService(user=request.auth)
    try:
        updated = service.move_items_for_organization(
            organization_id=organization_id,
            item_ids=data.item_ids,
            collection_id=data.collection_id,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    # ：org-only 移动只刷新操作者自己的文件夹树。
    _push_collection_ws(None, 'items_moved', None, extra={
        'collection_id': str(data.collection_id) if data.collection_id else None,
        'count': updated,
        'created_by_id': str(request.auth.id),
    }, organization_id=str(organization_id), recipient_user_ids=[str(request.auth.id)])
    return success_response(data={"updated": updated}, message=f"已移动 {updated} 个资源")


@router.post("/spaces/{space_id}/collections/reorder-items", auth=jwt_auth, response={200: dict, **RESP_ERR_400})
@router.post("/workspaces/{space_id}/collections/reorder-items", auth=jwt_auth, response={200: dict, **RESP_ERR_400})
@router.post("/projects/{space_id}/collections/reorder-items", auth=jwt_auth, response={200: dict, **RESP_ERR_400})
def reorder_collection_items(request: HttpRequest, space_id: UUID, data: ReorderCollectionItems):
    service = CollectionService(user=request.auth)
    try:
        updated = service.reorder_items(
            space_id=space_id,
            item_ids=data.item_ids,
            collection_id=data.collection_id,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    _push_collection_ws(space_id, 'items_reordered', None, extra={
        'collection_id': str(data.collection_id) if data.collection_id else None,
        'count': updated,
    })
    return success_response(data={"updated": updated}, message="资源顺序已更新")

__all__ = ["router"]
