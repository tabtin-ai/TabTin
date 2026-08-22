import hashlib
import io
import zipfile
from datetime import timedelta

from celery import shared_task
from celery.schedules import crontab
from django.utils import timezone

from apps.services.oss.services.factory import get_oss_service

from .models import DiagnosticBundle

MAX_FILES = 200
MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024
MAX_COMPRESSION_RATIO = 100
STALE_SCAN_AFTER = timedelta(minutes=15)
STALE_SCAN_BATCH_SIZE = 100

DIAGNOSTICS_BEAT_SCHEDULE = {
    "expire-diagnostic-bundles": {
        "task": "apps.diagnostics.tasks.expire_diagnostic_bundles",
        "schedule": crontab(minute="*/5"),
    },
    "recover-stale-diagnostic-scans": {
        "task": "apps.diagnostics.tasks.recover_stale_diagnostic_scans",
        "schedule": crontab(minute="*/5"),
    },
}


def _scan_zip(content: bytes, bundle: DiagnosticBundle) -> dict:
    if len(content) != bundle.expected_size:
        raise ValueError("size_mismatch")
    if hashlib.sha256(content).hexdigest() != bundle.expected_sha256:
        raise ValueError("sha256_mismatch")
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        infos = archive.infolist()
        if len(infos) > MAX_FILES:
            raise ValueError("too_many_files")
        total = 0
        for info in infos:
            normalized = info.filename.replace("\\", "/")
            if normalized.startswith("/") or ".." in normalized.split("/"):
                raise ValueError("unsafe_path")
            total += info.file_size
            if total > MAX_UNCOMPRESSED_BYTES:
                raise ValueError("uncompressed_size_exceeded")
            if info.file_size > 0 and info.compress_size == 0:
                raise ValueError("invalid_compression")
            if info.compress_size > 0 and info.file_size / info.compress_size > MAX_COMPRESSION_RATIO:
                raise ValueError("compression_ratio_exceeded")
    return {"file_count": len(infos), "uncompressed_bytes": total, "scanner_version": 1}


@shared_task(ignore_result=True)
def scan_diagnostic_bundle(bundle_id: str) -> None:
    claim_time = timezone.now()
    claimed = DiagnosticBundle.objects.filter(
        id=bundle_id,
        status=DiagnosticBundle.Status.UPLOADED,
    ).update(status=DiagnosticBundle.Status.SCANNING, updated_at=claim_time)
    if claimed != 1:
        return
    try:
        bundle = DiagnosticBundle.objects.get(id=bundle_id)
    except DiagnosticBundle.DoesNotExist:
        return
    try:
        service = get_oss_service()
        response = service.download_file(bundle.upload_object_key)
        content = (response.get("data") or {}).get("content") if response.get("success") else None
        if not isinstance(content, bytes):
            raise ValueError("object_download_failed")
        result = _scan_zip(content, bundle)
    except Exception as exc:
        DiagnosticBundle.objects.filter(
            id=bundle_id,
            status=DiagnosticBundle.Status.SCANNING,
            updated_at=claim_time,
        ).update(
            status=DiagnosticBundle.Status.QUARANTINED,
            scan_result={"reason": str(exc)[:128]},
            updated_at=timezone.now(),
        )
        return
    # Refresh the lease before mutating OSS. If the stale-scan recovery task
    # already reclaimed this row, this worker must stop before copying or
    # deleting objects that the replacement worker may be using.
    lease_time = timezone.now()
    lease_refreshed = DiagnosticBundle.objects.filter(
        id=bundle_id,
        status=DiagnosticBundle.Status.SCANNING,
        updated_at=claim_time,
    ).update(updated_at=lease_time)
    if lease_refreshed != 1:
        return
    try:
        copied = service.copy_file(bundle.upload_object_key, bundle.object_key)
        if not copied.get("success"):
            raise ValueError("final_copy_failed")
        deleted = service.delete_file(bundle.upload_object_key)
        if not deleted.get("success"):
            raise ValueError("incoming_delete_failed")
    except Exception as exc:
        DiagnosticBundle.objects.filter(
            id=bundle_id,
            status=DiagnosticBundle.Status.SCANNING,
            updated_at=lease_time,
        ).update(
            status=DiagnosticBundle.Status.QUARANTINED,
            scan_result={"reason": f"finalize_failed:{str(exc)[:96]}"},
            updated_at=timezone.now(),
        )
        return
    available_at = timezone.now()
    DiagnosticBundle.objects.filter(
        id=bundle_id,
        status=DiagnosticBundle.Status.SCANNING,
        updated_at=lease_time,
    ).update(
        status=DiagnosticBundle.Status.AVAILABLE,
        available_at=available_at,
        expires_at=available_at + timedelta(days=1),
        scan_result=result,
        updated_at=available_at,
    )


@shared_task(ignore_result=True)
def recover_stale_diagnostic_scans() -> None:
    cutoff = timezone.now() - STALE_SCAN_AFTER
    stale_ids = list(
        DiagnosticBundle.objects.filter(
            status=DiagnosticBundle.Status.SCANNING,
            updated_at__lte=cutoff,
        ).values_list("id", flat=True)[:STALE_SCAN_BATCH_SIZE]
    )
    for bundle_id in stale_ids:
        recovered = DiagnosticBundle.objects.filter(
            id=bundle_id,
            status=DiagnosticBundle.Status.SCANNING,
            updated_at__lte=cutoff,
        ).update(status=DiagnosticBundle.Status.UPLOADED, updated_at=timezone.now())
        if recovered == 1:
            scan_diagnostic_bundle.delay(str(bundle_id))


@shared_task(ignore_result=True)
def expire_diagnostic_bundles() -> None:
    bundles = DiagnosticBundle.objects.filter(
        expires_at__lte=timezone.now(),
        deleted_at__isnull=True,
    ).exclude(status=DiagnosticBundle.Status.DELETED)
    service = get_oss_service()
    for bundle in bundles.iterator():
        try:
            final_deleted = service.delete_file(bundle.object_key)
            incoming_deleted = service.delete_file(bundle.upload_object_key)
        except Exception:
            continue
        if not final_deleted.get("success") or not incoming_deleted.get("success"):
            continue
        bundle.status = DiagnosticBundle.Status.DELETED
        bundle.deleted_at = timezone.now()
        bundle.save(update_fields=["status", "deleted_at", "updated_at"])
