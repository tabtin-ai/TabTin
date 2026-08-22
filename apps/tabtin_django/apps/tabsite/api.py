"""
TabSite REST API

薄 API 层：参数解析 → 调用 SiteService → 格式化响应。
"""

from __future__ import annotations

import logging
import uuid as _uuid

from ninja import Router

from apps.users.auth.permissions import JWTAuth
from apps.i18n.response import (
    success_response,
    error_response_with_status,
    validation_error_response,
)
from apps.tabsite.models import Site, SiteVersion, SiteFile
from apps.tabsite.schemas import (
    SiteCreateRequest,
    SiteUpdateRequest,
    SiteSummary,
    SiteDetail,
    SiteVersionOut,
    SiteFileOut,
    SitePublishRequest,
    SiteFileWriteRequest,
)

logger = logging.getLogger(__name__)

router = Router(tags=["TabSite"])
jwt_auth = JWTAuth()


def _serialize_summary(s: Site) -> dict:
    version_count = getattr(s, "version_count", None)
    if version_count is None:
        version_count = s.versions.count() if s.pk else 0
    return SiteSummary(
        id=str(s.id),
        organization_id=str(s.organization_id),
        name=s.name,
        slug=s.slug,
        description=(s.description or "")[:200],
        icon=s.icon or "",
        framework=s.framework,
        status=s.status,
        published_url=s.published_url or "",
        current_version=s.current_version,
        total_views=s.total_views,
        is_public=s.is_public,
        template=s.template or "",
        version_count=version_count,
        created_at=s.created_at.isoformat(),
        updated_at=s.updated_at.isoformat(),
    ).dict()


def _serialize_detail(s: Site) -> dict:
    versions = [
        SiteVersionOut(
            id=str(v.id),
            version=v.version,
            message=v.message or "",
            dist_url=v.dist_url,
            file_count=v.file_count,
            total_size=v.total_size,
            is_current=v.is_current,
            created_at=v.created_at.isoformat(),
        ).dict()
        for v in s.versions.all()[:20]
    ]
    files = [
        SiteFileOut(
            id=str(f.id),
            path=f.path,
            content_type=f.content_type,
            file_size=f.file_size,
            updated_at=f.updated_at.isoformat(),
        ).dict()
        for f in s.files.all()
    ]
    return SiteDetail(
        id=str(s.id),
        organization_id=str(s.organization_id),
        name=s.name,
        slug=s.slug,
        description=s.description or "",
        icon=s.icon or "",
        framework=s.framework,
        status=s.status,
        published_url=s.published_url or "",
        current_version=s.current_version,
        dist_oss_url=s.dist_oss_url or "",
        total_views=s.total_views,
        is_public=s.is_public,
        password_protected=bool(s.password),
        custom_domain=s.custom_domain or "",
        template=s.template or "",
        code_project_path=s.code_project_path or "",
        tabdata_table_ids=s.tabdata_table_ids or [],
        tabdata_token_id=s.tabdata_token_id or "",
        versions=versions,
        files=files,
        created_at=s.created_at.isoformat(),
        updated_at=s.updated_at.isoformat(),
    ).dict()


def _svc(request):
    from apps.tabsite.services.site_service import SiteService
    return SiteService(user=request.auth)


def _check_uuid(value: str, field_name: str = "id"):
    try:
        _uuid.UUID(value)
        return None
    except (TypeError, ValueError):
        return validation_error_response(f"{field_name} 格式非法")


# ── Site CRUD ──


@router.post("/sites/", auth=jwt_auth)
def create_site(request, payload: SiteCreateRequest):
    from apps.tabtinspace.services.organization_control_guard import (
        OrganizationControlBlockedError,
        organization_control_blocked_response,
    )

    svc = _svc(request)
    try:
        site = svc.create_site(
            organization_id=payload.organization_id,
            space_id=payload.space_id,
            name=payload.name,
            description=payload.description,
            framework=payload.framework,
            template=payload.template,
        )
    except OrganizationControlBlockedError as e:
        return organization_control_blocked_response(e)
    return success_response(_serialize_detail(site))


@router.get("/sites/", auth=jwt_auth)
def list_sites(
    request,
    organization_id: str,
    space_id: str,
    status: str = "",
    page: int = 1,
    page_size: int = 20,
):
    page = max(1, page)
    page_size = max(1, min(page_size, 100))
    svc = _svc(request)
    result = svc.list_sites(
        organization_id=organization_id,
        space_id=space_id,
        status=status,
        page=page,
        page_size=page_size,
    )
    return success_response({
        "items": [_serialize_summary(s) for s in result["items"]],
        "total": result["total"],
        "page": page,
        "page_size": page_size,
    })


@router.get("/sites/{site_id}/", auth=jwt_auth)
def get_site(request, site_id: str):
    if err := _check_uuid(site_id, "site_id"):
        return err
    svc = _svc(request)
    site = svc.get_site_detail(site_id)
    return success_response(_serialize_detail(site))


@router.patch("/sites/{site_id}/", auth=jwt_auth)
def update_site(request, site_id: str, payload: SiteUpdateRequest):
    if err := _check_uuid(site_id, "site_id"):
        return err
    svc = _svc(request)
    site = svc.update_site(
        site_id=site_id,
        name=payload.name,
        description=payload.description,
        icon=payload.icon,
        is_public=payload.is_public,
        password=payload.password,
        custom_domain=payload.custom_domain,
        code_project_path=payload.code_project_path,
        tabdata_table_ids=payload.tabdata_table_ids,
        tabdata_token_id=payload.tabdata_token_id,
    )
    return success_response(_serialize_detail(site))


@router.delete("/sites/{site_id}/", auth=jwt_auth)
def archive_site(request, site_id: str):
    if err := _check_uuid(site_id, "site_id"):
        return err
    svc = _svc(request)
    svc.archive_site(site_id)
    return success_response()


# ── TabData Integration ──


@router.post("/sites/{site_id}/provision-token/", auth=jwt_auth)
def provision_tabdata_token(request, site_id: str):
    """为站点自动创建只读 TabData Token。幂等，重复调用不会创建新 Token。
    force=true 时撤销旧 Token 并重新签发（用于 .env.local 丢失恢复）。
    """
    if err := _check_uuid(site_id, "site_id"):
        return err
    force = False
    if request.body:
        import json
        try:
            body = json.loads(request.body)
            force = bool(body.get("force", False))
        except (json.JSONDecodeError, AttributeError):
            pass

    if force:
        from apps.services.common.utils import is_rate_limited
        # TC-006: 防止恶意协作者反复 force provision 破坏站点 Token
        if is_rate_limited(
            key=f"tabsite:provision_token:force:{site_id}",
            limit=5,
            window=3600,
        ):
            return error_response_with_status(
                "RATE_LIMIT_EXCEEDED",
                "Token 重签操作过于频繁，请稍后再试",
                status_code=429,
            )

    svc = _svc(request)
    env_data = svc.provision_tabdata_token(site_id, force=force)
    return success_response(env_data)


@router.get("/sites/{site_id}/tabdata-env/", auth=jwt_auth)
def get_tabdata_env(request, site_id: str):
    """返回站点的 TabData 环境变量（不含 plain_token）。"""
    if err := _check_uuid(site_id, "site_id"):
        return err
    svc = _svc(request)
    env_data = svc.get_tabdata_env(site_id)
    return success_response(env_data)


# ── Publishing ──


@router.post("/sites/{site_id}/publish/", auth=jwt_auth)
def publish_site(request, site_id: str, payload: SitePublishRequest):
    if err := _check_uuid(site_id, "site_id"):
        return err
    svc = _svc(request)
    version = svc.publish_site(
        site_id=site_id,
        message=payload.message,
        dist_url=payload.dist_url,
        file_count=payload.file_count,
        total_size=payload.total_size,
    )
    site = version.site
    result = SiteVersionOut(
        id=str(version.id),
        version=version.version,
        message=version.message or "",
        dist_url=version.dist_url,
        file_count=version.file_count,
        total_size=version.total_size,
        is_current=version.is_current,
        created_at=version.created_at.isoformat(),
    ).dict()
    result["published_url"] = site.published_url or ""
    return success_response(result)


@router.post("/sites/{site_id}/rollback/{version_num}/", auth=jwt_auth)
def rollback_site(request, site_id: str, version_num: int):
    if err := _check_uuid(site_id, "site_id"):
        return err
    svc = _svc(request)
    site = svc.rollback_to_version(site_id, version_num)
    return success_response(_serialize_detail(site))


# ── Files ──


@router.get("/sites/{site_id}/files/", auth=jwt_auth)
def list_files(request, site_id: str):
    if err := _check_uuid(site_id, "site_id"):
        return err
    svc = _svc(request)
    files = svc.list_files(site_id)
    return success_response([
        SiteFileOut(
            id=str(f.id),
            path=f.path,
            content_type=f.content_type,
            file_size=f.file_size,
            updated_at=f.updated_at.isoformat(),
        ).dict()
        for f in files
    ])


@router.get("/sites/{site_id}/files/{path:file_path}", auth=jwt_auth)
def read_file(request, site_id: str, file_path: str):
    if err := _check_uuid(site_id, "site_id"):
        return err
    svc = _svc(request)
    f = svc.read_file(site_id, file_path)
    return success_response({
        "id": str(f.id),
        "path": f.path,
        "content": f.content,
        "content_type": f.content_type,
        "file_size": f.file_size,
    })


@router.put("/sites/{site_id}/files/", auth=jwt_auth)
def write_file(request, site_id: str, payload: SiteFileWriteRequest):
    if err := _check_uuid(site_id, "site_id"):
        return err
    svc = _svc(request)
    f = svc.write_file(
        site_id=site_id,
        path=payload.path,
        content=payload.content,
        content_type=payload.content_type,
    )
    return success_response({
        "id": str(f.id),
        "path": f.path,
        "file_size": f.file_size,
    })


@router.delete("/sites/{site_id}/files/{path:file_path}", auth=jwt_auth)
def delete_file(request, site_id: str, file_path: str):
    if err := _check_uuid(site_id, "site_id"):
        return err
    svc = _svc(request)
    svc.delete_file(site_id, file_path)
    return success_response()
