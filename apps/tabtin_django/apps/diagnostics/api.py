import uuid
from datetime import timedelta

from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from ninja import Router, Schema
from ninja.errors import HttpError

from apps.services.oss.services.factory import get_oss_service
from apps.tabtinspace.models import OrganizationMember
from apps.users.auth.api import jwt_auth
from apps.users.auth.phone import phone_lookup_aliases
from apps.users.auth.permissions import AdminPermissionAuth

from .models import DiagnosticBundle, DiagnosticDownloadAudit
from .tasks import scan_diagnostic_bundle

router = Router()
MAX_BUNDLE_BYTES = 64 * 1024 * 1024
DOWNLOAD_TTL_SECONDS = 300
UPLOAD_TTL_SECONDS = 900
RETENTION = timedelta(days=1)


class CreateBundleRequest(Schema):
    organization_id: str
    client_install_id: str
    expected_size: int
    expected_sha256: str
    content_type: str = "application/zip"
    sentry_event_id: str = ""
    source: str = DiagnosticBundle.Source.INCIDENT


class CompleteBundleRequest(Schema):
    sha256: str
    size: int


def _member(request, organization_id: str) -> OrganizationMember:
    member = OrganizationMember.objects.filter(
        organization_id=organization_id,
        user_id=request.auth.id,
    ).first()
    if member is None:
        raise HttpError(403, "organization access denied")
    return member


def _owned_bundle(request, bundle_id: str) -> DiagnosticBundle:
    try:
        bundle = DiagnosticBundle.objects.get(id=bundle_id)
    except (DiagnosticBundle.DoesNotExist, ValueError):
        raise HttpError(404, "diagnostic bundle not found")
    member = _member(request, str(bundle.organization_id))
    is_creator = str(bundle.created_by_id) == str(request.auth.id)
    if not is_creator and member.role not in {"owner", "admin"}:
        raise HttpError(403, "diagnostic bundle access denied")
    return bundle


@router.post("/bundles", auth=jwt_auth)
def create_bundle(request, data: CreateBundleRequest):
    _member(request, data.organization_id)
    if data.content_type != "application/zip":
        raise HttpError(422, "content_type must be application/zip")
    if data.expected_size <= 0 or data.expected_size > MAX_BUNDLE_BYTES:
        raise HttpError(422, "bundle size is outside the allowed range")
    if len(data.expected_sha256) != 64 or any(c not in "0123456789abcdefABCDEF" for c in data.expected_sha256):
        raise HttpError(422, "expected_sha256 is invalid")
    if data.source not in DiagnosticBundle.Source.values:
        raise HttpError(422, "source is invalid")

    bundle_id = uuid.uuid4()
    object_key = f"diagnostics/{data.organization_id}/available/{bundle_id}.zip"
    upload_object_key = f"diagnostics/{data.organization_id}/incoming/{uuid.uuid4()}.zip"
    upload = get_oss_service().generate_bounded_upload(
        upload_object_key,
        expiration=UPLOAD_TTL_SECONDS,
        content_type="application/zip",
        content_length=data.expected_size,
    )
    bundle = DiagnosticBundle.objects.create(
        id=bundle_id,
        organization_id=data.organization_id,
        created_by_id=request.auth.id,
        client_install_id=data.client_install_id[:128],
        sentry_event_id=data.sentry_event_id[:64],
        source=data.source,
        object_key=object_key,
        upload_object_key=upload_object_key,
        expected_size=data.expected_size,
        expected_sha256=data.expected_sha256.lower(),
        content_type=data.content_type,
        # 上传尚未完成时也不能永久占用 incoming 对象；扫描完成后会重新从可下载时刻计满 24 小时。
        expires_at=timezone.now() + RETENTION,
    )
    return {
        "bundle_id": str(bundle.id),
        "status": bundle.status,
        "upload_url": upload["url"],
        "upload_method": upload["method"],
        "upload_fields": upload["fields"],
    }


@router.post("/bundles/{bundle_id}/complete", auth=jwt_auth)
@transaction.atomic
def complete_bundle(request, bundle_id: str, data: CompleteBundleRequest):
    bundle = _owned_bundle(request, bundle_id)
    if data.size != bundle.expected_size or data.sha256.lower() != bundle.expected_sha256:
        if bundle.status == DiagnosticBundle.Status.PENDING_UPLOAD:
            bundle.status = DiagnosticBundle.Status.QUARANTINED
            bundle.scan_result = {"reason": "client_integrity_mismatch"}
            bundle.save(update_fields=["status", "scan_result", "updated_at"])
        raise HttpError(422, "bundle integrity mismatch")
    if bundle.status == DiagnosticBundle.Status.AVAILABLE:
        return {"bundle_id": str(bundle.id), "status": bundle.status}
    if bundle.status == DiagnosticBundle.Status.UPLOADED:
        transaction.on_commit(lambda: scan_diagnostic_bundle.delay(str(bundle.id)))
        return {"bundle_id": str(bundle.id), "status": bundle.status}
    if bundle.status == DiagnosticBundle.Status.SCANNING:
        return {"bundle_id": str(bundle.id), "status": bundle.status}
    if bundle.status != DiagnosticBundle.Status.PENDING_UPLOAD:
        raise HttpError(409, "bundle is not pending upload")
    service = get_oss_service()
    if not service.file_exists(bundle.upload_object_key):
        raise HttpError(409, "uploaded object not found")
    info = service.get_file_info(bundle.upload_object_key) or {}
    info_data = info.get("data")
    if not isinstance(info_data, dict):
        raise HttpError(409, "uploaded object metadata unavailable")
    actual_size = info_data.get("content_length")
    if actual_size is None:
        raise HttpError(409, "uploaded object size unavailable")
    if int(actual_size) != bundle.expected_size:
        bundle.status = DiagnosticBundle.Status.QUARANTINED
        bundle.scan_result = {"reason": "object_size_mismatch"}
        bundle.save(update_fields=["status", "scan_result", "updated_at"])
        raise HttpError(422, "uploaded object size mismatch")
    bundle.status = DiagnosticBundle.Status.UPLOADED
    bundle.uploaded_at = timezone.now()
    bundle.save(update_fields=["status", "uploaded_at", "updated_at"])
    transaction.on_commit(lambda: scan_diagnostic_bundle.delay(str(bundle.id)))
    return {"bundle_id": str(bundle.id), "status": bundle.status}


@router.get("/bundles/{bundle_id}", auth=jwt_auth)
def get_bundle_status(request, bundle_id: str):
    bundle = _owned_bundle(request, bundle_id)
    return {"bundle_id": str(bundle.id), "status": bundle.status, "sentry_event_id": bundle.sentry_event_id or None}


@router.post("/bundles/{bundle_id}/download", auth=jwt_auth)
def create_download(request, bundle_id: str):
    bundle = _owned_bundle(request, bundle_id)
    if bundle.expires_at <= timezone.now():
        raise HttpError(410, "diagnostic bundle has expired")
    if bundle.status != DiagnosticBundle.Status.AVAILABLE:
        raise HttpError(409, "bundle is not available")
    DiagnosticDownloadAudit.objects.create(
        bundle=bundle,
        user_id=request.auth.id,
        request_id=request.headers.get("X-Request-ID", "")[:128],
    )
    download_url = get_oss_service().generate_presigned_url(
        bundle.object_key,
        expiration=DOWNLOAD_TTL_SECONDS,
        method="GET",
        response_content_disposition=f'attachment; filename="diagnostic-{bundle.id}.zip"',
    )
    return {"bundle_id": str(bundle.id), "download_url": download_url, "expires_in": DOWNLOAD_TTL_SECONDS}


def _require_diagnostics_operator(request):
    if not getattr(request.auth, "is_staff", False):
        raise HttpError(403, "diagnostics operator access denied")


@router.get("/admin/bundles", auth=AdminPermissionAuth("client_error:list"))
def list_admin_bundles(
    request,
    user_id: str = "",
    query: str = "",
    status: str = "",
    page: int = 1,
    page_size: int = 30,
):
    """运维收件箱：只返回定位所需元数据，日志内容始终经单独下载动作取得。"""
    _require_diagnostics_operator(request)
    bundles = DiagnosticBundle.objects.select_related("created_by", "organization").order_by("-created_at")
    # 保留 user_id 参数给既有调用方；新 query 既可传用户 ID，也可传手机号。
    lookup = (query or user_id).strip()
    if lookup:
        bundles = bundles.filter(
            Q(created_by_id=lookup) | Q(created_by__phone__in=phone_lookup_aliases(lookup))
        )
    if status.strip():
        bundles = bundles.filter(status=status.strip())
    page_size = max(1, min(page_size, 100))
    page = max(1, page)
    total = bundles.count()
    rows = bundles[(page - 1) * page_size: page * page_size]
    now = timezone.now()
    return {
        "items": [
            {
                "id": str(bundle.id),
                "user_id": str(bundle.created_by_id),
                "organization_id": str(bundle.organization_id),
                "client_install_id": bundle.client_install_id,
                "sentry_event_id": bundle.sentry_event_id or None,
                "source": bundle.source,
                "status": bundle.status,
                "bytes": bundle.expected_size,
                "created_at": bundle.created_at,
                "available_at": bundle.available_at,
                "expires_at": bundle.expires_at,
                "expired": bundle.expires_at <= now,
            }
            for bundle in rows
        ],
        "pagination": {"total": total, "page": page, "page_size": page_size},
    }


@router.post("/admin/bundles/{bundle_id}/download", auth=AdminPermissionAuth("client_error:list"))
def create_admin_download(request, bundle_id: str):
    _require_diagnostics_operator(request)
    try:
        bundle = DiagnosticBundle.objects.get(id=bundle_id)
    except (DiagnosticBundle.DoesNotExist, ValueError):
        raise HttpError(404, "diagnostic bundle not found")
    if bundle.expires_at <= timezone.now():
        raise HttpError(410, "diagnostic bundle has expired")
    if bundle.status != DiagnosticBundle.Status.AVAILABLE:
        raise HttpError(409, "bundle is not available")
    DiagnosticDownloadAudit.objects.create(bundle=bundle, user_id=request.auth.id, request_id=request.headers.get("X-Request-ID", "")[:128])
    return {
        "bundle_id": str(bundle.id),
        "download_url": get_oss_service().generate_presigned_url(
            bundle.object_key,
            expiration=DOWNLOAD_TTL_SECONDS,
            method="GET",
            response_content_disposition=f'attachment; filename="diagnostic-{bundle.id}.zip"',
        ),
        "expires_in": DOWNLOAD_TTL_SECONDS,
    }
