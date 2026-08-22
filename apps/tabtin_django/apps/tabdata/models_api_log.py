"""
API 调用日志与用量统计模型

为 Open API 提供请求级日志和聚合用量摘要，支持分析、计费和限流决策。
"""

from django.db import models

from apps.tabdata.constants import TABDATA_DB_ALIAS


class ApiCallLog(models.Model):
    """
    单次 Open API 请求日志。

    使用 BigAutoField 主键以应对高吞吐量写入场景。
    由中间件通过 Celery 异步写入，不阻塞请求链路。
    """

    id = models.BigAutoField(primary_key=True)

    # ── 请求标识 ──
    request_id = models.CharField(max_length=36, db_index=True, verbose_name='请求 ID')
    timestamp = models.DateTimeField(db_index=True, verbose_name='请求时间')

    # ── 归属 ──
    organization_id = models.CharField(max_length=100, db_index=True, verbose_name='组织 ID')
    space_id = models.UUIDField(null=True, blank=True, db_index=True, verbose_name='Space ID')
    token_id = models.CharField(max_length=20, blank=True, default='', verbose_name='Token 标识')
    user_id = models.CharField(max_length=100, blank=True, default='', verbose_name='用户 ID')
    auth_type = models.CharField(
        max_length=8,
        choices=[('jwt', 'JWT'), ('token', 'Token')],
        verbose_name='认证方式',
    )

    # ── 请求信息 ──
    method = models.CharField(max_length=8, verbose_name='HTTP 方法')
    path = models.CharField(max_length=500, verbose_name='请求路径')
    path_template = models.CharField(max_length=200, verbose_name='路径模板')

    # ── 响应信息 ──
    status_code = models.SmallIntegerField(verbose_name='HTTP 状态码')
    response_size = models.PositiveIntegerField(default=0, verbose_name='响应大小（字节）')
    duration_ms = models.PositiveIntegerField(default=0, verbose_name='耗时（毫秒）')

    # ── 业务上下文 ──
    table_id = models.UUIDField(null=True, blank=True, verbose_name='关联表格 ID')
    error_code = models.CharField(max_length=64, blank=True, default='', verbose_name='错误码')
    error_message = models.CharField(max_length=500, blank=True, default='', verbose_name='错误信息')

    # ── 限流 ──
    rate_limit_remaining = models.SmallIntegerField(null=True, blank=True, verbose_name='剩余配额')
    is_rate_limited = models.BooleanField(default=False, verbose_name='是否被限流')

    # ── 客户端 ──
    ip_address = models.GenericIPAddressField(null=True, blank=True, verbose_name='客户端 IP')
    user_agent = models.CharField(max_length=200, blank=True, default='', verbose_name='User-Agent')
    sdk_version = models.CharField(max_length=32, blank=True, default='', verbose_name='SDK 版本')

    class Meta:
        db_table = 'tabdata_api_call_log'
        verbose_name = 'API 调用日志'
        verbose_name_plural = 'API 调用日志'
        ordering = ['-timestamp']
        indexes = [
            models.Index(fields=['organization_id', 'timestamp']),
            models.Index(fields=['token_id', 'timestamp']),
            models.Index(fields=['organization_id', 'path_template', 'timestamp']),
            models.Index(fields=['organization_id', 'status_code', 'timestamp']),
            models.Index(fields=['table_id', 'timestamp']),
        ]

    def __str__(self):
        return f"[{self.method}] {self.path} → {self.status_code} ({self.duration_ms}ms)"


class ApiUsageSummary(models.Model):
    """
    API 用量聚合摘要。

    按 organization × space × token × path_template 维度，
    每小时/每天聚合一次，用于用量分析和计费。
    """

    id = models.BigAutoField(primary_key=True)

    # ── 聚合维度 ──
    organization_id = models.CharField(max_length=100, verbose_name='组织 ID')
    space_id = models.UUIDField(null=True, blank=True, verbose_name='Space ID')
    token_id = models.CharField(max_length=20, blank=True, default='', verbose_name='Token 标识')
    path_template = models.CharField(max_length=200, blank=True, default='', verbose_name='路径模板')
    period_type = models.CharField(
        max_length=8,
        choices=[('hour', 'Hour'), ('day', 'Day')],
        verbose_name='聚合粒度',
    )
    period_start = models.DateTimeField(verbose_name='周期起始时间')

    # ── 请求计数 ──
    total_requests = models.PositiveIntegerField(default=0, verbose_name='总请求数')
    success_count = models.PositiveIntegerField(default=0, verbose_name='成功数（2xx）')
    client_error_count = models.PositiveIntegerField(default=0, verbose_name='客户端错误数（4xx）')
    server_error_count = models.PositiveIntegerField(default=0, verbose_name='服务端错误数（5xx）')
    rate_limited_count = models.PositiveIntegerField(default=0, verbose_name='限流数（429）')

    # ── 性能指标 ──
    avg_duration_ms = models.PositiveIntegerField(default=0, verbose_name='平均耗时（ms）')
    p95_duration_ms = models.PositiveIntegerField(default=0, verbose_name='P95 耗时（ms）')
    max_duration_ms = models.PositiveIntegerField(default=0, verbose_name='最大耗时（ms）')

    # ── 流量 ──
    total_response_bytes = models.BigIntegerField(default=0, verbose_name='总响应字节数')

    class Meta:
        db_table = 'tabdata_api_usage_summary'
        verbose_name = 'API 用量摘要'
        verbose_name_plural = 'API 用量摘要'
        unique_together = [
            ('organization_id', 'space_id', 'token_id', 'path_template', 'period_type', 'period_start'),
        ]
        indexes = [
            models.Index(fields=['organization_id', 'period_type', 'period_start']),
            models.Index(fields=['token_id', 'period_type', 'period_start']),
        ]

    def __str__(self):
        return (
            f"{self.organization_id} | {self.path_template} | "
            f"{self.period_type}@{self.period_start} → {self.total_requests} reqs"
        )
