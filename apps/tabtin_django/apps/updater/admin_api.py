"""
Updater Admin API

- 读接口：仅后台 staff 用户可访问
- 写接口：仅后台 superuser 可执行
"""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Optional

from django.db.models import Count, Q
from django.utils import timezone
from ninja import Router, Schema
from ninja.errors import HttpError
from pydantic import Field

from apps.i18n import _
from apps.users.auth.permissions import StaffAuth, SuperuserAuth

from .models import AppRelease, UpdateLog
from .services.asset_service import (
    ReleaseAssetUploadIntent,
    ReleaseManifestPreviewResult,
    ReleaseAssetUploadResult,
    ReleaseAssetService,
)
from .services.push_service import UpdatePushService
from .services.query_service import UpdateQueryService
from .services.readiness_service import ReleaseReadinessResult, ReleaseReadinessService

router = Router(auth=StaffAuth())
logger = logging.getLogger(__name__)

def _resolve_release_status(release: AppRelease) -> str:
    if release.is_deprecated:
        return "deprecated"
    if release.is_draft or not release.published_at:
        return "draft"
    return "published"

def _resolve_user_name(user) -> str:
    if not user:
        return ""
    if hasattr(user, "get_display_name"):
        display_name = user.get_display_name()
        if display_name:
            return display_name
    return getattr(user, "nickname", "") or getattr(user, "username", "") or getattr(user, "email", "") or ""

def _release_log_queryset(release: AppRelease):
    return UpdateLog.objects.filter(
        to_version=release.version,
        platform=release.platform,
        arch=release.arch,
        channel=release.channel,
    )

def _get_release_push_records(release: AppRelease):
    prefetched_records = getattr(release, "_prefetched_objects_cache", {}).get("push_records")
    if prefetched_records is not None:
        return list(prefetched_records)
    return list(release.push_records.all())

def _raise_service_error(exc: Exception) -> None:
    if isinstance(exc, ValueError):
        raise HttpError(400, str(exc)) from exc
    raise exc

def _build_release_metrics(release: AppRelease) -> dict:
    logs = _release_log_queryset(release)
    total_attempts = logs.count()
    installed_count = logs.filter(status="installed").count()
    failed_count = logs.filter(status="failed").count()
    downloading_count = logs.filter(status="downloading").count()
    downloaded_count = logs.filter(status="downloaded").count()
    available_count = logs.filter(status="available").count()
    recent_24h = logs.filter(started_at__gte=timezone.now() - timedelta(hours=24)).count()

    return {
        "total_attempts": total_attempts,
        "installed_count": installed_count,
        "failed_count": failed_count,
        "downloading_count": downloading_count,
        "downloaded_count": downloaded_count,
        "available_count": available_count,
        "recent_24h_attempts": recent_24h,
        "success_rate": round((installed_count / total_attempts) * 100, 2) if total_attempts else 0,
    }

class AdminUpdateMatrixReleaseSchema(Schema):
    release_id: int
    version: str
    platform: str
    arch: str
    channel: str
    published_at: Optional[str] = None
    rollout_percentage: int
    priority: str
    mandatory: bool

class AdminUpdateOverviewSchema(Schema):
    total_releases: int
    draft_releases: int
    published_releases: int
    deprecated_releases: int
    recent_24h_attempts: int
    recent_24h_installs: int
    recent_24h_failures: int
    latest_matrix: dict[str, dict[str, AdminUpdateMatrixReleaseSchema]]

class AdminUpdateReleaseListItemSchema(Schema):
    id: int
    version: str
    platform: str
    arch: str
    channel: str
    status: str
    file_url: str
    website_file_url: str = ""
    feed_url: str = ""
    file_size: int
    checksum_sha256: str
    checksum_sha512: str = ""
    is_mandatory: bool
    min_compatible_version: str
    priority: str
    rollout_percentage: int
    rollout_target_users: list[str]
    release_notes: str
    release_notes_en: str
    created_by_id: Optional[str] = None
    created_by_name: str = ""
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    published_at: Optional[str] = None
    deprecated_at: Optional[str] = None
    push_count: int = 0
    sent_push_count: int = 0
    last_push_at: Optional[str] = None
    effective_feed_url: str
    feed_url_derived: bool
    manifest_file: str
    manifest_url: str
    asset_name: str
    website_asset_name: str = ""
    download_file_url: str = ""
    source_warnings: list[str] = Field(default_factory=list)

class AdminUpdatePaginationSchema(Schema):
    page: int
    page_size: int
    total: int
    total_pages: int

class AdminUpdateReleaseListResponseSchema(Schema):
    items: list[AdminUpdateReleaseListItemSchema]
    pagination: AdminUpdatePaginationSchema

class AdminUpdatePushRecordSchema(Schema):
    id: int
    status: str
    rollout_percentage: int
    silent: bool
    pushed_at: Optional[str] = None
    pushed_by_id: Optional[str] = None
    pushed_by_name: str = ""
    error_message: str = ""
    target_group: str
    notes: str = ""

class AdminUpdateLogSchema(Schema):
    id: int
    device_id: str
    user_id: str
    organization_id: str
    from_version: str
    to_version: str
    trigger_source: str
    status: str
    progress: float
    success: Optional[bool] = None
    error_code: str = ""
    error_message: str = ""
    started_at: Optional[str] = None
    completed_at: Optional[str] = None

class AdminUpdateReleaseMetricsSchema(Schema):
    total_attempts: int
    installed_count: int
    failed_count: int
    downloading_count: int
    downloaded_count: int
    available_count: int
    recent_24h_attempts: int
    success_rate: float

class AdminUpdateReadinessIssueSchema(Schema):
    code: str
    severity: str
    message: str
    expected: str = ""
    actual: str = ""

class AdminUpdateReadinessAssetSchema(Schema):
    raw_url: str = ""
    resolved_url: str = ""
    sha512: str = ""
    size: Optional[int] = None
    http_status: Optional[int] = None

class AdminUpdateReleaseReadinessSchema(Schema):
    status: str
    checked_at: Optional[str] = None
    manifest_url: str
    manifest_file: str
    manifest_http_status: Optional[int] = None
    manifest_version: str = ""
    manifest_release_date: str = ""
    staging_percentage: Optional[int] = None
    blocking_issue_count: int
    warning_issue_count: int
    info_issue_count: int
    asset: AdminUpdateReadinessAssetSchema
    issues: list[AdminUpdateReadinessIssueSchema]

class AdminUpdateManifestPreviewSchema(Schema):
    can_generate: bool
    manifest_file: str
    manifest_url: str
    content: str = ""
    issues: list[str] = Field(default_factory=list)

class AdminUpdateReleaseAssetUploadIntentRequestSchema(Schema):
    asset_type: str
    file_name: str = ""
    file_size: int = Field(..., ge=1)
    content_type: str = ""

class AdminUpdateReleaseAssetUploadIntentSchema(Schema):
    asset_type: str
    file_name: str
    expected_file_name: str
    object_key: str
    presigned_url: str
    access_url: str
    cdn_url: str = ""
    public_url: str
    content_type: str
    expires_in: int

class AdminUpdateReleaseAssetCompleteSchema(Schema):
    asset_type: str
    object_key: str
    file_name: str = ""
    file_size: int = Field(..., ge=1)
    content_type: str = ""
    checksum_sha256: str = ""
    checksum_sha512: str = ""
    auto_generate_manifest: bool = False

class AdminUpdateReleaseAssetSchema(Schema):
    asset_type: str
    file_record_id: str
    file_name: str
    object_key: str
    public_url: str
    access_url: str
    cdn_url: str = ""
    file_size: int
    checksum_sha256: str = ""
    checksum_sha512: str = ""
    manifest_generated: bool
    manifest_url: str = ""
    manifest_file: str = ""
    manifest_generation_error: str = ""

class AdminUpdateReleaseDetailSchema(Schema):
    release: AdminUpdateReleaseListItemSchema
    metrics: AdminUpdateReleaseMetricsSchema
    push_records: list[AdminUpdatePushRecordSchema]
    recent_logs: list[AdminUpdateLogSchema]
    active_version_distribution: list[dict]

class AdminUpdateReleaseCreateSchema(Schema):
    version: str = Field(..., description="语义化版本号")
    platform: str = Field(..., description="平台：mac/win/linux")
    arch: str = Field(default="x64", description="架构：x64/arm64")
    channel: str = Field(default="stable", description="渠道：stable/beta/alpha")
    file_url: str = ""
    website_file_url: str = ""
    feed_url: str = ""
    file_size: int = Field(default=0, ge=0)
    checksum_sha256: str = ""
    checksum_sha512: str = ""
    is_mandatory: bool = False
    min_compatible_version: str = ""
    priority: str = "normal"
    rollout_percentage: int = Field(default=0, ge=0, le=100)
    rollout_target_users: list[str] = Field(default_factory=list)
    release_notes: str
    release_notes_en: str = ""

class AdminUpdateReleaseUpdateSchema(Schema):
    file_url: Optional[str] = None
    website_file_url: Optional[str] = None
    feed_url: Optional[str] = None
    file_size: Optional[int] = Field(default=None, ge=0)
    checksum_sha256: Optional[str] = None
    checksum_sha512: Optional[str] = None
    is_mandatory: Optional[bool] = None
    min_compatible_version: Optional[str] = None
    priority: Optional[str] = None
    rollout_percentage: Optional[int] = Field(default=None, ge=0, le=100)
    rollout_target_users: Optional[list[str]] = None
    release_notes: Optional[str] = None
    release_notes_en: Optional[str] = None

class AdminUpdatePushActionSchema(Schema):
    rollout_percentage: Optional[int] = Field(default=None, ge=0, le=100)
    silent: bool = False

class AdminUpdateRolloutSchema(Schema):
    rollout_percentage: int = Field(..., ge=0, le=100)

class AdminUpdateActionResponseSchema(Schema):
    success: bool
    message: str
    release: AdminUpdateReleaseListItemSchema

class AdminUpdateAssetActionResponseSchema(Schema):
    success: bool
    message: str
    release: AdminUpdateReleaseListItemSchema
    asset: AdminUpdateReleaseAssetSchema

class AdminDesktopGoLiveSchema(Schema):
    platform: str
    channel: str = "stable"
    release_ids: list[int] = Field(default_factory=list)
    dry_run: bool = True
    cdn_refresh: bool = True
    cdn_warmup: bool = True
    publish: bool = True
    short_link: bool = True
    probe_short_links: bool = True
    public_api_base: str = ""

def _serialize_release(release: AppRelease) -> AdminUpdateReleaseListItemSchema:
    push_records = _get_release_push_records(release)
    last_push = push_records[0] if push_records else None
    effective_feed_url = release.get_effective_feed_url()

    return AdminUpdateReleaseListItemSchema(
        id=release.id,
        version=release.version,
        platform=release.platform,
        arch=release.arch,
        channel=release.channel,
        status=_resolve_release_status(release),
        file_url=release.file_url,
        website_file_url=release.website_file_url or "",
        feed_url=release.feed_url or "",
        file_size=release.file_size,
        checksum_sha256=release.checksum_sha256,
        checksum_sha512=release.checksum_sha512 or "",
        is_mandatory=release.is_mandatory,
        min_compatible_version=release.min_compatible_version or "",
        priority=release.priority,
        rollout_percentage=release.rollout_percentage,
        rollout_target_users=[str(item) for item in (release.rollout_target_users or [])],
        release_notes=release.release_notes,
        release_notes_en=release.release_notes_en or "",
        created_by_id=str(release.created_by_id) if release.created_by_id else None,
        created_by_name=_resolve_user_name(release.created_by),
        created_at=release.created_at.isoformat() if release.created_at else None,
        updated_at=release.updated_at.isoformat() if release.updated_at else None,
        published_at=release.published_at.isoformat() if release.published_at else None,
        deprecated_at=release.deprecated_at.isoformat() if release.deprecated_at else None,
        push_count=len(push_records),
        sent_push_count=sum(1 for item in push_records if item.status == "sent"),
        last_push_at=last_push.pushed_at.isoformat() if last_push and last_push.pushed_at else None,
        effective_feed_url=effective_feed_url,
        feed_url_derived=release.is_feed_url_derived(),
        manifest_file=release.get_manifest_file(),
        manifest_url=release.get_manifest_url(),
        asset_name=release.get_asset_name(),
        website_asset_name=release.get_website_asset_name(),
        download_file_url=release.get_download_file_url(),
        source_warnings=release.get_source_warnings(),
    )

def _serialize_asset_upload_intent(
    intent: ReleaseAssetUploadIntent,
) -> AdminUpdateReleaseAssetUploadIntentSchema:
    return AdminUpdateReleaseAssetUploadIntentSchema(
        asset_type=intent.asset_type,
        file_name=intent.file_name,
        expected_file_name=intent.expected_file_name,
        object_key=intent.object_key,
        presigned_url=intent.presigned_url,
        access_url=intent.access_url,
        cdn_url=intent.cdn_url,
        public_url=intent.public_url,
        content_type=intent.content_type,
        expires_in=intent.expires_in,
    )

def _serialize_asset_result(result: ReleaseAssetUploadResult) -> AdminUpdateReleaseAssetSchema:
    return AdminUpdateReleaseAssetSchema(
        asset_type=result.asset_type,
        file_record_id=result.file_record_id,
        file_name=result.file_name,
        object_key=result.object_key,
        public_url=result.public_url,
        access_url=result.access_url,
        cdn_url=result.cdn_url,
        file_size=result.file_size,
        checksum_sha256=result.checksum_sha256,
        checksum_sha512=result.checksum_sha512,
        manifest_generated=result.manifest_generated,
        manifest_url=result.manifest_url,
        manifest_file=result.manifest_file,
        manifest_generation_error=result.manifest_generation_error,
    )

def _serialize_manifest_preview(
    result: ReleaseManifestPreviewResult,
) -> AdminUpdateManifestPreviewSchema:
    return AdminUpdateManifestPreviewSchema(
        can_generate=result.can_generate,
        manifest_file=result.manifest_file,
        manifest_url=result.manifest_url,
        content=result.content,
        issues=result.issues or [],
    )

def _get_release_or_404(release_id: int) -> AppRelease:
    try:
        return AppRelease.objects.select_related("created_by").get(id=release_id)
    except AppRelease.DoesNotExist as exc:
        raise HttpError(404, _("updater.version_not_found")) from exc

def _serialize_readiness(result: ReleaseReadinessResult) -> AdminUpdateReleaseReadinessSchema:
    return AdminUpdateReleaseReadinessSchema(
        status=result.status,
        checked_at=result.checked_at.isoformat() if result.checked_at else None,
        manifest_url=result.manifest_url,
        manifest_file=result.manifest_file,
        manifest_http_status=result.manifest_http_status,
        manifest_version=result.manifest_version,
        manifest_release_date=result.manifest_release_date,
        staging_percentage=result.staging_percentage,
        blocking_issue_count=result.blocking_issue_count,
        warning_issue_count=result.warning_issue_count,
        info_issue_count=result.info_issue_count,
        asset=AdminUpdateReadinessAssetSchema(
            raw_url=result.asset.raw_url,
            resolved_url=result.asset.resolved_url,
            sha512=result.asset.sha512,
            size=result.asset.size,
            http_status=result.asset.http_status,
        ),
        issues=[
            AdminUpdateReadinessIssueSchema(
                code=issue.code,
                severity=issue.severity,
                message=issue.message,
                expected=issue.expected,
                actual=issue.actual,
            )
            for issue in result.issues
        ],
    )

def _ensure_release_ready_for_delivery(release: AppRelease, action_label: str) -> ReleaseReadinessResult:
    result = ReleaseReadinessService().check_release(release)
    if result.blocking_issue_count > 0:
        details = "；".join(result.blocking_messages[:2])
        raise HttpError(400, f"{action_label}前发布就绪检查未通过：{details}")
    return result

@router.get("/desktop-updates/overview", auth=StaffAuth(), response=AdminUpdateOverviewSchema)
def get_overview(request):

    latest_matrix: dict[str, dict[str, AdminUpdateMatrixReleaseSchema]] = {}
    query_service = UpdateQueryService()

    for channel in ("stable", "beta", "alpha"):
        channel_matrix: dict[str, AdminUpdateMatrixReleaseSchema] = {}
        for platform in ("mac", "win", "linux"):
            for arch in ("x64", "arm64"):
                release = query_service.get_latest_release(platform=platform, arch=arch, channel=channel)
                if not release:
                    continue
                channel_matrix[f"{platform}_{arch}"] = AdminUpdateMatrixReleaseSchema(
                    release_id=release.id,
                    version=release.version,
                    platform=release.platform,
                    arch=release.arch,
                    channel=release.channel,
                    published_at=release.published_at.isoformat() if release.published_at else None,
                    rollout_percentage=release.rollout_percentage,
                    priority=release.priority,
                    mandatory=release.is_mandatory,
                )
        latest_matrix[channel] = channel_matrix

    day_ago = timezone.now() - timedelta(hours=24)
    recent_logs = UpdateLog.objects.filter(started_at__gte=day_ago)

    return AdminUpdateOverviewSchema(
        total_releases=AppRelease.objects.count(),
        draft_releases=AppRelease.objects.filter(is_draft=True).count(),
        published_releases=AppRelease.objects.filter(
            is_draft=False,
            published_at__isnull=False,
            deprecated_at__isnull=True,
        ).count(),
        deprecated_releases=AppRelease.objects.filter(deprecated_at__isnull=False).count(),
        recent_24h_attempts=recent_logs.count(),
        recent_24h_installs=recent_logs.filter(status="installed").count(),
        recent_24h_failures=recent_logs.filter(status="failed").count(),
        latest_matrix=latest_matrix,
    )

@router.get("/desktop-updates/releases", auth=StaffAuth(), response=AdminUpdateReleaseListResponseSchema)
def list_releases(
    request,
    keyword: str = "",
    channel: str = "",
    platform: str = "",
    arch: str = "",
    status: str = "",
    page: int = 1,
    page_size: int = 20,
):

    queryset = AppRelease.objects.select_related("created_by").prefetch_related("push_records").all()

    if keyword:
        queryset = queryset.filter(
            Q(version__icontains=keyword)
            | Q(release_notes__icontains=keyword)
            | Q(file_url__icontains=keyword)
        )
    if channel:
        queryset = queryset.filter(channel=channel)
    if platform:
        queryset = queryset.filter(platform=platform)
    if arch:
        queryset = queryset.filter(arch=arch)
    if status == "draft":
        queryset = queryset.filter(is_draft=True)
    elif status == "published":
        queryset = queryset.filter(is_draft=False, deprecated_at__isnull=True)
    elif status == "deprecated":
        queryset = queryset.filter(deprecated_at__isnull=False)

    queryset = queryset.order_by("-published_at", "-created_at")

    safe_page = max(page, 1)
    safe_page_size = min(max(page_size, 1), 100)
    total = queryset.count()
    total_pages = max((total + safe_page_size - 1) // safe_page_size, 1)
    safe_page = min(safe_page, total_pages)
    start = (safe_page - 1) * safe_page_size
    end = start + safe_page_size

    items = [_serialize_release(item) for item in queryset[start:end]]

    return AdminUpdateReleaseListResponseSchema(
        items=items,
        pagination=AdminUpdatePaginationSchema(
            page=safe_page,
            page_size=safe_page_size,
            total=total,
            total_pages=total_pages,
        ),
    )

@router.get("/desktop-updates/releases/{release_id}", auth=StaffAuth(), response=AdminUpdateReleaseDetailSchema)
def get_release_detail(request, release_id: int):

    release = _get_release_or_404(release_id)
    metrics = _build_release_metrics(release)
    logs = _release_log_queryset(release).order_by("-started_at")[:20]
    push_records = release.push_records.select_related("pushed_by").order_by("-pushed_at")[:20]

    distribution = (
        UpdateLog.objects.filter(
            channel=release.channel,
            platform=release.platform,
            arch=release.arch,
            started_at__gte=timezone.now() - timedelta(days=7),
        )
        .values("from_version")
        .annotate(count=Count("id"))
        .order_by("-count")[:20]
    )

    return AdminUpdateReleaseDetailSchema(
        release=_serialize_release(release),
        metrics=AdminUpdateReleaseMetricsSchema(**metrics),
        push_records=[
            AdminUpdatePushRecordSchema(
                id=item.id,
                status=item.status,
                rollout_percentage=item.rollout_percentage,
                silent=item.silent,
                pushed_at=item.pushed_at.isoformat() if item.pushed_at else None,
                pushed_by_id=str(item.pushed_by_id) if item.pushed_by_id else None,
                pushed_by_name=_resolve_user_name(item.pushed_by),
                error_message=item.error_message or "",
                target_group=item.target_group,
                notes=item.notes or "",
            )
            for item in push_records
        ],
        recent_logs=[
            AdminUpdateLogSchema(
                id=item.id,
                device_id=item.device_id,
                user_id=item.user_id,
                organization_id=item.organization_id,
                from_version=item.from_version,
                to_version=item.to_version,
                trigger_source=item.trigger_source,
                status=item.status,
                progress=item.progress,
                success=item.success,
                error_code=item.error_code or "",
                error_message=item.error_message or "",
                started_at=item.started_at.isoformat() if item.started_at else None,
                completed_at=item.completed_at.isoformat() if item.completed_at else None,
            )
            for item in logs
        ],
        active_version_distribution=list(distribution),
    )

@router.post(
    "/desktop-updates/releases/{release_id}/readiness-check",
    auth=StaffAuth(),
    response=AdminUpdateReleaseReadinessSchema,
)
def check_release_readiness(request, release_id: int):

    release = _get_release_or_404(release_id)
    result = ReleaseReadinessService().check_release(release)
    return _serialize_readiness(result)

@router.get(
    "/desktop-updates/releases/{release_id}/manifest-preview",
    auth=StaffAuth(),
    response=AdminUpdateManifestPreviewSchema,
)
def preview_release_manifest(request, release_id: int):

    release = _get_release_or_404(release_id)
    result = ReleaseAssetService().preview_manifest(release)
    return _serialize_manifest_preview(result)

@router.post(
    "/desktop-updates/releases/{release_id}/asset-upload-intent",
    auth=SuperuserAuth(),
    response=AdminUpdateReleaseAssetUploadIntentSchema,
)
def create_release_asset_upload_intent(
    request,
    release_id: int,
    payload: AdminUpdateReleaseAssetUploadIntentRequestSchema,
):

    release = _get_release_or_404(release_id)
    try:
        intent = ReleaseAssetService().create_upload_intent(
            release,
            asset_type=payload.asset_type,
            file_name=payload.file_name,
            file_size=payload.file_size,
            content_type=payload.content_type,
        )
    except Exception as exc:
        _raise_service_error(exc)
    return _serialize_asset_upload_intent(intent)

@router.post(
    "/desktop-updates/releases/{release_id}/asset-upload-complete",
    auth=SuperuserAuth(),
    response=AdminUpdateAssetActionResponseSchema,
)
def complete_release_asset_upload(
    request,
    release_id: int,
    payload: AdminUpdateReleaseAssetCompleteSchema,
):

    release = _get_release_or_404(release_id)
    try:
        result = ReleaseAssetService().complete_upload(
            release,
            asset_type=payload.asset_type,
            object_key=payload.object_key,
            file_name=payload.file_name,
            file_size=payload.file_size,
            content_type=payload.content_type,
            checksum_sha256=payload.checksum_sha256,
            checksum_sha512=payload.checksum_sha512,
            user_id=getattr(request.auth, "id", None),
            upload_ip=request.META.get("REMOTE_ADDR", ""),
            auto_generate_manifest=payload.auto_generate_manifest,
        )
    except Exception as exc:
        _raise_service_error(exc)

    release.refresh_from_db()
    message = "更新资产已接入当前版本。"
    if result.manifest_generated:
        message = "安装包已上传，Manifest 已自动生成。"
    elif result.manifest_generation_error:
        message = f"安装包已上传，但 Manifest 自动生成失败：{result.manifest_generation_error}"
    elif result.asset_type == "website_installer":
        message = "官网安装包已上传并回填官网下载地址。"
    elif result.asset_type == "manifest":
        message = "自定义 Manifest 已上传并覆盖当前更新源。"

    return AdminUpdateAssetActionResponseSchema(
        success=True,
        message=message,
        release=_serialize_release(release),
        asset=_serialize_asset_result(result),
    )

@router.post(
    "/desktop-updates/releases/{release_id}/manifest-generate",
    auth=SuperuserAuth(),
    response=AdminUpdateAssetActionResponseSchema,
)
def generate_release_manifest(request, release_id: int):

    release = _get_release_or_404(release_id)
    try:
        result = ReleaseAssetService().generate_manifest(
            release,
            user_id=getattr(request.auth, "id", None),
            upload_ip=request.META.get("REMOTE_ADDR", ""),
        )
    except Exception as exc:
        _raise_service_error(exc)

    release.refresh_from_db()
    return AdminUpdateAssetActionResponseSchema(
        success=True,
        message="Manifest 已生成并回填到当前版本。",
        release=_serialize_release(release),
        asset=_serialize_asset_result(result),
    )

@router.post("/desktop-updates/releases", auth=SuperuserAuth(), response=AdminUpdateActionResponseSchema)
def create_release(request, payload: AdminUpdateReleaseCreateSchema):

    if AppRelease.objects.filter(
        version=payload.version,
        platform=payload.platform,
        arch=payload.arch,
        channel=payload.channel,
    ).exists():
        raise HttpError(400, _("updater.version_already_exists"))

    release = AppRelease.objects.create(
        version=payload.version,
        platform=payload.platform,
        arch=payload.arch,
        channel=payload.channel,
        file_url=payload.file_url,
        website_file_url=payload.website_file_url or "",
        feed_url=payload.feed_url or "",
        file_size=payload.file_size,
        checksum_sha256=payload.checksum_sha256,
        checksum_sha512=payload.checksum_sha512 or "",
        is_mandatory=payload.is_mandatory,
        min_compatible_version=payload.min_compatible_version or "",
        priority=payload.priority,
        rollout_percentage=payload.rollout_percentage,
        rollout_target_users=[str(item).strip() for item in payload.rollout_target_users if str(item).strip()],
        release_notes=payload.release_notes,
        release_notes_en=payload.release_notes_en or "",
        created_by=request.auth,
    )
    logger.info("[UpdaterAdmin] 创建桌面版本 %s (%s/%s/%s)", release.version, release.platform, release.arch, release.channel)

    return AdminUpdateActionResponseSchema(
        success=True,
        message=_("updater.version_created", version=release.version),
        release=_serialize_release(release),
    )

@router.put("/desktop-updates/releases/{release_id}", auth=SuperuserAuth(), response=AdminUpdateActionResponseSchema)
def update_release(request, release_id: int, payload: AdminUpdateReleaseUpdateSchema):

    release = _get_release_or_404(release_id)
    update_fields: list[str] = []

    for field_name in (
        "file_url",
        "website_file_url",
        "feed_url",
        "file_size",
        "checksum_sha256",
        "checksum_sha512",
        "is_mandatory",
        "min_compatible_version",
        "priority",
        "rollout_percentage",
        "release_notes",
        "release_notes_en",
    ):
        value = getattr(payload, field_name, None)
        if value is not None:
            setattr(release, field_name, value)
            update_fields.append(field_name)

    if payload.rollout_target_users is not None:
        release.rollout_target_users = [str(item).strip() for item in payload.rollout_target_users if str(item).strip()]
        update_fields.append("rollout_target_users")

    if update_fields:
        update_fields.append("updated_at")
        release.save(update_fields=update_fields)
        logger.info("[UpdaterAdmin] 更新桌面版本 %s fields=%s", release.version, update_fields)

    return AdminUpdateActionResponseSchema(
        success=True,
        message=_("updater.version_updated", version=release.version),
        release=_serialize_release(release),
    )

@router.post("/desktop-updates/releases/{release_id}/publish", auth=SuperuserAuth(), response=AdminUpdateActionResponseSchema)
def publish_release(request, release_id: int):

    release = _get_release_or_404(release_id)
    if not release.is_draft:
        raise HttpError(400, _("updater.version_already_published"))

    _ensure_release_ready_for_delivery(release, "发布")
    release.publish()
    logger.info("[UpdaterAdmin] 发布桌面版本 %s", release.version)
    return AdminUpdateActionResponseSchema(
        success=True,
        message=_("updater.version_published", version=release.version),
        release=_serialize_release(release),
    )


@router.post("/desktop-updates/go-live", auth=SuperuserAuth())
def desktop_go_live(request, payload: AdminDesktopGoLiveSchema):
    """
    按平台执行：CDN 刷新/预热 →（可选）发布 → 短链同步 → /dl 探测。
    默认 dry_run=true，仅预览；确认执行时传 dry_run=false。
    """
    from .services.go_live_service import DesktopGoLiveService

    try:
        result = DesktopGoLiveService().plan_or_execute(
            platform=payload.platform,
            channel=payload.channel,
            release_ids=list(payload.release_ids or []),
            dry_run=bool(payload.dry_run),
            do_cdn_refresh=bool(payload.cdn_refresh),
            do_cdn_warmup=bool(payload.cdn_warmup),
            do_publish=bool(payload.publish),
            do_short_link=bool(payload.short_link),
            do_probe=bool(payload.probe_short_links),
            public_api_base=payload.public_api_base or "",
        )
    except ValueError as exc:
        raise HttpError(400, str(exc)) from exc

    return {
        "success": bool(result.ok),
        "message": result.message,
        **result.to_dict(),
    }

@router.post("/desktop-updates/releases/{release_id}/push", auth=SuperuserAuth(), response=AdminUpdateActionResponseSchema)
def push_release(request, release_id: int, payload: AdminUpdatePushActionSchema):

    release = _get_release_or_404(release_id)
    if release.is_draft:
        raise HttpError(400, _("updater.draft_cannot_push"))

    _ensure_release_ready_for_delivery(release, "推送")
    service = UpdatePushService()
    try:
        service.push_update(
            release,
            rollout_percentage=payload.rollout_percentage,
            silent=payload.silent,
            pushed_by=request.auth,
        )
    except Exception as exc:
        _raise_service_error(exc)

    release.refresh_from_db()
    logger.info(
        "[UpdaterAdmin] 推送桌面版本 %s rollout=%s silent=%s",
        release.version,
        payload.rollout_percentage if payload.rollout_percentage is not None else release.rollout_percentage,
        payload.silent,
    )
    return AdminUpdateActionResponseSchema(
        success=True,
        message=_("updater.version_pushed", version=release.version),
        release=_serialize_release(release),
    )

@router.post("/desktop-updates/releases/{release_id}/rollout", auth=SuperuserAuth(), response=AdminUpdateActionResponseSchema)
def set_rollout(request, release_id: int, payload: AdminUpdateRolloutSchema):

    release = _get_release_or_404(release_id)
    if release.is_draft:
        raise HttpError(400, _("updater.draft_cannot_rollout"))

    previous_rollout = release.rollout_percentage
    if payload.rollout_percentage > previous_rollout:
        _ensure_release_ready_for_delivery(release, "灰度推进")

    release.rollout_percentage = payload.rollout_percentage
    release.save(update_fields=["rollout_percentage", "updated_at"])

    if payload.rollout_percentage > previous_rollout:
        service = UpdatePushService()
        try:
            service.push_update(
                release,
                rollout_percentage=payload.rollout_percentage,
                pushed_by=request.auth,
            )
        except Exception as exc:
            _raise_service_error(exc)
    release.refresh_from_db()

    logger.info(
        "[UpdaterAdmin] 设置桌面版本灰度 %s: %s%% -> %s%%",
        release.version,
        previous_rollout,
        release.rollout_percentage,
    )
    return AdminUpdateActionResponseSchema(
        success=True,
        message=_("updater.rollout_advanced", percentage=release.rollout_percentage),
        release=_serialize_release(release),
    )

@router.post("/desktop-updates/releases/{release_id}/deprecate", auth=SuperuserAuth(), response=AdminUpdateActionResponseSchema)
def deprecate_release(request, release_id: int):

    release = _get_release_or_404(release_id)
    if release.is_deprecated:
        raise HttpError(400, _("updater.version_already_deprecated"))

    release.deprecate()

    # UPDTR-1: 废弃版本时 deactivate 关联资产的 FileUsage，释放 ref_count
    _deactivate_release_file_usages(release)

    logger.info("[UpdaterAdmin] 废弃桌面版本 %s", release.version)
    return AdminUpdateActionResponseSchema(
        success=True,
        message=_("updater.version_deprecated", version=release.version),
        release=_serialize_release(release),
    )

def _deactivate_release_file_usages(release: AppRelease) -> None:
    """UPDTR-1: 废弃版本时 deactivate 该 release 关联的所有 FileUsage。

    updater 模块的 FileUsage context_type 为 desktop_update_{asset_type}，
    context_id 为 str(release.id)。废弃后 ref_count 递减，孤儿清理器
    可在 ref_count=0 时回收物理文件（.dmg/.exe 等大文件）。
    """
    try:
        from apps.services.oss.services.deactivate_utils import (
            deactivate_file_usages_and_release_storage,
        )
        count = deactivate_file_usages_and_release_storage(
            module="updater",
            context_filter={"context_id": str(release.id)},
            organization_id="",
            user_id=str(getattr(release, "created_by_id", "") or ""),
            biz_type="updater.deprecate_release",
            biz_id=str(release.id),
            log_prefix=f"[UPDTR-1] deprecate release {release.version}",
        )
        if count:
            logger.info(
                "[UPDTR-1] 废弃版本 %s: deactivated %d 条 FileUsage",
                release.version, count,
            )
    except Exception as exc:
        logger.error(
            "[UPDTR-1] 废弃版本 %s 时 deactivate FileUsage 失败: %s",
            release.version, exc, exc_info=True,
        )
