"""Tabtin Space organization 路由。"""

from .shared import *  # noqa: F401,F403

router = Router(tags=["Tabtin Space"])

@router.get("/organizations", auth=jwt_auth, response={200: dict, 401: ErrorResponse})
def list_organizations(request: HttpRequest):
    search = request.GET.get('search', None)
    is_default_str = request.GET.get('is_default', None)
    is_default = None if not is_default_str or is_default_str in ['null', 'undefined', ''] else is_default_str.lower() == 'true'

    type_param = request.GET.get('type', None)
    if type_param in ['null', 'undefined', '']:
        type_param = None

    try:
        page = max(1, int(request.GET.get('page', '1') or '1'))
    except (ValueError, TypeError):
        page = 1
    try:
        page_size = min(max(1, int(request.GET.get('page_size', '50') or '50')), 200)
    except (ValueError, TypeError):
        page_size = 50

    service = OrganizationService(user=request.auth)
    organizations = service.list_organizations(search=search, is_default=is_default, type=type_param)

    total = organizations.count()
    offset = (page - 1) * page_size
    page_ws = organizations[offset:offset + page_size]
    organization_data = [OrganizationOut.from_orm(ws).dict() for ws in page_ws]

    return success_response({
        "organizations": organization_data,
        "total": total,
        "page": page,
        "page_size": page_size,
    })

@router.get(
    "/organizations/{organization_id}",
    auth=jwt_auth,
    response={200: dict, 401: ErrorResponse, 404: ErrorResponse},
)
def get_organization(request: HttpRequest, organization_id: UUID):
    service = OrganizationService(user=request.auth)
    try:
        organization = service.get_organization(organization_id)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    return success_response(OrganizationOut.from_orm(organization).dict())

@router.post(
    "/organizations",
    auth=jwt_auth,
    response={201: dict, 400: ErrorResponse, 401: ErrorResponse, 409: ErrorResponse},
)
def create_organization(request: HttpRequest, data: OrganizationCreate):
    service = OrganizationService(user=request.auth)
    try:
        organization = service.create_organization(
            name=data.name,
            description=data.description,
            icon=data.icon,
            settings=data.settings,
            default_agent_device_fingerprint=data.default_agent_device_fingerprint,
            default_agent_working_dir=data.default_agent_working_dir,
            default_agent_working_dir_type=data.default_agent_working_dir_type,
            request=request,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    _audit(
        request,
        action_type='organization_create', target_type='organization',
        target_id=organization.id, organization_id=organization.id,
        message=f"创建组织「{data.name}」",
        activity_action='created', resource_name=data.name,
    )

    return 201, success_response(
        data=OrganizationOut.from_orm(organization).dict(),
        message=_("tabtinspace.organization_created")
    )

@router.put(
    "/organizations/{organization_id}",
    auth=jwt_auth,
    response={
        200: dict,
        400: ErrorResponse,
        401: ErrorResponse,
        403: ErrorResponse,
        404: ErrorResponse,
        409: ErrorResponse,
    },
)
def update_organization(request: HttpRequest, organization_id: UUID, data: OrganizationUpdate):
    service = OrganizationService(user=request.auth)
    try:
        organization = service.update_organization(
            organization_id=organization_id,
            name=data.name,
            description=data.description,
            icon=data.icon,
            settings=data.settings,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    _audit(
        request,
        action_type='organization_update', target_type='organization',
        target_id=organization_id, organization_id=organization_id,
        message=f"更新组织",
        activity_action='updated', resource_name=organization.name,
    )

    return success_response(
        data=OrganizationOut.from_orm(organization).dict(),
        message=_("tabtinspace.organization_updated")
    )

@router.delete(
    "/organizations/{organization_id}",
    auth=jwt_auth,
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
)
def delete_organization(request: HttpRequest, organization_id: UUID):
    service = OrganizationService(user=request.auth)
    try:
        service.delete_organization(organization_id)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    _audit(
        request,
        action_type='organization_delete', target_type='organization',
        target_id=organization_id, organization_id=organization_id,
        message=f"删除组织",
        activity_action='deleted',
    )

    return success_response(message=_("tabtinspace.organization_deleted"))

@router.post(
    "/organizations/{organization_id}/transfer-ownership",
    auth=jwt_auth,
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
)
def transfer_ownership(request: HttpRequest, organization_id: UUID, data: OwnershipTransferRequest):
    service = OrganizationService(user=request.auth)
    try:
        service.transfer_ownership(organization_id, data.new_owner_user_id)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    _audit(
        request,
        action_type='ownership_transfer', target_type='organization',
        target_id=organization_id, organization_id=organization_id,
        message=f"所有权转让给 {data.new_owner_user_id}",
        request_payload={'new_owner_user_id': data.new_owner_user_id},
        activity_action='transferred', resource_name='组织所有权',
    )
    return success_response(message=_("tabtinspace.ownership_transferred"))

@router.get(
    "/organizations/{organization_id}/audit-logs",
    auth=jwt_auth,
    response={200: dict, 401: ErrorResponse, 403: ErrorResponse},
)
def query_audit_logs(request: HttpRequest, organization_id: UUID):
    service = OrganizationService(user=request.auth)
    if not service.check_organization_permission(str(organization_id), 'owner'):
        return permission_denied_response(_("tabtinspace.owner_required"))

    try:
        page = max(1, int(request.GET.get('page') or '1'))
        limit = min(200, max(1, int(request.GET.get('limit') or '50')))
    except (ValueError, TypeError):
        page, limit = 1, 50

    result = AuditService.query_audit_logs(
        organization_id=organization_id,
        action_type=request.GET.get('action_type'),
        target_type=request.GET.get('target_type'),
        operator_id=request.GET.get('operator_id'),
        date_from=request.GET.get('date_from'),
        date_to=request.GET.get('date_to'),
        page=page,
        limit=limit,
    )
    return success_response(data=result)

@router.get(
    "/organizations/{organization_id}/activities",
    auth=jwt_auth,
    response={200: dict, 401: ErrorResponse, 403: ErrorResponse},
)
def get_activity_feed(request: HttpRequest, organization_id: UUID):
    service = OrganizationService(user=request.auth)
    if not service.check_organization_permission(str(organization_id), 'viewer'):
        return permission_denied_response(_("tabtinspace.permission_denied"))

    try:
        page = max(1, int(request.GET.get('page') or '1'))
        limit = min(200, max(1, int(request.GET.get('limit') or '30')))
    except (ValueError, TypeError):
        page, limit = 1, 30

    result = AuditService.get_activity_feed(
        organization_id=organization_id,
        resource_type=request.GET.get('resource_type'),
        page=page,
        limit=limit,
    )
    return success_response(data=result)

__all__ = ["router"]
