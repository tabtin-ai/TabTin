import uuid

from django.conf import settings
from django.db import models


class DiagnosticBundle(models.Model):
    class Source(models.TextChoices):
        INCIDENT = "incident", "自动故障采集"
        SUPPORT_UPLOAD = "support_upload", "用户主动上传"
    class Status(models.TextChoices):
        PENDING_UPLOAD = "pending_upload", "待上传"
        UPLOADED = "uploaded", "已上传"
        SCANNING = "scanning", "扫描中"
        AVAILABLE = "available", "可下载"
        QUARANTINED = "quarantined", "已隔离"
        EXPIRED = "expired", "已过期"
        DELETED = "deleted", "已删除"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization = models.ForeignKey("tabtinspace.Organization", on_delete=models.CASCADE)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    client_install_id = models.CharField(max_length=128, db_index=True)
    sentry_event_id = models.CharField(max_length=64, blank=True, default="", db_index=True)
    source = models.CharField(max_length=32, choices=Source.choices, default=Source.INCIDENT, db_index=True)
    object_key = models.CharField(max_length=512, unique=True)
    upload_object_key = models.CharField(max_length=512, unique=True)
    expected_size = models.PositiveBigIntegerField()
    expected_sha256 = models.CharField(max_length=64)
    content_type = models.CharField(max_length=128, default="application/zip")
    status = models.CharField(max_length=24, choices=Status.choices, default=Status.PENDING_UPLOAD, db_index=True)
    uploaded_at = models.DateTimeField(null=True, blank=True)
    available_at = models.DateTimeField(null=True, blank=True)
    expires_at = models.DateTimeField()
    deleted_at = models.DateTimeField(null=True, blank=True)
    scan_result = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "diagnostic_bundle"
        indexes = [
            models.Index(fields=["organization", "status", "-created_at"], name="diag_org_status_created_idx"),
        ]


class DiagnosticDownloadAudit(models.Model):
    bundle = models.ForeignKey(DiagnosticBundle, on_delete=models.CASCADE, related_name="download_audits")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    requested_at = models.DateTimeField(auto_now_add=True)
    request_id = models.CharField(max_length=128, blank=True, default="")

    class Meta:
        db_table = "diagnostic_download_audit"
