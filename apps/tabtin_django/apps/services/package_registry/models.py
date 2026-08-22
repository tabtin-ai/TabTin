import uuid

from django.db import models
from django.utils import timezone


class Package(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    namespace = models.CharField(max_length=128, db_index=True)
    name = models.CharField(max_length=128)
    organization_id = models.UUIDField(db_index=True)
    created_by = models.UUIDField()
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    metadata = models.JSONField(default=dict, blank=True)

    latest_version_seq = models.PositiveIntegerField(null=True, blank=True)

    parent_package_id = models.UUIDField(null=True, blank=True, db_index=True)

    class Meta:
        app_label = "package_registry"
        db_table = "package_registry_package"
        unique_together = [("namespace", "name")]

    def __str__(self):
        return f"{self.namespace}/{self.name}"


class PackageVersion(models.Model):
    class Status(models.TextChoices):
        UPLOADING = "uploading", "上传中"
        PUBLISHED = "published", "已发布"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    package = models.ForeignKey(
        Package, on_delete=models.CASCADE, related_name="versions"
    )

    version_seq = models.PositiveIntegerField(null=True, blank=True)

    version_label = models.CharField(max_length=64, null=True, blank=True, default=None)

    bundle_sha256 = models.CharField(max_length=64, blank=True, default="")

    file_count = models.PositiveIntegerField(default=0)
    total_size = models.BigIntegerField(default=0)
    manifest = models.JSONField(default=dict, blank=True)

    # 两阶段上传期间(status=UPLOADING)缓存 init 提交的 files 列表,
    # finalize 完成后清空。**与 manifest 解耦**:manifest 只存上层业务的
    # 不可变快照,init_files 只是发布期临时通道。GC 任务清理 stale UPLOADING
    # 时一并删除整行,无需独立清理路径。
    init_files = models.JSONField(default=list, blank=True)

    status = models.CharField(
        max_length=16,
        choices=Status.choices,
        default=Status.UPLOADING,
        db_index=True,
    )

    is_yanked = models.BooleanField(default=False, db_index=True)
    yanked_at = models.DateTimeField(null=True, blank=True)
    yanked_by = models.UUIDField(null=True, blank=True)
    yanked_reason = models.TextField(blank=True, default="")

    created_by = models.UUIDField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        app_label = "package_registry"
        db_table = "package_registry_version"
        unique_together = [("package", "version_seq")]

    def __str__(self):
        return f"{self.package} v{self.version_seq}"


class PackageFile(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    version = models.ForeignKey(
        PackageVersion, on_delete=models.CASCADE, related_name="files"
    )

    path = models.CharField(max_length=512)

    # 软引用 oss.FileRecord（跨库不能 FK）
    file_record_id = models.UUIDField(db_index=True)

    # 冗余存储实际 OSS 路径，避免跨库查 FileRecord.file_key
    oss_object_key = models.CharField(max_length=512, blank=True, default="")

    content_type = models.CharField(max_length=128, blank=True, default="application/octet-stream")
    file_size = models.BigIntegerField()
    sha256 = models.CharField(max_length=64)

    class Meta:
        app_label = "package_registry"
        db_table = "package_registry_file"
        unique_together = [("version", "path")]
        indexes = [models.Index(fields=["sha256"])]

    def __str__(self):
        return self.path


class EventOutbox(models.Model):
    """W7 P1-1:跨库告警事件兜底持久化表。

    PR 模块的 3 个软依赖告警事件(``pkg.package.reverted_sync_failed`` /
    ``pkg.skill.upsert_failed`` / ``pkg.gc.scheduling_failed``)在 emit 失败 +
    业务调用失败时写入此表;Celery 周期任务 ``process_event_outbox`` 扫描并
    指数退避重试,直到自愈或超过 ``max_retries`` 标记为 dead。

    设计要点(F-9 闭环):
    - **不替代主路径**:主路径仍然 emit_on_commit;只在 emit 失败 OR 业务调用
      自身失败的兜底路径写入此表,与 `EventBus 订阅模式` 平行(EventBus 仍是
      主告警通道,outbox 是自动重试通道)。
    - **不通用**:此 outbox 只处理 PR 模块自己的 3 类事件;其它模块需自建。
    - **PostgreSQL**(同 PR 模块库),通过 Django Router 路由。

    状态机:
    - ``pending``:待重试(初始 / 重试失败后)
    - ``processing``:Celery 任务正在重试(短暂)
    - ``done``:重试成功
    - ``dead``:超过 max_retries,需运维人工干预
    """

    STATUS_PENDING = "pending"
    STATUS_PROCESSING = "processing"
    STATUS_DONE = "done"
    STATUS_DEAD = "dead"

    STATUS_CHOICES = [
        (STATUS_PENDING, "Pending"),
        (STATUS_PROCESSING, "Processing"),
        (STATUS_DONE, "Done"),
        (STATUS_DEAD, "Dead"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    # 事件类型 — 必须是 PR 模块已知的 3 个之一
    event_type = models.CharField(max_length=128, db_index=True)

    # 组织 ID(冗余,便于审计 / 监控按 wt 过滤)
    organization_id = models.CharField(max_length=64, blank=True, default="")

    # 事件 payload(还原 emit 调用时的 dict)
    payload = models.JSONField(default=dict)

    status = models.CharField(
        max_length=16, choices=STATUS_CHOICES, default=STATUS_PENDING,
    )

    retry_count = models.IntegerField(default=0)
    max_retries = models.IntegerField(default=5)

    # 下次重试时间(指数退避后):now() + 2^retry_count 秒
    next_retry_at = models.DateTimeField(default=timezone.now)

    # 最后一次失败原因(只存最近一次,便于诊断;历史可通过日志找)
    last_error = models.TextField(blank=True, default="")

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        app_label = "package_registry"
        db_table = "package_registry_event_outbox"
        indexes = [
            models.Index(fields=["status", "next_retry_at"]),
            models.Index(fields=["event_type"]),
        ]
        ordering = ["-created_at"]

    def __str__(self):
        return f"[{self.status}] {self.event_type} retry={self.retry_count}/{self.max_retries}"


# Skills Wave 1（PRD V3.3 §11.1，2026-05-02）：跨库 ref 表已删除。
# 新 Skill 表归 PG（跟 Package 同库），GC 任务直接
# ``Skill.objects.filter(package_id=...).exists()`` 在同库内查，不再需要反向索引兜底。
