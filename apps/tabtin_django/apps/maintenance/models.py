from django.db import models


class FailedTaskRecord(models.Model):
    """
    Celery 关键任务最终失败记录（DLQ 兜底）。

    当 billing / payment / membership 等关键任务重试耗尽后，
    通过全局 task_failure 信号写入此表，供运维人工复核和重放。
    """

    task_id = models.CharField(max_length=255, db_index=True)
    task_name = models.CharField(max_length=500)
    args = models.JSONField(default=list)
    kwargs = models.JSONField(default=dict)
    exception = models.TextField()
    traceback = models.TextField(blank=True, default='')
    retries = models.IntegerField(default=0)
    failed_at = models.DateTimeField(auto_now_add=True)
    resolved = models.BooleanField(default=False)
    resolved_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = 'maintenance_failed_task_record'
        ordering = ['-failed_at']

    def __str__(self):
        return f"[{'resolved' if self.resolved else 'OPEN'}] {self.task_name} ({self.task_id})"


class OpsTroubleshootQueryLog(models.Model):
    """Admin Ops read-query audit log.

    P0 intentionally logs only query context and target identifiers. Sensitive
    response payloads, phone numbers, email addresses, tokens, and provider
    secrets must never be stored here.
    """

    QUERY_TYPE_MAX_LEN = 80
    TARGET_TYPE_MAX_LEN = 80
    TARGET_ID_MAX_LEN = 160
    REQUEST_ID_MAX_LEN = 128

    actor_user_id = models.CharField(max_length=36, blank=True, default="", db_index=True)
    actor_admin_account_id = models.CharField(max_length=36, null=True, blank=True, default=None)
    query_type = models.CharField(max_length=QUERY_TYPE_MAX_LEN, db_index=True)
    target_user_id = models.CharField(max_length=36, blank=True, default="")
    target_organization_id = models.CharField(
        max_length=100,
        blank=True,
        default="",
        db_column="target_workteam_id",
    )
    target_entity_type = models.CharField(max_length=TARGET_TYPE_MAX_LEN, blank=True, default="")
    target_entity_id = models.CharField(max_length=TARGET_ID_MAX_LEN, blank=True, default="")
    reason = models.TextField()
    ticket_id = models.CharField(max_length=100, blank=True, default="")
    time_range_start = models.DateTimeField(null=True, blank=True)
    time_range_end = models.DateTimeField(null=True, blank=True)
    ip = models.GenericIPAddressField(null=True, blank=True)
    user_agent = models.TextField(blank=True, default="")
    request_id = models.CharField(max_length=REQUEST_ID_MAX_LEN, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "ops_troubleshoot_query_log"
        ordering = ["-created_at"]
        verbose_name = "Ops 排障查询日志"
        verbose_name_plural = "Ops 排障查询日志"
        permissions = [
            ("ops_stability:view", "Can view Ops stability overview"),
            ("ops_user:diagnose", "Can diagnose users in Ops console"),
            ("ops_task:view", "Can view Ops task queues"),
            ("ops_realtime:view", "Can view Ops realtime overview"),
            ("ops_collab:view", "Can view Ops collab overview"),
            ("ops_search_outbox:view", "Can view Ops search outbox"),
            ("ops_finance_trace:view", "Can view Ops finance trace"),
            ("ops_audit:view", "Can view Ops audit events"),
            ("ops_beat:view", "Can view Ops beat tasks"),
            ("ops_llm_trace:view", "Can view Ops LLM traces"),
            ("ops_oss_status:view", "Can view Ops OSS status"),
            ("ops_sms_status:view", "Can view Ops SMS status"),
            ("ops_dependency_health:view", "Can view Ops dependency health"),
            ("ops_incident:view", "Can view Ops incident placeholders"),
            ("ops_cost_sla:view", "Can view Ops cost and SLA placeholders"),
        ]
        indexes = [
            models.Index(
                fields=["actor_admin_account_id", "created_at"],
                name="ops_tql_actor_time_idx",
            ),
            models.Index(
                fields=["target_user_id", "created_at"],
                name="ops_tql_user_time_idx",
            ),
            models.Index(
                fields=["target_entity_type", "target_entity_id", "created_at"],
                name="ops_tql_entity_time_idx",
            ),
            models.Index(fields=["created_at"], name="ops_tql_created_idx"),
            models.Index(fields=["ticket_id"], name="ops_tql_ticket_idx"),
            models.Index(fields=["request_id"], name="ops_tql_request_idx"),
        ]

    def __str__(self):
        target = self.target_entity_id or self.target_user_id or self.target_organization_id or "-"
        return f"{self.query_type}:{target}"


class OpsRuntimeActionLog(models.Model):
    """Runtime Operations Console write-action audit log.

    P1.5+ write actions are intentionally narrow and ticket-gated. This log is
    append-only evidence for both accepted and rejected attempts. Store only a
    sanitized payload snapshot; never store raw task payloads, secrets, tokens,
    or complete client IPs here.
    """

    id = models.BigAutoField(primary_key=True)
    action_type = models.CharField(max_length=40, db_index=True)
    target_type = models.CharField(max_length=80, blank=True, default="", db_index=True)
    target_id = models.CharField(max_length=160, blank=True, default="", db_index=True)
    source = models.CharField(max_length=80, blank=True, default="", db_index=True)
    queue = models.CharField(max_length=100, blank=True, default="", db_index=True)
    task_name = models.CharField(max_length=500, blank=True, default="")
    before_status = models.CharField(max_length=80, blank=True, default="")
    after_status = models.CharField(max_length=80, blank=True, default="")
    ticket_id = models.CharField(max_length=100, blank=True, default="", db_index=True)
    operator_id = models.CharField(max_length=36, blank=True, default="", db_index=True)
    operator_name = models.CharField(max_length=255, blank=True, default="")
    request_payload_sanitized = models.JSONField(default=dict, blank=True)
    result = models.CharField(max_length=40, blank=True, default="", db_index=True)
    error_message = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "ops_runtime_action_log"
        ordering = ["-created_at"]
        verbose_name = "Ops Runtime 治理动作日志"
        verbose_name_plural = "Ops Runtime 治理动作日志"
        permissions = [
            ("runtime_action:retry", "Can retry one runtime object"),
            ("runtime_action:resolve", "Can resolve one runtime object"),
            ("runtime_action:cleanup", "Can cleanup runtime terminal failures"),
        ]
        indexes = [
            models.Index(fields=["action_type", "created_at"], name="ops_rtal_action_time_idx"),
            models.Index(fields=["source", "target_id", "created_at"], name="ops_rtal_source_target_idx"),
            models.Index(fields=["queue", "created_at"], name="ops_rtal_queue_time_idx"),
        ]

    def __str__(self):
        return f"{self.action_type}:{self.source}:{self.target_id}:{self.result}"


class OpsRuntimeResolution(models.Model):
    """Runtime object resolution overlay.

    This records that an operator reviewed a runtime failure and decided it no
    longer needs to count as an open operational issue. The original failed
    object is kept intact.
    """

    id = models.BigAutoField(primary_key=True)
    source = models.CharField(max_length=80, db_index=True)
    target_id = models.CharField(max_length=160, db_index=True)
    target_type = models.CharField(max_length=80, blank=True, default="", db_index=True)
    status = models.CharField(max_length=40, default="resolved", db_index=True)
    reason = models.TextField()
    ticket_id = models.CharField(max_length=100, db_index=True)
    resolved_by = models.CharField(max_length=36, blank=True, default="", db_index=True)
    resolved_at = models.DateTimeField()

    class Meta:
        db_table = "ops_runtime_resolution"
        ordering = ["-resolved_at"]
        verbose_name = "Ops Runtime 处理覆盖记录"
        verbose_name_plural = "Ops Runtime 处理覆盖记录"
        unique_together = [["source", "target_id"]]
        indexes = [
            models.Index(fields=["source", "status", "resolved_at"], name="ops_rtr_source_status_idx"),
            models.Index(fields=["ticket_id", "resolved_at"], name="ops_rtr_ticket_time_idx"),
        ]

    def __str__(self):
        return f"{self.source}:{self.target_id}:{self.status}"
