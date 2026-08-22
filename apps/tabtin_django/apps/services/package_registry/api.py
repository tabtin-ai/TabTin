"""Package Registry API — 7 个核心端点。

所有端点 JWTAuth 强制（由 NinjaAPI 全局 auth 配置保证）。
"""

from __future__ import annotations

import logging
from typing import Any
from uuid import UUID

from django.db import IntegrityError
from django.http import HttpRequest
from ninja import Router, Schema

from apps.i18n.response import (
    error_response_with_status,
    not_found_response,
    success_response,
    validation_error_response,
)
from apps.services.package_registry import services
from apps.services.package_registry.models import Package, PackageVersion

logger = logging.getLogger(__name__)

router = Router()


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class CreatePackageIn(Schema):
    namespace: str
    name: str
    organization_id: str
    metadata: dict[str, Any] | None = None


class FileEntry(Schema):
    path: str
    sha256: str
    size: int = 0
    content_type: str | None = None


class InitVersionIn(Schema):
    files: list[FileEntry]
    manifest: dict[str, Any] = {}
    version_label: str | None = None


class FinalizeVersionIn(Schema):
    bundle_sha256: str


class YankVersionIn(Schema):
    reason: str


class ForkPackageIn(Schema):
    target_namespace: str
    target_name: str
    target_organization_id: str
    fork_at_version_seq: int | None = None


# ---------------------------------------------------------------------------
# Response Schemas
# ---------------------------------------------------------------------------

class ErrorOut(Schema):
    success: bool = False
    code: str
    message: str
    data: Any = None


class CreatePackageData(Schema):
    package_id: str
    namespace: str
    name: str


class CreatePackageOut(Schema):
    success: bool
    code: str
    message: str
    data: CreatePackageData


class LookupPackageData(Schema):
    package_id: str
    namespace: str
    name: str
    latest_version_seq: int | None = None
    created_at: str


class LookupPackageOut(Schema):
    success: bool
    code: str
    message: str
    data: LookupPackageData


class UploadTaskItem(Schema):
    path: str
    sha256: str
    action: str
    presigned_url: str | None = None
    oss_object_key: str | None = None
    file_record_id: str | None = None


class InitVersionData(Schema):
    version_id: str
    upload_tasks: list[UploadTaskItem]


class InitVersionOut(Schema):
    success: bool
    code: str
    message: str
    data: InitVersionData


class SkillUpsertOut(Schema):
    upserted: bool
    skill_id: str | None = None
    skill_key: str | None = None
    reason: str | None = None


class FinalizeVersionData(Schema):
    version_seq: int
    version_label: str | None = None
    bundle_sha256: str
    file_count: int
    total_size: int
    managed_skill: SkillUpsertOut | None = None


class FinalizeVersionOut(Schema):
    success: bool
    code: str
    message: str
    data: FinalizeVersionData


class VersionItem(Schema):
    version_seq: int
    version_label: str | None = None
    bundle_sha256: str | None = None
    is_yanked: bool
    file_count: int
    total_size: int
    created_at: str
    created_by: str


class ListVersionsData(Schema):
    items: list[VersionItem]
    next_cursor: int | None = None


class ListVersionsOut(Schema):
    success: bool
    code: str
    message: str
    data: ListVersionsData


class FileItem(Schema):
    path: str
    sha256: str
    size: int
    download_url: str
    content_type: str | None = None


class GetVersionFilesData(Schema):
    version_seq: int
    version_label: str | None = None
    bundle_sha256: str | None = None
    manifest: dict[str, Any]
    is_yanked: bool
    files: list[FileItem]


class GetVersionFilesOut(Schema):
    success: bool
    code: str
    message: str
    data: GetVersionFilesData


class YankVersionData(Schema):
    yanked_at: str


class YankVersionOut(Schema):
    success: bool
    code: str
    message: str
    data: YankVersionData


class ForkPackageData(Schema):
    new_package_id: str
    copied_versions: int


class ForkPackageOut(Schema):
    success: bool
    code: str
    message: str
    data: ForkPackageData


class RevertVersionData(Schema):
    new_version_seq: int
    new_version_id: str
    target_version_seq: int
    version_label: str | None = None
    synced_skills: int


class RevertVersionOut(Schema):
    success: bool
    code: str
    message: str
    data: RevertVersionData


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.post("/packages", response={200: CreatePackageOut, 400: ErrorOut, 403: ErrorOut, 409: ErrorOut})
def create_package(request: HttpRequest, body: CreatePackageIn):
    user = request.auth
    try:
        pkg = services.create_package(
            namespace=body.namespace,
            name=body.name,
            organization_id=body.organization_id,
            created_by=str(user.id),
            metadata=body.metadata,
        )
    except PermissionError as exc:
        return error_response_with_status(
            code="PERMISSION_DENIED", message=str(exc), status_code=403,
        )
    except ValueError as exc:
        return validation_error_response(str(exc))
    except IntegrityError:
        return error_response_with_status(
            code="PACKAGE_ALREADY_EXISTS",
            message=f"Package {body.namespace}/{body.name} already exists",
            status_code=409,
        )

    return success_response({
        "package_id": str(pkg.id),
        "namespace": pkg.namespace,
        "name": pkg.name,
    })


class ContentTypesData(Schema):
    map: dict[str, str]
    default: str


class ContentTypesOut(Schema):
    success: bool
    code: str
    message: str
    data: ContentTypesData


@router.get("/utils/content-types", response={200: ContentTypesOut}, auth=None)
def content_types_endpoint(request: HttpRequest):
    """W4-修3 SSoT:返回 ``utils.CONTENT_TYPE_MAP`` 字典 + default 兜底。

    Go CLI 启动时 lazy fetch 一次缓存(失败 fallback 到内置),
    避免两端各自抄写 mime 映射造成漂移。
    无认证(纯静态字典,无敏感数据)。
    """
    from apps.services.package_registry.utils import (
        CONTENT_TYPE_DEFAULT, CONTENT_TYPE_MAP,
    )
    return success_response({
        "map": dict(CONTENT_TYPE_MAP),
        "default": CONTENT_TYPE_DEFAULT,
    })


@router.get("/packages/lookup", response={200: LookupPackageOut, 404: ErrorOut})
def lookup_package(request: HttpRequest, namespace: str, name: str):
    try:
        pkg = services.lookup_package(namespace=namespace, name=name)
    except LookupError:
        return not_found_response(f"Package {namespace}/{name} not found")

    # 注意:lookup 端点为防跨团队信息泄露,**不**返回 organization_id。
    # service 层 lookup_package 仍返回完整 ORM 对象给后端内部使用,
    # 但 HTTP 响应严格只暴露 namespace/name/version 元信息。
    return success_response({
        "package_id": str(pkg.id),
        "namespace": pkg.namespace,
        "name": pkg.name,
        "latest_version_seq": pkg.latest_version_seq,
        "created_at": pkg.created_at.isoformat(),
    })


@router.post("/packages/{package_id}/versions/init", response={200: InitVersionOut, 400: ErrorOut, 403: ErrorOut, 404: ErrorOut})
def init_version(request: HttpRequest, package_id: UUID, body: InitVersionIn):
    user = request.auth
    package = Package.objects.filter(id=package_id).first()
    if not package:
        return not_found_response("Package not found")

    if not body.files:
        return validation_error_response("files list cannot be empty")

    try:
        result = services.init_version(
            package=package,
            files=[f.dict() for f in body.files],
            manifest=body.manifest,
            version_label=body.version_label,
            user_id=str(user.id),
        )
    except PermissionError as exc:
        return error_response_with_status(
            code="PERMISSION_DENIED", message=str(exc), status_code=403,
        )
    return success_response(result)


@router.post("/packages/{package_id}/versions/{version_id}/finalize", response={200: FinalizeVersionOut, 403: ErrorOut, 404: ErrorOut, 409: ErrorOut})
def finalize_version(
    request: HttpRequest,
    package_id: UUID,
    version_id: UUID,
    body: FinalizeVersionIn,
):
    user = request.auth
    package = Package.objects.filter(id=package_id).first()
    if not package:
        return not_found_response("Package not found")

    version = PackageVersion.objects.filter(
        id=version_id,
        package=package,
        status=PackageVersion.Status.UPLOADING,
    ).first()
    if not version:
        return not_found_response("VERSION_NOT_FOUND")

    # A3: 优先读独立字段 init_files。
    # manifest._init_files 兜底是**蓝绿部署窗口期保护**:0003 migration 已把 DB
    # 中所有 manifest._init_files 迁走,但应用进程版本可能滞后于 DB schema。
    # 蓝绿期间老进程仍按老代码写 manifest._init_files、不写 init_files 字段;
    # 新进程 finalize 必须读 manifest 兜底才能拿到老进程刚写入的数据。
    # TODO(W1+1): 确认所有 PR 服务进程都重启完成后,删除此 fallback。
    # 下线扳机:`git log --since="X+2 weeks" -- services/package_registry/`,
    # 确认无 0003-pre 老进程残留。
    init_files_data = (
        list(version.init_files)
        if version.init_files
        else version.manifest.get("_init_files")
    )
    if not init_files_data:
        return error_response_with_status(
            code="FILES_NOT_ALL_UPLOADED",
            message="No files info found for this version",
            status_code=409,
        )

    try:
        result = services.finalize_version(
            package=package,
            version=version,
            bundle_sha256=body.bundle_sha256,
            init_files=init_files_data,
            user_id=str(user.id),
        )
    except PermissionError as exc:
        return error_response_with_status(
            code="PERMISSION_DENIED", message=str(exc), status_code=403,
        )
    except ValueError as exc:
        return error_response_with_status(
            code="FINALIZE_FAILED", message=str(exc), status_code=409,
        )

    return success_response(result)


@router.get("/packages/{package_id}/versions", response={200: ListVersionsOut, 404: ErrorOut})
def list_versions(
    request: HttpRequest,
    package_id: UUID,
    limit: int = 50,
    cursor: int | None = None,
):
    package = Package.objects.filter(id=package_id).first()
    if not package:
        return not_found_response("Package not found")

    result = services.list_versions(package=package, limit=limit, cursor=cursor)
    return success_response(result)


@router.get("/packages/{package_id}/versions/{seq}/files", response={200: GetVersionFilesOut, 404: ErrorOut, 410: ErrorOut})
def get_version_files(
    request: HttpRequest,
    package_id: UUID,
    seq: int,
    include_yanked: int = 0,
):
    package = Package.objects.filter(id=package_id).first()
    if not package:
        return not_found_response("Package not found")

    try:
        result = services.get_version_files(
            package=package,
            version_seq=seq,
            include_yanked=bool(include_yanked),
        )
    except LookupError:
        return not_found_response("VERSION_NOT_FOUND")
    except PermissionError:
        return error_response_with_status(
            code="VERSION_YANKED",
            message="This version has been yanked",
            status_code=410,
        )

    return success_response(result)


@router.post("/packages/{package_id}/versions/{seq}/yank", response={200: YankVersionOut, 403: ErrorOut, 404: ErrorOut})
def yank_version(request: HttpRequest, package_id: UUID, seq: int, body: YankVersionIn):
    user = request.auth
    package = Package.objects.filter(id=package_id).first()
    if not package:
        return not_found_response("Package not found")

    try:
        result = services.yank_version(
            package=package,
            version_seq=seq,
            reason=body.reason,
            user_id=str(user.id),
        )
    except PermissionError as exc:
        return error_response_with_status(
            code="PERMISSION_DENIED", message=str(exc), status_code=403,
        )
    except LookupError:
        return not_found_response("VERSION_NOT_FOUND")

    return success_response(result)


@router.post("/packages/{package_id}/versions/{seq}/revert", response={200: RevertVersionOut, 400: ErrorOut, 403: ErrorOut, 404: ErrorOut, 409: ErrorOut, 410: ErrorOut})
def revert_version(request: HttpRequest, package_id: UUID, seq: int):
    """把 Package 回滚到指定 ``seq``(创建一个新版本,内容来自 target)。

    与 git revert 语义一致:**新建版本指向旧内容**,不删除任何东西。
    Skills 端 ``Skill.latest_version_seq`` 自动同步（Wave 1 起，PRD V3.3）。
    """
    user = request.auth
    package = Package.objects.filter(id=package_id).first()
    if not package:
        return not_found_response("Package not found")

    try:
        result = services.revert_to_version(
            package=package,
            target_version_seq=seq,
            user_id=str(user.id),
        )
    except PermissionError as exc:
        msg = str(exc)
        if "VERSION_YANKED" in msg or msg == "VERSION_YANKED":
            return error_response_with_status(
                code="VERSION_YANKED",
                message="Target version has been yanked",
                status_code=410,
            )
        return error_response_with_status(
            code="PERMISSION_DENIED", message=msg, status_code=403,
        )
    except LookupError:
        return not_found_response("VERSION_NOT_FOUND")
    except ValueError as exc:
        return error_response_with_status(
            code="REVERT_FAILED", message=str(exc), status_code=409,
        )

    return success_response(result)


@router.post("/packages/{package_id}/fork", response={200: ForkPackageOut, 400: ErrorOut, 403: ErrorOut, 404: ErrorOut, 409: ErrorOut})
def fork_package(request: HttpRequest, package_id: UUID, body: ForkPackageIn):
    user = request.auth
    source = Package.objects.filter(id=package_id).first()
    if not source:
        return not_found_response("Package not found")

    try:
        result = services.fork_package(
            source_package=source,
            target_namespace=body.target_namespace,
            target_name=body.target_name,
            target_organization_id=body.target_organization_id,
            fork_at_version_seq=body.fork_at_version_seq,
            user_id=str(user.id),
        )
    except PermissionError as exc:
        return error_response_with_status(
            code="PERMISSION_DENIED", message=str(exc), status_code=403,
        )
    except ValueError as exc:
        return validation_error_response(str(exc))
    except IntegrityError:
        return error_response_with_status(
            code="PACKAGE_ALREADY_EXISTS",
            message=f"Package {body.target_namespace}/{body.target_name} already exists",
            status_code=409,
        )

    return success_response(result)
