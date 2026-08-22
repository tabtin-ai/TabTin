from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models

from apps.extensions.fields import EncryptedJSONField

from .constants import (
    IMPORT_STATUS_FAILED,
    IMPORT_STATUS_PENDING,
    IMPORT_STATUS_RUNNING,
    IMPORT_STATUS_SUCCESS,
    STATUS_CONNECTED,
    STATUS_REAUTHORIZATION_REQUIRED,
    STATUS_REVOKED,
)


class FeishuOAuthProvider(models.Model):
    """Organization 级飞书企业自建应用凭证。"""

    class Status(models.TextChoices):
        ACTIVE = "active", "已验证"
        INVALID = "invalid", "验证失败"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization = models.OneToOneField(
        "tabtinspace.Organization",
        on_delete=models.CASCADE,
        related_name="feishu_oauth_provider",
    )
    app_id = models.CharField(max_length=255)
    # {"app_secret": "..."} —— 永不在 API、CLI 或日志中回传。
    credentials = EncryptedJSONField(default=dict)
    secret_fingerprint = models.CharField(max_length=64, editable=False)
    credential_version = models.PositiveBigIntegerField(default=1, editable=False)
    tenant_key = models.CharField(max_length=255, blank=True, default="")
    status = models.CharField(
        max_length=32,
        choices=Status.choices,
        default=Status.ACTIVE,
        db_index=True,
    )
    verified_at = models.DateTimeField(null=True, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="created_feishu_oauth_providers",
    )
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="updated_feishu_oauth_providers",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "integrations_feishu_oauth_provider"

    @property
    def app_secret(self) -> str:
        return str((self.credentials or {}).get("app_secret") or "")

    def __str__(self) -> str:
        return f"FeishuOAuthProvider({self.organization_id}, {self.status})"


class FeishuOAuthConnection(models.Model):
    """用户在某 Organization 下的飞书 OAuth 连接（存 user_access_token）。"""

    class Status(models.TextChoices):
        CONNECTED = STATUS_CONNECTED, "已连接"
        REVOKED = STATUS_REVOKED, "已撤销"
        REAUTHORIZATION_REQUIRED = (
            STATUS_REAUTHORIZATION_REQUIRED,
            "需重新授权",
        )

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="feishu_oauth_connections",
    )
    organization_id = models.UUIDField(db_index=True)
    provider = models.ForeignKey(
        FeishuOAuthProvider,
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name="connections",
    )
    credential_version = models.PositiveBigIntegerField(
        null=True,
        blank=True,
        editable=False,
    )

    # {"access_token": "...", "refresh_token": "..."} — 永不在 API 响应中回传
    tokens = EncryptedJSONField(default=dict)
    expires_at = models.DateTimeField(null=True, blank=True)
    refresh_token_expires_at = models.DateTimeField(null=True, blank=True)
    granted_scopes = models.JSONField(default=list, blank=True)

    open_id = models.CharField(max_length=128, blank=True, default="")
    display_name = models.CharField(max_length=255, blank=True, default="")
    status = models.CharField(
        max_length=32,
        choices=Status.choices,
        default=Status.CONNECTED,
        db_index=True,
    )

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "integrations_feishu_oauth_connection"
        constraints = [
            models.UniqueConstraint(
                fields=["user", "organization_id"],
                name="uniq_feishu_oauth_user_org",
            ),
        ]
        indexes = [
            models.Index(fields=["organization_id", "status"]),
        ]

    def __str__(self) -> str:
        return f"FeishuOAuthConnection({self.open_id or self.id}, {self.status})"


class FeishuImportJob(models.Model):
    """一次性飞书导入任务：多维表 → TabData，和/或云文档 Docx → TabDoc。"""

    class Status(models.TextChoices):
        PENDING = IMPORT_STATUS_PENDING, "等待中"
        RUNNING = IMPORT_STATUS_RUNNING, "运行中"
        SUCCESS = IMPORT_STATUS_SUCCESS, "成功"
        FAILED = IMPORT_STATUS_FAILED, "失败"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="feishu_import_jobs",
    )
    organization_id = models.UUIDField(db_index=True)
    space_id = models.UUIDField(null=True, blank=True)
    collection_id = models.UUIDField(null=True, blank=True)

    # [{app_token, table_id, name?}, ...]
    tables = models.JSONField(default=list)
    # [{doc_token, name?, doc_type?: "docx"}, ...]
    documents = models.JSONField(default=list, blank=True)
    status = models.CharField(
        max_length=32,
        choices=Status.choices,
        default=Status.PENDING,
        db_index=True,
    )
    # {"created_tables": [...], "created_documents": [...], "progress": {...}, "phase": ...}
    result = models.JSONField(default=dict, blank=True)
    error = models.TextField(blank=True, default="")
    celery_task_id = models.CharField(max_length=255, blank=True, default="")

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "integrations_feishu_import_job"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["user", "organization_id", "-created_at"]),
        ]

    def __str__(self) -> str:
        return f"FeishuImportJob({self.id}, {self.status})"
